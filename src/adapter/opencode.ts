import { execFile, spawn } from 'child_process';
import type {
  Adapter,
  AgentCapabilities,
  DiscoveryContext,
  LaunchRequest,
  LaunchSpec,
  ProbeResult,
} from './adapter';
import { AGENT_BINARY, DEFAULT_DISCOVERY_TIMEOUT_MS, capabilitiesFromEntries } from './adapter';
import type { Role } from '../model/role';
import type { ModelEntry } from '../orchestrator/modelCatalog';
import type { FeedFetch, FeedResponse } from '../orchestrator/modelsDev';
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
 * `--variant` values. An empty list signals free-text rendering in the config
 * panel.
 *
 * This is the CURATED fallback only. Discovery now derives per-model effort
 * levels from each model's `variants` keys (see
 * {@link opencodeModelsFromVerboseOutput}) and the capability-level list from
 * their ordered union, so a discovered empty list means only "no model
 * disclosed any level" — never "opencode has no variants".
 */
export const OPENCODE_EFFORTS: readonly string[] = [];

/** Documentation URL for opencode model selection rendered inline in the config panel. */
export const OPENCODE_MODEL_DOC_URL = 'https://opencode.ai/docs/go/';

// --- opencode model discovery (model-selector-refresh T06) ---

/** The only subcommand discovery ever spawns: `opencode serve`. */
export const OPENCODE_SERVE_SUBCOMMAND = 'serve';

/** Loopback only: discovery never binds a routable interface. */
export const OPENCODE_SERVE_HOSTNAME = '127.0.0.1';

/** Port `0` asks the OS for an ephemeral port, so discovery never binds a predictable public port. */
export const OPENCODE_SERVE_PORT = '0';

/** The full argv of the discovery server: loopback host, ephemeral port. */
export const OPENCODE_SERVE_ARGS: readonly string[] = [
  OPENCODE_SERVE_SUBCOMMAND,
  '--hostname',
  OPENCODE_SERVE_HOSTNAME,
  '--port',
  OPENCODE_SERVE_PORT,
];

/** The primary discovery source's subcommand: `opencode models`. */
export const OPENCODE_MODELS_SUBCOMMAND = 'models';

/** The flag that makes `opencode models` disclose each model's full JSON. */
export const OPENCODE_MODELS_VERBOSE_FLAG = '--verbose';

/**
 * The full argv of the primary discovery source: `opencode models --verbose`.
 *
 * Verified on opencode 1.18.30: the verbose listing prints each
 * `provider/model` line followed by that model's pretty-printed JSON object,
 * whose `variants` KEYS are exactly the values `--variant` accepts for that
 * model (and whose `name` is its display label). An older CLI that does not
 * know `--verbose` either errors — in which case the runner resolves
 * `undefined` and the `/api/model` fallback runs — or prints the bare listing,
 * which {@link opencodeModelsFromVerboseOutput} handles identically to
 * {@link opencodeModelsFromCliOutput}.
 */
export const OPENCODE_MODELS_ARGS: readonly string[] = [
  OPENCODE_MODELS_SUBCOMMAND,
  OPENCODE_MODELS_VERBOSE_FLAG,
];

/** The server route the primary discovery path GETs. */
export const OPENCODE_MODEL_ENDPOINT_PATH = '/api/model';

/**
 * When this environment variable already holds an `http://` / `https://` URL an
 * opencode server is assumed to be running and is used INSTEAD of spawning one
 * (and is never killed).
 *
 * It is a base URL, never a credential, and it is the only environment variable
 * the whole discovery path reads — so no secret can leave the host through it.
 */
export const OPENCODE_SERVER_ENV_VAR = 'OPENCODE_SERVER';

/**
 * A started (or pre-existing) opencode server handle. `dispose()` must be
 * idempotent and must never throw, because it runs from a `finally`.
 */
export interface OpencodeServer {
  readonly baseUrl: string;
  dispose(): void;
}

/**
 * Starts an opencode server for discovery. Resolves `undefined` — never
 * rejects — when no server could be started.
 */
