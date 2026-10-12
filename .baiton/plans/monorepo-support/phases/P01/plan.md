# Plan P01

## Steps

1. Add the pure repo-discovery module src/activation/repoDiscovery.ts

   Create a new pure module (no `vscode`, no direct `fs`; only Node `path` for joining/relative math) and re-export it from `src/activation/index.ts` (`export * from './repoDiscovery';`).

   Types:
   ```ts
   export type DirEntryKind = 'dir' | 'file' | 'other'; // 'other' = symlink/socket/etc, never followed
   export interface DiscoveryDirEntry { readonly name: string; readonly kind: DirEntryKind }
   export interface DiscoveryFs { readdir(dir: string): Promise<readonly DiscoveryDirEntry[]> } // a throw/reject is treated as an empty dir
   export interface DiscoveryFolder { readonly name: string; readonly root: string } // root already canonicalized by the shell
   export interface Repo {
     readonly name: string;        // stable identity (see naming below)
     readonly folderName: string;  // the workspace folder this repo was found under
     readonly relPath: string;     // folder-relative, POSIX separators, '' for the folder root
     readonly root: string;        // absolute canonical path
     readonly baitonDir?: string;  // `<root>/.baiton` when that directory exists
     readonly hasGit: boolean;     // `.git` dir or worktree `.git` file present
     readonly parent?: string;     // parent repo name; undefined for a folder root
     readonly children: readonly string[]; // child repo names, sorted
   }
   export interface RepoSet {
     readonly repos: readonly Repo[]; // pre-order: folder by folder (input order), parent before children, siblings sorted by name
     readonly folderRoots: readonly Repo[]; // one per folder, input order
     readonly truncated: boolean;     // a discovery bound was hit
   }
   export interface DiscoveryOptions { readonly maxDepth?: number; readonly maxEntries?: number }
   export const DISCOVERY_SKIP_DIRS: ReadonlySet<string> = new Set(['.git', 'node_modules', '.baiton']);
   export const DEFAULT_DISCOVERY_MAX_DEPTH = 12;
   export const DEFAULT_DISCOVERY_MAX_ENTRIES = 50000;
   export const SINGLE_ROOT_REPO_NAME = '.';
   ```

   `export async function discoverRepos(folders: readonly DiscoveryFolder[], fs: DiscoveryFs, opts: DiscoveryOptions = {}): Promise<RepoSet>`:
   - For each folder, walk breadth-first (or DFS) from `root`. The folder root is ALWAYS a repo, even with no `.git` and no `.baiton/` (keeps the initialize flow working).
   - A non-root directory is a repo iff its listing contains `.git` with kind 'dir' or 'file' (worktree/submodule gitfile), or `.baiton` with kind 'dir'. `baitonDir` is set iff `.baiton` is a 'dir'.
   - Descend only into entries of kind 'dir' whose name is not in `DISCOVERY_SKIP_DIRS`. Skipping `.baiton` entirely is what keeps Baiton's own phase/run worktrees (`<repo>/.baiton/worktrees/...`, which carry `.git` files) from being treated as repos. Never follow 'other' (symlinks) to avoid cycles.
   - Bounds: stop descending past `maxDepth` levels below a folder root; stop listing once total visited entries reach `maxEntries` across the whole call; set `truncated = true` when either bound cuts the walk.
   - Dedupe by canonical root: if a root was already recorded (overlapping multi-root folders), skip it — first folder wins.
   - Parent = nearest ancestor directory recorded as a repo in the same folder walk; fill `children` from that.
   - Naming: with exactly ONE folder, the root repo is named `SINGLE_ROOT_REPO_NAME` ('.') and nested repos by `relPath` (e.g. `packages/api`). With several folders, the root repo is named by its folder name and nested repos `${folderName}/${relPath}`; if two folders share a name, suffix the later one's name with `~${index}` (index = folder position) before building names. `relPath` always uses '/' (convert with `split(path.sep).join('/')`).

   Pure helpers (all string-based, no I/O):
   - `export function repoByName(set: RepoSet, name: string): Repo | undefined`
   - `export function repoFor(set: RepoSet, absPath: string): Repo | undefined` — the deepest repo whose `root` equals `absPath` or contains it (`path.relative(root, p)` is '' or does not start with '..' and is not absolute); deepest = longest root. A path under `<repo>/.baiton/worktrees/...` therefore resolves to the owning repo.
   - `export function isWithinSubtree(set: RepoSet, owner: Repo | string, target: Repo | string): boolean` — true iff target is owner or owner is on target's parent chain (walk `parent` names). Unknown names → false.
   - `export function reposWithBaiton(set: RepoSet): readonly Repo[]` — repos whose `baitonDir` is defined, in `repos` order.

   Document in the file header that this replaces the single-root selection and that the shell supplies the fs seam.

   Files: `src/activation/repoDiscovery.ts`, `src/activation/index.ts`

