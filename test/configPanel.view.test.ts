import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

/**
 * Unit tests for the Config Panel WebviewView and reveal command (spec "Config Panel",
 * config-panel todo T11).
 *
 * Exercises the VS Code glue without a running host by redirecting `vscode`
 * to `test/fixtures/vscodeFake.mjs` via `vscodeLoader.mjs`.
 */

type ConfigPanelModule = typeof import('../src/activation/configPanel');
type OpenConfigPanelViewModule = typeof import('../src/activation/openConfigPanelView');

let configPanelMod: ConfigPanelModule;
let openConfigPanelViewMod: OpenConfigPanelViewModule;

interface FakeWebviewViewInstance {
  readonly fakeView: import('vscode').WebviewView;
  readonly fakeWebview: {
    options: { enableScripts?: boolean; localResourceRoots?: readonly { fsPath: string; path?: string }[] };
    html: string;
    cspSource: string;
    asWebviewUri(uri: { fsPath?: string; path?: string }): { toString(): string };
    postMessage(msg: unknown): Promise<boolean>;
    onDidReceiveMessage(listener: (msg: unknown) => void): { dispose(): void };
  };
  readonly posted: unknown[];
  readonly messageListeners: ((msg: unknown) => void)[];
  readonly disposeListeners: (() => void)[];
}

function makeFakeWebviewView(): FakeWebviewViewInstance {
  const posted: unknown[] = [];
  const messageListeners: ((msg: unknown) => void)[] = [];
  const disposeListeners: (() => void)[] = [];

  const fakeWebview = {
    options: {} as { enableScripts?: boolean; localResourceRoots?: readonly { fsPath: string; path?: string }[] },
    html: '',
    cspSource: 'vscode-webview-resource:',
    asWebviewUri: (uri: { fsPath?: string; path?: string }) => ({
      toString: () => `vscode-resource://${uri.path ?? uri.fsPath}`,
    }),
    postMessage: async (msg: unknown) => {
      posted.push(msg);
      return true;
    },
    onDidReceiveMessage: (listener: (msg: unknown) => void) => {
      messageListeners.push(listener);
      return { dispose: () => {} };
    },
  };

  const fakeView = {
    webview: fakeWebview,
    onDidDispose: (listener: () => void) => {
      disposeListeners.push(listener);
      return { dispose: () => {} };
    },
    dispose: () => {
      for (const l of disposeListeners) {
        l();
      }
    },
  } as unknown as import('vscode').WebviewView;

  return {
    fakeView,
    fakeWebview,
    posted,
    messageListeners,
    disposeListeners,
  };
}

