# Plan P03

## Steps

1. Give SessionScope its own owner-aware plan variant

   In src/orchestrator/sessionStore.ts, replace `export type SessionScope = ConversationKind;` with a standalone union that stays a structural superset of ConversationKind, so every existing `ConversationKind` value, including `caller.kind` in subAgent.ts and the `{ kind: 'plan', slug }` literals in chatController.ts and the tests, is still assignable:

   ```ts
   export type SessionScope =
     | { kind: 'workspace' }
     | {
         kind: 'plan';
         slug: string;
         /** Owning repo of the plan, as a path relative to the conversation owner (PlanRepoInfo.path) or an absolute root. Absent or '.' = the owner repo. */
         repo?: string;
         /** Absolute `.baiton/` of the owning repo. Absent = the store's own baitonDir. Required when `repo` names a non-owner repo. */
         baitonDir?: string;
       };
   ```

   Keep the `import type { ConversationKind }` only if it is still used, and drop it if not, so lint stays clean. Do not import vscode. Do not import src/orchestrator/planRepos.ts either, because it pulls in git and guard. Add a small local helper instead:

   ```ts
   /** Whether a plan scope belongs to the conversation-owner repo. */
   export function isOwnerScope(scope: SessionScope): boolean {
     if (scope.kind === 'workspace') return true;
     const repo = scope.repo === undefined ? '.' : normalizeScopeRepo(scope.repo);
     return repo === '.';
   }
   ```

   Here `normalizeScopeRepo(repo)` trims the path, converts `\\` to `/`, applies `path.posix.normalize`, and strips trailing slashes except on `/` and drive roots. It maps '', '.' and './' to '.'. Mirror `normalizeRepoPath` in planRepos.ts so both layers spell repo paths identically. Add a one-line comment that says so.

   Files: `src/orchestrator/sessionStore.ts`

2. Make scopeId repo-qualified for non-owner plans, with an inverse

   Rewrite `scopeId` in src/orchestrator/sessionStore.ts:

   ```ts
   /** Separates the encoded repo from the slug in a non-owner plan's scope id. */
   export const SCOPE_REPO_SEPARATOR = ':';

   export function scopeId(scope: SessionScope): string {
     if (scope.kind === 'workspace') return 'workspace';
     if (isOwnerScope(scope)) return scope.slug;           // unchanged keys for owner plans
     return `${encodeURIComponent(normalizeScopeRepo(scope.repo!))}${SCOPE_REPO_SEPARATOR}${scope.slug}`;
   }
   ```

   The repo is URI-encoded because session keys are `<scopeId>/<sessionId>`, and `ChatController.sessionOfKey` and `sessionIdFromKey` split on the first '/'. A qualified id must therefore contain no '/'. Slugs match `[A-Za-z0-9._-]+`, so they contain neither ':' nor '%'. That means a qualified id can never equal a bare slug or 'workspace'. State this in the doc comment.

   Add the inverse, for later chat-controller phases and for tests:

   ```ts
   /** Decode a scope id back to its workspace/plan identity (no baitonDir: callers resolve that from the repo). Returns undefined for an empty or malformed id. */
   export function parseScopeId(id: string): { kind: 'workspace' } | { kind: 'plan'; slug: string; repo?: string } | undefined
   ```

   - 'workspace' maps to `{ kind: 'workspace' }`.
   - An id with no ':' maps to `{ kind: 'plan', slug: id }`.
   - Otherwise split on the last ':'. Decode the repo with `decodeURIComponent` inside try/catch, and return undefined on failure or when either side is empty. The result is `{ kind: 'plan', slug, repo }`.

   Update the `scopeId` JSDoc to say that owner-repo plans keep the bare slug, which is exactly today's value, and that other repos get `<encoded repo>:<slug>`.

   Files: `src/orchestrator/sessionStore.ts`

3. Resolve dirFor / legacyPathFor (and so pathFor, childrenDirFor, migrateLegacy) against the owning repo's .baiton

   In `SessionStore`, add a private helper:

   ```ts
   private baitonDirFor(scope: SessionScope): string {
     if (scope.kind === 'workspace') return this.baitonDir;
     if (scope.baitonDir !== undefined) return scope.baitonDir;
     if (!isOwnerScope(scope)) {
       throw new Error(`session scope for plan "${scope.slug}" in repo "${scope.repo}" has no baitonDir`);
     }
     return this.baitonDir;
   }
   ```

   - Change `dirFor` so its plan branch is `path.join(resolveDocument(this.baitonDirFor(scope), scope.slug).dir, 'chat')`. The workspace branch stays `path.join(this.baitonDir, 'chat')`.
   - Change `legacyPathFor` so its plan branch is `path.join(resolveDocument(this.baitonDirFor(scope), scope.slug).dir, 'chat.jsonl')`.
   - `pathFor`, `childrenDirFor`, `list`, `listChildren`, `listTree`, `createChild`, `ensureDir`, `delete`, `meta` and `migrateLegacy` already go through `dirFor`, `pathFor` and `legacyPathFor`, so they need no further change. Verify that none of them reads `this.baitonDir` directly.

   The result for an owner plan with no repo and no baitonDir, or with `repo: '.'`, is byte-identical to today. A plan scope may carry `baitonDir` equal to the store's own dir with `repo: '.'`. That is the owner case: its id is the bare slug and its paths match today's.

   Update the module header comment to name the layout: plan sessions live at `<owning repo>/.baiton/plans/<slug>/chat/<id>.jsonl`, or the legacy specs path, and the owner repo is the default.

   Files: `src/orchestrator/sessionStore.ts`

