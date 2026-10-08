import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { GITIGNORE_CONTENTS } from '../src/config/gitignore';
import { createGitService } from '../src/git/gitService';
import type { GitWorktreeService } from '../src/git';
import { createSpecBranchWriter, type SpecBranchWriter } from '../src/engine/specBranchWriter';
import { landTodoWorktree, todoBranchFor, todoWorktreeDirFor, unlandedTodos } from '../src/engine/todoWorktree';
import { submitPr } from '../src/engine/submitPr';
import type { PrTool } from '../src/engine/prTool';
import { createRunPipeline } from '../src/engine/runPipeline';
import { createRunStore } from '../src/engine/runStore';
import { createSpecDraftRunner } from '../src/engine/specDraft';
import type { ResultWatcherFactory } from '../src/engine/runQueue';
import type { ResultWatcher, Unsubscribe } from '../src/engine/resultWatcher';
import type { CreateTerminalOptions, HostTerminal, TerminalHost } from '../src/engine/terminalHost';
import type { Adapter, LaunchRequest, LaunchSpec, ProbeResult } from '../src/adapter';
import { createSpecStore } from '../src/activation/specStore';
import {
  createRunQueueSeam,
  createStageLock,
  createTodoQueues,
  type TodoQueues,
} from '../src/activation/engineFacade';
import { parseJournal, todoJournalPathFor } from '../src/journal';
import { parseSpec } from '../src/model/parser';
import { approvalHash } from '../src/model/hash';
import type { Role } from '../src/model/role';
import type { SpecStore } from '../src/engine/runQueue';
import { createToolRegistry, type ToolRegistry } from '../src/orchestrator/registry';
import { GuardContext } from '../src/orchestrator/guard';
import type { SubmitPrOutcome, ToolServices } from '../src/orchestrator/toolServices';
import type { LandTodoSeam } from '../src/orchestrator/seams';
import { systemClock } from '../src/orchestrator/seams';
import { SessionStore, type SessionScope } from '../src/orchestrator/sessionStore';
import { SubAgentRunner, chatSessionKey } from '../src/orchestrator/subAgent';
import { runToolLoop } from '../src/orchestrator/toolLoop';
import { ChatTranscript } from '../src/orchestrator/chatTranscript';
import { readTranscript } from '../src/orchestrator/transcriptReader';
import type {
  ChatMessage,
  CompletionRequest,
  CompletionResult,
  ModelClient,
} from '../src/orchestrator/modelClient';

/**
 * End-to-end test of sub-agent chats driving todos in parallel worktrees (T13).
 *
 * Everything below the agent boundary is real: a real temporary git repository,
 * the real git service, spec-branch writer, spec store, per-todo run queues,
 * run-queue seam, tool registry, sub-agent runner, session store, tool loop,
 * `submitPr` and `landTodoWorktree`. Only the agent boundary (adapter, terminal
 * host, result watcher) and the model client are stubbed.
 *
 * What it pins: a parent chat spawns two sub-agents in one completion; each
 * drives its own todo through plan, execute and review via `run`, the two todos
 * in flight at once (a per-stage barrier fails the test when the stages are
 * serialised) in separate worktrees without losing a state write; `submit_pr`
 * refuses while todos are unlanded; `land_todo` lands both; and a spec-less
 * bug run and the spec draft still work while a todo stage is in flight.
 */

// ---------------------------------------------------------------------------
// Repository helpers
// ---------------------------------------------------------------------------

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function writeRepoFile(root: string, rel: string, contents: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents, 'utf8');
}

function readRepoFile(root: string, rel: string): string {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

/** Must not contain -plan-/-execute-/-review-: the barrier parses run ids. */
const SLUG = 'twin-todos';
const SPEC_REL = `.baiton/specs/${SLUG}/spec.md`;

function initialSpec(): string {
  return [
    '---',
    'version: 1',
    'status: draft',
    'base: main',
    'base_commit:',
    'branch:',
    'approved_rev:',
    '---',
    '',
    '# OVERVIEW',
    '',
    'Two independent modules.',
    '',
    '# TODOS',
    '',
    '- [pending] T01 Add module one (files: src/one.ts)',
    '- [pending] T02 Add module two (files: src/two.ts)',
    '',
  ].join('\n');
}

function makeRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-subagents-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.name', 'Baiton Test');
  git(repo, 'config', 'user.email', 'baiton-test@example.com');
  git(repo, 'checkout', '-q', '-b', 'main');
  writeRepoFile(repo, 'src/one.ts', 'export const one = 0;\n');
  writeRepoFile(repo, 'src/two.ts', 'export const two = 0;\n');
  // Load-bearing: ignores runs/, worktrees/, specs/*/chat/ and specs/*/runs.jsonl.
  writeRepoFile(repo, '.baiton/.gitignore', GITIGNORE_CONTENTS);
  writeRepoFile(repo, SPEC_REL, initialSpec());
  git(repo, 'add', '-A');
  git(repo, 'commit', '-q', '-m', 'initial commit');
  return repo;
}

