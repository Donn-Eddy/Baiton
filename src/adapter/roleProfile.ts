import type { Role } from '../model/role';

/**
 * Baiton-owned, per-role agent definitions — the single source of truth for
 * what a sub-agent of each role may do, and the plain-language statement of
 * those constraints that every adapter delivers to its CLI.
 *
 * Before this module the policy existed only as Claude flags in
 * `permissions.ts`, and every other adapter re-derived it from
 * {@link isReadOnlyRole} by mapping onto whatever "plan mode" its CLI shipped.
 * That is not equivalent: opencode's built-in `plan` agent injects a system
 * reminder keyed on the agent *name* that forbids all writes, so a planner
 * launched as `--agent plan` never wrote its `result.json` even once the
 * permission had been granted. Owning the policy here and translating it per
 * adapter removes that class of defect.
 *
 * Role-specific *task* instructions stay in the Brief
 * (`src/engine/roleInstructions.ts`); this module carries only the permission
 * policy, and the two are deliberately not duplicated.
 */

/** Where a role's agent may write. */
export type WriteScope = 'run-dir' | 'workspace';

/** One role's agent definition: identity, capability, and the prompt that states it. */
export interface RoleProfile {
  /** The role this profile governs. */
  role: Role;
  /** Stable agent name used wherever a CLI takes a named agent: `baiton-<role>`. */
  agentName: string;
  /** One-line description for CLIs that display it. */
  description: string;
  /** May the agent run shell commands? */
  shell: boolean;
  /** Where the agent may write: only its run dir, or the whole workspace. */
  write: WriteScope;
  /** Plain-language system-prompt fragment stating the constraints. */
  systemPrompt: string;
}

/**
 * The sentence appended to every profile's system prompt. Each role's real
 * deliverable is its result file, and every "you must not write" clause above
 * it would otherwise read as forbidding that write too.
 */
export const RESULT_FILE_SENTENCE =
  'Your brief names a result file inside `.baiton/runs/<run-id>/`. Writing ' +
  'that file is required and is explicitly permitted; it is the only write ' +
  'the brief asks of you unless it says otherwise. When it is written, stop.';

/**
 * The workspace-relative run directory for a run, with a trailing slash:
 * `.baiton/runs/<runId>/`. Single source for the path that `runDirGrant`
 * spells on claude's `--add-dir`, codex's `--add-dir`, and opencode's inline
 * `edit` permission pattern.
 */
export function runDirPattern(runId: string): string {
  return `.baiton/runs/${runId}/`;
}

/**
 * The run-dir glob as a `**`-widened pattern: `.baiton/runs/<runId>/` with a
 * trailing `**` followed by one final single-`*` file component (the
 * `**`-then-`/*` form, `${runDirPattern(runId)}**` plus a trailing `/*`).
 *
 * A single `*` is not enough: `src/orchestrator/glob.ts` treats it as
 * non-separator-crossing, so opencode's `.baiton/runs/<id>/*` rule matches
 * only files directly inside the run dir and never
 * `.baiton/runs/<id>/sub/file.json`. A lone `**` is not enough either: this
 * matcher compiles `**` to segments-only `(?:[^/]+/)*` with no trailing file
 * component, so `<dir>/**` matches the directory and its sub-directories but
 * not a file inside them. Appending the final `*` component compiles to
 * `(?:[^/]+/)*[^/]*`, which covers both `.baiton/runs/<id>/result.json` and
 * `.baiton/runs/<id>/sub/file.json`. The allow-list gate matches write
 * targets against this glob with `matchesGlob`.
 */
export function runDirGlob(runId: string): string {
  return `${runDirPattern(runId)}**/*`;
}

/**
 * The canonical, CLI-independent tool families every harness tool name is
 * normalised onto by the auto-mode gate (`src/orchestrator/autoMode.ts`).
 */
export type AllowedToolFamily = 'read' | 'search' | 'write' | 'shell';

/** One allow-list entry: a tool family, optionally scoped to repo-relative globs. */
export interface ToolAllowRule {
  family: AllowedToolFamily;
  /** Repo-relative globs the rule is scoped to; absent means any path. */
  paths?: readonly string[];
  /** Short human reason used in the audit rationale, e.g. 'run-dir write grant'. */
  reason: string;
}

