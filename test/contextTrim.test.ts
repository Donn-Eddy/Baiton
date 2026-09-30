import * as assert from 'assert';
import {
  TRIM_LARGE_RESULT_BYTES,
  autoApprovedInterventionLines,
  resolveContextTrimAt,
  trimHistory,
  trimmedResultStub,
} from '../src/orchestrator/contextTrim';
import { estimateMessages } from '../src/orchestrator/contextBudget';
import { interventionHistoryText } from '../src/orchestrator/transcriptReader';
import type { ChatMessage } from '../src/orchestrator/modelClient';
import type { TranscriptRecord } from '../src/orchestrator/chatTranscript';
import type { InterventionView } from '../src/orchestrator/webviewProtocol';

const user = (t: string): ChatMessage => ({ role: 'user', content: t });
const asst = (t: string): ChatMessage => ({ role: 'assistant', content: t });
const asstCalls = (...ids: string[]): ChatMessage => ({
  role: 'assistant',
  content: '',
  tool_calls: ids.map((id) => ({ id, name: 'read_file', arguments: '{}' })),
});
const tool = (id: string, bytes: number): ChatMessage => ({
  role: 'tool',
  content: 'x'.repeat(bytes),
  tool_call_id: id,
});
const stub = (id: string, bytes: number): string => trimmedResultStub('read_file', bytes, id);

function view(id: string, prompt: string, auto: boolean): InterventionView {
  return {
    id,
    kind: 'permission',
    prompt,
    status: 'resolved',
    answer: { kind: 'approved' },
    ...(auto ? { auto: true } : {}),
  };
}

