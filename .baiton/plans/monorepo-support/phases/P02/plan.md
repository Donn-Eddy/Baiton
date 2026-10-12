# Plan P02

## Steps

1. Parser: add the optional `repo:` hint group and `Phase.repo`

   In src/model/parser.ts:
   - Add `repo?: string` to the `Phase` interface with a doc comment: the raw hint text naming the target repo as a path relative to the owning repo's root (`.` = the owning repo); absent means the owning repo.
   - Change `parseHints` to return `{ after: string[]; files: string[]; repo?: string } | undefined`. Add a third group branch, checked after `after` and `files`: match with a dedicated regex `/^repo\s*:\s*(\S.*)$/i`. The colon is REQUIRED for `repo`, unlike after/files. This keeps an existing title ending in prose such as `(repo cleanup)` parsing exactly as it does today. Trim the captured value. Return `undefined` (the whole parenthetical stays in the title, as for other malformed groups) when the value is empty, contains `,`, or a second `repo` group appears in the same hint. Set `sawAny = true` for a valid repo group, so `(repo: packages/api)` alone is a valid hint.
   - `parseTitleAndHints` returns `repo` too. `parsePhaseLine` builds the Phase with a conditional spread, `...(repo !== undefined ? { repo } : {})`, so a hint-less phase has NO `repo` key. Existing deepStrictEqual comparisons of Phase objects and generated models must stay unchanged.
   - `trailingHintIdsOfOtherKind` keeps working: its `parseHints` call now also accepts repo groups, and it still only reports `after` ids.
   - Export a small helper for the validator: `export function trailingRepoHintText(title: string): string | undefined`. It returns the trailing parenthetical's inner text when the title ends with `)` and that inner text contains a group matching `/(^|;)\s*repo\s*:/i`, and `undefined` otherwise. The validator uses it to flag malformed repo hints that the parser left in the title.
   - Update the module doc comment to mention the `repo:` group. Do not change frontmatter, preamble or kind detection. Both kinds accept the group (legacy-spec as well as plan).

   Files: `src/model/parser.ts`

