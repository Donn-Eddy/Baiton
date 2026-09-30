# Plan T06

## Steps

1. Add the LandTodoSeam types to seams.ts

   In src/orchestrator/seams.ts, beside RunQueueSeam, add:

   ```ts
   /** One request to land a done todo's branch into its spec branch. */
   export interface LandTodoRequest { slug: string; todoId: string; }

   /**
    * What the land seam answers `land_todo`. `landed` carries the spec branch's head after the merge (`noop` when the branch was already contained, `cleanup` any non-fatal worktree/branch removal warnings); `already-landed` means no todo branch exists; `refused` carries the named reason (wrong branch checked out, dirty tree, conflict, a stage still running, a git failure).
    */
   export type LandTodoOutcome =
     | { kind: 'landed'; commit: string; noop: boolean; cleanup: readonly string[] }
     | { kind: 'already-landed' }
     | { kind: 'refused'; reason: string };

   /** The seam `land_todo` lands through; the engine serializes it with state commits via the spec-branch writer. */
   export interface LandTodoSeam { land(req: LandTodoRequest): Promise<LandTodoOutcome>; }
   ```

   Add a `{@link LandTodoSeam}` bullet to the module header comment list. No vscode import. The orchestrator barrel already does `export * from './seams'`, so the types are exported.

   Files: `src/orchestrator/seams.ts`

2. Add optional landTodo to ToolServices

   In src/orchestrator/toolServices.ts import `LandTodoSeam` from './seams' (add to the existing import list) and add to `ToolServices`, after `runPipeline`:

   ```ts
   /**
    * The seam `land_todo` merges a done todo's branch into the spec branch through. Optional so a host that has not wired per-todo worktrees still builds a registry; `land_todo` then reports itself unavailable.
    */
   landTodo?: LandTodoSeam;
   ```

   Add a `- landTodo` line to the doc-comment bullet list above the interface.

   Files: `src/orchestrator/toolServices.ts`

3. Implement the land_todo control tool

   In src/orchestrator/controlTools.ts:

   1. Add `landTodoTool(services)` to the array returned by `createControlTools`, between `runTool(services)` and `submitPrTool(services)`.
   2. New function `landTodoTool(services: ToolServices): Tool` returning:
      - `name: 'land_todo'`
      - `description: 'Land a done todo: merge its branch into the spec branch and remove its worktree. Returns the merge commit, or reports that the todo is already landed.'`
      - `mutating: true` (so the guard requires a callId, replays a seen callId unchanged, and disables it under Restricted Mode), `phases: ['drive']`, no `dispatch`, no confirm card.
      - schema `{ type: 'object', properties: { slug: { type: 'string' }, todo: { type: 'string' } }, required: ['slug','todo'], additionalProperties: false }`.
      - `run(args, tc)`:
        a. `slug = readString(args,'slug')`, `todo = readString(args,'todo')`; if either undefined -> `{ ok:false, error:'land_todo requires a string "slug" and "todo"' }`.
        b. `!isSlug(slug)` -> `invalid slug: ${slug}`; `!isSlug(todo)` -> `invalid todo id: ${todo}`.
        c. `const resolved = await tc.ctx.resolveMutatingPath(specPath(services, slug))`; on !ok return its error message (same as submit_pr).
        d. Read the spec file (`fs.readFile(resolved.resolved,'utf8')`), catch -> `spec "${slug}" was not found`.
        e. `const entry = parseSpec(content).todos.find((t) => t.id === todo)`; missing -> `todo "${todo}" was not found in spec "${slug}"`.
        f. `entry.state !== 'done'` -> `{ ok:false, error: `todo "${todo}" is ${entry.state}; only a done todo can be landed. Run its remaining stages first.` }` (the seam is never reached).
        g. `services.landTodo === undefined` -> `land_todo is not available in this host`.
        h. `const outcome = await services.landTodo.land({ slug, todoId: todo })`; switch:
           - `landed` -> `{ ok:true, data: { slug, todo, landed: true, commit: outcome.commit, ...(outcome.noop ? { noop: true } : {}), ...(outcome.cleanup.length > 0 ? { cleanup: [...outcome.cleanup] } : {}) } }`
           - `already-landed` -> `{ ok:true, data: { slug, todo, landed: false, message: 'already landed' } }`
           - `refused` -> `{ ok:false, error: `landing todo "${todo}" of spec "${slug}" was refused: ${outcome.reason}` }`
           - default -> `land_todo returned an unknown outcome`.
   3. Update the module header doc: add a `land_todo(slug, todo)` (mutating, no confirm) bullet — refuses unless the todo is `done`, merges through the land seam, reports the merge commit or `already landed` — and say `submit_pr` runs only once every todo is done and landed. Update the phase paragraph to name `land_todo` as drive-only alongside `run`/`submit_pr`.
   4. Update submitPrTool's description to: 'Submit the pull request for a spec whose todos are all done and landed: ...' (rest unchanged).

   Files: `src/orchestrator/controlTools.ts`

