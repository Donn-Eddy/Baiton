/**
 * The chat orchestrator's context budget (host-free core).
 *
 * Resolves how large the selected model's context window is. This module
 * carries no `vscode` import so it can be unit-tested under plain mocha.
 */

import type { ModelEntry } from './modelCatalog';

/** The `baiton.orchestrator.contextWindow` setting key (0 = unset). */
export const CONTEXT_WINDOW_SETTING = 'baiton.orchestrator.contextWindow';

/**
 * The selected model's context window in tokens: the catalog entry's
 * `contextWindow` first, else the user's `baiton.orchestrator.contextWindow`
 * setting, else `undefined` (unknown). A value counts only when it is a
 * positive finite integer — `0` (the setting's default), negatives,
 * fractions, NaN/Infinity, strings and other shapes are "unset". Pure; never throws.
 */
export function resolveContextWindow(entry: ModelEntry | undefined, configured: unknown): number | undefined {
  const fromCatalog = positiveInteger(entry?.contextWindow);
  if (fromCatalog !== undefined) {
    return fromCatalog;
  }
  return positiveInteger(configured);
}

/** `value` when a positive finite integer, else undefined. */
function positiveInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined;
}
