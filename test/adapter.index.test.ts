import * as assert from 'assert';
import {
  agentCapabilities,
  askRelayKind,
  builtinAgentCapabilities,
  createAdapterRegistry,
  usesConfigDrivenAskRelay,
} from '../src/adapter';
import { ANTIGRAVITY_MODELS } from '../src/adapter/antigravity';
import { CODEX_EFFORTS } from '../src/adapter/codex';
import { CLAUDE_EFFORTS } from '../src/adapter/claude';
import { OPENCODE_MODEL_DOC_URL } from '../src/adapter/opencode';
import {
  AGENT_BINARY,
  AGENT_CATALOG_SOURCE,
  capabilitiesFromEntries,
  capabilitiesToCatalogFetch,
} from '../src/adapter/adapter';
import { defaultConfig } from '../src/config/defaultConfig';
import { isCatalogSourceId } from '../src/orchestrator/modelCatalog';
import type {
  CatalogSourceId,
  ModelCatalogSnapshot,
  ModelCatalogTable,
  ModelEntry,
} from '../src/orchestrator/modelCatalog';

/** Build a live {@link ModelCatalogSnapshot} fixture with the given model list. */
function snap(
  sourceId: CatalogSourceId,
  models: readonly (string | ModelEntry)[],
  extra: Partial<ModelCatalogSnapshot> = {},
): ModelCatalogSnapshot {
  return {
    sourceId,
    models: models.map((m) => (typeof m === 'string' ? { id: m } : m)),
    fetchedAt: '2026-01-02T03:04:05.000Z',
    source: 'live',
    stale: false,
    ...extra,
  };
}

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

/**
 * The probe-derived ask-relay selection (chat-interventions-auto-mode T18,
 * T21, T22): claude (argv-installed hook), antigravity (launcher-written
 * run-dir `hooks.json`) and codex (argv-installed `PermissionRequest` hook)
 * have a verified native hook; opencode — and any unknown agent id — take
 * the config-driven fallback.
 */
describe('askRelayKind selection', () => {
  it('returns native for claude, antigravity and codex and config-driven for opencode', () => {
    assert.strictEqual(askRelayKind('claude'), 'native');
    assert.strictEqual(askRelayKind('opencode'), 'config-driven');
    assert.strictEqual(askRelayKind('antigravity'), 'native');
    assert.strictEqual(askRelayKind('codex'), 'native');
  });

  it('resolves an unknown agent id to the conservative config-driven default', () => {
    assert.strictEqual(askRelayKind('future-cli'), 'config-driven');
  });

  it('usesConfigDrivenAskRelay mirrors askRelayKind', () => {
    assert.ok(!usesConfigDrivenAskRelay('claude'));
    assert.ok(!usesConfigDrivenAskRelay('antigravity'));
    assert.ok(!usesConfigDrivenAskRelay('codex'));
    for (const agent of ['opencode', 'future-cli']) {
      assert.ok(usesConfigDrivenAskRelay(agent), `${agent} uses the config-driven fallback`);
    }
  });
});

/**
 * The snapshot overlay (model-selector-refresh T03): `agentCapabilities(table)`
 * overlays the refreshed per-source lists onto the curated builtin table while
 * antigravity stays untouched, `claude-sonnet-5` always remains selectable for
 * claude, an empty refreshed list never wipes a curated one, and staleness
 * metadata is carried through. The no-argument path stays byte-identical to
 * the pre-T03 behaviour (no metadata keys, fresh non-aliased arrays).
 */
