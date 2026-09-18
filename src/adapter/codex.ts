import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  Adapter,
  DiscoverSessionInput,
  LaunchRequest,
  LaunchSpec,
  ProbeResult,
} from './adapter';
import { AGENT_BINARY } from './adapter';
import type { Role } from '../model/role';
import { runDirGrant } from './permissions';
import { roleProfile } from './roleProfile';

/** The codex CLI executable name, sourced from the canonical binary map (Requirement 14.1). */
const CODEX_BIN = AGENT_BINARY.codex;

/** How long to wait for `codex --version` before giving up (ms). */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * codex's read-only sandbox. Deliberately NOT used for the read-only roles —
 * see degrade 5 on the class doc comment. Kept named so the option we rejected
 * is visible at the decision site rather than only in history.
 */
export const CODEX_READ_ONLY_SANDBOX = 'read-only';

/** The codex `--sandbox` value used for every role (see degrade 5). */
export const CODEX_WORKSPACE_WRITE_SANDBOX = 'workspace-write';

/** The codex `--ask-for-approval` value used for every role. */
export const CODEX_ASK_FOR_APPROVAL = 'on-request';

/**
 * Build the `--sandbox workspace-write --ask-for-approval on-request` flags.
 *
 * Role-independent by design: `--sandbox read-only` is a whole-session sandbox
 * that also blocks the run-dir result write every role must perform, so every
 * role runs `workspace-write` and the no-edit rule is carried by
 * {@link codexSystemPromptFlags} plus the brief plus the post-run reset —
 * mirroring claude's `readOnlyFallbackToAcceptEdits` fallback. `role` is kept
 * in the signature because it is the natural seam if codex ever gains a scoped
 * write allow-list.
 */
export function codexPermissionFlags(_role: Role): string[] {
  return [
    '--sandbox',
    CODEX_WORKSPACE_WRITE_SANDBOX,
    '--ask-for-approval',
    CODEX_ASK_FOR_APPROVAL,
  ];
}

/**
 * Where codex keeps its rollout transcripts: `$CODEX_HOME/sessions/YYYY/MM/DD/`
 * (default `~/.codex`), one `rollout-<ISO time>-<uuid>.jsonl` per session whose
 * first line is `{"type":"session_meta","payload":{"id","cwd",...}}`.
 */
const CODEX_SESSIONS_DIR = 'sessions';

/**
 * Tolerance subtracted from a run's launch time when filtering rollout files by
 * mtime. Covers clock skew and the gap between Baiton's `launchedAt` and the
 * moment codex creates the file.
 */
const DISCOVERY_MTIME_SLACK_MS = 120_000;

/** How much of a rollout file is read while looking for the run's brief path. */
const DISCOVERY_MAX_BYTES = 256 * 1024;

/** How many leading lines of a rollout file may mention the run id. */
const DISCOVERY_MAX_LINES = 50;

/** The config key codex reads as extra developer-level system instructions. */
export const CODEX_DEVELOPER_INSTRUCTIONS_CONFIG_KEY = 'developer_instructions';

/**
 * Render `value` as a basic TOML string: wrapped in double quotes, with
 * backslashes and double quotes escaped and newlines encoded as `\n`.
 *
 * codex parses the `value` half of `-c key=value` as TOML and only falls back
 * to a literal raw string when that parse fails, so a prompt containing a
 * quote or a newline must be quoted here or it is silently mangled.
 */
export function tomlQuote(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n');
  return `"${escaped}"`;
}

/**
 * Build the `-c developer_instructions="<profile prompt>"` pair carrying the
 * role profile's plain-language constraints (codex's analogue of claude's
 * `--append-system-prompt`).
 */
export function codexSystemPromptFlags(role: Role): string[] {
  return [
    '-c',
    `${CODEX_DEVELOPER_INSTRUCTIONS_CONFIG_KEY}=${tomlQuote(roleProfile(role).systemPrompt)}`,
  ];
}