async function approveSpec(g: GitWorktreeService, repo: string): Promise<void> {
  const baseCommit = await g.resolveBaseCommit('main');
  const branch = `baiton/${SLUG}`;
  await g.createSpecBranch(branch, baseCommit);
  await g.checkout(branch);
  const specAbs = path.join(repo, SPEC_REL);
  let content = fs.readFileSync(specAbs, 'utf8');
  content = setKey(content, 'base_commit', baseCommit);
  content = setKey(content, 'branch', branch);
  content = setKey(content, 'status', 'approved');
  content = setKey(content, 'approved_rev', approvalHash(parseSpec(content)));
  fs.writeFileSync(specAbs, content, 'utf8');
  await g.commit(`spec(${SLUG}): approve`);
}

function setKey(content: string, key: string, value: string): string {
  const lines = content.split('\n');
  if (lines[0]?.trim() !== '---') {
    throw new Error('spec has no frontmatter');
  }
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      break;
    }
    const sep = lines[i].indexOf(':');
    if (sep !== -1 && lines[i].slice(0, sep).trim() === key) {
      lines[i] = `${key}: ${value}`;
      return lines.join('\n');
    }
  }
  throw new Error(`frontmatter key "${key}" not found`);
}

async function waitUntil(ready: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 2000 && !ready(); i++) {
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  assert.ok(ready(), `${what} never happened`);
}

// ---------------------------------------------------------------------------
// Agent-boundary stubs
// ---------------------------------------------------------------------------

class StubAdapter implements Adapter {
  readonly id = 'claude' as const;
  readonly acceptsSessionId = true;
  constructor(private readonly probeOk = true) {}
  async probe(): Promise<ProbeResult> {
    return this.probeOk
      ? { version: '0.0.0-stub', ok: true }
      : { version: '', ok: false, reason: 'pr-writer stub probe refused' };
  }
  launch(_req: LaunchRequest): LaunchSpec {
    return { shellPath: 'true', shellArgs: [] };
  }
  attach(_req: { role: Role; runId: string; sessionId: string }): LaunchSpec {
    return { shellPath: 'true', shellArgs: [] };
  }
}

class StubTerminal implements HostTerminal {
  public disposeCount = 0;
  readonly processId = Promise.resolve<number | undefined>(4321);
  sendText(_text: string): void {}
  dispose(): void {
    this.disposeCount += 1;
  }
  show(): void {}
}

class StubTerminalHost implements TerminalHost {
  public readonly created: StubTerminal[] = [];
  createTerminal(_options: CreateTerminalOptions): HostTerminal {
    const t = new StubTerminal();
    this.created.push(t);
    return t;
  }
}

class StubResultWatcher implements ResultWatcher {
  public disposeCount = 0;
  private resultListeners: Array<(raw: string) => void> = [];
  private closeListeners: Array<(exitCode: number | undefined) => void> = [];

  onResult(listener: (raw: string) => void): Unsubscribe {
    this.resultListeners.push(listener);
    return () => {
      this.resultListeners = this.resultListeners.filter((l) => l !== listener);
    };
  }
  onTerminalClose(listener: (exitCode: number | undefined) => void): Unsubscribe {
    this.closeListeners.push(listener);
    return () => {
      this.closeListeners = this.closeListeners.filter((l) => l !== listener);
    };
  }
  dispose(): void {
    this.disposeCount += 1;
    this.resultListeners = [];
    this.closeListeners = [];
  }
  emitResult(raw: string): void {
    for (const l of [...this.resultListeners]) {
      l(raw);
    }
  }
  emitClose(exitCode: number | undefined): void {
    for (const l of [...this.closeListeners]) {
      l(exitCode);
    }
  }
}

/** A plain watcher factory the test drives itself (the pipeline and the draft). */
class DrivenWatcherFactory implements ResultWatcherFactory {
  public readonly watchers: StubResultWatcher[] = [];
  create(_input: { slug: string; runId: string; resultPath: string; terminal: HostTerminal }): ResultWatcher {
    const w = new StubResultWatcher();
    this.watchers.push(w);
    return w;
  }
}

type TodoName = 'T01' | 'T02';
type StageName = 'plan' | 'execute' | 'review';

const TODO_FILE: Record<TodoName, { file: string; contents: string }> = {
  T01: { file: 'src/one.ts', contents: 'export const one = 1;\n' },
  T02: { file: 'src/two.ts', contents: 'export const two = 2;\n' },
};

