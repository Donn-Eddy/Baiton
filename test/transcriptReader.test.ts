import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { readTranscript } from '../src/orchestrator/transcriptReader';
import { TranscriptRecord } from '../src/orchestrator/chatTranscript';

/**
 * Unit tests for the transcript reader's tolerance behavior (Task 1.3).
 *
 * These run against real `chat.jsonl` files written under `os.tmpdir()`, so the
 * reader exercises its real Node `fs` path without a VS Code host. Each test
 * allocates its own temp directory and every directory is removed afterwards.
 *
 * Coverage:
 * - A missing file yields an empty ordered list and does not throw (Req 8.4).
 * - An unparseable line among valid ones is skipped, with the remaining
 *   parseable records returned in append order and no error raised (Req 8.5).
 * - A `tool` record left without the assistant record that requested it is
 *   dropped, so a reloaded conversation never opens with an orphan `tool`
 *   message that the endpoint would reject (Req 8.5).
 */
describe('transcript reader tolerance (Task 1.3)', () => {
  const dirs: string[] = [];

  /** Allocate a fresh temp directory registered for cleanup. */
  function newDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-transcript-'));
    dirs.push(dir);
    return dir;
  }

  /** Write `contents` to a `chat.jsonl` file in a fresh temp dir and return its path. */
  function writeTranscript(contents: string): string {
    const file = path.join(newDir(), 'chat.jsonl');
    fs.writeFileSync(file, contents, 'utf8');
    return file;
  }

  /** Serialize a record the same way {@link ChatTranscript.append} would. */
  function line(record: TranscriptRecord): string {
    return JSON.stringify(record);
  }

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('missing file (Req 8.4)', () => {
    it('returns an empty list and does not throw when the file does not exist', async () => {
      const file = path.join(newDir(), 'chat.jsonl');
      assert.strictEqual(fs.existsSync(file), false, 'the file should not exist');

      const records = await readTranscript(file);

      assert.deepStrictEqual(records, [], 'a missing file should yield []');
    });
  });

  describe('unparseable line among valid ones (Req 8.5)', () => {
    it('skips the unparseable line and returns the rest in append order', async () => {
      const first: TranscriptRecord = {
        ts: '2024-01-01T00:00:00.000Z',
        role: 'user',
        content: 'first message',
      };
      const third: TranscriptRecord = {
        ts: '2024-01-01T00:00:02.000Z',
        role: 'assistant',
        content: 'third message',
      };
      // A middle line that is not valid JSON at all. It must be skipped while the
      // first and third records are returned in their original append order.
      const contents = `${line(first)}\n{ not valid json\n${line(third)}\n`;
      const file = writeTranscript(contents);

      const records = await readTranscript(file);

      assert.deepStrictEqual(
        records,
        [first, third],
        'the unparseable line is skipped and the rest returned in order',
      );
    });

    it('skips valid JSON that is not a transcript record and keeps the rest in order', async () => {
      const first: TranscriptRecord = {
        ts: '2024-01-01T00:00:00.000Z',
        role: 'user',
        content: 'hello',
      };
      const caller: TranscriptRecord = {
        ts: '2024-01-01T00:00:02.000Z',
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', name: 'git_status', arguments: '{}' }],
      };
      const last: TranscriptRecord = {
        ts: '2024-01-01T00:00:03.000Z',
        role: 'tool',
        content: 'tool result',
        tool_call_id: 'call_1',
      };
      // The middle line parses as JSON but lacks the required record shape (no
      // `content`, bad `role`), so it must be skipped like any unparseable line.
      const notARecord = JSON.stringify({ ts: '2024-01-01T00:00:01.000Z', role: 'nope' });
      const contents = `${line(first)}\n${notARecord}\n${line(caller)}\n${line(last)}\n`;
      const file = writeTranscript(contents);

      const records = await readTranscript(file);

      assert.deepStrictEqual(
        records,
        [first, caller, last],
        'a shape-invalid record is skipped and the rest returned in order',
      );
    });
  });
  describe('orphaned tool records (Req 8.5)', () => {
    const user: TranscriptRecord = {
      ts: '2024-01-01T00:00:00.000Z',
      role: 'user',
      content: 'hello',
    };

    it('drops a tool record with no preceding assistant tool_calls', async () => {
      const orphan: TranscriptRecord = {
        ts: '2024-01-01T00:00:01.000Z',
        role: 'tool',
        content: 'result with no caller',
        tool_call_id: 'call_gone',
      };
      const file = writeTranscript(`${line(user)}\n${line(orphan)}\n`);

      const records = await readTranscript(file);

      assert.deepStrictEqual(records, [user], 'the orphan tool record is dropped');
    });

    it('drops a tool record whose id is not among the assistant tool_calls but keeps its sibling', async () => {
      // The shape a malformed stream leaves behind: the assistant record only
      // carries the call it managed to record, so the other tool record is
      // unanswerable and must go.
      const assistant: TranscriptRecord = {
        ts: '2024-01-01T00:00:01.000Z',
        role: 'assistant',
        content: 'looking',
        tool_calls: [{ id: 'call_ok', name: 'git_status', arguments: '{}' }],
      };
      const stray: TranscriptRecord = {
        ts: '2024-01-01T00:00:02.000Z',
        role: 'tool',
        content: 'Error: unknown tool',
        tool_call_id: 'call_missing',
      };
      const kept: TranscriptRecord = {
        ts: '2024-01-01T00:00:03.000Z',
        role: 'tool',
        content: '{"clean":true}',
        tool_call_id: 'call_ok',
      };
      const file = writeTranscript(
        `${line(user)}\n${line(assistant)}\n${line(stray)}\n${line(kept)}\n`,
      );

      const records = await readTranscript(file);

      assert.deepStrictEqual(
        records,
        [user, assistant, kept],
        'the unmatched tool record is dropped and its valid sibling kept',
      );
    });

    it('preserves a normal assistant to tool pairing', async () => {
      const assistant: TranscriptRecord = {
        ts: '2024-01-01T00:00:01.000Z',
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_a', name: 'git_status', arguments: '{}' },
          { id: 'call_b', name: 'glob', arguments: '{"glob":"**/*"}' },
        ],
      };
      const first: TranscriptRecord = {
        ts: '2024-01-01T00:00:02.000Z',
        role: 'tool',
        content: '{"clean":true}',
        tool_call_id: 'call_a',
      };
      const second: TranscriptRecord = {
        ts: '2024-01-01T00:00:03.000Z',
        role: 'tool',
        content: '[]',
        tool_call_id: 'call_b',
      };
      const reply: TranscriptRecord = {
        ts: '2024-01-01T00:00:04.000Z',
        role: 'assistant',
        content: 'all clean',
      };
      const file = writeTranscript(
        `${line(user)}\n${line(assistant)}\n${line(first)}\n${line(second)}\n${line(reply)}\n`,
      );

      const records = await readTranscript(file);

      assert.deepStrictEqual(
        records,
        [user, assistant, first, second, reply],
        'a well-formed assistant/tool pairing is returned untouched',
      );
    });
  });
});
