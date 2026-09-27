# Execute T02

## Summary

Added the Claude local model-catalog discovery source. src/adapter/claude.ts now corrects the curated tables (CLAUDE_MODELS = ['claude-sonnet-5','claude-opus-5-5','claude-fable-5-1','claude-haiku-4-5-20251001'], CLAUDE_EFFORTS = ['low','medium','high','xhigh','max']), exports the pure/total parser claudeModelsFromCatalog plus CLAUDE_CATALOG_SURFACE, CLAUDE_CATALOG_DIR_SEGMENTS and claudeCatalogDir(), and adds the injectable ClaudeCatalogReader seam (ClaudeAdapterOptions.readLocalCatalog) with a module-level defaultReadLocalCatalog that picks the freshest `cc` catalog under $CLAUDE_CONFIG_DIR/~/.claude/cache/model-catalog. discoverModels now prefers the local catalog (never touching ctx.feed or fetchFeed when it is usable), falls back to the models.dev feed verbatim, and resolves undefined when both legs fail; the shared tail is factored into capabilitiesFor and the catalog leg is timeboxed by a new raceTimeout that unrefs and clears its timer. Fixture, parser tests, precedence tests, index-overlay tests, hermeticity injections and the README discovery section are all in place; compile, lint, test:unit and the full mocha run are green.

## Files changed

- `src/adapter/claude.ts`
- `src/adapter/index.ts`
- `test/fixtures/claudeModelCatalog.sample.json`
- `test/adapter.claude.test.ts`
- `test/adapter.index.test.ts`
- `test/modelSelectorRefresh.test.ts`
- `test/configPanel.test.ts`
- `README.md`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm run test:unit`
- `npm test`

## Notes

- npm test: 2115 passing, 1 pending, 0 failing; mocha exits normally (no leaked timer from raceTimeout). npm run test:unit: 2038 passing, 1 pending, 0 failing. npm run lint reports only the one pre-existing warning in src/orchestrator/webviewProtocol.ts:626 ('_legacy' unused), unrelated to this todo.
- Step 4's abort contract needed one addition beyond the plan's literal text: after the catalog leg the plan only re-checked ctx.signal before RETURNING from the catalog path, which meant a mid-flight abort of a never-settling reader fell through and still called the feed fetcher once. The plan's own test requirement ('the fetcher is not called') and the acceptance bullet ('resolves undefined without invoking ... the fetcher') pin the opposite, so discoverModels now re-checks ctx.signal?.aborted between the two legs and returns undefined there.
- One test outside the plan's file list had to change: test/configPanel.test.ts:199 pinned the validateConfigForm message '(supported: low, medium, high)' for claude effort, which widening CLAUDE_EFFORTS makes false. Updated to '(supported: low, medium, high, xhigh, max)'. This was a consequence of the mandated table change, not a scope addition; the plan required the whole suite green.
- Verified (not assumed) the plan's configFormOptions risk: test/configPanel.test.ts's 'claude-opus-5' case still passes after dropping that id from the curated table — the out-of-set model is re-appended by the merge, so no compatibility shim was added.
- The never-settling-reader-under-ctx.timeoutMs-25 case: the implemented contract is that the timed-out catalog leg is treated as 'no catalog' and discovery falls THROUGH to the feed (resolving the feed's ids), not that it resolves undefined. The test name and an inline comment state this explicitly, as step 7 asked.
- test/adapter.index.test.ts: the plan's suggested assertion that an EMPTY claude snapshot keeps the curated ids is not true of the current overlay — overlayCapabilities runs mergePreservingExisting(snapshot, [CLAUDE_DEFAULT_MODEL]) first, so an empty claude snapshot yields a one-entry ['claude-sonnet-5'] list rather than taking the empty branch. The added case therefore asserts what actually holds: builtinAgentCapabilities().claude and agentCapabilities().claude expose the corrected curated ids and CLAUDE_EFFORTS, and an empty claude snapshot keeps CLAUDE_EFFORTS, source 'builtin' and the required default. The per-model-efforts union case is as specified.
- Hermeticity: every ClaudeAdapter construction in test/adapter.claude.test.ts's discoverModels describe now goes through a local feedOnlyAdapter(mode, fetchFeed) helper injecting readLocalCatalog: async () => undefined; test/modelSelectorRefresh.test.ts:290 got the same injection. Grep confirmed no other suite constructs a real ClaudeAdapter and calls discoverModels (adapter.launch.property.test.ts and engineFacade.resume.test.ts only use launch/attach/probe).
- The parser's shape was verified against the real file on this machine (~/.claude/cache/model-catalog/46b656cb-...-cc.json: version 2, catalog.surface 'cc', 4 main + 6 overflow models, thinking.type 'effort'|'none'), and it projects only id/label/efforts/defaultEffort — description, notice, capabilities, min_claude_code_version, fast_mode and settings_vocabulary are never read.
- launch/attach/probe/claudeSystemPromptFlags/raceAbort and the --model/--effort argv are untouched; no antigravity source, AGENT_CATALOG_SOURCE or CATALOG_SOURCE_IDS change was made. src/adapter/index.ts got only the documented one-sentence JSDoc addition on overlayCapabilities.
