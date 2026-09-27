import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GITIGNORE_CONTENTS, refreshGitignore } from '../src/config/gitignore';

/**
 * Unit tests for `refreshGitignore`, the activation-time step that keeps a
 * workspace's `.baiton/.gitignore` in sync with the canonical exclusion list
 * after the extension is upgraded, and for `GITIGNORE_CONTENTS` itself —
 * including the `/worktrees/` pattern, without which every run worktree created
 * under `.baiton/worktrees/` would make `git status` dirty.
 */
describe('refreshGitignore', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-gitignore-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('rewrites a stale .gitignore left by an older build', async () => {
    const target = path.join(dir, '.gitignore');
    fs.writeFileSync(target, '/.lock\n/chat/*\n/runs/\n', 'utf8');

    assert.strictEqual(await refreshGitignore(dir), 'rewritten');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), GITIGNORE_CONTENTS);
  });

  it('leaves an up-to-date .gitignore untouched', async () => {
    const target = path.join(dir, '.gitignore');
    fs.writeFileSync(target, GITIGNORE_CONTENTS, 'utf8');
    const before = fs.statSync(target).mtimeMs;

    assert.strictEqual(await refreshGitignore(dir), 'unchanged');
    assert.strictEqual(fs.statSync(target).mtimeMs, before);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), GITIGNORE_CONTENTS);
  });

  it('creates a missing .gitignore inside an existing .baiton directory', async () => {
    assert.strictEqual(await refreshGitignore(dir), 'rewritten');
    assert.strictEqual(fs.readFileSync(path.join(dir, '.gitignore'), 'utf8'), GITIGNORE_CONTENTS);
  });

  it('does not scaffold an uninitialized folder', async () => {
    const missing = path.join(dir, 'nope', '.baiton');
    await assert.rejects(refreshGitignore(missing));
    assert.ok(!fs.existsSync(missing));
  });

  it('rewrites a .gitignore from a build without the /worktrees/ pattern', async () => {
    const target = path.join(dir, '.gitignore');
    // Derive the stale text from the constant so this test cannot drift from it.
    const stale = GITIGNORE_CONTENTS.split('\n')
      .filter((line) => line !== '/worktrees/')
      .join('\n');
    assert.notStrictEqual(stale, GITIGNORE_CONTENTS);
    fs.writeFileSync(target, stale, 'utf8');

    assert.strictEqual(await refreshGitignore(dir), 'rewritten');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), GITIGNORE_CONTENTS);
  });
});

describe('GITIGNORE_CONTENTS', () => {
  const lines = GITIGNORE_CONTENTS.split('\n');
  const patterns = lines.filter((line) => line.length > 0 && !line.startsWith('#'));

  it('ignores the run worktrees directory, anchored at the .baiton root', () => {
    assert.strictEqual(lines.filter((line) => line === '/worktrees/').length, 1);
  });

  it('lists /worktrees/ after /runs/', () => {
    assert.ok(lines.indexOf('/worktrees/') > lines.indexOf('/runs/'));
  });

  it('has no duplicate patterns', () => {
    assert.deepStrictEqual(patterns, [...new Set(patterns)]);
  });

  it('ends with a single trailing newline', () => {
    assert.ok(GITIGNORE_CONTENTS.endsWith('\n'));
    assert.ok(!GITIGNORE_CONTENTS.endsWith('\n\n'));
  });
});
