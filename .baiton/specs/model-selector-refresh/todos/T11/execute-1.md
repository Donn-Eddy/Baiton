# Execute T11

## Summary

Made ProviderRouter catalog-driven. Added the host-free ModelCatalogSource seam (snapshot() + feed(), both read at call time) to ProviderRouterConfig and the additive optional fields stale/staleReason/fetchedAt/customModels to ProviderAvailability. Provider enumeration now comes from buildProviderCatalog(feed), extended with every distinct provider of the models.dev snapshot (the offline path, via providerInfo's synthesised source:'custom' fallback) and with the active and preserved selections' providers, so a persisted id that left the feed is never dropped. Per-provider models come from the snapshot when it has any, else the builtin/feed-merged list; copilot (vscode.lm) and openai (key+endpoint+setting) keep their branches verbatim and stay never-stale. Snapshot-backed entries carry fetchedAt and, when the snapshot is stale, stale+staleReason, with the keys absent otherwise. preserveInto() appends the active/preserved/last-chosen model for a provider at the END of its list without reordering catalog ids and reports them as customModels. availability() now returns only CONFIGURED providers (all enabled:true, no reason) and the new hiddenProviders() returns exactly the rest with their reasons; modelsFor() resolves an entry directly so it still works for a hidden id; firstUsableSelection() walks the filtered availability() once; modelFor() resolves its default against the live catalog. init()/refresh() gained the preserve-don't-persist path: a well-formed stored selection whose provider is unconfigured is kept in memory (never written over), routing falls back, and refresh() restores it the moment its provider becomes configured; an active selection displaced by refresh() becomes preserved the same way, while an absent/malformed blob still persists its fallback. select() clears preserved for the provider it names. commands.ts passes the catalog seam (getModelCatalogStore()?.get('models.dev') / getModelDiscovery()?.feed(), per call) and re-runs router.refresh() from discovery.onDidChange, with the subscription pushed onto the returned disposables. The test suite was updated for the availability()/hiddenProviders() split and gained a ten-case 'ProviderRouter catalog' suite.

## Files changed

- `src/activation/providerRouter.ts`
- `src/activation/commands.ts`
- `test/providerRouter.test.ts`

## Commands run

- `npx tsc --noEmit -p tsconfig.json`
- `npm run compile`
- `npx eslint src/activation/providerRouter.ts src/activation/commands.ts test/providerRouter.test.ts --ext .ts`
- `npx mocha test/providerRouter.test.ts`
- `npm run test:unit`
- `git status --porcelain`

## Notes

- All verification passed: tsc --noEmit exits 0, npm run compile exits 0, eslint reports nothing on the three files, and git status --porcelain lists exactly src/activation/providerRouter.ts, src/activation/commands.ts and test/providerRouter.test.ts. npm run test:unit: 1578 passing, 1 pending, 1 failing — only the pre-existing keytar 'includes zero native modules' packaging-gating case in test/activation.gating.test.ts.
- Plan step 6 had an internal inconsistency I resolved in favour of step 4 and the Acceptance criteria: step 6 said the stored blob { provider: 'nope', model: 'x' } should still 'fall back and persist', but step 4's init() rule (any stored value that normalises → preserve, persist nothing) and the acceptance rule ('a persisted selection whose provider is not configured is NOT written over') both make it a preserve case, since normalizeModelSelection accepts any non-blank provider id. I moved it out of the malformed-blob loop and documented why in a comment there; the loop keeps the genuinely malformed cases (undefined, 'garbage', 42, null, { provider: 'google', model: '   ' }, { model: 'x' }), which still persist their fallback.
- Step 6 also missed one pre-existing case that the same rule necessarily changes: 'falls back past a now-disabled provider, persisting the first surviving entry' stores a google selection with no google key, which is now the preserve path. I renamed it to '...WITHOUT persisting over the stored choice' and extended it to assert memento.updates stays empty and that a later refresh() brings google/gemini-2.5-flash back. Leaving it as-was would have directly contradicted the todo's acceptance criteria.
- init() sets this.preserved = stored BEFORE reading availability, so catalogEntries() enumerates a stored provider that is absent from both feed and snapshot; that is what makes the 'vanished provider is never dropped' case resolve as enabled and route through complete(). It is cleared again on the restore and the malformed-blob paths, and on the init catch.
- computeEntry builds the not-configured reason with providerNeedsKeyReason(id, [info]) — the one-element catalog is the already-resolved entry itself, which yields the identical string while avoiding a catalog rebuild per provider (availability() therefore still builds the catalog exactly once per call, as the plan required).
- The extension -> activation -> commands -> extension import cycle from the two accessors is in place as the plan specified, with a comment noting it is safe because both are called only inside closures; tsc and the full suite confirm nothing evaluates them at module load.
- As the plan's risk note predicted, availability() now probes one SecretStorage key per catalog provider; the reads stay in a single Promise.all per call and no per-provider sequential await was added. No memo was introduced (explicitly out of scope).
- chatController.ts, media/*, setApiKey.ts, src/extension.ts and src/orchestrator/* were left untouched; providerRouter.ts still imports vscode type-only, and the two new catalog imports (ModelCatalogSnapshot, ModelsDevFeed) are type-only too, so the module and its test still load with no running host.
