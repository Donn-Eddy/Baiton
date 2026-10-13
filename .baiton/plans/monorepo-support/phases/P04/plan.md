# Plan P04

## Steps

1. Add a per-repo lock map to the run queue module

   In src/engine/runQueue.ts, export a small lock map that replaces the single repository lock. It is already re-exported through `export * from './runQueue'` in src/engine/index.ts, so no index change is needed. Shape:

   ```ts
   /** Who holds a repo's one-stage lock. Phase queues never take it; they run in their own worktrees. */
   export type RepoLockHolder = 'plan-draft' | 'run-pipeline';
   /** A held lock. `release()` is idempotent. */
   export interface RepoLockLease { readonly repo: string; readonly holder: RepoLockHolder; release(): void; }
   /** One lock per repo, keyed by the repo's canonical root (`repoLockKey`). */
   export interface RepoLocks {
     /** Take `repo`'s lock, or return undefined when it is already held. Synchronous, so check-and-take cannot race. */
     tryAcquire(repo: string, holder: RepoLockHolder): RepoLockLease | undefined;
     isHeld(repo: string): boolean;
     holder(repo: string): RepoLockHolder | undefined;
     /** Keys of every held lock, in acquisition order. */
     heldRepos(): string[];
   }
   export function repoLockKey(root: string): string { return path.resolve(root); }
   export function createRepoLocks(): RepoLocks { /* Map<string, { holder, token: symbol }> */ }
   ```

   Implementation: `tryAcquire` normalizes `repo` with `repoLockKey`. If the key is present it returns undefined. Otherwise it stores `{ holder, token }`, where `token` is a fresh object or symbol, and returns a lease. The lease's `release()` deletes the entry only while the stored token is still its own, so a late or double release never frees a lock someone else has since taken. All the methods normalize keys the same way. Key by canonical root path rather than by repo name, so the engine does not import src/activation/repoDiscovery. Discovery already canonicalizes roots, so a parent repo and a child repo get distinct keys. `import * as path from 'path'` if the file does not already import it.

   Also in runQueue.ts, update the `isExternallyBusy` doc comment and the comment in `runOne()` (around line 576). They should say that the plan-draft and run-pipeline stages now take the per-repo lock (`RepoLocks`) and that the per-phase wiring still passes no `isExternallyBusy`. Keep the busy message text `'a stage is already running for this repository; try again after it finishes'` unchanged, because existing tests may match it.

   Files: `src/engine/runQueue.ts`

2. Plan-draft runner takes the lock of the repo it runs in

   In src/engine/planDraft.ts:
   - In `PlanDraftDeps`, make `isQueueRunning` optional (`isQueueRunning?(): boolean`) and keep its doc. Add `repoLocks?: RepoLocks` (import the type from './runQueue') with this doc: "The per-repo stage lock map, shared with the run pipeline. The draft takes the lock keyed by `workspaceRoot` for its whole lifetime."
   - In `DefaultPlanDraftRunner`, add `private lease: RepoLockLease | undefined`.
   - In `start()`, the slug check stays first. Replace the busy check with: refuse busy when `this.running || this.deps.isQueueRunning?.() === true`. Otherwise, when `repoLocks` is set, call `const lease = this.deps.repoLocks.tryAcquire(this.deps.workspaceRoot, 'plan-draft')`; if it returns undefined, refuse busy with the same message. Keep the lease in a local variable and release it on every refusal path after acquisition: duplicate-slug (both checks), unknown-agent, probe-failed and launch-failed. A small helper such as `const refuseHeld = (r) => { lease?.release(); return refuse(r); }` keeps this tidy. On a successful launch, set `this.running = true` and `this.lease = lease`.
   - In `awaitAndWrite`'s `finally`, after `this.running = false`, call `this.lease?.release(); this.lease = undefined;`.
   - Update the module header comment: the runner shares the one-stage-per-repo lock (keyed by its `workspaceRoot`) with the run pipeline, and drafts in unrelated repos do not block each other.

   Taking the lock before `adapter.probe()` closes the check-then-await race that exists today. Observable single-repo behaviour is otherwise unchanged: a draft still refuses while a plan-less run is in flight, and a run still refuses while a draft is in flight.

   Files: `src/engine/planDraft.ts`

