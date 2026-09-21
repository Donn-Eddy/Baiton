# Plan T16

## Steps

1. Read the three prior probes so this one matches their bar and shape

   Before touching anything, read (a) README.md section '#### Harness ask relay (per-adapter probe findings)' — the claude / opencode / codex bullet blocks and the 'Per-adapter relay state' table at the end; (b) the ask-relay doc comments and wiring in src/adapter/permissions.ts (bottom of file: CLAUDE_RELAY_HOOK_TIMEOUT_SECONDS, CLAUDE_RELAY_HOOK_MATCHER, shellQuote, CLAUDE_RELAY_HOOK_SCRIPT, claudeAskRelayHookCommand, claudeAskRelaySettings, claudeRelayFlags) and its one-line call site in src/adapter/claude.ts (`args.push(...claudeRelayFlags(req.relay))`); (c) the negative-outcome precedents: OpencodeAdapter class doc degrade 3 in src/adapter/opencode.ts and the describe('OpencodeAdapter ask-relay wiring (probe findings)') / describe('CodexAdapter ask-relay wiring (probe findings)') suites in test/adapter.opencode.test.ts and test/adapter.codex.test.ts. (d) src/engine/askRelay.ts for the wire shape the hook must produce: RelayAsk fields {version:1, id, runId, agent, kind:'permission', prompt, tool, args (opaque JSON string), createdAt} and RelayResponse {decision:'approve'|'decline', reason?}, plus askRelayDescriptor(root, runId) and AskRelayDescriptor {protocol:'file-v1', dir, askSuffix, responseSuffix, runId} in src/adapter/adapter.ts. The bar set by the three prior probes is: a mechanism only counts as verified when the probe OBSERVED it change a tool call's outcome end to end; anything read out of --help text or binary strings but not observed is written down as 'Unverified'.

   Files: `README.md`, `src/adapter/permissions.ts`, `src/adapter/claude.ts`, `src/adapter/opencode.ts`, `src/engine/askRelay.ts`, `src/adapter/adapter.ts`, `test/adapter.opencode.test.ts`, `test/adapter.codex.test.ts`

2. Probe agy for a native permission relay, working outside the repo

   The CLI is installed at ~/.local/bin/agy and reports version 1.2.7 (NOT the 1.2.2 the adapter doc comment cites — record the version you actually probe). Do all probe work in a scratch directory (e.g. mktemp -d), never in the Baiton worktree, and keep a transcript you can quote in the README. Surfaces to walk, in this order, stopping as soon as one is verified end to end:

   1. Flag surface. `agy --help` (captured for this plan) shows NO --settings / --hooks / --permission-callback style flag. The full flag list is: --add-dir, --agent, -c/--continue, --conversation, --dangerously-skip-permissions, --disable-slash-commands, --effort, -i, --input-format, --json-schema, --log-file, --mode, --model, --new-project, --output-format, -p/--print, --print-timeout, --project, --prompt, --prompt-interactive, --remote-control, --sandbox. Confirm against the installed build and record the negative. `--dangerously-skip-permissions` is on the never-emit list (adapter degrade 4): it must not be emitted even to make a probe pass, and any finding that depends on it is a non-result.
   2. `--agent` / `agy agent` / `agy agents`. The adapter's degrade 5 already records that `agy agents` printed nothing on the dev host and the agent-definition format is undocumented. Re-check on 1.2.7 (`agy agents`, `agy help agent`): if agents are now definable from a file/flag, check whether a definition can carry a permission hook or delegation, and whether it is installable WITHOUT writing a file (launch() is pure and writes nothing — that is exactly what disqualified opencode's plugin surface).
   3. `agy plugin` / `agy plugins` (`agy help plugin`, `agy plugin list`). Determine whether a plugin can intercept a tool call and whether it can be installed from argv/env rather than an on-disk install. An on-disk-only install is a negative, same as opencode and codex.
   4. `agy mcp` (`agy help mcp`). An MCP server is not a file-protocol hook and needs a running process; record it as a one-line negative unless it demonstrably delegates permission decisions.
   5. `--remote-control` / `agy remote-control`. This is the most promising 1.2.x-only surface: it creates a remote connection for the session and may be where permission prompts are delegated. Check `agy help remote-control` and whether a permission prompt is surfaced to (and answerable by) the remote side; it needs a background daemon, so judge it by the same 'installable from a pure launch()' test.
   6. Env / config layer. Look for an OPENCODE_CONFIG_CONTENT-style inline layer (`env | grep -i agy`, `agy install --help`, and `strings $(command -v agy) | grep -Ei 'pretooluse|hook|permission|webhook|AGY_[A-Z_]+'`). Strings evidence is a lead, never a verification.
   7. Behavioural check for whatever surface looks live: run a single non-interactive turn that must call a tool, e.g. `agy -p --mode accept-edits --print-timeout 120s 'run the shell command: echo baiton-probe'` in the scratch dir with the candidate wiring in place, and confirm (a) the hook/relay actually fires, (b) it receives the tool name and arguments, and (c) its decision changes the outcome (a deny blocks the call and the model is told). All three legs are required for 'verified'. If agy needs auth or network and the turn cannot run, record that leg as unprobeable and mark the surface Unverified — do not infer.

   Files: (none)