function stageBody(todo: TodoName, stage: StageName): string {
  const { file } = TODO_FILE[todo];
  switch (stage) {
    case 'plan':
      return JSON.stringify({
        steps: [{ title: `Implement ${todo}`, detail: 'write the module', files: [file] }],
        risks: [],
        acceptance: ['the module exists'],
      });
    case 'execute':
      return JSON.stringify({
        summary: `implemented ${todo}`,
        files_changed: [file],
        commands_run: ['npm test'],
        notes: [],
      });
    default:
      return JSON.stringify({
        verdict: 'pass',
        findings: [],
        tests: { ran: true, passed: true, output_tail: 'ok' },
      });
  }
}

interface PendingStage {
  todo: TodoName;
  stage: StageName;
  runId: string;
  resultPath: string;
  watcher: StubResultWatcher;
  released: boolean;
}

/**
 * The stubbed sub-agent. A stage's result is withheld until `expected` stages of
 * the same kind are in flight, so two todos that are serialised instead of
 * running concurrently never reach the barrier; a 3s fallback releases a lone
 * stage and records it in `releasedAlone` so that regression fails with a clear
 * assertion rather than a mocha timeout.
 */
class BarrierFactory implements ResultWatcherFactory {
  public readonly created: Array<{ todo: TodoName; stage: StageName; runId: string; resultPath: string }> = [];
  public readonly releasedAlone: string[] = [];
  public inFlight = 0;
  public maxInFlight = 0;
  private readonly pending: Record<StageName, PendingStage[]> = { plan: [], execute: [], review: [] };
  private readonly held = new Map<string, PendingStage>();
  private readonly holds = new Set<string>();

  constructor(private readonly expected: number) {}

  /** Withhold the next `todo`/`stage` result until {@link release} is called. */
  hold(todo: TodoName, stage: StageName): void {
    this.holds.add(`${todo}.${stage}`);
  }

  release(todo: TodoName, stage: StageName): void {
    const key = `${todo}.${stage}`;
    this.holds.delete(key);
    const entry = this.held.get(key);
    if (entry !== undefined) {
      this.held.delete(key);
      setImmediate(() => this.fire(entry));
    }
  }

  create(input: { slug: string; runId: string; resultPath: string; terminal: HostTerminal }): ResultWatcher {
    const m = /^twin-todos-(T\d+)-(plan|execute|review)-/.exec(input.runId);
    if (m === null) {
      throw new Error(`BarrierFactory cannot parse run id "${input.runId}"`);
    }
    const todo = m[1] as TodoName;
    const stage = m[2] as StageName;
    const watcher = new StubResultWatcher();
    const entry: PendingStage = { todo, stage, runId: input.runId, resultPath: input.resultPath, watcher, released: false };
    this.created.push({ todo, stage, runId: input.runId, resultPath: input.resultPath });
    this.inFlight += 1;
    this.maxInFlight = Math.max(this.maxInFlight, this.inFlight);

    const key = `${todo}.${stage}`;
    if (this.holds.has(key)) {
      this.held.set(key, entry);
      return watcher;
    }
    const list = this.pending[stage];
    list.push(entry);
    if (list.length === this.expected) {
      for (const e of list.splice(0, list.length)) {
        setImmediate(() => this.fire(e));
      }
    } else {
      const timer = setTimeout(() => {
        const at = list.indexOf(entry);
        if (at !== -1) {
          list.splice(at, 1);
          this.releasedAlone.push(key);
          this.fire(entry);
        }
      }, 3000);
      timer.unref();
    }
    return watcher;
  }

  private fire(entry: PendingStage): void {
    if (entry.released) {
      return;
    }
    entry.released = true;
    if (entry.stage === 'execute') {
      // The stage runs in the todo's worktree: `<worktree>/.baiton/runs/<run-id>/result.json`.
      const root = path.resolve(path.dirname(entry.resultPath), '..', '..', '..');
      writeRepoFile(root, TODO_FILE[entry.todo].file, TODO_FILE[entry.todo].contents);
    }
    const body = stageBody(entry.todo, entry.stage);
    fs.mkdirSync(path.dirname(entry.resultPath), { recursive: true });
    fs.writeFileSync(entry.resultPath, body, 'utf8');
    this.inFlight -= 1;
    entry.watcher.emitResult(body);
  }
}

function modelForRole(_role: Role): { model: string; effort?: string } {
  return { model: 'stub-model' };
}

// ---------------------------------------------------------------------------
// The scripted model client
// ---------------------------------------------------------------------------

type Script = CompletionResult[];

function reply(content: string): CompletionResult {
  return { content, tool_calls: [] };
}