describe('agentCapabilities snapshot overlay', () => {
  it('no argument returns the builtin table with no optional metadata keys', () => {
    const caps = agentCapabilities();
    assert.deepStrictEqual(caps, builtinAgentCapabilities());
    for (const [agent, entry] of Object.entries(caps)) {
      for (const key of ['modelEntries', 'source', 'stale', 'staleReason', 'fetchedAt']) {
        assert.strictEqual(
          Object.prototype.hasOwnProperty.call(entry, key),
          false,
          `${agent} must not carry a ${key} key on the no-snapshot path`,
        );
      }
    }
  });

  it('an empty snapshot table equals the no-argument result', () => {
    assert.deepStrictEqual(agentCapabilities({}), agentCapabilities());
  });

  it('a claude snapshot overlays the list in order and carries the metadata', () => {
    const claude = agentCapabilities({
      claude: snap('claude', ['claude-opus-5-5', 'claude-sonnet-5']),
    }).claude;
    assert.deepStrictEqual(claude.models, ['claude-opus-5-5', 'claude-sonnet-5']);
    assert.strictEqual(claude.source, 'live');
    assert.strictEqual(claude.stale, false);
    assert.strictEqual(claude.fetchedAt, '2026-01-02T03:04:05.000Z');
    assert.deepStrictEqual(claude.efforts, [...CLAUDE_EFFORTS]);
    assert.ok(claude.modelEntries, 'claude overlay must carry modelEntries');
    assert.strictEqual(claude.modelEntries.length, claude.models.length);
  });

  it('claude-sonnet-5 is always present exactly once', () => {
    const without = agentCapabilities({ claude: snap('claude', ['claude-opus-5-5']) }).claude;
    assert.strictEqual(without.models[without.models.length - 1], 'claude-sonnet-5');
    assert.strictEqual(without.modelEntries?.[without.modelEntries.length - 1].custom, true);

    const withDefault = agentCapabilities({
      claude: snap('claude', ['claude-sonnet-5', 'claude-opus-5-5']),
    }).claude;
    assert.strictEqual(withDefault.models.filter((m) => m === 'claude-sonnet-5').length, 1);
  });

  it('a claude snapshot carrying per-model efforts (the local catalog) uses the union, not the builtin list', () => {
    const entries: ModelEntry[] = [
      { id: 'claude-opus-5-5', efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defaultEffort: 'medium' },
      { id: 'claude-sonnet-5', efforts: ['low', 'high'], defaultEffort: 'high' },
    ];
    const claude = agentCapabilities({ claude: snap('claude', entries) }).claude;
    // The union of the entries' own levels, not the snapshot-less builtin path.
    assert.deepStrictEqual(claude.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
    assert.strictEqual(claude.modelEntries?.[0].defaultEffort, 'medium');
    assert.deepStrictEqual([...(claude.modelEntries?.[1].efforts ?? [])], ['low', 'high']);
  });

  it('the builtin claude table exposes the corrected curated ids and effort vocabulary', () => {
    const curated = ['claude-sonnet-5', 'claude-opus-5-5', 'claude-fable-5-1', 'claude-haiku-4-5-20251001'];
    assert.deepStrictEqual([...builtinAgentCapabilities().claude.models], curated);
    assert.deepStrictEqual([...builtinAgentCapabilities().claude.efforts], [...CLAUDE_EFFORTS]);
    assert.deepStrictEqual([...agentCapabilities().claude.models], curated);
    // An empty claude snapshot keeps the curated efforts (and the required
    // default is still appended by the overlay's mergePreservingExisting).
    const empty = agentCapabilities({ claude: snap('claude', [], { source: 'builtin', stale: true }) }).claude;
    assert.deepStrictEqual([...empty.efforts], [...CLAUDE_EFFORTS]);
    assert.strictEqual(empty.source, 'builtin');
    assert.ok(empty.models.includes('claude-sonnet-5'));
  });

  it('codex falls back to the per-model efforts union; snapshot-level efforts win', () => {
    const entries: ModelEntry[] = [
      { id: 'gpt-6-astra', efforts: ['low', 'medium'], defaultEffort: 'medium' },
      { id: 'o3', efforts: ['high'] },
    ];
    const union = agentCapabilities({ codex: snap('codex', entries) }).codex;
    assert.deepStrictEqual(union.efforts, ['low', 'medium', 'high']);
    assert.strictEqual(union.modelEntries?.[0].defaultEffort, 'medium');

    const snapshotLevel = agentCapabilities({
      codex: snap('codex', entries, { efforts: ['none', 'xhigh'] }),
    }).codex;
    assert.deepStrictEqual(snapshotLevel.efforts, ['none', 'xhigh']);
  });

  it('codex with entries but no efforts anywhere falls back to CODEX_EFFORTS', () => {
    const codex = agentCapabilities({
      codex: snap('codex', [{ id: 'gpt-6-astra' }, { id: 'o3' }]),
    }).codex;
    assert.deepStrictEqual(codex.efforts, [...CODEX_EFFORTS]);
  });

  it('opencode keeps its doc link; an empty refreshed list keeps the free-text shape', () => {
    const listed = agentCapabilities({
      opencode: snap('opencode', ['anthropic/claude-sonnet-5', 'openai/gpt-6-astra']),
    }).opencode;
    assert.deepStrictEqual(listed.models, ['anthropic/claude-sonnet-5', 'openai/gpt-6-astra']);
    assert.strictEqual(listed.modelLink, OPENCODE_MODEL_DOC_URL);

    const empty = agentCapabilities({ opencode: snap('opencode', []) }).opencode;
    assert.deepStrictEqual(empty.models, []);
    assert.deepStrictEqual(empty.efforts, []);
    assert.strictEqual(empty.modelLink, OPENCODE_MODEL_DOC_URL);
    assert.strictEqual(empty.source, 'builtin');
    assert.strictEqual(empty.stale, false);
    assert.strictEqual(empty.fetchedAt, '2026-01-02T03:04:05.000Z');
  });

  it('a stale snapshot keeps the list and reports the stale reason', () => {
    const claude = agentCapabilities({
      claude: snap('claude', ['claude-sonnet-5'], {
        stale: true,
        staleReason: 'feed unreachable',
        source: 'cached',
      }),
    }).claude;
    assert.deepStrictEqual(claude.models, ['claude-sonnet-5']);
    assert.strictEqual(claude.stale, true);
    assert.strictEqual(claude.staleReason, 'feed unreachable');
    assert.strictEqual(claude.source, 'cached');
  });

  it('an empty refreshed list never wipes the curated list', () => {
    const codex = agentCapabilities({
      codex: snap('codex', [], { stale: true, staleReason: 'app-server timed out' }),
    }).codex;
    assert.deepStrictEqual(codex.models, builtinAgentCapabilities().codex.models);
    assert.strictEqual(codex.source, 'builtin');
    assert.strictEqual(codex.stale, true);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(codex, 'modelEntries'), false);
  });

  it('antigravity is never overlaid, even with a fully populated table', () => {
    const table: ModelCatalogTable = {
      claude: snap('claude', ['claude-opus-5-5']),
      codex: snap('codex', ['gpt-6-astra']),
      opencode: snap('opencode', ['anthropic/claude-sonnet-5']),
      'models.dev': snap('models.dev', ['some-model']),
    };
    assert.deepStrictEqual(agentCapabilities(table).antigravity, agentCapabilities().antigravity);
    assert.deepStrictEqual(agentCapabilities(table).antigravity.models, Object.keys(ANTIGRAVITY_MODELS));
  });

  it('the overlay path still returns fresh, non-aliased objects on every call', () => {
    const table: ModelCatalogTable = {
      claude: snap('claude', ['claude-opus-5-5', 'claude-sonnet-5']),
      codex: snap('codex', [{ id: 'gpt-6-astra', efforts: ['low', 'medium'] }]),
      opencode: snap('opencode', ['anthropic/claude-sonnet-5']),
    };
    const first = agentCapabilities(table);
    const second = agentCapabilities(table);
    assert.deepStrictEqual(first, second);
    assert.notStrictEqual(first, second);
    for (const agent of Object.keys(first) as (keyof typeof first)[]) {
      assert.notStrictEqual(first[agent], second[agent]);
      assert.notStrictEqual(first[agent].models, second[agent].models);
      assert.notStrictEqual(first[agent].efforts, second[agent].efforts);
      (first[agent].models as string[]).push('mutated-model');
      (first[agent].efforts as string[]).push('mutated-effort');
      assert.ok(!second[agent].models.includes('mutated-model'));
      assert.ok(!second[agent].efforts.includes('mutated-effort'));
    }
  });
});

