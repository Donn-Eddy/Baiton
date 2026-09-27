import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  CATALOG_SOURCE_IDS,
  CatalogFetch,
  CatalogStore,
  CatalogStoreOptions,
  CatalogSourceId,
  MODEL_CATALOG_MEMENTO_KEY,
  MODEL_CATALOG_PERSIST_VERSION,
  ModelCatalogSnapshot,
  SnapshotSource,
  effortsFor,
  findModel,
  isCatalogSourceId,
  mergePreservingExisting,
  mergeTablePreservingExisting,
  modelIds,
  normalizeModelEntry,
} from '../src/orchestrator/modelCatalog';
import { ok, err } from '../src/model/result';

/** A fake `vscode.Memento` (structural subset) backed by a plain Map. */
interface FakeMemento {
  store: Map<string, unknown>;
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): Thenable<void> | void;
}

function makeFakeMemento(
  update?: (key: string, value: unknown) => Thenable<void> | void,
  get?: <T>(key: string) => T | undefined,
): FakeMemento {
  const store = new Map<string, unknown>();
  return {
    store,
    get:
      get ??
      function fakeGet<T>(key: string): T | undefined {
        return store.get(key) as T | undefined;
      },
    update:
      update ??
      function fakeUpdate(key: string, value: unknown): Thenable<void> | void {
        store.set(key, value);
        return undefined;
      },
  };
}

/** A fake memento whose `update` throws synchronously. */
function throwingUpdateMemento(): FakeMemento {
  return makeFakeMemento(() => {
    throw new Error('update exploded');
  });
}

/** A fake memento whose `update` returns an already-rejected Thenable. */
function rejectingUpdateMemento(): FakeMemento {
  return makeFakeMemento(() => {
    const rejected = Promise.reject<void>(new Error('update rejected'));
    return rejected;
  });
}

/** A fake memento whose `get` throws. */
function throwingGetMemento(): FakeMemento {
  return makeFakeMemento(
    undefined,
    (key: string) => {
      void key;
      throw new Error('get exploded');
    },
  );
}

/** Deterministic clock producing `'2026-01-01T00:00:00.NNNZ'`-style ISO strings. */
function clock(): () => string {
  let ticks = 0;
  return () => {
    ticks += 1;
    return `2026-01-01T00:00:00.${String(ticks).padStart(3, '0')}Z`;
  };
}

/** A minimal valid snapshot literal for pure-helper tests. */
function snapshot(overrides: Partial<ModelCatalogSnapshot> = {}): ModelCatalogSnapshot {
  const base: {
    sourceId: CatalogSourceId;
    models: { id: string }[];
    fetchedAt: string;
    source: SnapshotSource;
    stale: boolean;
  } = {
    sourceId: 'claude',
    models: [{ id: 'claude-sonnet-4-5' }, { id: 'claude-haiku-4-5' }],
    fetchedAt: '2026-01-01T00:00:00.000Z',
    source: 'live',
    stale: false,
  };
  const out = { ...base, ...overrides } as ModelCatalogSnapshot;
  return out;
}

