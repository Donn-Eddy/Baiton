import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { HostToWebview, ProviderGroup } from '../src/orchestrator/webviewProtocol';

/**
 * Fake-DOM unit tests for the Provider & Model dropdown projection added to
 * `media/chat.js` by multi-provider-orchestrator T08.
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
  ['model-select', 'select'],
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


/** The five provider groups in catalog order; the five-providers scenario. */
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
      id: 'google',
      label: 'Google Gemini',
      enabled: false,
      reason: 'Set a Gemini API key in Baiton settings.',
      models: [],
    },
    {
      id: 'opencode',
      label: 'OpenCode Zen',
      enabled: false,
      reason: 'OpenCode Zen is not reachable.',
      models: [],
    },
    {
      id: 'mistral',
      label: 'Mistral',
      enabled: true,
      models: [{ id: 'mistral-large', label: 'Mistral Large' }],
    },
    {
      id: 'openai',
      label: 'OpenAI',
      enabled: false,
      reason: 'OpenAI is not configured.',
      models: [],
    },
  ];
}

describe('chat view provider dropdown (multi-provider-orchestrator T08)', () => {
  it('seed paint: no selectable option and no Set API key affordance', () => {
    const view = loadChatView();
    const select = view.ids['model-select'];
    const setKey = view.ids['model-set-key'];
    // With no providers at all the rebuild still inserts the disabled
    // "Select a model…" placeholder — so "no options" here means no
    // selectable model option.
    assert.strictEqual(select.options.length, 1);
    assert.strictEqual(select.options[0].disabled, true);
    assert.strictEqual(select.options[0].selected, true);
    assert.strictEqual(setKey.classList.contains('visible'), false);
  });

  it('setProviders renders one optgroup per group in host order, disabled groups muted', () => {
    const view = loadChatView();
    view.send({ type: 'setProviders', groups: providerFixture(), selection: null });
    const select = view.ids['model-select'];
    const groups = select.children.filter((c) => c.tagName === 'OPTGROUP');
    assert.strictEqual(groups.length, 5);
    assert.deepStrictEqual(
      groups.map((g) => g.label),
      ['GitHub Copilot', 'Google Gemini', 'OpenCode Zen', 'Mistral', 'OpenAI'],
    );
    // Disabled groups: disabled=true plus one disabled option carrying the reason.
    const reasons: Record<string, string> = {
      'Google Gemini': 'Set a Gemini API key in Baiton settings.',
      'OpenCode Zen': 'OpenCode Zen is not reachable.',
      OpenAI: 'OpenAI is not configured.',
    };
    for (const g of groups) {
      if (g.disabled) {
        const notes = g.children.filter((c) => c.tagName === 'OPTION');
        assert.strictEqual(notes.length, 1, g.label);
        assert.strictEqual(notes[0].disabled, true);
        assert.strictEqual(
          notes[0].textContent,
          reasons[g.label],
          'option text must be the group reason',
        );
        assert.ok(notes[0].textContent.length > 0);
      }
    }
    assert.strictEqual(groups[0].children.length, 2, 'copilot offers its models');
  });

  it('the option matching the selection is selected, with value provider/model', () => {
    const view = loadChatView();
    view.send({
      type: 'setProviders',
      groups: providerFixture(),
      selection: { provider: 'copilot', model: 'claude-sonnet-4' },
    });
    const select = view.ids['model-select'];
    const selected = select.options.find((o) => o.selected);
    assert.ok(selected, 'an option is selected');
    assert.strictEqual(selected.dataset.provider, 'copilot');
    assert.strictEqual(selected.dataset.model, 'claude-sonnet-4');
    assert.strictEqual(select.value, 'copilot/claude-sonnet-4');
    assert.strictEqual(select.selectedIndex, select.options.indexOf(selected));
  });

  it('a selection no option matches (or null) inserts a selected disabled placeholder at index 0', () => {
    const view = loadChatView();
    view.send({
      type: 'setEmptyState',
      endpoint: null,
      model: 'gpt-5',
    });
    view.send({
      type: 'setProviders',
      groups: providerFixture(),
      selection: { provider: 'openai', model: 'gpt-4.1' },
    });
    const select = view.ids['model-select'];
    const placeholder = select.options[0];
    assert.strictEqual(placeholder.disabled, true);
    assert.strictEqual(placeholder.selected, true);
    assert.strictEqual(placeholder.textContent, 'OpenAI / gpt-4.1 (unavailable)');
    assert.strictEqual(select.selectedIndex, 0);
    assert.strictEqual(view.posted.length, 0, 'repainting never posts');

    const fresh = loadChatView();
    fresh.send({ type: 'setProviders', groups: providerFixture(), selection: null });
    assert.strictEqual(fresh.ids['model-select'].options[0].textContent, 'Select a model…');
    assert.strictEqual(fresh.ids['model-select'].options[0].selected, true);
    assert.strictEqual(fresh.posted.length, 0);
  });

  it('picking an enabled model posts selectModel exactly; other fires post nothing', () => {
    const view = loadChatView();
    view.send({ type: 'setProviders', groups: providerFixture(), selection: null });
    const select = view.ids['model-select'];
    const mistral = select.options.findIndex(
      (o) => o.dataset.provider === 'mistral' && o.dataset.model === 'mistral-large',
    );
    assert.ok(mistral >= 0, 'mistral option is flattened into the select');
    select.selectedIndex = mistral;
    select.fire('change', {});
    assert.deepStrictEqual(view.posted.map(plainClone), [
      { type: 'selectModel', provider: 'mistral', model: 'mistral-large' },
    ]);

    // A disabled reason row: repaint, not a post.
    const google = select.options.findIndex((o) => o.dataset.provider === undefined);
    assert.ok(google >= 0);
    select.selectedIndex = google;
    select.fire('change', {});
    assert.strictEqual(view.posted.length, 1);

    // Re-picking the already-active pair: nothing.
    view.send({
      type: 'setProviders',
      groups: providerFixture(),
      selection: { provider: 'mistral', model: 'mistral-large' },
    });
    select.fire('change', {});
    assert.strictEqual(view.posted.length, 1);
  });

  it('the Set API key affordance is visible only while a group is disabled and posts triggerFix', () => {
    const view = loadChatView();
    view.send({ type: 'setProviders', groups: providerFixture(), selection: null });
    const setKey = view.ids['model-set-key'];
    assert.strictEqual(setKey.classList.contains('visible'), true);
    assert.ok(setKey.title.length > 0);
    setKey.fire('click', {});
    assert.deepStrictEqual(view.posted.map(plainClone), [
      { type: 'triggerFix', action: 'setApiKey' },
    ]);

    // All groups enabled: the affordance disappears (without posting again).
    const all = providerFixture().map((g) => ({ ...g, enabled: true, reason: undefined }));
    view.send({ type: 'setProviders', groups: all, selection: null });
    assert.strictEqual(setKey.classList.contains('visible'), false);
    assert.strictEqual(setKey.title, '');
  });

  it('setBusy disables model-select while true and re-enables it after', () => {
    const view = loadChatView();
    view.send({ type: 'setProviders', groups: providerFixture(), selection: null });
    const select = view.ids['model-select'];
    assert.strictEqual(select.disabled, false, 'enabled models exist');
    view.send({ type: 'setBusy', busy: true });
    assert.strictEqual(select.disabled, true);
    view.send({ type: 'setBusy', busy: false });
    assert.strictEqual(select.disabled, false);
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