/** The config key codex's generic `--config` override uses to set reasoning effort. */
export const CODEX_EFFORT_CONFIG_KEY = 'model_reasoning_effort';

/**
 * Curated OpenAI Codex models exposed in the config panel dropdown.
 * Deliberately advisory: the "Other…" escape allows typing any unlisted model.
 */
export const CODEX_MODELS: readonly string[] = [
  'gpt-6-astra',
  'gpt-5-codex',
  'o3',
  'o3-mini',
  'o1',
] as const;

/**
 * Reasoning effort levels codex accepts for `--config model_reasoning_effort=<e>`.
 * Lists every documented level to avoid falsely rejecting valid user configurations.
 */
export const CODEX_EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

/** Build the `--config model_reasoning_effort=<effort>` flag pair, or `[]` when effort is unset. */
export function codexEffortFlags(effort: string | undefined): string[] {
  if (effort === undefined || effort.length === 0) {
    return [];
  }
  return ['--config', `${CODEX_EFFORT_CONFIG_KEY}=${effort}`];
}

/**
 * The codex CLI adapter (Requirement 14.1). Flags verified against
 * `codex-cli` v0.154.0 via `codex --version`/`codex --help`/`codex resume
 * --help`.
 *
 * Deliberate degrades from the Claude adapter, documented here rather than
 * silently implied to be enforced:
 *
 * 1. codex mints its own session UUID on a fresh run and exposes no flag to
 *    pre-assign one, so `launch()` ignores `req.sessionId` when `req.resume`
 *    is false; the journal's recorded session id will not match codex's
 *    actual session for a fresh launch.
 * 2. The interactive form `codex [OPTIONS] [PROMPT]` is used, NOT the `codex
 *    exec` subcommand, because `exec` is a non-interactive one-shot that
 *    exits — the wrong shape for a terminal the user watches and interjects
 *    in.
 * 3. codex has no reasoning-effort flag; effort is degraded onto
 *    `--config model_reasoning_effort=<effort>`, codex's generic config
 *    override.
 * 4. Resume with no known prior id uses `codex resume --last` and DROPS the
 *    prompt: `codex resume --last <text>` binds `<text>` to the SESSION_ID
 *    positional, not PROMPT, so passing the prompt there would silently be
 *    read as a session name and the resume would target a session that does
 *    not exist.
 * 5. Every role, read-only ones included, gets `--sandbox workspace-write`.
 *    `--sandbox read-only` is a whole-session sandbox with no scoped
 *    allow-list like claude's `Write(.baiton/runs/**)`, so it also blocks the
 *    run-dir result write that is the entire deliverable of a read-only stage.
 *    The no-edit rule is therefore carried in prose — by the role profile's
 *    `developer_instructions` and by the brief — and backstopped by the
 *    post-run reset, exactly as claude's `readOnlyFallbackToAcceptEdits`
 *    fallback does. The Requirement 15.4 run-dir grant is still emitted via
 *    `--add-dir`. This is a real degrade: a misbehaving read-only role can
 *    write inside the workspace and is caught after the fact, not prevented.
 * 6. `--dangerously-bypass-approvals-and-sandbox`,
 *    `--dangerously-bypass-hook-trust`, `--approve-for-me`,
 *    `--sandbox danger-full-access` and `--ask-for-approval never` are
 *    deliberately never emitted.
 */
export class CodexAdapter implements Adapter {
  readonly id = 'codex' as const;

  /**
   * codex mints its own session UUID on a fresh run (degrade 1 above), so
   * Baiton's journal `sessionId` names no session it knows: `codex resume
   * <that uuid>` prints "No saved session found with ID ..." and exits 1
   * before a session exists. The real id is recovered after the fact by
   * {@link CodexAdapter.discoverSessionId}.
   */
  readonly acceptsSessionId = false;

