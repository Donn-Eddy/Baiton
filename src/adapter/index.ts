/**
 * The adapter boundary, the Baiton role profiles, the shared permission
 * helpers, and the four per-CLI
 * adapters (claude, opencode, antigravity/agy, codex), plus the agent-id
 * keyed registry. An adapter owns only launch args, the probe and the
 * continue flag — nothing else (Requirement 14.1).
 */
export * from './adapter';
export * from './roleProfile';
export * from './permissions';
export * from './claude';
export * from './opencode';
export * from './antigravity';
export * from './codex';

import { AGENT_BINARY } from './adapter';
import type { Adapter, AgentCapabilities, AgentId } from './adapter';
import { DEFAULT_PERMISSION_MODE, claudeAllowList } from './permissions';
import type { PermissionMode } from './permissions';
import { opencodeAllowList } from './opencode';
import { roleAllowList } from './roleProfile';
import type { AgentAllowList } from './roleProfile';
import { ClaudeAdapter, CLAUDE_MODELS, CLAUDE_EFFORTS } from './claude';
import { OpencodeAdapter, OPENCODE_MODELS, OPENCODE_EFFORTS, OPENCODE_MODEL_DOC_URL } from './opencode';
import { AntigravityAdapter, ANTIGRAVITY_MODELS, ANTIGRAVITY_EFFORTS } from './antigravity';
import { CodexAdapter, CODEX_MODELS, CODEX_EFFORTS } from './codex';
import type { Role } from '../model/role';

/** Whether `value` is one of the known agent ids, derived from `AGENT_BINARY`'s keys. */
export function isAgentId(value: string): value is AgentId {
  return Object.prototype.hasOwnProperty.call(AGENT_BINARY, value);
}

/**
 * The per-agent auto-mode allow-list lookup: claude's list is parsed from the
 * `--allowedTools` flags it is launched with, opencode's from its agent
 * definition's permission rules, and codex (`--sandbox workspace-write` for
 * every role) and antigravity (`--mode plan|accept-edits`) expose no finer
 * table than the role profile, so they — and any unknown agent id — fall back
 * to the profile-derived list, the conservative default that never widens
 * beyond the role's own policy.
 */
export function agentAllowList(
  agent: string,
  role: Role,
  runId: string,
  mode: PermissionMode = DEFAULT_PERMISSION_MODE,
): AgentAllowList {
  switch (agent) {
    case 'claude':
      return claudeAllowList(role, runId, mode);
    case 'opencode':
      return opencodeAllowList(role, runId);
    // codex (--sandbox workspace-write for every role) and antigravity
    // (--mode plan|accept-edits) expose no finer table than the profile.
    default:
      return roleAllowList(agent, role, runId);
  }
}

/**
 * How a launched agent's harness asks reach the run's watched `asks/`
 * directory. Probed per adapter (see the README 'Per-adapter relay state'
 * table and the four findings blocks above it):
 *
 * - `native`        — the CLI installs a permission hook straight from argv, so
 *                     the relay needs nothing but the launch command
 *                     (`claudeRelayFlags` in `src/adapter/permissions.ts`).
 * - `config-driven` — the CLI's hook/plugin surface exists but loads only from
 *                     a file on disk (opencode's plugin file, agy's
 *                     `hooks.json`, codex's persisted hook trust) or cannot
 *                     grant an approval at all (agy's `allow`), so no hook is
 *                     wired; instead the Brief carries instructions telling the
 *                     sub-agent to write the ask files itself
 *                     (`askRelayInstruction` in `src/engine/roleInstructions.ts`).
 */
export type AskRelayKind = 'native' | 'config-driven';

/**
 * Probe-derived per-adapter ask-relay selection; mirrors the README
 * 'Per-adapter relay state' table. Each row cites its probe outcome:
 *
 * - claude: native — the inline `--settings` PreToolUse hook is installable
 *   from pure argv (verified against 2.1.278), so the harness relay runs
 *   without any brief text.
 * - opencode: config-driven — a native plugin hook exists and fires, but
 *   opencode loads plugins only from a file on disk (a `file://`/npm entry or
 *   `.opencode/plugin/`), never inline, and `launch()` writes nothing.
 * - antigravity: config-driven — the `hooks.json` PreToolUse hook works but
 *   loads only from an on-disk file, and its `allow` decision cannot grant a
 *   headless permission anyway, so it could never carry an approval relay.
 * - codex: config-driven — the PreToolUse hook works but every enabled hook is
 *   gated behind persisted hook trust written through the TUI, which argv
 *   alone cannot satisfy.
 */
