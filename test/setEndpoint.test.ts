import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

/**
 * Unit tests for the `Baiton: Set Provider Endpoint` command handler
 * (src/activation/setEndpoint.ts).
 *
 * Same harness as test/setApiKey.test.ts: `fixtures/vscodeLoader.mjs`
 * redirects the bare `vscode` import to `fixtures/vscodeFake.mjs`, which
 * delegates to the mutable fake installed on `globalThis.__vscodeFake`. Here
 * the fake also stands in for `workspace.getConfiguration('baiton')`, so the
 * `baiton.orchestrator.endpoints` map and every `update` to it are observable.
 *
 * Coverage: the pure helpers (URL validation, map normalisation, pick
 * candidates), the quick pick (candidates, set/not-set descriptions, dismiss,
 * nothing to offer), an explicit provider id, save / clear / no-op / invalid
 * input / write failure, the Global target, and the onChanged notification.
 */

import { buildProviderCatalog } from '../src/orchestrator/providers';
import type { ProviderInfo } from '../src/orchestrator/providers';
import { parseModelsDevFeed } from '../src/orchestrator/modelsDev';

interface MessageCall {
  readonly kind: 'info' | 'warning' | 'error';
  readonly message: string;
}

interface InputOptions {
  prompt?: string;
  value?: string;
  validateInput?: (value: string) => string | undefined;
}

interface QuickPickItem {
  label: string;
  description?: string;
  id?: string;
}

/** A fake `WorkspaceConfiguration` for the `baiton` section. */
class FakeConfiguration {
  /** Keyed like the handler reads it, e.g. `orchestrator.endpoints`. */
  readonly values = new Map<string, unknown>();
  readonly updates: Array<{ key: string; value: unknown; target: unknown }> = [];
  failUpdate = false;

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  async update(key: string, value: unknown, target: unknown): Promise<void> {
    this.updates.push({ key, value, target });
    if (this.failUpdate) {
      throw new Error('settings unavailable');
    }
    if (value === undefined) {
      this.values.delete(key);
    } else {
      this.values.set(key, value);
    }
  }
}

interface VscodeFake {
  inputResult: string | undefined;
  lastInputOptions: InputOptions | undefined;
  inputBoxCalls: number;
  quickPickResult: unknown;
  lastQuickPickItems: readonly QuickPickItem[] | undefined;
  quickPickCalls: number;
  readonly messages: MessageCall[];
  readonly configuration: FakeConfiguration;
  readonly sections: string[];
  readonly window: Record<string, (...args: never[]) => unknown>;
  readonly workspace: { getConfiguration: (section: string) => FakeConfiguration };
}

function makeVscodeFake(): VscodeFake {
  const configuration = new FakeConfiguration();
  const fake: VscodeFake = {
    inputResult: undefined,
    lastInputOptions: undefined,
    inputBoxCalls: 0,
    quickPickResult: undefined,
    lastQuickPickItems: undefined,
    quickPickCalls: 0,
    messages: [],
    configuration,
    sections: [],
    window: {
      showInputBox: (options: InputOptions) => {
        fake.inputBoxCalls += 1;
        fake.lastInputOptions = options;
        return Promise.resolve(fake.inputResult);
      },
      showQuickPick: (items: readonly QuickPickItem[]) => {
        fake.quickPickCalls += 1;
        fake.lastQuickPickItems = items;
        return Promise.resolve(fake.quickPickResult);
      },
      showInformationMessage: (message: string) => {
        fake.messages.push({ kind: 'info', message });
        return Promise.resolve(undefined);
      },
      showWarningMessage: (message: string) => {
        fake.messages.push({ kind: 'warning', message });
        return Promise.resolve(undefined);
      },
      showErrorMessage: (message: string) => {
        fake.messages.push({ kind: 'error', message });
        return Promise.resolve(undefined);
      },
    },
    workspace: {
      getConfiguration: (section: string) => {
        fake.sections.push(section);
        return configuration;
      },
    },
  };
  return fake;
}

