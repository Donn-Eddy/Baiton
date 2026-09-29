# Plan T05

## Steps

1. Add apiLog to ProviderRouterConfig and ClientConfigDeps

   In src/activation/providerRouter.ts add `import type { ApiLog } from '../orchestrator/apiLog';` next to the other orchestrator imports. Keep it a type-only import so the module stays host-free and needs no runtime import. (1) In `ProviderRouterConfig` (around line 140), directly after `log?`, add the field `/** Receives one entry per failed outbound completion call made by the clients this router builds; defaults to noopApiLog inside each client. Not consulted when `createClient` overrides construction. */ apiLog?: ApiLog;`. (2) In `ClientConfigDeps` (around line 178) add `/** Forwarded as ModelClientConfig.apiLog; the provider id becomes ModelClientConfig.surfaceId. */ apiLog?: ApiLog;`. (3) In `providerClientConfig(id, deps)` set `surfaceId: id` unconditionally in the `config` object literal, so every OpenAI-compatible client, including `openai`, tags entries with its own provider id. After the literal, add `if (deps.apiLog !== undefined) { config.apiLog = deps.apiLog; }`, following the style of the existing `extraHeaders` conditional. Add a bullet to the function's doc comment: 'failed calls are reported to `deps.apiLog` with the provider id as `surfaceId`'. Do not change endpoint, model, key, dialect or header wiring.

   Files: `src/activation/providerRouter.ts`

2. Pass apiLog into every client clientFor() builds

   In `ProviderRouter.clientFor` (around line 450): for the Copilot branch, add `...(this.config.apiLog !== undefined ? { apiLog: this.config.apiLog } : {})` to the `new CopilotModelClient({ api, getModel })` argument. CopilotModelClient already hard-codes `surface: 'copilot'`, and `CopilotClientConfig` has no surfaceId. For the OpenAI-compatible branch, add `apiLog: this.config.apiLog` to the deps object passed to `providerClientConfig(id, {...})`. Step 1 then threads it through with `surfaceId: id`. The `createClient` override branch stays unchanged, because test doubles own their own logging. `complete()` must stay as it is: the router adds no logging of its own, forwards the request by reference, and lets errors propagate unwrapped, so there is exactly one entry per failure and it comes from the client. Update the class/module doc comment with one sentence: 'Every client it builds reports failed calls to the injected `apiLog` (the provider id as surface); the router itself logs nothing to it.'

   Files: `src/activation/providerRouter.ts`

3. Wire surface.apiLog from the command layer

   In src/activation/commands.ts, in the `new ProviderRouter({...})` call (around line 613-630), add `apiLog: surface.apiLog,` right after `log: (message) => surface.log(message),`. Add a short comment saying failed completion calls go to the silent 'Baiton: API' channel. `surface` is already the `Surface` parameter in scope (the function signature around line 357), and T02 already added `Surface.apiLog`, so no new import is needed. Do not change any other wiring.

   Files: `src/activation/commands.ts`

4. Leave chatController inline errors unchanged (doc touch only)

   src/activation/chatController.ts needs NO behavioural change. `surfaceError` (around line 1384) keeps its `showError` messages, fix actions and existing `this.deps.log('Baiton chat: ...')` calls byte-for-byte. It must not call apiLog: the client already logged the failure, and a second entry would be a duplicate. The only allowed edit is a one-line addition to the `UnreachableEndpointError` comment (around line 1410), e.g. '(The failed call itself is also recorded, redacted, on the Baiton: API channel by the model client.)'. You may skip even that. Do not add imports.

   Files: `src/activation/chatController.ts`