3. Run pipeline takes the lock of the repo it runs in

   In src/engine/runPipeline.ts:
   - Add `repoLocks?: RepoLocks` to `RunPipelineDeps` (import the type from './runQueue'). Keep `isPlanBusy?` because existing tests use it.
   - Add `private lease: RepoLockLease | undefined` to `DefaultRunPipeline`.
   - In `start()`, step 2 refuses busy when `this.activeRunId !== undefined || this.deps.isPlanBusy?.() === true`. Otherwise, when `repoLocks` is set, call `tryAcquire(this.deps.workspaceRoot, 'run-pipeline')`; if it returns undefined, refuse busy with the existing message. Release the lease on every later refusal in `start()`: detached-head (both branches), no-base-head, manifest, and the worktree failure. On success, assign `this.lease = lease` next to `this.activeRunId = runId`.
   - In `drive()`'s `finally`, after clearing `activeRunId`/`stage`, call `this.lease?.release(); this.lease = undefined;`.
   - Rewrite the header paragraph "It holds the one-stage-per-repository lock from both sides …". It should say the pipeline takes the per-repo lock (`RepoLocks`) keyed by its `workspaceRoot`, shared with the plan-draft runner, and that phase queues never take it.

   Investigate runs take the lock too, exactly as they hold `activeRunId` today.

   Files: `src/engine/runPipeline.ts`

