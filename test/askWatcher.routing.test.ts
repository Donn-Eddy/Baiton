import * as assert from 'assert';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { PendingAskRegistry, systemClock } from '../src/orchestrator';
import { createRunQueue, parseResponse, serializeAsk } from '../src/engine';
import type { Adapter } from '../src/adapter';
import type { GitService } from '../src/git';
import type { HostTerminal, TerminalHost } from '../src/engine';
import type { ResultWatcher, ResultWatcherFactory, RunQueueDeps, SpecStore } from '../src/engine';
import { parseSpec } from '../src/model/parser';
import { ok } from '../src/model/result';

interface WatchFake {
  create?: (uri: { fsPath: string }) => void;
  change?: (uri: { fsPath: string }) => void;
  disposed: boolean;
}

let watcher: WatchFake;
let createVscodeAskWatcherFactory: typeof import('../src/activation/vscodeAskWatcher')['createVscodeAskWatcherFactory'];
let RUN_SETTLED_DECLINE_REASON: string;

function fakeVscode(): object {
  watcher = { disposed: false };
  return {
    Uri: { file: (fsPath: string) => ({ fsPath }) },
    RelativePattern: class { constructor(_base: unknown, _pattern: string) {} },
    workspace: {
      createFileSystemWatcher: () => ({
        onDidCreate: (cb: (uri: { fsPath: string }) => void) => { watcher.create = cb; },
        onDidChange: (cb: (uri: { fsPath: string }) => void) => { watcher.change = cb; },
        onDidDelete: () => undefined,
        dispose: () => { watcher.disposed = true; },
      }),
    },
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('condition was not met');
}

function responseAt(file: string) {
  const parsed = parseResponse(readFileSync(file, 'utf8'));
  assert.strictEqual(parsed.ok, true);
  if (!parsed.ok) throw new Error('invalid response');
  return parsed.value;
}

describe('vscode ask watcher routing', () => {
  let root: string;
  let asksDir: string;
  let cards: import('../src/orchestrator').Intervention[];
  let registry: PendingAskRegistry;
  let logs: string[];
  let declined: Array<{ id: string; reason: string }>;

  before(async () => {
    const loader = pathToFileURL(join(process.cwd(), 'test/fixtures/vscodeLoader.mjs')).href;
    register(loader, pathToFileURL(join(process.cwd(), '/')).href);
    await import('./fixtures/vscodeLoader.mjs');
    (globalThis as unknown as { __vscodeFake: object }).__vscodeFake = fakeVscode();
    const mod = await import('../src/activation/vscodeAskWatcher');
    createVscodeAskWatcherFactory = mod.createVscodeAskWatcherFactory;
    RUN_SETTLED_DECLINE_REASON = mod.RUN_SETTLED_DECLINE_REASON;
  });

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'baiton-asks-'));
    asksDir = join(root, 'asks');
    mkdirSync(asksDir, { recursive: true });
    cards = [];
    logs = [];
    declined = [];
    registry = new PendingAskRegistry({ ids: { next: () => `card-${cards.length}` }, clock: systemClock });
    (globalThis as unknown as { __vscodeFake: object }).__vscodeFake = fakeVscode();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function make() {
    return createVscodeAskWatcherFactory({
      registry,
      present: (card) => { cards.push(card); },
      decline: (id, reason) => { declined.push({ id, reason }); registry.reject(id, reason); },
      log: (message) => { logs.push(message); },
      now: () => '2026-01-01T00:00:00.000Z',
    }).create({ slug: 'spec-a', todoId: 'T17', runId: 'run-a', agent: 'claude', asksDir });
  }

  it('catches up asks, scopes cards, and writes approved responses', async () => {
    writeFileSync(join(asksDir, 'ask-1.json'), serializeAsk({ version: 1, id: 'ask-1', runId: 'run-a', agent: 'claude', kind: 'permission', prompt: 'allow?', tool: 'Bash', args: '{"x":1}', detail: 'run it' }));
    make();
    await waitFor(() => cards.length === 1);
    assert.deepStrictEqual({ kind: cards[0].kind, scopeId: cards[0].scopeId, agent: (cards[0] as Extract<typeof cards[number], { kind: 'permission' }>).agent }, { kind: 'permission', scopeId: 'spec-a', agent: 'claude' });
    registry.resolve(cards[0].id, { kind: 'approved' });
    await waitFor(() => existsSync(join(asksDir, 'ask-1.response.json')));
    assert.strictEqual(responseAt(join(asksDir, 'ask-1.response.json')).decision, 'approve');
  });

  function writeAsk(id: string, ask: Partial<Parameters<typeof serializeAsk>[0]> = {}): void {
    writeFileSync(join(asksDir, `${id}.json`), serializeAsk({
      version: 1, id, runId: 'run-a', agent: 'claude', kind: 'permission',
      prompt: 'allow?', tool: 'Bash', ...ask,
    }));
  }

  function emit(name: string): void {
    watcher.create?.({ fsPath: join(asksDir, name) });
  }

  it('ignores response files and declines pending cards on disposal', async () => {
    const live = make();
    watcher.create?.({ fsPath: join(asksDir, 'ask-1.response.json') });
    assert.strictEqual(cards.length, 0);
    writeFileSync(join(asksDir, 'ask-1.json'), serializeAsk({ version: 1, id: 'ask-1', runId: 'run-a', agent: 'claude', kind: 'permission', prompt: 'allow?', tool: 'Bash' }));
    watcher.create?.({ fsPath: join(asksDir, 'ask-1.json') });
    await waitFor(() => cards.length === 1);
    live.dispose();
    await waitFor(() => watcher.disposed && registry.size === 0);
    await waitFor(() => existsSync(join(asksDir, 'ask-1.response.json')));
    assert.strictEqual(responseAt(join(asksDir, 'ask-1.response.json')).reason, RUN_SETTLED_DECLINE_REASON);
    writeAsk('after-dispose');
    emit('after-dispose.json');
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.strictEqual(cards.length, 1, 'events after disposal are ignored');
    assert.ok(!existsSync(join(asksDir, 'after-dispose.response.json')));
  });

  it('writes declined and question-option answers', async () => {
    make();
    writeAsk('deny'); emit('deny.json');
    await waitFor(() => cards.length === 1);
    registry.resolve(cards[0].id, { kind: 'declined', reason: 'no' });
    await waitFor(() => existsSync(join(asksDir, 'deny.response.json')));
    assert.deepStrictEqual(
      { decision: responseAt(join(asksDir, 'deny.response.json')).decision, reason: responseAt(join(asksDir, 'deny.response.json')).reason },
      { decision: 'deny', reason: 'no' },
    );
    writeAsk('question', { kind: 'question', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }], tool: undefined }); emit('question.json');
    await waitFor(() => cards.length === 2);
    assert.strictEqual(cards[1].kind, 'question');
    registry.resolve(cards[1].id, { kind: 'option', optionId: 'b' });
    await waitFor(() => existsSync(join(asksDir, 'question.response.json')));
    assert.deepStrictEqual(
      { decision: responseAt(join(asksDir, 'question.response.json')).decision, answer: responseAt(join(asksDir, 'question.response.json')).answer },
      { decision: 'approve', answer: 'b' },
    );
  });

  it('does not route responses or duplicate ask events', async () => {
    make();
    emit('same.response.json'); emit('same.response.json.tmp');
    writeAsk('same'); emit('same.json'); watcher.change?.({ fsPath: join(asksDir, 'same.json') });
    await waitFor(() => cards.length === 1);
    registry.resolve(cards[0].id, { kind: 'approved' });
    await waitFor(() => existsSync(join(asksDir, 'same.response.json')));
    assert.strictEqual(cards.length, 1);
  });

  it('logs and ignores malformed, invalid, and wrong-run asks', async () => {
    make();
    writeFileSync(join(asksDir, 'bad.json'), '{not json'); emit('bad.json');
    writeFileSync(join(asksDir, 'invalid.json'), JSON.stringify({ version: 1, id: 'invalid', runId: 'run-a', agent: 'claude', kind: 'permission', prompt: 'x' })); emit('invalid.json');
    writeAsk('other', { runId: 'another-run' }); emit('other.json');
    await waitFor(() => logs.length === 3);
    assert.strictEqual(cards.length, 0);
    assert.ok(logs.some((line) => line.includes('bad.json')));
    assert.ok(logs.some((line) => line.includes('invalid.json')));
    assert.ok(logs.some((line) => line.includes('other.json')));
    assert.ok(!existsSync(join(asksDir, 'bad.response.json')));
    assert.ok(!existsSync(join(asksDir, 'invalid.response.json')));
    assert.ok(!existsSync(join(asksDir, 'other.response.json')));
  });
});