5. Tests in test/providerRouter.test.ts

   Add `import * as http from 'http';` and `import type { ApiFailureEntry, ApiLog } from '../src/orchestrator/apiLog';`. Add a helper `function recordingApiLog(): ApiLog & { entries: ApiFailureEntry[] } { const entries: ApiFailureEntry[] = []; return { entries, failure: (e) => { entries.push(e); } }; }`. Extend `makeHarness` opts with `apiLog?: ApiLog` and spread `...(opts.apiLog !== undefined ? { apiLog: opts.apiLog } : {})` into `config`. Add `describe('ProviderRouter API failure log', ...)` with these cases:
   (a) providerClientConfig: with `{ ...makeDeps(new FakeSecrets(), makeSettings()), apiLog: log }`, `providerClientConfig('google', deps).apiLog === log` and `.surfaceId === 'google'`. `providerClientConfig('openai', deps).surfaceId === 'openai'`. Without apiLog, `cfg.apiLog === undefined` and `surfaceId` is still set.
   (b) OpenAI-compatible HTTP failure: start `http.createServer((req, res) => { req.resume(); res.writeHead(500, {'content-type':'text/plain'}); res.end('boom'); })` on 127.0.0.1 port 0. Build `makeHarness({ lm: fakeLm([]), defaultClients: true, apiLog: log })`, set `h.secrets.values.set(providerSecretKey('mistral')!, 'm')` and `h.settings.endpoints = { mistral: `http://127.0.0.1:${port}/v1` }`. Then `select({provider:'mistral', model:'m1'})` and `assert.rejects(h.router.complete(makeReq()))` (UnreachableEndpointError). Assert `log.entries.length === 1`, `surface === 'mistral'`, `operation === 'completion'`, `kind === 'http-status'`, `status === 500`, and that `target` contains `127.0.0.1`. In `finally`, call `server.closeAllConnections?.()` and close the server.
   (c) Success produces none: same setup with a server replying 200 `application/json` `{"choices":[{"message":{"role":"assistant","content":"ok"}}]}` (streaming stays false because makeSettings defaults `streaming: false`). `complete` resolves and `log.entries.length === 0`.
   (d) Copilot: `makeHarness({ defaultClients: true, apiLog: log })` (lm enumerates 'fake-model', whose fake chat has no sendRequest, so the call fails as in the existing modelFor('copilot') test). `select({provider:'copilot', model:'fake-model'})`, complete rejects with UnreachableEndpointError, and there is exactly one entry with `surface === 'copilot'`, `kind === 'connection'`, `target === 'fake-model'`.
   (e) Not a call failure: the deepinfra no-endpoint case (catalog `mutableCatalog({ snapshot: snapshotFromFeed(fixtureFeed), feed: fixtureFeed })`, key set, defaultClients, apiLog) rejects with MissingConfigError('endpoint'), and there are 0 entries. `router.complete` with no selection (MissingConfigError('model')) also gives 0 entries.
   (f) createClient override: with a harness using RecordingClients plus an apiLog, a completion leaves `log.entries` empty. The router itself never writes. Existing tests stay unmodified.

   Files: `test/providerRouter.test.ts`

6. Verify

   Run `npm run compile`, `npm run lint` and `npm test`. Confirm providerRouter.ts still has only `import type * as vscode` (grep for a runtime `from 'vscode'` import) and imports apiLog only as a type.

   Files: (none)

## Risks

- Duplicate logging: adding any apiLog call in ProviderRouter.complete or ChatController.surfaceError would double-log the failures the clients already log. Keep the clients as the only writers.
- The HTTP test may hang on keep-alive sockets. Call server.closeAllConnections() before close() (T03 hit the same issue), and give the client no long timeout dependency. The 500 path resolves immediately.
- The completions URL shape depends on completionsUrl(): a base with a path (`/v1`) gets `/chat/completions` appended. Assert only that `target` contains the host, not the exact path.
- The non-streaming success body must match what OpenAiModelClient parses. If the minimal `choices[0].message` body fails, copy the success fixture shape from test/modelClient.test.ts.
- Setting `surfaceId` unconditionally in providerClientConfig changes the object's keys. An existing test that deep-equals the whole ModelClientConfig would need that key. Check the providerClientConfig tests (they appear to assert individual fields).
- The Copilot fake chat has no sendRequest, so the TypeError is classified 'connection' by classifyCopilotFailure. If T04's implementation logs it under a different path or kind, assert on the actual kind while still requiring exactly one entry.

## Acceptance

- ProviderRouterConfig has an optional `apiLog?: ApiLog`. Existing constructors and tests compile unchanged.
- Every OpenAiModelClient the router builds receives `apiLog` from config and `surfaceId` equal to its provider id, via providerClientConfig/ClientConfigDeps.apiLog.
- The CopilotModelClient the router builds receives the same `apiLog`.
- commands.ts passes `apiLog: surface.apiLog` to `new ProviderRouter`.
- ChatController inline error messages, fix actions and Baiton-channel log lines are unchanged, and ChatController does not write to apiLog.
- Router tests show: one induced HTTP 500 through the router produces exactly one entry (surface = provider id, kind 'http-status', status 500); a successful call produces none; a Copilot sendRequest failure produces exactly one 'copilot' entry; MissingConfigError paths produce none.
- providerRouter.ts keeps a type-only vscode import. No vscode import is added under src/orchestrator/.
- `npm run compile`, `npm run lint` (no new warnings) and `npm test` all pass.