4. Make submitPr refuse while any todo branch is unlanded

   In src/engine/submitPr.ts:

   1. Add to `SubmitPrDeps`:
   ```ts
   /**
    * The todo ids of `slug` whose todo branch still exists (not yet landed); the readiness check refuses while any remain. Optional so callers without per-todo worktrees keep today's behaviour. Real host: `(s) => unlandedTodos({ git }, s)`.
    */
   unlandedTodos?: (slug: string) => Promise<readonly string[]>;
   ```
   2. In `checkReady`, immediately after the `notDone` refusal block (before the branch/base_commit metadata check), add:
   ```ts
   if (deps.unlandedTodos !== undefined) {
     let unlanded: readonly string[];
     try {
       unlanded = await deps.unlandedTodos(slug);
     } catch (e) {
       return fail({ kind: 'not-ready', message: `could not list the unlanded todos of spec "${slug}": ${errorMessage(e)}` });
     }
     if (unlanded.length > 0) {
       return fail({
         kind: 'not-ready',
         message: `every todo must be landed before submitting a PR; still unlanded: ${unlanded.join(', ')}. Land each with land_todo first.`,
       });
     }
   }
   ```
   3. Update the file header step 1 to say '...every todo is `done` and landed (no todo branch remains)...'.

   Files: `src/engine/submitPr.ts`

5. Update the drive prompt stage table and scope text

   In src/orchestrator/systemPrompt.ts:

   1. SCOPE_TEXT line 2 becomes: `'2. Drive an approved spec to completion. Dispatch each stage with `run`, land each done todo with `land_todo`, and when every todo is done and landed finish with `submit_pr`.'` (must still contain '`run`' and '`submit_pr`').
   2. DRIVE_TEXT becomes:
   ```ts
   'This spec is approved. Your job here is to drive it to completion, one todo at a time.',
   'The next legal step follows the todo\'s current state:',
   '- `pending` -> `run` the `plan` stage.',
   '- `planned` -> `run` the `execute` stage.',
   '- `executed` -> `run` the `review` stage.',
   '- A review that sends the todo back -> `run` the `execute` stage again.',
   '- `done` (unlanded) -> `land_todo` it, which merges its branch into the spec branch.',
   'A todo can be planned only once every todo it comes `after` is done and landed.',
   '`run` blocks until the stage finishes and returns its outcome. There is nothing to poll, watch or read afterwards: when it returns, the stage is over and the spec file already reflects it.',
   'Drive one todo at a time. Take the next todo only when the one before it is `done`; land a done todo whenever you choose, but before any todo that comes `after` it is planned.',
   'You do not read the plan, the diff, or any source file to check the work. ...(unchanged)',
   'When every todo is `done` and landed, tell the user and offer to `submit_pr`. `submit_pr` refuses while any todo is unlanded.',
   ```
   Keep the four existing stage lines byte-identical (tests assert them) and keep the phrases 'one todo at a time', '`run` blocks until the stage finishes', 'nothing to poll'. Do not mention plan-review.
   3. Update the header comment's **drive** bullet to 'the next-legal-step table (plan, execute, review, land_todo), one todo at a time, and `submit_pr` when every todo is done and landed' and the DRIVE_TEXT doc comment likewise.
   4. RUN_ROLE_TEXT / run-phase texts are untouched (the run prompt must still contain no `submit_pr` and no `land_todo`).

   Files: `src/orchestrator/systemPrompt.ts`

