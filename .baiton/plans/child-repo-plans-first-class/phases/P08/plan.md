# Plan P08

## Steps

1. Add a pure document-path parser that yields slug and owning repo root

   In src/activation/commands.ts, next to `slugFromDocumentUri` (CodeLens section, ~line 2165), add and export:

   ```ts
   export interface PlanDocumentLocation { slug: string; root: string; baitonDir: string }
   export function planDocumentFromPath(fsPath: string): PlanDocumentLocation | undefined {
     // Greedy prefix so the LAST `.baiton` segment wins (a phase worktree's nested copy).
     const m = /^(.*)[/\\]\.baiton[/\\](?:plans[/\\]([^/\\]+)[/\\]plan\.md|specs[/\\]([^/\\]+)[/\\]spec\.md)$/.exec(fsPath);
     if (!m) return undefined;
     const root = m[1] === '' ? path.sep : m[1];
     return { slug: (m[2] ?? m[3])!, root, baitonDir: path.join(root, '.baiton') };
   }
   ```

   Rewrite `slugFromDocumentUri(uri)` as `planDocumentFromPath(uri.fsPath)?.slug` so the editor-follow handler (~line 1404, `chatController.setActivePlan(slug)`) keeps its exact current behaviour (chat-controller repo awareness belongs to a later phase; do not touch it here). Phase-plan files (`.baiton/plans/<slug>/phases/<id>/plan.md`) and other `.md` files in a slug folder must still return undefined, as today.

   Files: `src/activation/commands.ts`

2. Add an exported lens-target resolver matched against discovered repos

   In src/activation/commands.ts add and export:

   ```ts
   export interface LensPlanTarget { slug: string; baitonDir: string; repoPath?: string }
   export function resolveLensTarget(deps: PlanTargetDeps, fsPath: string): LensPlanTarget | undefined
   ```

   Logic:
   1. `const doc = planDocumentFromPath(fsPath)`; undefined -> return undefined.
   2. `const multiRepo = deps.planRepos.owners().length > 1`.
   3. `const target = deps.planRepos.targetAt(doc.root)`. Accept it only if `repoLockKey(target.baitonDir) === repoLockKey(doc.baitonDir)` (import `repoLockKey` is already used in this file).
   4. If accepted: `isOwner = repoLockKey(target.root) === repoLockKey(deps.ownerRoot)`; `baitonDir = isOwner ? deps.ownerBaitonDir : target.baitonDir`; return `{ slug: doc.slug, baitonDir, ...(multiRepo ? { repoPath: target.info.path } : {}) }`. In a multi-repo workspace the owner's lens therefore carries `'.'`, so a slug shared with a child never opens the ambiguity chooser; in a single-repo workspace no repoPath is added, keeping lens arguments byte-identical (`[slug, phaseId]`).
   5. If no discovered repo matches: preserve today's behaviour only for documents inside the owner root (e.g. the plan copy in a phase worktree under `<owner>/.baiton/worktrees/...`, which discovery never lists): if `path.relative(deps.ownerRoot, doc.root)` neither starts with `..` nor is absolute, return `{ slug: doc.slug, baitonDir: deps.ownerBaitonDir, ...(multiRepo ? { repoPath: '.' } : {}) }`. Otherwise return undefined (no lenses for a repo Baiton did not discover).

   The resolver is pure apart from the seam (no fs, no vscode), so it is unit-testable with the existing `makeDeps`/`makeLayout` helpers.

   Files: `src/activation/commands.ts`

3. Make PlanCodeLensProvider repo-aware and pass the repo in lens arguments

   Change `class PlanCodeLensProvider` (~line 2118) to `constructor(private readonly targets: PlanTargetDeps) {}`. In `provideCodeLenses(document)`: `const t = resolveLensTarget(this.targets, document.uri.fsPath); if (t === undefined) return [];` then use `readPlanJournal(t.baitonDir, t.slug)` and `phasePlanPath(t.baitonDir, t.slug, phase.id)` in place of `this.baitonDir`/`slug`, and call `lens(range, title, command, t.slug, phase.id, t.repoPath)`.

   Change `lens(...)` to take an optional `repoPath?: string` and build `arguments: repoPath === undefined ? [slug, phaseId] : [slug, phaseId, repoPath]`. No command handler changes are needed: every lens command (stage commands via `registerStageCommand`, `registerActionCommand` replan/stop, `registerViewCommand`, `COMMANDS.viewPlan`) already takes `(a, b, c)` and feeds `phaseArgs(a, b, c)`, whose third argument becomes `repoPath`, which `resolvePlanTarget` resolves through `planRepos.target(repoPath)` without prompting. Update the provider's doc comment and the file-header bullet (~line 45) to say the lens derives the owning repo from the document path and passes `[slug, phaseId, repoPath]` when more than one repo exists.

   Files: `src/activation/commands.ts`

