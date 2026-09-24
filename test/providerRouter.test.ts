import * as assert from 'assert';

/**
 * Unit tests for the host-side ProviderRouter (multi-provider orchestrator).
 *
 * `src/activation/providerRouter.ts` imports `vscode` as a TYPE ONLY and takes
 * every runtime dependency through `ProviderRouterConfig`, so this suite
 * STATICALLY imports the module — no loader-registration dance is needed,
 * unlike `test/setApiKey.test.ts`: the module never requires `vscode` at
 * runtime, so there is nothing to redirect.
 *
 * The fakes are local to the file: `FakeSecrets` (a Map plus a `failGet`
 * flag), `FakeMemento` (a Map plus recorded `updates`), a plain settings
 * object with mutable fields behind the four `ProviderSettings` getters, and
 * `fakeLm` standing in for the `vscode` namespace with `lm.selectChatModels`
 * (plus the message-part constructors the default Copilot client touches).
 * A `RecordingClient` rides through `ProviderRouterConfig.createClient` to
 * observe routing without touching any real HTTP surface.
 */

import {
  COPILOT_UNAVAILABLE_REASON,
  MODEL_SELECTION_KEY,
  PROVIDER_IDS,
  PROVIDER_NEEDS_ENDPOINT_REASON,
  ModelSelection,
  ProviderId,
  defaultModelFor,
  providerInfo,
  providerNeedsKeyReason,
  providerSecretKey,
} from '../src/orchestrator/providers';
import {
  CompletionRequest,
  CompletionResult,
  MissingConfigError,
  ModelClient,
  UnreachableEndpointError,
} from '../src/orchestrator/modelClient';
import {
  CopilotVscodeApi,
  COPILOT_VENDOR,
} from '../src/orchestrator/copilotClient';
import {
  ClientConfigDeps,
  ProviderRouter,
  ProviderRouterConfig,
  ProviderSettings,
  SecretsLike,
  MementoLike,
  providerClientConfig,
} from '../src/activation/providerRouter';

// --- fakes -------------------------------------------------------------------

/** A fake SecretStorage: a Map plus a failure flag for `get`. */
class FakeSecrets implements SecretsLike {
  public readonly values = new Map<string, string>();
  /** When true, `get` throws instead of resolving (degrades availability). */
  public failGet = false;

  public async get(key: string): Promise<string | undefined> {
    if (this.failGet) {
      throw new Error('secret storage unavailable');
    }
    return this.values.get(key);
  }
}

/** A fake `vscode.Memento` (`workspaceState`) recording every `update` call. */
class FakeMemento implements MementoLike {
  public readonly values = new Map<string, unknown>();
  public readonly updates: Array<{ key: string; value: unknown }> = [];
  public failGet = false;
  public failUpdate = false;

  public get<T>(key: string): T | undefined {
    if (this.failGet) {
      throw new Error('workspace state unavailable');
    }
    return this.values.get(key) as T | undefined;
  }

  public update(key: string, value: unknown): Promise<void> {
    this.updates.push({ key, value });
    this.values.set(key, value);
    return this.failUpdate
      ? Promise.reject(new Error('workspace state unavailable'))
      : Promise.resolve();
  }
}

/** The mutable settings state behind the four `ProviderSettings` getters. */
interface MutableSettings {
  endpoint: string | undefined;
  model: string | undefined;
  streaming: boolean;
  maxTokens: unknown;
}

function makeSettings(): ProviderSettings & MutableSettings {
  const state: MutableSettings = {
    endpoint: undefined,
    model: undefined,
    streaming: false,
    maxTokens: undefined,
  };
  return {
    get endpoint(): string | undefined {
      return state.endpoint;
    },
    set endpoint(value: string | undefined) {
      state.endpoint = value;
    },
    get model(): string | undefined {
      return state.model;
    },
    set model(value: string | undefined) {
      state.model = value;
    },
    get streaming(): boolean {
      return state.streaming;
    },
    set streaming(value: boolean) {
      state.streaming = value;
    },
    get maxTokens(): unknown {
      return state.maxTokens;
    },
    set maxTokens(value: unknown) {
      state.maxTokens = value;
    },
    getEndpoint: () => state.endpoint,
    getModel: () => state.model,
    isStreaming: () => state.streaming,
    getMaxTokens: () => state.maxTokens,
  };
}

/** A fake `LanguageModelChat`: just the id/family shape enumeration needs. */
interface FakeChatModel {
  id: string;
  family: string;
}

/** The last `selectChatModels` selector the fake saw. */
let lastSelector: { vendor: string } | undefined;

/**
 * Builds a fake `vscode` namespace. `lm.selectChatModels` returns `models`
 * (or rejects with `failSelector`). The message-part constructors and token
 * source are present so the DEFAULT Copilot client (used only by the
 * `modelFor('copilot')` test) reaches `chat.sendRequest` without a host.
 */
