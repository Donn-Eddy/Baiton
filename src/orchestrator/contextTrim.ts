/**
 * Context trimming for one round's payload (host-free core).
 *
 * `trimHistory` shrinks the history the tool loop is about to send: it drops
 * auto-approved intervention lines, then replaces tool results from earlier
 * turns, then large results from older rounds of the current turn, with short
 * stubs. It never touches the transcript and never breaks tool pairing: every
 * assistant `tool_calls` entry and every `tool_call_id` is kept. This module
 * carries no `vscode` import so it can be unit-tested under plain mocha.
 */

import type { ChatMessage } from './modelClient';
import type { TranscriptRecord } from './chatTranscript';
import type { InterventionView } from './webviewProtocol';
import { interventionHistoryText } from './transcriptReader';
import { estimateMessages } from './contextBudget';

/** The `baiton.orchestrator.contextTrimAt` setting key. */
export const CONTEXT_TRIM_AT_SETTING = 'baiton.orchestrator.contextTrimAt';

/** The fraction of the window at which trimming starts when the setting is unset or invalid. */
export const DEFAULT_CONTEXT_TRIM_AT = 0.5;

/** Pass 3 only stubs current-turn results larger than this many UTF-8 bytes. */
export const TRIM_LARGE_RESULT_BYTES = 2048;

/** Pass 3 leaves this many of the current turn's latest rounds untouched. */
export const TRIM_KEEP_RECENT_ROUNDS = 2;

/** The configured fraction when finite with 0 < v <= 1, else the default. Pure; never throws. */
export function resolveContextTrimAt(configured: unknown): number {
  if (typeof configured === 'number' && Number.isFinite(configured) && configured > 0 && configured <= 1) {
    return configured;
  }
  return DEFAULT_CONTEXT_TRIM_AT;
}

/** The placeholder that replaces a trimmed tool result. */
export function trimmedResultStub(tool: string, bytes: number, callId: string): string {
  return `[trimmed ${tool} result: ${bytes} bytes; call ${callId}]`;
}

/**
 * The history lines of intervention cards that settled as auto-approved. The
 * settled view per id is chosen as `toHistory` does (last resolved, else first seen).
 */
export function autoApprovedInterventionLines(records: readonly TranscriptRecord[]): Set<string> {
  const settledById = new Map<string, InterventionView>();
  for (const record of records) {
    const view = record.intervention;
    if (view !== undefined && (!settledById.has(view.id) || view.status === 'resolved')) {
      settledById.set(view.id, view);
    }
  }
  const lines = new Set<string>();
  for (const view of settledById.values()) {
    if (view.auto === true) {
      lines.add(interventionHistoryText(view));
    }
  }
  return lines;
}

/** What `trimHistory` needs: the target and optional tuning seams. */
export interface TrimOptions {
  targetTokens: number;
  estimate?: (messages: readonly ChatMessage[]) => number;
  autoApprovedLines?: ReadonlySet<string>;
  keepRecentRounds?: number;
  largeResultBytes?: number;
}

/**
 * A trimmed copy of `history`, stopping as soon as the estimate is at or below
 * `targetTokens` (it may stay above when nothing more can be trimmed). Never
 * mutates its input; only the pass-1 removals shorten the array.
 */
export function trimHistory(history: readonly ChatMessage[], opts: TrimOptions): ChatMessage[] {
  const estimate = opts.estimate ?? ((m: readonly ChatMessage[]): number => estimateMessages(m));
  const keepRecent = opts.keepRecentRounds ?? TRIM_KEEP_RECENT_ROUNDS;
  const largeBytes = opts.largeResultBytes ?? TRIM_LARGE_RESULT_BYTES;
  const out: ChatMessage[] = history.map((m) => m);
  const done = (): boolean => estimate(out) <= opts.targetTokens;
  if (done()) {
    return out;
  }

  const callTool = new Map<string, string>();
  for (const m of out) {
    for (const tc of m.tool_calls ?? []) {
      callTool.set(tc.id, tc.name);
    }
  }
  const stubAt = (i: number): boolean => {
    const m = out[i];
    if (STUB_PATTERN.test(m.content)) {
      return false;
    }
    const id = m.tool_call_id ?? '';
    const bytes = utf8Bytes(m.content);
    const stub = trimmedResultStub(callTool.get(id) ?? 'unknown', bytes, id);
    if (utf8Bytes(stub) >= bytes) {
      return false;
    }
    out[i] = { ...m, content: stub };
    return true;
  };

  // Pass 1: auto-approved intervention lines, oldest first.
  const lines = opts.autoApprovedLines;
  if (lines !== undefined && lines.size > 0) {
    for (let i = 0; i < out.length; ) {
      const m = out[i];
      if (m.role === 'assistant' && (m.tool_calls ?? []).length === 0 && lines.has(m.content)) {
        out.splice(i, 1);
        if (done()) {
          return out;
        }
      } else {
        i += 1;
      }
    }
  }

  // Pass 2: tool results from turns before the previous one, oldest first.
  const users = userIndices(out);
  const prevStart = users.length >= 2 ? users[users.length - 2] : 0;
  for (let i = 0; i < prevStart; i += 1) {
    if (out[i].role === 'tool' && stubAt(i) && done()) {
      return out;
    }
  }

  // Pass 3: large results from all but the last rounds of the current turn.
  const currentStart = users.length >= 1 ? users[users.length - 1] : 0;
  const rounds = roundStarts(out, currentStart);
  const oldEnd = rounds.length > keepRecent ? rounds[rounds.length - keepRecent] : currentStart;
  for (let i = currentStart; i < oldEnd; i += 1) {
    if (out[i].role === 'tool' && utf8Bytes(out[i].content) > largeBytes && stubAt(i) && done()) {
      return out;
    }
  }
  return out;
}

/** Matches a result that is already a trim stub, so a second pass leaves it alone. */
const STUB_PATTERN = /^\[trimmed .+ result: \d+ bytes; call .*\]$/;

/** Indices of the `user` messages (the turn boundaries). */
function userIndices(messages: readonly ChatMessage[]): number[] {
  const indices: number[] = [];
  messages.forEach((m, i) => {
    if (m.role === 'user') {
      indices.push(i);
    }
  });
  return indices;
}

/** Indices at or after `from` of assistant messages carrying tool calls (one per round). */
function roundStarts(messages: readonly ChatMessage[], from: number): number[] {
  const starts: number[] = [];
  for (let i = from; i < messages.length; i += 1) {
    if (messages[i].role === 'assistant' && (messages[i].tool_calls ?? []).length > 0) {
      starts.push(i);
    }
  }
  return starts;
}

/** UTF-8 byte length of `s`. */
function utf8Bytes(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}
