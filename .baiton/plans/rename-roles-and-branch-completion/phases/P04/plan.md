# Plan P04

## Steps

1. Declare isAncestor and fetchBranch on GitWorktreeService

   In src/git/types.ts add two members to the `GitWorktreeService` interface, not the base `GitService`. The registry (`GitServiceRegistry.forRepo`) already returns `GitWorktreeService`, and that is what P05's `branchMergedForPlan` in commands.ts will use. The base `GitService` is implemented by about a dozen object-literal fakes in test/ that would all stop compiling.

   1) `isAncestor(ancestor: string, descendant: string): Promise<boolean>;` Doc comment: backed by `git merge-base --is-ancestor <ancestor> <descendant>`. Resolves true on exit 0 and false on exit 1. Rejects with a GitError on any other exit (for example 128 for an unknown ref, or a non-repo directory) and when the process does not exit normally (exitCode undefined, for example a missing git CLI). A commit counts as its own ancestor, so callers that need 'strictly ahead' must compare shas themselves. Also say that it rejects a ref beginning with '-'.

   2) `fetchBranch(remote: string, branch: string): Promise<void>;` Doc comment: fetches one branch from `remote` and force-updates its remote-tracking ref with the explicit refspec `+refs/heads/<branch>:refs/remotes/<remote>/<branch>`, so a merge done only on the remote becomes visible as `<remote>/<branch>` without fetching every ref. Rejects with a GitError on a non-zero exit, for example when the remote or the branch is missing or the network fails.

   Also update the `GitWorktreeService` interface doc paragraph so it lists `isAncestor` among the reads that reject on an unexpected exit, noting that exit 1 is a normal false.

   Files: `src/git/types.ts`

2. Make the git process runner injectable

   In src/git/gitService.ts, export the run seam so the new methods can be unit-tested against a fake runner instead of real git or child_process. Export the existing `GitRun` interface, with a doc comment. Add `export type GitRunner = (args: readonly string[], cwd: string) => Promise<GitRun>;` with a doc comment saying it never rejects and reports a non-normal exit as exitCode undefined.

   Move the body of the private `run` method into a module-level `export const execFileGitRunner: GitRunner` (or a function). It keeps the same execFile call, the same cwd and maxBuffer 64 MiB options, and the same exitCode derivation.

   Change the signature to `createGitService(repoRoot: string, runner: GitRunner = execFileGitRunner): GitWorktreeService` and update its doc comment. Pass the runner into `ShellGitService`'s constructor (`constructor(private readonly repoRoot: string, private readonly runner: GitRunner)`). The private `run(args)` becomes `return this.runner(args, this.repoRoot)`. `runOrThrow` and `toGitError` should take `readonly string[]` or spread a copy as needed.

   `createGitServiceRegistry`'s default factory stays `createGitService`. Because the registry calls `factory(normalizedRoot)` with one argument, the default runner applies. No call sites in src change.

   Files: `src/git/gitService.ts`

3. Implement isAncestor and fetchBranch in ShellGitService

   In src/git/gitService.ts add both methods to `ShellGitService`.

   `isAncestor(ancestor, descendant)`:
   - If either argument is empty or starts with '-', throw a GitError `{ command: 'git merge-base --is-ancestor', exitCode: undefined, stderr: 'invalid ref: <ref>' }`. This stops option injection, since merge-base takes no `--` separator before the commits.
   - Otherwise `const args = ['merge-base', '--is-ancestor', ancestor, descendant]; const r = await this.run(args);`.
   - Return true if `r.exitCode === 0` and false if `r.exitCode === 1`. Otherwise `throw toGitError(args, r)`.
   - Add a short comment explaining that exit 1 is git's 'not an ancestor' answer and not a fault.

   `fetchBranch(remote, branch)`:
   - Validate both the same way: non-empty and no leading '-'. Throw a GitError otherwise.
   - Then `await this.runOrThrow(['fetch', '--no-tags', remote, `+refs/heads/${branch}:refs/remotes/${remote}/${branch}`]);`.
   - Comment that the explicit refspec updates `<remote>/<branch>` whatever the remote's configured fetch refspec is. Leave the existing `fetch(remote)` untouched.

   Fix the misplaced doc comment above `push`. It currently reads 'Run git and reject with a GitError on any non-zero exit', so either correct it or leave it. Do not refactor anything else.

   Files: `src/git/gitService.ts`

4. Keep the full FakeGit in runPipeline.test.ts compiling

   test/runPipeline.test.ts has `class FakeGit implements GitWorktreeService`, and the build will fail without the new members. Add `isAncestor = boom('isAncestor');` and `fetchBranch = boom('fetchBranch');` next to the other `boom(...)` members. The pipeline must never call them.

   The other test fakes typed as `GitWorktreeService` use `as`/`as unknown as` casts or `Partial<>`. The ones typed as plain `GitService` need no change, because the new members are only on `GitWorktreeService`. Confirm this by running `npx tsc -p ./ --noEmit`. If any other fake fails to compile, add the two members as throwing or no-op stubs in the same style.

   Files: `test/runPipeline.test.ts`

