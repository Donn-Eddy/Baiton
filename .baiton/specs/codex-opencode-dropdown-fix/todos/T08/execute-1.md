# Execute T08

## Summary

T08 adds end-to-end coverage for every corrected model source and updates the README discovery prose. test/modelSelectorRefresh.test.ts's shared harness gained five mode fields (codex widened to ok|fail|hang|data|paged|malformed, plus claudeCatalog, opencodeCli, agy), fixture readers for claudeModelCatalog.sample.json / opencodeModelsVerbose.sample.txt / agyModels.sample.txt, a recording codex app-server fake (modelListRequests()) and per-source call counters (claudeFeedCalls, opencodeApiCalls) — all with defaults ('missing'/'empty'/'fail' and the byte-identical CODEX_PAYLOAD) that reproduce the previously fixed stubs so no pre-existing case changed. 17 new cases drive the codex result.data and paged replies, the Claude local catalog (including the offline proof: fetcher never called, no models.dev snapshot), the opencode CLI-first path (no /api/model request), the agy families with the curated-table drift alarm, a malformed and a timed-out refresh of every source that never blanks a selector, a configured-but-unlisted value riding along as a custom Other… entry that still saves, and a new leg 6 that replays the controller's real loaded/optionsChanged messages through media/config.js (FakeEl/FakeClassList hoisted to the shared harness and extended with remove/removeChild, a reflected href and a richer matches). test/modelDiscovery.test.ts gained antigravity as the fifth catalog source and the per-model effort persistence round-trip. No src/ or media/ change was needed: every expectation matched production behaviour as recorded.

## Files changed

- `test/modelSelectorRefresh.test.ts`
- `test/modelDiscovery.test.ts`
- `README.md`

## Commands run

- `npx tsc -p ./ --noEmit`
- `npx mocha --grep "model selector refresh"`
- `npx mocha --grep "model selector refresh: (opencode|antigravity)"`
- `npx mocha --grep "model selector refresh: discovery fallback"`
- `npx mocha --grep "model selector refresh: round-trip"`
- `npx mocha --grep "the config view renders"`
- `npx mocha test/modelDiscovery.test.ts --grep "ModelDiscoveryService"`
- `npm run compile`
- `npm run lint`
- `npm test`

## Notes

- Verification: npm run compile clean; npm run lint 0 errors with only the expected pre-existing warning src/orchestrator/webviewProtocol.ts:626 '_legacy' is assigned a value but never used; npm test exits 0 on its own with 2203 passing, 1 pending (pending count unchanged), 0 failing. Baseline before T08 was 2184 passing, so the 19 new cases are all accounted for and no leaked timer keeps mocha alive.
- Hermeticity confirmed: test/modelSelectorRefresh.test.ts constructs each adapter exactly once, all inside buildRegistry, and every construction injects its transport seam (ClaudeAdapter readLocalCatalog + fetchFeed, CodexAdapter spawnAppServer, OpencodeAdapter serverBaseUrl + fetchModels + runModelsCli, AntigravityAdapter runModelsCli). No new process spawn, no loopback request and no read outside test/fixtures (plus the repo's own media/*.js, which the view legs execute in a vm).
- Plan deviation (step 6/step 8 mechanics, no scope change): the never-blanked cases record each source's modelEntries from the PANEL's last optionsChanged rather than from agentCapabilities(), because configFormOptions/formModelEntry strips `provider` on the way to the webview — comparing the host-side capability entries against the panel's would have compared two deliberately different shapes. The panel-side recording is what the acceptance actually asks about.
- Plan deviation (step 8.1): media/config.js never calls node.remove() — it detaches options via selectEl.removeChild and clears classes via classList.remove. Both remove() and removeChild() were added to FakeEl anyway, and the reflected `href` accessor was added because config.js sets link.href and then clears it with removeAttribute('href'), which a plain field would not honour.
- Two shared helpers moved rather than duplicated: FakeClassList/FakeEl were hoisted out of the provider-first describe to the outer suite scope (leg 4 uses them unchanged), and writeRoles() was hoisted out of the round-trip describe so leg 6 can build its role fixtures. Leg 4 and leg 5 were re-run and still pass.
- The antigravity drift alarm is deliberate and documented in the test: assert.deepStrictEqual(discovered.models, builtinAgentCapabilities().antigravity.models) will fail the next time ANTIGRAVITY_MODELS is refreshed by hand without refreshing test/fixtures/agyModels.sample.txt. Refresh both together.
- Recorded behaviours the new tests pin rather than fix (both stated in the plan's risks): a hung/timed-out Claude local-catalog read is treated as 'no catalog' and falls THROUGH to the models.dev feed, so the timeout case drives claude's failure through the hanging feed legs; and optionalStringArray drops an empty array, so an explicit `efforts: []` marker does not survive the memento round-trip — the rehydrated entry carries no efforts key and the webview falls back to the agent-level union for it.
- No production defect was found: every host-side and view-side expectation in the plan matched src/ and media/ as they stand, so nothing under src/ or media/ was touched.
- README: the Managed fields bullet now describes the live-backed model dropdown for all four agents and the per-model effort dropdown with (default: <effort>) / (default) / free-text rules plus agent-level-union validation; a new bullet describes the editable Other… rendering and its stickiness; the 'How a refresh behaves' bullet documents the live panel wiring (store and service built before registerConfigPanel, first loaded already cached, later refreshes as in-place option updates); and the 'What survives' bullet documents the never-blank/never-rewrite guarantee. The per-source Sources bullets were left untouched as instructed.
