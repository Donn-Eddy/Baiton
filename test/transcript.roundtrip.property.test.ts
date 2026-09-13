import * as assert from 'assert';
import * as fc from 'fast-check';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { ChatTranscript, TranscriptRecord } from '../src/orchestrator/chatTranscript';
import { readTranscript } from '../src/orchestrator/transcriptReader';
import { Clock } from '../src/orchestrator/seams';

/**
 * Feature: baiton-ui-first-pass, Property 1: Transcript append/read round trip —
 * For any sequence of transcript records, appending them one by one to a
 * `chat.jsonl` file through the generalized `ChatTranscript` and then reading
 * them back through the transcript reader SHALL yield the same records in the
 * same order.
 *
 * Validates: Requirements 8.2, 8.3, 20.2
 *
 * The property generates arbitrary message sequences with varied roles, content
 * (including newlines and non-ASCII), and well-formed assistant/tool pairs, appends
 * each through {@link ChatTranscript} into a fresh temp `chat.jsonl`, and reads
 * the file back through {@link readTranscript}. Because `ts` is stamped by the
 * injected {@link Clock} at append time (not supplied by the caller), the test
 * drives a deterministic clock that emits one distinct timestamp per append, so
 * the full persisted {@link TranscriptRecord} — including `ts` — is known and
 * the round trip is asserted exactly, in order. Each iteration uses its own
 * temp directory, removed afterward.
 */

// --- Generators ------------------------------------------------------------

/**
 * A message role. `content` is never a `\n`-free constraint: the record is
 * JSON-encoded per line, so embedded newlines and non-ASCII must survive.
 */
const roleArb: fc.Arbitrary<TranscriptRecord['role']> = fc.constantFrom(
  'user',
  'assistant',
  'system',
);

/** Message content: any string, exercising newlines, non-ASCII and emptiness. */
const contentArb: fc.Arbitrary<string> = fc.string({ maxLength: 60 });

/** A tool-call id, used to pair an assistant `tool_calls` entry with its `tool` reply. */
const toolCallIdArb: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 20 });

/**
 * One appended message: the caller-supplied fields (everything but `ts`, which
 * the clock stamps). `tool_call_id` is included only when present so the
 * expected record does not carry an `undefined` key that `JSON.stringify` drops.
 */
const messageArb: fc.Arbitrary<Omit<TranscriptRecord, 'ts'>> = fc.record({
  role: roleArb,
  content: contentArb,
});

/**
 * An assistant turn that requests a tool, followed by the `tool` reply that
 * answers it. The reader is pair-aware — it drops a `tool` record no preceding
 * assistant record called for — so `tool` records are generated as part of a
 * well-formed pair, which is the only shape the loop ever appends.
 */
const toolPairArb: fc.Arbitrary<Array<Omit<TranscriptRecord, 'ts'>>> = fc
  .record({
    id: toolCallIdArb,
    name: fc.string({ minLength: 1, maxLength: 20 }),
    args: fc.string({ maxLength: 30 }),
    askContent: contentArb,
    replyContent: contentArb,
  })
  .map(({ id, name, args, askContent, replyContent }) => [
    {
      role: 'assistant' as const,
      content: askContent,
      tool_calls: [{ id, name, arguments: args }],
    },
    { role: 'tool' as const, content: replyContent, tool_call_id: id },
  ]);

/** A sequence of messages to append in order (empty sequence allowed). */
const messagesArb: fc.Arbitrary<Array<Omit<TranscriptRecord, 'ts'>>> = fc
  .array(fc.oneof(messageArb.map((m) => [m]), toolPairArb), { maxLength: 8 })
  .map((groups) => groups.flat());

// --- Property --------------------------------------------------------------

describe('transcript round trip (property)', () => {
  it('Property 1: appending messages and reading them back yields the same records in order', async () => {
    await fc.assert(
      fc.asyncProperty(messagesArb, async (messages) => {
        const dir = mkdtempSync(join(tmpdir(), 'baiton-transcript-'));
        const path = join(dir, 'chat.jsonl');
        try {
          // A deterministic clock: one distinct ISO timestamp per append, so the
          // stamped `ts` is known and the whole record round trips exactly.
          let tick = 0;
          const clock: Clock = {
            now: () => `2024-01-01T00:00:${String(tick++).padStart(2, '0')}.000Z`,
          };

          const transcript = new ChatTranscript(path, clock);

          // Build the expected records as we append, capturing the `ts` the clock
          // stamped for each message (append order == send order, Req 8.2).
          const expected: TranscriptRecord[] = [];
          for (const message of messages) {
            const ts = `2024-01-01T00:00:${String(tick).padStart(2, '0')}.000Z`;
            expected.push({ ts, ...message });
            await transcript.append(message);
          }

          // Read back through the reader (Req 8.3) and assert exact, ordered equality.
          const actual = await readTranscript(path);
          assert.deepStrictEqual(actual, expected);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: 200 },
    );
  });
});

describe('transcript clear', () => {
  it('clear() empties the file and a subsequent read yields no records', async () => {
    const fs = await import('fs/promises');
    const os = await import('os');
    const path = await import('path');
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'baiton-clear-'));
    const file = path.join(dir, 'chat.jsonl');
    const transcript = new ChatTranscript(file);
    await transcript.append({ role: 'user', content: 'hello' });
    await transcript.append({ role: 'assistant', content: 'hi' });
    assert.strictEqual((await readTranscript(file)).length, 2);
    await transcript.clear();
    assert.deepStrictEqual(await readTranscript(file), []);
    assert.strictEqual(await fs.readFile(file, 'utf8'), '', 'the file is kept but empty');
    await transcript.append({ role: 'user', content: 'again' });
    assert.strictEqual((await readTranscript(file)).length, 1, 'appends resume after a clear');
  });
});
