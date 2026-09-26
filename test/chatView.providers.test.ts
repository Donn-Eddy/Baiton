import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { HostToWebview, ProviderGroup } from '../src/orchestrator/webviewProtocol';

/**
 * Fake-DOM unit tests for the provider-first model selection in
 * `media/chat.js` — the Provider & Model dropdown added by
 * multi-provider-orchestrator T08, split into two selects by
 * model-selector-refresh T14.
 *
 * `media/chat.js` and `media/protocol.js` are plain scripts (neither is
 * compiled or linted by the toolchain), so they are executed inside one `vm`
 * sandbox — the same pattern as `loadProtocolMirror()` in
 * `test/webviewProtocol.mirror.test.ts` — over a hand-rolled minimal DOM that
 * models only the surface chat.js touches.
 */

/** Class list over a Set, with the members chat.js exercises. */
class FakeClassList {
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
  toggle(c: string, force?: boolean): boolean {
    const on = force === undefined ? !this.set.has(c) : force;
    if (on) {
      this.set.add(c);
    } else {
      this.set.delete(c);
    }
    return this.set.has(c);
  }
}

/** A minimal DOM element covering exactly what chat.js touches. */
class FakeEl {
  readonly tagName: string;
  readonly children: FakeEl[] = [];
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly classList: FakeClassList;
  id = '';
  label = '';
  title = '';
  type = '';
  disabled = false;
  selected = false;
  checked = false;
  tabIndex = 0;
  open = false;
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  parentNode: FakeEl | null = null;
  private readonly attrs: Record<string, string> = {};
  private readonly handlers: Record<string, Array<(evt: unknown) => void>> = {};
  private textValue = '';
  private htmlValue = '';
  private valueStore = '';
  private classSet: Set<string>;

  constructor(tagName: string) {
    this.tagName = tagName.toUpperCase();
    this.classSet = new Set<string>();
    this.classList = new FakeClassList(this.classSet);
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

  get innerHTML(): string {
    return this.htmlValue;
  }

  set innerHTML(value: string) {
    this.htmlValue = String(value);
  }

  /** Real HTMLOptionsCollection semantics: options of the select and of its optgroups. */
  get options(): FakeEl[] {
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

  get selectedIndex(): number {
    const opts = this.options;
    for (let i = 0; i < opts.length; i++) {
      if (opts[i].selected) {
        return i;
      }
    }
    return -1;
  }

  set selectedIndex(index: number) {
    const opts = this.options;
    for (let i = 0; i < opts.length; i++) {
      opts[i].selected = i === index;
    }
  }

  get value(): string {
    if (this.tagName === 'SELECT') {
      const opts = this.options;
      for (const opt of opts) {
        if (opt.selected) {
          return opt.value;
        }
      }
    }
    return this.valueStore;
  }

  set value(v: string) {
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
      // No matching option leaves the value empty, like a real select.
      this.valueStore = '';
    }
  }

  get firstChild(): FakeEl | null {
    return this.children[0] ?? null;
  }

  get lastElementChild(): FakeEl | null {
    return this.children[this.children.length - 1] ?? null;
  }

  appendChild(node: FakeEl): FakeEl {
    this.detach(node);
    node.parentNode = this;
    this.children.push(node);
    return node;
  }

  insertBefore(node: FakeEl, ref: FakeEl | null): FakeEl {
    if (ref === null) {
      return this.appendChild(node);
    }
    this.detach(node);
    const index = this.children.indexOf(ref);
    node.parentNode = this;
    this.children.splice(index < 0 ? this.children.length : index, 0, node);
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
    // Not needed by these tests.
  }

  addEventListener(type: string, fn: (evt: unknown) => void): void {
    if (!this.handlers[type]) {
      this.handlers[type] = [];
    }
    this.handlers[type].push(fn);
  }

  /** Test-only dispatch recorded by {@link addEventListener}. */
  fire(type: string, evt: unknown = {}): void {
    for (const fn of this.handlers[type] ?? []) {
      fn(evt);
    }
  }

  private matches(selector: string): boolean {
    if (selector.startsWith('[') && selector.endsWith(']')) {
      return this.attrs[selector.slice(1, -1)] !== undefined;
    }
    if (selector.startsWith('.')) {
      return this.classList.contains(selector.slice(1));
    }
    return this.tagName === selector.toUpperCase();
  }

  querySelectorAll(selector: string): FakeEl[] {
    const out: FakeEl[] = [];
    for (const el of this.descendants()) {
      if (el.matches(selector)) {
        out.push(el);
      }
    }
    return out;
  }

  querySelector(selector: string): FakeEl | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }

