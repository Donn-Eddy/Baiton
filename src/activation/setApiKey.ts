/**
 * The `Baiton: Set Provider API Key` command handler (`baiton.setProviderApiKey`).
 * Thin `vscode` glue that sets or clears one provider's API key in VS Code
 * SecretStorage under its `baiton.orchestrator.key.<id>` slot, using a masked
 * input. It offers the keyed providers of the live catalog (the builtins plus
 * every models.dev-derived provider), and providers aliased onto one slot
 * appear as a single item. It never reveals a stored value; only ids, labels
 * and a set/not-set marker reach the quick pick. Ending behaviours: cancel
 * leaves the key unchanged with no message; an empty submit clears an existing
 * key or warns that nothing was provided; a write or delete failure leaves
 * the previous value and shows an error.
 */
import * as vscode from 'vscode';
import {
  providerCatalog,
  providerInfo,
  providerSecretKey,
} from '../orchestrator/providers';
import type { ProviderId, ProviderInfo } from '../orchestrator/providers';

// --- per-provider key management (multi-provider orchestrator) --------------

/** Title/placeholder of the provider quick-pick. */
export const PROVIDER_PICK_TITLE = 'Select the provider whose API key to set';

/** Quick-pick `description` for a provider that already has a key stored. */
export const PROVIDER_KEY_SET_DETAIL = 'API key set';

/** Quick-pick `description` for a provider with no key stored. */
export const PROVIDER_KEY_MISSING_DETAIL = 'No API key set';

/** Masked-input prompt for one provider's key. */
export function providerKeyPrompt(label: string): string {
  return `Enter your ${label} API key (submit an empty value to clear it)`;
}

/** Confirmation shown after a provider key is saved. */
export function providerKeySavedMessage(label: string): string {
  return `Baiton: the ${label} API key was saved.`;
}

/** Confirmation shown after a provider key is cleared. */
export function providerKeyClearedMessage(label: string): string {
  return `Baiton: the ${label} API key was cleared.`;
}

/** Error shown when a provider key write/delete fails. */
export function providerKeySaveFailedMessage(label: string): string {
  return `Baiton: the ${label} API key could not be saved.`;
}

/** Warning shown on an empty submit when there was nothing to clear. */
export const PROVIDER_KEY_NO_VALUE_MESSAGE =
  'Baiton: no value provided; the API key was left unchanged.';

/** Fires the availability notification without letting it break the command. */
async function notifyChanged(
  onChanged: ((id: ProviderId) => void | Promise<void>) | undefined,
  id: ProviderId,
): Promise<void> {
  try {
    await onChanged?.(id);
  } catch {
    /* the refresh is best-effort */
  }
}

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

/** True when `info` is a provider the quick pick can set a key for. */
function isKeyedProvider(info: ProviderInfo): boolean {
  return info.requiresKey === true && providerSecretKey(info.id) !== undefined;
}

/**
 * One entry of the key quick pick: every keyed provider that resolves to the
 * same SecretStorage slot, collapsed into one item.
 */
export interface ProviderKeyGroup {
  /** The first member's id, in catalog order; the id the pick reports. */
  id: ProviderId;
  /** Every member id, in catalog order. */
  ids: readonly ProviderId[];
  /** The member labels joined with " / " (e.g. "OpenCode Go / OpenCode Zen"). */
  label: string;
  /** The shared `baiton.orchestrator.key.<slot>` SecretStorage key. */
  secretKey: string;
}

/**
 * The keyed providers of `catalog` grouped by resolved SecretStorage key, in
 * catalog order of each group's first member. Pure.
 *
 * Ids aliased onto one slot (`opencode-go` onto `opencode`, see
 * `PROVIDER_SECRET_ALIAS`) share a single key, so offering them as two pick
 * items would suggest two independent keys where writing either overwrites
 * both. One item labelled by both names makes the sharing visible instead.
 */
export function providerKeyGroups(catalog: readonly ProviderInfo[]): ProviderKeyGroup[] {
  const groups: Array<{ id: ProviderId; ids: ProviderId[]; labels: string[]; secretKey: string }> = [];
  const bySecret = new Map<string, (typeof groups)[number]>();
  for (const info of catalog) {
    if (!isKeyedProvider(info)) {
      continue;
    }
    const secretKey = providerSecretKey(info.id)!;
    const existing = bySecret.get(secretKey);
    if (existing === undefined) {
      const group = { id: info.id, ids: [info.id], labels: [info.label], secretKey };
      bySecret.set(secretKey, group);
      groups.push(group);
    } else if (!existing.ids.includes(info.id)) {
      existing.ids.push(info.id);
      if (!existing.labels.includes(info.label)) {
        existing.labels.push(info.label);
      }
    }
  }
  return groups.map((g) => ({ id: g.id, ids: g.ids, label: g.labels.join(' / '), secretKey: g.secretKey }));
}

/**
 * The label naming `id`'s key in prompts and messages: its group's joined
 * label when `id` shares a slot with other providers in `catalog`, else its
 * own catalog label (an id absent from the catalog names itself). Pure.
 */
export function providerKeyLabel(id: ProviderId, catalog: readonly ProviderInfo[]): string {
  const group = providerKeyGroups(catalog).find((g) => g.ids.includes(id));
  return group !== undefined ? group.label : providerInfo(id, catalog).label;
}

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