2. Validator: inject repo topology and refuse unknown, sibling, ancestor and malformed bindings

   In src/model/validator.ts (keep it pure: import only `path` from Node plus the model modules, no activation/vscode/fs):
   - Add exported types:
     `export interface RepoTopologyEntry { readonly name: string; readonly root: string; readonly parent?: string }`. This is structurally satisfied by `Repo` from src/activation/repoDiscovery.ts, but do NOT import that module.
     `export interface RepoTopology { readonly owner: string; readonly repos: readonly RepoTopologyEntry[] }`. `owner` is the name of the repo whose `.baiton/` holds the document.
     `export type RepoBinding = { ok: true; target: string; isOwner: boolean } | { ok: false; reason: 'invalid' | 'unknown' | 'sibling' | 'ancestor'; target?: string }`.
   - Add `export function normalizeRepoHint(hint: string): string | undefined`. Trim it, convert `\\` to `/`, and return undefined (invalid) when it is absolute (`/` start or `/^[A-Za-z]:/`). Otherwise apply `path.posix.normalize`, strip any trailing `/`, and map `''` and `./` to `.`.
   - Add `export function resolvePhaseRepo(hint: string | undefined, topology: RepoTopology | undefined): RepoBinding`:
     - If hint is undefined, return `{ ok: true, target: topology?.owner ?? '.', isOwner: true }`.
     - If normalization fails, return `{ ok: false, reason: 'invalid' }`.
     - If the normalized hint is `.`, return the owner (ok, isOwner).
     - If topology is undefined, or `topology.owner` is not in `repos`, return `{ ok: false, reason: 'unknown' }`. Only the owning repo is known without topology.
     - Otherwise set `targetAbs = path.resolve(owner.root, ...normalized.split('/'))` and match the repo whose `path.resolve(root) === targetAbs`. With no match, return `unknown`. That covers a path that is a plain directory and not a discovered repo boundary.
     - If the match is the owner, return ok/isOwner. That covers forms like `a/..`.
     - Walk the parent chain from the match. If it reaches the owner, return `{ ok: true, target: match.name, isOwner: false }`.
     - Walk the parent chain from the owner. If it reaches the match, return `ancestor`. Otherwise return `sibling`; this covers any unrelated repo, including another workspace folder. Guard both walks with a `seen` set.
   - Change the signature to `validatePlan(plan: ParsedPlan, raw: string, topology?: RepoTopology): PlanError[]` and append `findRepoBindingErrors(plan, topology)` after `findForeignHintErrors`. Existing callers (treeModel, controlTools, tests) compile unchanged.
   - `findRepoBindingErrors` walks every phase. If `phase.repo === undefined` and `trailingRepoHintText(phase.title) !== undefined`, push a reason of `malformed repo hint "<inner>"; expected exactly one "repo: <path>" group`. Otherwise resolve the hint and, on failure, push `{ line: phase.lineIndex + 1, text: renderPhaseRef(phase), reason }`, using `itemNoun(plan.kind)`:
     - invalid: `<noun> "<id>" has an invalid repo hint "<hint>"; expected a path relative to the owning repo`
     - unknown: `<noun> "<id>" targets unknown repo "<hint>"; expected the owning repo or a repo nested beneath it`
     - sibling: `<noun> "<id>" targets repo "<target>", which is a sibling of the owning repo "<owner>"; a phase may only target the owning repo or a repo nested beneath it`
     - ancestor: the same pattern with `which is an ancestor of the owning repo`.
     Hint-less phases never produce an error, so every existing document validates exactly as before.
   - src/model/index.ts already re-exports validator.ts, so no index change is needed. Check for export-name collisions with `compile`.

   Files: `src/model/validator.ts`

3. Hash and writer: keep raw-line hashing, document the hint, no behavioural change

   src/model/hash.ts: do NOT change `approvalHash`, `computeInputRev`, `blankStateBox` or `hashPayload`. They already hash the raw on-disk line with the state box blanked, so a hint-less line hashes byte-identically to today. Adding, removing or changing `repo: ...` changes the raw line, and with it the approval hash and that phase's input rev only. Update the doc comments to say this explicitly: the repo hint is part of the hinted content, and it is deliberately not normalized before hashing. src/model/writer.ts: no code change. `writePhaseState` only replaces the `[state]` box, so the repo hint round-trips byte-for-byte. Update the module doc comment's list of user-owned bytes to name the `after`/`files`/`repo` hints.

   Files: `src/model/hash.ts`, `src/model/writer.ts`

4. Plan-draft schema, type and renderer: optional per-phase repo

   - src/schema/types.ts: add to `PlanDraftPhase` the field `repo?: string`, documented as the target repo path relative to the owning repo, emitted only for a child repo.
   - src/schema/schemas.ts, in `planDraftSchema.phases.items.properties`, add `repo: { type: 'string', nullable: true, minLength: 1, pattern: '^[^,;()\\n\\r]+$' }`. The pattern makes the rendered hint parse. Do not add it to `required`, and update the schema's doc comment.
   - src/engine/planDraft.ts: add `repo?: string` to `RenderPlanPhase`. In `writePlan`, map `...(phase.repo !== undefined ? { repo: phase.repo } : {})`. In `renderPlan`, set `const repo = phase.repo?.trim()` and push `repo: ${repo}` as the LAST group (after `after` and `files`) only when `repo` is non-empty and not `.`, so the owning repo stays implicit. The output for a phase without `repo` must be byte-identical to today.
   - Repo discovery is not yet wired into plan-draft, so the plan is still written to `services.baitonDir`, and the validator is not run here. Leave the lock and `workspaceRoot` untouched in this phase.

   Files: `src/schema/types.ts`, `src/schema/schemas.ts`, `src/engine/planDraft.ts`

