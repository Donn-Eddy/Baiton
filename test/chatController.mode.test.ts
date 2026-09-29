/**
 * Unit tests for the Chat controller's conversation mode, run-activity mirror
 * and Investigate promote card (spec "dispatch-modes", todo T14).
 *
 * Like the Auto-mode suite, this imports {@link ChatController} statically with
 * no `test/fixtures/vscodeLoader.mjs` hook, proving the controller carries no
 * `vscode` imports and stays host-free.
 *
 * Coverage:
 * 1. The stored mode seeds the first paint (`setMode`, `setRunActive`).
 * 2. An absent and an off-union stored value both seed Default, writing nothing.
 * 3. A `setMode` from the view is echoed and persisted.
 * 4. A repeated `setMode` echoes but does not persist again.
 * 5. An off-union `setMode` is refused, echoing the unchanged mode.
 * 6. A spec conversation is pinned to the literal Spec (even though the default
 *    is Default), and Workspace repaints the mode.
 * 7. A `setMode` while the chat is busy is refused.
 * 8. A `setMode` while a run is in flight is refused.
 * 9. The mode decides the phase, the tool surface and the system prompt.
 * 10. A spec conversation ignores a non-spec mode entirely.
 * 11. Run activity is mirrored, without duplicate posts.
 * 12. A completed run appends its completion note; a failed one also logs.
 * 13. The promote card dispatches through the ordinary run confirm card.
 * 14. Dismiss, decline and a `busy` outcome dispatch nothing.
 * 15. The promote card is posted once per run id, and never without the seam.
 * 16. Restricted Mode posts a note instead of the card.
 * 17. `dispose()` unsubscribes and a repeated `start()` leaves one subscription.
 * 18. A fresh workspace opens in Default; a stored concrete mode wins.
 * 19. Default maps to the run phase, run tools and the Default prompt.
 * 20. A spec conversation stays pinned to Spec from a Default workspace.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ChatController,
  promoteRunConfirm,
  runCompletionNote,
  startedRunNote,
} from '../src/activation/chatController';
import type {
  ChatWebview,
  ModeMemory,
  RunActivitySource,
} from '../src/activation/chatController';
import { buildSystemPrompt, readTranscript } from '../src/orchestrator';
import type {
  CompletionResult,
  GuardContext,
  HostToWebview,
  ModelClient,
  OrchestratorPhase,
  StartRunOutcome,
  StartRunRequest,
  ToolRegistry,
  TranscriptRecord,
  WebviewToHost,
} from '../src/orchestrator';
import { DEFAULT_MODE } from '../src/model/mode';
import type { RunMode } from '../src/model/mode';
import type {
  RunFinding,
  RunManifest,
  RunPipelineEvent,
  RunPipelineOutcome,
  Unsubscribe,
} from '../src/engine';

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
  /** When set, every completion waits on this promise before answering. */
  public hold: Promise<void> | undefined;

  public async complete(req: { messages: { role: string; content: string }[] }): Promise<CompletionResult> {
    this.requests.push(req.messages);
    if (this.hold !== undefined) {
      await this.hold;
    }
    const next = this.queue.shift();
    return next ?? { content: 'done', tool_calls: [] };
  }
}

/** A fake run pipeline's activity seam, driven by {@link FakeRuns.emit}. */
class FakeRuns implements RunActivitySource {
  public running = false;
  /** Every live listener; a disposed subscription removes itself. */
  public readonly listeners = new Set<(event: RunPipelineEvent) => void>();

  public isRunning(): boolean {
    return this.running;
  }

