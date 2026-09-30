/**
 * Conversation transcript reader (Requirements 8.3, 8.4, 8.5).
 *
 * Reads a session transcript file (`.baiton/chat/<id>.jsonl`, or
 * `.baiton/specs/<slug>/chat/<id>.jsonl`) written by {@link ChatTranscript} and
 * returns its records in append order, one per line. This is a pure filesystem seam with no
 * VS Code import, so it is testable without a host: the Chat_View loads a
 * conversation's persisted transcript through it on open, reopen and window
 * reload (Req 8.6, 8.8).
 *
 * Tolerance: a missing file yields an empty list rather than throwing (Req 8.4),
 * and any single line that cannot be parsed as one record is skipped, with the
 * remaining parseable records returned in order (Req 8.5).
 *
 * Pair awareness: dropping records individually can leave a `tool` record whose
 * matching `assistant` record was itself dropped (for example when a stream
 * recorded a malformed tool call). OpenAI-compatible endpoints reject a `tool`
 * message that does not answer a call on the immediately preceding assistant
 * message, so after parsing, every `tool` record whose `tool_call_id` is not
 * among the nearest preceding assistant record's `tool_calls` is dropped too
 * (Req 8.5).
 *
 * Intervention records are passed through that pairing untouched: a card can
 * sit between an assistant turn and the tool record answering it (a tool that
 * asks for confirmation mid-call) and neither opens nor closes a call window.
 *
 * Replay: {@link toHistory} turns records into the model's chat history. Record
 * to message replay lives here so it is host-free and testable. Tool messages
 * always directly follow their assistant `tool_calls` entry: an intervention
 * card met inside an open call window is deferred until the window closes,
 * a pending/settled pair for one id collapses to the settled card, and a plain
 * `system` record replays as `assistant`.
 */
import { readFile } from 'fs/promises';
import { TranscriptRecord } from './chatTranscript';
import type { ChatMessage } from './modelClient';
import type { InterventionAnswer } from './interventions';
import type { InterventionView } from './webviewProtocol';

/**
 * Read a session transcript file and return its records in append order.
 *
 * @param file The session transcript file path to read.
 * @returns The parsed records in file (append) order. A missing file yields
 *   `[]`; an unparseable line is skipped and the remaining records returned.
 */
export async function readTranscript(file: string): Promise<TranscriptRecord[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    // A missing file is not an error: an unopened conversation has no history.
    if (isNotFound(err)) {
      return [];
    }
    throw err;
  }

  const records: TranscriptRecord[] = [];
  for (const line of text.split('\n')) {
    // A trailing newline (and any blank line) produces an empty segment; skip it
    // silently rather than treating it as an unparseable record.
    if (line.trim() === '') {
      continue;
    }
    const record = parseRecord(line);
    if (record !== undefined) {
      records.push(record);
    }
  }
  return dropOrphanToolRecords(records);
}

/**
 * Drop every `tool` record that does not answer a call on the nearest preceding
 * `assistant` record. A `tool` record appearing before any assistant record, or
 * after an assistant record carrying no `tool_calls`, is an orphan and is
 * dropped; all other records are returned unchanged and in order.
 */
function dropOrphanToolRecords(records: TranscriptRecord[]): TranscriptRecord[] {
  const out: TranscriptRecord[] = [];
  // Call ids offered by the most recent assistant record; `undefined` until one
  // is seen. A run of `tool` records is measured against that same assistant.
  let openCallIds: Set<string> | undefined;
  for (const record of records) {
    if (record.role === 'tool') {
      const id = record.tool_call_id;
      if (id === undefined || openCallIds === undefined || !openCallIds.has(id)) {
        continue;
      }
      out.push(record);
      continue;
    }
    if (record.intervention !== undefined) {
      // An intervention card can be appended between an assistant turn and the
      // tool record answering it (a tool that asks for confirmation mid-call).
      // It is inert for pairing: keep the open call window intact.
      out.push(record);
      continue;
    }
    openCallIds =
      record.role === 'assistant' && record.tool_calls !== undefined
        ? new Set(record.tool_calls.map((c) => c.id))
        : undefined;
    out.push(record);
  }
  return out;
}

/** How a persisted card reads in the model history: the ask and what was decided. */
export function interventionHistoryText(view: InterventionView): string {
  return `[intervention] ${view.prompt}\nDecision: ${describeAnswer(view.answer)}`;
}

/** A one-line description of an intervention answer. */
function describeAnswer(answer: InterventionAnswer | undefined): string {
  if (answer === undefined) {
    return 'no answer was recorded';
  }
  switch (answer.kind) {
    case 'approved':
      return 'approved';
    case 'declined':
      return answer.reason === undefined ? 'declined' : `declined (${answer.reason})`;
    case 'option':
      return `chose "${answer.label ?? answer.optionId}"`;
    case 'text':
      return `answered: ${answer.text}`;
  }
}