5. Property tests: parser round trip with the repo hint

   In test/parser.roundtrip.property.test.ts:
   - Add `repo?: string` to `PhaseModel`.
   - Add `repoArb`: a non-empty path built from 1–3 segments of `[a-z0-9_-]{1,8}` joined by `/`, mixed with the literal `.`.
   - Generate `repo: fc.option(repoArb, { nil: undefined })` per phase.
   - `renderPhaseLine` appends a `repo: <value>` group when repo is defined. Keep the `after` and `files` rendering unchanged.
   - Assert `actual.repo === expected.repo`, and that `'repo' in actual` is false when the model has no repo.
   - Add example tests:
     - `(after P01; repo: packages/api)` parses to after `['P01']` and repo `packages/api`.
     - `(repo: a; files: x.ts)` parses as well; group order is free.
     - `Fix thing (repo cleanup)`, with no colon, keeps the whole text as the title and has no repo.
     - `(repo: a; repo: b)` and `(repo: a, b)` leave the parenthetical in the title and set no repo.
     - The same rules hold for a legacy-spec `T##` line.

   Files: `test/parser.roundtrip.property.test.ts`

6. Property tests: approval hash and input rev pinning and sensitivity

   In test/hash.approval.property.test.ts:
   - Add the optional `repo` to `PhaseModel` and its generator, `fc.option(repoArb, { nil: undefined })`, using the same repoArb shape as the parser test. `renderPhaseLine` emits `repo: <v>` last when it is defined.
   - New property 'hint-less documents hash byte-identically to the pre-change payload'. Generate models with repo forced undefined for both kinds. Compute the expected approval hash independently in the test: sha256 of `[parsed.preamble, ...phaseLines.map(l => l.replace(/^(- )\[[^\]]*\]/, '$1[]'))].join('\n')`, where phaseLines are the rendered lines. Assert it equals `approvalHash`. For every phase, assert `computeInputRev` equals the sha256 of `[preamble, blankedLine].join('\n')`, and that `parsePlan` gives the phase no `repo` key.
   - Extend `mutateContent` with kinds 'repo-add' (target a phase without a repo; set `packages/zz`), 'repo-change' (target a phase with a repo; append `x`) and 'repo-remove' (target a phase with a repo; delete it). Choose a valid target index, or use `fc.pre` to skip when none exists. Add them to the 'changes when ...' property's `constantFrom`.
   - New property: for each repo mutation, `computeInputRev(mutated, phase.id)` differs from the original for the mutated phase and is unchanged for every other phase.
   - The existing state-box invariance property must still pass with the repo hints present.

   Files: `test/hash.approval.property.test.ts`

7. Unit tests: validator bindings, writer round trip, renderPlan, and schema

   - Add test/validator.repo.test.ts. Build a RepoTopology literal with POSIX-style absolute roots, `path.resolve`-d: root `.` at /ws, `packages/api` at /ws/packages/api (parent `.`), `packages/api/sub` at /ws/packages/api/sub (parent `packages/api`), and `packages/web` at /ws/packages/web (parent `.`). Cover:
     - owner `.`: hints `packages/api`, `packages/api/sub`, `./packages/api/` and `.` validate with no errors.
     - owner `.`: hint `packages/nope` and hint `packages` (a plain directory) each give one 'unknown repo' error with the right line.
     - owner `packages/api`: hint `../web` gives 'sibling', `..` gives 'ancestor', `sub` is ok, and `/abs` gives 'invalid'.
     - With no topology argument, a hint-less plan and `repo: .` are valid, and `repo: packages/api` gives 'unknown'.
     - A malformed `(repo: a; repo: b)` gives the 'malformed repo hint' error.
     - A legacy-spec doc uses the noun 'todo'.
     - `resolvePhaseRepo` returns `target`/`isOwner` correctly.
   - test/writer.test.ts: `writePhaseState` on `- [pending] P01 Do it (after P00; repo: packages/api)` rewrites only the box. The rewritten line still parses with `repo === 'packages/api'`, and `approvalHash` is unchanged across the write.
   - test/engine.planDraft.test.ts `renderPlan`: phases with `repo: 'packages/api'` render `(after P01; files: a.ts; repo: packages/api)`. A repo of `.` or `'  '` emits no group. Phases without a repo render byte-identically to the existing expectations, and parsePlan reads `repo` back.
   - test/schema.examples.test.ts: a plan-draft result with phase `repo: 'packages/api'` is accepted, while `repo: ''`, `repo: 'a;b'` and `repo: 5` are rejected.

   Files: `test/validator.repo.test.ts`, `test/writer.test.ts`, `test/engine.planDraft.test.ts`, `test/schema.examples.test.ts`

