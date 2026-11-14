# Plan P02

## Steps

1. Delete OPENCODE_MODEL_DOC_URL from the opencode adapter

   In src/adapter/opencode.ts remove the two lines at ~203-204: the doc comment `/** Documentation URL for opencode model selection rendered inline in the config panel. */` and `export const OPENCODE_MODEL_DOC_URL = 'https://opencode.ai/docs/go/';`. Leave the comments at ~929 and ~974 that say discovery stamps NO `modelLink` (still true). Do not touch anything else in the file.

   Files: `src/adapter/opencode.ts`

2. Drop modelLink from the builtin opencode capability

   In src/adapter/index.ts: change the import on line 24 to `import { OpencodeAdapter, OPENCODE_MODELS, OPENCODE_EFFORTS } from './opencode';`. In `builtinAgentCapabilities()` the opencode entry becomes `opencode: { models: [...OPENCODE_MODELS], efforts: [...OPENCODE_EFFORTS] },` (no modelLink key at all, so it is not an own key). KEEP the generic seam in `overlayCapabilities`: the `modelLink?: string` field of the `empty` object, the `if (builtin.modelLink !== undefined) { empty.modelLink = builtin.modelLink; }` copy, and `modelLink: builtin.modelLink` passed to `capabilitiesFromEntries` (capabilitiesFromEntries only sets it when defined — verify in src/adapter/adapter.ts:147). Update the overlayCapabilities doc comment (~lines 270-285): the sentence about 'an opencode snapshot with no models, whose free-text shape (`models: []`, `efforts: []`, `modelLink`) survives' becomes '... whose free-text shape (`models: []`, `efforts: []`) survives'; keep the generic wording 'models/efforts/modelLink stay' and '`modelLink` kept from the builtin when set' (it describes the seam, which no builtin currently fills). Do NOT modify src/adapter/adapter.ts, src/config/configPanel.ts or media/config.js.

   Files: `src/adapter/index.ts`

3. Fix the stale comment in providers.ts

   src/orchestrator/providers.ts ~line 146 comment says 'documented at https://opencode.ai/docs/go — the same page OPENCODE_MODEL_DOC_URL in src/adapter/opencode.ts points the CLI adapter at'. Since the symbol no longer exists, reword to just 'documented at https://opencode.ai/docs/go' (drop the OPENCODE_MODEL_DOC_URL clause). Comment-only change; the `modelLink` seam and all provider data (including `doc` URLs) stay unchanged. This keeps `grep -rn OPENCODE_MODEL_DOC_URL src test` empty.

   Files: `src/orchestrator/providers.ts`

4. Update test/adapter.index.test.ts

   Remove `import { OPENCODE_MODEL_DOC_URL } from '../src/adapter/opencode';` (line 12). Update the describe doc comment bullet (line ~50) to 'exposes the free-text shape (empty models, empty efforts) for opencode; no agent carries a modelLink'. In the closed-agents test the per-agent `assert.strictEqual(entry.modelLink, undefined, ...)` stays. Rewrite the test at ~89 'opencode exposes empty models and efforts and a non-empty modelLink' to 'opencode exposes empty models and efforts and no modelLink': keep the two deepStrictEqual asserts and replace the modelLink assert with `assert.strictEqual(Object.prototype.hasOwnProperty.call(entry, 'modelLink'), false, 'opencode must not carry a documentation link')`. Add a new test 'no builtin agent carries a modelLink' looping over `Object.entries(agentCapabilities())` (and `builtinAgentCapabilities()`) asserting `modelLink` is not an own key for every agent. Rewrite the test at ~281 'opencode keeps its doc link; an empty refreshed list keeps the free-text shape' to 'opencode carries no doc link; an empty refreshed list keeps the free-text shape': replace both `assert.strictEqual(x.modelLink, OPENCODE_MODEL_DOC_URL)` with `assert.strictEqual(Object.prototype.hasOwnProperty.call(x, 'modelLink'), false)` for `listed` and `empty`; keep the other assertions. Add a seam test in the 'capability helpers' describe (or near the overlay tests): `capabilitiesFromEntries([{ id: 'm' }], { modelLink: 'https://example.invalid/models' }).modelLink === 'https://example.invalid/models'` — if an equivalent assertion already exists in 'capabilitiesFromEntries carries options and copies the entries', just confirm it covers modelLink and leave it.

   Files: `test/adapter.index.test.ts`

5. Update test/adapter.opencode.test.ts

   The existing test 'stamps no provenance and no modelLink' (~987) already asserts discoverModels returns no `modelLink`; keep it. Add one small test (e.g. in the same describe or a top-level describe 'opencode capability') asserting the module no longer exports the doc URL: `import * as opencodeModule from '../src/adapter/opencode';` (or reuse the existing import block at line 4) and `assert.strictEqual('OPENCODE_MODEL_DOC_URL' in opencodeModule, false)`, plus `assert.strictEqual(Object.prototype.hasOwnProperty.call(builtinAgentCapabilities().opencode, 'modelLink'), false)` importing `builtinAgentCapabilities` from '../src/adapter'. Make no other changes.

   Files: `test/adapter.opencode.test.ts`

