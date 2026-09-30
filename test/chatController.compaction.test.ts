/**
 * Tests for the Chat controller's context summarisation (context-budget T06):
 * the text-only summarise step at `contextSummarizeAt`, its inline failure
 * handling, replay after a reload, and the pure helpers.
 *
 * Imports {@link ChatController} statically (no vscode loader), like the mode suite.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ChatController,
  SUMMARY_SYSTEM_PROMPT,
  resolveContextSummarizeAt,
  summaryRequestMessages,
} from '../src/activation/chatController';
import type { ChatWebview } from '../src/activation/chatController';
import { ChatTranscript, readTranscript } from '../src/orchestrator';
import type {
  ChatMessage,
  CompletionResult,
  GuardContext,
  HostToWebview,
  ModelClient,
  ToolRegistry,
  ToolSpec,
  TranscriptRecord,
  WebviewToHost,
} from '../src/orchestrator';

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

interface Req {
  messages: ChatMessage[];
  tools?: ToolSpec[];
}

/** Records full requests and pops scripted results (or throws scripted Errors). */
class FakeClient implements ModelClient {
  public readonly requests: Req[] = [];
  public readonly queue: Array<CompletionResult | Error> = [];
  public async complete(req: Req): Promise<CompletionResult> {
    this.requests.push({ messages: req.messages, tools: req.tools });
    const next = this.queue.shift();
    if (next instanceof Error) {
      throw next;
    }
    return next ?? { content: 'done', tool_calls: [] };
  }
}

