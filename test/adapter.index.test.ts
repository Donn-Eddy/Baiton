import * as assert from 'assert';
import { agentCapabilities, createAdapterRegistry } from '../src/adapter';
import { AGENT_BINARY } from '../src/adapter/adapter';
import { defaultConfig } from '../src/config/defaultConfig';

/**
 * Unit tests for agentCapabilities() exported from src/adapter/index.ts (config-panel T10).
 *
 * Verifies that the adapter capability catalogue:
 * - shares its key set with createAdapterRegistry().ids and AGENT_BINARY (drift guard);
 * - exposes non-empty, non-blank, duplicate-free models and efforts for claude, antigravity, and codex;
 * - exposes the free-text shape (empty models, empty efforts, non-empty modelLink) for opencode;
 * - contains defaultConfig()'s model and effort under claude;
 * - returns fresh, non-aliased copies on every call.
 */
describe('agentCapabilities', () => {
  it('has exactly one entry per registry id and per AGENT_BINARY key', () => {
    const caps = agentCapabilities();
    const registryIds = createAdapterRegistry().ids;
    const binaryKeys = Object.keys(AGENT_BINARY);

    assert.deepStrictEqual(Object.keys(caps).sort(), [...registryIds].sort());
    assert.deepStrictEqual(Object.keys(caps).sort(), [...binaryKeys].sort());
  });

  it('claude, antigravity, and codex expose non-empty models and efforts with no duplicates and no blanks', () => {
    const caps = agentCapabilities();
    const closedAgents = ['claude', 'antigravity', 'codex'] as const;

    for (const agent of closedAgents) {
      const entry = caps[agent];
      assert.ok(entry, `missing entry for ${agent}`);
      assert.ok(entry.models.length > 0, `${agent} models must not be empty`);
      assert.ok(entry.efforts.length > 0, `${agent} efforts must not be empty`);
      assert.strictEqual(entry.modelLink, undefined, `${agent} should not have modelLink`);

      // No blanks or empty strings
      for (const model of entry.models) {
        assert.ok(typeof model === 'string' && model.trim().length > 0, `${agent} has blank model`);
      }
      for (const effort of entry.efforts) {
        assert.ok(typeof effort === 'string' && effort.trim().length > 0, `${agent} has blank effort`);
      }

      // No duplicates
      assert.strictEqual(new Set(entry.models).size, entry.models.length, `${agent} has duplicate models`);
      assert.strictEqual(new Set(entry.efforts).size, entry.efforts.length, `${agent} has duplicate efforts`);
    }
  });

  it('opencode exposes empty models and efforts and a non-empty modelLink', () => {
    const caps = agentCapabilities();
    const entry = caps.opencode;

    assert.ok(entry, 'missing opencode capability entry');
    assert.deepStrictEqual(entry.models, [], 'opencode models must be empty (free-text shape)');
    assert.deepStrictEqual(entry.efforts, [], 'opencode efforts must be empty (free-text shape)');
    assert.ok(
      typeof entry.modelLink === 'string' && entry.modelLink.startsWith('https://'),
      'opencode modelLink must be a non-empty documentation URL',
    );
  });

  it("defaultConfig()'s model and effort are members of the claude lists", () => {
    const config = defaultConfig();
    const caps = agentCapabilities();
    const claudeCaps = caps.claude;

    const sampleRole = config.roles.executor;
    assert.strictEqual(sampleRole.agent, 'claude');
    assert.ok(
      claudeCaps.models.includes(sampleRole.model),
      `defaultConfig model "${sampleRole.model}" must be in claude models table: ${JSON.stringify(claudeCaps.models)}`,
    );
    assert.ok(
      sampleRole.effort !== undefined && claudeCaps.efforts.includes(sampleRole.effort),
      `defaultConfig effort "${sampleRole.effort}" must be in claude efforts table: ${JSON.stringify(claudeCaps.efforts)}`,
    );
  });

  it('two calls return equal but non-aliased objects with independent arrays', () => {
    const first = agentCapabilities();
    const second = agentCapabilities();

    assert.deepStrictEqual(first, second);
    assert.notStrictEqual(first, second);

    for (const key of Object.keys(first) as (keyof typeof first)[]) {
      assert.notStrictEqual(first[key], second[key]);
      assert.notStrictEqual(first[key].models, second[key].models);
      assert.notStrictEqual(first[key].efforts, second[key].efforts);

      // Mutating first must not affect second
      (first[key].models as string[]).push('mutated-model');
      (first[key].efforts as string[]).push('mutated-effort');
      assert.ok(!second[key].models.includes('mutated-model'));
      assert.ok(!second[key].efforts.includes('mutated-effort'));
    }
  });
});
