# Plan P04

## Steps

1. Context: what P01–P03 already provide (do not re-implement)

   Already on the branch: `src/engine/prTool.ts` exports `PrState = 'open'|'merged'|'closed'|'unknown'`, `parsePrsValue(raw)` (JSON object string -> Map<repoName,url>), and `PrTool.stateByUrl?(url): Promise<PrState>` which NEVER rejects (unparsable URL / CLI failure -> 'unknown'); `createPrTool({kind, executable, repoRoot, run?})` implements it for gh and glab. `src/engine/transitions.ts` exports `recordedPrUrls(pr: string|undefined, prs: string|undefined): string[]` (pr first, then prs values in key order, trimmed, deduped) and `planPrsMerged(recorded, observed: ReadonlyMap<string,PrState>): boolean` (true iff non-empty and every url observed 'merged'). `src/model/treeModel.ts` `PlanInput` already has `prsMerged?: boolean` and `buildPlanNode` threads it into `planGroupKind` and `legalPlanActions` (merged pr/pr-partial -> group 'completed', actions ['showPr']). `transitions.ts` imports only `../model/planActions` and `./prTool` (no vscode), so it is safe to import directly from the explorer. `PR_STATUS` ('pr') and `PR_PARTIAL_STATUS` ('pr-partial') are exported from `src/model/planActions.ts`. This phase only touches `src/activation/planExplorer.ts`, `src/activation/commands.ts`, `test/planExplorer.test.ts`. Do NOT edit `src/engine/submitPr.ts` (SubmitPrDeps has no `prsMerged` field yet; that is a separate phase) and do not pass anything new to `submitPr(...)`.

   Files: (none)

2. planExplorer.ts: add the injected checker type and option

   In `src/activation/planExplorer.ts`:
   1. Add imports: `import { parsePlan } from '../model/parser';`, `import { PR_PARTIAL_STATUS, PR_STATUS } from '../model/planActions';` (merge into the existing `planContextValue` import), `import { recordedPrUrls } from '../engine/transitions';` and `import { parsePrsValue } from '../engine/prTool';` (import from the module files, not the `../engine` barrel, which is only imported as a type today).
   2. Export a query type with a doc comment:
   ```ts
   /** What the explorer asks the PR-state checker about one plan. */
   export interface PrsMergedQuery {
     slug: string;
     /** The repository that owns the plan document; undefined for the primary (single-source) repo. */
     repo?: string;
     /** The recorded URL set: `recordedPrUrls(pr, prs)`, non-empty. */
     urls: readonly string[];
     /** For URLs recorded under `prs:`, the repo key they were recorded for; URLs absent here belong to the owning repo. */
     repoForUrl: ReadonlyMap<string, string>;
   }
   /** Resolves true only when every recorded request reads merged; may reject (treated as not merged). */
   export type PrsMergedChecker = (query: PrsMergedQuery) => Promise<boolean>;
   ```
   3. Extend `PlanExplorerOptions` with `prsMerged?: PrsMergedChecker;` with a doc comment saying it is consulted at most once per owning repo + slug + URL set per explorer instance, never awaited by refresh, and only for plans whose trimmed status is `pr`/`pr-partial` with a non-empty URL set.

   Files: `src/activation/planExplorer.ts`