8. Build and verify

   Run `npm run compile`, `npm run lint`, then the focused suites with `npx mocha --no-config --require ts-node/register --extension ts` on test/parser*.test.ts, test/hash.approval.property.test.ts, test/validator*.test.ts, test/writer*.test.ts, test/engine.planDraft.test.ts and test/schema*.test.ts. Then run the full `npm test`. Git subprocess tests may need host permissions, as in P01. Finally, grep for every `validatePlan(` call and confirm the existing call sites in treeModel.ts and controlTools.ts are untouched and still compile. A later phase passes topology to them.

   Files: (none)

## Risks

- Title compatibility: an existing phase whose title ends in a parenthetical starting with `repo:` would now parse as a hint. Requiring the colon (unlike after/files) keeps prose like `(repo cleanup)` safe. The approval hash cannot change either way, because the hash covers the raw line.
- Without a topology argument, the validator treats any non-`.` hint as an unknown repo. treeModel and controlTools do not pass topology until a later phase wires it in, so until then a child-repo hint shows as invalid. That is the safe failure: no phase can run in an unvalidated repo.
- Hint semantics (a path relative to the owning repo root, not the folder-prefixed repo name) must stay consistent in later phases: execution, planWriteTools, role instructions. For a plan in a single-folder root repo, the hint equals the child's discovered name.
- Adding `repo` to the Phase object must use a conditional spread. Writing `repo: undefined` explicitly would break deepStrictEqual-based tests and models across the suite.
- On Windows, root comparison uses `path.resolve` equality. Case-insensitive filesystems could make a differently-cased hint resolve to 'unknown'. Discovery canonicalizes roots, but hints are not case-folded.
- The JSON schema pattern for `repo` must stay in sync with the parser's rejection of `,`, `;` and parens. Otherwise a drafted hint could render to an unparseable line that silently becomes title text, which the validator's malformed-repo check then flags.

## Acceptance

- `npm run compile` and `npm run lint` pass with no new errors.
- `npm test` passes, including all existing parser, hash, validator, writer, treeModel, controlTools and planDraft tests, which are unmodified except for added cases.
- parsePlan exposes `phase.repo` for `(after P01; repo: packages/api)`, and a hint-less phase has no `repo` key.
- A property test proves that hint-less phase lines (plan and legacy-spec) give an approvalHash and computeInputRev equal to an independently computed sha256 of the pre-change payload.
- Property tests prove that adding, changing or removing a repo hint changes the approval hash and that phase's input rev, while other phases' input revs and state-box-only edits leave hashes unchanged.
- validatePlan(plan, raw, topology) returns no errors for owner and descendant targets. It returns located errors for unknown, sibling, ancestor, absolute/invalid and malformed repo hints. Without topology, only the owning repo (`.` or no hint) is accepted.
- renderPlan emits `repo: <path>` as the last hint group only for non-empty, non-`.` values, and its output for repo-less phases is byte-identical to before. The plan-draft schema accepts an optional valid `repo` and rejects empty or grammar-breaking values.
- writePhaseState preserves a repo hint byte-for-byte.
