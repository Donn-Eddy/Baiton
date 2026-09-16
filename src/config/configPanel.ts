/**
 * Config panel message protocol and form model (host-free core) — spec
 * "Configuration Panel" (config-panel), todos T01, T10.
 *
 * The Config_Panel webview is driven by a typed message union, in the same
 * shape as {@link "../orchestrator/webviewProtocol"}: the host sends
 * {@link ConfigPanelHostToWebview} messages to the webview, and the webview
 * sends {@link ConfigPanelWebviewToHost} messages back. Between those
 * messages the panel edits a {@link ConfigForm}: a string-shaped mirror of
 * {@link Config} that holds raw, possibly-invalid input text so the webview
 * can report a bad field instead of silently coercing it.
 *
 * This module carries no `vscode` import and no Node built-in import, so the
 * protocol, the form mapping and validation are unit-testable without a
 * running VS Code host. `media/config.js` is its plain-script mirror and
 * `test/configPanel.mirror.test.ts` guards against divergence.
 */
import { Role, ROLES } from '../model';
import { Config, LIMIT_BOUNDS, Limits, SUPPORTED_VERSION } from './types';

/**
 * Per-agent capability descriptor as held by the config panel (T10).
 * Structurally identical to `AgentCapabilities` from `src/adapter/adapter`
 * but declared locally to keep this module import-free of adapter dependencies.
 */
export interface AgentFormCapability {
  readonly models: readonly string[];
  readonly efforts: readonly string[];
  readonly modelLink?: string;
}

/** One role's form entry: raw, possibly-invalid input text for each field. */
export interface RoleFormEntry {
  agent: string;
  model: string;
  /** `''` means the field is unset (the config `effort` is optional). */
  effort: string;
}

/** The editable form the panel round-trips against the loaded document. */
export interface ConfigForm {
  roles: Record<Role, RoleFormEntry>;
  limits: {
    plan_review_rounds: string;
    exec_attempts: string;
    stall_notice_minutes: string;
  };
  git: {
    remote: string;
    base: string;
  };
}

/** The dropdown option sets the webview renders alongside the form. */
export interface ConfigFormOptions {
  readonly agents: readonly string[];
  readonly byAgent: Readonly<Record<string, AgentFormCapability>>;
}

/** One field-level validation error, keyed by a dotted path into {@link ConfigForm}. */
export interface ConfigFieldError {
  /** e.g. `roles.planner.agent`, `limits.exec_attempts`, `git.base`. */
  path: string;
  message: string;
}

/** A message the host sends to the webview to update its rendered state. */
export type ConfigPanelHostToWebview =
  /** The form parsed from disk, the conflict token to echo back on save, and the dropdown option sets. */
  | { type: 'loaded'; form: ConfigForm; token: string; options: ConfigFormOptions }
  /** The document could not be loaded as a form; `canReset` offers "Reset to defaults". */
  | { type: 'loadFailed'; kind: 'absent' | 'unparseable' | 'invalid'; message: string; canReset: boolean }
  /** The write succeeded; `token` is the new conflict token. `notes` names anything that could not hot-reload. */
  | { type: 'saved'; token: string; notes?: string[] }
  /** The write was refused: host-side re-validation failure, a stale-token conflict, or an I/O error. */
  | { type: 'saveFailed'; reason: 'invalid' | 'conflict' | 'io'; message: string; errors?: ConfigFieldError[] }
  /** The file changed on disk since it was loaded; `token` is the new on-disk token. */
  | { type: 'externalChange'; token: string };

/** A message the webview sends back to the host in response to user actions. */
export type ConfigPanelWebviewToHost =
  /** The webview mounted; the host should send the first `loaded`/`loadFailed`. */
  | { type: 'ready' }
  /** The user asked to reload (or discard edits); the host resends `loaded`/`loadFailed`. */
  | { type: 'load' }
  /** The user asked to save; `overwrite` is set when the user chose Overwrite after a conflict. */
  | { type: 'save'; form: ConfigForm; token: string; overwrite?: boolean }
  /** The user confirmed "Reset to defaults"; the host writes `defaultConfigJson()`. */
  | { type: 'reset' };

/**
 * The dropdown option sets for the form: the installed agent ids plus any
 * agent value already present in the form that is not an installed id, and
 * a copy of the capability catalogue with out-of-table models and efforts
 * appended for agents with closed sets (T10 round-trip rule).
 */
