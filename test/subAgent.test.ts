/**
 * SubAgentRunner unit tests: spawn, follow-up, depth cap, concurrency, stop and
 * forwarded asks, over a real SessionStore in a temp dir with a scripted model
 * client and a fake tool surface.
 */
import * as assert from 'assert';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { CompletionRequest, CompletionResult, ModelClient, ToolSpec } from '../src/orchestrator/modelClient';
import type { GuardContext, OrchestratorPhase, Tool, ToolCaller, ToolResult, ToolSurface } from '../src/orchestrator/guard';
import { ok } from '../src/model/result';
import { SessionStore, type SessionScope } from '../src/orchestrator/sessionStore';
import { buildSubAgentPrompt } from '../src/orchestrator/systemPrompt';
import { readTranscript, toHistory } from '../src/orchestrator/transcriptReader';
import {
  PendingAskRegistry,
  createInterventionSeam,
  type Intervention,
  type InterventionOrigin,
} from '../src/orchestrator/interventions';
import {
  SubAgentRunner,
  type SubAgentEvent,
  type SubAgentToolSurface,
} from '../src/orchestrator/subAgent';

const workspace: SessionScope = { kind: 'workspace' };

type Script = CompletionResult | ((req: CompletionRequest) => Promise<CompletionResult>);

const reply = (content: string): CompletionResult => ({ content, tool_calls: [] });
const calls = (...c: { id: string; name: string; args: object }[]): CompletionResult => ({
  tool_calls: c.map((x) => ({ id: x.id, name: x.name, arguments: JSON.stringify(x.args) })),
});
function chatIdOf(o: { kind: string }): string {
  return (o as unknown as { chatId: string }).chatId;
}
function replyOf(o: { kind: string }): string {
  return (o as unknown as { reply: string }).reply;
}
const hang: Script = (req) =>
  new Promise((_resolve, reject) => {
    req.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });

/** Routes completions by `sessionId` (the child chat id) to per-session scripts. */
class RoutedClient implements ModelClient {
  public requests: CompletionRequest[] = [];
  private readonly scripts = new Map<string, Script[]>();
  private waiters: { count: number; resolve: () => void }[] = [];

  /** Scripts for the Nth spawned session (in order of first request) when no id is known up front. */
  private fallback: Script[][] = [];

  public script(sessionId: string, ...s: Script[]): void {
    this.scripts.set(sessionId, s);
  }
  public scriptNext(...s: Script[]): void {
    this.fallback.push(s);
  }
  public async waitForRequests(count: number): Promise<void> {
    if (this.requests.length >= count) {
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push({ count, resolve }));
  }

  public async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(req);
    this.waiters = this.waiters.filter((w) => {
      if (this.requests.length >= w.count) {
        w.resolve();
        return false;
      }
      return true;
    });
    const id = req.sessionId ?? '';
    let queue = this.scripts.get(id);
    if (queue === undefined) {
      queue = this.fallback.shift() ?? [];
      this.scripts.set(id, queue);
    }
    const next = queue.shift();
    if (next === undefined) {
      throw new Error(`no script left for ${id}`);
    }
    return typeof next === 'function' ? next(req) : next;
  }
}

interface RecordedCall {
  name: string;
  args: Record<string, string>;
  phase: OrchestratorPhase;
  surface: ToolSurface;
  caller: ToolCaller | undefined;
}

class FakeSurface implements SubAgentToolSurface {
  public assembled: { phase: OrchestratorPhase; surface: ToolSurface }[] = [];
  public recorded: RecordedCall[] = [];
  public runner!: SubAgentRunner;
  public ask!: (question: string) => Promise<unknown>;

