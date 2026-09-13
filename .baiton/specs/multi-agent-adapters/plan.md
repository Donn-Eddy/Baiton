# plan result

```json
{
  "steps": [
    {
      "title": "Create src/adapter/opencode.ts scaffolded on the ClaudeAdapter shape",
      "detail": "Add a new file `src/adapter/opencode.ts` exporting `export class OpencodeAdapter implements Adapter` with `readonly id = 'opencode' as const`. Mirror src/adapter/claude.ts's file layout: imports (`execFile` from 'child_process'; `Adapter, LaunchRequest, LaunchSpec, ProbeResult, AGENT_BINARY` from './adapter'; `Role` from '../model/role'; `isReadOnlyRole` from './permissions'), a module-level binary constant sourced from the canonical map added in T01 — `const OPENCODE_BIN = AGENT_BINARY.opencode;` (do NOT hard-code 'opencode'; the map is the single source of truth per the OVERVIEW) — a `const PROBE_TIMEOUT_MS = 10_000;`, the class, and a local `describeProbeError` helper at the bottom. Constructor: take no arguments. Claude's `PermissionMode` flip (`readOnlyFallbackToAcceptEdits`) has no opencode analogue — opencode has no scoped write allow-list at all — so accepting the parameter would imply a knob that does nothing; document that in the class doc comment and let T05's registry construct it with `new OpencodeAdapter()`.",
      "files": [
        "src/adapter/opencode.ts",
        "src/adapter/adapter.ts",
        "src/adapter/claude.ts"
      ]
    },
    {
      "title": "Document the two explicit degrades in the class doc comment",
      "detail": "The OVERVIEW requires the gaps be documented rather than silently papered over. Put a doc comment on the class stating: (1) opencode has NO `--add-dir` flag and no granular allow-list, so this adapter cannot emit the per-run write grant that Requirement 15.4 / `runDirGrant()` expresses for claude — the run-dir scoping is unenforced for opencode roles and is relied on only via the brief; `--auto` is deliberately not used to approximate acceptEdits because it auto-approves everything (opencode's own help calls it 'dangerous!'). (2) opencode mints its own session id on a fresh run and exposes no flag to pre-assign one, so `launch()` ignores `req.sessionId` when `req.resume` is false. Also note that per-role permissioning is expressed only through `--agent <name>`, whose profiles are user-configured in opencode, so the mapping is best-effort.",
      "files": [
        "src/adapter/opencode.ts",
        "src/adapter/permissions.ts"
      ]
    },
    {
      "title": "Implement probe() against `opencode --version`",
      "detail": "Copy ClaudeAdapter.probe/runVersion verbatim in shape, substituting OPENCODE_BIN: run `execFile(OPENCODE_BIN, ['--version'], { timeout: PROBE_TIMEOUT_MS, windowsHide: true })` in a promise-wrapped private `runVersion()`; on success trim stdout, return `{ version: '', ok: false, reason: '<bin> --version produced no version output' }` when the trimmed string is empty, else `{ version: trimmed, ok: true }`; on throw return `{ version: '', ok: false, reason: describeProbeError(e) }`. `describeProbeError` maps an ENOENT `code` to `'opencode was not found on PATH'`, an `Error` with a message to `'opencode --version failed: <message>'`, and anything else to `'opencode --version failed'` — matching Requirements 14.2-14.4 (non-empty reason whenever `ok` is false). Verified on the installed v1.18.30: `opencode --version` prints the bare string `1.18.30` and exits 0, so no prefix-stripping is needed, but keep the tolerant 'trim the whole stdout' handling claude uses rather than parsing.",
      "files": [
        "src/adapter/opencode.ts",
        "src/adapter/claude.ts"
      ]
    },
    {
      "title": "Add the role -> `--agent` mapping",
      "detail": "Add two exported constants and one exported helper in opencode.ts: `export const OPENCODE_PLAN_AGENT = 'plan';`, `export const OPENCODE_BUILD_AGENT = 'build';`, and `export function opencodeAgentFlags(role: Role): string[]` returning `['--agent', isReadOnlyRole(role) ? OPENCODE_PLAN_AGENT : OPENCODE_BUILD_AGENT]`. Reuse `isReadOnlyRole` from './permissions' rather than re-listing the read-only roles, so the role classification stays in one place (spec-writer, planner, plan-reviewer, pr-writer -> plan; executor, reviewer -> build). Export the constants and helper so T09's test can assert against them by name instead of string literals, exactly as adapter.claude.test.ts imports READ_ONLY_ALLOWED_TOOLS / ACCEPT_EDITS_MODE.",
      "files": [
        "src/adapter/opencode.ts",
        "src/adapter/permissions.ts"
      ]
    },
    {
      "title": "Implement launch() with the fresh / resume branches",
      "detail": "Build `args` starting with the `run` subcommand, then: if `req.resume` and `req.resumeSessionId` is a non-empty string push `'-s', req.resumeSessionId`; else if `req.resume` push `'-c'`; else push nothing (fresh run — `req.sessionId` is deliberately dropped, see the degrade above). Then push `'-m', req.model` (pass `req.model` through unchanged: opencode model ids are `provider/model`, e.g. `anthropic/claude-sonnet-5`, and it is the role config's job to already carry that shape — the adapter must NOT try to rewrite a bare claude model id). Then push `...opencodeAgentFlags(req.role)`. Then, when `req.effort !== undefined && req.effort.length > 0`, push `'--variant', req.effort`. Then push `'-i'` so the launched process stays a live interactive session in the terminal, matching how claude's `-- <prompt>` launch leaves an ongoing session rather than a one-shot. Finally push `req.prompt` as the trailing message positional. Return `{ shellPath: OPENCODE_BIN, shellArgs: args }`. No `runDirGrant()` call and no `--` end-of-options marker: `run`'s message is a plain variadic positional (`opencode run [message..]`), and claude's `--` exists only because its variadic `--add-dir`/`--allowedTools` would otherwise swallow the prompt — neither applies here.",
      "files": [
        "src/adapter/opencode.ts",
        "src/adapter/adapter.ts"
      ]
    },
    {
      "title": "Implement attach() as a no-prompt session reopen",
      "detail": "`attach(req: { role: Role; runId: string; sessionId: string }): LaunchSpec` returns `{ shellPath: OPENCODE_BIN, shellArgs: ['run', '-s', req.sessionId, ...opencodeAgentFlags(req.role), '-i'] }` — the session flag, the same role-derived `--agent` profile, interactive mode, and no message positional (Requirements 3.3, 3.4). `req.runId` is accepted to satisfy the Adapter signature but unused, since there is no `--add-dir` to grant it with; reference it in the doc comment (or name it in a short `void`-style comment) so the unused parameter reads as deliberate rather than forgotten, and so `noUnusedParameters`, if enabled in tsconfig, does not trip.",
      "files": [
        "src/adapter/opencode.ts",
        "src/adapter/adapter.ts"
      ]
    },
    {
      "title": "Leave index.ts, the registry and the engine wiring alone",
      "detail": "Do not add `export * from './opencode'` to src/adapter/index.ts and do not touch src/activation/commands.ts, the engine or package.json in this task — exporting the new adapters and adding the agent-id -> Adapter registry is T05, the per-role engine threading is T06/T07, and the settings entries are T08. T02's deliverable is exactly one new file (plus nothing else), which keeps the claude-only default path provably unchanged. Similarly, do not add the T09 test file here.",
      "files": [
        "src/adapter/index.ts",
        "src/adapter/opencode.ts"
      ]
    },
    {
      "title": "Type-check and run the existing suite",
      "detail": "Run the project's TypeScript build/type-check and the existing test suite (npm run compile / npm test, per package.json's scripts). Expect zero changes in behavior or output: nothing imports opencode.ts yet, so the only failure mode is a compile error in the new file (most likely a mismatch against the `Adapter` interface, or `AGENT_BINARY` not being exported the way T01 landed it — read src/adapter/adapter.ts first and use the names actually present rather than the names assumed here). Do not run the real `opencode` binary as part of the build; probe behavior is exercised by T09 with an emptied PATH, the way adapter.claude.test.ts does.",
      "files": [
        "src/adapter/opencode.ts",
        "test/adapter.claude.test.ts"
      ]
    }
  ],
  "risks": [
    "No run-dir write scoping exists for opencode: there is no `--add-dir` and no allow-list, so unlike the claude path, Requirement 15.4's grant is unenforceable and read-only roles are constrained only by whichever `--agent` profile the user has configured. This is a real weakening of the permission model for opencode roles, not a cosmetic gap — it must be documented in the adapter doc comment (and is worth surfacing in user-facing docs later), never silently implied to be enforced.",
    "`--agent plan` / `--agent build` are opencode profile NAMES, not built-in guarantees. If the user's opencode install has no agent by that name the launch may fail or fall back to the default agent with full permissions. Consider whether the names should be overridable later (config), but keep T02 to the fixed defaults the OVERVIEW specifies; flag the assumption in the doc comment.",
    "`req.sessionId` is dropped on a fresh launch because opencode mints its own id. Any engine code that assumes the journal's recorded session id will match the CLI's actual session (and therefore that `attach`/resume will work after a fresh opencode launch) will be wrong for opencode. That reconciliation is out of T02's scope but should be called out to T06/T07 — the adapter's silence here is the honest behavior, the engine's assumption is what may need revisiting.",
    "Prompt text beginning with `-` could be parsed as an option by opencode's yargs-based parser, since the message is a bare trailing positional with no `--` guard available the way claude has one. Low likelihood for generated briefs (they start with 'Read ...'), but if T09 or manual testing shows it matters, the mitigation is to verify whether `opencode run -- <text>` populates the positional before adding such a marker — do not add an unverified `--`, which yargs may swallow entirely.",
    "The probe/`describeProbeError` block will be near-duplicated across opencode.ts, antigravity.ts (T03) and codex.ts (T04). Duplicating it is the right call for T02 (it keeps the task to one new file and does not disturb claude.ts's existing tests); the deduplication into a shared `probeVersion(bin)` helper in adapter.ts is better raised as a T12 cleanup once all three adapters exist and the shared shape is proven.",
    "These findings were taken against opencode v1.18.30 and re-verified during planning (`opencode run --help` confirms `-s`, `-c`, `-m`, `--agent`, `--variant`, `-i`, `--auto`, and the absence of any `--add-dir`). opencode is third-party and can change flags between releases; the implementer should re-run `opencode --version` and `opencode run --help` before writing the args and adjust if they differ."
  ],
  "acceptance": [
    "src/adapter/opencode.ts exists and exports `OpencodeAdapter implements Adapter` with `id === 'opencode'`, and the TypeScript build passes with no changes to any other source file.",
    "`shellPath` is sourced from `AGENT_BINARY.opencode` (the T01 canonical map), not a hard-coded string literal.",
    "probe() returns `{version, ok}` with a non-empty `reason` whenever `ok` is false (verifiable by probing with an emptied PATH, as adapter.claude.test.ts does), and returns the trimmed `--version` stdout as `version` on success.",
    "A fresh launch (`resume: false`) produces `['run', '-m', <model>, '--agent', <plan|build>, (…'--variant', <effort>), '-i', <prompt>]` — with `-s`/`-c` absent and `req.sessionId` appearing nowhere in the args.",
    "A resume launch with a known prior id produces `-s <resumeSessionId>` immediately after `run`; a resume with no prior id produces `-c` instead; neither appears on a fresh launch.",
    "`--variant <effort>` is present exactly when `req.effort` is a non-empty string, and `req.model` is passed to `-m` byte-for-byte unchanged.",
    "Read-only roles (spec-writer, planner, plan-reviewer, pr-writer) get `--agent plan`; executor and reviewer get `--agent build`; the classification comes from `isReadOnlyRole` in src/adapter/permissions.ts.",
    "No `--add-dir` argument and no `--auto` argument is ever emitted by launch() or attach(), and the class doc comment explicitly records the missing run-dir grant and the ignored `req.sessionId` as deliberate degrades.",
    "attach() returns `['run', '-s', <sessionId>, '--agent', <plan|build>, '-i']` with no trailing prompt positional.",
    "The existing test suite passes unchanged; src/adapter/index.ts, the engine and package.json are untouched by this task."
  ]
}
```
