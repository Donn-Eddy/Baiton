import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as fc from 'fast-check';
import { compactionCut, readTranscript, toHistory } from '../src/orchestrator/transcriptReader';
import type { ChatMessage } from '../src/orchestrator/modelClient';
import { TranscriptRecord } from '../src/orchestrator/chatTranscript';
import { toRenderRecords, type InterventionView } from '../src/orchestrator/webviewProtocol';

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

describe('intervention records (Task T03)', () => {
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

  describe('round trip', () => {
    const user: TranscriptRecord = {
      ts: '2024-01-01T00:00:00.000Z',
      role: 'user',
      content: 'hello',
    };

    it('reads a legacy { what, why } escalation record and renders it as summary/detail', async () => {
      const legacyLine = JSON.stringify({
        ts: '2024-01-01T00:00:02.000Z',
        role: 'system',
        content: 'Allow Bash?',
        intervention: {
          id: 'p1',
          kind: 'permission',
          prompt: 'Allow Bash?',
          status: 'resolved',
          agent: 'claude',
          tool: 'Bash',
          args: '{"command":"ls"}',
          answer: { kind: 'approved' },
          detail: 'What you are approving: claude wants to run Bash\nWhy it was flagged: planner may not use shell tools',
          escalation: { what: 'claude wants to run Bash', why: 'planner may not use shell tools' },
        },
      });
      const file = writeTranscript(`${line(user)}\n${legacyLine}\n`);

      const records = await readTranscript(file);
      assert.strictEqual(records.length, 2, 'the legacy record is not dropped');
      const rendered = toRenderRecords(records);
      const card = rendered.find((r) => r.intervention !== undefined)!.intervention!;
      assert.deepStrictEqual(card.escalation, {
        summary: 'claude wants to run Bash',
        detail: 'planner may not use shell tools',
      });
      assert.strictEqual(card.status, 'resolved');
    });

    it('returns a resolved intervention record unchanged', async () => {
      const view: InterventionView = {
        id: 'a1',
        kind: 'confirm',
        prompt: 'Approve the spec?',
        status: 'resolved',
        answer: { kind: 'approved' },
        rationale: 'matched the allow-list',
        auto: true,
      };
      const card: TranscriptRecord = {
        ts: '2024-01-01T00:00:01.000Z',
        role: 'system',
        content: 'Approve the spec?',
        intervention: view,
      };
      const file = writeTranscript(`${line(user)}\n${line(card)}\n`);

      const records = await readTranscript(file);

      assert.deepStrictEqual(records, [user, card], 'every field of the card survives the round trip');
    });

    it('keeps a permission card\'s agent/tool/args fields', async () => {
      const card: TranscriptRecord = {
        ts: '2024-01-01T00:00:01.000Z',
        role: 'system',
        content: 'Allow Bash?',
        intervention: {
          id: 'a2',
          kind: 'permission',
          prompt: 'Allow Bash?',
          agent: 'claude',
          tool: 'Bash',
          args: '{"command":"ls"}',
          status: 'resolved',
          answer: { kind: 'declined', reason: 'declined' },
        },
      };
      const file = writeTranscript(`${line(user)}\n${line(card)}\n`);

      const records = await readTranscript(file);

      assert.deepStrictEqual(records, [user, card], 'the permission card is returned byte-identical');
    });

    it('keeps an option question card\'s options', async () => {
      const card: TranscriptRecord = {
        ts: '2024-01-01T00:00:01.000Z',
        role: 'system',
        content: 'Which one?',
        intervention: {
          id: 'a3',
          kind: 'question',
          prompt: 'Which one?',
          options: [
            { id: 'a', label: 'A' },
            { id: 'b', label: 'B', detail: 'the other one' },
          ],
          allowFreeText: true,
          status: 'resolved',
          answer: { kind: 'option', optionId: 'b' },
        },
      };
      const file = writeTranscript(`${line(user)}\n${line(card)}\n`);

      const records = await readTranscript(file);

      assert.deepStrictEqual(records, [user, card], 'the question card\'s options survive the round trip');
    });
  });

  describe('validation', () => {
    const user: TranscriptRecord = {
      ts: '2024-01-01T00:00:00.000Z',
      role: 'user',
      content: 'hello',
    };
    const assistant: TranscriptRecord = {
      ts: '2024-01-01T00:00:02.000Z',
      role: 'assistant',
      content: 'later',
    };

    it('skips a record whose intervention is malformed but keeps its neighbours', async () => {
      const bad = JSON.stringify({
        ts: '2024-01-01T00:00:01.000Z',
        role: 'system',
        content: 'x',
        intervention: { kind: 'confirm', prompt: 'x', status: 'pending' },
      });
      const file = writeTranscript(`${line(user)}\n${bad}\n${line(assistant)}\n`);

      const records = await readTranscript(file);

      assert.deepStrictEqual(
        records,
        [user, assistant],
        'a card with no id is not a record and is skipped',
      );
    });

    it('skips a record whose intervention is not an object but keeps its neighbours', async () => {
      const bad = JSON.stringify({
        ts: '2024-01-01T00:00:01.000Z',
        role: 'system',
        content: 'x',
        intervention: 'nope',
      });
      const file = writeTranscript(`${line(user)}\n${bad}\n${line(assistant)}\n`);

      const records = await readTranscript(file);

      assert.deepStrictEqual(records, [user, assistant], 'a non-object card is skipped');
    });
  });

  describe('pair awareness', () => {
    const user: TranscriptRecord = {
      ts: '2024-01-01T00:00:00.000Z',
      role: 'user',
      content: 'hello',
    };
    const assistant: TranscriptRecord = {
      ts: '2024-01-01T00:00:01.000Z',
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_ok', name: 'approve_spec', arguments: '{}' }],
    };
    const card: TranscriptRecord = {
      ts: '2024-01-01T00:00:02.000Z',
      role: 'system',
      content: 'Approve the spec?',
      intervention: {
        id: 'a1',
        kind: 'confirm',
        prompt: 'Approve the spec?',
        status: 'resolved',
        answer: { kind: 'approved' },
      },
    };
    const tool: TranscriptRecord = {
      ts: '2024-01-01T00:00:03.000Z',
      role: 'tool',
      content: 'approved',
      tool_call_id: 'call_ok',
    };

    it('does not orphan the tool record that follows an intervention', async () => {
      const file = writeTranscript(`${line(user)}\n${line(assistant)}\n${line(card)}\n${line(tool)}\n`);

      const records = await readTranscript(file);

      assert.deepStrictEqual(
        records,
        [user, assistant, card, tool],
        'an intervention between the call and its answer must not orphan the answer',
      );
    });

    it('still drops the tool record after a plain system record', async () => {
      const plain: TranscriptRecord = {
        ts: '2024-01-01T00:00:02.000Z',
        role: 'system',
        content: 'intervening note',
      };
      const file = writeTranscript(`${line(user)}\n${line(assistant)}\n${line(plain)}\n${line(tool)}\n`);

      const records = await readTranscript(file);

      assert.deepStrictEqual(
        records,
        [user, assistant, plain],
        'a plain system record still resets the call window',
      );
    });
  });
});

