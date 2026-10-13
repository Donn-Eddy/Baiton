# Plan P05

## Steps

1. Add the optional prsMerged dependency to SubmitPrDeps

   In src/engine/submitPr.ts, add to `interface SubmitPrDeps` (next to `unlandedPhases`) a documented optional member:

   ```ts
   /**
    * Whether every recorded PR/MR URL of the plan reads merged. Consulted only for
    * `pr`/`pr-partial` plans with a non-empty recorded URL set; `repoForUrl` maps
    * URLs recorded under `prs:` to their repo key (absent = owner repo). A
    * rejection or `false` is treated as not merged, leaving today's flow intact.
    */
   prsMerged?: (urls: readonly string[], repoForUrl: ReadonlyMap<string, string>) => Promise<boolean>;
   ```

   A one-parameter function `(urls) => Promise<boolean>` stays assignable, so tests may pass the simpler shape. Extend the import from './transitions' to `{ isPartialPrStatus, planPrStatus, recordedPrUrls, reposToSubmit }` and the import from '../model/planActions' to `{ PR_PARTIAL_STATUS, PR_STATUS }`. Optionally add one sentence to the file header's step 1 list: "and refuses a `pr`/`pr-partial` plan whose recorded requests all read merged".

   Files: `src/engine/submitPr.ts`

2. Refuse a merged plan in checkReady

   In `checkReady` (src/engine/submitPr.ts), immediately after the existing `if (status === 'done') { ... }` block and before the `approved_rev` check, insert:

   ```ts
   if (deps.prsMerged !== undefined && (status === PR_STATUS || status === PR_PARTIAL_STATUS)) {
     const prs = plan.frontmatter.get('prs');
     const urls = recordedPrUrls(plan.frontmatter.get('pr'), prs);
     if (urls.length > 0) {
       const repoForUrl = new Map([...parsePrsValue(prs)].map(([name, url]) => [url.trim(), name] as const));
       const merged = await safe(() => deps.prsMerged!(urls, repoForUrl), false);
       if (merged === true) {
         return fail({ kind: 'not-ready', message: `plan "${slug}" has already been merged (${urls.join(', ')})` });
       }
     }
   }
   ```

   (Use a local `const check = deps.prsMerged;` instead of the non-null assertion if lint forbids `!`.) `safe` already exists in the file and turns a rejection into `false`; also guard a synchronous throw by wrapping in `safe(async () => check(urls, repoForUrl), false)`. Only a positive `true` refuses; `false`/rejection falls through to today's flow (including `pr-partial` retry). Nothing else in submitPr changes: the `findOpenByHead`/`create` paths, recordGroupedPr and the owner path are untouched, and no document is written on refusal.

   Files: `src/engine/submitPr.ts`

3. Wire the checker into submitPrForSlug

   In src/activation/commands.ts, `prToolForRoot` and `prsMergedForPlan` (added in P04, currently defined just after `submitPrForSlug`, ~lines 646-690) must be usable from `submitPrForSlug`. Move both const definitions (unchanged) to just above the `// Submit PR (design section 8)` comment / `const prKeyFor` line, so there is no use-before-define. Then in the `submitPr(slug, { ... })` deps object inside `submitPrForSlug`, add after `unlandedPhases`:

   ```ts
   prsMerged: (urls, repoForUrl) => prsMergedForPlan({ slug, urls, repoForUrl }),
   ```

   (`repo` is omitted: submitPrForSlug only serves plans owned by `repoRoot`, which `prsMergedForPlan` maps to the primary root.) prsMergedForPlan already degrades unresolvable provider/remote/CLI and stateByUrl failures to `unknown` -> not merged and never throws on those paths; submitPr additionally swallows rejections. Do not gate it on Restricted Mode and add no config keys. Do not change the existing provider-resolution error messages in submitPrForSlug (refactoring it onto prToolForRoot is not required in this phase).

   Files: `src/activation/commands.ts`

4. Single-repo submitPr tests

   In test/submitPr.test.ts add a helper that turns the fixture into a submitted plan, e.g.

   ```ts
   function markSubmitted(repo: Repo, status: 'pr' | 'pr-partial', url = 'https://example.test/pull/42'): void {
     const file = path.join(repo.legacySpecsDir, SLUG, 'spec.md');
     let text = fs.readFileSync(file, 'utf8');
     text = setFrontmatterKey(setFrontmatterKey(text, 'pr', url), 'status', status);
     fs.writeFileSync(file, text, 'utf8');
     git(repo.root, 'commit', '-q', '-am', `plan(${SLUG}): pr`);
   }
   ```
   (import `setFrontmatterKey` from '../src/model/writer'; the approval hash excludes frontmatter so approved_rev stays valid). Add, inside the existing `describe('submitPr (design section 8 "PR")')`:
   1. 'refuses a pr plan whose recorded PRs are all merged': markSubmitted(repo,'pr'); harness with `prsMerged: async (urls) => { seen.push([...urls]); return true; }`; assert result not ok, kind 'not-ready', message matches /already been merged/ and contains the URL; `seen` deep-equals [['https://example.test/pull/42']]; no terminals created, `h.pr.lookedUp` and `h.pr.created` empty; the spec file content is byte-identical to before the call.
   2. 'leaves the flow unchanged when merged state is unknown': markSubmitted(repo,'pr'); `prsMerged` rejects (throw new Error('offline')) -> submission proceeds past readiness (await the watcher like the 'reads unlanded phases' test, emitClose(1), assert error kind is not 'not-ready'); repeat with `async () => false`.
   3. 'never consults the checker for a plan that is not pr/pr-partial or records no URL': default fixture (status approved, empty pr) with a checker that records calls; assert zero calls (drive to the watcher and close it, or use a not-done phase fixture so it stops early — prefer `makeRepo(['done','executed'])` plus a separate approved/done fixture driven to the watcher). Also a `status: pr` fixture with empty `pr:` -> checker not called.
   Existing tests must remain untouched.

   Files: `test/submitPr.test.ts`

