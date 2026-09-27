# Plan T04

## Steps

1. Add the optional `cwd` field to LaunchStageInput

   In `src/engine/launcher.ts`, add to the `LaunchStageInput` interface, after `workspaceRoot`/`runId` and before `stage` (or at the end of the optional group beside `relayAsks` — placement is cosmetic, but document it next to `workspaceRoot`):

   ```ts
     /**
      * Optional absolute run root the launch resolves against: the terminal cwd
      * and the `.baiton/runs/<launch-id>/` brief, result and asks directories
      * live under it instead of under `workspaceRoot`. Set by the spec-less run
      * pipeline to launch a stage inside `.baiton/worktrees/<run-id>/`, so the
      * role profiles' RELATIVE run-dir grants (`.baiton/runs/<launch-id>/`) still
      * resolve to the same directory the launcher wrote. Absent, the launch is
      * byte-identical to a launch without the field.
      */
     cwd?: string;
   ```

   Keep `workspaceRoot` required and unchanged in meaning (the workspace root); `cwd` only overrides where this one launch's files and terminal live.

   Files: `src/engine/launcher.ts`

2. Resolve a single `base` path inside launchStage and use it everywhere `root` is used today

   In `launchStage` (src/engine/launcher.ts), immediately after the existing `resolveRoot(input.workspaceRoot)` check that yields `root`, add a second validation for the override and derive one `base` that the rest of the function uses:

   ```ts
     const root = rootCheck.value;

     // The run root this launch resolves against: the workspace root, or the
     // caller's override (a run worktree). Validated the same way, so a bad
     // override halts before anything is written (Req 11.5).
     let base = root;
     if (input.cwd !== undefined) {
       const cwdCheck = resolveRoot(input.cwd);
       if (!cwdCheck.ok) {
         return cwdCheck;
       }
       base = cwdCheck.value;
     }
   ```

   Then replace every remaining use of `root` in the body with `base`. Concretely, the five sites:

   1. `const runDir = path.join(base, '.baiton', 'runs', input.runId);` (briefPath/resultPath follow from it unchanged).
   2. the relay descriptor: `askRelayDescriptor(base, input.runId)`.
   3. the relay-file path resolution and containment check: `const absPath = path.resolve(base, file.path);` (`isInsideDir(runDir, absPath)` is unchanged and now naturally guards the worktree run dir).
   4. `ensureAsksDir(base, input.runId)`.
   5. the terminal options: `cwd: base`.

   Do NOT change `resolveRoot`'s signature, its error `kind` (`'root-resolution'`), or its messages — an invalid `cwd` reuses the same variant, so the error union in the doc comment stays as-is (optionally extend that comment's `root-resolution` line to read "the workspace root, or the `cwd` override, could not be resolved"). Nothing else in the function moves: the adapter `launch()` call, the write/read-back ordering, the brief write and the `initialPromptFor(briefPath)` prompt already derive from `briefPath`, so they follow `base` automatically.

   Files: `src/engine/launcher.ts`

3. Update the module and function doc comments

   In the file header block of `src/engine/launcher.ts`, adjust step 1 and step 3 of the numbered handoff description so they read "under the run root (the workspace root, or `input.cwd` when the caller launches into a run worktree)" instead of "under the workspace root", and note in one sentence that with `cwd` absent the launch is byte-identical to the previous behaviour (mirroring the existing wording used for `relayAsks`). Also fix the `cwd at the workspace root` phrasing in the `launchStage` jsdoc and in the step-4 comment to say "cwd at the run root". No behavioural change; keep the Req references (11.1–11.5, 17.5) intact.

   Files: `src/engine/launcher.ts`

4. Add a `launchStage cwd override` test suite

   Append a new `describe('launchStage cwd override', ...)` block to `test/engine.launcher.test.ts`, following the file's existing conventions: reuse the module-level `StubTerminalHost` and `adapterThat` helpers, create the temp dirs with `fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-launcher-cwd-'))` in `beforeEach` and `fs.rmSync(..., { recursive: true, force: true })` in `afterEach`. Create the worktree dir as a real directory (e.g. `runRoot = path.join(root, '.baiton', 'worktrees', 'r1')` with `fs.mkdirSync(runRoot, { recursive: true })`) so the two roots are distinguishable, and use a local `input(workspaceRoot, cwd?, relayAsks?)` factory shaped like the existing ones (`runId: 'run-1'`, `stage: 'execute'`, `role: 'executor'`, model/effort/resume/sessionId, spreading `cwd`/`relayAsks` only when defined).

   Cases to write:

   1. **brief and result land under the cwd, not the workspace root** — launch with `cwd: runRoot`; assert `result.value.briefPath === path.join(runRoot, '.baiton', 'runs', 'run-1', 'brief.md')` and `resultPath` likewise with `result.json`; assert both files' parent exists and that `path.join(root, '.baiton', 'runs', 'run-1')` does NOT exist.
   2. **terminal cwd is the run root** — assert `host.created[0].cwd === runRoot`.
   3. **the initial prompt and the adapter prompt name the cwd brief path** — capture the `LaunchRequest` from the stub adapter (push into an array as `fileRelayAdapter` does) and assert `req.prompt === \`Read ${briefPath} and do what it says.\`` and `result.value.initialPrompt` equal to it, with `briefPath` under `runRoot`.
   4. **asks directory resolves under the cwd** — launch with `cwd: runRoot, relayAsks: true` and a fallback adapter id (`'opencode'`); assert `result.value.relay.dir === asksDirFor(runRoot, 'run-1')`, that the directory exists on disk under `runRoot`, that no `asks` dir exists under `root`, and that the written brief text (read from the `runRoot` brief path) includes `asksDirFor(runRoot, 'run-1')`.
   5. **relay files resolve and are contained under the cwd run dir** — with a `relayFiles`-returning stub adapter (same shape as `fileRelayAdapter` in the file) returning `{ path: path.join('.baiton', 'runs', 'run-1', '.agents', 'hooks.json'), content: '{}\n' }`, assert the file was written under `runRoot` and not under `root`. Add the negative twin: a relay file path that escapes the run dir (e.g. `.baiton/runs/other/hooks.json`) returns a `launch-args` error, creates no terminal and writes no file.
   6. **an invalid cwd halts with root-resolution and creates nothing** — `cwd: 'relative/dir'` (and a second assertion for `cwd: ''`) returns `!result.ok` with `result.error.kind === 'root-resolution'`, `host.created.length === 0`, and no `.baiton` tree under either root.
   7. **byte-identical when absent** — launch twice with the same input, once omitting `cwd` and once passing `cwd: root` explicitly, into two separate temp workspace roots; assert the two `launchSpec` objects are `deepStrictEqual` after normalising the differing root prefix (or, simpler and preferred: launch with `cwd` omitted and assert `briefPath`, `resultPath`, `host.created[0].cwd` and `launchSpec` are exactly what the pre-existing suites already assert — i.e. everything under `root`). This is the regression pin that an absent `cwd` changes nothing.

   Files: `test/engine.launcher.test.ts`