  public assembleFor(phase: OrchestratorPhase, surface: ToolSurface) {
    this.assembled.push({ phase, surface });
    return ok([
      { name: 'spawn_subagent', description: 'd', parameters: {} },
    ] as ToolSpec[]);
  }
  public definitionsFor(): Tool[] {
    return [
      { name: 'spawn_subagent', concurrent: true } as Tool,
      { name: 'read_file', concurrent: true } as Tool,
    ];
  }
  public async call(
    name: string,
    args: unknown,
    _callId: string | undefined,
    _ctx: GuardContext,
    phase: OrchestratorPhase,
    surface: ToolSurface,
    caller?: ToolCaller,
  ): Promise<ToolResult> {
    const a = args as Record<string, string>;
    this.recorded.push({ name, args: a, phase, surface, caller });
    if (name === 'spawn_subagent') {
      const o = await this.runner.spawn({ task: a.task, caller: caller as ToolCaller });
      return o.kind === 'replied'
        ? { ok: true, data: { chatId: o.chatId, reply: o.reply } }
        : { ok: false, error: o.reason };
    }
    if (name === 'ask_user') {
      const answer = await this.ask(a.question);
      return { ok: true, data: answer };
    }
    return { ok: false, error: `unknown tool ${name}` };
  }
}

describe('SubAgentRunner', () => {
  let tmp: string;
  let baitonDir: string;
  let store: SessionStore;
  let client: RoutedClient;
  let surface: FakeSurface;
  let events: SubAgentEvent[];
  let asks: PendingAskRegistry;
  let presented: Intervention[];
  let runner: SubAgentRunner;

  function makeStore(): SessionStore {
    let t = 0;
    let r = 0;
    return new SessionStore({
      baitonDir,
      specsDir: path.join(baitonDir, 'specs'),
      clock: { now: () => new Date(Date.UTC(2026, 8, 1, 0, 0, t++)).toISOString() },
      random: () => ((r++ * 0.137) % 1),
    });
  }

  function makeRunner(s: SessionStore = store): SubAgentRunner {
    const created = new SubAgentRunner({
      sessions: s,
      client,
      tools: () => surface,
      guardContext: () => ({}) as GuardContext,
      roundBound: () => 5,
      readSpec: async () => undefined,
      asks,
      onEvent: (e) => events.push(e),
    });
    return created;
  }

  function wire(r: SubAgentRunner): void {
    runner = r;
    surface.runner = r;
    const seam = r.interventionSeam(createInterventionSeam(asks, (i) => void presented.push(i)));
    surface.ask = (question) => seam.ask({ kind: 'question', prompt: question, allowFreeText: true });
  }

  function parentCaller(over: Partial<ToolCaller> = {}): ToolCaller {
    return {
      sessionKey: 'workspace/P1',
      depth: 0,
      phase: 'gather',
      kind: workspace,
      signal: new AbortController().signal,
      ...over,
    };
  }

  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'baiton-subagent-'));
    baitonDir = path.join(tmp, '.baiton');
    mkdirSync(path.join(baitonDir, 'specs'), { recursive: true });
    store = makeStore();
    client = new RoutedClient();
    surface = new FakeSurface();
    events = [];
    presented = [];
    let n = 0;
    asks = new PendingAskRegistry({ ids: { next: () => `ask-${++n}` } });
    wire(makeRunner());
  });

  afterEach(() => {
    runner.dispose();
    rmSync(tmp, { recursive: true, force: true });
  });

  async function records(chatId: string) {
    return readTranscript(store.pathFor(workspace, chatId));
  }

  it('spawns a child, runs its first turn and records the transcript', async () => {
    client.scriptNext(reply('done it'));
    const out = await runner.spawn({ task: 'do the thing', caller: parentCaller() });
    assert.strictEqual(out.kind, 'replied');
    if (out.kind !== 'replied') {
      return;
    }
    assert.ok(out.chatId.startsWith('P1/'));
    assert.strictEqual(out.reply, 'done it');
    const file = path.join(baitonDir, 'chat', 'P1.children', `${out.chatId.slice(3)}.jsonl`);
    assert.ok(existsSync(file));
    const recs = await records(out.chatId);
    assert.deepStrictEqual(recs.map((r) => [r.role, r.content]), [
      ['user', 'do the thing'],
      ['assistant', 'done it'],
    ]);
    const kids = await store.listChildren(workspace, 'P1');
    assert.deepStrictEqual(kids.map((k) => [k.id, k.title]), [[out.chatId, 'do the thing']]);
    assert.deepStrictEqual(events.map((e) => (e.type === 'appended' ? `appended:${e.record.role}` : e.type === 'finished' ? `finished:${e.outcome}` : e.type)), [
      'started',
      'appended:user',
      'appended:assistant',
      'finished:replied',
    ]);
    const first = client.requests[0];
    assert.strictEqual(first.messages[0].role, 'system');
    assert.strictEqual(first.messages[0].content, buildSubAgentPrompt({ kind: 'workspace' }, 'gather', 1));
    assert.strictEqual(first.sessionId, out.chatId);
    assert.deepStrictEqual(surface.assembled, [{ phase: 'gather', surface: 'subagent' }]);
  });

  it('runs tool calls on the sub-agent surface with the child as caller', async () => {
    client.scriptNext(calls({ id: 'c1', name: 'read_file', args: { path: 'x' } }), reply('fin'));
    const out = await runner.spawn({ task: 't', caller: parentCaller() });
    assert.strictEqual(out.kind, 'replied');
    const c = surface.recorded[0];
    assert.strictEqual(c.surface, 'subagent');
    assert.strictEqual(c.phase, 'gather');
    assert.strictEqual(c.caller?.depth, 1);
    assert.strictEqual(c.caller?.sessionKey, `workspace/${chatIdOf(out)}`);
    assert.deepStrictEqual(c.caller?.kind, workspace);
  });

  it('follows up in the same child and refuses bad targets', async () => {
    client.scriptNext(reply('first'), reply('second'));
    const out = await runner.spawn({ task: 'task', caller: parentCaller() });
    assert.strictEqual(out.kind, 'replied');
    const chatId = chatIdOf(out);
    const r = await runner.send({ chatId, message: 'more', caller: parentCaller() });
    assert.deepStrictEqual(r, { kind: 'replied', reply: 'second' });
    const msgs = client.requests[1].messages.slice(1).map((m) => m.content);
    assert.deepStrictEqual(msgs, ['task', 'first', 'more']);
    assert.strictEqual((await records(chatId)).length, 4);

    const unknown = await runner.send({ chatId: 'P1/nope', message: 'x', caller: parentCaller() });
    assert.ok(unknown.kind === 'refused' && unknown.reason.includes('no sub-agent chat'));
    const other = await runner.send({ chatId, message: 'x', caller: parentCaller({ sessionKey: 'workspace/P2' }) });
    assert.ok(other.kind === 'refused' && other.reason.includes('not a sub-agent of this chat'));
    const bad = await runner.send({ chatId: 'P1/../x', message: 'x', caller: parentCaller() });
    assert.ok(bad.kind === 'refused' && bad.reason === 'invalid chat id');
  });

  it('refuses a send while the previous turn is still running', async () => {
    client.scriptNext(hang);
    const first = runner.spawn({ task: 't', caller: parentCaller() });
    await client.waitForRequests(1);
    const chatId = runner.list()[0].chatId;
    const r = await runner.send({ chatId, message: 'again', caller: parentCaller() });
    assert.ok(r.kind === 'refused' && r.reason.includes('still working'));
    runner.stopDescendants('workspace/P1');
    await first;
  });

  it('rehydrates a child from disk in a new runner', async () => {
    client.scriptNext(reply('first'), reply('second'));
    const out = await runner.spawn({ task: 'task', caller: parentCaller() });
    const chatId = chatIdOf(out);
    runner.dispose();
    wire(makeRunner());
    const r = await runner.send({ chatId, message: 'again', caller: parentCaller() });
    assert.deepStrictEqual(r, { kind: 'replied', reply: 'second' });
    assert.deepStrictEqual(
      client.requests[1].messages.slice(1).map((m) => m.content),
      ['task', 'first', 'again'],
    );
  });

  it('refuses a spawn from a depth-2 caller without writing anything', async () => {
    const out = await runner.spawn({
      task: 't',
      caller: parentCaller({ sessionKey: 'workspace/P9/a/b', depth: 2 }),
    });
    assert.ok(out.kind === 'refused' && out.reason.includes('MAX_SUBAGENT_DEPTH = 2'));
    assert.ok(!existsSync(path.join(baitonDir, 'chat')));
  });

  it('nests to depth 2 and refuses a grandchild spawn', async () => {
    client.scriptNext(
      calls({ id: 'c1', name: 'spawn_subagent', args: { task: 'grand task' } }),
      reply('child done'),
    );
    client.scriptNext(
      calls({ id: 'g1', name: 'spawn_subagent', args: { task: 'great' } }),
      reply('grand done'),
    );
    const out = await runner.spawn({ task: 'child task', caller: parentCaller() });
    assert.deepStrictEqual(replyOf(out), 'child done');
    const kids = await store.listChildren(workspace, 'P1');
    assert.strictEqual(kids.length, 1);
    const grandKids = await store.listChildren(workspace, kids[0].id);
    const grand = grandKids.find((m) => m.depth === 2);
    assert.ok(grand);
    assert.ok(existsSync(store.pathFor(workspace, grand!.id)));
    const gRecs = await records(grand!.id);
    const toolMsg = gRecs.find((r) => r.role === 'tool');
    assert.ok(toolMsg?.content.includes('MAX_SUBAGENT_DEPTH = 2'));
    assert.strictEqual((await store.listChildren(workspace, grand!.id)).length, 0);
  });

  it('runs concurrent sub-agents side by side', async function () {
    this.timeout(2000);
    let release!: () => void;
    const barrier = new Promise<void>((r) => (release = r));
    const gated = (text: string): Script => async () => {
      if (client.requests.length >= 2) {
        release();
      }
      await barrier;
      return reply(text);
    };
    client.scriptNext(gated('A'));
    client.scriptNext(gated('B'));
    const [a, b] = await Promise.all([
      runner.spawn({ task: 'a', caller: parentCaller() }),
      runner.spawn({ task: 'b', caller: parentCaller() }),
    ]);
    assert.ok(a.kind === 'replied' && b.kind === 'replied');
    const ra = { chatId: chatIdOf(a), reply: replyOf(a) };
    const rb = { chatId: chatIdOf(b), reply: replyOf(b) };
    assert.notStrictEqual(ra.chatId, rb.chatId);
    assert.deepStrictEqual(new Set([ra.reply, rb.reply]), new Set(['A', 'B']));
    for (const o of [ra, rb]) {
      const recs = await records(o.chatId);
      assert.strictEqual(recs.length, 2);
      assert.strictEqual(recs[1].content, o.reply);
    }
    assert.strictEqual(runner.list().length, 2);
  });

  describe('stop', () => {
    it('stopDescendants aborts a running child', async () => {
      client.scriptNext(hang);
      const p = runner.spawn({ task: 't', caller: parentCaller() });
      await client.waitForRequests(1);
      assert.strictEqual(runner.stopDescendants('workspace/P1'), 1);
      const out = await p;
      assert.ok(out.kind === 'refused' && out.reason === 'the sub-agent was stopped');
      const recs = await records(runner.list()[0].chatId);
      assert.strictEqual(recs[recs.length - 1].content, 'The run was stopped.');
      assert.ok(events.some((e) => e.type === 'finished' && e.outcome === 'stopped'));
      assert.strictEqual(runner.isRunning(runner.list()[0].key), false);
    });

    it('aborting the parent signal also stops it', async () => {
      client.scriptNext(hang);
      const ac = new AbortController();
      const p = runner.spawn({ task: 't', caller: parentCaller({ signal: ac.signal }) });
      await client.waitForRequests(1);
      ac.abort();
      const out = await p;
      assert.ok(out.kind === 'refused' && out.reason === 'the sub-agent was stopped');
    });

    it('stopping the root aborts a running grandchild', async () => {
      client.scriptNext(calls({ id: 'c1', name: 'spawn_subagent', args: { task: 'g' } }), reply('x'));
      client.scriptNext(hang);
      const p = runner.spawn({ task: 'c', caller: parentCaller() });
      await client.waitForRequests(2);
      assert.strictEqual(runner.stopDescendants('workspace/P1'), 2);
      await p;
      assert.ok(runner.list().every((i) => !i.running));
    });
  });

  describe('forwarded asks', () => {
    it('carries origin, records a forwarded note and keeps the tool result paired', async () => {
      client.scriptNext(calls({ id: 'q1', name: 'ask_user', args: { question: 'colour?' } }), reply('ok blue'));
      const p = runner.spawn({ task: 't', caller: parentCaller() });
      await client.waitForRequests(1);
      while (presented.length === 0) {
        await new Promise((r) => setTimeout(r, 5));
      }
      const chatId = runner.list()[0].chatId;
      const expected: InterventionOrigin = { rootKey: 'workspace/P1', chatId, chatKey: `workspace/${chatId}`, depth: 1 };
      assert.deepStrictEqual(presented[0].origin, expected);
      assert.deepStrictEqual(asks.resolve(presented[0].id, { kind: 'text', text: 'blue' }), { kind: 'resolved' });
      const out = await p;
      assert.strictEqual(replyOf(out), 'ok blue');
      const recs = await records(chatId);
      const note = recs.find((r) => r.forwarded === true);
      assert.ok(note);
      assert.strictEqual(note!.role, 'system');
      assert.strictEqual(note!.intervention?.status, 'resolved');
      assert.deepStrictEqual(note!.intervention?.answer, { kind: 'text', text: 'blue' });
      const hist = toHistory(recs);
      assert.ok(hist.some((m) => m.role === 'tool' && m.tool_call_id === 'q1'));

      // A top-level ask through the same wrapped seam has no origin.
      const top = surface.ask('top?');
      while (presented.length < 2) {
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.ok(!('origin' in presented[1]));
      asks.resolve(presented[1].id, { kind: 'text', text: 'x' });
      await top;
    });

    it('stop declines a pending forwarded ask', async () => {
      client.scriptNext(calls({ id: 'q1', name: 'ask_user', args: { question: 'colour?' } }));
      const p = runner.spawn({ task: 't', caller: parentCaller() });
      while (presented.length === 0) {
        await new Promise((r) => setTimeout(r, 5));
      }
      assert.strictEqual(asks.size, 1);
      runner.stopDescendants('workspace/P1');
      const out = await p;
      assert.ok(out.kind === 'refused');
      assert.strictEqual(asks.size, 0);
      const recs = await records(runner.list()[0].chatId);
      const note = recs.find((r) => r.forwarded === true);
      assert.strictEqual(note?.intervention?.answer?.kind, 'declined');
    });
  });

  it('stamps origin on PendingAskRegistry.create only when given', () => {
    const reg = new PendingAskRegistry({ ids: { next: () => 'i' } });
    const a = reg.create({ kind: 'confirm', prompt: 'p' });
    assert.strictEqual('origin' in a.intervention, false);
    const origin: InterventionOrigin = { rootKey: 'workspace/P1', chatId: 'P1/c', chatKey: 'workspace/P1/c', depth: 1 };
    const b = reg.create({ kind: 'confirm', prompt: 'p' }, origin);
    assert.deepStrictEqual(b.intervention.origin, origin);
  });
});
