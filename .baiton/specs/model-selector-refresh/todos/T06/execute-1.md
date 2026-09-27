# Execute T06

## Summary

Implemented opencode model discovery in src/adapter/opencode.ts: the server's /api/model route is the primary source (reached through serverBaseUrl/OPENCODE_SERVER when set, else one `opencode serve --hostname 127.0.0.1 --port 0` child whose ephemeral URL is read off its banner) with `opencode models` stdout as both fallback and validation source. Added the discovery vocabulary and injection seams (OPENCODE_SERVE_SUBCOMMAND/ARGS/HOSTNAME/PORT, OPENCODE_MODELS_SUBCOMMAND, OPENCODE_MODEL_ENDPOINT_PATH, OPENCODE_SERVER_ENV_VAR, OpencodeServer, OpencodeServerStarter, OpencodeModelsCli, OpencodeAdapterOptions), the pure parsers opencodeModelsFromApi / opencodeModelsFromCliOutput / mergeOpencodeModelSources / parseOpencodeServerUrl, the default starter and CLI runner, and OpencodeAdapter.discoverModels. The constructor now takes (listSessions, options) so `new OpencodeAdapter()` and `new OpencodeAdapter(fakeList)` are unchanged. discoverModels never rejects, resolves undefined whenever nothing was discovered, honours ctx.signal and a clamped ctx.timeoutMs budget, disposes a started server exactly once on every exit path and never kills a pre-existing one, returns efforts: [] with no source/stale/staleReason/fetchedAt/modelLink own key, and reads no env var other than the OPENCODE_SERVER base-URL check. test/adapter.opencode.test.ts gained four parser suites and a 16-case discoverModels suite driven entirely through the fake seams (no real spawn, no socket); every existing suite is untouched.

## Files changed

- `src/adapter/opencode.ts`
- `test/adapter.opencode.test.ts`

## Commands run

- `npx tsc --noEmit -p tsconfig.json`
- `npm run compile`
- `npx eslint src/adapter/opencode.ts test/adapter.opencode.test.ts --ext .ts`
- `npx mocha "test/adapter.opencode.test.ts" --grep T06`
- `npm run test:unit`

## Notes

- Verification: npx tsc --noEmit exits 0, npm run compile exits 0, eslint on both files is clean, and npm run test:unit reports 1506 passing / 1 pending / 1 failing — the only failure being the pre-existing 'packaging gating: includes zero native (compiled binary) modules' keytar assertion in test/activation.gating.test.ts, documented at baseline in T01 and deliberately not touched here.
- The 47 new T06 assertions all pass (npx mocha test/adapter.opencode.test.ts --grep T06).
- The ANSI-strip regex in opencodeModelsFromCliOutput needed an `// eslint-disable-next-line no-control-regex` with a reason comment, following the existing precedent in src/orchestrator/sanitizer.ts:112.
- discoverModels needed a small `isAborted(signal)` helper rather than inline `ctx.signal?.aborted === true` re-checks: after the early-return guard TypeScript narrows the readonly `aborted` property to `false | undefined` and rejects the later comparisons with TS2367.
- opencodeModelsFromApi accepts the top-level provider-keyed map (shape 4) only when EVERY value is an object carrying a `models` array/map, so an arbitrary object still yields [] as the plan requires.
- In the tests, the `fakeServer` helper signals 'no server could be started' with `null` rather than `undefined`, because an explicitly passed `undefined` triggers the default parameter value and would silently exercise the happy path instead.
- src/adapter/index.ts, src/adapter/adapter.ts and src/orchestrator/* are untouched; launch(), attach(), probe(), resolveSessionId(), opencodeAgentDefinition, opencodeAllowList and opencodeConfigEnv are unchanged, and a launch built by an adapter constructed with discovery options is deep-equal to one from `new OpencodeAdapter()`.
