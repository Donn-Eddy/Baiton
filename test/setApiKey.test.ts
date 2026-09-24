import * as assert from 'assert';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

/**
 * Unit tests for the `Baiton: Set Orchestrator API Key` command handler
 * (Task 13.3; design "Set API Key").
 *
 * `setOrchestratorApiKey` is `vscode` glue: it prompts with a masked input box
 * and persists the trimmed value to an injected `SecretStorage`. There is no
 * requireable `vscode` runtime outside a running host, so a module
 * customization hook (`fixtures/vscodeLoader.mjs`) redirects the bare `vscode`
 * import to a stateless fake (`fixtures/vscodeFake.mjs`) that delegates to the
 * mutable fake this suite installs on `globalThis.__vscodeFake`. The handler is
 * imported dynamically only after the hook is registered.
 *
 * The `SecretStorage` passed to the handler is a per-test fake so writes are
 * observable and a write failure can be forced.
 *
 * Coverage (Req 17.4, 17.5, 17.6, 17.7):
 * - Cancel (input box dismissed -> `undefined`): key untouched, no message.
 * - Empty / whitespace-only submit: key untouched, "no value provided" message.
 * - Successful write: trimmed value stored under `baiton.orchestrator.apiKey`,
 *   a saved confirmation shown that never contains the value.
 * - Write failure: no stored value changes, an error message shown.
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
let setOrchestratorApiKey: SetApiKeyModule['setOrchestratorApiKey'];
let setProviderApiKey: SetApiKeyModule['setProviderApiKey'];
let migrateLegacyApiKey: SetApiKeyModule['migrateLegacyApiKey'];
let LEGACY_MIGRATION_FLAG: string;
let PROVIDER_KEY_NO_VALUE_MESSAGE: string;
let PROVIDER_KEY_SET_DETAIL: string;
let PROVIDER_KEY_MISSING_DETAIL: string;
let providerKeySavedMessage: (label: string) => string;
let providerKeyClearedMessage: (label: string) => string;
let providerKeySaveFailedMessage: (label: string) => string;
let API_KEY_SECRET: string;
let API_KEY_SAVED_MESSAGE: string;
let API_KEY_NO_VALUE_MESSAGE: string;
let API_KEY_SAVE_FAILED_MESSAGE: string;

// The provider catalog is host-free and statically importable.
import {
  LEGACY_API_KEY_SECRET,
  providerInfo,
  providerSecretKey,
} from '../src/orchestrator/providers';

/** Cast the SecretStorage fake to the type the handler expects. */
function asSecrets(fake: FakeSecretStorage): import('vscode').SecretStorage {
  return fake as unknown as import('vscode').SecretStorage;
}

/** A fake `vscode.Memento` (globalState) recording its updates. */
class FakeMemento {
  readonly values = new Map<string, unknown>();
  readonly updates: Array<{ key: string; value: unknown }> = [];

  get<T>(key: string): T | undefined {
    return this.values.get(key) as T | undefined;
  }

  update(key: string, value: unknown): Promise<void> {
    this.updates.push({ key, value });
    this.values.set(key, value);
    return Promise.resolve();
  }
}

/** The two-arg call shape cast for the migration entry point. */
function asMemento(fake: FakeMemento): import('vscode').Memento {
  return fake as unknown as import('vscode').Memento;
}

