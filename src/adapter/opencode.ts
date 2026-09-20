import { execFile } from 'child_process';
import type { Adapter, LaunchRequest, LaunchSpec, ProbeResult } from './adapter';
import { AGENT_BINARY } from './adapter';
import type { Role } from '../model/role';
import { roleProfile, runDirPattern } from './roleProfile';
import type { AgentAllowList, ToolAllowRule } from './roleProfile';

/** The opencode CLI executable name, sourced from the canonical binary map (Requirement 14.1). */
const OPENCODE_BIN = AGENT_BINARY.opencode;

/** How long to wait for `opencode --version` / `opencode session list` before giving up (ms). */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * The prefix opencode puts on every session id it mints (`ses_…`). Baiton's
 * own Session_Ids are UUIDs, so this is how the adapter tells a resolved
 * opencode id from an unresolved Baiton one before spending it on `-s`.
 */
export const OPENCODE_SESSION_ID_PREFIX = 'ses_';

/** True when `id` is an id opencode minted, as opposed to a Baiton Session_Id. */
export function isOpencodeSessionId(id: string | undefined): boolean {
  return id !== undefined && id.startsWith(OPENCODE_SESSION_ID_PREFIX);
}

/** One row of `opencode session list --format json`; only the fields the adapter reads. */
export interface OpencodeSessionRow {
  id: string;
  title?: string;
}

/**
 * Seam over `opencode session list --format json` run in `cwd`, so tests can
 * inject a fake listing. Rejects on any failure.
 */
export type ListSessionsFn = (cwd: string) => Promise<OpencodeSessionRow[]>;

/** Build the `--agent baiton-<role>` flag pair for a role. */
export function opencodeAgentFlags(role: Role): string[] {
  return ['--agent', roleProfile(role).agentName];
}

/** The env var opencode reads as inline, process-local config JSON. */
export const OPENCODE_CONFIG_ENV = 'OPENCODE_CONFIG_CONTENT';

/** One opencode permission rule table: glob pattern to `allow` / `deny`. */
export type OpencodePermissionRules = Record<string, string>;

/** The custom-agent definition this adapter synthesises from a role profile. */
export interface OpencodeAgentDefinition {
  description: string;
  mode: 'primary';
  prompt: string;
  permission: {
    edit: OpencodePermissionRules;
    bash?: OpencodePermissionRules;
  };
}

/**
 * Build the inline opencode config defining exactly one custom agent —
 * `baiton-<role>` — from that role's {@link roleProfile}.
 *
 * The agent carries the profile's prompt as its system prompt and translates
 * the profile's write scope and shell bit into opencode `permission` rules:
 *
 * - `write: 'run-dir'` becomes `edit: {"*": "deny", "<run dir>/*": "allow"}` —
 *   the more specific glob wins, so the run result file is writable and
 *   nothing else is;
 * - `write: 'workspace'` becomes `edit: {"*": "allow"}`;
 * - `shell: false` adds `bash: {"*": "deny"}`; `shell: true` omits the block
 *   entirely so opencode's own default (allow) applies.
 *
 * Defining our own agent rather than reusing opencode's built-in `plan`
 * profile is the point of this function: opencode's `SessionReminders` injects
 * a hard read-only reminder keyed on the *name* `plan` (verified in v1.18.30
 * `session/reminders.ts`, condition `agent.name === "plan"`), which overrode
 * the granted run-dir write and left the planner unable to produce
 * `result.json`. A `baiton-`-prefixed name never matches that condition.
 */
export function opencodeAgentDefinition(role: Role, runId: string): OpencodeAgentDefinition {
  const profile = roleProfile(role);

  const edit: OpencodePermissionRules =
    profile.write === 'workspace'
      ? { '*': 'allow' }
      : { '*': 'deny', [`${runDirPattern(runId)}*`]: 'allow' };

  const permission: OpencodeAgentDefinition['permission'] = { edit };
  if (!profile.shell) {
    permission.bash = { '*': 'deny' };
  }

  return {
    description: profile.description,
    mode: 'primary',
    prompt: profile.systemPrompt,
    permission,
  };
}

/**
 * Normalise an opencode glob pattern for the auto-mode gate's matcher.
 * `src/orchestrator/glob.ts` treats a single `*` as non-separator-crossing,
 * so opencode's trailing `/*` (the run-dir rule) is rewritten as `**` then
 * `/*`, and a bare `*` likewise becomes `**` then `/*`: a lone trailing `**`
 * compiles to segments-only `(?:[^/]+/)*` and would never match a file
 * inside the tree, while the final `*` component provides it. Anything else
 * passes through unchanged.
 */