export function configFormOptions(
  agentIds: readonly string[],
  capabilities?: Readonly<Record<string, AgentFormCapability>>,
  form?: ConfigForm,
): ConfigFormOptions {
  const agents = [...agentIds];
  const byAgent: Record<string, { models: string[]; efforts: string[]; modelLink?: string }> = {};

  if (capabilities) {
    for (const [agent, cap] of Object.entries(capabilities)) {
      byAgent[agent] = {
        models: [...cap.models],
        efforts: [...cap.efforts],
        ...(cap.modelLink !== undefined ? { modelLink: cap.modelLink } : {}),
      };
    }
  } else {
    for (const agent of agentIds) {
      byAgent[agent] = { models: [], efforts: [] };
    }
  }

  if (form !== undefined) {
    for (const role of ROLES) {
      const entry = form.roles[role];
      if (entry === undefined) {
        continue;
      }
      if (entry.agent !== '' && !agents.includes(entry.agent)) {
        agents.push(entry.agent);
      }
      const trimmedAgent = entry.agent.trim();
      if (trimmedAgent !== '') {
        if (!byAgent[trimmedAgent]) {
          byAgent[trimmedAgent] = { models: [], efforts: [] };
        }
        const cap = byAgent[trimmedAgent];
        const trimmedModel = entry.model.trim();
        if (cap.models.length > 0 && trimmedModel !== '' && !cap.models.includes(trimmedModel)) {
          cap.models.push(trimmedModel);
        }
        const trimmedEffort = entry.effort.trim();
        if (cap.efforts.length > 0 && trimmedEffort !== '' && !cap.efforts.includes(trimmedEffort)) {
          cap.efforts.push(trimmedEffort);
        }
      }
    }
  }

  return { agents, byAgent };
}

/**
 * Maps a validated {@link Config} to its {@link ConfigForm}. Iterates
 * {@link ROLES} (not `Object.keys`) so the result has a deterministic key
 * order and round-trip diffs are stable.
 */
export function formFromConfig(config: Config): ConfigForm {
  const roles = {} as Record<Role, RoleFormEntry>;
  for (const role of ROLES) {
    const entry = config.roles[role];
    roles[role] = {
      agent: entry.agent,
      model: entry.model,
      effort: entry.effort ?? '',
    };
  }

  return {
    roles,
    limits: {
      plan_review_rounds: String(config.limits.plan_review_rounds),
      exec_attempts: String(config.limits.exec_attempts),
      stall_notice_minutes: String(config.limits.stall_notice_minutes),
    },
    git: {
      remote: config.git.remote,
      base: config.git.base,
    },
  };
}

/**
 * Builds a best-effort {@link ConfigForm} from a raw parsed document that may
 * be semantically invalid (the shape {@link loadConfig} would refuse). Never
 * throws: missing or wrong-typed leaves coerce to `''` so the user can fix
 * the bad field in the form instead of hand-editing JSON.
 */
export function formFromDocument(doc: unknown): ConfigForm {
  const root = isObject(doc) ? doc : {};
  const rawRoles = isObject(root.roles) ? root.roles : {};
  const rawLimits = isObject(root.limits) ? root.limits : {};
  const rawGit = isObject(root.git) ? root.git : {};

  const roles = {} as Record<Role, RoleFormEntry>;
  for (const role of ROLES) {
    const entry = isObject(rawRoles[role]) ? (rawRoles[role] as Record<string, unknown>) : {};
    roles[role] = {
      agent: asString(entry.agent),
      model: asString(entry.model),
      effort: asString(entry.effort),
    };
  }

  return {
    roles,
    limits: {
      plan_review_rounds: asFormNumber(rawLimits.plan_review_rounds),
      exec_attempts: asFormNumber(rawLimits.exec_attempts),
      stall_notice_minutes: asFormNumber(rawLimits.stall_notice_minutes),
    },
    git: {
      remote: asString(rawGit.remote),
      base: asString(rawGit.base),
    },
  };
}

/** A string leaf as the form holds it: the value itself, or `''` for anything else. */
function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

