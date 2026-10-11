# Plan T01

## Steps

1. Rename todoState.ts to phaseState.ts

   Use `git mv src/model/todoState.ts src/model/phaseState.ts`. Inside it, rename `TodoState`→`PhaseState`, `TODO_STATES`→`PHASE_STATES` and `isTodoState`→`isPhaseState`. Keep the eight state values and their order exactly as they are. Reword the doc comments to say phase ('The lifecycle state of a single phase, written inside the `[state]` box of a phase line'). Do NOT leave a re-export shim under the old name. Update every import of '../model/todoState' or './model/todoState' in src: activation/specStore.ts, engine/recovery.ts, engine/resultFlow.ts, engine/runQueue.ts, engine/transitions.ts, extension.ts, journal/entry.ts, journal/journal.ts (`isTodoState`→`isPhaseState`) and orchestrator/specWriteTools.ts. Update the matching imports in test: blocked.property, controlTools.invalidBlocks.property, hash.approval.property, integration.plan-execute-review, journal.roundtrip.property, parser.roundtrip.property, recovery.revert, runQueue.approvalGate.property, runQueue.briefContext, runQueue.revert.property, runQueue.worktree, specActions.property (renamed in a later step), specWriteTools.protectedState.property and stageContext.confinement.property. Also update orchestrator/systemPrompt.ts (`TODO_STATES`→`PHASE_STATES`), test/systemPrompt.test.ts, test/transitions.dispatch.property.test.ts and test/model.test.ts. In those files, change only the identifiers and import paths. Do NOT rename persisted or wire fields such as journal `todoId` or RunRequest `todoId`; later todos own those (engine/journal).

   Files: `src/model/todoState.ts`, `src/model/phaseState.ts`, `src/model/index.ts`, `src/activation/specStore.ts`, `src/engine/recovery.ts`, `src/engine/resultFlow.ts`, `src/engine/runQueue.ts`, `src/engine/transitions.ts`, `src/extension.ts`, `src/journal/entry.ts`, `src/journal/journal.ts`, `src/orchestrator/specWriteTools.ts`, `src/orchestrator/systemPrompt.ts`

2. Parser: add document kind, the plan grammar, kind-strict ids and the ParsedPlan/Phase renames

   In src/model/parser.ts:
   (1) Add `export type DocumentKind = 'plan' | 'legacy-spec';` with a comment that marks 'legacy-spec' as the legacy `spec.md` format (`# OVERVIEW` + `# TODOS`, `T##`).
   (2) Add `export function phaseIdPattern(kind: DocumentKind): RegExp`, which returns `/^P\d{2,}$/` for 'plan' and `/^T\d{2,}$/` for 'legacy-spec'. Add `export function phaseIdPrefix(kind): 'P' | 'T'`. Add a private `phasesSectionName(kind)` that returns 'PHASES' or 'TODOS' (legacy). Later todos (add_phase, planDraft numbering) will reuse these.
   (3) Add `export function detectDocumentKind(raw: string): DocumentKind`. It splits on '\n', skips frontmatter with the existing parseFrontmatter, then scans the body for the first header (the existing isHeader/findHeader shape, `/^#+\s+(.*)$/`) named 'PHASES' or 'TODOS'. If 'PHASES' comes first, the kind is 'plan'; if 'TODOS' comes first, it is 'legacy-spec'. If neither header exists, a body with an 'OVERVIEW' header is 'legacy-spec' and anything else is 'plan'.
   (4) Rename `ParsedSpec`→`ParsedPlan` with these fields: `kind: DocumentKind`, `frontmatter: Map<string,string>`, `preamble: string` (replaces `overview`), `phases: Phase[]` (replaces `todos`) and `rawLines: string[]`. Rename `Todo`→`Phase` with the same fields (id, state: PhaseState, title, after, files, lineIndex). Update its id doc to say the id is the kind's prefix (`P`, or `T` for legacy) followed by two or more digits.
   (5) Rename `parseSpec`→`export function parsePlan(raw: string, kind: DocumentKind = detectDocumentKind(raw)): ParsedPlan`. Later callers will pass the kind from the path resolver. The function still never throws.
   (6) Preamble extraction: rename parseOverview to `parsePreamble(lines, bodyStart, kind)`, returning `{ preamble, phasesStart }`.
     - legacy-spec: behaviour must stay byte-identical. The preamble is the text between the `# OVERVIEW` header and the `# TODOS` header (or EOF), and is '' when there is no OVERVIEW header. phasesStart is the line after `# TODOS`, or lines.length.
     - plan: the preamble is `lines.slice(bodyStart, phasesHeader === -1 ? lines.length : phasesHeader).join('\n')`, i.e. every body line after the frontmatter up to `# PHASES`, including the Endstate / What needs changing / Limitations & constraints headings. When that slice is empty, the preamble is ''. phasesStart is the line after `# PHASES`, or lines.length.
     For the plan kind, search for the header from bodyStart, as today.
   (7) Rename parseTodos→parsePhases(lines, phasesStart, kind) and parseTodoLine→parsePhaseLine(line, i, kind). The id must match phaseIdPattern(kind). A wrong-prefix id (a `T01` line in a plan, or a `P01` line in a legacy spec) returns undefined, so the line is NOT parsed and the validator reports it.
   (8) Thread `kind` through parseTitleAndHints→parseHints. An `after` group's ids must all match phaseIdPattern(kind), otherwise the group is not hints, as today for malformed ids. Additionally export `export function trailingHintIdsOfOtherKind(title: string, kind: DocumentKind): string[] | undefined`. It runs the hint parse on a title's trailing `(…)` group with the OTHER kind's id pattern and returns the `after` ids when that succeeds and contains at least one after id, otherwise undefined. The validator uses it so wrong-prefix dependency hints are never silently swallowed into the title.
   (9) Rewrite the module doc comment for both kinds, and rename the regex constants: TODO_ID removed in favour of phaseIdPattern, TODO_PREFIX→PHASE_PREFIX. Mark legacy-only branches with a `// Legacy spec.md format` comment.

   Files: `src/model/parser.ts`