describe('orchestrator/modelCatalog', () => {
  describe('vocabulary', () => {
    it('CATALOG_SOURCE_IDS is exactly the known source order', () => {
      assert.deepStrictEqual([...CATALOG_SOURCE_IDS], ['claude', 'codex', 'opencode', 'models.dev']);
    });

    it('isCatalogSourceId accepts each known id', () => {
      for (const id of CATALOG_SOURCE_IDS) {
        assert.strictEqual(isCatalogSourceId(id), true);
      }
    });

    it('isCatalogSourceId rejects unknown values', () => {
      for (const value of ['anthropic', '', 42, null, undefined]) {
        assert.strictEqual(isCatalogSourceId(value), false);
      }
    });
  });

  describe('normalizeModelEntry', () => {
    it('accepts a plain string as { id: trimmed }', () => {
      assert.deepStrictEqual(normalizeModelEntry('grok-code'), { id: 'grok-code' });
      assert.deepStrictEqual(normalizeModelEntry('  grok-code  '), { id: 'grok-code' });
    });

    it('rejects empty, whitespace, and non-string scalars', () => {
      for (const value of ['', '   ', 42, null, true, undefined]) {
        assert.strictEqual(normalizeModelEntry(value), undefined);
      }
    });

    it('accepts an object with a non-empty string id and trims it', () => {
      assert.deepStrictEqual(normalizeModelEntry({ id: '  grok-code  ', label: 'Grok' }), {
        id: 'grok-code',
        label: 'Grok',
      });
    });

    it('rejects an object without a string id or with an empty id', () => {
      for (const value of [{}, { id: '' }, { id: '  ' }, { id: 42 }, { other: true }]) {
        assert.strictEqual(normalizeModelEntry(value), undefined);
      }
    });

    it('keeps efforts only when all members are non-empty strings', () => {
      assert.deepStrictEqual(normalizeModelEntry({ id: 'gpt-5-codex', efforts: ['low', 'high'] }), {
        id: 'gpt-5-codex',
        efforts: ['low', 'high'],
      });
      for (const efforts of [[], [42], ['low', ''], ['   '], ['low', null], 'low']) {
        assert.deepStrictEqual(normalizeModelEntry({ id: 'gpt-5-codex', efforts }), {
          id: 'gpt-5-codex',
        });
      }
    });

    it('keeps label/provider/defaultEffort only when non-empty strings', () => {
      assert.deepStrictEqual(normalizeModelEntry({ id: 'm', provider: 'x-ai', label: '  L  ', defaultEffort: 'high' }), {
        id: 'm',
        provider: 'x-ai',
        label: 'L',
        defaultEffort: 'high',
      });
      for (const field of ['provider', 'label', 'defaultEffort'] as const) {
        for (const bad of ['', '  ', 42, null]) {
          assert.deepStrictEqual(normalizeModelEntry({ id: 'm', [field]: bad }), { id: 'm' });
        }
      }
    });

    it('keeps custom only when true and drops unknown extra keys', () => {
      assert.deepStrictEqual(normalizeModelEntry({ id: 'm', custom: true, extra: 'drop' }), {
        id: 'm',
        custom: true,
      });
      assert.deepStrictEqual(normalizeModelEntry({ id: 'm', custom: false, extra: 'drop' }), {
        id: 'm',
      });
    });
  });

  describe('modelIds / findModel / effortsFor', () => {
    it('return empty for an undefined snapshot', () => {
      assert.deepStrictEqual(modelIds(undefined), []);
      assert.strictEqual(findModel(undefined, 'claude-sonnet-4-5'), undefined);
      assert.deepStrictEqual(effortsFor(undefined, 'claude-sonnet-4-5'), []);
    });

    it('modelIds lists the ids in order', () => {
      const snap = snapshot({ models: [{ id: 'b' }, { id: 'a' }] });
      assert.deepStrictEqual([...modelIds(snap)], ['b', 'a']);
    });

    it('findModel matches exact ids', () => {
      const snap = snapshot();
      assert.strictEqual(findModel(snap, 'claude-haiku-4-5'), snap.models[1]);
      assert.strictEqual(findModel(snap, 'nope'), undefined);
    });

    it('per-model efforts win over snapshot-level efforts', () => {
      const snap = snapshot({ efforts: ['minimal', 'high'], models: [{ id: 'm1', efforts: ['low'] }, { id: 'm2' }] });
      assert.deepStrictEqual([...effortsFor(snap, 'm1')], ['low']);
    });

    it('snapshot-level efforts are the fallback and unknown ids yield []', () => {
      const snap = snapshot({ efforts: ['minimal', 'high'], models: [{ id: 'm2' }] });
      assert.deepStrictEqual([...effortsFor(snap, 'm2')], ['minimal', 'high']);
      assert.deepStrictEqual(effortsFor(snap, 'unknown'), []);
      const bare = snapshot();
      assert.deepStrictEqual(effortsFor(bare, 'claude-sonnet-4-5'), []);
    });
  });

  describe('mergePreservingExisting', () => {
    it('appends a configured value missing from the refreshed list at the end as custom', () => {
      const snap = snapshot();
      const merged = mergePreservingExisting(snap, ['my-custom-model']);
      assert.deepStrictEqual(merged.models.slice(-1), [{ id: 'my-custom-model', custom: true }]);
      assert.deepStrictEqual(merged.models.slice(0, -1), snap.models);
    });

    it('does not duplicate a value already present in the refreshed list', () => {
      const snap = snapshot();
      const merged = mergePreservingExisting(snap, ['claude-haiku-4-5']);
      assert.deepStrictEqual(merged.models, snap.models);
    });

    it('skips undefined, empty and whitespace-only values', () => {
      const snap = snapshot();
      const merged = mergePreservingExisting(snap, [undefined, '', '   ']);
      assert.deepStrictEqual(merged.models, snap.models);
    });

    it('dedupes repeated existing values, keeping the first order', () => {
      const snap = snapshot();
      const merged = mergePreservingExisting(snap, ['alpha', 'beta', 'alpha', ' alpha ']);
      assert.deepStrictEqual(merged.models.slice(2), [
        { id: 'alpha', custom: true },
        { id: 'beta', custom: true },
      ]);
    });

    it('preserves refreshed order and appends survivors in the given order', () => {
      const snap = snapshot({ models: [{ id: 'first' }, { id: 'second' }] });
      const merged = mergePreservingExisting(snap, ['z', 'a', 'first', 'm']);
      assert.deepStrictEqual(merged.models.slice(2), [
        { id: 'z', custom: true },
        { id: 'a', custom: true },
        { id: 'm', custom: true },
      ]);
    });

    it('returns a new object without mutating the input', () => {
      const snap = snapshot();
      const lengthBefore = snap.models.length;
      const merged = mergePreservingExisting(snap, ['brand-new']);
      assert.notStrictEqual(merged, snap);
      assert.deepStrictEqual(
        merged,
        snapshot({
          models: [...snap.models, { id: 'brand-new', custom: true }],
        }),
      );
      assert.strictEqual(snap.models.length, lengthBefore);
    });

    it('a merge with nothing new is still a new object, structurally equal', () => {
      const snap = snapshot();
      const merged = mergePreservingExisting(snap, []);
      assert.notStrictEqual(merged, snap);
      assert.deepStrictEqual(merged, snap);
    });

    it('carries stale and staleReason through unchanged', () => {
      const snap = snapshot({ stale: true, staleReason: 'feed down' });
      const merged = mergePreservingExisting(snap, ['extra']);
      assert.strictEqual(merged.stale, true);
      assert.strictEqual(merged.staleReason, 'feed down');
      assert.strictEqual(merged.fetchedAt, snap.fetchedAt);
      assert.strictEqual(merged.source, 'live');
      assert.strictEqual(merged.sourceId, 'claude');
    });
  });

  describe('mergeTablePreservingExisting', () => {
    it('merges per present source and leaves absent sources untouched', () => {
      const table = {
        claude: snapshot(),
        codex: snapshot({ sourceId: 'codex', models: [{ id: 'gpt-5-codex' }] }),
      } as const;
      const merged = mergeTablePreservingExisting(table, {
        claude: ['mine'],
        codex: ['gpt-5-codex', '  '],
        opencode: ['never-present'],
      });
      assert.deepStrictEqual(modelIds(merged['claude']), ['claude-sonnet-4-5', 'claude-haiku-4-5', 'mine']);
      assert.deepStrictEqual(modelIds(merged['codex']), ['gpt-5-codex']);
      assert.strictEqual(merged['opencode'], undefined);
      assert.strictEqual(merged['models.dev'], undefined);
    });
  });

  describe('CatalogStore.applyResult', () => {
    let options: () => CatalogStoreOptions;

    beforeEach(() => {
      options = () => ({ now: clock() });
    });

    it('success records source live, not stale, and the injected fetchedAt', () => {
      const store = new CatalogStore(options());
      const result = store.applyResult('claude', ok<CatalogFetch, string>({ models: [{ id: 'claude-sonnet-4-5' }] }));
      assert.deepStrictEqual(result, {
        sourceId: 'claude',
        models: [{ id: 'claude-sonnet-4-5' }],
        fetchedAt: '2026-01-01T00:00:00.001Z',
        source: 'live',
        stale: false,
      });
      assert.strictEqual(store.get('claude')?.stale, false);
    });

    it('a subsequent failure keeps the previous models and fetchedAt and marks stale', () => {
      const store = new CatalogStore(options());
      store.applyResult('claude', ok<CatalogFetch, string>({ models: [{ id: 'claude-sonnet-4-5' }] }));
      const afterFailure = store.applyResult('claude', err<string, CatalogFetch>('feed down'));
      assert.deepStrictEqual(afterFailure, {
        sourceId: 'claude',
        models: [{ id: 'claude-sonnet-4-5' }],
        fetchedAt: '2026-01-01T00:00:00.001Z',
        source: 'live',
        stale: true,
        staleReason: 'feed down',
      });
    });

    it('a later success clears stale and staleReason and advances fetchedAt', () => {
      const store = new CatalogStore(options());
      store.applyResult('claude', ok<CatalogFetch, string>({ models: [{ id: 'claude-sonnet-4-5' }] }));
      store.applyResult('claude', err<string, CatalogFetch>('feed down'));
      const recovered = store.applyResult('claude', ok<CatalogFetch, string>({ models: [{ id: 'claude-sonnet-4-5' }, { id: 'claude-haiku-4-5' }] }));
      assert.strictEqual(recovered?.stale, false);
      assert.strictEqual(recovered?.staleReason, undefined);
      assert.strictEqual(recovered?.fetchedAt, '2026-01-01T00:00:00.002Z');
    });

    it('a failure with no previous snapshot and no builtin records nothing', () => {
      const store = new CatalogStore(options());
      assert.strictEqual(store.applyResult('claude', err<string, CatalogFetch>('feed down')), undefined);
      assert.strictEqual(store.get('claude'), undefined);
    });

    it('a failure with only a builtin marks the builtin snapshot stale but keeps its models', () => {
      const store = new CatalogStore({
        ...options(),
        builtins: { claude: { models: [{ id: 'builtin-1' }] } },
      });
      assert.strictEqual(store.get('claude')?.source, 'builtin');
      const afterFailure = store.applyResult('claude', err<string, CatalogFetch>('feed down'));
      assert.deepStrictEqual(afterFailure, {
        sourceId: 'claude',
        models: [{ id: 'builtin-1' }],
        fetchedAt: '2026-01-01T00:00:00.001Z',
        source: 'builtin',
        stale: true,
        staleReason: 'feed down',
      });
    });

    it('table() is a shallow copy; mutating it does not affect later reads', () => {
      const store = new CatalogStore(options());
      store.applyResult('claude', ok<CatalogFetch, string>({ models: [{ id: 'claude-sonnet-4-5' }] }));
      const first = store.table();
      assert.deepStrictEqual(modelIds(first['claude']), ['claude-sonnet-4-5']);
      delete (first as Record<string, unknown>)['claude'];
      assert.strictEqual(store.get('claude')?.source, 'live');
      assert.notStrictEqual(store.table(), store.table());
      assert.strictEqual(store.table()['claude']?.source, 'live');
    });
  });

  describe('CatalogStore persistence', () => {
    it('applyResult writes { version: 1, snapshots: … } under the memento key', () => {
      const memento = makeFakeMemento();
      const store = new CatalogStore({ memento, now: clock() });
      store.applyResult('claude', ok<CatalogFetch, string>({ models: [{ id: 'claude-sonnet-4-5' }] }));
      const blob = memento.store.get(MODEL_CATALOG_MEMENTO_KEY) as Record<string, unknown>;
      assert.deepStrictEqual(blob['version'], MODEL_CATALOG_PERSIST_VERSION);
      const snapshots = blob['snapshots'] as Record<string, ModelCatalogSnapshot>;
      assert.deepStrictEqual(modelIds(snapshots['claude']), ['claude-sonnet-4-5']);
    });

    it('a new store over the same memento rehydrates the snapshot as cached', () => {
      const memento = makeFakeMemento();
      const first = new CatalogStore({ memento, now: clock() });
      first.applyResult('claude', ok<CatalogFetch, string>({ models: [{ id: 'claude-sonnet-4-5' }] }));
      first.applyResult('claude', err<string, CatalogFetch>('feed down'));
      const second = new CatalogStore({ memento, now: clock() });
      assert.strictEqual(second.get('claude')?.source, 'cached');
      assert.strictEqual(second.get('claude')?.stale, true);
      assert.strictEqual(second.get('claude')?.staleReason, 'feed down');
      assert.strictEqual(second.get('claude')?.fetchedAt, '2026-01-01T00:00:00.001Z');
      assert.deepStrictEqual(modelIds(second.get('claude')), ['claude-sonnet-4-5']);
    });

    it('a wrong-version or non-object blob is discarded without throwing', () => {
      for (const bad of [
        undefined,
        null,
        'nope',
        42,
        { version: 99 },
        { version: 1 },
        { version: 1, snapshots: 'nope' },
      ]) {
        const memento = makeFakeMemento();
        memento.store.set(MODEL_CATALOG_MEMENTO_KEY, bad as unknown);
        assert.doesNotThrow(() => new CatalogStore({ memento }));
        const store = new CatalogStore({ memento });
        assert.strictEqual(store.get('claude'), undefined, `expected discard for ${JSON.stringify(bad)}`);
      }
    });

    it('a snapshot under an unknown source key is skipped silently', () => {
      const memento = makeFakeMemento();
      memento.store.set(MODEL_CATALOG_MEMENTO_KEY, {
        version: 1,
        snapshots: {
          anthropic: { sourceId: 'claude', models: [{ id: 'x' }], fetchedAt: '2025-01-01T00:00:00.000Z', source: 'cached', stale: false },
          claude: { sourceId: 'claude', models: 'nope', fetchedAt: '2025-01-01T00:00:00.000Z', source: 'cached', stale: false },
          codex: {
            sourceId: 'codex',
            models: [{ id: 'gpt-5-codex' }, 42, { id: '' }, 'openai/gpt-5-codex'],
            fetchedAt: '2025-01-01T00:00:00.000Z',
            source: 'cached',
            stale: false,
          },
        },
      });
      const store = new CatalogStore({ memento });
      assert.strictEqual(store.get('claude'), undefined);
      assert.deepStrictEqual(modelIds(store.get('codex')), ['gpt-5-codex', 'openai/gpt-5-codex']);
    });

    it('a memento whose get throws still constructs', () => {
      assert.doesNotThrow(() => new CatalogStore({ memento: throwingGetMemento() }));
      const store = new CatalogStore({ memento: throwingGetMemento() });
      assert.strictEqual(store.get('claude'), undefined);
    });

    it('a throwing or rejecting update does not fail applyResult and raises no unhandled rejection', async function () {
      this.timeout(10_000);
      const unhandled: unknown[] = [];
      const onUnhandled = (error: unknown): void => {
        unhandled.push(error);
      };
      process.on('unhandledRejection', onUnhandled);
      try {
        const throwing = new CatalogStore({ memento: throwingUpdateMemento(), now: clock() });
        const recorded = throwing.applyResult('claude', ok<CatalogFetch, string>({ models: [{ id: 'x' }] }));
        assert.strictEqual(recorded?.source, 'live');

        const rejecting = new CatalogStore({ memento: rejectingUpdateMemento(), now: clock() });
        const rejectedOk = rejecting.applyResult('claude', ok<CatalogFetch, string>({ models: [{ id: 'y' }] }));
        assert.strictEqual(rejectedOk?.source, 'live');

        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.deepStrictEqual(unhandled, []);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });

    it('clear() drops all snapshots and persists the empty table', () => {
      const memento = makeFakeMemento();
      const store = new CatalogStore({ memento, now: clock() });
      store.applyResult('claude', ok<CatalogFetch, string>({ models: [{ id: 'x' }] }));
      store.clear();
      assert.strictEqual(store.get('claude'), undefined);
      const blob = memento.store.get(MODEL_CATALOG_MEMENTO_KEY) as { snapshots: Record<string, unknown> };
      assert.deepStrictEqual(blob.snapshots, {});
    });
  });

  describe('CatalogStore builtins', () => {
    it('a source with only a builtin entry reports builtin, not stale', () => {
      const store = new CatalogStore({
        builtins: { claude: { models: [{ id: 'builtin-1' }], efforts: ['medium'] } },
        now: clock(),
      });
      assert.deepStrictEqual(store.get('claude'), {
        sourceId: 'claude',
        models: [{ id: 'builtin-1' }],
        efforts: ['medium'],
        fetchedAt: '2026-01-01T00:00:00.001Z',
        source: 'builtin',
        stale: false,
      });
      assert.ok(Object.keys(store.table()).length === 1);
    });

    it('a hydrated cached snapshot wins over the builtin for the same source', () => {
      const memento = makeFakeMemento();
      memento.store.set(MODEL_CATALOG_MEMENTO_KEY, {
        version: 1,
        snapshots: {
          claude: {
            sourceId: 'claude',
            models: [{ id: 'cached-1' }],
            fetchedAt: '2025-06-01T00:00:00.000Z',
            source: 'cached',
            stale: false,
          },
        },
      });
      const store = new CatalogStore({
        memento,
        builtins: { claude: { models: [{ id: 'builtin-1' }] } },
      });
      assert.deepStrictEqual(store.get('claude'), {
        sourceId: 'claude',
        models: [{ id: 'cached-1' }],
        fetchedAt: '2025-06-01T00:00:00.000Z',
        source: 'cached',
        stale: false,
      });
    });
  });

  describe('host-free', () => {
    it('the module source contains no vscode import', () => {
      const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'orchestrator', 'modelCatalog.ts'), 'utf8');
      assert.ok(!/from '.*vscode'/.test(source), 'modelCatalog.ts must not import vscode');
      assert.ok(!/require\(.*vscode/.test(source), 'modelCatalog.ts must not require vscode');
    });
  });
});
