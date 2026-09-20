/**
 * The auto-mode first gate: a pure, deterministic, host-free decision over a
 * harness permission ask and an agent's allow-list (stage (a)).
 *
 * This module knows nothing about `vscode`, the filesystem, or the model
 * client: it takes the {@link PermissionRequest} shape from
 * `src/orchestrator/interventions.ts` and an `AgentAllowList` (from
 * `src/adapter/roleProfile.ts`, derived per adapter via
 * `agentAllowList` in `src/adapter/index.ts`) and returns either an
 * `approve` — with a one-line rationale naming the agent, role, tool and
 * matched rule, which the later transcript audit record will carry — or an
 * `escalate`, which stage (b), the model evaluator (a later todo), consumes.
 * This module never calls a model.
 *
 * Two deliberate narrowings, documented plainly:
 *
 * 1. Path scope. A write ask auto-approves only when every target path can be
 *    proven in-scope: it must be relative (absolute paths, `file://` URLs and
 *    any `..` segment return `undefined` from {@link normalizeAskPath} and
 *    force an escalate) and it must match one of the rule's repo-relative
 *    globs. An unparseable `args`, or a write whose target cannot be
 *    determined, escalates rather than approving.
 *
 * 2. Shell. The role profile's `shell: true` bit alone is *not* blanket
 *    approval: it makes shell *eligible* (the allow-list contains a shell
 *    rule), and only the recognised safe read-only/verification prefixes in
 *    {@link SAFE_SHELL_PREFIXES} clear this first gate — chained commands
 *    (`;`, `&&`, `|`, …), redirects, substitutions and anything not on the
 *    prefix list all escalate to stage (b).
 *
 * Tool names are normalised through {@link TOOL_FAMILIES}, keyed by the
 * lower-cased harness tool name. Anything unmapped — `webfetch`, `websearch`,
 * `task`, `agent`, and any future harness tool — escalates, so the failure
 * mode of a missing name is an extra round-trip, never an unsafe approval.
 */
import type { PermissionRequest } from './interventions';
import { matchesGlob } from './glob';
import type { AgentAllowList, AllowedToolFamily, ToolAllowRule } from '../adapter/roleProfile';

/** The minimal shape the gate needs from a permission ask. */
export interface AutoModeAsk {
  agent: string;
  tool: string;
  args?: string;
}

/** Map a full {@link PermissionRequest} intervention onto the gate's ask shape. */
export function askFromPermission(req: PermissionRequest): AutoModeAsk {
  return { agent: req.agent, tool: req.tool, args: req.args };
}

/** The gate's decision: an approval carrying its audit rationale, or an escalation to stage (b). */
export type AutoModeDecision =
  | { kind: 'approve'; rationale: string; rule: ToolAllowRule }
  | { kind: 'escalate'; reason: string };

/** Harness tool names (lower-cased) mapped onto their canonical tool family. */
export const TOOL_FAMILIES: Readonly<Record<string, AllowedToolFamily>> = {
  read: 'read',
  view: 'read',
  notebookread: 'read',
  glob: 'search',
  grep: 'search',
  list: 'search',
  ls: 'search',
  list_files: 'search',
  search: 'search',
  write: 'write',
  edit: 'write',
  multiedit: 'write',
  patch: 'write',
  apply_patch: 'write',
  notebookedit: 'write',
  bash: 'shell',
  shell: 'shell',
  run: 'shell',
  execute_command: 'shell',
};

/** The tool family for a harness tool name, or `undefined` when unmapped (which escalates). */
export function toolFamily(tool: string): AllowedToolFamily | undefined {
  const key = tool.trim().toLowerCase();
  // Own-key lookup: a tool literally named `__proto__` must not hit the prototype.
  return Object.prototype.hasOwnProperty.call(TOOL_FAMILIES, key) ? TOOL_FAMILIES[key] : undefined;
}

/** The string keys whose value is read as a target path when parsing tool args. */
const PATH_KEYS = ['file_path', 'filePath', 'path', 'notebook_path', 'file', 'target'] as const;

