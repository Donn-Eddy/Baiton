import { execFile } from 'child_process';
import * as path from 'path';
import type { Adapter, AskRelayDescriptor, LaunchRequest, LaunchSpec, ProbeResult, RelayFile } from './adapter';
import { AGENT_BINARY, AdapterLaunchError } from './adapter';
import type { Role } from '../model/role';
import { isReadOnlyRole, runDirGrant, shellQuote } from './permissions';
import { runDirPattern } from './roleProfile';

/** The antigravity CLI executable name, sourced from the canonical binary map (Requirement 14.1). */
const ANTIGRAVITY_BIN = AGENT_BINARY.antigravity;

/**
 * Reasoning effort levels offered in the config panel dropdown (Requirement
 * 14.1): the union of the per-family suffixes in {@link ANTIGRAVITY_MODELS}.
 * Whether a given pair is accepted is decided per family by
 * {@link antigravityModelFlags}.
 */
export const ANTIGRAVITY_EFFORTS = ['low', 'medium', 'high'] as const;

/** How long to wait for `agy --version` before giving up (ms). */
const PROBE_TIMEOUT_MS = 10_000;

/** The agy `--mode` value used for read-only roles. */
export const ANTIGRAVITY_PLAN_MODE = 'plan';

/** The agy `--mode` value used for write-capable roles. */
export const ANTIGRAVITY_ACCEPT_EDITS_MODE = 'accept-edits';

/**
 * The agy model catalogue, as listed by `agy models` (v1.2.2), keyed by the
 * bare family name Baiton config uses. agy has no separate effort control
 * for most models: for Gemini the effort is baked into the model id as a
 * suffix (`gemini-3.8-flash-medium`) and `--effort` is only accepted, and in
 * fact required, alongside the *bare* family id. Claude and GPT-OSS ids take
 * no effort at all and agy rejects `--effort` for them outright.
 *
 * `efforts` lists the suffixes agy offers for a family; an empty list means
 * the id is fixed and effort is not configurable. Refresh from `agy models`
 * when agy adds a model. The catalogue's keys are also the model dropdown
 * the config panel offers for antigravity (see `agentCapabilities()`), with
 * "Other…" for anything newer.
 */
export const ANTIGRAVITY_MODELS: Readonly<Record<string, readonly string[]>> = {
  'gemini-3.8-flash': ['low', 'medium', 'high'],
  'gemini-3.7-flash': ['low', 'medium', 'high'],
  'gemini-3.6-flash': ['low', 'medium', 'high'],
  'gemini-3.1-pro': ['low', 'high'],
  'claude-sonnet-4-6': [],
  'claude-opus-4-6-thinking': [],
  'gpt-oss-120b-medium': [],
};

/**
 * Resolve a config `model` + `effort` pair to the `--model <id>` agy needs
 * (Requirement 14.1). The adapter is model-aware: a bare Gemini family plus
 * an effort maps to the suffixed id (`gemini-3.8-flash` + `medium` →
 * `gemini-3.8-flash-medium`); an already-suffixed id passes through when its
 * effort agrees or is unset; a fixed id (Claude, GPT-OSS) passes through and
 * any effort is dropped as a documented degrade; an id agy does not list
 * passes through verbatim, with `--effort` if set, so a newer agy can still
 * validate it itself.
 *
 * Throws {@link AdapterLaunchError} when agy is known to reject the pair: a
 * bare Gemini family with no effort or an effort it does not offer, or a
 * suffixed Gemini id whose suffix contradicts the configured effort.
 */
/** Own-key lookup into the catalogue (a model named `__proto__` must not hit the prototype). */
function catalogueEfforts(id: string): readonly string[] | undefined {
  return Object.prototype.hasOwnProperty.call(ANTIGRAVITY_MODELS, id) ? ANTIGRAVITY_MODELS[id] : undefined;
}

