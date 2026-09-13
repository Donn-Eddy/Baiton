/**
 * Chat session storage (host-free core).
 *
 * A conversation scope — the Workspace_Conversation or one spec — holds any
 * number of independent chat *sessions*, each persisted as its own append-only
 * `<id>.jsonl` transcript:
 *
 * - workspace sessions at `.baiton/chat/<id>.jsonl`
 * - spec sessions at `.baiton/specs/<slug>/chat/<id>.jsonl`
 *
 * There is no index file: every piece of session metadata is derived from the
 * transcript itself, so the folder is the whole model and an externally deleted
 * or copied file behaves exactly as expected. The derived metadata is:
 *
 * - `title` — the first `user` record's content, whitespace-collapsed and
 *   truncated to {@link TITLE_MAX_CHARS} characters, falling back to
 *   {@link DEFAULT_TITLE} when the file has no user record (or is unreadable);
 * - `createdAt` — the first record's timestamp;
 * - `updatedAt` — the last record's timestamp;
 *
 * with the file's mtime standing in for either timestamp when the file is
 * empty, unreadable, or carries no parseable record.
 *
 * Persistence still begins at the first message: {@link SessionStore.create}
 * only allocates an id, and the file appears when {@link ChatTranscript} first
 * appends to it.
 *
 * This module is a pure filesystem seam — no `vscode` import — so it is unit
 * testable against temp directories.
 */
import { mkdir, readdir, readFile, rename, stat, unlink } from 'fs/promises';
import * as path from 'path';
import type { ConversationKind } from './systemPrompt';
import { Clock, systemClock } from './seams';

/**
 * Which conversation a session belongs to: the workspace conversation, or one
 * spec's conversation. Reuses the system prompt's conversation discriminator.
 */
export type SessionScope = ConversationKind;

/** The longest a derived session title may be, in characters. */
export const TITLE_MAX_CHARS = 60;

/** The title a session with no user message yet is listed under. */
export const DEFAULT_TITLE = 'New chat';

/** One session's derived metadata. */
export interface SessionMeta {
  /** The session id, which is also its file's basename. */
  id: string;
  /** The derived title (never empty, at most {@link TITLE_MAX_CHARS} chars). */
  title: string;
  /** ISO-8601 timestamp of the session's first record (or the file's mtime). */
  createdAt: string;
  /** ISO-8601 timestamp of the session's last record (or the file's mtime). */
  updatedAt: string;
}

/** The stable identifier of a scope, used as a settings/memory key. */
export function scopeId(scope: SessionScope): string {
  return scope.kind === 'workspace' ? 'workspace' : scope.slug;
}

/** Options the store needs to locate a scope's session folder. */
export interface SessionStoreOptions {
  /** Absolute `.baiton/` directory. */
  baitonDir: string;
  /** Absolute `.baiton/specs/` directory. */
  specsDir: string;
  /** Clock used to allocate session ids; injected for deterministic tests. */
  clock?: Clock;
  /** Random suffix source; injected for deterministic tests. */
  random?: () => number;
}

/**
 * Lists, creates, locates and deletes a scope's chat sessions, and migrates the
 * single legacy `chat.jsonl` transcript into the per-session layout.
 */
export class SessionStore {
  private readonly baitonDir: string;
  private readonly specsDir: string;
  private readonly clock: Clock;
  private readonly random: () => number;

  constructor(options: SessionStoreOptions) {
    this.baitonDir = options.baitonDir;
    this.specsDir = options.specsDir;
    this.clock = options.clock ?? systemClock;
    this.random = options.random ?? Math.random;
  }

  /** The folder holding a scope's session transcripts. */
  public dirFor(scope: SessionScope): string {
    return scope.kind === 'workspace'
      ? path.join(this.baitonDir, 'chat')
      : path.join(this.specsDir, scope.slug, 'chat');
  }

  /** The transcript file path of one session in a scope. */
  public pathFor(scope: SessionScope, id: string): string {
    return path.join(this.dirFor(scope), `${id}.jsonl`);
  }

  /** The pre-sessions transcript path this scope is migrated from. */
  public legacyPathFor(scope: SessionScope): string {
    return scope.kind === 'workspace'
      ? path.join(this.baitonDir, 'chat.jsonl')
      : path.join(this.specsDir, scope.slug, 'chat.jsonl');
  }