/** The array keys whose string elements are read as target paths when parsing tool args. */
const PATH_LIST_KEYS = ['paths', 'files'] as const;

/**
 * Parse tool args as a JSON object. Missing/blank `args` is an empty object
 * (no paths, no command); unparseable JSON or a non-object is an error.
 */
function parseArgs(args: string | undefined): { ok: true; obj: Record<string, unknown> } | { ok: false; reason: string } {
  if (args === undefined || args.trim().length === 0) {
    return { ok: true, obj: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(args);
  } catch {
    return { ok: false, reason: 'the tool arguments could not be read' };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, reason: 'the tool arguments could not be read' };
  }
  return { ok: true, obj: parsed as Record<string, unknown> };
}

/**
 * Collect the target paths named in tool args: string values under
 * `file_path`, `filePath`, `path`, `notebook_path`, `file`, `target`, plus
 * every string in an array under `paths` or `files`.
 */
export function askPaths(args: string | undefined): { ok: true; paths: string[] } | { ok: false; reason: string } {
  const parsed = parseArgs(args);
  if (!parsed.ok) {
    return parsed;
  }
  const paths: string[] = [];
  for (const key of PATH_KEYS) {
    const value = parsed.obj[key];
    if (typeof value === 'string') {
      paths.push(value);
    }
  }
  for (const key of PATH_LIST_KEYS) {
    const value = parsed.obj[key];
    if (Array.isArray(value)) {
      for (const item of value) {
        if (typeof item === 'string') {
          paths.push(item);
        }
      }
    }
  }
  return { ok: true, paths };
}

/**
 * Normalise a candidate write target to the repo-relative form the glob
 * matcher compares against: backslashes become `/` and a leading `./` is
 * stripped. Returns `undefined` — "cannot be proven in-scope", which forces
 * an escalate — for an absolute path (`/…` or a Windows drive), a `file://`
 * URL, or any `..` segment.
 */
export function normalizeAskPath(p: string): string | undefined {
  if (p.startsWith('file://')) {
    return undefined;
  }
  const posix = p.replace(/\\/g, '/').trim();
  if (posix.startsWith('/')) {
    return undefined;
  }
  // A Windows drive (`C:` or `C:\…`).
  if (/^[A-Za-z]:/.test(posix)) {
    return undefined;
  }
  const stripped = posix.startsWith('./') ? posix.slice(2) : posix;
  const segments = stripped.split('/');
  if (segments.includes('..')) {
    return undefined;
  }
  return stripped;
}

/**
 * The read-only/verification shell prefixes the first gate auto-approves for
 * a shell-eligible role. Matched longest-first against the command's first
 * token(s) after whitespace normalisation; everything else escalates.
 */
export const SAFE_SHELL_PREFIXES: readonly string[] = [
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'pwd',
  'which',
  'rg',
  'grep',
  'find',
  'git status',
  'git diff',
  'git log',
  'git show',
  'git branch',
  'npm test',
  'npm run lint',
  'npm run compile',
  'npm run build',
  'npx tsc',
  'node --version',
];

/** Unsafe constructs that make any shell command escalate, however it starts. */
const SHELL_CHAIN_CHARS = [';', '&&', '||', '|', '`', '$(', '>', '<', '\n'];

/** Sort longest-first so `git status` is tried before `git`. */
const SORTED_SAFE_PREFIXES = [...SAFE_SHELL_PREFIXES].sort((a, b) => b.length - a.length);

/**
 * Deterministic conservative check that a shell command is a recognised
 * read-only/verification command: it must contain no chaining, piping,
 * redirection or substitution construct, and its first token(s) must match a
 * {@link SAFE_SHELL_PREFIXES} entry (longest prefix first, on
 * whitespace-normalised text).
 */
export function shellCommandIsSafe(command: string): boolean {
  if (SHELL_CHAIN_CHARS.some((c) => command.includes(c))) {
    return false;
  }
  const normalized = command.trim().replace(/\s+/g, ' ');
  return SORTED_SAFE_PREFIXES.some((prefix) => normalized === prefix || normalized.startsWith(`${prefix} `));
}