4. Key the phase-queue cache, isRunning and the run-queue seam by owning repo

   In src/activation/engineFacade.ts:

   1. Change `phaseQueueKey` to `export function phaseQueueKey(repo: string, slug: string, phaseId: string): string { return `${repoLockKey(repo)}\u0000${slug}/${phaseId}`; }`. `repo` is the owning repo's root, and the NUL separator cannot appear in a path or a slug. No test imports `phaseQueueKey`. Import `repoLockKey` and the `RepoLocks` types from '../engine'.

   2. Add a per-owner binding:
   ```ts
   /** Everything that differs per owning repo: plan state, journals and writes stay in its `.baiton/`. */
   export interface PhaseQueueOwner {
     workspaceRoot: string;
     baitonDir: string;
     git: GitWorktreeService;
     planWriter: PlanBranchWriter;
     planStore: RunQueueDeps['planStore'];
     worktrees?: QueueWorktreeSeam;
     targets?: PhaseTargetResolver;
   }
   ```
   Add `owners?: (repoRoot: string) => PhaseQueueOwner | undefined` to `PhaseQueuesDeps`, documented as resolving a non-default owning repo by root. The existing top-level `workspaceRoot`/`baitonDir`/`git`/`planWriter`/`planStore`/`worktrees`/`targets` deps form the DEFAULT owner, so every existing caller and test keeps compiling and behaving the same.

   3. Change the `PhaseQueues` interface. Keep the existing argument order so callers outside this phase's file list (test/integration.sub-agent-chats.test.ts, test/integration.plan-execute-review.test.ts) still compile and pass. The repo goes last and is optional:
   ```ts
   queueFor(slug: string, phaseId: string, repo?: string): RunQueue;   // repo = owning repo root; default owner when omitted
   find(slug: string, phaseId: string, repo?: string): RunQueue | undefined;
   running(): Array<LiveRun & { repo: string }>;   // repo = owning repo root (canonical)
   /** True when any queue of `repo` (any repo when omitted) and of `slug` (any slug when omitted) has a stage in flight. */
   isRunning(slug?: string, repo?: string): boolean;
   ```
   Record in the doc comment that this is the overview's `isRunning(repo, slug)`, with `repo` last for backward compatibility. With the repo omitted it matches every repo, which in a single-repo workspace is exactly today's behaviour and elsewhere refuses conservatively.

   4. In `createPhaseQueues`, resolve the default owner's root as `repoLockKey(deps.workspaceRoot)`. Cache entries become `{ repo, slug, queue }` keyed by `phaseQueueKey(repo, slug, phaseId)`. Build each owner's worktree seam lazily: either `owner.worktrees`, or `createQueueWorktreeSeam({ workspaceRoot: owner.workspaceRoot, git: owner.git, writer: owner.planWriter, ...(owner.targets ? { targets: owner.targets } : {}) })`. Cache the seam in a `Map<string, QueueWorktreeSeam>` keyed by repo, so all queues of one owner share one seam as they do today. `queueFor` with a repo other than the default resolves `deps.owners?.(repo)`; when that is undefined it throws `new Error(`unknown owning repo "${repo}"`)`. A new queue is built with `createRunQueue({ ...rest, workspaceRoot: owner.workspaceRoot, git: owner.git, planStore: owner.planStore, slug, phaseId, worktrees: seam, planWriter: owner.planWriter, journalPath: planJournalPathFor(owner.baitonDir, slug), journalPathFor: (id) => phaseJournalPathFor(owner.baitonDir, slug, id), readJournal: () => readPlanJournal(owner.baitonDir, slug) })`. Journals and plan state therefore always resolve against the owner's `baitonDir`. `isRunning(slug, repo)` filters on `(repo === undefined || entry.repo === repoLockKey(repo)) && (slug === undefined || entry.slug === slug)`. Phase queues still get no `isExternallyBusy`.

   5. Change `createRunQueueSeam(queueFor, baitonDir, adapterForRole, repo?: string)` to take an optional fourth `repo` (the owning repo root). Compute the in-flight key as `phaseQueueKey(repo ?? baitonDir-derived default, req.slug, req.phaseId)`; when `repo` is omitted, using `path.dirname(baitonDir)` is fine because only uniqueness within the seam matters. Existing 3-argument test callers keep working.

   6. Keep `createStageLock` exported with the same signature and behaviour, because tests import it. Mark it `@deprecated` in favour of `createRepoLocks`, and fix the module header and its doc so they describe the per-repo lock map: plan-draft and plan-less runs take the lock of the repo they run in, unrelated repos never block each other, and phase queues are keyed by (owning repo, slug, phase).

   Files: `src/activation/engineFacade.ts`

5. Wire the lock map and repo-keyed queues in commands

   In src/activation/commands.ts (registerCommands, around lines 470-700):
   - Import `createRepoLocks` (and the `RepoLocks` type if it is needed) from '../engine'. Drop the `createStageLock` import if nothing else uses it, and keep the import list tidy for eslint.
   - Create one shared map near the other shared seams: `const repoLocks = createRepoLocks();`, commented as "one stage-lock per repo, shared by every plan-draft runner and run pipeline; phase queues never take it". Delete the `stageLock` block (lines ~492-499).
   - `createRunPipeline({... })`: remove `isPlanBusy: () => stageLock.runPipelineBusy()` and pass `repoLocks` instead. Update the adjacent comment.
   - `createPlanDraftRunner({... })`: remove `isQueueRunning: () => stageLock.planDraftBusy()` and pass `repoLocks` instead. Both runners run with `workspaceRoot: repoRoot`, so they share one key and still exclude each other exactly as before.
   - Keep `createPhaseQueues({...})` as it is; it is the default owner = `repoRoot`. Do not pass `owners` yet, because the owner is still the single primary repo. Bind the repo explicitly at call sites:
     - `const queueFor = (slug, phaseId) => phaseQueues.queueFor(slug, phaseId, repoRoot);`
     - `submitPrForSlug`: `phaseQueues.isRunning(slug, repoRoot)`.
     - The View/find seam at ~line 852: `(slug, phaseId) => phaseQueues.find(slug, phaseId, repoRoot)`.
     - `buildToolServices` at ~line 1960: `createRunQueueSeam(queueFor, baitonDir, adapterForRole, repoRoot)`. Thread `repoRoot` through if the function doesn't already receive it; it receives `repoRoot` as its first parameter at the call sites at lines 643/676, so just use that.
   - Make `prInFlight` repo-aware for consistency: key it as `${repoRoot}\u0000${slug}`, or leave it keyed by slug and note that it is owner-bound. Keep land-phase and submit refusals textually identical.
   - The status listing at ~line 1148 (`phaseQueues.running().map(...)`) keeps its `slug/phaseId` text in a single-repo workspace. It may prefix the repo only when the run's `repo` differs from `repoRoot`, which never happens in this phase.
   - Update the comments that mention "the repository lock" (lines ~474-475, 492-494, 500-504, 517-520, 620-624, 667) to describe the per-repo lock.

   Files: `src/activation/commands.ts`

