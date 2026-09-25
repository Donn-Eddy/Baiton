# Plan T05

## Steps

1. Rewrite src/activation/setApiKey.ts around the provider catalog

   Keep every existing export byte-identical so the alias path and the current tests keep passing: `API_KEY_SECRET = 'baiton.orchestrator.apiKey'`, `API_KEY_PROMPT`, `API_KEY_SAVED_MESSAGE`, `API_KEY_NO_VALUE_MESSAGE`, `API_KEY_SAVE_FAILED_MESSAGE`, and the `setOrchestratorApiKey(secrets)` function itself (it stays as-is; nothing else calls it after this todo, but it is the documented single-key handler and its 8 existing tests must stay green).

   Add, in the same file:

   1. Imports (type-only where possible) from '../orchestrator/providers': `providerCatalog`, `providerInfo`, `providerSecretKey`, `LEGACY_API_KEY_SECRET`, and `type ProviderId`. Import the module path directly (`../orchestrator/providers`), NOT the `../orchestrator` barrel — the barrel pulls in host-touching modules and this file is loaded by the vscode-fake test loader.

   2. Message/label constants (exported so the tests assert on them rather than on literals):
      - `PROVIDER_PICK_TITLE = 'Select the provider whose API key to set'`
      - `PROVIDER_KEY_SET_DETAIL = 'API key set'` and `PROVIDER_KEY_MISSING_DETAIL = 'No API key set'` (the quick-pick item `description`).
      - `providerKeyPrompt(label: string): string` → `` `Enter your ${label} API key (submit an empty value to clear it)` ``.
      - `providerKeySavedMessage(label: string): string` → `` `Baiton: the ${label} API key was saved.` ``
      - `providerKeyClearedMessage(label: string): string` → `` `Baiton: the ${label} API key was cleared.` ``
      - `providerKeySaveFailedMessage(label: string): string` → `` `Baiton: the ${label} API key could not be saved.` ``
      - `PROVIDER_KEY_NO_VALUE_MESSAGE = 'Baiton: no value provided; the API key was left unchanged.'` (shown on an empty submit when there was nothing to clear).

   3. `export async function setProviderApiKey(secrets: vscode.SecretStorage, providerId?: ProviderId): Promise<void>`:
      - Build the candidate list as `providerCatalog().filter((p) => p.requiresKey)` — that is google, opencode, mistral, openai in catalog order; `copilot` is excluded because `providerSecretKey('copilot')` is undefined (it needs no key).
      - When `providerId` is supplied and keyed, skip the pick and use it (this is the seam the webview's "Set API key…" affordance will call in a later todo; it also keeps the tests from having to drive the quick-pick for every case).
      - Otherwise call `vscode.window.showQuickPick(items, { title: PROVIDER_PICK_TITLE, placeHolder: PROVIDER_PICK_TITLE, ignoreFocusOut: true })` where each item is `{ label: info.label, description: <detail>, id: info.id }` and `<detail>` is `PROVIDER_KEY_SET_DETAIL` when `await secrets.get(providerSecretKey(info.id)!)` is a non-empty string, else `PROVIDER_KEY_MISSING_DETAIL`. Read every existing key before showing the pick (one `Promise.all` over the candidates). A dismissed pick (`undefined`) returns immediately with no message and no store/delete.
      - Then `const key = providerSecretKey(picked.id)!;` and `const label = providerInfo(picked.id).label;` and `vscode.window.showInputBox({ prompt: providerKeyPrompt(label), password: true, ignoreFocusOut: true })`.
      - Cancel (`undefined`): return, no message, no write (mirrors Req 17.5).
      - Empty / whitespace-only submit: if a key is currently stored, `await secrets.delete(key)` and show `providerKeyClearedMessage(label)` as an information message; if nothing is stored, show `PROVIDER_KEY_NO_VALUE_MESSAGE` as a warning and write nothing. Wrap the delete in try/catch and surface `providerKeySaveFailedMessage(label)` on throw.
      - Non-empty submit: `await secrets.store(key, input.trim())` inside try/catch; on success show `providerKeySavedMessage(label)` (information), on throw show `providerKeySaveFailedMessage(label)` (error) and do not confirm. Neither message may ever contain the key value.

   4. `export const LEGACY_MIGRATION_FLAG = 'baiton.orchestrator.keyMigrated';` and
      `export async function migrateLegacyApiKey(secrets: vscode.SecretStorage, memento: { get<T>(key: string): T | undefined; update(key: string, value: unknown): Thenable<void> }): Promise<boolean>`:
      - Return `false` immediately when `memento.get<boolean>(LEGACY_MIGRATION_FLAG) === true`.
      - Read `await secrets.get(LEGACY_API_KEY_SECRET)`. If it is undefined or whitespace-only, set the flag to `true` and return `false` (nothing to migrate; never look again).
      - Read `await secrets.get(providerSecretKey('openai')!)`. If that already holds a non-empty value, set the flag and return `false` (never clobber a key the user set per-provider).
      - Otherwise `await secrets.store(providerSecretKey('openai')!, legacy.trim())`, set the flag, return `true`.
      - Do NOT delete the legacy secret: `buildModelClient` in commands.ts still reads `'baiton.orchestrator.apiKey'` until the ProviderRouter replaces it in a later todo, and deleting it here would break the live chat path mid-spec. The `globalState` flag, not the delete, is what makes the migration run once.
      - Wrap the whole body in try/catch and return `false` on any throw — a SecretStorage failure at activation must never break activation. Do not surface a message; the caller logs nothing.

   Files: `src/activation/setApiKey.ts`

2. Wire the new command and the migration into registerCommands

   In src/activation/commands.ts:

   1. Change the import at line 124 from `import { setOrchestratorApiKey } from './setApiKey';` to `import { migrateLegacyApiKey, setProviderApiKey } from './setApiKey';` (drop the now-unused `setOrchestratorApiKey` import — eslint's no-unused-vars will flag it otherwise).

   2. In the `COMMANDS` object (line ~148) keep `setApiKey: 'baiton.setOrchestratorApiKey'` exactly as-is and add `setProviderApiKey: 'baiton.setProviderApiKey'`. Update the doc comment block at line ~27 that lists `baiton.setOrchestratorApiKey` to mention that it is now an alias of `baiton.setProviderApiKey`.

   3. In the registration block at lines ~675-682, replace the single `registerCommand(COMMANDS.setApiKey, () => setOrchestratorApiKey(context.secrets))` with two registrations bound to the same handler:
   ```ts
   vscode.commands.registerCommand(COMMANDS.setProviderApiKey, () =>
     setProviderApiKey(context.secrets),
   ),
   // Kept as an alias so existing key bindings and the README keep working.
   vscode.commands.registerCommand(COMMANDS.setApiKey, () =>
     setProviderApiKey(context.secrets),
   ),
   ```
   Both ids must stay registered; VS Code throws on a duplicate id, so register each exactly once.

   4. Run the migration once per activation, near the top of `registerCommands` (right after `const disposables: vscode.Disposable[] = [];`, before any command registration), fire-and-forget so activation is not delayed:
   ```ts
   // One-time migration of the pre-multi-provider single-key secret into the
   // `openai` slot; gated by a globalState flag so it runs at most once.
   void migrateLegacyApiKey(context.secrets, context.globalState);
   ```

   5. Point the inline-error fix action at the new command: in `triggerFix` (line ~1625) change `void vscode.commands.executeCommand(COMMANDS.setApiKey)` to `COMMANDS.setProviderApiKey`. The webview's `'setApiKey'` action string is unchanged — only the command it dispatches to moves.

   Do NOT touch `buildModelClient` (line ~1670) in this todo; it keeps reading the legacy secret until the ProviderRouter replaces it.

   Files: `src/activation/commands.ts`

3. Contribute baiton.setProviderApiKey in package.json

   Two edits, both preserving the existing `baiton.setOrchestratorApiKey` entries verbatim (the alias must stay visible for existing key bindings):

   1. In `contributes.commands` (the array starting at line 60), immediately after the `baiton.setOrchestratorApiKey` object (lines 76-80), add:
   ```json
   {
     "command": "baiton.setProviderApiKey",
     "title": "Set Provider API Key",
     "category": "Baiton"
   }
   ```

   2. In `contributes.menus.commandPalette`, immediately after the `baiton.setOrchestratorApiKey` entry (lines 187-190), add:
   ```json
   {
     "command": "baiton.setProviderApiKey",
     "when": "baiton.activated"
   }
   ```

   Keep the file's 2-space indentation and trailing-comma-free JSON. Note that test/activation.gating.test.ts parses this file at the repo root, so it must remain valid JSON.

   Files: `package.json`

4. Teach the vscode fake to show a quick pick

   test/fixtures/vscodeFake.mjs currently exports no `showQuickPick`, so `setProviderApiKey` cannot be exercised through the existing loader. Add one delegating member to the `window` export, alongside the existing `showInputBox`:
   ```js
   showQuickPick: (items, options) => fake().window.showQuickPick(items, options),
   ```
   That is the only change to the fixture — it stays stateless and delegates to `globalThis.__vscodeFake`, exactly like every other member. Do not add state or defaults here; the per-test fake in setApiKey.test.ts supplies the behaviour.

   Files: `test/fixtures/vscodeFake.mjs`

5. Extend test/setApiKey.test.ts with the provider-key and migration suites

   Keep the existing `describe('setOrchestratorApiKey (Task 13.3)')` block and its 8 tests untouched — they are the alias/back-compat guarantee.

   Extend the shared harness:
   - Add to the `VscodeFake` interface and `makeVscodeFake()`: `quickPickResult: unknown` (what the next `showQuickPick` resolves with, default `undefined` = dismissed), `lastQuickPickItems: ReadonlyArray<{ label: string; description?: string; id?: string }> | undefined`, `lastQuickPickOptions: { title?: string; placeHolder?: string } | undefined`, `quickPickCalls: number`, and `window.showQuickPick(items, options)` recording all of those and resolving `quickPickResult`.
   - Reuse `FakeSecretStorage` and add a `deleteCalls: string[]` array plus a `failDelete` flag; `delete(key)` pushes the key and throws when `failDelete` is set.
   - In the `before` hook, also pull `setProviderApiKey`, `migrateLegacyApiKey`, `LEGACY_MIGRATION_FLAG` and the new message helpers off the loaded module, and import `providerSecretKey`, `LEGACY_API_KEY_SECRET`, `providerInfo` from '../src/orchestrator/providers' (a plain static import is fine — that module has no `vscode` import).
   - Add a tiny `FakeMemento` with a `Map`, `get<T>(key)` and `update(key, value)` returning `Promise.resolve()`, recording `updates: Array<{ key: string; value: unknown }>`.

   New `describe('setProviderApiKey')` cases:
   1. Quick-pick contents: with `baiton.orchestrator.key.google` pre-seeded, calling with no provider argument shows exactly four items — Google AI Studio, OpenCode Go, Mistral AI, OpenAI / Custom, in that order, labelled from `providerInfo(id).label` — and NO GitHub Copilot item (it needs no key). The google item's `description` is `PROVIDER_KEY_SET_DETAIL`; the other three carry `PROVIDER_KEY_MISSING_DETAIL`.
   2. Dismissed quick pick (`quickPickResult = undefined`): no input box is shown, no store, no delete, no message.
   3. Explicit provider argument (`setProviderApiKey(secrets, 'mistral')`): `quickPickCalls === 0` and the input box is shown once.
   4. Masked prompt: `lastInputOptions.password === true` and the prompt contains the picked provider's label.
   5. Successful set: picking `mistral` and submitting `'  mk-abc  '` stores `'mk-abc'` under `providerSecretKey('mistral')` (assert the literal `'baiton.orchestrator.key.mistral'` too, so a catalog rename is caught), shows exactly one info message equal to `providerKeySavedMessage('Mistral AI')`, and that message does not contain `'mk-abc'`.
   6. Per-provider isolation: setting the google key leaves a pre-seeded `baiton.orchestrator.key.mistral` untouched.
   7. Clear: with a key stored for google, an empty submit calls `secrets.delete('baiton.orchestrator.key.google')` exactly once, removes the value, shows `providerKeyClearedMessage('Google AI Studio')`, and performs no `store`.
   8. Empty submit with nothing stored: no delete, no store, exactly one warning equal to `PROVIDER_KEY_NO_VALUE_MESSAGE`.
   9. Input-box cancel (`inputResult = undefined`) after a successful pick: no store, no delete, no message, and a pre-seeded key is unchanged.
   10. Store failure (`failStore`): a pre-seeded value is unchanged, exactly one error equal to `providerKeySaveFailedMessage(label)`, no saved confirmation.

   New `describe('migrateLegacyApiKey')` cases:
   11. Copies a legacy `baiton.orchestrator.apiKey` into `baiton.orchestrator.key.openai`, returns `true`, sets `LEGACY_MIGRATION_FLAG` to `true` in the memento, and LEAVES the legacy secret in place.
   12. Runs at most once: a second call with the flag already set returns `false`, performs no store, and does not overwrite an openai key changed in between.
   13. Does not clobber: with both the legacy secret and a non-empty openai key present, returns `false`, the openai key keeps its value, and the flag is still set.
   14. No legacy secret: returns `false`, no store, flag set (so the read never repeats).
   15. Whitespace-only legacy secret is treated as absent: returns `false`, no store.
   16. A throwing SecretStorage (`failStore`, or a `get` that rejects) makes the call resolve `false` rather than reject.

   Every new test must run against the same `vscodeLoader.mjs`/`vscodeFake.mjs` redirect the file already registers in its `before` hook — do not add a second `register()` call.

   Files: `test/setApiKey.test.ts`, `test/fixtures/vscodeFake.mjs`

## Risks

- Deleting the legacy `baiton.orchestrator.apiKey` secret during migration would break the still-live `buildModelClient` in commands.ts (line ~1679), which reads that exact key until the ProviderRouter lands in a later todo. The plan deliberately copies without deleting and gates re-running on a globalState flag.
- `baiton.setOrchestratorApiKey` must stay registered exactly once and keep its package.json contribution; VS Code throws `command already exists` if an id is registered twice, and removing it would break existing key bindings and README line 486.
- test/fixtures/vscodeFake.mjs has no `showQuickPick`, so the new handler is untestable until that one member is added; forgetting it produces a confusing `undefined is not a function` inside the fake rather than a clear failure.
- Importing the provider catalog through the `../orchestrator` barrel instead of `../orchestrator/providers` would drag host-touching modules into the fake-loaded test graph and can fail at import time.
- `setOrchestratorApiKey` becomes unreferenced by commands.ts; leaving the stale import in place trips the repo's eslint no-unused-vars, while deleting the exported function itself would break the 8 existing tests. Keep the export, drop only the import.
- Treating an empty submit as 'clear' diverges from the legacy handler's 'leave unchanged' semantics. It is the behaviour the overview asks for ('set or clear with a masked input'), so the prompt text must say so explicitly and the no-key case must still fall back to the no-value warning.
- package.json is parsed by test/activation.gating.test.ts; a malformed edit fails tests far from this todo.

## Acceptance

- `npx tsc --noEmit -p tsconfig.json` is clean.
- `npx eslint src/activation/setApiKey.ts src/activation/commands.ts test/setApiKey.test.ts --ext .ts` reports no new findings (the pre-existing no-unused-vars warning in webviewProtocol.ts is untouched and expected).
- `npx mocha test/setApiKey.test.ts` is green, including all 8 pre-existing `setOrchestratorApiKey` tests unmodified plus the new setProviderApiKey and migrateLegacyApiKey groups.
- `npm run test:unit` is green with no regression against the 1170-passing baseline from T01.
- `node -e "JSON.parse(require('fs').readFileSync('package.json','utf8'))"` succeeds and the parsed `contributes.commands` contains both `baiton.setProviderApiKey` (title 'Set Provider API Key') and `baiton.setOrchestratorApiKey`; `contributes.menus.commandPalette` gates both on `baiton.activated`.
- `grep -n "setProviderApiKey\|setApiKey" src/activation/commands.ts` shows both ids registered exactly once each, both bound to `setProviderApiKey(context.secrets)`, and `triggerFix` dispatching to `COMMANDS.setProviderApiKey`.
- The quick pick offers only the four keyed providers in catalog order (google, opencode, mistral, openai) and never GitHub Copilot, and each key is written under `baiton.orchestrator.key.<provider>`.
- No message produced by any path contains the key value, and the legacy `baiton.orchestrator.apiKey` secret still exists after a migration.