export function antigravityModelFlags(model: string, effort: string | undefined): string[] {
  const hasEffort = effort !== undefined && effort.length > 0;
  const wanted = hasEffort ? effort : undefined;

  // Bare family known to the catalogue.
  const efforts = catalogueEfforts(model);
  if (efforts !== undefined) {
    if (efforts.length === 0) {
      // Fixed id: agy rejects --effort for it, so the effort is dropped.
      return ['--model', model];
    }
    if (wanted === undefined) {
      throw new AdapterLaunchError(
        `agy model "${model}" requires an effort (one of: ${efforts.join(', ')}); set "effort" for the role`,
      );
    }
    if (!efforts.includes(wanted)) {
      throw new AdapterLaunchError(
        `agy model "${model}" does not offer effort "${wanted}" (available: ${efforts.join(', ')})`,
      );
    }
    return ['--model', `${model}-${wanted}`];
  }

  // Suffixed Gemini id: split off a trailing effort and check it against the
  // family's catalogue entry.
  const dash = model.lastIndexOf('-');
  if (dash > 0) {
    const family = model.slice(0, dash);
    const suffix = model.slice(dash + 1);
    const familyEfforts = catalogueEfforts(family);
    if (familyEfforts !== undefined && familyEfforts.includes(suffix)) {
      if (wanted !== undefined && wanted !== suffix) {
        throw new AdapterLaunchError(
          `agy model "${model}" already fixes the effort to "${suffix}", which conflicts with the role's effort "${wanted}"; use "${family}" with an effort or drop the effort`,
        );
      }
      return ['--model', model];
    }
  }

  // Unknown to the catalogue: pass through and let agy validate.
  return wanted !== undefined ? ['--model', model, '--effort', wanted] : ['--model', model];
}

/** Build the `--mode <plan|accept-edits>` flag pair for a role. */
export function antigravityModeFlags(role: Role): string[] {
  return ['--mode', isReadOnlyRole(role) ? ANTIGRAVITY_PLAN_MODE : ANTIGRAVITY_ACCEPT_EDITS_MODE];
}

/**
 * The antigravity ask-relay wiring, verified by the probes recorded in the
 * README ("antigravity (agy) findings", `agy` 1.2.7 on 2026-09-20 and 1.2.8
 * on 2026-09-22). agy loads `PreToolUse` command hooks from
 * `<dir>/.agents/hooks.json` for every directory passed with an ABSOLUTE
 * `--add-dir` (a relative one loaded none), so the hook file lives inside the
 * run directory Baiton already grants (`.baiton/runs/<run-id>/`), the relay
 * launch passes that directory's absolute path, and nothing is written into
 * the user's own `.agents/`. The handler receives `{toolCall:{name, args}, …}`
 * on stdin (for `run_command`, `view_file`, `write_to_file`,
 * `replace_file_content`, … — every tool call) and answers `{"decision":"allow"|"deny", "reason"}` on
 * stdout; its working directory is the `.agents` directory.
 */

/**
 * Whether the hook's `{"decision":"allow"}` grants a permission on its own.
 * It does NOT: probed against `agy` 1.2.8 (2026-09-22) in the interactive
 * `--prompt-interactive` form Baiton launches, a hook answering `allow` was
 * followed by agy's own `Surfacing tool confirmation: "RunCommand"` and the
 * command never ran (the 1.2.7 headless probe had already shown the same
 * soft-deny for `-p`). The hook is a veto, not a grant — so the relay must
 * turn agy's own prompt off with {@link ANTIGRAVITY_SKIP_PERMISSIONS_FLAG}
 * and let the hook be the sole permission authority.
 */
export const ANTIGRAVITY_HOOK_ALLOW_GRANTS = false;

/**
 * agy's "auto-approve all tool permission requests" flag. Emitted ONLY by a
 * relay launch whose hook file the launcher writes, and only because
 * {@link ANTIGRAVITY_HOOK_ALLOW_GRANTS} is false: probed against 1.2.8 with
 * this flag on, a hook `deny` still blocked the call (headless and
 * interactive), `allow` ran it without any prompt, and a hook that crashed
 * (exit 1), timed out, or printed non-JSON blocked the call too. One gap the
 * hook script itself must close: a hook that exits 0 with EMPTY stdout was
 * treated as allow, so the script never exits 0 without printing a decision.
 */
export const ANTIGRAVITY_SKIP_PERMISSIONS_FLAG = '--dangerously-skip-permissions';