function calls(...list: Array<{ id: string; name: string; args: unknown }>): CompletionResult {
  return {
    tool_calls: list.map((c) => ({ id: c.id, name: c.name, arguments: JSON.stringify(c.args) })),
  };
}

function subScript(todo: TodoName): Script {
  const run = (stage: StageName): CompletionResult =>
    calls({ id: `${todo}-${stage}`, name: 'run', args: { slug: SLUG, todo, stage } });
  return [run('plan'), run('execute'), run('review'), reply(`${todo} is done`)];
}

class ScriptedClient implements ModelClient {
  public readonly requests: CompletionRequest[] = [];
  private readonly scripts = new Map<string, Script>();

  register(sessionId: string, script: Script): void {
    this.scripts.set(sessionId, script);
  }

  async complete(req: CompletionRequest): Promise<CompletionResult> {
    this.requests.push(req);
    const id = req.sessionId;
    if (id === undefined) {
      throw new Error('ScriptedClient: request without a session id');
    }
    let script = this.scripts.get(id);
    if (script === undefined) {
      const first = req.messages.find((m) => m.role === 'user');
      const m = first === undefined ? null : /T0[12]/.exec(first.content);
      if (m === null) {
        throw new Error(`ScriptedClient: no script for session "${id}" and its first user message names no todo`);
      }
      script = subScript(m[0] as TodoName);
      this.scripts.set(id, script);
    }
    const next = script.shift();
    if (next === undefined) {
      throw new Error(`ScriptedClient: script for session "${id}" is exhausted`);
    }
    return next;
  }
}

// ---------------------------------------------------------------------------
// Harness assembly, mirroring src/activation/commands.ts minus vscode
// ---------------------------------------------------------------------------

interface Harness {
  repo: string;
  specsDir: string;
  baitonDir: string;
  git: GitWorktreeService;
  writer: SpecBranchWriter;
  store: SpecStore;
  queues: TodoQueues;
  registry: ToolRegistry;
  runner: SubAgentRunner;
  sessions: SessionStore;
  guard: GuardContext;
  client: ScriptedClient;
  services: ToolServices;
  terminalHost: StubTerminalHost;
  confirmCalls: string[];
  prCalls: string[];
  scope: SessionScope;
}

function makeHarness(repo: string, factory: ResultWatcherFactory): Harness {
  const specsDir = path.join(repo, '.baiton', 'specs');
  const baitonDir = path.join(repo, '.baiton');
  const gitService = createGitService(repo);
  const writer = createSpecBranchWriter({ specsDir, git: gitService });
  const store = createSpecStore(specsDir, gitService, writer);
  const terminalHost = new StubTerminalHost();
  const queues = createTodoQueues({
    workspaceRoot: repo,
    specsDir,
    git: gitService,
    specWriter: writer,
    specStore: store,
    terminalHost,
    watcherFactory: factory,
    adapterForRole: () => new StubAdapter(),
    modelForRole,
  });

  const confirmCalls: string[] = [];
  const prCalls: string[] = [];

  const landTodo: LandTodoSeam = {
    land: async ({ slug, todoId }) => {
      if (queues.find(slug, todoId)?.isRunning()) {
        return { kind: 'refused', reason: `a stage is still running for todo "${todoId}"` };
      }
      return writer.apply(slug, async () => {
        if ((await gitService.branchHead(todoBranchFor(slug, todoId))) === undefined) {
          return { kind: 'already-landed' as const };
        }
        const landed = await landTodoWorktree({ workspaceRoot: repo, git: gitService }, { slug, todoId });
        if (landed.ok) {
          return {
            kind: 'landed' as const,
            commit: landed.value.commit,
            noop: landed.value.noop,
            cleanup: landed.value.cleanup,
          };
        }
        if (landed.error.reason === 'missing-branch') {
          return { kind: 'already-landed' as const };
        }
        return { kind: 'refused' as const, reason: landed.error.message };
      });
    },
  };

  const recordingPrTool: PrTool = {
    findOpenByHead: async (branch) => {
      prCalls.push(`findOpenByHead ${branch}`);
      throw new Error('findOpenByHead must not be reached');
    },
    create: async () => {
      prCalls.push('create');
      throw new Error('create must not be reached');
    },
  };

  const submitPrForSlug = async (slug: string): Promise<SubmitPrOutcome> => {
    if (queues.isRunning(slug)) {
      return { ok: false, error: `spec "${slug}" already has a run in progress` };
    }
    const result = await submitPr(slug, {
      workspaceRoot: repo,
      specsDir,
      terminalHost,
      watcherFactory: factory,
      git: gitService,
      pr: recordingPrTool,
      remote: 'origin',
      modelForRole,
      adapterForRole: (role) => (role === 'pr-writer' ? new StubAdapter(false) : new StubAdapter()),
      unlandedTodos: (s) => unlandedTodos({ git: gitService }, s),
    });
    if (result.ok) {
      return { ok: true, url: result.pr.url, reused: result.reused, title: result.title };
    }
    return { ok: false, error: result.error.message };
  };

  const sessions = new SessionStore({ baitonDir, specsDir });
  const scope: SessionScope = { kind: 'spec', slug: SLUG };
  const guard = new GuardContext({ repoRoot: repo, specsDir, restricted: false });
  const client = new ScriptedClient();

  // eslint-disable-next-line prefer-const -- late-bound to break a construction cycle
  let registry!: ToolRegistry;
  const runner = new SubAgentRunner({
    sessions,
    client,
    tools: () => registry,
    guardContext: () => guard,
    roundBound: () => 10,
    readSpec: async (s) => fs.promises.readFile(path.join(specsDir, s, 'spec.md'), 'utf8'),
  });

  const services: ToolServices = {
    repoRoot: repo,
    baitonDir,
    git: gitService,
    confirm: {
      confirm: async (m) => {
        confirmCalls.push(m);
        return true;
      },
    },
    runQueue: createRunQueueSeam(queues.queueFor, specsDir, () => new StubAdapter()),
    landTodo,
    submitPr: submitPrForSlug,
    subAgents: runner,
    clock: { now: () => new Date().toISOString() },
    ids: { next: () => 'id-1' },
    gitSettings: { remote: 'origin', base: 'main' },
  };
  registry = createToolRegistry(services);

  return {
    repo,
    specsDir,
    baitonDir,
    git: gitService,
    writer,
    store,
    queues,
    registry,
    runner,
    sessions,
    guard,
    client,
    services,
    terminalHost,
    confirmCalls,
    prCalls,
    scope,
  };
}