3. Emit wiring only for what the probe verified, in src/adapter/antigravity.ts

   Expected outcome given the --help surface (no inline settings/hook flag): NO wiring. In that case the only code change is documentation — add a new numbered point to the AntigravityAdapter class doc comment (the list currently runs 1,2,3,4,6,5 — append as point 7 and leave the existing mis-ordering alone), worded like OpencodeAdapter degrade 3: this adapter emits no ask-relay wiring, `LaunchRequest.relay` is deliberately ignored, `launch()`/`attach()` are byte-identical with and without a descriptor, state the version probed (1.2.7) and the decisive reason, point at README.md 'Harness ask relay (per-adapter probe findings)' for the transcript, and say the config-driven fallback (`--mode plan|accept-edits` plus the `--add-dir` run-dir grant) remains the whole policy surface. Explicitly note that `--dangerously-skip-permissions` is not a relay and stays never-emitted. Do NOT touch launch(), attach(), antigravityModelFlags, antigravityModeFlags or the model catalogue, and do not import AskRelayDescriptor if nothing uses it (lint will flag an unused import).

   If and only if a surface was verified on all three legs: add a pure exported helper in this file, `export function antigravityRelayFlags(relay?: AskRelayDescriptor): string[]`, modelled exactly on claudeRelayFlags — return `[]` when `relay === undefined` OR `relay.protocol !== 'file-v1'` (an unknown protocol must never emit a half-understood hook) — and spread it into launch()'s args immediately before the `--prompt-interactive` pair (`args.push(...antigravityRelayFlags(req.relay))`). Keep attach() relay-free: reopening a finished session must not re-arm the relay. Reuse shellQuote from src/adapter/permissions.ts rather than writing a second quoter, and keep the hook program's ask JSON exactly parseAsk-compatible (version/id/runId/agent:'antigravity'/kind:'permission'/prompt/tool/args-as-string/createdAt), degrading to the CLI's own prompt (never a silent allow) on parse, write, read or deadline failure.

   Files: `src/adapter/antigravity.ts`

