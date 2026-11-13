import * as assert from 'assert';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

/**
 * Unit tests for the `Baiton: Set Provider API Key` command handler.
 *
 * `setProviderApiKey` is `vscode` glue: it offers a quick pick over the live
 * provider catalog, then prompts with a masked input and sets or clears that
 * provider's `baiton.orchestrator.key.<id>` slot in an injected `SecretStorage`.
 * Cancel leaves the key unchanged with no message; an empty submit clears an
 * existing key or warns that nothing was provided; a storage failure leaves
 * the previous value and shows an error.
 *
 * There is no requireable `vscode` runtime outside a running host, so a module
 * customization hook (`fixtures/vscodeLoader.mjs`) redirects the bare `vscode`
 * import to a stateless fake (`fixtures/vscodeFake.mjs`) that delegates to the
 * mutable fake this suite installs on `globalThis.__vscodeFake`. The handler is
 * imported dynamically only after the hook is registered.
 *
 * The `SecretStorage` passed to the handler is a per-test fake so reads, writes,
 * deletes and storage failures are observable.
 */

/** A recorded call to one of the faked `vscode.window` message functions. */
interface MessageCall {
  readonly kind: 'info' | 'warning' | 'error';
  readonly message: string;
}

/** The controllable, observable fake standing in for the `vscode` surface. */
interface VscodeFake {
  /** The value the next `showInputBox` call resolves with. */
  inputResult: string | undefined;
  /** The options passed to the most recent `showInputBox` call. */
  lastInputOptions: { prompt?: string; password?: boolean } | undefined;
  /** Number of times `showInputBox` was invoked. */
  inputBoxCalls: number;
  /** The value the next `showQuickPick` call resolves with (undefined = dismissed). */
  quickPickResult: unknown;
  /** The items passed to the most recent `showQuickPick` call. */
  lastQuickPickItems: ReadonlyArray<{ label: string; description?: string; id?: string }> | undefined;
  /** The options passed to the most recent `showQuickPick` call. */
  lastQuickPickOptions: { title?: string; placeHolder?: string } | undefined;
  /** Number of times `showQuickPick` was invoked. */
  quickPickCalls: number;
  /** Every message surfaced through `show{Information,Warning,Error}Message`. */
  readonly messages: MessageCall[];
  readonly window: {
    showInputBox: (
      options?: { prompt?: string; password?: boolean },
    ) => Promise<string | undefined>;
    showQuickPick: (
      items: ReadonlyArray<{ label: string; description?: string; id?: string }>,
      options?: { title?: string; placeHolder?: string },
    ) => Promise<unknown>;
    showInformationMessage: (message: string) => Promise<string | undefined>;
    showWarningMessage: (message: string) => Promise<string | undefined>;
    showErrorMessage: (message: string) => Promise<string | undefined>;
  };
}

/** Build a fresh fake with no recorded calls and a cancelled prompt. */
function makeVscodeFake(): VscodeFake {
  const fake: VscodeFake = {
    inputResult: undefined,
    lastInputOptions: undefined,
    inputBoxCalls: 0,
    quickPickResult: undefined,
    lastQuickPickItems: undefined,
    lastQuickPickOptions: undefined,
    quickPickCalls: 0,
    messages: [],
    window: {
      showInputBox: (options) => {
        fake.inputBoxCalls += 1;
        fake.lastInputOptions = options;
        return Promise.resolve(fake.inputResult);
      },
      showQuickPick: (items, options) => {
        fake.quickPickCalls += 1;
        fake.lastQuickPickItems = items;
        fake.lastQuickPickOptions = options;
        return Promise.resolve(fake.quickPickResult);
      },
      showInformationMessage: (message) => {
        fake.messages.push({ kind: 'info', message });
        return Promise.resolve(undefined);
      },
      showWarningMessage: (message) => {
        fake.messages.push({ kind: 'warning', message });
        return Promise.resolve(undefined);
      },
      showErrorMessage: (message) => {
        fake.messages.push({ kind: 'error', message });
        return Promise.resolve(undefined);
      },
    },
  };
  return fake;
}

