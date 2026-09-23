import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import type {
  Adapter,
  AskRelayDescriptor,
  DiscoverSessionInput,
  LaunchRequest,
  LaunchSpec,
  ProbeResult,
} from './adapter';
import { AGENT_BINARY } from './adapter';
import type { Role } from '../model/role';
import { runDirGrant, shellQuote } from './permissions';
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
 * The codex ask-relay wiring, verified by the probes recorded in the README
 * ("codex findings", codex-cli 0.155.1 on 2026-09-22). codex's
 * `PermissionRequest` hook event fires exactly when codex would otherwise
 * show its own approval prompt (a command or edit that needs to leave the
 * `--sandbox workspace-write` / `--ask-for-approval on-request` floor), with
 * `{hook_event_name:"PermissionRequest", tool_name, tool_input, …}` on stdin,
 * and its stdout contract
 * `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"|"deny","message"}}}`
 * REPLACES that prompt: probed interactively, `allow` ran the command with no
 * keystroke and `deny` blocked it with the message shown to the model. The
 * hook is installed inline through `-c hooks.PermissionRequest=[…]`, so the
 * route is pure argv — no relay file.
 *
 * Unlike the antigravity route, the sandbox and approval policy stay the
 * floor: an in-sandbox tool call never reaches the hook and never produces a
 * card, and nothing like `--dangerously-bypass-approvals-and-sandbox` or
 * `--approve-for-me` is emitted.
 */

/** How long codex lets the relay hook block (seconds; the handler's `timeout`). A 70 s wait was honoured under 600 (probed). */
export const CODEX_RELAY_HOOK_TIMEOUT_SECONDS = 600;

/**
 * The hook script's own deadline, a margin inside the handler timeout so the
 * script's explicit no-decision reply lands before codex kills it. Both end in
 * codex's own prompt (probed), so the margin only avoids a "Hook failed" line.
 */
export const CODEX_RELAY_HOOK_DEADLINE_SECONDS = CODEX_RELAY_HOOK_TIMEOUT_SECONDS - 10;

/** The `PermissionRequest` matcher: every tool that would raise codex's approval prompt. */
export const CODEX_RELAY_HOOK_MATCHER = '*';

/** The codex hook event the relay installs under. */
export const CODEX_RELAY_HOOK_EVENT = 'PermissionRequest';

/**
 * codex's hook-trust bypass. Its help text (0.155.1): "Run enabled hooks
 * without requiring persisted hook trust for this invocation. DANGEROUS.
 * Intended only for automation that already vets hook sources". Baiton
 * authors the only hook it installs, so this is the intended use; without it
 * an inline hook is silently skipped until trusted through the TUI, which
 * would mean writing to `$CODEX_HOME`. It bypasses HOOK trust only — the
 * sandbox and approval policy are untouched, and codex's PROJECT trust still
 * gates hooks (an untrusted workspace shows the "trust this folder" dialog
 * and no hook fires, probed). Emitted only on a relay launch.
 */
export const CODEX_BYPASS_HOOK_TRUST_FLAG = '--dangerously-bypass-hook-trust';

/**
 * The node program the `PermissionRequest` hook runs, passed its parameters as
 * argv (never spliced into the source): the asks dir, the ask/response
 * suffixes, the run id and the deadline in milliseconds. It reads the hook
 * event from stdin, takes `tool_name` / `tool_input` (and carries
 * `tool_input.description`, codex's own one-line reason for asking, into the
 * ask's `detail`), mints an ask file the relay core can parse (`parseAsk`
 * accepts its exact bytes), polls for the response file and prints
 * `decision.behavior: "allow"` for `approve` and `"deny"` with the reason as
 * `message` for anything else.
 *
 * On any failure — unparseable event, unwritable ask, unreadable response,
 * deadline expiry — it prints the event name with NO decision, which codex
 * answers by showing its own approval prompt (probed: no-decision, empty
 * stdout, exit 1 and a handler timeout all fell back to the TUI prompt). The
 * run degrades to codex's own prompt, never to a silent allow. It never emits
 * `interrupt`, `updatedInput` or `updatedPermissions`, which make the hook
 * fail closed. The exit code starts at 1 and becomes 0 only after a reply was
 * written, so a crash is a hook failure rather than an empty success.
 *
 * Invariant: the script wraps in single quotes on the command line, so it
 * contains no `'` character (string concatenation + double quotes only).
 */
