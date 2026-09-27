# Plan T05

## Steps

1. Add the investigate role instruction text and make roleInstructions stage-aware

   In src/engine/roleInstructions.ts:

   1. Add `import type { Stage } from '../model/stage';` beside the existing `import type { Role } from '../model/role';`.
   2. Export a new constant `INVESTIGATE_INSTRUCTION` (placed after `CONTEXT_IS_COMPLETE_INSTRUCTION`, built with the same `[...].join('\n')` style as `SPEC_WRITER_INSTRUCTION`). Its body, in three blocks separated by blank lines:
      - 'You are the investigator. The Context section gives you one question and the files to start from. Study the repository read-only and answer the question from the code as it is. Make no code changes: no edits outside your run directory, no commits, no branches, no stashes.'
      - 'Answer with a finding: what is actually true of the code, why it is true, and the evidence (file and symbol names) that grounds it. Do not propose a fix as though it were the answer; list the follow-up work you would do as next steps.'
      - `CONTEXT_IS_COMPLETE_INSTRUCTION` (reused verbatim, so an investigate run is told not to go hunting through `.baiton/specs`; a spec-less run has no spec to read).
   3. Change the exported lookup to take an optional trailing stage:

   ```ts
   export function roleInstructions(role: Role, stage?: Stage): string {
     // The investigate stage is run by the `reviewer` role but is a different
     // job, so the text is selected by stage, not by role. Every other stage
     // (and every call with no stage) returns exactly what it returned before.
     if (stage === 'investigate') {
       return INVESTIGATE_INSTRUCTION;
     }
     return ROLE_INSTRUCTIONS[role];
   }
   ```

   `ROLE_INSTRUCTIONS` and every existing role's prose stay byte-for-byte unchanged. `roleInstructions` currently has exactly one non-test caller (src/engine/brief.ts), so the added optional parameter breaks nothing. Extend the module doc comment with one sentence naming the investigate case.

   Files: `src/engine/roleInstructions.ts`

2. Pass the stage through in buildBrief

   In src/engine/brief.ts, inside `buildBrief`, change the role section from `roleInstructions(input.role)` to `roleInstructions(input.role, input.stage)`. Nothing else in `buildBrief` or `writeBrief` changes: section order, headings and the schema/stop sections stay identical, and for every non-investigate stage the composed text is byte-identical to today (the existing assertions in test/engine.briefWatcher.test.ts and test/engine.launcher.test.ts must keep passing untouched). Add one sentence to the module doc comment: the Role section carries the stage's instruction text, which for `investigate` is `INVESTIGATE_INSTRUCTION` rather than the reviewer's.

   Files: `src/engine/brief.ts`

