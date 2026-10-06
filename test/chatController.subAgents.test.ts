/**
 * Unit tests for sub-agent chats inside the host-free Chat controller (spec
 * "sub-agent chats", todo T12). Imported statically with no `vscode` loader.
 *
 * Coverage:
 * 1. Top-level tool calls receive surface 'top' and a depth-0 caller.
 * 2. Spawn: the child transcript lives under `<id>.children/`, the tool result
 *    carries the reply, and the session list is the tree.
 * 3. Live posts are gated on the session in view; a running child can be
 *    selected (read-only), anything unrelated is refused while busy.
 * 4. A forwarded ask is shown on and persisted to the parent; the child gets
 *    the forwarded note; a card is not shown while the child is in view.
 * 5. Stop settles the forwarded card as declined and stops every descendant.
 * 6. Reload into a child is read-only; delete refuses a child and a parent
 *    delete removes its `.children` folder.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatController, STOP_DECLINE_REASON } from '../src/activation/chatController';
import type { ChatWebview } from '../src/activation/chatController';
import { createInterventionSeam, PendingAskRegistry, readTranscript, systemClock } from '../src/orchestrator';
import type {
  CompletionRequest,
  CompletionResult,
  GuardContext,
  HostToWebview,
  InterventionSeam,
  ModelClient,
  ToolRegistry,
  TranscriptRecord,
  WebviewToHost,
} from '../src/orchestrator';
import type { ToolCaller } from '../src/orchestrator/guard';
import { ok } from '../src/model/result';

class FakeWebview implements ChatWebview {
  public posts: HostToWebview[] = [];
  private handler?: (msg: WebviewToHost) => void;

  public post(m: HostToWebview): void {
    this.posts.push(m);
  }

  public onMessage(handler: (msg: WebviewToHost) => void): void {
    this.handler = handler;
  }

  public async send(msg: WebviewToHost): Promise<void> {
    await this.handler?.(msg);
  }

  public all<T extends HostToWebview['type']>(type: T): Array<Extract<HostToWebview, { type: T }>> {
    return this.posts.filter((m): m is Extract<HostToWebview, { type: T }> => m.type === type) as never;
  }

  public last<T extends HostToWebview['type']>(type: T): Extract<HostToWebview, { type: T }> | undefined {
    const all = this.all(type);
    return all[all.length - 1];
  }
}

/** One scripted completion: a result, optionally preceded by a delta, a gate or a hang. */
interface Script {
  result?: CompletionResult;
  delta?: string;
  /** Wait for this promise before answering. */
  gate?: Promise<void>;
  /** Wait until the request is aborted, then throw. */
  hang?: boolean;
}

/** Routes completions by session id: ids with a '/' are sub-agent chats. */
class RoutingClient implements ModelClient {
  public readonly parent: Script[] = [];
  public readonly child: Script[] = [];
  public requests = 0;
  /** The delta listener of the most recent child request. */
  public childDelta: ((t: string) => void) | undefined;

  public async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.requests += 1;
    const isChild = (req.sessionId ?? '').includes('/');
    const script = (isChild ? this.child : this.parent).shift() ?? { result: { content: 'done', tool_calls: [] } };
    if (isChild) {
      this.childDelta = req.onDelta;
    }
    if (script.delta !== undefined) {
      req.onDelta?.(script.delta);
    }
    if (script.gate !== undefined) {
      await script.gate;
    }
    if (script.hang === true) {
      await new Promise<void>((resolve) => {
        if (req.signal.aborted) {
          resolve();
        }
        req.signal.addEventListener('abort', () => resolve(), { once: true });
      });
      throw new Error('aborted');
    }
    return script.result ?? { content: 'done', tool_calls: [] };
  }
}

const call = (id: string, name: string, args: object): CompletionResult => ({
  content: '',
  tool_calls: [{ id, name, arguments: JSON.stringify(args) }],
});