describe('setOrchestratorApiKey (Task 13.3)', () => {
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
    setOrchestratorApiKey = mod.setOrchestratorApiKey;
    API_KEY_SECRET = mod.API_KEY_SECRET;
    API_KEY_SAVED_MESSAGE = mod.API_KEY_SAVED_MESSAGE;
    API_KEY_NO_VALUE_MESSAGE = mod.API_KEY_NO_VALUE_MESSAGE;
    API_KEY_SAVE_FAILED_MESSAGE = mod.API_KEY_SAVE_FAILED_MESSAGE;
    setProviderApiKey = mod.setProviderApiKey;
    migrateLegacyApiKey = mod.migrateLegacyApiKey;
    LEGACY_MIGRATION_FLAG = mod.LEGACY_MIGRATION_FLAG;
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

  it('prompts with a masked input box (Req 17.2)', async () => {
    vscodeFake.inputResult = 'sk-live-secret';
    const secrets = new FakeSecretStorage();

    await setOrchestratorApiKey(asSecrets(secrets));

    assert.strictEqual(vscodeFake.inputBoxCalls, 1, 'the prompt should be shown once');
    assert.strictEqual(
      vscodeFake.lastInputOptions?.password,
      true,
      'the input must be masked',
    );
  });

  describe('cancel path (Req 17.5)', () => {
    it('leaves the stored key unchanged and shows no message when the prompt is dismissed', async () => {
      // A dismissed input box resolves undefined.
      vscodeFake.inputResult = undefined;
      const secrets = new FakeSecretStorage();
      secrets.values.set(API_KEY_SECRET, 'previous-key');

      await setOrchestratorApiKey(asSecrets(secrets));

      assert.strictEqual(secrets.storeCalls.length, 0, 'no store should be attempted');
      assert.strictEqual(secrets.values.get(API_KEY_SECRET), 'previous-key');
      assert.strictEqual(vscodeFake.messages.length, 0, 'cancel must surface no message');
    });
  });

  describe('empty / whitespace-only submit (Req 17.6)', () => {
    it('leaves the key unchanged and reports no value for an empty string', async () => {
      vscodeFake.inputResult = '';
      const secrets = new FakeSecretStorage();
      secrets.values.set(API_KEY_SECRET, 'previous-key');

      await setOrchestratorApiKey(asSecrets(secrets));

      assert.strictEqual(secrets.storeCalls.length, 0, 'no store should be attempted');
      assert.strictEqual(secrets.values.get(API_KEY_SECRET), 'previous-key');
      assert.deepStrictEqual(
        vscodeFake.messages,
        [{ kind: 'warning', message: API_KEY_NO_VALUE_MESSAGE }],
        'exactly one no-value message should be shown',
      );
    });

    it('leaves the key unchanged and reports no value for a whitespace-only submit', async () => {
      vscodeFake.inputResult = '   \t  \n ';
      const secrets = new FakeSecretStorage();

      await setOrchestratorApiKey(asSecrets(secrets));

      assert.strictEqual(secrets.storeCalls.length, 0, 'no store should be attempted');
      assert.strictEqual(secrets.values.has(API_KEY_SECRET), false, 'nothing is stored');
      assert.deepStrictEqual(vscodeFake.messages, [
        { kind: 'warning', message: API_KEY_NO_VALUE_MESSAGE },
      ]);
    });
  });

  describe('successful write (Req 17.4)', () => {
    it('stores the trimmed value under the API-key secret and confirms without revealing it', async () => {
      vscodeFake.inputResult = '  sk-live-abcdef123456  ';
      const secrets = new FakeSecretStorage();

      await setOrchestratorApiKey(asSecrets(secrets));

      // The trimmed value is written under the exact key the Model_Client reads.
      assert.strictEqual(secrets.storeCalls.length, 1, 'exactly one store');
      assert.strictEqual(secrets.storeCalls[0].key, API_KEY_SECRET);
      assert.strictEqual(secrets.storeCalls[0].value, 'sk-live-abcdef123456');
      assert.strictEqual(secrets.values.get(API_KEY_SECRET), 'sk-live-abcdef123456');

      // Exactly one confirmation, and it never contains the stored value.
      assert.deepStrictEqual(vscodeFake.messages, [
        { kind: 'info', message: API_KEY_SAVED_MESSAGE },
      ]);
      assert.ok(
        !vscodeFake.messages[0].message.includes('sk-live-abcdef123456'),
        'the confirmation must not reveal the stored value',
      );
    });
  });

  describe('write failure (Req 17.7)', () => {
    it('leaves any previously stored key unchanged and surfaces an error', async () => {
      vscodeFake.inputResult = 'new-key-value';
      const secrets = new FakeSecretStorage();
      secrets.values.set(API_KEY_SECRET, 'previous-key');
      secrets.failStore = true;

      await setOrchestratorApiKey(asSecrets(secrets));

      // A store was attempted and threw, so the previous value is left intact.
      assert.strictEqual(secrets.storeCalls.length, 1, 'a store should be attempted');
      assert.strictEqual(
        secrets.values.get(API_KEY_SECRET),
        'previous-key',
        'a failed store leaves the previous key unchanged',
      );
      // Exactly one error, and no saved confirmation.
      assert.deepStrictEqual(vscodeFake.messages, [
        { kind: 'error', message: API_KEY_SAVE_FAILED_MESSAGE },
      ]);
    });
  });
});