  public onChange(listener: (event: RunPipelineEvent) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Fan one event out to every live listener. */
  public emit(event: RunPipelineEvent): void {
    for (const l of [...this.listeners]) {
      l(event);
    }
  }
}

describe('ChatController conversation mode (dispatch-modes T14)', () => {
  let webview: FakeWebview;
  let client: FakeModelClient;
  let baitonDir: string;
  let specsDir: string;
  let controller: ChatController;
  let runs: FakeRuns;
  /** The phases `toolsFor` was asked for, in call order. */
  let phases: OrchestratorPhase[];
  /** Every `set` call the fake mode memory received. */
  let modeSets: RunMode[];
  /** Every dispatch the run-pipeline seam received. */
  let startCalls: StartRunRequest[];
  /** What the fake run-pipeline seam answers. */
  let startOutcome: StartRunOutcome;
  /** Everything that reached the controller's log sink. */
  let logs: string[];
  let cleanup: (() => void) | undefined;

  interface HarnessOptions {
    storedMode?: string;
    restricted?: boolean;
    withRuns?: boolean;
    withPipeline?: boolean;
  }

  /** Build a fresh controller + harness over a temp workspace. */
  function buildHarness(options: HarnessOptions = {}): void {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-chat-mode-'));
    baitonDir = path.join(tmp, '.baiton');
    specsDir = path.join(tmp, '.baiton', 'specs');
    fs.mkdirSync(specsDir, { recursive: true });
    cleanup = () => fs.rmSync(tmp, { recursive: true, force: true });

    webview = new FakeWebview();
    client = new FakeModelClient();
    runs = new FakeRuns();
    phases = [];
    modeSets = [];
    startCalls = [];
    startOutcome = { kind: 'started', runId: 'run-b1', branch: 'baiton/bug/run-b1' };
    logs = [];
    let remembered = options.storedMode;

    const modeMemory: ModeMemory = {
      get: () => remembered,
      set: async (mode: RunMode) => {
        modeSets.push(mode);
        remembered = mode;
      },
    };

    const registry = {
      call: async (): Promise<{ ok: true; data: string }> => ({ ok: true, data: 'ok' }),
    } as unknown as ToolRegistry;

    controller = new ChatController({
      webview,
      client,
      registry,
      toolsFor: (phase) => {
        phases.push(phase);
        return [];
      },
      guardContext: () => ({ restricted: options.restricted === true }) as GuardContext,
      baitonDir,
      specsDir,
      roundBound: () => 4,
      config: { getEndpoint: () => 'http://x', getModel: () => 'm' },
      triggerFix: () => {},
      log: (m) => logs.push(m),
      modeMemory,
      ...(options.withRuns === false ? {} : { runs }),
      ...(options.withPipeline === false
        ? {}
        : {
            runPipeline: {
              start: async (req: StartRunRequest): Promise<StartRunOutcome> => {
                startCalls.push(req);
                return startOutcome;
              },
            },
          }),
    });
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

  /** Start the controller and wait for its first paint. */
  async function started(): Promise<void> {
    controller.start();
    await waitFor(() => webview.all('renderConversation').length >= 1, 'the first render');
  }

  /** A run manifest with every required field, overridable per test. */
  function manifest(overrides: Partial<RunManifest> = {}): RunManifest {
    const id = overrides.id ?? 'run-a1';
    const mode: RunMode = overrides.mode ?? 'bug';
    return {
      version: 1,
      id,
      mode,
      composerMode: mode,
      explicitMode: false,
      statement: 'the login button does nothing',
      files: [],
      baseBranch: 'main',
      baseHead: 'abc1234',
      branch: `baiton/${mode}/${id}`,
      state: 'done',
      attempts: { plan: 1, execute: 1, review: 1, investigate: 0 },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:10:00.000Z',
      ...overrides,
    };
  }

  /** A run outcome with every required field, overridable per test. */
  function outcome(overrides: Partial<RunPipelineOutcome> = {}): RunPipelineOutcome {
    return {
      runId: 'run-a1',
      mode: 'bug',
      state: 'done',
      outcome: { kind: 'verdict', verdict: 'pass' },
      commits: ['deadbee'],
      message: 'the review passed',
      ...overrides,
    };
  }

  /** An investigate finding with every required field, overridable per test. */
  function finding(overrides: Partial<RunFinding> = {}): RunFinding {
    const m = manifest({ id: 'run-i1', mode: 'investigate', state: 'answered' });
    return {
      runId: 'run-i1',
      mode: 'investigate',
      question: 'why does the login button do nothing?',
      questionFiles: ['src/login.ts'],
      finding: 'the click handler is never bound',
      files: ['src/login.ts', 'src/bind.ts'],
      nextSteps: ['bind the handler in init()'],
      findingPath: '.baiton/runs/run-i1/finding.md',
      manifest: m,
      ...overrides,
    };
  }

  /** Emit one `completed` event the way the pipeline would. */
  function emitCompleted(o: RunPipelineOutcome, m: RunManifest = manifest()): void {
    runs.emit({ kind: 'completed', runId: o.runId, manifest: m, outcome: o });
  }

  /** The `system` records of the single workspace session. */
  async function systemRecords(): Promise<TranscriptRecord[]> {
    const dir = path.join(baitonDir, 'chat');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')) : [];
    if (files.length === 0) {
      return [];
    }
    assert.strictEqual(files.length, 1);
    const records = await readTranscript(path.join(dir, files[0]));
    return records.filter((r) => r.role === 'system');
  }

  beforeEach(() => buildHarness());

  afterEach(() => {
    cleanup?.();
    cleanup = undefined;
  });

  it('seeds the mode from memory and paints run activity', async () => {
    buildHarness({ storedMode: 'bug' });
    await started();
    assert.strictEqual(webview.all('setMode')[0].mode, 'bug');
    assert.deepStrictEqual(webview.all('setRunActive')[0], { type: 'setRunActive', active: false });
    assert.deepStrictEqual(modeSets, []);
  });

  it('falls back to Default for an absent or off-union stored mode', async () => {
    assert.strictEqual(DEFAULT_MODE, 'default');
    await started();
    assert.strictEqual(webview.all('setMode')[0].mode, 'default');
    assert.deepStrictEqual(modeSets, []);

    buildHarness({ storedMode: 'nonsense' });
    await started();
    assert.strictEqual(webview.all('setMode')[0].mode, 'default');
    assert.deepStrictEqual(modeSets, []);
  });

  it('a fresh workspace opens in Default', async () => {
    await started();
    assert.strictEqual(webview.all('setMode')[0].mode, 'default');
    assert.deepStrictEqual(modeSets, []);
  });

  it('a stored concrete mode wins over Default', async () => {
    for (const m of ['spec', 'bug', 'quick', 'refactor', 'investigate']) {
      cleanup?.();
      buildHarness({ storedMode: m });
      await started();
      assert.strictEqual(webview.all('setMode')[0].mode, m);
    }
  });

  it('Default maps to the run phase, run tools and the Default prompt', async () => {
    await started();
    await webview.send({ type: 'sendText', text: 'go' });
    await waitFor(() => client.requests.length >= 1, 'the completion');
    assert.deepStrictEqual(phases, ['run']);
    const prompt = client.requests[0][0].content;
    assert.strictEqual(prompt, buildSystemPrompt({ kind: 'workspace' }, undefined, 'default'));
    assert.notStrictEqual(prompt, buildSystemPrompt({ kind: 'workspace' }));
  });

  it('a spec conversation stays pinned to Spec from a Default workspace', async () => {
    const content = '---\nstatus: draft\n---\n# Alpha\n';
    fs.mkdirSync(path.join(specsDir, 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(specsDir, 'alpha', 'spec.md'), content);
    await started();
    assert.strictEqual(webview.all('setMode')[0].mode, 'default');

    controller.setActiveSpec('alpha');
    await waitFor(() => webview.last('setMode')?.mode === 'spec', 'the pinned Spec paint');
    await webview.send({ type: 'setMode', mode: 'bug' });
    assert.strictEqual(webview.last('setMode')!.mode, 'spec');
    assert.deepStrictEqual(modeSets, []);

    await webview.send({ type: 'sendText', text: 'go' });
    await waitFor(() => client.requests.length >= 1, 'the completion');
    assert.deepStrictEqual(phases, ['gather']);
    assert.strictEqual(
      client.requests[0][0].content,
      buildSystemPrompt({ kind: 'spec', slug: 'alpha' }, content),
    );

    controller.setActiveSpec(undefined);
    await waitFor(() => webview.last('setMode')?.mode === 'default', 'Default to come back');
  });

  it('echoes and persists a mode picked in the composer', async () => {
    await started();
    await webview.send({ type: 'setMode', mode: 'refactor' });
    assert.strictEqual(webview.last('setMode')!.mode, 'refactor');
    assert.deepStrictEqual(modeSets, ['refactor']);
  });

  it('echoes but does not re-persist a repeated mode', async () => {
    buildHarness({ storedMode: 'quick' });
    await started();
    const before = webview.all('setMode').length;
    await webview.send({ type: 'setMode', mode: 'quick' });
    assert.strictEqual(webview.all('setMode').length, before + 1, 'the echo still happens');
    assert.strictEqual(webview.last('setMode')!.mode, 'quick');
    assert.deepStrictEqual(modeSets, []);
  });

  it('refuses an off-union mode, echoing the unchanged one', async () => {
    buildHarness({ storedMode: 'bug' });
    await started();
    await webview.send({ type: 'setMode', mode: 'nonsense' as never });
    assert.strictEqual(webview.last('setMode')!.mode, 'bug');
    assert.deepStrictEqual(modeSets, []);
  });

  it('pins a spec conversation to Spec and repaints the remembered mode on return', async () => {
    buildHarness({ storedMode: 'bug' });
    fs.mkdirSync(path.join(specsDir, 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(specsDir, 'alpha', 'spec.md'), '---\nstatus: draft\n---\n# Alpha\n');
    await started();

    controller.setActiveSpec('alpha');
    await waitFor(() => webview.last('setMode')?.mode === 'spec', 'the pinned Spec paint');

    await webview.send({ type: 'setMode', mode: 'bug' });
    assert.strictEqual(webview.last('setMode')!.mode, 'spec');
    assert.deepStrictEqual(modeSets, []);

    controller.setActiveSpec(undefined);
    await waitFor(() => webview.last('setMode')?.mode === 'bug', 'the remembered mode to come back');
  });

  it('refuses a mode change while the chat is busy', async () => {
    buildHarness({ storedMode: 'bug' });
    await started();
    let release!: () => void;
    client.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    void webview.send({ type: 'sendText', text: 'go' });
    await waitFor(() => webview.last('setBusy')?.busy === true, 'the run to start');

    await webview.send({ type: 'setMode', mode: 'quick' });
    assert.strictEqual(webview.last('setMode')!.mode, 'bug');
    assert.deepStrictEqual(modeSets, []);

    release();
    await waitFor(() => webview.last('setBusy')?.busy === false, 'the run to finish');
  });

  it('refuses a mode change while a run is in flight', async () => {
    buildHarness({ storedMode: 'bug' });
    await started();
    runs.emit({ kind: 'started', runId: 'run-a1', manifest: manifest() });
    await waitFor(() => webview.last('setRunActive')?.active === true, 'the active paint');

    await webview.send({ type: 'setMode', mode: 'quick' });
    assert.strictEqual(webview.last('setMode')!.mode, 'bug');
    assert.deepStrictEqual(modeSets, []);
  });

  it('derives the phase, tool surface and prompt from the mode', async () => {
    buildHarness({ storedMode: 'bug' });
    await started();
    await webview.send({ type: 'sendText', text: 'go' });
    await waitFor(() => client.requests.length >= 1, 'the completion');
    assert.deepStrictEqual(phases, ['run']);
    assert.strictEqual(
      client.requests[0][0].content,
      buildSystemPrompt({ kind: 'workspace' }, undefined, 'bug'),
    );

    buildHarness({ storedMode: 'spec' });
    await started();
    await webview.send({ type: 'sendText', text: 'go' });
    await waitFor(() => client.requests.length >= 1, 'the completion');
    assert.deepStrictEqual(phases, ['gather']);
    assert.strictEqual(client.requests[0][0].content, buildSystemPrompt({ kind: 'workspace' }));
  });

  it('ignores a non-spec mode on a spec conversation', async () => {
    buildHarness({ storedMode: 'quick' });
    const content = '---\nstatus: approved\n---\n# Alpha\n';
    fs.mkdirSync(path.join(specsDir, 'alpha'), { recursive: true });
    fs.writeFileSync(path.join(specsDir, 'alpha', 'spec.md'), content);
    await started();
    controller.setActiveSpec('alpha');
    await waitFor(() => webview.last('setMode')?.mode === 'spec', 'the pinned Spec paint');

    await webview.send({ type: 'sendText', text: 'go' });
    await waitFor(() => client.requests.length >= 1, 'the completion');
    assert.deepStrictEqual(phases, ['drive']);
    assert.strictEqual(
      client.requests[0][0].content,
      buildSystemPrompt({ kind: 'spec', slug: 'alpha' }, content),
    );
  });

  it('mirrors run activity without duplicate posts', async () => {
    await started();
    const m = manifest();
    runs.emit({ kind: 'started', runId: m.id, manifest: m });
    runs.emit({ kind: 'stage-started', runId: m.id, stage: 'plan', attempt: 1, manifest: m });
    runs.emit({
      kind: 'stage-completed',
      runId: m.id,
      stage: 'plan',
      attempt: 1,
      outcome: { kind: 'cancelled' },
      manifest: m,
    });
    await waitFor(() => webview.all('setRunActive').some((p) => p.active), 'the active paint');
    assert.strictEqual(
      webview.all('setRunActive').filter((p) => p.active).length,
      1,
      'exactly one active paint for consecutive active events',
    );

    emitCompleted(outcome(), m);
    await waitFor(() => webview.last('setRunActive')?.active === false, 'the inactive paint');
  });

  it('appends a completion note, and logs a failed run', async () => {
    await started();
    const m = manifest();
    const done = outcome();
    emitCompleted(done, m);
    await pollUntil(async () => (await systemRecords()).length === 1, 'the completion note');
    let records = await systemRecords();
    assert.strictEqual(records[0].content, runCompletionNote(done, m));

    const failed = outcome({ state: 'failed', message: 'the executor never finished' });
    emitCompleted(failed, m);
    await pollUntil(async () => (await systemRecords()).length === 2, 'the failure note');
    records = await systemRecords();
    assert.strictEqual(records[1].content, runCompletionNote(failed, m));
    assert.ok(logs.some((l) => l.includes(runCompletionNote(failed, m))), 'the failure reached the log');
  });

  it('promotes a finding into a Bug run through the run confirm card', async () => {
    await started();
    const f = finding();
    emitCompleted(
      outcome({ runId: f.runId, mode: 'investigate', state: 'answered', message: 'answered', finding: f }),
      f.manifest,
    );
    await pollUntil(() => webview.all('showIntervention').length >= 1, 'the promote card');

    const promote = webview.last('showIntervention')!.intervention;
    assert.strictEqual(promote.kind, 'question');
    assert.deepStrictEqual(promote.options!.map((o) => o.id), ['bug', 'quick', 'dismiss']);
    assert.ok(promote.prompt.includes(f.finding));

    await webview.send({
      type: 'answerIntervention',
      id: promote.id,
      answer: { kind: 'option', optionId: 'bug' },
    });
    await pollUntil(() => webview.all('showIntervention').length >= 2, 'the confirm card');

    const confirm = webview.all('showIntervention').map((p) => p.intervention).reverse()
      .find((i) => i.kind === 'confirm')!;
    const expected = promoteRunConfirm('bug', f.finding, f.files, 'main');
    assert.strictEqual(confirm.prompt, expected.prompt);
    assert.strictEqual(confirm.detail, expected.detail);

    await webview.send({ type: 'answerIntervention', id: confirm.id, answer: { kind: 'approved' } });
    await pollUntil(() => startCalls.length === 1, 'the dispatch');
    assert.deepStrictEqual(startCalls, [
      { mode: 'bug', statement: f.finding, files: f.files },
    ]);
    await pollUntil(
      async () => (await systemRecords()).some((r) => r.content === startedRunNote('bug', startOutcome)),
      'the dispatch note',
    );
  });

  it('dispatches nothing on dismiss, on a decline, and notes a busy outcome', async () => {
    await started();
    const f = finding();
    emitCompleted(
      outcome({ runId: f.runId, mode: 'investigate', state: 'answered', message: 'answered', finding: f }),
      f.manifest,
    );
    await pollUntil(() => webview.all('showIntervention').length >= 1, 'the promote card');
    let promote = webview.last('showIntervention')!.intervention;
    await webview.send({
      type: 'answerIntervention',
      id: promote.id,
      answer: { kind: 'option', optionId: 'dismiss' },
    });
    await pollUntil(() => webview.all('resolveIntervention').length >= 1, 'the settled card');
    assert.deepStrictEqual(startCalls, []);

    // A second finding, declined at the confirm card.
    buildHarness();
    await started();
    const g = finding({ runId: 'run-i2' });
    emitCompleted(
      outcome({ runId: g.runId, mode: 'investigate', state: 'answered', message: 'answered', finding: g }),
      g.manifest,
    );
    await pollUntil(() => webview.all('showIntervention').length >= 1, 'the promote card');
    promote = webview.last('showIntervention')!.intervention;
    await webview.send({
      type: 'answerIntervention',
      id: promote.id,
      answer: { kind: 'option', optionId: 'quick' },
    });
    await pollUntil(
      () => webview.all('showIntervention').some((p) => p.intervention.kind === 'confirm'),
      'the confirm card',
    );
    const confirm = webview.all('showIntervention').map((p) => p.intervention)
      .find((i) => i.kind === 'confirm')!;
    await webview.send({
      type: 'answerIntervention',
      id: confirm.id,
      answer: { kind: 'declined', reason: 'not now' },
    });
    await pollUntil(() => webview.all('resolveIntervention').length >= 2, 'the settled confirm');
    assert.deepStrictEqual(startCalls, []);

    // A third finding, approved but refused as busy by the pipeline.
    buildHarness();
    startOutcome = { kind: 'busy' };
    await started();
    const h = finding({ runId: 'run-i3' });
    emitCompleted(
      outcome({ runId: h.runId, mode: 'investigate', state: 'answered', message: 'answered', finding: h }),
      h.manifest,
    );
    await pollUntil(() => webview.all('showIntervention').length >= 1, 'the promote card');
    promote = webview.last('showIntervention')!.intervention;
    await webview.send({
      type: 'answerIntervention',
      id: promote.id,
      answer: { kind: 'option', optionId: 'bug' },
    });
    await pollUntil(
      () => webview.all('showIntervention').some((p) => p.intervention.kind === 'confirm'),
      'the confirm card',
    );
    const busyConfirm = webview.all('showIntervention').map((p) => p.intervention)
      .find((i) => i.kind === 'confirm')!;
    await webview.send({ type: 'answerIntervention', id: busyConfirm.id, answer: { kind: 'approved' } });
    await pollUntil(
      async () => (await systemRecords()).some((r) => r.content === startedRunNote('bug', { kind: 'busy' })),
      'the busy note',
    );
    assert.strictEqual(startCalls.length, 1, 'the seam was consulted exactly once');
  });

  it('posts the promote card once per run id, and never without the dispatch seam', async () => {
    await started();
    const f = finding();
    const event = outcome({
      runId: f.runId,
      mode: 'investigate',
      state: 'answered',
      message: 'answered',
      finding: f,
    });
    emitCompleted(event, f.manifest);
    await pollUntil(() => webview.all('showIntervention').length >= 1, 'the promote card');
    emitCompleted(event, f.manifest);
    await pollUntil(async () => (await systemRecords()).length >= 2, 'both completion notes');
    // A pending card is re-posted by every refresh, so count distinct cards.
    const cardIds = new Set(
      webview.all('showIntervention')
        .filter((p) => p.intervention.kind === 'question')
        .map((p) => p.intervention.id),
    );
    assert.strictEqual(cardIds.size, 1, 'exactly one promote card');

    buildHarness({ withPipeline: false });
    await started();
    emitCompleted(event, f.manifest);
    await pollUntil(async () => (await systemRecords()).length >= 1, 'the completion note');
    assert.strictEqual(webview.all('showIntervention').length, 0, 'no card without the seam');
  });

  it('notes, and does not offer, a finding in Restricted Mode', async () => {
    buildHarness({ restricted: true });
    await started();
    const f = finding();
    emitCompleted(
      outcome({ runId: f.runId, mode: 'investigate', state: 'answered', message: 'answered', finding: f }),
      f.manifest,
    );
    await pollUntil(
      async () =>
        (await systemRecords()).some((r) =>
          r.content === `Restricted Mode: the finding of \`${f.runId}\` was not offered as a run.`),
      'the Restricted Mode note',
    );
    assert.strictEqual(webview.all('showIntervention').length, 0, 'no card in Restricted Mode');
    assert.deepStrictEqual(startCalls, []);
  });

  it('unsubscribes on dispose and keeps exactly one subscription across starts', async () => {
    await started();
    assert.strictEqual(runs.listeners.size, 1);
    controller.start();
    await waitFor(() => webview.all('renderConversation').length >= 2, 'the second render');
    assert.strictEqual(runs.listeners.size, 1, 'a repeated start leaves one live subscription');

    controller.dispose();
    assert.strictEqual(runs.listeners.size, 0);
    const before = webview.all('setRunActive').length;
    runs.emit({ kind: 'started', runId: 'run-a1', manifest: manifest() });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.strictEqual(webview.all('setRunActive').length, before, 'no further paints after dispose');
  });

  /** Poll until an (optionally async) condition holds. */
  async function pollUntil(condition: () => boolean | Promise<boolean>, what: string): Promise<void> {
    const deadline = Date.now() + 5_000;
    for (;;) {
      if (await condition()) {
        return;
      }
      if (Date.now() > deadline) {
        assert.fail(`timed out waiting for: ${what}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
});