describe('toHistory replay', () => {
  let n = 0;
  const ts = (): string => new Date(1_700_000_000_000 + n++ * 1000).toISOString();
  const rec = (r: Omit<TranscriptRecord, 'ts'>): TranscriptRecord => ({ ts: ts(), ...r });
  const call = (id: string) => ({ id, name: 'ask_user', arguments: '{"question":"Which?"}' });
  const card = (
    id: string,
    status: 'pending' | 'resolved',
    extra: Partial<InterventionView> = {},
  ): TranscriptRecord =>
    rec({
      role: 'system',
      content: 'Which?',
      intervention: { id, kind: 'question', prompt: 'Which?', status, ...extra },
    });

  it('keeps the tool message right after its call and the card after the tool (2026-09-30 empty-body 400)', () => {
    const records = [
      rec({ role: 'user', content: 'hi' }),
      rec({ role: 'assistant', content: '', tool_calls: [call('call_ask')] }),
      card('q1', 'resolved', { answer: { kind: 'text', text: 'the blue one' } }),
      rec({ role: 'tool', content: 'the blue one', tool_call_id: 'call_ask' }),
      rec({ role: 'assistant', content: 'ok' }),
      rec({ role: 'user', content: 'next' }),
    ];
    const out = toHistory(records);
    assert.deepStrictEqual(out, [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '', tool_calls: [call('call_ask')] },
      { role: 'tool', content: 'the blue one', tool_call_id: 'call_ask' },
      { role: 'assistant', content: '[intervention] Which?\nDecision: answered: the blue one' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'next' },
    ]);
    assert.strictEqual(out[2].role, 'tool');
  });

  it('collapses a pending/settled pair to one settled card after the window', () => {
    const out = toHistory([
      rec({ role: 'assistant', content: '', tool_calls: [call('c1'), call('c2')] }),
      rec({ role: 'tool', content: 'r1', tool_call_id: 'c1' }),
      card('p1', 'pending'),
      card('p1', 'resolved', { answer: { kind: 'declined', reason: 'no' } }),
      rec({ role: 'tool', content: 'r2', tool_call_id: 'c2' }),
      rec({ role: 'assistant', content: 'done' }),
    ]);
    assert.deepStrictEqual(
      out.map((m) => [m.role, m.content]),
      [
        ['assistant', ''],
        ['tool', 'r1'],
        ['tool', 'r2'],
        ['assistant', '[intervention] Which?\nDecision: declined (no)'],
        ['assistant', 'done'],
      ],
    );
  });

  it('replays a lone pending card as no answer recorded', () => {
    const out = toHistory([rec({ role: 'user', content: 'hi' }), card('p', 'pending')]);
    assert.strictEqual(out[1].content, '[intervention] Which?\nDecision: no answer was recorded');
  });

  it('replays plain system as assistant and maps a legacy transcript 1:1', () => {
    const records = [
      rec({ role: 'user', content: 'u' }),
      rec({ role: 'system', content: 'note' }),
      rec({ role: 'assistant', content: '', tool_calls: [call('c1')] }),
      rec({ role: 'tool', content: 'r', tool_call_id: 'c1' }),
    ];
    assert.deepStrictEqual(toHistory(records), [
      { role: 'user', content: 'u' },
      { role: 'assistant', content: 'note' },
      { role: 'assistant', content: '', tool_calls: [call('c1')] },
      { role: 'tool', content: 'r', tool_call_id: 'c1' },
    ]);
  });

  it('emits a trailing card after the last tool record', () => {
    const out = toHistory([
      rec({ role: 'assistant', content: '', tool_calls: [call('c1')] }),
      rec({ role: 'tool', content: 'r', tool_call_id: 'c1' }),
      card('q', 'resolved', { answer: { kind: 'approved' } }),
    ]);
    assert.deepStrictEqual(out.map((m) => m.role), ['assistant', 'tool', 'assistant']);
    assert.ok(out[2].content.startsWith('[intervention] '));
  });

  it('drops an orphan tool record', () => {
    const out = toHistory([
      rec({ role: 'user', content: 'u' }),
      rec({ role: 'tool', content: 'r', tool_call_id: 'zzz' }),
    ]);
    assert.deepStrictEqual(out, [{ role: 'user', content: 'u' }]);
  });

  it('property: tool messages stay adjacent to their call over random valid transcripts', () => {
    const turnArb = fc.record({
      rounds: fc.array(
        fc.record({
          calls: fc.integer({ min: 1, max: 3 }),
          cards: fc.array(
            fc.record({
              pos: fc.nat(10),
              pending: fc.boolean(),
              answer: fc.constantFrom('approved', 'declined', 'text'),
            }),
            { maxLength: 2 },
          ),
        }),
        { maxLength: 3 },
      ),
      reply: fc.boolean(),
      note: fc.boolean(),
      between: fc.array(fc.boolean(), { maxLength: 2 }),
    });
    fc.assert(
      fc.property(fc.array(turnArb, { maxLength: 5 }), (turns) => {
        n = 0;
        const records: TranscriptRecord[] = [];
        const resolvedText = new Map<string, string>();
        let cardSeq = 0;
        let toolCount = 0;
        const userTexts: string[] = [];
        const toolIds: string[] = [];
        const mkResolved = (id: string, kind: string): TranscriptRecord => {
          const answer: InterventionView['answer'] =
            kind === 'approved'
              ? { kind: 'approved' }
              : kind === 'declined'
                ? { kind: 'declined', reason: 'r' }
                : { kind: 'text', text: `t-${id}` };
          const c = card(id, 'resolved', { answer, prompt: `P ${id}` });
          resolvedText.set(id, `[intervention] P ${id}\nDecision: ${
            kind === 'approved' ? 'approved' : kind === 'declined' ? 'declined (r)' : `answered: t-${id}`
          }`);
          return c;
        };
        turns.forEach((turn, t) => {
          userTexts.push(`u${t}`);
          records.push(rec({ role: 'user', content: `u${t}` }));
          turn.rounds.forEach((round, r) => {
            const ids = Array.from({ length: round.calls }, (_, k) => `c${t}_${r}_${k}`);
            const body: TranscriptRecord[] = ids.map((id) => {
              toolIds.push(id);
              toolCount++;
              return rec({ role: 'tool', content: `res ${id}`, tool_call_id: id });
            });
            const inserts: { pos: number; recs: TranscriptRecord[] }[] = round.cards.map((c) => {
              const id = `i${cardSeq++}`;
              const recs = c.pending
                ? [card(id, 'pending', { prompt: `P ${id}` }), mkResolved(id, c.answer)]
                : [mkResolved(id, c.answer)];
              return { pos: c.pos % (body.length + 1), recs };
            });
            records.push(
              rec({ role: 'assistant', content: '', tool_calls: ids.map((id) => call(id)) }),
            );
            for (let i = 0; i <= body.length; i++) {
              for (const ins of inserts) {
                if (ins.pos === i) {
                  records.push(...ins.recs);
                }
              }
              if (i < body.length) {
                records.push(body[i]);
              }
            }
          });
          if (turn.reply) {
            records.push(rec({ role: 'assistant', content: `a${t}` }));
          }
          if (turn.note) {
            records.push(rec({ role: 'system', content: `note${t}` }));
          }
          turn.between.forEach(() => {
            records.push(mkResolved(`i${cardSeq++}`, 'approved'));
          });
        });

        const out: ChatMessage[] = toHistory(records);
        // (1) adjacency
        out.forEach((m, i) => {
          if (m.role !== 'tool') {
            return;
          }
          let j = i;
          while (j >= 0 && out[j].role === 'tool') {
            j--;
          }
          assert.ok(j >= 0 && out[j].tool_calls?.some((c) => c.id === m.tool_call_id));
        });
        // (2) no tool record lost
        assert.strictEqual(out.filter((m) => m.role === 'tool').length, toolCount);
        // (3) one message per intervention id, with the resolved decision
        const cards = out.filter((m) => m.content.startsWith('[intervention] '));
        assert.strictEqual(cards.length, resolvedText.size);
        assert.deepStrictEqual(
          cards.map((m) => m.content).sort(),
          [...resolvedText.values()].sort(),
        );
        // (4) no system role
        assert.ok(out.every((m) => (m.role as string) !== 'system'));
        // (5) order of users and tools preserved
        assert.deepStrictEqual(
          out.filter((m) => m.role === 'user').map((m) => m.content),
          userTexts,
        );
        assert.deepStrictEqual(
          out.filter((m) => m.role === 'tool').map((m) => m.tool_call_id),
          toolIds,
        );
      }),
      { numRuns: 200 },
    );
  });
});

