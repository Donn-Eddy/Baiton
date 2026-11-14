# Plan P01

## Steps

1. Rename the Role union and ROLES

   In src/model/role.ts change the `Role` union to `'phased-planner' | 'step-planner' | 'step-reviewer' | 'executor' | 'reviewer' | 'pr-writer'` and `ROLES` to that exact order. Rewrite the doc comment so it names the roles: `phased-planner` drafts the whole phased plan (plan-draft stage, `draft_plan` tool), `step-planner` writes one phase's plan (plan stage), `step-reviewer` reviews that phase plan (plan-review sub-stage). `isRole` stays as it is. After this edit run `npx tsc -p ./ --noEmit`. Every compile error it reports is a place that still uses an old role literal, and steps below fix each one.

   Files: `src/model/role.ts`

2. Add a pure legacy role-key table and resolver shared by loader and Config Panel

   Create src/config/roleKeys.ts with no Node or vscode imports, because src/config/configPanel.ts must stay free of Node built-ins. Export these three things, each with a doc comment:
   (1) `LEGACY_ROLE_KEYS: Readonly<Partial<Record<Role, readonly string[]>>> = { 'phased-planner': ['plan-writer', 'spec-writer'], 'step-planner': ['planner'], 'step-reviewer': ['plan-reviewer'] }`. The order inside each array is the precedence.
   (2) `ROLE_FALLBACKS: Readonly<Partial<Record<Role, Role>>> = { 'phased-planner': 'step-planner' }`.
   (3) `resolveRoleEntry(role: Role, roles: Record<string, unknown>): unknown`, which returns the first value that is not `undefined` from: `roles[role]`, then each `roles[legacyKey]` in order, then, when `ROLE_FALLBACKS[role]` exists, `resolveRoleEntry(fallback, roles)`. The recursion matters: a legacy-only config with `planner` and no drafting key gives `phased-planner` the `planner` entry. Keep the `??` semantics the loader has today, so only `undefined` (an absent key) falls through.
   Also export `legacyKeysFor(role: Role): readonly string[]`, which returns `LEGACY_ROLE_KEYS[role] ?? []`, and `ALL_LEGACY_ROLE_KEYS: readonly string[]`, the flattened set. Import `Role` from '../model'.

   Files: `src/config/roleKeys.ts`

3. Use the resolver in loadConfig

   In src/config/loadConfig.ts delete the local `ROLE_FALLBACKS`, `LEGACY_ROLE_KEYS`, `fallbackRoleEntry` and `legacyRoleEntry`, and import `resolveRoleEntry` from './roleKeys'. In `readRoles` replace the `roles[role] ?? legacyRoleEntry(...) ?? fallbackRoleEntry(...)` expression with `resolveRoleEntry(role, roles)`. Missing-section errors keep using `role`, so they name the new role (for example `roles.step-planner.agent`). Update the `readRoles` doc comment to describe the order: new key, then legacy keys in order, then the fallback. The output object is keyed only by `ROLES`, so legacy keys never appear in `config.roles`.
   Merge caveat: `mergeConfigLayers` stays unchanged. A local overlay that uses a legacy key while the baseline uses the new key is resolved by new-key-wins, and the spec allows that. Mention it in the doc comment.

   Files: `src/config/loadConfig.ts`

4. Default config writes new names only

   In src/config/defaultConfig.ts set `roleList` to `['phased-planner', 'step-planner', 'step-reviewer', 'executor', 'reviewer', 'pr-writer']`. Using `ROLES` directly instead is fine, since the order is identical. `defaultConfigJson()` must then contain none of `spec-writer`, `plan-writer`, `"planner"` or `plan-reviewer`.

   Files: `src/config/defaultConfig.ts`

5. Config Panel: read legacy keys into the form, write new keys, drop superseded legacy keys

   In src/config/configPanel.ts import `resolveRoleEntry` and `legacyKeysFor` from './roleKeys'. This module has no Node import, so the import is safe.
   (a) In `formFromDocument` replace `rawRoles[role]` with `resolveRoleEntry(role, rawRoles)` (still guarded by `isObject`). The configPanelController uses `formFromDocument` on the normal load path, so without this change this repo's legacy-shaped config would show blank rows.
   (b) In `applyFormToDocument`, inside the `for (const role of ROLES)` loop, take `existingEntry` from `resolveRoleEntry(role, existingRoles)` when it is an object, so unmanaged keys inside a legacy entry carry over. Write `roles[role] = entry`, then `for (const legacy of legacyKeysFor(role)) delete roles[legacy];`. Because ROLES holds no legacy names, this drops exactly `spec-writer`, `plan-writer`, `planner` and `plan-reviewer`, and other unknown role keys survive. Update the doc comment of `applyFormToDocument` to say so. Change the example in the `ConfigFormError.path` comment from `roles.planner.agent` to `roles.step-planner.agent`.

   Files: `src/config/configPanel.ts`