/** The fake the redirected `vscode` module delegates to, per test. */
let vscodeFake: VscodeFake = makeVscodeFake();

/**
 * A fake `vscode.SecretStorage`. `store` can be made to reject to exercise the
 * write-failure path; the handler only uses `store`, but the whole surface is
 * implemented so the fake is a faithful stand-in.
 */
class FakeSecretStorage {
  /** The current stored secrets, keyed exactly as the handler writes them. */
  readonly values = new Map<string, string>();
  /** Every key/value passed to `store`, in call order (even a failed store). */
  readonly storeCalls: Array<{ key: string; value: string }> = [];
  /** When true, `store` rejects instead of writing (Req 17.7). */
  failStore = false;
  /** Every key/value passed to `delete`, in call order. */
  readonly deleteCalls: string[] = [];
  /** When true, `delete` rejects instead of deleting. */
  failDelete = false;

  async get(key: string): Promise<string | undefined> {
    return this.values.get(key);
  }

  async store(key: string, value: string): Promise<void> {
    this.storeCalls.push({ key, value });
    if (this.failStore) {
      throw new Error('secret storage unavailable');
    }
    this.values.set(key, value);
  }

  async delete(key: string): Promise<void> {
    this.deleteCalls.push(key);
    if (this.failDelete) {
      throw new Error('secret storage unavailable');
    }
    this.values.delete(key);
  }

  onDidChange = () => ({ dispose: () => undefined });
}

// The handler module and its exported constants, loaded once the vscode
// redirect hook is registered.
type SetApiKeyModule = typeof import('../src/activation/setApiKey');
let setProviderApiKey: SetApiKeyModule['setProviderApiKey'];
let PROVIDER_KEY_NO_VALUE_MESSAGE: string;
let PROVIDER_KEY_SET_DETAIL: string;
let PROVIDER_KEY_MISSING_DETAIL: string;
let providerKeySavedMessage: (label: string) => string;
let providerKeyClearedMessage: (label: string) => string;
let providerKeySaveFailedMessage: (label: string) => string;

// The provider catalog is host-free and statically importable.
import {
  providerCatalog,
  providerInfo,
  providerSecretKey,
} from '../src/orchestrator/providers';
import type { ProviderInfo } from '../src/orchestrator/providers';

/**
 * A stand-in for a models.dev-derived catalog entry: keyed, `source: 'feed'`,
 * and absent from the builtin catalog, so it exercises the generic key slot.
 */
function feedEntry(id: string, label: string): ProviderInfo {
  return {
    id,
    label,
    defaultBaseUrl: `https://api.${id}.test/v1`,
    requiresKey: true,
    usesSettings: false,
    models: [`${id}-model`],
    dialect: 'openai',
    headerStyle: 'default',
    source: 'feed',
  };
}

/**
 * The four builtin keyed quick-pick labels, in catalog order: OpenCode Go and
 * OpenCode Zen share one key slot and so one item.
 */
function builtinKeyedLabels(): string[] {
  return [
    providerInfo('google').label,
    'OpenCode Go / OpenCode Zen',
    providerInfo('mistral').label,
    providerInfo('openai').label,
  ];
}

/** Cast the SecretStorage fake to the type the handler expects. */
function asSecrets(fake: FakeSecretStorage): import('vscode').SecretStorage {
  return fake as unknown as import('vscode').SecretStorage;
}