/**
 * The agent→source mapping (model-selector-refresh T03): only the three
 * discovery-capable agents are mapped, every value is a valid
 * {@link CatalogSourceId}, and antigravity is deliberately absent.
 */
describe('AGENT_CATALOG_SOURCE', () => {
  it('maps only claude/codex/opencode to valid catalog source ids', () => {
    const keys = Object.keys(AGENT_CATALOG_SOURCE);
    for (const key of keys) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(AGENT_BINARY, key),
        `${key} must be a known agent id`,
      );
    }
    for (const agent of ['claude', 'codex', 'opencode']) {
      assert.ok(keys.includes(agent), `${agent} must be mapped`);
    }
    assert.strictEqual(AGENT_CATALOG_SOURCE.antigravity, undefined);
    for (const sourceId of Object.values(AGENT_CATALOG_SOURCE)) {
      assert.ok(isCatalogSourceId(sourceId), `${String(sourceId)} must be a catalog source id`);
    }
  });
});

/**
 * The `Adapter.discoverModels` seam (model-selector-refresh T03): optional,
 * and no adapter implements it yet — antigravity deliberately never will.
 */
describe('discoverModels seam', () => {
  it('no adapter implements discoverModels yet; antigravity never will', () => {
    const registry = createAdapterRegistry();
    for (const id of registry.ids) {
      const seam = registry.require(id).discoverModels;
      assert.ok(seam === undefined || typeof seam === 'function');
    }
    assert.strictEqual(createAdapterRegistry().require('antigravity').discoverModels, undefined);
  });
});

