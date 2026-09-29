# Plan T05

## Steps

1. Add Default first to MODE_OPTIONS in media/chat.js

   In media/chat.js (lines ~77-86) insert `{ id: 'default', label: 'Default' },` as the FIRST entry of `MODE_OPTIONS`, before `{ id: 'spec', label: 'Spec' }`. Final order: default, spec, bug, quick, refactor, investigate. Update the sync comment above it to: `// Mirrors RUN_MODES in src/model/mode.ts, in the same order (default first, then spec). This is a plain browser script and cannot import it, so the list and its labels are kept in sync by hand.` Drop the old trailing clause 'exactly as protocol.js keeps DEFAULT_MODE' (protocol.js no longer mirrors DEFAULT_MODE's value; see step 3). Do NOT touch `renderMode()` (lines ~1214-1240): its pinned value stays the literal 'spec' and its unknown-mode fallback `modeSelect.value = 'spec'` stays Spec. Optionally extend the fallback comment to say 'fall back to Spec (not DEFAULT_MODE)'; no behavioural change.

   Files: `media/chat.js`

2. Name the six modes in the chat.html header comment

   In the top-of-file comment of media/chat.html (lines ~22-26, the sentence describing the host-authoritative Mode select), add that the select lists six conversation modes in RUN_MODES order: Default, Spec, Bug, Quick, Refactor, Investigate (Default first; a Workspace conversation starts in Default). E.g. change '... a host-authoritative Mode select that reflects `state.mode`, posts `setMode`,' to '... a host-authoritative Mode select over the six conversation modes (Default, Spec, Bug, Quick, Refactor, Investigate) that reflects `state.mode`, posts `setMode`,'. Comment-only; no markup/CSS change.

   Files: `media/chat.html`

3. Make the TS reducer seed the literal 'spec'

   In src/orchestrator/webviewProtocol.ts: change `initialWebviewState()` (line ~357) from `mode: DEFAULT_MODE,` to `mode: 'spec',` with a short comment above it, e.g. `// Deliberately the literal 'spec', not DEFAULT_MODE: the seed is only a placeholder until the host echoes setMode, and media/protocol.js mirrors this literal by hand.` Change line 16 `import { DEFAULT_MODE, type RunMode } from '../model/mode';` to `import type { RunMode } from '../model/mode';` since DEFAULT_MODE is no longer used in this file (grep confirms only lines 16 and 357 reference it). The `mode` field doc comment (line ~323, "`'spec'` unless the host says otherwise") is already correct; leave it.

   Files: `src/orchestrator/webviewProtocol.ts`

4. Update the protocol.js seed comment (value stays 'spec')

   In media/protocol.js `initialWebviewState()` (lines ~25-27) keep `mode: 'spec',` unchanged. Replace the comment 'Mirrors DEFAULT_MODE in src/model/mode.ts; ...' with one mirroring the TS side: `// Mirrors initialWebviewState() in src/orchestrator/webviewProtocol.ts: the literal 'spec', deliberately not DEFAULT_MODE (now 'default'); the host's setMode echo supplies the real mode. This is a plain browser script and cannot import it, so the literal is kept in sync by hand.`

   Files: `media/protocol.js`

5. Update test/chatView.mode.test.ts pins and add Default coverage

   (a) 'seed paint' test (line ~378): rename to 'seed paint: the six modes in RUN_MODES order, Spec selected, enabled'; expected values become ['default','spec','bug','quick','refactor','investigate'] and labels ['Default','Spec','Bug','Quick','Refactor','Investigate']. Keep `modes.value === 'spec'` (seed is still 'spec'). (b) Line ~404 `modes.options.length, 5` -> 6. (c) Line ~491 `modes.options.length, 5` -> 6; the unknown-mode test still expects value 'spec'. (d) Add a test: 'the host echo selects Default, and picking Default posts setMode default': send `{type:'setMode', mode:'default'}` -> `modes.value === 'default'`, enabled, nothing posted; then in a fresh view, set `modes.selectedIndex` to the index of 'default', fire 'change', assert posted deep-equals `[{ type: 'setMode', mode: 'default' }]` and the control snapped back to 'spec'. (e) Add a test: 'a spec conversation pins to Spec even when the host mode is Default': send setMode default, setConversations [workspace, my-spec], setActive my-spec -> value 'spec', disabled true; setActive workspace -> value 'default', disabled false. Optionally update the file doc comment to mention default-mode. Leave the harness (FakeEl etc.) untouched.

   Files: `test/chatView.mode.test.ts`

6. Update test/webviewProtocol.reducer.test.ts seed pin

   In describe('conversation mode and run activity') the test at line ~888 currently asserts `initialWebviewState().mode === DEFAULT_MODE` and `=== 'spec'`, which now conflict. Rename it to 'a fresh state starts in Spec (not DEFAULT_MODE) with no run in flight' and make the body: `assert.strictEqual(initialWebviewState().mode, 'spec'); assert.notStrictEqual(initialWebviewState().mode, DEFAULT_MODE, 'the seed is deliberately decoupled from DEFAULT_MODE'); assert.strictEqual(initialWebviewState().runActive, false);`. This keeps the DEFAULT_MODE import (line 23) used. 'setMode sets every mode' iterates RUN_MODES and so already covers 'default'; add one explicit assertion case if desired: `reduce(initialWebviewState(), { type: 'setMode', mode: 'default' }).mode === 'default'`. No other tests in this file change.

   Files: `test/webviewProtocol.reducer.test.ts`

7. Mirror parity fixtures

   test/fixtures/protocolCases.ts: keep `seed()`'s `mode: 'spec'` (it is a literal chosen to catch seed drift and must equal initialWebviewState()). The (52) loop over RUN_MODES automatically adds a 'setMode sets the mode to default' case. Add one explicit case after (53): `cases.push({ name: 'setMode moves Default to a concrete mode', state: seed({ mode: 'default' }), messages: [{ type: 'setMode', mode: 'bug' }] });` so a Default-carrying state is folded by both reducers. test/webviewProtocol.mirror.test.ts needs no code change: its 'mirrors the initial seed state exactly' test passes once both seeds are 'spec' (it currently fails because TS seed = DEFAULT_MODE = 'default'). Only touch it if a comment there references DEFAULT_MODE (none found).

   Files: `test/fixtures/protocolCases.ts`, `test/webviewProtocol.mirror.test.ts`

8. Verify

   Run `npx tsc -p ./ --noEmit` (the only pre-existing error allowed is the systemPrompt.ts RUN_FLOW_TEXT TS2741 left for another todo; no new errors, in particular no unused-import error in webviewProtocol.ts). Run `TS_NODE_TRANSPILE_ONLY=true npx mocha` and confirm every test in test/chatView.mode.test.ts, test/webviewProtocol.reducer.test.ts and test/webviewProtocol.mirror.test.ts passes (remaining failures, if any, must be confined to chatController/systemPrompt tests owned by other todos). Also confirm test/chatView.providers.test.ts and test/modelSelectorRefresh.test.ts still pass.

   Files: (none)

## Risks

- Leaving `DEFAULT_MODE` imported but unused in webviewProtocol.ts would trip noUnusedLocals / eslint; switch to `import type { RunMode }`.
- If any other src code relies on initialWebviewState().mode === DEFAULT_MODE (e.g. chatController comparing against it), changing the seed to 'spec' could shift behaviour; grep showed no such reliance in webviewProtocol.ts, but the executor should grep src for initialWebviewState usages.
- The chatView harness FakeEl select must leave `value` empty for an unmatched option for the unknown-mode fallback test; this already works today and is unaffected.
- Other test files (chatController, systemPrompt) fail under the new DEFAULT_MODE and belong to other todos; do not fix them here, but do not misattribute their failures to this change.
- Putting 'default' anywhere but first in MODE_OPTIONS breaks the RUN_MODES order parity the seed-paint test pins.

## Acceptance

- media/chat.js MODE_OPTIONS is exactly [default/Default, spec/Spec, bug/Bug, quick/Quick, refactor/Refactor, investigate/Investigate] with the sync comment saying default first.
- renderMode still pins spec conversations to 'spec' and falls back to 'spec' for an unknown mode.
- media/chat.html header comment names the six modes, Default first.
- media/protocol.js initialWebviewState().mode is 'spec' and its comment says it mirrors the TS seed literal, not DEFAULT_MODE.
- src/orchestrator/webviewProtocol.ts initialWebviewState().mode is the literal 'spec' and DEFAULT_MODE is no longer imported there.
- test/chatView.mode.test.ts pins six options/labels, option count 6, and has passing tests for selecting/posting Default and spec-pinning over Default.
- test/webviewProtocol.reducer.test.ts asserts the seed is 'spec' and differs from DEFAULT_MODE; setMode covers 'default'.
- Mirror parity suite (including the new Default fixture case and the 'setMode sets the mode to default' loop case) passes.
- `npx tsc -p ./ --noEmit` introduces no new errors; the three named test files pass under `TS_NODE_TRANSPILE_ONLY=true npx mocha`.
