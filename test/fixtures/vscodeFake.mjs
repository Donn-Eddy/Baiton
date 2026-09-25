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
  showQuickPick: (items, options) => fake().window.showQuickPick(items, options),
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

// --- Language-model surface (copilotClient tests) ---------------------------
// Host interactions delegate to `fake()`; these value classes are concrete
// exports, like Disposable/Uri/ViewColumn above.

/** The roles usable in `LanguageModelChatMessage` (no system role in vscode.lm). */
export const LanguageModelChatMessageRole = { User: 1, Assistant: 2 };

/** A piece of assistant text, or one message content part. */
export class LanguageModelTextPart {
  constructor(value) {
    this.value = value;
  }
}

/** The model's request to call a tool. */
export class LanguageModelToolCallPart {
  constructor(callId, name, input) {
    this.callId = callId;
    this.name = name;
    this.input = input;
  }
}

/** A tool result; only ever carried by a User message. */
export class LanguageModelToolResultPart {
  constructor(callId, content) {
    this.callId = callId;
    this.content = content;
  }
}

/** One chat message; string content is normalised to a text part array. */
export class LanguageModelChatMessage {
  constructor(role, content, name) {
    this.role = role;
    this.content =
      typeof content === 'string' ? [new LanguageModelTextPart(content)] : content;
    this.name = name;
  }
  static User(content, name) {
    return new LanguageModelChatMessage(LanguageModelChatMessageRole.User, content, name);
  }
  static Assistant(content, name) {
    return new LanguageModelChatMessage(LanguageModelChatMessageRole.Assistant, content, name);
  }
}

/** Whether the model may optionally (Auto) or must (Required) use tools. */
export const LanguageModelChatToolMode = { Auto: 1, Required: 2 };

/** The error `vscode.lm` rejects with; identified by its `code`, not instanceof. */
export class LanguageModelError extends Error {
  constructor(code, message) {
    super(message ?? code);
    this.name = 'LanguageModelError';
    this.code = code;
  }
  static NotFound(m) {
    return new LanguageModelError('NotFound', m);
  }
  static NoPermissions(m) {
    return new LanguageModelError('NoPermissions', m);
  }
  static Blocked(m) {
    return new LanguageModelError('Blocked', m);
  }
}

/** A real working cancellation token source, so abort paths are testable. */
export class CancellationTokenSource {
  #cancelled = false;
  #listeners = [];
  #disposed = false;

  /** Whether cancellation has been requested. */
  get isCancellationRequested() {
    return this.#cancelled;
  }

  /** Whether `dispose()` has run. */
  get disposed() {
    return this.#disposed;
  }

  /** The token itself. */
  get token() {
    const source = this;
    return {
      get isCancellationRequested() {
        return source.isCancellationRequested;
      },
      onCancellationRequested(cb) {
        if (source.#cancelled) {
          cb();
        } else {
          source.#listeners.push(cb);
        }
        return { dispose() {} };
      },
    };
  }

  /** Fire every listener once. */
  cancel() {
    if (this.#cancelled) {
      return;
    }
    this.#cancelled = true;
    for (const cb of this.#listeners) {
      cb();
    }
    this.#listeners = [];
  }

  /** Mark disposed and drop the listeners. */
  dispose() {
    this.#disposed = true;
    this.#listeners = [];
  }
}

/** Model selection, delegating so each test supplies its own model list. */
export const lm = {
  selectChatModels: (selector) => fake().lm.selectChatModels(selector),
};
