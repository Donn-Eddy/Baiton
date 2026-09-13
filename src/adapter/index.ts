/**
 * The adapter boundary, the shared permission helpers, and the four per-CLI
 * adapters (claude, opencode, antigravity/agy, codex), plus the agent-id
 * keyed registry. An adapter owns only launch args, the probe and the
 * continue flag — nothing else (Requirement 14.1).
 */
export * from './adapter';
export * from './permissions';
export * from './claude';
export * from './opencode';
export * from './antigravity';
export * from './codex';

import { AGENT_BINARY } from './adapter';
import type { Adapter, AgentId } from './adapter';
import { DEFAULT_PERMISSION_MODE } from './permissions';
import type { PermissionMode } from './permissions';
import { ClaudeAdapter } from './claude';
import { OpencodeAdapter } from './opencode';
import { AntigravityAdapter } from './antigravity';
import { CodexAdapter } from './codex';

/** Whether `value` is one of the known agent ids, derived from `AGENT_BINARY`'s keys. */
export function isAgentId(value: string): value is AgentId {
  return Object.prototype.hasOwnProperty.call(AGENT_BINARY, value);
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
