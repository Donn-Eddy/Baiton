/**
 * Unit tests for the host-free Chat controller's intervention flow (spec
 * "Chat Interventions", todo T07).
 *
 * This suite imports {@link ChatController} statically with no
 * `test/fixtures/vscodeLoader.mjs` hook, proving that the controller carries no
 * `vscode` imports and remains fully host-free and unit-testable.
 *
 * Coverage:
 * 1. Card raised and the loop pauses — a tool asking through the shared
 *    `InterventionSeam` posts exactly one `showIntervention` with a pending
 *    view and does not return until the ask is settled.
 * 2. Approve settles in place and resumes — `answerIntervention` with
 *    `{ kind: 'approved' }` posts a `resolveIntervention` carrying the answer,
 *    the tool observes it, and the send completes (busy off last).
 * 3. Decline — same shape with a declined answer and the tool's refusal result.
 * 4. Persistence — exactly one settled `system` record with the prompt as
 *    `content` and `intervention.status === 'resolved'` in the session
 *    transcript; `readTranscript` + `toRenderRecords` re-render the settled card.
 * 5. Invalid answer — a `text` answer to a confirm posts `showError`, posts no
 *    `resolveIntervention`, leaves the ask pending; a following approval settles it.
 * 6. Unknown id — settles the stale card as declined without throwing.
 * 7. Stop declines pending asks — `stop` resolves each pending card declined
 *    with {@link STOP_DECLINE_REASON}, empties the registry, and the in-flight
 *    send completes.
 * 8. History projection — a settled card re-enters the model history as one
 *    assistant message `[intervention] <prompt>\nDecision: approved`, never as
 *    the bare prompt.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatController, STOP_DECLINE_REASON } from '../src/activation/chatController';
import type {
  ChatWebview,
} from '../src/activation/chatController';
import {
  createInterventionSeam,
  PendingAskRegistry,
  readTranscript,
  systemClock,
  toRenderRecords,
} from '../src/orchestrator';
import type {
  CompletionResult,
  GuardContext,
  HostToWebview,
  Intervention,
  InterventionAnswer,
  InterventionSeam,
  ModelClient,
  RenderRecord,
  ToolRegistry,
  TranscriptRecord,
  WebviewToHost,
} from '../src/orchestrator';

/** A fake webview that records every posted message and can drive the handler. */
class FakeWebview implements ChatWebview {
  public posts: HostToWebview[] = [];
  private handler?: (msg: WebviewToHost) => void;

  public post(m: HostToWebview): void {
    this.posts.push(m);
  }

  public onMessage(handler: (msg: WebviewToHost) => void): void {
    this.handler = handler;
  }

  /** Send one webview→host message through the registered handler. */
  public async send(msg: WebviewToHost): Promise<void> {
    await this.handler?.(msg);
  }

  /** The last message of the given type, or `undefined` when none was posted. */
  public last<T extends HostToWebview['type']>(type: T): Extract<HostToWebview, { type: T }> | undefined {
    return this.all(type)[this.all(type).length - 1];
  }

  /** Every message of the given type, in post order. */
  public all<T extends HostToWebview['type']>(type: T): Array<Extract<HostToWebview, { type: T }>> {
    return this.posts.filter((m): m is Extract<HostToWebview, { type: T }> => m.type === type) as never;
  }
}

/** A scripted model client: pops one completion per round, keeping the history. */
class FakeModelClient implements ModelClient {
  public readonly queue: CompletionResult[] = [];
  public readonly requests: Array<{ role: string; content: string }[]> = [];
  /** The `sessionId` each request carried, in completion order. */
  public readonly sessionIds: Array<string | undefined> = [];

  public async complete(req: { messages: { role: string; content: string }[]; sessionId?: string }): Promise<CompletionResult> {
    this.requests.push(req.messages);
    this.sessionIds.push(req.sessionId);
    const next = this.queue.shift();
    return next ?? { content: 'done', tool_calls: [] };
  }
}

