# Plan P03

## Steps

1. Strip the legacy handler and migration from setApiKey.ts

   In src/activation/setApiKey.ts:
   - Delete the exports API_KEY_SECRET (L39), API_KEY_PROMPT (L42), API_KEY_SAVED_MESSAGE (L45), API_KEY_NO_VALUE_MESSAGE (L48) and API_KEY_SAVE_FAILED_MESSAGE (L51), with their doc comments.
   - Delete the whole `export async function setOrchestratorApiKey(secrets)` (L53-101) and its JSDoc.
   - Delete the trailing block from L388 to the end of the file: `LEGACY_MIGRATION_FLAG` ('baiton.orchestrator.keyMigrated'), the private `interface MementoLike`, and `export async function migrateLegacyApiKey(secrets, memento)` with its JSDoc.
   - Remove `LEGACY_API_KEY_SECRET` from the `import { ... } from '../orchestrator/providers'` list. Keep `providerCatalog`, `providerInfo` and `providerSecretKey`, which are still used.
   - The `// --- per-provider key management ... ---` divider can stay or go. Everything from PROVIDER_PICK_TITLE through the end of setProviderApiKey stays byte-identical: PROVIDER_KEY_SET_DETAIL/MISSING_DETAIL, providerKeyPrompt, providerKeySavedMessage, providerKeyClearedMessage, providerKeySaveFailedMessage, PROVIDER_KEY_NO_VALUE_MESSAGE, notifyChanged, SetProviderApiKeyOptions, isKeyedProvider, ProviderKeyGroup, providerKeyGroups, providerKeyLabel, resolveCatalog and setProviderApiKey.
   - Rewrite the module doc comment (L1-24) so it describes only the per-provider flow and drops any mention of the single orchestrator key or `baiton.orchestrator.apiKey`. Suggested wording: "The `Baiton: Set Provider API Key` command handler (`baiton.setProviderApiKey`). Thin `vscode` glue that sets or clears one provider's API key in VS Code SecretStorage under its `baiton.orchestrator.key.<id>` slot, using a masked input. It offers the keyed providers of the live catalog (the builtins plus every models.dev-derived provider), and providers aliased onto one slot appear as a single item. It never reveals a stored value; only ids, labels and a set/not-set marker reach the quick pick. Ending behaviours: cancel leaves the key unchanged with no message; an empty submit clears an existing key or warns that nothing was provided; a write or delete failure leaves the previous value and shows an error."

   Files: `src/activation/setApiKey.ts`

2. Drop the alias command and the activation migration gate in commands.ts

   In src/activation/commands.ts:
   - L195: change `import { migrateLegacyApiKey, setProviderApiKey } from './setApiKey';` to `import { setProviderApiKey } from './setApiKey';`.
   - L242: delete the `setApiKey: 'baiton.setOrchestratorApiKey',` entry from the `COMMANDS` object. First grep src/ and test/ for `COMMANDS.setApiKey`. The only known use is L1194; remove any other you find.
   - L403-406: delete the 3-line comment ("One-time migration of the pre-multi-provider single-key secret ...") and `const legacyMigration = migrateLegacyApiKey(context.secrets, context.globalState);`.
   - L867-870: replace `void legacyMigration.then(() => router.init()).then(() => router.refresh());` with `void router.init().then(() => router.refresh());`. Reword the comment above it to drop "once the legacy key has landed in the `openai` slot", e.g. "Restore the persisted selection (or pick the first usable provider), then fire one change so a Chat view that resolved first repaints its dropdown." Keep the init-then-refresh ordering: refresh still runs only after init resolves.
   - L1193-1194: delete the `// Kept as an alias so existing key bindings and the README keep working.` comment and the `vscode.commands.registerCommand(COMMANDS.setApiKey, () => promptProviderKey()),` line. Leave the setProviderApiKey and setProviderEndpoint registrations as they are.
   - Module doc comment L33-35: remove the clause "`baiton.setOrchestratorApiKey` is kept as an alias of it for existing key bindings" and end the setProviderApiKey bullet cleanly, keeping the "(Req 17)" tag after "refreshes the Provider & Model dropdown".
   - Leave `triggerFix`, `FixAction` and `promptProviderKey` alone.
   - Check that `context.globalState` is still referenced elsewhere in registerCommands if any linter rule cares. No change is expected, because `context` is used broadly.

   Files: `src/activation/commands.ts`

