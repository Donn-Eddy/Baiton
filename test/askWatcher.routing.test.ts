import * as assert from 'assert';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { PendingAskRegistry, systemClock } from '../src/orchestrator';
import { parseResponse, serializeAsk } from '../src/engine';

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
    registry = new PendingAskRegistry({ ids: { next: () => `card-${cards.length}` }, clock: systemClock });
    (globalThis as unknown as { __vscodeFake: object }).__vscodeFake = fakeVscode();
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  function make() {
    return createVscodeAskWatcherFactory({
      registry,
      present: (card) => { cards.push(card); },
      decline: (id, reason) => { registry.reject(id, reason); },
      log: () => {},
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
  });
});