4. Pin the outcome in test/adapter.antigravity.test.ts

   Append a new suite at the end of the file, modelled on the CodexAdapter one: `describe('AntigravityAdapter ask-relay wiring (probe findings)', ...)` preceded by a doc comment that states the probed version (agy 1.2.7, 2026-09-20), the decisive negative, and that the tests PIN the outcome so a future native relay fails them instead of drifting in. Add the imports the suite needs: `import { askRelayDescriptor } from '../src/engine/askRelay';` and extend the existing type import to `import type { AskRelayDescriptor, LaunchRequest } from '../src/adapter/adapter';`. Reuse the file's existing `req()` helper and `const relay = askRelayDescriptor('/repo', 'run-123');`.

   For the expected no-wiring outcome, the tests are:
   - 'ignores the relay descriptor entirely: the whole launch spec is byte-identical' — assert.deepStrictEqual(adapter.launch(req({ relay })), adapter.launch(req())).
   - 'treats an explicitly undefined relay the same as an absent one'.
   - 'never lets the asks directory reach the argv' — join shellArgs and assert it contains neither relay.dir nor relay.askSuffix nor relay.responseSuffix.
   - 'carries no env layer at all' — assert.strictEqual(adapter.launch(req({ relay })).env, undefined) (agy is launched with no env today; keep that pinned).
   - 'emits no forbidden flag that would buy a relay by giving up the policy' — assert --dangerously-skip-permissions and --sandbox are absent, and that the --mode value is still the role's plan/accept-edits value.
   - 'is unaffected by an unknown protocol, exactly as it is by file-v1' — cast `{ ...relay, protocol: 'file-v2' } as unknown as AskRelayDescriptor` and assert byte-identical.
   - both resume branches byte-identical: `{resume:true, resumeSessionId:'sess-real'}` (the --conversation branch) and `{resume:true, resumeSessionId:undefined}` (the -c branch).
   - 'attach() installs no relay (it takes no descriptor at all)' — attach({role:'planner', runId:'run-777', sessionId:'sess-1'}) contains neither relay.dir nor any forbidden flag.
   - a `for (const role of ROLES)` loop asserting byte-identity per role (ROLES is already imported).
   If wiring WAS verified instead, replace the byte-identity assertions with positive ones (the flag pair is present, its value round-trips through JSON.parse to the probed shape, relay.dir/runId appear exactly once, `[]` for an unknown protocol, attach() still relay-free, and the pre-existing --model/--mode/--add-dir/--prompt-interactive argv order is unchanged).

   Files: `test/adapter.antigravity.test.ts`

5. Record the findings in README.md

   In the '#### Harness ask relay (per-adapter probe findings)' section, insert a new top-level bullet block `- **antigravity (agy) findings** (probed \`agy --version\` → 1.2.7, 2026-09-20):` after the codex block and immediately before `- **Per-adapter relay state**:`. Match the prose style of the codex/opencode blocks: sub-bullets quoting the actual observed output (the full `agy --help` flag list and the absence of any --settings/hooks flag; what `agy agents`, `agy help plugin`, `agy help mcp` and `agy help remote-control` printed; what the behavioural turn did), one bold **decisive** sub-bullet naming the reason no wiring is emitted, and explicit **Unverified:** sub-bullets for every leg the probe could not close (e.g. the interactive `--prompt-interactive` form vs `-p`, anything seen only in binary strings, any surface blocked by auth/network). State plainly that `--dangerously-skip-permissions` exists but is never emitted, so it is not a relay route.

   Then update the state table row from `| antigravity (agy) | config-driven fallback | not probed yet |` to the probed verdict, e.g. `| antigravity (agy) | config-driven fallback | probed 2026-09-20, version 1.2.7 — <one-line reason> |`, matching the phrasing of the opencode/codex rows (or, if verified, `native <mechanism>` / `yes (version 1.2.7, 2026-09-20)` like the claude row). Leave the rest of the section, including the closing 'Adapters without a verified native relay…' paragraph, unchanged.

   Files: `README.md`

6. Verify

   Run, in order, from the repo root: `npm run compile`; `npx mocha --no-config test/adapter.antigravity.test.ts --require ts-node/register`; `npm run lint`; `npm test`. All must be green, and npm test's total must be the prior count plus the new antigravity relay tests with no pre-existing test changed. Finish with `git status --short && git diff --stat` and confirm the only changed files are src/adapter/antigravity.ts, test/adapter.antigravity.test.ts and README.md — in particular that the probe left nothing behind in the worktree (no scratch dirs, no .baiton/runs additions from probe turns, no agy log/project files).

   Files: (none)

## Risks