/** A numeric leaf as the form holds it: its decimal text, or `''` for anything else. */
function asFormNumber(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

/**
 * Validates a {@link ConfigForm}, returning every error found (not just the
 * first), ordered roles → limits → git. Returns `[]` for a valid form. Each
 * rule mirrors what {@link loadConfig} would otherwise reject, so a form that
 * passes here always produces a document `loadConfig` accepts.
 */
export function validateConfigForm(
  form: ConfigForm,
  options: {
    agents: readonly string[];
    byAgent: Readonly<Record<string, AgentFormCapability>>;
  },
): ConfigFieldError[] {
  const errors: ConfigFieldError[] = [];

  for (const role of ROLES) {
    const entry = form.roles[role];
    const agent = entry.agent.trim();
    if (agent.length === 0) {
      errors.push({ path: `roles.${role}.agent`, message: `"${role}" is missing an agent.` });
    } else if (!options.agents.includes(agent)) {
      errors.push({
        path: `roles.${role}.agent`,
        message: `"${agent}" is not an installed agent (installed: ${options.agents.join(', ')}).`,
      });
    }

    // Model: blank/whitespace is the only model check. Deliberately no membership check
    // against byAgent so a brand-new model works without an extension update and hand-typed
    // opencode models are never rejected (the "Other…" escape makes model dropdowns advisory).
    if (entry.model.trim().length === 0) {
      errors.push({ path: `roles.${role}.model`, message: `"${role}" is missing a model.` });
    }

    // Effort: blank check first, then closed-set check only where the catalogue is closed.
    // Emit at most one effort error per role (blank OR unsupported, never both).
    if (entry.effort !== '' && entry.effort.trim().length === 0) {
      errors.push({ path: `roles.${role}.effort`, message: `"${role}" effort must not be blank.` });
    } else if (entry.effort.trim().length > 0) {
      const effort = entry.effort.trim();
      const cap = options.byAgent[agent];
      if (cap && cap.efforts.length > 0 && !cap.efforts.includes(effort)) {
        errors.push({
          path: `roles.${role}.effort`,
          message: `"${role}" effort "${effort}" is not supported by ${agent} (supported: ${cap.efforts.join(', ')}).`,
        });
      }
    }
  }

  const limitFields = Object.keys(LIMIT_BOUNDS) as (keyof Limits)[];
  for (const field of limitFields) {
    const raw = form.limits[field].trim();
    const bounds = LIMIT_BOUNDS[field];
    if (!/^-?\d+$/.test(raw) || !Number.isInteger(Number(raw))) {
      errors.push({ path: `limits.${field}`, message: `"limits.${field}" must be an integer.` });
      continue;
    }
    const n = Number(raw);
    if (n < bounds.min || n > bounds.max) {
      errors.push({
        path: `limits.${field}`,
        message: `"limits.${field}" must be between ${bounds.min} and ${bounds.max} (found ${n})`,
      });
    }
  }

  if (form.git.remote.trim().length === 0) {
    errors.push({ path: 'git.remote', message: 'Git remote must not be empty.' });
  }
  if (form.git.base.trim().length === 0) {
    errors.push({ path: 'git.base', message: 'Git base branch must not be empty.' });
  }

  return errors;
}

/**
 * Merges a validated {@link ConfigForm} into a raw parsed document, returning
 * a new object; `rawDoc` is never mutated (the caller keeps the original for
 * conflict reporting). Unknown top-level keys (`pr`, `git.verify`, unknown
 * role keys, …) survive untouched, because the merge clones the existing
 * document rather than rebuilding it from the form. Precondition: `form` has
 * already passed {@link validateConfigForm} (limits are parsed with `Number`
 * without re-checking range/integer-ness here).
 */
export function applyFormToDocument(rawDoc: unknown, form: ConfigForm): Record<string, unknown> {
  const base = isObject(rawDoc) ? { ...rawDoc } : {};

  const out: Record<string, unknown> = { ...base };
  if (typeof out.version !== 'number' || out.version !== SUPPORTED_VERSION) {
    out.version = SUPPORTED_VERSION;
  }

  const existingRoles = isObject(base.roles) ? base.roles : {};
  const roles: Record<string, unknown> = { ...existingRoles };
  for (const role of ROLES) {
    const existingEntry = isObject(existingRoles[role]) ? (existingRoles[role] as Record<string, unknown>) : {};
    const formEntry = form.roles[role];
    const entry: Record<string, unknown> = {
      ...existingEntry,
      agent: formEntry.agent.trim(),
      model: formEntry.model.trim(),
    };
    const effort = formEntry.effort.trim();
    if (effort === '') {
      delete entry.effort;
    } else {
      entry.effort = effort;
    }
    roles[role] = entry;
  }
  out.roles = roles;

  const existingLimits = isObject(base.limits) ? base.limits : {};
  out.limits = {
    ...existingLimits,
    plan_review_rounds: Number(form.limits.plan_review_rounds.trim()),
    exec_attempts: Number(form.limits.exec_attempts.trim()),
    stall_notice_minutes: Number(form.limits.stall_notice_minutes.trim()),
  };

  const existingGit = isObject(base.git) ? base.git : {};
  out.git = {
    ...existingGit,
    remote: form.git.remote.trim(),
    base: form.git.base.trim(),
  };

  return out;
}

/** Whether a value is a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
