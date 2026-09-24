# Execute T02

## Summary

Extended the orchestrator provider catalog and model client with wire-dialect and extra-header seams, and implemented the OpenCode header provider plus the Gemini tool-chaining dialect with mock-server tests. providers.ts gained `DialectId`/`HeaderStyleId` and required `dialect`/`headerStyle` on every PROVIDERS entry (google=gemini, opencode=opencode) while staying import-free. modelClient.ts gained an optional `sessionId` on CompletionRequest (never serialised into the body), a `WireMessage`/`WireDialect` seam with `shapeOpenAiMessages` lifting today's serialisation byte for byte as the default `openAiDialect`, `dialectFor`, the `geminiDialect` (omits empty assistant content on tool_calls turns, sanitises tool arguments to JSON objects, reattaches tool messages right after their assistant turn in call order, drops orphans), an `extraHeaders?: ExtraHeadersProvider` hook whose extras are lowercased and spread before the immutable base headers, and `openCodeExtraHeaders({ version, newSessionId? })` minting a stable `x-opencode-session` uuid per conversation plus `user-agent: baiton/<version>`. test/modelClient.test.ts records headers on the captured request and adds describe blocks for extraHeaders (including override-protection), sessionId body exclusion, openCodeExtraHeaders uuid stability, the openAiDialect default regression guard, and unit + end-to-end geminiDialect coverage. Verification: tsc --noEmit clean, eslint clean on the three files, mocha on both changed suites green, npm run test:unit 1189 passing / 1 pending (baseline 1170).

## Files changed

- `src/orchestrator/providers.ts`
- `src/orchestrator/modelClient.ts`
- `test/modelClient.test.ts`

## Commands run

- `npx tsc --noEmit -p tsconfig.json`
- `npx eslint src/orchestrator/modelClient.ts src/orchestrator/providers.ts test/modelClient.test.ts --ext .ts`
- `npx mocha test/modelClient.test.ts`
- `npx mocha test/providers.test.ts`
- `npm run test:unit`

## Notes

- sessionId stays optional; toolLoop.ts and autoMode.ts send none, so the OpenCode factory falls back to its per-factory uuid until a later todo threads the session id through (noted, files untouched).
- providers.ts remains dependency-free (no imports of modelClient.ts); modelClient.ts type-imports DialectId only.
- shapeOpenAiMessages is a verbatim lift of the previous inline map, so the default payload is unchanged — guarded by a regression test on an empty-content assistant tool_calls turn with a malformed argument string.
- Header precedence extras-first/base-last is pinned by a test asserting authorization/content-type/content-length cannot be clobbered.
- The pre-existing no-unused-vars warning in src/orchestrator/webviewProtocol.ts was left untouched as instructed.
