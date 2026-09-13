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
  /** Every message surfaced through `show{Information,Warning,Error}Message`. */
  readonly messages: MessageCall[];
  readonly window: {
    showInputBox: (
      options?: { prompt?: string; password?: boolean },
    ) => Promise<string | undefined>;
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
    messages: [],
    window: {
      showInputBox: (options) => {
        fake.inputBoxCalls += 1;
        fake.lastInputOptions = options;
        return Promise.resolve(fake.inputResult);
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
    this.values.delete(key);
  }

  onDidChange = () => ({ dispose: () => undefined });
}

// The handler module and its exported constants, loaded once the vscode
// redirect hook is registered.
type SetApiKeyModule = typeof import('../src/activation/setApiKey');
let setOrchestratorApiKey: SetApiKeyModule['setOrchestratorApiKey'];
let API_KEY_SECRET: string;
let API_KEY_SAVED_MESSAGE: string;
let API_KEY_NO_VALUE_MESSAGE: string;
let API_KEY_SAVE_FAILED_MESSAGE: string;

/** Cast the SecretStorage fake to the type the handler expects. */
function asSecrets(fake: FakeSecretStorage): import('vscode').SecretStorage {
  return fake as unknown as import('vscode').SecretStorage;
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

    const mod = (await import('../src/activation/setApiKey')) as SetApiKeyModule;
    setOrchestratorApiKey = mod.setOrchestratorApiKey;
    API_KEY_SECRET = mod.API_KEY_SECRET;
    API_KEY_SAVED_MESSAGE = mod.API_KEY_SAVED_MESSAGE;
    API_KEY_NO_VALUE_MESSAGE = mod.API_KEY_NO_VALUE_MESSAGE;
    API_KEY_SAVE_FAILED_MESSAGE = mod.API_KEY_SAVE_FAILED_MESSAGE;
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
