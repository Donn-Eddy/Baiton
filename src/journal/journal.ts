/**
 * Append-only read/write for the run journal `runs.jsonl` (Requirements 21.1,
 * 21.2; design "Run journal entry").
 *
 * The file is newline-delimited JSON. A stage appends one START record when it
 * begins ({@link appendStart}, Req 21.1) and later one COMPLETION record when
 * it finishes ({@link appendCompletion}, Req 21.2). Nothing is ever rewritten
 * in place. {@link parseJournal} reads the whole file back and merges the two
 * records for each run id into a single {@link JournalEntry}.
 *
 * All I/O is injectable for testing: every function takes the journal file
 * path and uses node `fs` directly, so a test can point it at a temp file.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
} from 'fs';
import { dirname, join } from 'path';
import { resolveDocument, phaseArtifactDir } from '../storage/documentLocation';
import {
  CompletionRecord,
  JournalEntry,
  JournalRecord,
  PrCompletion,
  RunResultKind,
  StartRecord,
} from './entry';
import { Stage, toStage } from '../model/stage';
import { PhaseState, isPhaseState } from '../model/phaseState';

/** File name of every run journal (document-level and per-phase). */
export const JOURNAL_FILE = 'runs.jsonl';

/** Plan-level journal: plan-draft, PR and legacy phase entries. */
export function planJournalPathFor(baitonDir: string, slug: string): string {
  return join(resolveDocument(baitonDir, slug).dir, JOURNAL_FILE);
}

/** Per-phase journal in `phases/<id>/` (Legacy documents use `todos/<id>/`). */
export function phaseJournalPathFor(
  baitonDir: string,
  slug: string,
  phaseId: string,
): string {
  return join(phaseArtifactDir(resolveDocument(baitonDir, slug), phaseId), JOURNAL_FILE);
}

/**
 * Every journal file of a plan: its document-level path first (always
 * included; parsing tolerates a missing file), then each existing per-phase
 * journal in sorted phase-id order.
 */
