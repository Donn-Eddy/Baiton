import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createGitService } from '../src/git/gitService';
import { submitPr, PR_DIFF_FILE_NAME, PR_TODO_ID } from '../src/engine/submitPr';
import type { SubmitPrDeps } from '../src/engine/submitPr';
import type { CreatePrInput, PrTool, PullRequest } from '../src/engine/prTool';
import {
  createPrTool,
  detectProvider,
  parseCreatedPr,
  parsePrList,
  remoteHost,
  resolveProviderExecutable,
} from '../src/engine/prTool';
import type { ResultWatcherFactory } from '../src/engine/runQueue';
import type {
  CreateTerminalOptions,
  HostTerminal,
  TerminalHost,
} from '../src/engine/terminalHost';
import type { ResultWatcher, Unsubscribe } from '../src/engine/resultWatcher';
import type { Adapter, LaunchRequest, LaunchSpec, ProbeResult } from '../src/adapter';
import type { Role } from '../src/model/role';
import { parseJournal } from '../src/journal';
import { parseSpec } from '../src/model/parser';
import { approvalHash } from '../src/model/hash';
import { GITIGNORE_CONTENTS } from '../src/config/gitignore';

/**
 * Submit PR (design section 8 "PR") against a real temporary repository with a
 * bare remote, a fake PR tool, and the stubbed agent boundary the integration
 * test uses. Covers the readiness gate, Verify, the happy path (push, create,
 * record, journal), PR reuse, and a rejected push.
 */

const SLUG = 'greeting';
const BRANCH = `baiton/${SLUG}`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function write(repo: string, rel: string, contents: string): void {
  const full = path.join(repo, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents, 'utf8');
}

function specText(opts: { states: string[]; baseCommit: string; approvedRev?: string }): string {
  const todos = opts.states.map((s, i) => `- [${s}] T0${i + 1} Step ${i + 1}`);
  return [
    '---',
    `name: ${SLUG}`,
    'status: approved',
    'mode: manual',
    'base: main',
    `base_commit: ${opts.baseCommit}`,
    `branch: ${BRANCH}`,
    `approved_rev: ${opts.approvedRev ?? ''}`,
    'pr:',
    '---',
    '',
    '# OVERVIEW',
    '',
    'Add a greeting.',
    '',
    '# TODOS',
    '',
    ...todos,
    '',
  ].join('\n');
}

interface Repo {
  root: string;
  remote: string;
  specsDir: string;
}

/**
 * A repo on `main` with one commit, a bare `origin`, and the spec branch checked
 * out with the spec (all todos in `states`) committed on it plus one code
 * change so the cumulative diff is non-empty.
 */
function makeRepo(states: string[], withRemote = true): Repo {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-pr-'));
  const remote = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-pr-remote-'));
  git(remote, 'init', '-q', '--bare');
  git(root, 'init', '-q');
  git(root, 'config', 'user.name', 'Baiton Test');
  git(root, 'config', 'user.email', 'baiton-test@example.com');
  git(root, 'checkout', '-q', '-b', 'main');
  write(root, 'src/greeting.ts', 'export const version = 0;\n');
  // The real layout ignores the runs directory and journal under `.baiton/`.
  write(root, '.baiton/.gitignore', GITIGNORE_CONTENTS);
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'initial commit');
  if (withRemote) {
    git(root, 'remote', 'add', 'origin', remote);
  }
  const baseCommit = git(root, 'rev-parse', 'HEAD').trim();

  git(root, 'checkout', '-q', '-b', BRANCH);
  const specRel = `.baiton/specs/${SLUG}/spec.md`;
  const unapproved = specText({ states, baseCommit });
  const approvedRev = approvalHash(parseSpec(unapproved));
  write(root, specRel, specText({ states, baseCommit, approvedRev }));
  write(root, `.baiton/specs/${SLUG}/plan.md`, '# plan\n');
  write(root, 'src/greeting.ts', 'export const greet = (n: string) => `hi ${n}`;\n');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', `spec(${SLUG}): T01 execute attempt 1`);

  return { root, remote, specsDir: path.join(root, '.baiton', 'specs') };
}

