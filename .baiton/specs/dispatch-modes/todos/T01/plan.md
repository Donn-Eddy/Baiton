# Plan T01

## Steps

1. Add src/model/mode.ts with RunMode, RUN_MODES, DEFAULT_MODE, isRunMode and isSpecless

   New file, styled exactly like the sibling vocabulary modules src/model/stage.ts and src/model/todoState.ts (leading block comment, exported union, exported readonly array with `as const`, a type-guard predicate).

   Contents:

   ```ts
   /**
    * The mode of one Baiton chat conversation, and so the pipeline a dispatch
    * from that conversation runs. `spec` is the default and keeps the existing
    * gather -> draft_spec -> approve -> run per-todo flow byte-for-byte; `bug`,
    * `quick` and `refactor` share one spec-less plan -> execute -> review
    * pipeline that differs only in the framing handed to the sub-agents; and
    * `investigate` is a read-only dispatch that ends in a written finding.
    */
   export type RunMode = 'spec' | 'bug' | 'quick' | 'refactor' | 'investigate';

   /** All modes a conversation can be in, spec first. */
   export const RUN_MODES: readonly RunMode[] = [
     'spec',
     'bug',
     'quick',
     'refactor',
     'investigate',
   ] as const;

   /**
    * The mode a conversation starts in and the mode an absent/unknown stored
    * value falls back to, so every existing code path keeps today's behaviour.
    */
   export const DEFAULT_MODE: RunMode = 'spec';

   /** Whether an arbitrary string is a known RunMode. */
   export function isRunMode(value: string): value is RunMode {
     return (RUN_MODES as readonly string[]).includes(value);
   }

   /**
    * Whether a mode's dispatches live entirely outside `.baiton/specs/`: true for
    * every mode except `spec`. A spec-less run owns only
    * `.baiton/runs/<run-id>/` and `.baiton/worktrees/<run-id>/`, so this is the
    * predicate later code uses to decide that no spec is read or written.
    * `investigate` is spec-less too — it simply runs a different pipeline, which
    * callers distinguish with `mode === 'investigate'`.
    */
   export function isSpecless(mode: RunMode): boolean {
     return mode !== 'spec';
   }
   ```

   Do not add any other export — the manifest, pipeline and prompt selection are other todos' work.

   Files: `src/model/mode.ts`

2. Export the mode module from src/model/index.ts

   Add `export * from './mode';` to the barrel. Place it immediately after `export * from './stage';` so the vocabulary modules stay grouped; leave every other line untouched.

   Files: `src/model/index.ts`

3. Add the `investigate` stage to src/model/stage.ts

   Extend the `Stage` union with `| 'investigate'` and append `'investigate'` as the last element of `STAGES` (after `'pr'`). Appending rather than inserting keeps every existing stage's position stable for any test that indexes the array.

   Update the file's leading block comment to mention the new stage: `investigate` is run-scoped (not todo-scoped), is run by the existing `reviewer` role, and persists a single `finding.md`.

   `isStage` needs no change — it derives from `STAGES`.

   Do NOT touch src/model/role.ts, the config `roles` mapping, `defaultConfig`, or src/adapter/roleProfile.ts: the new stage reuses the existing `reviewer` role profile (read + search + shell, writes only its run result), so there is no new role and no config migration.

   Files: `src/model/stage.ts`

4. Add InvestigateResult to src/schema/types.ts

   Append, next to the other stage result interfaces and before the `StageResult` union:

   ```ts
   /**
    * The investigator's structured output (Investigate stage): the answer to the
    * question the run asked, the files it is grounded in, and what could be done
    * next. No verdict and no test block — an investigate run changes nothing.
    */
   export interface InvestigateResult {
     /** The finding: the answer to the question the run asked. */
     finding: string;
     /** Repository-relative files the finding is grounded in. */
     files: string[];
     /** Suggested follow-up work, in priority order. */
     next_steps: string[];
   }
   ```

   Then add `| InvestigateResult` to the `StageResult` union. Leave every existing interface byte-for-byte unchanged.

   Files: `src/schema/types.ts`

