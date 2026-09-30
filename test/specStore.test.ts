import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createSpecStore } from '../src/activation/specStore';
import { GITIGNORE_CONTENTS } from '../src/config/gitignore';
import { createGitService } from '../src/git/gitService';
import { appendCompletion, appendStart, todoJournalPathFor } from '../src/journal';

const SPEC = [
  '---',
  'status: draft',
  'branch:',
  'approved_rev: ',
  '---',
  '',
  '# OVERVIEW',
  '',
  'Prose.',
  '',
  '# TODOS',
  '',
  '- [pending] T01 First todo',
  '- [pending] T02 Second todo',
  '',
].join('\n');

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function writeFile(repo: string, relPath: string, contents: string): void {
  const full = path.join(repo, relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, contents);
}

describe('createSpecStore (real repo)', () => {
  let repo: string;
  let specsDir: string;
  let store: ReturnType<typeof createSpecStore>;

  beforeEach(() => {
    repo = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-store-'));
    git(repo, 'init', '-q');
    git(repo, 'config', 'user.name', 'Baiton Test');
    git(repo, 'config', 'user.email', 'baiton-test@example.com');
    git(repo, 'checkout', '-q', '-b', 'main');
    writeFile(repo, 'README.md', 'baseline\n');
    writeFile(repo, '.baiton/.gitignore', GITIGNORE_CONTENTS);
    writeFile(repo, '.baiton/specs/s/spec.md', SPEC);
    git(repo, 'add', '-A');
    git(repo, 'commit', '-q', '-m', 'initial commit');
    git(repo, 'checkout', '-q', '-b', 'baiton/s');
    specsDir = path.join(repo, '.baiton', 'specs');
    store = createSpecStore(specsDir, createGitService(repo));
  });

  afterEach(() => {
    fs.rmSync(repo, { recursive: true, force: true });
  });

  const subjects = (n: number): string[] =>
    git(repo, 'log', '-n', String(n), '--format=%s').trim().split('\n');

  it('concurrent writes for two todos do not clobber each other', async () => {
    const r = await Promise.all([
      store.writeState('s', 'T01', 'planning'),
      store.writeState('s', 'T02', 'planning'),
    ]);
    assert.deepStrictEqual(r, [true, true]);
    assert.strictEqual(await store.currentState('s', 'T01'), 'planning');
    assert.strictEqual(await store.currentState('s', 'T02'), 'planning');
    assert.deepStrictEqual(subjects(2), ['spec(s): T02 planning', 'spec(s): T01 planning']);
    assert.strictEqual(git(repo, 'status', '--porcelain', '--', '.baiton/specs/s').trim(), '');
  });

  it('keeps call order across a larger interleaving', async () => {
    const r = await Promise.all([
      store.writeState('s', 'T01', 'planning'),
      store.writeState('s', 'T02', 'planning'),
      store.writeState('s', 'T01', 'planned'),
      store.writeState('s', 'T02', 'planned'),
    ]);
    assert.deepStrictEqual(r, [true, true, true, true]);
    assert.strictEqual(await store.currentState('s', 'T01'), 'planned');
    assert.strictEqual(await store.currentState('s', 'T02'), 'planned');
    assert.deepStrictEqual(subjects(4), [
      'spec(s): T02 planned',
      'spec(s): T01 planned',
      'spec(s): T02 planning',
      'spec(s): T01 planning',
    ]);
  });

  it('commits only the spec folder', async () => {
    writeFile(repo, 'src/unrelated.ts', 'x\n');
    fs.writeFileSync(path.join(repo, 'README.md'), 'changed\n');
    assert.strictEqual(await store.writeState('s', 'T01', 'planning'), true);
    const files = git(repo, 'show', '--name-only', '--format=', 'HEAD').trim().split('\n');
    assert.deepStrictEqual(files, ['.baiton/specs/s/spec.md']);
    const status = git(repo, 'status', '--porcelain');
    assert.ok(status.includes('README.md') && status.includes('src/'));
  });

  it('includes the note in the commit message', async () => {
    await store.writeState('s', 'T01', 'planning');
    await store.writeState('s', 'T01', 'failed', 'cancelled');
    assert.strictEqual(subjects(1)[0], 'spec(s): T01 failed (cancelled)');
  });

  it('returns false without committing for unchanged or unknown targets', async () => {
    const head = git(repo, 'rev-parse', 'HEAD');
    assert.strictEqual(await store.writeState('s', 'T01', 'pending'), false);
    assert.strictEqual(await store.writeState('s', 'T99', 'planning'), false);
    assert.strictEqual(git(repo, 'rev-parse', 'HEAD'), head);
  });

  it('persistArtifact serializes with state and is swept by the next state commit', async () => {
    const plan = path.join(specsDir, 's', 'todos', 'T01', 'plan.md');
    await Promise.all([
      store.persistArtifact!('s', plan, '# Plan T01\n'),
      store.writeState('s', 'T02', 'planning'),
    ]);
    await store.writeState('s', 'T01', 'planning');
    assert.strictEqual(fs.readFileSync(plan, 'utf8'), '# Plan T01\n');
    assert.ok(git(repo, 'ls-files').includes('.baiton/specs/s/todos/T01/plan.md'));
    assert.strictEqual(await store.readArtifact('s', 'T01', 'plan'), '# Plan T01\n');
  });

  it('latestExecuteCommit and plan Input_Rev read per-todo journals', async () => {
    const file = todoJournalPathFor(specsDir, 's', 'T01');
    appendStart(file, {
      runId: 'r-plan',
      todoId: 'T01',
      stage: 'plan',
      attempt: 1,
      startHead: 'h',
      inputRev: 'stale-rev',
    });
    appendStart(file, {
      runId: 'r-exec',
      todoId: 'T01',
      stage: 'execute',
      attempt: 1,
      startHead: 'h',
      inputRev: 'stale-rev',
    });
    appendCompletion(file, { runId: 'r-exec', result: 'completed', commit: 'abc123' });
    assert.strictEqual(await store.latestExecuteCommit('s', 'T01'), 'abc123');
    assert.strictEqual(await store.inputRevMatches('s', 'T01'), false);
    assert.strictEqual(await store.latestExecuteCommit('s', 'T02'), undefined);
  });
});