5. Fake-runner unit tests for the exit-code mapping and the fetch arguments

   Create test/gitService.ancestry.test.ts (mocha plus assert, like the other tests). Build a fake `GitRunner` that records each `(args, cwd)` call and replies from a scripted queue or function of `GitRun` values. Use `createGitService('/repo', fake)`.

   Cases:
   (a) exitCode 0 resolves true, and the recorded args deep-equal `['merge-base','--is-ancestor','abc','origin/main']` with cwd equal to the repoRoot passed in.
   (b) exitCode 1 resolves false.
   (c) exitCode 128 with stderr 'fatal: Not a valid commit name' rejects with a GitError whose exitCode is 128, whose stderr is passed through, and whose command is 'git merge-base --is-ancestor abc origin/main'.
   (d) exitCode undefined (process failed to spawn) rejects.
   (e) A ref starting with '-' rejects and the runner is never called.
   (f) fetchBranch('origin','main') records exactly `['fetch','--no-tags','origin','+refs/heads/main:refs/remotes/origin/main']` and resolves on exit 0.
   (g) fetchBranch rejects with a GitError carrying exitCode and stderr on a non-zero exit, for example 128 "couldn't find remote ref".
   (h) fetchBranch with a '-'-prefixed remote or branch rejects without calling the runner.
   (i) An existing method still routes through the injected runner, for example `head()` returns the trimmed stdout, which proves the seam.

   Files: `test/gitService.ancestry.test.ts`

6. Real temp-repo coverage alongside the existing gitService tests

   In test/gitService.test.ts add a `describe('isAncestor and fetchBranch', ...)` that reuses `newRepo()` and the `git()` helper.

   isAncestor cases:
   - Create branch `feature` from main and commit on it. `isAncestor('main','feature')` is true and `isAncestor('feature','main')` is false.
   - After `git merge --no-ff feature` on main, `isAncestor('feature','main')` is true.
   - `isAncestor('main','main')` is true. This documents the self-ancestor case that P05 must guard against.
   - An unknown ref rejects.

   fetchBranch:
   - Create a bare 'remote' repo with `git init --bare` in a scratch dir and add it as `origin`. Push main, then make a new commit on main from a second clone, or by pushing a branch directly.
   - `fetchBranch('origin','main')` makes `branchHead('origin/main')` equal the remote's new tip.
   - `fetchBranch('origin','no-such-branch')` rejects.

   Clean up the scratch directories in afterEach, as the worktree block does. These complement the fake-runner tests and match the file's existing real-repo style.

   Files: `test/gitService.test.ts`

7. Verify

   Run `npx tsc -p ./ --noEmit`, `npx mocha test/gitService.test.ts test/gitService.ancestry.test.ts test/runPipeline.test.ts`, then the full `npm test` and `npm run lint`. Fix any noUnusedLocals or noUnusedParameters complaints, for example an unused cwd parameter in the fake runner (prefix it with _ or record it).

   Files: (none)

## Risks

- Adding the methods to the base GitService instead of GitWorktreeService would break type-checking of about 12 object-literal fakes in test/ (askWatcher.routing, runQueue.*, registry.*, etc.), because tsconfig includes test/**. Keep them on GitWorktreeService.
- Any other full `implements GitWorktreeService` fake that P04 did not spot fails to compile. Only test/runPipeline.test.ts was found, and the tsc run must confirm it.
- `git merge-base --is-ancestor` returns true when ancestor == descendant. This is documented and tested, but P05's caller must enforce 'strictly ahead of base_commit / differs from base tip' itself.
- Refactoring `run` into an injectable runner must keep the exact exitCode derivation (error.code number → code, error without numeric code → undefined, no error → 0). A regression here would change every existing git call. The existing real-repo gitService tests guard this.
- fetchBranch with the explicit `+` refspec force-updates the local remote-tracking ref. This is intended (it mirrors the default fetch refspec) and never touches local branches or the working tree.
- The real-repo fetchBranch test needs a local bare repo as the remote (no network). Keep it filesystem-only so CI stays offline.

## Acceptance

- src/git/types.ts: GitWorktreeService declares `isAncestor(ancestor: string, descendant: string): Promise<boolean>` and `fetchBranch(remote: string, branch: string): Promise<void>`, each with a doc comment describing the exit-code mapping and refspec.
- src/git/gitService.ts exports `GitRun`, `GitRunner` and a default execFile-backed runner. `createGitService(repoRoot, runner?)` uses the injected runner for every git invocation, and existing callers compile unchanged.
- isAncestor runs `git merge-base --is-ancestor <a> <b>`. It resolves true on exit 0 and false on exit 1, and rejects with a GitError (command, exitCode, stderr) on any other exit, including undefined.
- fetchBranch runs exactly `git fetch --no-tags <remote> +refs/heads/<branch>:refs/remotes/<remote>/<branch>` and rejects with a GitError on a non-zero exit.
- Both methods reject refs or remotes that are empty or start with '-', without spawning git.
- test/gitService.ancestry.test.ts covers exits 0, 1 and 128, undefined, the argv, the cwd and option-injection rejection using a fake runner. test/gitService.test.ts covers isAncestor and fetchBranch against a temp repo and a local bare remote.
- test/runPipeline.test.ts FakeGit implements the two new members as `boom(...)` stubs.
- `npx tsc -p ./ --noEmit`, `npm test` and `npm run lint` all pass.
- No other src file changes behaviour in this phase. The existing `fetch(remote)` and all other GitService methods are unchanged.