6. Role profiles and permissions

   In src/adapter/roleProfile.ts replace the three profile entries:
   - `'phased-planner': { role: 'phased-planner', agentName: 'baiton-phased-planner', description: 'Baiton phased-planner (read-only, writes only its run result)', shell: false, write: 'run-dir', systemPrompt: prompt(readOnlyFragment('phased planner')) }`
   - `'step-planner': { role: 'step-planner', agentName: 'baiton-step-planner', description: 'Baiton step-planner (read-only, writes only its run result)', ..., systemPrompt: prompt(readOnlyFragment('step planner')) }`
   - `'step-reviewer': { role: 'step-reviewer', agentName: 'baiton-step-reviewer', description: 'Baiton step-reviewer (read-only, writes only its run result)', ..., systemPrompt: prompt(readOnlyFragment('step reviewer')) }`
   Put them in ROLES order. Check the rest of the file for comments that list role names and update them.
   In src/adapter/permissions.ts update the comment at line ~33 and the one at ~99 to `phased-planner, step-planner, step-reviewer, pr-writer`. Update the comment at src/adapter/antigravity.ts ~555 the same way. Change src/adapter/opencode.ts ~89 'the planner' to 'the step-planner'. Run `grep -rn "planner\|plan-writer\|plan-reviewer" src/adapter` and update any other comment that lists roles.

   Files: `src/adapter/roleProfile.ts`, `src/adapter/permissions.ts`, `src/adapter/antigravity.ts`, `src/adapter/opencode.ts`

7. Stage→role maps and fallback role

   In src/activation/engineFacade.ts set `STAGE_ROLE` to `'plan-draft': 'phased-planner', plan: 'step-planner', 'plan-review': 'step-reviewer'`. Change the control-action dispatch literal `role: 'planner'` (~line 123) to `role: 'step-planner'`. Update the comment that says 'maps to the plan-reviewer role' so it names step-reviewer.
   In src/engine/runPipeline.ts (~line 72) change `plan: 'planner'` to `plan: 'step-planner'`. If that map has a plan-review entry, set it to `'step-reviewer'`.
   In src/activation/commands.ts change `AUTO_MODE_FALLBACK_ROLE: Role = 'step-planner'`.

   Files: `src/activation/engineFacade.ts`, `src/engine/runPipeline.ts`, `src/activation/commands.ts`

8. Role instructions and plan-draft runner

   In src/engine/roleInstructions.ts rename the `ROLE_INSTRUCTIONS` keys: `'plan-writer'` becomes `'phased-planner'`, `planner` becomes `'step-planner'`, and `'plan-reviewer'` becomes `'step-reviewer'`. Change the opening sentences 'You are the planner.' to 'You are the step planner.' and 'You are the plan reviewer.' to 'You are the step reviewer.'. If PLAN_WRITER_INSTRUCTION opens with 'You are the plan writer', make it 'You are the phased planner'. The exported constant names (`PLAN_WRITER_INSTRUCTION`, `PLAN_WRITER_REPO_INSTRUCTION`, `PLANNER_REPO_INSTRUCTION`) stay so imports don't churn, but update their doc comments to name the new roles. Leave every other instruction text byte-identical, because test/roleInstructions.repo.test.ts snapshots executor, reviewer and investigate.
   In src/engine/planDraft.ts: `PLAN_WRITER_ROLE: Role = 'phased-planner'`. Update the header doc comment ('launches the `phased-planner` role') and the line ~182 comment. Change the error message to `'role "phased-planner" is configured with an unsupported agent; update "roles.phased-planner.agent" in .baiton/config.json'`. You may also rename the constant to `PHASED_PLANNER_ROLE`.

   Files: `src/engine/roleInstructions.ts`, `src/engine/planDraft.ts`

