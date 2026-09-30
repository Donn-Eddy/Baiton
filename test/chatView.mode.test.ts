import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { HostToWebview, SessionItem } from '../src/orchestrator/webviewProtocol';

/**
 * Fake-DOM unit tests for the composer's host-authoritative Mode select added
 * by dispatch-modes T12.
 *
 * `media/chat.js` and `media/protocol.js` are plain scripts (neither is
 * compiled or linted by the toolchain), so they are executed inside one `vm`
 * sandbox — the same pattern as `test/chatView.providers.test.ts` — over a
 * hand-rolled minimal DOM that models only the surface chat.js touches. The
 * harness classes below are deliberately file-local copies of that test's, so
 * neither file has to grow a shared fixture.
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
  ['mode-select', 'select'],
  ['new-chat', 'button'],
  ['session-list', 'div'],
  ['provider-select', 'select'],
  ['model-select', 'select'],
  ['model-stale', 'span'],
  ['model-set-key', 'button'],
  ['context-bar', 'div'],
  ['context-meter', 'span'],
  ['compact-context', 'button'],
  ['composer', 'div'],
  ['readonly-note', 'div'],
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

describe('chat view Mode select (dispatch-modes T12)', () => {
  it('seed paint: the six modes in RUN_MODES order, Spec selected, enabled', () => {
    const view = loadChatView();
    const modes = view.ids['mode-select'];
    assert.deepStrictEqual(
      modes.options.map((o) => o.value),
      ['default', 'spec', 'bug', 'quick', 'refactor', 'investigate'],
    );
    assert.deepStrictEqual(
      modes.options.map((o) => o.textContent),
      ['Default', 'Spec', 'Bug', 'Quick', 'Refactor', 'Investigate'],
    );
    for (const opt of modes.options) {
      assert.strictEqual(opt.dataset.mode, opt.value);
    }
    assert.strictEqual(modes.value, 'spec');
    assert.strictEqual(modes.disabled, false);
    assert.strictEqual(view.posted.length, 0, 'the seed paint posts nothing');
  });

  it('the host echo moves the control and never rebuilds the option list', () => {
    const view = loadChatView();
    const modes = view.ids['mode-select'];
    view.send({ type: 'setMode', mode: 'bug' });
    assert.strictEqual(modes.value, 'bug');
    view.send({ type: 'setMode', mode: 'investigate' });
    assert.strictEqual(modes.value, 'investigate');
    assert.strictEqual(modes.options.length, 6, 'the option list is built once');
  });

  it('picking a mode posts exactly one setMode and does not move the control', () => {
    const view = loadChatView();
    const modes = view.ids['mode-select'];
    modes.selectedIndex = modes.options.findIndex((o) => o.value === 'quick');
    modes.fire('change', {});
    assert.deepStrictEqual(view.posted.map(plainClone), [{ type: 'setMode', mode: 'quick' }]);
    assert.strictEqual(modes.value, 'spec', 'snapped back; only the host echo moves it');

    view.send({ type: 'setMode', mode: 'quick' });
    assert.strictEqual(modes.value, 'quick');
    assert.strictEqual(view.posted.length, 1);
  });

  it('re-picking the already-active mode posts nothing', () => {
    const view = loadChatView();
    const modes = view.ids['mode-select'];
    view.send({ type: 'setMode', mode: 'quick' });
    assert.strictEqual(modes.value, 'quick');
    assert.strictEqual(view.posted.length, 0);
    modes.fire('change', {});
    assert.strictEqual(view.posted.length, 0);
  });

  it('is disabled while busy, while the Auto toggle stays flippable', () => {
    const view = loadChatView();
    const modes = view.ids['mode-select'];
    view.send({ type: 'setBusy', busy: true });
    assert.strictEqual(modes.disabled, true);
    assert.strictEqual(
      view.ids['auto-mode'].disabled,
      false,
      'Auto stays enabled so it can be flipped mid-run',
    );
    modes.selectedIndex = modes.options.findIndex((o) => o.value === 'bug');
    modes.fire('change', {});
    assert.strictEqual(view.posted.length, 0, 'a disabled control posts nothing');

    view.send({ type: 'setBusy', busy: false });
    assert.strictEqual(modes.disabled, false);
  });

  it('is disabled while a run is active, independently of busy', () => {
    const view = loadChatView();
    const modes = view.ids['mode-select'];
    view.send({ type: 'setRunActive', active: true });
    assert.strictEqual(modes.disabled, true);
    assert.ok(modes.title.includes('run'), 'the title explains the in-flight run');
    modes.selectedIndex = modes.options.findIndex((o) => o.value === 'refactor');
    modes.fire('change', {});
    assert.strictEqual(view.posted.length, 0);

    view.send({ type: 'setRunActive', active: false });
    assert.strictEqual(modes.disabled, false);
  });

  it('pins to Spec on a spec conversation and restores the mode on Workspace', () => {
    const view = loadChatView();
    const modes = view.ids['mode-select'];
    view.send({ type: 'setMode', mode: 'quick' });
    view.send({
      type: 'setConversations',
      items: [
        { id: 'workspace', label: 'Workspace' },
        { id: 'my-spec', label: 'my-spec' },
      ],
    });
    view.send({ type: 'setActive', conversationId: 'my-spec' });
    assert.strictEqual(modes.value, 'spec');
    assert.strictEqual(modes.disabled, true);
    modes.fire('change', {});
    assert.strictEqual(view.posted.length, 0);

    view.send({ type: 'setActive', conversationId: 'workspace' });
    assert.strictEqual(modes.disabled, false);
    assert.strictEqual(modes.value, 'quick', "the host's mode survives the pinning");
  });

  it('the host echo selects Default, and picking Default posts setMode default', () => {
    const echoed = loadChatView();
    echoed.send({ type: 'setMode', mode: 'default' });
    assert.strictEqual(echoed.ids['mode-select'].value, 'default');
    assert.strictEqual(echoed.ids['mode-select'].disabled, false);
    assert.strictEqual(echoed.posted.length, 0);

    const view = loadChatView();
    const modes = view.ids['mode-select'];
    modes.selectedIndex = modes.options.findIndex((o) => o.value === 'default');
    modes.fire('change', {});
    assert.deepStrictEqual(view.posted.map(plainClone), [{ type: 'setMode', mode: 'default' }]);
    assert.strictEqual(modes.value, 'spec', 'snapped back; only the host echo moves it');
  });

  it('a spec conversation pins to Spec even when the host mode is Default', () => {
    const view = loadChatView();
    const modes = view.ids['mode-select'];
    view.send({ type: 'setMode', mode: 'default' });
    view.send({
      type: 'setConversations',
      items: [
        { id: 'workspace', label: 'Workspace' },
        { id: 'my-spec', label: 'my-spec' },
      ],
    });
    view.send({ type: 'setActive', conversationId: 'my-spec' });
    assert.strictEqual(modes.value, 'spec');
    assert.strictEqual(modes.disabled, true);
    view.send({ type: 'setActive', conversationId: 'workspace' });
    assert.strictEqual(modes.value, 'default');
    assert.strictEqual(modes.disabled, false);
  });

  it('an unknown mode falls back to Spec rather than blanking the control', () => {
    const view = loadChatView();
    const modes = view.ids['mode-select'];
    // The reducer carries no `isRunMode` guard, so the state really can hold an
    // off-union value; the renderer must still show a mode.
    view.send({ type: 'setMode', mode: 'not-a-mode' } as unknown as HostToWebview);
    assert.strictEqual(modes.value, 'spec');
    assert.strictEqual(modes.options.length, 6);
  });
});

describe('chat view context meter (context-budget T07)', () => {
  const usage = (loaded: number, window: number | null, source: 'usage' | 'estimate' = 'usage'): HostToWebview => ({
    type: 'setContextUsage',
    loaded,
    window,
    source,
  });

  it('seed paint hides the meter', () => {
    const view = loadChatView();
    assert.notStrictEqual(view.ids['context-bar'].getAttribute('hidden'), null);
    assert.strictEqual(view.ids['context-meter'].textContent, '');
  });

  it('renders loaded / window · source', () => {
    const view = loadChatView();
    view.send(usage(256000, 1000000));
    assert.strictEqual(view.ids['context-meter'].textContent, '~256K / 1M · usage');
    assert.strictEqual(view.ids['context-bar'].getAttribute('hidden'), null);
  });

  it('renders window unknown', () => {
    const view = loadChatView();
    view.send(usage(256000, null, 'estimate'));
    assert.strictEqual(view.ids['context-meter'].textContent, '~256K · window unknown');
  });

  it('formats small and fractional-million values', () => {
    const view = loadChatView();
    view.send(usage(900, 1500000, 'estimate'));
    assert.strictEqual(view.ids['context-meter'].textContent, '~900 / 1.5M · estimate');
  });

  it('warns at 80% of the window', () => {
    const view = loadChatView();
    view.send(usage(850000, 1000000));
    assert.strictEqual(view.ids['context-meter'].classList.contains('warn'), true);
    view.send(usage(100000, 1000000));
    assert.strictEqual(view.ids['context-meter'].classList.contains('warn'), false);
  });

  it('Compact posts compactContext exactly once when idle with records', () => {
    const view = loadChatView();
    view.send({ type: 'renderConversation', records: [{ role: 'user', content: 'hi' }] });
    const btn = view.ids['compact-context'];
    assert.strictEqual(btn.disabled, false);
    btn.fire('click', {});
    assert.deepStrictEqual(view.posted.map(plainClone), [{ type: 'compactContext' }]);
  });

  it('Compact is disabled and posts nothing while busy', () => {
    const view = loadChatView();
    view.send({ type: 'renderConversation', records: [{ role: 'user', content: 'hi' }] });
    view.send({ type: 'setBusy', busy: true });
    const btn = view.ids['compact-context'];
    assert.strictEqual(btn.disabled, true);
    btn.fire('click', {});
    assert.strictEqual(view.posted.length, 0);
    view.send({ type: 'setBusy', busy: false });
    assert.strictEqual(btn.disabled, false);
  });

  it('Compact is disabled on an empty conversation', () => {
    const view = loadChatView();
    view.send({ type: 'renderConversation', records: [] });
    assert.strictEqual(view.ids['compact-context'].disabled, true);
  });
});

describe('chat view sub-agent chats (sub-agent-chats T08)', () => {
  const tree = (): SessionItem[] => [
    { id: 'p1', title: 'Parent', updatedAt: 3, scopeId: 'workspace', depth: 0 },
    { id: 'p1/c1', parentId: 'p1', title: 'Child task', updatedAt: 2, scopeId: 'workspace', depth: 1 },
    { id: 'p1/c1/g1', parentId: 'p1/c1', title: 'Grandchild', updatedAt: 1, scopeId: 'workspace', depth: 2 },
    { id: 'p2', title: 'Other', updatedAt: 0, scopeId: 'workspace', depth: 0 },
  ];
  const rowsOf = (view: ChatView): FakeEl[] => view.ids['session-list'].querySelectorAll('.session-row');
  const rowIds = (view: ChatView): string[] => rowsOf(view).map((r) => r.dataset.sessionId);
  const rowFor = (view: ChatView, id: string): FakeEl => {
    const row = rowsOf(view).find((r) => r.dataset.sessionId === id);
    assert.ok(row, 'row ' + id);
    return row;
  };
  const stop = { stopPropagation(): void {} };
  const loaded = (): ChatView => {
    const view = loadChatView();
    view.send({ type: 'setSessions', items: tree() });
    return view;
  };

  it('renders children beneath their parent with depth and a chevron', () => {
    const view = loaded();
    assert.deepStrictEqual(rowIds(view), ['p1', 'p1/c1', 'p1/c1/g1', 'p2']);
    assert.ok(rowFor(view, 'p1/c1').classList.contains('depth-1'));
    assert.ok(rowFor(view, 'p1/c1/g1').classList.contains('depth-2'));
    assert.strictEqual(rowFor(view, 'p1').querySelectorAll('.session-chevron').length, 1);
    assert.strictEqual(rowFor(view, 'p1/c1').querySelectorAll('.session-chevron').length, 1);
    assert.strictEqual(rowFor(view, 'p2').querySelectorAll('.session-chevron').length, 0);
    assert.strictEqual(rowFor(view, 'p1/c1/g1').querySelectorAll('.session-chevron').length, 0);
    assert.deepStrictEqual(
      rowsOf(view).map((r) => r.getAttribute('aria-level')),
      ['1', '2', '3', '1'],
    );
  });

  it('collapsing a parent hides its descendants and expanding restores them', () => {
    const view = loaded();
    rowFor(view, 'p1').querySelector('.session-chevron')?.fire('click', stop);
    assert.deepStrictEqual(rowIds(view), ['p1', 'p2']);
    assert.strictEqual(view.posted.length, 0);
    rowFor(view, 'p1').querySelector('.session-chevron')?.fire('click', stop);
    assert.deepStrictEqual(rowIds(view), ['p1', 'p1/c1', 'p1/c1/g1', 'p2']);
    assert.strictEqual(view.posted.length, 0);
  });

  it('collapse survives a setSessions re-post', () => {
    const view = loaded();
    rowFor(view, 'p1').querySelector('.session-chevron')?.fire('click', stop);
    view.send({ type: 'setSessions', items: tree() });
    assert.deepStrictEqual(rowIds(view), ['p1', 'p2']);
  });

  it('the active child stays visible under a collapsed parent', () => {
    const view = loaded();
    view.send({ type: 'setActiveSession', sessionId: 'p1/c1' });
    rowFor(view, 'p1').querySelector('.session-chevron')?.fire('click', stop);
    assert.ok(rowIds(view).includes('p1/c1'));
  });

  it('child rows offer no delete; top-level rows do', () => {
    const view = loaded();
    const counts = rowsOf(view).map((r) => r.querySelectorAll('.session-delete').length);
    assert.deepStrictEqual(counts, [1, 0, 0, 1]);
  });

  it('clicking a child posts selectSession with its id', () => {
    const view = loaded();
    rowFor(view, 'p1/c1').fire('click', {});
    assert.deepStrictEqual(view.posted.map(plainClone), [{ type: 'selectSession', sessionId: 'p1/c1' }]);
  });

  it('read-only hides the composer and shows the note', () => {
    const view = loadChatView();
    view.send({ type: 'renderConversation', records: [{ role: 'user', content: 'hi' }] });
    view.send({ type: 'setReadOnly', readOnly: true });
    assert.notStrictEqual(view.ids.composer.getAttribute('hidden'), null);
    assert.strictEqual(view.ids['readonly-note'].getAttribute('hidden'), null);
    for (const id of ['send', 'stop', 'input', 'compact-context']) {
      assert.strictEqual(view.ids[id].disabled, true, id);
    }
    view.send({ type: 'setReadOnly', readOnly: false });
    assert.strictEqual(view.ids.composer.getAttribute('hidden'), null);
    assert.notStrictEqual(view.ids['readonly-note'].getAttribute('hidden'), null);
  });

  it('read-only: Stop, Send, Compact post nothing even while busy', () => {
    const view = loadChatView();
    view.send({ type: 'renderConversation', records: [{ role: 'user', content: 'hi' }] });
    view.send({ type: 'setBusy', busy: true });
    view.send({ type: 'setReadOnly', readOnly: true });
    view.ids.input.value = 'hello';
    view.ids.stop.fire('click', {});
    view.ids.send.fire('click', {});
    view.ids['compact-context'].fire('click', {});
    assert.strictEqual(view.posted.length, 0);
  });

  const cards = (): HostToWebview[] => [
    {
      type: 'showIntervention',
      intervention: { id: 'a1', kind: 'confirm', prompt: 'ok?', status: 'pending' },
    },
    {
      type: 'showIntervention',
      intervention: {
        id: 'a2',
        kind: 'question',
        prompt: 'which?',
        status: 'pending',
        options: [{ id: 'x', label: 'X' }],
      },
    },
  ];

  it('read-only pending cards render no answer controls', () => {
    const view = loadChatView();
    view.send({ type: 'setReadOnly', readOnly: true });
    for (const m of cards()) {
      view.send(m);
    }
    const transcript = view.ids.transcript;
    // FakeEl selectors match attributes only; card controls carry dataset fields.
    const controls = (): FakeEl[] =>
      ['BUTTON', 'INPUT', 'TEXTAREA'].flatMap((t) =>
        transcript.querySelectorAll(t).filter((el) => el.dataset.interventionField !== undefined),
      );
    assert.strictEqual(controls().length, 0);
    const decisions = transcript.querySelectorAll('.intervention-decision');
    assert.ok(decisions.length > 0);
    assert.ok(decisions.every((d) => d.textContent === 'Waiting for an answer in the parent chat'));
    view.send({ type: 'setReadOnly', readOnly: false });
    assert.ok(controls().length > 0);
  });

  it('read-only resolved cards still show the decision', () => {
    const view = loadChatView();
    view.send({ type: 'setReadOnly', readOnly: true });
    view.send({
      type: 'showIntervention',
      intervention: { id: 'a1', kind: 'confirm', prompt: 'ok?', status: 'resolved', answer: { kind: 'approved' } },
    });
    const decisions = view.ids.transcript.querySelectorAll('.intervention-decision');
    assert.strictEqual(decisions.length, 1);
    assert.strictEqual(decisions[0].textContent, 'Approved');
  });

  it('Delete key on a child row posts nothing', () => {
    const view = loaded();
    view.send({ type: 'setActiveSession', sessionId: 'p1/c1' });
    view.ids['session-list'].fire('keydown', { key: 'Delete', preventDefault(): void {} });
    assert.strictEqual(view.posted.length, 0);
  });
});