2. Rewrite workspace resolution in src/activation/workspace.ts to return a repo set

   Keep `WorkspaceContext<TUri>` ({ root, baitonDir, restricted }) unchanged — it remains the shape every existing consumer (commands.ts, guard, recovery) reads, now meaning the PRIMARY repo. Keep `canonicalizeRoot` and `RealpathFn` unchanged.

   Remove the old `WorkspaceFolder<TUri>` descriptor ({uri, hasBaitonDir}) and the `multiple-baiton-roots` variant and the `ONE_ROOT_REQUIRED` 'exactly one' wording.

   Add:
   ```ts
   export interface PrimaryRepo<TUri> extends WorkspaceContext<TUri> { readonly repo: Repo }
   export interface WorkspaceRepos<TUri> {
     readonly restricted: boolean;   // = !trusted
     readonly repos: RepoSet;
     readonly primary: PrimaryRepo<TUri>; // surface still single-root until later phases
   }
   export type WorkspaceError =
     | { kind: 'no-folder'; message: string }
     | { kind: 'no-baiton-root'; message: string };
   export function resolveWorkspace<TUri>(repos: RepoSet, trusted: boolean, toUri: (fsPath: string) => TUri): Result<WorkspaceRepos<TUri>, WorkspaceError>
   ```
   Rules:
   1. `repos.folderRoots.length === 0` → err `no-folder` (message: 'No workspace folder is open. Baiton needs a folder containing a .baiton/ directory.').
   2. Exactly one folder → primary = that folder's root repo regardless of `.baiton/` (unchanged Req 22.3; config load decides initialization).
   3. Several folders → primary = the first folder-root repo (folder order) with a `baitonDir`; else the first repo in `repos` order with a `baitonDir`; else err `no-baiton-root` (message mentions '.baiton/ directory' and Baiton: Initialize). Several `.baiton/` roots are no longer refused.
   Primary context: `root = toUri(repo.root)`, `baitonDir = toUri(repo.baitonDir ?? path.join(repo.root, '.baiton'))`, `restricted = !trusted`, `repo`.
   Update the file's header comment to describe discovery + primary selection (drop 'exactly one .baiton root').

   Files: `src/activation/workspace.ts`

3. Add a per-repo git service registry in src/git/gitService.ts

   Add, next to `createGitService`:
   ```ts
   export interface GitServiceRegistry {
     /** The single service bound to `repoRoot`, created on first use and reused after. */
     forRepo(repoRoot: string): GitWorktreeService;
   }
   export function createGitServiceRegistry(
     factory: (repoRoot: string) => GitWorktreeService = createGitService,
   ): GitServiceRegistry
   ```
   Implementation: a `Map<string, GitWorktreeService>` keyed by `path.resolve(repoRoot)`; return the cached instance or create via `factory`. Do not change `ShellGitService` behaviour (it already takes its root by injection, including `isCleanExceptPlanFolder` resolving `.baiton` under its own root). It is exported through `src/git/index.ts` automatically (`export * from './gitService'`).

   Files: `src/git/gitService.ts`