9. Orchestrator and schema text

   In src/orchestrator/systemPrompt.ts (~346–356) replace 'plan-writer' with 'phased-planner': 'the phased-planner harness', 'watch it in the phased-planner terminal', '`draft_plan` hands the agreed restatement to the phased-planner agent'.
   In src/orchestrator/controlTools.ts update the header comment (~20), the `draft_plan` doc comment (~194), the tool description (~205, 'Hand an agreed request to the phased-planner agent for a new slug…') and `draftConfirmation` (~317, 'The configured phased-planner agent will study…'). Check every reply or result string in the draft_plan handler for 'plan-writer' or 'plan writer' and replace it.
   In src/orchestrator/planWriteTools.ts (~11) change the comment to 'phased-planner harness'.
   In src/orchestrator/autoMode.ts (~946) change the comment example to (`step-reviewer` → `Step reviewer`).
   In src/schema/types.ts change the comments: line 48 'The step-planner's structured output (Plan stage).', line 61 'A finding raised by the step-reviewer.', line 70 'The step-reviewer's structured output (Plan_Review stage).'.
   Finish with `grep -rn "plan-writer\|plan-reviewer\|'planner'\|plan writer\|plan reviewer" src`. Nothing should remain except the legacy table in src/config/roleKeys.ts and doc comments that describe legacy keys.

   Files: `src/orchestrator/systemPrompt.ts`, `src/orchestrator/controlTools.ts`, `src/orchestrator/planWriteTools.ts`, `src/orchestrator/autoMode.ts`, `src/schema/types.ts`

10. Webview mirror

   In media/config.js set `var ROLES = ['phased-planner', 'step-planner', 'step-reviewer', 'executor', 'reviewer', 'pr-writer'];`. The roles-table row label is `nameCell.textContent = role`, so the rows then show the new names. No separate label map exists; if there is any other hard-coded role text in the file, update it too. Validation messages mirror the TS ones (`'"' + role + '" is missing an agent.'`), so they stay in sync automatically.

   Files: `media/config.js`

11. README

   Update README.md:
   - ~86: 'hand the agreed requirements to the phased planner'.
   - ~165: 'step planner and the executor'.
   - ~295/302: 'the configured `phased-planner` role produces the phase list' and 'launches the `phased-planner` role'.
   - ~311–312: 'A `phased-planner` entry missing from the configuration is filled in from the `step-planner` entry.'
   - ~577: 'so a step planner'. ~599: change the example 'Planner wants to run…' to 'Step planner wants to run…', matching autoMode's subjectName output.
   - ~615 legacy paragraph: replace it with text listing all four legacy keys and their precedence: `roles.plan-writer` and `roles.spec-writer` are read as `phased-planner` (in that order), `roles.planner` as `step-planner`, and `roles.plan-reviewer` as `step-reviewer`. An explicit new-name key always wins. A config with no drafting entry inherits the step-planner entry. A Config Panel save writes the new names and drops the superseded legacy keys.
   - ~779–780: 'edits the six role entries (`phased-planner`, `step-planner`, `step-reviewer`, `executor`, `reviewer`, `pr-writer`)'.
   Add a short roles list or table near 'Creating a plan' or the config section if none exists: one line per role saying what it does. Then grep README for any remaining 'plan-writer', 'plan-reviewer', '`planner`' or 'baiton-planner' and fix them, except the legacy paragraph.

   Files: `README.md`