/** How long agy lets the relay hook block (seconds; the `timeout` field of the handler). */
export const ANTIGRAVITY_RELAY_HOOK_TIMEOUT_SECONDS = 600;

/**
 * The hook script's own deadline, a margin inside the handler timeout so the
 * script's explicit `deny` (with a reason the model can read) lands before
 * agy kills it. A kill also blocks the call (probed), so the margin only
 * improves the message.
 */
export const ANTIGRAVITY_RELAY_HOOK_DEADLINE_SECONDS = ANTIGRAVITY_RELAY_HOOK_TIMEOUT_SECONDS - 10;

/**
 * The `PreToolUse` matcher: every tool. With {@link ANTIGRAVITY_SKIP_PERMISSIONS_FLAG}
 * on, a tool the matcher missed would run unasked, so this must stay `*`.
 */
export const ANTIGRAVITY_RELAY_HOOK_MATCHER = '*';

/** The named-hook key in the relay `hooks.json`. */
export const ANTIGRAVITY_RELAY_HOOK_NAME = 'baiton-ask-relay';

/**
 * The workspace-relative path of a run's relay hook file:
 * `.baiton/runs/<run-id>/.agents/hooks.json`.
 */
export function antigravityRelayHooksPath(runId: string): string {
  return `${runDirPattern(runId)}.agents/hooks.json`;
}

/**
 * The node program the `PreToolUse` hook runs, passed its parameters as argv
 * (never spliced into the source): the asks dir, the ask/response suffixes,
 * the run id and the deadline in milliseconds. It reads the hook event from
 * stdin, takes `toolCall.name` / `toolCall.args`, mints an ask file the relay
 * core can parse (`parseAsk` accepts its exact bytes), polls for the response
 * file and prints `{"decision":"allow"}` for `approve` and
 * `{"decision":"deny","reason"}` for anything else.
 *
 * It degrades to `deny`, never `allow`: an unparseable event, an unwritable
 * ask, an unreadable response and the deadline all print a `deny` with a
 * reason. agy has no verified `ask` fallback, and with
 * {@link ANTIGRAVITY_SKIP_PERMISSIONS_FLAG} on there is no prompt left to fall
 * back to. The exit code starts at 1 and becomes 0 only after a decision was
 * written, because agy treats an empty stdout with exit 0 as allow (probed)
 * while any non-zero exit blocks. A tool call whose arguments name an
 * `.agents` `hooks.json` is denied outright without asking, so the agent
 * cannot rewrite its own permission hook.
 *
 * Invariant: the script wraps in single quotes on the command line, so it
 * contains no `'` character (string concatenation + double quotes only).
 */
export const ANTIGRAVITY_RELAY_HOOK_SCRIPT: string =
  `const fs=require("fs"),path=require("path");` +
  `process.exitCode=1;` +
  `const a=process.argv.slice(1);` +
  `const dir=a[0],askSuffix=a[1],respSuffix=a[2],runId=a[3],deadline=Date.now()+Number(a[4]);` +
  `function done(decision,reason){` +
  `const out=decision==="allow"?{decision:"allow"}:{decision:"deny",reason:reason};` +
  `try{fs.writeSync(1,JSON.stringify(out))}catch(e){process.exit(1)}` +
  `process.exit(0)}` +
  `let ev={};` +
  `try{ev=JSON.parse(fs.readFileSync(0,"utf8")||"{}")}` +
  `catch(e){done("deny","baiton ask relay: unparseable PreToolUse event")}` +
  `const call=ev&&typeof ev.toolCall==="object"&&ev.toolCall!==null?ev.toolCall:{};` +
  `const tool=String(call.name||"unknown");` +
  `const argsText=JSON.stringify(call.args===undefined?{}:call.args);` +
  `if(argsText.indexOf(".agents")>=0&&argsText.indexOf("hooks.json")>=0){` +
  `done("deny","baiton ask relay: the relay hook file may not be touched")}` +
  `const id=String(Date.now())+"-"+String(process.pid);` +
  `const ask={version:1,id:id,runId:runId,agent:"antigravity",kind:"permission",` +
  `prompt:"antigravity wants to use "+tool,tool:tool,args:argsText,` +
  `createdAt:new Date().toISOString()};` +
  `try{fs.mkdirSync(dir,{recursive:true});` +
  `fs.writeFileSync(path.join(dir,id+askSuffix),JSON.stringify(ask,null,2)+"\\n")}` +
  `catch(e){done("deny","baiton ask relay: cannot write ask file")}` +
  `function poll(){try{const r=JSON.parse(fs.readFileSync(path.join(dir,id+respSuffix),"utf8"));` +
  `done(r.decision==="approve"?"allow":"deny",String(r.reason||"denied in Baiton"))}` +
  `catch(e){if(e&&e.code==="ENOENT"){setTimeout(poll,200)}else{` +
  `done("deny","baiton ask relay: cannot read response")}}}` +
  `setTimeout(function(){` +
  `done("deny","baiton ask relay timed out waiting for an answer")},` +
  `Math.max(0,deadline-Date.now()));` +
  `poll()`;