export const CODEX_RELAY_HOOK_SCRIPT: string =
  `const fs=require("fs"),path=require("path");` +
  `process.exitCode=1;` +
  `const a=process.argv.slice(1);` +
  `const dir=a[0],askSuffix=a[1],respSuffix=a[2],runId=a[3],deadline=Date.now()+Number(a[4]);` +
  `function done(behavior,message){` +
  `const out={hookEventName:"PermissionRequest"};` +
  `if(behavior!==undefined){out.decision={behavior:behavior,message:message}}` +
  `try{fs.writeSync(1,JSON.stringify({hookSpecificOutput:out}))}catch(e){process.exit(1)}` +
  `process.exit(0)}` +
  `function fallback(reason){try{fs.writeSync(2,reason+"\\n")}catch(e){}done(undefined,"")}` +
  `let ev={};` +
  `try{ev=JSON.parse(fs.readFileSync(0,"utf8")||"{}")}` +
  `catch(e){fallback("baiton ask relay: unparseable PermissionRequest event")}` +
  `if(typeof ev!=="object"||ev===null){ev={}}` +
  `const id=String(Date.now())+"-"+String(process.pid);` +
  `const tool=String(ev.tool_name||"unknown");` +
  `const input=ev.tool_input===undefined?{}:ev.tool_input;` +
  `const ask={version:1,id:id,runId:runId,agent:"codex",kind:"permission",` +
  `prompt:"codex wants to use "+tool,tool:tool,args:JSON.stringify(input)};` +
  `if(input&&typeof input.description==="string"&&input.description.length>0){ask.detail=input.description}` +
  `ask.createdAt=new Date().toISOString();` +
  `try{fs.mkdirSync(dir,{recursive:true});` +
  `fs.writeFileSync(path.join(dir,id+askSuffix),JSON.stringify(ask,null,2)+"\\n")}` +
  `catch(e){fallback("baiton ask relay: cannot write ask file")}` +
  `function poll(){try{const r=JSON.parse(fs.readFileSync(path.join(dir,id+respSuffix),"utf8"));` +
  `const ok=r.decision==="approve";` +
  `done(ok?"allow":"deny",String(r.reason||(ok?"approved in Baiton":"denied in Baiton")))}` +
  `catch(e){if(e&&e.code==="ENOENT"){setTimeout(poll,200)}else{` +
  `fallback("baiton ask relay: cannot read response")}}}` +
  `setTimeout(function(){` +
  `fallback("baiton ask relay timed out - falling back to the codex prompt")},` +
  `Math.max(0,deadline-Date.now()));` +
  `poll()`;

/**
 * The shell command for the relay hook: the {@link CODEX_RELAY_HOOK_SCRIPT}
 * program run with `node -e`, its parameters passed as argv (ask dir, ask
 * suffix, response suffix, run id — each {@link shellQuote}-wrapped because
 * codex executes the command through a shell) and the deadline in
 * milliseconds.
 */
export function codexAskRelayHookCommand(relay: AskRelayDescriptor): string {
  return (
    `node -e ${shellQuote(CODEX_RELAY_HOOK_SCRIPT)} ` +
    `${shellQuote(relay.dir)} ${shellQuote(relay.askSuffix)} ` +
    `${shellQuote(relay.responseSuffix)} ${shellQuote(relay.runId)} ` +
    `${CODEX_RELAY_HOOK_DEADLINE_SECONDS * 1000}`
  );
}

/**
 * The `-c` override installing the relay hook:
 * `hooks.PermissionRequest=[{matcher="*",hooks=[{type="command",command="<hook cmd>",timeout=600}]}]`.
 * codex parses the value half as TOML, so the command is {@link tomlQuote}d.
 */
