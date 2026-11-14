import { Role } from '../model';

/** Legacy config keys for each current role, ordered from highest to lowest precedence. */
export const LEGACY_ROLE_KEYS: Readonly<Partial<Record<Role, readonly string[]>>> = {
  'phased-planner': ['plan-writer', 'spec-writer'],
  'step-planner': ['planner'],
  'step-reviewer': ['plan-reviewer'],
};

/** Current role entries inherited when that role and all of its legacy keys are absent. */
export const ROLE_FALLBACKS: Readonly<Partial<Record<Role, Role>>> = {
  'phased-planner': 'step-planner',
};

/** All superseded role keys, in role order and with each role's precedence preserved. */
export const ALL_LEGACY_ROLE_KEYS: readonly string[] = Object.values(LEGACY_ROLE_KEYS).flatMap(
  (keys) => keys ?? [],
);

/** Returns the legacy config keys accepted for a role, in precedence order. */
export function legacyKeysFor(role: Role): readonly string[] {
  return LEGACY_ROLE_KEYS[role] ?? [];
}

/**
 * Resolves a role entry by checking its current key, its legacy keys in order,
 * then its fallback role recursively. Only `undefined` falls through, matching
 * the config loader's previous nullish-coalescing behavior.
 */
export function resolveRoleEntry(role: Role, roles: Record<string, unknown>): unknown {
  const current = roles[role];
  if (current !== undefined) {
    return current;
  }
  for (const key of legacyKeysFor(role)) {
    const legacy = roles[key];
    if (legacy !== undefined) {
      return legacy;
    }
  }
  const fallback = ROLE_FALLBACKS[role];
  return fallback === undefined ? undefined : resolveRoleEntry(fallback, roles);
}
