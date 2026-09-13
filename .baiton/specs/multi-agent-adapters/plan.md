# plan result

```json
{
  "steps": [
    {
      "title": "Re-verify the agy CLI surface before writing any args",
      "detail": "The OVERVIEW's findings are third-party and can drift, so re-run `agy --version` and `agy --help` first and only then write the flags. Verified during planning against the installed binary: `agy --version` prints the bare string `1.2.2` and exits 0 (`agy -v` is NOT a version alias — it errors 'flag needs an argument: -v', so probe must use the long form). `agy --help` confirms every flag this task needs: `--add-dir` ('Add a directory to the workspace (repeatable)'), `--conversation` ('Resume a previous conversation by ID'), `-c`/`--continue` ('Continue the most recent conversation'), `--effort` ('Reasoning effort ... (low|medium|high)'), `--mode` ('Set the agent execution mode for this session (accept-edits, plan)'), `--model`, and `-i`/`--prompt-interactive` ('Run an initial prompt interactively and continue the session'). Note the help header is 'Usage of agy:' — a Go `flag`-style parser, where a non-boolean flag in the two-arg `--flag value` form consumes the next argv entry verbatim, so a prompt starting with `-` is safe behind `--prompt-interactive` and NO `--` end-of-options marker is needed (unlike claude, whose prompt is a trailing positional after variadic flags). Do not use `--dangerously-skip-permissions`, `--print`/`-p`/`--prompt` (non-interactive one-shot — wrong shape), `--sandbox`, or `--agent`.",
      "files": [
        "src/adapter/adapter.ts"
      ]
    },
    {
      "title": "Create src/adapter/antigravity.ts scaffolded on the OpencodeAdapter/ClaudeAdapter shape",
      "detail": "Add one new file `src/adapter/antigravity.ts` exporting `export class AntigravityAdapter implements Adapter` with `readonly id = 'antigravity' as const`. Mirror the layout T02 landed in src/adapter/opencode.ts (which itself mirrors claude.ts) so the three adapters read identically: imports (`execFile` from 'child_process'; `import type { Adapter, LaunchRequest, LaunchSpec, ProbeResult } from './adapter'`; `import { AGENT_BINARY } from './adapter'`; `import type { Role } from '../model/role'`; `import { isReadOnlyRole, runDirGrant } from './permissions'`), then `const ANTIGRAVITY_BIN = AGENT_BINARY.antigravity;` (which is 'agy' — do NOT hard-code the literal; T01's map is the single source of truth), `const PROBE_TIMEOUT_MS = 10_000;`, the exported mode constants and helper (next step), the class, and a module-private `describeProbeError` helper at the bottom. Constructor takes no arguments: claude's `PermissionMode` / `readOnlyFallbackToAcceptEdits` flip has no agy analogue (agy's only non-edit mode is `plan`, and there is no scoped allow-list to fall back FROM), so accepting the parameter would advertise a knob that does nothing — same decision OpencodeAdapter made. T05's registry will construct it with `new AntigravityAdapter()`.",
      "files": [
        "src/adapter/antigravity.ts",
        "src/adapter/opencode.ts",
        "src/adapter/claude.ts",
        "src/adapter/adapter.ts"
      ]
    },
    {
      "title": "Add the role -> `--mode` mapping as named exports",
      "detail": "Add `export const ANTIGRAVITY_PLAN_MODE = 'plan';`, `export const ANTIGRAVITY_ACCEPT_EDITS_MODE = 'accept-edits';` and `export function antigravityModeFlags(role: Role): string[]` returning `['--mode', isReadOnlyRole(role) ? ANTIGRAVITY_PLAN_MODE : ANTIGRAVITY_ACCEPT_EDITS_MODE]`. Derive the classification from `isReadOnlyRole` in './permissions' rather than re-listing roles, so READ_ONLY_ROLES stays the one place that decides (spec-writer, planner, plan-reviewer, pr-writer -> plan; executor, reviewer -> accept-edits). Note that agy's spelling is hyphenated `accept-edits`, which is NOT the same string as permissions.ts's claude-facing `ACCEPT_EDITS_MODE = 'acceptEdits'` — define agy's own constant here and do not import or reuse the claude one. Exporting the constants and the helper lets T10's test assert by name instead of by string literal, exactly as adapter.claude.test.ts imports ACCEPT_EDITS_MODE / READ_ONLY_ALLOWED_TOOLS and as opencode.ts exports opencodeAgentFlags.",
      "files": [
        "src/adapter/antigravity.ts",
        "src/adapter/permissions.ts"
      ]
    },
    {
      "title": "Document the deliberate degrades and the permission mapping in the class doc comment",
      "detail": "Give the class a doc comment in the same register as OpencodeAdapter's, recording: (1) agy mints its own conversation id and exposes no flag to pre-assign one on a fresh run, so `launch()` deliberately ignores `req.sessionId` when `req.resume` is false — the journal's recorded session id will not match agy's actual conversation for a fresh launch; (2) agy has no scoped write allow-list like claude's `Write(.baiton/runs/**)`, so read-only roles rely on `--mode plan` refusing edits outright rather than on a scoped write allowance, and no `readOnlyFallbackToAcceptEdits`-style flip is needed because `plan` is agy's only non-edit mode; (3) unlike opencode, agy DOES support `--add-dir`, so the Requirement 15.4 per-run grant is emitted normally via `runDirGrant(req.runId)` — call this out so the contrast with opencode.ts's missing-grant degrade is explicit rather than looking like an oversight; (4) `--dangerously-skip-permissions` is deliberately never emitted. Also record the tested version (`agy` v1.2.2) the flags were verified against.",
      "files": [
        "src/adapter/antigravity.ts",
        "src/adapter/opencode.ts",
        "src/adapter/permissions.ts"
      ]
    },
    {
      "title": "Implement probe() against `agy --version`",
      "detail": "Copy the probe/runVersion pair from opencode.ts verbatim in shape, substituting ANTIGRAVITY_BIN: a promise-wrapped private `runVersion()` calling `execFile(ANTIGRAVITY_BIN, ['--version'], { timeout: PROBE_TIMEOUT_MS, windowsHide: true }, (error, stdout) => ...)` that rejects on `error` and resolves `stdout`; `probe()` trims the stdout, returns `{ version: '', ok: false, reason: `${ANTIGRAVITY_BIN} --version produced no version output` }` when the trimmed string is empty, else `{ version: trimmed, ok: true }`, and on throw returns `{ version: '', ok: false, reason: describeProbeError(e) }`. `describeProbeError(e)` maps an ENOENT `code` to `` `${ANTIGRAVITY_BIN} was not found on PATH` ``, an `Error` with a non-empty message to `` `${ANTIGRAVITY_BIN} --version failed: ${e.message}` ``, and anything else to `` `${ANTIGRAVITY_BIN} --version failed` `` — satisfying Requirements 14.2-14.4 (non-empty reason whenever `ok` is false). Keep the tolerant 'trim the whole stdout' handling rather than parsing: v1.2.2 prints a bare `1.2.2`, but the same code must not break if a future release adds a prefix the way codex's `codex-cli 0.154.0` does.",
      "files": [
        "src/adapter/antigravity.ts",
        "src/adapter/opencode.ts",
        "src/adapter/claude.ts"
      ]
    },
    {
      "title": "Implement launch() with the fresh / resume branches",
      "detail": "Build `args: string[] = []` in claude's order so the three adapters stay comparable. First the session branch: if `req.resume` and `req.resumeSessionId !== undefined && req.resumeSessionId.length > 0`, push `'--conversation', req.resumeSessionId`; else if `req.resume`, push `'-c'`; else push nothing at all (fresh launch — `req.sessionId` is deliberately dropped, see the degrade doc comment; this mirrors the claude `--session-id` branch being unavailable here). Then `args.push('--model', req.model)` — pass `req.model` through byte-for-byte unchanged, no rewriting. Then, when `req.effort !== undefined && req.effort.length > 0`, push `'--effort', req.effort` (agy's own help documents `low|medium|high`; the adapter does not validate or remap the value — that is the role config's job, same as claude's `--effort`). Then `args.push(...antigravityModeFlags(req.role))`. Then `args.push(...runDirGrant(req.runId))` — reuse permissions.ts's existing helper unchanged; agy's `--add-dir` is repeatable and takes a directory, matching the emitted `['--add-dir', '.baiton/runs/<run-id>/']` shape exactly. Finally push `'--prompt-interactive', req.prompt` as the initial-prompt flag pair (this is the analog of claude's `-- <prompt>` launch: it runs the prompt and continues the session interactively, rather than a one-shot). Use the long form `--prompt-interactive`, not the `-i` alias, so the args are self-describing in the journal and in test assertions. Return `{ shellPath: ANTIGRAVITY_BIN, shellArgs: args }`. Emit no `--` marker (the prompt is a flag value, not a positional) and set no `env`.",
      "files": [
        "src/adapter/antigravity.ts",
        "src/adapter/adapter.ts",
        "src/adapter/permissions.ts"
      ]
    },
    {
      "title": "Implement attach() as a no-prompt conversation reopen",
      "detail": "`attach(req: { role: Role; runId: string; sessionId: string }): LaunchSpec` returns `{ shellPath: ANTIGRAVITY_BIN, shellArgs: ['--conversation', req.sessionId, ...antigravityModeFlags(req.role), ...runDirGrant(req.runId)] }` — the conversation id, the same role-derived `--mode`, the same run-dir grant, and crucially NO `--prompt-interactive` pair, so the session reopens with no new message (Requirements 3.3, 3.4). This mirrors ClaudeAdapter.attach's `['--resume', id, ...permissionFlags, ...runDirGrant]` one-for-one. Every field of `req` is used here, so `noUnusedParameters` (enabled in tsconfig.json) is satisfied without the deliberate-unused note opencode.ts needed.",
      "files": [
        "src/adapter/antigravity.ts",
        "src/adapter/adapter.ts"
      ]
    },
    {
      "title": "Touch nothing else — index.ts, the registry, the engine, package.json and the test are later tasks",
      "detail": "T03's deliverable is exactly one new file and no edit to any existing file. Do NOT add `export * from './antigravity'` to src/adapter/index.ts (that is T05, together with the agent-id -> Adapter registry), do not touch src/activation/commands.ts, src/engine/* or src/activation/executable.ts (T06/T07), do not add the `baiton.agents.antigravity.path` setting to package.json (T08), and do not add test/adapter.antigravity.test.ts (T10). Keeping the blast radius to one unimported file is what makes the claude-only default path provably unchanged, and it is the same discipline T02 followed and its review passed on.",
      "files": [
        "src/adapter/index.ts",
        "src/adapter/antigravity.ts"
      ]
    },
    {
      "title": "Type-check, lint and run the existing suite",
      "detail": "Run `npm run compile` (tsc), `npm test`, and `npx eslint src/adapter/antigravity.ts --ext .ts` — the exact three commands T02's execute step ran. Expect zero behavior change and zero new failures: nothing imports antigravity.ts yet, so the only realistic failure is a compile error inside the new file (an `Adapter` interface mismatch, an unused import tripping `noUnusedLocals`, or an unused parameter tripping `noUnusedParameters` — both are on in tsconfig.json). The baseline to match is T02's recorded result: 409 passing, 1 pending (the pending test is pre-existing and unrelated). Do not invoke the real `agy` binary from the build or tests; probe failure behavior is exercised by T10 with an emptied `process.env.PATH`, the way adapter.claude.test.ts already does.",
      "files": [
        "src/adapter/antigravity.ts",
        "test/adapter.claude.test.ts"
      ]
    }
  ],
  "risks": [
    "`req.sessionId` is dropped on a fresh launch because agy mints its own conversation id and has no pre-assign flag. The engine records the generated Session_Id in the journal start record (Requirement 3.1) and later uses it for `--resume`/attach; for antigravity roles that recorded id will not match agy's real conversation, so a later attach or resume would target a conversation that does not exist. The adapter's silence is the honest behavior here — the reconciliation (capturing the CLI-minted id, or marking the journal id as unusable for non-claude agents) belongs to T06/T07 and must be raised there rather than papered over inside this adapter. This is the single most consequential gap in T03.",
    "agy is parsed by a Go `flag`-style parser, whose semantics differ from claude's yargs/commander in ways that could bite: it stops flag parsing at the first non-flag argument, and `--flag=value` and `--flag value` are both accepted for non-boolean flags. The design here keeps every argument a flag or a flag value (no positionals at all), which sidesteps both issues — but any future addition of a trailing positional to these args must re-check the parser's behavior rather than assuming claude's.",
    "`--mode plan` is agy's own notion of a non-editing mode, not a scoped allow-list. Read-only roles get whatever `plan` mode actually forbids in the installed agy version; unlike claude's `--allowedTools Read,Glob,Grep,Write(.baiton/runs/**)` there is no per-tool assertion the adapter can make. If `plan` mode turns out to permit writes in some agy release, read-only roles are protected only by the brief and by the post-run reset — worth documenting and worth a manual check during T10 or T12.",
    "`--mode plan` for read-only roles combined with `--add-dir .baiton/runs/<run-id>/` is a slight tension: the run-dir grant exists so a read-only role CAN write its result.json, but `plan` mode may refuse all edits including that write, which would break the result-file contract for antigravity read-only roles. The OVERVIEW nonetheless specifies this mapping, so implement it as specified — but flag it for manual verification (launch a planner role under agy and confirm it can write its result.json); if plan mode blocks the result write, the fix is a mapping change (a T12 follow-up), not an ad-hoc escape in this adapter.",
    "Findings were taken against agy v1.2.2 and re-verified during planning via `agy --version` and `agy --help` (all of `--add-dir`, `--conversation`, `-c/--continue`, `--effort`, `--mode`, `--model`, `-i/--prompt-interactive` confirmed present, and `-v` confirmed NOT a version alias). agy is third-party and self-updating; the implementer should re-run both commands before writing the args and adjust if the surface has changed.",
    "The probe / runVersion / describeProbeError block will now be near-triplicated across claude.ts, opencode.ts and antigravity.ts (and quadrupled by T04). Duplicating it again is still the right call for T03 — it keeps this task to one new file and disturbs no existing test — but the extraction of a shared `probeVersion(bin)` helper into adapter.ts is now clearly warranted and should be raised as a T12 cleanup once all four adapters exist.",
    "agy also exposes an `--agent` flag (per `agy --help`, 'Agent for the current CLI session', with `agy agents` listing them), which is a second plausible permission lever alongside `--mode`. The OVERVIEW deliberately maps roles via `--mode` only; do not additionally emit `--agent` in T03 — mixing both without verifying their interaction risks an unpredictable effective permission set."
  ],
  "acceptance": [
    "src/adapter/antigravity.ts exists and exports `AntigravityAdapter implements Adapter` with `id === 'antigravity'`; `npm run compile` passes with no edit to any other file in the repo.",
    "`shellPath` is `AGENT_BINARY.antigravity` (resolving to 'agy'), sourced from the T01 canonical map rather than a hard-coded string literal.",
    "probe() runs `agy --version` (the long form — never `-v`, which agy rejects), returns the trimmed stdout as `version` with `ok: true` on success, and returns `{ version: '', ok: false }` with a non-empty `reason` on every failure path (verifiable by probing with an emptied `process.env.PATH`, as adapter.claude.test.ts does).",
    "A fresh launch (`resume: false`) produces `['--model', <model>, (…'--effort', <effort>), '--mode', <plan|accept-edits>, '--add-dir', '.baiton/runs/<runId>/', '--prompt-interactive', <prompt>]` — with `--conversation` and `-c` both absent, and `req.sessionId` appearing nowhere in the args.",
    "A resume launch with a known prior id leads with `--conversation <resumeSessionId>`; a resume with no prior id leads with `-c` instead; neither appears on a fresh launch.",
    "`--effort <effort>` is present exactly when `req.effort` is a non-empty string, and `req.model` reaches `--model` byte-for-byte unchanged.",
    "Read-only roles (spec-writer, planner, plan-reviewer, pr-writer) get `--mode plan`; executor and reviewer get `--mode accept-edits` (agy's hyphenated spelling, distinct from permissions.ts's claude-facing 'acceptEdits'); the classification comes from `isReadOnlyRole` in src/adapter/permissions.ts.",
    "Every launch and attach emits the run-dir grant by calling the existing `runDirGrant(req.runId)` from permissions.ts — unchanged and unduplicated — and `--dangerously-skip-permissions`, `--sandbox`, `--print`/`-p`/`--prompt`, `--agent` and any `--` end-of-options marker are never emitted.",
    "attach() returns `['--conversation', <sessionId>, '--mode', <plan|accept-edits>, '--add-dir', '.baiton/runs/<runId>/']` with no `--prompt-interactive` pair and no prompt text anywhere in the args.",
    "The class doc comment explicitly records: the ignored `req.sessionId` on fresh launches, the reliance on `--mode plan` in place of a scoped write allow-list, the absence of any `readOnlyFallbackToAcceptEdits`-style flip, and that `--add-dir` IS supported here (in contrast to opencode.ts's missing-grant degrade).",
    "`npm test` matches T02's recorded baseline — 409 passing, 1 pending, no new failures — and `npx eslint src/adapter/antigravity.ts --ext .ts` is clean.",
    "src/adapter/index.ts, src/adapter/claude.ts, src/adapter/opencode.ts, src/adapter/permissions.ts, src/adapter/adapter.ts, the engine, src/activation/* and package.json are all untouched by this task, and no test file is added."
  ]
}
```