6. Tests: per-repo lock map, repo-keyed queues, and runners sharing a repo lock

   Extend test/engineFacade.resume.test.ts with new `describe` blocks that reuse its stub terminal host, watcher factory, git and plan-store helpers.

   1. `describe('repo locks')` covers `createRepoLocks`:
      - `tryAcquire('/w/a','plan-draft')` returns a lease.
      - A second `tryAcquire('/w/a','run-pipeline')` returns undefined, and so does the non-normalized `'/w/a/./'`.
      - `tryAcquire('/w/b', ...)` succeeds while `/w/a` is held, so unrelated repos are independent.
      - Parent `/w` and child `/w/packages/api` are distinct locks.
      - `holder()` and `heldRepos()` report correctly.
      - `release()` frees the lock; a second `release()` of a stale lease does not free a lock re-acquired by someone else.
   2. `describe('phase queues keyed by owning repo')`, built with `createPhaseQueues` and pre-built `worktrees` seam stubs so no git is needed. Pass an `owners` resolver for a second root with its own temp `baitonDir`:
      - `queueFor(slug, P01)` and `queueFor(slug, P01, defaultRoot)` return the same instance.
      - `queueFor(slug, P01, otherRoot)` returns a different instance.
      - `find(slug, P01, otherRoot)` is undefined before creation.
      - `queueFor(slug, P01, '/unknown')` throws `unknown owning repo`.
      - `phaseQueueKey(a, s, p) !== phaseQueueKey(b, s, p)`, and a non-normalized root yields the same key.
      - Dispatch an execute on the other repo's queue, using a watcher that resolves on demand so the stage stays in flight. Then `isRunning(slug, otherRoot)` is true, `isRunning(slug, defaultRoot)` is false, `isRunning(slug)` is true, and `running()[0].repo === repoLockKey(otherRoot)`.
      - The journal start record lands under the OTHER owner's `baitonDir` (`phaseJournalPathFor(otherBaitonDir, slug, 'P01')`) and not under the default's.
   3. `describe('plan draft and run pipeline share the per-repo lock')`, using `createPlanDraftRunner` and/or `createRunPipeline` with stub deps, or the lease API alone when wiring a full runner here is too heavy. The minimum is a plan-draft runner with a stub adapter whose `probe` resolves ok and a stub terminal host:
      - Acquiring `repoLocks.tryAcquire(root, 'run-pipeline')` first makes `runner.start(...)` refuse `busy`.
      - With the lock held for a DIFFERENT root, the draft starts.
      - After a refusal past the lock (for example `duplicate-slug`, from a pre-created plan.md), `repoLocks.isHeld(root)` is false again.
      - When the draft completes or fails, the lock is released.
      If wiring the full runner in this file needs helpers that only exist in test/engine.planDraft.test.ts, keep these runner-level tests minimal (busy and different-repo cases with a probe-failing adapter, which checks release on refusal) rather than duplicating that harness.

   All existing tests that use `createStageLock`, `isQueueRunning`, `isPlanBusy`, `queueFor(slug, phaseId)` and `isRunning(slug)` must keep passing unchanged.

   Files: `test/engineFacade.resume.test.ts`

