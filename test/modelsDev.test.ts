import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  FeedFetch,
  FetchModelsDevOptions,
  MODELS_DEV_URL,
  ModelsDevFeed,
  fetchModelsDev,
  parseModelsDevFeed,
} from '../src/orchestrator/modelsDev';
import type { FeedResponse } from '../src/orchestrator/modelsDev';

// test/fixtures/modelsDev.sample.json is a hand-trimmed excerpt of
// https://models.dev/api.json?type=all in the real feed shape (an object
// keyed by provider id). It is read untyped (fs + JSON.parse, not resolveJsonModule
// import) so the parser is exercised on genuinely untyped input.

/** The fixture text, read at module load. */
const fixtureText: string = fs.readFileSync(path.join(__dirname, 'fixtures', 'modelsDev.sample.json'), 'utf8');

/** A recording fake fetch returning a fixed response; returns the recorded calls. */
function fakeFetch(response: { ok: boolean; status: number; text: string }): {
  fetchFn: FeedFetch;
  calls: { url: string; init: { signal: AbortSignal; headers: Record<string, string> } }[];
} {
  const calls: { url: string; init: { signal: AbortSignal; headers: Record<string, string> } }[] = [];
  const fetchFn: FeedFetch = async (url, init) => {
    calls.push({ url, init });
    const text = response.text;
    return { ok: response.ok, status: response.status, text: async () => text };
  };
  return { fetchFn, calls };
}

/** Options with the fake fetch injected (no unused keys). */
function opts(fetchFn: FeedFetch, rest: Omit<FetchModelsDevOptions, 'fetch'> = {}): FetchModelsDevOptions {
  return { fetch: fetchFn, ...rest };
}