  /**
   * Run `codex --version` and report readiness (Requirements 14.2–14.4). A
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
          reason: `${CODEX_BIN} --version produced no version output`,
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
   * Fresh launch: `codex --model <m> [--config model_reasoning_effort=<e>]
   * --sandbox workspace-write --ask-for-approval on-request --add-dir
   * <run-dir> -c developer_instructions="<profile prompt>" -- "<prompt>"`
   * (`req.sessionId` is deliberately dropped, see the class doc comment). Resume: `resume <resumeSessionId>`
   * leads the arguments when a prior Session_Id is known, falling back to
   * `resume --last` (with no prompt) when it is not (Requirements 13.2, 13.3,
   * 15.1–15.4). Every role is additionally granted write access to its own
   * `.baiton/runs/<run-id>/` directory (Requirement 15.4).
   */
  launch(req: LaunchRequest): LaunchSpec {
    const args: string[] = [];
    let droppedPrompt = false;

    if (req.resume) {
      if (req.resumeSessionId !== undefined && req.resumeSessionId.length > 0) {
        args.push('resume', req.resumeSessionId);
      } else {
        args.push('resume', '--last');
        droppedPrompt = true;
      }
    }

    args.push('--model', req.model);
    args.push(...codexEffortFlags(req.effort));
    args.push(...codexPermissionFlags(req.role));
    args.push(...runDirGrant(req.runId));
    args.push(...codexSystemPromptFlags(req.role));

    if (!droppedPrompt) {
      args.push('--', req.prompt);
    }

    return { shellPath: CODEX_BIN, shellArgs: args };
  }

  /**
   * Build the args to reopen an existing session with no prompt: `codex
   * resume <id> --sandbox workspace-write --ask-for-approval on-request
   * --add-dir <run-dir> -c developer_instructions="<profile prompt>"`
   * (Requirements 3.3, 3.4).
   */
  attach(req: { role: Role; runId: string; sessionId: string }): LaunchSpec {
    const args: string[] = [
      'resume',
      req.sessionId,
      ...codexPermissionFlags(req.role),
      ...runDirGrant(req.runId),
      ...codexSystemPromptFlags(req.role),
    ];

    return { shellPath: CODEX_BIN, shellArgs: args };
  }