3. planExplorer.ts: per-session memo and non-blocking lookup

   Add private state to `PlanExplorer`:
   ```ts
   /** Per-session PR completeness memo, keyed by owning repo + slug + URL set; holds in-flight checks too. */
   private readonly prsMergedMemo = new Map<string, { merged?: boolean }>();
   /** Plans (repo + slug) whose PR check failure has already been logged this session. */
   private readonly prsMergedLogged = new Set<string>();
   private disposed = false;
   ```
   Set `this.disposed = true` at the top of `dispose()`.

   Add a private method `private prsMergedFor(slug: string, repo: string | undefined, raw: string | undefined): boolean`:
   - If `this.options.prsMerged === undefined` or `raw === undefined` return false.
   - `let frontmatter; try { frontmatter = parsePlan(raw).frontmatter; } catch { return false; }`.
   - `const status = frontmatter.get('status')?.trim();` if status is not `PR_STATUS` and not `PR_PARTIAL_STATUS` return false (no query for pending/approved/in-progress/done/unset).
   - `const prs = frontmatter.get('prs'); const urls = recordedPrUrls(frontmatter.get('pr'), prs);` if `urls.length === 0` return false.
   - `const key = [repo ?? '', slug, ...urls].join('\u0000');` look up memo. If an entry exists return `entry.merged === true` (in-flight entries have `merged` undefined -> false; this also dedups concurrent refreshes).
   - On a miss: build `repoForUrl` as `new Map([...parsePrsValue(prs)].map(([r, u]) => [u.trim(), r]))`; create `const entry: { merged?: boolean } = {}; this.prsMergedMemo.set(key, entry);` then start the check WITHOUT awaiting it:
   ```ts
   let check: Promise<boolean>;
   try { check = Promise.resolve(this.options.prsMerged({ slug, ...(repo !== undefined ? { repo } : {}), urls, repoForUrl })); }
   catch (e) { check = Promise.reject(e); }
   void check.then(
     (merged) => { entry.merged = merged === true; if (entry.merged && !this.disposed) void this.refresh(); },
     (e) => { entry.merged = false; this.logPrsMergedFailure(slug, repo, e); },
   );
   return false;
   ```
   (The synchronous try/catch guards a checker that throws synchronously.) Unknown/false results are memoised as `merged: false` and never re-queried for that key; a changed URL set produces a new key, which re-arms the check.

   Add `private logPrsMergedFailure(slug, repo, e)`: `const id = `${repo ?? ''}\u0000${slug}`; if (this.prsMergedLogged.has(id) || this.disposed) return; this.prsMergedLogged.add(id); try { this.surface.warn(`Baiton: could not read PR state for plan "${slug}"${repo === undefined ? '' : ` in ${repo}`}: ${describe(e)}.`); } catch { /* logging must never escape */ }` — use `warn` (Surface.warn logs to the output channel with a WARN prefix; check `src/activation/surface.ts` that `warn` does not pop a notification — if it does, use `this.surface.log` instead so the failure stays log-only).

   Files: `src/activation/planExplorer.ts`