3. Validator: kind-aware validatePlan / PlanError

   In src/model/validator.ts:
   - Rename `SpecError`→`PlanError` (same fields: line, text, reason) and `validateSpec`→`validatePlan(plan: ParsedPlan, raw: string): PlanError[]`.
   - Import `ParsedPlan, Phase, DocumentKind, phaseIdPattern, phaseIdPrefix, trailingHintIdsOfOtherKind` from './parser' and `PHASE_STATES, isPhaseState` from './phaseState'.
   - Replace findTodosStart with `findPhasesStart(rawLines, kind)`, which looks for the 'PHASES' header for plan and the 'TODOS' header for legacy-spec.
   - Rename findGrammarErrors(plan, rawLines) and grammarFailureReason(line, kind). Use a noun helper `itemNoun(kind)`: 'phase' for plan, and 'todo' for legacy-spec (marked legacy, so legacy messages stay byte-identical). The malformed-id reason becomes `malformed id "${id}"; expected "${phaseIdPrefix(kind)}" followed by two or more digits`. For a wrong-prefix id, append `(${kind === 'plan' ? 'T## ids belong to legacy spec documents' : 'P## ids belong to plan documents'})` so the user sees why. The general grammar reason is `malformed ${noun} line: expected "- [<state>] <id> <title>"`.
   - In findDependencyErrors, use `${noun} "${id}" lists itself…` and `${noun} "${id}" depends on unknown id…`. Duplicate-id and cycle reasons stay exactly as they are.
   - Add `findForeignHintErrors(plan)`. For each parsed phase, `const ids = trailingHintIdsOfOtherKind(phase.title, plan.kind)`. If ids is defined, push `{ line: lineIndex+1, text: renderPhaseRef(phase), reason: `after hint uses ids of the wrong kind (${ids.join(', ')}); expected "${phaseIdPrefix(plan.kind)}" ids` }`. Call it from validatePlan after the dependency errors.
   - Rename the Todo-typed helpers (findDuplicateIds(phases), findDependencyErrors(phases), findCycleErrors(phases), renderTodoRef→renderPhaseRef). The cycle algorithm is unchanged.
   - Update the doc comments to phase vocabulary.

   Files: `src/model/validator.ts`