describe('ChatController interventions', () => {
  let webview: FakeWebview;
  let client: FakeModelClient;
  let baitonDir: string;
  let specsDir: string;
  let askRegistry: PendingAskRegistry;
  let seam: InterventionSeam;
  let controller: ChatController;
  /** The answers the fake tool observed, in call order. */
  let observed: InterventionAnswer[];
  let cleanup: (() => void) | undefined;

  /** Build a fresh controller + harness over a temp workspace. */
  function buildHarness(): void {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-chat-'));
    baitonDir = path.join(tmp, '.baiton');
    specsDir = path.join(tmp, '.baiton', 'specs');
    cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });

    webview = new FakeWebview();
    client = new FakeModelClient();
    // Round 1 asks for the confirm tool call, round 2 finishes the loop.
    client.queue.push(
      { content: '', tool_calls: [{ id: 'c1', name: 'confirm_tool', arguments: '{}' }] },
      { content: 'done', tool_calls: [] },
    );
    observed = [];
    askRegistry = new PendingAskRegistry({
      ids: { next: () => `ask-${Date.now()}-${Math.random().toString(36).slice(2)}` },
      clock: systemClock,
    });

    const fakeRegistry = {
      call: async (): Promise<{ ok: true; data: string } | { ok: false; error: string }> => {
        const answer = await seam.ask({
          kind: 'confirm',
          prompt: 'Approve spec "x"?',
          detail: 'This creates its branch.',
        });
        observed.push(answer);
        return answer.kind === 'approved'
          ? { ok: true, data: 'approved' }
          : { ok: false, error: 'approval of spec "x" was declined; the spec is unchanged' };
      },
    } as unknown as ToolRegistry;

    // The seam is needed before the controller exists; bind the presenter
    // lazily through a mutable local, exactly as `commands.ts` does.
    let present: (ask: Intervention) => void = () => {};
    seam = createInterventionSeam(askRegistry, (ask) => present(ask));

    controller = new ChatController({
      webview,
      client,
      registry: fakeRegistry,
      toolsFor: () => [],
      guardContext: () => ({}) as GuardContext,
      baitonDir,
      specsDir,
      roundBound: () => 4,
      config: { getEndpoint: () => 'http://x', getModel: () => 'm' },
      triggerFix: () => {},
      log: () => {},
      askRegistry,
    });
    present = (ask) => controller.presentIntervention(ask);
  }

  /** Poll until `condition` holds, failing after a generous timeout. */
  async function waitFor(condition: () => boolean, what: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    while (!condition()) {
      if (Date.now() > deadline) {
        assert.fail(`timed out waiting for: ${what}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /** Drive a send; the controller handles fire-and-forget, so follow with waitFor. */
  function startSend(): Promise<void> {
    controller.start();
    return webview.send({ type: 'sendText', text: 'go' });
  }

  /** Wait until the run has finished (busy off), having reached `minRequests` completions. */
  async function awaitRunEnd(minRequests = 1): Promise<void> {
    await waitFor(
      () =>
        client.requests.length >= minRequests &&
        webview.last('setBusy')?.busy === false,
      'the run to finish (setBusy false)',
    );
  }

  /** The single workspace-session transcript file after a send has started. */
  function transcriptFile(): string {
    const dir = path.join(baitonDir, 'chat');
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl'));
    assert.strictEqual(files.length, 1);
    return path.join(dir, files[0]);
  }

  beforeEach(buildHarness);

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it('posts one pending card and blocks the tool call until the ask is settled', async () => {
    startSend();
    await waitFor(() => webview.all('showIntervention').length === 1, 'the pending card');

    const card = webview.last('showIntervention')!.intervention;
    assert.ok(card.id.length > 0);
    assert.strictEqual(card.kind, 'confirm');
    assert.strictEqual(card.status, 'pending');
    assert.strictEqual(card.prompt, 'Approve spec "x"?');
    assert.strictEqual(card.detail, 'This creates its branch.');
    // The loop is blocked on the ask: no tool result yet, and no render of the
    // finished loop beyond the one start() posted.
    assert.strictEqual(observed.length, 0);
    assert.strictEqual(webview.all('renderConversation').length, 1);

    await webview.send({ type: 'answerIntervention', id: card.id, answer: { kind: 'approved' } });
    await waitFor(() => observed.length === 1, 'the paused tool to resume');
    await awaitRunEnd();
  });

  it('settles an approval in place, resumes the tool, and completes the send', async () => {
    startSend();
    await waitFor(() => webview.all('showIntervention').length === 1, 'the pending card');
    const card = webview.last('showIntervention')!.intervention;

    await webview.send({ type: 'answerIntervention', id: card.id, answer: { kind: 'approved' } });
    await awaitRunEnd();

    const resolved = webview.all('resolveIntervention');
    assert.strictEqual(resolved.length, 1);
    assert.strictEqual(resolved[0].id, card.id);
    assert.deepStrictEqual(resolved[0].answer, { kind: 'approved' });
    assert.deepStrictEqual(observed, [{ kind: 'approved' }]);
    assert.strictEqual(askRegistry.size, 0);
  });

  it('settles a decline and records the tool result', async () => {
    startSend();
    await waitFor(() => webview.all('showIntervention').length === 1, 'the pending card');
    const card = webview.last('showIntervention')!.intervention;

    await webview.send({
      type: 'answerIntervention',
      id: card.id,
      answer: { kind: 'declined', reason: 'no' },
    });
    await awaitRunEnd();

    const resolved = webview.all('resolveIntervention');
    assert.strictEqual(resolved.length, 1);
    assert.strictEqual(resolved[0].id, card.id);
    assert.deepStrictEqual(resolved[0].answer, { kind: 'declined', reason: 'no' });
    assert.deepStrictEqual(observed, [{ kind: 'declined', reason: 'no' }]);
  });

  it('persists exactly one settled system record the view re-renders', async () => {
    startSend();
    await waitFor(() => webview.all('showIntervention').length === 1, 'the pending card');
    const card = webview.last('showIntervention')!.intervention;

    await webview.send({ type: 'answerIntervention', id: card.id, answer: { kind: 'approved' } });
    await awaitRunEnd();

    const file = transcriptFile();
    const rawLines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() !== '');
    assert.ok(rawLines.length >= 1, 'the transcript should have records');
    const interventionRecords = rawLines
      .map((line) => JSON.parse(line) as TranscriptRecord)
      .filter((r) => r.intervention !== undefined);
    assert.strictEqual(interventionRecords.length, 1);
    const record = interventionRecords[0];
    assert.strictEqual(record.role, 'system');
    assert.strictEqual(record.content, 'Approve spec "x"?');
    assert.strictEqual(record.intervention!.status, 'resolved');
    assert.deepStrictEqual(record.intervention!.answer, { kind: 'approved' });

    // The card survives a re-render through the normal reader.
    const persisted = await readTranscript(file);
    const rendered: RenderRecord[] = toRenderRecords(persisted);
    const withCard = rendered.filter((r) => r.intervention !== undefined);
    assert.strictEqual(withCard.length, 1);
    assert.strictEqual(withCard[0].intervention!.status, 'resolved');
    assert.deepStrictEqual(withCard[0].intervention!.answer, { kind: 'approved' });
  });

  it('rejects an invalid answer, reports why, and leaves the ask pending', async () => {
    startSend();
    await waitFor(() => webview.all('showIntervention').length === 1, 'the pending card');
    const card = webview.last('showIntervention')!.intervention;

    webview.send({
      type: 'answerIntervention',
      id: card.id,
      answer: { kind: 'text', text: 'maybe' },
    });
    await waitFor(() => webview.all('showError').length === 1, 'the rejection message');

    assert.strictEqual(webview.all('resolveIntervention').length, 0);
    assert.strictEqual(askRegistry.size, 1);

    // A valid answer still settles it afterwards.
    await webview.send({ type: 'answerIntervention', id: card.id, answer: { kind: 'approved' } });
    await awaitRunEnd();
    assert.strictEqual(askRegistry.size, 0);
  });

  it('settles an unknown id as declined without throwing', async () => {
    startSend();
    await waitFor(() => webview.all('showIntervention').length === 1, 'the pending card');

    await assert.doesNotReject(
      webview.send({ type: 'answerIntervention', id: 'nope', answer: { kind: 'approved' } }),
    );
    const resolved = webview.all('resolveIntervention').filter((m) => m.id === 'nope');
    assert.strictEqual(resolved.length, 1);
    assert.strictEqual(resolved[0].answer.kind, 'declined');
    // The live ask is untouched and the loop can still be answered normally.
    assert.strictEqual(askRegistry.size, 1);
    const card = webview.last('showIntervention')!.intervention;
    await webview.send({ type: 'answerIntervention', id: card.id, answer: { kind: 'approved' } });
    await waitFor(() => observed.length === 1, 'the real ask to settle');
    await awaitRunEnd();
  });

  it('declines every pending ask on stop and completes the run', async () => {
    startSend();
    await waitFor(() => webview.all('showIntervention').length === 1, 'the pending card');

    await webview.send({ type: 'stop' });
    await waitFor(() => observed.length === 1, 'the paused tool to resume');
    assert.deepStrictEqual(observed[0], { kind: 'declined', reason: STOP_DECLINE_REASON });
    const settled = webview.all('resolveIntervention');
    assert.strictEqual(settled.length, 1);
    assert.strictEqual(settled[0].answer.kind, 'declined');
    assert.strictEqual(settled[0].rationale, STOP_DECLINE_REASON);
    assert.strictEqual(askRegistry.size, 0);

    await awaitRunEnd();
  });

  it('feeds the model the settled card as one assistant history message', async () => {
    startSend();
    await waitFor(() => webview.all('showIntervention').length === 1, 'the pending card');
    const card = webview.last('showIntervention')!.intervention;
    await webview.send({ type: 'answerIntervention', id: card.id, answer: { kind: 'approved' } });
    await awaitRunEnd();

    // A second send loads the persisted history into the model request.
    await webview.send({ type: 'sendText', text: 'continue' });
    await awaitRunEnd(3);

    const messages = client.requests[client.requests.length - 1];
    const barePrompt = messages.filter((m) => m.content === 'Approve spec "x"?');
    assert.strictEqual(barePrompt.length, 0, 'the bare prompt must not be a history message');
    const projected = messages.filter(
      (m) => m.role === 'assistant' && m.content.startsWith('[intervention] '),
    );
    assert.strictEqual(projected.length, 1);
    assert.ok(projected[0].content.includes('Decision: approved'));
    assert.ok(projected[0].content.includes('[intervention] Approve spec "x"?'));
  });

  it('sends the same sessionId the transcript is written under, stable within a session and distinct after newChat', async () => {
    // Send 1: the controller allocates and remembers the chat session id. The
    // loop makes two completions (tool call + final), so wait for exactly 2.
    startSend();
    await waitFor(() => webview.all('showIntervention').length === 1, 'the pending card');
    const run1Card = webview.last('showIntervention')!.intervention;
    await webview.send({ type: 'answerIntervention', id: run1Card.id, answer: { kind: 'approved' } });
    await awaitRunEnd(2);

    const first = client.sessionIds[0];
    assert.ok(first !== undefined, 'the controller threads its session id into every completion');
    assert.strictEqual(client.sessionIds[1], first, 'stays stable across one session');

    // The id matches the one the transcript was written under (the filename).
    const file = path.basename(transcriptFile());
    assert.ok(file.includes(first), `transcript file ${file} carries session id ${first}`);

    // Send 2 in the same session, answering its own confirm card: both
    // completions reuse the same id. The send is fire-and-forget: the handler
    // resolves only when the whole loop ends.
    void webview.send({ type: 'sendText', text: 'continue' }).catch(() => {});
    await awaitRunEnd(3);
    assert.strictEqual(client.sessionIds[2], first, 'second send in one session keeps the id');

    // A new chat switches sessions, so the next send keys on a different id.
    await webview.send({ type: 'newChat' });
    await waitFor(() => {
      const active = webview.last('setActiveSession')?.sessionId;
      return active !== undefined && active !== first;
    }, 'the controller to switch to a fresh session');
    void webview.send({ type: 'sendText', text: 'fresh' }).catch(() => {});
    await awaitRunEnd(4);
    const last = client.sessionIds[client.sessionIds.length - 1];
    assert.ok(last !== undefined && last !== first, 'a different chat session yields a different sessionId');
  });
});