describe('ChatController context summarisation (context-budget T06)', () => {
  let webview: FakeWebview;
  let client: FakeClient;
  let baitonDir: string;
  let controller: ChatController;
  let cleanup: (() => void) | undefined;
  let seeded: TranscriptRecord[];

  const big = (c: string): string => c.repeat(1600);

  async function build(opts: { window: number | undefined; small?: boolean }): Promise<void> {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-chat-compact-'));
    baitonDir = path.join(tmp, '.baiton');
    const specsDir = path.join(baitonDir, 'specs');
    fs.mkdirSync(specsDir, { recursive: true });
    fs.mkdirSync(path.join(baitonDir, 'chat'), { recursive: true });
    cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });
    webview = new FakeWebview();
    client = new FakeClient();

    let tick = 0;
    const file = path.join(baitonDir, 'chat', 'seed.jsonl');
    const t = new ChatTranscript(file, { now: () => `2026-01-01T00:00:${String(tick++).padStart(2, '0')}.000Z` });
    const body = (c: string): string => (opts.small === true ? c : big(c));
    await t.append({ role: 'user', content: body('a') });
    await t.append({ role: 'assistant', content: body('b') });
    await t.append({ role: 'user', content: body('c') });
    await t.append({ role: 'assistant', content: body('d') });
    await t.append({ role: 'user', content: 'u3' });
    await t.append({ role: 'assistant', content: 'a3' });
    seeded = await readTranscript(file);

    controller = new ChatController({
      webview,
      client,
      registry: { call: async () => ({ ok: true, data: 'ok' }) } as unknown as ToolRegistry,
      toolsFor: () => [],
      guardContext: () => ({ restricted: false }) as GuardContext,
      baitonDir,
      specsDir,
      roundBound: () => 4,
      contextWindow: () => opts.window,
      contextTrimAt: () => 0.5,
      contextSummarizeAt: () => 0.8,
      sessionMemory: { get: () => 'seed', set: async () => {} },
      config: { getEndpoint: () => 'http://x', getModel: () => 'm' },
      triggerFix: () => {},
      log: () => {},
    });
    controller.start();
    await waitFor(() => webview.all('renderConversation').length >= 1, 'the first render');
  }

  async function waitFor(cond: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!cond()) {
      if (Date.now() > deadline) {
        assert.fail(`timed out waiting for: ${what}`);
      }
      await new Promise((r) => setTimeout(r, 5));
    }
  }

  async function send(text: string): Promise<void> {
    const before = webview.all('setBusy').length;
    await webview.send({ type: 'sendText', text });
    await waitFor(
      () => webview.all('setBusy').length > before && webview.last('setBusy')?.busy === false,
      'the send to finish',
    );
  }

  const records = (): Promise<TranscriptRecord[]> => readTranscript(path.join(baitonDir, 'chat', 'seed.jsonl'));
  const summaries = (msgs: ChatMessage[]): ChatMessage[] =>
    msgs.filter((m) => m.content.startsWith('[context summary] '));

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it('summarises older turns over the threshold and keeps the full transcript visible', async () => {
    await build({ window: 1000 });
    client.queue.push({ content: 'Goals: g', tool_calls: [] });
    await send('next');

    assert.strictEqual(client.requests.length, 2);
    const [summ, loop] = client.requests;
    assert.strictEqual(summ.tools, undefined);
    assert.strictEqual(summ.messages.length, 2);
    assert.deepStrictEqual(summ.messages[0], { role: 'system', content: SUMMARY_SYSTEM_PROMPT });
    // The request budget is half the (tiny) window, so the oldest blocks are
    // dropped; the newest summarised turn is always present.
    assert.ok(summ.messages[1].content.includes('dddd'));
    assert.ok(summ.messages[1].content.includes('[earlier messages omitted]'));
    assert.ok(!summ.messages[1].content.includes('next'));

    assert.deepStrictEqual(loop.messages[1], { role: 'assistant', content: '[context summary] Goals: g' });
    assert.ok(!loop.messages.some((m) => m.content === big('a') || m.content === big('b')));
    assert.ok(loop.messages.some((m) => m.content === 'u3'));
    assert.ok(loop.messages.some((m) => m.content === 'next'));

    const recs = await records();
    const comps = recs.filter((r) => r.compaction !== undefined);
    assert.strictEqual(comps.length, 1);
    assert.strictEqual(comps[0].role, 'system');
    assert.strictEqual(comps[0].compaction?.fromTs, seeded[0].ts);
    assert.strictEqual(comps[0].compaction?.toTs, seeded[3].ts);
    assert.strictEqual(comps[0].compaction?.messages, 4);
    for (const s of seeded) {
      assert.ok(recs.some((r) => r.ts === s.ts && r.content === s.content));
    }

    const rendered = webview.last('renderConversation')?.records ?? [];
    assert.ok(rendered.some((r) => r.content === big('a')));
    assert.ok(rendered.some((r) => r.content === big('b')));
    assert.ok(rendered.some((r) => r.content === 'Goals: g'));
  });

  it('shows an inline error and proceeds unchanged when the summary fails', async () => {
    await build({ window: 1000 });
    client.queue.push(new Error('boom'));
    await send('next');

    const err = webview.all('showError').find((e) => e.message.startsWith('Compacting the conversation failed: boom'));
    assert.ok(err, 'an inline error was posted');
    assert.strictEqual((await records()).filter((r) => r.compaction !== undefined).length, 0);
    assert.strictEqual(client.requests.length, 2);
    assert.ok(client.requests[1].messages.some((m) => m.content === big('a')));
    const recs = await records();
    assert.strictEqual(recs[recs.length - 1].role, 'assistant');
    assert.strictEqual(recs[recs.length - 1].content, 'done');
  });

  it('treats an empty summary as a failure', async () => {
    await build({ window: 1000 });
    client.queue.push({ content: '   ', tool_calls: [] });
    await send('next');
    assert.ok(webview.all('showError').some((e) => e.message.startsWith('Compacting the conversation failed:')));
    assert.strictEqual((await records()).filter((r) => r.compaction !== undefined).length, 0);
  });

  it('does not summarise below the threshold', async () => {
    await build({ window: 100_000, small: true });
    await send('next');
    assert.strictEqual(client.requests.length, 1);
    assert.strictEqual((await records()).filter((r) => r.compaction !== undefined).length, 0);
  });

  it('does not summarise when the window is unknown', async () => {
    await build({ window: undefined });
    await send('next');
    assert.strictEqual(client.requests.length, 1);
    assert.strictEqual((await records()).filter((r) => r.compaction !== undefined).length, 0);
  });

  it('replays the summary after a reload', async () => {
    await build({ window: 1000 });
    client.queue.push({ content: 'Goals: g', tool_calls: [] });
    await send('next');
    await send('again');
    // A second compaction may run first; the loop request is the last one.
    const firstLoop = client.requests[client.requests.length - 1];
    assert.ok(firstLoop !== undefined);
    assert.strictEqual(summaries(firstLoop.messages).length, 1);
    assert.ok(!firstLoop.messages.some((m) => m.content === big('a')));
  });

  describe('resolveContextSummarizeAt', () => {
    it('falls back to 0.8 for unusable values and passes valid ones', () => {
      for (const v of [undefined, 0, -1, 1.5, 'x', NaN]) {
        assert.strictEqual(resolveContextSummarizeAt(v), 0.8);
      }
      assert.strictEqual(resolveContextSummarizeAt(0.6), 0.6);
      assert.strictEqual(resolveContextSummarizeAt(1), 1);
    });
  });

  describe('summaryRequestMessages', () => {
    it('clips tool results and never emits tool roles', () => {
      const out = summaryRequestMessages(
        [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'x', tool_calls: [{ id: 'c1', name: 'read', arguments: '{"p":1}' }] },
          { role: 'tool', content: 'z'.repeat(5000), tool_call_id: 'c1' },
        ],
        100_000,
      );
      assert.strictEqual(out.length, 2);
      assert.ok(out.every((m) => m.role === 'system' || m.role === 'user'));
      assert.ok(out.every((m) => m.tool_calls === undefined));
      const body = out[1].content;
      assert.ok(body.includes('assistant called read({"p":1})'));
      assert.ok(body.includes('tool result (c1):'));
      assert.ok(body.includes(`${'z'.repeat(2048)} …[clipped]`));
      assert.ok(!body.includes('z'.repeat(2049)));
    });

    it('drops the oldest blocks when over the token budget', () => {
      const msgs: ChatMessage[] = Array.from({ length: 10 }, (_, i) => ({
        role: 'user' as const,
        content: `m${i}-${'q'.repeat(400)}`,
      }));
      const out = summaryRequestMessages(msgs, 300);
      const body = out[1].content;
      assert.ok(body.includes('[earlier messages omitted]'));
      assert.ok(!body.includes('m0-'));
      assert.ok(body.includes('m9-'));
    });
  });
});
