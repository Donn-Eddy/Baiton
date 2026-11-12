/**
 * Config service: load, validate and migrate `.baiton/config.json` plus the
 * gitignored `.baiton/config.local.json` overlay
 * (Requirement 2, Requirement 23.5/23.6).
 *
 * The design signature is `loadConfig(baitonDir: vscode.Uri)`. To keep this
 * core unit-testable without a VS Code host, the function accepts a plain
 * directory path (a string, or any `{ fsPath }`/`{ path }` Uri-like value) and
 * uses Node's `fs` directly. Behaviour matches the design "Config service":
 *
 * - A newer `version` is refused and the required extension version reported
 *   (Req 2.5).
 * - The optional committed `config.json` baseline is read-only for the
 *   extension. The optional gitignored `config.local.json` overlay is deep-
 *   merged over it: local objects win key by key, while local arrays and
 *   scalars replace baseline values. The merged document is validated.
 * - An older `version` is migrated and persisted to the local file before
 *   loading (Req 2.6); a migration or persist failure refuses (Req 2.8).
 * - An absent, unparseable, or missing-section configuration is refused with
 *   the offending section named (Req 2.7); absent means neither layer exists.
 * - `version` absent or not equal to 1 (after any migration) is rejected as an
 *   unsupported version (Req 23.6); the returned `Config.version` is pinned to
 *   1 (Req 23.5).
 * - `limits` fields are range-checked: `plan_review_rounds` 0..10,
 *   `exec_attempts` 1..10, `stall_notice_minutes` 1..1440 (Req 2.3).
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { Result, ok, err, ROLES, Role } from '../model';
import {
  Config,
  ConfigError,
  GitConfig,
  Limits,
  LIMIT_BOUNDS,
  RoleConfig,
  SUPPORTED_VERSION,
} from './types';

/** The extension version a user needs to load a config newer than we support. */
const REQUIRED_EXTENSION_VERSION_HINT = 'a newer version of the Baiton extension';

/** A directory reference accepted by {@link loadConfig}. */
export type DirLike = string | { fsPath: string } | { path: string };

/**
 * Resolves a {@link DirLike} to a filesystem path. Accepts a plain string or a
 * `vscode.Uri`-like object exposing `fsPath` (preferred) or `path`.
 */
function toDir(baitonDir: DirLike): string {
  if (typeof baitonDir === 'string') {
    return baitonDir;
  }
  if ('fsPath' in baitonDir && typeof baitonDir.fsPath === 'string') {
    return baitonDir.fsPath;
  }
  if ('path' in baitonDir && typeof baitonDir.path === 'string') {
    return baitonDir.path;
  }
  throw new Error('loadConfig: baitonDir must be a string or a Uri-like object with fsPath/path.');
}

/**
 * The optional committed team baseline, read-only for the extension.
 */
export function configFilePath(baitonDir: DirLike): string {
  return path.join(toDir(baitonDir), 'config.json');
}

/**
 * The personal, gitignored overlay the extension writes.
 */
export function localConfigFilePath(baitonDir: DirLike): string {
  return path.join(toDir(baitonDir), 'config.local.json');
}

/**
 * Deep-merges the local overlay over the committed baseline: plain objects
 * merge key by key (recursively), arrays and scalars from `local` replace the
 * baseline's value. Neither input is mutated; keys present on only one side
 * are kept.
 */
export function mergeConfigLayers(
  baseline: Record<string, unknown>,
  local: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...baseline };
  for (const [key, value] of Object.entries(local)) {
    if (key === '__proto__') {
      continue;
    }
    const prev = out[key];
    out[key] = isObject(prev) && isObject(value) ? mergeConfigLayers(prev, value) : value;
  }
  return out;
}

