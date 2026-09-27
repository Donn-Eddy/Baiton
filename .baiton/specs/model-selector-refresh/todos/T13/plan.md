# Plan T13

## Steps

1. Widen ProviderModelItem and ProviderGroup in the protocol core

   In src/orchestrator/webviewProtocol.ts, extend the two provider interfaces additively (every new field optional, so every existing construction site and fixture stays valid):

   `ProviderModelItem` gains:
   - `custom?: boolean` — JSDoc: 'True when this model id came from the active/preserved selection rather than the refreshed catalog; the view marks it "(custom)".'
   - `efforts?: string[]` — JSDoc: 'The reasoning-effort levels this model accepts, when the source reports them; absent means the provider exposes none.'

   `ProviderGroup` gains:
   - `stale?: boolean` — 'True when the catalog snapshot backing `models` is no longer known current; the view shows a stale badge.'
   - `staleReason?: string` — 'Why the snapshot is stale; present only with `stale: true`.'

   Also fix the now-wrong doc on `ProviderGroup.id`: `ProviderId` is an open `string` since the provider-catalog todo, so replace the enumerated comment ("'copilot' | 'google' | ...") with 'The provider id; builtin (`copilot`, `openai`, …) or feed-derived.' Update `ProviderGroup`'s own leading doc: the view is provider-first (a provider select plus a model select), so word it as 'One provider offered in the Provider & Model selection, in catalog order' rather than 'One <optgroup>'. Leave `enabled` and `reason` required/optional exactly as they are — the host now only sends configured groups, but keeping the fields keeps the union additive and the existing fixtures/tests valid; say so in `enabled`'s JSDoc ('the host posts only configured providers, so this is normally true; kept for a group the host chooses to show as unusable').

   Files: `src/orchestrator/webviewProtocol.ts`

2. Carry refreshedAt on setProviders and in WebviewState

   Still in src/orchestrator/webviewProtocol.ts:

   1. Change the `setProviders` variant of `HostToWebview` to `{ type: 'setProviders'; groups: ProviderGroup[]; selection: ModelSelection | null; refreshedAt?: string }` and document `refreshedAt` as 'ISO-8601 time of the most recent successful catalog fetch backing these groups; absent when no group is catalog-backed.' Update the variant's block comment to say the host posts only the configured providers.
   2. Add `refreshedAt?: string` to `WebviewState`, documented the same way.
   3. Do NOT add `refreshedAt` to `initialWebviewState()` — the seed keeps its current exact shape, because test/webviewProtocol.mirror.test.ts deep-compares the seeds of both implementations and test/fixtures/protocolCases.ts `seed()` deliberately re-declares the literal to catch seed drift.
   4. In `reduce`, change the `setProviders` case to:
      `return { ...state, providers: [...msg.groups], selection: msg.selection, refreshedAt: msg.refreshedAt };`
      Write it unconditionally (not a conditional spread): after a `setProviders` without `refreshedAt` the state carries the own key with value `undefined`, which is exactly the existing house style for `showError` (`action: msg.action, provider: msg.provider`) and is trivially mirrorable. `assert.deepStrictEqual` in the mirror test distinguishes a missing key from an undefined one, so the JS mirror must use the identical unconditional form.
   5. Update the `reduce` doc-comment bullet for `setProviders` to '`setProviders` replaces the provider groups, the active selection and the catalog refresh time.'

   Files: `src/orchestrator/webviewProtocol.ts`

3. Mirror the reducer change in media/protocol.js

   In media/protocol.js, the `case 'setProviders':` branch becomes:

   ```js
         case 'setProviders':
           return Object.assign({}, state, {
             providers: msg.groups.slice(),
             selection: msg.selection,
             refreshedAt: msg.refreshedAt,
           });
   ```

   Leave `initialWebviewState()` in this file byte-identical (no `refreshedAt` key) so it still deep-equals the TypeScript seed. No other branch changes; the new ProviderGroup/ProviderModelItem fields need no reducer code because groups are copied wholesale by `msg.groups.slice()`. Keep the file's `Object.assign` / `function` style and the `// @ts-check` header intact.

   Files: `media/protocol.js`