export function codexAskRelayHookConfig(relay: AskRelayDescriptor): string {
  return (
    `hooks.${CODEX_RELAY_HOOK_EVENT}=[{matcher=${tomlQuote(CODEX_RELAY_HOOK_MATCHER)},` +
    `hooks=[{type="command",command=${tomlQuote(codexAskRelayHookCommand(relay))},` +
    `timeout=${CODEX_RELAY_HOOK_TIMEOUT_SECONDS}}]}]`
  );
}

/**
 * The relay argv: {@link CODEX_BYPASS_HOOK_TRUST_FLAG} plus the `-c`
 * {@link codexAskRelayHookConfig} pair. Returns `[]` when no relay was
 * requested, or when the descriptor's `protocol` is not `file-v1` — an
 * unknown protocol must never emit a half-understood hook — so callers can
 * spread this straight into the argv ahead of the `--` end-of-options marker.
 */
export function codexRelayFlags(relay?: AskRelayDescriptor): string[] {
  if (relay === undefined || relay.protocol !== 'file-v1') {
    return [];
  }
  return [CODEX_BYPASS_HOOK_TRUST_FLAG, '-c', codexAskRelayHookConfig(relay)];
}

/**
 * The codex CLI adapter (Requirement 14.1). Flags verified against
 * `codex-cli` v0.154.0 via `codex --version`/`codex --help`/`codex resume
 * --help`; the ask-relay flags against v0.155.1.
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
 * 6. `--dangerously-bypass-approvals-and-sandbox`, `--approve-for-me`,
 *    `--sandbox danger-full-access` and `--ask-for-approval never` are
 *    deliberately never emitted. `--dangerously-bypass-hook-trust`
 *    ({@link CODEX_BYPASS_HOOK_TRUST_FLAG}) is emitted on a relay launch ONLY,
 *    to let the one hook Baiton itself authors run (degrade 7); it bypasses
 *    hook trust and nothing else.
 * 7. The ask relay is native and pure argv: a `file-v1` `LaunchRequest.relay`
 *    adds {@link codexRelayFlags} — the hook-trust bypass plus an inline
 *    `-c hooks.PermissionRequest=[…]` command hook running
 *    {@link CODEX_RELAY_HOOK_SCRIPT} — and no relay file is written. See
 *    README.md, "Harness ask relay (per-adapter probe findings)", for the
 *    transcripts (codex-cli 0.155.1, 2026-09-22).
 *
 *    The hook is on `PermissionRequest`, NOT `PreToolUse`. `PermissionRequest`
 *    fires only where codex would otherwise raise its own approval prompt and
 *    its `decision.behavior` replaces that prompt, so the sandbox and
 *    `--ask-for-approval on-request` stay the enforcement floor and an
 *    in-sandbox call never becomes a card. The 0.154.0 probe that rejected
 *    this route only tried `PreToolUse` under `codex exec`, where the approval
 *    policy is forced to `never` (its "`ask` is a silent allow" finding is an
 *    exec artefact), and it treated the hook-trust flag as off-limits;
 *    probed interactively on 0.155.1, `allow` ran the command with no
 *    keystroke and `deny` blocked it with its message shown to the model.
 *
 *    Degrades: the hook script's failure paths (and a handler timeout, a
 *    crash, an empty reply) all fall back to codex's own TUI prompt, never to
 *    an allow. The hook also needs codex's PROJECT trust — Baiton launches in
 *    the user's workspace, which the user normally trusted when first running
 *    codex there; in an untrusted workspace codex shows its "trust this
 *    folder" dialog, no hook fires, and asks stay in the terminal. `attach()`
 *    takes no relay (no caller passes one), so a re-opened session prompts in
 *    the terminal as before.
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
   * <run-dir> -c developer_instructions="<profile prompt>" [--dangerously-bypass-hook-trust
   * -c hooks.PermissionRequest=[…]] -- "<prompt>"` (`req.sessionId` is
   * deliberately dropped, see the class doc comment; the bracketed relay flags
   * are {@link codexRelayFlags}, present only for a `file-v1` `req.relay`). Resume: `resume <resumeSessionId>`
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
    args.push(...codexRelayFlags(req.relay));

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