export const ASK_RELAY_KIND: Record<AgentId, AskRelayKind> = {
  claude: 'native',
  opencode: 'config-driven',
  antigravity: 'config-driven',
  codex: 'config-driven',
};

/**
 * The ask-relay kind for an agent id. An unknown id resolves to
 * `config-driven` deliberately — the conservative default, since the fallback
 * only adds brief text and never widens a permission.
 */
export function askRelayKind(agent: string): AskRelayKind {
  return isAgentId(agent) ? ASK_RELAY_KIND[agent] : 'config-driven';
}

/** True when the agent needs the config-driven ask-relay fallback (brief text) rather than a native hook. */
export function usesConfigDrivenAskRelay(agent: string): boolean {
  return askRelayKind(agent) === 'config-driven';
}

/**
 * A per-role lookup from agent id to its adapter. Roles may mix agents (a
 * role's `RoleConfig.agent` is an unvalidated string — see
 * src/config/types.ts and src/config/loadConfig.ts), so the engine needs a
 * lookup instead of the single `new ClaudeAdapter()` constructed today at
 * src/activation/commands.ts:164 (Requirement 14.1).
 */
export interface AdapterRegistry {
  /** Look up the adapter for an unvalidated agent string; `undefined` for an unknown id. */
  get(agent: string): Adapter | undefined;
  /** Look up the adapter for an already-narrowed agent id. */
  require(agent: AgentId): Adapter;
  /** The known agent ids, matching the keys of `AGENT_BINARY`. */
  readonly ids: readonly AgentId[];
}

/**
 * Build an {@link AdapterRegistry} with one adapter instance per agent id.
 * Adapters are stateless (launch/attach are pure; probe only spawns
 * `<bin> --version`), so sharing one instance per id across roles and runs is
 * safe. `mode` is threaded to the claude adapter only: the
 * `readOnlyFallbackToAcceptEdits` flip (Requirement 15.7) is claude-specific,
 * the other three adapters map permissions via their own CLI-native flags
 * (opencode `--agent`, antigravity `--mode`, codex `--sandbox`/`--ask-for-approval`).
 */
export function createAdapterRegistry(mode: PermissionMode = DEFAULT_PERMISSION_MODE): AdapterRegistry {
  const instances: Record<AgentId, Adapter> = {
    claude: new ClaudeAdapter(mode),
    opencode: new OpencodeAdapter(),
    antigravity: new AntigravityAdapter(),
    codex: new CodexAdapter(),
  };
  const ids = Object.keys(instances) as AgentId[];

  return {
    get(agent: string): Adapter | undefined {
      return isAgentId(agent) ? instances[agent] : undefined;
    },
    require(agent: AgentId): Adapter {
      return instances[agent];
    },
    ids,
  };
}

/**
 * Assembles the single source of truth for model and reasoning effort options across
 * the extension and the config panel.
 *
 * For claude, antigravity, and codex, models and efforts are enumerated starting
 * sets rendered as dropdowns with an always-present "Other…" escape.
 * For opencode, both lists are empty (free text) with a link to model documentation.
 *
 * Returns a fresh object with newly copied arrays on every call, matching defaultConfig()'s
 * factory convention so mutation or appending in a consumer does not leak across calls.
 */
export function agentCapabilities(): Record<AgentId, AgentCapabilities> {
  return {
    claude: {
      models: [...CLAUDE_MODELS],
      efforts: [...CLAUDE_EFFORTS],
    },
    opencode: {
      models: [...OPENCODE_MODELS],
      efforts: [...OPENCODE_EFFORTS],
      modelLink: OPENCODE_MODEL_DOC_URL,
    },
    antigravity: {
      models: Object.keys(ANTIGRAVITY_MODELS),
      efforts: [...ANTIGRAVITY_EFFORTS],
    },
    codex: {
      models: [...CODEX_MODELS],
      efforts: [...CODEX_EFFORTS],
    },
  };
}