describe('setProviderApiKey', () => {
  before(async () => {
    // Register the hook that redirects `vscode` to the in-repo fake, then load
    // the handler so its `import * as vscode` resolves to the fake. Mocha runs
    // from the repository root, so the loader path is resolved from the CWD
    // (this file avoids `import.meta` so it also compiles under the project's
    // CommonJS tsc configuration).
    const root = process.cwd();
    const loaderUrl = pathToFileURL(
      join(root, 'test', 'fixtures', 'vscodeLoader.mjs'),
    ).href;
    register(loaderUrl, pathToFileURL(join(root, '/')).href);
    await import('./fixtures/vscodeLoader.mjs');

    const mod = (await import('../src/activation/setApiKey')) as SetApiKeyModule;
    setProviderApiKey = mod.setProviderApiKey;
    PROVIDER_KEY_NO_VALUE_MESSAGE = mod.PROVIDER_KEY_NO_VALUE_MESSAGE;
    PROVIDER_KEY_SET_DETAIL = mod.PROVIDER_KEY_SET_DETAIL;
    PROVIDER_KEY_MISSING_DETAIL = mod.PROVIDER_KEY_MISSING_DETAIL;
    providerKeySavedMessage = mod.providerKeySavedMessage;
    providerKeyClearedMessage = mod.providerKeyClearedMessage;
    providerKeySaveFailedMessage = mod.providerKeySaveFailedMessage;
  });

  beforeEach(() => {
    vscodeFake = makeVscodeFake();
    (globalThis as unknown as { __vscodeFake: VscodeFake }).__vscodeFake = vscodeFake;
  });

  it('quick-pick contents: four keyed providers in catalog order, no copilot', async () => {
    const secrets = new FakeSecretStorage();
    secrets.values.set('baiton.orchestrator.key.google', 'g-key');

    await setProviderApiKey(asSecrets(secrets));

    const items = vscodeFake.lastQuickPickItems!;
    assert.strictEqual(items.length, 4, 'exactly the four keyed providers');
    assert.deepStrictEqual(
      items.map((i) => i.label),
      builtinKeyedLabels(),
    );
    assert.ok(items.every((i) => i.label !== 'GitHub Copilot'), 'no GitHub Copilot item');
    assert.strictEqual(items[0].description, PROVIDER_KEY_SET_DETAIL);
    assert.deepStrictEqual(
      [items[1].description, items[2].description, items[3].description],
      [PROVIDER_KEY_MISSING_DETAIL, PROVIDER_KEY_MISSING_DETAIL, PROVIDER_KEY_MISSING_DETAIL],
    );
  });

  it('dismissed quick pick: no input box, no store, no delete, no message', async () => {
    vscodeFake.quickPickResult = undefined;
    const secrets = new FakeSecretStorage();

    await setProviderApiKey(asSecrets(secrets));

    assert.strictEqual(vscodeFake.quickPickCalls, 1);
    assert.strictEqual(vscodeFake.inputBoxCalls, 0);
    assert.strictEqual(secrets.storeCalls.length, 0);
    assert.strictEqual(secrets.deleteCalls.length, 0);
    assert.strictEqual(vscodeFake.messages.length, 0);
  });

  it('explicit provider argument skips the quick pick', async () => {
    const secrets = new FakeSecretStorage();

    await setProviderApiKey(asSecrets(secrets), 'mistral');

    assert.strictEqual(vscodeFake.quickPickCalls, 0);
    assert.strictEqual(vscodeFake.inputBoxCalls, 1);
  });

  it('the prompt is masked and names the picked provider', async () => {
    const secrets = new FakeSecretStorage();

    await setProviderApiKey(asSecrets(secrets), 'openai');

    assert.strictEqual(vscodeFake.lastInputOptions?.password, true);
    assert.ok(
      (vscodeFake.lastInputOptions?.prompt ?? '').includes(providerInfo('openai').label),
    );
  });

  it('stores the trimmed value under the per-provider key and confirms without revealing it', async () => {
    vscodeFake.inputResult = '  mk-abc  ';
    const secrets = new FakeSecretStorage();

    await setProviderApiKey(asSecrets(secrets), 'mistral');

    assert.strictEqual(secrets.storeCalls.length, 1);
    assert.strictEqual(secrets.storeCalls[0].key, 'baiton.orchestrator.key.mistral');
    assert.strictEqual(secrets.storeCalls[0].key, providerSecretKey('mistral'));
    assert.strictEqual(secrets.storeCalls[0].value, 'mk-abc');
    assert.deepStrictEqual(vscodeFake.messages, [
      { kind: 'info', message: providerKeySavedMessage('Mistral AI') },
    ]);
    assert.ok(!vscodeFake.messages[0].message.includes('mk-abc'));
  });

  it('per-provider isolation: setting google leaves mistral untouched', async () => {
    vscodeFake.inputResult = 'g-new-key';
    const secrets = new FakeSecretStorage();
    secrets.values.set('baiton.orchestrator.key.mistral', 'm-key');

    await setProviderApiKey(asSecrets(secrets), 'google');

    assert.strictEqual(secrets.values.get(providerSecretKey('mistral')!), 'm-key');
    assert.strictEqual(secrets.values.get(providerSecretKey('google')!), 'g-new-key');
  });

  it('clear: an empty submit with a stored key deletes it once and confirms', async () => {
    vscodeFake.inputResult = '';
    const secrets = new FakeSecretStorage();
    secrets.values.set('baiton.orchestrator.key.google', 'g-key');

    await setProviderApiKey(asSecrets(secrets), 'google');

    assert.deepStrictEqual(secrets.deleteCalls, ['baiton.orchestrator.key.google']);
    assert.strictEqual(secrets.values.has('baiton.orchestrator.key.google'), false);
    assert.strictEqual(secrets.storeCalls.length, 0, 'no store on a clear');
    assert.deepStrictEqual(vscodeFake.messages, [
      { kind: 'info', message: providerKeyClearedMessage('Google AI Studio') },
    ]);
  });

  it('empty submit with nothing stored: one warning, no writes', async () => {
    vscodeFake.inputResult = '   ';
    const secrets = new FakeSecretStorage();

    await setProviderApiKey(asSecrets(secrets), 'openai');

    assert.strictEqual(secrets.deleteCalls.length, 0);
    assert.strictEqual(secrets.storeCalls.length, 0);
    assert.deepStrictEqual(vscodeFake.messages, [
      { kind: 'warning', message: PROVIDER_KEY_NO_VALUE_MESSAGE },
    ]);
  });

  it('input-box cancel after a picked provider: nothing touched', async () => {
    vscodeFake.inputResult = undefined;
    const secrets = new FakeSecretStorage();
    secrets.values.set('baiton.orchestrator.key.google', 'g-key');

    await setProviderApiKey(asSecrets(secrets), 'google');

    assert.strictEqual(secrets.storeCalls.length, 0);
    assert.strictEqual(secrets.deleteCalls.length, 0);
    assert.strictEqual(vscodeFake.messages.length, 0);
    assert.strictEqual(secrets.values.get('baiton.orchestrator.key.google'), 'g-key');
  });

  it('store failure: previous value unchanged, one error, no confirmation', async () => {
    vscodeFake.inputResult = 'new-key';
    const secrets = new FakeSecretStorage();
    secrets.values.set('baiton.orchestrator.key.google', 'g-key');
    secrets.failStore = true;

    await setProviderApiKey(asSecrets(secrets), 'google');

    assert.strictEqual(secrets.values.get('baiton.orchestrator.key.google'), 'g-key');
    assert.deepStrictEqual(vscodeFake.messages, [
      { kind: 'error', message: providerKeySaveFailedMessage('Google AI Studio') },
    ]);
  });
});

