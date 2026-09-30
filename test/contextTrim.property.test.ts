import * as assert from 'assert';
import * as fc from 'fast-check';
import { trimHistory, trimmedResultStub } from '../src/orchestrator/contextTrim';
import { estimateMessages } from '../src/orchestrator/contextBudget';
import type { ChatMessage } from '../src/orchestrator/modelClient';

/** Property: trimming never breaks tool pairing and never grows the estimate. */

interface RoundSpec { calls: number[]; final: boolean }
interface TurnSpec { rounds: RoundSpec[]; final: boolean; intervention: boolean }

const roundArb = fc.record({
  calls: fc.array(fc.integer({ min: 0, max: 6000 }), { minLength: 1, maxLength: 3 }),
  final: fc.boolean(),
});
const turnArb = fc.record({
  rounds: fc.array(roundArb, { maxLength: 4 }),
  final: fc.boolean(),
  intervention: fc.boolean(),
});
const specArb = fc.record({
  turns: fc.array(turnArb, { minLength: 1, maxLength: 5 }),
  autoMask: fc.array(fc.boolean(), { minLength: 20, maxLength: 20 }),
  targetFrac: fc.double({ min: 0, max: 1, noNaN: true }),
});

function build(turns: TurnSpec[], autoMask: boolean[]): { history: ChatMessage[]; auto: Set<string> } {
  const history: ChatMessage[] = [];
  const auto = new Set<string>();
  let n = 0;
  let iv = 0;
  turns.forEach((t, ti) => {
    history.push({ role: 'user', content: `turn ${ti}` });
    for (const r of t.rounds) {
      const ids = r.calls.map(() => `c${n++}`);
      history.push({
        role: 'assistant',
        content: '',
        tool_calls: ids.map((id) => ({ id, name: 'read_file', arguments: '{}' })),
      });
      r.calls.forEach((bytes, i) => {
        history.push({ role: 'tool', content: 'x'.repeat(bytes), tool_call_id: ids[i] });
      });
      if (r.final) {
        history.push({ role: 'assistant', content: 'note' });
      }
    }
    if (t.intervention) {
      const line = `[intervention] p${iv}\nDecision: approved`;
      if (autoMask[iv % autoMask.length]) {
        auto.add(line);
      }
      iv += 1;
      history.push({ role: 'assistant', content: line });
    }
    if (t.final) {
      history.push({ role: 'assistant', content: 'done' });
    }
  });
  return { history, auto };
}

function pairing(out: readonly ChatMessage[]): void {
  for (let i = 0; i < out.length; i += 1) {
    const m = out[i];
    if (m.tool_calls !== undefined && m.tool_calls.length > 0) {
      const ids = m.tool_calls.map((c) => c.id);
      const answers = out.slice(i + 1, i + 1 + ids.length);
      assert.deepStrictEqual(answers.map((a) => a.tool_call_id), ids);
      assert.ok(answers.every((a) => a.role === 'tool'));
    }
    if (m.role === 'tool') {
      let j = i - 1;
      while (j >= 0 && out[j].role === 'tool') { j -= 1; }
      assert.ok(j >= 0 && (out[j].tool_calls ?? []).some((c) => c.id === m.tool_call_id));
    }
  }
}

describe('trimHistory property', () => {
  it('keeps pairing, never grows, never mutates, only drops auto lines', () => {
    fc.assert(
      fc.property(specArb, ({ turns, autoMask, targetFrac }) => {
        const { history, auto } = build(turns, autoMask);
        const before = JSON.stringify(history);
        const full = estimateMessages(history);
        const target = Math.floor(full * targetFrac);
        const out = trimHistory(history, { targetTokens: target, autoApprovedLines: auto });

        assert.strictEqual(JSON.stringify(history), before); // (c)
        pairing(out); // (a)
        assert.ok(estimateMessages(out) <= full); // (b)
        assert.ok(out.length <= history.length);

        const keep = (m: ChatMessage): boolean => m.role === 'user' || (m.tool_calls ?? []).length > 0;
        assert.deepStrictEqual(out.filter(keep), history.filter(keep)); // (d)

        // (e) removed messages are all auto-approved lines
        const remaining = [...out.map((m) => m.role + '\u0000' + m.content)];
        let removed = 0;
        for (const m of history) {
          if (m.role === 'tool') { continue; }
          const k = m.role + '\u0000' + m.content;
          const idx = remaining.indexOf(k);
          if (idx >= 0) { remaining.splice(idx, 1); } else {
            removed += 1;
            assert.ok(m.role === 'assistant' && auto.has(m.content));
          }
        }
        void removed;

        // (f) still above target => every earlier-turn result with a shorter stub is stubbed
        if (estimateMessages(out) > target) {
          const users = out.reduce<number[]>((a, m, i) => (m.role === 'user' ? [...a, i] : a), []);
          const prevStart = users.length >= 2 ? users[users.length - 2] : 0;
          const owner = new Map<string, string>();
          out.forEach((m) => (m.tool_calls ?? []).forEach((c) => owner.set(c.id, c.name)));
          out.slice(0, prevStart).forEach((m) => {
            if (m.role === 'tool') {
              const id = m.tool_call_id ?? '';
              const bytes = Buffer.byteLength(m.content, 'utf8');
              const s = trimmedResultStub(owner.get(id) ?? 'unknown', bytes, id);
              assert.ok(Buffer.byteLength(s, 'utf8') >= bytes || m.content === s || /^\[trimmed /.test(m.content));
            }
          });
        }
      }),
      { numRuns: 200 },
    );
  });
});