5. Multi-repo submitPr tests

   In test/submitPr.multiRepo.test.ts (harness at ~line 208 builds `deps`; tests mutate `h.deps` freely), add inside `describe('submitPr multi-repo flow')`:
   1. 'refuses resubmitting a multi-repo plan whose PRs are all merged': run the existing happy path (submitPr + draftAndFinish) so the plan records status 'pr' with prs for '.' and 'packages/api'; then set `h.deps.prsMerged = async (urls, repoForUrl) => { calls.push({ urls: [...urls], repoForUrl: new Map(repoForUrl) }); return true; }`; capture plan text; call submitPr again; assert not ok, kind 'not-ready', /already been merged/; `calls[0].urls` deep-equals ['https://example.test/owner/pull/1', 'https://example.test/api/pull/2']; repoForUrl maps the api URL to 'packages/api' (and owner URL to '.'); `h.watchers.created.length` still 1; ownerPr/childPr created and lookedUp counts unchanged; plan file byte-identical; last owner commit subject unchanged.
   2. 'keeps the partial retry when the merged state is unknown': reproduce the partial scenario (childPr.failCreate = true, first submit -> 'pr-partial'), then set `h.deps.prsMerged = async () => false` (and in a variant, a rejecting checker), clear failCreate, resubmit with draftAndFinish(h, pending, 2) and assert ok with status 'pr' exactly as the existing retry test does.
   3. A checker returning true for a 'pr-partial' plan also refuses (merged wins over retry) — optional but cheap: after the partial first submit, set prsMerged to `async () => true` and assert not-ready with no second watcher.

   Files: `test/submitPr.multiRepo.test.ts`

6. Verify

   Run `npm run compile`, `npm run lint`, then the focused suites `npx mocha --no-config --node-option no-strip-types --require ts-node/register test/submitPr.test.ts test/submitPr.multiRepo.test.ts` (the plain `--no-config` form trips Node's strip-only TS parser), then the full `npm test` (needs process spawning; the sandbox denies git subprocesses with EPERM). Finish with `git diff --check` and confirm `git diff --stat` touches only the four phase files.

   Files: (none)

## Risks

- Moving prToolForRoot/prsMergedForPlan above submitPrForSlug in commands.ts: they reference `ownerRepoName`, `activation`, `git`, `cfg`, `readGitSettings`, `readPrToolPath` — all defined earlier (ownerRepoName ~line 466), so the move is safe; leave the P04 PlanExplorer wiring (`{ prsMerged: prsMergedForPlan }` ~line 1215) unchanged.
- The merged check is placed before the approval/branch/clean-tree checks, so it can make a CLI call even for a plan that would otherwise be refused for another reason; this is intended (overview says 'after the existing done check') and is read-only.
- The check spawns gh/glab (up to 120 s timeout) during Submit PR for pr/pr-partial plans; that is acceptable here since submitPr is user-initiated and already awaits CLIs, but tests must stub `prsMerged` so no real CLI runs.
- Non-null assertion or `as` casts may trip the repo's lint rules; prefer a captured local `const check = deps.prsMerged` narrowed by the `!== undefined` guard.
- Tests that drive the flow to the watcher depend on real git in a temp repo; run them with process spawning enabled.
- TypeScript parameter bivariance: tests passing `async (urls) => true` to a two-parameter dep type is fine; do not make the second parameter required in a way that breaks P04 wiring.

## Acceptance

- `SubmitPrDeps` has an optional, documented `prsMerged` member; omitting it reproduces today's behaviour exactly (all existing submitPr tests pass unchanged).
- For a `pr` or `pr-partial` plan whose recorded URL set (recordedPrUrls(pr, prs)) is non-empty and the checker resolves true, submitPr returns `{ ok: false, error: { kind: 'not-ready', message: /plan "<slug>" has already been merged \(<urls>\)/ } }` without launching a terminal, calling findOpenByHead/create, pushing, committing or changing the plan file.
- A checker that resolves false or rejects leaves the flow unchanged, including the multi-repo `pr-partial` retry submitting only the failed repo.
- The checker is never invoked for plans whose status is not pr/pr-partial or that record no URL.
- The multi-repo checker receives every URL from `pr` + `prs` (deduplicated, stable order) and a repoForUrl map keyed by URL to the `prs` repo key.
- commands.ts passes `prsMerged: (urls, repoForUrl) => prsMergedForPlan({ slug, urls, repoForUrl })` into submitPr; no new config keys or settings; no Restricted Mode gate.
- `npm run compile` and `npm run lint` pass (only the pre-existing webviewProtocol.ts warning), the full `npm test` suite passes, `git diff --check` is clean, and only src/engine/submitPr.ts, src/activation/commands.ts, test/submitPr.test.ts and test/submitPr.multiRepo.test.ts change.
