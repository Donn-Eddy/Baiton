# Plan P03

## Steps

1. planActions: add prsMerged to PlanActionInput and short-circuit legalPlanActions

   In src/model/planActions.ts:
   1. Add to `PlanActionInput` an optional field with a doc comment:
      `/** True when every recorded PR/MR URL reads merged (derived, never persisted). Absent or false keeps today's actions. */ prsMerged?: boolean;`
   2. In `legalPlanActions`, immediately after the `if (input.invalid) return [];` guard and BEFORE the `status === PR_PARTIAL_STATUS` branch, add:
      ```ts
      if (input.prsMerged === true) {
        return input.prUrl !== undefined ? ['showPr'] : [];
      }
      ```
      (A merged plan never offers Approve or Submit PR, not even the pr-partial retry; Show PR only when a `pr:` URL is present.)
   3. Update the function's doc comment to mention: 'A plan whose recorded PRs all read merged offers Show PR only.'
   Do not change the order of the remaining branches, `PR_STATUS`, `PR_PARTIAL_STATUS`, or `planContextValue`.

   Files: `src/model/planActions.ts`

2. treeModel: add prsMerged to PlanGroupFacts and planGroupKind

   In src/model/treeModel.ts:
   1. Extend the import from './planActions' to `import { legalPlanActions, PlanAction, PR_PARTIAL_STATUS, PR_STATUS } from './planActions';`.
   2. Add to `PlanGroupFacts`: `/** True when every recorded PR/MR URL reads merged; only consulted for status `pr`/`pr-partial`. */ prsMerged?: boolean;`
   3. Add a small non-exported helper:
      ```ts
      function isPrStatus(status: PlanStatus): boolean {
        return status.kind === 'set' && (status.value === PR_STATUS || status.value === PR_PARTIAL_STATUS);
      }
      ```
      (PlanStatus value is already trimmed by deriveStatus, so exact comparison is correct.)
   4. Change `planGroupKind`:
      ```ts
      if (facts.status.kind === 'set' && facts.status.value === 'done') return 'completed';
      if (facts.prsMerged === true && isPrStatus(facts.status)) return 'completed';
      // existing active/pending lines unchanged
      ```
      Update its doc comment: 'Completed when status is `done`, or when status is `pr`/`pr-partial` and every recorded PR reads merged; otherwise active when approved or any phase is past `pending`.'

   Files: `src/model/treeModel.ts`

3. treeModel: thread prsMerged through PlanInput, PlanNode and buildPlanNode

   In src/model/treeModel.ts:
   1. `PlanInput` gains `/** Derived fact: every recorded PR/MR URL reads merged. Absent means not known to be merged. */ prsMerged?: boolean;`
   2. `PlanNode` gains `/** Present (true) only when the caller supplied the merged fact; part of the facts `group` is derived from. */ prsMerged?: boolean;`
   3. In `buildPlanNode`, compute once at the top: `const prsMergedFact = input.prsMerged === true ? { prsMerged: true as const } : {};` and spread `...prsMergedFact` into every returned PlanNode object (unreadable, invalid, valid) right after the `repo` spread. Using a conditional spread keeps nodes byte-identical to today when the fact is absent/false, so existing deepStrictEqual-style tests are unaffected.
   4. Pass the fact into all three `planGroupKind` calls: `planGroupKind({ status, approved: input.approved, phaseStates, prsMerged: input.prsMerged })` (and the unreadable one with status unset — it will still never be completed via this rule).
   5. In the valid branch's `legalPlanActions({...})` call add `prsMerged: input.prsMerged === true && isPrStatus(status)` — gating on status so a stray fact on a non-`pr` plan never changes its actions; the invalid/unreadable branches keep `actions: []`.
   6. Leave `status`, `prUrl`, `phaseStates`, children untouched — `status` stays the persisted value.
   No new exports needed beyond the interface fields (src/model/index.ts already re-exports both modules).

   Files: `src/model/treeModel.ts`