class StubAdapter implements Adapter {
  readonly id = 'claude' as const;
  readonly acceptsSessionId = true;
  public launches: LaunchRequest[] = [];
  public probeCount = 0;
  async probe(): Promise<ProbeResult> {
    this.probeCount += 1;
    return { version: 'stub', ok: true };
  }
  launch(req: LaunchRequest): LaunchSpec {
    this.launches.push(req);
    return { shellPath: 'true', shellArgs: [] };
  }
  attach(_req: { role: Role; runId: string; sessionId: string }): LaunchSpec {
    return { shellPath: 'true', shellArgs: [] };
  }
}

class StubTerminal implements HostTerminal {
  public disposeCount = 0;
  readonly processId = Promise.resolve<number | undefined>(777);
  sendText(): void {}
  dispose(): void {
    this.disposeCount += 1;
  }
  show(): void {}
}

class StubTerminalHost implements TerminalHost {
  public readonly created: Array<{ terminal: StubTerminal; options: CreateTerminalOptions }> = [];
  createTerminal(options: CreateTerminalOptions): HostTerminal {
    const terminal = new StubTerminal();
    this.created.push({ terminal, options });
    return terminal;
  }
}

class StubWatcher implements ResultWatcher {
  private results: Array<(raw: string) => void> = [];
  private closes: Array<(code: number | undefined) => void> = [];
  onResult(l: (raw: string) => void): Unsubscribe {
    this.results.push(l);
    return () => undefined;
  }
  onTerminalClose(l: (code: number | undefined) => void): Unsubscribe {
    this.closes.push(l);
    return () => undefined;
  }
  dispose(): void {}
  emitResult(raw: string): void {
    for (const l of [...this.results]) l(raw);
  }
  emitClose(code: number | undefined): void {
    for (const l of [...this.closes]) l(code);
  }
}

class StubWatcherFactory implements ResultWatcherFactory {
  public readonly created: Array<{ watcher: StubWatcher; resultPath: string }> = [];
  create(input: { resultPath: string }): ResultWatcher {
    const watcher = new StubWatcher();
    this.created.push({ watcher, resultPath: input.resultPath });
    return watcher;
  }
}

class FakePrTool implements PrTool {
  public existing: PullRequest | undefined;
  public created: CreatePrInput[] = [];
  public lookedUp: string[] = [];
  async findOpenByHead(branch: string): Promise<PullRequest | undefined> {
    this.lookedUp.push(branch);
    return this.existing;
  }
  async create(input: CreatePrInput): Promise<PullRequest> {
    this.created.push(input);
    return { url: 'https://example.test/pull/42', number: 42 };
  }
}

interface Harness {
  repo: Repo;
  adapter: StubAdapter;
  terminals: StubTerminalHost;
  watchers: StubWatcherFactory;
  pr: FakePrTool;
  deps: SubmitPrDeps;
}

function harness(repo: Repo, overrides: Partial<SubmitPrDeps> = {}): Harness {
  const adapter = new StubAdapter();
  const terminals = new StubTerminalHost();
  const watchers = new StubWatcherFactory();
  const pr = new FakePrTool();
  const deps: SubmitPrDeps = {
    workspaceRoot: repo.root,
    specsDir: repo.specsDir,
    terminalHost: terminals,
    watcherFactory: watchers,
    git: createGitService(repo.root),
    pr,
    remote: 'origin',
    modelForRole: () => ({ model: 'stub-model' }),
    adapterForRole: () => adapter,
    newSessionId: () => 'session-pr',
    clock: () => 1_700_000_000_000,
    ...overrides,
  };
  return { repo, adapter, terminals, watchers, pr, deps };
}