let vscodeFake: VscodeFake = makeVscodeFake();

type SetEndpointModule = typeof import('../src/activation/setEndpoint');
let mod: SetEndpointModule;

/** The fixture feed's catalog: deepinfra and cerebras publish no URL. */
function fixtureCatalog(): readonly ProviderInfo[] {
  const text = fs.readFileSync(path.join(__dirname, 'fixtures', 'modelsDev.sample.json'), 'utf8');
  const result = parseModelsDevFeed(JSON.parse(text));
  assert.ok(result.ok, 'fixture feed must parse');
  return buildProviderCatalog(result.value);
}

const ENDPOINTS = 'orchestrator.endpoints';
/** `vscode.ConfigurationTarget.Global` in the fake. */
const GLOBAL = 1;

describe('setEndpoint pure helpers', () => {
  before(async () => {
    const root = process.cwd();
    register(pathToFileURL(join(root, 'test', 'fixtures', 'vscodeLoader.mjs')).href, pathToFileURL(join(root, '/')).href);
    await import('./fixtures/vscodeLoader.mjs');
    mod = (await import('../src/activation/setEndpoint')) as SetEndpointModule;
  });

  it('validateEndpointUrl accepts http(s) and blank, rejects everything else', () => {
    assert.strictEqual(mod.validateEndpointUrl('https://api.deepinfra.com/v1/openai'), undefined);
    assert.strictEqual(mod.validateEndpointUrl('  http://localhost:8080/v1  '), undefined);
    assert.strictEqual(mod.validateEndpointUrl(''), undefined, 'blank clears');
    assert.strictEqual(mod.validateEndpointUrl('   '), undefined);
    for (const bad of ['api.deepinfra.com', 'ftp://x.test', 'file:///etc/passwd', 'javascript:alert(1)', 'not a url']) {
      assert.strictEqual(mod.validateEndpointUrl(bad), mod.PROVIDER_ENDPOINT_INVALID_MESSAGE, bad);
    }
  });

  it('normalizeEndpoints keeps trimmed non-blank strings and drops the rest', () => {
    assert.deepStrictEqual(
      mod.normalizeEndpoints({ a: ' https://a.test ', b: '', c: 5, d: null, '  ': 'https://x.test' }),
      { a: 'https://a.test' },
    );
    for (const junk of [undefined, null, 'x', 42, ['https://a.test']]) {
      assert.deepStrictEqual(mod.normalizeEndpoints(junk), {});
    }
  });

  it('endpointCandidates: providers needing one, plus settable providers already set', () => {
    const catalog = fixtureCatalog();
    assert.deepStrictEqual(
      mod.endpointCandidates(catalog, {}).map((i) => i.id),
      ['deepinfra', 'cerebras'],
    );
    assert.deepStrictEqual(
      mod.endpointCandidates(catalog, { mistral: 'https://p.test', copilot: 'x', openai: 'y' }).map((i) => i.id),
      ['mistral', 'deepinfra', 'cerebras'],
      'copilot and openai are never offered, even when present in the map',
    );
  });
});

