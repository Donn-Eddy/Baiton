import * as assert from 'assert';
import { describeRepoPrs, formatPrsValue, parsePrsValue } from '../src/engine/prTool';
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