describe('setProviderApiKey', () => {
  before(async () => {
    // The module is already loaded by the earlier suite's hook (same loader,
    // same redirect); pick it up here too.
    const mod = (await import('../src/activation/setApiKey')) as SetApiKeyModule;
    setProviderApiKey = mod.setProviderApiKey;
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
      [
        providerInfo('google').label,
        providerInfo('opencode').label,
        providerInfo('mistral').label,
        providerInfo('openai').label,
      ],
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

describe('migrateLegacyApiKey', () => {
  before(async () => {
    const mod = (await import('../src/activation/setApiKey')) as SetApiKeyModule;
    migrateLegacyApiKey = mod.migrateLegacyApiKey;
    LEGACY_MIGRATION_FLAG = mod.LEGACY_MIGRATION_FLAG;
  });

  beforeEach(() => {
    vscodeFake = makeVscodeFake();
    (globalThis as unknown as { __vscodeFake: VscodeFake }).__vscodeFake = vscodeFake;
  });

  it('copies the legacy secret into the openai slot and leaves the legacy secret in place', async () => {
    const secrets = new FakeSecretStorage();
    secrets.values.set(LEGACY_API_KEY_SECRET, '  legacy-key  ');
    const memento = new FakeMemento();

    const migrated = await migrateLegacyApiKey(asSecrets(secrets), asMemento(memento));

    assert.strictEqual(migrated, true);
    assert.strictEqual(secrets.values.get(providerSecretKey('openai')!), 'legacy-key');
    assert.strictEqual(secrets.values.get(LEGACY_API_KEY_SECRET), '  legacy-key  ', 'legacy secret not deleted');
    assert.strictEqual(memento.values.get(LEGACY_MIGRATION_FLAG), true);
  });

  it('runs at most once: the flag prevents a second migration', async () => {
    const secrets = new FakeSecretStorage();
    secrets.values.set(LEGACY_API_KEY_SECRET, 'legacy-key');
    const memento = new FakeMemento();

    assert.strictEqual(await migrateLegacyApiKey(asSecrets(secrets), asMemento(memento)), true);

    // Between calls the user changes the openai key themselves; a second run
    // must not overwrite it.
    secrets.values.set(providerSecretKey('openai')!, 'user-key');
    assert.strictEqual(await migrateLegacyApiKey(asSecrets(secrets), asMemento(memento)), false);
    assert.strictEqual(secrets.values.get(providerSecretKey('openai')!), 'user-key');
    assert.strictEqual(secrets.storeCalls.length, 1, 'only the first call stored');
  });

  it('does not clobber an existing openai key', async () => {
    const secrets = new FakeSecretStorage();
    secrets.values.set(LEGACY_API_KEY_SECRET, 'legacy-key');
    secrets.values.set(providerSecretKey('openai')!, 'user-key');
    const memento = new FakeMemento();

    const migrated = await migrateLegacyApiKey(asSecrets(secrets), asMemento(memento));

    assert.strictEqual(migrated, false);
    assert.strictEqual(secrets.values.get(providerSecretKey('openai')!), 'user-key');
    assert.strictEqual(memento.values.get(LEGACY_MIGRATION_FLAG), true);
  });

  it('no legacy secret: flag set so the read never repeats', async () => {
    const secrets = new FakeSecretStorage();
    const memento = new FakeMemento();

    const migrated = await migrateLegacyApiKey(asSecrets(secrets), asMemento(memento));

    assert.strictEqual(migrated, false);
    assert.strictEqual(secrets.storeCalls.length, 0);
    assert.strictEqual(memento.values.get(LEGACY_MIGRATION_FLAG), true);
  });

  it('whitespace-only legacy secret is treated as absent', async () => {
    const secrets = new FakeSecretStorage();
    secrets.values.set(LEGACY_API_KEY_SECRET, '  \t ');
    const memento = new FakeMemento();

    const migrated = await migrateLegacyApiKey(asSecrets(secrets), asMemento(memento));

    assert.strictEqual(migrated, false);
    assert.strictEqual(secrets.storeCalls.length, 0);
  });

  it('a throwing SecretStorage resolves false rather than rejecting', async () => {
    const secrets = new FakeSecretStorage();
    secrets.values.set(LEGACY_API_KEY_SECRET, 'legacy-key');
    secrets.failStore = true;
    const memento = new FakeMemento();

    const migrated = await migrateLegacyApiKey(asSecrets(secrets), asMemento(memento));

    assert.strictEqual(migrated, false);
  });

  it('a rejecting get resolves false rather than rejecting', async () => {
    const secrets = new FakeSecretStorage();
    // Force `get` to reject for this case only.
    const throwing = asSecrets(secrets);
    (throwing as unknown as { get: () => Promise<string> }).get = () =>
      Promise.reject(new Error('boom'));
    const memento = new FakeMemento();

    const migrated = await migrateLegacyApiKey(throwing, asMemento(memento));

    assert.strictEqual(migrated, false);
  });
});