/**
 * The shell command for the relay hook (agy runs it through `sh -c`): the
 * {@link ANTIGRAVITY_RELAY_HOOK_SCRIPT} program run with `node -e`, its
 * parameters passed as argv (ask dir, ask suffix, response suffix, run id —
 * each {@link shellQuote}-wrapped) and the deadline in milliseconds.
 */
export function antigravityAskRelayHookCommand(relay: AskRelayDescriptor): string {
  return (
    `node -e ${shellQuote(ANTIGRAVITY_RELAY_HOOK_SCRIPT)} ` +
    `${shellQuote(relay.dir)} ${shellQuote(relay.askSuffix)} ` +
    `${shellQuote(relay.responseSuffix)} ${shellQuote(relay.runId)} ` +
    `${ANTIGRAVITY_RELAY_HOOK_DEADLINE_SECONDS * 1000}`
  );
}

/**
 * The relay `hooks.json` object: one named hook
 * ({@link ANTIGRAVITY_RELAY_HOOK_NAME}) with a `PreToolUse` group matching
 * {@link ANTIGRAVITY_RELAY_HOOK_MATCHER} and one command handler running
 * {@link antigravityAskRelayHookCommand} with
 * {@link ANTIGRAVITY_RELAY_HOOK_TIMEOUT_SECONDS}.
 */
export function antigravityAskRelayHooks(relay: AskRelayDescriptor): Record<string, unknown> {
  return {
    [ANTIGRAVITY_RELAY_HOOK_NAME]: {
      PreToolUse: [
        {
          matcher: ANTIGRAVITY_RELAY_HOOK_MATCHER,
          hooks: [
            {
              type: 'command',
              command: antigravityAskRelayHookCommand(relay),
              timeout: ANTIGRAVITY_RELAY_HOOK_TIMEOUT_SECONDS,
            },
          ],
        },
      ],
    },
  };
}

