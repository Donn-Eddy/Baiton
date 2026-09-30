import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { CONTEXT_WINDOW_SETTING, resolveContextWindow } from '../src/orchestrator/contextBudget';

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

  describe('host-free', () => {
    it('the module source contains no vscode import', () => {
      const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'orchestrator', 'contextBudget.ts'), 'utf8');
      assert.ok(!/from '.*vscode'/.test(source), 'contextBudget.ts must not import vscode');
      assert.ok(!/require\(.*vscode/.test(source), 'contextBudget.ts must not require vscode');
    });
  });
});