4. planExplorer.ts: feed the fact into refresh

   In `refresh()`, inside the `listed.map(async (entry) => { ... })` object literal, add `prsMerged: this.prsMergedFor(entry.slug, source.repo, entry.readError === undefined ? entry.raw : undefined),`. It is synchronous and never awaits the CLI, so refresh latency is unchanged. Use `source.repo` (the owning source's repo, undefined in single-source mode) for both the memo key and the query. Leave the `seq !== this.refreshSeq` superseding logic unchanged; the refresh triggered after a `true` settle simply re-reads disk and now gets a memo hit. Update the class/file doc comment briefly: Completed also includes `pr`/`pr-partial` plans whose recorded requests all read merged, derived via the injected checker, never persisted. No file writes, no store calls are added.

   Files: `src/activation/planExplorer.ts`

5. commands.ts: a PrTool resolver helper and the prsMerged checker

   In `registerCommands` in `src/activation/commands.ts`, after `submitPrForSlug` is defined (it needs `git`, `cfg`, `activation`), add a local helper mirroring `submitPrForSlug`'s provider resolution but returning undefined on any failure:
   ```ts
   /** The PR tool for a repo root over its configured remote, or undefined when pr.tool, the remote or the CLI cannot be resolved. Read-only; not gated on Restricted Mode. */
   const prToolForRoot = async (root: string, remote: string): Promise<PrTool | undefined> => {
     const selection = cfg().pr?.tool ?? DEFAULT_PR_TOOL;
     if (!isPrToolSelection(selection)) return undefined;
     const rootGit = path.resolve(root) === path.resolve(repoRoot) ? git : activation.git?.forRepo(root) ?? createGitService(root);
     let remoteUrl: string;
     try { remoteUrl = await rootGit.remoteUrl(remote); } catch { return undefined; }
     const kind = selectProvider(selection, remoteUrl);
     const executable = resolveProviderExecutable(kind, { override: readPrToolPath() });
     return executable === undefined ? undefined : createPrTool({ kind, executable, repoRoot: root });
   };
   ```
   Leave `submitPrForSlug` and its `repoSettings` body untouched (their distinct user-facing error messages must not change); the helper duplicates the four resolution steps on purpose.

   Then add the checker:
   ```ts
   /** Whether every recorded PR/MR of a plan reads merged; unresolvable repo/provider or any failure -> not merged. */
   const prsMergedForPlan: PrsMergedChecker = async ({ repo, urls, repoForUrl }) => {
     const rootFor = (name: string | undefined): string | undefined =>
       name === undefined ? repoRoot : activation.repos?.repos.find((r) => r.name === name)?.root;
     const remoteFor = (name: string | undefined): string =>
       (name !== undefined ? activation.repoConfigs?.get(name)?.git?.remote : undefined) ?? readGitSettings().remote;
     const tools = new Map<string, Promise<PrTool | undefined>>();
     const toolFor = (name: string | undefined): Promise<PrTool | undefined> => {
       const root = rootFor(name);
       if (root === undefined) return Promise.resolve(undefined);
       const key = path.resolve(root);
       let tool = tools.get(key);
       if (tool === undefined) { tool = prToolForRoot(root, remoteFor(name)).catch(() => undefined); tools.set(key, tool); }
       return tool;
     };
     const observed = new Map<string, PrState>(await Promise.all(urls.map(async (url): Promise<[string, PrState]> => {
       const tool = await toolFor(repoForUrl.get(url) ?? repo);
       const state = await tool?.stateByUrl?.(url).catch(() => 'unknown' as const);
       return [url, state ?? 'unknown'];
     })));
     return planPrsMerged(urls, observed);
   };
   ```
   Notes: for a `prs` key equal to the owner repo's name, `rootFor` resolves through `activation.repos` (and falls back to undefined -> unknown if repos is absent; to keep the common single-repo case working, also treat a name whose resolved root is missing but equals `ownerRepoName()` as `repoRoot`: `name === undefined || name === ownerRepoName() ? repoRoot : ...`). Add imports: `planPrsMerged` and types `PrTool`, `PrState` from `'../engine'` (check the barrel re-exports `./transitions` and `./prTool` — it does: `export * from './transitions'`, `export * from './prTool'`), and `type PrsMergedChecker` from `'./planExplorer'` (extend the existing `import { PlanExplorer, treeNodeTarget, type TreeNode } from './planExplorer';`). Do not add config keys or settings; do not check `workspace.restricted`.

   Files: `src/activation/commands.ts`

6. commands.ts: pass the checker to the explorer

   Change the construction at `const explorer = new PlanExplorer(baitonDir, planStore, surface, workspace.restricted, (slug) => chatController.setActivePlan(slug))` to add a sixth argument `{ prsMerged: prsMergedForPlan }`. Do not add `sources` (keep current single-source behaviour). Do not wire anything into `submitPr` in this phase (its deps type lacks the field); leave `prsMergedForPlan` as a named const so the later submit-readiness phase can adapt it.

   Files: `src/activation/commands.ts`

7. test/planExplorer.test.ts: make watcher events triggerable and surfaces loggable

   In the `beforeEach` fake, capture watcher callbacks so tests can force a refresh: change `createFileSystemWatcher` so `onDidCreate/onDidChange/onDidDelete` store the passed listener on the `watcher` record (e.g. `onDidChange: (cb: () => void) => { watcher.change = cb; return { dispose: () => undefined }; }`), matching the already-declared `watchers` element type `{ create?, change?, del?, disposed }`. Add a helper `fireChange()` that calls `change?.()` on every non-disposed watcher (refresh fires after the 500 ms debounce; `waitFor`'s 2 s deadline covers it; give the new tests `this.timeout(5000)` via `function () {}` style or a describe-level timeout if needed). Add a helper `writePlan(slug, frontmatterLines)` that writes `plans/<slug>/plan.md` as `['---', ...frontmatterLines, '---', validPlan()].join('\n')`. New-test surfaces: `const warnings: string[] = []; const surface = { error: () => undefined, warn: (m: string) => warnings.push(m), log: (m: string) => warnings.push(m) } as unknown as Surface;`. Helper `groupSlugs()` returning slugs per group (as in the existing grouping test). Existing tests must stay byte-identical in behaviour (they pass no `prsMerged`).

   Files: `test/planExplorer.test.ts`

8. test/planExplorer.test.ts: new cases

   Add these `it` blocks (each with a recording fake checker `const calls: PrsMergedQuery[] = []`):
   1. 'groups a pr plan Completed when its recorded PRs all read merged, without writing the document': write `merged` with `status: pr`, `pr: https://github.com/o/r/pull/1`; also `prdone` with `status: done` + a pr URL, `prnourl` with `status: pr` and no pr, plus the default alpha (no status) and beta (legacy draft). Checker resolves `true`. Snapshot `fs.readFileSync` bytes of `merged`'s plan.md before start. Wait until `merged` is in the Completed group (refresh scheduled after settle). Assert: `calls.length === 1`, `calls[0].slug === 'merged'`, `calls[0].urls` deep-equals `['https://github.com/o/r/pull/1']`, `calls[0].repo === undefined`; no call for alpha/beta/prdone/prnourl; the plan item's `contextValue === planContextValue(['showPr'])`; its description still shows status `pr`; file bytes unchanged.
   2. 'memoises the check per URL set and re-arms when the URL set changes': same `merged` plan, checker returns true. After it lands in Completed, call `fireChange()` twice (wait for each refresh, e.g. wait ~700 ms via waitFor on a counter of `onDidChangeTreeData` fires) and assert `calls.length` stays 1. Then rewrite the plan with `pr: https://github.com/o/r/pull/2`, `fireChange()`, wait until `calls.length === 2` and assert `calls[1].urls` is `['.../pull/2']`.
   3. 'does not block refresh on a hung check': checker returns `new Promise(() => {})`. Assert the tree populates (alpha/beta listed), the `pr` plan is NOT in Completed, `calls.length === 1`, and after `fireChange()` + refresh `calls.length` is still 1 (in-flight memo shared).
   4. 'treats a failed check as not merged and logs once': checker `async () => { throw new Error('offline'); }` (also cover a synchronous `() => { throw ... }` variant in the same or a separate test). Assert the plan stays out of Completed, `warnings.length === 1` and mentions the slug, and after two `fireChange()` refreshes `warnings.length` is still 1 and `calls.length` still 1; no unhandled rejection.
   5. 'requires every recorded URL in prs to be merged': write `multi` with `status: pr-partial`, `pr: https://github.com/o/r/pull/1`, `prs: {".":"https://github.com/o/r/pull/1","packages/api":"https://github.com/o/api/pull/3"}`. Checker records the query and resolves `query.urls.every(u => !u.endsWith('/3'))` (i.e. false). Assert `calls[0].urls` deep-equals both URLs deduped in order, `calls[0].repoForUrl.get('https://github.com/o/api/pull/3') === 'packages/api'`, and the plan is not Completed. Then a second explorer instance with a checker resolving true shows it Completed with contextValue `planContextValue(['showPr'])` (no submitPr for pr-partial).
   Import `type PrsMergedQuery` via `PlanExplorerModule` types (e.g. `Parameters<NonNullable<import('../src/activation/planExplorer').PlanExplorerOptions['prsMerged']>>[0]`) or a type-only import from '../src/activation/planExplorer' (type-only imports are erased, so they don't break the dynamic-import loader setup).

   Files: `test/planExplorer.test.ts`

9. Verify

   Run `npm run compile` (or `npx tsc --noEmit -p .`), `npm run lint` (one pre-existing warning in src/orchestrator/webviewProtocol.ts:678 is expected), the focused test `npx mocha --no-config --require ts-node/register test/planExplorer.test.ts` (repository mocha config otherwise expands to the full suite), then the full `npm test` (needs process-spawn permission; sandboxed runs fail with EPERM unrelated to this change), and `git diff --check`. Confirm `git diff --stat` lists only the three phase files.

   Files: (none)

## Risks

- Surface.warn may show a user notification rather than only logging; if so, use surface.log so a PR-state failure stays a single log line per plan per session.
- Existing test surfaces are `{ error }` casts; the failure-log path must only run when a checker is injected (and is wrapped in try/catch) so existing tests never hit a missing `warn`.
- Triggering refresh after a `true` settle while the explorer is disposed would fire a disposed emitter; guard with the `disposed` flag.
- Debounced watcher refreshes take 500 ms; the new tests must wait for refresh completion (e.g. count onDidChangeTreeData fires) rather than fixed sleeps, and may need a raised mocha timeout.
- Repo-name resolution for `prs:` keys relies on activation.repos; when repos are absent (lightweight fixtures) or a key is unknown, the URL becomes 'unknown' and the plan stays out of Completed — this is the intended fail-soft behaviour, but the owner repo's own key must map to repoRoot via ownerRepoName() so single-repo plans recorded under prs still resolve.
- Importing `../engine` barrel at runtime from planExplorer could pull heavy modules into the explorer test loader; import `recordedPrUrls`/`parsePrsValue` from the specific module files instead.
- The spec suggests refactoring submitPrForSlug to share the resolver; doing so risks changing its user-facing error strings and existing tests, so the plan deliberately adds a separate helper and leaves submitPrForSlug untouched.
- submitPr readiness wiring (SubmitPrDeps.prsMerged) is out of this phase's file list; passing it now would not compile.

## Acceptance

- `PlanExplorerOptions` has an optional `prsMerged` checker; `PrsMergedQuery`/`PrsMergedChecker` are exported with doc comments.
- During refresh, only plans whose trimmed status is `pr` or `pr-partial` and whose `recordedPrUrls(pr, prs)` set is non-empty invoke the checker; tests assert no call for no-status, draft, done, and pr-without-URL plans.
- The checker is invoked at most once per owning repo + slug + URL set per explorer instance, including while in flight; changing the URL set triggers exactly one new call (tested).
- Refresh never awaits the checker: a never-settling checker still lets the tree populate, with the plan outside Completed (tested).
- A checker resolving true causes a follow-up refresh that places the plan under Completed with contextValue `planContextValue(['showPr'])`, including for `pr-partial`; the plan document bytes are unchanged (tested).
- A rejecting or synchronously throwing checker leaves the plan where it is today, logs exactly once per plan per session, and nothing escapes refresh (tested).
- Multi-URL plans pass every deduplicated URL plus a repoForUrl map for `prs:` entries; one non-merged URL keeps the plan out of Completed (tested).
- commands.ts builds `prsMergedForPlan` from cfg().pr.tool, the configured git remote (per-repo remote from repoConfigs), selectProvider, resolveProviderExecutable with readPrToolPath(), createPrTool and stateByUrl, applies planPrsMerged, returns false on any unresolvable step, is not gated on Restricted Mode, and passes it to `new PlanExplorer(..., { prsMerged: prsMergedForPlan })`; submitPrForSlug behaviour and messages are unchanged.
- No new config keys or VS Code settings; only src/activation/planExplorer.ts, src/activation/commands.ts and test/planExplorer.test.ts change.
- `npm run compile` and `npm run lint` pass (only the pre-existing warning), `test/planExplorer.test.ts` passes, the full `npm test` passes with all existing tests unchanged, and `git diff --check` is clean.
