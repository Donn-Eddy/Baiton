# Plan T04

## Steps

1. Pin a spec conversation's effective mode to the literal 'spec' in ChatController

   In src/activation/chatController.ts, `DEFAULT_MODE` (src/model/mode.ts) is now 'default' after T01, so the one place that used it to mean 'Spec' must stop. Change `effectiveMode()` (around line 693) from `return this.activeSpec === undefined ? this.mode : DEFAULT_MODE;` to `return this.activeSpec === undefined ? this.mode : 'spec';`. Update its doc comment to say that a spec conversation is always the literal Spec, deliberately not DEFAULT_MODE, because the Workspace default no longer means Spec. `postMode()` (line ~698) already posts `this.effectiveMode()`, so it needs no code change. Its comment can note that a spec conversation always paints Spec. Leave `onSetMode`, `phaseForConversation` and `buildPrompt` unchanged: they already route the spec branch without a mode, and the Workspace branch through `effectiveMode()`, which now yields 'default' for a fresh workspace. phaseFor/buildSystemPrompt map that to the run phase (done in T03).

   Files: `src/activation/chatController.ts`

2. Keep ChatController seeding on DEFAULT_MODE and fix the seeding comments

   In src/activation/chatController.ts, keep the field initializer `private mode: RunMode = DEFAULT_MODE;` (line ~365) and the constructor line `this.mode = stored !== undefined && isRunMode(stored) ? stored : DEFAULT_MODE;` (line ~417) as they are. They now seed Default, and a stored valid mode (including 'spec' or 'default') still wins. Change the comment above the constructor line (lines ~414-415) from '...silently falls back to Spec rather than poisoning the phase.' to say it falls back to DEFAULT_MODE (the Default mode a fresh Workspace conversation starts in) rather than poisoning the phase. Optionally update the field's doc comment to mention that it starts in Default. Keep the `DEFAULT_MODE` import, which the seed still uses.

   Files: `src/activation/chatController.ts`

3. Update the composerMode() reader comment in commands.ts

   In src/activation/commands.ts, the `composerMode` closure (lines ~373-383) keeps its code unchanged (`stored !== undefined && isRunMode(stored) ? stored : DEFAULT_MODE`). Rewrite only the last sentence of its JSDoc, 'A stale or off-union stored value falls back to Spec, exactly as the controller's own seeding does.', to say it falls back to DEFAULT_MODE (Default), exactly as the controller's own seeding does. Add a note that a spec conversation never reaches this reader's fallback, because spec conversations do not dispatch spec-less runs. Keep the note to one sentence or leave it out. Make no other edits.

   Files: `src/activation/commands.ts`

4. Comment-only touch in engineFacade.createRunPipelineSeam

   In src/activation/engineFacade.ts, leave `createRunPipelineSeam` logic unchanged: `explicitMode: req.mode !== composer`. In the JSDoc (lines ~234-239), extend the example after 'an Investigate dispatched from a Bug conversation, say' to also cover Default. A run dispatched from a Default conversation always records `composerMode: 'default'` with `explicitMode: true`, since Default is never itself a run mode. This edit is optional. If it is made, it must be comment-only.

   Files: `src/activation/engineFacade.ts`

