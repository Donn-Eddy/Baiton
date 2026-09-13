/**
 * The run-journal entry shape and the two append-record shapes that build it
 * (Requirements 21.1, 21.2; design "Run journal entry").
 *
 * `runs.jsonl` is an append-only, newline-delimited JSON file. A stage writes a
 * START record when it begins and a COMPLETION record when it finishes; both
 * are keyed by `runId`. Parsing merges the two records for a run id back into a
 * single {@link JournalEntry}, so the reconstructed entry is equivalent to the
 * information that was appended.
 *
 * The PR completion fields (`pr`) are carried as an optional shape only: the
 * first pass never sets them, but the schema keeps room for the deferred PR run
 * (design notes the PR journal fields as an unused seam).
 */
import { Stage } from '../model/stage';
import { TodoState } from '../model/todoState';

/**
 * The terminal result kind a run can record on completion. Mirrors the stage
 * engine's `RunOutcome` kinds from the design (`completed`, `invalid_output`,
 * `closed`, `cancelled`); the journal only ever stores the kind, not the full
 * outcome payload.
 */
export type RunResultKind =
  | 'completed'
  | 'invalid_output'
  | 'closed'
  | 'cancelled';

/**
 * A fully reconstructed journal entry: the start metadata plus, once the run
 * has finished, its completion metadata. Fields after `terminalPid` are absent
 * until a completion record for the same `runId` has been appended.
 */
export interface JournalEntry {
  runId: string;
  todoId: string;
  stage: Stage;
  attempt: number;
  startHead: string;
  inputRev: string;
  terminalPid?: number;
  /** Transition.from at launch; absent on entries written before this field existed. */
  fromState?: TodoState;
  /** The Claude `--session-id` UUID; absent on entries written before this field existed. */
  sessionId?: string;

  // Completion fields, appended later as a separate record:
  result?: RunResultKind;
  commit?: string;
  /** PR-run only; unused in the first pass. Carried as an optional shape. */
  pr?: PrCompletion;
}

/** Which PR side effects succeeded. PR run only; unused in the first pass. */
export interface PrCompletion {
  push: boolean;
  create: boolean;
  record: boolean;
}

/**
 * The record appended when a stage starts (Req 21.1): the run id, todo, stage,
 * attempt, starting HEAD, input rev, and terminal process id.
 */
export interface StartRecord {
  type: 'start';
  runId: string;
  todoId: string;
  stage: Stage;
  attempt: number;
  startHead: string;
  inputRev: string;
  terminalPid?: number;
  /** Transition.from at launch; written only when supplied. */
  fromState?: TodoState;
  /** The Claude `--session-id` UUID; written only when supplied. */
  sessionId?: string;
}

/**
 * The record appended when a stage completes (Req 21.2): the result kind and
 * the resulting commit, keyed to its run by `runId`. `pr` is set only for the
 * deferred PR run.
 */
export interface CompletionRecord {
  type: 'completion';
  runId: string;
  result: RunResultKind;
  commit?: string;
  pr?: PrCompletion;
}

/** Either record kind, as written one-per-line to `runs.jsonl`. */
export type JournalRecord = StartRecord | CompletionRecord;
