/**
 * The `Baiton: Set Orchestrator API Key` command handler (task 13.2; design
 * "Set API Key").
 *
 * This is thin `vscode` glue that prompts for the orchestrator API key with a
 * masked (password) input and persists it to VS Code SecretStorage under the
 * key the Model_Client reads (`baiton.orchestrator.apiKey`). It never reveals
 * the stored value in any message (Req 17.2, 17.3, 17.4).
 *
 * The handler is defensive about the several ways a prompt can end:
 *  - Cancel (the user dismisses the box): the stored key is left unchanged and
 *    no confirmation is shown (Req 17.5).
 *  - Empty / whitespace-only submit: the stored key is left unchanged and a
 *    "no value provided" message is shown (Req 17.6).
 *  - Write failure: any previously stored key is left unchanged and an error
 *    message is shown (Req 17.7).
 */
import * as vscode from 'vscode';
import {
  LEGACY_API_KEY_SECRET,
  providerCatalog,
  providerInfo,
  providerSecretKey,
} from '../orchestrator/providers';
import type { ProviderId } from '../orchestrator/providers';

/**
 * The SecretStorage key under which the orchestrator API key is stored. This is
 * the same key the Model_Client configuration reads via `context.secrets`, so
 * writing here makes the key immediately available to the Tool_Loop.
 */
export const API_KEY_SECRET = 'baiton.orchestrator.apiKey';

/** The prompt title/label shown in the masked input box (Req 17.2). */
export const API_KEY_PROMPT = 'Enter your Baiton orchestrator API key';

/** Confirmation shown after a successful write, revealing no value (Req 17.4). */
export const API_KEY_SAVED_MESSAGE = 'Baiton: the orchestrator API key was saved.';

/** Message shown when the submitted value has no non-whitespace character (Req 17.6). */
export const API_KEY_NO_VALUE_MESSAGE = 'Baiton: no value provided; the API key was left unchanged.';

/** Error message shown when the SecretStorage write fails (Req 17.7). */
export const API_KEY_SAVE_FAILED_MESSAGE = 'Baiton: the orchestrator API key could not be saved.';

/**
 * Prompt for the orchestrator API key and store it in SecretStorage.
 *
 * On a submit with at least one non-whitespace character, the trimmed value is
 * written to `baiton.orchestrator.apiKey` and a confirmation is shown that does
 * not reveal the value (Req 17.3, 17.4). Cancelling the prompt (an `undefined`
 * result) leaves the key untouched with no message (Req 17.5). An empty or
 * whitespace-only submit leaves the key untouched and reports that no value was
 * provided (Req 17.6). If the write throws, any previous key is left unchanged
 * and an error is surfaced (Req 17.7).
 *
 * @param secrets The VS Code SecretStorage to write the key into. Passed in so
 *   the handler is testable without a running host.
 */
export async function setOrchestratorApiKey(
  secrets: vscode.SecretStorage,
): Promise<void> {
  const input = await vscode.window.showInputBox({
    prompt: API_KEY_PROMPT,
    password: true,
    ignoreFocusOut: true,
  });

  // Cancel: the input box was dismissed. Leave the stored key unchanged and
  // show nothing (Req 17.5).
  if (input === undefined) {
    return;
  }

  // Empty / whitespace-only submit: nothing meaningful to store. Leave the key
  // unchanged and report that no value was provided (Req 17.6).
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    void vscode.window.showWarningMessage(API_KEY_NO_VALUE_MESSAGE);
    return;
  }

  try {
    await secrets.store(API_KEY_SECRET, trimmed);
  } catch {
    // Write failure: any previously stored key is untouched by a failed store.
    // Surface an error and do not confirm a save (Req 17.7).
    void vscode.window.showErrorMessage(API_KEY_SAVE_FAILED_MESSAGE);
    return;
  }

  // Success: confirm without revealing the stored value (Req 17.4).
  void vscode.window.showInformationMessage(API_KEY_SAVED_MESSAGE);
}

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

/**
 * Prompt for and manage one provider's API key.
 *
 * The provider is taken from the optional `providerId` argument (the seam the
 * Chat webview's "Set API key…" action uses) or, when omitted, through a quick
 * pick over the keyed providers in catalog order — `copilot` is excluded since
 * it needs no key. Each quick-pick item's `description` reflects whether a key
 * is currently stored.
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
 * @param secrets The VS Code SecretStorage the per-provider keys live in.
 * @param providerId Optional provider to skip the quick pick for.
 */
export async function setProviderApiKey(
  secrets: vscode.SecretStorage,
  providerId?: ProviderId,
): Promise<void> {
  const candidates = providerCatalog().filter((p) => p.requiresKey);

  let picked: ProviderId;
  if (providerId !== undefined && providerSecretKey(providerId) !== undefined) {
    picked = providerId;
  } else {
    // Read every existing key before showing the pick so descriptions are
    // consistent within one offering.
    const detailKeys = candidates.map((p) => providerSecretKey(p.id)!);
    const stored = await Promise.all(detailKeys.map((key) => secrets.get(key)));
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
    });
    if (choice === undefined) {
      return;
    }
    picked = choice.id;
  }

  const key = providerSecretKey(picked)!;
  const label = providerInfo(picked).label;

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

  // Success: confirm without revealing the stored value.
  void vscode.window.showInformationMessage(providerKeySavedMessage(label));
}

/** `globalState` flag making the legacy-key migration run at most once. */
export const LEGACY_MIGRATION_FLAG = 'baiton.orchestrator.keyMigrated';

/** A minimal `vscode.Memento`-like store for the migration gate. */
interface MementoLike {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void>;
}

/**
 * One-time migration of the pre-multi-provider single-key secret
 * (`baiton.orchestrator.apiKey`) into the `openai` provider slot.
 *
 * The migration runs at most once, gated by {@link LEGACY_MIGRATION_FLAG} in
 * the caller's `globalState`. It never deletes the legacy secret: the live
 * `buildModelClient` still reads it until the ProviderRouter replaces it. A
 * non-empty value already in the `openai` slot is never clobbered, and a
 * missing/whitespace-only legacy secret sets the flag so the read never
 * repeats. Any failure resolves `false` — activation must not break here.
 *
 * @returns Whether a legacy value was copied into the `openai` slot.
 */
export async function migrateLegacyApiKey(
  secrets: vscode.SecretStorage,
  memento: MementoLike,
): Promise<boolean> {
  try {
    if (memento.get<boolean>(LEGACY_MIGRATION_FLAG) === true) {
      return false;
    }
    const legacy = await secrets.get(LEGACY_API_KEY_SECRET);
    if (legacy === undefined || legacy.trim().length === 0) {
      await memento.update(LEGACY_MIGRATION_FLAG, true);
      return false;
    }
    const openaiKey = providerSecretKey('openai')!;
    const existing = await secrets.get(openaiKey);
    if (typeof existing === 'string' && existing.length > 0) {
      await memento.update(LEGACY_MIGRATION_FLAG, true);
      return false;
    }
    await secrets.store(openaiKey, legacy.trim());
    await memento.update(LEGACY_MIGRATION_FLAG, true);
    return true;
  } catch {
    // A SecretStorage failure at activation must never break activation.
    return false;
  }
}
