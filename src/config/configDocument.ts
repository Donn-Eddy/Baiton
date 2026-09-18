/**
 * Config Panel document I/O — spec "Config Panel" (config-panel).
 *
 * The panel reads the raw `.baiton/config.json` document itself — rather than
 * going through {@link loadConfig} — so unknown keys and the exact on-disk
 * text survive a round trip. Writes are guarded by a content-hash "token":
 * the caller passes back the token it loaded with, and a write is refused if
 * the file changed on disk since. This narrows, but does not close, the
 * window between reading the token and the atomic rename; a file watcher
 * (T07) is the other half of the story.
 */
import * as fs from 'fs/promises';
import { createHash } from 'crypto';
import { Result, ok, err } from '../model';
import { DirLike, configFilePath, writeJsonAtomic } from './loadConfig';

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
 * spec-content digests and has no business knowing about config files.
 */
export function configToken(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The raw config document as loaded: exact text, parsed object, and token. */
export interface ConfigDocument {
  path: string;
  text: string;
  doc: Record<string, unknown>;
  token: string;
}

/**
 * A failure reading or writing a {@link ConfigDocument}. Deliberately a
 * separate union from `ConfigError`: `absent`/`unparseable` mirror the
 * loader's classification (and reuse its message wording so the panel's error
 * state reads like the rest of the extension), while `conflict`/`io` are
 * write-side outcomes that have no loader equivalent. The `conflict` error
 * carries the current on-disk `token` so the webview's Reload action can
 * adopt it without a second read.
 */
export type ConfigDocumentError =
  | { kind: 'absent'; path: string; message: string }
  | { kind: 'unparseable'; path: string; message: string }
  | { kind: 'conflict'; path: string; token: string; message: string }
  | { kind: 'io'; path: string; message: string };

/**
 * Reads and parses `<baitonDir>/config.json`, returning the exact file text,
 * the parsed object, and a {@link configToken} for it. Never throws for an
 * expected failure — same contract as {@link loadConfig}. A missing file is
 * `absent`; malformed JSON or a parsed non-object is `unparseable`; any other
 * read failure is `io`.
 */
export async function readConfigDocument(
  baitonDir: DirLike,
): Promise<Result<ConfigDocument, ConfigDocumentError>> {
  const p = configFilePath(baitonDir);

  let text: string;
  try {
    text = await fs.readFile(p, 'utf8');
  } catch (e) {
    if (isNotFound(e)) {
      return err({
        kind: 'absent',
        path: p,
        message: `No configuration found at ${p}. Run "Baiton: Initialize" first.`,
      });
    }
    return err({ kind: 'io', path: p, message: `Could not read configuration at ${p}: ${describe(e)}.` });
  }

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

  return ok({ path: p, text, doc: parsed, token: configToken(text) });
}

/**
 * Reads just the text of `<baitonDir>/config.json` and returns its
 * {@link configToken}, or {@link ABSENT_TOKEN} when the file does not exist.
 * The primitive the write path and (later) the file watcher use, so neither
 * has to parse to learn whether the file moved under it.
 */
export async function readConfigToken(
  baitonDir: DirLike,
): Promise<Result<string, ConfigDocumentError>> {
  const p = configFilePath(baitonDir);
  let text: string;
  try {
    text = await fs.readFile(p, 'utf8');
  } catch (e) {
    if (isNotFound(e)) {
      return ok(ABSENT_TOKEN);
    }
    return err({ kind: 'io', path: p, message: `Could not read configuration at ${p}: ${describe(e)}.` });
  }
  return ok(configToken(text));
}

/** Options for {@link writeConfigDocument}. */
export interface WriteConfigOptions {
  /**
   * The token the caller last loaded. When present, the write is refused with
   * a `conflict` error unless the file's current token still matches. When
   * omitted, the write proceeds unconditionally (the Overwrite and
   * Reset-to-defaults path).
   */
  expectedToken?: string;
}

/**
 * Writes `value` to `<baitonDir>/config.json` atomically, optionally guarded
 * by {@link WriteConfigOptions.expectedToken}. When the token is stale,
 * nothing is written and the file is left byte-for-byte unchanged. On
 * success, recomputes the text exactly as {@link writeJsonAtomic} wrote it —
 * `JSON.stringify(value, null, 2) + '\n'` — so the caller gets the post-write
 * token without re-reading the file. The serialization is duplicated with
 * `writeJsonAtomic` on purpose, to avoid widening that function's return
 * type; a test pins the two together (T03).
 *
 * The token check narrows, not closes, the window between reading the token
 * and the atomic rename (TOCTOU); this is accepted, not solved, here.
 */
export async function writeConfigDocument(
  baitonDir: DirLike,
  value: unknown,
  options?: WriteConfigOptions,
): Promise<Result<ConfigDocument, ConfigDocumentError>> {
  const p = configFilePath(baitonDir);

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
