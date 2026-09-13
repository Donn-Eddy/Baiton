import * as assert from 'assert';
import * as fc from 'fast-check';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  appendStart,
  appendCompletion,
  parseJournal,
  StartInput,
  CompletionInput,
  JournalEntry,
} from '../src/journal';
import { STAGES, Stage } from '../src/model/stage';
import { TODO_STATES, TodoState } from '../src/model/todoState';

/**
 * Feature: baiton-first-pass, Property 20: Run-journal round trip —
 * For any sequence of start and completion records, appending them to
 * runs.jsonl and parsing it back SHALL reconstruct the entries keyed by run id
 * equivalently.
 *
 * Validates: Requirements 21.1, 21.2
 *
 * The property generates a sequence of runs, each with a start record (Req
 * 21.1) and, for some runs, a matching completion record (Req 21.2). It writes
 * every record to a temp `runs.jsonl` via {@link appendStart} /
 * {@link appendCompletion}, parses it back with {@link parseJournal}, and
 * asserts the reconstructed {@link JournalEntry} values equal the expected
 * merge of each run's start fields and (when present) completion fields, keyed
 * by run id and ordered by first-start appearance. Each iteration uses a fresh
 * temp directory that is removed afterward.
 *
 * Feature: baiton-run-controls, Property 3: Journal round trip with the new
 * fields — `fromState`/`sessionId` on a start record survive append/parse
 * (the generator above sometimes omits either or both), and are absent from
 * the reconstructed entry precisely when they were not written.
 *
 * Validates: Requirements 1.2
 */

// --- Generators ------------------------------------------------------------

/** Non-empty short text without control characters that survive JSON exactly. */
const textArb: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 20 });

const stageArb: fc.Arbitrary<Stage> = fc.constantFrom<Stage>(...STAGES);

/** A start record's caller input (Req 21.1); `terminalPid` sometimes omitted. */
const startInputArb = (runId: string): fc.Arbitrary<StartInput> =>
  fc.record({
    todoId: textArb,
    stage: stageArb,
    attempt: fc.integer({ min: 1, max: 10 }),
    startHead: textArb,
    inputRev: textArb,
    terminalPid: fc.option(fc.integer({ min: 1, max: 999999 }), {
      nil: undefined,
    }),
    fromState: fc.option(fc.constantFrom<TodoState>(...TODO_STATES), {
      nil: undefined,
    }),
    sessionId: fc.option(fc.uuid(), { nil: undefined }),
  }).map((rest) => ({ runId, ...rest }));

/** A completion record's caller input (Req 21.2); `commit`/`pr` optional. */
const completionInputArb = (runId: string): fc.Arbitrary<CompletionInput> =>
  fc.record({
    result: fc.constantFrom<CompletionInput['result']>(
      'completed',
      'invalid_output',
      'closed',
      'cancelled',
    ),
    commit: fc.option(textArb, { nil: undefined }),
    pr: fc.option(
      fc.record({
        push: fc.boolean(),
        create: fc.boolean(),
        record: fc.boolean(),
      }),
      { nil: undefined },
    ),
  }).map((rest) => ({ runId, ...rest }));

/** A single run: its start input and, sometimes, a matching completion input. */
const runArb = (runId: string) =>
  startInputArb(runId).chain((start) =>
    fc
      .option(completionInputArb(runId), { nil: undefined })
      .map((completion) => ({ start, completion })),
  );

/**
 * A sequence of runs with distinct run ids. Distinct ids keep the expected
 * merge unambiguous; the journal keys by run id, so overlapping ids would just
 * be a last-write-wins overwrite (covered by unit tests, not the shape here).
 */
const runsArb = fc
  .uniqueArray(fc.uuid(), { minLength: 0, maxLength: 8 })
  .chain((runIds) =>
    fc.tuple(...runIds.map((id) => runArb(id))) as fc.Arbitrary<
      Array<{ start: StartInput; completion?: CompletionInput }>
    >,
  );

// --- Expected reconstruction ----------------------------------------------

/** The entry the parser should reconstruct for one run (start + completion). */
function expectedEntry(
  start: StartInput,
  completion?: CompletionInput,
): JournalEntry {
  const entry: JournalEntry = {
    runId: start.runId,
    todoId: start.todoId,
    stage: start.stage,
    attempt: start.attempt,
    startHead: start.startHead,
    inputRev: start.inputRev,
  };
  if (start.terminalPid !== undefined) {
    entry.terminalPid = start.terminalPid;
  }
  if (start.fromState !== undefined) {
    entry.fromState = start.fromState;
  }
  if (start.sessionId !== undefined) {
    entry.sessionId = start.sessionId;
  }
  if (completion !== undefined) {
    entry.result = completion.result;
    if (completion.commit !== undefined) {
      entry.commit = completion.commit;
    }
    if (completion.pr !== undefined) {
      entry.pr = completion.pr;
    }
  }
  return entry;
}

// --- Property --------------------------------------------------------------

describe('run journal round trip (property)', () => {
  it('Property 20: appending starts/completions and parsing back reconstructs the entries by run id', () => {
    fc.assert(
      fc.property(runsArb, (runs) => {
        const dir = mkdtempSync(join(tmpdir(), 'baiton-journal-'));
        const path = join(dir, 'runs.jsonl');
        try {
          // Append every start first (Req 21.1), then every completion
          // (Req 21.2) — the append order across runs does not change which
          // entry a record merges into, since records are keyed by run id.
          for (const { start } of runs) {
            appendStart(path, start);
          }
          for (const { completion } of runs) {
            if (completion !== undefined) {
              appendCompletion(path, completion);
            }
          }

          const parsed = parseJournal(path);

          // Entries come back in first-start order, one per run id.
          const expected = runs.map(({ start, completion }) =>
            expectedEntry(start, completion),
          );
          assert.deepStrictEqual(parsed, expected);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: 200 },
    );
  });

  it('Property 3: fromState/sessionId survive append/parse and are absent when not written', () => {
    fc.assert(
      fc.property(runsArb, (runs) => {
        const dir = mkdtempSync(join(tmpdir(), 'baiton-journal-'));
        const path = join(dir, 'runs.jsonl');
        try {
          for (const { start } of runs) {
            appendStart(path, start);
          }
          const parsed = parseJournal(path);
          assert.strictEqual(parsed.length, runs.length);
          for (let i = 0; i < runs.length; i++) {
            const { start } = runs[i];
            const entry = parsed[i];
            if (start.fromState !== undefined) {
              assert.strictEqual(entry.fromState, start.fromState);
            } else {
              assert.strictEqual('fromState' in entry, false);
            }
            if (start.sessionId !== undefined) {
              assert.strictEqual(entry.sessionId, start.sessionId);
            } else {
              assert.strictEqual('sessionId' in entry, false);
            }
          }
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 },
    );
  });
});