5. Add investigateSchema to src/schema/schemas.ts

   Add `InvestigateResult` to the existing `import type { ... } from './types';` list (keep the list alphabetical: it goes after `ExecuteResult`). Then append the schema at the end of the file, in the same strict style as the others:

   ```ts
   /**
    * Investigate stage schema: the finding, the files it is grounded in, and the
    * suggested next steps. Strict, like every other stage schema. The finding is
    * required non-empty — an investigate run whose whole product is the finding
    * has produced nothing without it.
    */
   export const investigateSchema: JSONSchemaType<InvestigateResult> = {
     type: 'object',
     additionalProperties: false,
     required: ['finding', 'files', 'next_steps'],
     properties: {
       finding: { type: 'string', minLength: 1 },
       files: { type: 'array', items: { type: 'string' } },
       next_steps: { type: 'array', items: { type: 'string' } },
     },
   };
   ```

   No `if`/`then`/`else` — there is no verdict to constrain. Do not modify any existing schema object.

   Files: `src/schema/schemas.ts`

6. Wire the investigate stage through src/schema/index.ts

   Five mechanical additions, all additive:

   1. Add `investigateSchema` to the `import { ... } from './schemas';` block and `InvestigateResult` to the `import type { ... } from './types';` block.
   2. Add `investigateSchema` to the `export { ... } from './schemas';` re-export list.
   3. `const validateInvestigate = ajv.compile(investigateSchema);` beside the other compiled validators; add `investigate: validateInvestigate as ValidateFunction,` to `VALIDATORS` and `investigate: investigateSchema,` to `STAGE_SCHEMAS`. Both are `Record<Stage, ...>`, so tsc fails until these entries exist — this is the compile-time proof the stage is wired.
   4. Add the typed convenience wrapper beside `validateReviewResult`:

   ```ts
   /** Typed convenience wrapper for the Investigate stage. */
   export function validateInvestigateResult(
     value: unknown,
   ): Result<InvestigateResult, SchemaError[]> {
     return validateStageResult('investigate', value) as Result<
       InvestigateResult,
       SchemaError[]
     >;
   }
   ```

   5. `stageArtifactIsNumbered`: add the new stage to the exclusion list, since the finding persists once per run —
   `return stage !== 'plan' && stage !== 'pr' && stage !== 'spec-draft' && stage !== 'investigate';`

   6. `persistencePathForStage`: add a case before the `default:` arm, and extend the function's doc comment to say the investigate artifact is run-scoped (`finding.md`, relative to the run directory, not a spec) and ignores the todo id and index like the other unnumbered spec-scoped stages:

   ```ts
       case 'investigate':
         // An investigate run persists one finding, at the root of its run
         // directory; it is run-scoped, so the todo id and index are unused.
         return 'finding.md';
   ```

   The `switch` keeps its `assertNever(stage)` default, which is the second compile-time proof the stage is handled.

   Files: `src/schema/index.ts`