4. Widen the CodeLens registration

   At the registration (~line 1416) change the selector to `{ pattern: '**/.baiton/{plans,specs}/*/*.md' }` and construct `new PlanCodeLensProvider(planTargets)` (the `planTargets` object built ~line 470 in the same function). The filename filter in `planDocumentFromPath` still restricts lenses to `plan.md` / legacy `spec.md`, so the wider glob adds no lenses on other markdown. Keep the legacy comment noting spec.md support. If `baitonDir` is no longer referenced by the provider, ensure no now-unused variable or import trips lint.

   Files: `src/activation/commands.ts`

5. Unit tests for document parsing and lens target resolution

   In test/runCommands.test.ts inside `describe('plan command targets (repo, slug)')`, reusing `makeLayout`/`makeDeps`, add:
   - `planDocumentFromPath`: `<ws>/.baiton/plans/alpha/plan.md` -> `{slug:'alpha', root: ws, baitonDir: ownerBaiton}`; `<child>/.baiton/specs/old/spec.md` -> slug 'old', root child; `<ws>/.baiton/worktrees/s/P01/.baiton/plans/x/plan.md` -> root is the worktree dir (last `.baiton` wins); `<ws>/.baiton/plans/alpha/phases/P01/plan.md` and `<ws>/.baiton/plans/alpha/notes.md` -> undefined.
   - `resolveLensTarget` single-repo (`discovered: false`): owner `alpha` doc -> `{slug:'alpha', baitonDir: ownerBaiton}` with no `repoPath` key (assert deepStrictEqual).
   - multi-repo: child `shared` doc -> `{slug:'shared', baitonDir: childBaiton, repoPath:'child'}`; owner `shared` doc -> `{..., baitonDir: ownerBaiton, repoPath:'.'}`; worktree copy under the owner root -> owner baitonDir with repoPath '.'; a doc in an unrelated temp dir (outside ws, not discovered) -> undefined.
   - Round trip: `resolvePlanTarget(deps, phaseArgs('shared','P01','child'))` and with `'.'` resolve to child / owner respectively with zero `choose` calls.

   Files: `test/runCommands.test.ts`

## Risks

- Single-repo byte-identity: lens arguments must stay exactly `[slug, phaseId]` when `planRepos.owners().length <= 1`; appending `undefined` or `'.'` there would change command arguments.
- In multi-repo workspaces the owner lens must carry `'.'`; omitting it would make an owner plan whose slug also exists in a child open the ambiguity chooser on every lens click, since owner-wins precedence is gone.
- Owner baitonDir: `resolveLensTarget` must use `deps.ownerBaitonDir` for the owner (as `resolvePlanTarget` does) rather than `<root>/.baiton`, in case the workspace context's baitonDir differs in form (symlink/case); compare roots with `repoLockKey`.
- Phase-worktree copies of plan.md are not discovered repos; the owner-root fallback preserves today's lenses there. Dropping it would silently remove lenses that exist today.
- The wider glob `*/*.md` matches extra markdown; the regex filename check must stay strict so no lenses appear on non-plan files.
- Editor-follow still uses the bare slug; leave it unchanged in this phase (chat-controller identity is a separate phase) so behaviour is not partially changed.

## Acceptance

- `npm run compile` succeeds.
- `npm run lint` reports no new errors or warnings.
- `npx mocha --grep "plan command targets"` passes, including the new planDocumentFromPath and resolveLensTarget tests.
- Full `npm test` passes (use `--timeout 60000` if the known slow tree-model property test times out).
- In a single-repo workspace the CodeLens provider emits the same lenses with arguments `[slug, phaseId]`, reading `<owner>/.baiton` journal and phase plans as before.
- A child repo's `.baiton/plans/<slug>/plan.md` shows phase lenses computed from the child's journal and phase plans, and each lens's arguments are `[slug, phaseId, '<childRepoPath>']`, so Plan/Execute/Review/Re-plan/Stop/View/View plan act on the child plan without a chooser.
- `git diff --check` is clean and only src/activation/commands.ts and test/runCommands.test.ts change.
