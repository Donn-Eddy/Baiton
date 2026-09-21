# Execute T12

## Summary

Implemented the T12 ask-relay file protocol core. Added host-free src/engine/askRelay.ts (node fs/path only, no vscode) exporting the path helpers (asksDirFor/askFilePath/responseFilePath/askIdFromFileName with the response suffix checked first so a.response.json is never read as ask id a.response), the RelayAsk/RelayResponse wire types, AskRelayError + describeAskRelayError, pure parseAsk/parseResponse returning Result<T, AskRelayError> with unknown-field dropping on success, stable-field-order 2-space-indent trailing-newline serializers, the intervention bridge both ways (toInterventionRequest, responseFromAnswer with respondedAt only when passed), askRelayDescriptor, and the injectable-io fs helpers (AskRelayIo/nodeAskRelayIo/ensureAsksDir/writeResponse with .tmp+rename atomicity/listPendingAskIds swallowing ENOENT). Added AskRelayDescriptor and the optional LaunchRequest.relay field to src/adapter/adapter.ts with no adapter implementation changes. Plumbed relayAsks through src/engine/launcher.ts: the descriptor is computed only when relayAsks === true (byte-identical requests when omitted), the asks dir is created inside the existing brief-write try/catch, and relay is added to LaunchStageOutput only when defined. Re-exported ./askRelay from src/engine/index.ts and extended the header JSDoc. Added test/engine.askRelay.test.ts (35 tests) covering path helpers, id extraction, valid/invalid parses with field-naming messages, serialize→parse round-trips, the intervention bridge in both directions, all responseFromAnswer variants, the fs helpers, and both launcher branches via a copied StubTerminalHost/adapterThat pair. npm run compile, npx mocha (35 passing), npm run lint and npm test (1088 passing, 1 pending) all green.

## Files changed

- `src/engine/askRelay.ts`
- `src/adapter/adapter.ts`
- `src/engine/launcher.ts`
- `src/engine/index.ts`
- `test/engine.askRelay.test.ts`

## Commands run

- `npm run compile`
- `npx mocha --no-config test/engine.askRelay.test.ts --require ts-node/register`
- `npm run lint`
- `npm test`
- `git status --short && git diff --stat`

## Notes

- No adapter implementation files were changed; the four adapters keep ignoring LaunchRequest.relay until their probe todos land, and test/adapter.launch.property.test.ts plus the per-adapter suites stayed green (npm test 1088 passing).
- askIdFromFileName checks RESPONSE_FILE_SUFFIX before ASK_FILE_SUFFIX and rejects empty ids, path separators and '..', so the T17 watcher cannot answer its own responses.
- writeResponse uses the .tmp-sibling + rename only when io is the node implementation, per the plan; custom injected io implementations get a direct write.
- listPendingAskIds swallows ENOENT on both the readdir and the per-response readFile (a response vanishing mid-scan counts as pending); any other errno propagates.
- args stays an opaque string end-to-end and is never JSON.parsed, and parseAsk drops unknown fields so harness data never leaks into the intervention request.
