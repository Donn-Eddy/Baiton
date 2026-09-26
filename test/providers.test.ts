import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  BUILTIN_PROVIDER_IDS,
  FEED_PROVIDER_DENY,
  LEGACY_API_KEY_SECRET,
  MODEL_SELECTION_KEY,
  PROVIDERS,
  PROVIDER_IDS,
  PROVIDER_SECRET_KEY_PREFIX,
  ModelSelection,
  ProviderInfo,
  buildProviderCatalog,
  defaultModelFor,
  findProviderInfo,
  isProviderId,
  isProviderIdLike,
  normalizeModelSelection,
  providerCatalog,
  providerInfo,
  providerNeedsKeyReason,
  providerSecretKey,
  providersFromFeed,
} from '../src/orchestrator/providers';
import { parseModelsDevFeed } from '../src/orchestrator/modelsDev';
import type { FeedProvider, ModelsDevFeed } from '../src/orchestrator/modelsDev';
import { completionsUrl } from '../src/orchestrator/modelClient';

/** The models.dev fixture feed, loaded the same way test/modelsDev.test.ts does. */
function sampleFeed(): ModelsDevFeed {
  const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'modelsDev.sample.json'), 'utf8');
  const result = parseModelsDevFeed(JSON.parse(text));
  assert.ok(result.ok, 'fixture feed must parse');
  return result.value;
}

