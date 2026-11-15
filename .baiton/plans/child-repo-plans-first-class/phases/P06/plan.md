# Plan P06

## Steps

1. Add a shared-writer plan-state factory to planStore.ts

   In src/activation/planStore.ts export a new pure helper (no vscode import):

   ```ts
   /** Plan state for ONE owning repo: a writer and a store that shares it, so per-slug writes in that repo serialize. */
   export interface OwnerPlanState { readonly baitonDir: string; readonly planWriter: PlanBranchWriter; readonly planStore: PlanStore; }
   export function createOwnerPlanState(baitonDir: string, git: GitWorktreeService, writer: PlanBranchWriter = createPlanBranchWriter({ baitonDir, git })): OwnerPlanState {
     return { baitonDir, planWriter: writer, planStore: createPlanStore(baitonDir, git, writer) };
   }
   ```

   Do not change createPlanStore's signature or behaviour, nor createPhaseTargetResolver (its `topology` callback form already lets a child owner pass `() => target.topology`). The store's journals/documents stay rooted at the given baitonDir, which is what makes a child owner's state land in the child's own `.baiton/`.

   Files: `src/activation/planStore.ts`

2. Add a lazy per-repo owner registry to engineFacade.ts

   In src/activation/engineFacade.ts import `createOwnerPlanState`, `createPhaseTargetResolver` from './planStore' and `RepoTopology` type from '../model/validator'. Add:

   ```ts
   /** What the facade needs to know about one discovered `.baiton/` repo to build its owner entry. Mirrors PlanRepoTarget's root/baitonDir/git/topology. */
   export interface PhaseQueueOwnerSource { root: string; baitonDir: string; git: GitWorktreeService; topology?: RepoTopology; }

   export interface PhaseQueueOwnersDeps {
     /** Resolve a discovered `.baiton/` repo by canonical root (activation passes planRepos.targetAt); undefined = not a plan repo. */
     sourceAt(repoRoot: string): PhaseQueueOwnerSource | undefined;
     /** One git service per repo root, used for phase targets (the activation GitServiceRegistry). */
     gitFor(repoRoot: string): GitWorktreeService;
   }

   export interface PhaseQueueOwners {
     /** The owner entry for a repo root, created once and cached by repoLockKey(root); undefined when the root is not a discovered `.baiton/` repo. */
     ownerFor(repoRoot: string): PhaseQueueOwner | undefined;
   }

   export function createPhaseQueueOwners(deps: PhaseQueueOwnersDeps): PhaseQueueOwners
   ```

   Implementation: a `Map<string, PhaseQueueOwner>` keyed by `repoLockKey(root)`. On miss call `deps.sourceAt(key)`; undefined -> return undefined WITHOUT caching (so a repo discovered later resolves on a later call). Otherwise build `const state = createOwnerPlanState(source.baitonDir, source.git)` and `targets = createPhaseTargetResolver({ baitonDir: source.baitonDir, ownerRoot: source.root, topology: () => source.topology, gitFor: deps.gitFor })`, then cache and return `{ workspaceRoot: source.root, baitonDir: source.baitonDir, git: source.git, planWriter: state.planWriter, planStore: state.planStore, targets }` (no `worktrees`, so createPhaseQueues' `seamFor` builds a per-repo QueueWorktreeSeam bound to that owner's writer and targets). Each repo thus has exactly one writer shared by its store, its queues and its worktree seam.

   Update the module doc comment to say each discovered `.baiton/` repo gets its own lazily-created plan store, writer and owner entry keyed by repo root.

   Files: `src/activation/engineFacade.ts`

