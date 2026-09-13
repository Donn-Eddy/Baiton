---
version: 1
name: multi-agent-adapters
status: approved
mode: manual
base: main
base_commit: 5d5371777389073a209ee28de8d8a74f52fba763
branch: baiton/multi-agent-adapters
approved_rev: f59bdbd5e6b4822ddfa0750a36dce64e062d2612d8ed7d259964f4ef4614574b
---

# OVERVIEW

Extend Baiton's adapter layer so any role can be configured to run the opencode, antigravity (`agy` binary), or codex CLI, in addition to claude, without changing claude's own behavior or the default config. This adds three new Adapter implementations, widens the adapter id union, lets executable resolution and role-agent config accept the new ids, and lets the engine pick a different adapter per role instead of the single hard-wired ClaudeAdapter it uses today.

CLI research (via `<bin> --help` on the installed binaries; findings below drive each adapter's launch/attach/probe/permission mapping — implementers should re-verify against the installed version before writing code, since these are third-party CLIs that can change):

opencode (binary `opencode`, tested v1.18.30):
- probe: `opencode --version` prints a bare version string (e.g. `1.18.30`), exit 0.
- fresh launch: `opencode run [message..]` is the launch-with-initial-message form (the bare `opencode [project]` command starts the TUI with no message). Pass `-m/--model <provider/model>` (opencode's model ids are `provider/model`, e.g. `anthropic/claude-sonnet-5` — note this is a different shape than claude's bare model id, so role config for an opencode role must already use that shape; the adapter passes `req.model` through unchanged), `--agent <name>` for opencode's agent/permission profile, `--variant <effort>` for reasoning effort when `req.effort` is set, and `-i/--interactive` so the launched process stays a live interactive session in the terminal (matching how claude's `-- <prompt>` launches an ongoing session, not a one-shot). The message is the trailing positional(s), not behind `--`.
- session id: opencode has no flag to pre-assign a session id on a fresh run; it mints its own. Degrade explicitly: `launch()` ignores `req.sessionId` on a fresh launch (do not attempt to force it).
- resume: `-s/--session <id>` continues a specific session (use when `req.resumeSessionId` is set); `-c/--continue` continues the most recent session (use when resuming with no known prior id), mirroring claude's `--resume <id>` / `-c` fallback.
- attach (reopen, no prompt): `opencode run -s <sessionId> -i` with no message positional.
- permission mapping: opencode has no granular allow-list or `--permission-mode` equivalent, and **no `--add-dir` flag at all** — there is no way to scope writes to `.baiton/runs/<run-id>/` the way claude's `--add-dir` grant does. Degrade explicitly: the opencode adapter cannot emit a run-dir grant; document this gap in the adapter's doc comment rather than silently pretending to enforce it. Map roles via `--agent <name>` (read-only roles get a read-only-oriented agent name if one is configured/available, e.g. `plan`; executor/reviewer get the default/build agent) and treat `--auto` as out of scope (it is explicitly "dangerous" and auto-approves everything, so it is not used to approximate acceptEdits).

antigravity (binary `agy`, tested v1.2.2) — closest to claude's flag shape:
- probe: `agy --version` prints a bare version string (e.g. `1.2.2`), exit 0. Note `-v` is not a version alias (`agy -v` errors "flag needs an argument: -v") — only `--version` works.
- fresh launch: `--prompt-interactive <text>` (short alias `-i`) runs an initial prompt interactively and continues the session — this is the analog of claude's `-- <prompt>` launch. Add `--model <m>`, `--effort low|medium|high` when `req.effort` is set, `--mode accept-edits|plan` for the permission mapping, and `--add-dir <dir>` (repeatable) for the run-dir grant, matching claude's shape closely.
- session id: no flag to pre-assign a fresh session/conversation id; agy mints its own. Degrade explicitly: `launch()` ignores `req.sessionId` on a fresh launch, same as opencode.
- resume: `--conversation <id>` resumes a specific conversation (use when `req.resumeSessionId` is set), `-c/--continue` continues the most recent (use otherwise) — directly mirrors claude's `--resume`/`-c` fallback.
- attach (reopen, no prompt): `--conversation <sessionId>` with no `--prompt-interactive`, plus `--mode`/permission flags and `--add-dir` run-dir grant.
- permission mapping: `--mode plan` for read-only roles (spec-writer, planner, plan-reviewer, pr-writer), `--mode accept-edits` for executor/reviewer — agy has no scoped allow-list like claude's `Write(.baiton/runs/**)`, so read-only roles rely on `--mode plan` refusing edits outright rather than a scoped write allowance; note this as the agy-specific permission mapping (no acceptEdits-fallback flip needed since agy has only the one non-edit mode). Avoid `--dangerously-skip-permissions`.