4. Writer and hash: rename identifiers, keep the bytes and hashes identical

   src/model/writer.ts:
   - `writeTodoState`→`writePhaseState(current: string, phaseId: string, state: PhaseState, kind?: DocumentKind)`. It parses with `parsePlan(current, kind)` (detected when omitted) and finds `plan.phases.find(p => p.id === phaseId)`.
   - WriteError variants become `{ kind: 'phase-not-found'; phaseId; message }`, the unchanged `{ kind: 'key-not-found'; key; message }` and `{ kind: 'done-protected'; phaseId; message }`.
   - The messages say 'phase' (e.g. `cannot write state: phase "${phaseId}" was not found or did not parse`, `phase "${phaseId}" is done; its state was left unchanged`).
   - writeFrontmatterKey and setFrontmatterKey are unchanged apart from comment wording.
   - Grep confirms that nothing in src outside src/model reads `'todo-not-found'` or WriteError.todoId. Only the tests writer.test.ts, writer.abort.test.ts and writer.scope.property.test.ts need updating.

   src/model/hash.ts:
   - isBlocked(phase: Phase, all: Phase[]) has the same logic.
   - approvalHash(plan: ParsedPlan) uses plan.phases and plan.preamble.
   - computeInputRev(plan: ParsedPlan, phaseId: string).
   - The payload is still `[preamble, ...blankedLines].join('\n')`. The kind is NOT mixed in, so a legacy spec's preamble equals its old overview and every existing approved_rev / input rev stays valid. Add a comment saying so.
   - Reword the doc comments: OVERVIEW→preamble (legacy: the OVERVIEW section).

   Files: `src/model/writer.ts`, `src/model/hash.ts`

5. Actions: todoActions→phaseActions, specActions→planActions

   Run `git mv src/model/todoActions.ts src/model/phaseActions.ts`, then rename `TodoAction`→`PhaseAction`, `legalActions` (keep the name, it is neutral) and `todoContextValue`→`phaseContextValue`. Its parameter becomes `state: PhaseState`. Update the comments: Plan Explorer, `phases/<id>/plan.md` (legacy `todos/<id>/plan.md`).

   Run `git mv src/model/specActions.ts src/model/planActions.ts`, then rename `SpecAction`→`PlanAction`, `SpecActionInput`→`PlanActionInput` (field `todoStates`→`phaseStates: readonly PhaseState[]`), `legalSpecActions`→`legalPlanActions` and `specContextValue`→`planContextValue`. The rules are unchanged.

   IMPORTANT: the returned contextValue STRING literals 'baiton.todo' and 'baiton.spec' must stay unchanged in this todo, because package.json `view/item/context` when-clauses match them and package.json belongs to the Activation/UI todo. Add a one-line comment on each literal, e.g. `// contextValue string still matched by package.json; renamed with the Plan Explorer`.

   Files: `src/model/todoActions.ts`, `src/model/phaseActions.ts`, `src/model/specActions.ts`, `src/model/planActions.ts`

6. Tree model renames and kind propagation

   In src/model/treeModel.ts:
   - `buildSpecTree`→`buildPlanTree`, `SpecNode`→`PlanNode`, `TodoNode`→`PhaseNode`, `SpecInput`→`PlanInput` and `SpecStatus`→`PlanStatus`. `ErrorNode` keeps its name.
   - The children union becomes `{ kind: 'errors'; errors } | { kind: 'phases'; phases: PhaseNode[] }`.
   - PlanInput gains an optional `kind?: DocumentKind`, passed to parsePlan (detected when absent). Its `sessions`/`plans` doc comments say phase ids.
   - PlanNode gains `kind: DocumentKind`. Take it from parsed.kind; for an unreadable document use `input.kind ?? 'plan'`.
   - `actions: PlanAction[]` comes from `legalPlanActions({ …, phaseStates })`, and PhaseNode.actions is `PhaseAction[]`.
   - The default readError text stays 'spec.md could not be read' only when `input.kind === 'legacy-spec'`; otherwise it is 'plan.md could not be read'.
   - Use parsePlan/validatePlan/isBlocked, rename buildTodoNode→buildPhaseNode, and rewrite the module doc for the Plan Explorer.

   Then update src/model/index.ts to export './phaseState', './phaseActions' and './planActions' instead of the old names.

   Files: `src/model/treeModel.ts`, `src/model/index.ts`