4. planActions property tests: merged fact

   In test/planActions.property.test.ts, leave all existing `it` blocks untouched (they never pass prsMerged, so they still pin today's behaviour). Add:
   1. Import `PR_STATUS` alongside `PR_PARTIAL_STATUS`.
   2. `it('a merged plan offers Show PR only, even when partial and ready to retry')` — fc.property over approved (boolean), prUrlArb, phaseStatesArb, `fc.constantFrom(PR_STATUS, PR_PARTIAL_STATUS)`: with `invalid: false, prsMerged: true` assert actions deepStrictEqual `prUrl !== undefined ? ['showPr'] : []`; with `invalid: true, prsMerged: true` assert `[]`.
   3. Example: `legalPlanActions({ approved: true, invalid: false, prUrl: 'https://example.com/org/repo/pull/7', phaseStates: ['done'], status: PR_PARTIAL_STATUS, prsMerged: true })` deepStrictEqual `['showPr']` (contrast with the existing `['submitPr','showPr']` example).
   4. `it('an absent or false merged fact preserves today\'s actions')` — property over approved, invalid, prUrlArb, phaseStatesArb, statusArb: `legalPlanActions({...input, prsMerged: false})` and `legalPlanActions({...input})` deepStrictEqual each other.
   5. Extend the contextValue property only if convenient; not required.

   Files: `test/planActions.property.test.ts`

5. treeModel property tests: merged pr/pr-partial grouping and actions

   In test/treeModel.property.test.ts, keep existing tests unchanged. Add:
   1. `it('groups merged pr/pr-partial plans as completed and leaves other statuses alone')` — fc.property over status `fc.oneof(fc.constant({kind:'unset'}), fc.constantFrom('done','draft','approved','in-progress','pr','pr-partial','Done','PR').map(v=>({kind:'set',value:v})))`, approved, phaseStates, `prsMerged: fc.option(fc.boolean(), {nil: undefined})`. Expected: `done` → completed; else `prsMerged === true && (value === 'pr' || value === 'pr-partial')` → completed; else today's active/pending rule. Also assert `planGroupKind({...facts, prsMerged: undefined})` equals `planGroupKind` without the key (absent fact unchanged).
   2. Example-based `it('buildPlanNode threads the merged fact into group and actions')` using helpers: build raw docs `['---','status: pr','pr: https://example.com/o/r/pull/1','---', validPlanDocument('done')].join('\n')` and the same with `status: pr-partial`. Via `buildPlanTree([{ slug, raw, approved: true, sessions: new Set(), plans: new Set(), prsMerged: true }])[0]` assert: `group === 'completed'`, `actions` deepStrictEqual `['showPr']`, `status` deepStrictEqual `{kind:'set', value:'pr'}` (resp. 'pr-partial') — persisted status unchanged, `prUrl` is the URL, `prsMerged === true`. Without `prsMerged` (use buildPlanNodeForTest(raw, true)): `group === 'active'`, pr-partial actions `['submitPr','showPr']`, pr actions `['showPr']`, and `'prsMerged' in node === false`.
   3. In the same test: a `status: approved` (or no status) valid doc with `prsMerged: true` keeps its group/actions identical to the build without the fact (non-pr status ignores it); a `status: done` doc stays completed.
   4. An invalid `status: pr` doc (e.g. duplicate phase ids as in the existing invalid example but with `status: pr`) with `prsMerged: true` → `invalid === true`, `group === 'completed'`, `actions` `[]`.
   5. Optionally extend the generated-document property at 'plan root prUrl and actions...' NOT by modifying it, but by a new sibling property that adds `prsMerged: fc.boolean()` to the input and asserts `node.group === planGroupKind({status: node.status, approved, phaseStates, prsMerged})`.

   Files: `test/treeModel.property.test.ts`

6. Verify

   Run the type-check and unit tests (e.g. `npm run compile` / `npx tsc --noEmit -p .` and `npm test`, or the repo's mocha invocation for test/treeModel.property.test.ts and test/planActions.property.test.ts). Confirm no other callers of planGroupKind/legalPlanActions/PlanInput (grep: only src/model and test) need edits — the new fields are optional. Do not touch src/activation, src/engine or other phases' files.

   Files: (none)

## Risks

- Adding `prsMerged` unconditionally to PlanNode (e.g. `prsMerged: false`) would break any existing test or caller that deepStrictEquals whole nodes; use a conditional spread so the key is absent unless the input fact is true.
- If treeModel compares untrimmed or case-varied status (e.g. 'PR'), grouping could diverge from the overview's 'trimmed status is pr or pr-partial'; deriveStatus already trims, and the comparison must stay exact-case like the existing 'done' check.
- Choosing to suppress Submit PR when prsMerged is true but no `pr:` URL exists (prs-only multi-repo plan) returns []; this is slightly stronger than 'Show PR when a URL is present' but matches the endstate (no Submit PR retry for a merged plan). Document it in the doc comment.
- Gating the actions fact on status in buildPlanNode but passing the raw fact to planGroupKind (which gates itself) must stay consistent; both effectively require status pr/pr-partial.
- Later phases (planExplorer, commands) depend on the field names `PlanInput.prsMerged` and `PlanActionInput.prsMerged`; renaming them would break downstream phases.

## Acceptance

- `PlanGroupFacts`, `PlanInput`, `PlanNode` and `PlanActionInput` each have an optional `prsMerged?: boolean` with a doc comment; no other exported signatures change.
- `planGroupKind` returns 'completed' for status `done`, or for status `pr`/`pr-partial` with `prsMerged === true`; for every other combination (including prsMerged absent/false, or prsMerged true with any other status) it returns exactly what it returned before.
- `legalPlanActions` with `invalid: false, prsMerged: true` returns `['showPr']` when prUrl is present (including for `pr-partial` with approved + all phases done) and `[]` otherwise; with prsMerged absent/false its output is identical to before.
- `buildPlanTree` with `prsMerged: true` on a valid `status: pr` / `pr-partial` plan yields group 'completed', actions ['showPr'], unchanged persisted `status` and `prUrl`, and `prsMerged: true` on the node; without the fact the node is deep-equal to today's output (no `prsMerged` key).
- A non-pr status plan given `prsMerged: true` keeps its previous group and actions.
- All existing tests in test/treeModel.property.test.ts and test/planActions.property.test.ts pass unmodified, the new tests pass, and the project type-checks.
- Only src/model/treeModel.ts, src/model/planActions.ts, test/treeModel.property.test.ts and test/planActions.property.test.ts are modified.
