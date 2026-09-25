# Plan T07

## Steps

1. Add the provider view types to the protocol core

   In src/orchestrator/webviewProtocol.ts, extend the existing type-only import block with `import type { ModelSelection, ProviderId } from './providers';` (providers.ts is host-free, so this keeps the core vscode-free). Below the `FixAction` declaration add two exported interfaces with the same doc-comment density as the neighbouring `ConversationItem`/`SessionItem`:

   ```ts
   /** One model offered under a provider group in the Chat dropdown. */
   export interface ProviderModelItem {
     /** The model id sent back with `selectModel` (e.g. 'gemini-2.5-pro'). */
     id: string;
     /** Optional display text; the webview falls back to `id` when absent. */
     label?: string;
   }

   /** One <optgroup> in the Provider & Model dropdown, in catalog order. */
   export interface ProviderGroup {
     /** The provider id (`'copilot' | 'google' | 'opencode' | 'mistral' | 'openai'`). */
     id: ProviderId;
     /** The human label rendered as the group's optgroup label. */
     label: string;
     /** False when the provider cannot be used yet (no key, no endpoint, Copilot absent). */
     enabled: boolean;
     /** Why the group is disabled; present only when `enabled` is false. */
     reason?: string;
     /** The models offered under this group; empty for a disabled provider. */
     models: ProviderModelItem[];
   }
   ```

   Do not re-declare a provider id union locally — reuse `ProviderId` so the webview contract and the catalog cannot drift.

   Files: `src/orchestrator/webviewProtocol.ts`, `src/orchestrator/providers.ts`

