import type { Role } from '../model/role';
import { ROLES } from '../model/role';
import type { AskRelayDescriptor } from './adapter';
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
 *
 * The same module owns the claude ask-relay hook wiring at the bottom of the
 * file: the `PreToolUse` hook shapes emitted through `--settings` are the ones
 * verified by the CLI probe recorded in the README against
 * `claude --version 2.1.278`.
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

/**
 * The claude ask-relay hook wiring, verified by the probe recorded in the
 * README (`claude --version 2.1.278`). A `PreToolUse` command hook installed
 * via inline `--settings` JSON fires for every tool call with a JSON event on
 * stdin carrying `tool_name` / `tool_input` (verbatim field names the probe
 * observed), and honours the hook's stdout contract
 * `hookSpecificOutput.permissionDecision ∈ allow|deny|ask` plus
 * `permissionDecisionReason`.
 */

/** How long the relay hook blocks (seconds) before degrading to `ask`. */
export const CLAUDE_RELAY_HOOK_TIMEOUT_SECONDS = 600;

/** The `PreToolUse` matcher: hear every tool call; Auto mode's allow-list absorbs reads. */
export const CLAUDE_RELAY_HOOK_MATCHER = '*';

/**
 * POSIX single-quote wrap for values interpolated into the hook command,
 * which the CLI executes through a shell. Quotes `value`'s embedded single
 * quotes the standard `"'"'"'"` way so spaces and quotes cannot break the
 * command.
 */
export function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

/**
 * The node program the `PreToolUse` hook runs, passed its parameters as argv
 * (never spliced into the source): the asks dir, the ask/response suffixes,
 * the run id and the deadline in milliseconds. It reads the hook event from
 * stdin, mints an ask file the relay core can parse (`parseAsk` accepts its
 * exact bytes), polls for the response file and translates `approve`→`allow`
 * and anything else→`deny`.
 *
 * On any failure — unparseable event, unwritable ask, unreadable response,
 * deadline expiry — it emits `permissionDecision: "ask"`, never a silent
 * allow: the run degrades to claude's own interactive prompt.
 *
 * Invariant: the script wraps in single quotes on the command line, so it
 * contains no `'` character (string concatenation + double quotes only).
 */
export const CLAUDE_RELAY_HOOK_SCRIPT: string =
  `const fs=require("fs"),path=require("path");` +
  `const a=process.argv.slice(1);` +
  `const dir=a[0],askSuffix=a[1],respSuffix=a[2],runId=a[3],deadline=Date.now()+Number(a[4]);` +
  `function done(decision,reason){` +
  `process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",` +
  `permissionDecision:decision,permissionDecisionReason:reason}}));process.exit(0)}` +
  `let ev={};` +
  `try{ev=JSON.parse(fs.readFileSync(0,"utf8")||"{}")}` +
  `catch(e){done("ask","baiton ask relay: unparseable PreToolUse event")}` +
  `const id=String(Date.now())+"-"+String(process.pid);` +
  `const tool=String(ev.tool_name||"unknown");` +
  `const ask={version:1,id:id,runId:runId,agent:"claude",kind:"permission",` +
  `prompt:"claude wants to use "+tool,tool:tool,` +
  `args:JSON.stringify(ev.tool_input===undefined?{}:ev.tool_input),` +
  `createdAt:new Date().toISOString()};` +
  `try{fs.mkdirSync(dir,{recursive:true});` +
  `fs.writeFileSync(path.join(dir,id+askSuffix),JSON.stringify(ask,null,2)+"\\n")}` +
  `catch(e){done("ask","baiton ask relay: cannot write ask file")}` +
  `function poll(){try{const r=JSON.parse(fs.readFileSync(path.join(dir,id+respSuffix),"utf8"));` +
  `done(r.decision==="approve"?"allow":"deny",String(r.reason||""))}` +
  `catch(e){if(e&&e.code==="ENOENT"){setTimeout(poll,200)}else{` +
  `done("ask","baiton ask relay: cannot read response")}}}` +
  `setTimeout(function(){` +
  `done("ask","baiton ask relay timed out - falling back to the harness prompt")},` +
  `Math.max(0,deadline-Date.now()));` +
  `poll()`;

/**
 * The shell command for the relay hook: the {@link CLAUDE_RELAY_HOOK_SCRIPT}
 * program run with `node -e`, its parameters passed as argv (ask dir, ask
 * suffix, response suffix, run id — each {@link shellQuote}-wrapped because
 * the command executes through a shell) and the deadline in milliseconds.
 */
export function claudeAskRelayHookCommand(relay: AskRelayDescriptor): string {
  return (
    `node -e ${shellQuote(CLAUDE_RELAY_HOOK_SCRIPT)} ` +
    `${shellQuote(relay.dir)} ${shellQuote(relay.askSuffix)} ` +
    `${shellQuote(relay.responseSuffix)} ${shellQuote(relay.runId)} ` +
    `${CLAUDE_RELAY_HOOK_TIMEOUT_SECONDS * 1000}`
  );
}

/**
 * The inline `--settings` JSON value carrying the relay hook: a `PreToolUse`
 * group matching {@link CLAUDE_RELAY_HOOK_MATCHER} with one command hook
 * whose command is {@link claudeAskRelayHookCommand} and whose `timeout` is
 * {@link CLAUDE_RELAY_HOOK_TIMEOUT_SECONDS} (accepted by the probed CLI).
 */
export function claudeAskRelaySettings(relay: AskRelayDescriptor): Record<string, unknown> {
  return {
    hooks: {
      PreToolUse: [
        {
          matcher: CLAUDE_RELAY_HOOK_MATCHER,
          hooks: [
            {
              type: 'command',
              command: claudeAskRelayHookCommand(relay),
              timeout: CLAUDE_RELAY_HOOK_TIMEOUT_SECONDS,
            },
          ],
        },
      ],
    },
  };
}

/**
 * The `--settings <inline JSON>` argv pair carrying the ask-relay hook.
 * Returns `[]` when no relay was requested, or when the descriptor's
 * `protocol` is not `file-v1` — an unknown protocol must never emit a
 * half-understood hook — so callers can spread this straight into the argv
 * ahead of the `--` end-of-options marker.
 */
export function claudeRelayFlags(relay?: AskRelayDescriptor): string[] {
  if (relay === undefined || relay.protocol !== 'file-v1') {
    return [];
  }
  return ['--settings', JSON.stringify(claudeAskRelaySettings(relay))];
}
