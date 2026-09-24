/**
 * Unit tests for the Chat controller's Auto-mode flow (spec "Chat
 * Interventions", todo T11).
 *
 * This suite imports {@link ChatController} statically with no
 * `test/fixtures/vscodeLoader.mjs` hook, proving that the controller carries no
 * `vscode` imports and remains fully host-free and unit-testable.
 *
 * Coverage:
 * 1. Toggle echo and persistence — `setAutoMode` from the webview is echoed
 *    back host-side and remembered through `autoModeMemory` (`memorySets`).
 * 2. Persisted state is restored — a controller whose memory reads `true`
 *    posts `setAutoMode { enabled: true }` with its first refresh.
 * 3. Off: nothing is gated — a permission ask presents exactly as before.
 * 4. On: allow-list approval settles with no card to answer — one
 *    already-resolved `auto` card, the ask approved, and the audit record.
 * 5. On: model-stage approval — same shape, rationale naming `model review`.
 * 6. On: escalation renders on the card and is audited — a pending card led
 *    by the one-sentence summary with the raw args under it and the tripped
 *    rule kept for the audit only, a transcript record when it happens, and the
 *    pending-then-resolved pair collapsing to one card on re-render.
 * 7. Confirms and questions are never gated.
 * 8. Only asks presented while on are gated — a card already pending when the
 *    toggle goes on is untouched.
 * 9. A throwing gate escalates — Auto mode only ever fails towards asking.
 * 10. Stop during a slow gate wins — a late approval neither posts a card
 *     nor writes a record.
 * 11. A relayed ask reaches the gate with its run context.
 * 12. An orchestrator-raised ask reaches the gate with no context.
 * 13. A relayed allow-list approval is audited.
 * 14. A relayed escalation posts a pending card and is audited.
 * 15. A shell escalation carries the raw command, and a failed gate's summary
 *     names the run's role.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { ChatController, STOP_DECLINE_REASON } from '../src/activation/chatController';
import type {
  AutoModeGate,
  AutoModeMemory,
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
  AutoModeOutcome,
  AutoModeRunContext,
  CompletionResult,
  GuardContext,
  HostToWebview,
  Intervention,
  InterventionAnswer,
  InterventionRequest,
  InterventionSeam,
  ModelClient,
  PermissionRequest,
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

describe('ChatController auto mode', () => {
  let webview: FakeWebview;
  let client: FakeModelClient;
  let baitonDir: string;
  let specsDir: string;
  let askRegistry: PendingAskRegistry;
  let seam: InterventionSeam;
  let controller: ChatController;
  /** The answers the fake tool observed, in call order. */
  let observed: InterventionAnswer[];
  /** The permission asks the gate received, in call order, with their opts. */
  let gateCalls: Array<{ ask: PermissionRequest; context?: AutoModeRunContext }>;
  /** The scripted gate outcome, or a deferred-gate thunk. */
  let gateResult: AutoModeOutcome | (() => Promise<AutoModeOutcome>);
  /** Every `set` call the fake autoModeMemory received. */
  let memorySets: boolean[];
  let cleanup: (() => void) | undefined;

  /** The permission ask the fake tool raises by default. */
  const PERMISSION_ASK: PermissionRequest = {
    kind: 'permission',
    prompt: 'Allow Read of src/a.ts?',
    agent: 'claude',
    tool: 'Read',
    args: '{"file_path":"src/a.ts"}',
    detail: 'Reads one file.',
  };

  /** Build a fresh controller + harness over a temp workspace. */
  function buildHarness(options: { askKind?: 'permission' | 'confirm'; persistedAuto?: boolean } = {}): void {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-chat-auto-'));
    baitonDir = path.join(tmp, '.baiton');
    specsDir = path.join(tmp, '.baiton', 'specs');
    cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });

    webview = new FakeWebview();
    client = new FakeModelClient();
    // Round 1 asks the permission (or confirm), round 2 finishes the loop.
    client.queue.push(
      { content: '', tool_calls: [{ id: 'c1', name: 'confirm_tool', arguments: '{}' }] },
      { content: 'done', tool_calls: [] },
    );
    observed = [];
    gateCalls = [];
    gateResult = { kind: 'approve', stage: 'allow-list', rationale: 'unused here' };
    memorySets = [];
    let remembered = options.persistedAuto === true;
    askRegistry = new PendingAskRegistry({
      ids: { next: () => `ask-${Date.now()}-${Math.random().toString(36).slice(2)}` },
      clock: systemClock,
    });

    const request: InterventionRequest = options.askKind === 'confirm'
      ? { kind: 'confirm', prompt: 'Approve spec "x"?', detail: 'This creates its branch.' }
      : PERMISSION_ASK;

    const fakeRegistry = {
      call: async (): Promise<{ ok: true; data: string } | { ok: false; error: string }> => {
        const answer = await seam.ask(request);
        observed.push(answer);
        return answer.kind === 'approved'
          ? { ok: true, data: 'ok' }
          : { ok: false, error: 'declined' };
      },
    } as unknown as ToolRegistry;

    // The seam is needed before the controller exists; bind the presenter
    // lazily through a mutable local, exactly as `commands.ts` does.
    let present: (ask: Intervention) => void | Promise<void> = () => {};
    seam = createInterventionSeam(askRegistry, (ask) => present(ask));

    const autoGate: AutoModeGate = async (ask, opts) => {
      gateCalls.push({ ask, context: opts.context });
      const outcome = gateResult;
      return typeof outcome === 'function' ? outcome() : outcome;
    };

    const autoModeMemory: AutoModeMemory = {
      get: () => remembered,
      set: async (enabled: boolean) => {
        memorySets.push(enabled);
        remembered = enabled;
      },
    };

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
      autoGate,
      autoModeMemory,
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

  /** Turn Auto mode on before the send, the way the webview would flip it. */
  async function startSendWithAutoOn(): Promise<void> {
    controller.start();
    await webview.send({ type: 'setAutoMode', enabled: true });
    return webview.send({ type: 'sendText', text: 'go' });
  }

  /** The trusted run context a relayed ask carries into the controller. */
  const RUN_CONTEXT: AutoModeRunContext = { agent: 'claude', role: 'executor', runId: 'run-a' };

  /** Present a relayed ask directly, the way the ask watcher does, without the tool loop. */
  async function presentRelayed(ask: PermissionRequest = PERMISSION_ASK): Promise<void> {
    const { intervention } = askRegistry.create(ask);
    await controller.presentIntervention({ ...intervention }, RUN_CONTEXT);
  }

  /** Wait until the run has finished (busy off), having reached `minRequests` completions. */
  async function awaitRunEnd(minRequests = 2): Promise<void> {
    await waitFor(
      () => client.requests.length >= minRequests && webview.last('setBusy')?.busy === false,
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

  /** The persisted intervention records of the single workspace session. */
  async function interventionRecords(): Promise<TranscriptRecord[]> {
    return (await readTranscript(transcriptFile())).filter((r) => r.intervention !== undefined);
  }

  beforeEach(() => buildHarness());

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it('echoes and persists the Auto toggle', async () => {
    controller.start();
    await waitFor(() => webview.all('setAutoMode').length === 1, 'the initial echo');
    assert.strictEqual(webview.all('setAutoMode')[0].enabled, false);

    await webview.send({ type: 'setAutoMode', enabled: true });
    await waitFor(() => webview.all('setAutoMode').length === 2, 'the echo');
    const echoes = webview.all('setAutoMode').filter((m) => m.enabled === true);
    assert.strictEqual(echoes.length, 1, 'exactly one enabled=true echo');
    await waitFor(() => memorySets.length === 1, 'the memory write');
    assert.deepStrictEqual(memorySets, [true]);

    await webview.send({ type: 'setAutoMode', enabled: false });
    await waitFor(() => webview.last('setAutoMode')?.enabled === false, 'the off echo');
    assert.deepStrictEqual(memorySets, [true, false]);
  });

  it('restores the persisted Auto state on start', async () => {
    buildHarness({ persistedAuto: true });
    controller.start();
    await waitFor(
      () => webview.all('setAutoMode').length >= 1 && webview.all('renderConversation').length >= 1,
      'the first render',
    );
    assert.strictEqual(webview.all('setAutoMode')[0].enabled, true);
  });

  it('does not gate a permission ask while Auto mode is off', async () => {
    startSend();
    await waitFor(() => webview.all('showIntervention').length === 1, 'the pending card');
    const card = webview.last('showIntervention')!.intervention;
    assert.strictEqual(card.status, 'pending');
    assert.strictEqual(card.kind, 'permission');
    assert.strictEqual(card.auto, undefined);
    assert.strictEqual(card.escalation, undefined);
    assert.strictEqual(gateCalls.length, 0);

    await webview.send({ type: 'answerIntervention', id: card.id, answer: { kind: 'approved' } });
    await awaitRunEnd();
    assert.deepStrictEqual(observed, [{ kind: 'approved' }]);
    assert.strictEqual(askRegistry.size, 0);
  });

  it('settles a gate-approved ask with no card ever pending (allow-list stage)', async () => {
    gateResult = { kind: 'approve', stage: 'allow-list', rationale: 'claude/planner may read any file' };
    await startSendWithAutoOn();
    await awaitRunEnd();

    const shown = webview.all('showIntervention');
    assert.strictEqual(shown.length, 1);
    const card = shown[0].intervention;
    assert.strictEqual(card.status, 'resolved');
    assert.strictEqual(card.auto, true);
    assert.ok(card.rationale!.includes('Auto mode (allow-list)'));
    assert.ok(card.rationale!.includes('claude/planner may read any file'));
    assert.strictEqual(webview.all('resolveIntervention').length, 0);
    assert.deepStrictEqual(observed, [{ kind: 'approved' }]);
    assert.strictEqual(askRegistry.size, 0);

    const records = await interventionRecords();
    assert.strictEqual(records.length, 1);
    const record = records[0].intervention!;
    assert.strictEqual(record.status, 'resolved');
    assert.strictEqual(record.auto, true);
    assert.ok(record.rationale!.includes('Auto mode (allow-list)'));

    const rendered: RenderRecord[] = toRenderRecords(await readTranscript(transcriptFile()));
    const withCard = rendered.filter((r) => r.intervention !== undefined);
    assert.strictEqual(withCard.length, 1);
    assert.strictEqual(withCard[0].intervention!.status, 'resolved');
    assert.strictEqual(withCard[0].intervention!.auto, true);
  });

  it('names the model stage in a model-approved ask', async () => {
    gateResult = { kind: 'approve', stage: 'model', rationale: 'the read looks harmless' };
    await startSendWithAutoOn();
    await awaitRunEnd();

    const shown = webview.all('showIntervention');
    assert.strictEqual(shown.length, 1);
    assert.strictEqual(shown[0].intervention.status, 'resolved');
    assert.strictEqual(shown[0].intervention.auto, true);
    assert.strictEqual(shown[0].intervention.rationale, 'Auto mode (model review): the read looks harmless');
    assert.deepStrictEqual(observed, [{ kind: 'approved' }]);
  });

  it('renders and audits an escalated ask', async () => {
    const escalation = {
      summary: 'Planner wants to read a file outside the project folder (/etc/shadow).',
      detail: 'The path is absolute and outside the workspace.',
      reason: '"/etc/shadow" cannot be proven to stay inside the workspace',
    };
    gateResult = { kind: 'escalate', ...escalation };
    await startSendWithAutoOn();
    await waitFor(() => webview.all('showIntervention').length === 1, 'the escalated card');

    const card = webview.last('showIntervention')!.intervention;
    assert.strictEqual(card.status, 'pending');
    // The card carries the one-sentence summary, the raw args to show under
    // it, and the tripped rule for the audit record only.
    assert.deepStrictEqual(card.escalation, {
      summary: escalation.summary,
      detail: escalation.detail,
      command: '{"file_path":"src/a.ts"}',
      reason: escalation.reason,
    });
    // The plain-text form leads with the summary; no rule label, no reason.
    assert.ok(card.detail!.startsWith(escalation.summary));
    assert.ok(card.detail!.includes(escalation.detail));
    assert.ok(card.detail!.includes('Reads one file.'));
    assert.ok(!card.detail!.includes('What you are approving'));
    assert.ok(!card.detail!.includes('Why it was flagged'));
    assert.ok(!card.detail!.includes(escalation.reason));

    // The escalation is written to the transcript before any answer.
    let records = await interventionRecords();
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].intervention!.id, card.id);
    assert.strictEqual(records[0].intervention!.status, 'pending');

    await webview.send({ type: 'answerIntervention', id: card.id, answer: { kind: 'approved' } });
    await awaitRunEnd();
    assert.strictEqual(webview.all('resolveIntervention').length, 1);

    records = await interventionRecords();
    assert.strictEqual(records.length, 2);
    assert.strictEqual(records[0].intervention!.status, 'pending');
    assert.strictEqual(records[1].intervention!.status, 'resolved');
    assert.deepStrictEqual(records[1].intervention!.answer, { kind: 'approved' });

    // The pair renders as one card, settled, still carrying the escalation.
    const rendered: RenderRecord[] = toRenderRecords(await readTranscript(transcriptFile()));
    const withCard = rendered.filter((r) => r.intervention !== undefined);
    assert.strictEqual(withCard.length, 1);
    assert.strictEqual(withCard[0].intervention!.status, 'resolved');
    assert.strictEqual(withCard[0].intervention!.escalation!.summary, escalation.summary);
    assert.strictEqual(withCard[0].intervention!.escalation!.detail, escalation.detail);
    assert.strictEqual(withCard[0].intervention!.escalation!.reason, escalation.reason);
  });

  it('never gates a confirm ask, even with Auto mode on', async () => {
    buildHarness({ askKind: 'confirm' });
    controller.start();
    await webview.send({ type: 'setAutoMode', enabled: true });
    await webview.send({ type: 'sendText', text: 'go' });
    await waitFor(() => webview.all('showIntervention').length === 1, 'the pending card');

    const card = webview.last('showIntervention')!.intervention;
    assert.strictEqual(card.status, 'pending');
    assert.strictEqual(card.kind, 'confirm');
    assert.strictEqual(gateCalls.length, 0);

    await webview.send({ type: 'answerIntervention', id: card.id, answer: { kind: 'approved' } });
    await awaitRunEnd();
    assert.deepStrictEqual(observed, [{ kind: 'approved' }]);
  });

  it('leaves a card presented before the toggle untouched', async () => {
    startSend();
    await waitFor(() => webview.all('showIntervention').length === 1, 'the pending card');
    const card = webview.last('showIntervention')!.intervention;

    await webview.send({ type: 'setAutoMode', enabled: true });
    assert.strictEqual(webview.all('showIntervention').length, 1, 'no re-post of the card');
    assert.strictEqual(webview.last('showIntervention')!.intervention.status, 'pending');
    assert.strictEqual(gateCalls.length, 0);

    await webview.send({ type: 'answerIntervention', id: card.id, answer: { kind: 'approved' } });
    await awaitRunEnd();
    assert.deepStrictEqual(observed, [{ kind: 'approved' }]);
    assert.strictEqual(askRegistry.size, 0);
  });

  it('escalates when the gate throws', async () => {
    gateResult = async () => {
      throw new Error('boom');
    };
    await startSendWithAutoOn();
    await waitFor(() => webview.all('showIntervention').length === 1, 'the escalated card');

    const card = webview.last('showIntervention')!.intervention;
    assert.strictEqual(card.status, 'pending');
    assert.strictEqual(card.escalation!.summary, 'Claude wants to run Read');
    assert.ok(card.escalation!.detail!.includes('Auto mode could not decide'));
    assert.ok(card.escalation!.detail!.includes('boom'));
    assert.ok(card.detail!.includes('Auto mode could not decide'));
    assert.strictEqual(askRegistry.size, 1);

    // The send completes normally once the card is answered.
    await webview.send({ type: 'answerIntervention', id: card.id, answer: { kind: 'approved' } });
    await awaitRunEnd();
    assert.deepStrictEqual(observed, [{ kind: 'approved' }]);
  });

  it('lets a stop win over a slow gate', async () => {
    let release!: () => void;
    const heldGate = new Promise<AutoModeOutcome>((resolve) => {
      release = () =>
        resolve({ kind: 'approve', stage: 'allow-list', rationale: 'too late' });
    });
    gateResult = () => heldGate;

    controller.start();
    await webview.send({ type: 'setAutoMode', enabled: true });
    void webview.send({ type: 'sendText', text: 'go' });
    await waitFor(() => gateCalls.length === 1, 'the gate to be consulted');

    await webview.send({ type: 'stop' });
    // The ask was declined under the in-flight gate and the run wound down;
    // the paused tool still cannot resume before the presentation settles, so
    // release the gate before observing its answer.
    release();
    await waitFor(() => observed.length === 1, 'the paused tool to resume');
    assert.deepStrictEqual(observed[0], { kind: 'declined', reason: STOP_DECLINE_REASON });
    await awaitRunEnd(1);
    assert.strictEqual(
      webview.all('showIntervention').filter((m) => m.intervention.auto === true).length,
      0,
    );
    assert.strictEqual((await interventionRecords()).length, 0);
  });

  it('reaches the gate with its run context for a relayed ask', async () => {
    controller.start();
    await webview.send({ type: 'setAutoMode', enabled: true });
    await presentRelayed();
    await waitFor(() => gateCalls.length === 1, 'the gate to be consulted');
    assert.strictEqual(gateCalls[0].ask.tool, 'Read');
    assert.deepStrictEqual(gateCalls[0].context, RUN_CONTEXT);
  });

  it('reaches the gate with no context for an orchestrator-raised ask', async () => {
    await startSendWithAutoOn();
    await awaitRunEnd();
    assert.strictEqual(gateCalls.length, 1);
    assert.strictEqual(gateCalls[0].context, undefined);
  });

  it('audits a relayed allow-list approval with no pending card', async () => {
    gateResult = {
      kind: 'approve',
      stage: 'allow-list',
      rationale: 'claude/executor may write inside its run dir',
    };
    controller.start();
    await webview.send({ type: 'setAutoMode', enabled: true });
    await presentRelayed();
    await waitFor(() => webview.all('showIntervention').length === 1, 'the settled card');

    const shown = webview.all('showIntervention');
    assert.strictEqual(shown.length, 1);
    const card = shown[0].intervention;
    assert.strictEqual(card.status, 'resolved');
    assert.strictEqual(card.auto, true);
    assert.ok(card.rationale!.includes('Auto mode (allow-list)'));
    assert.strictEqual(webview.all('resolveIntervention').length, 0);
    assert.strictEqual(askRegistry.size, 0);

    const records = await interventionRecords();
    assert.strictEqual(records.length, 1);
    const record = records[0].intervention!;
    assert.strictEqual(record.status, 'resolved');
    assert.strictEqual(record.auto, true);
  });

  it('posts and audits a relayed escalation, then settles on answer', async () => {
    const escalation = { summary: 'Executor wants to write src/app.ts outside its allowed paths.' };
    gateResult = { kind: 'escalate', ...escalation };
    controller.start();
    await webview.send({ type: 'setAutoMode', enabled: true });
    await presentRelayed();
    // The start-time refresh re-posts pending cards, so poll on "at least one"
    // rather than an exact count.
    await waitFor(() => webview.all('showIntervention').length >= 1, 'the pending card');

    const card = webview.last('showIntervention')!.intervention;
    assert.strictEqual(card.status, 'pending');
    assert.strictEqual(card.escalation!.summary, escalation.summary);
    assert.strictEqual(card.escalation!.detail, undefined);
    assert.strictEqual(card.escalation!.command, '{"file_path":"src/a.ts"}');
    assert.ok(card.detail!.startsWith(escalation.summary));

    let records = await interventionRecords();
    assert.strictEqual(records.length, 1);
    assert.strictEqual(records[0].intervention!.status, 'pending');

    await webview.send({ type: 'answerIntervention', id: card.id, answer: { kind: 'declined', reason: 'no' } });
    await new Promise((resolve) => setTimeout(resolve, 50));
    records = await interventionRecords();
    assert.strictEqual(records.length, 2);
    assert.strictEqual(records[0].intervention!.status, 'pending');
    assert.strictEqual(records[1].intervention!.status, 'resolved');
    assert.deepStrictEqual(records[1].intervention!.answer, { kind: 'declined', reason: 'no' });

    const rendered: RenderRecord[] = toRenderRecords(await readTranscript(transcriptFile()));
    const withCard = rendered.filter((r) => r.intervention !== undefined);
    assert.strictEqual(withCard.length, 1);
    assert.strictEqual(withCard[0].intervention!.status, 'resolved');
    assert.strictEqual(withCard[0].intervention!.escalation!.summary, escalation.summary);
  });

  it('shows a shell escalation with the raw command and names the role in a thrown-gate summary', async () => {
    gateResult = async () => {
      throw new Error('boom');
    };
    controller.start();
    await webview.send({ type: 'setAutoMode', enabled: true });
    await presentRelayed({
      kind: 'permission',
      prompt: 'Allow Bash?',
      agent: 'claude',
      tool: 'Bash',
      args: '{"command":"python scripts/seed.py --db dev"}',
    });
    await waitFor(() => webview.all('showIntervention').length >= 1, 'the pending card');
    const card = webview.last('showIntervention')!.intervention;
    assert.strictEqual(card.escalation!.command, 'python scripts/seed.py --db dev');
    assert.strictEqual(card.escalation!.summary, 'Executor wants to run Bash');
  });

  it('threads the controller session id through every tool-loop completion', async () => {
    startSend();
    // Auto mode is off, so the ask pends; approve it the way the view would.
    await waitFor(() => webview.all('showIntervention').length === 1, 'the pending card');
    const card = webview.last('showIntervention')!.intervention;
    await webview.send({ type: 'answerIntervention', id: card.id, answer: { kind: 'approved' } });
    await awaitRunEnd();

    // Rounds 1 and 2 ran in one send, so two completions; both carried the same
    // live session id the controller had allocated for the chat.
    const [first, second] = client.sessionIds;
    assert.ok(first !== undefined, 'completion carries a sessionId');
    assert.strictEqual(second, first, 'the same session id reuses across rounds');
  });
});
