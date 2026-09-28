import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  MODEL_DISCOVERY_SOURCE_TIMEOUT_MS,
  ModelDiscoveryService,
  builtinCatalogFetches,
  type DiscoveryRegistry,
  type FeedFetcher,
} from '../src/activation/modelDiscovery';
import {
  CATALOG_SOURCE_IDS,
  CatalogStore,
  MODEL_CATALOG_MEMENTO_KEY,
  MODEL_CATALOG_PERSIST_VERSION,
  type ModelCatalogTable,
  type ModelEntry,
} from '../src/orchestrator/modelCatalog';
import { parseModelsDevFeed, type ModelsDevFeed } from '../src/orchestrator/modelsDev';
import { AGENT_CATALOG_SOURCE, capabilitiesFromEntries } from '../src/adapter/adapter';
import type {
  Adapter,
  AgentCapabilities,
  AgentId,
  DiscoveryContext,
} from '../src/adapter/adapter';
import { ok, err } from '../src/model/result';

// This module is host-free (no runtime `vscode` import), so it is imported
// statically here with no loader dance — exactly as test/providerRouter.test.ts
// explains for the router.

/** A Map-backed `vscode.Memento` subset recording every `update` call. */
interface FakeMemento {
  store: Map<string, unknown>;
  updates: { key: string; value: unknown }[];
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | void;
}

function fakeMemento(): FakeMemento {
  const store = new Map<string, unknown>();
  const updates: { key: string; value: unknown }[] = [];
  return {
    store,
    updates,
    get<T>(key: string): T | undefined {
      return store.get(key) as T | undefined;
    },
    update(key: string, value: unknown): void {
      updates.push({ key, value });
      store.set(key, value);
    },
  };
}

/** An adapter fake carrying only `id` + `discoverModels`, recording every ctx. */
interface FakeAdapter {
  adapter: Adapter;
  calls: DiscoveryContext[];
}

function fakeAdapter(
  id: AgentId,
  impl: (ctx: DiscoveryContext) => Promise<AgentCapabilities | undefined>,
): FakeAdapter {
  const calls: DiscoveryContext[] = [];
  const adapter = {
    id,
    discoverModels: (ctx: DiscoveryContext): Promise<AgentCapabilities | undefined> => {
      calls.push(ctx);
      return impl(ctx);
    },
  } as unknown as Adapter;
  return { adapter, calls };
}

/** An adapter fake with no discovery seam at all (a hypothetical adapter without one). */
function seamlessAdapter(id: AgentId): Adapter {
  return { id, discoverModels: undefined } as unknown as Adapter;
}

/** An adapter fake whose `discoverModels` throws synchronously. */
function throwingAdapter(id: AgentId, message: string): Adapter {
  return {
    id,
    discoverModels: (): Promise<AgentCapabilities | undefined> => {
      throw new Error(message);
    },
  } as unknown as Adapter;
}

/** A registry literal structurally satisfying {@link DiscoveryRegistry}. */
function fakeRegistry(map: Partial<Record<AgentId, Adapter>>): DiscoveryRegistry {
  return {
    get: (agent: string): Adapter | undefined => map[agent as AgentId],
    ids: Object.keys(map) as AgentId[],
  };
}

/** Capabilities with the given model ids (and optional efforts). */
function caps(models: readonly string[], efforts: readonly string[] = []): AgentCapabilities {
  return { models: [...models], efforts: [...efforts] };
}

/**
 * Capabilities built from per-model {@link ModelEntry} records, so a source can
 * return a family entry with its own `efforts` beside a fixed entry with an
 * explicitly empty one.
 */
function entryCaps(entries: readonly ModelEntry[], efforts?: readonly string[]): AgentCapabilities {
  return capabilitiesFromEntries(entries, efforts !== undefined ? { efforts } : undefined);
}

/** A manually settled promise, so a refresh can be held mid-flight. */
interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
  let resolveFn: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolveFn = resolve;
  });
  return { promise, resolve: resolveFn };
}

// The real feed shape, read from the same fixture test/modelsDev.test.ts uses.
const fixtureText: string = fs.readFileSync(
  path.join(__dirname, 'fixtures', 'modelsDev.sample.json'),
  'utf8',
);

