import * as assert from 'assert';
import {
  createPrTool,
  describeRepoPrs,
  formatPrsValue,
  parseGhPrState,
  parseGlabMrState,
  parsePrsValue,
  parsePrUrl,
} from '../src/engine/prTool';
import { prContext } from '../src/engine/submitPr';
import { locationFor } from '../src/storage/documentLocation';

describe('per-repo PR helpers', () => {
  it('round-trips a single-line prs JSON object and tolerates malformed values', () => {
    const formatted = formatPrsValue([
      { repo: '.', url: 'https://example.test/root/pull/1' },
      { repo: 'packages/api', url: 'https://example.test/api/pull/2' },
    ]);
    assert.strictEqual(formatted, '{".":"https://example.test/root/pull/1","packages/api":"https://example.test/api/pull/2"}');
    assert.deepStrictEqual([...parsePrsValue(formatted)], [
      ['.', 'https://example.test/root/pull/1'],
      ['packages/api', 'https://example.test/api/pull/2'],
    ]);
    assert.deepStrictEqual([...parsePrsValue('{"ok":"url","skip":1}')], [['ok', 'url']]);
    assert.deepStrictEqual([...parsePrsValue('{garbage')], []);
    assert.deepStrictEqual([...parsePrsValue(undefined)], []);
  });

  it('describes each PR and failure on a separate line, naming the root repo', () => {
    assert.strictEqual(describeRepoPrs(
      [
        { repo: '.', pr: { url: 'https://example.test/pull/1' }, reused: true },
        { repo: 'packages/api', pr: { url: 'https://example.test/pull/2' }, reused: false },
      ],
      [{ repo: 'packages/web', message: 'provider rejected it' }],
    ), [
      '(root): https://example.test/pull/1 (reused)',
      'packages/api: https://example.test/pull/2',
      'packages/web: failed — provider rejected it',
    ].join('\n'));
  });

  it('keeps the owner-only pr-writer context text byte-identical', () => {
    const location = locationFor('/workspace/.baiton', 'demo', 'plan');
    assert.strictEqual(prContext({
      location,
      diffPath: '/workspace/.baiton/runs/demo/diff.patch',
      base: 'main',
      branch: 'baiton/demo',
      repos: [{ repo: '.', diffPath: '/workspace/.baiton/runs/demo/diff.patch', base: 'main', branch: 'baiton/demo' }],
    }), [
      'The plan document is `/workspace/.baiton/plans/demo/plan.md`; its preamble and phase list describe the work.',
      "Each phase's plan and execution summaries live in its own folder: `/workspace/.baiton/plans/demo/phases/<phase-id>/plan.md` and `execute-<n>.md` beside it.",
      'The cumulative diff of branch `baiton/demo` against base `main` is at `/workspace/.baiton/runs/demo/diff.patch`.',
      'Draft the pull request from these; the extension pushes the branch and opens the PR itself.',
    ].join('\n\n'));
  });
});