describe('setProviderApiKey shared OpenCode key', () => {
  let providerKeyGroups: SetApiKeyModule['providerKeyGroups'];

  before(async () => {
    const mod = (await import('../src/activation/setApiKey')) as SetApiKeyModule;
    setProviderApiKey = mod.setProviderApiKey;
    providerKeyGroups = mod.providerKeyGroups;
  });

  beforeEach(() => {
    vscodeFake = makeVscodeFake();
    (globalThis as unknown as { __vscodeFake: VscodeFake }).__vscodeFake = vscodeFake;
  });

  it('providerKeyGroups collapses ids sharing a slot, in catalog order', () => {
    const groups = providerKeyGroups(providerCatalog());
    assert.deepStrictEqual(
      groups.map((g) => [g.id, [...g.ids], g.label, g.secretKey]),
      [
        ['google', ['google'], 'Google AI Studio', 'baiton.orchestrator.key.google'],
        [
          'opencode-go',
          ['opencode-go', 'opencode'],
          'OpenCode Go / OpenCode Zen',
          'baiton.orchestrator.key.opencode',
        ],
        ['mistral', ['mistral'], 'Mistral AI', 'baiton.orchestrator.key.mistral'],
        ['openai', ['openai'], 'OpenAI / Custom', 'baiton.orchestrator.key.openai'],
      ],
    );
  });

  it('offers one OpenCode item, marked set by the shared key', async () => {
    const secrets = new FakeSecretStorage();
    secrets.values.set('baiton.orchestrator.key.opencode', 'oc');

    await setProviderApiKey(asSecrets(secrets));

    const items = vscodeFake.lastQuickPickItems!;
    const openCode = items.filter((i) => i.label.includes('OpenCode'));
    assert.strictEqual(openCode.length, 1, 'exactly one OpenCode item');
    assert.strictEqual(openCode[0].label, 'OpenCode Go / OpenCode Zen');
    assert.strictEqual(openCode[0].description, PROVIDER_KEY_SET_DETAIL);
  });

  it('picking the OpenCode item stores under the shared slot with the joined label', async () => {
    const secrets = new FakeSecretStorage();
    vscodeFake.quickPickResult = { label: 'OpenCode Go / OpenCode Zen', id: 'opencode-go' };
    vscodeFake.inputResult = 'oc-new';
    const changed: string[] = [];

    await setProviderApiKey(asSecrets(secrets), undefined, (id) => {
      changed.push(id);
    });

    assert.deepStrictEqual(secrets.storeCalls, [{ key: 'baiton.orchestrator.key.opencode', value: 'oc-new' }]);
    assert.ok((vscodeFake.lastInputOptions?.prompt ?? '').includes('OpenCode Go / OpenCode Zen'));
    assert.deepStrictEqual(vscodeFake.messages, [
      { kind: 'info', message: providerKeySavedMessage('OpenCode Go / OpenCode Zen') },
    ]);
    assert.deepStrictEqual(changed, ['opencode-go']);
  });

  for (const id of ['opencode-go', 'opencode']) {
    it(`an explicit ${id} argument skips the pick and writes the shared slot`, async () => {
      const secrets = new FakeSecretStorage();
      vscodeFake.inputResult = 'oc-key';

      await setProviderApiKey(asSecrets(secrets), id);

      assert.strictEqual(vscodeFake.quickPickCalls, 0);
      assert.deepStrictEqual(secrets.storeCalls, [{ key: 'baiton.orchestrator.key.opencode', value: 'oc-key' }]);
      assert.deepStrictEqual(vscodeFake.messages, [
        { kind: 'info', message: providerKeySavedMessage('OpenCode Go / OpenCode Zen') },
      ]);
    });
  }

  it('clearing through either id deletes the one shared key and names both', async () => {
    const secrets = new FakeSecretStorage();
    secrets.values.set('baiton.orchestrator.key.opencode', 'oc');
    vscodeFake.inputResult = '';

    await setProviderApiKey(asSecrets(secrets), 'opencode-go');

    assert.deepStrictEqual(secrets.deleteCalls, ['baiton.orchestrator.key.opencode']);
    assert.deepStrictEqual(vscodeFake.messages, [
      { kind: 'info', message: providerKeyClearedMessage('OpenCode Go / OpenCode Zen') },
    ]);
  });
});