/**
 * The capability bridges (model-selector-refresh T03):
 * `capabilitiesFromEntries` builds capabilities from rich per-model entries,
 * `capabilitiesToCatalogFetch` rounds them back to a `CatalogFetch`.
 */
describe('capability helpers', () => {
  it('capabilitiesFromEntries([]) yields the bare shape with no extra own keys', () => {
    const caps = capabilitiesFromEntries([]);
    assert.deepStrictEqual(caps, { models: [], efforts: [] });
    for (const key of ['modelLink', 'modelEntries', 'source', 'stale', 'staleReason', 'fetchedAt']) {
      assert.strictEqual(
        Object.prototype.hasOwnProperty.call(caps, key),
        false,
        `empty entries must not carry ${key}`,
      );
    }
  });

  it('capabilitiesFromEntries carries options and copies the entries', () => {
    const entries: ModelEntry[] = [{ id: 'gpt-6-astra', efforts: ['low', 'medium'] }];
    const caps = capabilitiesFromEntries(entries, {
      source: 'live',
      stale: true,
      staleReason: 'x',
      fetchedAt: 't',
    });
    assert.deepStrictEqual(caps.models, ['gpt-6-astra']);
    assert.strictEqual(caps.source, 'live');
    assert.strictEqual(caps.stale, true);
    assert.strictEqual(caps.staleReason, 'x');
    assert.strictEqual(caps.fetchedAt, 't');
    assert.ok(caps.modelEntries, 'non-empty entries must carry modelEntries');
    assert.notStrictEqual(caps.modelEntries, entries);
    assert.deepStrictEqual([...caps.modelEntries], entries);
  });

  it('capabilitiesToCatalogFetch round-trips ids and omits empty efforts', () => {
    const empty = capabilitiesToCatalogFetch(capabilitiesFromEntries([]));
    assert.deepStrictEqual(empty.models, []);
    assert.strictEqual(empty.efforts, undefined);

    const fetched = capabilitiesToCatalogFetch(
      capabilitiesFromEntries([{ id: 'a' }, { id: 'b', label: 'B' }], { efforts: ['low'] }),
    );
    assert.deepStrictEqual(fetched.models.map((m) => m.id), ['a', 'b']);
    assert.deepStrictEqual(fetched.efforts, ['low']);
  });
});
