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
 * 9. Provider selection — `start()` posts `setProviders` (router entries in
 *    order, before `setEmptyState`), `selectModel` switches the selection for
 *    the next turn without touching the transcript, a rejected switch repaints
 *    the unchanged selection, a router-side change posts a fresh dropdown, the
 *    subscription never stacks across `start()` calls and `dispose()` stops
 *    the posts, a missing provider key maps to a provider-scoped inline error
 *    whose fix echoes `triggerFix { provider }`, the controller works without
 *    the `providers` dep, and an `availability()` failure logs and skips only
 *    the dropdown post.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ChatController,
  STOP_DECLINE_REASON,
} from '../src/activation/chatController';
import type {
  ChatWebview,
  ProviderAvailabilityView,
  ProviderSource,
} from '../src/activation/chatController';
import {
  COPILOT_UNAVAILABLE_REASON,
  createInterventionSeam,
  MissingConfigError,
  PendingAskRegistry,
  providerNeedsKeyReason,
  readTranscript,
  systemClock,
  toRenderRecords,
} from '../src/orchestrator';
import type {
  CompletionResult,
  FixAction,
  GuardContext,
  HostToWebview,
  Intervention,
  InterventionAnswer,
  InterventionSeam,
  ModelClient,
  ModelSelection,
  ProviderId,
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
  /** When set, `complete` throws it instead of popping the queue. */
  public failWith: unknown;

  public async complete(req: { messages: { role: string; content: string }[]; sessionId?: string }): Promise<CompletionResult> {
    this.requests.push(req.messages);
    this.sessionIds.push(req.sessionId);
    if (this.failWith !== undefined) {
      throw this.failWith;
    }
    const next = this.queue.shift();
    return next ?? { content: 'done', tool_calls: [] };
  }
}

/** A fake ProviderRouter bound as the controller's provider seam. */
class FakeProviders implements ProviderSource {
  public entries: ProviderAvailabilityView[] = [
    { id: 'copilot', label: 'GitHub Copilot', enabled: false, reason: COPILOT_UNAVAILABLE_REASON, models: [] },
    { id: 'google', label: 'Google AI Studio', enabled: true, models: ['gemini-2.5-pro', 'gemini-2.5-flash'] },
    { id: 'mistral', label: 'Mistral AI', enabled: false, reason: providerNeedsKeyReason('mistral'), models: ['mistral-large-latest'] },
  ];
  public selection: ModelSelection | undefined = { provider: 'google', model: 'gemini-2.5-pro' };
  public readonly selected: unknown[] = [];
  public accept = true;
  public failAvailability = false;
  private readonly listeners = new Set<(s: ModelSelection | undefined) => void>();

  public async availability(): Promise<ProviderAvailabilityView[]> {
    if (this.failAvailability) {
      throw new Error('nope');
    }
    return this.entries;
  }

  public getSelection(): ModelSelection | undefined {
    return this.selection;
  }

  public async select(value: unknown): Promise<boolean> {
    this.selected.push(value);
    if (!this.accept) {
      return false;
    }
    this.selection = value as ModelSelection;
    for (const l of [...this.listeners]) {
      l(this.selection);
    }
    return true;
  }