7. Update every src caller (identifiers and field accesses only; no logic change)

   Mechanically update the callers so `npm run compile` passes. Apply these replacements: parseSpec→parsePlan, ParsedSpec→ParsedPlan, Todo (type)→Phase, validateSpec→validatePlan, SpecError→PlanError, writeTodoState→writePhaseState, TodoAction→PhaseAction, todoContextValue→phaseContextValue, specContextValue→planContextValue, legalSpecActions→legalPlanActions, buildSpecTree→buildPlanTree, SpecNode/TodoNode/SpecInput/SpecStatus→PlanNode/PhaseNode/PlanInput/PlanStatus, `.todos`→`.phases` on parsed documents and tree children, `children.kind === 'todos'`→`'phases'`, and `.overview`→`.preamble` on ParsedPlan values.

   Known sites:
   - src/activation/commands.ts: lines ~273 and ~1806 `spec.todos`; imports of ParsedSpec/parseSpec/Todo/TodoAction.
   - src/activation/specExplorer.ts: buildSpecTree, SpecNode, TodoNode, SpecStatus, todoContextValue, specContextValue, parseSpec, validateSpec, and `children.todos` at ~196. Check every `children.kind` comparison.
   - src/activation/specLister.ts: SpecInput, buildSpecTree.
   - src/activation/specStore.ts: ParsedSpec, parseSpec, TodoState, writeTodoState, `.todos` at ~74/126/130.
   - src/engine/runQueue.ts: ParsedSpec, Todo, TodoState, writeTodoState, `.todos` ~732/1084.
   - src/engine/stageContext.ts: `input.spec.overview` ~93/116 becomes `.preamble`, but keep the emitted `# OVERVIEW` heading text unchanged (the brief format is owned by the engine todo), and `.todos` ~176.
   - src/engine/submitPr.ts: parseSpec, `.todos` ~296/299.
   - src/engine/transitions.ts, recovery.ts, resultFlow.ts and roleInstructions.ts: Todo/TodoState type imports.
   - src/extension.ts: TodoState, writeTodoState.
   - src/journal/entry.ts and journal.ts: TodoState/isTodoState.
   - src/orchestrator/controlTools.ts: parseSpec, validateSpec, `.todos` ~827.
   - src/orchestrator/specWriteTools.ts: parseSpec, TodoState, `.todos` ~137/185/238.
   - src/orchestrator/systemPrompt.ts: parseSpec, Todo, TODO_STATES.

   After the edits, `grep -rnE "\b(ParsedSpec|TodoState|TODO_STATES|isTodoState|parseSpec|writeTodoState|validateSpec|SpecError|TodoAction|todoContextValue|SpecAction|legalSpecActions|specContextValue|buildSpecTree|SpecNode|TodoNode|SpecInput|SpecStatus)\b" src test` must be empty, and so must `grep -rn "model/todoState\|model/todoActions\|model/specActions" src test`. Do not rename local variables, file names, functions or wire fields outside src/model (e.g. `spec` variables, `todoId`, SpecStore, specDraft's schema field `structured.overview` which is the draft schema not ParsedPlan); later todos own those. Do not change behaviour: every current caller reads `spec.md` files, which detectDocumentKind classifies as 'legacy-spec' (they contain `# TODOS`/`# OVERVIEW`), so parsing is unchanged for them.

   Files: `src/activation/commands.ts`, `src/activation/specExplorer.ts`, `src/activation/specLister.ts`, `src/activation/specStore.ts`, `src/engine/runQueue.ts`, `src/engine/stageContext.ts`, `src/engine/submitPr.ts`, `src/engine/transitions.ts`, `src/engine/recovery.ts`, `src/engine/resultFlow.ts`, `src/engine/roleInstructions.ts`, `src/extension.ts`, `src/journal/entry.ts`, `src/journal/journal.ts`, `src/orchestrator/controlTools.ts`, `src/orchestrator/specWriteTools.ts`, `src/orchestrator/systemPrompt.ts`

8. Rename and update the model tests; add dual-kind coverage

   Test file renames (git mv):
   - test/todoActions.property.test.ts → test/phaseActions.property.test.ts
   - test/specActions.property.test.ts → test/planActions.property.test.ts

   In every test named in this todo, rename the imported symbols and the describe/it titles to phase/plan vocabulary. In model.test.ts, `describe('TodoState')` becomes `describe('PhaseState')`. Update fixtures that read `.todos`/`.overview` to `.phases`/`.preamble`, the WriteError kind 'todo-not-found' to 'phase-not-found', and `todoId` to `phaseId`.

   Existing generators that build `# OVERVIEW`/`# TODOS` text with `T##` ids stay valid as legacy-spec coverage. Assert `parsed.kind === 'legacy-spec'` where convenient.

   Add new cases:
   (a) parser.property.test.ts / parser.roundtrip.property.test.ts: parametrise the generators over kind ∈ {plan, legacy-spec}. A plan document is frontmatter + `## Endstate\n…\n## What needs changing\n…\n## Limitations & constraints\n…` + `# PHASES` + `- [state] P01 …` lines with `(after P0x; files: …)` hints. The round-trip property must hold for both: every rendered item parses back with its id/state/title/after/files, `kind` equals the generator's kind, and `preamble` equals the rendered preamble text.
   (b) Unit cases (in model.test.ts or validator.test.ts): detectDocumentKind returns 'plan' for `# PHASES`, 'legacy-spec' for `# TODOS`, 'legacy-spec' for an OVERVIEW-only body, 'plan' for an empty or headerless body, and respects an explicit kind argument to parsePlan.
   (c) validator.test.ts: a `- [pending] T01 x` line under `# PHASES` yields one error located on that line whose reason contains 'malformed id "T01"' and 'expected "P"'. A `- [pending] P01 x` line under `# TODOS` yields the symmetric error. In a plan, `- [pending] P02 y (after T01)` yields the 'after hint uses ids of the wrong kind' error. Duplicate / unknown-dep / self-dep / cycle / conflict-marker checks work in a plan doc with P ids.
   (d) validator.property.test.ts and validator.cycle.property.test.ts: run the existing properties for both kinds, choosing the id prefix and section header from the kind. Add a property: for any valid document of kind K, replacing one item's id prefix with the other kind's prefix makes validatePlan report an error on that line.
   (e) hash.approval.property.test.ts: the existing invariance/sensitivity properties are run for both kinds (the hash is sensitive to the preamble text, including the Endstate section for plans). Add a fixed-vector regression: for a fixed legacy spec.md string, approvalHash(parsePlan(s)) equals sha256 of `[overview, ...blankedTodoLines].join('\n')` computed inline in the test (the old algorithm), proving existing approvals stay valid.
   (f) treeModel.property.test.ts: buildPlanTree on plan inputs yields `children.kind === 'phases'` with P ids and `node.kind === 'plan'`; legacy inputs yield `node.kind === 'legacy-spec'`.
   (g) writer coverage: writePhaseState edits only the state box of a P-id phase in a plan doc. If the requested id has the wrong prefix for the document, it returns phase-not-found.

   Also update the tests outside the list that import the renamed symbols, otherwise compile, lint and mocha break: blocked.property, controlTools.invalidBlocks.property, askWatcher.routing, engine.briefWatcher, engine.launcher, engine.specDraft, integration.plan-execute-review, integration.sub-agent-chats, journal.roundtrip.property, recovery.revert, runQueue.approvalGate.property, runQueue.briefContext, runQueue.revert.property, runQueue.worktree, specWriteTools.protectedState.property, stageContext.confinement.property, stageContext, submitPr, systemPrompt.mode, systemPrompt.phase.property, systemPrompt, transitions.dispatch.property, writer.abort, writer.scope.property and writer. In those, change identifiers only and do not rename the files.

   Files: `test/parser.property.test.ts`, `test/parser.roundtrip.property.test.ts`, `test/validator.test.ts`, `test/validator.property.test.ts`, `test/validator.cycle.property.test.ts`, `test/hash.approval.property.test.ts`, `test/todoActions.property.test.ts`, `test/phaseActions.property.test.ts`, `test/specActions.property.test.ts`, `test/planActions.property.test.ts`, `test/treeModel.property.test.ts`, `test/model.test.ts`, `test/model.property.test.ts`, `test/writer.test.ts`, `test/writer.abort.test.ts`, `test/writer.scope.property.test.ts`, `test/blocked.property.test.ts`

9. Verify

   Run `npm run compile`, `npm run lint` and `npm test` (the full mocha suite). Fix any remaining reference. Then run a word-boundary sweep over src/model and the renamed or listed test files: `grep -nwiE 'spec|specs|todo|todos' src/model/*.ts test/{parser*,validator*,hash.approval*,phaseActions*,planActions*,treeModel*,model.*}.ts`. Every remaining hit must be either an explicitly legacy-marked branch or comment (legacy spec.md format, 'legacy-spec' kind, `T##`, `# OVERVIEW`/`# TODOS`, the 'todo' noun in legacy validator messages), a contextValue literal kept for package.json, or a documented legacy test fixture. Reword historical references in these files such as `(Req 3.3)` lines that say 'todo id' into phase wording. Requirement numbers may stay. Leave runTreeModel.ts, mode.ts, role.ts, stage.ts, managedKey.ts and result.ts alone unless compile requires a change; their vocabulary belongs to other todos.

   Files: (none)

## Risks

- Hash compatibility: if the legacy preamble differs at all from the old `overview` (whitespace, slice bounds), every approved legacy spec silently becomes stale. The fixed-vector test in step 8(e) guards this. Keep parsePreamble's legacy branch byte-identical to the old parseOverview.
- Kind detection default: a headerless or frontmatter-only document is classified as 'plan'. Today such a document has no todos either way, so this is safe. A legacy spec.md that lacks both `# OVERVIEW` and `# TODOS` would be classed 'plan', which is harmless because it has no parseable items. Later todos should pass an explicit kind from the path resolver instead of relying on detection.
- The contextValue strings 'baiton.todo'/'baiton.spec'/'baiton.specError' must NOT change in this todo, because package.json when-clauses depend on them. The Activation/UI todo must rename them together with package.json.
- Large mechanical blast radius (~17 src files, ~40 test files). Rename only the model identifiers listed. Renaming adjacent things (SpecStore, todoId wire fields, journal fields, file names outside src/model) would collide with later todos and could change persisted formats.
- stageContext still emits a `# OVERVIEW` heading built from `.preamble`. That is intentional for now (brief format unchanged); the engine/drafting todos own it.
- Validator messages for legacy-spec keep the word 'todo' so existing tests and orchestrator-facing text are unchanged. They must be clearly commented as legacy for the final vocabulary sweep.
- The new foreign-kind after-hint check adds a validator error that did not exist before. A legacy spec whose title happens to end with `(after P01)` would now be flagged invalid. That is very unlikely and matches the 'never silently accepted' requirement.

## Acceptance

- `npm run compile`, `npm run lint` and `npm test` all pass.
- src/model/todoState.ts, todoActions.ts and specActions.ts no longer exist. phaseState.ts, phaseActions.ts and planActions.ts exist and are exported from src/model/index.ts. test/todoActions.property.test.ts and test/specActions.property.test.ts are renamed to phaseActions/planActions.
- `grep -rnwE 'ParsedSpec|TodoState|TODO_STATES|isTodoState|parseSpec|writeTodoState|validateSpec|SpecError|TodoAction|todoContextValue|SpecAction|SpecActionInput|legalSpecActions|specContextValue|buildSpecTree|SpecNode|TodoNode|SpecInput|SpecStatus' src test` returns nothing.
- parsePlan returns `kind: 'plan'` with `preamble` = the body before `# PHASES` and P## phases for a plan.md. It returns `kind: 'legacy-spec'` with `preamble` = the OVERVIEW text and T## items for a legacy spec.md.
- validatePlan reports a located malformed-id error for a T## line in a plan document and for a P## line in a legacy spec document. It also reports wrong-kind ids in after hints. All other validator checks work for both kinds.
- approvalHash and computeInputRev of a legacy spec.md equal the values the pre-change algorithm produced (fixed-vector test), and both functions behave identically for plan documents using the preamble.
- writePhaseState edits only the state box for both kinds, refuses `done` phases with 'done-protected', and returns 'phase-not-found' for missing or wrong-kind ids.
- buildPlanTree yields PlanNodes carrying `kind` and children `{ kind: 'phases', phases }` for both document kinds. The contextValue strings are unchanged.
- New tests exist that cover both document kinds in the parser, validator, hash, writer and tree model.