function fakeLm(
  models: FakeChatModel[] = [],
  opts: { failSelector?: boolean } = {},
): CopilotVscodeApi {
  lastSelector = undefined;
  return {
    lm: {
      selectChatModels: async (selector: { vendor: string }) => {
        lastSelector = selector;
        if (opts.failSelector) {
          throw new Error('lm unavailable');
        }
        return models as never;
      },
    },
    LanguageModelChatMessage: {
      User: (content: unknown) => ({ role: 'user', content }),
      Assistant: (content: unknown) => ({ role: 'assistant', content }),
    },
    LanguageModelTextPart: function (this: { value: unknown }, value: unknown) {
      this.value = value;
    } as unknown as new (value: string) => unknown,
    LanguageModelToolResultPart: function (
      this: { callId: unknown; value: unknown },
      callId: unknown,
      parts: unknown,
    ) {
      this.callId = callId;
      this.value = parts;
    } as unknown as new (id: string, parts: unknown[]) => unknown,
    CancellationTokenSource: class {
      public readonly token = { isCancellationRequested: false };
      public cancel(): void {}
      public dispose(): void {}
    } as unknown as new () => unknown,
  } as unknown as CopilotVscodeApi;
}

/** A canned completion a RecordingClient hands back. */
const CANNED: CompletionResult = {
  content: 'ok',
  tool_calls: [{ id: 'c1', name: 'tool', arguments: '{}' }],
};

/** A client that records every request and returns a canned result (or fails). */
class RecordingClient implements ModelClient {
  public readonly requests: CompletionRequest[] = [];
  constructor(
    private readonly result: CompletionResult = CANNED,
    private readonly failWith?: Error,
  ) {}
  public async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(req);
    if (this.failWith !== undefined) {
      throw this.failWith;
    }
    return this.result;
  }
}

interface RouterHarness {
  router: ProviderRouter;
  secrets: FakeSecrets;
  memento: FakeMemento;
  settings: ProviderSettings & MutableSettings;
  lm: CopilotVscodeApi;
  /** Per-provider recording client, populated by `createClient`. */
  clients: Map<ProviderId, RecordingClient>;
  constructions: Array<ProviderId>;
}

/**
 * Builds a router whose clients are `RecordingClient`s via `createClient`.
 * With `defaultClients: true` the real clients are built instead (used only
 * by the `modelFor('copilot')` wiring test, which needs a working fake host).
 */
function makeHarness(opts: {
  secrets?: FakeSecrets;
  memento?: FakeMemento;
  lm?: CopilotVscodeApi;
  defaultClients?: boolean;
} = {}): RouterHarness {
  const secrets = opts.secrets ?? new FakeSecrets();
  const memento = opts.memento ?? new FakeMemento();
  const settings = makeSettings();
  const lm = opts.lm ?? fakeLm([{ id: 'fake-model', family: 'fake-fam' }]);
  const clients = new Map<ProviderId, RecordingClient>();
  const constructions: ProviderId[] = [];
  const config: ProviderRouterConfig = {
    secrets,
    workspaceState: memento,
    settings,
    lm,
    version: '1.2.3',
    createClient:
      opts.defaultClients === true
        ? undefined
        : (id) => {
            constructions.push(id);
            const client = new RecordingClient();
            clients.set(id, client);
            return client;
          },
  };
  return { router: new ProviderRouter(config), secrets, memento, settings, lm, clients, constructions };
}

/** Builds a `CompletionRequest` with identity-checkable parts. */
function makeReq(sessionId?: string, onDelta?: (text: string) => void): CompletionRequest {
  return {
    messages: [{ role: 'user', content: 'hi' }],
    signal: new AbortController().signal,
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(onDelta !== undefined ? { onDelta } : {}),
  };
}

/** Client-config deps whose model choice is a mutable local slot. */
function makeDeps(
  secrets: FakeSecrets,
  settings: ProviderSettings & MutableSettings,
): ClientConfigDeps & {
  settings: ProviderSettings & MutableSettings;
  setChosen(value: string | undefined): void;
} {
  const state: { chosen: string | undefined } = { chosen: undefined };
  return {
    secrets,
    settings,
    version: '1.2.3',
    getModel: () => state.chosen,
    setChosen: (value) => {
      state.chosen = value;
    },
  };
}

// --- providerClientConfig ----------------------------------------------------