/**
 * The main checkout holds no change but the tracked per-todo journals. The
 * queue appends a stage's completion record after the state commit that ends
 * it, and `specs/*\/runs.jsonl` in the canonical .gitignore does not match
 * `todos/<id>/runs.jsonl`, so the last record of each journal stays uncommitted.
 * Every other path must be clean.
 */
async function assertOnlyJournalsDirty(g: GitWorktreeService, what: string): Promise<void> {
  const paths = (await g.status()).changes.map((c) => c.path);
  for (const p of paths) {
    assert.match(p, /^\.baiton\/specs\/twin-todos\/todos\/T0[12]\/runs\.jsonl$/, `${what} has an unexpected change: ${p}`);
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Integration: sub-agent chats drive two todos in parallel worktrees (T13)', () => {
  const repos: string[] = [];

  afterEach(() => {
    while (repos.length > 0) {
      fs.rmSync(repos.pop()!, { recursive: true, force: true });
    }
  });

  function newRepo(): string {
    const repo = makeRepo();
    repos.push(repo);
    return repo;
  }

  function toolContent(history: ChatMessage[], callId: string): string {
    const m = history.find((h) => h.role === 'tool' && h.tool_call_id === callId);
    assert.ok(m !== undefined, `the parent received a result for call "${callId}"`);
    return m.content;
  }

  it('drives two todos through plan, execute and review concurrently in separate worktrees, gates submit_pr on landing, and lands both', async function () {
    this.timeout(30000);
    const repo = newRepo();
    const factory = new BarrierFactory(2);
    const h = makeHarness(repo, factory);
    await approveSpec(h.git, repo);

    // -- The parent chat ------------------------------------------------------
    const parentId = h.sessions.create(h.scope);
    await h.sessions.ensureDir(h.scope);
    const transcript = new ChatTranscript(h.sessions.pathFor(h.scope, parentId), systemClock);
    const first: ChatMessage = { role: 'user', content: 'Drive twin-todos to a PR.' };
    await transcript.append(first);
    const history: ChatMessage[] = [first];

    h.client.register(parentId, [
      calls(
        { id: 'spawn-1', name: 'spawn_subagent', args: { task: 'Drive todo T01 of twin-todos through plan, execute and review.' } },
        { id: 'spawn-2', name: 'spawn_subagent', args: { task: 'Drive todo T02 of twin-todos through plan, execute and review.' } },
      ),
      calls({ id: 'pr-1', name: 'submit_pr', args: { slug: SLUG } }),
      calls(
        { id: 'land-1', name: 'land_todo', args: { slug: SLUG, todo: 'T01' } },
        { id: 'land-2', name: 'land_todo', args: { slug: SLUG, todo: 'T02' } },
      ),
      calls({ id: 'land-3', name: 'land_todo', args: { slug: SLUG, todo: 'T01' } }),
      calls({ id: 'pr-2', name: 'submit_pr', args: { slug: SLUG } }),
      reply('done'),
    ]);

    const assembled = h.registry.assembleFor('drive', 'top');
    assert.ok(assembled.ok, 'the parent tool surface assembles');
    await runToolLoop(history, {
      client: h.client,
      tools: assembled.value,
      call: (name, args, callId, signal) =>
        h.registry.call(name, JSON.parse(args || '{}'), callId, h.guard, 'drive', 'top', {
          sessionKey: chatSessionKey(h.scope, parentId),
          depth: 0,
          phase: 'drive',
          kind: h.scope,
          signal,
        }),
      isConcurrent: (n) => h.registry.definitionsFor('drive', 'top').some((t) => t.name === n && t.concurrent === true),
      systemPrompt: async () => 'parent',
      append: (m) => transcript.append(m),
      roundBound: 10,
      signal: new AbortController().signal,
      sessionId: parentId,
    });

    // -- Concurrency ----------------------------------------------------------
    assert.deepStrictEqual(factory.releasedAlone, [], 'no stage ran alone: both todos reached every barrier together');
    assert.strictEqual(factory.maxInFlight, 2, 'two stages were in flight at once');
    assert.deepStrictEqual(
      factory.created.map((c) => `${c.todo}.${c.stage}`).sort(),
      ['T01.execute', 'T01.plan', 'T01.review', 'T02.execute', 'T02.plan', 'T02.review'],
    );

    // -- The sub-agent chats --------------------------------------------------
    const spawn1 = JSON.parse(toolContent(history, 'spawn-1')) as { chatId: string; reply: string };
    const spawn2 = JSON.parse(toolContent(history, 'spawn-2')) as { chatId: string; reply: string };
    assert.ok(spawn1.chatId && spawn2.chatId, 'both spawns report a chat id');
    assert.strictEqual(spawn1.reply, 'T01 is done');
    assert.strictEqual(spawn2.reply, 'T02 is done');

    const tree = await h.sessions.listTree(h.scope);
    assert.strictEqual(tree.length, 3, 'the parent and two children');
    assert.strictEqual(tree[0].id, parentId);
    const children = tree.slice(1);
    assert.deepStrictEqual(children.map((c) => c.id).sort(), [spawn1.chatId, spawn2.chatId].sort());
    for (const child of children) {
      assert.strictEqual(child.parentId, parentId);
      const records = await readTranscript(h.sessions.pathFor(h.scope, child.id));
      const toolRecords = records.filter((r) => r.role === 'tool');
      assert.strictEqual(toolRecords.length, 3, `${child.id} ran plan, execute and review`);
      for (const r of toolRecords) {
        assert.ok(!r.content.startsWith('Error:'), `a sub-agent tool call failed: ${r.content}`);
      }
    }

    // -- The sub-agent tool surface -------------------------------------------
    const childIds = new Set(children.map((c) => c.id));
    const childRequests = h.client.requests.filter((r) => r.sessionId !== undefined && childIds.has(r.sessionId));
    assert.ok(childRequests.length >= 8, 'the children made their completions');
    for (const req of childRequests) {
      const names = (req.tools ?? []).map((t) => t.name);
      for (const wanted of ['run', 'spawn_subagent', 'send_to_subagent']) {
        assert.ok(names.includes(wanted), `a sub-agent is offered ${wanted}`);
      }
      for (const banned of ['land_todo', 'submit_pr', 'approve_spec', 'draft_spec', 'start_run']) {
        assert.ok(!names.includes(banned), `a sub-agent must not be offered ${banned}`);
      }
    }

    // -- submit_pr refuses before landing, land_todo lands both ---------------
    const pr1 = toolContent(history, 'pr-1');
    assert.ok(pr1.startsWith('Error:'), pr1);
    assert.ok(pr1.includes('still unlanded: T01, T02'), pr1);
    assert.ok(pr1.includes('land_todo'), pr1);
    assert.ok(h.confirmCalls.length >= 1, 'submit_pr asked for confirmation');
    assert.deepStrictEqual(h.prCalls, [], 'nothing was pushed or created');

    for (const id of ['land-1', 'land-2']) {
      const landed = JSON.parse(toolContent(history, id)) as { landed: boolean; commit: string };
      assert.strictEqual(landed.landed, true);
      assert.match(landed.commit, /^[0-9a-f]{40}$/);
    }
    const again = toolContent(history, 'land-3');
    assert.ok(!again.startsWith('Error:'), again);
    const againJson = JSON.parse(again) as { landed: boolean; message: string };
    assert.strictEqual(againJson.landed, false);
    assert.strictEqual(againJson.message, 'already landed');

    const pr2 = toolContent(history, 'pr-2');
    assert.ok(pr2.startsWith('Error:'), pr2);
    assert.ok(pr2.includes('probe failed'), pr2);
    assert.ok(!pr2.includes('unlanded') && !pr2.includes('every todo must be done'), pr2);
    assert.deepStrictEqual(h.prCalls, [], 'still nothing pushed or created');

    // -- Spec state was not clobbered -----------------------------------------
    const todos = parseSpec(readRepoFile(repo, SPEC_REL)).todos;
    assert.deepStrictEqual(todos.map((t) => [t.id, t.state]), [['T01', 'done'], ['T02', 'done']]);
    assert.strictEqual(await h.store.currentState(SLUG, 'T01'), 'done');
    assert.strictEqual(await h.store.currentState(SLUG, 'T02'), 'done');

    const subjects = git(repo, 'log', '--format=%s', `baiton/${SLUG}`).split('\n').filter((s) => s.length > 0);
    for (const id of ['T01', 'T02']) {
      for (const suffix of ['planning', 'planned', 'executed', 'done']) {
        assert.ok(subjects.includes(`spec(${SLUG}): ${id} ${suffix}`), `missing state commit "${id} ${suffix}"`);
      }
      assert.ok(subjects.includes(`spec(${SLUG}): land ${id}`), `missing land commit for ${id}`);
    }
    const stateCommits = git(repo, 'log', '--format=%H%x09%s', `baiton/${SLUG}`)
      .split('\n')
      .filter((l) => /\tspec\(twin-todos\): T0[12] (planning|planned|executing|executed|reviewing|done)$/.test(l));
    assert.ok(stateCommits.length >= 8, 'the state commits are on the spec branch');
    for (const line of stateCommits) {
      const sha = line.split('\t')[0];
      const files = git(repo, 'show', '--name-only', '--format=', sha).split('\n').filter((f) => f.length > 0);
      assert.ok(files.length > 0, `state commit ${line} touches something`);
      for (const f of files) {
        assert.ok(f.startsWith(`.baiton/specs/${SLUG}/`), `state commit "${line}" touched ${f}`);
      }
    }

    // -- Worktree isolation ---------------------------------------------------
    for (const id of ['T01', 'T02']) {
      assert.strictEqual(
        subjects.filter((s) => s === `spec(${SLUG}): ${id} execute attempt 1`).length,
        1,
        `${id}'s own execute commit arrived through its merge, exactly once`,
      );
      assert.ok(!fs.existsSync(todoWorktreeDirFor(repo, SLUG, id)), `${id}'s worktree was removed`);
      assert.strictEqual(git(repo, 'branch', '--list', todoBranchFor(SLUG, id)).trim(), '', `${id}'s branch was removed`);
    }
    assert.ok(readRepoFile(repo, 'src/one.ts').includes('export const one = 1;'));
    assert.ok(readRepoFile(repo, 'src/two.ts').includes('export const two = 2;'));
    assert.deepStrictEqual(await unlandedTodos({ git: h.git }, SLUG), []);
    await assertOnlyJournalsDirty(h.git, 'the main checkout');
    assert.strictEqual(await h.git.currentBranch(), `baiton/${SLUG}`);

    // -- Journals -------------------------------------------------------------
    for (const id of ['T01', 'T02']) {
      const journalPath = todoJournalPathFor(h.specsDir, SLUG, id);
      const entries = parseJournal(journalPath);
      assert.deepStrictEqual(
        entries.map((e) => [e.stage, e.result]),
        [['plan', 'completed'], ['execute', 'completed'], ['review', 'completed']],
        `${id}'s journal holds its own three completed entries`,
      );
      for (const e of entries) {
        assert.strictEqual(e.todoId, id);
      }
      const tracked = git(repo, 'ls-files', path.relative(repo, journalPath)).trim();
      assert.ok(tracked.length > 0, `${id}'s journal is tracked`);
    }
  });

  it('runs a spec-less bug run and starts a spec draft while a todo stage is in flight', async function () {
    this.timeout(30000);
    const repo = newRepo();
    const factory = new BarrierFactory(1);
    factory.hold('T01', 'plan');
    const h = makeHarness(repo, factory);
    await approveSpec(h.git, repo);

    const pipelineWatchers = new DrivenWatcherFactory();
    const draftWatchers = new DrivenWatcherFactory();
    // eslint-disable-next-line prefer-const -- late-bound to break a construction cycle
    let runPipeline!: ReturnType<typeof createRunPipeline>;
    // eslint-disable-next-line prefer-const -- late-bound to break a construction cycle
    let draftRunner!: ReturnType<typeof createSpecDraftRunner>;
    const lock = createStageLock({
      specDraftRunning: () => draftRunner.isRunning(),
      runRunning: () => runPipeline.isRunning(),
    });
    runPipeline = createRunPipeline({
      workspaceRoot: repo,
      git: h.git,
      store: createRunStore({ workspaceRoot: repo }),
      terminalHost: new StubTerminalHost(),
      watcherFactory: pipelineWatchers,
      modelForRole,
      adapterForRole: () => new StubAdapter(),
      execAttempts: () => 2,
      verify: () => 'npm test',
      newRunId: () => 'bug-20260101-000000-aaaa',
      newSessionId: () => '11111111-1111-4111-8111-111111111111',
      isSpecBusy: () => lock.runPipelineBusy(),
    });
    draftRunner = createSpecDraftRunner({
      workspaceRoot: repo,
      specsDir: h.specsDir,
      terminalHost: new StubTerminalHost(),
      watcherFactory: draftWatchers,
      services: h.services,
      modelForRole,
      adapterForRole: () => new StubAdapter(),
      isQueueRunning: () => lock.specDraftBusy(),
      newRunId: () => 'draft-run-1',
    });

    // A todo stage goes in flight and stays there.
    const planning = h.services.runQueue.dispatch({ slug: SLUG, todoId: 'T01', stage: 'plan' });
    await waitUntil(() => factory.created.some((c) => c.todo === 'T01' && c.stage === 'plan'), 'the T01 plan watcher');
    assert.strictEqual(h.queues.isRunning(SLUG), true);
    assert.deepStrictEqual(await h.services.runQueue.dispatch({ slug: SLUG, todoId: 'T01', stage: 'plan' }), { kind: 'busy' });
    const t02 = await h.services.runQueue.dispatch({ slug: SLUG, todoId: 'T02', stage: 'plan' });
    assert.strictEqual(t02.kind, 'dispatched', 'another todo is not blocked by it');
    assert.strictEqual(await h.store.currentState(SLUG, 'T02'), 'planned');

    // A spec-less bug run is not blocked by the in-flight todo stage.
    const started = await runPipeline.start({
      mode: 'bug',
      composerMode: 'bug',
      explicitMode: false,
      statement: 'module one is off by one',
      files: ['src/one.ts'],
      reproduction: 'Call one().',
    });
    assert.ok(started.ok, `the bug run starts: ${JSON.stringify(started.ok ? '' : started.error)}`);
    if (!started.ok) {
      return;
    }
    const busyDraft = await draftRunner.start({ slug: 'other-spec', requirements: 'Goal: other.' });
    assert.ok(!busyDraft.ok && busyDraft.error.kind === 'busy', 'the draft is refused while the run is in flight');

    await waitUntil(() => pipelineWatchers.watchers.length > 0, 'the run plan watcher');
    pipelineWatchers.watchers[0].emitResult(stageBody('T01', 'plan'));
    await waitUntil(() => pipelineWatchers.watchers.length > 1, 'the run execute watcher');
    const runWorktree = path.join(repo, '.baiton', 'worktrees', 'bug-20260101-000000-aaaa');
    writeRepoFile(runWorktree, 'src/one.ts', 'export const one = 7;\n');
    pipelineWatchers.watchers[1].emitResult(stageBody('T01', 'execute'));
    await waitUntil(() => pipelineWatchers.watchers.length > 2, 'the run review watcher');
    pipelineWatchers.watchers[2].emitResult(stageBody('T01', 'review'));
    const outcome = await started.completed;
    assert.strictEqual(outcome.state, 'done');
    assert.strictEqual(outcome.commits.length, 1);
    assert.strictEqual(git(runWorktree, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'baiton/bug/bug-20260101-000000-aaaa');
    assert.strictEqual(
      parseSpec(readRepoFile(repo, SPEC_REL)).todos.find((t) => t.id === 'T01')?.state,
      'planning',
      'the run did not touch the in-flight todo',
    );

    // With the run finished, the draft starts even though a todo stage is in flight.
    const draft = await draftRunner.start({ slug: 'other-spec', requirements: 'Goal: other.' });
    assert.ok(draft.ok, 'a todo stage does not block the spec draft');
    if (!draft.ok) {
      return;
    }
    await waitUntil(() => draftWatchers.watchers.length > 0, 'the draft watcher');
    draftWatchers.watchers[0].emitClose(1);
    const drafted = await draft.completed;
    assert.strictEqual(drafted.ok, false, 'a closed terminal drafts nothing');

    // The held stage finishes and nothing was clobbered.
    factory.release('T01', 'plan');
    assert.deepStrictEqual(await planning, { kind: 'dispatched', runId: 'completed' });
    const states = parseSpec(readRepoFile(repo, SPEC_REL)).todos.map((t) => [t.id, t.state]);
    assert.deepStrictEqual(states, [['T01', 'planned'], ['T02', 'planned']]);
    await assertOnlyJournalsDirty(h.git, 'the main checkout');
  });
});
