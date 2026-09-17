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
import { appendFileSync, existsSync, readFileSync } from 'fs';
import {
  CompletionRecord,
  JournalEntry,
  JournalRecord,
  PrCompletion,
  RunResultKind,
  StartRecord,
} from './entry';
import { Stage, isStage } from '../model/stage';
import { TodoState, isTodoState } from '../model/todoState';

/** The start metadata a caller supplies when a stage begins (Req 21.1). */
export interface StartInput {
  runId: string;
  todoId: string;
  stage: Stage;
  attempt: number;
  startHead: string;
  inputRev: string;
  terminalPid?: number;
  /** Transition.from at launch (Req 1.2); omitted from the line when undefined. */
  fromState?: TodoState;
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
    todoId: input.todoId,
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
  const raw = readFileSync(path, 'utf8');
  const byRunId = new Map<string, JournalEntry>();
  const order: string[] = [];

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

  return order.map((runId) => byRunId.get(runId) as JournalEntry);
}

/**
 * Returns the last start entry recorded for `todoId` (optionally restricted to
 * one `stage`), or `undefined` if none. Operates on already-parsed entries
 * (Req 1.2, 3.1); callers read the journal once with {@link parseJournal} and
 * pass the result in rather than this function reading the file itself.
 */
export function latestStart(
  entries: JournalEntry[],
  todoId: string,
  stage?: Stage,
): JournalEntry | undefined {
  let latest: JournalEntry | undefined;
  for (const entry of entries) {
    if (
      entry.todoId === todoId &&
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
  appendFileSync(path, JSON.stringify(record) + '\n', 'utf8');
}

/** Builds the initial entry from a start record's fields. */
function startToEntry(record: StartRecord): JournalEntry {
  const entry: JournalEntry = {
    runId: record.runId,
    todoId: record.todoId,
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
  if (
    typeof obj.runId !== 'string' ||
    typeof obj.todoId !== 'string' ||
    typeof obj.stage !== 'string' ||
    !isStage(obj.stage) ||
    typeof obj.attempt !== 'number' ||
    typeof obj.startHead !== 'string' ||
    typeof obj.inputRev !== 'string'
  ) {
    return undefined;
  }
  const record: StartRecord = {
    type: 'start',
    runId: obj.runId,
    todoId: obj.todoId,
    stage: obj.stage,
    attempt: obj.attempt,
    startHead: obj.startHead,
    inputRev: obj.inputRev,
  };
  if (typeof obj.terminalPid === 'number') {
    record.terminalPid = obj.terminalPid;
  }
  if (typeof obj.fromState === 'string' && isTodoState(obj.fromState)) {
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