  /**
   * A scope's sessions, newest first (descending `updatedAt`, ties broken by
   * descending id so the order is total and stable). A missing folder lists as
   * no sessions.
   */
  public async list(scope: SessionScope): Promise<SessionMeta[]> {
    const dir = this.dirFor(scope);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      if (isNotFound(err)) {
        return [];
      }
      throw err;
    }
    const metas: SessionMeta[] = [];
    for (const name of names) {
      if (!name.endsWith('.jsonl')) {
        continue;
      }
      const id = name.slice(0, -'.jsonl'.length);
      if (id.length === 0) {
        continue;
      }
      metas.push(await this.metaFor(path.join(dir, name), id));
    }
    metas.sort((a, b) =>
      a.updatedAt === b.updatedAt
        ? b.id.localeCompare(a.id)
        : a.updatedAt < b.updatedAt
          ? 1
          : -1,
    );
    return metas;
  }

  /**
   * Allocate a new session id in a scope. The id is a timestamp plus a short
   * random suffix (`20260913-141501-a1b2`), which sorts lexicographically by
   * creation time and never collides in practice. No file is written: the
   * transcript appears on the session's first append (Req 9.9).
   */
  public create(_scope: SessionScope): string {
    const now = this.clock.now();
    const stamp = now.replace(/[-:]/g, '').replace(/\.\d+Z?$/, '').replace('T', '-').slice(0, 15);
    const alphabet = '0123456789abcdefghijklmnopqrstuvwxyz';
    let suffix = '';
    for (let i = 0; i < 4; i++) {
      const draw = this.random();
      const index = Number.isFinite(draw) ? Math.floor(Math.abs(draw) * alphabet.length) : 0;
      suffix += alphabet.charAt(index % alphabet.length);
    }
    return `${stamp}-${suffix}`;
  }

  /** Ensure a scope's session folder exists, so a first append can create the file. */
  public async ensureDir(scope: SessionScope): Promise<void> {
    await mkdir(this.dirFor(scope), { recursive: true });
  }

  /** Delete one session's transcript. A session with no file yet deletes cleanly. */
  public async delete(scope: SessionScope, id: string): Promise<void> {
    try {
      await unlink(this.pathFor(scope, id));
    } catch (err) {
      if (!isNotFound(err)) {
        throw err;
      }
    }
  }

  /** Read one session's derived metadata, or `undefined` when it has no file. */
  public async meta(scope: SessionScope, id: string): Promise<SessionMeta | undefined> {
    const file = this.pathFor(scope, id);
    try {
      await stat(file);
    } catch (err) {
      if (isNotFound(err)) {
        return undefined;
      }
      throw err;
    }
    return this.metaFor(file, id);
  }

  /**
   * Migrate a scope's legacy single `chat.jsonl` into the session folder,
   * idempotently: a non-empty legacy file is renamed to a session named after
   * its first record's timestamp; an empty one is removed; a missing one is a
   * no-op. Returns the new session id when one was created.
   */
  public async migrateLegacy(scope: SessionScope): Promise<string | undefined> {
    const legacy = this.legacyPathFor(scope);
    let text: string;
    try {
      text = await readFile(legacy, 'utf8');
    } catch (err) {
      if (isNotFound(err)) {
        return undefined;
      }
      throw err;
    }
    if (text.trim().length === 0) {
      // An empty legacy transcript carries nothing worth keeping.
      await unlink(legacy).catch(() => undefined);
      return undefined;
    }
    const id = legacyIdFrom(text) ?? this.create(scope);
    await this.ensureDir(scope);
    await rename(legacy, this.pathFor(scope, id));
    return id;
  }

  /** Derive one session's metadata from its transcript file. */
  private async metaFor(file: string, id: string): Promise<SessionMeta> {
    let text = '';
    try {
      text = await readFile(file, 'utf8');
    } catch {
      text = '';
    }
    const records = parseLightRecords(text);
    let mtime: string | undefined;
    if (records.length === 0) {
      mtime = await mtimeIso(file);
    }
    const fallback = mtime ?? this.clock.now();
    const first = records[0];
    const last = records[records.length - 1];
    return {
      id,
      title: deriveTitle(records),
      createdAt: first?.ts ?? fallback,
      updatedAt: last?.ts ?? fallback,
    };
  }
}

/** One transcript line, reduced to the fields session metadata is derived from. */
interface LightRecord {
  ts: string;
  role: string;
  content: string;
}

/**
 * The title derived from a transcript's records: the first `user` record's
 * content, whitespace-collapsed and truncated to {@link TITLE_MAX_CHARS}
 * (the last character becoming an ellipsis when it is cut). Falls back to
 * {@link DEFAULT_TITLE} when there is no user record with visible text.
 */
export function deriveTitle(records: readonly { role: string; content: string }[]): string {
  for (const record of records) {
    if (record.role !== 'user') {
      continue;
    }
    const flat = record.content.replace(/\s+/g, ' ').trim();
    if (flat.length === 0) {
      continue;
    }
    return flat.length > TITLE_MAX_CHARS
      ? `${flat.slice(0, TITLE_MAX_CHARS - 1)}…`
      : flat;
  }
  return DEFAULT_TITLE;
}

/** Parse a transcript's lines, skipping any that is not a usable record. */
function parseLightRecords(text: string): LightRecord[] {
  const out: LightRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.trim() === '') {
      continue;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof value !== 'object' || value === null) {
      continue;
    }
    const rec = value as Record<string, unknown>;
    if (typeof rec.ts !== 'string' || typeof rec.role !== 'string') {
      continue;
    }
    out.push({
      ts: rec.ts,
      role: rec.role,
      content: typeof rec.content === 'string' ? rec.content : '',
    });
  }
  return out;
}

/** A session id derived from a legacy transcript's first record timestamp. */
function legacyIdFrom(text: string): string | undefined {
  const records = parseLightRecords(text);
  const ts = records[0]?.ts;
  if (ts === undefined) {
    return undefined;
  }
  const stamp = ts.replace(/[-:]/g, '').replace(/\.\d+Z?$/, '').replace('T', '-').slice(0, 15);
  if (stamp.length === 0) {
    return undefined;
  }
  return `${stamp}-legacy`;
}

/** A file's mtime as an ISO-8601 string, or `undefined` when it cannot be read. */
async function mtimeIso(file: string): Promise<string | undefined> {
  try {
    const info = await stat(file);
    return new Date(info.mtimeMs).toISOString();
  } catch {
    return undefined;
  }
}

/** Whether a caught filesystem error is a "file does not exist" error. */
function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'ENOENT'
  );
}