describe('orchestrator/modelsDev', () => {
  describe('parseModelsDevFeed', () => {
    it('parses the fixture into the nine providers in fixture order', () => {
      const result = parseModelsDevFeed(JSON.parse(fixtureText));
      assert.strictEqual(result.ok, true);
      const feed = result.value as ModelsDevFeed;
      assert.deepStrictEqual(
        feed.map((provider) => provider.id),
        ['anthropic', 'deepinfra', 'cerebras', 'baseten', 'deepseek', 'google', 'mistral', 'opencode', 'opencode-go'],
      );
    });

    it('carries the anthropic provider through and lists its model ids in fixture order', () => {
      const result = parseModelsDevFeed(JSON.parse(fixtureText));
      assert.strictEqual(result.ok, true);
      const anthropic = (result.value as ModelsDevFeed)[0];
      assert.strictEqual(anthropic.name, 'Anthropic');
      assert.strictEqual(anthropic.api, 'https://api.anthropic.com/v1');
      assert.deepStrictEqual([...anthropic.env], ['ANTHROPIC_API_KEY']);
      assert.strictEqual(anthropic.npm, '@ai-sdk/anthropic');
      assert.strictEqual(anthropic.doc, 'https://docs.claude.com/en/api/getting-started');
      assert.deepStrictEqual(
        anthropic.models.map((model) => model.id),
        ['claude-opus-5-5', 'claude-sonnet-5', 'claude-haiku-4-5'],
      );
    });

    it('maps snake_case to camelCase: the fully-populated model equals the exact FeedModel', () => {
      const result = parseModelsDevFeed(JSON.parse(fixtureText));
      assert.strictEqual(result.ok, true);
      const anthropic = (result.value as ModelsDevFeed)[0];
      assert.deepStrictEqual(anthropic.models[0], {
        id: 'claude-opus-5-5',
        name: 'Claude Opus 5.5',
        reasoning: true,
        toolCall: true,
        attachment: true,
        limits: { context: 200000, output: 64000 },
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        releaseDate: '2026-03-02',
      });
    });

    it('omits limits/cost/releaseDate on the minimal model (key presence, not undefined)', () => {
      const result = parseModelsDevFeed(JSON.parse(fixtureText));
      assert.strictEqual(result.ok, true);
      const opencode = (result.value as ModelsDevFeed)[7];
      const minimal = opencode.models.find((model) => model.id === 'gpt-oss-120b-zen');
      assert.ok(minimal !== undefined);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(minimal, 'limits'), false);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(minimal, 'cost'), false);
      assert.strictEqual(Object.prototype.hasOwnProperty.call(minimal, 'releaseDate'), false);
      assert.deepStrictEqual(minimal, {
        id: 'gpt-oss-120b-zen',
        name: 'gpt-oss 120b (Zen)',
        reasoning: false,
        toolCall: false,
        attachment: false,
      });
    });

    it('rejects null, non-objects and empty shapes without throwing', () => {
      for (const bad of [null, 42, 'x']) {
        const result = parseModelsDevFeed(bad);
        assert.strictEqual(result.ok, false);
        assert.strictEqual((result as { error: string }).error, 'models.dev feed is not an object');
      }
      // An array of non-objects yields no providers → the no-providers error.
      const result = parseModelsDevFeed([]);
      assert.strictEqual(result.ok, false);
      assert.match((result as { error: string }).error, /no providers/);
    });

    it('skips a provider whose value is not an object', () => {
      const result = parseModelsDevFeed({ a: 'nope', 42: undefined, b: { id: 'b', env: [], models: {} } });
      assert.strictEqual(result.ok, true);
      assert.deepStrictEqual(
        (result.value as ModelsDevFeed).map((provider) => provider.id),
        ['b'],
      );
    });

    it('keeps a provider with a malformed models block as models: []', () => {
      const result = parseModelsDevFeed({ p: { id: 'p', name: 'P', env: ['X'], models: 'nope' } });
      assert.strictEqual(result.ok, true);
      const provider = (result.value as ModelsDevFeed)[0];
      assert.strictEqual(provider.id, 'p');
      assert.deepStrictEqual(provider.models, []);
    });

    it('skips a model with a non-object record; a blank id falls back to the object key', () => {
      const result = parseModelsDevFeed({
        p: {
          id: 'p',
          models: {
            good: { id: 'good', name: 'Good' },
            blank: { id: '   ', name: 'Blank' },
            bad: 42,
          },
        },
      });
      assert.strictEqual(result.ok, true);
      const provider = (result.value as ModelsDevFeed)[0];
      assert.deepStrictEqual(
        provider.models.map((model) => model.id),
        ['good', 'blank'],
      );
    });

    it('a model record without its own id takes the object key as its id', () => {
      const result = parseModelsDevFeed({
        p: { id: 'p', models: { keyed: { name: 'M' } } },
      });
      assert.strictEqual(result.ok, true);
      const provider = (result.value as ModelsDevFeed)[0];
      assert.deepStrictEqual(provider.models[0], {
        id: 'keyed',
        name: 'M',
        reasoning: false,
        toolCall: false,
        attachment: false,
      });
    });

    it('defaults env to [] and omits a non-numeric cost', () => {
      const result = parseModelsDevFeed({
        p: { id: 'p', models: { m: { id: 'm', cost: { input: 'free' } } }, env: [''], extra: ['ok', '', 42] },
      });
      assert.strictEqual(result.ok, true);
      const provider = (result.value as ModelsDevFeed)[0];
      assert.deepStrictEqual(provider.env, []);
      const model = provider.models[0];
      assert.strictEqual(Object.prototype.hasOwnProperty.call(model, 'cost'), false);
    });

    it('parses a top-level array of provider records equivalently to the keyed shape', () => {
      const keyed = JSON.parse(fixtureText);
      const listed: unknown[] = Object.entries(keyed).map(([, value]) => (value as Record<string, unknown>));
      const resultA = parseModelsDevFeed(keyed);
      const resultB = parseModelsDevFeed(listed);
      assert.strictEqual(resultA.ok, true);
      assert.strictEqual(resultB.ok, true);
      assert.deepStrictEqual(resultA.value as ModelsDevFeed, resultB.value as ModelsDevFeed);
    });

    it('an empty object yields an error mentioning no providers', () => {
      const result = parseModelsDevFeed({});
      assert.strictEqual(result.ok, false);
      assert.match((result as { error: string }).error, /no providers/);
    });

    it('provider id falls back to the object key; name falls back to the id', () => {
      const result = parseModelsDevFeed({ keyed: { env: [], models: {} } });
      assert.strictEqual(result.ok, true);
      const provider = (result.value as ModelsDevFeed)[0];
      assert.strictEqual(provider.id, 'keyed');
      assert.strictEqual(provider.name, 'keyed');
    });

    it('filters non-finite numbers out of limit and cost, omitting empty objects', () => {
      const result = parseModelsDevFeed({
        p: {
          models: {
            a: { id: 'a', limit: { context: 'big', output: Infinity }, cost: { input: NaN } },
            b: { id: 'b', limit: { output: 100 }, cost: { cache_write: 0 } },
          },
        },
      });
      assert.strictEqual(result.ok, true);
      const models = (result.value as ModelsDevFeed)[0].models;
      assert.deepStrictEqual(models[0], { id: 'a', name: 'a', reasoning: false, toolCall: false, attachment: false });
      assert.deepStrictEqual(models[1], {
        id: 'b',
        name: 'b',
        reasoning: false,
        toolCall: false,
        attachment: false,
        limits: { output: 100 },
        cost: { cacheWrite: 0 },
      });
    });
  });

  describe('fetchModelsDev', () => {
    it('success parses the fixture through the injected fetch and calls the default URL', async () => {
      const { fetchFn, calls } = fakeFetch({ ok: true, status: 200, text: fixtureText });
      const result = await fetchModelsDev(opts(fetchFn));
      assert.strictEqual(result.ok, true);
      const feed = result.value as ModelsDevFeed;
      assert.deepStrictEqual(
        feed.map((provider) => provider.id),
        ['anthropic', 'deepinfra', 'cerebras', 'baseten', 'deepseek', 'google', 'mistral', 'opencode', 'opencode-go'],
      );
      assert.strictEqual(calls.length, 1);
      assert.strictEqual(calls[0].url, MODELS_DEV_URL);
      assert.ok(calls[0].init.signal instanceof AbortSignal);
      assert.deepStrictEqual(calls[0].init.headers, { accept: 'application/json' });
    });

    it('uses a custom url when passed', async () => {
      const { fetchFn, calls } = fakeFetch({ ok: true, status: 200, text: fixtureText });
      await fetchModelsDev(opts(fetchFn, { url: 'https://example.test/api.json' }));
      assert.strictEqual(calls[0].url, 'https://example.test/api.json');
    });

    it('non-2xx resolves to an err containing the status', async () => {
      const { fetchFn } = fakeFetch({ ok: false, status: 503, text: '' });
      const result = await fetchModelsDev(opts(fetchFn));
      assert.strictEqual(result.ok, false);
      assert.match((result as { error: string }).error, /503/);
    });

    it('an invalid JSON body resolves to an err mentioning invalid JSON', async () => {
      const { fetchFn } = fakeFetch({ ok: true, status: 200, text: '<html>not json</html>' });
      const result = await fetchModelsDev(opts(fetchFn));
      assert.strictEqual(result.ok, false);
      assert.match((result as { error: string }).error, /invalid JSON/);
    });

    it('a rejecting fetch resolves (never rejects) with the transport message', async () => {
      const fetchFn: FeedFetch = async () => {
        throw new Error('ECONNREFUSED');
      };
      const result = await fetchModelsDev(opts(fetchFn));
      assert.strictEqual(result.ok, false);
      assert.match((result as { error: string }).error, /ECONNREFUSED/);
    });

    it('a timeout aborts the request and reports it, finishing promptly', async function () {
      this.timeout(2000);
      const fetchFn: FeedFetch = (url, init) =>
        new Promise<FeedResponse>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            reject(new Error('aborted by test'));
          });
          void url;
        });
      const result = await fetchModelsDev(opts(fetchFn, { timeoutMs: 10 }));
      assert.strictEqual(result.ok, false);
      assert.match((result as { error: string }).error, /timed out after 10ms/);
    });

    it('a body that stays pending until the deadline reports the timeout', async function () {
      this.timeout(2000);
      // fetch resolves headers immediately but `text()` only rejects when the
      // deadline aborts it — the streaming-body timeout case.
      const hangingBodyFetch: FeedFetch = async (url, init) => {
        void url;
        return {
          ok: true,
          status: 200,
          text: () =>
            new Promise<string>((resolve, reject) => {
              init.signal.addEventListener('abort', () => {
                reject(new Error('aborted while reading body'));
              });
              void resolve;
            }),
        };
      };
      const result = await fetchModelsDev(opts(hangingBodyFetch, { timeoutMs: 10 }));
      assert.strictEqual(result.ok, false);
      assert.match((result as { error: string }).error, /timed out after 10ms/);
    });

    it('missing global fetch resolves to a runtime error without throwing', async () => {
      const globalAny = globalThis as { fetch?: unknown };
      const original = globalAny.fetch;
      delete globalAny.fetch;
      try {
        const result = await fetchModelsDev();
        assert.strictEqual(result.ok, false);
        assert.match((result as { error: string }).error, /unavailable in this runtime/);
      } finally {
        globalAny.fetch = original;
      }
    });
  });

  describe('host-free', () => {
    it('the module source contains no vscode import', () => {
      const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'orchestrator', 'modelsDev.ts'), 'utf8');
      assert.ok(!/from '.*vscode'/.test(source), 'modelsDev.ts must not import vscode');
      assert.ok(!/require\(.*vscode/.test(source), 'modelsDev.ts must not require vscode');
    });
  });
});