/**
 * Prompt for and manage one provider's API key.
 *
 * The provider is taken from the optional `providerId` argument (the seam the
 * Chat webview's "Set API key…" action uses) or, when omitted, through a quick
 * pick over the keyed providers of the *live* catalog — the builtins plus every
 * models.dev-derived provider — in catalog order. `copilot` and any keyless or
 * unkeyable feed entry are excluded since they need no key, and providers that
 * share one SecretStorage slot appear as a single item. Providers the Chat
 * dropdown hides are offered here too, so they can be configured *before* they
 * can appear there. Each quick-pick item carries only an id, a label and a
 * `description` reflecting whether a key is currently stored: no part of a
 * stored value ever reaches the pick. When no catalog supplier is given — or it
 * throws, yields `undefined`, or yields nothing keyable — the pick degrades to
 * the builtin catalog, so an offline window behaves exactly as before.
 *
 * Ending behaviours:
 *  - Dismissed pick or cancelled input: no message, no store/delete.
 *  - Non-empty submit (trimmed): stored under
 *    `baiton.orchestrator.key.<provider>`; a confirmation that never contains
 *    the value is shown.
 *  - Empty submit: clears an existing key ("set or clear with a masked
 *    input"), or falls back to the no-value warning when nothing was stored.
 *  - Write/delete failure: the previous value is untouched and an error is
 *    shown; neither failure path confirms anything.
 *
 * When a key is actually written or deleted, `onChanged` (when supplied) is
 * invoked with the affected provider id so the host can recompute provider
 * availability. It fires only after a successful store or clear: never on
 * cancel, on the empty-submit-with-nothing-stored path, or on a store/delete
 * failure. A throwing/rejecting callback is contained by {@link notifyChanged}.
 *
 * @param secrets The VS Code SecretStorage the per-provider keys live in.
 * @param providerId Optional provider to skip the quick pick for.
 * @param onChanged Invoked with the affected provider id after a key is
 *   successfully stored or cleared — and only then — so the host can recompute
 *   provider availability. Never invoked on cancel, on the empty-submit-with-
 *   nothing-stored path, or on a store/delete failure; a throwing/rejecting
 *   callback is contained.
 * @param options Optional extra wiring; see {@link SetProviderApiKeyOptions}.
 */
export async function setProviderApiKey(
  secrets: vscode.SecretStorage,
  providerId?: ProviderId,
  onChanged?: (id: ProviderId) => void | Promise<void>,
  options?: SetProviderApiKeyOptions,
): Promise<void> {
  const catalog = resolveCatalog(options);
  // One item per SecretStorage slot: aliased ids share a key (see providerKeyGroups).
  const candidates = providerKeyGroups(catalog);

  let picked: ProviderId;
  if (providerId !== undefined && providerSecretKey(providerId) !== undefined) {
    picked = providerId;
  } else {
    // Read every existing key before showing the pick so descriptions are
    // consistent within one offering. A live catalog makes this dozens of
    // reads, so one rejecting slot must not kill the command.
    const stored = await Promise.all(
      candidates.map(async (info) => {
        try {
          return await secrets.get(info.secretKey);
        } catch {
          return undefined; // an unreadable slot reads as "no key set"
        }
      }),
    );
    const items = candidates.map((info, i) => ({
      label: info.label,
      description:
        typeof stored[i] === 'string' && (stored[i] as string).length > 0
          ? PROVIDER_KEY_SET_DETAIL
          : PROVIDER_KEY_MISSING_DETAIL,
      id: info.id,
    }));
    const choice = await vscode.window.showQuickPick(items, {
      title: PROVIDER_PICK_TITLE,
      placeHolder: PROVIDER_PICK_TITLE,
      ignoreFocusOut: true,
      // The live catalog can be long; filtering by "API key set" is useful.
      matchOnDescription: true,
    });
    if (choice === undefined) {
      return;
    }
    picked = choice.id;
  }

  const key = providerSecretKey(picked)!;
  // Resolved from the offered catalog so a feed provider gets its feed label
  // and a shared slot names every provider it unlocks; an id absent from the
  // catalog degrades to a label equal to the id.
  const label = providerKeyLabel(picked, catalog);

  const input = await vscode.window.showInputBox({
    prompt: providerKeyPrompt(label),
    password: true,
    ignoreFocusOut: true,
  });

  // Cancel: leave whatever is stored untouched, message nothing.
  if (input === undefined) {
    return;
  }

  // Empty / whitespace-only submit: clear the key when one is stored, else
  // warn that nothing happened ("set or clear with a masked input").
  if (input.trim().length === 0) {
    let hadKey = false;
    try {
      const current = await secrets.get(key);
      hadKey = typeof current === 'string' && current.length > 0;
      if (hadKey) {
        await secrets.delete(key);
      }
    } catch {
      void vscode.window.showErrorMessage(providerKeySaveFailedMessage(label));
      return;
    }
    if (hadKey) {
      await notifyChanged(onChanged, picked);
      void vscode.window.showInformationMessage(providerKeyClearedMessage(label));
    } else {
      void vscode.window.showWarningMessage(PROVIDER_KEY_NO_VALUE_MESSAGE);
    }
    return;
  }

  try {
    await secrets.store(key, input.trim());
  } catch {
    // Write failure: any previously stored key is untouched by a failed store.
    // Surface an error and do not confirm a save.
    void vscode.window.showErrorMessage(providerKeySaveFailedMessage(label));
    return;
  }

  // Availability changed out of band: let the host recompute before the
  // confirmation (which must never be delayed by a failing refresh either way
  // — notifyChanged contains the callback).
  await notifyChanged(onChanged, picked);

  // Success: confirm without revealing the stored value.
  void vscode.window.showInformationMessage(providerKeySavedMessage(label));
}
