# Execute T03

## Summary

Made `opencode models --verbose` the primary OpenCode model source. Added OPENCODE_MODELS_VERBOSE_FLAG and OPENCODE_MODELS_ARGS (['models','--verbose']) and switched defaultRunModelsCli to that argv (options, never-reject contract and the OpencodeModelsCli seam signature unchanged). Added the pure, total parser opencodeModelsFromVerboseOutput, which walks the listing, collects each id's pretty-printed JSON block by brace depth counted outside double-quoted strings, and emits id/provider plus a conditional `label` from `name` (omitted when it equals the full token or the bare model id) and a conditional `efforts` from Object.keys(variants) (no key at all for {}/missing/null/non-object variants, never defaultEffort), de-duplicating by id first-occurrence-wins; an unparseable or unterminated block degrades to a plain { id, provider } entry. Inverted OpencodeAdapter.discoverModels: abort check, shared clamped wall-clock budget, CLI run first, return capabilitiesFromEntries(cliEntries) as soon as it yields one entry (no server started, no request made), else /api/model as the ids-only fallback merged through mergeOpencodeModelSources, with undefined when both fail. Dropped the explicit `{ efforts: [...OPENCODE_EFFORTS] }` argument so the capability-level efforts are the ordered union of the entries' own levels. Corrected the OPENCODE_EFFORTS, class-doc item 4, discoverModels and mergeOpencodeModelSources doc comments, checked in test/fixtures/opencodeModelsVerbose.sample.txt, added the parser suite plus CLI-first discovery tests, and rewrote README's opencode Sources, CLI capabilities and Privacy bullets.

## Files changed

- `src/adapter/opencode.ts`
- `test/fixtures/opencodeModelsVerbose.sample.txt`
- `test/adapter.opencode.test.ts`
- `README.md`

## Commands run

- `npm run lint`
- `npx tsc --noEmit -p .`
- `npm test`
- `git status --short && git diff --stat`

## Notes

- Full suite green: 2132 passing, 1 pending, 0 failing (includes test/adapter.opencode.test.ts and test/modelSelectorRefresh.test.ts). `npx tsc --noEmit -p .` is clean; `npm run lint` reports 0 errors and only the pre-existing `_legacy` unused-var warning in src/orchestrator/webviewProtocol.ts.
- One deviation from the plan, made to satisfy the acceptance bullet '/api/model is requested only when the CLI is unavailable, rejects, times out, or yields no entry': the CLI call is wrapped in its own try/catch that degrades to [] instead of letting a rejecting injected runner hit the outer catch. Without it a rejecting runner ended the whole refresh and the API fallback never ran, which failed the new 'falls back to /api/model when the runner rejects' table row. The seam is still documented as never rejecting.
- Re-checked every OpencodeAdapter construction site for the CLI-primary risk: src/adapter/index.ts:154 (production, intended), test/adapter.launch.property.test.ts (launch/attach only, no discovery), test/modelSelectorRefresh.test.ts:309 (already stubs runModelsCli: async () => undefined, so it stays on the API path), and test/adapter.opencode.test.ts:'still resolves session ids through the positional listSessions parameter' (resolveSessionId only). No test can reach a real opencode binary.
- Invalidated discovery tests repaired as planned: the old '/api/model happy path' and 'runs the CLI as a validation source even when the API succeeded' were replaced by a fixture-driven CLI-first happy path and its inverse 'starts no server and makes no request when the CLI succeeds'; every API-path test now injects fakeCli(undefined)/fakeCli(''); the apiFailures loop now asserts undefined (its CLI source yields nothing and the API fails, so both sources are empty); 'round-trips through capabilitiesToCatalogFetch' asserts the API ids only.
- mergeOpencodeModelSources and opencodeModelsFromCliOutput are both still exported and behaviourally untouched, with their existing unit tests passing; the verbose parser's bare-listing parity is pinned by a test asserting deep equality of both parsers' output on the same coloured/bulleted listing.
- OPENCODE_MODELS/OPENCODE_EFFORTS are still both `[]`, and launch()/attach() argv is untouched — the existing 'leaves launch() byte-identical whether or not discovery options were passed' test still passes.