function toGlob(pattern: string): string {
  if (pattern.endsWith('/*') && !pattern.endsWith('/**/*')) {
    // Drop the trailing `*`, keep the slash, then add `**/*`.
    return `${pattern.slice(0, -1)}**/*`;
  }
  return pattern === '*' ? '**/*' : pattern;
}

/**
 * Derive opencode's auto-mode allow-list from {@link opencodeAgentDefinition}
 * rather than from the role profile directly, so the gate reads exactly the
 * permission table opencode is launched with.
 *
 * - `edit` allow keys become the write rule's `paths` (deny keys are dropped:
 *   they are the default-deny backdrop; a path only auto-approves when it
 *   matches an `allow` glob);
 * - no `bash` block means opencode's own default (allow) applies, so a shell
 *   rule is emitted; a `bash` block denying `*` emits none;
 * - read and search are always granted unscoped (opencode grants them to
 *   every agent; there is no rule table for them).
 */
export function opencodeAllowList(role: Role, runId: string): AgentAllowList {
  const definition = opencodeAgentDefinition(role, runId);

  const writePaths: string[] = [];
  for (const [pattern, value] of Object.entries(definition.permission.edit)) {
    if (value === 'allow') {
      writePaths.push(toGlob(pattern));
    }
  }
  const rules: ToolAllowRule[] = [
    { family: 'read', reason: 'every role may read' },
    { family: 'search', reason: 'every role may search' },
    { family: 'write', paths: writePaths, reason: 'opencode edit allow globs' },
  ];

  const bash = definition.permission.bash;
  if (bash === undefined || bash['*'] !== 'deny') {
    rules.push({ family: 'shell', reason: 'opencode agent has no bash deny rule' });
  }

  return { agent: 'opencode', role, runId, rules };
}

/**
 * Build the `OPENCODE_CONFIG_CONTENT` env override carrying the custom agent
 * for `role` and `runId` (Requirement 15.4 for opencode).
 *
 * opencode parses `OPENCODE_CONFIG_CONTENT` as a config layer for that process
 * only, so nothing is written to disk and the definition lives and dies with
 * the launched terminal.
 */
export function opencodeConfigEnv(role: Role, runId: string): Record<string, string> {
  const config = {
    agent: {
      [roleProfile(role).agentName]: opencodeAgentDefinition(role, runId),
    },
  };
  return { [OPENCODE_CONFIG_ENV]: JSON.stringify(config) };
}

/**
 * Opencode model list: empty by design because opencode models are arbitrary
 * `provider/model` identifiers configured by the user or provider.
 * An empty list signals free-text rendering in the config panel.
 */
export const OPENCODE_MODELS: readonly string[] = [];

/**
 * Opencode effort list: empty by design because effort maps to user-configured
 * `--variant` values. An empty list signals free-text rendering in the config panel.
 */
export const OPENCODE_EFFORTS: readonly string[] = [];

/** Documentation URL for opencode model selection rendered inline in the config panel. */
export const OPENCODE_MODEL_DOC_URL = 'https://opencode.ai/docs/go/';