6. Wire the land seam and the unlanded gate in commands.ts

   In src/activation/commands.ts:

   1. Extend the `'../engine'` value import with `landTodoWorktree`, `todoBranchFor`, `unlandedTodos`; extend the `'../orchestrator'` type import with `LandTodoSeam`.
   2. After `submitPrForSlug` is defined (it owns `prInFlight`) and before `draftServices`, build the seam:
   ```ts
   // land_todo (per-todo worktrees): merge a done todo's branch into the spec
   // branch in the main checkout. It goes through the spec-branch writer so a
   // land never interleaves with a state commit for another todo of the spec.
   const landTodoSeam: LandTodoSeam = {
     land: async ({ slug, todoId }) => {
       if (prInFlight.has(slug)) {
         return { kind: 'refused', reason: `a pull request is being submitted for spec "${slug}"` };
       }
       if (queueFor(slug, todoId).isRunning()) {
         return { kind: 'refused', reason: `a stage is still running for todo "${todoId}"` };
       }
       try {
         return await specWriter.apply(slug, async () => {
           if ((await git.branchHead(todoBranchFor(slug, todoId))) === undefined) {
             return { kind: 'already-landed' as const };
           }
           const landed = await landTodoWorktree({ workspaceRoot: repoRoot, git }, { slug, todoId });
           if (landed.ok) {
             return { kind: 'landed' as const, commit: landed.value.commit, noop: landed.value.noop, cleanup: landed.value.cleanup };
           }
           if (landed.error.reason === 'missing-branch') {
             return { kind: 'already-landed' as const };
           }
           const detail = landed.error.reason === 'dirty-tree' ? ` (${landed.error.changes.join(', ')})` : '';
           return { kind: 'refused' as const, reason: `${landed.error.message}${detail}` };
         });
       } catch (e) {
         return { kind: 'refused', reason: e instanceof Error ? e.message : String(e) };
       }
     },
   };
   ```
   (The branch-existence check is done first so an already-landed todo reports `already landed` even when landTodoWorktree's pinned order would hit wrong-branch/dirty-tree first. If `queueFor` creates-and-caches a queue as a side effect that's acceptable; `RunQueue.isRunning()` is the existing per-queue method.)
   3. In `submitPrForSlug`'s `submitPr(slug, {...})` deps add `unlandedTodos: (s) => unlandedTodos({ git }, s),`.
   4. Give `buildToolServices` a new trailing parameter `landTodo: LandTodoSeam` and set `landTodo` in the returned object; update its doc comment to mention the land seam. Pass `landTodoSeam` at both call sites (the `draftServices` call and the `createToolRegistry({...buildToolServices(...)})` call).
   5. Update the stale comment above `prInFlight`/`submitPrForSlug` ('one run at a time per repository') to say it also refuses while any todo of the spec is unlanded (checked inside submitPr).
   No other behaviour changes.

   Files: `src/activation/commands.ts`