describe('trimHistory', () => {
  it('returns an equal copy without mutating when under target', () => {
    const history = [user('a'), asstCalls('c1'), tool('c1', 5000), asst('ok')];
    const before = JSON.stringify(history);
    const out = trimHistory(history, { targetTokens: 1_000_000 });
    assert.deepStrictEqual(out, history);
    assert.notStrictEqual(out, history);
    assert.strictEqual(JSON.stringify(history), before);
  });

  it('pass 1 drops only auto-approved intervention lines and stops once satisfied', () => {
    const autoLine = interventionHistoryText(view('a', 'Run ls', true));
    const manualLine = interventionHistoryText(view('b', 'Run pwd', false));
    const records: TranscriptRecord[] = [
      { role: 'system', content: 'Run ls', intervention: view('a', 'Run ls', true), ts: 't' } as TranscriptRecord,
    ];
    const lines = autoApprovedInterventionLines(records);
    const history = [
      user('u1'), asstCalls('c1'), tool('c1', 4000), asst('r1'),
      asst(autoLine), asst(manualLine),
      user('u2'), asst('r2'),
    ];
    const target = estimateMessages(history) - 5;
    const out = trimHistory(history, { targetTokens: target, autoApprovedLines: lines });
    assert.strictEqual(out.length, history.length - 1);
    assert.ok(!out.some((m) => m.content === autoLine));
    assert.ok(out.some((m) => m.content === manualLine));
    assert.strictEqual(out.find((m) => m.role === 'tool')?.content.length, 4000);
  });

  it('autoApprovedInterventionLines uses the settled view', () => {
    const pending = { ...view('a', 'P', true), status: 'pending' as const };
    const records = [
      { role: 'system', content: 'P', intervention: pending, ts: 't' },
      { role: 'system', content: 'P', intervention: view('a', 'P', true), ts: 't' },
      { role: 'system', content: 'Q', intervention: view('b', 'Q', false), ts: 't' },
    ] as TranscriptRecord[];
    const lines = autoApprovedInterventionLines(records);
    assert.ok(lines.has(interventionHistoryText(view('a', 'P', true))));
    assert.ok(!lines.has(interventionHistoryText(view('b', 'Q', false))));
  });

  function threeTurns(): ChatMessage[] {
    return [
      user('u1'), asstCalls('c1'), tool('c1', 4000), asst('r1'),
      user('u2'), asstCalls('c2'), tool('c2', 4000), asst('r2'),
      user('u3'), asstCalls('c3'), tool('c3', 4000), asst('r3'),
    ];
  }

  it('pass 2 stubs earlier-turn results exactly and keeps pairing', () => {
    const history = threeTurns();
    const target = estimateMessages(history) - 500;
    const out = trimHistory(history, { targetTokens: target });
    assert.strictEqual(out[2].content, stub('c1', 4000));
    assert.strictEqual(out[2].tool_call_id, 'c1');
    assert.deepStrictEqual(out[1], history[1]);
    assert.strictEqual(out[6].content.length, 4000);
    assert.strictEqual(out[10].content.length, 4000);
  });

  it('stubs oldest first', () => {
    const history = [
      user('u1'), asstCalls('c1'), tool('c1', 4000),
      user('u2'), asstCalls('c2'), tool('c2', 4000),
      user('u3'), asstCalls('c3'), tool('c3', 4000),
      user('u4'), asst('r'),
    ];
    const target = estimateMessages(history) - 500;
    const out = trimHistory(history, { targetTokens: target });
    assert.strictEqual(out[2].content, stub('c1', 4000));
    assert.strictEqual(out[5].content.length, 4000);
  });

  it('pass 3 stubs large results of older rounds only', () => {
    const history: ChatMessage[] = [user('u')];
    for (let i = 1; i <= 4; i += 1) {
      history.push(asstCalls(`c${i}`), tool(`c${i}`, i === 2 ? 100 : 4000));
    }
    const out = trimHistory(history, { targetTokens: 0 });
    assert.strictEqual(out[2].content, stub('c1', 4000));
    assert.strictEqual(out[4].content.length, 100);
    assert.strictEqual(out[6].content.length, 4000);
    assert.strictEqual(out[8].content.length, 4000);
    assert.ok(100 < TRIM_LARGE_RESULT_BYTES);
  });

  it('protects the previous turn entirely', () => {
    const history = [
      user('u0'), asstCalls('c1'), tool('c1', 4000),
      user('u1'), asstCalls('c2'), tool('c2', 4000),
      user('u2'),
      asstCalls('c3'), tool('c3', 4000), asstCalls('c4'), tool('c4', 4000), asstCalls('c5'), tool('c5', 4000),
    ];
    const out = trimHistory(history, { targetTokens: 0 });
    assert.strictEqual(out[2].content, stub('c1', 4000));
    assert.strictEqual(out[5].content.length, 4000);
  });

  it('never grows a result and is idempotent', () => {
    const history = [
      user('u1'), asstCalls('c1'), tool('c1', 5), asstCalls('c2'), tool('c2', 4000),
      user('u2'), user('u3'), asst('r'),
    ];
    const once = trimHistory(history, { targetTokens: 0 });
    assert.strictEqual(once[2].content.length, 5);
    assert.strictEqual(once[4].content, stub('c2', 4000));
    assert.deepStrictEqual(trimHistory(once, { targetTokens: 0 }), once);
  });

  it('uses "unknown" for an unmatched call id', () => {
    const history = [user('u1'), tool('zz', 4000), user('u2'), user('u3')];
    const out = trimHistory(history, { targetTokens: 0 });
    assert.strictEqual(out[1].content, trimmedResultStub('unknown', 4000, 'zz'));
  });
});

describe('resolveContextTrimAt', () => {
  it('accepts (0, 1] numbers and defaults otherwise', () => {
    assert.strictEqual(resolveContextTrimAt(0.7), 0.7);
    assert.strictEqual(resolveContextTrimAt(1), 1);
    for (const bad of [0, -1, 1.5, NaN, '0.6', undefined]) {
      assert.strictEqual(resolveContextTrimAt(bad), 0.5);
    }
  });
});

describe('trimmedResultStub', () => {
  it('has the exact format', () => {
    assert.strictEqual(trimmedResultStub('x', 10, 'c1'), '[trimmed x result: 10 bytes; call c1]');
  });
});