/** The parsed fixture feed. */
function fakeFeed(): ModelsDevFeed {
  const parsed = parseModelsDevFeed(JSON.parse(fixtureText) as unknown);
  assert.ok(parsed.ok, 'the models.dev fixture must parse');
  return parsed.value;
}

/** A feed fetcher spy resolving `feed`, counting its calls and recording options. */
function feedSpy(feed: ModelsDevFeed): {
  fetchFeed: FeedFetcher;
  calls: { timeoutMs: number; signal?: AbortSignal }[];
} {
  const calls: { timeoutMs: number; signal?: AbortSignal }[] = [];
  const fetchFeed: FeedFetcher = async (options) => {
    calls.push(options);
    return ok(feed);
  };
  return { fetchFeed, calls };
}

/** A deterministic `now` for the store, so `fetchedAt` never varies. */
const NOW = '2026-01-01T00:00:00.000Z';

/** A store over a fresh fake memento, optionally seeded with the builtins. */
function makeStore(
  memento: FakeMemento,
  options: { builtins?: boolean } = {},
): CatalogStore {
  return new CatalogStore({
    memento,
    now: () => NOW,
    ...(options.builtins === true ? { builtins: builtinCatalogFetches() } : {}),
  });
}

describe('T07 ModelDiscoveryService.refresh', () => {
  it('drives all four sources, fetching the feed exactly once and handing it to claude', async () => {
    const feed = fakeFeed();
    const spy = feedSpy(feed);
    const claude = fakeAdapter('claude', async () => caps(['claude-sonnet-5']));
    const codex = fakeAdapter('codex', async () => caps(['gpt-5-codex'], ['low', 'high']));
    const opencode = fakeAdapter('opencode', async () => caps(['anthropic/claude-sonnet-5']));
    const service = new ModelDiscoveryService({
      store: makeStore(fakeMemento()),
      registry: fakeRegistry({
        claude: claude.adapter,
        codex: codex.adapter,
        opencode: opencode.adapter,
      }),
      fetchFeed: spy.fetchFeed,
    });

    await service.refresh();

    assert.strictEqual(claude.calls.length, 1);
    assert.strictEqual(codex.calls.length, 1);
    assert.strictEqual(opencode.calls.length, 1);
    assert.strictEqual(spy.calls.length, 1, 'the feed must be fetched exactly once per refresh');
    assert.strictEqual(
      claude.calls[0].feed,
      feed,
      'the claude adapter must receive the very feed object the fetcher returned',
    );
    assert.strictEqual(codex.calls[0].feed, undefined);
    assert.strictEqual(
      claude.calls[0].timeoutMs,
      MODEL_DISCOVERY_SOURCE_TIMEOUT_MS,
      'the default per-source budget applies when none is injected',
    );
    service.dispose();
  });

  it('resolves the full table with every source live and not stale', async () => {
    const service = new ModelDiscoveryService({
      store: makeStore(fakeMemento()),
      registry: fakeRegistry({
        claude: fakeAdapter('claude', async () => caps(['claude-sonnet-5'])).adapter,
        codex: fakeAdapter('codex', async () => caps(['gpt-5-codex'], ['high'])).adapter,
        opencode: fakeAdapter('opencode', async () => caps(['anthropic/claude-sonnet-5'])).adapter,
      }),
      fetchFeed: feedSpy(fakeFeed()).fetchFeed,
    });

    const table = await service.refresh();

    for (const sourceId of ['models.dev', 'claude', 'codex', 'opencode'] as const) {
      const snapshot = table[sourceId];
      assert.ok(snapshot !== undefined, `${sourceId} must be present`);
      assert.strictEqual(snapshot.source, 'live', `${sourceId} must be live`);
      assert.strictEqual(snapshot.stale, false, `${sourceId} must not be stale`);
    }
    assert.deepStrictEqual(table['codex']?.efforts, ['high']);
    service.dispose();
  });

  it('stores bare feed model ids with the provider id on `provider`, in feed order', async () => {
    const feed = fakeFeed();
    const service = new ModelDiscoveryService({
      store: makeStore(fakeMemento()),
      registry: fakeRegistry({}),
      fetchFeed: feedSpy(feed).fetchFeed,
    });

    const table = await service.refresh();

    const expected = feed.flatMap((provider) =>
      provider.models.map((model) => ({ id: model.id, provider: provider.id })),
    );
    const actual = (table['models.dev']?.models ?? []).map((entry) => ({
      id: entry.id,
      provider: entry.provider,
    }));
    assert.deepStrictEqual(actual, expected);
    assert.ok(
      actual.some((entry) => entry.id === 'claude-sonnet-5' && entry.provider === 'anthropic'),
      'a bare model id must carry its provider half separately',
    );
    assert.strictEqual(table['models.dev']?.efforts, undefined, 'the feed discloses no efforts');
    assert.strictEqual(service.feed(), feed, 'feed() returns the parsed feed');
    service.dispose();
  });

  it('marks only a failing source stale, keeping its previous models, and never rejects', async () => {
    const memento = fakeMemento();
    const store = makeStore(memento, { builtins: true });
    const builtinClaude = store.get('claude')?.models ?? [];
    const builtinCodex = store.get('codex')?.models ?? [];
    const builtinOpencode = store.get('opencode')?.models ?? [];
    const service = new ModelDiscoveryService({
      store,
      registry: fakeRegistry({
        claude: fakeAdapter('claude', async () => undefined).adapter,
        codex: fakeAdapter('codex', async () => {
          throw new Error('app-server died');
        }).adapter,
        opencode: throwingAdapter('opencode', 'spawn failed'),
      }),
      fetchFeed: feedSpy(fakeFeed()).fetchFeed,
    });

    const table = await service.refresh();

    for (const [sourceId, previous] of [
      ['claude', builtinClaude],
      ['codex', builtinCodex],
      ['opencode', builtinOpencode],
    ] as const) {
      const snapshot = table[sourceId];
      assert.ok(snapshot !== undefined);
      assert.strictEqual(snapshot.stale, true, `${sourceId} must be stale`);
      assert.ok(
        (snapshot.staleReason ?? '').length > 0,
        `${sourceId} must carry a non-empty staleReason`,
      );
      assert.deepStrictEqual(snapshot.models, previous, `${sourceId} keeps its previous models`);
      assert.strictEqual(snapshot.source, 'builtin', `${sourceId} keeps its previous provenance`);
    }
    assert.match(table['claude']?.staleReason ?? '', /returned no models/);
    assert.match(table['codex']?.staleReason ?? '', /app-server died/);
    assert.match(table['opencode']?.staleReason ?? '', /spawn failed/);
    assert.strictEqual(table['models.dev']?.source, 'live');
    assert.strictEqual(table['models.dev']?.stale, false);
    service.dispose();
  });

  it('marks only models.dev stale when the feed fetcher fails', async () => {
    const store = makeStore(fakeMemento(), { builtins: true });
    const claude = fakeAdapter('claude', async () => caps(['claude-sonnet-5']));
    const service = new ModelDiscoveryService({
      store,
      registry: fakeRegistry({
        claude: claude.adapter,
        codex: fakeAdapter('codex', async () => caps(['gpt-5-codex'])).adapter,
      }),
      fetchFeed: async () => err('models.dev returned HTTP 503'),
    });

    const table = await service.refresh();

    // The feed source never succeeded and has no builtin seed, so there is
    // nothing to mark stale — the CLI sources still land live.
    assert.strictEqual(table['models.dev'], undefined);
    assert.strictEqual(table['claude']?.source, 'live');
    assert.strictEqual(table['codex']?.source, 'live');
    assert.strictEqual(service.feed(), undefined);
    assert.strictEqual(claude.calls[0].feed, undefined, 'a failed feed is not passed to claude');
    service.dispose();
  });

  it('marks a feed failure stale over a previously cached models.dev list', async () => {
    const memento = fakeMemento();
    memento.store.set(MODEL_CATALOG_MEMENTO_KEY, {
      version: MODEL_CATALOG_PERSIST_VERSION,
      snapshots: {
        'models.dev': {
          sourceId: 'models.dev',
          models: [{ id: 'claude-sonnet-5', provider: 'anthropic' }],
          fetchedAt: NOW,
          source: 'live',
          stale: false,
        },
      },
    });
    const service = new ModelDiscoveryService({
      store: makeStore(memento),
      registry: fakeRegistry({}),
      fetchFeed: async () => err('models.dev returned HTTP 503'),
    });

    const table = await service.refresh();

    assert.strictEqual(table['models.dev']?.stale, true);
    assert.strictEqual(table['models.dev']?.staleReason, 'models.dev returned HTTP 503');
    assert.deepStrictEqual(table['models.dev']?.models, [
      { id: 'claude-sonnet-5', provider: 'anthropic' },
    ]);
    service.dispose();
  });

  it('times a hanging adapter out without hanging the refresh', async function () {
    this.timeout(2_000);
    const store = makeStore(fakeMemento(), { builtins: true });
    const hanging = fakeAdapter('codex', () => deferred<AgentCapabilities | undefined>().promise);
    const service = new ModelDiscoveryService({
      store,
      registry: fakeRegistry({ codex: hanging.adapter }),
      fetchFeed: feedSpy(fakeFeed()).fetchFeed,
      timeoutMs: 20,
    });

    const table = await service.refresh();

    assert.strictEqual(hanging.calls.length, 1);
    assert.strictEqual(table['codex']?.stale, true);
    assert.match(table['codex']?.staleReason ?? '', /timed out after 20ms/);
    service.dispose();
  });

  it('writes no snapshot and marks nothing stale for an adapter with no discovery seam', async () => {
    const store = makeStore(fakeMemento());
    const service = new ModelDiscoveryService({
      store,
      registry: fakeRegistry({ opencode: seamlessAdapter('opencode') }),
      fetchFeed: feedSpy(fakeFeed()).fetchFeed,
    });

    const table = await service.refresh();

    assert.strictEqual(table['opencode'], undefined, 'no seam means no snapshot at all');
    assert.strictEqual(table['claude'], undefined);
    assert.strictEqual(table['models.dev']?.source, 'live');
    service.dispose();
  });

  it('passes the cwd the accessor returned at refresh time, and omits it when undefined', async () => {
    const codex = fakeAdapter('codex', async () => caps(['gpt-5-codex']));
    // A holder, not a `let`, so the accessor is genuinely re-read per refresh.
    const workspace: { root?: string } = {};
    const service = new ModelDiscoveryService({
      store: makeStore(fakeMemento()),
      registry: fakeRegistry({ codex: codex.adapter }),
      fetchFeed: feedSpy(fakeFeed()).fetchFeed,
      cwd: () => workspace.root,
    });

    await service.refresh();
    assert.strictEqual(codex.calls[0].cwd, undefined);
    assert.ok(
      !Object.prototype.hasOwnProperty.call(codex.calls[0], 'cwd'),
      'an undefined cwd must not be written as an own key',
    );

    workspace.root = '/tmp/workspace';
    await service.refresh();
    assert.strictEqual(codex.calls[1].cwd, '/tmp/workspace');
    service.dispose();
  });

  it('drives the antigravity source through the same per-agent loop', async () => {
    const spy = feedSpy(fakeFeed());
    const antigravity = fakeAdapter('antigravity', async () =>
      entryCaps([
        { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', efforts: ['low', 'high'] },
        { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', efforts: [] },
      ]),
    );
    const service = new ModelDiscoveryService({
      store: makeStore(fakeMemento()),
      registry: fakeRegistry({
        antigravity: antigravity.adapter,
        codex: fakeAdapter('codex', async () => caps(['gpt-5-codex'], ['high'])).adapter,
      }),
      fetchFeed: spy.fetchFeed,
    });

    const table = await service.refresh();

    assert.strictEqual(antigravity.calls.length, 1, 'the antigravity adapter runs exactly once');
    assert.strictEqual(
      antigravity.calls[0].feed,
      undefined,
      'only claude is handed the shared feed',
    );
    assert.strictEqual(table['antigravity']?.source, 'live');
    assert.strictEqual(table['antigravity']?.stale, false);
    assert.deepStrictEqual(table['antigravity']?.models, [
      { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', efforts: ['low', 'high'] },
      { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', efforts: [] },
    ]);
    assert.deepStrictEqual(
      table['antigravity']?.efforts,
      ['low', 'high'],
      'the snapshot-level efforts are the union of the per-entry levels',
    );
    assert.deepStrictEqual(Object.keys(table).sort(), ['antigravity', 'codex', 'models.dev']);

    // antigravity is the fifth catalog source, mapped like every other agent.
    assert.strictEqual(AGENT_CATALOG_SOURCE['antigravity'], 'antigravity');
    assert.deepStrictEqual(CATALOG_SOURCE_IDS, [
      'claude',
      'codex',
      'opencode',
      'antigravity',
      'models.dev',
    ]);
    service.dispose();
  });
});

describe('T07 ModelDiscoveryService.onDidChange', () => {
  it('fires with the current table, survives a throwing listener and unsubscribes on dispose', async () => {
    const logged: string[] = [];
    const seen: ModelCatalogTable[] = [];
    const service = new ModelDiscoveryService({
      store: makeStore(fakeMemento()),
      registry: fakeRegistry({
        codex: fakeAdapter('codex', async () => caps(['gpt-5-codex'])).adapter,
      }),
      fetchFeed: feedSpy(fakeFeed()).fetchFeed,
      log: (m) => logged.push(m),
    });
    const bad = service.onDidChange(() => {
      throw new Error('listener exploded');
    });
    const good = service.onDidChange((table) => seen.push(table));

    const table = await service.refresh();

    assert.ok(seen.length >= 2, 'one fire per applied source');
    assert.deepStrictEqual(seen[seen.length - 1], table);
    assert.ok(
      logged.some((m) => m.includes('listener exploded')),
      'a throwing listener is logged',
    );
    bad.dispose();

    good.dispose();
    const before = seen.length;
    await service.refresh();
    assert.strictEqual(seen.length, before, 'dispose() unsubscribes the handle');
    service.dispose();
  });
});

describe('T07 ModelDiscoveryService persistence', () => {
  it('persists the snapshots and rehydrates them as cached in a new store', async () => {
    const memento = fakeMemento();
    const service = new ModelDiscoveryService({
      store: makeStore(memento),
      registry: fakeRegistry({
        codex: fakeAdapter('codex', async () => caps(['gpt-5-codex'], ['high'])).adapter,
      }),
      fetchFeed: feedSpy(fakeFeed()).fetchFeed,
    });

    await service.refresh();
    service.dispose();

    assert.ok(
      memento.updates.some((u) => u.key === MODEL_CATALOG_MEMENTO_KEY),
      'the store persists through the injected memento',
    );
    const blob = memento.store.get(MODEL_CATALOG_MEMENTO_KEY) as {
      version: number;
      snapshots: Record<string, unknown>;
    };
    assert.strictEqual(blob.version, 1);
    assert.deepStrictEqual(Object.keys(blob.snapshots).sort(), ['codex', 'models.dev']);

    const second = new ModelDiscoveryService({
      store: makeStore(memento),
      registry: fakeRegistry({}),
      fetchFeed: feedSpy(fakeFeed()).fetchFeed,
    });
    const rehydrated = second.table();
    assert.strictEqual(rehydrated['codex']?.source, 'cached');
    assert.strictEqual(rehydrated['models.dev']?.source, 'cached');
    assert.deepStrictEqual(rehydrated['codex']?.models, [{ id: 'gpt-5-codex' }]);
    second.dispose();
  });

  it('per-model efforts and defaults survive the persistence round-trip, an empty list excepted', async () => {
    const memento = fakeMemento();
    const service = new ModelDiscoveryService({
      store: makeStore(memento),
      registry: fakeRegistry({
        antigravity: fakeAdapter('antigravity', async () =>
          entryCaps([
            { id: 'fam', efforts: ['low', 'high'], defaultEffort: 'high' },
            { id: 'fixed', efforts: [] },
          ]),
        ).adapter,
      }),
      fetchFeed: feedSpy(fakeFeed()).fetchFeed,
    });

    await service.refresh();
    service.dispose();

    const second = new ModelDiscoveryService({
      store: makeStore(memento),
      registry: fakeRegistry({}),
      fetchFeed: feedSpy(fakeFeed()).fetchFeed,
    });
    const cached = second.table()['antigravity'];
    assert.strictEqual(cached?.source, 'cached');
    assert.deepStrictEqual(cached?.models[0], {
      id: 'fam',
      efforts: ['low', 'high'],
      defaultEffort: 'high',
    });
    // `optionalStringArray` in src/orchestrator/modelCatalog.ts deliberately
    // drops an EMPTY array, so the "this model has no levels" marker does NOT
    // survive a reload: the rehydrated entry carries no `efforts` key at all and
    // the webview falls back to the agent-level union for it. That is the
    // recorded behaviour, not a defect to fix here.
    assert.deepStrictEqual(cached?.models[1], { id: 'fixed' });
    second.dispose();
  });
});

describe('T07 ModelDiscoveryService supersede and dispose', () => {
  it('aborts the in-flight refresh and drops everything the superseded run would write', async () => {
    const pending: Deferred<AgentCapabilities | undefined>[] = [];
    const codex = fakeAdapter('codex', () => {
      const d = deferred<AgentCapabilities | undefined>();
      pending.push(d);
      return d.promise;
    });
    const service = new ModelDiscoveryService({
      store: makeStore(fakeMemento()),
      registry: fakeRegistry({ codex: codex.adapter }),
      fetchFeed: feedSpy(fakeFeed()).fetchFeed,
    });

    const first = service.refresh();
    const second = service.refresh();

    assert.strictEqual(pending.length, 2, 'the second refresh starts its own adapter call');
    assert.strictEqual(
      codex.calls[0].signal?.aborted,
      true,
      'the superseded run’s signal is aborted',
    );
    assert.strictEqual(codex.calls[1].signal?.aborted, false);

    pending[0].resolve(caps(['superseded-model']));
    pending[1].resolve(caps(['winning-model']));
    const firstTable = await first;
    const secondTable = await second;

    assert.deepStrictEqual(secondTable['codex']?.models, [{ id: 'winning-model' }]);
    assert.deepStrictEqual(firstTable['codex']?.models, [{ id: 'winning-model' }]);
    assert.ok(
      !(firstTable['codex']?.models ?? []).some((m) => m.id === 'superseded-model'),
      'the superseded run writes nothing after the abort',
    );
    service.dispose();
  });

  it('dispose() aborts the refresh, stops the fires and short-circuits a later refresh', async () => {
    const pending: Deferred<AgentCapabilities | undefined>[] = [];
    const codex = fakeAdapter('codex', () => {
      const d = deferred<AgentCapabilities | undefined>();
      pending.push(d);
      return d.promise;
    });
    const fires: number[] = [];
    const service = new ModelDiscoveryService({
      store: makeStore(fakeMemento()),
      registry: fakeRegistry({ codex: codex.adapter }),
      fetchFeed: feedSpy(fakeFeed()).fetchFeed,
    });
    service.onDidChange(() => fires.push(1));

    const running = service.refresh();
    service.dispose();
    assert.strictEqual(codex.calls[0].signal?.aborted, true);
    pending[0].resolve(caps(['too-late']));
    const table = await running;
    assert.strictEqual(table['codex'], undefined, 'a disposed run writes nothing');
    assert.strictEqual(fires.length, 0, 'a disposed service fires no listener');

    const after = await service.refresh();
    assert.strictEqual(codex.calls.length, 1, 'a refresh after dispose calls no adapter');
    assert.deepStrictEqual(after, table);
  });
});

describe('T07 builtinCatalogFetches', () => {
  it('seeds exactly the four CLI sources with fresh objects on every call', () => {
    const first = builtinCatalogFetches();
    assert.deepStrictEqual(Object.keys(first).sort(), ['antigravity', 'claude', 'codex', 'opencode']);
    assert.ok(
      (first['antigravity']?.models ?? []).some((entry) => (entry.efforts ?? []).length > 0),
      "antigravity's seed carries per-family efforts on its entries",
    );
    assert.strictEqual(first['models.dev'], undefined, 'there is no curated feed fallback');
    assert.ok(
      (first['claude']?.models ?? []).some((entry) => entry.id === 'claude-sonnet-5'),
      'the curated claude list carries the default model',
    );
    assert.ok((first['codex']?.efforts ?? []).length > 0, 'codex discloses curated efforts');

    const second = builtinCatalogFetches();
    assert.notStrictEqual(second, first);
    assert.notStrictEqual(second['claude'], first['claude']);
    assert.notStrictEqual(second['claude']?.models, first['claude']?.models);
    assert.deepStrictEqual(second, first);
  });
});

describe('T07 host-free', () => {
  it('the module source contains no runtime vscode import', () => {
    const source = fs.readFileSync(
      path.join(__dirname, '..', 'src', 'activation', 'modelDiscovery.ts'),
      'utf8',
    );
    const runtimeImport = /(^|\n)\s*import\s+(?!type\b)[^;]*from\s+'[^']*vscode'/.test(source);
    assert.ok(!runtimeImport, 'modelDiscovery.ts must not import vscode at runtime');
    assert.ok(!/require\(.*vscode/.test(source), 'modelDiscovery.ts must not require vscode');
  });
});