describe('providerClientConfig', () => {
  it('google: endpoint is the catalog base and the dialect is the gemini shaping', () => {
    const deps = makeDeps(new FakeSecrets(), makeSettings());
    const cfg = providerClientConfig('google', deps);

    assert.strictEqual(cfg.getEndpoint(), providerInfo('google').defaultBaseUrl);
    const shaped = cfg.dialect!.shapeMessages([
      { role: 'assistant', content: '', tool_calls: [{ id: '1', name: 'tool', arguments: '{}' }] },
    ]);
    // The gemini shaping drops `content` from an empty-content assistant
    // tool_calls turn (the wire shape Gemini rejects otherwise).
    assert.deepStrictEqual(shaped, [
      {
        role: 'assistant',
        tool_calls: [{ id: '1', type: 'function', function: { name: 'tool', arguments: '{}' } }],
      },
    ]);
    assert.ok(!('content' in shaped[0]), 'the empty assistant content key must be dropped');
    assert.strictEqual('extraHeaders' in cfg, false, 'google gets no extra headers');
  });

  it('mistral: the openai dialect (content always present) and no extraHeaders', () => {
    const deps = makeDeps(new FakeSecrets(), makeSettings());
    const cfg = providerClientConfig('mistral', deps);

    assert.strictEqual(cfg.getEndpoint(), providerInfo('mistral').defaultBaseUrl);
    const shaped = cfg.dialect!.shapeMessages([
      { role: 'assistant', content: '', tool_calls: [{ id: '1', name: 'tool', arguments: '{}' }] },
    ]);
    assert.deepStrictEqual(shaped[0].content, '', 'the openai dialect keeps empty content');
    assert.strictEqual('extraHeaders' in cfg, false, 'mistral gets no extra headers');
  });

  it('opencode: extra headers carry the User-Agent and a stable session uuid', () => {
    const deps = makeDeps(new FakeSecrets(), makeSettings());
    const cfg = providerClientConfig('opencode', deps);

    assert.ok(cfg.extraHeaders !== undefined, 'opencode gets extraHeaders');
    const first = cfg.extraHeaders(makeReq('session-a'))!;
    const second = cfg.extraHeaders(makeReq('session-a'))!;
    const other = cfg.extraHeaders(makeReq('session-b'))!;

    assert.deepStrictEqual(first, {
      'user-agent': 'baiton/1.2.3',
      'x-opencode-session': first['x-opencode-session'],
    });
    assert.strictEqual(
      second['x-opencode-session'],
      first['x-opencode-session'],
      'the session uuid is stable for the same sessionId',
    );
    assert.notStrictEqual(
      other['x-opencode-session'],
      first['x-opencode-session'],
      'a different sessionId mints a different uuid',
    );
  });

  it('openai: endpoint and model read the settings and change when the settings change', () => {
    const deps = makeDeps(new FakeSecrets(), makeSettings());
    deps.settings.endpoint = 'https://api.example.com';

    const cfg = providerClientConfig('openai', deps);

    assert.strictEqual(cfg.getEndpoint(), 'https://api.example.com');
    assert.strictEqual(cfg.getModel(), undefined, 'no chosen model and no setting yet');
    deps.setChosen('chosen-1');
    assert.strictEqual(cfg.getModel(), 'chosen-1', 'the chosen model wins');
    deps.setChosen(undefined);
    deps.settings.model = 'gpt-x';
    assert.strictEqual(cfg.getModel(), 'gpt-x', 'the setting is read at call time');
    deps.settings.endpoint = 'https://other.example.com';
    assert.strictEqual(cfg.getEndpoint(), 'https://other.example.com');
  });

  it('openai: getApiKey reads and trims the per-provider secret, undefined for whitespace', async () => {
    const secrets = new FakeSecrets();
    const deps = makeDeps(secrets, makeSettings());
    const cfg = providerClientConfig('openai', deps);

    assert.strictEqual(await cfg.getApiKey(), undefined, 'no secret stored yet');
    secrets.values.set(providerSecretKey('openai')!, '  sk-1  ');
    assert.strictEqual(await cfg.getApiKey(), 'sk-1', 'the key is read and trimmed');
    secrets.values.set(providerSecretKey('openai')!, '   ');
    assert.strictEqual(await cfg.getApiKey(), undefined, 'a whitespace value is no key');
  });

  it('calling it with copilot is a programmer error', () => {
    const deps = makeDeps(new FakeSecrets(), makeSettings());
    assert.throws(() => providerClientConfig('copilot', deps), /copilot has no OpenAI-compatible client config/);
  });
});

// --- availability ------------------------------------------------------------