7. Add the investigate artifact renderer to src/engine/resultFlow.ts

   Add `InvestigateResult` to the `import type { ... } from '../schema';` list. Then add the renderer beside `renderReviewArtifact`, using the existing `bullets()` helper so an empty list renders `- (none)` exactly as the other renderers do:

   ```ts
   /**
    * The investigate artifact: the finding, the files it is grounded in, and the
    * suggested next steps. This is `finding.md` — the whole product of an
    * investigate run, and the text the chat's promote card carries into a Bug or
    * Quick run as the work statement.
    */
   export function renderInvestigateArtifact(
     runId: string,
     result: InvestigateResult,
   ): string {
     return [
       `# Finding ${runId}`,
       '## Finding',
       result.finding,
       '## Files',
       bullets(result.files.map((f) => `\`${f}\``)),
       '## Next steps',
       bullets(result.next_steps),
     ].join('\n\n') + '\n';
   }
   ```

   In `renderArtifact`, add the case before the `default:` arm:

   ```ts
       case 'investigate':
         return renderInvestigateArtifact(id, structured as InvestigateResult);
   ```

   The `id` local is already `todoId ?? ''`; for an investigate run the caller passes the run id there, so no signature change is needed. Leave `artifactPathFor` alone — it composes a spec path, and the run pipeline (a later todo) supplies its own `ArtifactWriter`/path for run-scoped artifacts.

   Files: `src/engine/resultFlow.ts`

8. Map the investigate stage to the reviewer role in src/activation/engineFacade.ts

   `STAGE_ROLE` is a `Record<Stage, Role>`, so tsc fails until the entry exists. Add, after the `pr` entry:

   ```ts
     // `investigate` is run-scoped and runs through the run pipeline, never
     // through the todo-scoped queue; the existing `reviewer` role already has
     // exactly the surface it needs (read + search + shell, writes only its run
     // result), so no new role is introduced.
     investigate: 'reviewer',
   ```

   `actionForStage` needs no new case: its `default:` already returns `undefined`, so an `investigate` trigger reaching `dispatchTrigger` is refused with the existing `"stage \"investigate\" is not a standalone trigger"` error — the correct answer, because investigate is dispatched by the run pipeline, not the per-todo queue. Add a short comment on the `plan-review` case noting that `investigate` lands in the same arm for that reason.

   Files: `src/activation/engineFacade.ts`

9. Extend the three existing stage-exhaustive test files so they compile and pass with the new stage

   These three files are not optional: each is exhaustive over `Stage` and will break the moment `'investigate'` joins `STAGES`. The edits are purely additive — no existing assertion changes.

   1. `test/schema.reject.property.test.ts` — `baseResult(stage)` is a `switch` with no `default` under `noImplicitReturns`, so it stops compiling. Add:

   ```ts
       case 'investigate':
         return {
           finding: 'The retry loop drops the last review.',
           files: ['src/engine/runPipeline.ts'],
           next_steps: ['carry the review into the retry brief'],
         };
   ```

   The existing mutations (drop a required key, wrong-type a key, add an extra property) all hold against `investigateSchema` as written.

   2. `test/schema.roundtrip.property.test.ts` — `RESULT_ARBS` is a `Record<Stage, ...>`. Add `InvestigateResult` to the `import type` list, add an arb beside the others, and add the map entry:

   ```ts
   /** A conformant {@link InvestigateResult}; the finding is non-empty. */
   const investigateArb: fc.Arbitrary<InvestigateResult> = fc.record({
     finding: fc.string({ minLength: 1, maxLength: 30 }),
     files: filesArb,
     next_steps: fc.array(textArb, { maxLength: 5 }),
   });
   ```

   ```ts
     investigate: investigateArb as fc.Arbitrary<StageResult>,
   ```

   Note the `minLength: 1` — the shared `textArb` can produce `''`, which `investigateSchema` rejects.

   3. `test/schema.persistencePath.property.test.ts` — the main property generates over all `STAGES` and its final `else` arm would demand `todos/<id>/investigate-<n>.md`. Add an arm beside the `spec-draft` and `pr` arms (before the `plan` arm):

   ```ts
           } else if (stage === 'investigate') {
             // An investigate run persists one finding at its run-dir root.
             assert.strictEqual(
               path,
               'finding.md',
               `investigate must yield finding.md, got ${path}`,
             );
             assert.strictEqual(
               stageArtifactIsNumbered(stage),
               false,
               'investigate artifact must not be numbered',
             );
   ```

   Also extend the closing `it('spec-draft and pr ignore the todo id')` case with `assert.strictEqual(persistencePathForStage('investigate', todoId), 'finding.md');` and rename it to `'the run- and spec-scoped stages ignore the todo id'`.

   Nothing else needs touching: `test/model.test.ts`, `test/journal.roundtrip.property.test.ts`, `test/resultFlow.artifacts.test.ts`, `src/engine/recovery.ts` and `test/integration.plan-execute-review.test.ts` all either iterate `STAGES` generically or have a `default:` arm.

   Files: `test/schema.reject.property.test.ts`, `test/schema.roundtrip.property.test.ts`, `test/schema.persistencePath.property.test.ts`

10. Add an investigate example block to test/schema.examples.test.ts

   Add `validateInvestigateResult` to the imports and a new `describe('investigate stage', ...)` block after the `review stage` block, matching the hand-written accept/reject style of its siblings:

   - accepts a well-formed result (`{ finding, files: ['src/a.ts'], next_steps: ['...'] }`);
   - accepts empty `files` and `next_steps` arrays;
   - rejects a missing `finding`, a missing `files`, a missing `next_steps`;
   - rejects an empty-string `finding`;
   - rejects a non-string item inside `files`;
   - rejects an unexpected extra property (`additionalProperties: false`);
   - reaches the same validator through the generic entry point: `isOk(validateStageResult('investigate', { finding: 'f', files: [], next_steps: [] }))` and `isErr(validateStageResult('investigate', { finding: 'f' }))`.

   Also add one cross-stage guard to the existing `validateStageResult dispatches by stage` block: an investigate-shaped value submitted under `'review'` is rejected, and a review-shaped value submitted under `'investigate'` is rejected. Do not modify any existing assertion in this file.

   Files: `test/schema.examples.test.ts`

11. Add test/mode.test.ts covering the new vocabulary and the no-regression guarantee

   New unit test file (mocha + `assert`, no vscode import), in the house style of `test/model.test.ts`. Four describes:

   1. `RunMode` — `DEFAULT_MODE === 'spec'`; `RUN_MODES` deep-equals `['spec','bug','quick','refactor','investigate']`; `isRunMode` accepts every member of `RUN_MODES` and rejects `'bogus'`, `''`, `'Spec'`; `isSpecless('spec') === false` and `isSpecless(m) === true` for every other member (loop over `RUN_MODES`).

   2. `investigate stage` — `isStage('investigate') === true`; `STAGES` includes it; the six pre-existing stages are all still present and `STAGES.length === 7`; `schemaForStage('investigate') === investigateSchema`; `persistencePathForStage('investigate')` is `'finding.md'` with no todo id, with a todo id, and with an index (all three call shapes); `stageArtifactIsNumbered('investigate') === false`; `STAGE_ROLE.investigate === 'reviewer'` (import from `../src/activation/engineFacade`, which is host-free).

   3. `investigate result` — `validateInvestigateResult` accepts a well-formed value and rejects a missing `finding`; `renderInvestigateArtifact('R01', { finding: 'f', files: ['src/a.ts'], next_steps: ['n'] })` starts with `'# Finding R01'` and contains `'## Finding'`, `` '`src/a.ts`' `` and `'- n'`; the empty-list case renders `'- (none)'`; and `renderArtifact('investigate', value, 'R01')` equals `renderInvestigateArtifact('R01', value)`.

   4. `existing stages unchanged` — a regression guard, since the whole point of the todo is that nothing else moves: `persistencePathForStage` still yields `'spec.md'`, `'pr.md'`, `'todos/T01/plan.md'`, `'todos/T01/plan-review-2.md'`, `'todos/T01/execute-3.md'`, `'todos/T01/review-1.md'`; `stageArtifactIsNumbered` is false for `plan`/`pr`/`spec-draft` and true for `plan-review`/`execute`/`review`; and `STAGE_ROLE` still maps `plan → planner`, `execute → executor`, `review → reviewer`, `spec-draft → spec-writer`, `plan-review → plan-reviewer`, `pr → pr-writer`.

   Open the file with the repo's usual header block comment naming what it validates.

   Files: `test/mode.test.ts`

12. Verify the build, lint and full suite

   Run, from the repository root:

   - `npm run compile` — must be clean. This is the real proof of wiring: `VALIDATORS`, `STAGE_SCHEMAS` and `STAGE_ROLE` are `Record<Stage, ...>` and `persistencePathForStage` ends in `assertNever`, so a missed entry is a type error, not a silent gap.
   - `npm run lint` — must be clean (`noUnusedLocals`/`noUnusedParameters` are on, so drop any import you did not end up using).
   - `npm test` — the whole suite, unit and property. Every pre-existing test must pass without its assertions being changed; only the three additive edits in step 9 touch existing test files.

   If `tsc` reports a `Record<Stage, ...>` outside the files listed above, add the `investigate` entry there rather than widening the type — that map is exactly the kind of totality check the stage addition is meant to trip.

   Files: (none)

## Risks

- `isSpecless` is ambiguous in the OVERVIEW: the prose calls Bug/Quick/Refactor "one spec-less pipeline", which could read as excluding Investigate. This plan defines `isSpecless(mode) === (mode !== 'spec')`, matching the literal name and the hard rule that no non-Spec run writes under `.baiton/specs/`. Callers that need the three-mode build pipeline specifically should test `mode !== 'spec' && mode !== 'investigate'`. If a later todo wants the narrower meaning under this name, only this one-line predicate changes.
- Adding a member to `Stage` is a breaking change for every `Record<Stage, ...>` and every `switch (stage)` without a `default`. Three existing test files (`schema.reject.property`, `schema.roundtrip.property`, `schema.persistencePath.property`) are exhaustive and will not compile or will fail otherwise, so step 9 edits them even though the todo's file list does not name them. The edits are strictly additive — no existing assertion is weakened or removed — which keeps the "every existing test passes unchanged" intent even though three files gain lines.
- `persistencePathForStage('investigate')` returns `'finding.md'`, a run-relative path, while every other return value from that function is spec-relative and `artifactPathFor` joins them under `.baiton/specs/<slug>/`. Calling `artifactPathFor` with `'investigate'` would therefore write a finding into a spec folder. That is left for the run pipeline todo to avoid (it supplies its own writer and run-dir path); this todo only documents it in the function's doc comment and does not change `artifactPathFor`.
- `investigateSchema` requires a non-empty `finding`. Any generator built from the shared `textArb` (which can produce `''`) will flake against it, so the roundtrip arb must use `fc.string({ minLength: 1 })` — the same care `specDraftSchema`'s `title` already needs.
- `renderArtifact`'s third parameter is still named `todoId`; an investigate run passes its run id through it. Renaming the parameter would ripple through every caller and existing test, so the plan keeps the name and explains the reuse in the comment instead.
- `STAGE_ROLE` lives in `src/activation/engineFacade.ts`. Importing it from `test/mode.test.ts` is safe only because that module never imports `vscode` (it imports from `../model`, `../engine`, `../orchestrator`, `../adapter`, `../journal`); `test/engineFacade.resume.test.ts` already relies on this. If it ever gains a `vscode` import, assert the mapping from a host-free module instead.

## Acceptance

- `npm run compile` is clean; `npm run lint` is clean.
- `npm test` passes in full, with no pre-existing assertion modified — the only edits to existing test files are the additive `investigate` arms in `test/schema.reject.property.test.ts`, `test/schema.roundtrip.property.test.ts` and `test/schema.persistencePath.property.test.ts`.
- `src/model/mode.ts` exports `RunMode`, `RUN_MODES`, `DEFAULT_MODE === 'spec'`, `isRunMode` and `isSpecless`, and is re-exported from `src/model/index.ts` (so `import { DEFAULT_MODE } from '../src/model'` resolves).
- `isSpecless('spec')` is false and `isSpecless(m)` is true for `bug`, `quick`, `refactor` and `investigate`.
- `isStage('investigate')` is true, `STAGES` has 7 members ending in `'investigate'`, and all six previous members are still present in their original order.
- `schemaForStage('investigate')` returns `investigateSchema`; `validateInvestigateResult` accepts `{ finding, files, next_steps }`, and rejects a missing/empty `finding`, a missing `files` or `next_steps`, a non-string item in `files`, and any extra property.
- `persistencePathForStage('investigate')` returns `'finding.md'` for every call shape (no todo id, a todo id, an index), and `stageArtifactIsNumbered('investigate')` is false.
- `renderArtifact('investigate', result, runId)` equals `renderInvestigateArtifact(runId, result)` and produces a `# Finding <runId>` heading with `## Finding`, `## Files` and `## Next steps` sections, rendering `- (none)` for empty lists.
- `STAGE_ROLE.investigate === 'reviewer'`, and `src/model/role.ts`, `src/adapter/roleProfile.ts`, the config `roles` mapping and `defaultConfig` are untouched (no new role, no config migration).
- Every pre-existing stage's schema object, `persistencePathForStage` result, `stageArtifactIsNumbered` result, `STAGE_ROLE` entry and Markdown renderer output is unchanged, pinned by the `existing stages unchanged` describe in `test/mode.test.ts`.
- `test/mode.test.ts` exists and runs under plain `mocha` with no `vscode` import.