5. Verify no existing caller is affected and the build/tests are green

   `cwd` is optional, so the three existing callers (`src/engine/specDraft.ts:189`, `src/engine/submitPr.ts:159`, `src/engine/runQueue.ts:692`) need no edit — confirm by grep that none of them constructs a `LaunchStageInput` with an unrelated `cwd` property that would now be consumed. Then run the project's compile and test commands as declared in `package.json` (typically `npm run compile` / `npm test`, i.e. the mocha + ts-node suite under `test/`) and confirm every pre-existing test still passes unchanged, in particular `test/engine.launcher.test.ts`, `test/engine.runQueue*.test.ts` and `test/integration.plan-execute-review.test.ts`.

   Files: `src/engine/launcher.ts`, `test/engine.launcher.test.ts`, `src/engine/runQueue.ts`, `src/engine/specDraft.ts`, `src/engine/submitPr.ts`

## Risks

- Missing one `root` use inside `launchStage` would split the launch across two roots — e.g. leaving `askRelayDescriptor(root, ...)` while the brief goes under the worktree makes the antigravity adapter refuse the launch (it derives the absolute run dir from the descriptor and cross-checks the promised hook path), and leaving `cwd: root` on the terminal makes the role profiles' relative run-dir grants point at a directory the launcher never wrote. After the edit, grep the function body for `root` and confirm the only remaining uses are the `resolveRoot(input.workspaceRoot)` result feeding `base`.
- `workspaceRoot` keeps a second job outside this function: result-path validation (`allowedResultPath` in `src/engine/resultValidation.ts`) and the run-dir watchers resolve against the workspace root. Widening `launchStage` alone does not make those worktree-aware; a later todo owns that. Do not repurpose or drop `workspaceRoot` here, and do not touch `resultValidation.ts`.
- Reusing the `root-resolution` error kind for a bad `cwd` keeps the error union stable but makes the message ambiguous. Keeping `resolveRoot`'s messages verbatim is deliberate: existing tests match on them (`/does not offer effort/`, root-resolution assertions). If a clearer message is wanted, prefix at the call site rather than editing `resolveRoot`.
- The launcher `mkdirSync`s the run dir recursively, so a `cwd` pointing at a not-yet-created worktree silently creates it. That is acceptable (the pipeline creates the worktree first), but it means a typo'd absolute `cwd` fails late rather than at validation — the tests should not assert that a non-existent `cwd` is rejected.
- Adding a `cwd` field to an input interface that tests construct via object literals can trip `exactOptionalPropertyTypes`-style strictness if a test spreads `cwd: undefined`. Spread it conditionally (`...(cwd !== undefined ? { cwd } : {})`) exactly as the existing test factories do for `relayAsks`.

## Acceptance

- `LaunchStageInput` has an optional `cwd?: string` documented as the run root override; no other field changed and no existing caller edited.
- With `cwd` set to an absolute directory, `launchStage` writes `brief.md`, `result.json` and (when `relayAsks`) `asks/` under `<cwd>/.baiton/runs/<runId>/`, resolves adapter relay files against `<cwd>` with the same inside-the-run-dir containment check, hands the adapter a relay descriptor whose `dir` is `asksDirFor(cwd, runId)`, creates the terminal with `cwd: <cwd>`, and returns `briefPath`/`resultPath`/`initialPrompt` naming the `<cwd>` paths — with nothing written under `workspaceRoot`.
- With `cwd` absent, the launch is byte-identical to before: paths under `workspaceRoot`, terminal `cwd` at the workspace root, same `launchSpec`, same prompt.
- An empty or relative `cwd` returns a `root-resolution` error before any directory, file or terminal is created.
- New tests in `test/engine.launcher.test.ts` cover: cwd paths for brief/result, terminal cwd, prompt/adapter-request brief path, asks dir + brief relay text under cwd, relay-file write under cwd plus the escaping-path `launch-args` refusal, invalid-cwd `root-resolution`, and the absent-cwd regression pin.
- `npm run compile` (tsc) succeeds and the full mocha suite passes with no pre-existing test modified — in particular the three existing `launchStage` describe blocks and the spec-mode run-queue / plan-execute-review integration tests.
