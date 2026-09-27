# Plan T12

## Steps

1. Add a catalog seam to setProviderApiKey (options parameter)

   In src/activation/setApiKey.ts, widen the import from '../orchestrator/providers' to also bring in `providerCatalog` (already imported), `providerInfo`, `providerSecretKey` (already imported) and the TYPE `ProviderInfo` (add `ProviderInfo` to the existing `import type { ProviderId } ...` line).

   Add, just above `setProviderApiKey`:

   ```ts
   /** Extra, optional wiring for {@link setProviderApiKey}. */
   export interface SetProviderApiKeyOptions {
     /**
      * The live provider catalog to offer, read at call time so a models.dev
      * refresh that landed after activation is picked up. Host glue passes
      * `() => providerCatalog(feed)`. Absent, throwing, undefined-returning or
      * carrying no keyed provider all fall back to the builtin catalog, so the
      * command works in an offline window exactly as before.
      */
     catalog?: () => readonly ProviderInfo[] | undefined;
   }
   ```

   Add a FOURTH optional parameter `options?: SetProviderApiKeyOptions` to `setProviderApiKey(secrets, providerId?, onChanged?, options?)`. The three existing positional parameters keep their meaning and order, so every current call site and every existing test compiles unchanged.

   Add a private helper in the same module:

   ```ts
   /**
    * The catalog to offer: the injected live catalog when it yields at least one
    * keyed provider, else the builtin catalog. Never throws — a supplier that
    * throws is treated as "no live catalog".
    */
   function resolveCatalog(options?: SetProviderApiKeyOptions): readonly ProviderInfo[] {
     let live: readonly ProviderInfo[] | undefined;
     try {
       live = options?.catalog?.();
     } catch {
       live = undefined;
     }
     if (live !== undefined && live.some(isKeyedProvider)) {
       return live;
     }
     return providerCatalog();
   }

   /** True when `info` is a provider the quick pick can set a key for. */
   function isKeyedProvider(info: ProviderInfo): boolean {
     return info.requiresKey === true && providerSecretKey(info.id) !== undefined;
   }
   ```

   `isKeyedProvider` replaces the current bare `.filter((p) => p.requiresKey)`; the extra `providerSecretKey(...) !== undefined` guard keeps `copilot` and any blank/keyless feed id out and makes the later `providerSecretKey(picked)!` non-null assertion sound.

   Files: `src/activation/setApiKey.ts`

2. Drive the quick pick and all labels from the resolved catalog

   Still in `setProviderApiKey` (src/activation/setApiKey.ts):

   1. Replace `const candidates = providerCatalog().filter((p) => p.requiresKey);` with:
   ```ts
   const catalog = resolveCatalog(options);
   const candidates = catalog.filter(isKeyedProvider);
   ```
   Catalog order is preserved verbatim (builtins minus copilot, then feed-only providers, `openai` last), so with no injected catalog the pick is byte-identical to today's four items.

   2. Make the description pass tolerant of a failing SecretStorage — with a large feed catalog this is now ~dozens of reads and one rejection must not kill the command:
   ```ts
   const stored = await Promise.all(
     candidates.map(async (info) => {
       try {
         return await secrets.get(providerSecretKey(info.id)!);
       } catch {
         return undefined; // an unreadable slot reads as "no key set"
       }
     }),
   );
   ```
   Keep building `items` exactly as now (`label`, `description` = `PROVIDER_KEY_SET_DETAIL` / `PROVIDER_KEY_MISSING_DETAIL`, `id`). Items must continue to carry ONLY id/label/set-or-missing — never any part of a stored value.

   3. Add `matchOnDescription: true` to the `showQuickPick` options object alongside the existing `title`, `placeHolder`, `ignoreFocusOut` (the list can now be long; filtering by "API key set" is useful). Do not change `PROVIDER_PICK_TITLE`.

   4. Explicit-provider path: keep `if (providerId !== undefined && providerSecretKey(providerId) !== undefined) { picked = providerId; }` — `providerSecretKey` already returns `baiton.orchestrator.key.<id>` for any non-blank non-builtin id, so a feed-derived or vanished id passed by the Chat view's inline "Set API key…" fix still skips the pick.

   5. Resolve the label from the resolved catalog so feed providers get their feed label instead of their bare id:
   ```ts
   const label = providerInfo(picked, catalog).label;
   ```
   (`providerInfo` still synthesises `label === id` for an id absent from the catalog, so a vanished provider degrades gracefully rather than throwing.)

   6. Leave every message constant/helper, the set/clear/cancel/failure branches and the `onChanged` contract exactly as they are.

   7. Update the `setProviderApiKey` JSDoc: the pick is over the keyed providers of the LIVE catalog (builtins plus every models.dev-derived provider), in catalog order; providers the Chat dropdown hides are offered here so they can be configured before they can appear; the items carry ids, labels and a set/not-set marker only — no secret value ever reaches the pick; and an absent/failing catalog supplier degrades to the builtin catalog. Also refresh the file-header comment's per-provider section to say the same.

   Files: `src/activation/setApiKey.ts`

