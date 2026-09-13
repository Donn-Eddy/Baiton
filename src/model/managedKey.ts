/**
 * A frontmatter key the extension is allowed to write. Every other byte of a
 * spec file is owned by the user or the orchestrator; the serializer touches
 * only state boxes and these keys (Requirement 6.1).
 */
export type ManagedKey =
  | 'base'
  | 'base_commit'
  | 'branch'
  | 'approved_rev'
  | 'pr'
  | 'status';

/** All extension-managed frontmatter keys. */
export const MANAGED_KEYS: readonly ManagedKey[] = [
  'base',
  'base_commit',
  'branch',
  'approved_rev',
  'pr',
  'status',
] as const;

/** Whether an arbitrary string is an extension-managed frontmatter key. */
export function isManagedKey(value: string): value is ManagedKey {
  return (MANAGED_KEYS as readonly string[]).includes(value);
}