  /**
   * Recover the session id codex actually minted for a run (degrade 1 above),
   * so a later Execute can `codex resume <real id>` instead of the journal's
   * unusable pre-assigned UUID.
   *
   * codex writes one rollout transcript per session at
   * `$CODEX_HOME/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO time>-<uuid>.jsonl`
   * (`$CODEX_HOME` defaults to `~/.codex`). Line 1 is a `session_meta` record
   * carrying the session `id` and the `cwd` it ran in; the first user turn
   * carries Baiton's initial prompt, which names the run's `brief.md` and so
   * contains the run id. A file therefore identifies this run when its `cwd`
   * is the workspace root and its opening lines mention the run id.
   *
   * The scan is bounded: only the launch day's and the next day's date
   * directories, only files modified at/after the launch (minus a slack), and
   * only the first {@link DISCOVERY_MAX_BYTES} bytes /
   * {@link DISCOVERY_MAX_LINES} lines of each. Newest candidates are examined
   * first. Never throws: any error resolves `undefined`.
   */
  async discoverSessionId(input: DiscoverSessionInput): Promise<string | undefined> {
    try {
      const root = path.join(codexHome(), CODEX_SESSIONS_DIR);
      const since = input.launchedAt - DISCOVERY_MTIME_SLACK_MS;
      const workspace = path.resolve(input.workspaceRoot);

      for (const file of candidateRollouts(root, input.launchedAt, since)) {
        const id = sessionIdIfMatches(file, workspace, input.runId);
        if (id !== undefined) {
          return id;
        }
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /** Execute `codex --version`, resolving stdout or rejecting on failure. */
  private runVersion(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      execFile(
        CODEX_BIN,
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

/** Turn a probe failure into a human-readable, non-empty reason. */
function describeProbeError(e: unknown): string {
  if (e && typeof e === 'object' && 'code' in e && (e as { code?: unknown }).code === 'ENOENT') {
    return `${CODEX_BIN} was not found on PATH`;
  }
  if (e instanceof Error && e.message.length > 0) {
    return `${CODEX_BIN} --version failed: ${e.message}`;
  }
  return `${CODEX_BIN} --version failed`;
}

/** `$CODEX_HOME` when set and non-empty, else `~/.codex`. */
function codexHome(): string {
  const env = process.env.CODEX_HOME;
  return env !== undefined && env.length > 0 ? env : path.join(os.homedir(), '.codex');
}

/**
 * The rollout files that could belong to a run launched at `launchedAt`,
 * newest first: the launch day's and the following day's date directories
 * (a run can cross midnight), filtered to files modified at/after `since`.
 */
function candidateRollouts(
  sessionsRoot: string,
  launchedAt: number,
  since: number,
): string[] {
  const found: Array<{ file: string; mtimeMs: number }> = [];
  for (const dir of dayDirectories(sessionsRoot, launchedAt)) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith('rollout-') || !name.endsWith('.jsonl')) {
        continue;
      }
      const file = path.join(dir, name);
      try {
        const stat = fs.statSync(file);
        if (stat.isFile() && stat.mtimeMs >= since) {
          found.push({ file, mtimeMs: stat.mtimeMs });
        }
      } catch {
        // An unreadable entry is simply not a candidate.
      }
    }
  }
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).map((entry) => entry.file);
}

/** The `<root>/YYYY/MM/DD` directories for the launch day and the next day. */
function dayDirectories(sessionsRoot: string, launchedAt: number): string[] {
  const dirs: string[] = [];
  for (const offset of [0, 24 * 60 * 60 * 1000]) {
    const day = new Date(launchedAt + offset);
    if (Number.isNaN(day.getTime())) {
      continue;
    }
    dirs.push(
      path.join(
        sessionsRoot,
        String(day.getFullYear()),
        pad2(day.getMonth() + 1),
        pad2(day.getDate()),
      ),
    );
  }
  return dirs;
}

/** Zero-pad a month/day number to codex's two-digit directory names. */
function pad2(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * The session id of a rollout file when it belongs to this run: its first line
 * is a `session_meta` whose `cwd` resolves to `workspace`, and the run id
 * appears in its opening lines. `undefined` otherwise, including on any read or
 * parse failure.
 */
function sessionIdIfMatches(
  file: string,
  workspace: string,
  runId: string,
): string | undefined {
  const head = readHead(file);
  if (head === undefined) {
    return undefined;
  }
  const lines = head.split('\n', DISCOVERY_MAX_LINES);
  const meta = parseSessionMeta(lines[0] ?? '');
  if (meta === undefined) {
    return undefined;
  }
  if (path.resolve(meta.cwd) !== workspace) {
    return undefined;
  }
  // The initial prompt names `<workspace>/.baiton/runs/<run id>/brief.md`, so
  // the run id identifies the run inside the first few turns.
  return lines.some((line) => line.includes(runId)) ? meta.id : undefined;
}

/** Read at most {@link DISCOVERY_MAX_BYTES} bytes from the head of a file. */
function readHead(file: string): string | undefined {
  let fd: number | undefined;
  try {
    fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(DISCOVERY_MAX_BYTES);
    const read = fs.readSync(fd, buffer, 0, DISCOVERY_MAX_BYTES, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // Closing a file we only read from cannot invalidate the result.
      }
    }
  }
}

/** The `{id, cwd}` of a `session_meta` line, or `undefined` when it is not one. */
function parseSessionMeta(line: string): { id: string; cwd: string } | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const obj = parsed as { type?: unknown; payload?: unknown };
  if (obj.type !== 'session_meta' || typeof obj.payload !== 'object' || obj.payload === null) {
    return undefined;
  }
  const payload = obj.payload as { id?: unknown; cwd?: unknown };
  if (
    typeof payload.id !== 'string' ||
    payload.id.length === 0 ||
    typeof payload.cwd !== 'string' ||
    payload.cwd.length === 0
  ) {
    return undefined;
  }
  return { id: payload.id, cwd: payload.cwd };
}