export function planJournalPaths(baitonDir: string, slug: string): string[] {
  const location = resolveDocument(baitonDir, slug);
  const paths = [planJournalPathFor(baitonDir, slug)];
  let ids: string[] = [];
  try {
    ids = readdirSync(location.artifactsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    // No artifacts directory (or unreadable): only the document-level journal.
  }
  for (const id of ids) {
    const p = phaseJournalPathFor(baitonDir, slug, id);
    if (existsSync(p)) {
      paths.push(p);
    }
  }
  return paths;
}

/** The start metadata a caller supplies when a stage begins (Req 21.1). */
export interface StartInput {
  runId: string;
  phaseId: string;
  stage: Stage;
  attempt: number;
  startHead: string;
  inputRev: string;
  terminalPid?: number;
  /** Transition.from at launch (Req 1.2); omitted from the line when undefined. */
  fromState?: PhaseState;
  /** The Claude `--session-id` UUID (Req 1.2); omitted from the line when undefined. */
  sessionId?: string;
}

/** The completion metadata a caller supplies when a stage finishes (Req 21.2). */
export interface CompletionInput {
  runId: string;
  result: RunResultKind;
  commit?: string;
  /** PR-run only; unused in the first pass. */
  pr?: PrCompletion;
  /**
   * The session id the CLI minted for this run, recovered by the adapter after
   * the run settled (Req 3.2); omitted from the line when undefined.
   */
  discoveredSessionId?: string;
}

/**
 * Appends a START record to the journal at `path` (Req 21.1). Creates the file
 * if it does not yet exist. Only the provided fields are written; `terminalPid`
 * is omitted from the line when undefined.
 */
export function appendStart(path: string, input: StartInput): void {
  const record: StartRecord = {
    type: 'start',
    runId: input.runId,
    // Legacy wire key retained so existing journal lines remain unchanged.
    // Legacy wire key: preserve the field name already stored in run journals.
    todoId: input.phaseId,
    stage: input.stage,
    attempt: input.attempt,
    startHead: input.startHead,
    inputRev: input.inputRev,
    ...(input.terminalPid !== undefined
      ? { terminalPid: input.terminalPid }
      : {}),
    ...(input.fromState !== undefined ? { fromState: input.fromState } : {}),
    ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
  };
  appendRecord(path, record);
}

/**
 * Appends a COMPLETION record to the journal at `path` (Req 21.2). The record
 * is keyed to its run by `runId`; `commit` and `pr` are omitted when undefined.
 */
export function appendCompletion(path: string, input: CompletionInput): void {
  const record: CompletionRecord = {
    type: 'completion',
    runId: input.runId,
    result: input.result,
    ...(input.commit !== undefined ? { commit: input.commit } : {}),
    ...(input.pr !== undefined ? { pr: input.pr } : {}),
    ...(input.discoveredSessionId !== undefined
      ? { discoveredSessionId: input.discoveredSessionId }
      : {}),
  };
  appendRecord(path, record);
}

/**
 * Reads `runs.jsonl` at `path` and reconstructs one {@link JournalEntry} per
 * run id, merging each run's START and COMPLETION records (Req 21.1, 21.2).
 *
 * Behavior:
 * - A missing file yields an empty list.
 * - Blank lines and lines that are not valid, recognizable records are skipped
 *   (the journal never throws on a partially written last line, which a crash
 *   can leave behind).
 * - Entries are returned in the order their START record first appears; a
 *   completion record without a preceding start is ignored.
 */
export function parseJournal(path: string): JournalEntry[] {
  if (!existsSync(path)) {
    return [];
  }
  const byRunId = new Map<string, JournalEntry>();
  const order: string[] = [];
  mergeRecords(readFileSync(path, 'utf8'), byRunId, order);
  return order.map((runId) => byRunId.get(runId) as JournalEntry);
}

/**
 * Reads a plan's merged journal: the document-level `runs.jsonl` followed by
 * every phase journal (see {@link planJournalPaths}), merged through one
 * shared run-id map so a completion in a later file still attaches to a start
 * recorded in an earlier one.
 *
 * Ordering: the document-level file first, then per-phase files in sorted id
 * order. Legacy document-level entries for a phase therefore precede that
 * phase's artifact-folder entries; cross-phase interleaving is NOT
 * preserved, so callers must not rely on global order. Unreadable files are
 * skipped.
 */
export function readPlanJournal(baitonDir: string, slug: string): JournalEntry[] {
  const byRunId = new Map<string, JournalEntry>();
  const order: string[] = [];
  for (const file of planJournalPaths(baitonDir, slug)) {
    try {
      if (existsSync(file)) {
        mergeRecords(readFileSync(file, 'utf8'), byRunId, order);
      }
    } catch {
      // Unreadable journal file: skip it.
    }
  }
  return order.map((runId) => byRunId.get(runId) as JournalEntry);
}

/** Merges each recognizable line of `raw` into `byRunId`/`order`. */
function mergeRecords(
  raw: string,
  byRunId: Map<string, JournalEntry>,
  order: string[],
): void {
  for (const line of raw.split('\n')) {
    const record = parseRecord(line);
    if (record === undefined) {
      continue;
    }
    if (record.type === 'start') {
      if (!byRunId.has(record.runId)) {
        order.push(record.runId);
      }
      byRunId.set(record.runId, startToEntry(record));
    } else {
      const existing = byRunId.get(record.runId);
      if (existing === undefined) {
        // Completion with no start: nothing to attach it to.
        continue;
      }
      applyCompletion(existing, record);
    }
  }
}

/**
 * Returns the last start entry recorded for `phaseId` (optionally restricted to
 * one `stage`), or `undefined` if none. Operates on already-parsed entries
 * (Req 1.2, 3.1); callers read the journal once with {@link parseJournal} and
 * pass the result in rather than this function reading the file itself.
 */
export function latestStart(
  entries: JournalEntry[],
  phaseId: string,
  stage?: Stage,
): JournalEntry | undefined {
  let latest: JournalEntry | undefined;
  for (const entry of entries) {
    if (
      entry.phaseId === phaseId &&
      (stage === undefined || entry.stage === stage)
    ) {
      latest = entry;
    }
  }
  return latest;
}

/**
 * The session id that can actually be resumed for a journal entry (Req 3.2).
 *
 * A CLI that minted its own id has it recorded as `discoveredSessionId` and
 * that id is always the right one to resume. Baiton's pre-assigned `sessionId`
 * is resumable only for a CLI that honoured it on launch — the caller passes
 * its adapter's `acceptsSessionId`. Everything else yields `undefined`, which
 * means "launch fresh"/"nothing to attach to" rather than resuming with an id
 * the CLI never knew.
 */
export function resumableSessionId(
  entry: JournalEntry | undefined,
  acceptsSessionId: boolean,
): string | undefined {
  if (entry === undefined) {
    return undefined;
  }
  if (entry.discoveredSessionId !== undefined && entry.discoveredSessionId.length > 0) {
    return entry.discoveredSessionId;
  }
  return acceptsSessionId ? entry.sessionId : undefined;
}

/** Serializes a record as a single JSON line and appends it to the file. */
function appendRecord(path: string, record: JournalRecord): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(record) + '\n', 'utf8');
}

