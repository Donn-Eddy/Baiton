/**
 * Conversation transcript persistence (Requirements 8.1, 8.2, 9.9).
 *
 * The orchestrator persists a chat session's messages to a `<id>.jsonl` file
 * starting from the user's first message. The file is append-only,
 * newline-delimited JSON: one record per message, in send order. This recorder
 * is a pure filesystem seam: it takes the target transcript file path and an
 * injected {@link Clock} for timestamps, so it is testable without a VS Code
 * host, and the activation layer wires it to the live chat session.
 *
 * Workspace sessions persist to `.baiton/chat/<id>.jsonl` and each spec
 * conversation's sessions to `.baiton/specs/<slug>/chat/<id>.jsonl` (see
 * {@link SessionStore}); the caller supplies the full file path so one recorder
 * can serve any session of any conversation (Req 8.1, 8.2).
 *
 * Intervention cards are persisted as `system` records carrying `intervention`,
 * appended when the ask settles, so they are part of the append-only history
 * like any other message.
 */
import { appendFile, writeFile } from 'fs/promises';
import type { ToolCall } from './modelClient';
import type { InterventionAnswer } from './interventions';
import type { InterventionView } from './webviewProtocol';
import { Clock, systemClock } from './seams';

/** One persisted transcript record. */
export interface TranscriptRecord {
  /** ISO-8601 timestamp the message was recorded. */
  ts: string;
  /** The message role on the conversation. */
  role: 'user' | 'assistant' | 'tool' | 'system';
  /** The message content. */
  content: string;
  /** For a tool message, the tool-call id it answers. */
  tool_call_id?: string;
  /** For an assistant message, the tool calls it requested. */
  tool_calls?: ToolCall[];
  /** For an intervention record: the card and its settled state. */
  intervention?: InterventionView;
}

/**
 * Appends conversation messages to one session's transcript file. The first
 * {@link append} the recorder ever receives is the user's first message, so
 * persistence begins from that message with no separate "start" step (Req 9.9).
 */
export class ChatTranscript {
  private readonly file: string;

  constructor(
    file: string,
    private readonly clock: Clock = systemClock,
  ) {
    this.file = file;
  }

  /**
   * Persist one message. The record carries a timestamp from the injected clock
   * so ordering and timing are captured and deterministic under test. Creates
   * the file on the first append.
   */
  public async append(message: Omit<TranscriptRecord, 'ts'>): Promise<void> {
    const record: TranscriptRecord = { ts: this.clock.now(), ...message };
    await appendFile(this.file, `${JSON.stringify(record)}\n`, 'utf8');
  }

  /** The absolute path of the transcript file, for callers that need it. */
  /** Discard every record: the file is truncated to empty (kept, not deleted). */
  public async clear(): Promise<void> {
    await writeFile(this.file, '', 'utf8');
  }

  public get path(): string {
    return this.file;
  }
}

/**
 * The transcript record that persists one intervention card. Cards are stored
 * once, in settled form: a card is appended when it resolves, so a reloaded
 * conversation shows the decision inline and never re-offers an ask whose
 * promise died with the window. `content` mirrors the prompt so a reader that
 * ignores `intervention` still sees the text.
 */
export function interventionTranscriptRecord(
  view: InterventionView,
): Omit<TranscriptRecord, 'ts'> {
  return { role: 'system', content: view.prompt, intervention: { ...view } };
}

/** The settled card to persist: `view` flipped to 'resolved' with its answer. */
export function settledInterventionView(
  view: InterventionView,
  answer: InterventionAnswer,
  opts: { rationale?: string; auto?: boolean } = {},
): InterventionView {
  return {
    ...view,
    status: 'resolved',
    answer,
    ...(opts.rationale !== undefined ? { rationale: opts.rationale } : {}),
    ...(opts.auto !== undefined ? { auto: opts.auto } : {}),
  };
}