4. Thread the owning repo through the sub-agent runner

   In src/orchestrator/subAgent.ts:

   1. Widen `SubAgentRunnerDeps.readPlan` to `readPlan(slug: string, scope?: SessionScope): Promise<string | undefined>`, and update its doc comment so it says the scope carries the owning repo. The existing caller in chatController.ts, `(slug) => this.readPlanDocument(slug)`, still type-checks, so it needs no change in this phase.
   2. In the `systemPrompt` closure of `runTurn`, call `this.deps.readPlan(entry.scope.slug, entry.scope)` when `entry.scope.kind === 'plan'`.
   3. `spawn` and `send` take `scope = caller.kind`. `ToolCaller.kind` is `ConversationKind`, which is assignable to `SessionScope`. At runtime the object is the full scope that the controller passed, including `repo` and `baitonDir`, because `runTurn` passes `kind: entry.scope` back into `ToolCaller`. Leave this flow as it is, and add a short comment that the scope object, with its repo and baitonDir, is carried unchanged through `ToolCaller.kind`. Do not add a cast. Passing `entry.scope` where `ConversationKind` is expected (`kind: entry.scope`, and the first argument of `buildSubAgentPrompt`) must still compile. If TS rejects the union because the field sets differ, narrow it with a small `toConversationKind(scope)` helper in subAgent.ts that returns the same object typed as ConversationKind: `return scope as ConversationKind`, with a comment that the extra fields are intentional.
   4. Update the doc comments of `chatSessionKey` and `sessionIdFromKey`. A key is `<scopeId>/<sessionId>`, scopeId never contains '/', so keys from different repos' same-slug plans never collide. The function bodies stay unchanged.

   Files: `src/orchestrator/subAgent.ts`

5. Document the qualified scope id on interventions

   In src/orchestrator/interventions.ts, update the doc comments only, with no runtime change:

   - `Intervention.scopeId` becomes: "Conversation scope the card belongs to: the `scopeId()` of its session scope ('workspace', a bare slug for an owner-repo plan, or `<encoded repo>:<slug>` for a plan in another repo)."
   - `InterventionOrigin.rootKey` and `chatKey` note that `<scopeId>` follows the same rule.

   Keep the file free of a sessionStore import, so there are no new dependencies.

   Files: `src/orchestrator/interventions.ts`

