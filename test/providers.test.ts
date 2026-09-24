import * as assert from 'assert';
import {
  LEGACY_API_KEY_SECRET,
  MODEL_SELECTION_KEY,
  PROVIDERS,
  PROVIDER_IDS,
  PROVIDER_SECRET_KEY_PREFIX,
  ModelSelection,
  defaultModelFor,
  isProviderId,
  normalizeModelSelection,
  providerCatalog,
  providerInfo,
  providerSecretKey,
} from '../src/orchestrator/providers';
import { completionsUrl } from '../src/orchestrator/modelClient';

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
        { provider: 'nope', model: 'x' },
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
});
