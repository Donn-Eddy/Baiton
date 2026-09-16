/**
 * Live configuration hot-reload (Requirement 22.7, 22.8; spec "Config Panel", todo T08).
 *
 * Provides {@link createConfigRefresh}, the host-free supplier for the Config Panel
 * controller's `ApplyConfig` seam. When the user saves in the panel, the newly validated
 * {@link Config} is applied to the running activation state in place — replacing the
 * whole configuration object, re-resolving agent executables, and surfacing any
 * non-reloadable factors (in-flight runs, missing binaries) as user-facing notes.
 *
 * What needs NO refresh and why:
 * - Adapter registry (`src/adapter/index.ts:52-71`): keyed by agent id with stateless
 *   adapter instances, so only the role -> agent lookup had to become lazy, not the
 *   registry itself.
 * - Limits block (`limits`): validated but has no consumer in the running extension yet.
 * - SpecExplorer (`src/activation/specExplorer.ts:126-150`): derives all tree state from
 *   the filesystem (`spec.md`) plus the `restricted` flag, reading no config.
 */
import type { Config } from '../config';
import type { AgentExecutables } from './executable';
import type { ApplyConfig } from './configPanelController';
import { ROLES } from '../model/role';

/**
 * The mutable activation target refreshed by {@link createConfigRefresh}.
 * Held by the extension host and shared with the command layer.
 */
export interface ConfigRefreshTarget {
  /** The live configuration, replaced wholesale on save. */
  config: Config;
  /** The live agent executables resolution table, replaced wholesale when role agents change. */
  executables: AgentExecutables;
}

/**
 * Dependencies injected into {@link createConfigRefresh}.
 * Host-free: carries no `vscode` imports and is fully unit-testable.
 */
export interface ConfigRefreshDeps {
  /** The live activation state, or undefined when activation never completed. */
  state(): ConfigRefreshTarget | undefined;
  /** Re-resolve one executable per distinct agent named by a config. */
  resolveExecutables(agents: readonly string[]): AgentExecutables;
  /** Retry the gated half of activation after a previously invalid config; resolves the notes to report. */
  completeActivation(): Promise<readonly string[]>;
  /** Slugs with a stage in flight, for the in-flight note. */
  runningSlugs(): readonly string[];
  /** Logger for recording refresh events. */
  log(message: string): void;
}

/**
 * Note returned when one or more stages are in flight during a config save.
 * A stage already dispatched keeps the model, effort, and agent it launched with;
 * the new configuration applies to subsequent runs.
 */
export const IN_FLIGHT_NOTE = (slugs: readonly string[]): string =>
  `A stage is currently running for: ${slugs.join(', ')}. Running stages keep the model, effort, and agent they launched with; new values apply to the next run.`;

/**
 * Note returned when late activation cannot complete due to an unrecoverable factor
 * (e.g. workspace resolution failure).
 */
export const NOT_ACTIVATED_NOTE = (reason: string): string =>
  `Baiton remains inactive in this window: ${reason}`;

/**
 * Note returned when saving a configuration in a panel opened for a directory
 * other than the one this window is currently activated against.
 */
export const FOLDER_MISMATCH_NOTE =
  'Configuration saved, but this window is activated against a different workspace folder; live changes were not applied to the running extension.';

/**
 * Build the host-free `ApplyConfig` function for hot-reloading `.baiton/config.json`.
 */
export function createConfigRefresh(deps: ConfigRefreshDeps): ApplyConfig {
  return async (config: Config): Promise<readonly string[]> => {
    const state = deps.state();
    if (state === undefined) {
      return await deps.completeActivation();
    }

    // 1. Whole-object replacement: never merge field-by-field.
    state.config = config;

    // 2. Re-resolve executables from the new role agents.
    state.executables = deps.resolveExecutables(ROLES.map((r) => config.roles[r].agent));

    // 3. Collect notes: missing executables + in-flight stages.
    const notes: string[] = [];
    for (const error of state.executables.errors) {
      notes.push(error.message);
    }

    const running = deps.runningSlugs();
    if (running.length > 0) {
      notes.push(IN_FLIGHT_NOTE(running));
    }

    // 4. Log replacement and note count.
    deps.log(`Live config reloaded (${notes.length} note${notes.length === 1 ? '' : 's'}).`);
    return notes;
  };
}