3. Expose owner resolution on PhaseQueues

   In engineFacade.ts add to the `PhaseQueues` interface:

   ```ts
   /** The owner entry (baitonDir, git, planStore, planWriter) for a repo; omitted repo = default owner; undefined for an unknown repo. Never creates a queue. */
   owner(repo?: string): PhaseQueueOwner | undefined;
   ```

   Implement it in createPhaseQueues by reusing the existing `ownerFor` logic but non-throwing: refactor into `const resolveOwner = (repo?) => { key = repo === undefined ? defaultRepo : repoLockKey(repo); if (key === defaultRepo) return { repo: defaultRepo, owner: defaultOwner }; const owner = owners?.(key); return owner === undefined ? undefined : { repo: key, owner }; }` and have the existing throwing `ownerFor` call it and throw `unknown owning repo "${key}"` on undefined (message unchanged; existing test asserts /unknown owning repo/). Also make `find` canonicalize identically (it already does). Default owner behaviour, defaultRepo identity and queue keys are unchanged, so single-repo workspaces behave exactly as today. Callers that construct PhaseQueues objects by hand (search `PhaseQueues` with Grep across src and test; e.g. test doubles) must gain an `owner` member if they implement the interface literally — fix any compile errors this introduces in the same phase.

   Optionally (recommended, additive) widen `PhaseQueuesDeps.owners` doc: it may be `createPhaseQueueOwners(...).ownerFor`. Do NOT wire commands.ts in this phase (not in the phase's file list); the existing optional `owners` seam stays optional and today's activation keeps working.

   Files: `src/activation/engineFacade.ts`

4. Make createRunQueueSeam / dispatch resolve journal paths from the owner

   `createRunQueueSeam(queueFor, baitonDir, adapterForRole, repo?)` already keys in-flight by repo; leave its signature unchanged (callers in commands.ts untouched). No change to dispatchTrigger: callers pass the owner's baitonDir. Only verify via tsc that nothing else in engineFacade needs the new types.

   Files: `src/activation/engineFacade.ts`

5. Test per-repo owners in engineFacade.resume.test.ts

   Add a `describe('per-repo owner registry', ...)` block to test/engineFacade.resume.test.ts reusing the file's helpers (makeGit, makeTerminalHost, withStubbedProbe, ClaudeAdapter, the deferred-result watcher pattern from 'phase queues keyed by owning repo'). Cases:
   1. `createPhaseQueueOwners` caching: build two temp roots childA/childB each with `.baiton/`; `sourceAt` returns sources for those roots (compare `path.resolve`), undefined otherwise and counts calls. Assert `ownerFor(childA) === ownerFor(`${childA}/./`)`, `ownerFor(childA) !== ownerFor(childB)`, their `planWriter`/`planStore`/`baitonDir` differ, `baitonDir` equals each child's `.baiton`, and `ownerFor('/nowhere')` is undefined and is retried (sourceAt called again) on the next call.
   2. Owner plan store reads its own repo: write a minimal plan document into childA via the same layout resolveDocument expects (`.baiton/plans/demo/plan.md` with a `# Phases`-style phase line like other tests use — grep test/ for an existing parsePlan fixture string and copy it) and assert `ownerFor(childA).planStore.readPlan('demo')` resolves while childB's resolves undefined.
   3. Concurrency across child owners: createPhaseQueues with default owner (temp root) and `owners: registry.ownerFor`, but because the registry owner has no `worktrees`, pass sources whose git stubs include `commitPaths`, and give each owner a stub worktree seam by wrapping: `owners: (root) => { const o = registry.ownerFor(root); return o && { ...o, worktrees: worktreesFor(o.workspaceRoot, o.git) } }`. Dispatch execute on ('demo','P01') in childA and childB; once both watchers have registered, assert `queues.isRunning('demo', childA)` and `queues.isRunning('demo', childB)` are both true, `queues.running()` has two entries with repos resolving to each child, and each child's `phaseJournalPathFor(<child>/.baiton,'demo','P01')` exists while the default owner's does not. Then complete both results and await both dispatches.
   4. `queues.owner()` returns the default owner (baitonDir === default), `queues.owner(childA)?.baitonDir === childA/.baiton`, `queues.owner('/unknown') === undefined`, while `queueFor(..., '/unknown')` still throws /unknown owning repo/.
   Use a per-test watcher factory that collects listeners into an array so two concurrent dispatches can be resolved independently.

   Files: `test/engineFacade.resume.test.ts`

6. Build, lint and test

   Run `npm run compile`, `npm run lint`, `npm test` and `git diff --check`. Fix any type errors from the new `PhaseQueues.owner` member in hand-rolled PhaseQueues implementations (grep `PhaseQueues` / `isRunning(slug` doubles in test/ and src/); if a fix would be needed outside the listed files, prefer making `owner` optional-free but keep the change minimal and note it.

   Files: `src/activation/engineFacade.ts`, `src/activation/planStore.ts`, `test/engineFacade.resume.test.ts`

## Risks

- Adding a required `owner` member to the PhaseQueues interface can break any literal PhaseQueues test double or stub elsewhere; grep first, and if doubles exist outside the phase's files, declare `owner?` on the interface instead to keep the change inside the allowed files.
- Importing ./planStore into engineFacade.ts must not create an import cycle (planStore imports '../engine', engineFacade imports '../engine'; neither imports the other today) — verify compile.
- Caching an `undefined` sourceAt result would make a child repo discovered after activation permanently unknown; only cache hits.
- Two owners must never share a PlanBranchWriter; sharing would serialize unrelated repos and, worse, commit through the wrong repo's git. The test should assert writer identity differs.
- createPhaseTargetResolver for a child owner uses `source.topology` snapshotted at creation; if topology changes later, cached owners keep the old topology. Acceptable for this phase (P01 targets are rebuilt per lookup only in commands.ts); note it for the commands-wiring phase.
- Default-owner behaviour (queue keys, error messages, find semantics) must stay byte-identical; existing 'phase queues keyed by owning repo' test must pass unchanged.

## Acceptance

- `createPhaseQueueOwners` is exported from src/activation/engineFacade.ts and lazily builds, per discovered `.baiton/` repo root (canonicalized with repoLockKey), one owner entry whose planStore and planWriter are bound to that repo's baitonDir and git and share a single writer.
- `createOwnerPlanState` is exported from src/activation/planStore.ts and returns a store built over the same writer it returns.
- `PhaseQueues.owner(repo?)` returns the default owner for an omitted/default repo, the registry owner for a child repo, and undefined for an unknown repo; `queueFor` on an unknown repo still throws /unknown owning repo/.
- New tests show two child-repo plans with the same slug and phase running concurrently in separate queues with journals written only to their own `.baiton/`.
- No changes outside src/activation/engineFacade.ts, src/activation/planStore.ts and test/engineFacade.resume.test.ts (unless a PhaseQueues double forces a minimal fix, documented in notes).
- `npm run compile`, `npm run lint` (no new errors) and the full `npm test` suite pass; `git diff --check` is clean.
