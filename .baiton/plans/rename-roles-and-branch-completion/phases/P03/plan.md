# Plan P03

## Steps

1. Diagnosis (read before editing): the record commit is made after the only push

   In src/engine/submitPr.ts both record paths push and open/reuse the PR before they write the record. Owner path (`submitOwnerPr`): it commits `plan(<slug>): pr draft`, calls `deps.git.push(deps.remote, branch)` (~line 315), runs `findOpenByHead`/`create`, and only then (~lines 336-342) writes `pr:`/`status: pr` and calls `deps.git.commit(`plan(${slug}): pr`)`. Nothing pushes after that commit, so the record exists only locally. The PR head on the remote stops at `pr draft`, and the merged base keeps `status: approved`. Grouped path (`submitGroupedPr` -> `recordGroupedPr`, ~lines 497-583): the owner repo is pushed in the per-repo loop and the `plan(<slug>): pr` / `pr (partial)` commit is made afterwards in `recordGroupedPr`, with the same result. A second problem: `GitService.commit` runs `git add -A && git commit`, which rejects when nothing changed. If a record push fails and the user submits again, re-recording identical frontmatter would throw 'nothing to commit', and the plan could never recover. The fix therefore commits only when the document actually changed and always pushes afterwards. The record cannot simply come before the first push, because the PR URL is only known once `create`/`findOpenByHead` returns. Pushing the branch again after the record commit is the correct fix.

   Files: `src/engine/submitPr.ts`

