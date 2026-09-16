/**
 * A fake `vscode` module for host-free unit tests (Task 13.3, config-panel T11).
 *
 * The extension source imports `vscode` as a bare specifier, but there is no
 * requireable `vscode` runtime outside a running VS Code host. `vscodeLoader.mjs`
 * redirects that bare specifier to this module so glue code such as
 * `setOrchestratorApiKey` and `configPanel` can be exercised without a host.
 *
 * The module is stateless: each member delegates to the mutable fake
 * a test installs on `globalThis.__vscodeFake`. Delegating (rather than closing
 * over state) lets a test swap the fake between cases while this module stays a
 * singleton in the loader graph.
 */

/** The live fake a test has installed, or a throwing guard when none is set. */
function fake() {
  const installed = globalThis.__vscodeFake;
  if (!installed) {
    throw new Error('No vscode fake installed on globalThis.__vscodeFake');
  }
  return installed;
}

export const window = {
  showInputBox: (options) => fake().window.showInputBox(options),
  showInformationMessage: (message, ...args) => fake().window.showInformationMessage(message, ...args),
  showWarningMessage: (message, ...args) => fake().window.showWarningMessage(message, ...args),
  showErrorMessage: (message, ...args) => fake().window.showErrorMessage(message, ...args),
  registerWebviewViewProvider: (viewId, provider, options) =>
    fake().window.registerWebviewViewProvider(viewId, provider, options),
};

export const commands = {
  executeCommand: (command, ...args) => fake().commands.executeCommand(command, ...args),
};

export const workspace = {
  createFileSystemWatcher: (pattern, ...args) =>
    fake().workspace.createFileSystemWatcher(pattern, ...args),
};

export class RelativePattern {
  constructor(base, pattern) {
    if (fake().RelativePattern) {
      return new (fake().RelativePattern)(base, pattern);
    }
    this.base = base;
    this.pattern = pattern;
  }
}

export const Uri = {
  file: (path) => (fake().Uri?.file ? fake().Uri.file(path) : { fsPath: path, path, scheme: 'file' }),
  joinPath: (base, ...segments) =>
    fake().Uri?.joinPath
      ? fake().Uri.joinPath(base, ...segments)
      : {
          fsPath: [base.fsPath || base.path, ...segments].join('/').replace(/\/+/g, '/'),
          path: [base.path || base.fsPath, ...segments].join('/').replace(/\/+/g, '/'),
          scheme: base.scheme || 'file',
        },
};

export class Disposable {
  constructor(callOnDispose) {
    this.callOnDispose = callOnDispose;
  }
  dispose() {
    this.callOnDispose?.();
  }
  static from(...disposables) {
    if (fake().Disposable?.from) {
      return fake().Disposable.from(...disposables);
    }
    return new Disposable(() => {
      for (const d of disposables) {
        d?.dispose?.();
      }
    });
  }
}

export const ViewColumn = {
  Active: -1,
  Beside: -2,
  One: 1,
  Two: 2,
  Three: 3,
};