/** Builds the initial entry from a start record's fields. */
function startToEntry(record: StartRecord): JournalEntry {
  const entry: JournalEntry = {
    runId: record.runId,
    // Legacy wire key: expose this wire field in memory as phaseId.
    // Legacy wire key: the serialized phase id remains under `todoId`.
    phaseId: record.todoId,
    stage: record.stage,
    attempt: record.attempt,
    startHead: record.startHead,
    inputRev: record.inputRev,
  };
  if (record.terminalPid !== undefined) {
    entry.terminalPid = record.terminalPid;
  }
  if (record.fromState !== undefined) {
    entry.fromState = record.fromState;
  }
  if (record.sessionId !== undefined) {
    entry.sessionId = record.sessionId;
  }
  return entry;
}

/** Merges a completion record's fields into an existing entry in place. */
function applyCompletion(entry: JournalEntry, record: CompletionRecord): void {
  entry.result = record.result;
  if (record.commit !== undefined) {
    entry.commit = record.commit;
  }
  if (record.pr !== undefined) {
    entry.pr = record.pr;
  }
  if (record.discoveredSessionId !== undefined) {
    entry.discoveredSessionId = record.discoveredSessionId;
  }
}

/**
 * Parses one line into a {@link JournalRecord}, or `undefined` when the line is
 * blank, not valid JSON, or does not have the required fields for a known
 * record type. Never throws.
 */
function parseRecord(line: string): JournalRecord | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.type === 'start') {
    return toStartRecord(obj);
  }
  if (obj.type === 'completion') {
    return toCompletionRecord(obj);
  }
  return undefined;
}

/** Validates and narrows a raw object to a StartRecord, or undefined. */
function toStartRecord(obj: Record<string, unknown>): StartRecord | undefined {
  const stage = typeof obj.stage === 'string' ? toStage(obj.stage) : undefined;
  if (
    typeof obj.runId !== 'string' ||
    // Legacy wire key: existing journal START records carry this field name.
    // Legacy wire key: parse the id field used by existing start records.
    typeof obj.todoId !== 'string' ||
    stage === undefined ||
    typeof obj.attempt !== 'number' ||
    typeof obj.startHead !== 'string' ||
    typeof obj.inputRev !== 'string'
  ) {
    return undefined;
  }
  const record: StartRecord = {
    type: 'start',
    runId: obj.runId,
    // Legacy wire key: existing journals serialize their phase id as `todoId`.
    todoId: obj.todoId,
    stage,
    attempt: obj.attempt,
    startHead: obj.startHead,
    inputRev: obj.inputRev,
  };
  if (typeof obj.terminalPid === 'number') {
    record.terminalPid = obj.terminalPid;
  }
  if (typeof obj.fromState === 'string' && isPhaseState(obj.fromState)) {
    record.fromState = obj.fromState;
  }
  if (typeof obj.sessionId === 'string') {
    record.sessionId = obj.sessionId;
  }
  return record;
}

/** Validates and narrows a raw object to a CompletionRecord, or undefined. */
function toCompletionRecord(
  obj: Record<string, unknown>,
): CompletionRecord | undefined {
  if (typeof obj.runId !== 'string' || !isRunResultKind(obj.result)) {
    return undefined;
  }
  const record: CompletionRecord = {
    type: 'completion',
    runId: obj.runId,
    result: obj.result,
  };
  if (typeof obj.commit === 'string') {
    record.commit = obj.commit;
  }
  const pr = toPrCompletion(obj.pr);
  if (pr !== undefined) {
    record.pr = pr;
  }
  if (typeof obj.discoveredSessionId === 'string') {
    record.discoveredSessionId = obj.discoveredSessionId;
  }
  return record;
}

/** Validates and narrows a raw value to a PrCompletion, or undefined. */
function toPrCompletion(value: unknown): PrCompletion | undefined {
  if (typeof value !== 'object' || value === null) {
    return undefined;
  }
  const obj = value as Record<string, unknown>;
  if (
    typeof obj.push !== 'boolean' ||
    typeof obj.create !== 'boolean' ||
    typeof obj.record !== 'boolean'
  ) {
    return undefined;
  }
  return { push: obj.push, create: obj.create, record: obj.record };
}

/** Whether a value is one of the four recorded run result kinds. */
function isRunResultKind(value: unknown): value is RunResultKind {
  return (
    value === 'completed' ||
    value === 'invalid_output' ||
    value === 'closed' ||
    value === 'cancelled'
  );
}