/** Reads and parses one config layer. `undefined` means the file does not exist. */
async function readLayer(
  filePath: string,
): Promise<Result<Record<string, unknown> | undefined, ConfigError>> {
  let raw: string;
  try {
    raw = await fs.readFile(filePath, 'utf8');
  } catch (e) {
    if (isNotFound(e)) {
      return ok(undefined);
    }
    return err({
      kind: 'unparseable',
      path: filePath,
      message: `Could not read configuration at ${filePath}: ${describe(e)}.`,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return err({
      kind: 'unparseable',
      path: filePath,
      message: `Configuration at ${filePath} is not valid JSON: ${describe(e)}.`,
    });
  }

  if (!isObject(parsed)) {
    return err({
      kind: 'missing-section',
      section: 'root',
      message: `Configuration at ${filePath} must be a JSON object.`,
    });
  }
  return ok(parsed);
}

/**
 * Loads and validates the optional committed `<baitonDir>/config.json`
 * baseline plus optional gitignored `<baitonDir>/config.local.json` overlay.
 * The layers are deep-merged with local values winning (objects merge key by
 * key; arrays and scalars are replaced), then validated. An older version is
 * migrated and persisted to the local file only. Returns a validated
 * {@link Config} or a
 * {@link ConfigError} describing why loading was refused. Never throws for an
 * expected failure (missing/unparseable/invalid files); absent is returned
 * only when neither layer exists. Unexpected I/O errors surface as an
 * `unparseable` error.
 */
export async function loadConfig(
  baitonDir: DirLike,
): Promise<Result<Config, ConfigError>> {
  const baselinePath = configFilePath(baitonDir);
  const localPath = localConfigFilePath(baitonDir);
  const baseline = await readLayer(baselinePath);
  if (!baseline.ok) return baseline;
  const local = await readLayer(localPath);
  if (!local.ok) return local;
  if (baseline.value === undefined && local.value === undefined) {
    return err({
      kind: 'absent',
      path: localPath,
      message: `No configuration found at ${localPath} or ${baselinePath}. Run "Baiton: Initialize" first.`,
    });
  }
  const parsed = baseline.value === undefined
    ? local.value!
    : local.value === undefined
      ? baseline.value
      : mergeConfigLayers(baseline.value, local.value);
  const namedPath = local.value !== undefined ? localPath : baselinePath;

  // Version gate (Req 2.5, 2.6, 23.6).
  const versionResult = readVersion(parsed);
  if (!versionResult.ok) {
    return versionResult;
  }
  let doc = parsed;
  const version = versionResult.value;

  if (version > SUPPORTED_VERSION) {
    return err({
      kind: 'version-too-new',
      found: version,
      supported: SUPPORTED_VERSION,
      message:
        `Configuration at ${namedPath} declares version ${version}, but this ` +
        `build supports version ${SUPPORTED_VERSION}. Install ${REQUIRED_EXTENSION_VERSION_HINT} ` +
        `to load it.`,
    });
  }

  if (version < SUPPORTED_VERSION) {
    // Migrate an older config to the supported version and persist it before
    // loading (Req 2.6). On any failure, leave the original untouched (Req 2.8).
    const migrated = await migrateAndPersist(localPath, doc, version);
    if (!migrated.ok) {
      return migrated;
    }
    doc = migrated.value;
  }

  // Validate the required sections and shapes (Req 2.2, 2.4, 2.7, 2.3).
  const roles = readRoles(doc);
  if (!roles.ok) {
    return roles;
  }
  const limits = readLimits(doc);
  if (!limits.ok) {
    return limits;
  }
  const git = readGit(doc);
  if (!git.ok) {
    return git;
  }
  const pr = readPr(doc);
  if (!pr.ok) {
    return pr;
  }

  const config: Config = {
    version: SUPPORTED_VERSION, // pinned on read (Req 23.5)
    roles: roles.value,
    limits: limits.value,
    git: git.value,
    ...(pr.value !== undefined ? { pr: pr.value } : {}),
  };
  return ok(config);
}

/**
 * Reads and validates the `version` field. Refuses a `version` that is absent
 * or not a positive integer as an unsupported version (Req 23.6). Returns the
 * numeric version otherwise; the caller compares it against the supported one.
 */
function readVersion(doc: Record<string, unknown>): Result<number, ConfigError> {
  const v = doc.version;
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    return err({
      kind: 'invalid-version',
      message:
        `Configuration "version" must be a positive integer (this build supports ` +
        `${SUPPORTED_VERSION}); found ${JSON.stringify(v)}.`,
    });
  }
  return ok(v);
}

/**
 * Version-to-version migration steps, keyed by the source version. Each returns
 * the document bumped to the next version. Empty in the first pass because the
 * supported version is the minimum; a later schema change registers its
 * upgrade here.
 */
const MIGRATIONS: Record<number, (doc: Record<string, unknown>) => Record<string, unknown>> = {};

/**
 * Migrates an older configuration document and persists it to the target file
 * before it is loaded (Req 2.6). There is currently no pre-1 schema, so any
 * `version` below the supported version has no defined upgrade path; migration
 * therefore fails without changing the target file (Req 2.8).
 * @internal Exported for tests; production callers go through loadConfig.
 */
export async function migrateAndPersist(
  targetPath: string,
  doc: Record<string, unknown>,
  from: number,
  migrations: Record<number, (doc: Record<string, unknown>) => Record<string, unknown>> = MIGRATIONS,
): Promise<Result<Record<string, unknown>, ConfigError>> {
  let current = doc;
  let currentVersion = from;

  while (currentVersion < SUPPORTED_VERSION) {
    const step = migrations[currentVersion];
    if (!step) {
      return err({
        kind: 'migration-failed',
        from,
        message:
          `Configuration at ${targetPath} declares version ${from}, which this ` +
          `build cannot migrate to version ${SUPPORTED_VERSION}. The file was left unchanged.`,
      });
    }
    try {
      current = step(current);
      currentVersion = current.version as number;
    } catch (e) {
      return err({
        kind: 'migration-failed',
        from,
        message:
          `Migrating configuration at ${targetPath} from version ${from} failed: ` +
          `${describe(e)}. The file was left unchanged.`,
      });
    }
  }

  // Persist the migrated document before loading it (Req 2.6). A write failure
  // leaves any prior file untouched because the write is atomic-by-replace: we
  // only rename the temp file over the target once it is fully written.
  try {
    await fs.mkdir(path.dirname(targetPath), { recursive: true });
    await writeJsonAtomic(targetPath, current);
  } catch (e) {
    return err({
      kind: 'migration-failed',
      from,
      message:
        `Could not persist the migrated configuration at ${targetPath}: ` +
        `${describe(e)}. The file was left unchanged.`,
    });
  }

  return ok(current);
}

/**
 * Roles added after a `config.json` shape shipped, mapped to the role whose
 * entry stands in for a missing one. `plan-writer` is a read-only plan-draft
 * role like `planner`, so a config with neither entry still loads with the plan
 * writer inheriting the planner's agent, model and effort.
 */
const ROLE_FALLBACKS: Partial<Record<Role, Role>> = {
  'plan-writer': 'planner',
};

/**
 * Legacy: configs written before the phased-plan rename name the drafting role
 * `spec-writer`; map that key into the canonical role while loading.
 */
const LEGACY_ROLE_KEYS: Partial<Record<Role, string>> = {
  'plan-writer': 'spec-writer',
};

/** The entry a missing role inherits, or `undefined` when it has no fallback. */
function fallbackRoleEntry(role: Role, roles: Record<string, unknown>): unknown {
  const source = ROLE_FALLBACKS[role];
  return source === undefined ? undefined : roles[source];
}

/** The pre-rename config entry for a role, when that role has one. */
function legacyRoleEntry(role: Role, roles: Record<string, unknown>): unknown {
  const legacyKey = LEGACY_ROLE_KEYS[role];
  return legacyKey === undefined ? undefined : roles[legacyKey];
}

/**
 * Validates the `roles` mapping: an object assigning every {@link Role} an
 * `agent` and a `model` string, with an optional `effort` string (Req 2.2).
 * A role absent from the file is filled in from {@link ROLE_FALLBACKS} so a
 * config written before that role existed still loads.
 */
function readRoles(
  doc: Record<string, unknown>,
): Result<Record<Role, RoleConfig>, ConfigError> {
  const roles = doc.roles;
  if (!isObject(roles)) {
    return err(missingSection('roles', 'the "roles" section is missing or not an object'));
  }

  const out = {} as Record<Role, RoleConfig>;
  for (const role of ROLES) {
    const entry =
      roles[role] ?? legacyRoleEntry(role, roles) ?? fallbackRoleEntry(role, roles);
    if (!isObject(entry)) {
      return err(
        missingSection(`roles.${role}`, `the "${role}" role is missing or not an object`),
      );
    }
    if (typeof entry.agent !== 'string' || entry.agent.length === 0) {
      return err(
        missingSection(`roles.${role}.agent`, `the "${role}" role is missing a string "agent"`),
      );
    }
    if (typeof entry.model !== 'string' || entry.model.length === 0) {
      return err(
        missingSection(`roles.${role}.model`, `the "${role}" role is missing a string "model"`),
      );
    }
    if (entry.effort !== undefined && typeof entry.effort !== 'string') {
      return err(
        missingSection(
          `roles.${role}.effort`,
          `the "${role}" role "effort" must be a string when present`,
        ),
      );
    }
    out[role] = {
      agent: entry.agent,
      model: entry.model,
      ...(entry.effort !== undefined ? { effort: entry.effort } : {}),
    };
  }
  return ok(out);
}

/**
 * Validates the `limits` object: three integer fields, each within its closed
 * range (Req 2.3). A missing object, a non-integer field, or an out-of-range
 * value all surface as a located `missing-section` error naming the field.
 */
function readLimits(doc: Record<string, unknown>): Result<Limits, ConfigError> {
  const limits = doc.limits;
  if (!isObject(limits)) {
    return err(missingSection('limits', 'the "limits" section is missing or not an object'));
  }

  const fields = ['plan_review_rounds', 'exec_attempts', 'stall_notice_minutes'] as const;
  const out = {} as Limits;
  for (const field of fields) {
    const value = limits[field];
    const bounds = LIMIT_BOUNDS[field];
    if (typeof value !== 'number' || !Number.isInteger(value)) {
      return err(
        missingSection(`limits.${field}`, `"limits.${field}" must be an integer`),
      );
    }
    if (value < bounds.min || value > bounds.max) {
      return err(
        missingSection(
          `limits.${field}`,
          `"limits.${field}" must be between ${bounds.min} and ${bounds.max} (found ${value})`,
        ),
      );
    }
    out[field] = value;
  }
  return ok(out);
}

/**
 * Validates the `git` object: a string `remote`, a string `base`, and an
 * optional string `verify` (Req 2.4).
 */
function readGit(doc: Record<string, unknown>): Result<GitConfig, ConfigError> {
  const git = doc.git;
  if (!isObject(git)) {
    return err(missingSection('git', 'the "git" section is missing or not an object'));
  }
  if (typeof git.remote !== 'string' || git.remote.length === 0) {
    return err(missingSection('git.remote', 'the "git" section is missing a string "remote"'));
  }
  if (typeof git.base !== 'string' || git.base.length === 0) {
    return err(missingSection('git.base', 'the "git" section is missing a string "base"'));
  }
  if (git.verify !== undefined && typeof git.verify !== 'string') {
    return err(missingSection('git.verify', 'the "git" "verify" must be a string when present'));
  }
  return ok({
    remote: git.remote,
    base: git.base,
    ...(git.verify !== undefined ? { verify: git.verify } : {}),
  });
}

/**
 * Validates the optional `pr` seam: when present it must be an object with a
 * string `tool`. Absent is valid (the first pass does not use it).
 */
function readPr(
  doc: Record<string, unknown>,
): Result<{ tool: string } | undefined, ConfigError> {
  const pr = doc.pr;
  if (pr === undefined) {
    return ok(undefined);
  }
  if (!isObject(pr) || typeof pr.tool !== 'string') {
    return err(missingSection('pr', 'the "pr" section, when present, must have a string "tool"'));
  }
  return ok({ tool: pr.tool });
}

/** Builds a located `missing-section` error naming the offending section (Req 2.7). */
function missingSection(section: string, detail: string): ConfigError {
  return {
    kind: 'missing-section',
    section,
    message: `Invalid configuration: ${detail}.`,
  };
}

/** Whether a value is a non-null, non-array object. */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether an error is a Node "file not found" error. */
function isNotFound(e: unknown): boolean {
  return isObject(e) && (e as { code?: unknown }).code === 'ENOENT';
}

/** A short, safe description of a thrown value for error messages. */
function describe(e: unknown): string {
  if (e instanceof Error) {
    return e.message;
  }
  return String(e);
}

/**
 * Writes JSON to `filePath` by writing a sibling temp file and renaming it over
 * the target, so a partial write never leaves a corrupt or truncated config in
 * place (supports the "leave the original unchanged on failure" guarantee).
 * Serializes with `JSON.stringify(value, null, 2) + '\n'`, matching
 * {@link defaultConfigJson} exactly. Also the Config Panel's write path
 * (`src/config/configDocument.ts`); its signature and behaviour must not
 * change, since {@link migrateAndPersist} depends on both unchanged.
 */
export async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  const dir = path.dirname(filePath);
  const tmp = path.join(dir, `.config.json.${process.pid}.${Date.now()}.tmp`);
  const text = JSON.stringify(value, null, 2) + '\n';
  await fs.writeFile(tmp, text, 'utf8');
  try {
    await fs.rename(tmp, filePath);
  } catch (e) {
    // Best-effort cleanup of the temp file; surface the original rename error.
    await fs.rm(tmp, { force: true }).catch(() => undefined);
    throw e;
  }
}