/**
 * The antigravity (`agy`) CLI adapter (Requirement 14.1). Flags verified
 * against `agy` v1.2.2 via `agy --version`/`agy --help`.
 *
 * Deliberate degrades from the Claude adapter, documented here rather than
 * silently implied to be enforced:
 *
 * 1. agy mints its own conversation id on a fresh run and exposes no flag to
 *    pre-assign one, so `launch()` ignores `req.sessionId` when `req.resume`
 *    is false; the journal's recorded session id will not match agy's actual
 *    conversation for a fresh launch.
 * 2. agy has no scoped write allow-list like claude's `Write(.baiton/runs/**)`,
 *    so read-only roles rely on `--mode plan` refusing edits outright rather
 *    than a scoped write allowance. There is no `readOnlyFallbackToAcceptEdits`
 *    -style flip because `plan` is agy's only non-edit mode.
 *
 *    CONSEQUENCE — read-only roles on agy are effectively unsupported.
 *    `--mode plan` is a whole-session read-only mode with no per-path escape:
 *    `agy --help` (v1.2.2) offers only `--mode accept-edits|plan`, no
 *    permission/allow-list flag, and no config-content environment layer to
 *    define a custom agent with one (`agy agent`/`agents` only lists agents).
 *    So a spec-writer, planner, plan-reviewer or pr-writer run on agy is
 *    expected to REFUSE to write its own `.baiton/runs/<run-id>/result.json`,
 *    exit 0, and be recorded by the queue as `closed (exit 0)` with the todo
 *    reverted. `--add-dir` widens the visible workspace; it does not lift plan
 *    mode's edit ban. This mirrors exactly the opencode bug fixed by moving
 *    that adapter off the built-in `--agent plan` onto Baiton-owned agents
 *    declared in `OPENCODE_CONFIG_CONTENT` (see src/adapter/opencode.ts);
 *    opencode had an env-var config layer to fix it with, agy does not. Use
 *    claude (or opencode) for read-only roles until agy grows a scoped write
 *    grant; the args below are deliberately left unchanged because there is no
 *    correct alternative to emit. (This describes a launch WITHOUT the ask
 *    relay; degrade 7 explains how a relay launch changes the floor.)
 * 3. Unlike opencode, agy DOES support `--add-dir`, so the Requirement 15.4
 *    per-run grant is emitted normally via `runDirGrant(req.runId)` — this is
 *    not a degrade.
 * 4. `--dangerously-skip-permissions` ({@link ANTIGRAVITY_SKIP_PERMISSIONS_FLAG})
 *    is emitted ONLY on a relay launch (degrade 7), never otherwise, and
 *    never without the relay hook file: `launch()` throws
 *    `AdapterLaunchError` when a `file-v1` relay arrives without the
 *    launcher's promise ({@link LaunchRequest.relayFiles}) to write
 *    {@link antigravityRelayHooksPath}. Without a relay it stays off the argv,
 *    exactly as before.
 * 6. agy has no standalone effort control for most models: Gemini efforts
 *    are model-id suffixes and Claude/GPT-OSS ids take none, and agy exits
 *    with "invalid model selection" when `--effort` is passed with either.
 *    `launch()` therefore maps model+effort through
 *    {@link antigravityModelFlags}: a bare Gemini family gains the effort as
 *    a suffix, a fixed id drops the effort, an unknown id passes through.
 *    Pairs agy is known to reject throw `AdapterLaunchError` so the stage is
 *    refused before a terminal opens.
 * 5. Unlike claude, opencode, and codex, agy receives NO role-profile system
 *    prompt (`src/adapter/roleProfile.ts`). `agy` 1.2.2 exposes `--agent
 *    <name>` and an `agy agents` listing, but the listing printed nothing on
 *    the development host and the agent-definition format is undocumented in
 *    `--help`, so there is no verified way to deliver the profile's prose.
 *    The consequence is concrete: for an antigravity role the Brief
 *    (`src/engine/roleInstructions.ts`) is the ONLY place the constraints are
 *    stated — which is why `EXECUTOR_NO_GIT_INSTRUCTION` stays in the brief
 *    even though the executor profile now repeats it.
 *    TODO: investigate `agy --agent` / `agy agents` and, if agents can be
 *    defined, translate the role profile here the way the opencode adapter
 *    does.
 * 7. The ask relay is a NATIVE hook installed from a file the launcher
 *    writes, not from argv. `relayFiles()` returns
 *    `.baiton/runs/<run-id>/.agents/hooks.json` with a `PreToolUse` handler
 *    for every tool that writes a `file-v1` ask and prints agy's decision
 *    ({@link ANTIGRAVITY_RELAY_HOOK_SCRIPT}); `launch()` stays pure. Probed
 *    against 1.2.8 (2026-09-22): agy loads that file when the run directory
 *    is an `--add-dir` workspace (`loaded 1 named hooks from 1 hooks.json
 *    file(s)`), so nothing lands in the user's own `.agents/` or in
 *    `~/.gemini` — but ONLY when that `--add-dir` value is absolute. The
 *    relative run-dir grant (`--add-dir .baiton/runs/<run-id>/`, degrade 3)
 *    loaded 0 hooks, with the cwd at the workspace root exactly as Baiton
 *    launches, and a skip-permissions run in that state ran its command
 *    unasked. A relay launch therefore adds the absolute run directory as a
 *    second `--add-dir`.
 *
 *    The hook alone cannot say yes: `{"decision":"allow"}` did not grant in
 *    headless (1.2.7) or interactive (1.2.8) runs — agy surfaced its own
 *    confirmation anyway ({@link ANTIGRAVITY_HOOK_ALLOW_GRANTS}). So a relay
 *    launch also emits {@link ANTIGRAVITY_SKIP_PERMISSIONS_FLAG}, which hands
 *    the whole permission decision to the hook: with it on, `deny` still
 *    blocked and `allow` ran without a prompt. The degrade is `deny`, never
 *    `allow` — every hook failure (unparseable event, unwritable ask,
 *    unreadable response, the {@link ANTIGRAVITY_RELAY_HOOK_DEADLINE_SECONDS}
 *    deadline) prints `deny`, and a crash, kill or garbage output also
 *    blocked the call in the probe. An unanswered ask therefore blocks the
 *    tool rather than falling back to agy's prompt, unlike claude's `ask`.
 *
 *    CONSEQUENCE for degrade 2: with the flag on, `--mode plan` no longer
 *    holds by itself — the 1.2.8 probe saw a plan-mode run write a file once
 *    the hook allowed it. On a relay launch the enforcement floor for every
 *    role is the hook, i.e. Baiton's permission cards and Auto mode's gate,
 *    which see every tool call (reads included). A launch without a relay is
 *    unchanged. Unverified: whether agy re-reads `hooks.json` while running;
 *    the hook denies any tool call that names an `.agents` `hooks.json` so
 *    the agent cannot rewrite it either way.
 */
