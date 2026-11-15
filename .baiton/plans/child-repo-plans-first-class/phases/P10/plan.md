# Plan P10

## Steps

1. Add an owner-qualified plan identity and a plan-owner seam to ChatControllerDeps

   In src/activation/chatController.ts:
   - Export `interface ChatPlanIdentity { repo: string; slug: string }`. `repo` is a PlanRepoInfo.path (relative to the conversation owner, '.' = owner repo, or an absolute root) — the same spelling SessionScope.repo uses.
   - Export `interface ChatPlanOwner { repo: string; baitonDir: string }`.
   - Add an optional dep to ChatControllerDeps: `planOwners?(): readonly ChatPlanOwner[];` documented as "every discovered repo with a .baiton/ that can own plans, owner ('.') first; absent = only the owner repo at `baitonDir`".
   - Import `normalizeRepoPath` and `formatPlanRef` from '../orchestrator/planRepos', `parseScopeId` and `isOwnerScope` from the orchestrator barrel (or '../orchestrator/sessionStore' if the barrel lacks them), and `listPlansAcrossRepos` from './planLister' (keep `listPlans` only if still used).
   - Add private helpers:
     - `owners(): ChatPlanOwner[]` → `[{ repo: '.', baitonDir: this.deps.baitonDir }, ...(this.deps.planOwners?.() ?? []).filter(o => normalizeRepoPath(o.repo) !== '.')]` (owner always first and always backed by deps.baitonDir so owner paths are unchanged).
     - `normalizePlan(p: ChatPlanIdentity | string): ChatPlanIdentity` — a string is a bare slug meaning the owner plan `{ repo: '.', slug }`; otherwise `{ repo: normalizeRepoPath(p.repo) ?? p.repo, slug: p.slug }`.
     - `isOwnerPlan(p)` → `p.repo === '.'`.
     - `baitonDirFor(repo: string): string | undefined` → '.' → deps.baitonDir; else the matching (normalized) entry of `owners()`; else undefined.
     - `scopeOf(plan: ChatPlanIdentity): SessionScope | undefined` → owner plan returns EXACTLY `{ kind: 'plan', slug }` (no repo, no baitonDir, so scopeId/dirFor/legacyPathFor are byte-identical to today); non-owner returns `{ kind: 'plan', slug, repo, baitonDir }` or undefined when baitonDirFor misses.
     - `planOfScope(scope: SessionScope): ChatPlanIdentity | undefined` → workspace → undefined; plan → `{ repo: isOwnerScope(scope) ? '.' : normalizeRepoPath(scope.repo!)!, slug }`.
     - `scopeFromId(id: string): SessionScope | undefined` → `parseScopeId(id)`; workspace → `{kind:'workspace'}`; plan without repo → `{ kind: 'plan', slug }`; plan with repo → `scopeOf({ repo, slug })` (undefined if the repo is not a known owner).
     - `conversationKindFor(plan)`: owner → `{ kind: 'plan', slug }`; else `{ kind: 'plan', slug, repo }` (owner prompts stay byte-identical because P05's prompt only adds owner framing when repo is non-'.').

   Files: `src/activation/chatController.ts`

2. Convert activePlan and every site that reads it to ChatPlanIdentity

   In src/activation/chatController.ts change `private activePlan: string | undefined` to `private activePlan: ChatPlanIdentity | undefined` and update each site:
   - `setActivePlan(plan: ChatPlanIdentity | string | undefined)`: normalize via normalizePlan; for a non-owner plan whose `scopeOf` is undefined, log `Baiton chat: unknown plan repo "<repo>" for <formatPlanRef(repo, slug)>` and return without changing state. No-op when the new scopeId equals the current `scopeId(this.activeScope())` (compare identities, not object references). Then assign and `void this.refresh()`. Keep the string overload so existing callers/tests (`setActivePlan('alpha')`) keep working.
   - `activeScope()`: `this.activePlan === undefined ? { kind: 'workspace' } : this.scopeOf(this.activePlan)!` (activePlan is only ever set to a resolvable identity).
   - `activeConversationId()`: `scopeId(this.activeScope())` (returns 'workspace' == WORKSPACE_CONVERSATION_ID, the bare slug for owner plans, `<encoded repo>:<slug>` otherwise).
   - `onSelectConversation(conversationId)`: WORKSPACE_CONVERSATION_ID → `setActivePlan(undefined)`; else `const scope = this.scopeFromId(conversationId)`; if undefined or workspace, log and return; else `setActivePlan(this.planOfScope(scope))`.
   - `sessionOfKey(key)`: replace the `{ kind: 'plan', slug: scopeKey }` construction with `this.scopeFromId(scopeKey)`; return undefined when it does not resolve (sub-agent keys for child plans are `<encoded repo>:<slug>/<id>`; encodeURIComponent keeps '/' out of the scope part so splitting at the first '/' stays correct).
   - `scopeForAsk(ask)`: if `ask.scopeId === undefined || ask.scopeId === scopeId(this.activeScope())` return activeScope(); else `const scope = this.scopeFromId(ask.scopeId)`; when it is undefined or workspace, return activeScope() (log the unknown id); otherwise set `this.activePlan = this.planOfScope(scope)`, `await this.refresh()`, return activeScope(). Remove the old `slug === this.activePlan` comparison.
   - `onSetMode` / `effectiveMode` keep `this.activePlan !== undefined` / `=== undefined` checks (unchanged semantics).
   - `onSend`, `compactContext`, `refresh` (the seedContextEstimate call): replace `const slug = this.activePlan` with `const plan = this.activePlan` and pass `plan` through.
   - Change signatures: `buildPrompt(plan: ChatPlanIdentity | undefined, mode)`, `stepForConversation(plan: ChatPlanIdentity | undefined)`, `seedContextEstimate(key, plan: ChatPlanIdentity | undefined, history)`. In buildPrompt use `const kind = plan === undefined ? { kind: 'workspace' } : this.conversationKindFor(plan)` and `readPlanDocument(plan)`; in stepForConversation use `conversationStepFor(this.conversationKindFor(plan), await this.readPlanDocument(plan))`.
   - `readPlanDocument(plan: ChatPlanIdentity, baitonDir?: string)`: `const dir = baitonDir ?? this.baitonDirFor(plan.repo)`; undefined dir → return undefined; else `resolveDocument(dir, plan.slug).documentPath` read as today.
   - Sub-agent runner wiring in the constructor: `readPlan: (slug, scope) => scope?.kind === 'plan' ? this.readPlanDocument(this.planOfScope(scope) ?? { repo: '.', slug }, scope.baitonDir) : this.readPlanDocument({ repo: '.', slug })`.
   - `callTool` already passes `kind: scope`; the non-owner scope now carries repo/baitonDir, which is structurally a ConversationKind with the owning repo — leave as is (owner scopes are unchanged).
   - `migrate`, `postSessions`, `setActiveSession`, `newSessionId`, `viewKey`, `cardVisible`, `presentIntervention`, transcriptFor already key on `scopeId(scope)` / scope paths; they need no change beyond receiving the qualified scope. The sessionMemory key therefore becomes the new scopeId automatically: bare slug for owner plans (unchanged `baiton.chat.session.<slug>`), `<encoded repo>:<slug>` otherwise.
   - Update the doc comment on `activePlan` and `setActivePlan` to describe the (repo, slug) identity.

   Files: `src/activation/chatController.ts`

3. List conversations across every plan-owning repo

   Rewrite `buildConversationItems()` in src/activation/chatController.ts:
   ```ts
   const listed = await listPlansAcrossRepos(this.owners().map(o => ({ repo: o.repo, baitonDir: o.baitonDir })));
   const items: ConversationItem[] = [{ id: WORKSPACE_CONVERSATION_ID, label: 'Workspace' }];
   for (const entry of listed) {
     const plan = this.normalizePlan({ repo: entry.repo, slug: entry.slug });
     const scope = this.scopeOf(plan);
     if (scope === undefined) continue;
     items.push({ id: scopeId(scope), label: this.isOwnerPlan(plan) ? entry.slug : formatPlanRef(plan.repo, entry.slug) });
   }
   return items;
   ```
   Owner plans come first in ascending slug order (listPlans order), then each other repo's plans in owners() order. With a single repo the output is identical to today: ids and labels are the bare slugs. Note listPlans skipped ENOENT docs and included readError entries — listPlansAcrossRepos preserves both; keep that behaviour (today readError entries were listed too).

   Files: `src/activation/chatController.ts`

4. Wire plan owners, the explorer open sink and editor-follow in commands.ts

   In src/activation/commands.ts:
   - In the `new ChatController({...})` deps add:
   ```ts
   planOwners: () => planRepos.owners().flatMap((info) => {
     const resolved = planRepos.target(info.path);
     if (!resolved.ok) return [];
     const isOwner = repoLockKey(resolved.target.root) === repoLockKey(repoRoot);
     return [{ repo: isOwner ? '.' : resolved.target.info.path, baitonDir: isOwner ? baitonDir : resolved.target.baitonDir }];
   }),
   ```
   (the controller already drops '.' entries and prepends its own owner; use the existing `repoLockKey` helper already used by resolveLensTarget; if it is not in scope at that point, compare `path.resolve` values).
   - Leave the `sessionMemory` wiring's `baiton.chat.session.${scope}` key unchanged — `scope` is now the new scopeId, so owner keys are byte-identical and child plans get qualified keys. Fix the odd indentation of that block only if lint requires it.
   - Replace the PlanExplorer open sink `(slug, repo) => { if (repo === undefined || repo === ownerRepoName()) chatController.setActivePlan(slug); }` and its stale "ChatController is still slug-only" comment with: owner (repo undefined or === ownerRepoName()) → `chatController.setActivePlan(slug)`; otherwise find the Repo by name in `activation.repos` (`repoByName`, already imported or import from './repoDiscovery'), `const target = repo === undefined ? undefined : planRepos.targetAt(found.root)`; when found → `chatController.setActivePlan({ repo: target.info.path, slug })`; when not found → `surface.log(...)` and leave the active plan unchanged.
   - Editor-follow (`onDidChangeActiveTextEditor`): replace `slugFromDocumentUri` with `const lensTarget = resolveLensTarget(planTargets, editor.document.uri.fsPath); if (lensTarget !== undefined) chatController.setActivePlan({ repo: lensTarget.repoPath ?? '.', slug: lensTarget.slug });`. resolveLensTarget (P07/P09 helper) already maps the document path to the owning discovered repo, returns repoPath only in multi-repo workspaces, and falls back to the owner for documents under the owner root, so single-repo behaviour is unchanged (owner slug).
   - Delete `slugFromDocumentUri` if it has no remaining callers (grep first) so lint stays clean.
   - Do not touch other commands, the facade, or ask-watcher wiring in this phase.

   Files: `src/activation/commands.ts`

5. Test repo-qualified conversations in chatController.mode.test.ts

   In test/chatController.mode.test.ts extend `HarnessOptions` with `planOwners?: ChatPlanOwner[]` and `sessionMemory?: SessionMemory` and pass them into the ChatController deps when present. Add a `describe('repo-qualified plan conversations', ...)` (or `it` blocks in the existing describe) that builds a harness where `tmp/child/.baiton` exists and `planOwners` returns `[{ repo: '.', baitonDir }, { repo: 'child', baitonDir: <tmp>/child/.baiton }]`, with an owner plan `plans/alpha/plan.md` and a child plan `child/.baiton/plans/alpha/plan.md` holding different content. Cases:
   1. `setConversations` items are `[{id:'workspace',label:'Workspace'},{id:'alpha',label:'alpha'},{id:'child:alpha',label:'child:alpha'}]`.
   2. `controller.setActivePlan({ repo: 'child', slug: 'alpha' })` → last `setActive.conversationId === 'child:alpha'`; send 'go' → `client.requests[0][0].content === buildSystemPrompt({ kind: 'plan', slug: 'alpha', repo: 'child' }, childContent)` and a transcript `.jsonl` appears under `<tmp>/child/.baiton/plans/alpha/chat/`, none under the owner's `plans/alpha/chat/`; the fake sessionMemory recorded a `set('child:alpha', <id>)`.
   3. `setActivePlan('alpha')` and `setActivePlan({ repo: '.', slug: 'alpha' })` both resolve to conversationId 'alpha', prompt equals `buildSystemPrompt({ kind: 'plan', slug: 'alpha' }, ownerContent)` byte-for-byte, transcript under `<baitonDir>/plans/alpha/chat/`, memory key 'alpha'.
   4. `webview.send({ type: 'selectConversation', conversationId: 'child:alpha' })` (use the protocol message name the file already uses for conversation selection) activates the child conversation.
   5. `setActivePlan({ repo: 'nowhere', slug: 'alpha' })` leaves the active conversation unchanged and logs.
   6. With no `planOwners` dep, the conversation list and ids are exactly today's (existing tests cover this; add one explicit assertion if none exists).
   Keep all existing tests unchanged and passing.

   Files: `test/chatController.mode.test.ts`

6. Test child-plan sub-agent keys and owner key compatibility in chatController.subAgents.test.ts

   In test/chatController.subAgents.test.ts extend `build()` with an optional `planOwners` argument (options object or second param) passed into the deps. Add tests:
   1. With a child owner `{ repo: 'child', baitonDir: <tmp>/child/.baiton }` and `child/.baiton/plans/alpha/plan.md`, activate `{ repo: 'child', slug: 'alpha' }`, have the model call `spawn_subagent`; assert the caller's `sessionKey` starts with 'child:alpha/', the child transcript lands at `<tmp>/child/.baiton/plans/alpha/chat/<topId>.children/<leaf>.jsonl`, and the sub-agent's 'appended'/'finished' events re-render the child conversation (sessionOfKey resolves the qualified key — e.g. the view receives the sub-agent's streamEnd/render while it is in view).
   2. An `ask_user` raised from that child-plan conversation lands its settled intervention in the child repo's transcript, not the owner's.
   3. Owner plan compatibility: activating bare 'alpha' with the memory fake yields memory key 'alpha' and transcripts under `<baitonDir>/plans/alpha/chat/` (same as before the change).
   Reuse the file's existing RoutingClient/script helpers and `waitFor`.

   Files: `test/chatController.subAgents.test.ts`

7. Build, lint and run the full suite

   Run `npm run compile`, `npm run lint`, and `npm test` (re-run unsandboxed if git-backed tests hit EPERM, as earlier phases did). Fix any other test file that calls private ChatController methods with a string slug (grep test/ for `readPlanDocument`, `buildPrompt`, `stepForConversation`, `activePlan`) — the public `setActivePlan(string)` overload remains, so only private-access tests could break; update them in this phase if so. Run `git diff --check`.

   Files: `src/activation/chatController.ts`, `src/activation/commands.ts`, `test/chatController.mode.test.ts`, `test/chatController.subAgents.test.ts`

## Risks

- Owner transcript compatibility depends on scopeOf returning exactly `{ kind: 'plan', slug }` (no repo/baitonDir) for owner plans; adding `repo: '.'` would still be OK for scopeId but any baitonDir mismatch (e.g. a resolved realpath vs deps.baitonDir) could move owner transcripts — always use deps.baitonDir for the owner.
- The vscodeAskWatcher stamps `scopeId: this.input.slug` (bare slug) on relayed harness asks; for a child-plan phase run that bare slug resolves to the owner conversation (or nowhere). Fixing the stamp needs the owning repo in AskWatcherInput, which is outside this phase's file list — scopeForAsk must at least not throw or switch to an unknown repo; flag it for the engine-facade/commands phase.
- Plan-owner `repo` spelling must match between planRepos.owners()/target().info.path (commands.ts) and the SessionScope.repo used by P03; mismatched normalization (trailing slash, backslashes) would produce two scopeIds for one plan. Normalize through normalizeRepoPath in one place (normalizePlan).
- resolveLensTarget only returns repoPath in multi-repo workspaces and falls back to the owner for paths under the owner root; a child plan document whose repo is not a discovered .baiton/ repo would be treated as an owner plan of the same slug in editor-follow. This matches today's behaviour but is worth noting.
- Conversation item labels for non-owner plans use `<repoPath>:<slug>`; if the webview relies on ids being bare slugs (e.g. for CSS/data attributes) encoded ids like `..%2Fsib:alpha` must be tolerated — check webview code handles arbitrary id strings.
- listPlansAcrossRepos swallows per-repo errors; an unreadable child .baiton/ silently disappears from the selector rather than surfacing — acceptable but differs from owner behaviour.

## Acceptance

- `npm run compile` and `npm run lint` pass with no new warnings; `npm test` passes in full.
- ChatController.activePlan is a `{ repo, slug }` identity; `setActivePlan` accepts that identity, a bare slug (owner plan) or undefined.
- With no planOwners dep or a single repo, the conversation selector ids/labels, setActive ids, system prompts, transcript paths, legacy chat.jsonl migration and `baiton.chat.session.<slug>` keys are byte-identical to before (existing chatController tests pass unchanged).
- An owner plan and a child plan with the same slug appear as two conversation entries (`alpha` and `child:alpha`), and each writes transcripts and child sessions under its own repo's `.baiton/plans/<slug>/chat/`.
- A child-plan conversation's system prompt and conversation step are built from the child repo's plan document, with the owning repo passed as ConversationKind.repo; owner-plan prompts carry no repo.
- Session-memory keys for child plans are the repo-qualified scopeId; owner-plan keys are unchanged.
- Selecting a qualified conversation id, a sub-agent event or ask carrying a qualified scope key resolves to the child plan's scope; an unknown repo is ignored and logged rather than falling back to an owner plan of the same slug.
- Clicking a child-repo plan in the Plan Explorer and focusing a child plan's plan.md editor both make that child plan the active chat conversation; owner plans behave as before.