4. Forward stale, custom, efforts and refreshedAt from ChatController

   In src/activation/chatController.ts:

   1. Extend the local `ProviderAvailabilityView` seam interface (it structurally mirrors `ProviderAvailability` from providerRouter.ts, which already carries the first four) with:
   ```ts
     /** True when the catalog snapshot backing `models` is no longer known current. */
     stale?: boolean;
     /** Why the snapshot is stale; present only with `stale: true`. */
     staleReason?: string;
     /** ISO-8601 time of the last successful catalog fetch backing `models`. */
     fetchedAt?: string;
     /** Ids inside `models` that came from a preserved selection, not the catalog. */
     customModels?: readonly string[];
     /** Per-model reasoning-effort levels, keyed by model id, when the source reports them. */
     efforts?: Readonly<Record<string, readonly string[]>>;
   ```
   All optional, so the existing fake sources in test/chatController.autoMode.test.ts and test/chatController.interventions.test.ts keep compiling unchanged.

   2. Rewrite `postProviders()` (around line 353) to build the richer groups and the message-level `refreshedAt`:
   ```ts
         const entries = await source.availability();
         const groups: ProviderGroup[] = entries.map((e) => {
           const custom = new Set(e.customModels ?? []);
           return {
             id: e.id,
             label: e.label,
             enabled: e.enabled,
             ...(e.reason !== undefined ? { reason: e.reason } : {}),
             ...(e.stale === true ? { stale: true } : {}),
             ...(e.stale === true && e.staleReason !== undefined ? { staleReason: e.staleReason } : {}),
             models: e.models.map((id) => {
               const efforts = e.efforts?.[id];
               return {
                 id,
                 ...(custom.has(id) ? { custom: true } : {}),
                 ...(efforts !== undefined && efforts.length > 0 ? { efforts: [...efforts] } : {}),
               };
             }),
           };
         });
         const refreshedAt = latestFetchedAt(entries);
         this.deps.webview.post({
           type: 'setProviders',
           groups,
           selection: source.getSelection() ?? null,
           ...(refreshedAt !== undefined ? { refreshedAt } : {}),
         });
   ```
   Keep the surrounding `try/catch` and its `this.deps.log('Baiton chat: could not list the providers: …')` message verbatim — a throwing source must still degrade to 'no post', never to a rejected promise.

   3. Add a module-private pure helper next to `postProviders` (or beside the existing `describe` helper at the bottom of the file, matching the file's placement of such helpers):
   ```ts
   /**
    * The most recent `fetchedAt` among the given availability entries, as the
    * host reported it. Entries with no `fetchedAt` (copilot, openai, and any
    * builtin-backed provider) are ignored, and an unparseable value is ignored
    * rather than allowed to win. Returns undefined when nothing is catalog-backed.
    */
   function latestFetchedAt(entries: readonly ProviderAvailabilityView[]): string | undefined {
     let best: string | undefined;
     let bestMs = -Infinity;
     for (const e of entries) {
       if (e.fetchedAt === undefined) continue;
       const ms = Date.parse(e.fetchedAt);
       if (!Number.isFinite(ms) || ms <= bestMs) continue;
       bestMs = ms;
       best = e.fetchedAt;
     }
     return best;
   }
   ```
   Return the original string, not a re-serialised date, so the webview shows exactly what the host recorded.

   4. Update the class doc header bullet at src/activation/chatController.ts:46 to mention that the dropdown post carries only the configured providers plus stale/custom markers and the catalog refresh time. Change nothing about `onSelectModel` — `ProviderId` is already an open `string`, so a feed-derived or preserved provider id round-trips as-is.

   Files: `src/activation/chatController.ts`

5. Extend the shared mirror fixtures

   In test/fixtures/protocolCases.ts:

   1. Leave `seed()` exactly as it is (no `refreshedAt`), so seed drift is still caught.
   2. Keep `group()` as-is and add a second helper beside it:
   ```ts
   /** A minimal provider model item, overridable per field. */
   export function modelItem(over: Partial<ProviderModelItem> = {}): ProviderModelItem {
     return { id: 'gemini-2.5-pro', ...over };
   }
   ```
   importing `ProviderModelItem` from '../../src/orchestrator/webviewProtocol' alongside the existing `ProviderGroup` type import.
   3. Append new cases after the existing setProviders block (cases 37–41, ~lines 416–510), each continuing the numbered-comment convention:
      - 'setProviders carries refreshedAt' — one configured group plus `refreshedAt: '2026-09-26T10:00:00.000Z'`.
      - 'setProviders without refreshedAt clears a previous one' — start from `seed({ providers: [group()], selection: { provider: 'google', model: 'gemini-2.5-pro' }, refreshedAt: '2026-09-01T00:00:00.000Z' })` and fold a `setProviders` with no `refreshedAt`; both reducers must land on the key present with value `undefined`, which is the whole point of the unconditional assignment.
      - 'setProviders with a stale group' — `group({ stale: true, staleReason: 'models.dev fetch failed: timeout' })`.
      - 'setProviders with a custom model marker' — models `[modelItem(), modelItem({ id: 'gemini-9-preview', custom: true })]` and a selection naming the custom id.
      - 'setProviders with per-model efforts' — `group({ id: 'anthropic', label: 'Anthropic', models: [modelItem({ id: 'claude-sonnet-5', label: 'Claude Sonnet 5', efforts: ['low', 'medium', 'high'] })] })`.
      - 'setProviders with a feed-derived provider id' — `group({ id: 'deepinfra', label: 'DeepInfra', models: [modelItem({ id: 'deepseek-ai/DeepSeek-V3' })] })`, pinning that an open string id survives the fold.
      - 'setProviders then setEmptyState then a stale re-post' — a multi-message fold so the purity check (which picks the first multi-message case it finds) and the ordering stay exercised over the new fields.

   test/webviewProtocol.mirror.test.ts needs NO edit: it folds every `PROTOCOL_CASES` entry through both reducers and deep-compares, so the new cases are the parity guard. Re-read it before deciding otherwise, and do not weaken its `deepStrictEqual`s.

   Files: `test/fixtures/protocolCases.ts`, `test/webviewProtocol.mirror.test.ts`

6. Extend the reducer unit tests

   In test/webviewProtocol.reducer.test.ts, inside the existing `describe('provider selection', …)` block (starts ~line 604; its `groups` const is at 609):

   1. Leave the existing `groups` const and its five `setProviders` tests untouched — they pin the additive contract (a group with `enabled: false` + `reason` still type-checks and still folds).
   2. Add tests:
      - 'setProviders stores refreshedAt': fold with `refreshedAt: '2026-09-26T10:00:00.000Z'`, assert `next.refreshedAt`.
      - 'setProviders without refreshedAt clears the previous value': seed a state with `refreshedAt` set, fold without it, assert `next.refreshedAt === undefined` AND `Object.prototype.hasOwnProperty.call(next, 'refreshedAt') === true` (the own-key detail the mirror parity depends on).
      - 'a fresh state has no refreshedAt key': `assert.strictEqual(Object.prototype.hasOwnProperty.call(initialWebviewState(), 'refreshedAt'), false)` — guards the seed against drift in the other direction.
      - 'setProviders keeps a group\'s stale markers and a model\'s custom/efforts flags': fold a group carrying `stale: true`, `staleReason`, and models `[{ id: 'a' }, { id: 'b', custom: true, efforts: ['low','high'] }]`, then `deepStrictEqual` the whole `next.providers` against the input and `assert.notStrictEqual(next.providers, input)` (copied, not aliased), matching the style of the existing copy assertion at line 632.
      - 'setProviders accepts a feed-derived provider id': a group whose `id` is `'deepinfra'`, with a matching `selection`, asserting both survive — the compile-time half of the open-`ProviderId` change.
      - 'selectModel carries a feed-derived provider id': alongside the existing `selectModel` assertion at line 698, build `{ type: 'selectModel', provider: 'cerebras', model: 'qwen-3-coder' }` as a `WebviewToHost` and assert the fields, proving the webview→host direction is not narrowed.
   3. Use explicit `ProviderGroup[]` / `ProviderModelItem[]` annotations on the new literals (import `ProviderModelItem` from the core) so a field typo fails `tsc` rather than silently passing.

   Files: `test/webviewProtocol.reducer.test.ts`

7. Verify

   Run, from the repo root, and get all of them clean:
   - `npx tsc --noEmit -p tsconfig.json`
   - `npm run compile`
   - `npx eslint src/orchestrator/webviewProtocol.ts src/activation/chatController.ts test/webviewProtocol.reducer.test.ts test/webviewProtocol.mirror.test.ts test/fixtures/protocolCases.ts --ext .ts`
   - `npx mocha test/webviewProtocol.mirror.test.ts` (note: .mocharc pulls in the whole suite regardless of the named file — read the output for the three protocol/controller suites specifically)
   - `npm run test:unit` — compare against the known baseline: the only acceptable failure is the pre-existing keytar 'packaging gating … includes zero native modules' case in test/activation.gating.test.ts. Anything else is a regression from this todo.
   - `git status --porcelain` must list only: src/orchestrator/webviewProtocol.ts, media/protocol.js, src/activation/chatController.ts, test/fixtures/protocolCases.ts, test/webviewProtocol.reducer.test.ts (and test/webviewProtocol.mirror.test.ts only if you genuinely had to touch it).

   Do not edit media/chat.html, media/chat.js, test/chatView.providers.test.ts or src/activation/setApiKey.ts: the provider-select/model-select split, the stale badge and the '(custom)' option are a separate todo, and this todo's job is to land the fields they will consume while every current chat-view test still passes untouched.

   Files: (none)

## Risks

- The mirror test's `assert.deepStrictEqual` distinguishes a missing key from an own key whose value is `undefined`. If the TypeScript reducer uses a conditional spread for `refreshedAt` and media/protocol.js uses an unconditional assignment (or vice versa), the parity suite fails on every setProviders case. Both must use the plain unconditional `refreshedAt: msg.refreshedAt`.
- Adding `refreshedAt` to `initialWebviewState()` would break two guards at once: the mirror test's seed comparison (unless media/protocol.js is changed identically) and the deliberate literal duplication in `seed()` in test/fixtures/protocolCases.ts. Leave the seed alone.
- test/chatController.autoMode.test.ts and test/chatController.interventions.test.ts build fake `ProviderSource`s and assert on `webview.last('setProviders')`. Every new field must be optional and omitted when absent, or those fakes stop compiling / their deep assertions drift. The `...(cond ? { k: v } : {})` form in `postProviders` is what keeps the posted message byte-identical for a source that reports nothing new.
- media/chat.js currently renders one `<optgroup>` per group including disabled ones, and test/chatView.providers.test.ts pins that. The new fields are ignored by that code, so it keeps working — but only as long as this todo does not start omitting `enabled`/`reason` or changing the message shape non-additively.
- `ProviderAvailability` in src/activation/providerRouter.ts has no `efforts` field today, so the `efforts` seam on `ProviderAvailabilityView` will be unpopulated by the real router until a later todo supplies it. That is intended (the protocol field is what the chat view needs); assert the forwarding through a fake source in the reducer/fixture tests rather than expecting live data.
- `refreshedAt` is picked by `Date.parse` across entries. Entries whose `fetchedAt` is unparseable must be ignored, not allowed to win, or a malformed host value would blank out a good timestamp.

## Acceptance

- `ProviderModelItem` carries optional `custom` and `efforts`; `ProviderGroup` carries optional `stale` and `staleReason`; the `setProviders` message and `WebviewState` carry optional `refreshedAt` — all additive, with no existing field removed, renamed or narrowed.
- `reduce`'s `setProviders` case sets `providers`, `selection` and `refreshedAt`, and media/protocol.js's branch is its exact mirror; `initialWebviewState()` is unchanged in both files and still deep-equals across them.
- test/webviewProtocol.mirror.test.ts passes with new PROTOCOL_CASES entries covering refreshedAt present, refreshedAt absent-after-present, a stale group, a custom-marked model, per-model efforts and a feed-derived provider id — with its `deepStrictEqual` assertions unweakened.
- test/webviewProtocol.reducer.test.ts asserts that a fresh state has no own `refreshedAt` key, that a setProviders without `refreshedAt` leaves the own key present and `undefined`, that stale/custom/efforts markers survive the fold copied-not-aliased, and that an open (feed-derived) provider id round-trips in both `setProviders` and `selectModel`.
- `ChatController.postProviders()` posts only the entries `source.availability()` returns, forwarding `stale`/`staleReason` for a stale entry, `custom: true` for each id in `customModels`, `efforts` for each model the source reports levels for, and a message-level `refreshedAt` equal to the newest parseable `fetchedAt` among the entries; a source reporting none of the new fields yields a message byte-identical to today's.
- A throwing or rejecting `availability()` still posts nothing and logs 'Baiton chat: could not list the providers: …' as before.
- `npx tsc --noEmit -p tsconfig.json`, `npm run compile` and eslint over the changed .ts files are clean, and `npm run test:unit` shows no new failures beyond the pre-existing keytar packaging-gating case.
- media/chat.html, media/chat.js, test/chatView.providers.test.ts, src/activation/providerRouter.ts and src/activation/setApiKey.ts are untouched, and the existing chat-view and chat-controller suites pass unmodified.