export class AntigravityAdapter implements Adapter {
  readonly id = 'antigravity' as const;

  /**
   * antigravity mints its own session id and has no flag to pre-assign one,
   * so Baiton's journal `sessionId` is not resumable with it.
   */
  readonly acceptsSessionId = false;

  /**
   * Run `agy --version` and report readiness (Requirements 14.2–14.4). A
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
          reason: `${ANTIGRAVITY_BIN} --version produced no version output`,
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
   * Fresh launch: `agy --model <m> [--effort <e>] --mode <plan|accept-edits>` where
   * `<m>`/`<e>` come from {@link antigravityModelFlags} (model-aware mapping;
   * throws `AdapterLaunchError` for pairs agy rejects). Full shape: `agy --model <m> [--effort <e>] --mode <plan|accept-edits>
   * --add-dir <run-dir> --prompt-interactive "<prompt>"` (`req.sessionId` is
   * deliberately dropped, see the class doc comment). Resume:
   * `--conversation <resumeSessionId>` leads the arguments when a prior
   * Session_Id is known, falling back to `-c` when it is not (Requirements
   * 13.2, 13.3, 15.1–15.4). Every role is additionally granted write access
   * to its own `.baiton/runs/<run-id>/` directory (Requirement 15.4).
   *
   * With a `file-v1` relay, a second `--add-dir <absolute run dir>` and
   * {@link ANTIGRAVITY_SKIP_PERMISSIONS_FLAG} are added before
   * `--prompt-interactive` (class doc, degrades 4 and 7) — the absolute form
   * because agy loads a workspace's `.agents/hooks.json` only for an absolute
   * `--add-dir` (the relative run-dir grant loaded none in the 1.2.8 probe).
   * Both are emitted only when `req.relayFiles` lists
   * {@link antigravityRelayHooksPath} and the descriptor's asks dir is
   * `<abs root>/.baiton/runs/<run-id>/asks`; otherwise it throws
   * `AdapterLaunchError` rather than start agy with its prompt off and no
   * hook. An unknown protocol is ignored and the launch is unchanged.
   */
  launch(req: LaunchRequest): LaunchSpec {
    const args: string[] = [];

    if (req.resume) {
      if (req.resumeSessionId !== undefined && req.resumeSessionId.length > 0) {
        args.push('--conversation', req.resumeSessionId);
      } else {
        args.push('-c');
      }
    }

    args.push(...antigravityModelFlags(req.model, req.effort));

    args.push(...antigravityModeFlags(req.role));
    args.push(...runDirGrant(req.runId));
    args.push(...antigravityRelayFlags(req));
    args.push('--prompt-interactive', req.prompt);

    return { shellPath: ANTIGRAVITY_BIN, shellArgs: args };
  }

