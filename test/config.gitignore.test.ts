import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  GITIGNORE_CONTENTS,
  RETIRED_GITIGNORE_LINES,
  mergeGitignore,
  refreshGitignore,
} from '../src/config/gitignore';

/**
 * Unit tests for `refreshGitignore`, the activation-time step that keeps a
 * workspace's `.baiton/.gitignore` in sync with the canonical exclusion list
 * after the extension is upgraded, and for `GITIGNORE_CONTENTS` itself —
 * including the `/config.local.json`, atomic temp-file, and `/worktrees/`
 * patterns, without which private config or run worktrees could make `git
 * status` dirty.
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

  it('preserves user patterns when refreshing the canonical block', async () => {
    const target = path.join(dir, '.gitignore');
    fs.writeFileSync(target, `${GITIGNORE_CONTENTS}\n.claude/\n.env\n`, 'utf8');

    await refreshGitignore(dir);

    const refreshed = fs.readFileSync(target, 'utf8');
    assert.ok(refreshed.includes('.claude/'));
    assert.ok(refreshed.includes('.env'));
  });

  it('does not rewrite a canonical block with user patterns', async () => {
    const target = path.join(dir, '.gitignore');
    const contents = `${GITIGNORE_CONTENTS}\n.claude/\n.env\n`;
    fs.writeFileSync(target, contents, 'utf8');
    const before = fs.statSync(target).mtimeMs;

    assert.strictEqual(await refreshGitignore(dir), 'unchanged');
    assert.strictEqual(fs.statSync(target).mtimeMs, before);
    assert.strictEqual(fs.readFileSync(target, 'utf8'), contents);
  });

  it('adds missing canonical patterns while keeping user patterns', async () => {
    const target = path.join(dir, '.gitignore');
    const stale = GITIGNORE_CONTENTS.split('\n')
      .filter((line) => line !== '/worktrees/')
      .join('\n');
    fs.writeFileSync(target, `${stale}\n.claude/\n.env\n`, 'utf8');

    assert.strictEqual(await refreshGitignore(dir), 'rewritten');
    assert.strictEqual(
      fs.readFileSync(target, 'utf8'),
      `${GITIGNORE_CONTENTS}\n.claude/\n.env\n`,
    );
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

  it('rewrites a .gitignore from a build without the config.local.json patterns', async () => {
    const target = path.join(dir, '.gitignore');
    const stale = GITIGNORE_CONTENTS.split('\n')
      .filter((line) => line !== '/config.local.json' && line !== '/.config*json.*.tmp')
      .join('\n');
    assert.notStrictEqual(stale, GITIGNORE_CONTENTS);
    fs.writeFileSync(target, stale, 'utf8');

    assert.strictEqual(await refreshGitignore(dir), 'rewritten');
    assert.strictEqual(fs.readFileSync(target, 'utf8'), GITIGNORE_CONTENTS);
  });
});

describe('mergeGitignore', () => {
  it('returns the canonical block for a missing file', () => {
    assert.strictEqual(mergeGitignore(undefined), GITIGNORE_CONTENTS);
  });

  it('leaves a canonical block followed by user lines unchanged', () => {
    const contents = `${GITIGNORE_CONTENTS}\n.claude/\n.env\n.env.*\n!.env.example\n`;
    assert.strictEqual(mergeGitignore(contents), contents);
  });

  it('adds missing canonical patterns and keeps user lines in order', () => {
    const stale = GITIGNORE_CONTENTS.split('\n')
      .filter((line) => line !== '/worktrees/')
      .join('\n');
    assert.strictEqual(
      mergeGitignore(`${stale}\n.claude/\n.env\n`),
      `${GITIGNORE_CONTENTS}\n.claude/\n.env\n`,
    );
  });

  it('moves user lines after the canonical block and removes duplicate canonical lines', () => {
    const withDuplicate = GITIGNORE_CONTENTS.replace(
      '/runs/',
      '/runs/\n/runs/\n.middle/',
    );
    assert.strictEqual(
      mergeGitignore(`.first/\n${withDuplicate}/.lock\n.last/\n`),
      `${GITIGNORE_CONTENTS}\n.first/\n.middle/\n.last/\n`,
    );
  });

  it('normalizes CRLF input to LF', () => {
    const current = `.claude/\r\n${GITIGNORE_CONTENTS.replace(/\n/g, '\r\n')}`;
    assert.strictEqual(
      mergeGitignore(current),
      `${GITIGNORE_CONTENTS}\n.claude/\n`,
    );
  });

  it('is idempotent for representative inputs', () => {
    const inputs = [
      undefined,
      '',
      '/.lock\n/chat/*\n/runs/\n',
      `${GITIGNORE_CONTENTS}\n.claude/\n.env\n`,
      '\n# local\n\n.env\n\n',
    ];
    for (const input of inputs) {
      const merged = mergeGitignore(input);
      assert.strictEqual(mergeGitignore(merged), merged);
    }
  });

  it('preserves user comments and interior blank lines, trimming edge blanks', () => {
    const userLines = '\n\n# User comment  \n\n.env\n\n# Another comment\n\n';
    assert.strictEqual(
      mergeGitignore(userLines),
      `${GITIGNORE_CONTENTS}\n# User comment  \n\n.env\n\n# Another comment\n`,
    );
  });

  it('does not list a canonical line as retired', () => {
    const canonical = new Set(GITIGNORE_CONTENTS.split('\n'));
    for (const line of RETIRED_GITIGNORE_LINES) {
      assert.ok(!canonical.has(line), `${line} must not be both canonical and retired`);
    }
  });
});

describe('GITIGNORE_CONTENTS', () => {
  const lines = GITIGNORE_CONTENTS.split('\n');
  const patterns = lines.filter((line) => line.length > 0 && !line.startsWith('#'));

  it('ignores the run worktrees directory, anchored at the .baiton root', () => {
    assert.strictEqual(lines.filter((line) => line === '/worktrees/').length, 1);
  });

  it('ignores the personal config overlay, anchored at the .baiton root', () => {
    assert.strictEqual(lines.filter((line) => line === '/config.local.json').length, 1);
    assert.ok(!patterns.includes('config.json'));
    assert.ok(!patterns.includes('/config.json'));
  });

  it('ignores the atomic config temp files', () => {
    assert.strictEqual(lines.filter((line) => line === '/.config*json.*.tmp').length, 1);
  });

  it('lists the config patterns after /.lock and before /chat.jsonl', () => {
    const lockIndex = lines.indexOf('/.lock');
    const localIndex = lines.indexOf('/config.local.json');
    const tempIndex = lines.indexOf('/.config*json.*.tmp');
    const chatIndex = lines.indexOf('/chat.jsonl');
    assert.strictEqual(localIndex, lockIndex + 1);
    assert.strictEqual(tempIndex, localIndex + 1);
    assert.ok(localIndex < chatIndex);
    assert.ok(tempIndex < chatIndex);
  });

  it('lists /worktrees/ after /runs/', () => {
    assert.ok(lines.indexOf('/worktrees/') > lines.indexOf('/runs/'));
  });

  it('ignores plan chat sessions and plan journals while keeping legacy patterns', () => {
    assert.ok(patterns.includes('plans/*/chat/'));
    assert.ok(patterns.includes('plans/*/runs.jsonl'));
    assert.ok(patterns.includes('specs/*/chat.jsonl'));
    assert.ok(patterns.includes('specs/*/chat/'));
    assert.ok(patterns.includes('specs/*/runs.jsonl'));
  });

  it('has no duplicate patterns', () => {
    assert.deepStrictEqual(patterns, [...new Set(patterns)]);
  });

  it('ends with a single trailing newline', () => {
    assert.ok(GITIGNORE_CONTENTS.endsWith('\n'));
    assert.ok(!GITIGNORE_CONTENTS.endsWith('\n\n'));
  });
});
