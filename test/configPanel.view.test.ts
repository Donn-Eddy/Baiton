import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
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

/* ------------------------------------------------------------------------- *
 * Fake-DOM suite for the out-of-band option refresh (model-selector-refresh
 * T09). media/config.js is a plain script that neither tsc nor eslint sees, so
 * it is executed inside a `vm` sandbox over a hand-rolled minimal DOM — the
 * same pattern as `loadChatView()` in test/chatView.providers.test.ts. This
 * suite is deliberately self-contained: it never imports `vscode` and does not
 * depend on the loader registered by the suite above, so the order in which the
 * two run cannot matter.
 * ------------------------------------------------------------------------- */

/** Class list over a Set, with the members config.js exercises. */
class ViewClassList {
  constructor(private readonly set: Set<string>) {}
  add(c: string): void {
    this.set.add(c);
  }
  remove(c: string): void {
    this.set.delete(c);
  }
  contains(c: string): boolean {
    return this.set.has(c);
  }
}

/** A minimal DOM element covering exactly what media/config.js touches. */
class ViewEl {
  readonly tagName: string;
  readonly children: ViewEl[] = [];
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly classList: ViewClassList;
  id = '';
  htmlFor = '';
  type = '';
  rel = '';
  target = '';
  disabled = false;
  selected = false;
  parentNode: ViewEl | null = null;
  private readonly attrs: Record<string, string> = {};
  private readonly handlers: Record<string, Array<(evt: unknown) => void>> = {};
  private textValue = '';
  private valueStore = '';
  private readonly classSet: Set<string>;

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
    this.classSet = new Set<string>();
    this.classList = new ViewClassList(this.classSet);
  }

  get className(): string {
    return Array.from(this.classSet).join(' ');
  }

  set className(value: string) {
    this.classSet.clear();
    String(value)
      .split(/\s+/)
      .filter(Boolean)
      .forEach((t) => this.classSet.add(t));
  }

  /** Reflected attributes, so `removeAttribute` really clears the property. */
  get title(): string {
    return this.attrs.title ?? '';
  }

  set title(value: string) {
    this.attrs.title = String(value);
  }

  get href(): string {
    return this.attrs.href ?? '';
  }

  set href(value: string) {
    this.attrs.href = String(value);
  }

  get textContent(): string {
    if (this.children.length > 0) {
      let out = '';
      for (const child of this.children) {
        out += child.textContent;
      }
      return out;
    }
    return this.textValue;
  }

  set textContent(value: string) {
    for (const child of this.children) {
      child.parentNode = null;
    }
    this.children.length = 0;
    this.textValue = String(value);
  }

  get options(): ViewEl[] {
    return this.children.filter((c) => c.tagName === 'OPTION');
  }

  get value(): string {
    if (this.tagName === 'SELECT') {
      for (const opt of this.options) {
        if (opt.selected) {
          return opt.value;
        }
      }
      return '';
    }
    return this.valueStore;
  }

  set value(v: string) {
    if (this.tagName !== 'SELECT') {
      this.valueStore = String(v);
      return;
    }
    const opts = this.options;
    const found = opts.find((o) => o.value === v);
    for (const opt of opts) {
      opt.selected = found !== undefined && opt === found;
    }
    // No matching option leaves the value empty, like a real select.
    this.valueStore = found ? found.value : '';
  }

  appendChild(node: ViewEl): ViewEl {
    this.detach(node);
    node.parentNode = this;
    this.children.push(node);
    return node;
  }

  insertBefore(node: ViewEl, ref: ViewEl | null): ViewEl {
    if (ref === null) {
      return this.appendChild(node);
    }
    this.detach(node);
    const index = this.children.indexOf(ref);
    node.parentNode = this;
    this.children.splice(index < 0 ? this.children.length : index, 0, node);
    return node;
  }

  removeChild(node: ViewEl): ViewEl {
    const index = this.children.indexOf(node);
    if (index >= 0) {
      this.children.splice(index, 1);
      node.parentNode = null;
    }
    return node;
  }

  setAttribute(name: string, value: string): void {
    this.attrs[name] = String(value);
  }

  getAttribute(name: string): string | null {
    const value = this.attrs[name];
    return value === undefined ? null : value;
  }

  removeAttribute(name: string): void {
    // eslint-disable-next-line @typescript-eslint/no-dynamic-delete
    delete this.attrs[name];
  }

  focus(): void {
    // The sandbox's `document.activeElement` is set explicitly by the tests.
  }

  addEventListener(type: string, fn: (evt: unknown) => void): void {
    if (!this.handlers[type]) {
      this.handlers[type] = [];
    }
    this.handlers[type].push(fn);
  }

  /** Test-only dispatch over the handlers recorded by {@link addEventListener}. */
  fire(type: string, evt: unknown = {}): void {
    for (const fn of this.handlers[type] ?? []) {
      fn(evt);
    }
  }

  private matchesOne(selector: string): boolean {
    const sel = selector.trim();
    if (sel.startsWith('[') && sel.endsWith(']')) {
      const body = sel.slice(1, -1);
      const eq = body.indexOf('=');
      const name = eq === -1 ? body : body.slice(0, eq);
      const want = eq === -1 ? undefined : body.slice(eq + 1).replace(/^["']|["']$/g, '');
      // data-* attributes live on `dataset` in the elements config.js builds.
      const actual = name.startsWith('data-')
        ? this.dataset[
            name
              .slice(5)
              .replace(/-([a-z])/g, (_m, c: string) => c.toUpperCase())
          ] ?? this.attrs[name]
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

  querySelectorAll(selector: string): ViewEl[] {
    const out: ViewEl[] = [];
    for (const el of this.descendants()) {
      if (el.matches(selector)) {
        out.push(el);
      }
    }
    return out;
  }

  querySelector(selector: string): ViewEl | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  *descendants(): Generator<ViewEl> {
    for (const child of this.children) {
      yield child;
      yield* child.descendants();
    }
  }

  private detach(node: ViewEl): void {
    if (node.parentNode) {
      node.parentNode.removeChild(node);
    }
    node.parentNode = null;
  }
}

type ViewConfigForm = import('../src/config/configPanel').ConfigForm;
type ViewConfigFormOptions = import('../src/config/configPanel').ConfigFormOptions;
type ViewAgentStaleness = import('../src/config/configPanel').AgentStaleness;
type ViewHostMessage = import('../src/config/configPanel').ConfigPanelHostToWebview;

/** ROLES, duplicated so this suite needs no `vscode`-tainted import. */
const VIEW_ROLES = [
  'spec-writer',
  'planner',
  'plan-reviewer',
  'executor',
  'reviewer',
  'pr-writer',
] as const;

const OTHER_SENTINEL = '\u0000other';

interface ConfigView {
  ids: Record<string, ViewEl>;
  posted: unknown[];
  send(msg: ViewHostMessage | { type: string }): void;
  setActive(el: ViewEl | null): void;
  byId(id: string): ViewEl;
}

/** Execute media/config.js inside a fresh sandbox over the hand-rolled DOM. */
function loadConfigView(): ConfigView {
  const ids: Record<string, ViewEl> = {};
  const make = (id: string, tag: string, dataPath?: string): ViewEl => {
    const el = new ViewEl(tag);
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
  const limitPlan = make('limit-plan_review_rounds', 'input', 'limits.plan_review_rounds');
  const limitExec = make('limit-exec_attempts', 'input', 'limits.exec_attempts');
  const limitStall = make('limit-stall_notice_minutes', 'input', 'limits.stall_notice_minutes');
  const gitRemote = make('git-remote', 'input', 'git.remote');
  const gitBase = make('git-base', 'input', 'git.base');

  // Mirror the markup's containment so formEl.querySelectorAll reaches
  // everything the renderer touches.
  const rolesFieldset = new ViewEl('fieldset');
  rolesFieldset.appendChild(rolesBody);
  formEl.appendChild(rolesFieldset);
  for (const control of [limitPlan, limitExec, limitStall, gitRemote, gitBase]) {
    const row = new ViewEl('div');
    row.className = 'field-row';
    row.appendChild(control);
    const err = new ViewEl('div');
    err.className = 'field-error';
    err.dataset.errorFor = control.dataset.path;
    row.appendChild(err);
    formEl.appendChild(row);
  }

  const posted: unknown[] = [];
  let persistedState: unknown = {};
  let messageListener: ((event: { data: unknown }) => void) | null = null;

  const documentStub = {
    createElement: (tag: string) => new ViewEl(tag),
    getElementById: (id: string): ViewEl | null => {
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
    activeElement: null as ViewEl | null,
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

  const source = fs.readFileSync(path.join(__dirname, '..', 'media', 'config.js'), 'utf8');
  vm.runInNewContext(source, sandbox, { filename: 'media/config.js' });

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

function viewForm(overrides?: Partial<Record<string, { agent: string; model: string; effort: string }>>): ViewConfigForm {
  const roles = {} as ViewConfigForm['roles'];
  for (const role of VIEW_ROLES) {
    roles[role] = overrides?.[role]
      ? { ...overrides[role]! }
      : { agent: 'claude', model: 'claude-sonnet-5', effort: 'high' };
  }
  return {
    roles,
    limits: { plan_review_rounds: '1', exec_attempts: '3', stall_notice_minutes: '10' },
    git: { remote: 'origin', base: 'main' },
  };
}

function viewOptions(
  models: readonly string[] = ['claude-sonnet-5', 'claude-opus-5'],
  efforts: readonly string[] = ['high', 'low'],
  agents: readonly string[] = ['claude'],
): ViewConfigFormOptions {
  return {
    agents,
    byAgent: {
      claude: { models: [...models], efforts: [...efforts], modelLink: 'https://example.invalid/models' },
    },
  };
}

/** Values of the dynamic (non-static) options of a select, in order. */
function dynamicValues(select: ViewEl): string[] {
  return select.children
    .filter((c) => c.tagName === 'OPTION' && c.dataset.static === undefined)
    .map((c) => c.value);
}

describe('config panel webview options refresh (model-selector-refresh T09)', () => {
  function loadedView(
    options: ViewConfigFormOptions = viewOptions(),
    form: ViewConfigForm = viewForm(),
  ): ConfigView {
    const view = loadConfigView();
    view.send({ type: 'loaded', form, token: 'tok-1', options });
    return view;
  }

  function refresh(
    view: ConfigView,
    options: ViewConfigFormOptions,
    stale: Record<string, ViewAgentStaleness> = {},
  ): void {
    view.send({ type: 'optionsChanged', options, stale });
  }

  it('builds six role groups with the model and effort option lists from loaded', () => {
    const view = loadedView();
    assert.strictEqual(view.ids['config-form'].querySelectorAll('.role-group').length, 6);

    const modelSelect = view.byId('role-executor-model-select');
    assert.deepStrictEqual(dynamicValues(modelSelect), ['claude-sonnet-5', 'claude-opus-5']);
    const modelOpts = modelSelect.options;
    assert.strictEqual(modelOpts[modelOpts.length - 1].value, OTHER_SENTINEL);
    assert.strictEqual(modelOpts[modelOpts.length - 1].textContent, 'Other…');

    const effortSelect = view.byId('role-executor-effort-select');
    assert.strictEqual(effortSelect.options[0].value, '');
    assert.strictEqual(effortSelect.options[0].textContent, '(default)');
    assert.deepStrictEqual(dynamicValues(effortSelect), ['high', 'low']);
  });

  it('optionsChanged replaces the model options in place, keeping node identity and selection', () => {
    const view = loadedView();
    const before = view.byId('role-executor-model-select');
    assert.strictEqual(before.value, 'claude-sonnet-5');

    refresh(view, viewOptions(['claude-sonnet-5', 'claude-opus-5', 'claude-fable-5-1']));

    const after = view.byId('role-executor-model-select');
    assert.strictEqual(after, before, 'the select node must be reused, not rebuilt');
    assert.deepStrictEqual(dynamicValues(after), [
      'claude-sonnet-5',
      'claude-opus-5',
      'claude-fable-5-1',
    ]);
    const opts = after.options;
    assert.strictEqual(opts[opts.length - 1].value, OTHER_SENTINEL);
    assert.strictEqual(after.value, 'claude-sonnet-5', 'the selected model must survive the refresh');
  });

  it('optionsChanged does not reset in-progress edits or post anything', () => {
    const view = loadedView();
    const remote = view.ids['git-remote'];
    remote.value = 'upstream';
    view.ids['config-form'].fire('input', { target: remote });
    assert.strictEqual(view.ids['save'].disabled, false, 'dirty valid form enables Save');

    const postedBefore = view.posted.length;
    refresh(view, viewOptions(['claude-sonnet-5', 'claude-opus-5', 'claude-fable-5-1']));

    assert.strictEqual(remote.value, 'upstream');
    assert.strictEqual(view.ids['save'].disabled, false, 'Save must stay enabled across a refresh');
    const newPosts = view.posted.slice(postedBefore) as Array<{ type: string }>;
    assert.deepStrictEqual(
      newPosts.filter((m) => m.type === 'load' || m.type === 'save'),
      [],
      'a refresh must not trigger a load or a save',
    );
  });

  it('optionsChanged never overwrites the focused control', () => {
    const view = loadedView();
    const select = view.byId('role-planner-model-select');
    select.value = OTHER_SENTINEL;
    view.ids['config-form'].fire('change', { target: select });
    const input = view.byId('role-planner-model-input');
    input.value = 'half-typed-mod';
    view.setActive(input);

    refresh(view, viewOptions(['claude-sonnet-5', 'claude-opus-5', 'claude-fable-5-1']));

    assert.strictEqual(input.value, 'half-typed-mod');
  });

  it('an Other… model entry stays editable when the refreshed list contains it', () => {
    const view = loadedView();
    const select = view.byId('role-reviewer-model-select');
    select.value = OTHER_SENTINEL;
    view.ids['config-form'].fire('change', { target: select });
    const input = view.byId('role-reviewer-model-input');
    input.value = 'my-custom-model';
    view.ids['config-form'].fire('input', { target: input });

    refresh(view, viewOptions(['claude-sonnet-5', 'my-custom-model']));

    assert.notStrictEqual(input.style.display, 'none', 'the custom-model input must stay visible');
    assert.strictEqual(input.value, 'my-custom-model');
    assert.strictEqual(select.value, OTHER_SENTINEL);
  });

  it('an Other… effort entry with an empty input does not snap back to (default)', () => {
    const view = loadedView();
    const select = view.byId('role-reviewer-effort-select');
    select.value = OTHER_SENTINEL;
    view.ids['config-form'].fire('change', { target: select });
    const input = view.byId('role-reviewer-effort-input');
    assert.notStrictEqual(input.style.display, 'none');

    refresh(view, viewOptions(undefined, ['high', 'low', 'medium']));

    assert.notStrictEqual(input.style.display, 'none', 'the effort input must stay visible');
    assert.strictEqual(input.value, '');
    assert.strictEqual(select.value, OTHER_SENTINEL);
  });

  it('renders the stale badge for every role bound to the stale agent and clears it again', () => {
    const view = loadedView(viewOptions(undefined, undefined, ['claude', 'codex']), viewForm({
      'pr-writer': { agent: 'codex', model: 'gpt-x', effort: '' },
    }));

    refresh(view, viewOptions(undefined, undefined, ['claude', 'codex']), {
      claude: {
        stale: true,
        reason: 'models.dev fetch failed',
        fetchedAt: '2026-09-01T00:00:00.000Z',
      },
    });

    for (const role of VIEW_ROLES) {
      const note = view.byId(`role-${role}-stale`);
      if (role === 'pr-writer') {
        assert.strictEqual(note.textContent, '', 'a role on a fresh agent gets no badge');
        assert.strictEqual(note.classList.contains('visible'), false);
        continue;
      }
      assert.ok(
        note.textContent.startsWith('stale — showing last known models'),
        `role ${role} should show the stale note, got "${note.textContent}"`,
      );
      assert.ok(note.textContent.includes('(last updated 2026-09-01T00:00:00.000Z)'));
      assert.strictEqual(note.title, 'models.dev fetch failed');
      assert.strictEqual(note.classList.contains('visible'), true);
    }

    refresh(view, viewOptions(undefined, undefined, ['claude', 'codex']), {});
    for (const role of VIEW_ROLES) {
      const note = view.byId(`role-${role}-stale`);
      assert.strictEqual(note.textContent, '');
      assert.strictEqual(note.classList.contains('visible'), false);
    }
  });

  it('a new agent id appears in every role select and a configured-but-absent agent round-trips', () => {
    const view = loadedView(viewOptions(), viewForm({
      'pr-writer': { agent: 'codex', model: 'gpt-x', effort: '' },
    }));

    refresh(view, {
      agents: ['claude', 'opencode'],
      byAgent: viewOptions().byAgent,
    });

    for (const role of VIEW_ROLES) {
      const agentSelect = view.byId(`role-${role}-agent`);
      assert.ok(
        agentSelect.options.some((o) => o.value === 'opencode'),
        `role ${role} should list the newly installed agent`,
      );
    }
    const prAgent = view.byId('role-pr-writer-agent');
    assert.ok(
      prAgent.options.some((o) => o.value === 'codex'),
      'the configured agent must stay listed even when it is not installed',
    );
    assert.strictEqual(prAgent.value, 'codex', 'and must stay selected');
  });

  it('an unknown message type leaves the rendered options unchanged', () => {
    const view = loadedView();
    const select = view.byId('role-executor-model-select');
    const before = dynamicValues(select);

    view.send({ type: 'somethingElse' });

    assert.deepStrictEqual(dynamicValues(select), before);
    assert.strictEqual(select.value, 'claude-sonnet-5');
  });
});