3. Remove LEGACY_API_KEY_SECRET from providers.ts and reword the providerRouter comment

   - src/orchestrator/providers.ts L455-461: delete the JSDoc ("The pre-multi-provider single-key secret, written by `setOrchestratorApiKey` ...") and `export const LEGACY_API_KEY_SECRET = 'baiton.orchestrator.apiKey';`. Grep src/ to confirm nothing else imports it. setApiKey.ts was the only consumer, and step 1 removes that import.
   - src/activation/providerRouter.ts ~L519-520: in the `init()` JSDoc, replace "activation must not break here (matching `migrateLegacyApiKey`)." with "activation must not break here." Change nothing else in that file. In particular, keep the exported `MementoLike` interface in providerRouter.ts: it is a different symbol from the one deleted in setApiKey.ts, and test/providerRouter.test.ts and test/modelSelectorRefresh.test.ts use it.
   - Optional comment-only tidy, outside the phase file list but harmless: src/activation/chatController.ts L257 says `setApiKey` "invokes the Set Orchestrator API Key command". Reword it to "opens the per-provider API key prompt". None of the grep-gated identifiers appear in that file, so skipping it is fine.

   Files: `src/orchestrator/providers.ts`, `src/activation/providerRouter.ts`

4. Remove the command contribution from package.json

   In package.json:
   - Delete the `contributes.commands` object `{ "command": "baiton.setOrchestratorApiKey", "title": "Set Orchestrator API Key", "category": "Baiton" }` (~L87-91).
   - Delete the `menus.commandPalette` object `{ "command": "baiton.setOrchestratorApiKey", "when": "baiton.activated" }` (~L243-246).
   - Keep the JSON valid: no trailing commas, and the neighbouring entries stay intact. Add nothing.

   Files: `package.json`

5. Delete the legacy suites from test/setApiKey.test.ts and move the loader registration

   In test/setApiKey.test.ts:
   - Module-binding block (~L152-166): delete the `let` lines for setOrchestratorApiKey, migrateLegacyApiKey, LEGACY_MIGRATION_FLAG, API_KEY_SECRET, API_KEY_SAVED_MESSAGE, API_KEY_NO_VALUE_MESSAGE and API_KEY_SAVE_FAILED_MESSAGE. Keep setProviderApiKey, PROVIDER_KEY_NO_VALUE_MESSAGE, PROVIDER_KEY_SET_DETAIL, PROVIDER_KEY_MISSING_DETAIL, providerKeySavedMessage, providerKeyClearedMessage and providerKeySaveFailedMessage.
   - Static import from '../src/orchestrator/providers' (~L169-174): drop `LEGACY_API_KEY_SECRET` and keep providerCatalog, providerInfo and providerSecretKey.
   - Delete `class FakeMemento` (~L213-227) and `asMemento` (~L229-232), which only the migration suite uses.
   - Delete the whole `describe('setOrchestratorApiKey', ...)` suite (L234-376). Its `before()` is what registers the vscode loader hook: the `register(loaderUrl, ...)` call plus `await import('./fixtures/vscodeLoader.mjs')`. Move that hook code, with its explanatory comment, into the `before()` of the first remaining suite, `describe('setProviderApiKey', ...)` (~L378). That `before()` should register the loader, dynamically import '../src/activation/setApiKey', and assign setProviderApiKey, PROVIDER_KEY_NO_VALUE_MESSAGE, PROVIDER_KEY_SET_DETAIL, PROVIDER_KEY_MISSING_DETAIL, providerKeySavedMessage, providerKeyClearedMessage and providerKeySaveFailedMessage, which the deleted suite used to assign. Update its comment, which currently says "The module is already loaded by the earlier suite's hook". The later suites ('setProviderApiKey shared OpenCode key', 'onChanged notification', 'catalog-driven quick pick') keep their own re-import `before()`s unchanged.
   - Delete the whole `describe('migrateLegacyApiKey', ...)` suite (~L950 to end of file).
   - Rewrite the file header comment (L6-27) to describe the per-provider handler `setProviderApiKey` (masked input, per-provider `baiton.orchestrator.key.<id>` slot, cancel/empty/clear/failure paths, quick pick over the live catalog). Keep the explanation of the loader/fake harness, and remove mentions of `setOrchestratorApiKey` and `baiton.orchestrator.apiKey`.
   - Make sure the remaining imports (`register`, `pathToFileURL`, `join`) are still used; they are, by the moved hook code. Check that no unused-variable lint error is left, e.g. a now-unused helper type.

   Files: `test/setApiKey.test.ts`