export type OpencodeServerStarter = (options: {
  cwd?: string;
  timeoutMs: number;
  log?: (message: string) => void;
}) => Promise<OpencodeServer | undefined>;

/**
 * Runs `opencode models --verbose` and resolves its stdout, or `undefined` on
 * any failure. Never rejects.
 */
export type OpencodeModelsCli = (options: {
  cwd?: string;
  timeoutMs: number;
}) => Promise<string | undefined>;

/** Optional construction options of {@link OpencodeAdapter}; every field has a default. */
export interface OpencodeAdapterOptions {
  /** The server starter; defaults to {@link defaultStartOpencodeServer}. */
  readonly startServer?: OpencodeServerStarter;
  /** The transport for `/api/model`; defaults to the runtime's global `fetch`. */
  readonly fetchModels?: FeedFetch;
  /** The `opencode models` runner; defaults to {@link defaultRunModelsCli}. */
  readonly runModelsCli?: OpencodeModelsCli;
  /** A base URL of an already-running server; skips the starter entirely. */
  readonly serverBaseUrl?: string;
}

/**
 * Parse an `/api/model` payload into {@link ModelEntry} records.
 *
 * Pure and total: never throws, never mutates the input, returns `[]` for any
 * unrecognised shape. The response shape is not pinned by any fixture or
 * documentation in this repo, so the parser is deliberately tolerant — an
 * unrecognised shape yields no entry rather than
 * failing the refresh. Accepted shapes, first match winning:
 *
 * 1. a bare array of items;
 * 2. an object whose `providers`, `models` or `items` property is an array;
 * 3. an object whose `providers` property is an OBJECT keyed by provider id,
 *    each value an array of items or an object whose `models` is an array or a
 *    map keyed by model id;
 * 4. the same provider-keyed OBJECT at the top level (no `providers` wrapper).
 *
 * Per item, with an inherited provider id when the shape supplied one (the map
 * key, or the parent's `id`): a string item is the raw id; an object item's raw
 * id is the first non-empty trimmed string of `id`, `model`, `modelID`, `slug`;
 * a map-keyed model falls back to its key. The emitted `id` is the raw id when
 * it already contains a `/`, else `<provider>/<raw>` when a provider is known —
 * never double-prefixed. `provider` is the emitted id's first segment, else the
 * known provider id, else omitted. `label` is the first non-empty trimmed
 * string of `displayName`, `name`, set only when it differs from the emitted id
 * (the same rule as `codexModelsFromAppServer`). No `efforts`/`defaultEffort`
 * is ever emitted: opencode effort is free-text `--variant`. Entries are
 * de-duplicated by emitted id, first occurrence winning, and source order is
 * otherwise preserved. Every key is assigned CONDITIONALLY — never an explicit
 * `undefined` own key.
 */
export function opencodeModelsFromApi(payload: unknown): ModelEntry[] {
  const entries: ModelEntry[] = [];
  const seen = new Set<string>();

  const push = (item: unknown, providerId: string | undefined, keyId?: string): void => {
    const entry = opencodeEntryFromItem(item, providerId, keyId);
    if (entry === undefined || seen.has(entry.id)) {
      return;
    }
    seen.add(entry.id);
    entries.push(entry);
  };

  // A provider bucket: an array of items, or an object whose `models` is an
  // array or a map keyed by model id.
  const pushProvider = (value: unknown, providerId: string | undefined): void => {
    if (Array.isArray(value)) {
      for (const item of value) {
        push(item, providerId);
      }
      return;
    }
    if (typeof value !== 'object' || value === null) {
      return;
    }
    const bucket = value as Record<string, unknown>;
    const own = firstNonEmptyString([bucket['id']]) ?? providerId;
    const models = bucket['models'];
    if (Array.isArray(models)) {
      for (const item of models) {
        push(item, own);
      }
      return;
    }
    if (typeof models === 'object' && models !== null) {
      for (const [key, item] of Object.entries(models as Record<string, unknown>)) {
        push(item, own, key);
      }
    }
  };

  if (Array.isArray(payload)) {
    for (const item of payload) {
      push(item, undefined);
    }
    return entries;
  }
  if (typeof payload !== 'object' || payload === null) {
    return entries;
  }
  const obj = payload as Record<string, unknown>;

  for (const key of ['providers', 'models', 'items'] as const) {
    if (Array.isArray(obj[key])) {
      for (const item of obj[key] as readonly unknown[]) {
        // A `providers` array element may itself be a provider bucket.
        if (key === 'providers') {
          pushProvider(item, firstNonEmptyString([(item as Record<string, unknown> | null)?.['id']]));
        } else {
          push(item, undefined);
        }
      }
      return entries;
    }
  }

  const providers = obj['providers'];
  if (typeof providers === 'object' && providers !== null && !Array.isArray(providers)) {
    for (const [key, value] of Object.entries(providers as Record<string, unknown>)) {
      pushProvider(value, key);
    }
    return entries;
  }

  // Shape 4: the provider-keyed map at the top level. Only accepted when every
  // value is an object carrying a `models` array/map, so an arbitrary object
  // still yields `[]`.
  const topLevel = Object.entries(obj);
  if (topLevel.length > 0 && topLevel.every(([, value]) => carriesModels(value))) {
    for (const [key, value] of topLevel) {
      pushProvider(value, key);
    }
  }
  return entries;
}

