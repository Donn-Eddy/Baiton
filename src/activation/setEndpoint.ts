/**
 * The `Baiton: Set Provider Endpoint` command handler.
 *
 * Thin `vscode` glue, modelled on the per-provider half of
 * src/activation/setApiKey.ts, that edits one entry of the
 * `baiton.orchestrator.endpoints` user setting: a map from provider id to the
 * OpenAI-compatible base URL that provider is reached at.
 *
 * Why it exists: models.dev stopped publishing an `api` URL for many
 * providers (deepinfra, cerebras, groq, xai, …). Those providers now appear in
 * the catalog with no base URL (see `providerNeedsEndpoint` in
 * src/orchestrator/providers.ts), and this command is how the user supplies
 * one. A value set for a provider that DOES have a catalog URL overrides it,
 * so the same map also routes a provider through a proxy. Known URLs are never
 * pre-filled from a hard-coded table: the user's key is sent to whatever is
 * stored here, so the user types (or pastes) it deliberately.
 *
 * Ending behaviours mirror the key command:
 *  - Dismissed pick or cancelled input: nothing written, no message.
 *  - A valid http(s) URL: stored (trimmed) under the provider id, confirmed.
 *  - Empty submit: clears an existing entry, or warns that nothing changed.
 *  - An invalid URL (only reachable when the host skips `validateInput`):
 *    nothing written, an error names the problem.
 *  - Write failure: the previous map is untouched and an error is shown.
 */
import * as vscode from 'vscode';
import { findProviderInfo, providerCatalog, providerInfo, providerNeedsEndpoint } from '../orchestrator/providers';
import type { ProviderId, ProviderInfo } from '../orchestrator/providers';

/** The configuration section the endpoints map lives in. */
export const ENDPOINTS_SECTION = 'baiton';

/** The key of the endpoints map inside {@link ENDPOINTS_SECTION}. */
export const ENDPOINTS_KEY = 'orchestrator.endpoints';

/** Title/placeholder of the provider quick-pick. */
export const PROVIDER_ENDPOINT_PICK_TITLE = 'Select the provider whose endpoint URL to set';

/** Quick-pick `description` for a provider with a user endpoint set. */
export const PROVIDER_ENDPOINT_SET_DETAIL = 'Endpoint set';

/** Quick-pick `description` for a provider with no user endpoint set. */
export const PROVIDER_ENDPOINT_MISSING_DETAIL = 'No endpoint set';

/** Shown when the catalog has no provider an endpoint could be set for. */
export const PROVIDER_ENDPOINT_NONE_MESSAGE =
  'Baiton: no provider needs an endpoint URL right now.';

/** Warning shown on an empty submit when there was nothing to clear. */
export const PROVIDER_ENDPOINT_NO_VALUE_MESSAGE =
  'Baiton: no value provided; the endpoint was left unchanged.';

/** Input prompt for one provider's endpoint. */
export function providerEndpointPrompt(label: string): string {
  return `Enter the OpenAI-compatible base URL for ${label} (submit an empty value to clear it)`;
}

/** Confirmation shown after a provider endpoint is saved. */
export function providerEndpointSavedMessage(label: string): string {
  return `Baiton: the ${label} endpoint was saved.`;
}

/** Confirmation shown after a provider endpoint is cleared. */
export function providerEndpointClearedMessage(label: string): string {
  return `Baiton: the ${label} endpoint was cleared.`;
}

/** Error shown when writing the endpoints setting fails. */
export function providerEndpointSaveFailedMessage(label: string): string {
  return `Baiton: the ${label} endpoint could not be saved.`;
}

/** Validation message for a value that is not an http(s) URL. */
export const PROVIDER_ENDPOINT_INVALID_MESSAGE = 'Enter an http:// or https:// URL, or leave empty to clear.';

/**
 * Validates one submitted endpoint: `undefined` when acceptable (a blank value
 * clears, so it is acceptable), else the message to show. Only `http:` and
 * `https:` URLs pass — the key is sent to this URL, so nothing else is
 * meaningful. Pure; never throws.
 */
export function validateEndpointUrl(value: string): string | undefined {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  try {
    const url = new URL(trimmed);
    return url.protocol === 'http:' || url.protocol === 'https:' ? undefined : PROVIDER_ENDPOINT_INVALID_MESSAGE;
  } catch {
    return PROVIDER_ENDPOINT_INVALID_MESSAGE;
  }
}

/**
 * Reads an untrusted settings value as the endpoints map: an object whose
 * string values are kept (trimmed, blanks dropped); anything else becomes an
 * empty map. Settings JSON is user-edited, so this never throws. Pure.
 */
export function normalizeEndpoints(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return out;
  }
  for (const [id, url] of Object.entries(value as Record<string, unknown>)) {
    if (typeof url === 'string' && url.trim().length > 0 && id.trim().length > 0) {
      out[id] = url.trim();
    }
  }
  return out;
}

/** True when `info` is an HTTP provider whose endpoint this command may set. */
export function isEndpointSettable(info: ProviderInfo): boolean {
  return info.id !== 'copilot' && info.usesSettings !== true;
}