3. Wire the live catalog in at the single host call site

   src/activation/commands.ts is outside the todo's stated file list but the todo's goal ('so hidden providers can be configured') is unreachable without it: with no injected catalog `resolveCatalog` returns the five builtins and nothing changes at runtime. Keep the edit to exactly these three lines and say so in the execution summary.

   1. Extend the value import at line 131 to `import { isProviderId, providerCatalog, findProviderInfo } from '../orchestrator/providers';` and the type import at line 132 to also carry `ProviderInfo` if needed (it is not, unless a local annotation is added).

   2. At line 545-546 pass the live catalog, reusing the same feed accessor the router already uses:
   ```ts
   const providerCatalogNow = (): readonly ProviderInfo[] =>
     providerCatalog(getModelDiscovery()?.feed());
   const promptProviderKey = (provider?: ProviderId): Promise<void> =>
     setProviderApiKey(context.secrets, provider, () => router.refresh(), {
       catalog: providerCatalogNow,
     });
   ```
   (If adding the `ProviderInfo` annotation is noisy, drop the annotation and let it infer.)

   3. At line 749-750 widen the palette command's argument gate from builtin membership to catalog membership, so a hidden FEED provider id can be pre-selected while an arbitrary string still cannot store a key under a bogus slot:
   ```ts
   vscode.commands.registerCommand(COMMANDS.setProviderApiKey, (arg?: unknown) =>
     promptProviderKey(
       typeof arg === 'string' && findProviderInfo(arg, providerCatalogNow()) !== undefined
         ? arg
         : isProviderId(arg)
           ? arg
           : undefined,
     ),
   ),
   ```
   The `isProviderId` fallback keeps the builtin ids working when the feed has not landed. Leave `COMMANDS.setApiKey`'s alias registration and `triggerFix` untouched (`triggerFix` already passes a `ProviderId` straight through).

   Files: `src/activation/commands.ts`