/** The per-agent allow-list the auto-mode first gate consumes. */
export interface AgentAllowList {
  agent: string;
  role: Role;
  runId: string;
  rules: readonly ToolAllowRule[];
}

/**
 * The profile-derived default allow-list for a role — the fallback for
 * adapters with no granular permission data of their own (codex runs
 * `--sandbox workspace-write` for every role and antigravity has only
 * `--mode plan|accept-edits`, so neither exposes a finer table than the
 * profile; see their JSDoc).
 *
 * Derived purely from {@link ROLE_PROFILES}: read and search are always
 * granted unscoped; the write rule's paths follow the profile's write scope
 * (`workspace` → `**` then `/*`, `run-dir` → the run dir glob); a shell rule is emitted
 * only when the profile grants shell. Note that a shell rule makes shell
 * *eligible* only — `autoMode.ts` still restricts shell approval to
 * recognised safe read-only/verification commands and escalates the rest.
 */
export function roleAllowList(agent: string, role: Role, runId: string): AgentAllowList {
  const profile = ROLE_PROFILES[role];
  const rules: ToolAllowRule[] = [
    { family: 'read', reason: 'every role may read' },
    { family: 'search', reason: 'every role may search' },
  ];
  rules.push(
    profile.write === 'workspace'
      ? { family: 'write', paths: ['**', '**/*'], reason: 'workspace write scope' }
      : { family: 'write', paths: [runDirGlob(runId)], reason: 'run-dir write grant' },
  );
  if (profile.shell) {
    rules.push({ family: 'shell', reason: 'role profile grants shell' });
  }
  return { agent, role, runId, rules };
}

/** Compose a profile's full system prompt: the role fragment plus the shared sentence. */
function prompt(fragment: string): string {
  return `${fragment} ${RESULT_FILE_SENTENCE}`;
}

/** The read-and-search-only constraint shared by the four non-shell, run-dir roles. */
function readOnlyFragment(who: string): string {
  return (
    `You are Baiton's ${who}. You may read and search the repository. You ` +
    'must not modify, create, or delete any file outside your run directory, ' +
    'and you must not run shell commands.'
  );
}

/** The six default profiles, keyed by role. Constants: there is no user override. */
export const ROLE_PROFILES: Record<Role, RoleProfile> = {
  'spec-writer': {
    role: 'spec-writer',
    agentName: 'baiton-spec-writer',
    description: 'Baiton spec-writer (read-only, writes only its run result)',
    shell: false,
    write: 'run-dir',
    systemPrompt: prompt(readOnlyFragment('spec writer')),
  },
  planner: {
    role: 'planner',
    agentName: 'baiton-planner',
    description: 'Baiton planner (read-only, writes only its run result)',
    shell: false,
    write: 'run-dir',
    systemPrompt: prompt(readOnlyFragment('planner')),
  },
  'plan-reviewer': {
    role: 'plan-reviewer',
    agentName: 'baiton-plan-reviewer',
    description: 'Baiton plan-reviewer (read-only, writes only its run result)',
    shell: false,
    write: 'run-dir',
    systemPrompt: prompt(readOnlyFragment('plan reviewer')),
  },
  executor: {
    role: 'executor',
    agentName: 'baiton-executor',
    description: 'Baiton executor (full workspace write)',
    shell: true,
    write: 'workspace',
    systemPrompt: prompt(
      "You are Baiton's executor. You may read, search, edit, and create files " +
        'anywhere in the workspace and run shell commands to build and verify. ' +
        'Do not commit, stash, or change branches; the extension manages git.',
    ),
  },
  reviewer: {
    role: 'reviewer',
    agentName: 'baiton-reviewer',
    description: 'Baiton reviewer (read-only plus shell, writes only its run result)',
    shell: true,
    write: 'run-dir',
    systemPrompt: prompt(
      "You are Baiton's reviewer. You may read and search the repository and " +
        'run shell commands to build, test, and inspect. You must not modify, ' +
        'create, or delete any file outside your run directory.',
    ),
  },
  'pr-writer': {
    role: 'pr-writer',
    agentName: 'baiton-pr-writer',
    description: 'Baiton pr-writer (read-only, writes only its run result)',
    shell: false,
    write: 'run-dir',
    systemPrompt: prompt(readOnlyFragment('PR writer')),
  },
};

/** The profile governing a role. */
export function roleProfile(role: Role): RoleProfile {
  return ROLE_PROFILES[role];
}
