import type { Role } from '../model/role';

/**
 * The adapter boundary. An adapter owns only a CLI's launch arguments per role,
 * its readiness probe, and its continue flag — nothing else. Terminal creation,
 * brief handling, result handling, watching, validation, journaling and reset
 * are all shared and live outside the adapter (Requirement 14.1).
 *
 * The first pass ships a single adapter, {@link ClaudeAdapter}.
 */

/** The stable set of supported agent ids, shared by adapters, the registry and executable resolution. */
export type AgentId = 'claude' | 'opencode' | 'antigravity' | 'codex';

/** Maps each agent id to the CLI binary name it launches (Requirement 14.1). */
export const AGENT_BINARY: Record<AgentId, string> = {
  claude: 'claude',
  opencode: 'opencode',
  antigravity: 'agy',
  codex: 'codex',
};

/**
 * Capability descriptor for an agent CLI in the configuration panel (T10).
 *
 * An empty list means free text (no dropdown, no membership check).
 * A non-empty list means an enumerated set rendered as a dropdown plus an
 * always-present "Other…" free-text entry.
 * `modelLink` is an optional documentation URL rendered next to a free-text model field.
 */
export interface AgentCapabilities {
  readonly models: readonly string[];
  readonly efforts: readonly string[];
  readonly modelLink?: string;
}

/**
 * Thrown by an adapter's `launch()` when the request cannot be expressed in
 * the CLI's argv at all (for example a model/effort pair the CLI is known to
 * reject). The launcher turns it into a `launch-args` refusal before any
 * terminal is created; the `message` is user-facing and must say what to fix.
 */
export class AdapterLaunchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdapterLaunchError';
  }
}

export interface Adapter {
  /** Stable adapter identifier. */
  readonly id: AgentId;

  /**
   * Whether the CLI honours Baiton's pre-assigned session id on a fresh
   * launch, so a journal `sessionId` can be resumed.
   *
   * claude accepts one directly (`--session-id <uuid>`). opencode cannot
   * pre-assign an id but tags the session with Baiton's, and
   * {@link Adapter.resolveSessionId} maps it back before a resume, so its
   * journal `sessionId` counts as resumable too. codex and antigravity mint
   * their own id and ignore the one Baiton generated, so the `sessionId` their
   * journal start records carry names no session that CLI knows: resuming with
   * it fails (`codex resume <uuid>` exits 1 with "No saved session found"). The
   * engine facade therefore launches those agents fresh unless a real id was
   * recovered by {@link Adapter.discoverSessionId}.
   */
  readonly acceptsSessionId: boolean;

  /**
   * Check that the underlying CLI is present and usable. Runs before every
   * stage because CLIs self-update (Requirement 14.2). When `ok` is false the
   * `reason` is a non-empty explanation the extension surfaces to the user
   * (Requirement 14.4).
   */
  probe(): Promise<ProbeResult>;

  /**
   * Build the launch arguments for one stage. Pure: it computes `shellPath`,
   * `shellArgs` and an optional `env` from the request and does not touch the
   * filesystem, terminal or journal. Throws {@link AdapterLaunchError} when
   * the request cannot be expressed in the CLI's argv; any other throw is a
   * bug.
   */
  launch(req: LaunchRequest): LaunchSpec;

  /**
   * Build the launch arguments to reopen an existing session with no prompt:
   * `claude --resume <id> <permission flags> <run-dir grant>` (Requirement
   * 3.3, 3.4). Used by the View command to show a sub-agent's conversation
   * after its terminal is gone.
   */
  attach(req: { role: Role; runId: string; sessionId: string }): LaunchSpec;

  /**
   * Best-effort recovery of the session id the CLI actually minted for a run,
   * for adapters whose `acceptsSessionId` is false. Called by the run queue
   * once a run has settled (whatever its outcome), and the id it returns is
   * journaled as the run's `discoveredSessionId` so a later Execute can resume
   * that session.
   *
   * Implementations read the CLI's own session storage and must never throw:
   * any failure — missing directory, unreadable file, malformed content —
   * resolves `undefined`, which simply means "no resumable session known".
   */
  discoverSessionId?(input: DiscoverSessionInput): Promise<string | undefined>;

  /**
   * Map a Baiton Session_Id (the UUID the Run_Queue mints and journals) to the
   * identifier the CLI itself needs on resume/attach. Only adapters whose CLI
   * mints its own session ids and offers no way to pre-assign one implement
   * this; for them `launch()` tags the fresh session with the Baiton id, and
   * this method looks the CLI's id back up before a `launch({resume: true})`
   * or `attach()`. Resolves `undefined` when no session carries that tag (the
   * caller then resumes without a specific id and the adapter falls back to
   * its "most recent session" flag). Must never throw.
   */
  resolveSessionId?(sessionId: string, cwd: string): Promise<string | undefined>;
}

/** What an adapter needs to locate the session a specific run created. */
export interface DiscoverSessionInput {
  /** The run id; its brief path appears in the session's first user turn. */
  runId: string;
  /** Absolute workspace root the CLI ran in; the session's recorded `cwd`. */
  workspaceRoot: string;
  /** Epoch milliseconds when the run was launched; bounds the search. */
  launchedAt: number;
}

/** The result of an adapter probe (Requirements 14.3, 14.4). */
export interface ProbeResult {
  /** The reported CLI version string (empty when the probe could not read it). */
  version: string;
  /** Whether the CLI is present and usable. */
  ok: boolean;
  /** Non-empty explanation when `ok` is false; omitted when `ok` is true. */
  reason?: string;
}

/** Everything the adapter needs to construct a stage launch. */
export interface LaunchRequest {
  /** The role being launched; selects the permission row (Requirement 15). */
  role: Role;
  /** The model identifier passed as `--model`. */
  model: string;
  /** Optional reasoning effort passed as `--effort`. */
  effort?: string;
  /** The initial prompt handed to the CLI. */
  prompt: string;
  /**
   * The run id whose `.baiton/runs/<run-id>/` directory the role may write to
   * (Requirement 15.4).
   */
  runId: string;
  /**
   * True when a prior session should be resumed via `--resume`/`-c`. False
   * launches a fresh session (Requirements 13.2, 13.3).
   */
  resume: boolean;
  /**
   * The Claude `--session-id` UUID passed on a fresh launch, generated by the
   * Run_Queue and recorded in the journal start record (Requirement 3.1).
   */
  sessionId: string;
  /**
   * The prior Session_Id to resume with `--resume <id>` when set; when
   * `resume` is true and this is absent, the adapter falls back to `-c`
   * (Requirement 3.2).
   */
  resumeSessionId?: string;
}

/**
 * A ready-to-run terminal launch. The extension creates the terminal with this
 * `shellPath`/`shellArgs` and no intervening shell (Requirement 11.1).
 */
export interface LaunchSpec {
  /** The executable to run as the terminal's own process. */
  shellPath: string;
  /** The arguments passed to that executable. */
  shellArgs: string[];
  /** Optional environment overrides for the launched process. */
  env?: Record<string, string>;
}