  private *descendants(): Generator<FakeEl> {
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

/** Execute chat.js inside a fresh sandbox over the hand-rolled DOM. */
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
  const protocolSource = fs.readFileSync(path.join(mediaPath, 'protocol.js'), 'utf8');
  const chatSource = fs.readFileSync(path.join(mediaPath, 'chat.js'), 'utf8');
  vm.runInNewContext(protocolSource, sandbox, { filename: 'media/protocol.js' });
  vm.runInNewContext(chatSource, sandbox, { filename: 'media/chat.js' });

  const idsRef = ids;
  const postedRef = posted;
  return {
    ids: idsRef,
    posted: postedRef,
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


/**
 * The configured provider groups in host order — the router now posts only
 * providers that are configured, so every group is enabled. One builtin id, one
 * feed-derived id, a `custom` model, and one group whose catalog snapshot went
 * stale.
 */
function providerFixture(): ProviderGroup[] {
  return [
    {
      id: 'copilot',
      label: 'GitHub Copilot',
      enabled: true,
      models: [
        { id: 'gpt-5', label: 'GPT-5' },
        { id: 'claude-sonnet-4', label: 'Claude Sonnet 4' },
      ],
    },
    {
      id: 'anthropic',
      label: 'Anthropic',
      enabled: true,
      models: [
        { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
        { id: 'claude-sonnet-5', label: 'Claude Sonnet 5', custom: true },
      ],
    },
    {
      id: 'opencode',
      label: 'OpenCode Zen',
      enabled: true,
      stale: true,
      staleReason: 'models.dev fetch failed: ETIMEDOUT',
      models: [{ id: 'zen-coder', label: 'Zen Coder' }],
    },
  ];
}

/** The same list with one group shown as configured-but-unusable. */
function withDisabled(): ProviderGroup[] {
  return providerFixture().map((g) =>
    g.id === 'opencode'
      ? { ...g, enabled: false, reason: 'OpenCode Zen is not reachable.', models: [] }
      : g,
  );
}

/** The index of the provider option carrying this id. */
function providerIndex(select: FakeEl, id: string): number {
  const index = select.options.findIndex((o) => o.dataset.provider === id);
  assert.ok(index >= 0, `provider option ${id} exists`);
  return index;
}

describe('chat view provider-first model selector (model-selector-refresh T14)', () => {
  it('seed paint: a disabled placeholder in each select, no Set API key, no stale badge', () => {
    const view = loadChatView();
    const providers = view.ids['provider-select'];
    const models = view.ids['model-select'];
    assert.strictEqual(providers.options.length, 1);
    assert.strictEqual(providers.options[0].disabled, true);
    assert.strictEqual(providers.options[0].selected, true);
    assert.strictEqual(models.options.length, 1);
    assert.strictEqual(models.options[0].disabled, true);
    assert.strictEqual(models.options[0].selected, true);
    assert.strictEqual(view.ids['model-set-key'].classList.contains('visible'), false);
    assert.strictEqual(view.ids['model-stale'].textContent, '');
    assert.strictEqual(view.ids['model-stale'].classList.contains('visible'), false);
  });

  it('setProviders lists the posted groups in host order and only the chosen provider models', () => {
    const view = loadChatView();
    view.send({ type: 'setProviders', groups: providerFixture(), selection: null });
    const providers = view.ids['provider-select'];
    assert.deepStrictEqual(
      providers.options.map((o) => o.value),
      ['copilot', 'anthropic', 'opencode'],
    );
    assert.deepStrictEqual(
      providers.options.map((o) => o.textContent),
      ['GitHub Copilot', 'Anthropic', 'OpenCode Zen'],
    );

    const models = view.ids['model-select'];
    assert.strictEqual(
      models.children.filter((c) => c.tagName === 'OPTGROUP').length,
      0,
      'the model select carries no optgroups',
    );
    // The first configured provider with models is chosen, so only its models
    // are offered; a provider the host omitted appears in neither select.
    assert.deepStrictEqual(
      models.options.filter((o) => !o.disabled).map((o) => o.value),
      ['copilot/gpt-5', 'copilot/claude-sonnet-4'],
    );
    assert.strictEqual(
      providers.options.some((o) => o.value === 'mistral'),
      false,
    );
  });

  it('a selection drives both selects', () => {
    const view = loadChatView();
    view.send({
      type: 'setProviders',
      groups: providerFixture(),
      selection: { provider: 'anthropic', model: 'claude-opus-5-5' },
    });
    assert.strictEqual(view.ids['provider-select'].value, 'anthropic');
    const models = view.ids['model-select'];
    const selected = models.options.find((o) => o.selected);
    assert.ok(selected, 'a model option is selected');
    assert.strictEqual(selected.value, 'anthropic/claude-opus-5-5');
    assert.strictEqual(selected.dataset.provider, 'anthropic');
    assert.strictEqual(selected.dataset.model, 'claude-opus-5-5');
    assert.strictEqual(models.value, 'anthropic/claude-opus-5-5');
  });

  it('changing the provider repaints the models and posts nothing; picking a model posts once', () => {
    const view = loadChatView();
    view.send({ type: 'setProviders', groups: providerFixture(), selection: null });
    const providers = view.ids['provider-select'];
    const models = view.ids['model-select'];

    providers.selectedIndex = providerIndex(providers, 'opencode');
    providers.fire('change', {});
    assert.deepStrictEqual(
      models.options.filter((o) => !o.disabled).map((o) => o.value),
      ['opencode/zen-coder'],
    );
    assert.strictEqual(view.posted.length, 0, 'picking a provider posts nothing');

    models.selectedIndex = models.options.findIndex((o) => o.value === 'opencode/zen-coder');
    models.fire('change', {});
    assert.deepStrictEqual(view.posted.map(plainClone), [
      { type: 'selectModel', provider: 'opencode', model: 'zen-coder' },
    ]);

    // Re-picking the already-active pair: nothing.
    view.send({
      type: 'setProviders',
      groups: providerFixture(),
      selection: { provider: 'opencode', model: 'zen-coder' },
    });
    models.fire('change', {});
    assert.strictEqual(view.posted.length, 1);
  });

  it('a disabled model row repaints rather than posting', () => {
    const view = loadChatView();
    view.send({ type: 'setProviders', groups: withDisabled(), selection: null });
    const providers = view.ids['provider-select'];
    const models = view.ids['model-select'];
    const disabled = providers.options[providerIndex(providers, 'opencode')];
    assert.strictEqual(disabled.disabled, true);
    assert.strictEqual(disabled.title, 'OpenCode Zen is not reachable.');

    providers.selectedIndex = providerIndex(providers, 'opencode');
    providers.fire('change', {});
    assert.strictEqual(models.options.length, 2, 'the reason row plus the placeholder');
    assert.strictEqual(
      models.options.some((o) => o.textContent === 'OpenCode Zen is not reachable.'),
      true,
    );
    models.selectedIndex = models.options.findIndex(
      (o) => o.textContent === 'OpenCode Zen is not reachable.',
    );
    models.fire('change', {});
    assert.strictEqual(view.posted.length, 0);
  });

  it('custom values stay visible, selected and postable', () => {
    // A model flagged custom keeps the suffix but posts its bare id.
    const view = loadChatView();
    view.send({ type: 'setProviders', groups: providerFixture(), selection: null });
    const providers = view.ids['provider-select'];
    const models = view.ids['model-select'];
    providers.selectedIndex = providerIndex(providers, 'anthropic');
    providers.fire('change', {});
    const custom = models.options.find((o) => o.dataset.model === 'claude-sonnet-5');
    assert.ok(custom);
    assert.strictEqual(custom.textContent, 'Claude Sonnet 5 (custom)');
    models.selectedIndex = models.options.indexOf(custom);
    models.fire('change', {});
    assert.deepStrictEqual(view.posted.map(plainClone), [
      { type: 'selectModel', provider: 'anthropic', model: 'claude-sonnet-5' },
    ]);

    // A selection whose model is absent from the group: appended, selectable.
    const missingModel = loadChatView();
    missingModel.send({
      type: 'setProviders',
      groups: providerFixture(),
      selection: { provider: 'copilot', model: 'gpt-4.1' },
    });
    const mm = missingModel.ids['model-select'];
    const appended = mm.options[mm.options.length - 1];
    assert.strictEqual(appended.textContent, 'gpt-4.1 (custom)');
    assert.strictEqual(appended.disabled, false);
    assert.strictEqual(appended.selected, true);
    assert.strictEqual(mm.value, 'copilot/gpt-4.1');
    assert.strictEqual(missingModel.posted.length, 0);

    // A selection whose provider is absent from the groups: leading option.
    const missingProvider = loadChatView();
    missingProvider.send({
      type: 'setProviders',
      groups: providerFixture(),
      selection: { provider: 'mystery', model: 'm1' },
    });
    const mp = missingProvider.ids['provider-select'];
    assert.strictEqual(mp.options[0].value, 'mystery');
    assert.strictEqual(mp.options[0].textContent, 'mystery (custom)');
    assert.strictEqual(mp.options[0].dataset.custom, '1');
    assert.strictEqual(mp.options[0].selected, true);
    assert.strictEqual(mp.value, 'mystery');
    assert.strictEqual(missingProvider.ids['model-select'].value, 'mystery/m1');
    assert.strictEqual(missingProvider.posted.length, 0);
  });

  it('the stale badge follows the chosen provider', () => {
    const view = loadChatView();
    view.send({
      type: 'setProviders',
      groups: providerFixture(),
      selection: { provider: 'opencode', model: 'zen-coder' },
      refreshedAt: '2026-09-25T10:00:00.000Z',
    });
    const badge = view.ids['model-stale'];
    assert.strictEqual(badge.classList.contains('visible'), true);
    assert.ok(badge.textContent.startsWith('stale — showing last known models'));
    assert.ok(badge.textContent.includes('2026-09-25T10:00:00.000Z'));
    assert.strictEqual(badge.title, 'models.dev fetch failed: ETIMEDOUT');

    // Switching to a fresh provider clears text, class and the title attribute.
    const providers = view.ids['provider-select'];
    providers.selectedIndex = providerIndex(providers, 'copilot');
    providers.fire('change', {});
    assert.strictEqual(badge.textContent, '');
    assert.strictEqual(badge.classList.contains('visible'), false);
    assert.strictEqual(badge.getAttribute('title'), null);
  });

  it('the Set API key affordance tracks unusable providers and posts triggerFix', () => {
    const view = loadChatView();
    const setKey = view.ids['model-set-key'];
    view.send({ type: 'setProviders', groups: providerFixture(), selection: null });
    assert.strictEqual(setKey.classList.contains('visible'), false, 'all configured');
    assert.strictEqual(setKey.title, '');

    view.send({ type: 'setProviders', groups: withDisabled(), selection: null });
    assert.strictEqual(setKey.classList.contains('visible'), true);
    assert.ok(setKey.title.length > 0);

    // Configured providers that offer no model at all: still a way in.
    const modelless = providerFixture().map((g) => ({ ...g, models: [] }));
    view.send({ type: 'setProviders', groups: modelless, selection: null });
    assert.strictEqual(setKey.classList.contains('visible'), true);
    assert.ok(setKey.title.length > 0);

    setKey.fire('click', {});
    assert.deepStrictEqual(view.posted.map(plainClone), [
      { type: 'triggerFix', action: 'setApiKey' },
    ]);
  });

  it('setBusy disables both selects while true and re-enables them after', () => {
    const view = loadChatView();
    view.send({ type: 'setProviders', groups: providerFixture(), selection: null });
    const providers = view.ids['provider-select'];
    const models = view.ids['model-select'];
    assert.strictEqual(providers.disabled, false);
    assert.strictEqual(models.disabled, false, 'enabled models exist');
    view.send({ type: 'setBusy', busy: true });
    assert.strictEqual(providers.disabled, true);
    assert.strictEqual(models.disabled, true);
    view.send({ type: 'setBusy', busy: false });
    assert.strictEqual(providers.disabled, false);
    assert.strictEqual(models.disabled, false);
  });

  it('the empty state shows the provider label and model, falling back when unselected', () => {
    const view = loadChatView();
    view.send({ type: 'setEmptyState', endpoint: 'https://example.invalid', model: 'gpt-5' });
    view.send({ type: 'setProviders', groups: providerFixture(), selection: null });
    assert.strictEqual(view.ids['empty-provider'].textContent, 'not configured');
    assert.strictEqual(view.ids['empty-model'].textContent, 'gpt-5');

    // With a matching selection the provider label replaces the endpoint URL.
    view.send({
      type: 'setProviders',
      groups: providerFixture(),
      selection: { provider: 'copilot', model: 'gpt-5' },
    });
    assert.strictEqual(view.ids['empty-provider'].textContent, 'GitHub Copilot');
    assert.strictEqual(view.ids['empty-model'].textContent, 'gpt-5');
  });
});