6. Drop the LEGACY_API_KEY_SECRET assertions from test/providers.test.ts

   In test/providers.test.ts:
   - Remove `LEGACY_API_KEY_SECRET,` from the import list (L7).
   - ~L209-211 (per-provider keys distinct test): replace `assert.notStrictEqual(key, LEGACY_API_KEY_SECRET);` with `assert.notStrictEqual(key, 'baiton.orchestrator.apiKey');`, restating the guarantee against the literal. Alternatively, remove the loop.
   - ~L255-259: delete the `describe('legacy key', ...)` block whose only test pins `LEGACY_API_KEY_SECRET === 'baiton.orchestrator.apiKey'`.
   - ~L616-621 ('blank ids get no key, and no key is the legacy secret'): replace `LEGACY_API_KEY_SECRET` with the literal `'baiton.orchestrator.apiKey'` and keep the test title. Alternatively, drop the loop and retitle it 'blank ids get no key'.

   Files: `test/providers.test.ts`

7. Update the vscodeFake header comment

   test/fixtures/vscodeFake.mjs L6-7: change "glue code such as `setOrchestratorApiKey` and `configPanel` can be exercised without a host" to name `setProviderApiKey` instead, e.g. "glue code such as `setProviderApiKey`, `setProviderEndpoint` and `configPanel` can be exercised without a host." This is a comment-only change.

   Files: `test/fixtures/vscodeFake.mjs`

8. Verify build, lint, tests and the removal grep

   - Run `npm run compile` (tsc -p ./), `npm run lint` and `npm test`. All must pass.
   - Then grep src/, test/, media/ and package.json for `setOrchestratorApiKey|LEGACY_API_KEY_SECRET|migrateLegacyApiKey|keyMigrated|API_KEY_SECRET|LEGACY_MIGRATION_FLAG`. It must return nothing.
   - README.md (L670-675) still names these identifiers. The README is not in this phase's file list; its *Per-provider API keys* rewrite belongs to the README/docs work. Do not edit it here unless the phase-list owner says so. Report the leftover README hits in the execution summary so the README phase picks them up.

   Files: (none)

## Risks

- Deleting the `setOrchestratorApiKey` suite also deletes the only `register(loaderUrl, ...)` call in test/setApiKey.test.ts. If the hook is not moved into the first remaining suite's before(), importing setApiKey.ts resolves the real `vscode` specifier and every setProviderApiKey suite fails. This only stays hidden if another test file registered the hook first in the same mocha process, which is order-dependent and must not be relied on.
- providerRouter.ts exports its own `MementoLike`, which test/providerRouter.test.ts and test/modelSelectorRefresh.test.ts import. Only the private `MementoLike` in setApiKey.ts is deleted. A blanket delete-by-name would break those tests.
- Changing `legacyMigration.then(() => router.init()).then(() => router.refresh())` must keep refresh chained after init (`router.init().then(() => router.refresh())`). Running them concurrently would change the first-paint behaviour the gating/model-selector tests may rely on.
- Unrelated `setApiKey` identifiers (FixAction 'setApiKey', triggerFix, chat.js, protocol fixtures) must not be touched. Only the `COMMANDS.setApiKey` key is removed.
- README.md still mentions `baiton.setOrchestratorApiKey`, `migrateLegacyApiKey` and `keyMigrated` until the README phase runs. The grep-empty guarantee over README.md is only fully met once that phase lands.
- package.json edits can leave a trailing comma or break JSON. The activation.gating tests parse package.json, so a malformed file fails many suites at once.

## Acceptance

- `npm run compile` succeeds with no TypeScript errors.
- `npm run lint` reports no errors (no unused imports or variables left in setApiKey.ts, commands.ts, setApiKey.test.ts or providers.test.ts).
- `npm test` (full mocha suite, including test/setApiKey.test.ts, test/providers.test.ts, test/activation.gating.test.ts, test/configPanel.mirror.test.ts and the property tests) passes.
- A grep over src/, test/, media/ and package.json for setOrchestratorApiKey, LEGACY_API_KEY_SECRET, migrateLegacyApiKey, keyMigrated, API_KEY_SECRET and LEGACY_MIGRATION_FLAG returns no matches.
- package.json no longer lists `baiton.setOrchestratorApiKey` in contributes.commands or menus.commandPalette. `baiton.setProviderApiKey` and `baiton.setProviderEndpoint` entries are unchanged.
- commands.ts no longer registers an alias command. `COMMANDS` has no `setApiKey` key. Activation calls `router.init()` then `router.refresh()` directly, with no migration promise in front.
- setApiKey.ts exports only the per-provider API (PROVIDER_* constants, providerKey* helpers, SetProviderApiKeyOptions, ProviderKeyGroup, providerKeyGroups, providerKeyLabel, setProviderApiKey). Its module doc comment describes only the per-provider flow and does not mention `baiton.orchestrator.apiKey`.
- No production code reads or writes the 'baiton.orchestrator.apiKey' secret or the 'baiton.orchestrator.keyMigrated' globalState flag.