/** True when `value` is an object whose `models` is an array or a non-null object. */
function carriesModels(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const models = (value as Record<string, unknown>)['models'];
  return Array.isArray(models) || (typeof models === 'object' && models !== null);
}

/** One `/api/model` item as an entry, or `undefined` when it carries no usable id. */
function opencodeEntryFromItem(
  item: unknown,
  providerId: string | undefined,
  keyId?: string,
): ModelEntry | undefined {
  let rawId: string | undefined;
  let label: string | undefined;

  if (typeof item === 'string') {
    rawId = firstNonEmptyString([item]);
  } else if (typeof item === 'object' && item !== null) {
    const raw = item as Record<string, unknown>;
    rawId = firstNonEmptyString([raw['id'], raw['model'], raw['modelID'], raw['slug']]);
    label = firstNonEmptyString([raw['displayName'], raw['name']]);
  }
  rawId = rawId ?? firstNonEmptyString([keyId]);
  if (rawId === undefined) {
    return undefined;
  }

  const id =
    rawId.includes('/') || providerId === undefined || providerId.length === 0
      ? rawId
      : `${providerId}/${rawId}`;
  const slash = id.indexOf('/');
  const provider = slash > 0 ? id.slice(0, slash) : providerId;

  const entry: { id: string; label?: string; provider?: string } = { id };
  if (label !== undefined && label !== id) {
    entry.label = label;
  }
  if (provider !== undefined && provider.length > 0) {
    entry.provider = provider;
  }
  return entry;
}

/** The first element readable as a non-empty trimmed string, or undefined. */
function firstNonEmptyString(values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string') {
      const trimmed = value.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return undefined;
}

/** A `provider/model` token as `opencode models` prints it: exactly one `/`, no spaces. */
const OPENCODE_MODEL_TOKEN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._:-]+$/;

/**
 * Parse a BARE `opencode models` listing into {@link ModelEntry} records.
 *
 * Kept as the documented plain-listing parser; discovery itself goes through
 * {@link opencodeModelsFromVerboseOutput}, which yields exactly these ids on a
 * listing with no JSON blocks.
 *
 * Pure and total: never throws. Each line has its ANSI escapes and any leading
 * bullet/marker stripped, and only its FIRST whitespace-delimited token is
 * considered (opencode prints an id plus an optional trailing description). A
 * token is kept only when it matches {@link OPENCODE_MODEL_TOKEN}, which drops
 * headers, blank lines and prose. Entries are de-duplicated by id in first-seen
 * order and carry only `id` and `provider`: effort stays free text.
 */
