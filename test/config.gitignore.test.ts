import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GITIGNORE_CONTENTS, refreshGitignore } from '../src/config/gitignore';

/**
 * Unit tests for `refreshGitignore`, the activation-time step that keeps a
 * workspace's `.baiton/.gitignore` in sync with the canonical exclusion list
 * after the extension is upgraded.
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
});