6. Update test/modelSelectorRefresh.test.ts

   At ~1826-1830 in 'model selector refresh: opencode CLI first', replace the assertion that `opencode.modelLink` equals `builtinAgentCapabilities().opencode.modelLink` ('the documentation link is re-attached from the builtin') with `assert.strictEqual(opencode.modelLink, undefined, 'opencode carries no documentation link after a refresh')` (and, if `opencode` here is a form-options object, also assert `hasOwnKey(opencode, 'modelLink') === false` using the file's existing `hasOwnKey` helper). Remove the `builtinAgentCapabilities` import only if it becomes unused (check with grep). Grep the file for any other `modelLink`/`model-link` assertion (e.g. the test ~2886 'the opencode model and effort controls become dropdowns once a list arrives'); if it asserts the link is visible for opencode, flip it to assert the link element is hidden (`style.display === 'none'`) / has no href.

   Files: `test/modelSelectorRefresh.test.ts`

7. Update test/configPanel.view.test.ts: seam still renders, real agents render none

   Keep the seam tests that hand in an explicit `modelLink` (viewOptions' claude `modelLink: 'https://example.invalid/models'`, and the OpenCode dropdown test ~1429 using 'https://opencode.invalid/models') — they prove the webview still renders a Documentation link when a capability supplies one; rename that test's link asserts' messages or add a comment saying the link here is a seam fixture, not a real adapter value. Add a new test in the 'config panel webview options refresh' describe, e.g. 'no builtin agent renders a Documentation link': build options from the real builtins — `const { agentCapabilities } = await import('../src/adapter'); const { configFormOptions } = await import('../src/config/configPanel'); const caps = agentCapabilities(); const options = configFormOptions(Object.keys(caps), caps);` (use dynamic import like line 93 if static import of src modules breaks the vscode stub, otherwise a static import is fine; make the it() async if needed). For each agent id, load the view with `allRoles(agent, <model>, '')` (opencode: 'anthropic/claude-sonnet-5'; others: first entry of caps[agent].models), then assert for every role in VIEW_ROLES: `view.byId('role-' + role + '-model-link').style.display === 'none'` and the link has no href (`getAttribute('href')` null / `href` falsy, whichever the fake DOM supports — check how ViewEl exposes attributes). Also add a seam counterpart if not already explicit: with `capsOptions({ opencode: { models: [], efforts: [], modelLink: 'https://opencode.invalid/models' } }, ['opencode'])` the link is visible and `href === 'https://opencode.invalid/models'`, and a following `optionsChanged` refresh with the same capability minus modelLink hides it (exercises media/config.js 611-617 both branches).

   Files: `test/configPanel.view.test.ts`

8. Verify

   Run `grep -rn OPENCODE_MODEL_DOC_URL src test media README.md` (must be empty). Run the type check / build (`npm run compile` or the repo's tsc script, see package.json) and the test suite, at minimum test/adapter.index.test.ts, test/adapter.opencode.test.ts, test/modelSelectorRefresh.test.ts, test/configPanel.view.test.ts, test/configPanel.test.ts and test/providers.test.ts, then the full `npm test`. Run lint if configured.

   Files: (none)

## Risks

- test/configPanel.test.ts (~line 331) builds expectations conditionally on `CAPABILITIES[agent].modelLink !== undefined`; it should pass unchanged, but if it hard-codes an opencode link elsewhere it must be updated too.
- Removing modelLink from the builtin must not remove the overlay's generic copy path in overlayCapabilities; deleting that would break the 'seam still works' requirement.
- `modelLink` must be absent as an own key, not set to undefined — an `{ modelLink: undefined }` would fail own-key assertions and could leak to the webview message.
- The configPanel.view test that imports real src/adapter modules may pull in modules needing the vscode stub; use the file's existing dynamic-import pattern (line ~93) if a static import fails.
- The providers.ts edit is comment-only and outside the phase file list; keep it to the single comment so no provider data (doc URLs used by test/providers.test.ts) changes.
- Other phases in this plan (role rename) touch the same test files; keep edits localized to modelLink assertions to minimize merge conflicts.

## Acceptance

- `OPENCODE_MODEL_DOC_URL` does not appear anywhere in src/, test/, media/ or README.md, and src/adapter/opencode.ts exports no such symbol.
- `builtinAgentCapabilities()` and `agentCapabilities()` (with and without an opencode snapshot, including an empty one) return no own `modelLink` key for any agent.
- The `modelLink` field remains in src/adapter/adapter.ts (AgentCapabilities and capabilitiesFromEntries options), src/config/configPanel.ts (AgentFormCapability and configFormOptions), the overlayCapabilities copy path in src/adapter/index.ts, and media/config.js rendering — none of these files' modelLink handling is removed.
- A config-panel view test shows that with real builtin capabilities no role row's `#role-<role>-model-link` is visible for any agent, and a seam test shows a capability that supplies `modelLink` renders a visible link with that href.
- test/adapter.index.test.ts, test/adapter.opencode.test.ts, test/modelSelectorRefresh.test.ts and test/configPanel.view.test.ts assert the absence of the opencode link instead of its presence.
- The TypeScript build and the full test suite pass.
