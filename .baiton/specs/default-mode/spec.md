---
version: 1
name: default-mode
status: draft
mode: manual
base:
base_commit:
branch:
approved_rev:
---

# OVERVIEW

Add a sixth conversation mode, `default`, that a Workspace conversation starts in. Its flow is recommend-and-confirm: the orchestrator inspects the ask with the read tools, states it in one line with the guessed files, recommends exactly one concrete mode with a one-line why, raises ONE `ask_user` card whose options are the five concrete modes (recommendation first, free text allowed), and then dispatches the picked mode with the tools that already exist: `start_run(mode: bug|quick|refactor)` or `investigate`. Picking Spec dispatches nothing and tells the user to change the Mode control to Spec and re-send; a decline or typed answer dispatches nothing. Default never dispatches without the pick, and the picked mode's own confirm card still governs the dispatch.

`default` is never itself a run. `'default'` joins `RunMode`/`RUN_MODES` (listed first), `isSpecless('default')` is true so `phaseFor`/`buildSystemPrompt` map it to the `run` phase beside bug/quick/refactor/investigate, and `DEFAULT_MODE` becomes `'default'`. `runPipeline.start` and `runStore.create` refuse `mode: 'default'` exactly as they refuse `'spec'` (invalid-mode refusal naming `draft_spec`); `parseRunManifest` rejects `default` as a manifest `mode` but accepts it as `composerMode`. `RUN_TOOL_MODES`, the `start_run` schema enum, the `investigate` tool, `serializeRunManifest`, `isRunId`, `runBranchFor`, the Runs view and the worktree layout are untouched, so a dispatch from Default carries the picked mode in its run id prefix and branch while the manifest records `composerMode: 'default'` and `explicitMode: true` under the unchanged engineFacade derivation (`req.mode !== composerMode`).

Spec-mode behaviour stays byte-identical. The one place that must not follow the new default is a spec conversation's effective mode: `ChatController.effectiveMode()`/`postMode()` pin spec conversations to the literal `'spec'` instead of `DEFAULT_MODE`, while seeding (chatController) and the `composerMode()` reader in commands.ts fall back to `DEFAULT_MODE`. Webview fallbacks that catch an unknown mode keep falling back to Spec: `renderMode` in media/chat.js, and the reducer seed in media/protocol.js keeps `mode: 'spec'` with `initialWebviewState()` in src/orchestrator/webviewProtocol.ts made the literal `'spec'` too so the mirror parity holds. media/chat.js `MODE_OPTIONS` gains `{ id: 'default', label: 'Default' }` first, chat.html's header comment names six modes, and the README's "Conversation modes" section gains the sixth id, the start-in-Default rule and the recommend-and-confirm flow.

Every fixture that pins the widened mode lists is updated; Spec-only tests stay unmodified except where a widened list forces a pin update; new prompt, controller and webview tests cover the Default beats.

# TODOS

- [pending] T01 Add 'default' to RunMode/RUN_MODES (listed first), make DEFAULT_MODE 'default', keep isSpecless('default') true, and update test/mode.test.ts pins (files: src/model/mode.ts, src/model/index.ts, test/mode.test.ts)
- [pending] T02 Refuse mode 'default' in runPipeline.start and runStore.create (invalid-mode refusal naming draft_spec), reject it as a manifest mode but accept it as composerMode in parseRunManifest, and test run.json validity with composerMode 'default' / explicitMode true (after T01; files: src/engine/runPipeline.ts, src/engine/runStore.ts, src/orchestrator/controlTools.ts, test/runPipeline.test.ts, test/runStore.test.ts)
- [pending] T03 Add RUN_FLOW_TEXT['default'] with the recommend-and-confirm beats (inspect, state, recommend one mode, one ask_user card with the five concrete modes, dispatch the pick via start_run/investigate, Spec pick and decline dispatch nothing, Mode control stays as-is) and cover it in test/systemPrompt.mode.test.ts (after T01; files: src/orchestrator/systemPrompt.ts, test/systemPrompt.mode.test.ts)
- [pending] T04 Split the ChatController fallback: seed from DEFAULT_MODE, pin effectiveMode()/postMode() on a spec conversation to the literal 'spec', update the commands.ts composerMode() reader comment, and extend test/chatController.mode.test.ts (fresh workspace opens in Default, stored concrete mode wins, Default maps to the run phase/tools/prompt, spec conversation stays pinned to Spec) (after T01, T03; files: src/activation/chatController.ts, src/activation/commands.ts, src/activation/engineFacade.ts, test/chatController.mode.test.ts)
- [pending] T05 Widen the webview surfaces: MODE_OPTIONS gains { id: 'default', label: 'Default' } first with the sync comment updated, chat.html header names six modes, protocol.js and webviewProtocol.ts keep the reducer seed as the literal 'spec' (comment mirrors DEFAULT_MODE), renderMode's unknown-mode fallback stays Spec; update test/chatView.mode.test.ts, test/webviewProtocol.reducer.test.ts and the mirror parity fixtures (after T01; files: media/chat.js, media/chat.html, media/protocol.js, src/orchestrator/webviewProtocol.ts, test/chatView.mode.test.ts, test/webviewProtocol.reducer.test.ts, test/webviewProtocol.mirror.test.ts, test/fixtures/protocolCases.ts)
- [pending] T06 Update README "Conversation modes": sixth id `default`, the start-in-Default rule, the recommend-and-confirm flow in one short paragraph, and the unchanged concrete-mode labels (after T03, T05; files: README.md)