describe('compaction records', () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length > 0) {
      fs.rmSync(dirs.pop() as string, { recursive: true, force: true });
    }
  });

  const T = (n: number): string => `2026-01-01T00:00:${String(n).padStart(2, '0')}.000Z`;
  const rec = (
    role: TranscriptRecord['role'],
    content: string,
    n: number,
    extra: Partial<TranscriptRecord> = {},
  ): TranscriptRecord => ({ ts: T(n), role, content, ...extra });
  const comp = (content: string, n: number, fromN: number, toN: number, id = 'c1'): TranscriptRecord =>
    rec('system', content, n, { compaction: { id, fromTs: T(fromN), toTs: T(toN), messages: 2 } });
  const call = (id: string) => [{ id, name: 'read', arguments: '{}' }];

  async function roundTrip(lines: unknown[]): Promise<TranscriptRecord[]> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-compaction-'));
    dirs.push(dir);
    const file = path.join(dir, 'chat.jsonl');
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf8');
    return readTranscript(file);
  }

  it('round trips a compaction record', async () => {
    const records = [rec('user', 'u1', 1), rec('assistant', 'a1', 2), comp('S', 3, 1, 2)];
    assert.deepStrictEqual(await roundTrip(records), records);
  });

  it('skips malformed compaction records and keeps neighbours', async () => {
    const good = rec('user', 'u', 1);
    const bad = [
      { ...comp('x', 2, 1, 1), compaction: { id: 'c', fromTs: T(1), toTs: T(1), messages: '2' } },
      { ...comp('x', 3, 1, 1), compaction: { id: '', fromTs: T(1), toTs: T(1), messages: 2 } },
      { ...comp('x', 4, 1, 1), compaction: { id: 'c', fromTs: T(1), messages: 2 } },
      { ...comp('x', 5, 1, 1), role: 'assistant' },
    ];
    const end = rec('assistant', 'end', 6);
    assert.deepStrictEqual(await roundTrip([good, ...bad, end]), [good, end]);
  });

  it('replays the summary once in place of the covered records', () => {
    const records = [
      rec('user', 'u1', 1),
      rec('assistant', 'a1', 2, { tool_calls: call('c1') }),
      rec('tool', 't1', 3, { tool_call_id: 'c1' }),
      rec('user', 'u2', 4),
      rec('assistant', 'a2', 5),
      rec('user', 'u3', 6),
      comp('S', 7, 1, 3),
    ];
    assert.deepStrictEqual(toHistory(records), [
      { role: 'assistant', content: '[context summary] S' },
      { role: 'user', content: 'u2' },
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'u3' },
    ]);
  });

  it('keeps tool directly after its call across an intervention card in the kept region', () => {
    const card: InterventionView = { id: 'i1', kind: 'confirm', prompt: 'ok?', status: 'resolved' };
    const records = [
      rec('user', 'u1', 1),
      rec('assistant', 'a1', 2),
      rec('user', 'u2', 3),
      rec('assistant', 'a2', 4, { tool_calls: call('c2') }),
      rec('system', 'ok?', 5, { intervention: card }),
      rec('tool', 't2', 6, { tool_call_id: 'c2' }),
      comp('S', 7, 1, 2),
    ];
    const out = toHistory(records);
    const i = out.findIndex((m) => m.role === 'tool');
    assert.strictEqual(out[i - 1].role, 'assistant');
    assert.ok(out[i - 1].tool_calls?.some((c) => c.id === 'c2'));
    assert.strictEqual(out.filter((m) => m.content.startsWith('[context summary] ')).length, 1);
  });

  it('lets a later enclosing compaction supersede an earlier one', () => {
    const records = [
      rec('user', 'u1', 1),
      rec('assistant', 'a1', 2),
      rec('user', 'u2', 3),
      comp('S1', 4, 1, 2, 'c1'),
      rec('assistant', 'a2', 5),
      rec('user', 'u3', 6),
      comp('S2', 7, 1, 5, 'c2'),
    ];
    const out = toHistory(records);
    assert.deepStrictEqual(out[0], { role: 'assistant', content: '[context summary] S2' });
    assert.strictEqual(out.filter((m) => m.content.startsWith('[context summary] ')).length, 1);
    assert.ok(!out.some((m) => m.content.includes('S1')));
    assert.deepStrictEqual(out.slice(1).map((m) => m.content), ['u3']);
  });

  it('emits the summary at its own position when it covers nothing', () => {
    const records = [rec('user', 'u1', 5), comp('S', 6, 1, 2)];
    assert.deepStrictEqual(toHistory(records), [
      { role: 'user', content: 'u1' },
      { role: 'assistant', content: '[context summary] S' },
    ]);
  });

  it('does not hide a later record sharing the range end timestamp', () => {
    const records = [rec('user', 'u1', 1), comp('S', 2, 1, 2), rec('user', 'late', 2)];
    assert.deepStrictEqual(toHistory(records).map((m) => m.content), ['[context summary] S', 'late']);
  });

  it('compactionCut finds the keepTurns-th user from the end, or refuses', () => {
    const base = [rec('user', 'u1', 1), rec('assistant', 'a1', 2), rec('user', 'u2', 3), rec('assistant', 'a2', 4), rec('user', 'u3', 5)];
    assert.strictEqual(compactionCut(base, 2), 2);
    assert.strictEqual(compactionCut([rec('user', 'u', 1)], 2), undefined);
    assert.strictEqual(compactionCut(base.slice(2), 2), undefined, 'cut at index 0');
    const collide = [rec('user', 'u1', 1), rec('assistant', 'a1', 2), rec('user', 'u2', 2), rec('user', 'u3', 3)];
    assert.strictEqual(compactionCut(collide, 2), undefined);
  });

  it('property: tool messages stay adjacent and exactly one summary is emitted', () => {
    const turnArb = fc.record({
      calls: fc.integer({ min: 0, max: 2 }),
      card: fc.boolean(),
    });
    fc.assert(
      fc.property(fc.array(turnArb, { minLength: 2, maxLength: 6 }), fc.nat(), (turns, pick) => {
        const records: TranscriptRecord[] = [];
        let n = 0;
        const userIdx: number[] = [];
        turns.forEach((t, ti) => {
          userIdx.push(records.length);
          records.push(rec('user', `u${ti}`, n++));
          if (t.calls > 0) {
            const ids = Array.from({ length: t.calls }, (_, k) => `c${ti}-${k}`);
            records.push(rec('assistant', `a${ti}`, n++, { tool_calls: ids.map((id) => ({ id, name: 'r', arguments: '{}' })) }));
            ids.forEach((id, k) => {
              if (t.card && k === 0) {
                records.push(rec('system', 'ask', n++, { intervention: { id: `i${ti}`, kind: 'confirm', prompt: 'ask', status: 'resolved' } }));
              }
              records.push(rec('tool', 'r', n++, { tool_call_id: id }));
            });
          }
          records.push(rec('assistant', `f${ti}`, n++));
        });
        // Compaction appended after user `k` (k >= 1), covering everything before it.
        const k = 1 + (pick % (turns.length - 1));
        const at = userIdx[k];
        const c: TranscriptRecord = {
          ts: T(n++),
          role: 'system',
          content: 'S',
          compaction: { id: 'c', fromTs: records[0].ts, toTs: records[at - 1].ts, messages: at },
        };
        records.splice(at + 1, 0, c);
        const out = toHistory(records);
        out.forEach((m, i) => {
          if (m.role !== 'tool') {
            return;
          }
          let j = i - 1;
          while (j >= 0 && out[j].role === 'tool') {
            j--;
          }
          assert.ok(j >= 0 && out[j].role === 'assistant' && out[j].tool_calls?.some((x) => x.id === m.tool_call_id));
        });
        assert.strictEqual(out.filter((m) => m.content.startsWith('[context summary] ')).length, 1);
      }),
      { numRuns: 100 },
    );
  });
});