7. Verify

   Run `npm run compile`, `npm run lint` and the focused suites: `npx mocha --no-config --require ts-node/register --extension ts test/engineFacade*.test.ts test/engine.planDraft.test.ts test/runPipeline.test.ts test/engine.runQueue*.test.ts test/runCommands.test.ts test/integration.run-modes.test.ts test/integration.sub-agent-chats.test.ts test/integration.plan-execute-review.test.ts test/registry.controlTools.test.ts`. Then run `npm test` and `git diff --check`. Git-backed suites may need to run outside the sandbox, as in P03.

   Files: (none)

## Risks

- Signature compatibility: tests outside this phase's file list call `phaseQueues.queueFor(slug, phaseId)`, `phaseQueues.isRunning(slug)`, `createRunQueueSeam(queueFor, baitonDir, adapter)`, `createStageLock(...)`, and pass `isQueueRunning`/`isPlanBusy`. ts-node type-checks tests, so the repo argument must stay optional and trailing (`isRunning(slug?, repo?)` rather than the overview's literal `isRunning(repo, slug)`), and the legacy hooks must stay supported. Reordering to `(repo, slug)` would compile, because both are strings, but would silently break test/integration.sub-agent-chats.test.ts.
- Every refusal path in planDraft.start() and runPipeline.start() after the lock is taken must release the lease. A missed release wedges that repo until reload. Tests should cover at least one post-acquire refusal per runner.
- Taking the lease before the async adapter probe (planDraft) or the git reads (runPipeline) narrows a pre-existing race. It also means that for the probe's duration the other runner sees busy slightly earlier than before. This is only a change in timing, not in single-repo semantics.
- Lock and queue keys use canonical root paths (path.resolve), not discovery repo names. Callers must pass roots that are canonicalized the same way discovery canonicalizes them (symlinks are not resolved here). commands.ts uses `workspace.root.fsPath` for both the runners' workspaceRoot and the queue repo, so the keys match today.
- `queueFor` throws for an unknown owner. In this phase commands.ts only ever passes the primary repo root, so the throw is unreachable in production. A later phase that routes tree items to other owners must supply `owners` first.
- Phase queues still neither take nor wait on the repo lock, which preserves today's concurrent per-phase worktree behaviour. Do not add `isExternallyBusy` to phase queues, because that would change single-repo lock behaviour.

## Acceptance

- src/engine/runQueue.ts exports `createRepoLocks`, `repoLockKey`, `RepoLocks`, `RepoLockLease` and `RepoLockHolder`, and they are reachable from '../engine'.
- With `repoLocks` set, the plan-draft runner and the run pipeline each refuse `busy` while the lock for their `workspaceRoot` is held, start while only a different repo's lock (including a parent's or a child's) is held, and release the lock on every refusal after acquisition and on completion.
- `phaseQueueKey(repo, slug, phaseId)` includes the canonical owning-repo root. `createPhaseQueues` caches queues per (owning repo, slug, phase), resolves a non-default owner through `owners`, and journals that owner's runs under its own `baitonDir`. `isRunning(slug, repo)` is scoped to the repo, and `isRunning(slug)` and `queueFor(slug, phaseId)` behave exactly as before.
- commands.ts no longer uses `createStageLock`. It creates one `createRepoLocks()` map, passes it to both `createPlanDraftRunner` and `createRunPipeline`, and passes `repoRoot` explicitly to `queueFor`, `find`, `isRunning` and `createRunQueueSeam`. Single-repo refusal messages are unchanged.
- test/engineFacade.resume.test.ts has new passing tests for lock independence across unrelated and parent/child repos, stale-release safety, repo-keyed queue caching and isRunning scoping, and owner-bound journaling.
- `npm run compile` and `npm run lint` succeed with no new warnings. `npm test` passes in full, including the existing planDraft, runPipeline, runCommands, run-modes, sub-agent-chats and plan-execute-review suites, without modifying them. `git diff --check` is clean.