codex (binary `codex`, tested v0.154.0):
- probe: `codex --version` prints `codex-cli 0.154.0` (a prefixed string, not bare like the others) — treat the whole trimmed stdout as the version string, same tolerant handling as the claude adapter already uses.
- fresh launch: use the **interactive** form `codex [OPTIONS] [PROMPT]` (bare `codex`, not the `codex exec` subcommand, which is a non-interactive one-shot that exits — the wrong shape for a terminal the user can watch/interject in, matching claude/agy). Pass `--model <m>`, `--sandbox read-only|workspace-write|danger-full-access` and `--ask-for-approval on-request|never` for the permission mapping, `--add-dir <dir>` for the run-dir grant, and the prompt as the trailing positional (add a defensive `--` before it, as the claude adapter already does, in case the prompt text starts with `-`).
- session id: codex assigns its own session UUID at start; there is no flag to pre-assign one on a fresh launch. Degrade explicitly: `launch()` ignores `req.sessionId` on a fresh launch.
- effort: `codex --help`/`codex resume --help` expose no `--effort`/reasoning-effort flag. Degrade via codex's generic `-c key=value` config override: `-c model_reasoning_effort=<req.effort>` when `req.effort` is set (codex's own config schema uses that key name) — flag this mapping as needing a final check against `codex doctor`/`~/.codex/config.toml` docs at implementation time, since it is inferred from the override mechanism rather than a dedicated flag.
- resume: `codex resume <sessionId>` when `req.resumeSessionId` is known, else `codex resume --last` (no interactive picker). No `-c/--continue` short-hand exists; `--last` is codex's "most recent" equivalent.
- attach (reopen, no prompt): `codex resume <sessionId>` with no trailing PROMPT positional (PROMPT is optional on `resume`), plus sandbox/approval flags and `--add-dir` run-dir grant.

Architecture implications beyond "add three files": the extension currently wires exactly one `new ClaudeAdapter()` (`src/activation/commands.ts:164`) and threads that single `Adapter` value through `LaunchDeps`, `RunQueue`, `specDraft.ts` and `submitPr.ts` — there is no per-role adapter selection today. Since roles may mix agents, this single-adapter wiring must become a per-role lookup (an agent-id -> Adapter instance registry, keyed by each role's configured `agent`). Likewise, `src/extension.ts` resolves exactly one executable (`CLAUDE_AGENT`/`CLAUDE_EXECUTABLE`) and derives one global `canDispatch`; with mixed agents this must resolve an executable per distinct configured agent id and gate dispatch per role, not globally. `RoleConfig.agent` in `src/config/types.ts` is already an unconstrained `string` and `loadConfig.ts` already accepts any non-empty string, so no schema tightening is required there — but the new agent-id -> CLI-binary-name mapping (`claude`->`claude`, `opencode`->`opencode`, `antigravity`->`agy`, `codex`->`codex`) needs one canonical home that both the adapter registry and the executable resolver read from.

# TODOS

- [done] T01 Widen the Adapter id union and add the agent-id -> CLI-binary-name map in src/adapter/adapter.ts (files: src/adapter/adapter.ts)
- [done] T02 Add src/adapter/opencode.ts implementing Adapter for the opencode CLI (probe/launch/attach per the opencode findings, including the missing --add-dir degrade) (after T01; files: src/adapter/adapter.ts, src/adapter/claude.ts, src/adapter/permissions.ts)
- [done] T03 Add src/adapter/antigravity.ts implementing Adapter for the agy CLI (probe/launch/attach per the antigravity findings) (after T01; files: src/adapter/adapter.ts, src/adapter/claude.ts, src/adapter/permissions.ts)
- [done] T04 Add src/adapter/codex.ts implementing Adapter for the codex CLI (probe/launch/attach per the codex findings, including the interactive-vs-exec subcommand choice and the -c model_reasoning_effort degrade) (after T01; files: src/adapter/adapter.ts, src/adapter/claude.ts, src/adapter/permissions.ts)
- [done] T05 Export the new adapters from src/adapter/index.ts and add an adapter registry keyed by agent id (claude/opencode/antigravity/codex -> Adapter instance) (after T02, T03, T04; files: src/adapter/index.ts)
- [done] T06 Thread per-role adapter selection through the engine: replace the single injected Adapter in LaunchDeps/RunQueue/specDraft/submitPr with a lookup from each role's configured agent id, resolved via the new registry (after T05; files: src/engine/launcher.ts, src/engine/runQueue.ts, src/engine/specDraft.ts, src/engine/submitPr.ts, src/activation/commands.ts)
- [done] T07 Extend executable resolution to resolve one executable per distinct agent id referenced in config.roles and gate stage dispatch per role instead of with one global canDispatch flag (after T01, T06; files: src/activation/executable.ts, src/extension.ts)
- [done] T08 Extend package.json's baiton.agents.<agent>.path settings with opencode, antigravity, and codex entries (executable overrides), consistent with the existing baiton.agents.claude.path setting (after T01; files: package.json)
- [done] T09 Add test/adapter.opencode.test.ts mirroring test/adapter.claude.test.ts (probe success/failure, fresh vs resume launch args, attach, the missing-run-dir-grant degrade) (after T02; files: test/adapter.claude.test.ts, src/adapter/opencode.ts)
- [done] T10 Add test/adapter.antigravity.test.ts mirroring test/adapter.claude.test.ts (probe success/failure, fresh vs resume launch args, attach, --mode permission mapping) (after T03; files: test/adapter.claude.test.ts, src/adapter/antigravity.ts)
- [done] T11 Add test/adapter.codex.test.ts mirroring test/adapter.claude.test.ts (probe success/failure, fresh vs resume launch args via `codex resume`, attach, effort-override mapping) (after T04; files: test/adapter.claude.test.ts, src/adapter/codex.ts)
- [reviewing] T12 Run the full test suite and fix any existing test or type-check breakage from the widened adapter id union and the per-role adapter/executable wiring, confirming default (claude-only) config behavior is unchanged (after T06, T07, T08, T09, T10, T11; files: test/adapter.claude.test.ts)