7. Registry/control-tool tests for land_todo

   In test/registry.controlTools.test.ts:

   1. Add 'land_todo' to `EXPECTED_TOOLS` (Control tools group) and to `EXPECTED_PHASE_TOOLS.drive` (not gather, not run). Import `LandTodoOutcome, LandTodoRequest` from '../src/orchestrator/seams'.
   2. In 'refuses every spec tool while in the run phase' add `['land_todo', { slug, todo: 'T01' }]` to `calls`.
   3. Add a helper `recordingLand(outcome: LandTodoOutcome)` returning `{ calls: LandTodoRequest[]; land(req) }`, and a spec helper `approvedSpec(state: string)` (status: approved, one todo `- [${state}] T01 Do the first thing`). Attach the seam with `{ ...makeServices(repo, benignGit(), confirm), landTodo: seam }` (do not change makeServices' signature).
   4. New `describe('land_todo', ...)` with cases (all via `registry.call('land_todo', args, callId, makeGuard(repo), 'drive')` unless stated):
      - lands a done todo: outcome `{kind:'landed', commit:'c'.repeat(40), noop:false, cleanup:[]}` -> ok, `data` deepEquals `{ slug, todo:'T01', landed:true, commit:'c'.repeat(40) }`; seam calls `[{slug, todoId:'T01'}]`; `confirm.calls.length === 0` (no card).
      - reports already-landed: outcome `{kind:'already-landed'}` -> ok, `data.landed === false`, `data.message === 'already landed'`.
      - refuses a todo that is not done (state `executed`) -> ok false, error matches /executed/ and /done/; seam never called.
      - refuses an unknown todo id (`T09`) -> error matches /T09/ and /not found/; seam never called.
      - relays a seam refusal: `{kind:'refused', reason:'the merge conflicts'}` -> ok false, error includes 'the merge conflicts' and 'T01'.
      - reports unavailable when `landTodo` is not wired (plain makeServices) -> error matches /not available/.
      - is idempotent by call id: two calls with the same callId 'call-land-1' -> seam called once, second result deepStrictEqual the first.
      - requires a call id: callId `undefined` -> ok false, error matches /idempotency key/; seam not called.
      - is disabled under Restricted Mode (`makeRestrictedGuard(repo)`) -> ok false; seam not called.
      - is refused while gathering (phase 'gather') -> error matches /land_todo/ and /gather/; seam not called.
   5. If any existing test asserts the full definitions list or a tool count elsewhere in this file, update it for the added tool.

   Files: `test/registry.controlTools.test.ts`

8. submitPr tests for the unlanded gate

   In test/submitPr.test.ts add to the `describe('submitPr ...')` block (import `unlandedTodos` from '../src/engine/todoWorktree'):

   1. 'refuses while a todo branch is unlanded, naming the todos': `harness(makeRepo(['done','done']), { unlandedTodos: async () => ['T01','T02'] })` -> `result.ok === false`, `error.kind === 'not-ready'`, message matches /T01, T02/ and /land_todo/; `h.terminals.created.length === 0`, `h.pr.created.length === 0`.
   2. 'reads unlanded todos from real todo branches': `const repo = makeRepo(['done'])`; `git(repo.root, 'branch', 'baiton-todo/greeting/T01')`; harness with `unlandedTodos: (s) => unlandedTodos({ git: createGitService(repo.root) }, s)` -> not-ready naming T01, nothing launched. Then `git(repo.root, 'branch', '-D', 'baiton-todo/greeting/T01')` and a fresh `submitPr` call gets past readiness: assert via `awaitWatcher(h)` that one watcher was created, then `emitClose(1)` (or deliver DRAFT and let it finish, as the existing happy-path test does) so the call resolves; assert it did not fail with `not-ready`.
   3. 'reports a failing unlanded lookup as not-ready': `unlandedTodos: async () => { throw new Error('boom'); }` -> not-ready, message matches /boom/, nothing launched.
   4. Leave existing tests as they are (they omit `unlandedTodos`, which keeps today's behaviour).

   Files: `test/submitPr.test.ts`

9. systemPrompt tests for the landing step

   In test/systemPrompt.test.ts:

   1. In 'gives the next legal stage for each todo state while driving' also assert `DRIVE_TEXT.includes('- `done` (unlanded) -> `land_todo` it')` (or a regex /`done` \(unlanded\) -> `land_todo`/).
   2. New it 'offers submit_pr only once every todo is done and landed': `assert.match(DRIVE_TEXT, /every todo is `done` and landed/)`, `assert.match(DRIVE_TEXT, /`submit_pr` refuses while any todo is unlanded/)`, and `assert.match(DRIVE_TEXT, /after.*done and landed/)` for the plan dependency rule.
   3. In 'names both jobs with the tool that ends each' add `assert.ok(SCOPE_TEXT.includes('`land_todo`'))`.
   4. New it: the approved-spec prompt (`buildSystemPrompt(SPEC, APPROVED_SPEC)`) contains '`land_todo`'; the draft-spec prompt's drive table is absent (`!buildSystemPrompt(SPEC, DRAFT_SPEC).includes(DRIVE_TEXT)` already covered — just add that the run-phase prompt from `buildSystemPrompt(WORKSPACE, undefined, 'bug')` does not contain 'land_todo', matching how systemPrompt.mode.test builds run prompts).
   Existing assertions (the four stage lines, 'one todo at a time', '`run` blocks until the stage finishes', 'nothing to poll', no 'plan-review') must still pass unchanged.

   Files: `test/systemPrompt.test.ts`

10. Verify

   Run `npm run compile`, `npm run lint`, `npm test`. Also grep: `grep -rn "from 'vscode'" src/orchestrator src/engine` must show nothing new. If another test file enumerates the drive-phase tools or all tool names (e.g. test/registry.assembleToolSpecs.test.ts, test/chatController*.test.ts, test/systemPrompt.phase.property.test.ts) and fails because of the new tool or text, update that expectation minimally to include land_todo.

   Files: (none)

## Risks

- Todo branches live under `baiton-todo/<slug>/<id>` (T01 deviation), not `baiton/<slug>/<id>`; always use `todoBranchFor`/`unlandedTodos` from src/engine/todoWorktree.ts, never hand-built names.
- landTodoWorktree checks wrong-branch and dirty-tree before missing-branch; the seam therefore checks branch existence first so an already-landed todo reports `already landed` instead of a spurious refusal.
- The land must run inside `specWriter.apply(slug, ...)` so it cannot interleave with a state/artifact commit from another todo's queue; calling landTodoWorktree outside the writer would reintroduce that race.
- land_todo is mutating, so the guard's containment rule applies: resolveMutatingPath must be called on the spec.md path (under .baiton/specs) exactly as submit_pr does, or the guard/containment tests may diverge.
- Adding a tool changes the advertised tool set; tests elsewhere that pin the complete drive-phase or full tool list will need the new name added.
- DRIVE_TEXT/SCOPE_TEXT are asserted verbatim in several prompt tests (includes(DRIVE_TEXT), phrases like 'one todo at a time'); keep existing lines byte-identical and only add lines/clauses.
- `queueFor(slug, todoId)` may create and cache a queue as a side effect when checking isRunning; harmless, but if it has costs prefer an existing lookup on `todoQueues` if one exists.
- submitPr's unlanded gate is opt-in via `unlandedTodos`; forgetting to pass it in commands.ts would silently leave the PR gate open.

## Acceptance

- The registry advertises `land_todo` in the drive phase only; it is refused in gather and run phases, under Restricted Mode, and without a call id, never reaching the seam.
- `land_todo` refuses a todo that is not `done` (naming its state) or not found, without calling the LandTodoSeam; it shows no confirm card.
- `land_todo` returns `{ slug, todo, landed: true, commit }` for a landed outcome, `{ landed: false, message: 'already landed' }` for already-landed, and relays a refusal reason as an error; a repeated call id replays the first result without calling the seam again.
- `submitPr` returns `not-ready` naming every unlanded todo and mentioning land_todo when `deps.unlandedTodos` reports any, before verify or any launch; with no unlanded todos it proceeds as before; a real `baiton-todo/<slug>/T01` branch is detected through `unlandedTodos`.
- commands.ts wires `landTodo` into both ToolServices bundles through a seam that lands via `landTodoWorktree` inside `specWriter.apply(slug, ...)`, and passes `unlandedTodos: (s) => unlandedTodos({ git }, s)` to submitPr.
- DRIVE_TEXT includes the `done (unlanded) -> land_todo` row, the plan-after-landed rule, and offers `submit_pr` only when every todo is done and landed; SCOPE_TEXT mentions `land_todo`; the run-phase prompt contains neither `submit_pr` nor `land_todo`.
- No `vscode` import is added under src/orchestrator/ or src/engine/.
- `npm run compile`, `npm run lint` (no new warnings) and `npm test` all pass.
