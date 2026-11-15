# Plan P02

## Steps

1. Add an ownerRepo input to PlanInput, distinct from the label repo

   In src/model/treeModel.ts, extend `PlanInput` with `ownerRepo?: string` and a doc comment: 'Identity of the repository whose `.baiton/` owns this plan document (used for addressing and actions). Independent of `repo`, which only drives the visible repo label, and of any phase `repo:` hint (the phase target).' Keep the existing `repo?: string` field and its semantics unchanged; reword its comment to 'Repository label shown for this plan; supplied only when repo labels are shown.' Add one private helper near the bottom of the file:

   ```ts
   /** The plan's owning repo: the explicit owner, else the label repo, else none (single-repo). */
   function owningRepo(input: PlanInput): string | undefined {
     return input.ownerRepo ?? input.repo;
   }
   ```

   Falling back to `repo` means the current multi-repo caller (src/activation/planExplorer.ts, which passes `repo: source.repo` only when labels are shown) gets an owning repo on every node with no change on its side, and single-repo callers (no `repo`, no `ownerRepo`) get none. Do not edit planExplorer.ts in this phase.

   Files: `src/model/treeModel.ts`

2. Add ownerRepo to PlanNode, PhaseNode and ErrorNode

   In src/model/treeModel.ts add an optional `ownerRepo?: string` field to each of the three node interfaces, with the comment 'Repository that owns the plan document (its `.baiton/`), present only when the caller supplied one. Never the phase target repo.'
   - `PlanNode`: add `ownerRepo?: string` next to the existing `repo?: string` (leave `repo` — the label — as is).
   - `PhaseNode`: add `ownerRepo?: string`, placed before `repo`. Update the `repo` comment to: 'Target repo from the phase `repo:` hint, present only when it resolves to a repo other than the plan owner. Distinct from `ownerRepo`.'
   - `ErrorNode`: add `ownerRepo?: string` after `slug`.
   The fields are optional and only spread in when defined (`...(owner !== undefined ? { ownerRepo: owner } : {})`), so nodes built without an owner are byte-for-byte the same object shapes as today (deepStrictEqual-stable).

   Files: `src/model/treeModel.ts`