5. Update and extend test/chatController.mode.test.ts

   Edit test/chatController.mode.test.ts. (a) Header comment: change coverage item 2 to 'An absent and an off-union stored value both seed Default, writing nothing.' and item 6 to note the pin is to the literal Spec even though the default is Default. Add lines for the new tests. (b) Rename the test 'falls back to Spec for an absent or off-union stored mode' to 'falls back to Default for an absent or off-union stored mode' and change both `'spec'` expectations to `'default'`. Import `DEFAULT_MODE` from '../src/model/mode' and also assert `DEFAULT_MODE === 'default'`, or compare against it. (c) In 'derives the phase, tool surface and prompt from the mode', change the second half so it uses `buildHarness({ storedMode: 'spec' })` for the gather/Spec case, keeping `phases` deepEqual ['gather'] and prompt `buildSystemPrompt({ kind: 'workspace' })`. Leave the bug half unchanged. (d) Add the test 'a fresh workspace opens in Default': call `buildHarness()` then `started()`, and assert that `webview.all('setMode')[0].mode === 'default'` and that `modeSets` deepEquals []. (e) Add the test 'a stored concrete mode wins over Default': for each of 'spec', 'bug', 'quick', 'refactor' and 'investigate', call `buildHarness({ storedMode: m })` then `started()`, and assert the first setMode is m. Clean up between iterations by calling `cleanup?.()` before each re-build, as the existing multi-harness tests do. (f) Add the test 'Default maps to the run phase, run tools and the Default prompt': call `buildHarness()`, `started()`, send `{ type: 'sendText', text: 'go' }`, and wait for `client.requests.length >= 1`. Assert `phases` deepEquals ['run'] and `client.requests[0][0].content === buildSystemPrompt({ kind: 'workspace' }, undefined, 'default')`. Also assert that it is not equal to `buildSystemPrompt({ kind: 'workspace' })`, which is the Spec prompt. (g) Add the test 'a spec conversation stays pinned to Spec from a Default workspace'. Use `buildHarness()` with no stored mode, write specsDir/alpha/spec.md with '---\nstatus: draft\n---\n# Alpha\n', call `started()`, check that the first setMode is 'default', then call `controller.setActiveSpec('alpha')` and wait for `webview.last('setMode')?.mode === 'spec'`. Send setMode 'bug' and assert the last setMode is still 'spec' and `modeSets` is []. Send sendText 'go' and wait for the completion. Assert `phases` deepEquals ['gather'] and the prompt equals `buildSystemPrompt({ kind: 'spec', slug: 'alpha' }, content)`. Then call `controller.setActiveSpec(undefined)` and wait for `webview.last('setMode')?.mode === 'default'`. Existing tests with storedMode 'bug' or 'quick' stay unchanged. Also check the other existing tests that use a bare `buildHarness()` (promote-card, completion-note, dispose): they should keep passing unchanged, since they do not assert the mode. If one fails only because Default is now the seed, adjust only its pin.

   Files: `test/chatController.mode.test.ts`

6. Verify

   Run `npx tsc -p ./ --noEmit` (must be clean). Run `npx mocha -g 'ChatController conversation mode'` (all pass). Run the full `npx mocha`. The only remaining failures allowed are the webviewProtocol reducer/mirror-parity tests, which later todos own (T03 reported 2 of them). Everything in test/chatController.mode.test.ts must pass. Run `git grep -n "DEFAULT_MODE" src/activation` and confirm it appears only in the chatController seed, the field initializer, its import, and the commands.ts composerMode reader. It must not appear in effectiveMode.

   Files: (none)

## Risks

- Test (e) iterating stored modes inside one `it` must call `cleanup?.()` before each `buildHarness`. Otherwise temp dirs leak, because `afterEach` cleans only the last harness. Each iteration's `controller` should also be disposed, or the prior one left alone. The FakeRuns instance is replaced per harness, so no cross-talk is expected.
- Other tests in the file that call bare `buildHarness()` now run in Default (phase 'run', run tools) instead of Spec. Promote-card, completion-note, busy and dispose tests do not assert the phase or prompt, so they should be unaffected. If any does fail, it is a pin update, not a behaviour change.
- Do not change `buildPrompt` or `phaseForConversation` to pass the mode on the spec branch. Spec conversations must stay byte-identical, so that branch keeps passing no mode.
- Some full-suite failures remain in the webviewProtocol tests (the initialWebviewState/reducer seed parity). They belong to a later todo and must not be 'fixed' here by changing media/ or src/orchestrator/webviewProtocol.ts.
- `isRunMode('default')` is true, so a stored 'default' value persists and round-trips. This is correct, and test (d) and the seed path rely on it.

## Acceptance

- `ChatController.effectiveMode()` returns the literal `'spec'` when `activeSpec !== undefined`, and no longer references DEFAULT_MODE. `postMode()` therefore paints 'spec' on a spec conversation.
- The ChatController field initializer and constructor seeding still use `DEFAULT_MODE`, so a fresh workspace with no stored or an off-union stored mode posts `setMode` 'default' first and writes nothing to modeMemory.
- A stored valid mode (spec, bug, quick, refactor, investigate) wins over Default at seeding.
- A Default Workspace send calls `toolsFor('run')` and uses `buildSystemPrompt({ kind: 'workspace' }, undefined, 'default')` as the system prompt.
- A spec conversation opened from a Default workspace posts 'spec', refuses setMode 'bug' by echoing 'spec' without persisting, keeps the gather/drive phase and the unchanged spec prompt, and repaints 'default' on return to Workspace.
- The commands.ts `composerMode` code is unchanged and its comment says the fallback is DEFAULT_MODE/Default, not Spec. Any engineFacade.ts change is comment-only, and the `explicitMode: req.mode !== composer` derivation is untouched.
- `npx tsc -p ./ --noEmit` is clean, and every test in test/chatController.mode.test.ts passes, including the new Default tests.
- No files outside src/activation/chatController.ts, src/activation/commands.ts, src/activation/engineFacade.ts and test/chatController.mode.test.ts are modified.