12. Update tests in the phase file list

   test/config.test.ts:
   - In the 'loads a default config' test change `roles.planner` to `roles['step-planner']`.
   - Rewrite the 'loadConfig role fallbacks' describe with these cases:
     - a missing `phased-planner` is filled from `step-planner`;
     - a missing `phased-planner` is filled from a legacy `planner` when the config has neither the drafting nor the step-planner new key (delete the `phased-planner` and `step-planner` keys, set `planner`);
     - an explicit `phased-planner` beats the fallback;
     - each legacy key loads under its new name and is absent from `result.value.roles`: `spec-writer`→phased-planner, `plan-writer`→phased-planner, `planner`→step-planner, `plan-reviewer`→step-reviewer;
     - new-key-wins for each pair (`phased-planner` vs `plan-writer` and `spec-writer`, `step-planner` vs `planner`, `step-reviewer` vs `plan-reviewer`);
     - `plan-writer` beats `spec-writer` when both exist without `phased-planner`;
     - the repo's own legacy-shaped config: copy `path.join(__dirname, '..', '.baiton', 'config.json')` into the temp dir (resolve it the way other repo-reading tests do, for example via `process.cwd()`; do not modify the file) and assert that `loadConfig` is ok and that phased-planner/step-planner/step-reviewer equal the file's `plan-writer`/`planner`/`plan-reviewer` entries. Alternatively, inline a literal copy of that JSON's roles block, but loading the real file is preferred;
     - a missing-section error names `roles.step-planner` when no step-planner or planner entry exists;
     - defaults write the new names and none of the four legacy keys (check `defaultConfigJson()` for `"spec-writer"`, `"plan-writer"`, `"planner"` and `"plan-reviewer"`).
   test/configPanel.view.test.ts: change `VIEW_ROLES` to the new order.
   test/fixtures/configFormCases.ts: `roles.planner` becomes `roles['step-planner']`, `roles['plan-writer']` becomes `roles['phased-planner']`, `roles['plan-reviewer']` becomes `roles['step-reviewer']`. Update the names and expectedPaths (for example 'roles.step-planner.agent', 'roles.phased-planner.model', 'roles.step-reviewer.model') and any expected message strings.
   test/adapter.roleProfile.test.ts: change the run-dir role list to `['phased-planner', 'step-planner', 'step-reviewer', 'pr-writer']` and the sorted READ_ONLY_ROLES expectation to `['phased-planner', 'pr-writer', 'step-planner', 'step-reviewer']`. Add an assertion on the agentNames `baiton-phased-planner`, `baiton-step-planner` and `baiton-step-reviewer`.
   test/engine.planDraft.test.ts: the launch tuple `['phased-planner', 'writer-model', 'high']` (check how the config fixture there names the role and rename it), and the error regexes `/phased-planner/` and `/roles\.phased-planner\.agent/`.
   test/mode.test.ts: STAGE_ROLE expectations become 'step-planner', 'phased-planner' and 'step-reviewer'.
   test/roleInstructions.repo.test.ts: `roleInstructions('step-planner')`.
   test/systemPrompt.test.ts: `/harness|phased-planner agent/i`.
   Add a configPanel test, in test/configPanel.test.ts or test/configPanel.document.test.ts. Give `applyFormToDocument` a doc with `spec-writer`, `plan-writer`, `planner` and `plan-reviewer` plus an unknown `custom-role` key. The written roles must contain the six new keys, none of the four legacy keys, and `custom-role` intact. Also test that `formFromDocument` on that legacy doc fills `phased-planner` from `plan-writer` and `step-planner` from `planner`.

   Files: `test/config.test.ts`, `test/configPanel.view.test.ts`, `test/fixtures/configFormCases.ts`, `test/adapter.roleProfile.test.ts`, `test/engine.planDraft.test.ts`, `test/mode.test.ts`, `test/roleInstructions.repo.test.ts`, `test/systemPrompt.test.ts`, `test/configPanel.test.ts`

13. Fix the remaining tests that spell old role literals (needed for tsc and mocha to pass)

   The Role union change breaks type-checking anywhere a test passes `'planner'`, `'plan-writer'` or `'plan-reviewer'` as a Role. Rename the literals mechanically (`'planner'` becomes `'step-planner'`, `'plan-writer'` becomes `'phased-planner'`, `'plan-reviewer'` becomes `'step-reviewer'`, and `baiton-planner` becomes `baiton-step-planner`) in these files:
   - test/adapter.opencode.test.ts: attach role, `--agent baiton-step-planner`, the `agentDefinition(..., 'baiton-step-planner')` key and the expected JSON key;
   - test/adapter.codex.test.ts, test/adapter.claude.test.ts (READ_ONLY_ROLES includes 'phased-planner', role 'phased-planner'), test/adapter.antigravity.test.ts, test/adapter.registry.test.ts, test/adapter.launch.property.test.ts (comments);
   - test/autoMode.evaluator.test.ts: role literals. The hyphenated case at ~287 uses 'step-reviewer', so its expected summary subject becomes 'Step reviewer'. Check any expected 'Planner wants…' strings and change them to 'Step planner wants…';
   - test/autoMode.allowList.test.ts, test/askWatcher.routing.test.ts, test/integration.plan-execute-review.test.ts, test/configPanel.test.ts (~202 expected message `'"step-planner" effort "unsupported" …'`), test/config.overlay.test.ts (~83: rewrite the overlay test to use `step-planner` in both baseline and local overlay, `roles['step-planner']`), test/engine.launcher.test.ts, test/engine.briefWatcher.test.ts (also rename the 'plan-writer brief' describe), test/engine.askRelay.test.ts, test/runQueue.briefContext.test.ts, test/runQueue.revert.property.test.ts, test/runQueue.worktree.test.ts, test/runQueue.approvalGate.property.test.ts, test/runPipeline.test.ts.
   Then run `grep -rnE "'planner'|\"planner\"|plan-writer|plan-reviewer|baiton-planner|roles\.planner" test` and fix every hit, except deliberate legacy-key fixtures in the new config and configPanel tests. Leave tmpdir prefixes like 'baiton-plan-explorer-' alone; they are not role names.

   Files: `test/adapter.opencode.test.ts`, `test/adapter.codex.test.ts`, `test/adapter.claude.test.ts`, `test/adapter.antigravity.test.ts`, `test/adapter.registry.test.ts`, `test/adapter.launch.property.test.ts`, `test/autoMode.evaluator.test.ts`, `test/autoMode.allowList.test.ts`, `test/askWatcher.routing.test.ts`, `test/integration.plan-execute-review.test.ts`, `test/configPanel.test.ts`, `test/config.overlay.test.ts`, `test/engine.launcher.test.ts`, `test/engine.briefWatcher.test.ts`, `test/engine.askRelay.test.ts`, `test/runQueue.briefContext.test.ts`, `test/runQueue.revert.property.test.ts`, `test/runQueue.worktree.test.ts`, `test/runQueue.approvalGate.property.test.ts`, `test/runPipeline.test.ts`