describe('setProviderApiKey onChanged notification', () => {
  before(async () => {
    const mod = (await import('../src/activation/setApiKey')) as SetApiKeyModule;
    setProviderApiKey = mod.setProviderApiKey;
  });

  beforeEach(() => {
    vscodeFake = makeVscodeFake();
    (globalThis as unknown as { __vscodeFake: VscodeFake }).__vscodeFake = vscodeFake;
  });

  it('non-empty submit for a picked provider: callback called once with that id, after the secret is present', async () => {
    vscodeFake.inputResult = '  mk-abc  ';
    const secrets = new FakeSecretStorage();
    const calls: Array<{ id: string; secretPresent: boolean }> = [];

    await setProviderApiKey(asSecrets(secrets), 'mistral', (id) => {
      calls.push({ id, secretPresent: secrets.values.get(providerSecretKey('mistral')!) === 'mk-abc' });
    });

    assert.deepStrictEqual(calls, [{ id: 'mistral', secretPresent: true }]);
    assert.deepStrictEqual(vscodeFake.messages, [
      { kind: 'info', message: providerKeySavedMessage('Mistral AI') },
    ]);
  });

  it('empty submit that clears an existing key: callback called once with that id, after the key is gone', async () => {
    vscodeFake.inputResult = '';
    const secrets = new FakeSecretStorage();
    secrets.values.set('baiton.orchestrator.key.google', 'g-key');
    const calls: Array<{ id: string; keyGone: boolean }> = [];

    await setProviderApiKey(asSecrets(secrets), 'google', (id) => {
      calls.push({ id, keyGone: !secrets.values.has(providerSecretKey('google')!) });
    });

    assert.deepStrictEqual(calls, [{ id: 'google', keyGone: true }]);
    assert.strictEqual(secrets.values.has('baiton.orchestrator.key.google'), false);
    assert.deepStrictEqual(vscodeFake.messages, [
      { kind: 'info', message: providerKeyClearedMessage('Google AI Studio') },
    ]);
  });

  it('empty submit with nothing stored: callback NOT called', async () => {
    vscodeFake.inputResult = '   ';
    const secrets = new FakeSecretStorage();
    const calls: string[] = [];

    await setProviderApiKey(asSecrets(secrets), 'openai', (id) => {
      calls.push(id);
    });

    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(vscodeFake.messages, [
      { kind: 'warning', message: PROVIDER_KEY_NO_VALUE_MESSAGE },
    ]);
  });

  it('cancelled input box: callback NOT called', async () => {
    vscodeFake.inputResult = undefined;
    const secrets = new FakeSecretStorage();
    secrets.values.set('baiton.orchestrator.key.google', 'g-key');
    const calls: string[] = [];

    await setProviderApiKey(asSecrets(secrets), 'google', (id) => {
      calls.push(id);
    });

    assert.deepStrictEqual(calls, []);
    assert.strictEqual(secrets.values.get('baiton.orchestrator.key.google'), 'g-key');
  });

  it('dismissed quick pick: callback NOT called', async () => {
    vscodeFake.quickPickResult = undefined;
    const secrets = new FakeSecretStorage();
    const calls: string[] = [];

    await setProviderApiKey(asSecrets(secrets), undefined, (id) => {
      calls.push(id);
    });

    assert.deepStrictEqual(calls, []);
    assert.strictEqual(vscodeFake.messages.length, 0);
  });

  it('a store that throws: callback NOT called and the failure message still shown', async () => {
    vscodeFake.inputResult = 'new-key';
    const secrets = new FakeSecretStorage();
    secrets.failStore = true;
    const calls: string[] = [];

    await setProviderApiKey(asSecrets(secrets), 'google', (id) => {
      calls.push(id);
    });

    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(vscodeFake.messages, [
      { kind: 'error', message: providerKeySaveFailedMessage('Google AI Studio') },
    ]);
  });

  it('a delete that throws: callback NOT called and the failure message still shown', async () => {
    vscodeFake.inputResult = '';
    const secrets = new FakeSecretStorage();
    secrets.values.set('baiton.orchestrator.key.google', 'g-key');
    secrets.failDelete = true;
    const calls: string[] = [];

    await setProviderApiKey(asSecrets(secrets), 'google', (id) => {
      calls.push(id);
    });

    assert.deepStrictEqual(calls, []);
    assert.deepStrictEqual(vscodeFake.messages, [
      { kind: 'error', message: providerKeySaveFailedMessage('Google AI Studio') },
    ]);
  });

  it('a callback that rejects: setProviderApiKey still resolves and the confirmation is still shown', async () => {
    vscodeFake.inputResult = 'mk-abc';
    const secrets = new FakeSecretStorage();

    await setProviderApiKey(asSecrets(secrets), 'mistral', async () => {
      throw new Error('refresh boom');
    });

    assert.strictEqual(secrets.values.get(providerSecretKey('mistral')!), 'mk-abc');
    assert.deepStrictEqual(vscodeFake.messages, [
      { kind: 'info', message: providerKeySavedMessage('Mistral AI') },
    ]);
  });

  it('a callback that throws synchronously is contained the same way', async () => {
    vscodeFake.inputResult = 'mk-abc';
    const secrets = new FakeSecretStorage();

    await setProviderApiKey(asSecrets(secrets), 'mistral', () => {
      throw new Error('refresh boom');
    });

    assert.deepStrictEqual(vscodeFake.messages, [
      { kind: 'info', message: providerKeySavedMessage('Mistral AI') },
    ]);
  });
});