/**
 * The providers the quick pick offers, in catalog order: every provider that
 * needs an endpoint ({@link providerNeedsEndpoint}), plus every settable
 * provider that already has a user endpoint (so an override can be edited or
 * cleared). Pure.
 */
export function endpointCandidates(
  catalog: readonly ProviderInfo[],
  endpoints: Readonly<Record<string, string>>,
): ProviderInfo[] {
  return catalog.filter(
    (info) =>
      isEndpointSettable(info) &&
      (providerNeedsEndpoint(info) || Object.prototype.hasOwnProperty.call(endpoints, info.id)),
  );
}

/** Extra, optional wiring for {@link setProviderEndpoint}. */
export interface SetProviderEndpointOptions {
  /**
   * The live provider catalog, read at call time. Absent, throwing or
   * undefined-returning falls back to the builtin catalog.
   */
  catalog?: () => readonly ProviderInfo[] | undefined;
}

/** The catalog to offer: the injected live catalog, else the builtins. Never throws. */
function resolveCatalog(options?: SetProviderEndpointOptions): readonly ProviderInfo[] {
  try {
    const live = options?.catalog?.();
    if (live !== undefined && live.length > 0) {
      return live;
    }
  } catch {
    /* a throwing supplier reads as "no live catalog" */
  }
  return providerCatalog();
}

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

/**
 * Prompt for and manage one provider's endpoint URL.
 *
 * The provider comes from `providerId` when it names a settable catalog
 * provider (the Chat view's "Set endpoint…" fix passes the failing one), else
 * from a quick pick over {@link endpointCandidates}. The input box is
 * pre-filled with the current user value and validated with
 * {@link validateEndpointUrl}. The map is written to the USER (global)
 * settings: the setting is application-scoped because the provider's API key
 * is sent to it, so a workspace must not be able to redirect it.
 *
 * `onChanged` is invoked with the provider id after a successful write or
 * clear — never on cancel, a no-op, invalid input or a failed write.
 */
export async function setProviderEndpoint(
  providerId?: ProviderId,
  onChanged?: (id: ProviderId) => void | Promise<void>,
  options?: SetProviderEndpointOptions,
): Promise<void> {
  const catalog = resolveCatalog(options);
  const config = vscode.workspace.getConfiguration(ENDPOINTS_SECTION);
  const endpoints = normalizeEndpoints(config.get<unknown>(ENDPOINTS_KEY));

  let picked: ProviderId;
  const explicit = providerId !== undefined ? findProviderInfo(providerId, catalog) : undefined;
  if (explicit !== undefined && isEndpointSettable(explicit)) {
    picked = explicit.id;
  } else {
    const candidates = endpointCandidates(catalog, endpoints);
    if (candidates.length === 0) {
      void vscode.window.showInformationMessage(PROVIDER_ENDPOINT_NONE_MESSAGE);
      return;
    }
    const items = candidates.map((info) => ({
      label: info.label,
      description: Object.prototype.hasOwnProperty.call(endpoints, info.id)
        ? PROVIDER_ENDPOINT_SET_DETAIL
        : PROVIDER_ENDPOINT_MISSING_DETAIL,
      id: info.id,
    }));
    const choice = await vscode.window.showQuickPick(items, {
      title: PROVIDER_ENDPOINT_PICK_TITLE,
      placeHolder: PROVIDER_ENDPOINT_PICK_TITLE,
      ignoreFocusOut: true,
      matchOnDescription: true,
    });
    if (choice === undefined) {
      return;
    }
    picked = choice.id;
  }

  const label = providerInfo(picked, catalog).label;
  const current = Object.prototype.hasOwnProperty.call(endpoints, picked) ? endpoints[picked] : undefined;

  const input = await vscode.window.showInputBox({
    prompt: providerEndpointPrompt(label),
    placeHolder: 'https://api.example.com/v1',
    ...(current !== undefined ? { value: current } : {}),
    ignoreFocusOut: true,
    validateInput: validateEndpointUrl,
  });
  if (input === undefined) {
    return;
  }

  const trimmed = input.trim();
  const invalid = validateEndpointUrl(trimmed);
  if (invalid !== undefined) {
    void vscode.window.showErrorMessage(`Baiton: ${invalid}`);
    return;
  }

  const next: Record<string, string> = { ...endpoints };
  if (trimmed.length === 0) {
    if (current === undefined) {
      void vscode.window.showWarningMessage(PROVIDER_ENDPOINT_NO_VALUE_MESSAGE);
      return;
    }
    delete next[picked];
  } else {
    next[picked] = trimmed;
  }

  try {
    // An emptied map is removed rather than written as `{}`, so clearing the
    // last entry leaves settings.json as if it had never been set.
    await config.update(
      ENDPOINTS_KEY,
      Object.keys(next).length > 0 ? next : undefined,
      vscode.ConfigurationTarget.Global,
    );
  } catch {
    void vscode.window.showErrorMessage(providerEndpointSaveFailedMessage(label));
    return;
  }

  await notifyChanged(onChanged, picked);
  void vscode.window.showInformationMessage(
    trimmed.length === 0 ? providerEndpointClearedMessage(label) : providerEndpointSavedMessage(label),
  );
}