14. Verify

   Run `npm run compile` (tsc -p ./), `npm run lint` and `npm test` (mocha). All must pass. Confirm `git diff --stat -- .baiton/config.json` is empty: this repo's config must not be edited.

   Files: (none)

## Risks

- formFromDocument is the Config Panel's normal load path (configPanelController), not just the invalid-doc path. If it does not use the legacy resolver, this repo's config (spec-writer/plan-writer/planner/plan-reviewer) shows blank rows and a save fails validation.
- The phase's file list names only some tests, but the Role union change breaks tsc in about 20 other test files that pass old literals. The executor must update them or compile and mocha fail.
- configPanel.ts must stay free of Node imports, so the legacy table cannot live in loadConfig.ts (which imports fs). Put it in a pure module (src/config/roleKeys.ts) imported by both.
- Overlay merge: a gitignored config.local.json that overrides a legacy key (e.g. `planner`) over a baseline that uses the new key (`step-planner`) is silently ignored because new-key-wins. This matches the spec's precedence rule but should be documented.
- This repo's .baiton/config.json has both `spec-writer` and `plan-writer` with no `phased-planner`. Precedence must pick `plan-writer` first, then `spec-writer`. The entries currently hold identical values, so add a test with differing values to prove the order.
- Changing role-instruction opening sentences changes brief text. Snapshot tests for executor, reviewer and investigate must stay byte-identical, so touch only the three renamed roles' text.
- autoMode subjectName derives summaries from the role id ('Step planner wants to run …'), so any test or README text that expects 'Planner wants…' changes.

## Acceptance

- `ROLES` in src/model/role.ts is exactly ['phased-planner','step-planner','step-reviewer','executor','reviewer','pr-writer'], and media/config.js `ROLES` matches it in the same order.
- `STAGE_ROLE` maps plan-draft→phased-planner, plan→step-planner, plan-review→step-reviewer. Role profiles use agentNames baiton-phased-planner, baiton-step-planner and baiton-step-reviewer, and their descriptions and prompts name the new roles.
- The plan-draft unsupported-agent error mentions `roles.phased-planner.agent`.
- `defaultConfigJson()` contains the six new role keys and none of `spec-writer`, `plan-writer`, `planner` or `plan-reviewer`.
- loadConfig reads `spec-writer` and `plan-writer` as phased-planner (plan-writer wins over spec-writer), `planner` as step-planner and `plan-reviewer` as step-reviewer. A new-name key always wins. With no drafting key, phased-planner inherits the resolved step-planner entry (including a legacy `planner`). Missing-role errors name the new role. Tests cover each case.
- Loading a copy of this repo's own `.baiton/config.json` succeeds, and the file itself is unchanged in git.
- applyFormToDocument writes the six new keys, removes the four legacy keys and keeps other unknown role keys. formFromDocument fills new-name rows from legacy keys. Tests cover both.
- `grep -rnE "plan-writer|plan-reviewer|'planner'|baiton-planner" src media README.md` returns only the legacy-key table and resolver and the README legacy paragraph.
- `npm run compile`, `npm run lint` and `npm test` all pass.