describe('Config Panel view and reveal command (spec "Config Panel", todo T11)', () => {
  before(async () => {
    const root = process.cwd();
    const loaderUrl = pathToFileURL(
      join(root, 'test', 'fixtures', 'vscodeLoader.mjs'),
    ).href;
    register(loaderUrl, pathToFileURL(join(root, '/')).href);
    await import('./fixtures/vscodeLoader.mjs');

    configPanelMod = await import('../src/activation/configPanel');
    openConfigPanelViewMod = await import('../src/activation/openConfigPanelView');
  });

  it('CONFIG_VIEW_ID equals package.json contributed view id and focus command derives from it', () => {
    const pkgPath = path.join(process.cwd(), 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const contributedViews = pkg.contributes?.views?.baiton as Array<{ id: string }> | undefined;
    assert.ok(contributedViews, 'contributes.views.baiton must exist');
    const configEntry = contributedViews.find((v) => v.id === configPanelMod.CONFIG_VIEW_ID);
    assert.ok(configEntry, `contributed view ${configPanelMod.CONFIG_VIEW_ID} must exist in package.json`);
    assert.strictEqual(configPanelMod.CONFIG_VIEW_ID, 'baiton.configPanel');
    assert.strictEqual(
      openConfigPanelViewMod.CONFIG_VIEW_FOCUS_COMMAND,
      configPanelMod.CONFIG_VIEW_ID + '.focus',
    );
  });

  it('registerConfigPanel registers provider with retainContextWhenHidden and never calls createWebviewPanel', () => {
    let registerCalls = 0;
    let registeredId: string | undefined;
    let registeredOptions: unknown;
    let createWebviewPanelCalls = 0;

    const fake = {
      window: {
        registerWebviewViewProvider: (viewId: string, _provider: unknown, options: unknown) => {
          registerCalls++;
          registeredId = viewId;
          registeredOptions = options;
          return { dispose: () => {} };
        },
        createWebviewPanel: () => {
          createWebviewPanelCalls++;
          throw new Error('createWebviewPanel must not be called');
        },
        showInformationMessage: async () => undefined,
        showWarningMessage: async () => undefined,
        showErrorMessage: async () => undefined,
      },
      commands: { executeCommand: async () => undefined },
      workspace: {
        createFileSystemWatcher: () => ({
          onDidCreate: () => ({ dispose: () => {} }),
          onDidChange: () => ({ dispose: () => {} }),
          onDidDelete: () => ({ dispose: () => {} }),
          dispose: () => {},
        }),
      },
    };
    (globalThis as unknown as { __vscodeFake: unknown }).__vscodeFake = fake;

    const extensionUri = { fsPath: process.cwd(), scheme: 'file' } as unknown as import('vscode').Uri;
    const disposable = configPanelMod.registerConfigPanel({
      extensionUri,
      resolveBaitonDir: () => path.join(process.cwd(), '.baiton'),
      agentIds: ['claude'],
      log: () => {},
    });

    assert.strictEqual(registerCalls, 1);
    assert.strictEqual(registeredId, configPanelMod.CONFIG_VIEW_ID);
    assert.deepStrictEqual(
      registeredOptions,
      configPanelMod.ConfigPanelProvider.registration,
    );
    assert.strictEqual(
      (registeredOptions as { webviewOptions: { retainContextWhenHidden: boolean } })?.webviewOptions
        ?.retainContextWhenHidden,
      true,
    );
    assert.strictEqual(createWebviewPanelCalls, 0);

    disposable.dispose();
  });

  it('resolveWebviewView sets enableScripts, restricts localResourceRoots to media, and renders valid CSP shell', () => {
    const extensionUri = { fsPath: process.cwd(), scheme: 'file' } as unknown as import('vscode').Uri;
    const provider = new configPanelMod.ConfigPanelProvider(extensionUri);
    const { fakeView, fakeWebview } = makeFakeWebviewView();

    provider.resolveWebviewView(fakeView);

    assert.strictEqual(fakeWebview.options.enableScripts, true);
    assert.ok(Array.isArray(fakeWebview.options.localResourceRoots));
    assert.strictEqual(fakeWebview.options.localResourceRoots.length, 1);
    const rootPath = fakeWebview.options.localResourceRoots[0].fsPath;
    assert.ok(
      rootPath.endsWith(path.join('', 'media')),
      `localResourceRoots must point to media directory, got: ${rootPath}`,
    );

    assert.ok(!fakeWebview.html.includes('${nonce}'), 'HTML must not have unreplaced ${nonce}');
    assert.ok(!fakeWebview.html.includes('${cspSource}'), 'HTML must not have unreplaced ${cspSource}');
    assert.ok(!fakeWebview.html.includes('${baseUri}'), 'HTML must not have unreplaced ${baseUri}');
    assert.match(fakeWebview.html, /script-src 'nonce-[0-9a-f]+'/);
  });

  it('flushes messages posted before the first resolve in order on resolve', () => {
    const extensionUri = { fsPath: process.cwd(), scheme: 'file' } as unknown as import('vscode').Uri;
    const provider = new configPanelMod.ConfigPanelProvider(extensionUri);

    provider.post({ type: 'loadFailed', kind: 'invalid', message: 'msg1', canReset: false });
    provider.post({ type: 'loadFailed', kind: 'invalid', message: 'msg2', canReset: false });

    const { fakeView, posted } = makeFakeWebviewView();
    assert.strictEqual(posted.length, 0, 'no messages posted before resolve');

    provider.resolveWebviewView(fakeView);

    assert.strictEqual(posted.length, 2);
    assert.strictEqual((posted[0] as { message: string }).message, 'msg1');
    assert.strictEqual((posted[1] as { message: string }).message, 'msg2');
  });

  it('a second resolve does not create a second watcher or controller', () => {
    let watcherCount = 0;
    let registeredProvider: { resolveWebviewView(webviewView: import('vscode').WebviewView): void } | undefined;

    const fake = {
      window: {
        registerWebviewViewProvider: (_id: string, provider: unknown) => {
          registeredProvider = provider as { resolveWebviewView(webviewView: import('vscode').WebviewView): void };
          return { dispose: () => {} };
        },
        showInformationMessage: async () => undefined,
        showWarningMessage: async () => undefined,
        showErrorMessage: async () => undefined,
      },
      commands: { executeCommand: async () => undefined },
      workspace: {
        createFileSystemWatcher: () => {
          watcherCount++;
          return {
            onDidCreate: () => ({ dispose: () => {} }),
            onDidChange: () => ({ dispose: () => {} }),
            onDidDelete: () => ({ dispose: () => {} }),
            dispose: () => {},
          };
        },
      },
    };
    (globalThis as unknown as { __vscodeFake: unknown }).__vscodeFake = fake;

    const extensionUri = { fsPath: process.cwd(), scheme: 'file' } as unknown as import('vscode').Uri;
    const disposable = configPanelMod.registerConfigPanel({
      extensionUri,
      resolveBaitonDir: () => path.join(process.cwd(), '.baiton'),
      agentIds: ['claude'],
      log: () => {},
    });

    assert.ok(registeredProvider, 'provider should be registered');
    const view1 = makeFakeWebviewView();
    registeredProvider.resolveWebviewView(view1.fakeView);
    assert.strictEqual(watcherCount, 1, 'first resolve creates one watcher');

    const view2 = makeFakeWebviewView();
    registeredProvider.resolveWebviewView(view2.fakeView);
    assert.strictEqual(watcherCount, 1, 'second resolve must not recreate watcher');

    disposable.dispose();
  });

  it('revealConfigPanel executes the focus command and shows unavailable message on rejection', async () => {
    let executedCommand: string | undefined;
    const infoMessages: string[] = [];

    // 1. Success path
    const successFake = {
      commands: {
        executeCommand: async (cmd: string) => {
          executedCommand = cmd;
        },
      },
      window: {
        showInformationMessage: async (msg: string) => {
          infoMessages.push(msg);
          return undefined;
        },
      },
    };
    (globalThis as unknown as { __vscodeFake: unknown }).__vscodeFake = successFake;

    await openConfigPanelViewMod.revealConfigPanel();
    assert.strictEqual(executedCommand, openConfigPanelViewMod.CONFIG_VIEW_FOCUS_COMMAND);
    assert.strictEqual(infoMessages.length, 0);

    // 2. Rejection path
    const rejectFake = {
      commands: {
        executeCommand: async () => {
          throw new Error('View focus command not found');
        },
      },
      window: {
        showInformationMessage: async (msg: string) => {
          infoMessages.push(msg);
          return undefined;
        },
      },
    };
    (globalThis as unknown as { __vscodeFake: unknown }).__vscodeFake = rejectFake;

    await openConfigPanelViewMod.revealConfigPanel();
    assert.deepStrictEqual(infoMessages, [
      openConfigPanelViewMod.CONFIG_VIEW_UNAVAILABLE_MESSAGE,
    ]);
  });

  it('posts loadFailed rather than throwing when resolveBaitonDir returns undefined', () => {
    let registeredProvider: { resolveWebviewView(webviewView: import('vscode').WebviewView): void } | undefined;

    const fake = {
      window: {
        registerWebviewViewProvider: (_id: string, provider: unknown) => {
          registeredProvider = provider as { resolveWebviewView(webviewView: import('vscode').WebviewView): void };
          return { dispose: () => {} };
        },
        showInformationMessage: async () => undefined,
        showWarningMessage: async () => undefined,
        showErrorMessage: async () => undefined,
      },
      commands: { executeCommand: async () => undefined },
      workspace: {
        createFileSystemWatcher: () => {
          throw new Error('should not create watcher without a workspace folder');
        },
      },
    };
    (globalThis as unknown as { __vscodeFake: unknown }).__vscodeFake = fake;

    const extensionUri = { fsPath: process.cwd(), scheme: 'file' } as unknown as import('vscode').Uri;
    const disposable = configPanelMod.registerConfigPanel({
      extensionUri,
      resolveBaitonDir: () => undefined,
      agentIds: ['claude'],
      log: () => {},
    });

    assert.ok(registeredProvider, 'provider should be registered');
    const { fakeView, posted } = makeFakeWebviewView();
    assert.doesNotThrow(() => {
      registeredProvider!.resolveWebviewView(fakeView);
    });

    assert.strictEqual(posted.length, 1);
    const msg = posted[0] as { type: string; kind: string; canReset: boolean; message: string };
    assert.strictEqual(msg.type, 'loadFailed');
    assert.strictEqual(msg.kind, 'invalid');
    assert.strictEqual(msg.canReset, false);
    assert.ok(msg.message.includes('requires exactly one workspace folder'));

    disposable.dispose();
  });
});