6. Unit tests for owner-aware scopes

   In test/sessionStore.test.ts, add cases. Use `newStore()` plus a second temp `.baiton` (`childBaiton`) holding `plans/my-plan/plan.md` and `specs/legacy-child/spec.md`.

   (a) Owner compatibility: for `{kind:'plan',slug:'my-plan'}`, `{...,repo:'.'}`, `{...,repo:'./'}` and `{...,repo:'.',baitonDir}` (the store's own dir), `scopeId` is 'my-plan', and `dirFor`, `pathFor(s,'a')`, `childrenDirFor(s,'a')` and `legacyPathFor` equal the paths built from `baitonDir/plans/my-plan`. Assert literal joined paths, not store calls. Do the same for the legacy spec scope under `specs/`.

   (b) A child scope `{kind:'plan',slug:'my-plan',repo:'packages/child',baitonDir:childBaiton}` gives:
   - `scopeId` equal to 'packages%2Fchild:my-plan', which contains no '/' and differs from 'my-plan';
   - `dirFor` under `childBaiton/plans/my-plan/chat`;
   - `pathFor(s,'p/c')` equal to `childBaiton/plans/my-plan/chat/p.children/c.jsonl`;
   - `legacyPathFor` equal to `childBaiton/plans/my-plan/chat.jsonl`;
   - the legacy spec slug resolving under `childBaiton/specs/legacy-child/chat`.

   (c) Same slug, two repos: write a session in the owner scope and a different one in the child scope. Each `list()` returns only its own session, and `delete` in one leaves the other intact.

   (d) `migrateLegacy` on the child scope moves `childBaiton/plans/my-plan/chat.jsonl` into the child's chat folder and leaves the owner's legacy file untouched.

   (e) `createChild` and `listTree` on the child scope create `.children` folders only under childBaiton.

   (f) A non-owner repo with no baitonDir throws from `dirFor`.

   (g) `parseScopeId` round-trips with `scopeId` for 'workspace', an owner slug, and child repos including nested paths and an absolute path such as '/abs/repo'. It returns undefined for '', ':slug', 'repo:' and a malformed percent escape such as '%E0%A4%A:x'.

   Keep the existing 'scopeId names the workspace scope and each plan by slug' test unchanged.

   Files: `test/sessionStore.test.ts`

7. Property tests for scope identity and path compatibility

   In test/sessionStore.property.test.ts, add a `describe('SessionScope identity properties')` block that uses fast-check, with:

   - `slugArb` built with `fc.stringMatching(/^[A-Za-z0-9._-]{1,20}$/)`, filtered to exclude '.', '..' and 'workspace';
   - `repoArb` drawing segments from `[A-Za-z0-9._-]` (excluding '.' and '..'), joined by '/' to depth 1–3, optionally prefixed with '/'.

   Properties:

   1. For any slug, `scopeId({kind:'plan',slug})`, `scopeId({kind:'plan',slug,repo:'.'})` and `scopeId({kind:'plan',slug,repo:'.',baitonDir:ownerDir})` all equal `slug`. `dirFor` and `legacyPathFor` for all three equal `path.join(ownerDir,'plans',slug,'chat')` and `path.join(ownerDir,'plans',slug,'chat.jsonl')` when no specs folder exists for the slug. Use a fixed temp ownerDir created once with only a `plans/` folder.
   2. For any slug and non-owner repo, the child scopeId contains no '/', differs from every bare slug (it contains ':'), and `parseScopeId(scopeId(s))` deep-equals `{kind:'plan',slug,repo:normalized repo}`.
   3. Injectivity: for two (repo, slug) pairs, scopeIds are equal iff the normalized repo and the slug are equal. Treat owner repos ('.' or undefined) as one repo.
   4. For any session id from the existing `sessionArb` id generator, `pathFor(childScope, id)` starts with `childBaitonDir + path.sep`, and `pathFor(ownerScope, id)` starts with `ownerDir + path.sep`.

   Keep `numRuns` modest (for example 100) to match the existing properties in the file.

   Files: `test/sessionStore.property.test.ts`

8. Build, lint and run the suites

   Run `npm run compile` (tsc), `npm run lint`, `npm run test:unit` and `npm run test:property`, or the full `npm test`. Fix any type error at call sites of `SessionScope` or `SubAgentRunnerDeps.readPlan`. Expect none, because the new fields are optional. Confirm with grep that no `vscode` import entered src/orchestrator/sessionStore.ts, subAgent.ts or interventions.ts. Do not change chatController.ts behaviour in this phase. It keeps building `{kind:'plan',slug}` scopes, which still resolve exactly as today.

   Files: (none)

## Risks

- Session keys are split at the first '/' (ChatController.sessionOfKey, sessionIdFromKey). A qualified scopeId built with formatPlanRef ('packages/child:slug') would break those splits, which is why the repo is URI-encoded. Any later phase that derives keys must use scopeId() and not formatPlanRef.
- SessionScope stops being an alias of ConversationKind. If TS rejects assigning SessionScope (with optional repo/baitonDir) to ConversationKind in subAgent.ts (`kind: entry.scope`, buildSubAgentPrompt), a narrowing helper is needed. Excess-property checks only hit object literals, so this should compile, but verify it.
- ChatController.sessionOfKey still rebuilds `{kind:'plan', slug: scopeKey}` from a key. For a child scope that would produce a bare-slug scope with the qualified string as its slug, which points to the wrong directory. That is harmless now, because nothing creates child scopes yet, but the chat-controller phase must switch it to parseScopeId plus a repo-to-baitonDir lookup.
- normalizeScopeRepo duplicates planRepos.normalizeRepoPath. If the two drift apart, the same repo could get two scopeIds. Add a test asserting they agree on sample inputs, or have the later phase import one from the other once the dependency direction allows it.
- A scope that carries a non-owner repo without baitonDir throws. Callers in later phases must always populate baitonDir for child-repo plans.

## Acceptance

- `npm run compile`, `npm run lint` and the full `npm test` (unit plus property) pass.
- For an owner-repo plan scope (no repo, repo '.', or repo '.' with the store's own baitonDir), scopeId equals the bare slug, and dirFor, pathFor, childrenDirFor and legacyPathFor equal today's paths under the store's baitonDir, for both plans/ and legacy specs/ documents. The existing sessionStore tests pass unmodified.
- A plan scope with a non-owner repo and baitonDir resolves every transcript path (top-level, children and legacy chat.jsonl) under that baitonDir, and its scopeId is `<encodeURIComponent(repo)>:<slug>`, containing no '/'.
- An owner plan and a child-repo plan with the same slug list, migrate and delete independently, each in its own repo's .baiton.
- parseScopeId inverts scopeId for workspace, owner and child scopes, and returns undefined for malformed ids.
- SubAgentRunnerDeps.readPlan receives the session scope as its second argument, and existing callers compile unchanged.
- No vscode import in src/orchestrator/sessionStore.ts, subAgent.ts or interventions.ts.