2. Write the reproduction tests first (they must fail on the current code)

   In test/transitions.prStatus.test.ts add a new `describe('submitPr record step reaches the pushed branch', ...)` block. It drives `submitPr` through fake seams only, with no child_process and no real git. Build a small in-file harness:

   1. A temp dir (`fs.mkdtempSync(os.tmpdir()/baiton-prstatus-)`) used as `workspaceRoot`, with `baitonDir = <root>/.baiton`. Write an approved plan document at `<baitonDir>/plans/<slug>/plan.md`: frontmatter `status: approved`, `base: main`, `base_commit: base0`, `branch: baiton/<slug>`, `approved_rev: <approvalHash(parsePlan(draft))>`, `pr:`, and phases all `[done]`. Copy the `planText` shape from test/submitPr.test.ts and compute the hash with `approvalHash`/`parsePlan` the same way.
   2. `FakeGit`: an object cast to `GitService` (`as unknown as GitService`) that implements only what submitPr calls: `currentBranch` returns the branch; `isCleanExceptPlanFolder` returns true; `diff` returns 'diff'; `head` returns `c<n>`; `resetWorkingTree` returns `{ ok: true, value: undefined }`; `branchHead` returns 'child-tip' for child fakes; `resolveBaseCommit` returns 'base0'. `commit(message)` appends the message to `localLog` together with a snapshot of the plan document read with `fs.readFileSync(documentPath)`, and records `{op:'commit', message}` in a shared `calls` array. `push(remote, branch)` records `{op:'push', remote, branch}`, copies the latest local snapshot into `remoteDoc.get(branch)` and `localLog.length` into `remoteTipIndex`, and throws when a configurable `failPushAt` call number is reached. Add a `failCommitMatching` option (a regex on the message) that throws a `{command:'git commit', exitCode:1, stderr:'boom'}` GitError-shaped object.
   3. `FakePrTool` (as in test/submitPr.test.ts) returning a configurable URL, with `existing` and `failCreate`. Also copy the stub adapter/terminal host/watcher/watcher-factory classes and the `awaitWatcher` + `emitResult(JSON.stringify({title, body}))` helper.

   Tests:
   (a) Owner path happy case. After a successful submit, `remoteDoc.get(branch)` parses (via `parsePlan`) to `status: pr` and `pr: <url>`. The last commit on the remote is `plan(<slug>): pr`. `calls` shows commit `pr draft` < push < commit `plan(<slug>): pr` < push. The journal completion (`parseJournal(<baitonDir>/plans/<slug>/runs.jsonl)`) has `pr: {push:true, create:true, record:true}`. This test FAILS on current code (the remote copy says `approved`), which is the reproduction. Note that in a comment.
   (b) Owner path, second (record) push rejected. Result `{ok:false, error.kind:'record-failed'}`, the message contains the PR URL, and the journal has `record:false`. The local document still says `status: pr`.
   (c) Owner path, record commit rejected (`failCommitMatching: /: pr$/`). Result `record-failed` naming the URL, and no push follows the failed commit.
   (d) Owner path recovery. After (b), clear `failPushAt` and set `prTool.existing` to the recorded PR, so the re-submission reuses it. Call `submitPr` again (checkReady passes because `prsMerged` is not injected) and deliver a draft. Result `ok`. No new `plan(<slug>): pr` commit is made, because the document is unchanged (assert the `commit` calls). The remote doc now says `status: pr`. This guards the 'nothing to commit' trap.
   (e) Grouped owner+child path. Supply `phaseTarget` (P01 -> owner `{name:'.', isOwner:true, git: ownerFake}`, P02 -> child `{name:'packages/api', isOwner:false, git: childFake}`) and `repoSettings` -> `{ok:true, value:{remote:'origin', base:'main', pr: childPr}}`. On success the owner fake's remote doc says `status: pr` with `prs:` holding both URLs. The final owner op is a push of `baiton/<slug>` after the `plan(<slug>): pr` commit.
   (f) Grouped partial. With `childPr.failCreate = true` the result is `error.kind === 'partial'`, and the owner remote doc says `status: pr-partial`, its last remote commit being `plan(<slug>): pr (partial)`. Retry with `failCreate = false`: owner `findOpenByHead`/`create` are NOT called again, which preserves the retry-only-failed-repos behaviour. The owner gets exactly one more push (the record push). The owner remote doc says `status: pr`.
   (g) Grouped record push failure. Make the owner record push throw. Result `record-failed` naming the primary URL. The journal `record:false`.
   (h) Child-only plan (P01 -> child). No push of the owner fake happens at all, and the result is ok. There is no owner PR, so there is nothing to carry the record.

   Keep the existing pure-helper tests in the file unchanged. Run `npx mocha` (or the repo's test script, see package.json) on this file and confirm (a), (e) and (f) fail before the fix. Mention that outcome in the execution summary.

   Files: `test/transitions.prStatus.test.ts`

3. Add a shared record helper in submitPr.ts that commits-if-changed then pushes

   In src/engine/submitPr.ts add a private, doc-commented helper near `recordGroupedPr`:

   ```ts
   /**
    * Write the PR record into the plan document, commit it when the document
    * changed, then push the owner branch so the record reaches the PR head.
    * Rejects on any read, write, commit or push failure; callers map that to
    * `record-failed`. An unchanged document (a retry after a failed record push)
    * skips the commit but still pushes.
    */
   async function writeAndPushRecord(
     deps: SubmitPrDeps,
     documentPath: string,
     update: (content: string) => string,
     message: string,
     push: { remote: string; branch: string } | undefined,
   ): Promise<void> {
     const before = await fsp.readFile(documentPath, 'utf8');
     const after = update(before);
     if (after !== before) {
       await fsp.writeFile(documentPath, after, 'utf8');
       await deps.git.commit(message);
     }
     if (push !== undefined) await deps.git.push(push.remote, push.branch);
   }
   ```

   Update the file's top-of-file doc comment, step 4, to say that after creating or reusing the PRs the owner records `pr`/`pr-partial` in a `plan(<slug>): pr` commit and pushes its branch again, so the record lands on the PR head.

   Files: `src/engine/submitPr.ts`

4. Fix the owner path record block

   In `submitOwnerPr`, replace the try body at ~lines 336-342 with:

   ```ts
   await writeAndPushRecord(
     deps, documentPath,
     (c) => setFrontmatterKey(setFrontmatterKey(c, 'pr', pr.url), 'status', 'pr'),
     `plan(${slug}): pr`,
     { remote: deps.remote, branch },
   );
   steps.record = true;
   ```

   Keep the catch: `complete(); return fail({ kind: 'record-failed', message: `pull request ${pr.url} exists but recording it on ${branch} failed: ${errorMessage(e)}` })`. The URL must stay in the message. `steps.record` becomes true only after the push resolves. Do not touch the first push, the create/reuse logic, or `checkReady`.

   Files: `src/engine/submitPr.ts`

5. Fix the grouped path record block (recordGroupedPr)

   In `recordGroupedPr` (~lines 574-588), replace the read/set/write/commit sequence with a `writeAndPushRecord` call. Keep the same update function: set `pr` to primary's URL; when `touchedNames.length > 1`, set `prs` to `formatPrsValue(orderedPrs ?? prs.map(...))`; set `status` to the status. Keep the same message: `pr (partial)` vs `pr`. Pass `push` as `{ remote: deps.remote, branch: owner.branch }` when `const owner = prs.find((p) => p.isOwner)` is defined, else `undefined`. The plan document lives in the owner repo (deps.git), so only an owner PR can carry it. A child-only plan keeps today's local-only record and pushes nothing new to the owner remote. Using `prs.find(isOwner)` also covers a pr-partial retry where the owner PR was recorded earlier and is not re-submitted: the owner branch is pushed once more (record only), and `findOpenByHead`/`create` are not re-run for it. Both callers reach this, including the `prepared.length === 0` call, which passes no `steps`. Keep `if (steps !== undefined) steps.record = true;` after the helper resolves. The catch stays `record-failed` with `pull request ${primary.pr.url} exists but recording it failed: ...` (add ` on ${owner.branch}` when an owner exists, optional). Leave `planPrStatus`, the partial-result return, `reposToSubmit`, and the per-repo push/create loop unchanged.

   Files: `src/engine/submitPr.ts`

6. Adjust the existing real-git tests the fix intentionally changes, and add remote assertions

   These files are outside the phase's listed files. The fix's extra record push breaks one assertion, so they must be touched minimally.
   - test/submitPr.multiRepo.test.ts, 'records a partial result and retry submits only the failed child repo' (~line 355): change `assert.strictEqual(h.world.ownerPushes(), ownerPushes)` to `ownerPushes + 1`, with a comment that the one extra push carries the `pr` record and is not a resubmission. The `ownerPr.created`/`lookedUp` assertions stay as they are and still prove that only the failed repo is resubmitted. In the first test ('uses one writer draft...') add: `git(h.world.owner.remote, 'show', `${BRANCH}:.baiton/plans/${SLUG}/plan.md`)` parses to `status: pr`. In the partial test, after the first submit, the owner remote copy says `pr-partial`.
   - test/submitPr.test.ts, 'drafts, pushes, creates the PR, records it and journals each step': add `git(h.repo.remote, 'log', '-1', '--format=%s', BRANCH)` === `plan(greeting): pr`, and the remote's `.baiton/specs/greeting/spec.md` (via `git show`) parses to `status: pr` with the PR URL. The journal assertion `{push:true, create:true, record:true}` stays. The push-failed test is unchanged: the first push still fails with `push-failed` and record:false.
   If any other test counts pushes or asserts the remote tip, update it the same way. Grep `test/` for `ownerPushes`, `push(` counters and `branch', '--list'`.

   Files: `test/submitPr.multiRepo.test.ts`, `test/submitPr.test.ts`

7. Verify

   Run the TypeScript build/typecheck (`npm run compile` or `npx tsc --noEmit -p .`, per package.json) and the test suite, at least `test/transitions.prStatus.test.ts`, `test/submitPr.test.ts`, `test/submitPr.multiRepo.test.ts` and `test/journal*`. Confirm the new reproduction tests fail on the pre-fix code (recorded in the summary) and pass after it. Confirm the lint script passes, if one exists.

   Files: (none)

## Risks

- The phase's file hint lists only src/engine/submitPr.ts and test/transitions.prStatus.test.ts. The extra record push necessarily breaks the `ownerPushes` equality in test/submitPr.multiRepo.test.ts, so that test (and an optional remote assertion in test/submitPr.test.ts) must be touched. Keep those edits minimal and justified.
- Re-submission after a failed record push: `GitService.commit` rejects on 'nothing to commit'. Without the commit-only-if-changed guard, a retry would loop on record-failed. The guard is required, and test (d) covers it.
- Child-only plans: the document lives on the owner branch, but no owner PR exists. Pushing there would create an unexpected remote branch, so the plan pushes only when an owner PR is recorded. The record does not reach any remote for child-only plans, which is acceptable because no PR merges the owner branch.
- The fake GitService is a partial object cast to GitService. If submitPr starts calling another method, the fake throws 'not a function'. Have the fake throw a clear error for any unexpected method, for example via a Proxy.
- The second push uses `push --set-upstream`, which is idempotent. A remote that rejects it (for example, the branch was force-updated) now surfaces as record-failed instead of a silent ok. This is intended, but the user-visible behaviour changes.
- Do not alter checkReady refusals (done, stale approval, unlanded, merged PRs) or the order of push/create. Only the record block changes.

## Acceptance

- After a successful owner-only Submit PR, the remote branch's tip commit is `plan(<slug>): pr`, and its copy of the plan document reads `status: pr` with the `pr:` URL (asserted with the fake git in test/transitions.prStatus.test.ts and against the bare remote in test/submitPr.test.ts).
- After a successful multi-repo Submit PR, the owner remote branch's plan document reads `status: pr` with `pr:` and `prs:`. After a partial submit it reads `status: pr-partial`, with remote tip `plan(<slug>): pr (partial)`.
- The pr-partial retry still calls the owner PR tool's `findOpenByHead`/`create` zero additional times and resubmits only the failed repos. The owner gets exactly one extra push, for the record.
- A failed record commit or record push returns `{ok:false, error:{kind:'record-failed'}}` whose message contains the PR URL. The journal completion has `pr.record === false`. `record === true` only when the record push resolved.
- Re-submitting after a failed record push succeeds without creating an empty commit and pushes the record.
- A child-only plan never pushes the owner branch.
- The new reproduction tests fail on the pre-fix code and pass after it. The existing submitPr, multi-repo, journal and transitions tests pass, with only the documented `ownerPushes + 1` adjustment. The typecheck is clean.
