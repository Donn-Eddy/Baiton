import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  CONTEXT_WINDOW_SETTING,
  ContextTracker,
  MESSAGE_OVERHEAD_TOKENS,
  USAGE_IN_STREAM_SETTING,
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
});