/** Poll until the flow has created its result watcher (real git calls precede it). */
async function awaitWatcher(h: Harness): Promise<StubWatcher> {
  const deadline = Date.now() + 10_000;
  while (h.watchers.created.length === 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.strictEqual(h.watchers.created.length, 1, 'the pr-writer stage created one watcher');
  return h.watchers.created[0].watcher;
}

/** Wait for the watcher, then hand it the draft. */
async function deliverDraft(h: Harness, draft: unknown): Promise<void> {
  (await awaitWatcher(h)).emitResult(JSON.stringify(draft));
}

const DRAFT = { title: 'Add greeting', body: 'Adds greet().\n\nVerified by tests.' };

function readSpec(repo: Repo): ReturnType<typeof parseSpec> {
  return parseSpec(fs.readFileSync(path.join(repo.specsDir, SLUG, 'spec.md'), 'utf8'));
}

describe('submitPr (design section 8 "PR")', () => {
  it('refuses while a todo is not done and launches nothing', async () => {
    const h = harness(makeRepo(['done', 'executed']));
    const result = await submitPr(SLUG, h.deps);
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.strictEqual(result.error.kind, 'not-ready');
      assert.match(result.error.message, /T02 \(executed\)/);
    }
    assert.strictEqual(h.terminals.created.length, 0);
    assert.strictEqual(h.pr.created.length, 0);
  });

  it('refuses when the spec branch is not checked out', async () => {
    const repo = makeRepo(['done']);
    // A sibling branch carries the same spec, but it is not the spec's branch.
    git(repo.root, 'checkout', '-q', '-b', 'other');
    const h = harness(repo);
    const result = await submitPr(SLUG, h.deps);
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.strictEqual(result.error.kind, 'not-ready');
      assert.match(result.error.message, /other is checked out/);
    }
    assert.strictEqual(h.terminals.created.length, 0);
  });

  it('halts on a failing verify command before launching, with its output', async () => {
    const commands: string[] = [];
    const h = harness(makeRepo(['done']), {
      verify: 'npm test',
      runCommand: async (command) => {
        commands.push(command);
        return { ok: false, output: '1 failing\n' };
      },
    });
    const result = await submitPr(SLUG, h.deps);
    assert.deepStrictEqual(commands, ['npm test']);
    assert.strictEqual(result.ok, false);
    if (!result.ok) {
      assert.strictEqual(result.error.kind, 'verify-failed');
      assert.ok(result.error.kind === 'verify-failed' && result.error.output.includes('1 failing'));
    }
    assert.strictEqual(h.terminals.created.length, 0);
  });

  it('refuses with unknown-agent when adapterForRole returns undefined, before probing or launching (Req 14.1)', async () => {
    const h = harness(makeRepo(['done']), { adapterForRole: () => undefined });
    const result = await submitPr(SLUG, h.deps);
    assert.strictEqual(result.ok, false, 'an unknown agent id must refuse the PR submission');
    if (!result.ok) {
      assert.strictEqual(result.error.kind, 'unknown-agent');
      assert.match(result.error.message, /pr-writer/);
      assert.match(result.error.message, /roles\.pr-writer\.agent/);
      assert.match(result.error.message, /\.baiton\/config\.json/);
    }
    assert.strictEqual(h.adapter.probeCount, 0, 'no probe runs for an unknown agent');
    assert.strictEqual(h.terminals.created.length, 0, 'no terminal is created for an unknown agent');
  });

  it('drafts, pushes, creates the PR, records it and journals each step', async () => {
    const h = harness(makeRepo(['done', 'done']));
    const pending = submitPr(SLUG, h.deps);
    await deliverDraft(h, DRAFT);
    const result = await pending;

    assert.strictEqual(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.strictEqual(result.pr.url, 'https://example.test/pull/42');
    assert.strictEqual(result.reused, false);
    assert.strictEqual(result.title, DRAFT.title);

    // The pr-writer was launched as the `pr` stage with a diff and context.
    assert.strictEqual(h.adapter.launches.length, 1);
    assert.strictEqual(h.adapter.launches[0].role, 'pr-writer');
    const { options, terminal } = h.terminals.created[0];
    assert.strictEqual(options.cwd, h.repo.root);
    assert.strictEqual(terminal.disposeCount, 1, 'terminal disposed on the valid draft');
    const runDir = path.dirname(h.watchers.created[0].resultPath);
    const diff = fs.readFileSync(path.join(runDir, PR_DIFF_FILE_NAME), 'utf8');
    assert.match(diff, /greet/, 'the cumulative diff from base_commit covers the code change');
    const brief = fs.readFileSync(path.join(runDir, 'brief.md'), 'utf8');
    assert.ok(brief.includes('# Context'), 'the brief carries a context section');
    assert.ok(brief.includes(PR_DIFF_FILE_NAME), 'the context names the diff');
    assert.ok(brief.indexOf('# Role') < brief.indexOf('# Context'), 'context follows the role');
    assert.ok(brief.indexOf('# Context') < brief.indexOf('# Result file'), 'context precedes the result path');

    // The PR was created against the spec's base from its branch.
    assert.deepStrictEqual(h.pr.lookedUp, [BRANCH]);
    assert.deepStrictEqual(h.pr.created, [{ base: 'main', head: BRANCH, title: DRAFT.title, body: DRAFT.body }]);

    // The branch reached the remote with upstream set.
    const remoteHeads = git(h.repo.remote, 'branch', '--list', BRANCH);
    assert.match(remoteHeads, /baiton\/greeting/);
    assert.strictEqual(git(h.repo.root, 'rev-parse', '--abbrev-ref', `${BRANCH}@{upstream}`).trim(), `origin/${BRANCH}`);

    // The metadata was recorded and committed; the draft persisted as pr.md.
    const spec = readSpec(h.repo);
    assert.strictEqual(spec.frontmatter.get('pr'), 'https://example.test/pull/42');
    assert.strictEqual(spec.frontmatter.get('status'), 'pr');
    assert.strictEqual(git(h.repo.root, 'log', '-1', '--format=%s').trim(), `spec(${SLUG}): pr`);
    assert.strictEqual(git(h.repo.root, 'status', '--porcelain').trim(), '', 'tree is clean after recording');
    assert.ok(fs.existsSync(path.join(h.repo.specsDir, SLUG, 'pr.md')));

    // The journal has one PR start and a completion with every step true.
    const entries = parseJournal(path.join(h.repo.specsDir, SLUG, 'runs.jsonl'));
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].stage, 'pr');
    assert.strictEqual(entries[0].todoId, PR_TODO_ID);
    assert.strictEqual(entries[0].result, 'completed');
    assert.deepStrictEqual(entries[0].pr, { push: true, create: true, record: true });
  });

  it('reuses an open PR for the head branch instead of creating another', async () => {
    const h = harness(makeRepo(['done']));
    h.pr.existing = { url: 'https://example.test/pull/7', number: 7 };
    const pending = submitPr(SLUG, h.deps);
    await deliverDraft(h, DRAFT);
    const result = await pending;
    assert.strictEqual(result.ok, true, JSON.stringify(result));
    if (!result.ok) return;
    assert.strictEqual(result.reused, true);
    assert.strictEqual(result.pr.url, 'https://example.test/pull/7');
    assert.strictEqual(h.pr.created.length, 0);
    assert.strictEqual(readSpec(h.repo).frontmatter.get('pr'), 'https://example.test/pull/7');
  });

  it('halts with push-failed and journals push:false when the push is rejected', async () => {
    const h = harness(makeRepo(['done'], /* withRemote */ false));
    const pending = submitPr(SLUG, h.deps);
    await deliverDraft(h, DRAFT);
    const result = await pending;
    assert.strictEqual(result.ok, false);
    if (result.ok) return;
    assert.strictEqual(result.error.kind, 'push-failed');
    assert.strictEqual(h.pr.created.length, 0, 'no PR is created after a rejected push');
    assert.strictEqual(readSpec(h.repo).frontmatter.get('pr'), '', 'pr key untouched');
    assert.strictEqual(readSpec(h.repo).frontmatter.get('status'), 'approved');
    const entries = parseJournal(path.join(h.repo.specsDir, SLUG, 'runs.jsonl'));
    assert.deepStrictEqual(entries[0].pr, { push: false, create: false, record: false });
  });

  it('records a closed terminal as the outcome and pushes nothing', async () => {
    const h = harness(makeRepo(['done']));
    const pending = submitPr(SLUG, h.deps);
    (await awaitWatcher(h)).emitClose(1);
    const result = await pending;
    assert.strictEqual(result.ok, false);
    if (result.ok) return;
    assert.strictEqual(result.error.kind, 'outcome');
    const entries = parseJournal(path.join(h.repo.specsDir, SLUG, 'runs.jsonl'));
    assert.strictEqual(entries[0].result, 'closed');
    assert.strictEqual(git(h.repo.remote, 'branch', '--list', BRANCH).trim(), '');
  });
});