describe('ProviderRouter.availability', () => {
  it('returns one entry per provider in PROVIDER_IDS order', async () => {
    const h = makeHarness();
    const list = await h.router.availability();
    assert.deepStrictEqual(
      list.map((a) => a.id),
      [...PROVIDER_IDS],
      'PROVIDER_IDS order',
    );
    for (const entry of list) {
      assert.ok(entry.label.length > 0);
      if (entry.enabled) {
        assert.strictEqual('reason' in entry, false, `${entry.id} must not carry a reason`);
      } else {
        assert.ok(
          typeof entry.reason === 'string' && entry.reason.length > 0,
          `disabled ${entry.id} must carry a reason`,
        );
      }
      assert.ok(Array.isArray(entry.models));
    }
  });

  it('keyed providers flip `enabled` with the secret and report the catalog reason', async () => {
    const h = makeHarness({ lm: fakeLm([]) });
    let list = await h.router.availability();
    const google = list.find((a) => a.id === 'google')!;
    const mistral = list.find((a) => a.id === 'mistral')!;
    const opencode = list.find((a) => a.id === 'opencode')!;

    assert.strictEqual(google.enabled, false);
    assert.strictEqual(google.reason, providerNeedsKeyReason('google'));
    assert.deepStrictEqual(google.models, ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite']);
    assert.strictEqual(mistral.enabled, false);
    assert.strictEqual(mistral.reason, providerNeedsKeyReason('mistral'));
    assert.strictEqual(opencode.enabled, false);
    assert.strictEqual(opencode.reason, providerNeedsKeyReason('opencode'));

    h.secrets.values.set(providerSecretKey('google')!, '  g-key  ');
    list = await h.router.availability();
    assert.strictEqual(list.find((a) => a.id === 'google')!.enabled, true, 'a secret enables google');
    assert.strictEqual('reason' in list.find((a) => a.id === 'google')!, false);
    assert.strictEqual(list.find((a) => a.id === 'mistral')!.enabled, false, 'the other providers do not flip');
  });

  it('openai needs key AND endpoint; the reason follows the deterministic key-first check', async () => {
    const h = makeHarness({ lm: fakeLm([]) });
    let openai = (await h.router.availability()).find((a) => a.id === 'openai')!;
    assert.strictEqual(openai.enabled, false);
    assert.strictEqual(openai.reason, providerNeedsKeyReason('openai'), 'the key is checked first');
    assert.deepStrictEqual(openai.models, []);

    h.secrets.values.set(providerSecretKey('openai')!, 'sk');
    openai = (await h.router.availability()).find((a) => a.id === 'openai')!;
    assert.strictEqual(openai.enabled, false);
    assert.strictEqual(openai.reason, PROVIDER_NEEDS_ENDPOINT_REASON, 'then the endpoint');

    h.settings.endpoint = 'https://api.example.com';
    openai = (await h.router.availability()).find((a) => a.id === 'openai')!;
    assert.strictEqual(openai.enabled, true);
    assert.strictEqual('reason' in openai, false);
    assert.deepStrictEqual(openai.models, [], 'no model setting yet');

    h.settings.model = 'gpt-x';
    openai = (await h.router.availability()).find((a) => a.id === 'openai')!;
    assert.deepStrictEqual(openai.models, ['gpt-x'], 'the model setting is the enumeration');
  });

  it('copilot: enumerates model ids (deduped, in order) through selectChatModels', async () => {
    const h = makeHarness({
      lm: fakeLm([
        { id: 'm2', family: 'f2' },
        { id: 'm1', family: 'f1' },
        { id: 'm2', family: 'f2' },
      ]),
    });
    const copilot = (await h.router.availability()).find((a) => a.id === 'copilot')!;

    assert.strictEqual(lastSelector?.vendor, COPILOT_VENDOR, 'the copilot vendor selector is used');
    assert.strictEqual(copilot.enabled, true);
    assert.deepStrictEqual(copilot.models, ['m2', 'm1'], 'de-duplicated, in the order returned');
    assert.strictEqual('reason' in copilot, false);
  });

  it('copilot: disabled with the availability reason both for an empty list and a rejection', async () => {
    let h = makeHarness({ lm: fakeLm([]) });
    let copilot = (await h.router.availability()).find((a) => a.id === 'copilot')!;
    assert.strictEqual(copilot.enabled, false);
    assert.strictEqual(copilot.reason, COPILOT_UNAVAILABLE_REASON);
    assert.deepStrictEqual(copilot.models, []);

    h = makeHarness({ lm: fakeLm([], { failSelector: true }) });
    copilot = (await h.router.availability()).find((a) => a.id === 'copilot')!;
    assert.strictEqual(copilot.enabled, false);
    assert.strictEqual(copilot.reason, COPILOT_UNAVAILABLE_REASON);
    assert.deepStrictEqual(copilot.models, []);
  });

  it('a throwing secrets.get degrades to disabled without throwing', async () => {
    const h = makeHarness();
    h.secrets.failGet = true;
    const list = await h.router.availability();

    const google = list.find((a) => a.id === 'google')!;
    assert.strictEqual(google.enabled, false);
    assert.strictEqual(google.reason, providerNeedsKeyReason('google'));
    const openai = list.find((a) => a.id === 'openai')!;
    assert.strictEqual(openai.enabled, false);
    assert.strictEqual(openai.reason, providerNeedsKeyReason('openai'), 'no readable key = no key');
    // copilot never reads secrets, so it stays whatever lm reports.
    assert.strictEqual(list.find((a) => a.id === 'copilot')!.enabled, true);
  });

  it('enabledProviders and modelsFor are conveniences over availability', async () => {
    const h = makeHarness();
    h.secrets.values.set(providerSecretKey('google')!, 'g');
    h.secrets.values.set(providerSecretKey('mistral')!, 'm');
    h.secrets.values.set(providerSecretKey('openai')!, 'k');
    h.settings.endpoint = 'https://api.example.com';

    assert.deepStrictEqual(
      await h.router.enabledProviders(),
      ['copilot', 'google', 'mistral', 'openai'],
      'opencode lacks a key; openai needs only key + endpoint here',
    );
    assert.deepStrictEqual(
      [...(await h.router.modelsFor('google'))],
      ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
    );
    assert.deepStrictEqual([...(await h.router.modelsFor('copilot'))], ['fake-model']);
    assert.deepStrictEqual([...(await h.router.modelsFor('openai'))], [], 'no model setting = no models');
  });
});

// --- init --------------------------------------------------------------------

describe('ProviderRouter.init', () => {
  it('restores a valid persisted selection without rewriting and without firing', async () => {
    const h = makeHarness();
    h.secrets.values.set(providerSecretKey('google')!, 'g');
    h.memento.values.set(MODEL_SELECTION_KEY, { provider: 'google', model: 'gemini-2.5-flash' });
    const events: Array<ModelSelection | undefined> = [];
    h.router.onDidChangeSelection((s) => events.push(s));

    await h.router.init();

    assert.deepStrictEqual(h.router.getSelection(), { provider: 'google', model: 'gemini-2.5-flash' });
    assert.strictEqual(h.router.activeProvider(), 'google');
    assert.strictEqual(events.length, 0, 'init must not fire the change event');
    assert.strictEqual(h.memento.updates.length, 0, 'a valid restore is not rewritten');
    assert.strictEqual(h.router.modelFor('google'), 'gemini-2.5-flash');
  });

  it('falls back to the first enabled provider + first model and persists it', async () => {
    const h = makeHarness({ lm: fakeLm([{ id: 'fake-model', family: 'f' }]) });

    await h.router.init();

    assert.deepStrictEqual(h.router.getSelection(), { provider: 'copilot', model: 'fake-model' });
    assert.deepStrictEqual(h.memento.updates, [
      { key: MODEL_SELECTION_KEY, value: { provider: 'copilot', model: 'fake-model' } },
    ]);
  });

  it('falls back when the blob is absent, malformed, unknown, or its provider is disabled', async () => {
    const cases: unknown[] = [
      undefined,
      'garbage',
      42,
      null,
      { provider: 'nope', model: 'x' },
      { provider: 'google', model: '   ' },
      { model: 'x' },
    ];
    for (const garbage of cases) {
      const h = makeHarness({ lm: fakeLm([{ id: 'fake-model', family: 'f' }]) });
      h.memento.values.set(MODEL_SELECTION_KEY, garbage);

      await h.router.init();

      assert.deepStrictEqual(
        h.router.getSelection(),
        { provider: 'copilot', model: 'fake-model' },
        `fallback for ${JSON.stringify(garbage)}`,
      );
      assert.deepStrictEqual(h.memento.updates, [
        { key: MODEL_SELECTION_KEY, value: { provider: 'copilot', model: 'fake-model' } },
      ]);
    }
  });

  it('falls back past a now-disabled provider, persisting the first surviving entry', async () => {
    const h = makeHarness({ lm: fakeLm([]) }); // copilot unavailable
    h.secrets.values.set(providerSecretKey('openai')!, 'sk');
    h.settings.endpoint = 'https://api.example.com';
    h.settings.model = 'gpt-x';
    h.memento.values.set(MODEL_SELECTION_KEY, { provider: 'google', model: 'gemini-2.5-flash' });

    await h.router.init();

    assert.deepStrictEqual(h.router.getSelection(), { provider: 'openai', model: 'gpt-x' });
    assert.deepStrictEqual(h.memento.updates, [
      { key: MODEL_SELECTION_KEY, value: { provider: 'openai', model: 'gpt-x' } },
    ]);
  });

  it('never throws when workspaceState.get throws and leaves nothing selected', async () => {
    const h = makeHarness();
    h.memento.failGet = true;

    await h.router.init();

    assert.strictEqual(h.router.getSelection(), undefined);
    assert.strictEqual(h.router.activeProvider(), undefined);
  });

  it('leaves nothing selected when no provider is usable', async () => {
    const h = makeHarness({ lm: fakeLm([]) });

    await h.router.init();

    assert.strictEqual(h.router.getSelection(), undefined);
    assert.strictEqual(h.memento.updates.length, 0, 'nothing to persist');
  });
});

// --- select ------------------------------------------------------------------

describe('ProviderRouter.select', () => {
  it('rejects malformed input: false, no persist, no event', async () => {
    const h = makeHarness();
    const events: Array<ModelSelection | undefined> = [];
    h.router.onDidChangeSelection((s) => events.push(s));

    const bads: unknown[] = [
      'nope',
      undefined,
      null,
      7,
      {},
      { provider: 'nope', model: 'x' },
      { provider: 'google', model: '   ' },
    ];
    for (const bad of bads) {
      assert.strictEqual(await h.router.select(bad), false, JSON.stringify(bad));
    }

    assert.strictEqual(h.memento.updates.length, 0, 'nothing persisted');
    assert.deepStrictEqual(events, [], 'no event fired');
    assert.strictEqual(h.router.getSelection(), undefined);
  });

  it('persists a valid selection, normalising the model, and fires the event once', async () => {
    const h = makeHarness();
    h.secrets.values.set(providerSecretKey('google')!, 'g');
    const events: Array<ModelSelection | undefined> = [];
    h.router.onDidChangeSelection((s) => events.push(s));

    assert.strictEqual(await h.router.select({ provider: 'google', model: '  gemini-2.5-flash  ' }), true);

    assert.deepStrictEqual(h.router.getSelection(), { provider: 'google', model: 'gemini-2.5-flash' });
    assert.deepStrictEqual(h.memento.updates, [
      { key: MODEL_SELECTION_KEY, value: { provider: 'google', model: 'gemini-2.5-flash' } },
    ]);
    assert.deepStrictEqual(events, [{ provider: 'google', model: 'gemini-2.5-flash' }]);
  });

  it('a repeat of the identical selection returns true and fires nothing', async () => {
    const h = makeHarness();
    h.secrets.values.set(providerSecretKey('google')!, 'g');
    await h.router.select({ provider: 'google', model: 'gemini-2.5-flash' });
    const before = h.memento.updates.length;
    const events: Array<ModelSelection | undefined> = [];
    h.router.onDidChangeSelection((s) => events.push(s));

    assert.strictEqual(await h.router.select({ provider: 'google', model: ' gemini-2.5-flash ' }), true);

    assert.strictEqual(h.memento.updates.length, before, 'no new persist');
    assert.deepStrictEqual(events, [], 'no new event');
  });

  it('a disposed listener stops receiving', async () => {
    const h = makeHarness();
    h.secrets.values.set(providerSecretKey('google')!, 'g');
    h.secrets.values.set(providerSecretKey('mistral')!, 'm');
    const events: Array<ModelSelection | undefined> = [];
    const sub = h.router.onDidChangeSelection((s) => events.push(s));

    await h.router.select({ provider: 'google', model: 'm-google' });
    assert.strictEqual(events.length, 1);
    sub.dispose();
    await h.router.select({ provider: 'mistral', model: 'm-mistral' });

    assert.strictEqual(events.length, 1, 'the disposed listener saw nothing more');
    assert.deepStrictEqual(h.router.getSelection(), { provider: 'mistral', model: 'm-mistral' });
  });

  it('a throwing listener does not prevent the other listeners or the state change', async () => {
    const h = makeHarness();
    const events: Array<ModelSelection | undefined> = [];
    h.router.onDidChangeSelection(() => {
      throw new Error('listener boom');
    });
    h.router.onDidChangeSelection((s) => events.push(s));

    assert.strictEqual(await h.router.select({ provider: 'google', model: 'gemini-2.5-flash' }), true);

    assert.deepStrictEqual(h.router.getSelection(), { provider: 'google', model: 'gemini-2.5-flash' });
    assert.strictEqual(events.length, 1, 'the second listener still ran');
  });

  it('a rejected workspaceState.update still leaves the in-memory selection applied', async () => {
    const h = makeHarness();
    h.memento.failUpdate = true;
    const events: Array<ModelSelection | undefined> = [];
    h.router.onDidChangeSelection((s) => events.push(s));

    assert.strictEqual(await h.router.select({ provider: 'google', model: 'gemini-2.5-flash' }), true);

    assert.deepStrictEqual(h.router.getSelection(), { provider: 'google', model: 'gemini-2.5-flash' });
    assert.strictEqual(events.length, 1, 'the switch still surfaces to the UI');
  });
});

// --- refresh -----------------------------------------------------------------

describe('ProviderRouter.refresh', () => {
  it('with no selection and a key newly present, selects the provider and its first model, persists and fires', async () => {
    const h = makeHarness({ lm: fakeLm([]) }); // copilot unavailable
    h.secrets.values.set(providerSecretKey('google')!, 'g');
    const events: Array<ModelSelection | undefined> = [];
    h.router.onDidChangeSelection((s) => events.push(s));

    await h.router.refresh();

    assert.deepStrictEqual(h.router.getSelection(), {
      provider: 'google',
      model: 'gemini-2.5-pro',
    });
    assert.deepStrictEqual(h.memento.updates, [
      { key: MODEL_SELECTION_KEY, value: { provider: 'google', model: 'gemini-2.5-pro' } },
    ]);
    assert.deepStrictEqual(events, [{ provider: 'google', model: 'gemini-2.5-pro' }]);
    assert.strictEqual(h.router.modelFor('google'), 'gemini-2.5-pro');
  });

  it('with the active provider just cleared, re-resolves to the next enabled provider and fires once', async () => {
    const h = makeHarness({ lm: fakeLm([]) });
    h.secrets.values.set(providerSecretKey('google')!, 'g');
    h.secrets.values.set(providerSecretKey('mistral')!, 'm');
    await h.router.select({ provider: 'google', model: 'm-google' });
    // Out of band: the google key is cleared.
    h.secrets.values.delete(providerSecretKey('google')!);
    const events: Array<ModelSelection | undefined> = [];
    h.router.onDidChangeSelection((s) => events.push(s));

    await h.router.refresh();

    assert.deepStrictEqual(h.router.getSelection(), { provider: 'mistral', model: 'mistral-large-latest' });
    assert.strictEqual(events.length, 1);
  });

  it('with the active provider still enabled, leaves the selection untouched, persists nothing, and still fires once', async () => {
    const h = makeHarness({ lm: fakeLm([]) });
    h.secrets.values.set(providerSecretKey('google')!, 'g');
    await h.router.select({ provider: 'google', model: 'gemini-2.5-flash' });
    const before = h.memento.updates.length;
    const events: Array<ModelSelection | undefined> = [];
    h.router.onDidChangeSelection((s) => events.push(s));

    await h.router.refresh();

    assert.deepStrictEqual(h.router.getSelection(), { provider: 'google', model: 'gemini-2.5-flash' });
    assert.strictEqual(h.memento.updates.length, before, 'nothing was written to workspaceState');
    assert.strictEqual(events.length, 1, 'exactly one change event');
  });

  it('with no provider usable, re-resolves to undefined and still fires once', async () => {
    const h = makeHarness({ lm: fakeLm([]) });
    h.secrets.values.set(providerSecretKey('google')!, 'g');
    await h.router.select({ provider: 'google', model: 'gemini-2.5-flash' });
    h.secrets.values.delete(providerSecretKey('google')!);
    const events: Array<ModelSelection | undefined> = [];
    h.router.onDidChangeSelection((s) => events.push(s));

    await h.router.refresh();

    assert.strictEqual(h.router.getSelection(), undefined);
    assert.deepStrictEqual(events, [undefined]);
  });

  it('a throwing secrets fake resolves (never rejects), logs through config.log, and still fires', async () => {
    const secrets = new FakeSecrets();
    const memento = new FakeMemento();
    secrets.failGet = true;
    const logs: string[] = [];
    const router = new ProviderRouter({
      secrets,
      workspaceState: memento,
      settings: makeSettings(),
      lm: fakeLm([]),
      version: '1.2.3',
      log: (message) => logs.push(message),
    });
    const events: Array<ModelSelection | undefined> = [];
    router.onDidChangeSelection((s) => events.push(s));

    await router.refresh(); // must not throw

    // The throwing secret reads surface through the router's contained
    // per-provider catches, all of which log through config.log.
    assert.ok(logs.length > 0, 'the failure was logged through config.log');
    assert.strictEqual(events.length, 1, 'the event still fired');
    assert.strictEqual(router.getSelection(), undefined);
  });

  it('a rejected workspaceState.update during refresh resolves, logs through config.log, and still fires', async () => {
    const secrets = new FakeSecrets();
    const memento = new FakeMemento();
    memento.failUpdate = true;
    secrets.values.set(providerSecretKey('google')!, 'g');
    const logs: string[] = [];
    const router = new ProviderRouter({
      secrets,
      workspaceState: memento,
      settings: makeSettings(),
      lm: fakeLm([]),
      version: '1.2.3',
      log: (message) => logs.push(message),
    });
    const events: Array<ModelSelection | undefined> = [];
    router.onDidChangeSelection((s) => events.push(s));

    await router.refresh();

    assert.ok(
      logs.some((line) => line.includes('refreshing provider availability failed')),
      'the failure was logged',
    );
    assert.deepStrictEqual(
      router.getSelection(),
      { provider: 'google', model: 'gemini-2.5-pro' },
      'the in-memory selection is applied even though the persist rejected',
    );
    assert.strictEqual(events.length, 1);
  });

  it('select() and init() behaviour is unchanged by the refactor', async () => {
    const h = makeHarness({ lm: fakeLm([{ id: 'fake-model', family: 'f' }]) });
    const events: Array<ModelSelection | undefined> = [];
    h.router.onDidChangeSelection((s) => events.push(s));

    await h.router.init();

    assert.strictEqual(events.length, 0, 'init still does not fire');
    // select() unchanged: the basic switch behaviour is asserted elsewhere and
    // stays green (see the ProviderRouter.select suite).
  });
});

// --- routing -----------------------------------------------------------------

describe('ProviderRouter.complete routing', () => {
  it('with no selection it rejects with MissingConfigError(missing === "model")', async () => {
    const h = makeHarness();
    await assert.rejects(
      () => h.router.complete(makeReq()),
      (err: unknown) => err instanceof MissingConfigError && err.missing === 'model',
    );
  });

  it('reaches exactly the selected provider, forwarding the request object unchanged', async () => {
    const h = makeHarness();
    h.secrets.values.set(providerSecretKey('google')!, 'g');
    await h.router.select({ provider: 'google', model: 'gemini-2.5-flash' });

    const req = makeReq('session-1', () => undefined);
    const result = await h.router.complete(req);

    assert.deepStrictEqual(result, CANNED);
    assert.deepStrictEqual(h.constructions, ['google'], 'exactly one client was built');
    const google = h.clients.get('google')!;
    assert.strictEqual(google.requests.length, 1);
    assert.strictEqual(google.requests[0], req, 'the request object is forwarded BY REFERENCE');
    assert.strictEqual(google.requests[0].messages, req.messages);
    assert.strictEqual(google.requests[0].signal, req.signal);
    assert.strictEqual(google.requests[0].sessionId, 'session-1');
    assert.ok(google.requests[0].onDelta !== undefined, 'onDelta survives forwarding');
    for (const id of ['copilot', 'opencode', 'mistral', 'openai'] as ProviderId[]) {
      assert.strictEqual(h.clients.has(id), false, `${id} was never constructed`);
    }
  });

  it("the delegate's error propagates unwrapped", async () => {
    const boom = new UnreachableEndpointError('delegate boom');
    const config: ProviderRouterConfig = {
      secrets: new FakeSecrets(),
      workspaceState: new FakeMemento(),
      settings: makeSettings(),
      lm: fakeLm([]),
      version: '1.2.3',
      createClient: () =>
        new (class implements ModelClient {
          public async complete(): Promise<CompletionResult> {
            throw boom;
          }
        })(),
    };
    const router = new ProviderRouter(config);
    await router.select({ provider: 'opencode', model: 'grok-code' });

    await assert.rejects(
      () => router.complete(makeReq()),
      (err: unknown) => err === boom,
      'the exact error instance the delegate threw',
    );
  });

  it('after select() to another provider the NEXT complete() hits the new one', async () => {
    const h = makeHarness();
    h.secrets.values.set(providerSecretKey('google')!, 'g');
    h.secrets.values.set(providerSecretKey('mistral')!, 'm');

    await h.router.select({ provider: 'google', model: 'm-google' });
    await h.router.complete(makeReq());
    await h.router.select({ provider: 'mistral', model: 'm-mistral' });
    await h.router.complete(makeReq());

    assert.strictEqual(h.clients.get('google')!.requests.length, 1, 'the first client is not called again');
    assert.strictEqual(h.clients.get('mistral')!.requests.length, 1, 'the new client got the next call');
  });

  it('clients are memoised: two completions on one provider construct one client', async () => {
    const h = makeHarness();
    h.secrets.values.set(providerSecretKey('opencode')!, 'k');

    await h.router.select({ provider: 'opencode', model: 'grok-code' });
    await h.router.complete(makeReq());
    await h.router.complete(makeReq());

    assert.strictEqual(h.constructions.filter((id) => id === 'opencode').length, 1, 'one construction');
    assert.strictEqual(h.clients.get('opencode')!.requests.length, 2, 'both completions routed');
  });
});

// --- model resolution ----------------------------------------------------------

describe('model resolution', () => {
  it('switching provider and back restores the previously chosen model', async () => {
    const h = makeHarness();
    h.secrets.values.set(providerSecretKey('google')!, 'g');
    h.secrets.values.set(providerSecretKey('mistral')!, 'm');

    await h.router.select({ provider: 'google', model: 'm-google' });
    await h.router.select({ provider: 'mistral', model: 'm-mistral' });

    assert.strictEqual(h.router.modelFor('mistral'), 'm-mistral', 'the active provider still resolves live');
    assert.strictEqual(h.router.modelFor('google'), 'm-google', 'restored from the per-provider memory');
    assert.notStrictEqual(h.router.getSelection()?.provider, 'google');

    await h.router.select({ provider: 'google', model: 'm-google' });
    assert.strictEqual(h.router.modelFor('mistral'), 'm-mistral', 'and back the other way');
  });

  it('falls back to the catalog default, and to the openai setting when unset', async () => {
    const h = makeHarness();
    assert.strictEqual(h.router.modelFor('google'), defaultModelFor('google'));
    assert.strictEqual(h.router.modelFor('openai'), undefined);
    h.settings.model = 'gpt-x';
    assert.strictEqual(h.router.modelFor('openai'), 'gpt-x', 'openai falls through to the setting');
  });

  it('an explicit openai choice wins over the setting', async () => {
    const settings = makeSettings();
    settings.model = 'gpt-x';
    const router = new ProviderRouter({
      secrets: new FakeSecrets(),
      workspaceState: new FakeMemento(),
      settings,
      lm: fakeLm([]),
      version: '1.2.3',
    });
    await router.select({ provider: 'openai', model: 'custom-1' });
    assert.strictEqual(router.modelFor('openai'), 'custom-1');
  });

  it('modelFor("copilot") is what the default Copilot client reads', async () => {
    // Default clients (no createClient): the CopilotModelClient receives
    // getModel: () => router.modelFor('copilot'). A selection matching the
    // enumerated fake chat's id proves the value was forwarded as-is — a
    // mismatch would surface as MissingConfigError('model') from
    // selectCopilotModel instead of the sendRequest failure below.
    const h = makeHarness({ defaultClients: true }); // lm enumerates id 'fake-model'
    await h.router.select({ provider: 'copilot', model: 'fake-model' });
    assert.strictEqual(h.router.modelFor('copilot'), 'fake-model');

    await assert.rejects(
      () => h.router.complete(makeReq('sid')),
      (err: unknown) => err instanceof UnreachableEndpointError,
      'selection matched the enumerated id, so resolution succeeded before sendRequest failed',
    );

    // A selection the enumeration does not know yields MissingConfigError.
    const other = makeHarness({ defaultClients: true });
    await other.router.select({ provider: 'copilot', model: 'vanished-model' });
    assert.strictEqual(other.router.modelFor('copilot'), 'vanished-model');
    await assert.rejects(
      () => other.router.complete(makeReq()),
      (err: unknown) => err instanceof MissingConfigError && err.missing === 'model',
    );
  });
});