3. Create src/engine/runContext.ts: the pure per-mode run Brief context assembler

   New module modelled on src/engine/stageContext.ts (pure: no `fs`, no `vscode`; every artifact is passed in). Open with a doc comment that lists, per stage, exactly which sections are emitted, and states that it never reads or names anything under `.baiton/specs/`.

   Imports (type-only, so nothing is pulled in at runtime):

   ```ts
   import type { RunMode } from '../model/mode';
   import type { RunStage } from './runStore';
   ```

   Exported input type:

   ```ts
   export interface RunContextInput {
     /** The stage whose context is being assembled; selects the sections. */
     stage: RunStage;                 // 'plan' | 'execute' | 'review' | 'investigate'
     /** The run's mode; never 'spec'. Selects the mode framing sections. */
     mode: RunMode;
     /** The one-line statement of the work (for investigate: the question). */
     statement: string;
     /** The files the run starts from, repository-relative. */
     files?: readonly string[];
     /** Bug only: reproduction steps, when the user supplied them. */
     reproduction?: string;
     /** The run's own branch (`baiton/<mode>/<run-id>`); absent for investigate. */
     branch?: string;
     /** Refactor only: the configured `git.verify` command that must stay green. */
     verify?: string;
     /** The run's plan artifact text (`execute`, `review`). */
     plan?: string;
     /** `execute`: the latest review artifact text, included from attempt 2 on. */
     latestReview?: string;
     /** `review`: the latest execution-summary artifact text. */
     latestExecute?: string;
     /** `review`: the commit the execution landed in, when it is known. */
     executeCommit?: string;
     /** `execute`: the 1-based attempt index; attempt >= 2 carries the review. */
     attempt?: number;
     /** `execute`: true when the run resumes a prior executor session. */
     resume?: boolean;
   }
   ```

   Exported entry point, mirroring `buildStageContext`'s switch + `assertNever` shape:

   ```ts
   export function buildRunContext(input: RunContextInput): string {
     switch (input.stage) {
       case 'plan':        return join(planSections(input));
       case 'execute':     return join(executeSections(input));
       case 'review':      return join(reviewSections(input));
       case 'investigate': return join(investigateSections(input));
       default:            return assertNever(input.stage);
     }
   }
   ```

   Private helpers (all pure, all returning `string`):

   - `runSection(input)` — the `# Run` section, a bullet list in a fixed order:
     `- Mode: <mode>`, `- Statement: <statement.trim()>`, `- Target branch: \`<branch>\`` (omitted when `branch` is undefined or blank; for investigate emit `- No branch: this run is read-only and makes no commits.` instead), then either `- Files:` followed by one `  - \`<file>\`` line per entry of `files`, in the given order, or the single line `- Files: none named.` when `files` is undefined or empty.
   - `modeSections(input)` — returns `string[]`, the mode framing emitted for `plan`, `execute` and `review` (never for `investigate`), placed directly after `# Run`:
     - `'bug'` → two sections. `# Defect` with the statement restated as the reported defect plus the sentence 'Find and fix the root cause, not the symptom.' and `# Reproduction` carrying `reproduction.trim()` verbatim, or, when absent/blank, 'No reproduction steps were supplied. Establish how to reproduce the defect from the statement and the files above before changing anything.'
     - `'refactor'` → one `# Behaviour preservation` section: the observable behaviour of the code must not change — no behaviour, API or output differences — and the checks must stay green, naming the command as `Run \`<verify>\` and keep it green.` when `verify` is set and non-blank, or 'No verify command is configured; run the repository\'s own tests and checks and keep them green.' otherwise.
     - `'quick'`, `'investigate'`, `'spec'` → `[]` (Quick's statement and files are already carried by `# Run`; the OVERVIEW asks for nothing more).
     Implement as a `switch (input.mode)` with an `assertNever`-free exhaustive default returning `[]`, so a future mode does not break the build here but also emits nothing.
   - `planSection(input)` — `# Plan` + `input.plan.trim()`, or `'# Plan\n\nNo plan is on file for this run.'` (same fallback shape as stageContext).
   - `planSections` = `[runSection, ...modeSections]`.
   - `executeSections` = `[runSection, ...modeSections, planSection]`, plus, when `(input.attempt ?? 1) >= 2 || input.resume === true` and `latestReview` is non-blank, `` `# Latest review\n\n${input.latestReview.trim()}` `` — copy the retry predicate from `executeSections` in stageContext.ts exactly.
   - `reviewSections` = `[runSection, ...modeSections, planSection]`, then the execution section (`# Execution` + `latestExecute.trim()`, else '# Execution\n\nNo execution summary is on file for this run.'), then the commit section (`` `# Execute commit\n\nThe execution landed in commit \`<commit>\`. Inspect it with \`git show <commit>\`.` `` when `executeCommit` is non-blank, else '# Execute commit\n\nThe execute commit is unknown; fall back to the files named in the execution summary.'), matching the wording used in stageContext.ts so the two stay recognisably the same.
   - `investigateSections(input)` — `[runSection(input), '# Question\n\n' + statement.trim(), filesSection]` where `# Files` lists the same files as backticked bullets or says 'No files were named; start from the question.'. No plan, no execution, no commit, no mode framing.
   - `join(sections)` — `sections.join('\n\n') + '\n'` and `assertNever(value: never): never` — copied from stageContext.ts.

   The module must never emit the words `spec.md` or `.baiton/specs`.

   Files: `src/engine/runContext.ts`

4. Export the new module from the engine barrel

   In src/engine/index.ts add `export * from './runContext';` immediately after the existing `export * from './stageContext';` line, and extend the module doc comment with '…, the per-mode run brief context builder for spec-less runs, …'. Check for name collisions across the barrel before compiling: `buildRunContext`, `RunContextInput` and the `RunStage`-typed `stage` field must not clash with anything already exported (notably `runStore.ts` and `stageContext.ts`); all private helpers in runContext.ts stay unexported, so `planSection`/`join`/`assertNever` cannot collide with stageContext.ts's identically named private helpers.

   Files: `src/engine/index.ts`

5. Write test/runContext.test.ts

   New mocha test file in the repo's existing style (`import * as assert from 'assert';`, no `vscode` import, `describe`/`it`, a doc comment naming what is under test). Import `buildRunContext` from '../src/engine/runContext', and `buildBrief` from '../src/engine/brief' plus `INVESTIGATE_INSTRUCTION`, `roleInstructions` from '../src/engine/roleInstructions'. Use unique marker strings (e.g. `STATEMENT_MARK`, `REPRO_MARK`, `PLAN_MARK`, `REVIEW_MARK`, `EXEC_MARK`) the way test/stageContext.test.ts does, and a small `base()` helper returning a valid `RunContextInput`.

   Cases:
   - `# Run` shape: for a bug plan context, the output carries '# Run', '- Mode: bug', the statement marker, the branch in backticks, and one bullet per file in order; with `files: []` it carries 'none named.' and no stray bullet.
   - Bug: plan, execute and review contexts all carry '# Defect' and '# Reproduction' with the reproduction marker; with `reproduction` omitted the '# Reproduction' heading is still present and carries the 'No reproduction steps were supplied' fallback.
   - Quick: the context carries '# Run', the statement and the files, and carries neither '# Defect' nor '# Reproduction' nor '# Behaviour preservation'.
   - Refactor: '# Behaviour preservation' is present and contains the configured verify command (e.g. 'npm test') in backticks; with `verify` undefined it is present and contains the no-verify-command fallback and no backticked command.
   - Execute: carries '# Plan' and the plan marker; attempt 1 with a `latestReview` omits '# Latest review'; attempt 2 includes it with the review marker; `attempt: 1, resume: true` also includes it; a blank `latestReview` never produces the section.
   - Review: carries '# Plan', '# Execution' with the execute marker and '# Execute commit' with the commit sha and a `git show <sha>` instruction; with no `latestExecute`/`executeCommit` it carries both headings with their fallback sentences.
   - Investigate: carries '# Question' with the statement marker and '# Files' with the file bullets; carries no '# Plan', no '# Execution', no '# Execute commit', no '# Defect', and no 'Target branch' line; it does carry the read-only note.
   - Hygiene: every stage's output ends with exactly one '\n', and no stage's output contains 'spec.md' or '.baiton/specs'.
   - Determinism/purity: calling `buildRunContext` twice with the same input returns identical strings.
   - Brief wiring: `buildBrief({ stage: 'investigate', role: 'reviewer', resultPath: '/tmp/r/result.json' })` contains `INVESTIGATE_INSTRUCTION` and does NOT contain the reviewer prose (assert on a distinctive fragment such as 'You are the reviewer.'), while `buildBrief({ stage: 'review', role: 'reviewer', resultPath })` still contains 'You are the reviewer.' and does not contain `INVESTIGATE_INSTRUCTION`; and `roleInstructions('reviewer')` (no stage) equals `roleInstructions('reviewer', 'review')`.

   Files: `test/runContext.test.ts`

6. Compile, lint and run the suite

   Run `npm run compile`, `npm run lint` and `npm test` from the repository root. All three must be clean; the only pre-existing lint warning permitted is the known "'_legacy' is assigned a value but never used" at src/orchestrator/webviewProtocol.ts:591. The full suite must pass with no existing assertion changed — in particular test/engine.briefWatcher.test.ts, test/engine.launcher.test.ts, test/stageContext.test.ts and test/stageContext.confinement.property.test.ts stay untouched, and the pass count must rise by exactly the number of new cases in test/runContext.test.ts.

   Files: (none)

## Risks

- `roleInstructions` gains an optional second parameter. It currently has one non-test caller (src/engine/brief.ts), but grep for `roleInstructions(` across src/ and test/ before editing: any caller that passes a stage-shaped value positionally today would change behaviour silently.
- Selecting the instruction text by stage rather than by role means any future non-reviewer role running an `investigate` stage would also get INVESTIGATE_INSTRUCTION. That is the intended contract (the stage, not the role, is the job), and it is stated in the code comment.
- `import type { RunStage } from './runStore'` is type-only and erased at compile time, so runContext.ts stays free of runStore's `fs` imports — but a careless later edit that drops `type` would make the pure module pull in `fs`. Keep the `import type` form.
- Exporting runContext through src/engine/index.ts risks a name collision with the existing stageContext and runStore exports; `buildRunContext`/`RunContextInput` are deliberately distinct from `buildStageContext`/`StageContextInput`, and tsc will catch anything missed.
- The `# Execution` / `# Execute commit` fallback wording is copied from stageContext.ts with 'todo' changed to 'run'. If a later todo asserts byte equality between the two builders' commit sections, that one word differs — deliberate, since a run has no todo.
- The statement, reproduction and file names are embedded verbatim. A statement containing Markdown or a fence renders oddly but is never parsed back, matching how stageContext.ts embeds artifacts; no escaping is added.
- The OVERVIEW says Quick 'carries the statement and guessed files', which `# Run` already provides, so Quick emits no extra section. If a later todo expects a distinct Quick heading, that is a one-arm addition to `modeSections`.

## Acceptance

- src/engine/runContext.ts exists, exports `buildRunContext` and `RunContextInput`, and contains no `fs`, `path` or `vscode` import (only type-only imports of `RunMode` and `RunStage`).
- For every mode, `buildRunContext` emits a `# Run` section carrying the mode, the statement, the files (or an explicit 'none named') and — except for investigate — the target branch.
- Bug contexts (plan, execute, review) carry `# Defect` and `# Reproduction`, with a stated fallback when no reproduction was supplied; Refactor contexts carry `# Behaviour preservation` naming the configured `git.verify` command, with a fallback when none is configured; Quick contexts carry neither.
- Execute carries `# Plan` and includes `# Latest review` exactly when `attempt >= 2` or `resume === true` and the review text is non-blank; Review carries `# Plan`, `# Execution` and `# Execute commit` with the stated fallbacks.
- Investigate carries `# Question` and `# Files` and no plan, execution, commit or mode-framing section.
- No output of `buildRunContext` mentions `spec.md` or `.baiton/specs`, and every output ends with a single trailing newline.
- `buildBrief({ stage: 'investigate', role: 'reviewer', ... })` opens with `INVESTIGATE_INSTRUCTION`; `buildBrief` for every other stage produces byte-identical text to before this change, and `roleInstructions(role)` with no stage is unchanged for all six roles.
- src/engine/index.ts re-exports './runContext'.
- test/runContext.test.ts covers each bullet above and passes.
- `npm run compile`, `npm run lint` and `npm test` are clean (only the pre-existing `_legacy` lint warning), with no existing test file or assertion modified.