/**
 * Replay transcript records as the chat history the model receives. Tool
 * messages stay adjacent to the assistant `tool_calls` entry they answer:
 * intervention cards inside an open call window are held back and emitted when
 * the window closes. A pending/settled pair for one id collapses to a single
 * message carrying the settled decision, at the first occurrence's position.
 */
export function toHistory(records: readonly TranscriptRecord[]): ChatMessage[] {
  const settledById = new Map<string, InterventionView>();
  for (const record of records) {
    const view = record.intervention;
    if (view !== undefined && (!settledById.has(view.id) || view.status === 'resolved')) {
      settledById.set(view.id, view);
    }
  }

  const out: ChatMessage[] = [];
  let openCallIds: Set<string> | undefined;
  let deferred: ChatMessage[] = [];
  const emittedIds = new Set<string>();
  const flush = (): void => {
    out.push(...deferred);
    deferred = [];
    openCallIds = undefined;
  };

  for (const record of records) {
    if (record.intervention !== undefined) {
      const id = record.intervention.id;
      if (emittedIds.has(id)) {
        continue;
      }
      emittedIds.add(id);
      // A persisted card re-enters the model history as the ask and its outcome,
      // never as a bare prompt that would read like a fresh question.
      const message: ChatMessage = {
        role: 'assistant',
        content: interventionHistoryText(settledById.get(id) as InterventionView),
      };
      if (openCallIds !== undefined) {
        deferred.push(message);
      } else {
        out.push(message);
      }
      continue;
    }
    if (record.role === 'tool') {
      if (
        openCallIds === undefined ||
        record.tool_call_id === undefined ||
        !openCallIds.has(record.tool_call_id)
      ) {
        continue;
      }
      out.push({ role: 'tool', content: record.content, tool_call_id: record.tool_call_id });
      continue;
    }
    flush();
    // A persisted `system` role is not part of the history the loop sends (the
    // loop prepends a fresh system prompt each round), so it replays as assistant.
    const role: ChatMessage['role'] = record.role === 'system' ? 'assistant' : record.role;
    out.push({
      role,
      content: record.content,
      ...(record.tool_call_id !== undefined ? { tool_call_id: record.tool_call_id } : {}),
      ...(record.tool_calls !== undefined ? { tool_calls: record.tool_calls } : {}),
    });
    if (record.role === 'assistant' && record.tool_calls !== undefined && record.tool_calls.length > 0) {
      openCallIds = new Set(record.tool_calls.map((c) => c.id));
    }
  }
  flush();
  return out;
}

/** Whether a caught filesystem error is a "file does not exist" error. */
function isNotFound(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: string }).code === 'ENOENT'
  );
}

/**
 * Parse one line as a transcript record, returning `undefined` when the line is
 * not valid JSON or does not have the shape of a record. Skipping malformed
 * lines keeps a truncated or partially corrupt file readable (Req 8.5).
 */
function parseRecord(line: string): TranscriptRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isTranscriptRecord(value)) {
    return undefined;
  }
  return value;
}

/** Structural check for the required transcript record fields. */
function isTranscriptRecord(value: unknown): value is TranscriptRecord {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const rec = value as Record<string, unknown>;
  if (typeof rec.ts !== 'string') {
    return false;
  }
  if (
    rec.role !== 'user' &&
    rec.role !== 'assistant' &&
    rec.role !== 'tool' &&
    rec.role !== 'system'
  ) {
    return false;
  }
  if (typeof rec.content !== 'string') {
    return false;
  }
  if (rec.tool_call_id !== undefined && typeof rec.tool_call_id !== 'string') {
    return false;
  }
  if (rec.tool_calls !== undefined && !isToolCallList(rec.tool_calls)) {
    return false;
  }
  if (rec.intervention !== undefined && !isInterventionView(rec.intervention)) {
    return false;
  }
  return true;
}

/** Structural check for a persisted assistant `tool_calls` list. */
function isToolCallList(value: unknown): boolean {
  return (
    Array.isArray(value) &&
    value.every((c) => {
      if (typeof c !== 'object' || c === null) {
        return false;
      }
      const call = c as Record<string, unknown>;
      return (
        typeof call.id === 'string' &&
        typeof call.name === 'string' &&
        typeof call.arguments === 'string'
      );
    })
  );
}

/**
 * Structural check for a persisted intervention card. Only the fields the view
 * needs in order to key, label and settle a card are required; the optional
 * fields (options, detail, agent, tool, args, answer, rationale, auto) are
 * tolerated in any shape, so a card written by a newer version still loads.
 */
function isInterventionView(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const view = value as Record<string, unknown>;
  return (
    typeof view.id === 'string' &&
    view.id.length > 0 &&
    (view.kind === 'question' || view.kind === 'confirm' || view.kind === 'permission') &&
    typeof view.prompt === 'string' &&
    (view.status === 'pending' || view.status === 'resolved')
  );
}