describe('run queue ask watcher wiring', () => {
  const slug = 'demo';
  const todoId = 'T17';
  let workspaceRoot: string;

  beforeEach(() => {
    workspaceRoot = mkdtempSync(join(tmpdir(), 'baiton-queue-'));
    mkdirSync(join(workspaceRoot, '.baiton', 'specs', slug), { recursive: true });
  });
  afterEach(() => rmSync(workspaceRoot, { recursive: true, force: true }));

  async function dispatch(wire = false): Promise<{ relay: unknown; creates: unknown[]; disposes: () => number }> {
    let relay: unknown;
    const creates: unknown[] = [];
    let disposeCount = 0;
    class Terminal implements HostTerminal {
      sendText(): void {}
      show(): void {}
      dispose(): void {}
      get processId(): Promise<number | undefined> { return Promise.resolve(undefined); }
    }
    const terminalHost: TerminalHost = { createTerminal: () => new Terminal() };
    const watcherFactory: ResultWatcherFactory = {
      create: (): ResultWatcher => {
        const listeners: Array<(raw: string) => void> = [];
        setImmediate(() => listeners.forEach((listener) => listener(JSON.stringify({ steps: [{ title: 'x', detail: 'x', files: [] }], risks: [], acceptance: [] }))));
        return {
          onResult: (listener) => { listeners.push(listener); return () => {}; },
          onTerminalClose: () => () => {},
          dispose: () => {},
        };
      },
    };
    const adapter: Adapter = {
      id: 'claude', acceptsSessionId: true,
      probe: async () => ({ version: 'test', ok: true }),
      launch: (input) => { relay = input.relay; return { shellPath: 'claude', shellArgs: [] }; },
      attach: () => ({ shellPath: 'claude', shellArgs: [] }),
    };
    const git: GitService = {
      status: async () => ({ clean: true, changes: [] }), isCleanExceptSpecFolder: async () => true,
      fetch: async () => {}, resolveBaseCommit: async () => 'base', createSpecBranch: async () => {}, checkout: async () => {},
      commit: async () => 'commit', head: async () => 'head', currentBranch: async () => 'branch', diff: async () => '',
      diffAgainstWorkingTree: async () => '', log: async () => '', resetWorkingTree: async () => ok(undefined),
      findCommitByRunId: async () => undefined, push: async () => undefined, remoteUrl: async () => '',
    };
    const specStore: SpecStore = {
      currentState: async () => 'pending', readSpec: async () => parseSpec('# OVERVIEW\n\nO\n\n# TODOS\n- [pending] T17 Todo\n'),
      readArtifact: async () => undefined, latestExecuteCommit: async () => undefined, isApproved: async () => true,
      isBlocked: async () => false, inputRevMatches: async () => true, inputRev: async () => 'rev', writeState: async () => true,
    };
    const deps: RunQueueDeps = {
      workspaceRoot, terminalHost, watcherFactory, git, specStore,
      journalPath: join(workspaceRoot, '.baiton', 'specs', slug, 'runs.jsonl'), modelForRole: () => ({ model: 'm' }),
      adapterForRole: () => adapter, newRunId: () => 'run-1', newSessionId: () => '11111111-1111-1111-1111-111111111111',
      ...(wire ? { askWatcherFactory: { create: (input) => { creates.push(input); return { dispose: () => { disposeCount += 1; } }; } } } : {}),
    };
    const outcome = await createRunQueue(deps).dispatch({ slug, todoId, action: 'plan', role: 'planner', attempt: 1, resume: false });
    assert.ok(outcome.ok);
    return { relay, creates, disposes: () => disposeCount };
  }

  it('creates and disposes a watcher over the launched relay directory', async () => {
    const result = await dispatch(true);
    assert.deepStrictEqual(result.creates, [{ slug, todoId, runId: 'run-1', agent: 'claude', asksDir: join(workspaceRoot, '.baiton', 'runs', 'run-1', 'asks') }]);
    assert.strictEqual(result.disposes(), 1);
    assert.ok(result.relay !== undefined);
  });

  it('keeps an unwired queue byte-identical: no relay request or asks directory', async () => {
    const result = await dispatch(false);
    assert.strictEqual(result.relay, undefined);
    assert.ok(!existsSync(join(workspaceRoot, '.baiton', 'runs', 'run-1', 'asks')));
    assert.deepStrictEqual(result.creates, []);
  });
});
