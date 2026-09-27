# Plan T09

## Steps

1. Widen OrchestratorPhase with a third phase 'run'

   In src/orchestrator/guard.ts change `export type OrchestratorPhase = 'gather' | 'drive';` (line 91) to `'gather' | 'drive' | 'run'`, and `ORCHESTRATOR_PHASES` (line 94) to `['gather', 'drive', 'run'] as const`. Extend the doc comment above the type (currently 'Which of the orchestrator's two jobs...') to describe three jobs, adding a bullet: `- 'run' — a non-Spec (Bug/Quick/Refactor/Investigate) Workspace conversation: inspect the repository with the read tools, agree the work, then dispatch one spec-less run through start_run or investigate.` Add an explicit warning sentence that the PHASE named 'run' is not the TOOL named `run`: the `run` tool stays `phases: ['drive']` and dispatches a spec stage for a todo, while the `run` phase advertises `start_run`/`investigate` and never sees `run`. Also touch up the sentence 'Each tool declares the phases it belongs to' to say three phases, and the `Tool.dispatch` doc (line ~101) so 'e.g. `run`' reads 'e.g. `run`, `start_run`, `investigate`'. Change nothing else in this file: `guardTool` already disables every `mutating || dispatch === true` tool under Restricted Mode, which is how the two new dispatch tools get Restricted-Mode coverage for free.

   Files: `src/orchestrator/guard.ts`

2. Add the RunPipelineSeam to seams.ts

   In src/orchestrator/seams.ts add `import { RunMode } from '../model/mode';` beside the existing `Stage` import (this file must keep importing only from ../model, never from ../engine). Then add, modelled byte-for-byte on the DraftSpecSeam block:

   ```ts
   /** One confirmed spec-less dispatch from a run-mode conversation. */
   export interface StartRunRequest {
     /** The mode the run executes as; never 'spec'. */
     mode: RunMode;
     /** The one-line statement of the work (or the question, for investigate). */
     statement: string;
     /** The repository-relative files the orchestrator guessed are involved. */
     files: string[];
     /** How to reproduce the defect; only a Bug run supplies it. */
     reproduction?: string;
   }

   /**
    * The answer the run pipeline gives `start_run`/`investigate`. `started`
    * carries the run id (and the branch the run was created on, when the host
    * knows it) so the model can tell the user where to watch; `busy` means a
    * stage is already running for the repository — a spec queue, the spec draft,
    * or another run; `refused` carries the reason the run never launched.
    */
   export type StartRunOutcome =
     | { kind: 'started'; runId: string; branch?: string }
     | { kind: 'busy' }
     | { kind: 'refused'; reason: string };

   /**
    * The spec-less run pipeline seam the dispatch tools start a run through. The
    * stage engine implements it over `createRunPipeline(...).start`; the tools
    * only ask it to start a run and report what it answers. It resolves as soon
    * as the run is launched, so the chat turn is never blocked on the run.
    *
    * The seam is deliberately narrower than `RunPipelineRequest` in
    * src/engine/runPipeline.ts: the pipeline also wants `composerMode` and
    * `explicitMode`, which only the host knows (the composer's Mode select). The
    * host adapter fills those in; a tool never guesses them.
    */
   export interface RunPipelineSeam {
     start(req: StartRunRequest): Promise<StartRunOutcome>;
   }
   ```

   Also extend this module's header comment with a `- {@link RunPipelineSeam}` bullet next to the `RunQueueSeam`/`DraftSpecSeam` ones.

   Files: `src/orchestrator/seams.ts`

3. Carry the seam on ToolServices

   In src/orchestrator/toolServices.ts add `RunPipelineSeam` to the existing `./seams` import list and add an optional field after `draftSpec`:

   ```ts
     /**
      * The spec-less run pipeline the `start_run` and `investigate` tools dispatch
      * into. Optional so a host that has not wired the run pipeline still builds a
      * registry; both tools then report themselves as unavailable and dispatch
      * nothing.
      */
     runPipeline?: RunPipelineSeam;
   ```

   Add a matching `- \`runPipeline\` — the spec-less run pipeline seam \`start_run\` and \`investigate\` dispatch into.` line to the interface's bullet list doc comment. Keep every existing field and its optionality unchanged.

   Files: `src/orchestrator/toolServices.ts`

4. Advertise the read tools in the run phase

   In src/orchestrator/readTools.ts append `'run'` to the `phases` array of all eight read tools: list_specs (line ~49), read_spec (~85), list_files (~128), read_file (~159), search (~219), git_status (~286), git_diff (~312), git_log (~342). So `['gather', 'drive']` becomes `['gather', 'drive', 'run']` and `['gather']` becomes `['gather', 'run']`. All eight — including list_specs/read_spec — because the OVERVIEW says 'the read tools ... are advertised in run', and because the existing test case 'runs the same tool when it is called in a phase it belongs to' loops ORCHESTRATOR_PHASES calling `read_spec` and asserts ok:true, so leaving read_spec out of the new phase would break an existing assertion. Extend this module's header comment with one sentence: the same read surface serves the run phase, where a run-mode conversation inspects the repository before dispatching. Do not change any tool's behaviour, schema or description.

   Files: `src/orchestrator/readTools.ts`

5. Add shared helpers to controlTools.ts for the two dispatch tools

   At the bottom of src/orchestrator/controlTools.ts (beside the existing `readString`/`readBoolean`/`isSlug` helpers) add:

   1. `const RUN_TOOL_MODES: readonly RunMode[] = ['bug', 'quick', 'refactor'] as const;` — the three build modes `start_run` accepts. Import `RunMode, isRunMode` from '../model/mode'. `investigate` is dispatched by its own tool, and `spec` is the spec pipeline, so neither is accepted as a `start_run` argument.

   2. `function readFileList(args: unknown, tool: string): { ok: true; files: string[] } | { ok: false; error: string }` — reads the `files` key. Absent or non-array => error `` `${tool} requires a "files" array of repository-relative paths` ``. Each entry must be a string that is non-empty after trimming (else `` `each ${tool} "files" entry must be a non-empty string` ``), must not be absolute (`path.isAbsolute`) and must not contain a `..` path segment (else `` `${tool} "files" must be repository-relative paths without "..": ${entry}` ``). Trim each entry and drop exact duplicates, preserving first-seen order. An empty array is legal (nothing was guessed).

   3. `function readOneLine(args: unknown, key: string, tool: string): { ok: true; value: string } | { ok: false; error: string }` — reads a required string, rejects missing/non-string/blank-after-trim with `` `${tool} requires a non-empty string "${key}"` ``, and rejects an embedded newline with `` `${tool} "${key}" must be a single line` `` (the manifest stores a one-line statement). Returns the trimmed value.

   4. `async function askConfirmCard(services: ToolServices, prompt: string, detail: string): Promise<boolean>` — when `services.intervention !== undefined`, `await services.intervention.ask({ kind: 'confirm', prompt, detail })` and return `answer.kind === 'approved'`; otherwise fall back to `services.confirm.confirm(`${prompt}\n\n${detail}`)` so a host that wired only the legacy confirm seam still gets the card text verbatim.

   5. `async function targetBranch(services: ToolServices): Promise<string>` — `try { const b = (await services.git.currentBranch()).trim(); return b === '' ? services.gitSettings.base : b; } catch { return services.gitSettings.base; }`. The card must never fail because git did; the pipeline re-derives the real base itself when it starts.

   Files: `src/orchestrator/controlTools.ts`

6. Implement start_run

   In src/orchestrator/controlTools.ts add `function startRunTool(services: ToolServices): Tool` and register it in `createControlTools` (after `draftSpecTool(services)`).

   ```ts
   name: 'start_run',
   description: 'Start a spec-less run (bug, quick or refactor): hand a one-line statement of the work and the files involved to the planner, which plans, executes and reviews it on its own branch.',
   mutating: false,
   phases: ['run'],
   dispatch: true,
   schema: {
     type: 'object',
     properties: {
       mode: { type: 'string', enum: ['bug', 'quick', 'refactor'] },
       statement: { type: 'string' },
       files: { type: 'array', items: { type: 'string' } },
       reproduction: { type: 'string' },
     },
     required: ['mode', 'statement', 'files'],
     additionalProperties: false,
   },
   ```

   `run(args, _tc)` in this exact order, so nothing is asked or dispatched on a malformed call (mirroring `draft_spec`):
   1. `mode`: `readString(args, 'mode')`; reject when missing, when `!isRunMode(mode)`, or when not in `RUN_TOOL_MODES`, with `` `start_run "mode" must be one of bug, quick, refactor: ${mode}. Use investigate for a read-only question, and the spec tools for spec work.` ``
   2. `statement` via `readOneLine(args, 'statement', 'start_run')`.
   3. `files` via `readFileList(args, 'start_run')`.
   4. `reproduction`: optional; when the key is present it must be a string non-empty after trimming, else `'start_run "reproduction" must be a non-empty string when given'`. Trim it.
   5. `if (services.runPipeline === undefined) return { ok: false, error: 'start_run is not available in this host' };`
   6. `const branch = await targetBranch(services);`
   7. Build the card and ask: prompt `` `Start a ${mode} run?` ``; detail = these lines joined with '\n': `` `Mode: ${mode}` ``, `` `Work: ${statement}` ``, `` `Files: ${files.length > 0 ? files.join(', ') : '(none guessed)'}` ``, `` `Reproduction: ${reproduction}` `` only when present, `` `Target branch: ${branch}` ``, and a fixed closing line `'The run works on its own branch and worktree; nothing outside .baiton/runs/ and .baiton/worktrees/ changes until you merge it.'`. On `!confirmed` return `{ ok: false, error: `starting the ${mode} run was declined; nothing was written` }`.
   8. `const outcome = await services.runPipeline.start({ mode, statement, files, ...(reproduction !== undefined ? { reproduction } : {}) });` and switch: `started` => `{ ok: true, data: { runId: outcome.runId, mode, ...(outcome.branch !== undefined ? { branch: outcome.branch } : {}) } }`; `busy` => `{ ok: false, error: 'a stage is already running for this repository; try again after it finishes' }` (same wording as `draft_spec`/`run`, so the existing /already running/i assertions read the same); `illegal`-less default => `{ ok: false, error: 'start_run dispatch returned an unknown outcome' }`; `refused` => `` { ok: false, error: `the run did not start: ${outcome.reason}` } ``.

   Document in the function's doc comment that the tool returns as soon as the run is launched (it does not block on the run finishing, unlike `run`), that a decline writes nothing and dispatches nothing, and that the guard disables it under Restricted Mode because `dispatch: true`.

   Files: `src/orchestrator/controlTools.ts`

7. Implement investigate

   In src/orchestrator/controlTools.ts add `function investigateTool(services: ToolServices): Tool`, registered in `createControlTools` immediately after `startRunTool(services)`.

   ```ts
   name: 'investigate',
   description: 'Answer a question about the repository with a read-only investigation: the investigator studies the named files and writes a one-line finding, the files it looked at, and suggested next steps.',
   mutating: false,
   phases: ['run'],
   dispatch: true,
   schema: {
     type: 'object',
     properties: {
       question: { type: 'string' },
       files: { type: 'array', items: { type: 'string' } },
     },
     required: ['question', 'files'],
     additionalProperties: false,
   },
   ```

   `run(args, _tc)`: `readOneLine(args, 'question', 'investigate')`, then `readFileList(args, 'investigate')`, then the `services.runPipeline === undefined` guard with `'investigate is not available in this host'`, then `const branch = await targetBranch(services);`, then the card: prompt `'Investigate this question?'`; detail lines `'Mode: investigate'`, `` `Question: ${question}` ``, `` `Files: ${files.length > 0 ? files.join(', ') : '(none guessed)'}` ``, `` `Target branch: ${branch}` ``, and the fixed line `'Read-only: no branch, no worktree and no commit. The only write is the finding under .baiton/runs/.'`. A decline returns `{ ok: false, error: 'the investigation was declined; nothing was written' }`.

   Dispatch with `services.runPipeline.start({ mode: 'investigate', statement: question, files })` — the pipeline's manifest stores the question as the run's `statement`, so the tool passes it there rather than inventing a second field — and map the outcome exactly as `start_run` does, with `data: { runId, mode: 'investigate' }` on success and `` `the investigation did not start: ${outcome.reason}` `` for a refusal.

   Files: `src/orchestrator/controlTools.ts`

8. Update the module and registry doc comments

   src/orchestrator/controlTools.ts header comment: add the two new tools to the bullet list, after the `draft_spec` bullet — `- start_run(mode, statement, files, reproduction?)` (dispatch) and `- investigate(question, files)` (dispatch) — each stating that it raises the confirm card (mode, one-line statement, guessed files, target branch) through the intervention seam, returns as soon as the run is launched, and writes nothing on a decline. Update the paragraph 'Each tool declares the orchestrator phases it belongs to (Req 11.1): ...' to add: `start_run` and `investigate` only in the `run` phase, so they are unavailable in a Spec conversation, exactly as `draft_spec`, `run` and `submit_pr` are unavailable in a run-mode one.

   src/orchestrator/registry.ts: no functional change is needed — the new tools come in through `createControlTools`, and `definitionsFor`/`assembleFor`/`call` are already phase-generic. Update only the module header comment: the phase paragraph should name the three phases and note that a `run`-phase conversation sees the read tools, `ask_user` and the two dispatch tools, and that `call` refuses an out-of-phase dispatch before the guard and before the tool's `run`. Verify by inspection that no `Record<OrchestratorPhase, ...>` or exhaustive `switch` over the phase exists in src/ (there is none: src/activation/commands.ts:618 uses a `Map` read through `?? []`, which compiles unchanged). Do NOT touch src/activation/commands.ts, src/activation/chatController.ts or src/orchestrator/systemPrompt.ts: wiring the host's `run`-phase tool list, `phaseFor`/`buildSystemPrompt` and the composer Mode select belong to the other todos.

   Files: `src/orchestrator/controlTools.ts`, `src/orchestrator/registry.ts`

9. Extend test/registry.controlTools.test.ts

   Additive edits only; weaken no existing assertion.

   1. `EXPECTED_TOOLS`: add `'start_run'` and `'investigate'` under the control-tools group (the 'advertises exactly the expected tools' deepStrictEqual then pins 19 tools).
   2. `EXPECTED_PHASE_TOOLS` is `Record<OrchestratorPhase, string[]>`, so tsc now requires a third key — add `run: ['list_specs', 'read_spec', 'list_files', 'read_file', 'search', 'git_status', 'git_diff', 'git_log', 'ask_user', 'start_run', 'investigate']` and extend that constant's doc comment with the run phase.
   3. `makeServices`: add a trailing optional parameter `runPipeline?: { start: (req: StartRunRequest) => Promise<StartRunOutcome> }` spread in as `...(runPipeline !== undefined ? { runPipeline } : {})`. Appending keeps every existing positional call site valid. Import `StartRunOutcome, StartRunRequest` from '../src/orchestrator/seams'.
   4. Add helpers: `spyingPipeline(outcome: StartRunOutcome = { kind: 'started', runId: 'run-1', branch: 'baiton/bug/run-1' })` returning `{ start, calls }` like `recordingDraft`; and `makeRestrictedGuard(repoRoot)` returning a `GuardContext` with `restricted: true`.
   5. New `describe('start_run and investigate (run-phase dispatch tools)')` with these cases, every call made with phase `'run'`:
      - confirms then dispatches: `start_run` with `{ mode: 'bug', statement: 'Fix the off-by-one in slice', files: ['src/a.ts', 'src/b.ts'], reproduction: 'call slice(0)' }` returns `ok: true` with `data.runId === 'run-1'`; `pipeline.calls` deep-equals the one request including `reproduction`; the recorded confirm text contains 'bug', the statement, both file paths and 'main' (benignGit's currentBranch).
      - card goes through the intervention seam when one is wired: with `recordingIntervention({ kind: 'approved' })`, the single recorded request has `kind: 'confirm'` and its `prompt` + `detail` carry the mode, statement, files and target branch.
      - a decline (`recordingIntervention({ kind: 'declined' })`, and separately `recordingConfirm(false)`) returns `ok: false` matching /declined/i, leaves `pipeline.calls` empty, and creates nothing under `path.join(repo, '.baiton', 'runs')`.
      - invalid arguments refuse before the card and the seam (assert `confirm.calls.length === 0` and `pipeline.calls.length === 0`): `mode: 'spec'`, `mode: 'investigate'`, `mode: 'nope'`, a missing/blank `statement`, a statement containing '\n', `files: 'nope'`, `files: ['']`, `files: ['/etc/passwd']`, `files: ['../outside.ts']`, and `reproduction: '  '`. Assert the mode refusal text names `bug, quick, refactor`.
      - `files: []` is accepted and reaches the seam with an empty array; duplicates collapse (`['a.ts','a.ts']` dispatches `['a.ts']`).
      - `busy` => /already running/i; `{ kind: 'refused', reason: 'the working tree is dirty' }` => /working tree is dirty/.
      - no `runPipeline` wired => /not available/i with `confirm.calls.length === 0`.
      - `investigate` with `{ question: 'Where is the retry budget enforced?', files: ['src/engine/runQueue.ts'] }` dispatches `{ mode: 'investigate', statement: <question>, files: [...] }` and returns `data.mode === 'investigate'`; the card names the question, the file and 'main'; a decline dispatches nothing.
      - both are callable with `callId: undefined` (non-mutating) and still reach the seam.
      - Restricted Mode: with `makeRestrictedGuard(repo)`, both return `ok: false` matching /Restricted Mode/, with a `throwingGit()`, `recordingConfirm(true)` untouched (`calls.length === 0`) and `pipeline.calls.length === 0`.
      - schema shape: `registry.definitions().find(d => d.name === 'start_run')!.schema` has `properties.mode.enum` deep-equal to `['bug', 'quick', 'refactor']` and `additionalProperties === false`; `investigate`'s schema requires `['question', 'files']`; both have `dispatch === true`, `mutating === false` and `phases` deep-equal to `['run']`.
   6. Extend the existing `describe('phase scoping (Req 11.1)')` with two additive cases: `start_run` is refused in both `'gather'` and `'drive'` (error matches /start_run/ and the phase name, `pipeline.calls.length === 0`), and `run`, `draft_spec`, `submit_pr`, `approve_spec` and `add_todo` are each refused in `'run'` with no confirm, no queue dispatch and the spec file left byte-for-byte unchanged.

   Files: `test/registry.controlTools.test.ts`

10. Extend test/registry.assembleToolSpecs.test.ts

   The `for (const phase of ORCHESTRATOR_PHASES)` loop in 'per-phase assembly (Req 11.1)' now also covers `'run'`; it should pass as-is (the run phase has 11 tools against 19 registered, so the strict-subset assertion holds, and both new descriptions clear MIN_TOOL_DESCRIPTION_LENGTH and differ from their names). Add one new `it` in that describe: 'the run phase assembles the read tools, ask_user and the two dispatch tools' — build the registry from `makeServices(newRepo())`, `assembleFor('run')`, assert `ok`, and assert the assembled names include `'start_run'`, `'investigate'`, `'ask_user'` and `'read_file'` while excluding `'run'`, `'draft_spec'`, `'submit_pr'`, `'approve_spec'` and `'add_todo'`; also assert each spec's `description` equals its tool's `description` and is neither empty nor equal to its name. `makeServices` in this file needs no change — tool registration does not depend on the `runPipeline` seam being wired.

   Files: `test/registry.assembleToolSpecs.test.ts`

11. Extend test/guard.restrictedMode.property.test.ts

   Two additive edits. (a) In `makeTool`, replace `phases: ['gather', 'drive']` with `phases: [...ORCHESTRATOR_PHASES]` and import `ORCHESTRATOR_PHASES` from '../src/orchestrator/guard', so the harness carries the widened union rather than a hard-coded pair. (b) Add a second `it` to the same describe — 'the real registry refuses every dispatch tool under Restricted Mode, reaching no seam' — that builds `createToolRegistry` over a `ToolServices` whose `confirm`, `draftSpec`, `runQueue`, `runPipeline`, `submitPr` and every `git` method throw if called and whose `repoRoot`/`baitonDir` point at an unused path under os.tmpdir() (no filesystem access happens: the guard refuses before `run`). For every `registry.definitions().filter(d => d.dispatch === true)` — which must now include `run`, `draft_spec`, `start_run` and `investigate`, asserted by name so a future tool cannot silently drop out — call `registry.call(tool.name, {}, 'key-1', makeCtx(true), tool.phases[0])` and assert `ok === false` and the error matches /Restricted Mode/. Then assert the mirror: the same call through `makeCtx(false)` gets past the Restricted-Mode gate (it may fail later for a missing argument or an unavailable seam, but the error must NOT match /Restricted Mode/). Keep the existing property test untouched.

   Files: `test/guard.restrictedMode.property.test.ts`

12. Verify

   Run `npm run compile`, `npm run lint`, then `npm test`. `npm run compile` is the main guard on the union widening: the only exhaustive `Record<OrchestratorPhase, ...>` in the tree is `EXPECTED_PHASE_TOOLS` in test/registry.controlTools.test.ts, so tsc will flag exactly that one site if step 9.2 is missed. Lint is expected to report 0 errors; the pre-existing warning `'_legacy' is assigned a value but never used` at src/orchestrator/webviewProtocol.ts:591 is untouched by this todo and may remain. The full suite must pass with no pre-existing assertion modified or weakened; the whole-registry name list in 'advertises exactly the expected tools' is the one existing deepStrictEqual that legitimately changes, and it changes only by gaining the two new names.

   Files: (none)

## Risks

- The new phase 'run' and the existing tool named 'run' are easy to conflate. Keep the `run` tool's `phases` at ['drive'] and the new tools' at ['run'], and say so in the doc comments; a reviewer skimming `phases: ['run']` on the `run` tool would see a silently self-dispatching Spec tool.
- Widening OrchestratorPhase breaks any exhaustive Record/switch over it. Only test/registry.controlTools.test.ts:564 is exhaustive; src/activation/commands.ts:618 builds a `Map<OrchestratorPhase, ToolSpec[]>` with two entries read through `?? []`, so it compiles but would advertise an EMPTY tool list if a host ever passed 'run'. That wiring (plus `phaseFor`/`buildSystemPrompt` for run mode) is another todo's job — do not add it here, and do not 'fix' commands.ts.
- `ToolServices.runPipeline` must stay optional. Making it required would break every existing host and test that builds a registry, and both tools must degrade to 'not available in this host' exactly as `draft_spec` and `submit_pr` do.
- src/engine/runPipeline.ts's `RunPipelineRequest` already requires `composerMode` and `explicitMode`, which a tool cannot know. Resist widening `StartRunRequest` to match it: the host adapter fills those two fields. If the seam grows them, the tool would have to invent the composer's state.
- The confirm card must render identically on both paths (intervention seam when wired, legacy ConfirmSeam otherwise), because tests assert on the text. Build one `prompt`/`detail` pair and join them for the fallback rather than composing two different strings.
- `services.git.currentBranch()` throws on the `throwingGit()` stub used by several existing tests and in a detached HEAD. The target-branch helper must swallow the error and fall back to `gitSettings.base`; an unguarded call would turn a card into a tool failure.
- Leaving `read_spec`/`list_specs` out of the run phase would break the existing 'runs the same tool when it is called in a phase it belongs to' case, which loops ORCHESTRATOR_PHASES. All eight read tools get 'run'.
- Validating `files` too aggressively (e.g. checking existence on disk) would make the tool read the filesystem and slow the dispatch; validation stays purely lexical (non-empty, relative, no '..'), and the planner brief is what actually resolves the paths.

## Acceptance

- `npm run compile` and `npm run lint` are clean (0 lint errors; only the pre-existing webviewProtocol.ts:591 warning), and `npm test` passes with no existing assertion removed or weakened.
- `OrchestratorPhase` is `'gather' | 'drive' | 'run'` and `ORCHESTRATOR_PHASES` is `['gather', 'drive', 'run']`.
- `registry.names()` is exactly the previous 17 tools plus `start_run` and `investigate` (19 total), and `definitionsFor('run')` is exactly the eight read tools, `ask_user`, `start_run` and `investigate` — no spec-write tool, no `run`, `draft_spec`, `approve_spec` or `submit_pr`.
- `assembleFor('run')` succeeds and each returned spec's description comes from its tool's `description` field.
- `start_run` and `investigate` are `mutating: false, dispatch: true, phases: ['run']`, so a restricted `GuardContext` makes both return an error matching /Restricted Mode/ with the run-pipeline seam and the confirm/intervention seam never touched.
- `start_run` accepts exactly the modes bug, quick and refactor in its schema enum and at runtime; 'spec', 'investigate' and an unknown string are refused with a message naming the three legal modes, before the card and before the seam.
- A confirmed `start_run` raises exactly one confirm card whose text carries the mode, the one-line statement, every guessed file and the target branch, then calls `RunPipelineSeam.start` once with `{ mode, statement, files, reproduction? }` and returns `{ runId, mode }` as soon as the run is launched.
- A declined `start_run`/`investigate` returns an error matching /declined/i, calls the seam zero times, and creates nothing under `.baiton/runs/`.
- `investigate(question, files)` dispatches `{ mode: 'investigate', statement: question, files }` and returns `data.mode === 'investigate'`; its card states the investigation is read-only.
- A `busy` outcome surfaces the same 'a stage is already running for this repository' wording the other dispatch tools use, and a `refused` outcome surfaces the reason verbatim.
- With no `runPipeline` on `ToolServices`, both tools return /not available/ without raising a card; every other tool and existing host wiring is unaffected.
- Phase gating holds both ways: `start_run`/`investigate` are refused in 'gather' and 'drive', and `run`, `draft_spec`, `approve_spec`, `submit_pr` and the spec-write tools are refused in 'run', each refusal naming the tool and the phase and leaving the spec file byte-for-byte unchanged.
- src/activation/commands.ts, src/activation/chatController.ts and src/orchestrator/systemPrompt.ts are unmodified.
