import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  CONTEXT_WINDOW_SETTING,
  ContextTracker,
  MESSAGE_OVERHEAD_TOKENS,
  USAGE_IN_STREAM_SETTING,
  contextOverflowNotice,
  fitToWindow,
  resolveOutputReserve,
  estimateMessages,
  estimateTokens,
  resolveContextWindow,
} from '../src/orchestrator/contextBudget';
import type { ChatMessage, ToolSpec } from '../src/orchestrator/modelClient';

describe('orchestrator/contextBudget', () => {
  describe('resolveContextWindow', () => {
    it('prefers the catalog entry', () => {
      assert.strictEqual(resolveContextWindow({ id: 'm', contextWindow: 200000 }, 64000), 200000);
    });

    it('falls back to the setting', () => {
      assert.strictEqual(resolveContextWindow({ id: 'm' }, 64000), 64000);
      assert.strictEqual(resolveContextWindow(undefined, 131072), 131072);
    });

    it('is undefined when nothing is usable', () => {
      assert.strictEqual(resolveContextWindow(undefined, 0), undefined);
      assert.strictEqual(resolveContextWindow({ id: 'm' }, undefined), undefined);
      for (const bad of [0, -5, 1.5, NaN, Infinity, '64000', null, {}]) {
        assert.strictEqual(resolveContextWindow({ id: 'm' }, bad), undefined);
      }
    });

    it('a bad catalog value falls through to the setting', () => {
      assert.strictEqual(resolveContextWindow({ id: 'm', contextWindow: 0 }, 32000), 32000);
    });
  });

  describe('setting', () => {
    it('is contributed by package.json as an integer defaulting to 0', () => {
      assert.strictEqual(CONTEXT_WINDOW_SETTING, 'baiton.orchestrator.contextWindow');
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
        contributes: { configuration: { properties: Record<string, { type?: string; default?: unknown }> } };
      };
      const prop = pkg.contributes.configuration.properties[CONTEXT_WINDOW_SETTING];
      assert.strictEqual(prop?.type, 'integer');
      assert.strictEqual(prop?.default, 0);
    });
  });

  describe('usageInStream setting', () => {
    it('is contributed by package.json as a boolean defaulting to true', () => {
      assert.strictEqual(USAGE_IN_STREAM_SETTING, 'baiton.orchestrator.usageInStream');
      const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')) as {
        contributes: { configuration: { properties: Record<string, { type?: string; default?: unknown }> } };
      };
      const prop = pkg.contributes.configuration.properties[USAGE_IN_STREAM_SETTING];
      assert.strictEqual(prop?.type, 'boolean');
      assert.strictEqual(prop?.default, true);
    });
  });

  describe('estimateTokens', () => {
    it('is ceil(utf8 bytes / 4)', () => {
      assert.strictEqual(estimateTokens(''), 0);
      assert.strictEqual(estimateTokens('abcd'), 1);
      assert.strictEqual(estimateTokens('abcde'), 2);
      assert.strictEqual(estimateTokens('é'.repeat(4)), 2);
    });
  });

  describe('estimateMessages', () => {
    const user: ChatMessage[] = [{ role: 'user', content: 'abcd' }];

    it('adds per-message overhead to the content estimate', () => {
      assert.strictEqual(estimateMessages(user), MESSAGE_OVERHEAD_TOKENS + 1);
    });

    it('counts tool_calls arguments', () => {
      const args = '{"path":"a/very/long/path/name.txt"}';
      const withCall: ChatMessage[] = [
        ...user,
        { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'read_file', arguments: args }] },
      ];
      assert.ok(estimateMessages(withCall) - estimateMessages(user) >= estimateTokens(args));
    });

    it('counts each tool spec', () => {
      const tools: ToolSpec[] = [
        { name: 'a', description: 'first tool', parameters: { type: 'object' } },
        { name: 'b', description: 'second tool', parameters: { type: 'object', properties: {} } },
      ];
      const expected = tools.reduce(
        (n, t) => n + estimateTokens(JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters })),
        0,
      );
      assert.strictEqual(estimateMessages(user, tools) - estimateMessages(user), expected);
    });

    it('does not throw without tools', () => {
      assert.doesNotThrow(() => estimateMessages(user));
    });
  });

  describe('ContextTracker', () => {
    const sent = {
      messages: [{ role: 'user', content: 'hello world' }] as ChatMessage[],
      tools: [{ name: 't', description: 'd', parameters: {} }] as ToolSpec[],
    };

    it('starts empty with no window', () => {
      assert.deepStrictEqual(new ContextTracker().status(), { loaded: 0, source: 'estimate' });
    });

    it('prefers reported usage', () => {
      const t = new ContextTracker();
      t.record(sent, { usage: { promptTokens: 321, completionTokens: 5 } });
      assert.deepStrictEqual(t.status(), { loaded: 321, source: 'usage' });
    });

    it('falls back to the estimate without usage', () => {
      const t = new ContextTracker();
      t.record(sent, {});
      assert.deepStrictEqual(t.status(), {
        loaded: estimateMessages(sent.messages, sent.tools),
        source: 'estimate',
      });
    });

    it('reports window and ratio when the window is known', () => {
      const t = new ContextTracker(() => 1000);
      t.record(sent, { usage: { promptTokens: 250, completionTokens: 0 } });
      const s = t.status();
      assert.strictEqual(s.window, 1000);
      assert.strictEqual(s.ratio, 0.25);
    });

    it('omits window and ratio when the window is 0 or undefined', () => {
      for (const w of [0, undefined]) {
        const t = new ContextTracker(() => w);
        t.record(sent, { usage: { promptTokens: 250, completionTokens: 0 } });
        const s = t.status();
        assert.ok(!('window' in s));
        assert.ok(!('ratio' in s));
      }
    });

    it('switches back to estimate when a later record has no usage', () => {
      const t = new ContextTracker();
      t.record(sent, { usage: { promptTokens: 10, completionTokens: 1 } });
      assert.strictEqual(t.status().source, 'usage');
      t.record(sent, {});
      assert.strictEqual(t.status().source, 'estimate');
    });

    it('reset returns to the initial status', () => {
      const t = new ContextTracker();
      t.record(sent, { usage: { promptTokens: 10, completionTokens: 1 } });
      t.reset();
      assert.deepStrictEqual(t.status(), { loaded: 0, source: 'estimate' });
    });
  });

  describe('host-free', () => {
    it('the module source contains no vscode import', () => {
      const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'orchestrator', 'contextBudget.ts'), 'utf8');
      assert.ok(!/from '.*vscode'/.test(source), 'contextBudget.ts must not import vscode');
      assert.ok(!/require\(.*vscode/.test(source), 'contextBudget.ts must not require vscode');
    });
  });

  describe('resolveOutputReserve', () => {
    it('picks max_tokens, then maxOutput, then 8192', () => {
      assert.strictEqual(resolveOutputReserve(4096, 9999), 4096);
      assert.strictEqual(resolveOutputReserve(0, 9999), 9999);
      assert.strictEqual(resolveOutputReserve(undefined, undefined), 8192);
      assert.strictEqual(resolveOutputReserve('x', 1.5), 8192);
    });
  });

  describe('contextOverflowNotice', () => {
    it('sizes the notice', () => {
      assert.strictEqual(
        contextOverflowNotice(5, 10),
        "The conversation exceeds the model's context window (~5 of 10 tokens); compact it or start a new chat.",
      );
    });
  });

  describe('fitToWindow', () => {
    // 'x'.repeat(n) content costs ceil(n/4) + 4 tokens.
    const msg = (role: ChatMessage['role'], n: number): ChatMessage => ({ role, content: 'x'.repeat(n) });
    const sys = msg('system', 40); // 14
    const big = msg('user', 4000); // 1004
    const small = msg('user', 40); // 14
    const harness = (over: { window?: number; reserve?: number; trimmed?: ChatMessage[]; summary?: ChatMessage[] | undefined; messages?: ChatMessage[] }) => {
      const calls = { trim: 0, summarise: 0 };
      const opts = {
        messages: over.messages ?? [sys, big],
        history: [big],
        window: 'window' in over ? over.window : 500,
        reserve: over.reserve ?? 100,
        trim: (h: readonly ChatMessage[]) => {
          calls.trim += 1;
          return over.trimmed ?? [...h];
        },
        summarise: async () => {
          calls.summarise += 1;
          return over.summary;
        },
      };
      return { opts, calls };
    };

    it('sends unchanged when the window is unknown', async () => {
      const { opts, calls } = harness({ window: undefined });
      const v = await fitToWindow(opts);
      assert.deepStrictEqual(v, { kind: 'send', messages: [sys, big] });
      assert.deepStrictEqual(calls, { trim: 0, summarise: 0 });
    });

    it('sends unchanged when the payload fits', async () => {
      const { opts, calls } = harness({ window: 2000, messages: [sys, big] });
      const v = await fitToWindow(opts);
      assert.deepStrictEqual(v, { kind: 'send', messages: [sys, big] });
      assert.deepStrictEqual(calls, { trim: 0, summarise: 0 });
    });

    it('sends the trimmed history when trim is enough', async () => {
      const { opts, calls } = harness({ trimmed: [small] });
      const v = await fitToWindow(opts);
      assert.deepStrictEqual(v, { kind: 'send', messages: [sys, small] });
      assert.deepStrictEqual(calls, { trim: 1, summarise: 0 });
    });

    it('summarises when trim is not enough', async () => {
      const { opts, calls } = harness({ summary: [small] });
      const v = await fitToWindow(opts);
      assert.deepStrictEqual(v, { kind: 'send', messages: [sys, small], history: [small] });
      assert.strictEqual(calls.summarise, 1);
    });

    it('overflows with the trimmed estimate when summarise yields nothing', async () => {
      const { opts } = harness({ summary: undefined });
      const v = await fitToWindow(opts);
      assert.deepStrictEqual(v, { kind: 'overflow', estimate: estimateMessages([sys, big]), window: 500 });
    });

    it('overflows when the summary is still too big', async () => {
      const { opts } = harness({ summary: [big] });
      const v = await fitToWindow(opts);
      assert.strictEqual(v.kind, 'overflow');
      assert.strictEqual(v.kind === 'overflow' ? v.estimate : 0, estimateMessages([sys, big]));
    });
  });
});