4. Extend test/setApiKey.test.ts for the catalog-driven pick

   Keep every existing test unchanged — in particular 'quick-pick contents: four keyed providers in catalog order, no copilot' is the offline/back-compat guarantee and must stay green with the new default path.

   Add to the static provider import at the top of the file: `providerCatalog`, `buildProviderCatalog`, and `type ProviderInfo`. Add a small local helper building a fake feed-derived entry:
   ```ts
   function feedEntry(id: string, label: string): ProviderInfo {
     return {
       id,
       label,
       defaultBaseUrl: `https://api.${id}.test/v1`,
       requiresKey: true,
       usesSettings: false,
       models: [`${id}-model`],
       dialect: 'openai',
       headerStyle: 'default',
       source: 'feed',
     };
   }
   ```
   Also pull `SetProviderApiKeyOptions` off the loaded module type if a typed local is wanted (`type SetApiKeyModule['setProviderApiKey']` already covers the call shape).

   New `describe('setProviderApiKey catalog-driven quick pick')` cases (each with a fresh `FakeSecretStorage` and the per-test `vscodeFake`):

   1. **Hidden feed providers are offered**: inject `catalog: () => [...providerCatalog(), feedEntry('deepseek', 'DeepSeek'), feedEntry('cerebras', 'Cerebras')]`. Assert the pick's item labels are the four builtin keyed labels followed by 'DeepSeek' and 'Cerebras' — i.e. catalog order preserved, still no 'GitHub Copilot'.
   2. **Choosing a hidden provider stores under the generic key**: same injected catalog, `vscodeFake.quickPickResult = { label: 'DeepSeek', id: 'deepseek' }`, `inputResult = '  dk-abc  '`. Assert one store, key `'baiton.orchestrator.key.deepseek'` (and equal to `providerSecretKey('deepseek')`), value `'dk-abc'`, and exactly one info message equal to `providerKeySavedMessage('DeepSeek')`, which must not contain `'dk-abc'`.
   3. **Descriptions reflect stored keys for feed providers**: pre-store `'baiton.orchestrator.key.cerebras'`. Assert the Cerebras item's description is `PROVIDER_KEY_SET_DETAIL` and the DeepSeek item's is `PROVIDER_KEY_MISSING_DETAIL`.
   4. **No credential ever reaches the pick**: pre-store a distinctive value (`'super-secret-value'`) for one provider; assert `JSON.stringify(vscodeFake.lastQuickPickItems)` does not include it.
   5. **Explicit feed provider id skips the pick and uses the feed label**: `await setProviderApiKey(secrets, 'deepseek', undefined, { catalog })` with `inputResult = 'dk'`; assert `quickPickCalls === 0`, one input box whose prompt includes 'DeepSeek', store under the deepseek key, and `onChanged` (when supplied) called once with `'deepseek'`.
   6. **Unknown id degrades rather than throwing**: `setProviderApiKey(secrets, 'ghost-provider', undefined, { catalog })` stores under `'baiton.orchestrator.key.ghost-provider'` and the confirmation names `'ghost-provider'` (the synthesised label).
   7. **Throwing catalog supplier falls back to the builtins**: `catalog: () => { throw new Error('boom'); }`; the call resolves, the pick shows exactly the four builtin keyed labels.
   8. **undefined / empty / keyless catalog falls back to the builtins**: three sub-assertions using `() => undefined`, `() => []` and `() => [providerCatalog()[0]]` (copilot alone, keyless) — each yields the four builtin keyed items.
   9. **A rejecting SecretStorage read does not break the pick**: replace `secrets.get` with `() => Promise.reject(new Error('boom'))`, inject the extended catalog, assert the call resolves, the pick was shown once, and every description is `PROVIDER_KEY_MISSING_DETAIL`.
   10. **Catalog is read at call time**: a mutable `let feedExtra: ProviderInfo[] = []` supplier; first call shows four items, then push `feedEntry('baseten', 'Baseten')` and a second call shows five — proving no hoisting.

   Files: `test/setApiKey.test.ts`

5. Verify

   Run, from the repo root: `npx tsc --noEmit -p tsconfig.json`; `npx eslint src/activation/setApiKey.ts src/activation/commands.ts test/setApiKey.test.ts --ext .ts`; `npx mocha test/setApiKey.test.ts` (note the repo's .mocharc pulls in the whole suite); `npm run test:unit`. The only acceptable failure is the documented pre-existing keytar packaging-gating case in test/activation.gating.test.ts. Also `grep -n "providerCatalog\|resolveCatalog\|isKeyedProvider" src/activation/setApiKey.ts` to confirm no `providerCatalog()` call is left outside `resolveCatalog`.

   Files: `src/activation/setApiKey.ts`, `src/activation/commands.ts`, `test/setApiKey.test.ts`

## Risks

- The todo's file list omits src/activation/commands.ts, but without the one-call-site wiring the change is inert: resolveCatalog would always fall back to the five builtins and no hidden provider would ever be offered. Keep that edit to the import line, the promptProviderKey closure and the palette-command argument gate, and record the deviation in the execution summary.
- Loosening the palette command's argument gate is the security-sensitive part: an arbitrary string must never become a SecretStorage slot. Gate on `findProviderInfo(arg, providerCatalogNow()) !== undefined` (real catalog membership) with the existing `isProviderId` as the offline fallback — do NOT swap in `isProviderIdLike`.
- The real models.dev feed carries far more providers than the fixture, so the pick becomes a long list and the description pass issues one SecretStorage read per keyed provider. Per-read try/catch (step 2) plus `matchOnDescription: true` cover correctness and usability; if the read volume ever matters, that is a later optimisation, not this todo.
- Existing tests pin the no-catalog behaviour exactly (four keyed providers, catalog order, no copilot, exact message text). Every change must be additive: same positional parameters, same exported constants and helpers, same branch behaviour for cancel / empty-submit / clear / store-failure / onChanged.
- `providerInfo(picked, catalog)` returns a synthesised entry whose label equals the id for an id absent from the catalog. That is deliberate graceful degradation (a provider that left the feed is still configurable), but it means a typo'd explicit id produces a confirmation naming the typo — acceptable, and covered by test case 6.
- setApiKey.ts imports `vscode` for real, so the test must keep loading it through the existing `fixtures/vscodeLoader.mjs` hook registered in the first suite's `before`; new describe blocks must re-import the module the same way the later blocks already do.

## Acceptance

- `setProviderApiKey` accepts a fourth optional `options?: SetProviderApiKeyOptions` with a call-time `catalog?: () => readonly ProviderInfo[] | undefined`; the three existing positional parameters are unchanged and every existing call site and test compiles untouched.
- With no options (or a supplier that throws, returns undefined, returns [], or returns only keyless entries) the quick pick is exactly today's four builtin keyed providers, in catalog order, with no GitHub Copilot item and the same descriptions.
- With an injected catalog containing feed-derived providers, the pick lists every keyed provider of that catalog in catalog order, and picking a feed provider stores the trimmed value under `baiton.orchestrator.key.<id>` and confirms with the feed's label.
- Quick-pick items carry only id, label and the set/not-set description: no stored secret value appears anywhere in the items or in any message (asserted by a stringify check).
- An explicit `providerId` — builtin, feed-derived, or absent from the catalog — still skips the pick, prompts with a masked input, stores under the generic key, and fires `onChanged` exactly once on a successful store or clear.
- A SecretStorage `get` that rejects during the description pass no longer rejects the command: the pick still shows, with those providers marked 'No API key set'.
- src/activation/commands.ts passes `{ catalog: () => providerCatalog(getModelDiscovery()?.feed()) }` at the single `promptProviderKey` call site, and `baiton.setProviderApiKey` pre-selects an argument that is a member of the current catalog (builtin or feed) and ignores anything else.
- `npx tsc --noEmit -p tsconfig.json` exits 0; eslint on the three touched files reports no findings; `npx mocha test/setApiKey.test.ts` is green; `npm run test:unit` shows no new failures beyond the pre-existing keytar packaging-gating case.
