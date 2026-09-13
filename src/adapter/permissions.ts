import type { Role } from '../model/role';

/**
 * Per-role Claude permission flags (Requirement 15, design "Claude adapter"
 * table). Each role also receives write access to its own
 * `.baiton/runs/<run-id>/` directory; that per-run grant is appended by the
 * adapter at launch time (Requirement 15.4).
 */

/** Roles that only read and search (Requirement 15.1). */
export const READ_ONLY_ROLES: readonly Role[] = [
  'spec-writer',
  'planner',
  'plan-reviewer',
  'pr-writer',
] as const;

/** Whether a role is one of the read-only roles. */
export function isReadOnlyRole(role: Role): boolean {
  return (READ_ONLY_ROLES as readonly string[]).includes(role);
}

/**
 * The `--allowedTools` value for the read-only roles: read and search plus
 * write scoped to the run artifact tree (Requirement 15.1).
 */
export const READ_ONLY_ALLOWED_TOOLS = 'Read,Glob,Grep,Write(.baiton/runs/**)';

/**
 * The `--allowedTools` value for the reviewer: read and search, command
 * execution, and write scoped to the run artifact tree (Requirement 15.2).
 */
export const REVIEWER_ALLOWED_TOOLS = 'Read,Glob,Grep,Bash,Write(.baiton/runs/**)';

/**
 * The permission-mode value for the executor. Accept-edits mode lets command
 * execution prompts surface in the terminal (Requirement 15.3).
 */
export const ACCEPT_EDITS_MODE = 'acceptEdits';

/**
 * The read-only `acceptEdits` fallback arg set (Requirement 15.7 seam).
 *
 * Whether Claude's `Write(...)` rule scopes writes the way `Read`/`Edit` rules
 * do is unverified (design checklist). If it does not, read-only roles fall
 * back to `--permission-mode acceptEdits` with the brief forbidding edits,
 * relying on the post-run reset to revert any change. Exposing both arg sets
 * makes the fallback a config flip rather than a plumbing rewrite.
 */
export interface PermissionMode {
  /** Config flip: when true, read-only roles launch with the acceptEdits fallback. */
  readOnlyFallbackToAcceptEdits: boolean;
}

/** The default permission mode: read-only roles use the scoped `Write(...)` rule. */
export const DEFAULT_PERMISSION_MODE: PermissionMode = {
  readOnlyFallbackToAcceptEdits: false,
};

/**
 * Build the base permission flags (before the per-run write grant) for a role.
 *
 * @param role the role being launched
 * @param mode the permission mode; the `readOnlyFallbackToAcceptEdits` flip
 *   swaps read-only roles onto the accept-edits fallback (Requirement 15.7)
 */
export function permissionFlags(role: Role, mode: PermissionMode = DEFAULT_PERMISSION_MODE): string[] {
  if (role === 'executor') {
    return ['--permission-mode', ACCEPT_EDITS_MODE];
  }
  if (role === 'reviewer') {
    return ['--allowedTools', REVIEWER_ALLOWED_TOOLS];
  }
  // Read-only roles: spec-writer, planner, plan-reviewer, pr-writer.
  if (mode.readOnlyFallbackToAcceptEdits) {
    return ['--permission-mode', ACCEPT_EDITS_MODE];
  }
  return ['--allowedTools', READ_ONLY_ALLOWED_TOOLS];
}

/**
 * The per-run write grant every role receives for its own run directory
 * (Requirement 15.4). Returned as an `--add-dir` flag scoping writes to
 * `.baiton/runs/<run-id>/`.
 */
export function runDirGrant(runId: string): string[] {
  return ['--add-dir', `.baiton/runs/${runId}/`];
}