  public onDidChangeSelection(l: (s: ModelSelection | undefined) => void): { dispose(): void } {
    this.listeners.add(l);
    return { dispose: () => { this.listeners.delete(l); } };
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
  let providers: FakeProviders;
  let fixes: Array<{ action: FixAction; provider?: ProviderId }>;
  let logs: string[];
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
    providers = new FakeProviders();
    fixes = [];
    logs = [];
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
      triggerFix: (action, provider) => {
        fixes.push({ action, provider });
      },
      log: (message) => {
        logs.push(message);
      },
      askRegistry,
      providers,
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

  describe('provider selection', () => {
    it('start() posts one setProviders with the router entries in order and the active selection', async () => {
      controller.start();
      await waitFor(() => webview.all('setProviders').length === 1, 'the first setProviders');
      const posted = webview.last('setProviders')!;
      assert.deepStrictEqual(posted.groups, [
        { id: 'copilot', label: 'GitHub Copilot', enabled: false, reason: COPILOT_UNAVAILABLE_REASON, models: [] },
        {
          id: 'google',
          label: 'Google AI Studio',
          enabled: true,
          models: [{ id: 'gemini-2.5-pro' }, { id: 'gemini-2.5-flash' }],
        },
        {
          id: 'mistral',
          label: 'Mistral AI',
          enabled: false,
          reason: providerNeedsKeyReason('mistral'),
          models: [{ id: 'mistral-large-latest' }],
        },
      ]);
      assert.deepStrictEqual(posted.selection, { provider: 'google', model: 'gemini-2.5-pro' });
    });

    it('posts setProviders before the first setEmptyState', async () => {
      controller.start();
      await waitFor(() => webview.all('setEmptyState').length > 0, 'the empty state');
      const firstProviders = webview.posts.findIndex((m) => m.type === 'setProviders');
      const firstEmpty = webview.posts.findIndex((m) => m.type === 'setEmptyState');
      assert.ok(firstProviders >= 0, 'setProviders was posted');
      assert.ok(firstProviders < firstEmpty, 'setProviders must precede setEmptyState');
    });

    it('posts selection null when the router has no selection', async () => {
      providers.selection = undefined;
      controller.start();
      await waitFor(() => webview.all('setProviders').length === 1, 'the first setProviders');
      assert.strictEqual(webview.last('setProviders')!.selection, null);
    });

    it('selectModel switches for the next turn without touching the transcript', async () => {
      startSend();
      await waitFor(() => webview.all('showIntervention').length === 1, 'the pending card');
      const card = webview.last('showIntervention')!.intervention;
      await webview.send({ type: 'answerIntervention', id: card.id, answer: { kind: 'approved' } });
      await awaitRunEnd(2);

      const beforePosts = webview.posts.length;
      const beforeBytes = fs.readFileSync(transcriptFile(), 'utf8');
      const beforeFiles = fs.readdirSync(path.join(baitonDir, 'chat')).slice().sort();
      const beforeRenders = webview.all('renderConversation').length;
      const beforeAppends = webview.all('appendMessage').length;
      const beforeBusy = webview.all('setBusy').length;

      await webview.send({ type: 'selectModel', provider: 'google', model: 'gemini-2.5-flash' });

      assert.deepStrictEqual(providers.selected, [{ provider: 'google', model: 'gemini-2.5-flash' }]);
      await waitFor(() => webview.posts.length > beforePosts, 'the repaint to arrive');
      assert.deepStrictEqual(
        webview.all('setProviders')[webview.all('setProviders').length - 1].selection,
        { provider: 'google', model: 'gemini-2.5-flash' },
      );
      assert.strictEqual(webview.posts.length, beforePosts + 1, 'only the setProviders repaint was posted');
      assert.strictEqual(fs.readFileSync(transcriptFile(), 'utf8'), beforeBytes, 'the transcript bytes are untouched');
      assert.deepStrictEqual(
        fs.readdirSync(path.join(baitonDir, 'chat')).slice().sort(),
        beforeFiles,
        'the session file list is untouched',
      );
      // No re-render of the transcript.
      assert.strictEqual(webview.all('renderConversation').length, beforeRenders, 'no extra renderConversation');
      assert.strictEqual(webview.all('appendMessage').length, beforeAppends, 'no extra appendMessage');
      assert.strictEqual(webview.all('setBusy').length, beforeBusy, 'no extra setBusy');
    });

    it('a rejected switch repaints the unchanged selection and never throws', async () => {
      controller.start();
      await waitFor(() => webview.all('setProviders').length === 1, 'the first setProviders');
      providers.accept = false;
      await assert.doesNotReject(
        webview.send({ type: 'selectModel', provider: 'mistral', model: 'mistral-large-latest' }),
      );
      const posted = webview.last('setProviders')!;
      assert.deepStrictEqual(posted.selection, { provider: 'google', model: 'gemini-2.5-pro' });
      assert.deepStrictEqual(providers.selected, [{ provider: 'mistral', model: 'mistral-large-latest' }]);
    });

    it('a router-side change posts a fresh setProviders with the new selection', async () => {
      controller.start();
      await waitFor(() => webview.all('setProviders').length === 1, 'the first setProviders');
      const before = webview.all('setProviders').length;
      await providers.select({ provider: 'mistral', model: 'mistral-large-latest' });
      await waitFor(() => webview.all('setProviders').length === before + 1, 'the response to the change');
      assert.deepStrictEqual(
        webview.last('setProviders')!.selection,
        { provider: 'mistral', model: 'mistral-large-latest' },
      );
    });

    it('start() twice yields one post per change, and dispose() stops them', async () => {
      controller.start();
      await waitFor(() => webview.all('setProviders').length === 1, 'the first setProviders');
      controller.start();
      await waitFor(() => webview.all('setProviders').length === 2, 'the second refresh');
      const before = webview.all('setProviders').length;
      await providers.select({ provider: 'mistral', model: 'mistral-large-latest' });
      await waitFor(() => webview.all('setProviders').length === before + 1, 'the extra post');
      assert.strictEqual(webview.all('setProviders').length, before + 1, 'exactly one post per change');

      controller.dispose();
      const afterDispose = webview.all('setProviders').length;
      await providers.select({ provider: 'google', model: 'gemini-2.5-pro' });
      await new Promise((resolve) => setTimeout(resolve, 50));
      assert.strictEqual(webview.all('setProviders').length, afterDispose, 'dispose() stops the posts');
    });

    it('a missing provider key maps to a provider-scoped inline error and echoes the provider back', async () => {
      client.failWith = new MissingConfigError('apiKey');
      controller.start();
      await waitFor(() => webview.all('setProviders').length === 1, 'the first setProviders');
      await webview.send({ type: 'sendText', text: 'go' });
      await waitFor(() => webview.all('showError').length === 1, 'the error');
      const error = webview.last('showError')!;
      assert.strictEqual(error.message, 'The Google AI Studio API key is not configured.');
      assert.strictEqual(error.action, 'setApiKey');
      assert.deepStrictEqual(error.provider, 'google');

      await webview.send({ type: 'triggerFix', action: 'setApiKey', provider: 'google' });
      await webview.send({ type: 'triggerFix', action: 'setApiKey' });
      assert.strictEqual(fixes.length, 2);
      assert.deepStrictEqual(fixes[0], { action: 'setApiKey', provider: 'google' });
      assert.deepStrictEqual(fixes[1], { action: 'setApiKey', provider: undefined });
    });

    it('without the providers dep there is no setProviders and selectModel is a no-op', async () => {
      const second = new ChatController({
        webview,
        client,
        registry: {
          call: async (): Promise<{ ok: false; error: string }> => ({ ok: false, error: 'unused' }),
        } as unknown as ToolRegistry,
        toolsFor: () => [],
        guardContext: () => ({}) as GuardContext,
        baitonDir,
        specsDir,
        roundBound: () => 4,
        config: { getEndpoint: () => 'http://x', getModel: () => 'm' },
        triggerFix: () => {},
        log: (message) => {
          logs.push(message);
        },
        askRegistry,
      });
      second.start();
      await waitFor(() => webview.all('setConversations').length > 0, 'the refresh to post');
      assert.strictEqual(webview.all('setProviders').length, 0);
      await assert.doesNotReject(
        webview.send({ type: 'selectModel', provider: 'google', model: 'gemini-2.5-flash' }),
      );
      assert.strictEqual(providers.selected.length, 0, 'the switch never reached the router');
      second.dispose();
    });

    it('an availability failure logs and skips only the dropdown post', async () => {
      providers.failAvailability = true;
      controller.start();
      await waitFor(() => webview.all('setConversations').length > 0, 'the refresh to continue');
      assert.strictEqual(webview.all('setProviders').length, 0, 'no setProviders when availability fails');
      assert.ok(
        webview.all('renderConversation').length > 0 || webview.all('setEmptyState').length > 0,
        'the rest of the refresh still happens',
      );
      assert.strictEqual(logs.filter((m) => m.includes('could not list the providers')).length, 1);
    });
  });
});
