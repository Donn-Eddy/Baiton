/**
 * The end-to-end suite for model-selector-refresh (T15).
 *
 * Every other suite in this area pins one unit. This one wires the REAL
 * modules the way the host wires them and asserts the whole chain:
 *
 *   fake feed / CLI transports
 *     -> ModelDiscoveryService -> CatalogStore
 *        -> agentCapabilities(table) -> ConfigPanelController
 *        -> ProviderRouter -> ChatController -> media/chat.js
 *
 * The six legs below each cover one guarantee end to end:
 *
 * 1. reload refresh      — a window reload refreshes every source, the config
 *                          panel picks it up with no second `loaded`, and the
 *                          persisted snapshots come back as `cached` before any
 *                          fetch in the next window — the panel's first
 *                          `loaded` already shows that rehydrated list, because
 *                          the host builds the store before registering the
 *                          panel.
 * 2. discovery fallback  — every source failing keeps the curated builtin lists
 *                          and marks them stale; a failure after a success keeps
 *                          the last good list byte for byte; a later success
 *                          clears the mark (stale-list handling).
 * 3. provider filtering  — `availability()` lists only configured providers,
 *                          the rest are hidden with the exact catalog reasons,
 *                          and storing a key reveals a hidden feed provider.
 * 4. provider-first      — a real `ChatController`-posted `setProviders` drives
 *    selection             `media/chat.js`'s provider select + model select.
 * 5. round-trip          — a configured model/effort/agent a refresh does not
 *                          list stays listed and saveable, and a persisted
 *                          `ModelSelection` survives a refresh; a configured
 *                          value the refreshed lists lack rides along as a
 *                          `custom: true` "Other…" entry and still saves.
 * 6. corrected sources    — every corrected source, driven from checked-in
 *    -> open panel         fixtures, reaches an OPEN config panel and then
 *                          `media/config.js`:
 *                          - codex: a `result.data` reply whose ids come from
 *                            `model`, whose `{ reasoningEffort }` objects become
 *                            per-model levels and whose `nextCursor` page is
 *                            followed;
 *                          - claude: the CLI's own local model catalog drives
 *                            the panel with NO network at all;
 *                          - opencode: `opencode models --verbose` is the
 *                            primary source, so no server is started and
 *                            `/api/model` is never requested;
 *                          - antigravity: `agy models` becomes families with
 *                            their levels beside fixed ids;
 *                          - a failed, timed-out or malformed refresh keeps the
 *                            last known-good lists marked stale, never blanking
 *                            a selector;
 *                          - a configured-but-unlisted value round-trips through
 *                            the view as an editable `Other…` entry.
 *
 * NO `vscode` loader hook. Every module this file touches is host-free, so it
 * imports statically and never registers `test/fixtures/vscodeLoader.mjs` —
 * suite ordering can therefore never matter, the same rule
 * test/modelDiscovery.test.ts and test/providerRouter.test.ts state in their
 * own headers. The Set-API-key quick pick itself stays covered by
 * test/setApiKey.test.ts, which DOES need that loader; leg 3 asserts the quick
 * pick's input (catalog membership) and its effect (key stored -> provider
 * becomes available) instead of importing `setApiKey.ts`.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vm from 'vm';

import {
  CatalogStore,
  MODEL_CATALOG_MEMENTO_KEY,
  MODEL_CATALOG_PERSIST_VERSION,
} from '../src/orchestrator/modelCatalog';
import {
  ModelDiscoveryService,
  builtinCatalogFetches,
  type DiscoveryRegistry,
  type FeedFetcher,
} from '../src/activation/modelDiscovery';
import { parseModelsDevFeed, type ModelsDevFeed } from '../src/orchestrator/modelsDev';
import { agentCapabilities, builtinAgentCapabilities } from '../src/adapter';
import type { Adapter, AgentCapabilities, AgentId } from '../src/adapter/adapter';
import { CLAUDE_EFFORTS, ClaudeAdapter } from '../src/adapter/claude';
import {
  CodexAdapter,
  codexModelListParams,
  type CodexAppServerProcess,
  type CodexAppServerSpawner,
} from '../src/adapter/codex';
import { OpencodeAdapter } from '../src/adapter/opencode';
import { AntigravityAdapter } from '../src/adapter/antigravity';
import {
  ProviderRouter,
  type MementoLike,
  type ProviderSettings,
  type SecretsLike,
} from '../src/activation/providerRouter';
import {
  COPILOT_UNAVAILABLE_REASON,
  MODEL_SELECTION_KEY,
  PROVIDER_NEEDS_ENDPOINT_REASON,
  providerCatalog,
  providerNeedsKeyReason,
  providerSecretKey,
  type ModelSelection,
} from '../src/orchestrator/providers';
import {
  ConfigPanelController,
  type ConfigPanelWebview,
} from '../src/activation/configPanelController';
import type {
  ConfigPanelHostToWebview,
  ConfigPanelWebviewToHost,
} from '../src/config/configPanel';
import { configFilePath, loadConfig } from '../src/config/loadConfig';
import { defaultConfig, defaultConfigJson } from '../src/config/defaultConfig';
import { ChatController, type ChatWebview } from '../src/activation/chatController';
import type {
  GuardContext,
  HostToWebview,
  ModelClient,
  ToolRegistry,
  WebviewToHost,
} from '../src/orchestrator';
import type { ProviderGroup } from '../src/orchestrator/webviewProtocol';
import { ok, err, isOk, type Result } from '../src/model/result';
import type { CopilotVscodeApi } from '../src/orchestrator/copilotClient';

describe('model selector refresh (T15 end to end)', () => {
  // --- shared harness --------------------------------------------------------

  /** The parsed models.dev fixture the whole suite drives the feed from. */
  function fixtureFeed(): ModelsDevFeed {
    const text = fs.readFileSync(
      path.join(__dirname, 'fixtures', 'modelsDev.sample.json'),
      'utf8',
    );
    const parsed = parseModelsDevFeed(JSON.parse(text) as unknown);
    assert.ok(parsed.ok, 'the models.dev fixture must parse');
    return parsed.value;
  }

  /**
   * The Claude CLI local model catalog fixture, re-read and re-parsed per call
   * so no test can mutate another test's data.
   */
  function claudeCatalogFixture(): unknown {
    return JSON.parse(
      fs.readFileSync(path.join(__dirname, 'fixtures', 'claudeModelCatalog.sample.json'), 'utf8'),
    ) as unknown;
  }

  /** The `opencode models --verbose` fixture listing, re-read per call. */
  function opencodeVerboseFixture(): string {
    return fs.readFileSync(
      path.join(__dirname, 'fixtures', 'opencodeModelsVerbose.sample.txt'),
      'utf8',
    );
  }

  /** The `agy models` fixture listing, re-read per call. */
  function agyModelsFixture(): string {
    return fs.readFileSync(path.join(__dirname, 'fixtures', 'agyModels.sample.txt'), 'utf8');
  }

  /**
   * A local catalog `claudeModelsFromCatalog` rejects to `[]`: the surface is
   * `zed`, not `cc`. The claude leg then falls THROUGH to the models.dev feed.
   */
  const MALFORMED_CLAUDE_CATALOG = {
    version: 2,
    catalog: { surface: 'zed', config: { models: [{ id: 'claude-x' }] } },
  };

  /** A Map-backed `vscode.Memento` subset, as test/modelDiscovery.test.ts builds it. */
  interface FakeMemento {
    store: Map<string, unknown>;
    updates: { key: string; value: unknown }[];
    get<T>(key: string): T | undefined;
    update(key: string, value: unknown): void;
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

  /** A monotonically advancing `now`, so a later success visibly advances `fetchedAt`. */
  function tickingClock(): () => string {
    let ms = Date.parse('2026-09-26T00:00:00.000Z');
    return () => {
      const value = new Date(ms).toISOString();
      ms += 1_000;
      return value;
    };
  }

  /** How each injected transport behaves during the next refresh. */
  interface HarnessMode {
    /** The models.dev feed the service fetches once per refresh. */
    feed: 'ok' | 'fail' | 'hang';
    /** The claude adapter's OWN fetcher, used only when `ctx.feed` is absent. */
    claudeFeed: 'ok' | 'fail' | 'hang';
    /**
     * The `codex app-server` child: the curated `models`-shaped reply (`ok`,
     * the default every pre-existing case asserts), the corrected `data`-shaped
     * one, a two-page `data` reply, a payload that parses to no models at all,
     * or a dead/hung child.
     */
    codex: 'ok' | 'fail' | 'hang' | 'data' | 'paged' | 'malformed';
    /**
     * The Claude CLI's own local model catalog reader. `missing` (the default)
     * reproduces the injected `async () => undefined` every pre-existing case
     * was written against.
     */
    claudeCatalog: 'missing' | 'ok' | 'malformed' | 'hang';
    /**
     * `opencode models --verbose`. `empty` (the default) reproduces the injected
     * `async () => undefined`, which makes `/api/model` the source.
     */
    opencodeCli: 'empty' | 'ok' | 'fail';
    /** The opencode `/api/model` transport. */
    opencode: 'ok' | 'fail';
    /**
     * `agy models`. `fail` (the default) reproduces the injected
     * `async () => undefined`, which keeps the curated antigravity table.
     */
    agy: 'fail' | 'ok';
  }

  /** A promise that never settles; the way a hung transport is modelled. */
  function never<T>(): Promise<T> {
    return new Promise<T>(() => undefined);
  }

  /** The `codex app-server` payload the happy spawner answers `model/list` with. */
  const CODEX_PAYLOAD = {
    models: [
      {
        id: 'gpt-6-astra',
        displayName: 'GPT-6 Astra',
        supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
        defaultReasoningEffort: 'medium',
      },
      {
        id: 'gpt-5-codex',
        supportedReasoningEfforts: ['minimal', 'low', 'medium', 'high'],
        defaultReasoningEffort: 'low',
      },
    ],
  };

  /**
   * The CORRECTED app-server reply: `result.data` rather than `result.models`,
   * ids from `model` (the `id` field is the internal one and must lose),
   * `{ reasoningEffort, description }` effort objects, and a `hidden: true`
   * model that is still kept (`includeHidden: true` asked for it).
   */
  const CODEX_DATA_PAYLOAD = {
    data: [
      {
        model: 'gpt-6-astra',
        id: 'ignored-astra-id',
        displayName: 'GPT-6 Astra',
        hidden: false,
        supportedReasoningEfforts: [
          { reasoningEffort: 'low', description: 'l' },
          { reasoningEffort: 'medium', description: 'm' },
          { reasoningEffort: 'high', description: 'h' },
          { reasoningEffort: 'xhigh', description: 'x' },
        ],
        defaultReasoningEffort: 'medium',
      },
      {
        model: 'gpt-6-sol',
        id: 'ignored-sol-id',
        displayName: 'GPT-6 Sol',
        hidden: true,
        supportedReasoningEfforts: [{ reasoningEffort: 'medium' }, { reasoningEffort: 'max' }],
      },
    ],
  };

  /** Page one of a paged `model/list` reply; its `nextCursor` must be followed. */
  const CODEX_PAGE_1 = {
    data: [{ model: 'gpt-6-astra', supportedReasoningEfforts: ['low', 'high'] }],
    nextCursor: 'cursor-2',
  };

  /** Page two; no cursor, so pagination ends here. */
  const CODEX_PAGE_2 = {
    data: [{ model: 'gpt-6-sol', supportedReasoningEfforts: ['high'] }],
  };

  /** A reply that parses to `[]`, so `discoverModels` resolves `undefined`. */
  const CODEX_MALFORMED_PAYLOAD = { data: 'not-an-array' };

  /** The opencode `/api/model` payload; ids come out as `provider/model`. */
  const OPENCODE_PAYLOAD = {
    providers: {
      anthropic: { models: { 'claude-sonnet-5': {} } },
      'github-copilot': { models: { 'gpt-5': {} } },
    },
  };

  /**
   * The fake `CodexAppServerSpawner`, a compact copy of `fakeAppServer` in
   * test/adapter.codex.test.ts: listener arrays over stdout/stderr/error/exit/
   * close, `stdin.write` parsing each JSONL line and replying to `initialize`
   * (id 1) and `model/list` (id 2) through `setImmediate`. `mode()` is read per
   * spawn so one registry can serve a whole test's sequence of refreshes.
   *
   * Every message written to stdin is recorded, so a test can assert the
   * `model/list` request shape (`includeHidden`/`limit`) and the cursor of a
   * follow-up page.
   */
  function codexAppServer(mode: () => HarnessMode['codex']): {
    spawner: CodexAppServerSpawner;
    kills: () => number;
    writes: () => unknown[];
    modelListRequests: () => Array<{ id?: unknown; method?: string; params?: Record<string, unknown> }>;
  } {
    let killCount = 0;
    const writes: unknown[] = [];
    const spawner: CodexAppServerSpawner = () => {
      const stdoutListeners: Array<(chunk: Buffer | string) => void> = [];
      const errorListeners: Array<(...args: unknown[]) => void> = [];
      const behaviour = mode();

      const emit = (message: unknown): void => {
        setImmediate(() => {
          for (const listener of stdoutListeners) {
            listener(`${JSON.stringify(message)}\n`);
          }
        });
      };

      const child: CodexAppServerProcess = {
        stdin: {
          write(chunk: string): unknown {
            if (behaviour === 'fail' || behaviour === 'hang') {
              return true;
            }
            for (const line of chunk.split('\n')) {
              const trimmed = line.trim();
              if (trimmed.length === 0) {
                continue;
              }
              let parsed: { id?: unknown };
              try {
                parsed = JSON.parse(trimmed) as { id?: unknown };
              } catch {
                continue;
              }
              writes.push(parsed);
              if (parsed.id === 1) {
                emit({ jsonrpc: '2.0', id: 1, result: {} });
              } else if (parsed.id === 2) {
                emit({
                  jsonrpc: '2.0',
                  id: 2,
                  result:
                    behaviour === 'data'
                      ? CODEX_DATA_PAYLOAD
                      : behaviour === 'malformed'
                        ? CODEX_MALFORMED_PAYLOAD
                        : behaviour === 'paged'
                          ? CODEX_PAGE_1
                          : CODEX_PAYLOAD,
                });
              } else if (typeof parsed.id === 'number' && parsed.id >= 3) {
                if (behaviour === 'paged') {
                  emit({ jsonrpc: '2.0', id: parsed.id, result: CODEX_PAGE_2 });
                }
              }
            }
            return true;
          },
          end(): unknown {
            return undefined;
          },
        },
        stdout: {
          on(event: 'data', listener: (chunk: Buffer | string) => void): unknown {
            if (event === 'data') {
              stdoutListeners.push(listener);
            }
            return child;
          },
        },
        stderr: {
          on(): unknown {
            return child;
          },
        },
        on(event: 'error' | 'exit' | 'close', listener: (...args: unknown[]) => void): unknown {
          if (event === 'error') {
            errorListeners.push(listener);
          }
          return child;
        },
        kill(): unknown {
          killCount += 1;
          return true;
        },
      };

      if (behaviour === 'fail') {
        setImmediate(() => {
          for (const listener of errorListeners) {
            listener(new Error('spawn codex ENOENT'));
          }
        });
      }
      return child;
    };
    return {
      spawner,
      kills: () => killCount,
      writes: () => [...writes],
      modelListRequests: () =>
        writes.filter(
          (m): m is { id?: unknown; method?: string; params?: Record<string, unknown> } =>
            (m as { method?: string }).method === 'model/list',
        ),
    };
  }

  /** The recording codex fake plus the per-source call counters of one registry. */
  interface RegistryProbes {
    codexServer: ReturnType<typeof codexAppServer>;
    claudeFeedCalls: () => number;
    opencodeApiCalls: () => number;
  }

  /**
   * The adapter registry over the REAL adapters, with every transport injected.
   *
   * EVERY live leg is driven from a checked-in fixture, never from the
   * developer's machine: no real `codex app-server` is spawned (an injected
   * `spawnAppServer`), no real `~/.claude/cache/model-catalog` is read (an
   * injected `readLocalCatalog`), no real `opencode`/`agy` binary is executed
   * (injected `runModelsCli` seams) and no loopback request is ever made (an
   * injected `fetchModels` over a deliberately closed port). Each seam is
   * driven off `mode()`, read per call, so ONE registry serves a whole test's
   * sequence of refreshes.
   */
  function buildRegistry(mode: () => HarnessMode): {
    registry: DiscoveryRegistry;
    probes: RegistryProbes;
  } {
    const codex = codexAppServer(() => mode().codex);
    let claudeFeedCalls = 0;
    let opencodeApiCalls = 0;
    const map: Partial<Record<AgentId, Adapter>> = {
      claude: new ClaudeAdapter(undefined, {
        fetchFeed: async () => {
          claudeFeedCalls += 1;
          const behaviour = mode().claudeFeed;
          if (behaviour === 'hang') {
            return never<Result<ModelsDevFeed, string>>();
          }
          return behaviour === 'ok'
            ? ok<ModelsDevFeed, string>(fixtureFeed())
            : err<string, ModelsDevFeed>('models.dev request failed: ETIMEDOUT');
        },
        // T02: the default reader would read the developer's real
        // ~/.claude/cache/model-catalog and make these claude expectations
        // machine-dependent, so the catalog is served from
        // test/fixtures/claudeModelCatalog.sample.json instead.
        readLocalCatalog: async () => {
          const behaviour = mode().claudeCatalog;
          if (behaviour === 'hang') {
            return never<unknown>();
          }
          if (behaviour === 'ok') {
            return claudeCatalogFixture();
          }
          if (behaviour === 'malformed') {
            return MALFORMED_CLAUDE_CATALOG;
          }
          return undefined;
        },
      }),
      codex: new CodexAdapter({ spawnAppServer: codex.spawner }),
      // A `serverBaseUrl` means nothing is spawned and nothing is killed; the
      // port is closed on purpose so a leaked real request could not succeed.
      opencode: new OpencodeAdapter(undefined, {
        serverBaseUrl: 'http://127.0.0.1:65535',
        fetchModels: async () => {
          opencodeApiCalls += 1;
          if (mode().opencode === 'fail') {
            throw new Error('connect ECONNREFUSED 127.0.0.1:65535');
          }
          return {
            ok: true,
            status: 200,
            text: async () => JSON.stringify(OPENCODE_PAYLOAD),
          };
        },
        // `opencode models --verbose` is served from
        // test/fixtures/opencodeModelsVerbose.sample.txt: the real binary would
        // make these expectations machine-dependent.
        runModelsCli: async () => {
          const behaviour = mode().opencodeCli;
          if (behaviour === 'ok') {
            return opencodeVerboseFixture();
          }
          if (behaviour === 'fail') {
            throw new Error('spawn opencode ENOENT');
          }
          return undefined;
        },
      }),
      // Same for `agy models`, served from test/fixtures/agyModels.sample.txt.
      antigravity: new AntigravityAdapter({
        runModelsCli: async () => (mode().agy === 'ok' ? agyModelsFixture() : undefined),
      }),
    };
    return {
      registry: {
        get: (agent: string): Adapter | undefined => map[agent as AgentId],
        ids: Object.keys(map) as AgentId[],
      },
      probes: {
        codexServer: codex,
        claudeFeedCalls: () => claudeFeedCalls,
        opencodeApiCalls: () => opencodeApiCalls,
      },
    };
  }

  /** Every discovery service built in a test, disposed by the shared `afterEach`. */
  const services: ModelDiscoveryService[] = [];

  /** One wired store + discovery service over the real adapters. */
  interface Harness {
    store: CatalogStore;
    discovery: ModelDiscoveryService;
    memento: FakeMemento;
    mode: HarnessMode;
    logs: string[];
    /** The recording `codex app-server` fake, for asserting the `model/list` requests. */
    codexServer: ReturnType<typeof codexAppServer>;
    /** How many times the claude adapter's OWN feed fetcher was called. */
    claudeFeedCalls: () => number;
    /** How many times the opencode `/api/model` transport was called. */
    opencodeApiCalls: () => number;
  }

  function buildDiscovery(
    options: {
      memento?: FakeMemento;
      mode?: Partial<HarnessMode>;
      now?: () => string;
      cwd?: string;
      timeoutMs?: number;
    } = {},
  ): Harness {
    const memento = options.memento ?? fakeMemento();
    const mode: HarnessMode = {
      feed: 'ok',
      claudeFeed: 'ok',
      codex: 'ok',
      // The three defaults below reproduce the fixed stubs this suite was
      // written against exactly; changing one silently rewrites leg 1-3/5.
      claudeCatalog: 'missing',
      opencodeCli: 'empty',
      opencode: 'ok',
      agy: 'fail',
      ...options.mode,
    };
    const logs: string[] = [];
    const store = new CatalogStore({
      memento,
      builtins: builtinCatalogFetches(),
      now: options.now ?? tickingClock(),
    });
    const { registry, probes } = buildRegistry(() => mode);
    const discovery = new ModelDiscoveryService({
      store,
      registry,
      fetchFeed: (async () => {
        if (mode.feed === 'hang') {
          return never();
        }
        return mode.feed === 'ok'
          ? ok<ModelsDevFeed, string>(fixtureFeed())
          : err<string, ModelsDevFeed>('models.dev request failed: ETIMEDOUT');
      }) as FeedFetcher,
      cwd: () => options.cwd,
      timeoutMs: options.timeoutMs ?? 200,
      log: (m) => logs.push(m),
    });
    services.push(discovery);
    return {
      store,
      discovery,
      memento,
      mode,
      logs,
      codexServer: probes.codexServer,
      claudeFeedCalls: probes.claudeFeedCalls,
      opencodeApiCalls: probes.opencodeApiCalls,
    };
  }

  /** Temp directories created by {@link newDir}, removed by the shared `afterEach`. */
  const dirs: string[] = [];

  function newDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-model-selector-'));
    dirs.push(dir);
    return dir;
  }

  function writeConfigFile(dir: string, text: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configFilePath(dir), text, 'utf8');
  }

  /** A `.baiton/config.json` built from the defaults with some roles overridden. */
  function writeRoles(
    dir: string,
    overrides: Record<string, { agent: string; model: string; effort: string }>,
  ): void {
    const base = defaultConfig();
    const doc = {
      ...base,
      roles: { ...base.roles, ...overrides },
    };
    writeConfigFile(dir, `${JSON.stringify(doc, null, 2)}\n`);
  }

  /** Chat controllers built in a test, disposed by the shared `afterEach`. */
  const controllers: ChatController[] = [];

  afterEach(() => {
    while (services.length > 0) {
      services.pop()!.dispose();
    }
    while (controllers.length > 0) {
      controllers.pop()!.dispose();
    }
    while (dirs.length > 0) {
      fs.rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  /** The config panel's recording webview, as test/configPanel.controller.test.ts builds it. */
  class RecordingConfigWebview implements ConfigPanelWebview {
    public messages: ConfigPanelHostToWebview[] = [];
    private handler?: (msg: ConfigPanelWebviewToHost) => void | Promise<void>;

    public post(msg: ConfigPanelHostToWebview): void {
      this.messages.push(msg);
    }

    public onMessage(handler: (msg: ConfigPanelWebviewToHost) => void | Promise<void>): void {
      this.handler = handler;
    }

    public async send(msg: ConfigPanelWebviewToHost): Promise<void> {
      if (!this.handler) {
        throw new Error('RecordingConfigWebview: no handler registered.');
      }
      await this.handler(msg);
    }

    public loaded(): Array<Extract<ConfigPanelHostToWebview, { type: 'loaded' }>> {
      return this.messages.filter(
        (m): m is Extract<ConfigPanelHostToWebview, { type: 'loaded' }> => m.type === 'loaded',
      );
    }

    public optionsChanged(): Array<Extract<ConfigPanelHostToWebview, { type: 'optionsChanged' }>> {
      return this.messages.filter(
        (m): m is Extract<ConfigPanelHostToWebview, { type: 'optionsChanged' }> =>
          m.type === 'optionsChanged',
      );
    }
  }

  /**
   * Wire a config panel over a harness, mirroring the real wiring in
   * `src/extension.ts`: `registerConfigPanel({ getCapabilities: () =>
   * agentCapabilities(catalogStore.table()), onDidChangeCapabilities: (l) =>
   * discovery.onDidChange(() => l()) })`.
   */
  function buildPanel(
    harness: Harness,
    dir: string,
  ): { webview: RecordingConfigWebview; controller: ConfigPanelController } {
    const webview = new RecordingConfigWebview();
    const controller = new ConfigPanelController({
      webview,
      baitonDir: dir,
      agentIds: ['claude', 'opencode', 'antigravity', 'codex'],
      getCapabilities: () => agentCapabilities(harness.store.table()),
      onDidChangeCapabilities: (listener) => harness.discovery.onDidChange(listener),
      confirmReset: async () => false,
      log: () => undefined,
    });
    controller.start();
    return { webview, controller };
  }

  /** A `SecretsLike` whose values a test can add to mid-run. */
  interface FakeSecrets extends SecretsLike {
    set(key: string, value: string): void;
  }

  function fakeSecrets(initial: Record<string, string> = {}): FakeSecrets {
    const values = new Map<string, string>(Object.entries(initial));
    return {
      get: async (key: string) => values.get(key),
      set: (key: string, value: string) => {
        values.set(key, value);
      },
    };
  }

  /** A `MementoLike` (`workspaceState`) recording every update. */
  interface FakeWorkspaceState extends MementoLike {
    updates: Array<{ key: string; value: unknown }>;
  }

  function fakeWorkspaceState(initial: Record<string, unknown> = {}): FakeWorkspaceState {
    const values = new Map<string, unknown>(Object.entries(initial));
    const updates: Array<{ key: string; value: unknown }> = [];
    return {
      updates,
      get<T>(key: string): T | undefined {
        return values.get(key) as T | undefined;
      },
      async update(key: string, value: unknown): Promise<void> {
        updates.push({ key, value });
        values.set(key, value);
      },
    };
  }

  /** The `baiton.orchestrator.*` settings the router reads. */
  function fakeSettings(overrides: Partial<ProviderSettings> = {}): ProviderSettings {
    return {
      getEndpoint: () => undefined,
      getProviderEndpoint: () => undefined,
      getModel: () => undefined,
      isStreaming: () => false,
      getMaxTokens: () => undefined,
      ...overrides,
    };
  }

  /** The `{ lm: { selectChatModels } }` shape the Copilot path needs; `[]` means unavailable. */
  function fakeLm(modelIds: readonly string[] = []): CopilotVscodeApi {
    return {
      lm: {
        selectChatModels: async () => modelIds.map((id) => ({ id, family: id })),
      },
    } as unknown as CopilotVscodeApi;
  }

  /** A router wired the way src/activation/commands.ts wires it. */
  function buildRouter(parts: {
    harness?: Harness;
    secrets: SecretsLike;
    workspaceState: MementoLike;
    settings?: ProviderSettings;
    lm?: CopilotVscodeApi;
  }): ProviderRouter {
    return new ProviderRouter({
      secrets: parts.secrets,
      workspaceState: parts.workspaceState,
      settings: parts.settings ?? fakeSettings(),
      lm: parts.lm ?? fakeLm([]),
      version: '1.2.3',
      catalog: {
        snapshot: () => parts.harness?.store.get('models.dev'),
        feed: () => parts.harness?.discovery.feed(),
      },
      log: () => undefined,
    });
  }

  /** Poll until `condition` holds — `ChatController.start()` posts fire-and-forget. */
  async function waitFor(condition: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
      if (Date.now() > deadline) {
        assert.fail(`timed out waiting for: ${what}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /** Set equality over two id lists, so union ORDER stays the implementation's business. */
  function assertSameSet(actual: readonly string[], expected: readonly string[], what: string): void {
    assert.deepStrictEqual([...actual].sort(), [...expected].sort(), what);
  }

  /** True when `value` carries `key` as its own (not inherited) property. */
  function hasOwnKey(value: object, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

  /** Class list over a Set, with the members chat.js exercises. */
  class FakeClassList {
    constructor(private readonly set: Set<string>) {}
    public add(c: string): void {
      this.set.add(c);
    }
    public remove(c: string): void {
      this.set.delete(c);
    }
    public contains(c: string): boolean {
      return this.set.has(c);
    }
    public toggle(c: string, force?: boolean): boolean {
      const on = force === undefined ? !this.set.has(c) : force;
      if (on) {
        this.set.add(c);
      } else {
        this.set.delete(c);
      }
      return this.set.has(c);
    }
  }

  /**
   * A minimal DOM element covering exactly what media/chat.js (leg 4) and
   * media/config.js (leg 6) touch. Every behaviour leg 4 relies on — `options`,
   * `selectedIndex`, `value`, `insertBefore`, `dataset`, `style`, `focus` — is
   * untouched by the config.js additions (`remove`/`removeChild`, the reflected
   * `href`, and the richer `matches`).
   */
  class FakeEl {
    public readonly tagName: string;
    public readonly children: FakeEl[] = [];
    public readonly style: Record<string, string> = {};
    public readonly dataset: Record<string, string> = {};
    public readonly classList: FakeClassList;
    public id = '';
    public label = '';
    public title = '';
    public type = '';
    /** `<label for>` and `<a target|rel>`, which media/config.js sets. */
    public htmlFor = '';
    public target = '';
    public rel = '';
    public disabled = false;
    public selected = false;
    public checked = false;
    public tabIndex = 0;
    public open = false;
    public scrollTop = 0;
    public scrollHeight = 0;
    public clientHeight = 0;
    public parentNode: FakeEl | null = null;
    private readonly attrs: Record<string, string> = {};
    private readonly handlers: Record<string, Array<(evt: unknown) => void>> = {};
    private textValue = '';
    private htmlValue = '';
    private valueStore = '';
    private readonly classSet: Set<string>;

    constructor(tagName: string) {
      this.tagName = tagName.toUpperCase();
      this.classSet = new Set<string>();
      this.classList = new FakeClassList(this.classSet);
    }

    public get className(): string {
      return Array.from(this.classSet).join(' ');
    }

    public set className(value: string) {
      this.classSet.clear();
      String(value)
        .split(/\s+/)
        .filter(Boolean)
        .forEach((t) => this.classSet.add(t));
    }

    /**
     * Reflected, so `removeAttribute('href')` really clears it — which is how
     * media/config.js hides a capability's documentation link.
     */
    public get href(): string {
      return this.attrs.href ?? '';
    }

    public set href(value: string) {
      this.attrs.href = String(value);
    }

    public get textContent(): string {
      if (this.children.length > 0) {
        let out = '';
        for (const child of this.children) {
          out += child.textContent;
        }
        return out;
      }
      return this.textValue;
    }

    public set textContent(value: string) {
      for (const child of this.children) {
        child.parentNode = null;
      }
      this.children.length = 0;
      this.textValue = String(value);
    }

    public get innerHTML(): string {
      return this.htmlValue;
    }

    public set innerHTML(value: string) {
      this.htmlValue = String(value);
    }

    /** Real HTMLOptionsCollection semantics: options of the select and of its optgroups. */
    public get options(): FakeEl[] {
      const out: FakeEl[] = [];
      for (const child of this.children) {
        if (child.tagName === 'OPTION') {
          out.push(child);
        } else if (child.tagName === 'OPTGROUP') {
          for (const opt of child.children) {
            if (opt.tagName === 'OPTION') {
              out.push(opt);
            }
          }
        }
      }
      return out;
    }

    public get selectedIndex(): number {
      const opts = this.options;
      for (let i = 0; i < opts.length; i++) {
        if (opts[i].selected) {
          return i;
        }
      }
      return -1;
    }

    public set selectedIndex(index: number) {
      const opts = this.options;
      for (let i = 0; i < opts.length; i++) {
        opts[i].selected = i === index;
      }
    }

    public get value(): string {
      if (this.tagName === 'SELECT') {
        for (const opt of this.options) {
          if (opt.selected) {
            return opt.value;
          }
        }
      }
      return this.valueStore;
    }

    public set value(v: string) {
      if (this.tagName !== 'SELECT') {
        this.valueStore = String(v);
        return;
      }
      const opts = this.options;
      let found: FakeEl | undefined;
      for (const opt of opts) {
        if (opt.value === v) {
          found = opt;
          break;
        }
      }
      if (found) {
        for (const opt of opts) {
          opt.selected = opt === found;
        }
        this.valueStore = found.value;
      } else {
        this.valueStore = '';
      }
    }

    public get firstChild(): FakeEl | null {
      return this.children[0] ?? null;
    }

    public get lastElementChild(): FakeEl | null {
      return this.children[this.children.length - 1] ?? null;
    }

    public appendChild(node: FakeEl): FakeEl {
      this.detach(node);
      node.parentNode = this;
      this.children.push(node);
      return node;
    }

    public insertBefore(node: FakeEl, ref: FakeEl | null): FakeEl {
      if (ref === null) {
        return this.appendChild(node);
      }
      this.detach(node);
      const index = this.children.indexOf(ref);
      node.parentNode = this;
      this.children.splice(index < 0 ? this.children.length : index, 0, node);
      return node;
    }

    /** Detach from the parent's child list, returning the node (config.js). */
    public removeChild(node: FakeEl): FakeEl {
      this.detach(node);
      return node;
    }

    /** Detach self from its parent (config.js's `.remove()`). */
    public remove(): void {
      this.parentNode?.detach(this);
    }

    public setAttribute(name: string, value: string): void {
      this.attrs[name] = String(value);
    }

    public getAttribute(name: string): string | null {
      const value = this.attrs[name];
      return value === undefined ? null : value;
    }

    public removeAttribute(name: string): void {
      // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
      delete this.attrs[name];
    }

    public focus(): void {
      // Not needed by these tests.
    }

    public addEventListener(type: string, fn: (evt: unknown) => void): void {
      if (!this.handlers[type]) {
        this.handlers[type] = [];
      }
      this.handlers[type].push(fn);
    }

    /** Test-only dispatch recorded by {@link addEventListener}. */
    public fire(type: string, evt: unknown = {}): void {
      for (const fn of this.handlers[type] ?? []) {
        fn(evt);
      }
    }

    public querySelectorAll(selector: string): FakeEl[] {
      const out: FakeEl[] = [];
      for (const el of this.descendants()) {
        if (el.matches(selector)) {
          out.push(el);
        }
      }
      return out;
    }

    public querySelector(selector: string): FakeEl | null {
      return this.querySelectorAll(selector)[0] ?? null;
    }

    /**
     * One comma-free selector part: `[name]`, `[name="value"]` (quotes
     * optional), `.class` or a tag name. `data-*` attributes are looked up on
     * `dataset` as well as on the attribute map, because both fakes' elements
     * carry them there.
     */
    private matchesOne(selector: string): boolean {
      const sel = selector.trim();
      if (sel.startsWith('[') && sel.endsWith(']')) {
        const body = sel.slice(1, -1);
        const eq = body.indexOf('=');
        const name = eq === -1 ? body : body.slice(0, eq);
        const want = eq === -1 ? undefined : body.slice(eq + 1).replace(/^["']|["']$/g, '');
        const actual = name.startsWith('data-')
          ? (this.dataset[name.slice(5).replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())] ??
            this.attrs[name])
          : this.attrs[name];
        if (actual === undefined) {
          return false;
        }
        return want === undefined ? true : actual === want;
      }
      if (sel.startsWith('.')) {
        return this.classList.contains(sel.slice(1));
      }
      return this.tagName === sel.toUpperCase();
    }

    private matches(selector: string): boolean {
      return selector.split(',').some((part) => this.matchesOne(part));
    }

    /** Public so a document stub can resolve ids created during a render. */
    public *descendants(): Generator<FakeEl> {
      for (const child of this.children) {
        yield child;
        yield* child.descendants();
      }
    }

    private detach(node: FakeEl): void {
      if (node.parentNode) {
        const index = node.parentNode.children.indexOf(node);
        if (index >= 0) {
          node.parentNode.children.splice(index, 1);
        }
      }
      node.parentNode = null;
    }
  }

  // --- Leg 1: reload refresh end to end --------------------------------------

  describe('model selector refresh: reload refresh', () => {
    it('a window reload refreshes every source and the config panel picks it up without a second loaded', async () => {
      const harness = buildDiscovery();
      const dir = newDir();
      writeConfigFile(dir, defaultConfigJson());
      const { webview } = buildPanel(harness, dir);

      await webview.send({ type: 'ready' });

      assert.strictEqual(webview.loaded().length, 1, 'exactly one loaded');
      const firstLoad = webview.loaded()[0];
      assert.deepStrictEqual(
        firstLoad.options.byAgent.claude.models,
        builtinAgentCapabilities().claude.models,
        'before a refresh the panel shows the curated builtin claude list',
      );
      // The store seeds its builtins at construction, so the pre-refresh entry
      // is provenance-stamped `builtin` — but never stale and never reasoned.
      assert.strictEqual(firstLoad.options.byAgent.claude.source, 'builtin');
      assert.strictEqual(firstLoad.options.byAgent.claude.stale, false);
      assert.strictEqual(
        hasOwnKey(firstLoad.options.byAgent.claude, 'staleReason'),
        false,
        'an unrefreshed capability carries no own staleReason key',
      );

      await harness.discovery.refresh();

      const changes = webview.optionsChanged();
      assert.ok(changes.length >= 1, 'at least one optionsChanged is posted per refresh');
      assert.strictEqual(webview.loaded().length, 1, 'a refresh never re-posts loaded');
      const byAgent = changes[changes.length - 1].options.byAgent;

      // claude: the models.dev `anthropic` provider, fetched exactly once.
      assert.ok(byAgent.claude.models.includes('claude-opus-5-5'));
      assert.ok(byAgent.claude.models.includes('claude-sonnet-5'));
      // codex: the app-server `model/list` ids plus the union of their efforts.
      assert.deepStrictEqual(byAgent.codex.models, ['gpt-6-astra', 'gpt-5-codex']);
      assertSameSet(
        byAgent.codex.efforts,
        ['low', 'medium', 'high', 'xhigh', 'minimal'],
        'the codex efforts are the union of the per-model levels',
      );
      // opencode: `provider/model` ids from `/api/model`.
      assert.ok(byAgent.opencode.models.includes('anthropic/claude-sonnet-5'));
      // antigravity: the stubbed-out `agy models` fails, so the curated seed
      // survives the refresh and is marked stale.
      assert.deepStrictEqual(
        byAgent.antigravity.models,
        builtinAgentCapabilities().antigravity.models,
      );
      assert.strictEqual(byAgent.antigravity.source, 'builtin');
      assert.strictEqual(byAgent.antigravity.stale, true);
      assert.ok((byAgent.antigravity.staleReason ?? '').length > 0, 'antigravity names a stale reason');
    });

    it('the persisted snapshots come back as cached on the next window, before any fetch', async () => {
      const memento = fakeMemento();
      const first = buildDiscovery({ memento });
      await first.discovery.refresh();

      const blob = memento.store.get(MODEL_CATALOG_MEMENTO_KEY) as { version: number } | undefined;
      assert.ok(blob !== undefined, 'the store persisted through the memento');
      assert.strictEqual(blob.version, MODEL_CATALOG_PERSIST_VERSION);

      // The next window: a second store over the SAME memento, with fresh
      // builtins and no refresh at all.
      const store2 = new CatalogStore({
        memento,
        builtins: builtinCatalogFetches(),
        now: tickingClock(),
      });
      const claude = store2.get('claude');
      assert.ok(claude !== undefined);
      assert.strictEqual(claude.source, 'cached', 'a reload shows the last good list immediately');
      assert.strictEqual(claude.stale, false);
      assert.ok(agentCapabilities(store2.table()).claude.models.includes('claude-opus-5-5'));

      const second = buildDiscovery({ memento });
      // The second window's own store is what its service writes to; assert on
      // that one, then confirm the rehydrated store agreed before the fetch.
      await second.discovery.refresh();
      assert.strictEqual(second.store.get('claude')?.source, 'live');
    });

    it("a seeded store reaches the panel's first loaded, and a later refresh arrives as optionsChanged only", async () => {
      // Window one: refresh so the memento holds real snapshots.
      const memento = fakeMemento();
      const first = buildDiscovery({ memento });
      await first.discovery.refresh();

      // Window two: the store rehydrates in its constructor — i.e. exactly the
      // state the host is in when `registerConfigPanel` runs, because
      // `src/extension.ts` builds the store BEFORE registering the panel.
      const second = buildDiscovery({ memento });
      const dir = newDir();
      writeConfigFile(dir, defaultConfigJson());
      const { webview } = buildPanel(second, dir);

      await webview.send({ type: 'ready' });

      assert.strictEqual(webview.loaded().length, 1, 'exactly one loaded');
      const claude = webview.loaded()[0].options.byAgent.claude;
      assert.strictEqual(
        claude.source,
        'cached',
        "the panel's first load shows the rehydrated list, not the curated builtin one",
      );
      assert.strictEqual(claude.stale, false);
      assert.strictEqual(
        hasOwnKey(claude, 'staleReason'),
        false,
        'a rehydrated capability carries no own staleReason key',
      );
      assert.deepStrictEqual(
        claude.models,
        agentCapabilities(second.store.table()).claude.models,
        'the last known-good list is on screen before any fetch',
      );

      await second.discovery.refresh();

      assert.strictEqual(webview.loaded().length, 1, 'a refresh never re-posts loaded');
      const changes = webview.optionsChanged();
      assert.ok(changes.length >= 1, 'the refresh reaches the open panel as optionsChanged');
      assert.strictEqual(
        changes[changes.length - 1].options.byAgent.claude.source,
        'live',
        'the final optionsChanged carries the freshly discovered claude list',
      );
    });

    it('refresh never blocks and never rejects', async function () {
      this.timeout(10_000);
      const harness = buildDiscovery({
        mode: { feed: 'hang', claudeFeed: 'hang', codex: 'hang', opencode: 'fail' },
        timeoutMs: 50,
      });
      const seeds = builtinCatalogFetches();

      const inFlight = harness.discovery.refresh();
      // Capabilities stay answerable synchronously while the refresh is out.
      assert.deepStrictEqual(
        agentCapabilities(harness.store.table()).claude.models,
        builtinAgentCapabilities().claude.models,
      );
      await assert.doesNotReject(() => inFlight);

      for (const sourceId of ['claude', 'codex', 'opencode'] as const) {
        const snapshot = harness.store.get(sourceId);
        assert.ok(snapshot !== undefined, `${sourceId} still has a snapshot`);
        assert.deepStrictEqual(snapshot.models, seeds[sourceId]?.models);
      }

      // A second refresh started before the first settles resolves too.
      const a = harness.discovery.refresh();
      const b = harness.discovery.refresh();
      await assert.doesNotReject(() => Promise.all([a, b]));

      // An adapter whose `discoverModels` throws synchronously does not reject
      // the refresh either.
      const throwing = buildDiscovery({ timeoutMs: 50 });
      const registry: DiscoveryRegistry = {
        get: (agent: string): Adapter | undefined =>
          agent === 'codex'
            ? ({
                id: 'codex',
                discoverModels: (): Promise<AgentCapabilities | undefined> => {
                  throw new Error('discoverModels exploded');
                },
              } as unknown as Adapter)
            : undefined,
        ids: ['codex'],
      };
      const exploding = new ModelDiscoveryService({
        store: throwing.store,
        registry,
        fetchFeed: async () => ok<ModelsDevFeed, string>(fixtureFeed()),
        timeoutMs: 50,
      });
      services.push(exploding);
      await assert.doesNotReject(() => exploding.refresh());
      assert.match(throwing.store.get('codex')?.staleReason ?? '', /discoverModels exploded/);
    });

    it('a data-shaped model/list reply reaches an open panel with per-model efforts', async () => {
      const harness = buildDiscovery({ mode: { codex: 'data' } });
      const dir = newDir();
      writeConfigFile(dir, defaultConfigJson());
      const { webview } = buildPanel(harness, dir);
      await webview.send({ type: 'ready' });

      await harness.discovery.refresh();

      const changes = webview.optionsChanged();
      const codex = changes[changes.length - 1].options.byAgent.codex;

      // `model` wins over the internal `id`, and the `hidden: true` model is
      // kept — `includeHidden: true` asked for it.
      assert.deepStrictEqual(codex.models, ['gpt-6-astra', 'gpt-6-sol']);
      assert.deepStrictEqual(codex.modelEntries, [
        {
          id: 'gpt-6-astra',
          label: 'GPT-6 Astra',
          efforts: ['low', 'medium', 'high', 'xhigh'],
          defaultEffort: 'medium',
        },
        { id: 'gpt-6-sol', label: 'GPT-6 Sol', efforts: ['medium', 'max'] },
      ]);
      assert.strictEqual(
        hasOwnKey(codex.modelEntries![1], 'defaultEffort'),
        false,
        'a model whose reply names no default carries no defaultEffort own key',
      );
      // The union INCLUDES `max`, a level the curated CODEX_EFFORTS lacks.
      assertSameSet(
        codex.efforts,
        ['low', 'medium', 'high', 'xhigh', 'max'],
        'the codex efforts are the union of the per-model levels',
      );
      assert.strictEqual(codex.source, 'live');
      assert.strictEqual(codex.stale, false);
      assert.strictEqual(hasOwnKey(codex, 'staleReason'), false);

      const requests = harness.codexServer.modelListRequests();
      assert.strictEqual(requests.length, 1, 'one unpaged reply needs one request');
      assert.deepStrictEqual(
        requests[0].params,
        codexModelListParams(),
        'model/list carries includeHidden and limit',
      );
    });

    it('a paged model/list reply arrives whole', async () => {
      const harness = buildDiscovery({ mode: { codex: 'paged' } });
      const dir = newDir();
      writeConfigFile(dir, defaultConfigJson());
      const { webview } = buildPanel(harness, dir);
      await webview.send({ type: 'ready' });

      await harness.discovery.refresh();

      const snapshot = harness.store.get('codex')!;
      assert.deepStrictEqual(
        snapshot.models.map((entry) => ({ id: entry.id, efforts: entry.efforts })),
        [
          { id: 'gpt-6-astra', efforts: ['low', 'high'] },
          { id: 'gpt-6-sol', efforts: ['high'] },
        ],
      );
      assert.strictEqual(snapshot.stale, false);

      const requests = harness.codexServer.modelListRequests();
      assert.strictEqual(requests.length, 2, 'the nextCursor page is followed');
      assert.strictEqual(requests[1].params?.cursor, 'cursor-2');
      assert.strictEqual(requests[1].id, 3, 'the follow-up page uses the next consecutive id');
    });
  });

  // --- Leg 6a: the Claude CLI's own local catalog drives the panel ----------

  describe('model selector refresh: claude local catalog', () => {
    it('an offline window refreshes claude from the local catalog, with per-model efforts and defaults', async () => {
      // BOTH network legs fail: the shared feed and the adapter's own fetcher.
      const harness = buildDiscovery({
        mode: { claudeCatalog: 'ok', feed: 'fail', claudeFeed: 'fail' },
      });
      const dir = newDir();
      writeConfigFile(dir, defaultConfigJson());
      const { webview } = buildPanel(harness, dir);
      await webview.send({ type: 'ready' });

      await harness.discovery.refresh();

      const changes = webview.optionsChanged();
      const claude = changes[changes.length - 1].options.byAgent.claude;

      // `section: 'main'` in file order, then `overflow` in file order; the
      // duplicate `claude-sonnet-5`, the `gpt-5` id and the blank id are gone.
      assert.deepStrictEqual(claude.models, [
        'claude-opus-5-5',
        'claude-sonnet-5',
        'claude-haiku-4-5-20251001',
        'claude-opus-4-7',
        'claude-label-equals-id',
      ]);
      assert.deepStrictEqual(claude.modelEntries, [
        {
          id: 'claude-opus-5-5',
          label: 'Opus 5.5',
          efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
          defaultEffort: 'medium',
        },
        { id: 'claude-sonnet-5', label: 'Sonnet 5', efforts: ['low', 'high'], defaultEffort: 'high' },
        // The EXPLICIT empty list is the `thinking: none` marker the webview
        // reads as "this model has no levels", distinct from "unknown".
        { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', efforts: [] },
        { id: 'claude-opus-4-7', label: 'Opus 4.7', efforts: ['low', 'high'], defaultEffort: 'high' },
        // `name === id`, so no label at all.
        { id: 'claude-label-equals-id', efforts: [] },
      ]);
      // Only ids, labels and effort names may cross to the webview.
      assert.strictEqual(hasOwnKey(claude.modelEntries![0], 'provider'), false);
      assert.strictEqual(hasOwnKey(claude.modelEntries![0], 'custom'), false);

      assert.deepStrictEqual(claude.efforts, ['low', 'medium', 'high', 'xhigh', 'max']);
      assert.strictEqual(claude.source, 'live');
      assert.strictEqual(claude.stale, false);

      // The offline guarantee: the adapter returned from the catalog before it
      // ever touched its fetcher, and the feed source recorded nothing at all.
      assert.strictEqual(harness.claudeFeedCalls(), 0, 'no network for the claude leg');
      assert.strictEqual(harness.store.get('models.dev'), undefined);
    });

    it('a malformed local catalog falls back to the models.dev feed', async () => {
      const harness = buildDiscovery({ mode: { claudeCatalog: 'malformed' } });
      const dir = newDir();
      writeConfigFile(dir, defaultConfigJson());
      const { webview } = buildPanel(harness, dir);
      await webview.send({ type: 'ready' });

      await harness.discovery.refresh();

      const changes = webview.optionsChanged();
      const claude = changes[changes.length - 1].options.byAgent.claude;
      assert.ok(claude.models.includes('claude-haiku-4-5'), 'a feed-only id is present');
      assert.strictEqual(
        claude.models.includes('claude-opus-4-7'),
        false,
        'the catalog-only id is not',
      );
      for (const entry of claude.modelEntries ?? []) {
        assert.strictEqual(
          hasOwnKey(entry, 'efforts'),
          false,
          `the feed discloses no per-model levels (${entry.id})`,
        );
      }
      assert.deepStrictEqual(claude.efforts, [...CLAUDE_EFFORTS]);
      assert.strictEqual(claude.source, 'live');
      assert.strictEqual(claude.stale, false);
      assert.strictEqual(
        claude.models.filter((m) => m === 'claude-sonnet-5').length,
        1,
        'the required default is present exactly once',
      );
    });

    it('both claude sources unusable keeps the last known-good catalog list, marked stale', async () => {
      const harness = buildDiscovery({ mode: { claudeCatalog: 'ok' } });
      const dir = newDir();
      writeConfigFile(dir, defaultConfigJson());
      const { webview } = buildPanel(harness, dir);
      await webview.send({ type: 'ready' });

      await harness.discovery.refresh();
      const good = harness.store.get('claude')!;
      const goodModels = good.models;
      const goodFetchedAt = good.fetchedAt;
      const goodEntries = agentCapabilities(harness.store.table()).claude.modelEntries;
      assert.ok((goodEntries ?? []).length > 0, 'the catalog leg landed');

      // The catalog turns unusable AND both feed legs fail.
      harness.mode.claudeCatalog = 'malformed';
      harness.mode.claudeFeed = 'fail';
      harness.mode.feed = 'fail';
      await harness.discovery.refresh();

      const stale = harness.store.get('claude')!;
      assert.deepStrictEqual(stale.models, goodModels, 'the models survive byte for byte');
      assert.strictEqual(stale.fetchedAt, goodFetchedAt, 'fetchedAt is the last SUCCESSFUL fetch');
      assert.strictEqual(stale.stale, true);
      assert.ok((stale.staleReason ?? '').length > 0);
      assert.deepStrictEqual(
        agentCapabilities(harness.store.table()).claude.modelEntries,
        goodEntries,
        'the per-model entries survive too',
      );

      const changes = webview.optionsChanged();
      const last = changes[changes.length - 1];
      assert.ok(
        last.options.byAgent.claude.models.includes('claude-opus-4-7'),
        'the catalog-derived list is still on screen',
      );
      assert.strictEqual(last.stale.claude?.stale, true);
    });
  });

  // --- Leg 2: discovery fallback and stale-list handling ---------------------

  describe('model selector refresh: discovery fallback', () => {
    it('every source failing keeps the curated builtin lists and marks them stale', async () => {
      const harness = buildDiscovery({
        mode: { feed: 'fail', claudeFeed: 'fail', codex: 'fail', opencode: 'fail' },
      });
      const seeds = builtinCatalogFetches();
      const seededFetchedAt: Partial<Record<string, string>> = {};
      for (const sourceId of ['claude', 'codex', 'opencode'] as const) {
        seededFetchedAt[sourceId] = harness.store.get(sourceId)!.fetchedAt;
      }

      await harness.discovery.refresh();

      for (const sourceId of ['claude', 'codex', 'opencode'] as const) {
        const snapshot = harness.store.get(sourceId);
        assert.ok(snapshot !== undefined, `${sourceId} keeps a snapshot`);
        assert.strictEqual(snapshot.stale, true, `${sourceId} is stale`);
        assert.ok((snapshot.staleReason ?? '').length > 0, `${sourceId} names a reason`);
        assert.deepStrictEqual(snapshot.models, seeds[sourceId]?.models);
        assert.strictEqual(
          snapshot.fetchedAt,
          seededFetchedAt[sourceId],
          `${sourceId} keeps the last successful fetchedAt`,
        );
      }

      const caps = agentCapabilities(harness.store.table());
      assert.deepStrictEqual(caps.claude.models, builtinAgentCapabilities().claude.models);
      assert.strictEqual(caps.claude.stale, true);
      assert.strictEqual(caps.claude.source, 'builtin');
      assert.strictEqual(caps.antigravity.stale, true);
      assert.deepStrictEqual(caps.antigravity.models, builtinAgentCapabilities().antigravity.models);

      // models.dev has no builtin seed, so a never-successful source records
      // nothing at all — the documented `applyResult` contract.
      assert.strictEqual(harness.store.get('models.dev'), undefined);
    });

    it('a failure after a success keeps the last good list', async () => {
      const harness = buildDiscovery();
      const dir = newDir();
      writeConfigFile(dir, defaultConfigJson());
      const { webview } = buildPanel(harness, dir);
      await webview.send({ type: 'ready' });

      await harness.discovery.refresh();
      const good = harness.store.get('claude')!;
      const goodModels = good.models;
      const goodFetchedAt = good.fetchedAt;
      assert.strictEqual(good.source, 'live');

      harness.mode.feed = 'fail';
      harness.mode.claudeFeed = 'fail';
      await harness.discovery.refresh();

      const stale = harness.store.get('claude')!;
      assert.deepStrictEqual(stale.models, goodModels, 'the models survive byte for byte');
      assert.strictEqual(stale.fetchedAt, goodFetchedAt, 'fetchedAt is the last SUCCESSFUL fetch');
      assert.strictEqual(stale.source, 'live');
      assert.strictEqual(stale.stale, true);
      assert.ok((stale.staleReason ?? '').length > 0);

      const changes = webview.optionsChanged();
      const last = changes[changes.length - 1];
      assert.deepStrictEqual(last.stale.claude, {
        stale: true,
        reason: stale.staleReason,
        fetchedAt: goodFetchedAt,
      });
      assert.ok(
        last.options.byAgent.claude.models.includes('claude-opus-5-5'),
        'the panel still lists the refreshed ids behind the stale note',
      );
    });

    it('a later success clears the stale mark', async () => {
      const harness = buildDiscovery();
      const dir = newDir();
      writeConfigFile(dir, defaultConfigJson());
      const { webview } = buildPanel(harness, dir);
      await webview.send({ type: 'ready' });

      await harness.discovery.refresh();
      const firstFetchedAt = harness.store.get('claude')!.fetchedAt;

      harness.mode.feed = 'fail';
      harness.mode.claudeFeed = 'fail';
      await harness.discovery.refresh();
      assert.strictEqual(harness.store.get('claude')!.stale, true);

      harness.mode.feed = 'ok';
      harness.mode.claudeFeed = 'ok';
      await harness.discovery.refresh();

      const fresh = harness.store.get('claude')!;
      assert.strictEqual(fresh.stale, false);
      assert.strictEqual(fresh.staleReason, undefined);
      assert.ok(fresh.fetchedAt > firstFetchedAt, 'a later success advances fetchedAt');

      const changes = webview.optionsChanged();
      const last = changes[changes.length - 1];
      assert.strictEqual(
        last.stale.claude === undefined || last.stale.claude.stale === false,
        true,
        'the panel no longer reports claude as stale',
      );
    });

    it('one failing source never poisons the others', async () => {
      const harness = buildDiscovery({ mode: { codex: 'fail' } });
      const seeds = builtinCatalogFetches();

      await harness.discovery.refresh();

      const codex = harness.store.get('codex')!;
      assert.strictEqual(codex.stale, true);
      assert.deepStrictEqual(codex.models, seeds['codex']?.models, 'the curated CODEX_MODELS stand');

      const claude = harness.store.get('claude')!;
      assert.strictEqual(claude.stale, false);
      assert.ok(claude.models.some((m) => m.id === 'claude-opus-5-5'), 'the feed-derived list');
    });

    /** The four CLI-backed sources, in the order these two cases assert them. */
    const CLI_SOURCES = ['claude', 'codex', 'opencode', 'antigravity'] as const;

    /** One source's last known-good shape, recorded before the failing refresh. */
    interface Recorded {
      models: readonly { id: string }[];
      efforts: readonly string[] | undefined;
      fetchedAt: string;
      entries: readonly { id: string }[] | undefined;
    }

    /**
     * The entries are read off the PANEL's own message, not off
     * `agentCapabilities`: `configFormOptions` strips `provider` on the way to
     * the webview, so the two shapes are deliberately not identical.
     */
    function record(harness: Harness, webview: RecordingConfigWebview): Record<string, Recorded> {
      const changes = webview.optionsChanged();
      const last = changes[changes.length - 1];
      const out: Record<string, Recorded> = {};
      for (const agent of CLI_SOURCES) {
        const snapshot = harness.store.get(agent)!;
        assert.ok(snapshot.models.length > 0, `${agent} starts from a non-empty list`);
        out[agent] = {
          models: snapshot.models,
          efforts: snapshot.efforts,
          fetchedAt: snapshot.fetchedAt,
          entries: last.options.byAgent[agent].modelEntries,
        };
      }
      return out;
    }

    /** The never-blanked / stale guarantees shared by the two cases below. */
    function assertNeverBlanked(
      harness: Harness,
      webview: RecordingConfigWebview,
      before: Record<string, Recorded>,
    ): void {
      const changes = webview.optionsChanged();
      const last = changes[changes.length - 1];
      for (const agent of CLI_SOURCES) {
        const snapshot = harness.store.get(agent)!;
        const recorded = before[agent];
        assert.deepStrictEqual(snapshot.models, recorded.models, `${agent} models survive`);
        assert.deepStrictEqual(snapshot.efforts, recorded.efforts, `${agent} efforts survive`);
        assert.strictEqual(snapshot.fetchedAt, recorded.fetchedAt, `${agent} keeps its fetchedAt`);
        assert.strictEqual(snapshot.stale, true, `${agent} is stale`);
        assert.ok((snapshot.staleReason ?? '').length > 0, `${agent} names a reason`);
        assert.ok(snapshot.models.length > 0, `${agent} is never blanked`);

        const cap = last.options.byAgent[agent];
        assert.ok(cap.models.length > 0, `${agent}'s selector is never blanked`);
        assert.deepStrictEqual(last.stale[agent], {
          stale: true,
          reason: snapshot.staleReason,
          fetchedAt: recorded.fetchedAt,
        });
        assert.deepStrictEqual(cap.modelEntries, before[agent].entries, `${agent} keeps its entries`);
      }
      // The rich per-model metadata is still on screen, not just the ids.
      const astra = (last.options.byAgent.codex.modelEntries ?? []).find(
        (entry) => entry.id === 'gpt-6-astra',
      );
      assert.ok(astra, 'the codex entry survives the failed refresh');
      assert.deepStrictEqual(astra.efforts, ['low', 'medium', 'high', 'xhigh']);
      assert.strictEqual(astra.defaultEffort, 'medium');
    }

    it('malformed data from every source keeps the last known-good lists, marked stale', async () => {
      const harness = buildDiscovery({
        mode: { codex: 'data', claudeCatalog: 'ok', opencodeCli: 'ok', agy: 'ok' },
      });
      const dir = newDir();
      writeConfigFile(dir, defaultConfigJson());
      const { webview } = buildPanel(harness, dir);
      await webview.send({ type: 'ready' });

      await harness.discovery.refresh();
      const before = record(harness, webview);

      harness.mode.codex = 'malformed';
      harness.mode.claudeCatalog = 'malformed';
      harness.mode.claudeFeed = 'fail';
      harness.mode.feed = 'fail';
      harness.mode.opencodeCli = 'empty';
      harness.mode.opencode = 'fail';
      harness.mode.agy = 'fail';
      await harness.discovery.refresh();

      assertNeverBlanked(harness, webview, before);
    });

    it('a timed-out refresh of every source keeps the last known-good lists', async function () {
      this.timeout(10_000);
      const harness = buildDiscovery({
        mode: { codex: 'data', claudeCatalog: 'ok', opencodeCli: 'ok', agy: 'ok' },
        timeoutMs: 50,
      });
      const dir = newDir();
      writeConfigFile(dir, defaultConfigJson());
      const { webview } = buildPanel(harness, dir);
      await webview.send({ type: 'ready' });

      await harness.discovery.refresh();
      const before = record(harness, webview);

      // A HUNG local catalog is treated as "no catalog" and falls THROUGH to
      // the feed, so the hanging feed legs are what make claude fail here.
      harness.mode.claudeCatalog = 'hang';
      harness.mode.feed = 'hang';
      harness.mode.claudeFeed = 'hang';
      harness.mode.codex = 'hang';
      harness.mode.opencodeCli = 'empty';
      harness.mode.opencode = 'fail';
      harness.mode.agy = 'fail';
      await assert.doesNotReject(() => harness.discovery.refresh());

      assertNeverBlanked(harness, webview, before);
    });
  });

  // --- Leg 6b: `opencode models --verbose` is the primary source -------------

  describe('model selector refresh: opencode CLI first', () => {
    it('the verbose CLI listing reaches an open panel as a model list with per-model variants', async () => {
      // The API leg would FAIL if it were reached; it must not be.
      const harness = buildDiscovery({ mode: { opencodeCli: 'ok', opencode: 'fail' } });
      const dir = newDir();
      writeConfigFile(dir, defaultConfigJson());
      const { webview } = buildPanel(harness, dir);
      await webview.send({ type: 'ready' });

      await harness.discovery.refresh();

      const changes = webview.optionsChanged();
      const opencode = changes[changes.length - 1].options.byAgent.opencode;

      assert.deepStrictEqual(opencode.models, [
        'anthropic/claude-sonnet-5',
        'openai/gpt-6',
        'google/gemini-3-pro',
        'zed/weird-1',
        'local/llama-4',
        'broken/model-1',
        'last/no-detail',
      ]);
      assert.deepStrictEqual(opencode.modelEntries, [
        { id: 'anthropic/claude-sonnet-5', label: 'Claude Sonnet 5', efforts: ['low', 'high', 'max'] },
        // `variants: {}` carries NO `efforts` key: "no variants" is not "none".
        { id: 'openai/gpt-6', label: 'GPT-6' },
        { id: 'google/gemini-3-pro', label: 'Gemini 3 Pro', efforts: ['none', 'thinking'] },
        { id: 'zed/weird-1', label: 'Weird {model} name', efforts: ['minimal'] },
        // `name` equals the bare model id, so no label.
        { id: 'local/llama-4' },
        // The unparseable JSON block degrades to a plain entry.
        { id: 'broken/model-1' },
        { id: 'last/no-detail' },
      ]);
      // The parser stamps `provider` on every entry; `formModelEntry` strips it
      // before the entry crosses to the webview.
      assert.strictEqual(hasOwnKey(opencode.modelEntries![0], 'provider'), false);

      // The ordered union is what turns the effort control into a dropdown.
      assert.deepStrictEqual(opencode.efforts, [
        'low',
        'high',
        'max',
        'none',
        'thinking',
        'minimal',
      ]);
      assert.strictEqual(
        opencode.modelLink,
        builtinAgentCapabilities().opencode.modelLink,
        'the documentation link is re-attached from the builtin',
      );
      assert.strictEqual(harness.opencodeApiCalls(), 0, 'no server, no /api/model request');
    });

    it('falls back to /api/model only when the CLI yields nothing', async () => {
      const harness = buildDiscovery({ mode: { opencodeCli: 'fail', opencode: 'ok' } });

      await harness.discovery.refresh();

      const snapshot = harness.store.get('opencode')!;
      const ids = snapshot.models.map((entry) => entry.id);
      assert.ok(ids.includes('anthropic/claude-sonnet-5'));
      assert.ok(ids.includes('github-copilot/gpt-5'));
      for (const entry of snapshot.models) {
        assert.strictEqual(hasOwnKey(entry, 'efforts'), false, `${entry.id} discloses no levels`);
      }
      // The free-text shape is preserved: an empty agent-level union.
      assert.deepStrictEqual(agentCapabilities(harness.store.table()).opencode.efforts, []);
      assert.ok(harness.opencodeApiCalls() >= 1, 'the API leg ran');
    });

    it('both opencode sources unusable keeps the last known-good list, marked stale', async () => {
      const harness = buildDiscovery({ mode: { opencodeCli: 'ok' } });

      await harness.discovery.refresh();
      const good = harness.store.get('opencode')!;
      const goodModels = good.models;
      const goodFetchedAt = good.fetchedAt;
      const goodEntries = agentCapabilities(harness.store.table()).opencode.modelEntries;

      harness.mode.opencodeCli = 'empty';
      harness.mode.opencode = 'fail';
      await harness.discovery.refresh();

      const stale = harness.store.get('opencode')!;
      assert.deepStrictEqual(stale.models, goodModels, 'the models survive byte for byte');
      assert.strictEqual(stale.fetchedAt, goodFetchedAt);
      assert.strictEqual(stale.stale, true);
      assert.ok((stale.staleReason ?? '').length > 0);
      assert.deepStrictEqual(
        agentCapabilities(harness.store.table()).opencode.modelEntries,
        goodEntries,
      );
    });
  });

  // --- Leg 6c: `agy models` drives the antigravity selector -----------------

  describe('model selector refresh: antigravity agy models', () => {
    it('the agy listing reaches an open panel as families with their levels and fixed ids', async () => {
      const harness = buildDiscovery({ mode: { agy: 'ok' } });
      const dir = newDir();
      writeConfigFile(dir, defaultConfigJson());
      const { webview } = buildPanel(harness, dir);
      await webview.send({ type: 'ready' });

      await harness.discovery.refresh();

      const changes = webview.optionsChanged();
      const antigravity = changes[changes.length - 1].options.byAgent.antigravity;

      assert.deepStrictEqual(antigravity.models, [
        'gemini-3.8-flash',
        'gemini-3.7-flash',
        'gemini-3.6-flash',
        'gemini-3.1-pro',
        'claude-sonnet-4-6',
        'claude-opus-4-6-thinking',
        'gpt-oss-120b-medium',
      ]);
      assert.deepStrictEqual(antigravity.modelEntries, [
        { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash', efforts: ['low', 'medium', 'high'] },
        { id: 'gemini-3.7-flash', label: 'Gemini 3.7 Flash', efforts: ['low', 'medium', 'high'] },
        { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash', efforts: ['low', 'medium', 'high'] },
        { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro', efforts: ['low', 'high'] },
        // A lone suffixed id and the Claude ids are FIXED: agy rejects
        // `--effort` for them, so the empty list is explicit.
        { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6', efforts: [] },
        { id: 'claude-opus-4-6-thinking', label: 'Claude Opus 4.6 (Thinking)', efforts: [] },
        { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B Medium', efforts: [] },
      ]);
      for (const entry of antigravity.modelEntries ?? []) {
        assert.strictEqual(
          hasOwnKey(entry, 'defaultEffort'),
          false,
          `agy defines no default (${entry.id})`,
        );
      }
      assert.deepStrictEqual(antigravity.efforts, ['low', 'medium', 'high']);
      assert.strictEqual(antigravity.source, 'live');
      assert.strictEqual(antigravity.stale, false);

      // A deliberate DRIFT ALARM, not a tautology: what the panel shows is the
      // discovered listing, and it must still reproduce the hand-maintained
      // table. When `ANTIGRAVITY_MODELS` is next refreshed by hand this
      // assertion fails, and test/fixtures/agyModels.sample.txt must be
      // refreshed with it.
      assert.deepStrictEqual(
        antigravity.models,
        builtinAgentCapabilities().antigravity.models,
        'the checked-in agy listing still reproduces the curated table',
      );
    });

    it('a failed agy listing keeps the curated antigravity table, marked stale', async () => {
      // The default `agy: 'fail'`.
      const harness = buildDiscovery();
      const dir = newDir();
      writeConfigFile(dir, defaultConfigJson());
      const { webview } = buildPanel(harness, dir);
      await webview.send({ type: 'ready' });

      await harness.discovery.refresh();

      const changes = webview.optionsChanged();
      const antigravity = changes[changes.length - 1].options.byAgent.antigravity;
      assert.deepStrictEqual(antigravity.models, builtinAgentCapabilities().antigravity.models);
      assert.strictEqual(antigravity.source, 'builtin');
      assert.strictEqual(antigravity.stale, true);
      assert.ok((antigravity.staleReason ?? '').length > 0);
      // The empty-snapshot overlay branch keeps the builtin's OWN modelEntries,
      // so the curated per-family efforts are still rendered.
      assert.ok((antigravity.modelEntries ?? []).length > 0);
      assert.ok(
        (antigravity.modelEntries ?? []).some((entry) => (entry.efforts ?? []).length > 0),
        'the curated families keep their levels behind the stale note',
      );
    });
  });

  // --- Leg 3: provider filtering, hidden providers and key-driven reveal -----

  describe('model selector refresh: provider filtering', () => {
    /** A refreshed harness plus a router over it, the way commands.ts builds one. */
    async function refreshedRouter(
      keys: Record<string, string> = {},
      opts: { lm?: readonly string[]; settings?: Partial<ProviderSettings> } = {},
    ): Promise<{
      harness: Harness;
      router: ProviderRouter;
      secrets: FakeSecrets;
      workspaceState: FakeWorkspaceState;
    }> {
      const harness = buildDiscovery();
      await harness.discovery.refresh();
      const secrets = fakeSecrets(keys);
      const workspaceState = fakeWorkspaceState();
      const router = buildRouter({
        harness,
        secrets,
        workspaceState,
        settings: fakeSettings(opts.settings),
        lm: fakeLm(opts.lm ?? []),
      });
      await router.init();
      await router.refresh();
      return { harness, router, secrets, workspaceState };
    }

    it('availability lists only configured providers', async () => {
      const { harness, router } = await refreshedRouter({
        [providerSecretKey('anthropic')!]: 'sk-anthropic',
      });

      const av = await router.availability();
      assert.deepStrictEqual(
        av.map((e) => e.id),
        ['anthropic'],
      );
      for (const entry of av) {
        assert.strictEqual(entry.enabled, true);
        assert.strictEqual(hasOwnKey(entry, 'reason'), false);
      }
      assert.ok(
        av[0].models.includes('claude-opus-5-5'),
        'the model list comes from the refreshed snapshot, not a hard-coded one',
      );
      assert.strictEqual(av[0].fetchedAt, harness.store.get('models.dev')!.fetchedAt);
    });

    it('unconfigured providers are hidden, each with its reason', async () => {
      const { harness, router, secrets } = await refreshedRouter({
        [providerSecretKey('anthropic')!]: 'sk-anthropic',
      });
      const catalog = providerCatalog(harness.discovery.feed());

      const hidden = await router.hiddenProviders();
      const hiddenIds = hidden.map((e) => e.id);
      for (const id of [
        'copilot',
        'google',
        'mistral',
        'opencode',
        'openai',
        'deepseek',
        'deepinfra',
        'cerebras',
        'baseten',
      ]) {
        assert.ok(hiddenIds.includes(id), `${id} is hidden`);
      }
      const availableIds = (await router.availability()).map((e) => e.id);
      for (const id of hiddenIds) {
        assert.strictEqual(availableIds.includes(id), false, `${id} is not also available`);
      }

      const reasonOf = (id: string): string | undefined => hidden.find((e) => e.id === id)?.reason;
      assert.strictEqual(reasonOf('copilot'), COPILOT_UNAVAILABLE_REASON);
      for (const id of ['google', 'mistral', 'opencode', 'deepseek', 'openai']) {
        assert.strictEqual(reasonOf(id), providerNeedsKeyReason(id, catalog), `${id} reason`);
      }

      // `openai` needs BOTH a key and an endpoint; with the key stored the
      // reason becomes the endpoint one.
      secrets.set(providerSecretKey('openai')!, 'sk-openai');
      const afterKey = await router.hiddenProviders();
      assert.strictEqual(
        afterKey.find((e) => e.id === 'openai')?.reason,
        PROVIDER_NEEDS_ENDPOINT_REASON,
      );
    });

    it('legacy secret slots still enable their providers', async () => {
      const { router, secrets } = await refreshedRouter();
      for (const id of ['google', 'mistral', 'opencode']) {
        secrets.set(`baiton.orchestrator.key.${id}`, `sk-${id}`);
      }
      await router.refresh();

      const av = await router.availability();
      const ids = av.map((e) => e.id);
      for (const id of ['google', 'mistral', 'opencode']) {
        assert.ok(ids.includes(id), `the legacy ${id} slot still enables it`);
      }
      // The list is feed-derived; the base-URL override is irrelevant here.
      assert.ok(av.find((e) => e.id === 'google')!.models.includes('gemini-2.5-pro'));
      assert.ok(av.find((e) => e.id === 'mistral')!.models.includes('mistral-large-latest'));
    });

    it('a hidden feed provider becomes usable once its key is stored', async () => {
      const { harness, router, secrets } = await refreshedRouter({
        [providerSecretKey('anthropic')!]: 'sk-anthropic',
      });

      // The quick pick's candidate set includes the hidden provider. The quick
      // pick UI itself is covered by test/setApiKey.test.ts, which needs the
      // vscode loader this suite deliberately avoids.
      assert.ok(
        providerCatalog(harness.discovery.feed()).some(
          (p) => p.id === 'deepseek' && p.requiresKey,
        ),
      );

      secrets.set(providerSecretKey('deepseek')!, 'sk-test');
      await router.refresh();

      const entry = (await router.availability()).find((e) => e.id === 'deepseek');
      assert.ok(entry !== undefined, 'deepseek is now available');
      assert.deepStrictEqual([...entry.models], ['deepseek-chat', 'deepseek-reasoner']);
      assert.strictEqual(
        (await router.hiddenProviders()).some((e) => e.id === 'deepseek'),
        false,
      );
    });

    it('an offline window falls back to the six builtin providers', async () => {
      const secrets = fakeSecrets({ [providerSecretKey('google')!]: 'sk-google' });
      const router = buildRouter({ secrets, workspaceState: fakeWorkspaceState() });
      await router.init();
      await router.refresh();

      const av = await router.availability();
      assert.deepStrictEqual(
        av.map((e) => e.id),
        ['google'],
      );
      assert.deepStrictEqual(
        [...av[0].models],
        ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
      );
      assert.deepStrictEqual(
        (await router.hiddenProviders()).map((e) => e.id),
        ['copilot', 'opencode-go', 'opencode', 'mistral', 'openai'],
      );
    });
  });

  // --- Leg 4: provider-first selection in the Chat view ----------------------

  describe('model selector refresh: provider-first selection', () => {
    /** The chat view's recording webview. */
    class FakeChatWebview implements ChatWebview {
      public posts: HostToWebview[] = [];
      private handler?: (msg: WebviewToHost) => void;

      public post(m: HostToWebview): void {
        this.posts.push(m);
      }

      public onMessage(handler: (msg: WebviewToHost) => void): void {
        this.handler = handler;
      }

      public async send(msg: WebviewToHost): Promise<void> {
        await this.handler?.(msg);
      }

      public setProviders(): Array<Extract<HostToWebview, { type: 'setProviders' }>> {
        return this.posts.filter(
          (m): m is Extract<HostToWebview, { type: 'setProviders' }> => m.type === 'setProviders',
        );
      }
    }

    /**
     * Half A: a real ChatController over the real router, driven to the point
     * where the stale group exists — one configured snapshot-backed provider
     * gone stale beside a fresh, live-enumerated Copilot group.
     */
    async function hostPost(): Promise<{
      posted: Extract<HostToWebview, { type: 'setProviders' }>;
      router: ProviderRouter;
      harness: Harness;
    }> {
      const harness = buildDiscovery();
      await harness.discovery.refresh();

      const secrets = fakeSecrets({
        [providerSecretKey('anthropic')!]: 'sk-anthropic',
        [providerSecretKey('google')!]: 'sk-google',
      });
      const workspaceState = fakeWorkspaceState({
        // A preserved model the refreshed list does not carry.
        [MODEL_SELECTION_KEY]: { provider: 'anthropic', model: 'claude-opus-9-gone' },
      });
      const router = buildRouter({
        harness,
        secrets,
        workspaceState,
        lm: fakeLm(['gpt-5-copilot']),
      });
      await router.init();

      const webview = new FakeChatWebview();
      const dir = newDir();
      const controller = new ChatController({
        webview,
        client: {
          complete: async () => {
            throw new Error('the model client is never called in this suite');
          },
        } as unknown as ModelClient,
        registry: { call: async () => ({ ok: true, data: '' }) } as unknown as ToolRegistry,
        toolsFor: () => [],
        guardContext: () => ({}) as GuardContext,
        baitonDir: path.join(dir, '.baiton'),
        specsDir: path.join(dir, '.baiton', 'specs'),
        roundBound: () => 4,
        config: { getEndpoint: () => undefined, getModel: () => undefined },
        triggerFix: () => undefined,
        log: () => undefined,
        providers: router,
      });
      controllers.push(controller);
      controller.start();
      await waitFor(() => webview.setProviders().length > 0, 'the first setProviders');

      // Now fail the feed so the models.dev snapshot goes stale, and let the
      // router's change event drive a fresh post.
      const before = webview.setProviders().length;
      harness.mode.feed = 'fail';
      harness.mode.claudeFeed = 'fail';
      await harness.discovery.refresh();
      await router.refresh();
      await waitFor(() => webview.setProviders().length > before, 'the stale setProviders');

      const all = webview.setProviders();
      return { posted: all[all.length - 1], router, harness };
    }

    it('half A: the host posts only configured providers, the stale mark and the preserved model', async () => {
      const { posted, router, harness } = await hostPost();
      const configured = (await router.availability()).map((e) => e.id);

      assert.deepStrictEqual(
        posted.groups.map((g) => g.id),
        configured,
        'exactly the configured providers, in host order',
      );
      for (const group of posted.groups) {
        assert.strictEqual(group.enabled, true);
      }
      const anthropic = posted.groups.find((g) => g.id === 'anthropic')!;
      assert.strictEqual(anthropic.stale, true);
      assert.ok((anthropic.staleReason ?? '').length > 0);
      const copilot = posted.groups.find((g) => g.id === 'copilot')!;
      assert.strictEqual(copilot.stale, undefined, 'a live-enumerated group is never stale');
      assert.strictEqual(posted.refreshedAt, harness.store.get('models.dev')!.fetchedAt);
      assert.ok(
        anthropic.models.some((m) => m.id === 'claude-opus-9-gone' && m.custom === true),
        'the preserved selection rides along as a custom item',
      );
    });

    // --- Half B: that very message through media/chat.js ---------------------
    //
    // The loader below is duplicated from test/chatView.providers.test.ts rather
    // than extracted: T15's file list is this test plus README.md, and the T09
    // suite set the same precedent for self-contained view harnesses. Each copy
    // is trimmed to the surface this leg actually exercises. The fake DOM
    // (`FakeEl`/`FakeClassList`) lives in the shared harness region above,
    // because leg 6 drives media/config.js over the same elements.

    /** The ids chat.html defines; chat.js looks each of them up at load. */
    const ELEMENT_IDS: Array<[string, string]> = [
      ['conversation-select', 'select'],
      ['error-banner', 'div'],
      ['error-message', 'span'],
      ['error-fix', 'button'],
      ['transcript', 'div'],
      ['empty-state', 'div'],
      ['empty-provider', 'dd'],
      ['empty-model', 'dd'],
      ['empty-set-key', 'button'],
      ['input', 'textarea'],
      ['send', 'button'],
      ['stop', 'button'],
      ['auto-mode', 'button'],
      ['mode-select', 'select'],
      ['new-chat', 'button'],
      ['session-list', 'div'],
      ['provider-select', 'select'],
      ['model-select', 'select'],
      ['model-stale', 'span'],
      ['model-set-key', 'button'],
    ];

    interface ChatView {
      ids: Record<string, FakeEl>;
      posted: unknown[];
      send(msg: HostToWebview): void;
    }

    /** Execute media/chat.js inside a fresh sandbox over the hand-rolled DOM. */
    function loadChatView(): ChatView {
      const ids: Record<string, FakeEl> = {};
      for (const [id, tag] of ELEMENT_IDS) {
        ids[id] = new FakeEl(tag);
      }

      const posted: unknown[] = [];
      let persistedState: unknown = {};
      let messageListener: ((event: { data: unknown }) => void) | null = null;

      const sandbox: {
        window: Record<string, unknown>;
        document: Record<string, unknown>;
        acquireVsCodeApi: () => unknown;
      } = {
        window: {
          addEventListener: (type: string, fn: (event: unknown) => void) => {
            if (type === 'message') {
              messageListener = fn as (event: { data: unknown }) => void;
            }
          },
          baitonSanitizeHtml: (s: string) => s,
        },
        document: {
          createElement: (tag: string) => new FakeEl(tag),
          getElementById: (id: string) => ids[id] ?? null,
          activeElement: null,
        },
        acquireVsCodeApi: () => ({
          postMessage: (message: unknown) => {
            posted.push(message);
          },
          getState: () => persistedState,
          setState: (next: unknown) => {
            persistedState = next;
          },
        }),
      };

      const mediaPath = path.join(__dirname, '..', 'media');
      vm.runInNewContext(fs.readFileSync(path.join(mediaPath, 'protocol.js'), 'utf8'), sandbox, {
        filename: 'media/protocol.js',
      });
      vm.runInNewContext(fs.readFileSync(path.join(mediaPath, 'chat.js'), 'utf8'), sandbox, {
        filename: 'media/chat.js',
      });

      return {
        ids,
        posted,
        send: (msg: HostToWebview) => {
          assert.ok(messageListener, 'chat.js did not register a message listener');
          messageListener({ data: msg });
        },
      };
    }

    /** Messages posted match host-realm literals, so clone out of the vm realm first. */
    function plainClone(value: unknown): unknown {
      return JSON.parse(JSON.stringify(value));
    }

    /** The index of the provider option carrying this id. */
    function providerIndex(select: FakeEl, id: string): number {
      const index = select.options.findIndex((o) => o.dataset.provider === id);
      assert.ok(index >= 0, `provider option ${id} exists`);
      return index;
    }

    /** The `provider/model` option values of a group, as chat.js renders them. */
    function groupValues(group: ProviderGroup): string[] {
      return group.models.map((m) => `${group.id}/${m.id}`);
    }

    it('half B: only configured providers reach the provider select', async () => {
      const { posted, router } = await hostPost();
      const view = loadChatView();
      view.send(posted);

      const providers = view.ids['provider-select'];
      assert.deepStrictEqual(
        providers.options.map((o) => o.value),
        posted.groups.map((g) => g.id),
      );
      const hidden = (await router.hiddenProviders()).map((e) => e.id);
      const rendered = [
        ...providers.options.map((o) => o.value),
        ...view.ids['model-select'].options.map((o) => o.value),
      ].join(' ');
      for (const id of hidden) {
        assert.strictEqual(
          rendered.includes(`${id}/`) || providers.options.some((o) => o.value === id),
          false,
          `the hidden provider ${id} appears in neither select`,
        );
      }
    });

    it('half B: the model select shows only the chosen provider models', async () => {
      const { posted } = await hostPost();

      // With the host's own selection the chosen provider is the selected one.
      const view = loadChatView();
      view.send(posted);
      const selectedGroup = posted.groups.find((g) => g.id === posted.selection?.provider)!;
      assert.deepStrictEqual(
        view.ids['model-select'].options.filter((o) => !o.disabled).map((o) => o.value),
        groupValues(selectedGroup),
      );

      // With nothing selected the first group paints, and switching provider
      // repaints without posting.
      const fresh = loadChatView();
      fresh.send({ ...posted, selection: null });
      const providers = fresh.ids['provider-select'];
      const models = fresh.ids['model-select'];
      assert.deepStrictEqual(
        models.options.filter((o) => !o.disabled).map((o) => o.value),
        groupValues(posted.groups[0]),
      );

      providers.selectedIndex = providerIndex(providers, posted.groups[1].id);
      providers.fire('change', {});
      assert.deepStrictEqual(
        models.options.filter((o) => !o.disabled).map((o) => o.value),
        groupValues(posted.groups[1]),
      );
      assert.strictEqual(fresh.posted.length, 0, 'picking a provider posts nothing');
    });

    it('half B: the stale badge follows the chosen provider', async () => {
      const { posted } = await hostPost();
      const stale = posted.groups.find((g) => g.stale === true)!;
      const fresh = posted.groups.find((g) => g.stale !== true)!;

      const view = loadChatView();
      view.send({ ...posted, selection: null });
      const providers = view.ids['provider-select'];
      const badge = view.ids['model-stale'];

      providers.selectedIndex = providerIndex(providers, stale.id);
      providers.fire('change', {});
      assert.strictEqual(badge.classList.contains('visible'), true);
      assert.ok(badge.textContent.includes('stale'));
      assert.strictEqual(badge.title, stale.staleReason);

      providers.selectedIndex = providerIndex(providers, fresh.id);
      providers.fire('change', {});
      assert.strictEqual(badge.textContent, '');
      assert.strictEqual(badge.classList.contains('visible'), false);
      assert.strictEqual(badge.getAttribute('title'), null);
    });

    it('half B: a custom (preserved) model stays selectable and postable', async () => {
      const { posted, router } = await hostPost();
      const anthropic = posted.groups.find((g) => g.id === 'anthropic')!;

      // Painted with no active selection so picking the custom model is a real
      // change rather than a re-pick of the pair already selected.
      const view = loadChatView();
      view.send({ ...posted, selection: null });
      const providers = view.ids['provider-select'];
      const models = view.ids['model-select'];
      providers.selectedIndex = providerIndex(providers, anthropic.id);
      providers.fire('change', {});

      const custom = models.options.find((o) => o.dataset.model === 'claude-opus-9-gone');
      assert.ok(custom, 'the preserved model renders');
      assert.ok(custom.textContent.endsWith('(custom)'));
      assert.strictEqual(custom.disabled, false);

      models.selectedIndex = models.options.indexOf(custom);
      models.fire('change', {});
      assert.deepStrictEqual(view.posted.map(plainClone), [
        { type: 'selectModel', provider: 'anthropic', model: 'claude-opus-9-gone' },
      ]);

      // Back to the host: the router accepts the very payload the view posted.
      const payload = plainClone(view.posted[0]) as { provider: string; model: string };
      assert.strictEqual(
        await router.select({ provider: payload.provider, model: payload.model }),
        true,
      );
      assert.deepStrictEqual(router.getSelection(), {
        provider: 'anthropic',
        model: 'claude-opus-9-gone',
      });
    });

    it('half B: the Set API key affordance appears when nothing is usable', async () => {
      const { posted } = await hostPost();
      const view = loadChatView();
      const setKey = view.ids['model-set-key'];

      view.send(posted);
      assert.strictEqual(setKey.classList.contains('visible'), false, 'every group is usable');

      // NOTE: `groups: []` is the view's "nothing known yet" state and shows no
      // affordance; the case the acceptance names — no provider offering a
      // model — is the configured-but-modelless shape below.
      view.send({ ...posted, groups: posted.groups.map((g) => ({ ...g, models: [] })) });
      assert.strictEqual(setKey.classList.contains('visible'), true);
      assert.ok(setKey.title.length > 0);

      setKey.fire('click', {});
      assert.deepStrictEqual(view.posted.map(plainClone), [
        { type: 'triggerFix', action: 'setApiKey' },
      ]);
    });
  });

  // --- Leg 5: config and selection round-trip --------------------------------

  describe('model selector refresh: round-trip', () => {
    it('a configured model a refresh does not list stays listed and saveable', async () => {
      const harness = buildDiscovery();
      const dir = newDir();
      writeRoles(dir, {
        planner: { agent: 'claude', model: 'claude-opus-4-legacy', effort: 'high' },
        executor: { agent: 'codex', model: 'gpt-5-codex', effort: 'xhigh' },
      });
      const { webview } = buildPanel(harness, dir);
      await webview.send({ type: 'ready' });
      const loaded = webview.loaded()[0];

      await harness.discovery.refresh();

      const changes = webview.optionsChanged();
      const byAgent = changes[changes.length - 1].options.byAgent;
      assert.ok(
        byAgent.claude.models.includes('claude-opus-4-legacy'),
        'the configured-but-unlisted model is appended',
      );
      assert.ok(byAgent.claude.models.includes('claude-opus-5-5'), 'beside the refreshed ids');
      assert.ok(byAgent.codex.efforts.includes('xhigh'));

      await webview.send({ type: 'save', form: loaded.form, token: loaded.token });
      const saved = webview.messages.filter((m) => m.type === 'saved');
      assert.strictEqual(saved.length, 1, 'exactly one saved');
      assert.strictEqual(
        webview.messages.some((m) => m.type === 'saveFailed'),
        false,
      );

      const reloaded = await loadConfig(dir);
      assert.ok(isOk(reloaded));
      assert.strictEqual(reloaded.value.roles.planner.model, 'claude-opus-4-legacy');
      assert.strictEqual(reloaded.value.roles.executor.effort, 'xhigh');
    });

    it('an agent id no longer installed still round-trips', async () => {
      const harness = buildDiscovery();
      const dir = newDir();
      writeRoles(dir, {
        reviewer: { agent: 'agy-legacy', model: 'gemini-legacy', effort: 'high' },
      });
      const { webview } = buildPanel(harness, dir);
      await webview.send({ type: 'ready' });
      const loaded = webview.loaded()[0];

      await harness.discovery.refresh();

      const changes = webview.optionsChanged();
      assert.ok(
        changes[changes.length - 1].options.agents.includes('agy-legacy'),
        'the uninstalled agent id stays offered',
      );

      await webview.send({ type: 'save', form: loaded.form, token: loaded.token });
      const last = webview.messages[webview.messages.length - 1];
      assert.strictEqual(last.type, 'saved', 'the panel validates the unmodified save');

      const reloaded = await loadConfig(dir);
      assert.ok(isOk(reloaded));
      assert.strictEqual(reloaded.value.roles.reviewer.agent, 'agy-legacy');
    });

    it('a persisted ModelSelection whose provider left the feed survives a refresh', async () => {
      const harness = buildDiscovery();
      await harness.discovery.refresh();
      const stored: ModelSelection = { provider: 'anthropic', model: 'claude-opus-9-gone' };
      const workspaceState = fakeWorkspaceState({ [MODEL_SELECTION_KEY]: { ...stored } });
      const secrets = fakeSecrets({ [providerSecretKey('anthropic')!]: 'sk-anthropic' });
      const router = buildRouter({ harness, secrets, workspaceState });

      await router.init();

      assert.deepStrictEqual(router.getSelection(), stored, 'the model is not validated away');
      assert.strictEqual(
        workspaceState.updates.some((u) => u.key === MODEL_SELECTION_KEY),
        false,
        'a protected selection is never rewritten',
      );
      const entry = (await router.availability()).find((e) => e.id === 'anthropic')!;
      assert.deepStrictEqual([...(entry.customModels ?? [])], ['claude-opus-9-gone']);
      assert.ok(entry.models.includes('claude-opus-9-gone'));

      await harness.discovery.refresh();
      await router.refresh();
      assert.deepStrictEqual(router.getSelection(), stored);
    });

    it('a persisted selection whose provider is unconfigured comes back when its key returns', async () => {
      const harness = buildDiscovery();
      await harness.discovery.refresh();
      const stored: ModelSelection = { provider: 'deepseek', model: 'deepseek-chat' };
      const workspaceState = fakeWorkspaceState({ [MODEL_SELECTION_KEY]: { ...stored } });
      const secrets = fakeSecrets({ [providerSecretKey('anthropic')!]: 'sk-anthropic' });
      const router = buildRouter({ harness, secrets, workspaceState });

      await router.init();

      assert.strictEqual(router.getSelection()?.provider, 'anthropic', 'routed to the fallback');
      assert.strictEqual(
        workspaceState.updates.some((u) => u.key === MODEL_SELECTION_KEY),
        false,
        'the fallback is never persisted over a real choice',
      );

      secrets.set(providerSecretKey('deepseek')!, 'k');
      await router.refresh();
      assert.deepStrictEqual(router.getSelection(), stored);
    });

    it('a configured value the refreshed lists lack rides along as a custom entry and still saves', async () => {
      const harness = buildDiscovery({
        mode: { claudeCatalog: 'ok', codex: 'data', opencodeCli: 'ok', agy: 'ok' },
      });
      const dir = newDir();
      writeRoles(dir, {
        // `claude-opus-5` is a real legacy id both the corrected curated table
        // and the local catalog drop; `ultra` is outside the opencode variant
        // union the verbose listing discloses.
        planner: { agent: 'claude', model: 'claude-opus-5', effort: 'medium' },
        executor: { agent: 'opencode', model: 'openrouter/legacy-model', effort: 'ultra' },
      });
      const { webview } = buildPanel(harness, dir);
      await webview.send({ type: 'ready' });
      const loaded = webview.loaded()[0];

      await harness.discovery.refresh();

      const byAgent = webview.optionsChanged().slice(-1)[0].options.byAgent;

      // claude: listed for validation, but rendered through `Other…` only.
      assert.ok(byAgent.claude.models.includes('claude-opus-5'));
      const claudeEntries = byAgent.claude.modelEntries!;
      assert.deepStrictEqual(claudeEntries[claudeEntries.length - 1], {
        id: 'claude-opus-5',
        custom: true,
      });
      for (const entry of claudeEntries.slice(0, -1)) {
        assert.strictEqual(hasOwnKey(entry, 'custom'), false, `${entry.id} is a discovered entry`);
      }

      // opencode: the model AND the effort ride along, appended last.
      assert.strictEqual(byAgent.opencode.models.slice(-1)[0], 'openrouter/legacy-model');
      const opencodeEntries = byAgent.opencode.modelEntries!;
      assert.deepStrictEqual(opencodeEntries[opencodeEntries.length - 1], {
        id: 'openrouter/legacy-model',
        custom: true,
      });
      assert.deepStrictEqual(byAgent.opencode.efforts, [
        'low',
        'high',
        'max',
        'none',
        'thinking',
        'minimal',
        'ultra',
      ]);

      // Appended ONCE only: a second refresh must not duplicate them.
      await harness.discovery.refresh();
      const after = webview.optionsChanged().slice(-1)[0].options.byAgent;
      assert.strictEqual(after.claude.models.filter((m) => m === 'claude-opus-5').length, 1);
      assert.strictEqual(
        after.opencode.models.filter((m) => m === 'openrouter/legacy-model').length,
        1,
      );
      assert.strictEqual(after.opencode.efforts.filter((e) => e === 'ultra').length, 1);

      await webview.send({ type: 'save', form: loaded.form, token: loaded.token });
      assert.strictEqual(webview.messages.filter((m) => m.type === 'saved').length, 1);
      assert.strictEqual(
        webview.messages.some((m) => m.type === 'saveFailed'),
        false,
      );

      const reloaded = await loadConfig(dir);
      assert.ok(isOk(reloaded));
      assert.strictEqual(reloaded.value.roles.planner.model, 'claude-opus-5');
      assert.strictEqual(reloaded.value.roles.executor.model, 'openrouter/legacy-model');
      assert.strictEqual(reloaded.value.roles.executor.effort, 'ultra');
    });
  });

  // --- Leg 6: the panel's own messages replayed through media/config.js ------
  //
  // The host-side payloads asserted above are the *input* to the webview. This
  // leg closes the loop the way leg 4 closes it for media/chat.js: it feeds the
  // real `ConfigPanelController`'s OWN `loaded`/`optionsChanged` messages into
  // media/config.js and asserts what the user actually sees.

  describe('model selector refresh: the config view renders the refreshed lists', () => {
    /** The `Other…` option value, copied verbatim from media/config.js. */
    const OTHER_SENTINEL = '\u0000other';

    interface ConfigView {
      ids: Record<string, FakeEl>;
      posted: unknown[];
      send(msg: ConfigPanelHostToWebview): void;
      setActive(el: FakeEl | null): void;
      byId(id: string): FakeEl;
    }

    /**
     * Execute media/config.js inside a fresh sandbox over the hand-rolled DOM.
     *
     * A trimmed copy of `loadConfigView()` in test/configPanel.view.test.ts, for
     * the same reason leg 4's chat loader is a trimmed copy of
     * test/chatView.providers.test.ts: this todo's file list is this test plus
     * README.md, and each copy covers only the surface its own leg exercises.
     */
    function loadConfigView(): ConfigView {
      const ids: Record<string, FakeEl> = {};
      const make = (id: string, tag: string, dataPath?: string): FakeEl => {
        const el = new FakeEl(tag);
        el.id = id;
        if (dataPath !== undefined) {
          el.dataset.path = dataPath;
        }
        ids[id] = el;
        return el;
      };

      // The ids media/config.html defines.
      const formEl = make('config-form', 'form');
      const rolesBody = make('roles-body', 'div');
      make('save', 'button');
      make('reload', 'button');
      make('reset', 'button');
      make('banner', 'div');
      make('banner-message', 'span');
      make('banner-primary', 'button');
      make('banner-secondary', 'button');
      make('status', 'div');
      make('error-view', 'div');
      make('error-message', 'p');
      make('error-reset', 'button');
      make('error-reload', 'button');
      const controls = [
        make('limit-plan_review_rounds', 'input', 'limits.plan_review_rounds'),
        make('limit-exec_attempts', 'input', 'limits.exec_attempts'),
        make('limit-stall_notice_minutes', 'input', 'limits.stall_notice_minutes'),
        make('git-remote', 'input', 'git.remote'),
        make('git-base', 'input', 'git.base'),
      ];

      // Mirror the markup's containment so `formEl.querySelectorAll` reaches
      // everything the renderer touches.
      const rolesFieldset = new FakeEl('fieldset');
      rolesFieldset.appendChild(rolesBody);
      formEl.appendChild(rolesFieldset);
      for (const control of controls) {
        const row = new FakeEl('div');
        row.className = 'field-row';
        row.appendChild(control);
        const errorSlot = new FakeEl('div');
        errorSlot.className = 'field-error';
        errorSlot.dataset.errorFor = control.dataset.path;
        row.appendChild(errorSlot);
        formEl.appendChild(row);
      }

      const posted: unknown[] = [];
      let persistedState: unknown = {};
      let messageListener: ((event: { data: unknown }) => void) | null = null;

      const documentStub = {
        createElement: (tag: string) => new FakeEl(tag),
        // The role controls are created BY the renderer, so the pre-made id map
        // is only the first half of the lookup: without the descendant search
        // every `role-*` lookup would be null and the cases would pass vacuously.
        getElementById: (id: string): FakeEl | null => {
          if (ids[id]) {
            return ids[id];
          }
          for (const el of formEl.descendants()) {
            if (el.id === id) {
              return el;
            }
          }
          return null;
        },
        activeElement: null as FakeEl | null,
      };

      const sandbox = {
        window: {
          addEventListener: (type: string, fn: (event: unknown) => void) => {
            if (type === 'message') {
              messageListener = fn as (event: { data: unknown }) => void;
            }
          },
        } as Record<string, unknown>,
        document: documentStub,
        acquireVsCodeApi: () => ({
          postMessage: (message: unknown) => {
            posted.push(message);
          },
          getState: () => persistedState,
          setState: (next: unknown) => {
            persistedState = next;
          },
        }),
      };

      vm.runInNewContext(
        fs.readFileSync(path.join(__dirname, '..', 'media', 'config.js'), 'utf8'),
        sandbox,
        { filename: 'media/config.js' },
      );

      return {
        ids,
        posted,
        send: (msg) => {
          assert.ok(messageListener, 'media/config.js did not register a message listener');
          messageListener({ data: msg });
        },
        setActive: (el) => {
          documentStub.activeElement = el;
        },
        byId: (id) => {
          const el = documentStub.getElementById(id);
          assert.ok(el, `element #${id} should exist`);
          return el;
        },
      };
    }

    /** Value/text pairs of the dynamic (non-static) options of a select, in order. */
    function dynamicOptions(select: FakeEl): { value: string; text: string }[] {
      return select.children
        .filter((c) => c.tagName === 'OPTION' && c.dataset.static === undefined)
        .map((c) => ({ value: c.value, text: c.textContent }));
    }

    /** The static `(default)` or `Other…` option of a select. */
    function staticOption(select: FakeEl, kind: 'default' | 'other'): FakeEl {
      const found = select.children.find(
        (c) => c.tagName === 'OPTION' && c.dataset.static === kind,
      );
      assert.ok(found, `select #${select.id} should carry a static "${kind}" option`);
      return found;
    }

    /** Host-realm objects must not cross into the vm realm (leg 4's precedent). */
    function replay(view: ConfigView, msg: ConfigPanelHostToWebview): void {
      view.send(JSON.parse(JSON.stringify(msg)) as ConfigPanelHostToWebview);
    }

    /** A refreshed harness with an OPEN panel over `roles`, plus its webview. */
    async function refreshedPanel(
      roles: Record<string, { agent: string; model: string; effort: string }>,
      mode: Partial<HarnessMode> = { claudeCatalog: 'ok', codex: 'data', opencodeCli: 'ok', agy: 'ok' },
    ): Promise<{ harness: Harness; webview: RecordingConfigWebview }> {
      const harness = buildDiscovery({ mode });
      const dir = newDir();
      writeRoles(dir, roles);
      const { webview } = buildPanel(harness, dir);
      await webview.send({ type: 'ready' });
      await harness.discovery.refresh();
      return { harness, webview };
    }

    /** Replay the controller's `loaded` and then its LAST `optionsChanged`. */
    function viewOf(webview: RecordingConfigWebview): ConfigView {
      const view = loadConfigView();
      replay(view, webview.loaded()[0]);
      const changes = webview.optionsChanged();
      replay(view, changes[changes.length - 1]);
      return view;
    }

    it('a custom value renders as an editable Other… entry after the refresh', async () => {
      const { webview } = await refreshedPanel({
        planner: { agent: 'claude', model: 'claude-opus-5', effort: 'medium' },
      });
      const view = viewOf(webview);

      const select = view.byId('role-planner-model-select');
      const input = view.byId('role-planner-model-input');
      assert.strictEqual(select.value, OTHER_SENTINEL, 'the select shows Other…');
      assert.notStrictEqual(input.style.display, 'none', 'the text input is visible');
      assert.strictEqual(input.value, 'claude-opus-5', 'and keeps the configured value');
      assert.strictEqual(input.disabled, false, 'and stays editable');

      const values = dynamicOptions(select).map((o) => o.value);
      assert.strictEqual(
        values.includes('claude-opus-5'),
        false,
        'a custom: true entry is NEVER an ordinary option',
      );
      const listed = dynamicOptions(select).find((o) => o.value === 'claude-opus-5-5');
      assert.ok(listed, 'the discovered ids are ordinary options');
      assert.strictEqual(listed.text, 'Opus 5.5', 'rendered with the catalog label');
    });

    it('the opencode model and effort controls become dropdowns once a list arrives', async () => {
      const { webview } = await refreshedPanel({
        executor: { agent: 'opencode', model: 'anthropic/claude-sonnet-5', effort: 'high' },
      });

      // Before the refresh: the curated opencode lists are both empty, so both
      // controls are free text.
      const view = loadConfigView();
      replay(view, webview.loaded()[0]);
      assert.strictEqual(view.byId('role-executor-model-select').style.display, 'none');
      assert.notStrictEqual(view.byId('role-executor-model-input').style.display, 'none');
      assert.strictEqual(view.byId('role-executor-effort-select').style.display, 'none');
      assert.notStrictEqual(view.byId('role-executor-effort-input').style.display, 'none');

      const changes = webview.optionsChanged();
      replay(view, changes[changes.length - 1]);

      const modelSelect = view.byId('role-executor-model-select');
      assert.notStrictEqual(modelSelect.style.display, 'none', 'the model control is a dropdown');
      assert.deepStrictEqual(
        dynamicOptions(modelSelect).map((o) => o.value),
        [
          'anthropic/claude-sonnet-5',
          'openai/gpt-6',
          'google/gemini-3-pro',
          'zed/weird-1',
          'local/llama-4',
          'broken/model-1',
          'last/no-detail',
        ],
      );
      assert.strictEqual(modelSelect.value, 'anthropic/claude-sonnet-5');

      const effortSelect = view.byId('role-executor-effort-select');
      assert.notStrictEqual(effortSelect.style.display, 'none', 'the effort control is a dropdown');
      assert.deepStrictEqual(
        dynamicOptions(effortSelect).map((o) => o.value),
        ['low', 'high', 'max'],
        "the SELECTED model's own variants, not the agent-level union",
      );
      const link = view.byId('role-executor-model-link');
      assert.ok(link.getAttribute('href'), 'the documentation link survives the refresh');
      assert.notStrictEqual(link.style.display, 'none');
    });

    it('per-model effort lists and the default label follow the selected model', async () => {
      const { webview } = await refreshedPanel({
        planner: { agent: 'claude', model: 'claude-opus-5-5', effort: '' },
        reviewer: { agent: 'antigravity', model: 'gemini-3.1-pro', effort: '' },
      });
      const view = viewOf(webview);
      const form = view.ids['config-form'];

      const plannerEffort = view.byId('role-planner-effort-select');
      assert.deepStrictEqual(
        dynamicOptions(plannerEffort).map((o) => o.value),
        ['low', 'medium', 'high', 'xhigh', 'max'],
      );
      assert.strictEqual(staticOption(plannerEffort, 'default').textContent, '(default: medium)');

      // A `thinking: none` model discloses an EMPTY list, which leaves only the
      // static options.
      const plannerModel = view.byId('role-planner-model-select');
      plannerModel.value = 'claude-haiku-4-5-20251001';
      form.fire('change', { target: plannerModel });
      assert.deepStrictEqual(dynamicOptions(view.byId('role-planner-effort-select')), []);
      assert.strictEqual(
        staticOption(view.byId('role-planner-effort-select'), 'default').textContent,
        '(default)',
      );

      // An antigravity family discloses its own levels; a fixed id discloses none.
      const reviewerEffort = view.byId('role-reviewer-effort-select');
      assert.deepStrictEqual(
        dynamicOptions(reviewerEffort).map((o) => o.value),
        ['low', 'high'],
      );
      const reviewerModel = view.byId('role-reviewer-model-select');
      reviewerModel.value = 'claude-sonnet-4-6';
      form.fire('change', { target: reviewerModel });
      assert.deepStrictEqual(dynamicOptions(view.byId('role-reviewer-effort-select')), []);
    });

    it('a stale refresh keeps the options on screen and shows the note', async () => {
      const { harness, webview } = await refreshedPanel({
        planner: { agent: 'claude', model: 'claude-opus-5-5', effort: '' },
      });
      const good = dynamicOptions(viewOf(webview).byId('role-planner-model-select'));
      assert.ok(good.length > 0, 'the refresh put a list on screen');

      // Now break every source, exactly as the malformed-refresh case does.
      harness.mode.claudeCatalog = 'malformed';
      harness.mode.claudeFeed = 'fail';
      harness.mode.feed = 'fail';
      harness.mode.codex = 'malformed';
      harness.mode.opencodeCli = 'empty';
      harness.mode.opencode = 'fail';
      harness.mode.agy = 'fail';
      await harness.discovery.refresh();

      const view = viewOf(webview);
      assert.deepStrictEqual(
        dynamicOptions(view.byId('role-planner-model-select')),
        good,
        'the last known-good options are still on screen',
      );
      const note = view.byId('role-planner-stale');
      assert.strictEqual(note.classList.contains('visible'), true);
      assert.ok(
        note.textContent.startsWith('stale — showing last known models'),
        `the note reads: ${note.textContent}`,
      );
    });
  });

});