4. Wire discovery into src/extension.ts activation, per-repo config and per-repo recovery

   Imports: replace `type WorkspaceFolder` with `discoverRepos`, `reposWithBaiton`, `type RepoSet`, `type DiscoveryFs`, `type DiscoveryFolder`, `type WorkspaceRepos` from './activation'; import `createGitServiceRegistry`, `type GitServiceRegistry` from './git'.

   `ActivationState`: keep `workspace: WorkspaceContext<vscode.Uri>` (now the primary repo — assign `resolved.value.primary`), `config` (primary repo's config), `executables`. Add `readonly repos: RepoSet;` and `repoConfigs: ReadonlyMap<string, Config>` (keyed by repo name, includes the primary when it loaded) and `readonly git: GitServiceRegistry`. Document that later phases consume these; commands.ts keeps reading `workspace`.

   `completeActivation`:
   - Replace `readWorkspaceFolders()` with `async function discoverWorkspaceRepos(): Promise<RepoSet>`: map `vscode.workspace.workspaceFolders ?? []` to `DiscoveryFolder { name: folder.name, root: folder.uri.scheme === 'file' ? canonicalizeRoot(folder.uri.fsPath) : folder.uri.fsPath }` and call `discoverRepos(folders, nodeDiscoveryFs)`. For a non-file-scheme folder pass a fs seam that only reports the root (or just let readdir fail → root-only repo). If `repos.truncated`, `surface.log(...)` a note that discovery hit its bound.
   - `const nodeDiscoveryFs: DiscoveryFs = { readdir: async (dir) => (await fsp.readdir(dir, { withFileTypes: true })).map((d) => ({ name: d.name, kind: d.isDirectory() ? 'dir' : d.isFile() ? 'file' : 'other' })) }` (Dirent.isDirectory() is false for symlinks, so they are 'other' and never followed).
   - `resolveWorkspace<vscode.Uri>(repos, trusted, (p) => vscode.Uri.file(p))`; on error behave exactly as today (showErrorMessage + NOT_ACTIVATED_NOTE). `const workspace = resolved.value.primary;`
   - Primary config load unchanged (`loadConfig(workspace.baitonDir.fsPath)`; failure aborts activation exactly as today). Then for every other repo in `reposWithBaiton(repos)` (skip the primary) call `loadConfig(repo.baitonDir)`; on success put it in `repoConfigs`; on failure `surface.warn(`Baiton could not load ${repo.name}/.baiton/config.json: ${message}`)` and continue — a broken child config never blocks activation. Executable resolution stays driven by the primary config only (unchanged).
   - Build `const git = createGitServiceRegistry();` once.
   - Crash recovery: change `runCrashRecovery(workspace, surface)` to `runCrashRecovery(repos, git, surface)` that loops over `reposWithBaiton(repos)` and, per repo, runs the existing per-slug loop with `repoRoot = repo.root`, `baitonDir = repo.baitonDir`, `git.forRepo(repo.root)`; wrap each repo in try/catch so one repo's failure does not stop the rest. `makeRecoveryWriteState` keeps resolving the document under its own repo's `.baiton` (pass `repo.baitonDir` and use it instead of `path.join(repoRoot, '.baiton')`). Journals are read/written only under that repo's own `baitonDir`.
   - `.gitignore` refresh: run `refreshGitignore(repo.baitonDir)` for every repo with a `.baiton/` (each in its own try/catch with the existing warn message naming the repo), still skipped under Restricted Mode.
   - `const state: ActivationState = { workspace, config, executables, repos, repoConfigs, git };`
   - Delete `readWorkspaceFolders` and `hasBaitonDir`; keep `baitonDirOf` only if still used (otherwise remove). Update the activation-order header comment step 2 to 'Repo discovery — walk every folder; primary = single folder, or first .baiton repo in multi-root'.
   Do NOT touch the ordering of `new CatalogStore(`, `new ModelDiscoveryService(`, `registerConfigPanel({`, `void discovery.refresh()` (pinned by tests). The `cwd: () => getActivationState()?.workspace.root.fsPath` closure and `scopedApplyConfig` keep reading the primary.

   Files: `src/extension.ts`

5. Update and extend test/activation.gating.test.ts

   Replace the `resolveWorkspace (Req 22.3-22.8)` describe block and the `folder()`/`makeBaitonDir` helpers. Add an in-memory fake: `function fakeFs(tree: Record<string, 'dir' | 'file' | 'link'>): DiscoveryFs` where keys are absolute POSIX paths (e.g. '/ws/a/.git': 'dir'); `readdir(dir)` returns the immediate children with kinds ('link' → 'other'), rejects for unknown dirs, and records each call in a `calls: string[]` array for assertions. Use `path.posix`-style paths only on POSIX; guard with `if (process.platform === 'win32') this.skip()` if needed, or build paths with `path.join`.

   discoverRepos tests:
   - single folder with no `.git`/`.baiton` → one repo named '.', relPath '', no baitonDir, no parent, no children.
   - nested monorepo: `/ws/.git`, `/ws/.baiton`, `/ws/packages/api/.git` (dir), `/ws/packages/web/.git` (file, worktree gitfile), `/ws/packages/web/.baiton`, `/ws/tools/x/.baiton` (no git) → names ['.', 'packages/api', 'packages/web', 'tools/x'] in pre-order; parents all '.'; root children sorted; baitonDir set only for '.', 'packages/web', 'tools/x'; hasGit true/false as expected.
   - deeper nesting: `/ws/a/.git` and `/ws/a/b/.git` → 'a/b'.parent === 'a'.
   - skips: a `.git` inside `/ws/node_modules/pkg/`, inside `/ws/.baiton/worktrees/slug/P01/` (a `.git` file) and contents of `/ws/.git/` are never reported, and `calls` never includes any path under `node_modules`, `.git` or `.baiton`.
   - symlinked directory ('link') is not descended.
   - bounds: `maxDepth: 1` excludes a repo at depth 2 and sets `truncated`; `maxEntries` small sets `truncated`; an unbounded walk reports `truncated: false`.
   - multi-root: folders `{name:'api', root:'/w/api'}`, `{name:'web', root:'/w/web'}` with `/w/web/libs/ui/.git` → names ['api', 'web', 'web/libs/ui']; duplicate folder names get the `~index` suffix; an overlapping folder root is deduped.

   Helper tests: `repoFor` returns the deepest repo (a file under packages/api → 'packages/api'; a file under `/ws/.baiton/worktrees/...` → '.'; outside every root → undefined; the root path itself → that repo); `isWithinSubtree` true for self and descendants, false for sibling ('packages/api' vs 'packages/web'), ancestor ('packages/api' owner, '.' target) and unknown names.

   resolveWorkspace tests (built from `discoverRepos` over the fake, or a hand-built RepoSet): no folders → `no-folder`; single folder without `.baiton` → primary root '/ws/fresh', baitonDir '/ws/fresh/.baiton'; single folder whose root has no `.baiton` but a child does → primary is still the folder root; multi-root with one `.baiton` root → that root; multi-root with TWO `.baiton` roots → ok, primary is the first in folder order (regression that `multiple-baiton-roots` is gone; assert `r.error` kind never equals it by type); multi-root where only a nested repo has `.baiton` → that nested repo is primary; multi-root with none → `no-baiton-root` and message matches /\.baiton\/ directory/; `restricted === !trusted` on both `WorkspaceRepos.restricted` and `primary.restricted`; `repos` is carried through unchanged.

   createGitServiceRegistry tests: with a counting fake factory, `forRepo('/r/a')` twice returns the same instance and calls the factory once; `/r/a` vs `/r/b` yields two distinct services; `'/r/a/'` and `'/r/a'` share one (path.resolve normalization).

   Update the file's header coverage comment accordingly. Keep every other describe block (engine guard, executables, packaging, config-panel wiring source checks, canonicalizeRoot, createRunPipelineSeam) untouched.

   Files: `test/activation.gating.test.ts`

6. Sweep for remaining references and build

   Grep `src` and `test` for `WorkspaceFolder<`, `hasBaitonDir`, `multiple-baiton-roots`, `readWorkspaceFolders` and fix any remaining reference (expected: only the files above). Leave `resolveCommandRoot`/`resolveBaitonDirForCommands` in `src/activation/commands.ts` as-is for this phase (they are converted by a later phase); do not edit commands.ts unless the compile requires it. Run `npm run compile`, `npm run lint`, and `npm test`.

   Files: (none)

## Risks

- Discovery walking a large monorepo at activation could be slow; the async walk, skip list (.git, node_modules, .baiton) and the maxDepth/maxEntries bounds must be honoured, and hitting a bound must only log, never fail activation.
- Skipping `.baiton` entirely is what keeps Baiton phase/run worktrees (which contain `.git` gitfiles) from being discovered as repos; if an executor instead only skips `.baiton/worktrees`, other Baiton-owned directories may still be walked — keep the whole-directory skip.
- Single-folder behaviour must stay byte-for-byte equivalent: the folder root must remain the primary even when it lacks `.baiton/` and a child has one, otherwise the initialize flow changes.
- ActivationState gains required fields; any code or test that constructs an ActivationState literal must be updated (currently only src/extension.ts does).
- Loading child-repo configs must never abort activation; only the primary config failure keeps the existing hard stop.
- Canonicalization: nested repo roots are derived by joining onto the canonicalized folder root without following symlinks, so they stay canonical; following symlinked dirs would both break this and risk cycles.
- commands.ts `resolveCommandRoot` still refuses ambiguous multi-root for Initialize/Config Panel; in a multi-root workspace with several `.baiton/` roots, the config panel may resolve no folder until the later commands phase — acceptable interim behaviour but should not crash.
- Repo naming for single vs multi-root ('.' vs folder name) becomes the identity later phases (repo hints, lock keys, labels) depend on; keep it exactly as specified.

## Acceptance

- src/activation/repoDiscovery.ts exists, imports neither `vscode` nor `fs`, and exports discoverRepos, repoFor, isWithinSubtree, repoByName, reposWithBaiton, the Repo/RepoSet/DiscoveryFs types and DISCOVERY_SKIP_DIRS; it is re-exported from src/activation/index.ts.
- The `multiple-baiton-roots` error kind and the 'exactly one .baiton root' wording no longer exist anywhere in src or test.
- resolveWorkspace takes a RepoSet and returns { restricted, repos, primary } where primary satisfies WorkspaceContext; single-folder resolves to the folder root with or without `.baiton/`; multi-root with several `.baiton/` repos succeeds.
- src/git/gitService.ts exports createGitServiceRegistry returning one memoized service per normalized repo root.
- src/extension.ts discovers repos, loads config for the primary (hard stop on failure as before) and every other `.baiton/` repo (warn and continue), runs crash recovery and .gitignore refresh per `.baiton/` repo against that repo's own baitonDir and git service, and stores repos/repoConfigs/git on ActivationState.
- test/activation.gating.test.ts covers discovery (nesting, gitfile repos, .baiton-only repos, skip list including Baiton worktrees, symlinks, bounds, multi-root naming/dedupe), repoFor, isWithinSubtree (self/descendant true; sibling/ancestor/unknown false), the new resolveWorkspace rules, and the git service registry; the existing config-panel wiring and other describe blocks still pass unchanged.
- `npm run compile`, `npm run lint` and `npm test` all pass.