  /**
   * The relay hook file for a `file-v1` descriptor:
   * {@link antigravityRelayHooksPath} holding {@link antigravityAskRelayHooks}
   * as pretty-printed JSON. `[]` for any other protocol. Pure — the launcher
   * writes it.
   */
  relayFiles(relay: AskRelayDescriptor): RelayFile[] {
    if (relay.protocol !== 'file-v1') {
      return [];
    }
    return [
      {
        path: antigravityRelayHooksPath(relay.runId),
        content: JSON.stringify(antigravityAskRelayHooks(relay), null, 2) + '\n',
      },
    ];
  }

  /**
   * Build the args to reopen an existing session with no prompt: `agy
   * --conversation <id> --mode <plan|accept-edits> --add-dir <run-dir>`
   * (Requirements 3.3, 3.4).
   */
  attach(req: { role: Role; runId: string; sessionId: string }): LaunchSpec {
    const args: string[] = [
      '--conversation',
      req.sessionId,
      ...antigravityModeFlags(req.role),
      ...runDirGrant(req.runId),
    ];

    return { shellPath: ANTIGRAVITY_BIN, shellArgs: args };
  }

  /** Execute `agy --version`, resolving stdout or rejecting on failure. */
  private runVersion(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      execFile(
        ANTIGRAVITY_BIN,
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
 * The relay flags for a launch: `[]` without a `file-v1` relay, or when the
 * hook grants on its own ({@link ANTIGRAVITY_HOOK_ALLOW_GRANTS}); otherwise
 * {@link ANTIGRAVITY_SKIP_PERMISSIONS_FLAG}, guarded so it is never emitted
 * unless the launcher will write the run's hook file first.
 */
function antigravityRelayFlags(req: LaunchRequest): string[] {
  const relay = req.relay;
  if (relay === undefined || relay.protocol !== 'file-v1') {
    return [];
  }
  const hooksPath = antigravityRelayHooksPath(req.runId);
  const runDir = antigravityRelayRunDir(relay);
  if (
    runDir === undefined ||
    relay.runId !== req.runId ||
    !(req.relayFiles ?? []).includes(hooksPath)
  ) {
    throw new AdapterLaunchError(
      `the antigravity ask relay needs its hook file ${hooksPath} written before launch; ` +
        `refusing to start agy with ${ANTIGRAVITY_SKIP_PERMISSIONS_FLAG} and no hook`,
    );
  }
  // agy loads `<dir>/.agents/hooks.json` only for an ABSOLUTE `--add-dir`
  // (probed, 1.2.8): the relative run-dir grant loaded 0 hooks.
  const flags = ['--add-dir', runDir];
  if (!ANTIGRAVITY_HOOK_ALLOW_GRANTS) {
    flags.push(ANTIGRAVITY_SKIP_PERMISSIONS_FLAG);
  }
  return flags;
}

/**
 * The absolute run directory a `file-v1` descriptor's asks dir sits in
 * (`<root>/.baiton/runs/<run-id>/asks` → `<root>/.baiton/runs/<run-id>`), or
 * `undefined` when the descriptor does not have that exact shape — the relay
 * then refuses to launch rather than point agy somewhere else.
 */
function antigravityRelayRunDir(relay: AskRelayDescriptor): string | undefined {
  if (!path.isAbsolute(relay.dir) || path.basename(relay.dir) !== 'asks') {
    return undefined;
  }
  const runDir = path.dirname(relay.dir);
  if (
    path.basename(runDir) !== relay.runId ||
    path.basename(path.dirname(runDir)) !== 'runs' ||
    path.basename(path.dirname(path.dirname(runDir))) !== '.baiton'
  ) {
    return undefined;
  }
  return runDir;
}

/** Turn a probe failure into a human-readable, non-empty reason. */
function describeProbeError(e: unknown): string {
  if (e && typeof e === 'object' && 'code' in e && (e as { code?: unknown }).code === 'ENOENT') {
    return `${ANTIGRAVITY_BIN} was not found on PATH`;
  }
  if (e instanceof Error && e.message.length > 0) {
    return `${ANTIGRAVITY_BIN} --version failed: ${e.message}`;
  }
  return `${ANTIGRAVITY_BIN} --version failed`;
}
