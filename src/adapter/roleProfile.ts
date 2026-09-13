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