describe('setProviderApiKey catalog-driven quick pick', () => {
  /** The extended catalog the host would pass once the feed has landed. */
  const extendedCatalog = (): readonly ProviderInfo[] => [
    ...providerCatalog(),
    feedEntry('deepseek', 'DeepSeek'),
    feedEntry('cerebras', 'Cerebras'),
  ];

  before(async () => {
    const mod = (await import('../src/activation/setApiKey')) as SetApiKeyModule;
    setProviderApiKey = mod.setProviderApiKey;
  });

  beforeEach(() => {
    vscodeFake = makeVscodeFake();
    (globalThis as unknown as { __vscodeFake: VscodeFake }).__vscodeFake = vscodeFake;
  });

  it('offers the hidden feed providers too, in catalog order, still without copilot', async () => {
    const secrets = new FakeSecretStorage();

    await setProviderApiKey(asSecrets(secrets), undefined, undefined, {
      catalog: extendedCatalog,
    });

    const items = vscodeFake.lastQuickPickItems!;
    assert.deepStrictEqual(
      items.map((i) => i.label),
      [...builtinKeyedLabels(), 'DeepSeek', 'Cerebras'],
    );
    assert.ok(items.every((i) => i.label !== 'GitHub Copilot'), 'no GitHub Copilot item');
  });

  it('choosing a hidden provider stores under the generic per-provider key', async () => {
    vscodeFake.quickPickResult = { label: 'DeepSeek', id: 'deepseek' };
    vscodeFake.inputResult = '  dk-abc  ';
    const secrets = new FakeSecretStorage();

    await setProviderApiKey(asSecrets(secrets), undefined, undefined, {
      catalog: extendedCatalog,
    });

    assert.strictEqual(secrets.storeCalls.length, 1);
    assert.strictEqual(secrets.storeCalls[0].key, 'baiton.orchestrator.key.deepseek');
    assert.strictEqual(secrets.storeCalls[0].key, providerSecretKey('deepseek'));
    assert.strictEqual(secrets.storeCalls[0].value, 'dk-abc');
    assert.deepStrictEqual(vscodeFake.messages, [
      { kind: 'info', message: providerKeySavedMessage('DeepSeek') },
    ]);
    assert.ok(!vscodeFake.messages[0].message.includes('dk-abc'));
  });

  it('descriptions reflect stored keys for feed providers too', async () => {
    const secrets = new FakeSecretStorage();
    secrets.values.set('baiton.orchestrator.key.cerebras', 'cb-key');

    await setProviderApiKey(asSecrets(secrets), undefined, undefined, {
      catalog: extendedCatalog,
    });

    const items = vscodeFake.lastQuickPickItems!;
    const byLabel = new Map(items.map((i) => [i.label, i.description]));
    assert.strictEqual(byLabel.get('Cerebras'), PROVIDER_KEY_SET_DETAIL);
    assert.strictEqual(byLabel.get('DeepSeek'), PROVIDER_KEY_MISSING_DETAIL);
  });

  it('no credential value ever reaches the quick-pick items', async () => {
    const secrets = new FakeSecretStorage();
    secrets.values.set('baiton.orchestrator.key.deepseek', 'super-secret-value');

    await setProviderApiKey(asSecrets(secrets), undefined, undefined, {
      catalog: extendedCatalog,
    });

    assert.ok(
      !JSON.stringify(vscodeFake.lastQuickPickItems).includes('super-secret-value'),
      'the pick items must carry only ids, labels and a set/not-set marker',
    );
  });

  it('an explicit feed provider id skips the pick and prompts with the feed label', async () => {
    vscodeFake.inputResult = 'dk';
    const secrets = new FakeSecretStorage();
    const calls: string[] = [];

    await setProviderApiKey(
      asSecrets(secrets),
      'deepseek',
      (id) => {
        calls.push(id);
      },
      { catalog: extendedCatalog },
    );

    assert.strictEqual(vscodeFake.quickPickCalls, 0);
    assert.strictEqual(vscodeFake.inputBoxCalls, 1);
    assert.ok((vscodeFake.lastInputOptions?.prompt ?? '').includes('DeepSeek'));
    assert.strictEqual(secrets.values.get('baiton.orchestrator.key.deepseek'), 'dk');
    assert.deepStrictEqual(calls, ['deepseek']);
  });

  it('an id absent from the catalog degrades to a label equal to the id', async () => {
    vscodeFake.inputResult = 'gh-key';
    const secrets = new FakeSecretStorage();

    await setProviderApiKey(asSecrets(secrets), 'ghost-provider', undefined, {
      catalog: extendedCatalog,
    });

    assert.strictEqual(secrets.values.get('baiton.orchestrator.key.ghost-provider'), 'gh-key');
    assert.deepStrictEqual(vscodeFake.messages, [
      { kind: 'info', message: providerKeySavedMessage('ghost-provider') },
    ]);
  });

  it('a throwing catalog supplier falls back to the builtin catalog', async () => {
    const secrets = new FakeSecretStorage();

    await setProviderApiKey(asSecrets(secrets), undefined, undefined, {
      catalog: () => {
        throw new Error('boom');
      },
    });

    assert.deepStrictEqual(
      vscodeFake.lastQuickPickItems!.map((i) => i.label),
      builtinKeyedLabels(),
    );
  });

  it('an undefined / empty / keyless catalog falls back to the builtin catalog', async () => {
    const suppliers: Array<() => readonly ProviderInfo[] | undefined> = [
      () => undefined,
      () => [],
      () => [providerCatalog()[0]], // copilot alone: keyless, so not offerable
    ];

    for (const catalog of suppliers) {
      vscodeFake = makeVscodeFake();
      (globalThis as unknown as { __vscodeFake: VscodeFake }).__vscodeFake = vscodeFake;
      const secrets = new FakeSecretStorage();

      await setProviderApiKey(asSecrets(secrets), undefined, undefined, { catalog });

      assert.deepStrictEqual(
        vscodeFake.lastQuickPickItems!.map((i) => i.label),
        builtinKeyedLabels(),
      );
    }
  });

  it('a rejecting SecretStorage read leaves the pick showing, all marked unset', async () => {
    const secrets = new FakeSecretStorage();
    const throwing = asSecrets(secrets);
    (throwing as unknown as { get: () => Promise<string> }).get = () =>
      Promise.reject(new Error('boom'));

    await setProviderApiKey(throwing, undefined, undefined, { catalog: extendedCatalog });

    assert.strictEqual(vscodeFake.quickPickCalls, 1);
    const items = vscodeFake.lastQuickPickItems!;
    assert.strictEqual(items.length, 6);
    assert.ok(
      items.every((i) => i.description === PROVIDER_KEY_MISSING_DETAIL),
      'an unreadable slot reads as "no key set"',
    );
  });

  it('the catalog is read at call time, not hoisted at the first call', async () => {
    const feedExtra: ProviderInfo[] = [];
    const catalog = (): readonly ProviderInfo[] => [...providerCatalog(), ...feedExtra];

    await setProviderApiKey(asSecrets(new FakeSecretStorage()), undefined, undefined, { catalog });
    assert.strictEqual(vscodeFake.lastQuickPickItems!.length, 4);

    feedExtra.push(feedEntry('baseten', 'Baseten'));
    vscodeFake = makeVscodeFake();
    (globalThis as unknown as { __vscodeFake: VscodeFake }).__vscodeFake = vscodeFake;

    await setProviderApiKey(asSecrets(new FakeSecretStorage()), undefined, undefined, { catalog });
    assert.strictEqual(vscodeFake.lastQuickPickItems!.length, 5);
    assert.strictEqual(vscodeFake.lastQuickPickItems![4].label, 'Baseten');
  });
});
