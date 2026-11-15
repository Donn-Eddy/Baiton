import * as assert from 'assert';
import { createGitService, GitRun, GitRunner } from '../src/git/gitService';
import { GitError } from '../src/git/types';

interface RecordedCall {
  readonly args: readonly string[];
  readonly cwd: string;
}

function scriptedRunner(results: GitRun[]): { runner: GitRunner; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const runner: GitRunner = async (args, cwd) => {
    calls.push({ args: [...args], cwd });
    const result = results.shift();
    assert.ok(result, 'fake runner received an unexpected call');
    return result;
  };
  return { runner, calls };
}

describe('git service ancestry runner', () => {
  it('maps exit 0 to true and passes argv and cwd to the runner', async () => {
    const { runner, calls } = scriptedRunner([{ exitCode: 0, stdout: '', stderr: '' }]);
    const git = createGitService('/repo', runner);

    assert.strictEqual(await git.isAncestor('abc', 'origin/main'), true);
    assert.deepStrictEqual(calls, [
      { args: ['merge-base', '--is-ancestor', 'abc', 'origin/main'], cwd: '/repo' },
    ]);
  });

  it('maps exit 1 to false', async () => {
    const { runner } = scriptedRunner([{ exitCode: 1, stdout: '', stderr: '' }]);
    assert.strictEqual(await createGitService('/repo', runner).isAncestor('a', 'b'), false);
  });

  it('preserves the GitError details on another merge-base exit', async () => {
    const { runner } = scriptedRunner([
      { exitCode: 128, stdout: '', stderr: 'fatal: Not a valid commit name' },
    ]);
    const git = createGitService('/repo', runner);

    await assert.rejects(git.isAncestor('abc', 'origin/main'), (error: unknown) => {
      const gitError = error as GitError;
      assert.strictEqual(gitError.command, 'git merge-base --is-ancestor abc origin/main');
      assert.strictEqual(gitError.exitCode, 128);
      assert.strictEqual(gitError.stderr, 'fatal: Not a valid commit name');
      return true;
    });
  });

  it('rejects when the process did not exit normally', async () => {
    const { runner } = scriptedRunner([{ exitCode: undefined, stdout: '', stderr: 'spawn failed' }]);
    await assert.rejects(createGitService('/repo', runner).isAncestor('a', 'b'), (error: unknown) => {
      assert.strictEqual((error as GitError).exitCode, undefined);
      assert.strictEqual((error as GitError).stderr, 'spawn failed');
      return true;
    });
  });

  it('rejects empty or dash-prefixed refs without calling the runner', async () => {
    const { runner, calls } = scriptedRunner([]);
    const git = createGitService('/repo', runner);
    await assert.rejects(git.isAncestor('-option', 'main'));
    await assert.rejects(git.isAncestor('main', '-option'));
    await assert.rejects(git.isAncestor('', 'main'));
    await assert.rejects(git.isAncestor('main', ''));
    assert.deepStrictEqual(calls, []);
  });

  it('fetches one branch with the explicit force refspec', async () => {
    const { runner, calls } = scriptedRunner([{ exitCode: 0, stdout: '', stderr: '' }]);
    await createGitService('/repo', runner).fetchBranch('origin', 'main');
    assert.deepStrictEqual(calls, [
      {
        args: ['fetch', '--no-tags', 'origin', '+refs/heads/main:refs/remotes/origin/main'],
        cwd: '/repo',
      },
    ]);
  });

  it('preserves fetch failure details in a GitError', async () => {
    const { runner } = scriptedRunner([
      { exitCode: 128, stdout: '', stderr: "couldn't find remote ref" },
    ]);
    await assert.rejects(createGitService('/repo', runner).fetchBranch('origin', 'main'), (error: unknown) => {
      const gitError = error as GitError;
      assert.strictEqual(gitError.exitCode, 128);
      assert.strictEqual(gitError.stderr, "couldn't find remote ref");
      assert.strictEqual(
        gitError.command,
        'git fetch --no-tags origin +refs/heads/main:refs/remotes/origin/main',
      );
      return true;
    });
  });

  it('rejects empty or dash-prefixed remote and branch without calling the runner', async () => {
    const { runner, calls } = scriptedRunner([]);
    const git = createGitService('/repo', runner);
    await assert.rejects(git.fetchBranch('-origin', 'main'));
    await assert.rejects(git.fetchBranch('origin', '-main'));
    await assert.rejects(git.fetchBranch('', 'main'));
    await assert.rejects(git.fetchBranch('origin', ''));
    assert.deepStrictEqual(calls, []);
  });

  it('routes existing methods through the injected runner', async () => {
    const { runner, calls } = scriptedRunner([
      { exitCode: 0, stdout: '  abc123\n', stderr: '' },
    ]);
    assert.strictEqual(await createGitService('/repo', runner).head(), 'abc123');
    assert.deepStrictEqual(calls, [
      { args: ['rev-parse', 'HEAD'], cwd: '/repo' },
    ]);
  });
});