describe('setProviderEndpoint', () => {
  beforeEach(() => {
    vscodeFake = makeVscodeFake();
    (globalThis as unknown as { __vscodeFake: VscodeFake }).__vscodeFake = vscodeFake;
  });

  const options = { catalog: fixtureCatalog };

  it('offers the providers needing an endpoint with set/not-set descriptions', async () => {
    vscodeFake.configuration.values.set(ENDPOINTS, { cerebras: 'https://api.cerebras.ai/v1' });

    await mod.setProviderEndpoint(undefined, undefined, options);

    assert.deepStrictEqual(vscodeFake.sections, ['baiton']);
    assert.deepStrictEqual(
      vscodeFake.lastQuickPickItems!.map((i) => [i.id, i.label, i.description]),
      [
        ['deepinfra', 'Deep Infra', mod.PROVIDER_ENDPOINT_MISSING_DETAIL],
        ['cerebras', 'Cerebras', mod.PROVIDER_ENDPOINT_SET_DETAIL],
      ],
    );
  });

  it('a dismissed pick writes nothing and says nothing', async () => {
    await mod.setProviderEndpoint(undefined, undefined, options);
    assert.strictEqual(vscodeFake.quickPickCalls, 1);
    assert.strictEqual(vscodeFake.inputBoxCalls, 0);
    assert.strictEqual(vscodeFake.configuration.updates.length, 0);
    assert.deepStrictEqual(vscodeFake.messages, []);
  });

  it('with nothing to offer (offline builtins) it says so and shows no pick', async () => {
    await mod.setProviderEndpoint();
    assert.strictEqual(vscodeFake.quickPickCalls, 0);
    assert.deepStrictEqual(vscodeFake.messages, [{ kind: 'info', message: mod.PROVIDER_ENDPOINT_NONE_MESSAGE }]);
  });

  it('picking a provider saves the trimmed URL to the user settings, keeping other entries', async () => {
    vscodeFake.configuration.values.set(ENDPOINTS, { cerebras: 'https://api.cerebras.ai/v1' });
    vscodeFake.quickPickResult = { label: 'Deep Infra', id: 'deepinfra' };
    vscodeFake.inputResult = '  https://api.deepinfra.com/v1/openai  ';
    const changed: string[] = [];

    await mod.setProviderEndpoint(undefined, (id) => {
      changed.push(id);
    }, options);

    assert.deepStrictEqual(vscodeFake.configuration.updates, [
      {
        key: ENDPOINTS,
        value: { cerebras: 'https://api.cerebras.ai/v1', deepinfra: 'https://api.deepinfra.com/v1/openai' },
        target: GLOBAL,
      },
    ]);
    assert.ok((vscodeFake.lastInputOptions?.prompt ?? '').includes('Deep Infra'));
    assert.strictEqual(typeof vscodeFake.lastInputOptions?.validateInput, 'function');
    assert.deepStrictEqual(changed, ['deepinfra']);
    assert.deepStrictEqual(vscodeFake.messages, [
      { kind: 'info', message: mod.providerEndpointSavedMessage('Deep Infra') },
    ]);
  });

  it('an explicit provider id skips the pick and pre-fills the current value', async () => {
    vscodeFake.configuration.values.set(ENDPOINTS, { deepinfra: 'https://old.test/v1' });
    vscodeFake.inputResult = 'https://new.test/v1';

    await mod.setProviderEndpoint('deepinfra', undefined, options);

    assert.strictEqual(vscodeFake.quickPickCalls, 0);
    assert.strictEqual(vscodeFake.lastInputOptions?.value, 'https://old.test/v1');
    assert.deepStrictEqual(vscodeFake.configuration.values.get(ENDPOINTS), { deepinfra: 'https://new.test/v1' });
  });

  it('an explicit id may override a provider that has a catalog URL (proxy)', async () => {
    vscodeFake.inputResult = 'https://proxy.test/mistral';
    await mod.setProviderEndpoint('mistral', undefined, options);
    assert.strictEqual(vscodeFake.quickPickCalls, 0);
    assert.deepStrictEqual(vscodeFake.configuration.values.get(ENDPOINTS), { mistral: 'https://proxy.test/mistral' });
  });

  it('an explicit copilot, openai or unknown id falls back to the pick', async () => {
    for (const id of ['copilot', 'openai', 'nope']) {
      vscodeFake = makeVscodeFake();
      (globalThis as unknown as { __vscodeFake: VscodeFake }).__vscodeFake = vscodeFake;
      await mod.setProviderEndpoint(id, undefined, options);
      assert.strictEqual(vscodeFake.quickPickCalls, 1, id);
      assert.strictEqual(vscodeFake.configuration.updates.length, 0, id);
    }
  });

  it('an empty submit clears the entry and removes an emptied map', async () => {
    vscodeFake.configuration.values.set(ENDPOINTS, { deepinfra: 'https://old.test/v1' });
    vscodeFake.inputResult = '   ';
    const changed: string[] = [];

    await mod.setProviderEndpoint('deepinfra', (id) => {
      changed.push(id);
    }, options);

    assert.deepStrictEqual(vscodeFake.configuration.updates, [{ key: ENDPOINTS, value: undefined, target: GLOBAL }]);
    assert.deepStrictEqual(changed, ['deepinfra']);
    assert.deepStrictEqual(vscodeFake.messages, [
      { kind: 'info', message: mod.providerEndpointClearedMessage('Deep Infra') },
    ]);
  });

  it('clearing one entry keeps the others', async () => {
    vscodeFake.configuration.values.set(ENDPOINTS, { deepinfra: 'https://a.test', cerebras: 'https://b.test' });
    vscodeFake.inputResult = '';
    await mod.setProviderEndpoint('deepinfra', undefined, options);
    assert.deepStrictEqual(vscodeFake.configuration.values.get(ENDPOINTS), { cerebras: 'https://b.test' });
  });

  it('an empty submit with nothing set warns and writes nothing', async () => {
    vscodeFake.inputResult = '';
    const changed: string[] = [];
    await mod.setProviderEndpoint('deepinfra', (id) => {
      changed.push(id);
    }, options);
    assert.strictEqual(vscodeFake.configuration.updates.length, 0);
    assert.deepStrictEqual(changed, []);
    assert.deepStrictEqual(vscodeFake.messages, [
      { kind: 'warning', message: mod.PROVIDER_ENDPOINT_NO_VALUE_MESSAGE },
    ]);
  });

  it('a cancelled input box writes nothing and says nothing', async () => {
    vscodeFake.inputResult = undefined;
    await mod.setProviderEndpoint('deepinfra', undefined, options);
    assert.strictEqual(vscodeFake.configuration.updates.length, 0);
    assert.deepStrictEqual(vscodeFake.messages, []);
  });

  it('an invalid URL that slips past validateInput is refused', async () => {
    vscodeFake.inputResult = 'ftp://files.test';
    const changed: string[] = [];
    await mod.setProviderEndpoint('deepinfra', (id) => {
      changed.push(id);
    }, options);
    assert.strictEqual(vscodeFake.configuration.updates.length, 0);
    assert.deepStrictEqual(changed, []);
    assert.deepStrictEqual(vscodeFake.messages, [
      { kind: 'error', message: `Baiton: ${mod.PROVIDER_ENDPOINT_INVALID_MESSAGE}` },
    ]);
  });

  it('a failed write reports an error and does not notify', async () => {
    vscodeFake.configuration.failUpdate = true;
    vscodeFake.inputResult = 'https://api.deepinfra.com/v1/openai';
    const changed: string[] = [];
    await mod.setProviderEndpoint('deepinfra', (id) => {
      changed.push(id);
    }, options);
    assert.deepStrictEqual(changed, []);
    assert.deepStrictEqual(vscodeFake.messages, [
      { kind: 'error', message: mod.providerEndpointSaveFailedMessage('Deep Infra') },
    ]);
  });

  it('a rejecting onChanged is contained and the confirmation still shows', async () => {
    vscodeFake.inputResult = 'https://api.deepinfra.com/v1/openai';
    await assert.doesNotReject(
      mod.setProviderEndpoint('deepinfra', () => Promise.reject(new Error('refresh failed')), options),
    );
    assert.deepStrictEqual(vscodeFake.messages, [
      { kind: 'info', message: mod.providerEndpointSavedMessage('Deep Infra') },
    ]);
  });

  it('a throwing catalog supplier falls back to the builtin catalog', async () => {
    await mod.setProviderEndpoint(undefined, undefined, {
      catalog: () => {
        throw new Error('no feed');
      },
    });
    assert.deepStrictEqual(vscodeFake.messages, [{ kind: 'info', message: mod.PROVIDER_ENDPOINT_NONE_MESSAGE }]);
  });
});