describe('PR providers', () => {
  it('detects GitLab from the remote host and defaults to GitHub otherwise', () => {
    assert.strictEqual(remoteHost('git@github.com:o/r.git'), 'github.com');
    assert.strictEqual(remoteHost('https://user@gitlab.example.org/g/p.git'), 'gitlab.example.org');
    assert.strictEqual(remoteHost('ssh://git@gitlab.com:2222/g/p.git'), 'gitlab.com');
    assert.strictEqual(detectProvider('git@gitlab.com:g/p.git'), 'glab');
    assert.strictEqual(detectProvider('https://gitlab.corp.internal/g/p.git'), 'glab');
    assert.strictEqual(detectProvider('https://github.com/o/r.git'), 'gh');
    assert.strictEqual(detectProvider('git@ghe.corp:o/r.git'), 'gh');
  });

  it('resolves the CLI from an override, then PATH, then the fallback directories', () => {
    const present = new Set(['/brew/bin/gh', '/opt/tools/glab', '/custom/my-gh']);
    const isExecutable = (c: string): boolean => present.has(c);
    const opts = { pathEnv: '/nowhere:/opt/tools', fallbackDirs: ['/brew/bin'], isExecutable };
    assert.strictEqual(resolveProviderExecutable('gh', opts), '/brew/bin/gh', 'fallback dir');
    assert.strictEqual(resolveProviderExecutable('glab', opts), '/opt/tools/glab', 'PATH');
    assert.strictEqual(resolveProviderExecutable('gh', { ...opts, override: '/custom/my-gh' }), '/custom/my-gh');
    assert.strictEqual(resolveProviderExecutable('gh', { ...opts, override: '/custom/missing' }), undefined);
    assert.strictEqual(resolveProviderExecutable('gh', { ...opts, fallbackDirs: [] }), undefined);
  });

  it('drives gh with pr list/create arguments', async () => {
    const calls: string[][] = [];
    const tool = createPrTool({
      kind: 'gh',
      executable: '/bin/gh',
      repoRoot: '/repo',
      run: async (exe, args, cwd) => {
        assert.strictEqual(exe, '/bin/gh');
        assert.strictEqual(cwd, '/repo');
        calls.push(args);
        return args[1] === 'list' ? '[]' : 'https://github.com/o/r/pull/5\n';
      },
    });
    assert.strictEqual(await tool.findOpenByHead('b'), undefined);
    const created = await tool.create({ base: 'main', head: 'b', title: 't', body: 'multi\nline' });
    assert.deepStrictEqual(created, { url: 'https://github.com/o/r/pull/5', number: 5 });
    assert.deepStrictEqual(calls[0].slice(0, 4), ['pr', 'list', '--head', 'b']);
    assert.deepStrictEqual(calls[1], [
      'pr', 'create', '--base', 'main', '--head', 'b', '--title', 't', '--body', 'multi\nline',
    ]);
  });

  it('drives glab with mr list/create arguments and reads iid/web_url', async () => {
    const calls: string[][] = [];
    const tool = createPrTool({
      kind: 'glab',
      executable: '/bin/glab',
      repoRoot: '/repo',
      run: async (_exe, args) => {
        calls.push(args);
        return args[1] === 'list'
          ? '[{"iid":9,"web_url":"https://gitlab.com/g/p/-/merge_requests/9"}]'
          : 'https://gitlab.com/g/p/-/merge_requests/10\n';
      },
    });
    assert.deepStrictEqual(await tool.findOpenByHead('b'), {
      url: 'https://gitlab.com/g/p/-/merge_requests/9',
      number: 9,
    });
    const created = await tool.create({ base: 'main', head: 'b', title: 't', body: 'd' });
    assert.strictEqual(created.number, 10);
    assert.deepStrictEqual(calls[0], ['mr', 'list', '--source-branch', 'b', '--output', 'json']);
    assert.deepStrictEqual(calls[1], [
      'mr', 'create', '--source-branch', 'b', '--target-branch', 'main', '--title', 't', '--description', 'd', '--yes',
    ]);
  });

  it('parses a request list from either provider and tolerates empty or malformed output', () => {
    assert.deepStrictEqual(parsePrList('[{"number":3,"url":"https://x/pull/3"}]'), [
      { url: 'https://x/pull/3', number: 3 },
    ]);
    assert.deepStrictEqual(parsePrList('[{"iid":4,"web_url":"https://x/-/merge_requests/4"}]'), [
      { url: 'https://x/-/merge_requests/4', number: 4 },
    ]);
    assert.deepStrictEqual(parsePrList(''), []);
    assert.deepStrictEqual(parsePrList('not json'), []);
  });

  it('takes the created PR url from the last url line of gh pr create', () => {
    assert.deepStrictEqual(parseCreatedPr('Creating pull request...\n\nhttps://github.com/o/r/pull/12\n'), {
      url: 'https://github.com/o/r/pull/12',
      number: 12,
    });
    assert.throws(() => parseCreatedPr('nothing here'));
  });
});