describe('request state by URL', () => {
  it('parses supported request URLs and rejects other shapes', () => {
    assert.deepStrictEqual(parsePrUrl('https://github.com/o/r/pull/12'), {
      kind: 'gh', host: 'github.com', repoPath: 'o/r', number: 12,
    });
    assert.deepStrictEqual(parsePrUrl(' https://github.com/o/r/pull/12/ '), {
      kind: 'gh', host: 'github.com', repoPath: 'o/r', number: 12,
    });
    assert.deepStrictEqual(parsePrUrl('https://gitlab.com/g/sub/p/-/merge_requests/7'), {
      kind: 'glab', host: 'gitlab.com', repoPath: 'g/sub/p', number: 7,
    });
    assert.deepStrictEqual(parsePrUrl('https://git.example:8443/g/p/-/merge_requests/3'), {
      kind: 'glab', host: 'git.example:8443', repoPath: 'g/p', number: 3,
    });
    for (const url of [
      '',
      'not a url',
      'https://github.com/o/r/issues/1',
      'https://github.com/o/r/pull/abc',
      'https://github.com/o/r/pull/',
      'https://gitlab.com/-/merge_requests/1',
      'ssh://git@github.com/o/r/pull/1',
    ]) {
      assert.strictEqual(parsePrUrl(url), undefined, url);
    }
  });

  it('parses GitHub state output defensively', () => {
    assert.strictEqual(parseGhPrState('{"state":"OPEN"}'), 'open');
    assert.strictEqual(parseGhPrState('{"state":"MERGED"}'), 'merged');
    assert.strictEqual(parseGhPrState('{"state":"CLOSED"}'), 'closed');
    for (const output of ['{"state":"DRAFT"}', '', 'garbage', '[]', '{}', '{"state":1}']) {
      assert.strictEqual(parseGhPrState(output), 'unknown', output);
    }
  });

  it('parses GitLab state output defensively', () => {
    assert.strictEqual(parseGlabMrState('{"state":"opened"}'), 'open');
    assert.strictEqual(parseGlabMrState('{"state":"merged"}'), 'merged');
    assert.strictEqual(parseGlabMrState('{"state":"closed"}'), 'closed');
    assert.strictEqual(parseGlabMrState('{"state":"locked"}'), 'closed');
    for (const output of ['{"state":"weird"}', '', 'garbage']) {
      assert.strictEqual(parseGlabMrState(output), 'unknown', output);
    }
  });

  it('uses the expected GitHub CLI arguments and execution context', async () => {
    const calls: string[][] = [];
    let executable = '';
    let cwd = '';
    const tool = createPrTool({
      kind: 'gh',
      executable: '/bin/gh',
      repoRoot: '/repo',
      run: async (exe, args, workingDirectory) => {
        executable = exe;
        cwd = workingDirectory;
        calls.push(args);
        return '{"state":"MERGED"}';
      },
    });
    assert.strictEqual(await tool.stateByUrl!('https://github.com/o/r/pull/12'), 'merged');
    assert.strictEqual(executable, '/bin/gh');
    assert.strictEqual(cwd, '/repo');
    assert.deepStrictEqual(calls[0], ['pr', 'view', '12', '--repo', 'github.com/o/r', '--json', 'state']);
  });

  it('uses the expected GitLab CLI arguments', async () => {
    const calls: string[][] = [];
    const tool = createPrTool({
      kind: 'glab',
      executable: '/bin/glab',
      repoRoot: '/repo',
      run: async (_exe, args) => {
        calls.push(args);
        return '{"iid":7,"state":"opened"}';
      },
    });
    assert.strictEqual(await tool.stateByUrl!('https://gitlab.com/g/sub/p/-/merge_requests/7'), 'open');
    assert.deepStrictEqual(calls[0], ['mr', 'view', '7', '--repo', 'g/sub/p', '--output', 'json']);
  });

  it('maps CLI failures and malformed output to unknown', async () => {
    const failedTool = createPrTool({
      kind: 'gh',
      executable: '/bin/gh',
      repoRoot: '/repo',
      run: async () => Promise.reject({ command: 'gh pr view', exitCode: 1, stderr: 'offline' }),
    });
    assert.strictEqual(await failedTool.stateByUrl!('https://github.com/o/r/pull/12'), 'unknown');

    const malformedTool = createPrTool({
      kind: 'gh',
      executable: '/bin/gh',
      repoRoot: '/repo',
      run: async () => 'not json',
    });
    assert.strictEqual(await malformedTool.stateByUrl!('https://github.com/o/r/pull/12'), 'unknown');
  });

  it('does not invoke a CLI for malformed or wrong-provider URLs', async () => {
    const calls: string[][] = [];
    const run = async (_exe: string, args: string[]): Promise<string> => {
      calls.push(args);
      return '{"state":"open"}';
    };
    const ghTool = createPrTool({ kind: 'gh', executable: '/bin/gh', repoRoot: '/repo', run });
    assert.strictEqual(await ghTool.stateByUrl!('nope'), 'unknown');
    assert.strictEqual(await ghTool.stateByUrl!('https://gitlab.com/g/p/-/merge_requests/1'), 'unknown');
    assert.strictEqual(calls.length, 0);

    const glabTool = createPrTool({ kind: 'glab', executable: '/bin/glab', repoRoot: '/repo', run });
    assert.strictEqual(await glabTool.stateByUrl!('https://github.com/o/r/pull/1'), 'unknown');
    assert.strictEqual(calls.length, 0);
  });
});