describe('orchestrator/providers', () => {
  describe('catalog shape', () => {
    it('PROVIDER_IDS is the exact dropdown order', () => {
      assert.deepStrictEqual([...PROVIDER_IDS], ['copilot', 'google', 'opencode', 'mistral', 'openai']);
    });

    it('providerCatalog returns one entry per id, in dropdown order', () => {
      const catalog = providerCatalog();
      assert.strictEqual(catalog.length, PROVIDER_IDS.length);
      catalog.forEach((entry, index) => {
        assert.strictEqual(entry.id, PROVIDER_IDS[index]);
      });
    });

    it('PROVIDERS has exactly one own key per id', () => {
      const keys = Object.keys(PROVIDERS);
      assert.strictEqual(keys.length, PROVIDER_IDS.length);
      for (const key of keys) {
        assert.ok(isProviderId(key), `unexpected catalog key: ${key}`);
      }
    });

    it('labels are non-empty and distinct', () => {
      const labels = providerCatalog().map((entry) => entry.label);
      for (const label of labels) {
        assert.strictEqual(typeof label, 'string');
        assert.ok(label.length > 0);
      }
      assert.strictEqual(new Set(labels).size, labels.length);
    });

    it('providerInfo returns the catalog entry of its id', () => {
      for (const id of PROVIDER_IDS) {
        assert.strictEqual(providerInfo(id), PROVIDERS[id]);
      }
    });
  });

  describe('wire dialect + header style', () => {
    it('every entry carries a dialect: only google needs the gemini shaping', () => {
      for (const entry of providerCatalog()) {
        assert.strictEqual(entry.dialect, entry.id === 'google' ? 'gemini' : 'openai');
      }
      assert.strictEqual(PROVIDERS.google.dialect, 'gemini');
    });

    it('every entry carries a headerStyle: only opencode is non-default', () => {
      assert.strictEqual(PROVIDERS.opencode.headerStyle, 'opencode');
      for (const entry of providerCatalog()) {
        assert.strictEqual(entry.headerStyle, entry.id === 'opencode' ? 'opencode' : 'default');
      }
    });

    it('the HTTP catalog bases resolve to their /chat/completions paths', () => {
      assert.strictEqual(
        completionsUrl(PROVIDERS.google.defaultBaseUrl!).href,
        'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
      );
      assert.strictEqual(
        completionsUrl(PROVIDERS.mistral.defaultBaseUrl!).href,
        'https://api.mistral.ai/v1/chat/completions',
      );
      assert.strictEqual(
        completionsUrl(PROVIDERS.opencode.defaultBaseUrl!).href,
        'https://opencode.ai/zen/v1/chat/completions',
      );
    });
  });

  describe('isProviderId', () => {
    it('accepts each known id', () => {
      for (const id of PROVIDER_IDS) {
        assert.strictEqual(isProviderId(id), true);
      }
    });

    it('rejects unknown values', () => {
      for (const value of ['', 'OPENAI', 'gemini', 'anthropic', undefined, null, 42, {}]) {
        assert.strictEqual(isProviderId(value), false);
      }
    });
  });

  describe('isProviderIdLike', () => {
    it('accepts any non-blank string id, builtin or not', () => {
      for (const value of ['anthropic', 'deepinfra', 'copilot']) {
        assert.strictEqual(isProviderIdLike(value), true);
      }
    });

    it('rejects blank strings and non-strings', () => {
      for (const value of ['', '   ', undefined, null, 42, {}, []]) {
        assert.strictEqual(isProviderIdLike(value), false);
      }
    });
  });

  describe('base URLs', () => {
    it('google base URL is exact', () => {
      assert.strictEqual(PROVIDERS.google.defaultBaseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai/');
    });

    it('mistral base URL is exact', () => {
      assert.strictEqual(PROVIDERS.mistral.defaultBaseUrl, 'https://api.mistral.ai/v1');
    });

    it('copilot and openai have no defaultBaseUrl', () => {
      assert.strictEqual(PROVIDERS.copilot.defaultBaseUrl, undefined);
      assert.strictEqual(PROVIDERS.openai.defaultBaseUrl, undefined);
    });

    it('every defined base URL is an https URL', () => {
      for (const entry of providerCatalog()) {
        if (entry.defaultBaseUrl === undefined) {
          continue;
        }
        const url = new URL(entry.defaultBaseUrl);
        assert.strictEqual(url.protocol, 'https:');
      }
    });
  });

  describe('key policy', () => {
    it('only copilot needs no key', () => {
      for (const entry of providerCatalog()) {
        assert.strictEqual(entry.requiresKey, entry.id !== 'copilot');
      }
    });

    it('copilot has no secret key', () => {
      assert.strictEqual(providerSecretKey('copilot'), undefined);
    });

    it('keyed providers get prefix + id, distinct and not the legacy key', () => {
      const keys: string[] = [];
      for (const id of PROVIDER_IDS) {
        if (id === 'copilot') {
          continue;
        }
        const key = providerSecretKey(id) as string;
        assert.strictEqual(key, PROVIDER_SECRET_KEY_PREFIX + id);
        keys.push(key);
      }
      assert.strictEqual(new Set(keys).size, keys.length);
      for (const key of keys) {
        assert.notStrictEqual(key, LEGACY_API_KEY_SECRET);
      }
    });
  });

  describe('legacy key', () => {
    it('pins the legacy secret literal', () => {
      assert.strictEqual(LEGACY_API_KEY_SECRET, 'baiton.orchestrator.apiKey');
    });
  });

  describe('settings-backed provider', () => {
    it('only openai uses settings', () => {
      for (const entry of providerCatalog()) {
        assert.strictEqual(entry.usesSettings, entry.id === 'openai');
      }
    });

    it('free/runtime providers carry empty model lists', () => {
      assert.strictEqual(PROVIDERS.openai.models.length, 0);
      assert.strictEqual(PROVIDERS.copilot.models.length, 0);
    });
  });

  describe('built-in model lists', () => {
    it('hosted providers carry non-empty, duplicate-free model ids', () => {
      for (const id of ['google', 'opencode', 'mistral'] as const) {
        const models = PROVIDERS[id].models;
        assert.ok(models.length > 0, `${id} has no models`);
        for (const model of models) {
          assert.strictEqual(typeof model, 'string');
          assert.ok(model.length > 0);
        }
        assert.strictEqual(new Set(models).size, models.length, `${id} has duplicate models`);
      }
    });

    it('google models start with gemini-', () => {
      const first = PROVIDERS.google.models[0] as string;
      assert.ok(first.startsWith('gemini-'));
    });

    it('defaultModelFor returns the first built-in or undefined', () => {
      for (const id of PROVIDER_IDS) {
        const expected = PROVIDERS[id].models[0];
        assert.strictEqual(defaultModelFor(id), expected);
      }
      assert.strictEqual(defaultModelFor('copilot'), undefined);
      assert.strictEqual(defaultModelFor('openai'), undefined);
    });
  });

  describe('MODEL_SELECTION_KEY', () => {
    it('pins the persistence key literal', () => {
      assert.strictEqual(MODEL_SELECTION_KEY, 'baiton.orchestrator.selection');
    });
  });

  describe('normalizeModelSelection', () => {
    it('accepts a valid pair and returns a fresh equal object', () => {
      const input = { provider: 'google', model: 'gemini-2.5-pro' };
      const result = normalizeModelSelection(input) as ModelSelection;
      assert.deepStrictEqual(result, { provider: 'google', model: 'gemini-2.5-pro' });
      assert.notStrictEqual(result, input);
    });

    it('trims the model', () => {
      assert.deepStrictEqual(normalizeModelSelection({ provider: 'google', model: '  gemini-2.5-flash  ' }), {
        provider: 'google',
        model: 'gemini-2.5-flash',
      });
    });

    it('accepts models absent from the catalog (runtime-enumerated / free text)', () => {
      assert.deepStrictEqual(normalizeModelSelection({ provider: 'copilot', model: 'gpt-4.1' }), {
        provider: 'copilot',
        model: 'gpt-4.1',
      });
    });

    it('drops extra properties', () => {
      const result = normalizeModelSelection({ provider: 'openai', model: 'x', extra: true }) as ModelSelection;
      assert.deepStrictEqual(Object.keys(result).sort(), ['model', 'provider']);
    });

    it('rejects malformed input and never throws', () => {
      const bad: unknown[] = [
        undefined,
        null,
        'google',
        42,
        [],
        {},
        { provider: '', model: 'x' },
        { provider: '   ', model: 'x' },
        { provider: 5, model: 'x' },
        { provider: 'google' },
        { provider: 'google', model: '' },
        { provider: 'google', model: '   ' },
        { provider: 'google', model: 5 },
      ];
      for (const value of bad) {
        assert.doesNotThrow(() => normalizeModelSelection(value));
        assert.strictEqual(normalizeModelSelection(value), undefined);
      }
    });

    it('accepts a provider absent from the builtin catalog', () => {
      assert.deepStrictEqual(normalizeModelSelection({ provider: 'anthropic', model: 'claude-opus-5-5' }), {
        provider: 'anthropic',
        model: 'claude-opus-5-5',
      });
    });

    it('trims the provider', () => {
      assert.deepStrictEqual(normalizeModelSelection({ provider: '  google  ', model: 'x' }), {
        provider: 'google',
        model: 'x',
      });
    });

    it('round-trips every catalog default model', () => {
      for (const id of PROVIDER_IDS) {
        const model = defaultModelFor(id);
        if (model === undefined) {
          continue;
        }
        assert.deepStrictEqual(normalizeModelSelection({ provider: id, model }), { provider: id, model });
      }
    });
  });

  describe('builtin vocabulary', () => {
    it('BUILTIN_PROVIDER_IDS is PROVIDER_IDS', () => {
      assert.deepStrictEqual([...BUILTIN_PROVIDER_IDS], [...PROVIDER_IDS]);
    });
  });

  describe('providersFromFeed', () => {
    it('derives one entry per fixture provider, in feed order', () => {
      const feed = sampleFeed();
      const entries = providersFromFeed(feed);
      assert.deepStrictEqual(
        entries.map((entry) => entry.id),
        feed.map((provider) => provider.id),
      );
      assert.strictEqual(entries.length, 8);
    });

    it('maps anthropic through unchanged', () => {
      const anthropic = providersFromFeed(sampleFeed()).find((entry) => entry.id === 'anthropic') as ProviderInfo;
      assert.ok(anthropic);
      assert.strictEqual(anthropic.label, 'Anthropic');
      assert.strictEqual(anthropic.defaultBaseUrl, 'https://api.anthropic.com/v1');
      assert.strictEqual(anthropic.requiresKey, true);
      assert.strictEqual(anthropic.usesSettings, false);
      assert.strictEqual(anthropic.dialect, 'openai');
      assert.strictEqual(anthropic.headerStyle, 'default');
      assert.strictEqual(anthropic.source, 'feed');
      assert.deepStrictEqual([...(anthropic.env ?? [])], ['ANTHROPIC_API_KEY']);
      assert.strictEqual(anthropic.models[0], 'claude-opus-5-5');
    });

    it('applies the per-id trait overrides', () => {
      const entries = providersFromFeed(sampleFeed());
      const google = entries.find((entry) => entry.id === 'google') as ProviderInfo;
      assert.strictEqual(google.dialect, 'gemini');
      assert.strictEqual(google.defaultBaseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai/');
      const opencode = entries.find((entry) => entry.id === 'opencode') as ProviderInfo;
      assert.strictEqual(opencode.headerStyle, 'opencode');
    });

    it('skips entries with no api, no models, a blank id, or a denied id', () => {
      const model = { id: 'm', name: 'm', reasoning: false, toolCall: false, attachment: false };
      const base: FeedProvider = { id: 'ok', name: 'OK', api: 'https://example.com/v1', env: [], models: [model] };
      const feed: ModelsDevFeed = [
        base,
        { ...base, id: 'no-api', api: undefined },
        { ...base, id: 'no-models', models: [] },
        { ...base, id: '   ' },
        { ...base, id: 'copilot' },
        { ...base, id: 'github-copilot' },
      ];
      assert.deepStrictEqual(
        providersFromFeed(feed).map((entry) => entry.id),
        ['ok'],
      );
      for (const denied of FEED_PROVIDER_DENY) {
        assert.strictEqual(
          providersFromFeed([{ ...base, id: denied }]).length,
          0,
          `${denied} must be skipped`,
        );
      }
    });

    it('never throws on malformed entries', () => {
      const malformed = [null, undefined, 42, 'nope', {}, { id: 'x' }, { id: 'y', api: 5, models: 'no' }];
      assert.doesNotThrow(() => providersFromFeed(malformed as unknown as ModelsDevFeed));
      assert.strictEqual(providersFromFeed(malformed as unknown as ModelsDevFeed).length, 0);
    });
  });

  describe('buildProviderCatalog', () => {
    it('with no feed it is today’s builtin catalog', () => {
      assert.deepStrictEqual(buildProviderCatalog(), providerCatalog());
      assert.deepStrictEqual(
        buildProviderCatalog().map((entry) => entry.id),
        [...PROVIDER_IDS],
      );
      assert.deepStrictEqual(buildProviderCatalog([]), providerCatalog());
    });

    it('merges the feed into unique ids, copilot first and openai last', () => {
      const catalog = buildProviderCatalog(sampleFeed());
      const ids = catalog.map((entry) => entry.id);
      assert.strictEqual(new Set(ids).size, ids.length, `duplicate ids: ${ids.join(', ')}`);
      assert.strictEqual(ids[0], 'copilot');
      assert.strictEqual(ids[ids.length - 1], 'openai');
      for (const id of ['anthropic', 'deepinfra', 'cerebras', 'baseten', 'deepseek']) {
        assert.ok(ids.includes(id), `missing feed provider ${id}`);
      }
    });

    it('keeps builtin host traits but takes the feed’s model lists', () => {
      const catalog = buildProviderCatalog(sampleFeed());
      for (const id of ['google', 'mistral', 'opencode'] as const) {
        assert.strictEqual(catalog.filter((entry) => entry.id === id).length, 1, `${id} appears twice`);
        const entry = catalog.find((item) => item.id === id) as ProviderInfo;
        assert.strictEqual(entry.label, PROVIDERS[id].label);
        assert.strictEqual(entry.dialect, PROVIDERS[id].dialect);
        assert.strictEqual(entry.headerStyle, PROVIDERS[id].headerStyle);
        assert.strictEqual(entry.defaultBaseUrl, PROVIDERS[id].defaultBaseUrl);
      }
      const google = catalog.find((entry) => entry.id === 'google') as ProviderInfo;
      assert.ok(google.models.includes('gemini-2.5-pro'));
      const opencode = catalog.find((entry) => entry.id === 'opencode') as ProviderInfo;
      assert.ok(!opencode.models.includes('claude-sonnet-4-5'), 'opencode must stop advertising the stale model');
      assert.deepStrictEqual([...opencode.models], ['grok-code', 'gpt-oss-120b-zen', 'claude-sonnet-5-zen']);
    });

    it('every feed-derived base URL is an https /chat/completions prefix', () => {
      for (const entry of buildProviderCatalog(sampleFeed())) {
        if (entry.defaultBaseUrl === undefined) {
          continue;
        }
        assert.strictEqual(new URL(entry.defaultBaseUrl).protocol, 'https:');
        assert.ok(completionsUrl(entry.defaultBaseUrl).href.endsWith('/chat/completions'));
      }
    });
  });

  describe('unknown ids degrade gracefully', () => {
    it('findProviderInfo matches the builtins or the given catalog', () => {
      assert.strictEqual(findProviderInfo('anthropic'), undefined);
      const catalog = buildProviderCatalog(sampleFeed());
      assert.strictEqual(findProviderInfo('anthropic', catalog)?.label, 'Anthropic');
      assert.strictEqual(findProviderInfo('', catalog), undefined);
      assert.strictEqual(findProviderInfo('nope', catalog), undefined);
    });

    it('providerInfo synthesises a fallback instead of throwing', () => {
      const info = providerInfo('anthropic');
      assert.strictEqual(info.id, 'anthropic');
      assert.strictEqual(info.label, 'anthropic');
      assert.strictEqual(info.requiresKey, true);
      assert.strictEqual(info.usesSettings, false);
      assert.deepStrictEqual([...info.models], []);
      assert.strictEqual(info.dialect, 'openai');
      assert.strictEqual(info.headerStyle, 'default');
      assert.strictEqual(info.source, 'custom');
    });

    it('inherited object members cannot be smuggled in', () => {
      for (const id of ['__proto__', 'constructor', 'toString']) {
        const info = providerInfo(id);
        assert.strictEqual(info.id, id);
        assert.strictEqual(info.label, id);
        assert.strictEqual(info.source, 'custom');
        assert.deepStrictEqual([...info.models], []);
        assert.strictEqual(findProviderInfo(id), undefined);
      }
    });

    it('providerNeedsKeyReason names the id, or the feed label with a catalog', () => {
      assert.strictEqual(providerNeedsKeyReason('anthropic'), 'Set an API key for anthropic to use it.');
      assert.strictEqual(
        providerNeedsKeyReason('anthropic', buildProviderCatalog(sampleFeed())),
        'Set an API key for Anthropic to use it.',
      );
    });

    it('defaultModelFor resolves against the given catalog only', () => {
      assert.strictEqual(defaultModelFor('anthropic', buildProviderCatalog(sampleFeed())), 'claude-opus-5-5');
      assert.strictEqual(defaultModelFor('anthropic'), undefined);
    });
  });

  describe('legacy secret-key compatibility', () => {
    it('every builtin but copilot keeps prefix + id', () => {
      for (const id of PROVIDER_IDS) {
        if (id === 'copilot') {
          continue;
        }
        assert.strictEqual(providerSecretKey(id), 'baiton.orchestrator.key.' + id);
      }
      assert.strictEqual(providerSecretKey('copilot'), undefined);
    });

    it('a feed id gets a key of the same shape', () => {
      assert.strictEqual(providerSecretKey('anthropic'), 'baiton.orchestrator.key.anthropic');
    });

    it('blank ids get no key, and no key is the legacy secret', () => {
      assert.strictEqual(providerSecretKey(''), undefined);
      assert.strictEqual(providerSecretKey('   '), undefined);
      for (const entry of buildProviderCatalog(sampleFeed())) {
        assert.notStrictEqual(providerSecretKey(entry.id), LEGACY_API_KEY_SECRET);
      }
    });
  });
});
