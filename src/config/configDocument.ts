/**
 * Config Panel document I/O.
 *
 * The panel reads the committed `.baiton/config.json` baseline and the
 * gitignored `.baiton/config.local.json` overlay, shows their merged result,
 * and only ever writes the local file. A content-hash token guards the local
 * file. The watcher also checks the baseline token so baseline changes reach
 * the panel.
 */
import * as fs from 'fs/promises';
import { createHash } from 'crypto';
import { Result, ok, err } from '../model';
import {
  DirLike,
  configFilePath,
  localConfigFilePath,
  mergeConfigLayers,
  writeJsonAtomic,
} from './loadConfig';

/**
 * The conflict token of a file that does not exist. Using this as
 * {@link WriteConfigOptions.expectedToken} lets a save after Reset-to-defaults
 * use the same token check as any other save ("I expect no file to be
 * there").
 */
export const ABSENT_TOKEN = '';

/**
 * Hex-encoded SHA-256 digest of `text`, the conflict token for a config
 * document. Computed over the raw file text (not the parsed object), so a
 * whitespace-only external edit still counts as a conflict. A local helper
 * rather than an export added to `src/model/hash.ts`, which is about
 * plan-content digests and has no business knowing about config files.
 */
export function configToken(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The effective config document as loaded. `path` is always the local file;
 * `text` is its exact text (empty when only the baseline exists); `doc` is the
 * merged effective document; and `token` is the local text's configToken or
 * ABSENT_TOKEN when the local file is absent.
 */
export interface ConfigDocument {
  path: string;
  text: string;
  doc: Record<string, unknown>;
  token: string;
  /**
   * configToken of the committed `.baiton/config.json` baseline at read time,
   * ABSENT_TOKEN when it does not exist; set by readConfigDocument only
   * (writeConfigDocument never reads or writes the baseline).
   */
  baselineToken?: string;
}

/**
 * A failure reading or writing a {@link ConfigDocument}. Deliberately a
 * separate union from `ConfigError`: `absent`/`unparseable` mirror the
 * loader's classification (and reuse its message wording so the panel's error
 * state reads like the rest of the extension), while `conflict`/`io` are
 * write-side outcomes that have no loader equivalent. The `conflict` error
 * carries the current on-disk local token so the webview's Reload action can
 * adopt it without a second read.
 */
export type ConfigDocumentError =
  | { kind: 'absent'; path: string; message: string }
  | { kind: 'unparseable'; path: string; message: string }
  | { kind: 'conflict'; path: string; token: string; message: string }
  | { kind: 'io'; path: string; message: string };

/**
 * Reads the committed baseline and local overlay, returning the exact local
 * file text and the merged effective document. Never throws for an expected
 * failure. A missing layer is allowed; the result is `absent` only when both
 * files are missing. Malformed JSON or a parsed non-object is `unparseable`
 * and names the exact file that failed; any other read failure is `io`.
 */
export async function readConfigDocument(
  baitonDir: DirLike,
): Promise<Result<ConfigDocument, ConfigDocumentError>> {
  const localPath = localConfigFilePath(baitonDir);
  const baselinePath = configFilePath(baitonDir);

  const baselineTextResult = await readLayerText(baselinePath);
  if (!baselineTextResult.ok) {
    return baselineTextResult;
  }
  const localTextResult = await readLayerText(localPath);
  if (!localTextResult.ok) {
    return localTextResult;
  }
  const baselineText = baselineTextResult.value;
  const localText = localTextResult.value;

  if (baselineText === undefined && localText === undefined) {
    return err({
      kind: 'absent',
      path: localPath,
      message: `No configuration found at ${localPath} or ${baselinePath}. Run "Baiton: Initialize" first.`,
    });
  }

  let baseline: Record<string, unknown> | undefined;
  if (baselineText !== undefined) {
    const parsedBaseline = parseLayer(baselinePath, baselineText);
    if (!parsedBaseline.ok) {
      return parsedBaseline;
    }
    baseline = parsedBaseline.value;
  }

  let local: Record<string, unknown> | undefined;
  if (localText !== undefined) {
    const parsedLocal = parseLayer(localPath, localText);
    if (!parsedLocal.ok) {
      return parsedLocal;
    }
    local = parsedLocal.value;
  }

  const doc = baseline === undefined
    ? local!
    : local === undefined
      ? baseline
      : mergeConfigLayers(baseline, local);

  return ok({
    path: localPath,
    text: localText ?? '',
    doc,
    token: localText === undefined ? ABSENT_TOKEN : configToken(localText),
    baselineToken: baselineText === undefined ? ABSENT_TOKEN : configToken(baselineText),
  });
}

/**
 * Reads just `<baitonDir>/config.local.json` and returns its
 * {@link configToken}, or {@link ABSENT_TOKEN} when the local file does not
 * exist. `<baitonDir>/config.json` is never read here; the token guards the
 * file this panel writes.
 */
export async function readConfigToken(
  baitonDir: DirLike,
): Promise<Result<string, ConfigDocumentError>> {
  return readTokenAt(localConfigFilePath(baitonDir));
}

/** Reads the token of the committed `<baitonDir>/config.json` baseline. */
export async function readBaselineToken(
  baitonDir: DirLike,
): Promise<Result<string, ConfigDocumentError>> {
  return readTokenAt(configFilePath(baitonDir));
}

/** Options for {@link writeConfigDocument}. */
export interface WriteConfigOptions {
  /**
   * The local-file token the caller last loaded. When present, the write is
   * refused with a `conflict` error unless the current local token still
   * matches. When omitted, the write proceeds unconditionally (the Overwrite
   * and Reset-to-defaults path).
   */
  expectedToken?: string;
}

/**
 * Writes `value` to `<baitonDir>/config.local.json` atomically, optionally
 * guarded by {@link WriteConfigOptions.expectedToken}. It never reads or
 * writes `<baitonDir>/config.json`. When the token is stale, nothing is
 * written and the local file is left byte-for-byte unchanged. On success,
 * recomputes the text exactly as {@link writeJsonAtomic} wrote it —
 * `JSON.stringify(value, null, 2) + '\n'` — so the caller gets the post-write
 * token without re-reading the file.
 *
 * The token check narrows, not closes, the window between reading the token
 * and the atomic rename (TOCTOU); this is accepted, not solved, here.
 */
export async function writeConfigDocument(
  baitonDir: DirLike,
  value: unknown,
  options?: WriteConfigOptions,
): Promise<Result<ConfigDocument, ConfigDocumentError>> {
  const p = localConfigFilePath(baitonDir);

  if (options?.expectedToken !== undefined) {
    const currentResult = await readConfigToken(baitonDir);
    if (!currentResult.ok) {
      return currentResult;
    }
    const current = currentResult.value;
    if (current !== options.expectedToken) {
      return err({
        kind: 'conflict',
        path: p,
        token: current,
        message: `${p} changed on disk since it was loaded. Reload to pick up the new contents, or overwrite to save your edits anyway.`,
      });
    }
  }

  try {
    await writeJsonAtomic(p, value);
  } catch (e) {
    return err({ kind: 'io', path: p, message: `Could not write configuration at ${p}: ${describe(e)}.` });
  }

  const text = `${JSON.stringify(value, null, 2)}\n`;
  return ok({ path: p, text, doc: JSON.parse(text) as Record<string, unknown>, token: configToken(text) });
}

/** Reads one layer's exact text, allowing a missing file. */
async function readLayerText(
  p: string,
): Promise<Result<string | undefined, ConfigDocumentError>> {
  try {
    return ok(await fs.readFile(p, 'utf8'));
  } catch (e) {
    if (isNotFound(e)) {
      return ok(undefined);
    }
    return err({ kind: 'io', path: p, message: `Could not read configuration at ${p}: ${describe(e)}.` });
  }
}

/** Parses a layer and attributes any shape or syntax error to its own path. */
function parseLayer(
  p: string,
  text: string,
): Result<Record<string, unknown>, ConfigDocumentError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return err({
      kind: 'unparseable',
      path: p,
      message: `Configuration at ${p} is not valid JSON: ${describe(e)}.`,
    });
  }

  if (!isObject(parsed)) {
    return err({
      kind: 'unparseable',
      path: p,
      message: `Configuration at ${p} must be a JSON object.`,
    });
  }

  return ok(parsed);
}

/** Reads and hashes one file, returning ABSENT_TOKEN for ENOENT. */
async function readTokenAt(p: string): Promise<Result<string, ConfigDocumentError>> {
  try {
    return ok(configToken(await fs.readFile(p, 'utf8')));
  } catch (e) {
    if (isNotFound(e)) {
      return ok(ABSENT_TOKEN);
    }
    return err({ kind: 'io', path: p, message: `Could not read configuration at ${p}: ${describe(e)}.` });
  }
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
