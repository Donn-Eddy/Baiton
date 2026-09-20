import type { Role } from '../model/role';
import { ROLES } from '../model/role';
import {
  ROLE_PROFILES,
  roleProfile,
  runDirPattern,
  runDirGlob,
  roleAllowList,
  type AgentAllowList,
  type AllowedToolFamily,
  type ToolAllowRule,
} from './roleProfile';

/**
 * The Claude translation of the Baiton role profiles (Requirement 15, design
 * "Claude adapter" table). The policy itself lives in `roleProfile.ts`; this
 * module turns one profile into `--allowedTools` / `--permission-mode` /
 * `--add-dir` flags. Each role also receives write access to its own
 * `.baiton/runs/<run-id>/` directory; that per-run grant is appended by the
 * adapter at launch time (Requirement 15.4).
 */

/**
 * Whether a role only reads and searches (Requirement 15.1): it may write
 * nothing outside its run directory AND may not run shell commands. Derived
 * from the profile table, and by construction the historical set
 * `spec-writer, planner, plan-reviewer, pr-writer` — the reviewer is excluded
 * because it has shell.
 */
export function isReadOnlyRole(role: Role): boolean {
  const profile = roleProfile(role);
  return profile.write === 'run-dir' && profile.shell === false;
}

/** Roles that only read and search (Requirement 15.1), derived from the profile table. */
export const READ_ONLY_ROLES: readonly Role[] = ROLES.filter(isReadOnlyRole);

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
  const profile = ROLE_PROFILES[role];

  // `write: 'workspace'` is claude's accept-edits row (Requirement 15.3).
  if (profile.write === 'workspace') {
    return ['--permission-mode', ACCEPT_EDITS_MODE];
  }
  // Run-dir roles with shell keep Bash in the allow-list (Requirement 15.2).
  if (profile.shell) {
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
  return ['--add-dir', runDirPattern(runId)];
}

/**
 * Split an `--allowedTools` spec on commas that are *outside* parentheses, so
 * a pattern like `Write(.baiton/runs/**)` is not split inside its pattern.
 */
function splitSpec(spec: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of spec) {
    if (ch === '(') {
      depth++;
      current += ch;
    } else if (ch === ')') {
      depth = Math.max(0, depth - 1);
      current += ch;
    } else if (ch === ',' && depth === 0) {
      parts.push(current);
      current = '';
    } else {
      current += ch;
    }
  }
  parts.push(current);
  return parts;
}

/**
 * Parse an `--allowedTools` spec string (the same strings
 * {@link permissionFlags} emits for `READ_ONLY_ALLOWED_TOOLS` /
 * `REVIEWER_ALLOWED_TOOLS`) into per-tool entries, so the auto-mode
 * allow-list and the launch flags cannot drift.
 *
 * Each entry is `Name` or `Name(pattern)`; the pattern becomes the entry's
 * repo-relative glob scope. Dependency-free and tolerant of whitespace:
 * `'Read,Glob,Grep,Write(.baiton/runs/**)'` parses to
 * `[{tool:'Read'},{tool:'Glob'},{tool:'Grep'},{tool:'Write',paths:['.baiton/runs/**']}]`.
 */
export function parseAllowedTools(spec: string): { tool: string; paths?: string[] }[] {
  const entries: { tool: string; paths?: string[] }[] = [];
  for (const raw of splitSpec(spec.trim())) {
    const entry = raw.trim();
    if (entry.length === 0) {
      continue;
    }
    const open = entry.indexOf('(');
    if (open === -1) {
      entries.push({ tool: entry.trim() });
      continue;
    }
    const close = entry.lastIndexOf(')');
    const tool = entry.slice(0, open).trim();
    const pattern = entry.slice(open + 1, close === -1 ? entry.length : close).trim();
    entries.push(pattern.length > 0 ? { tool, paths: [pattern] } : { tool });
  }
  return entries;
}

/** Map a claude `--allowedTools` tool name onto its canonical {@link AllowedToolFamily}. */
const CLAUDE_TOOL_FAMILY: Record<string, AllowedToolFamily> = {
  Read: 'read',
  Glob: 'search',
  Grep: 'search',
  Write: 'write',
  Edit: 'write',
  MultiEdit: 'write',
  Bash: 'shell',
};

/**
 * Derive claude's auto-mode allow-list from the same flags
 * {@link permissionFlags} emits, so the gate reads exactly the table claude
 * is launched with.
 *
 * - `['--allowedTools', spec]`: each parsed entry maps onto a
 *   {@link ToolAllowRule} via {@link CLAUDE_TOOL_FAMILY}; a Write rule is
 *   substituted with the concrete {@link runDirGlob} (the `--add-dir` grant
 *   from {@link runDirGrant}), scoping the rule to this agent's own run dir
 *   rather than the spec's broader `.baiton/runs/**` pattern.
 * - `['--permission-mode', ACCEPT_EDITS_MODE]`: accept-edits carries no
 *   per-tool table, so fall back to the profile-derived
 *   {@link roleAllowList} (this covers both the executor row and the
 *   `readOnlyFallbackToAcceptEdits` flip).
 */
export function claudeAllowList(role: Role, runId: string, mode: PermissionMode = DEFAULT_PERMISSION_MODE): AgentAllowList {
  const flags = permissionFlags(role, mode);
  if (flags[0] === '--allowedTools' && flags.length > 1) {
    const rules: ToolAllowRule[] = [];
    for (const entry of parseAllowedTools(flags[1])) {
      const family = CLAUDE_TOOL_FAMILY[entry.tool];
      if (family === undefined) {
        continue;
      }
      if (family === 'write') {
        // Substitute the concrete run-dir glob for the spec's broad pattern:
        // `Write(.baiton/runs/**)` reaches into every run's directory, but
        // this agent's grant is exactly its own run dir (plus the `--add-dir`
        // grant from `runDirGrant`), so the rule must be scoped to
        // `runDirGlob(runId)` and nothing wider.
        const paths = [runDirGlob(runId)];
        rules.push({
          family,
          paths,
          reason: `claude --allowedTools ${entry.tool}(${entry.paths?.join(',') ?? ''})`,
        });
      } else {
        rules.push({ family, paths: entry.paths, reason: `claude --allowedTools ${entry.tool}` });
      }
    }
    return { agent: 'claude', role, runId, rules };
  }
  return roleAllowList('claude', role, runId);
}