/**
 * The opencode CLI adapter (Requirement 14.1).
 *
 * How this adapter differs from the Claude adapter, documented here rather
 * than silently implied:
 *
 * 1. opencode has no `--add-dir` flag and no granular allow-list on the command
 *    line, so the whole per-role policy — the Requirement 15.4 run-dir grant
 *    included — is emitted as an environment override instead: see
 *    {@link opencodeConfigEnv}, which sets `OPENCODE_CONFIG_CONTENT` to an
 *    inline config defining one Baiton-owned agent, `baiton-<role>`, with the
 *    role profile's prompt and its `edit`/`bash` permission rules. opencode
 *    merges that as a process-local config layer, so nothing is written to
 *    disk and the definition does not outlive the terminal. `--auto` is
 *    deliberately never emitted: it auto-approves everything (opencode's own
 *    help calls it "dangerous!") rather than scoping to the run dir.
 * 1a. The adapter no longer maps roles onto opencode's built-in `plan`/`build`
 *    profiles. `plan` is not a permission setting but a *name* opencode's
 *    `SessionReminders` keys on to inject an unconditional read-only reminder,
 *    which defeated the run-dir write grant outright. Baiton owns the agent
 *    definition now, so the policy is stated once in `roleProfile.ts` and
 *    translated here.
 * 2. opencode mints its own session id (`ses_…`) on a fresh run and exposes no
 *    flag to pre-assign one. `launch()` therefore cannot make `req.sessionId`
 *    the session's id; instead it passes it as the session's `--title`, and
 *    {@link OpencodeAdapter.resolveSessionId} looks the minted id back up from
 *    `opencode session list --format json` by that title before a resume or
 *    attach. `-s` is only ever given an id opencode minted
 *    ({@link isOpencodeSessionId}); handing it a Baiton UUID makes opencode
 *    print "Session not found" and exit 1 before its logger even starts —
 *    exactly what happened to every execute retry (attempt ≥ 2 resumes the
 *    prior attempt's Session_Id) before this resolution existed. An
 *    unresolvable id degrades to `-c` (most recent session in this project),
 *    which opencode accepts even when the project has no sessions yet.
 * 3. This adapter emits **no** ask-relay wiring: `LaunchRequest.relay` is
 *    deliberately ignored, and `launch()`/`attach()` produce byte-identical
 *    specs with and without a descriptor. That is a probe result, not an
 *    omission — see README.md, "Harness ask relay (per-adapter probe
 *    findings)", for the transcript. On opencode 1.18.30 the only surface that
 *    can intercept a tool call is a plugin's `tool.execute.before` hook
 *    (verified end-to-end: it fires with the tool name and args, and throwing
 *    from it blocks the call), but opencode only loads a plugin from a *file*
 *    — a `file://` path or npm module named in the inline config's `plugin`
 *    array, or `.opencode/plugin/<name>.js` in the cwd. A `data:` URL carrying
 *    the source inline is silently ignored, so there is no way to install the
 *    relay without writing a file to disk, and `launch()` is a pure function
 *    that must not. opencode's own config-driven permission layer
 *    ({@link opencodeAgentDefinition}) therefore remains its whole policy
 *    surface, with the generic fallback covering asks; note that an `ask`
 *    action is not a relay either, because a non-interactive `opencode run`
 *    auto-rejects it ("permission requested: bash (…); auto-rejecting").
 *
 * The run-dir path this adapter hands opencode in the initial prompt relies on
 * the workspace root already being canonical (see `canonicalizeRoot` in
 * `src/activation/workspace.ts`): opencode compares every target against its
 * own realpath'd cwd, so a root reached through a symlink makes the brief look
 * like an external directory and `opencode run`, being non-interactive,
 * auto-rejects the resulting permission ask.
 */
export class OpencodeAdapter implements Adapter {
  readonly id = 'opencode' as const;

  constructor(private readonly listSessions: ListSessionsFn = defaultListSessions) {}

  /**
   * opencode mints its own session id and has no flag to pre-assign one, but
   * `launch()` tags the fresh session with Baiton's id as its `--title`, so the
   * journal `sessionId` is resumable once {@link resolveSessionId} has mapped
   * it back to the minted `ses_…` id. Callers therefore treat the journaled id
   * as resumable and run it through `resolveSessionId` before `-s`.
   */
  readonly acceptsSessionId = true;

  /**
   * Run `opencode --version` and report readiness (Requirements 14.2–14.4). A
   * clean exit with a version string is `ok: true`; any failure is `ok: false`
   * with a non-empty reason.
   */
  async probe(): Promise<ProbeResult> {
    try {
      const version = await this.runVersion();
      const trimmed = version.trim();
      if (trimmed.length === 0) {
        return {
          version: '',
          ok: false,
          reason: `${OPENCODE_BIN} --version produced no version output`,
        };
      }
      return { version: trimmed, ok: true };
    } catch (e) {
      return {
        version: '',
        ok: false,
        reason: describeProbeError(e),
      };
    }
  }