- Shipping unverified wiring. The whole point of this todo is that only a surface observed to (a) fire, (b) carry the tool name and args, and (c) change the outcome is wired. A --help line, a binary string, or a flag that merely 'was accepted' is not verification — write it down under **Unverified:** and emit nothing, exactly as the opencode and codex probes did.
- Version drift in the adapter doc comment. The class doc and several degrades cite `agy` v1.2.2 while the installed CLI is 1.2.7. Record the version actually probed (1.2.7) in the README and the new doc point; do NOT silently rewrite the older 1.2.2 claims (model catalogue, --help degrades) from this probe unless you re-verified them, and if you do re-verify any, say so.
- `--dangerously-skip-permissions` is a trap: it would make a relay look unnecessary by auto-approving everything. It is on the never-emit list (degrade 4). Do not emit it, and do not let a probe run that used it count as a finding about the shipped argv.
- Probing in the worktree. agy writes project/log state and may create files; run every probe turn in a mktemp -d scratch dir and confirm a clean `git status` at the end. A probe turn must also never be pointed at the repo with --add-dir.
- agy may need auth or network for a real turn, so the behavioural leg can be unrunnable on this host. That is an unprobeable leg, not a negative result: record it as **Unverified:** rather than asserting the mechanism does not exist.
- Purity of launch(). Any relay that needs a file written to disk (a plugin file, an agent definition, a $AGY_HOME trust entry) is disqualified for the same reason opencode's and codex's were: `launch()` is a pure function that writes nothing, and the launcher is outside this change. Say so explicitly rather than half-wiring it.
- Test drift. The existing antigravity suite pins exact argv order (--conversation/-c, --model, --effort, --mode, --add-dir, --prompt-interactive). If wiring is emitted, insert it before --prompt-interactive and update only the tests the new pair genuinely affects; if nothing is emitted, no existing test may change at all.
- The read-only-role degrade (`--mode plan` refuses even run-dir writes) is unrelated to the relay and out of scope. Do not 'fix' it here, and do not let a relay probe turn into a plan-mode change.

## Acceptance

- README.md contains an `- **antigravity (agy) findings** (probed `agy --version` → 1.2.7, 2026-09-20):` block placed after the codex block and before '- **Per-adapter relay state**:', with sub-bullets quoting observed output, one bold decisive sub-bullet, and an explicit **Unverified:** sub-bullet for every leg that could not be closed.
- The 'Per-adapter relay state' table's antigravity row no longer reads 'not probed yet': it names the relay actually shipped and a Verified cell carrying the probe date and version 1.2.7.
- src/adapter/antigravity.ts documents the relay outcome in the AntigravityAdapter class doc comment, naming the probed version and pointing at the README section.
- Emitted wiring matches the probe exactly: if no surface was verified, `adapter.launch(req)` and `adapter.attach(...)` are byte-identical with and without an AskRelayDescriptor for every role and both resume branches, and neither relay.dir nor either suffix appears in shellArgs or env; if a surface was verified, the flag it needs is emitted from a pure helper that returns [] for `undefined` and for any protocol other than 'file-v1', attach() stays relay-free, and the ask JSON the wiring produces is accepted by parseAsk from src/engine/askRelay.ts.
- test/adapter.antigravity.test.ts gains a `describe('AntigravityAdapter ask-relay wiring (probe findings)')` suite that pins that outcome (including the unknown-protocol case, both resume branches, attach(), the per-role loop, and the absence of --dangerously-skip-permissions), with a doc comment naming the probed version and saying the tests exist so a future native relay fails them.
- No existing test in test/adapter.antigravity.test.ts was modified unless emitted wiring genuinely changed the argv.
- `npm run compile`, `npx mocha --no-config test/adapter.antigravity.test.ts --require ts-node/register`, `npm run lint` and `npm test` are all green, with npm test's passing count up by the new tests and nothing newly pending or failing.
- `git status --short` shows only src/adapter/antigravity.ts, test/adapter.antigravity.test.ts and README.md as changed — the probe left no scratch files, logs or run artifacts in the worktree.