export function opencodeModelsFromCliOutput(stdout: string): ModelEntry[] {
  const entries: ModelEntry[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const cleaned = line
      // The ESC byte is intentional: it is exactly what a coloured listing line
      // hides its id behind.
      // eslint-disable-next-line no-control-regex
      .replace(/\u001B\[[0-9;]*m/g, '')
      .replace(/^[\s>*•-]+/, '')
      .trim();
    const token = cleaned.split(/\s+/)[0] ?? '';
    if (!OPENCODE_MODEL_TOKEN.test(token) || seen.has(token)) {
      continue;
    }
    seen.add(token);
    entries.push({ id: token, provider: token.slice(0, token.indexOf('/')) });
  }
  return entries;
}

/** Strip ANSI escapes and any leading bullet/marker from one listing line. */
function cleanOpencodeLine(line: string): string {
  return (
    line
      // The ESC byte is intentional: it is exactly what a coloured listing line
      // hides its id behind.
      // eslint-disable-next-line no-control-regex
      .replace(/\u001B\[[0-9;]*m/g, '')
      .replace(/^[\s>*•-]+/, '')
      .trim()
  );
}

/**
 * Parse `opencode models --verbose` stdout into {@link ModelEntry} records —
 * the PRIMARY discovery source.
 *
 * Pure and total: never throws, never mutates, `[]` for empty or unrecognised
 * input. Each line is ANSI-stripped and marker-stripped exactly as
 * {@link opencodeModelsFromCliOutput} strips it, and a line is an entry only
 * when its FIRST whitespace-delimited token matches {@link OPENCODE_MODEL_TOKEN}
 * — which drops headers, blank lines and prose. When the next non-blank line
 * after an id opens a `{`, the pretty-printed object is collected by brace depth
 * counted OUTSIDE double-quoted strings (so a `{` inside a `"name"` value never
 * shifts the depth) and `JSON.parse`d; an unparseable block, or one running to
 * EOF unterminated, degrades to a plain `{ id, provider }` entry rather than
 * failing.
 *
 * From a parsed detail object only two fields are read: `name` becomes `label`
 * (set only when it differs from both the full token and the bare model id) and
 * the KEYS of `variants` become `efforts`, in object order, which are exactly
 * the values `--variant` accepts for that model. A model whose `variants` is
 * `{}`, missing, null or not an object gets NO `efforts` key at all — an empty
 * array is not the same thing downstream. `defaultEffort` is NEVER emitted:
 * opencode marks no default variant. Every key is assigned CONDITIONALLY, never
 * as an explicit `undefined` own key.
 *
 * Entries are de-duplicated by id, first occurrence winning (a duplicate's JSON
 * block is still consumed), and source order is otherwise preserved. On a bare
 * listing with no JSON blocks the result carries exactly the same ids as
 * {@link opencodeModelsFromCliOutput}.
 */
export function opencodeModelsFromVerboseOutput(stdout: string): ModelEntry[] {
  const lines = stdout.split(/\r?\n/);
  const entries: ModelEntry[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i += 1) {
    const cleaned = cleanOpencodeLine(lines[i] ?? '');
    const token = cleaned.split(/\s+/)[0] ?? '';
    if (!OPENCODE_MODEL_TOKEN.test(token)) {
      continue;
    }

    // Look ahead past blank lines for this model's pretty-printed JSON block.
    let scan = i + 1;
    while (scan < lines.length && cleanOpencodeLine(lines[scan] ?? '').length === 0) {
      scan += 1;
    }
    let detail: Record<string, unknown> | undefined;
    if (scan < lines.length && cleanOpencodeLine(lines[scan] ?? '').startsWith('{')) {
      const collected: string[] = [];
      let depth = 0;
      let inString = false;
      let escaped = false;
      let closed = false;
      let cursor = scan;
      for (; cursor < lines.length; cursor += 1) {
        const raw = cleanOpencodeLine(lines[cursor] ?? '');
        collected.push(raw);
        for (const ch of raw) {
          if (escaped) {
            escaped = false;
            continue;
          }
          if (inString) {
            if (ch === '\\') {
              escaped = true;
            } else if (ch === '"') {
              inString = false;
            }
            continue;
          }
          if (ch === '"') {
            inString = true;
          } else if (ch === '{') {
            depth += 1;
          } else if (ch === '}') {
            depth -= 1;
          }
        }
        if (depth <= 0) {
          closed = true;
          break;
        }
      }
      // Consume the block either way: an unterminated one runs to EOF.
      i = closed ? cursor : lines.length;
      try {
        const parsed: unknown = JSON.parse(collected.join('\n'));
        if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
          detail = parsed as Record<string, unknown>;
        }
      } catch {
        // An unparseable block degrades to a plain entry.
      }
    }

    if (seen.has(token)) {
      continue;
    }
    seen.add(token);

    const slash = token.indexOf('/');
    const entry: { id: string; label?: string; provider?: string; efforts?: readonly string[] } = {
      id: token,
      provider: token.slice(0, slash),
    };
    if (detail !== undefined) {
      const label = firstNonEmptyString([detail['name']]);
      if (label !== undefined && label !== token && label !== token.slice(slash + 1)) {
        entry.label = label;
      }
      const variants = detail['variants'];
      if (typeof variants === 'object' && variants !== null && !Array.isArray(variants)) {
        const keys = Object.keys(variants as Record<string, unknown>);
        if (keys.length > 0) {
          entry.efforts = keys;
        }
      }
    }
    entries.push(entry);
  }

  return entries;
}

/**
 * Union the two discovery sources.
 *
 * Since T03 inverted the precedence this runs only on the `/api/model` fallback
 * path, where the CLI list is empty — so it is effectively the identity on the
 * API entries. It is kept because the union rule itself is still the contract:
 * a model missing from one source is a gap in that source, not evidence the
 * model is gone.
 *
 * The API entries come first, in their own order, then every CLI entry whose id
 * is not already present is appended. With an empty `apiEntries` the result is
 * exactly the CLI entries; with an empty `cliEntries` — the only case reached
 * today — it is exactly the API entries. Pure: neither input is mutated.
 */
export function mergeOpencodeModelSources(
  apiEntries: readonly ModelEntry[],
  cliEntries: readonly ModelEntry[],
): ModelEntry[] {
  const merged: ModelEntry[] = [...apiEntries];
  const seen = new Set(merged.map((entry) => entry.id));
  for (const entry of cliEntries) {
    if (seen.has(entry.id)) {
      continue;
    }
    seen.add(entry.id);
    merged.push(entry);
  }
  return merged;
}

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
 * 4. Model discovery's primary source is `opencode models --verbose`
 *    ({@link OPENCODE_MODELS_ARGS}), which discloses ids, each model's `name`
 *    label and its `variants` keys — exactly the values `--variant` accepts for
 *    that model. The opencode server's `/api/model` route, reached through a
 *    server named by `serverBaseUrl`/{@link OPENCODE_SERVER_ENV_VAR} or, failing
 *    that, one `opencode serve --hostname 127.0.0.1 --port 0` child whose
 *    ephemeral URL is read off its banner, is the IDS-ONLY fallback, used only
 *    when the CLI is unavailable, fails, times out or yields nothing (its
 *    `variants` is empty in this build). The two endpoints that do carry the
 *    variant map, `/provider` and `/config/providers`, are never requested
 *    because both return the configured provider API keys in clear text. Any
 *    failure — unparseable stdout, no server, a rejected or non-2xx request,
 *    malformed JSON, an unrecognised shape, a timeout, an abort — resolves
 *    `undefined`, which means "keep the last known-good list" (not "keep the
 *    curated list"), and a server this adapter started is disposed on every exit
 *    path. See {@link OpencodeAdapter.discoverModels}.
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

  /** Starts (or reuses) the server the `/api/model` request goes to. */
  private readonly startServer: OpencodeServerStarter;

  /** The `/api/model` transport; `undefined` when the runtime has no global `fetch`, which skips the API path. */
  private readonly fetchModels: FeedFetch | undefined;

  /** The `opencode models --verbose` runner: the primary discovery source. */
  private readonly runModelsCli: OpencodeModelsCli;

  /** A pre-existing server's base URL; when set nothing is spawned and nothing is killed. */
  private readonly serverBaseUrl: string | undefined;

  constructor(
    private readonly listSessions: ListSessionsFn = defaultListSessions,
    options: OpencodeAdapterOptions = {},
  ) {
    this.startServer = options.startServer ?? defaultStartOpencodeServer;
    this.fetchModels = options.fetchModels ?? (globalThis as { fetch?: FeedFetch }).fetch;
    this.runModelsCli = options.runModelsCli ?? defaultRunModelsCli;
    this.serverBaseUrl = options.serverBaseUrl;
  }

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

  /**
   * Discover opencode's model list, primarily from `opencode models --verbose`
   * and secondarily from the server's `/api/model` route.
   *
   * Contract, honoured exactly as `CodexAdapter.discoverModels` honours it: it
   * MUST never reject, and `undefined` means "keep the last known-good list" —
   * returning the curated `OPENCODE_MODELS`/`OPENCODE_EFFORTS` list here would
   * falsely mark it refreshed. `ctx.signal` and `ctx.timeoutMs` are both
   * honoured: an already-aborted refresh starts no process and makes no
   * request, an abort mid-flight resolves `undefined`, and the single
   * wall-clock budget now starts with the CLI run — a slow CLI can legitimately
   * leave no budget for the `/api/model` fallback, in which case the refresh
   * keeps the last known-good list.
   *
   * The primary path returns as soon as the verbose listing yields one entry, so
   * NO server is started and NO request is made at all; per-model labels come
   * from each model's `name` and per-model efforts from its `variants` keys.
   * `/api/model` runs only when the CLI is unavailable, fails, times out or
   * yields nothing, and contributes ids and labels only. The key-bearing
   * `/provider` and `/config/providers` endpoints — the only ones that also
   * carry the variant map — are NEVER requested: both return the configured
   * provider API keys in clear text.
   *
   * Every child process and socket is torn down: a server this adapter started
   * is disposed exactly once from a `finally`, a pre-existing server named by
   * `serverBaseUrl` or {@link OPENCODE_SERVER_ENV_VAR} is never killed, and
   * every timer is unref'd and cleared. No secret is read — the only
   * environment access is the {@link OPENCODE_SERVER_ENV_VAR} base-URL check —
   * so only ids, labels and variant names leave the host.
   *
   * Launch argv is untouched by discovery: a chosen effort is still `--variant
   * <effort>`, an empty effort emits no flag, and `--variant default` is never
   * emitted because opencode reserves `default` for "no variant". The result
   * deliberately carries NO `source`/`stale`/`staleReason`/`fetchedAt` —
   * provenance is stamped by `CatalogStore.applyResult` — and NO `modelLink`,
   * which `overlayCapabilities` re-attaches from the builtin.
   */
  async discoverModels(ctx: DiscoveryContext): Promise<AgentCapabilities | undefined> {
    try {
      // An aborted refresh must start no process and make no request.
      if (isAborted(ctx.signal)) {
        return undefined;
      }
      const timeoutMs = Math.min(
        ctx.timeoutMs > 0 ? ctx.timeoutMs : DEFAULT_DISCOVERY_TIMEOUT_MS,
        DEFAULT_DISCOVERY_TIMEOUT_MS,
      );
      const deadline = Date.now() + timeoutMs;
      const remaining = (): number => deadline - Date.now();

      // Primary: `opencode models --verbose`. No server, no request.
      let cliEntries: ModelEntry[] = [];
      if (remaining() > 0) {
        try {
          const stdout = await this.runModelsCli({ cwd: ctx.cwd, timeoutMs: remaining() });
          cliEntries = opencodeModelsFromVerboseOutput(stdout ?? '');
        } catch {
          // The seam is documented never to reject, but a rejecting injected
          // runner must still fall through to `/api/model` rather than end the
          // whole refresh.
          cliEntries = [];
        }
      }
      if (isAborted(ctx.signal)) {
        return undefined;
      }
      if (cliEntries.length > 0) {
        return capabilitiesFromEntries(cliEntries);
      }

      // Fallback: `/api/model`, ids and labels only.
      const apiEntries =
        !isAborted(ctx.signal) && remaining() > 0 ? await this.discoverFromApi(ctx, remaining) : [];
      const entries = mergeOpencodeModelSources(apiEntries, cliEntries);
      if (isAborted(ctx.signal) || entries.length === 0) {
        return undefined;
      }
      // The capability-level efforts are the ordered union of the entries' own
      // levels — empty on this path, which keeps free-text rendering.
      // Provenance and modelLink are deliberately absent, see the doc comment.
      return capabilitiesFromEntries(entries);
    } catch {
      return undefined;
    }
  }

  /**
   * The `/api/model` half of {@link discoverModels}: resolve a base URL
   * (injected, pre-existing or freshly started), GET the model route inside the
   * remaining budget and parse the payload. Any failure yields `[]` so the CLI
   * path becomes the fallback; only a server this call started is disposed.
   */
  private async discoverFromApi(
    ctx: DiscoveryContext,
    remaining: () => number,
  ): Promise<ModelEntry[]> {
    let server: OpencodeServer | undefined;
    try {
      const env = process.env[OPENCODE_SERVER_ENV_VAR];
      const preexisting =
        this.serverBaseUrl !== undefined && this.serverBaseUrl.length > 0
          ? this.serverBaseUrl
          : env !== undefined && env.length > 0 && env.startsWith('http')
            ? env
            : undefined;
      let baseUrl = preexisting;
      if (baseUrl === undefined && !isAborted(ctx.signal) && remaining() > 0) {
        server = await this.startServer({
          cwd: ctx.cwd,
          timeoutMs: remaining(),
          ...(ctx.log !== undefined ? { log: ctx.log } : {}),
        });
        baseUrl = server?.baseUrl;
      }

      const fetchModels = this.fetchModels;
      if (
        baseUrl === undefined ||
        fetchModels === undefined ||
        isAborted(ctx.signal) ||
        remaining() <= 0
      ) {
        return [];
      }

      const url = `${baseUrl}${OPENCODE_MODEL_ENDPOINT_PATH}`;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining());
      timer.unref?.();
      const onAbort = (): void => controller.abort();
      ctx.signal?.addEventListener('abort', onAbort);
      let text: string;
      try {
        const response: FeedResponse = await fetchModels(url, {
          signal: controller.signal,
          headers: { accept: 'application/json' },
        });
        if (!response.ok || response.status < 200 || response.status > 299) {
          ctx.log?.(`${OPENCODE_BIN} ${OPENCODE_MODEL_ENDPOINT_PATH} returned HTTP ${response.status}`);
          return [];
        }
        text = await response.text();
      } catch (e) {
        ctx.log?.(
          `${OPENCODE_BIN} ${OPENCODE_MODEL_ENDPOINT_PATH} request failed${e instanceof Error && e.message.length > 0 ? `: ${e.message}` : ''}`,
        );
        return [];
      } finally {
        clearTimeout(timer);
        ctx.signal?.removeEventListener('abort', onAbort);
      }

      try {
        return opencodeModelsFromApi(JSON.parse(text));
      } catch {
        ctx.log?.(`${OPENCODE_BIN} ${OPENCODE_MODEL_ENDPOINT_PATH} returned unparseable JSON`);
        return [];
      }
    } catch {
      return [];
    } finally {
      // Exactly once, and only for a server this call started.
      server?.dispose();
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

/** True when `signal` exists and has already been aborted. */
function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/**
 * The first `http(s)://…` URL in accumulated `opencode serve` output, with any
 * trailing `/` removed, or `undefined` when none appeared yet. This is how the
 * ephemeral port ({@link OPENCODE_SERVE_PORT}) is learned. Pure.
 */
export function parseOpencodeServerUrl(text: string): string | undefined {
  const match = /(https?:\/\/[^\s,)"']+)/.exec(text);
  if (match === null) {
    return undefined;
  }
  const url = match[1] ?? '';
  return url.endsWith('/') ? url.slice(0, -1) : url;
}

/**
 * Spawn `opencode serve --hostname 127.0.0.1 --port 0` and resolve a handle as
 * soon as its banner discloses the bound URL; the default
 * {@link OpencodeServerStarter}.
 *
 * Never rejects: a spawn error (ENOENT included), an exit before a URL appeared
 * and the wall-clock timeout each resolve `undefined`, which degrades discovery
 * to `undefined`, so the caller keeps the last known-good list. Exactly one
 * idempotent `settle` path
 * clears the timer, detaches the listeners and — on every non-success path —
 * kills the child, mirroring the `finish` helper in
 * `CodexAdapter.discoverModels`. The timer is unref'd so a stray timer can
 * never hold the host process open, and `dispose()` is safe to call twice.
 */
function defaultStartOpencodeServer(options: {
  cwd?: string;
  timeoutMs: number;
  log?: (m: string) => void;
}): Promise<OpencodeServer | undefined> {
  return new Promise<OpencodeServer | undefined>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(OPENCODE_BIN, [...OPENCODE_SERVE_ARGS], {
        cwd: options.cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch {
      resolve(undefined);
      return;
    }

    let buffer = '';
    let settled = false;

    const kill = (): void => {
      try {
        child.kill('SIGTERM');
      } catch {
        // Killing an already-dead child is best-effort and must never throw.
      }
    };

    const settle = (server?: OpencodeServer, reason?: string): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      child.stdout?.removeAllListeners('data');
      child.stderr?.removeAllListeners('data');
      child.removeAllListeners('error');
      child.removeAllListeners('exit');
      child.removeAllListeners('close');
      if (reason !== undefined) {
        options.log?.(reason);
      }
      if (server === undefined) {
        kill();
      }
      resolve(server);
    };

    const timer = setTimeout(() => {
      settle(
        undefined,
        `${OPENCODE_BIN} ${OPENCODE_SERVE_SUBCOMMAND} printed no URL within ${options.timeoutMs}ms`,
      );
    }, Math.max(0, options.timeoutMs));
    timer.unref?.();

    const onChunk = (chunk: Buffer | string): void => {
      buffer += String(chunk);
      const baseUrl = parseOpencodeServerUrl(buffer);
      if (baseUrl === undefined) {
        return;
      }
      let disposed = false;
      settle({
        baseUrl,
        dispose: (): void => {
          if (disposed) {
            return;
          }
          disposed = true;
          kill();
        },
      });
    };

    child.stdout?.on('data', onChunk);
    child.stderr?.on('data', onChunk);

    child.on('error', (error: unknown) => {
      const code =
        error !== null && typeof error === 'object' && 'code' in error
          ? (error as { code?: unknown }).code
          : undefined;
      settle(
        undefined,
        code === 'ENOENT'
          ? `${OPENCODE_BIN} was not found on PATH`
          : `${OPENCODE_BIN} ${OPENCODE_SERVE_SUBCOMMAND} spawn failed`,
      );
    });
    child.on('exit', (code: number | null) => {
      settle(
        undefined,
        `${OPENCODE_BIN} ${OPENCODE_SERVE_SUBCOMMAND} exited (code ${String(code)}) before printing a URL`,
      );
    });
    child.on('close', () => {
      settle(undefined, `${OPENCODE_BIN} ${OPENCODE_SERVE_SUBCOMMAND} closed before printing a URL`);
    });
  });
}

/**
 * Run `opencode models --verbose` ({@link OPENCODE_MODELS_ARGS}) in `cwd` and
 * resolve its stdout; the default {@link OpencodeModelsCli}. Resolves
 * `undefined` on any error — a missing binary, a non-zero exit (an older CLI
 * rejecting `--verbose` included), a timeout — and never rejects, matching the
 * never-throw contract of {@link OpencodeAdapter.discoverModels}. The
 * 16 MiB `maxBuffer` comfortably holds the ~50 KB verbose listing.
 */
function defaultRunModelsCli(options: {
  cwd?: string;
  timeoutMs: number;
}): Promise<string | undefined> {
  return new Promise<string | undefined>((resolve) => {
    execFile(
      OPENCODE_BIN,
      [...OPENCODE_MODELS_ARGS],
      {
        cwd: options.cwd,
        timeout: options.timeoutMs,
        windowsHide: true,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout) => {
        resolve(error ? undefined : stdout);
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
