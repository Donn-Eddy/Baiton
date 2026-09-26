# Execute T05

## Summary

T05: implemented Codex model discovery through `codex app-server` stdio JSON-RPC. src/adapter/codex.ts gained the app-server vocabulary (CODEX_APP_SERVER_SUBCOMMAND/'app-server', the initialize/initialized/model/list method constants, request ids 1/2, and the literal CODEX_APP_SERVER_CLIENT_INFO), the injectable CodexAppServerSpawner/CodexAppServerProcess/CodexAdapterOptions seam with defaultSpawnAppServer, the optional CodexAdapter constructor parameter (existing no-arg call sites unchanged), the pure total codexModelsFromAppServer parser (models|items|bare array; id|model|slug ids; displayName/name labels when different; supportedReasoningEfforts of strings or {effort} objects with blanks/dups dropped; defaultEffort guarded by membership; de-dup by id; conditional key assignment), and CodexAdapter.discoverModels driving the JSONL handshake with a single idempotent finish() that clears the timer, removes the abort listener, ends stdin and kills the child on every path; it resolves undefined (never rejects, never returns the curated list) and maps entries via capabilitiesFromEntries with the first-seen effort union or the curated CODEX_EFFORTS fallback, carrying no provenance keys. This retry run (execute-2) appended the two T05 suites to test/adapter.codex.test.ts — the full codexModelsFromAppServer parser cases and the 15 discoverModels cases (happy path with exact three-message framing, round-trip through capabilitiesToCatalogFetch, effort fallback, cwd forwarding, multi-chunk/Buffer/junk framing, initialize and model/list JSON-RPC errors, ENOENT, early exit/close, 30ms timeout with kill-once + clamp pins for timeoutMs 0 and 60_000, already-aborted/mid-flight abort, throwing spawner and throwing stdin.write, empty list, registry wiring) — and restructured the timer to a const per eslint prefer-const. test/adapter.index.test.ts required no edit: its seam assertion already tolerates implemented adapters.

## Files changed

- `src/adapter/codex.ts`
- `test/adapter.codex.test.ts`

## Commands run

- `npx tsc --noEmit -p tsconfig.json`
- `npm run compile`
- `npx eslint src/adapter/codex.ts test/adapter.codex.test.ts --ext .ts`
- `npx mocha test/adapter.codex.test.ts --grep 'T05' (40 passing)`
- `npx mocha test/adapter.index.test.ts --grep 'discoverModels' (27 passing, incl. the codex seam test)`
- `npm run test:unit (1459 passing, 1 pending, 1 failing: only the pre-existing keytar gating failure)`
- `npm run test:property (1535 passing, 1 pending, same single keytar failure)`

## Notes

- Retry context: run execute-1 had already implemented the src/adapter/codex.ts half and extended the test file's imports/header (committed by the extension as part of 'T05 planned (closed (exit 1))'); this run appended the two missing test suites and fixed one eslint issue in codex.ts (timer let -> const, moved above finish's callers).
- test/adapter.index.test.ts:344('no adapter implements discoverModels yet') needed no change: it asserts seam === undefined || typeof seam === 'function' per registered adapter and only pins antigravity to undefined, so codex implementing the seam passes it; no out-of-scope file was edited.
- The only failing suite is the documented pre-existing baseline failure: test/activation.gating.test.ts 'packaging gating: includes zero native modules' (keytar).
- test:unit/test:property runs show 1459/1535 passing with that single failure; the new codex discovery suites (10 parser + 15 adapter cases) are green.
- Launch behaviour is untouched: launch argparse, probe, attach, discoverSessionId, relay flags and CODEX_MODELS/CODEX_EFFORTS are byte-identical; the new constructor parameter is optional with default {}.