3. Thread the owning repo through buildPlanNode, buildPhaseNode and error nodes

   In `buildPlanNode(input)`: compute `const owner = owningRepo(input);` and `const ownerFact = owner !== undefined ? { ownerRepo: owner } : {};` once at the top.
   - In all three returned PlanNode shapes (read-error, invalid, valid) spread `...ownerFact` right after the existing `repo` spread.
   - In the read-error branch's single error object and in the invalid branch's `errors.map(...)`, spread `...ownerFact` into each ErrorNode (`{ slug: input.slug, ...ownerFact, reason, line }`).
   - Change `buildPhaseNode` to take the owner: add a parameter `owner: string | undefined` (after `slug`) and pass `owner` from the `parsed.phases.map(...)` call. In the returned PhaseNode spread `...(owner !== undefined ? { ownerRepo: owner } : {})` before the existing target spread `...(binding.ok && !binding.isOwner ? { repo: binding.target } : {})`, which stays exactly as it is so a phase with no hint or `repo: .` keeps no `repo` field.
   - Update the file header comment's last line to: 'Optional repo identity records the owning repo on plan, phase and error nodes (separate from a phase's distinct target repo) and labels the plan; non-actionable inputs expose no actions.'
   Do not change labels, actions, grouping or any other derivation. No new imports; module stays vscode-free.

   Files: `src/model/treeModel.ts`

4. Add tests for owning vs target repo on nodes

   In test/treeModel.property.test.ts, add `type RepoTopology` (exported from '../src/model' via validator — confirm with `src/model/index.ts`; if not re-exported, build the topology object literal untyped) and add a new `it(...)` block group inside the existing `describe('tree model (property)')`:
   1. 'omits ownerRepo on every node when no repo identity is supplied': build a valid plan (reuse the inline raw from the first test, with two phases), an invalid plan (e.g. duplicate ids `- [pending] P01 A` twice) and an unreadable one (`readError: 'boom'`); assert `'ownerRepo' in node === false` for each PlanNode, each PhaseNode and each ErrorNode, and that `'repo' in phase === false`.
   2. 'records ownerRepo on plan, phase and error nodes from ownerRepo or the label repo': for the same three inputs with `ownerRepo: 'child'` (and separately with only `repo: 'child'`), assert `node.ownerRepo === 'child'` on the PlanNode, every PhaseNode and every ErrorNode; with `ownerRepo: 'child', repo: 'label'` assert ownerRepo is 'child' and PlanNode.repo is 'label'. Also assert that with ownerRepo only, `PlanNode.repo` is absent (label unchanged).
   3. 'keeps the owning repo separate from the phase target repo': use a topology `{ owner: 'root', repos: [{ name: 'root', root: '/w' }, { name: 'child', root: '/w/child', parent: 'root' }] }`, raw plan phases `- [pending] P01 Owner phase` and `- [pending] P02 Child phase (repo: child)` (check the exact hint grammar in src/model/parser.ts / existing validator tests, e.g. test/validator*.test.ts, and copy it), input `ownerRepo: 'root', topology`. Assert plan is valid, P01 has `ownerRepo: 'root'` and no `repo`, P02 has `ownerRepo: 'root'` and `repo: 'child'`; actions and titles equal those of the same input without ownerRepo.
   4. Property: in the existing 'tree phase nodes equal parsed phases...' style, add an fc.assert over the existing valid-document arbitrary and `fc.option(fc.constantFrom('a', 'b/c'), { nil: undefined })` for ownerRepo, asserting that stripping `ownerRepo` from every node yields a deepStrictEqual match with the tree built without it (owner field is purely additive), and that every phase/error node's ownerRepo equals the input's.

   Files: `test/treeModel.property.test.ts`

5. Build, lint and run the suite

   Run `npm run compile`, `npm run lint` and `npm test` (mocha, full unit + property suite). planExplorer.ts must compile unchanged: it still reads `PlanNode.repo` for labels/ids and `PhaseNode.repo` for the target suffix, both of which keep their meaning.

   Files: (none)

## Risks

- Confusing `PhaseNode.repo` (target) with the new `ownerRepo`: the target spread must stay keyed on `binding.ok && !binding.isOwner`, never on the owner, or single-repo phase descriptions change.
- Falling back from `ownerRepo` to the label `repo` is a deliberate bridge for the current planExplorer caller; a later phase that always passes `ownerRepo` must not rely on `repo` for identity.
- Spreading ownerRepo unconditionally (as `ownerRepo: undefined`) would change object shapes and break deepStrictEqual elsewhere; only spread when defined.
- The phase `repo:` hint grammar and topology shape in the test must match the validator exactly, or the plan comes back invalid; copy from existing validator tests.
- If `RepoTopology` is not re-exported from src/model/index.ts, import it from '../src/model/validator' instead rather than adding exports outside this phase's files.

## Acceptance

- PlanNode, PhaseNode and ErrorNode each declare an optional `ownerRepo?: string`, documented as the owning repo and distinct from the phase target `repo`.
- PlanInput declares `ownerRepo?: string`; nodes carry `ownerRepo` equal to `input.ownerRepo ?? input.repo` on valid, invalid and unreadable plans, including every phase and error child.
- With neither `ownerRepo` nor `repo` supplied, built nodes contain no `ownerRepo` key and are deepStrictEqual to today's output (labels, actions, groups unchanged).
- A phase with a `repo:` hint naming another repo carries both `ownerRepo` (plan owner) and `repo` (target); a phase without a hint carries only `ownerRepo`.
- src/model/treeModel.ts still imports nothing from `vscode`; src/activation/planExplorer.ts is not modified and compiles.
- `npm run compile`, `npm run lint` and `npm test` all pass.