2. Add setProviders to HostToWebview and selectModel to WebviewToHost

   In the `HostToWebview` union in src/orchestrator/webviewProtocol.ts, add one variant after `setEmptyState` (keep the union's existing doc-comment-per-variant style):

   ```ts
     /**
      * Replace the Provider & Model dropdown: the ordered provider groups and
      * the active selection, or `null` when no provider/model is chosen yet.
      */
     | { type: 'setProviders'; groups: ProviderGroup[]; selection: ModelSelection | null }
   ```

   In the `WebviewToHost` union add:

   ```ts
     /** The user picked a provider/model pair in the dropdown. */
     | { type: 'selectModel'; provider: ProviderId; model: string }
   ```

   Flat `provider`/`model` fields match the existing `selectSession`/`selectConversation` style; the host normalizes the pair with `normalizeModelSelection` from './providers' in a later todo. Nothing else in the repo needs updating for the new webview→host variant: `ChatController.handle` (src/activation/chatController.ts:333) switches without a `default`/`assertNever`, so an unhandled `selectModel` compiles and is simply ignored until the controller todo wires it.

   Files: `src/orchestrator/webviewProtocol.ts`

3. Extend WebviewState, initialWebviewState and reduce in the TypeScript core

   In src/orchestrator/webviewProtocol.ts:

   1. `WebviewState` gains two required fields, documented like its neighbours:
   ```ts
     /** The provider groups rendered in the Provider & Model dropdown. */
     providers: ProviderGroup[];
     /** The active provider/model pair, or null when none is chosen. */
     selection: ModelSelection | null;
   ```
   They are required (not optional) so the seed, the mirror and the fixture `seed()` helper all have to carry them — the mirror test's `deepStrictEqual` over the whole state is the drift guard.

   2. `initialWebviewState()` returns `providers: []` and `selection: null` in addition to the current keys. Put them after `autoMode: false` and keep the same key order as the mirror.

   3. `reduce` gains one case, placed next to `setEmptyState` (before `default`):
   ```ts
       case 'setProviders':
         return { ...state, providers: [...msg.groups], selection: msg.selection };
   ```
   The copy is shallow, exactly like `setConversations`/`setSessions` — do not deep-clone the groups, or the mirror must match that too. `selection` is stored by reference as given (including `null`).

   4. Extend the `reduce` doc comment's bullet list with: "- `setProviders` replaces the provider groups and the active selection."

   The `assertNever(msg)` default branch makes this a compile error if the case is forgotten, so `npx tsc --noEmit` is the first check.

   Files: `src/orchestrator/webviewProtocol.ts`

4. Mirror the change byte-for-behaviour in media/protocol.js

   In media/protocol.js:

   1. `initialWebviewState()` returns the two new keys in the same order as the TypeScript seed: `providers: []`, `selection: null` after `autoMode: false`.

   2. Add the case in the same position as in the TS switch (right after `setEmptyState`), in the file's ES5-ish `Object.assign` idiom:
   ```js
         case 'setProviders':
           return Object.assign({}, state, {
             providers: msg.groups.slice(),
             selection: msg.selection,
           });
   ```
   `.slice()` is the mirror of `[...msg.groups]`; `selection` is assigned unchanged so a `null` stays `null` and an object stays the same reference. Do not normalize, default or omit `selection` here — a `msg.selection ?? undefined` would make the mirror state differ from the TS state under `deepStrictEqual` (a present key with value `undefined` is distinct from `null`).

   3. Leave the `default:` branch (return state unchanged) alone. The file's header comment already names webviewProtocol.ts as the source of truth; no new comment is required beyond a one-line note if the surrounding cases carry one (they do not).

   Files: `media/protocol.js`

5. Add setProviders fixture cases and update the seed helper

   In test/fixtures/protocolCases.ts:

   1. Import the new types: extend the existing `import type { ... } from '../../src/orchestrator/webviewProtocol';` with `ProviderGroup` (and `ProviderModelItem` if used directly).

   2. Update `seed()` — the deliberately hand-written state literal — to include `providers: []` and `selection: null` before the `...over` spread. Without this every existing case fails the mirror `deepStrictEqual`, and that is the intended seed-drift guard.

   3. Add a small helper next to `ask()`:
   ```ts
   /** A minimal provider group, overridable per field. */
   export function group(over: Partial<ProviderGroup> = {}): ProviderGroup {
     return { id: 'google', label: 'Google AI Studio', enabled: true, models: [{ id: 'gemini-2.5-pro' }], ...over };
   }
   ```

   4. Append these cases (continuing the numbered-comment convention, starting at (37)):
   - 'setProviders sets groups and the active selection': one message with all five groups in catalog order — `copilot` enabled with `[{ id: 'gpt-4o', label: 'GPT-4o' }]`, `google` enabled, `opencode` disabled with `reason: 'Set an API key for OpenCode Go to use it.'` and `models: []`, `mistral` enabled, `openai` disabled with `reason: 'Set baiton.orchestrator.endpoint to use OpenAI / Custom.'` — and `selection: { provider: 'google', model: 'gemini-2.5-pro' }`.
   - 'setProviders with a null selection': `groups: [group()]`, `selection: null`.
   - 'setProviders with no groups at all': `groups: []`, `selection: null`.
   - 'setProviders replaces a previously set list': `state: seed({ providers: [group({ id: 'mistral', label: 'Mistral AI' })], selection: { provider: 'mistral', model: 'mistral-large-latest' } })`, one `setProviders` with a different single group and a different selection.
   - 'setProviders keeps records, busy and auto mode': `state: seed({ records: [{ role: 'user', content: 'hi' }], busy: true, autoMode: true })` plus one `setProviders`.
   - 'interleaved setProviders, empty state and streaming': a multi-message case — `setProviders` (disabled copilot with a reason), `setEmptyState`, `streamDelta`, `setProviders` again with a new selection — so the fold covers ordering and the purity check in the mirror suite has a multi-message candidate that touches the new fields.

   Every `messages` entry must be a valid `HostToWebview` variant (the fixture header says so): `selectModel` is webview→host and must NOT appear here.

   Files: `test/fixtures/protocolCases.ts`

6. Cover setProviders and selectModel in the reducer unit test

   In test/webviewProtocol.reducer.test.ts, extend the import list with `ProviderGroup`, `ModelSelection` (from '../src/orchestrator/webviewProtocol' — re-export it there if it is only imported as a type, otherwise import `ModelSelection` from '../src/orchestrator/providers') and `WebviewToHost`. Add a `describe('provider selection', ...)` block near the `setAutoMode` test with:

   - 'a fresh state has no providers and no selection': `initialWebviewState().providers` deep-equals `[]` and `.selection` is `null`.
   - 'setProviders sets the groups and the selection': build `const groups: ProviderGroup[] = [...]` with one enabled and one disabled group (the disabled one carrying `reason`), reduce with `{ type: 'setProviders', groups, selection: { provider: 'google', model: 'gemini-2.5-pro' } }`, assert `next.providers` deep-equals `groups`, `assert.notStrictEqual(next.providers, groups)` (copied, not aliased, mirroring the `setConversations` test), and the selection deep-equals the pair.
   - 'setProviders with a null selection clears the active pair': seed a state with a selection, reduce with `selection: null`, assert `next.selection === null`.
   - 'setProviders replaces the previous groups': assert the second reduce's `providers` equals only the new groups.
   - 'setProviders leaves the rest of the state alone': records, busy, autoMode, activeId and `empty` unchanged (in particular `setProviders` must NOT clear `empty`).
   - 'setProviders does not mutate its input state': deep-equal the input against a pre-reduce clone.
   - 'selectModel carries the provider and the model': `const msg: WebviewToHost = { type: 'selectModel', provider: 'mistral', model: 'codestral-latest' };` then assert the three fields — a compile-time check that the variant exists with these field names, in the same spirit as the existing message-shape assertions.

   No change is needed to test/webviewProtocol.mirror.test.ts itself: it folds `PROTOCOL_CASES` and compares `initialWebviewState()`, so the new cases and the new seed keys are picked up automatically. Only touch it if a helper import is needed.

   Files: `test/webviewProtocol.reducer.test.ts`, `test/webviewProtocol.mirror.test.ts`

7. Verify

   Run, from the repo root: `npx tsc --noEmit -p tsconfig.json` (must be clean; the `assertNever` guard catches a missing case), `npx eslint src test --ext .ts` (the only acceptable finding is the pre-existing no-unused-vars warning on `_legacy` in webviewProtocol.ts), `npx mocha test/webviewProtocol.reducer.test.ts test/webviewProtocol.mirror.test.ts`, and finally `npm run test:unit` (was 1170 passing / 1 pending before this todo; expect that plus the new cases). media/ is not in the tsconfig `include`, so protocol.js is not type-checked — the mirror test is its only guard; do not skip it.

   Files: (none)

## Risks

- Adding required `providers` / `selection` fields to WebviewState makes every existing state literal incomplete. The two that must be updated are `initialWebviewState()` (both files) and `seed()` in test/fixtures/protocolCases.ts; other tests build states with `...initialWebviewState()` and are unaffected. If tsc reports more literals, fill them in rather than making the fields optional — optional fields would let the mirror and the core drift silently.
- The mirror suite compares the whole state with deepStrictEqual, where a present key holding `undefined` differs from `null` and from an absent key. Keep `selection: msg.selection` verbatim in both reducers and `selection: null` in both seeds; any normalization on one side breaks parity.
- Key order inside the seed object does not affect deepStrictEqual, but a missing key does — add both keys to media/protocol.js's `initialWebviewState` in the same edit as the TypeScript one.
- `selectModel` is added to WebviewToHost but nothing handles it yet: `ChatController.handle` has no exhaustive default, so the message is silently dropped at runtime until the controller/router todo wires it. This is expected for this todo; do not add a handler here.
- The empty state still carries `endpoint`/`model` (`setEmptyState`). This todo deliberately does not rename those fields; the webview can render provider + model from `state.selection` and `state.providers` instead, so the empty-state rewording stays a webview-todo concern and no host caller of `setEmptyState` has to change.
- Importing `ProviderId`/`ModelSelection` from './providers' into webviewProtocol.ts must stay a `import type` — a value import would still be host-free, but the type-only form keeps the protocol core's zero-runtime-dependency property that its header comment claims.
- Disabled groups should carry `models: []` in the fixtures; if a later todo decides disabled providers still list their catalog models, only the fixtures change, not the contract.

## Acceptance

- src/orchestrator/webviewProtocol.ts exports `ProviderGroup` and `ProviderModelItem`, the `HostToWebview` variant `{ type: 'setProviders'; groups: ProviderGroup[]; selection: ModelSelection | null }` and the `WebviewToHost` variant `{ type: 'selectModel'; provider: ProviderId; model: string }`, with `ProviderId`/`ModelSelection` imported as types from './providers'.
- `WebviewState` has required `providers: ProviderGroup[]` and `selection: ModelSelection | null`; `initialWebviewState()` seeds them as `[]` and `null` in both src/orchestrator/webviewProtocol.ts and media/protocol.js.
- `reduce` handles `setProviders` by shallow-copying `groups` and storing `selection` unchanged, leaving records, busy, autoMode, conversations, sessions, error and `empty` untouched, and never mutating its input.
- media/protocol.js has the matching `case 'setProviders'` using `msg.groups.slice()` and `msg.selection`, in the same switch position as the TypeScript core.
- test/fixtures/protocolCases.ts `seed()` includes the two new keys and PROTOCOL_CASES contains at least six new `setProviders` cases: full five-group list with a selection, null selection, empty groups, replacing a previous list, preserving unrelated state, and a multi-message interleaving with setEmptyState/streamDelta.
- test/webviewProtocol.reducer.test.ts asserts the seed defaults, the copied-not-aliased groups array, null-selection handling, replacement, non-interference with the rest of the state, input purity, and the `selectModel` message shape.
- `npx tsc --noEmit -p tsconfig.json` is clean, `npx eslint src test --ext .ts` reports nothing new beyond the pre-existing `_legacy` warning, and `npm run test:unit` is green including webviewProtocol.mirror.test.ts (mirror parity over every new case and the seed).