describe('ChatController sub-agent chats', () => {
  let tmp: string;
  let baitonDir: string;
  let specsDir: string;
  let webview: FakeWebview;
  let client: RoutingClient;
  let askRegistry: PendingAskRegistry;
  let controller: ChatController;
  let toolCalls: Array<{ name: string; surface: unknown; caller: ToolCaller }>;
  let toolResults: string[];
  let logs: string[];

  function build(memory?: { get(scope: string): string | undefined; set(scope: string, id: string): Promise<void> }): {
    controller: ChatController;
    webview: FakeWebview;
  } {
    const wv = new FakeWebview();
    const holder: { seam?: InterventionSeam } = {};
    let present: (ask: Parameters<ChatController['presentIntervention']>[0]) => Promise<void> = async () => {};
    const base = createInterventionSeam(askRegistry, (ask) => present(ask));
    const registry = {
      definitions: () => [{ name: 'spawn_subagent', concurrent: true }],
      definitionsFor: () => [{ name: 'spawn_subagent', concurrent: true }],
      assembleFor: () => ok([]),
      call: async (name: string, args: Record<string, string>, _id: string, _ctx: unknown, _phase: unknown, surface: unknown, caller: ToolCaller) => {
        toolCalls.push({ name, surface, caller });
        let data: unknown;
        if (name === 'spawn_subagent') {
          data = await c.subAgents.spawn({ task: args.task, caller });
        } else if (name === 'send_to_subagent') {
          data = await c.subAgents.send({ chatId: args.chat_id, message: args.message, caller });
        } else if (name === 'ask_user') {
          data = await holder.seam!.ask({ kind: 'question', prompt: args.question, allowFreeText: true });
        } else {
          data = 'ok';
        }
        const text = JSON.stringify(data);
        toolResults.push(text);
        return { ok: true as const, data: text };
      },
    } as unknown as ToolRegistry;
    const c: ChatController = new ChatController({
      webview: wv,
      client,
      registry,
      toolsFor: () => [],
      guardContext: () => ({}) as GuardContext,
      baitonDir,
      specsDir,
      roundBound: () => 6,
      config: { getEndpoint: () => 'http://x', getModel: () => 'm' },
      triggerFix: () => {},
      log: (m) => logs.push(m),
      askRegistry,
      ...(memory !== undefined ? { sessionMemory: memory } : {}),
    });
    present = (ask) => c.presentIntervention(ask);
    holder.seam = c.subAgentInterventionSeam(base);
    return { controller: c, webview: wv };
  }

  async function waitFor(condition: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
      if (Date.now() > deadline) {
        assert.fail(`timed out waiting for: ${what}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  function idle(): boolean {
    return webview.last('setBusy')?.busy === false;
  }

  function topId(): string {
    const files = fs.readdirSync(path.join(baitonDir, 'chat')).filter((f) => f.endsWith('.jsonl'));
    assert.strictEqual(files.length, 1);
    return path.basename(files[0], '.jsonl');
  }

  function childId(): string {
    const kids = controller.subAgents.list();
    assert.strictEqual(kids.length, 1);
    return kids[0].chatId;
  }

  async function send(text = 'go'): Promise<void> {
    await webview.send({ type: 'sendText', text });
  }

  async function lines(file: string): Promise<TranscriptRecord[]> {
    return readTranscript(file);
  }

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-subagents-'));
    baitonDir = path.join(tmp, '.baiton');
    specsDir = path.join(baitonDir, 'specs');
    client = new RoutingClient();
    askRegistry = new PendingAskRegistry({
      ids: { next: () => `ask-${Date.now()}-${Math.random().toString(36).slice(2)}` },
      clock: systemClock,
    });
    toolCalls = [];
    toolResults = [];
    logs = [];
    ({ controller, webview } = build());
    controller.start();
  });

  afterEach(() => {
    controller.dispose();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('passes the top surface and a depth-0 caller on a top-level tool call', async () => {
    client.parent.push({ result: call('t1', 'read_file', {}) }, { result: { content: 'fin', tool_calls: [] } });
    await send();
    await waitFor(() => toolCalls.length === 1 && idle(), 'the run to end');
    assert.strictEqual(toolCalls[0].surface, 'top');
    assert.strictEqual(toolCalls[0].caller.sessionKey, `workspace/${topId()}`);
    assert.strictEqual(toolCalls[0].caller.depth, 0);
    assert.deepStrictEqual(toolCalls[0].caller.kind, { kind: 'workspace' });
    assert.strictEqual(toolCalls[0].caller.phase, 'run');
  });

  it('spawns a child chat under the parent and lists the session tree', async () => {
    client.parent.push({ result: call('s1', 'spawn_subagent', { task: 'inspect it' }) }, { result: { content: 'all done', tool_calls: [] } });
    client.child.push({ result: { content: 'child reply', tool_calls: [] } });
    await send();
    await waitFor(() => idle() && toolResults.length === 1, 'the run to end');
    const id = topId();
    assert.ok(toolResults[0].includes('child reply'));
    const kid = childId();
    const file = path.join(baitonDir, 'chat', `${id}.children`, `${kid.split('/').pop()}.jsonl`);
    assert.ok(fs.existsSync(file));
    const records = await lines(file);
    assert.strictEqual(records[0].role, 'user');
    assert.strictEqual(records[0].content, 'inspect it');
    const items = webview.last('setSessions')!.items;
    assert.deepStrictEqual(items.map((i) => i.id), [id, kid]);
    assert.strictEqual(items[1].parentId, id);
    assert.strictEqual(items[1].depth, 1);
  });

  it('posts live output only for the session in view and allows selecting the running descendants', async () => {
    client.parent.push({ result: call('s1', 'spawn_subagent', { task: 'secret task' }) }, { result: { content: 'all done', tool_calls: [] } });
    client.child.push({ delta: 'early', hang: true });
    await send();
    await waitFor(() => client.childDelta !== undefined, 'the child to start');
    const id = topId();
    const kid = childId();
    await waitFor(() => webview.last('setSessions')?.items.some((i) => i.id === kid) === true, 'the child row');
    const appended = webview.all('appendMessage').map((m) => m.record.content);
    assert.ok(!appended.includes('secret task'));
    assert.strictEqual(webview.all('streamDelta').length, 0);

    // An unrelated session cannot be selected while busy.
    await webview.send({ type: 'selectSession', sessionId: 'nope' });
    await waitFor(() => webview.last('showError')?.message === 'Wait for the current run to finish', 'the refusal');

    const before = webview.posts.length;
    await webview.send({ type: 'selectSession', sessionId: kid });
    await waitFor(() => webview.last('setReadOnly')?.readOnly === true, 'the read-only paint');
    await waitFor(() => webview.last('renderConversation')?.records[0]?.content === 'secret task', 'the child render');
    client.childDelta!('late');
    assert.ok(webview.posts.slice(before).some((m) => m.type === 'streamDelta' && m.text === 'late'));

    await webview.send({ type: 'selectSession', sessionId: id });
    await waitFor(() => webview.last('setReadOnly')?.readOnly === false, 'the parent paint');
    await waitFor(() => webview.last('renderConversation')?.records[0]?.content === 'go', 'the parent render');

    await webview.send({ type: 'stop' });
    await waitFor(idle, 'stop to finish');
  });

  it('shows a forwarded ask on the parent, persists it there and notes it on the child', async () => {
    client.parent.push({ result: call('s1', 'spawn_subagent', { task: 'ask me' }) }, { result: { content: 'fin', tool_calls: [] } });
    client.child.push({ result: call('q1', 'ask_user', { question: 'which?' }) }, { result: { content: 'thanks', tool_calls: [] } });
    await send();
    await waitFor(() => webview.all('showIntervention').length === 1, 'the forwarded card');
    const card = webview.last('showIntervention')!.intervention;
    assert.strictEqual(card.status, 'pending');
    assert.ok(card.prompt.startsWith('Sub-agent'));
    await webview.send({ type: 'answerIntervention', id: card.id, answer: { kind: 'text', text: 'blue' } });
    await waitFor(() => idle() && toolResults.length === 2, 'the run to end');
    const parent = (await lines(path.join(baitonDir, 'chat', `${topId()}.jsonl`))).filter((r) => r.intervention?.id === card.id);
    assert.strictEqual(parent.length, 1);
    assert.strictEqual(parent[0].intervention!.status, 'resolved');
    const kid = childId();
    const childRecords = await lines(path.join(baitonDir, 'chat', `${topId()}.children`, `${kid.split('/').pop()}.jsonl`));
    const notes = childRecords.filter((r) => r.intervention !== undefined);
    assert.strictEqual(notes.length, 1);
    assert.strictEqual(notes[0].forwarded, true);
  });

  it('does not show a forwarded ask while a child is in view until the parent is selected again', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    client.parent.push({ result: call('s1', 'spawn_subagent', { task: 'ask later' }) }, { result: { content: 'fin', tool_calls: [] } });
    client.child.push({ gate, result: call('q1', 'ask_user', { question: 'which?' }) }, { result: { content: 'thanks', tool_calls: [] } });
    await send();
    await waitFor(() => client.requests >= 2, 'the child to start');
    const id = topId();
    const kid = childId();
    await webview.send({ type: 'selectSession', sessionId: kid });
    release();
    await waitFor(() => askRegistry.size === 1, 'the ask to be raised');
    assert.strictEqual(webview.all('showIntervention').length, 0);
    await webview.send({ type: 'selectSession', sessionId: id });
    await waitFor(() => webview.all('showIntervention').length === 1, 'the reposted card');
    const card = webview.last('showIntervention')!.intervention;
    await webview.send({ type: 'answerIntervention', id: card.id, answer: { kind: 'text', text: 'x' } });
    await waitFor(idle, 'the run to end');
  });

  it('stop settles the forwarded card as declined and stops every descendant', async () => {
    client.parent.push({ result: call('s1', 'spawn_subagent', { task: 'ask me' }) });
    client.child.push({ result: call('q1', 'ask_user', { question: 'which?' }) });
    await send();
    await waitFor(() => webview.all('showIntervention').length === 1, 'the forwarded card');
    const card = webview.last('showIntervention')!.intervention;
    await webview.send({ type: 'stop' });
    await waitFor(() => idle() && webview.all('resolveIntervention').length === 1, 'stop to finish');
    const resolved = webview.last('resolveIntervention')!;
    assert.strictEqual(resolved.id, card.id);
    assert.deepStrictEqual(resolved.answer, { kind: 'declined', reason: STOP_DECLINE_REASON });
    await waitFor(() => {
      try {
        return fs
          .readFileSync(path.join(baitonDir, 'chat', `${topId()}.jsonl`), 'utf8')
          .includes(`"status":"resolved"`);
      } catch {
        return false;
      }
    }, 'the settled record');
    const settled = (await lines(path.join(baitonDir, 'chat', `${topId()}.jsonl`))).filter((r) => r.intervention?.id === card.id);
    assert.strictEqual(settled.length, 1);
    assert.strictEqual(askRegistry.size, 0);
    assert.ok(controller.subAgents.list().every((i) => !i.running));
  });

  it('reopens a child read-only after a reload and guards send, compact and delete', async () => {
    client.parent.push({ result: call('s1', 'spawn_subagent', { task: 'inspect it' }) }, { result: { content: 'fin', tool_calls: [] } });
    client.child.push({ result: { content: 'child reply', tool_calls: [] } });
    await send();
    await waitFor(() => idle() && toolResults.length === 1, 'the run to end');
    const id = topId();
    const kid = childId();
    const childFile = path.join(baitonDir, 'chat', `${id}.children`, `${kid.split('/').pop()}.jsonl`);
    controller.dispose();

    const second = build({ get: () => kid, set: async () => {} });
    second.controller.start();
    await waitFor(() => second.webview.last('setReadOnly') !== undefined, 'the reload paint');
    assert.deepStrictEqual(second.webview.last('setSessions')!.items.map((i) => i.id), [id, kid]);
    assert.strictEqual(second.webview.last('setActiveSession')!.sessionId, kid);
    assert.strictEqual(second.webview.last('setReadOnly')!.readOnly, true);

    const requests = client.requests;
    await second.webview.send({ type: 'sendText', text: 'hello' });
    assert.strictEqual(client.requests, requests);

    await second.webview.send({ type: 'deleteSession', sessionId: kid });
    await waitFor(() => second.webview.last('showError') !== undefined, 'the refusal');
    assert.strictEqual(second.webview.last('showError')!.message, 'Sub-agent chats are deleted with their parent.');
    assert.ok(fs.existsSync(childFile));

    await second.webview.send({ type: 'deleteSession', sessionId: id });
    await waitFor(() => !fs.existsSync(path.join(baitonDir, 'chat', `${id}.children`)), 'the children folder to go');
    assert.ok(!fs.existsSync(path.join(baitonDir, 'chat', `${id}.jsonl`)));
    second.controller.dispose();
  });
});