/** The read-only families whose unscoped rules approve without a path check. */
function unscopedReadonly(family: AllowedToolFamily, rule: ToolAllowRule): boolean {
  return (family === 'read' || family === 'search') && rule.paths === undefined;
}

/**
 * The first gate: decide a permission ask against an agent's allow-list.
 * Pure and synchronous — same inputs give the same decision, and the passed
 * allow-list is never mutated. Every escalation carries a non-empty,
 * human-readable reason; every approval carries a one-line rationale naming
 * the agent, role, tool and matched rule, plus the matched rule itself.
 */
export function allowListDecision(ask: AutoModeAsk, allowList: AgentAllowList): AutoModeDecision {
  // 1. The ask must come from the allow-list's own agent.
  if (ask.agent !== allowList.agent) {
    return { kind: 'escalate', reason: 'the ask came from a different agent than the allow-list' };
  }

  // 2. The tool must be one the gate knows a family for.
  const family = toolFamily(ask.tool);
  if (family === undefined) {
    return { kind: 'escalate', reason: `"${ask.tool}" is not on the allow-list` };
  }

  // 3. The allow-list must contain a rule for that family.
  const rules = allowList.rules.filter((rule) => rule.family === family);
  if (rules.length === 0) {
    return { kind: 'escalate', reason: `${allowList.role} may not use ${family} tools` };
  }

  // 4. Read/search with an unscoped rule approve immediately; a path-scoped
  //    rule falls through to the path check below.
  const unscoped = rules.find((rule) => unscopedReadonly(family, rule));
  if (unscoped !== undefined) {
    return {
      kind: 'approve',
      rationale: `${allowList.agent}/${allowList.role}: ${ask.tool} allowed (${unscoped.reason})`,
      rule: unscoped,
    };
  }

  // 6. Shell: the command must be a recognised read-only/verification
  //    command. The profile's `shell: true` bit alone is not blanket approval
  //    — it makes shell *eligible* (there is a shell rule); only the
  //    recognised safe prefixes clear this first gate, everything else goes
  //    to stage (b).
  if (family === 'shell') {
    const parsedArgs = parseArgs(ask.args);
    if (!parsedArgs.ok) {
      return { kind: 'escalate', reason: parsedArgs.reason };
    }
    const rawCommand = parsedArgs.obj['command'] ?? parsedArgs.obj['cmd'];
    if (typeof rawCommand !== 'string' || rawCommand.trim().length === 0) {
      return { kind: 'escalate', reason: 'the shell command could not be determined' };
    }
    if (!shellCommandIsSafe(rawCommand)) {
      return { kind: 'escalate', reason: 'the command is not a recognised read-only or verification command' };
    }
    const rule = rules[0];
    return {
      kind: 'approve',
      rationale: `${allowList.agent}/${allowList.role}: ${ask.tool} allowed (${rule.reason})`,
      rule,
    };
  }

  // 5. Write (or path-scoped read/search): every target path must be provably
  //    in-scope and match one of the rule's globs.
  const parsed = askPaths(ask.args);
  if (!parsed.ok) {
    return { kind: 'escalate', reason: parsed.reason };
  }
  if (parsed.paths.length === 0) {
    return { kind: 'escalate', reason: 'the write target could not be determined' };
  }
  const normalized: string[] = [];
  for (const p of parsed.paths) {
    const n = normalizeAskPath(p);
    if (n === undefined) {
      return { kind: 'escalate', reason: `"${p}" cannot be proven to stay inside the workspace` };
    }
    normalized.push(n);
  }
  for (const rule of rules) {
    const globs = rule.paths ?? [];
    if (normalized.every((n) => globs.some((glob) => matchesGlob(n, glob)))) {
      return {
        kind: 'approve',
        rationale: `${allowList.agent}/${allowList.role}: ${ask.tool} allowed (${rule.reason})`,
        rule,
      };
    }
  }
  return { kind: 'escalate', reason: 'the write target is outside the allowed paths' };
}