  /**
   * Build the terminal launch for one stage.
   *
   * Fresh launch: `opencode run --title <sessionId> -m <model> --agent
   * baiton-<role> [--variant <effort>] -i "<prompt>"` — the title is how
   * `req.sessionId` survives (see the class doc comment). Resume: `-s
   * <resumeSessionId>` when the caller has already resolved it to an opencode
   * id via {@link resolveSessionId}, falling back to `-c` when there is no
   * prior id or it is still an unresolved Baiton UUID (Requirements 13.2, 13.3).
   */
  launch(req: LaunchRequest): LaunchSpec {
    const args: string[] = ['run'];

    if (req.resume) {
      args.push(...sessionSelector(req.resumeSessionId));
    } else if (req.sessionId.length > 0) {
      args.push('--title', req.sessionId);
    }

    args.push('-m', req.model);
    args.push(...opencodeAgentFlags(req.role));
    if (req.effort !== undefined && req.effort.length > 0) {
      args.push('--variant', req.effort);
    }
    args.push('-i');
    args.push(req.prompt);

    return { shellPath: OPENCODE_BIN, shellArgs: args, env: opencodeConfigEnv(req.role, req.runId) };
  }

  /**
   * Build the args to reopen an existing session with no prompt: `opencode
   * run -s <id> --agent baiton-<role> -i` (Requirements 3.3, 3.4). As with
   * `launch()`, `-s` is only emitted for an id opencode minted; pass the
   * result of {@link resolveSessionId}. An unresolved id degrades to `-c`.
   *
   * `req.runId` never reaches the command line (there is no `--add-dir` here);
   * it is carried by the `OPENCODE_CONFIG_CONTENT` env layer instead.
   */
  attach(req: { role: Role; runId: string; sessionId: string }): LaunchSpec {
    const args: string[] = [
      'run',
      ...sessionSelector(req.sessionId),
      ...opencodeAgentFlags(req.role),
      '-i',
    ];

    return { shellPath: OPENCODE_BIN, shellArgs: args, env: opencodeConfigEnv(req.role, req.runId) };
  }

  /**
   * Find the opencode session whose `--title` is the Baiton Session_Id
   * `sessionId` (set by `launch()` on the fresh run) and return its minted
   * `ses_…` id. An id that is already opencode's is returned unchanged. Any
   * listing failure, or no session carrying that title, resolves `undefined`
   * so the caller falls back to `-c`; this never throws.
   */
  async resolveSessionId(sessionId: string, cwd: string): Promise<string | undefined> {
    if (isOpencodeSessionId(sessionId)) {
      return sessionId;
    }
    if (sessionId.length === 0) {
      return undefined;
    }
    try {
      const rows = await this.listSessions(cwd);
      const match = rows.find((row) => row.title === sessionId && isOpencodeSessionId(row.id));
      return match?.id;
    } catch {
      return undefined;
    }
  }

  /** Execute `opencode --version`, resolving stdout or rejecting on failure. */
  private runVersion(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      execFile(
        OPENCODE_BIN,
        ['--version'],
        { timeout: PROBE_TIMEOUT_MS, windowsHide: true },
        (error, stdout) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(stdout);
        },
      );
    });
  }
}

/**
 * The `-s <id>` / `-c` session selector for resume and attach: `-s` only for
 * an id opencode minted, `-c` (most recent session in this project) otherwise.
 */
function sessionSelector(sessionId: string | undefined): string[] {
  return sessionId !== undefined && isOpencodeSessionId(sessionId) ? ['-s', sessionId] : ['-c'];
}

/**
 * Run `opencode session list --format json` in `cwd` and parse its rows.
 * opencode scopes the listing to the project containing `cwd`, so the
 * workspace root is the right cwd. Rejects on spawn failure, non-zero exit,
 * or unparseable output.
 */
function defaultListSessions(cwd: string): Promise<OpencodeSessionRow[]> {
  return new Promise<OpencodeSessionRow[]>((resolve, reject) => {
    execFile(
      OPENCODE_BIN,
      ['session', 'list', '--format', 'json'],
      { cwd, timeout: PROBE_TIMEOUT_MS, windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        try {
          const parsed: unknown = JSON.parse(stdout);
          resolve(Array.isArray(parsed) ? (parsed as OpencodeSessionRow[]) : []);
        } catch (e) {
          reject(e);
        }
      },
    );
  });
}

/** Turn a probe failure into a human-readable, non-empty reason. */
function describeProbeError(e: unknown): string {
  if (e && typeof e === 'object' && 'code' in e && (e as { code?: unknown }).code === 'ENOENT') {
    return `${OPENCODE_BIN} was not found on PATH`;
  }
  if (e instanceof Error && e.message.length > 0) {
    return `${OPENCODE_BIN} --version failed: ${e.message}`;
  }
  return `${OPENCODE_BIN} --version failed`;
}
