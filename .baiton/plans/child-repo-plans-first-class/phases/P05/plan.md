# Plan P05

## Steps

1. Widen ConversationKind with an optional owning repo

   In src/orchestrator/systemPrompt.ts change `export type ConversationKind = | { kind: 'workspace' } | { kind: 'plan'; slug: string };` to `| { kind: 'workspace' } | { kind: 'plan'; slug: string; /** Owning repo of the plan, as a path relative to the conversation owner (PlanRepoInfo.path) or an absolute root. Absent or '.' = this conversation's own repo. */ repo?: string };`. Keep it OPTIONAL so every existing caller (src/activation/chatController.ts lines ~561/1399/1416/1869, test files constructing `{ kind: 'plan', slug }`) compiles unchanged; src/orchestrator/subAgent.ts passes a SessionScope (which already carries `repo?` and `baitonDir?`) to buildSubAgentPrompt and stays structurally assignable. Do NOT import vscode or anything from src/activation. Add a small private helper `function ownedElsewhere(kind: ConversationKind): string | undefined` that returns the normalized repo path when `kind.kind === 'plan'` and `kind.repo` is defined and, after normalization (trim, backslashes to '/', path.posix.normalize, strip trailing '/', ''/'./' -> '.'), is not '.'; otherwise undefined. Prefer importing `normalizeRepoPath` and `formatPlanRef` from './planRepos' (both are pure, exported, and planRepos.ts is already a vscode-free orchestrator module); if that import creates a cycle (planRepos imports './guard' and './seams'; systemPrompt already imports type from './guard' and value from './seams', so no cycle is expected), inline the same normalization instead. Update the file's header doc comment to mention that a plan kind may carry its owning repo.

   Files: `src/orchestrator/systemPrompt.ts`

2. Add the plan-owner text for a plan owned by another repo

   In src/orchestrator/systemPrompt.ts add and export `export function planOwnerText(slug: string, repo: string): string` returning exactly these lines joined with '\n':
   1. `This conversation's plan \`${slug}\` is owned by the repo \`${repo}\`, not by this conversation's repo.`
   2. `Address it as \`${formatPlanRef(repo, slug)}\` (or pass \`plan_repo: "${repo}"\`) whenever a plan tool takes a slug.`
   3. `Its phases' \`repo:\` hints and \`files\` are relative to \`${repo}\`, and its approval, journal and pull requests live in that repo.`
   4. `The read tools (\`read_file\`, \`list_files\`, \`search\`, \`git_*\`) still read this conversation's repo, not \`${repo}\`.`
   In buildSystemPrompt (the gather/drive branch, after the DRIVE_TEXT/FLOW_TEXT push and after the multi-repo section), when `ownedElsewhere(kind)` returns a repo push `planOwnerText(kind.slug, repo)` as its own section. It must be emitted only for a non-owner repo, so a plan kind with no repo or repo '.' produces byte-identical output. Also in buildSubAgentPrompt, when ownedElsewhere(kind) returns a repo, push planOwnerText(kind.slug, repo) right before `subAgentSpawnText(depth)`; otherwise unchanged.

   Files: `src/orchestrator/systemPrompt.ts`

3. Teach the qualified form and the ambiguity reply in multi-repo prompts

   In src/orchestrator/systemPrompt.ts add and export `export const PLAN_ADDRESSING_TEXT` (lines joined with '\n'):
   - `Addressing plans across repos:`
   - `- A plan is identified by its owning repo and its slug. Write a qualified plan as \`<repoPath>:<slug>\`, where \`<repoPath>\` is the repo's path relative to this repo (\`.\` for this repo), for example \`packages/api:my-plan\`.`
   - `- \`list_plans\`, \`read_plan\`, \`update_overview\`, \`add_phase\`, \`edit_phase\`, \`remove_phase\`, \`approve_plan\`, \`land_phase\` and \`submit_pr\` accept a qualified \`slug\`, or a bare \`slug\` plus an optional \`plan_repo\`. Each acts on the plan's own repo: its \`.baiton/\`, its branch and its pull requests.`
   - `- A bare slug works only when exactly one repo has a plan with that slug. Nothing picks a repo for you.`
   - `- When a tool refuses because the slug exists in more than one repo, it lists the candidates as \`<repoPath>:<slug>\`. This is the one refusal you do not just quote: ask the user which plan they mean with \`ask_user\`, offering each candidate as an option, then retry with the qualified slug they chose. Never choose a candidate yourself.`
   - `- \`list_plans\` shows qualified names wherever a slug appears in more than one repo; use those names as given.`
   In buildSystemPrompt, inside the existing `if (hasMultipleRepos)` block, change the pushed section to `[repoListText(repos), step === 'drive' ? REPO_DRIVE_TEXT : REPO_GATHER_TEXT, PLAN_ADDRESSING_TEXT].join('\n\n')`. Leave REPO_GATHER_TEXT, REPO_DRIVE_TEXT, REPO_HINT_GRAMMAR_LINE, repoListText and every single-repo section text exactly as they are (their wording is already consistent with checkRepoHint validating against the plan's own topology). Do not change the run-step branch (mode !== 'plan' on a workspace kind): it must still ignore repos. Also, when ownedElsewhere(kind) is set but repos context is absent/single (possible in tests or future callers), still push PLAN_ADDRESSING_TEXT together with planOwnerText so the qualified form is explained; implement as: `const addressingNeeded = hasMultipleRepos || owner !== undefined` and push PLAN_ADDRESSING_TEXT exactly once (inside the multi-repo section when hasMultipleRepos, otherwise as its own section immediately before planOwnerText).

   Files: `src/orchestrator/systemPrompt.ts`

4. Teach the owning-repo framing in role instructions

   In src/engine/roleInstructions.ts extend PLAN_WRITER_REPO_INSTRUCTION with one new bullet appended after the existing `- When the context lists no repositories, omit \`repo\` everywhere.` line: `- A plan is identified by its owning repository and its slug, written \`<repoPath>:<slug>\` when the repository must be named. The plan you write belongs to the repository marked as owning, even when the conversation that asked for it lives in another repository; every \`repo\` and \`files\` path is relative to that owning repository.` Extend PLANNER_REPO_INSTRUCTION by appending (same string, one space separator) the sentence: `The plan's owning repository is the one whose \`.baiton/\` holds it, which may differ from the repository a conversation was started in.` Keep all other role texts (executor, reviewer, step-reviewer, pr-writer, investigate, CONTEXT_IS_COMPLETE_INSTRUCTION) byte-identical; test/roleInstructions.repo.test.ts snapshots executor, reviewer and investigate and only uses `includes`/`match` for the planner texts, so those assertions keep passing. Do not add runtime parameters to roleInstructions().

   Files: `src/engine/roleInstructions.ts`

5. Extend test/systemPrompt.repos.test.ts

   Add imports of PLAN_ADDRESSING_TEXT and planOwnerText. Extend the byte-identity test: also loop over plan kinds `{ kind: 'plan', slug: 'sample', repo: '.' }` and `{ kind: 'plan', slug: 'sample', repo: './' }` and assert each equals the output for the repo-less PLAN kind for every content/mode, with and without a single-repo context. Add tests: (a) multi-repo gather and drive prompts (PLAN with DRAFT and APPROVED, REPOS) include PLAN_ADDRESSING_TEXT exactly once, include '<repoPath>:<slug>', and match /ask_user/ in the ambiguity line; (b) a single-repo or absent context prompt does NOT include PLAN_ADDRESSING_TEXT; (c) a child-owned plan kind `{ kind: 'plan', slug: 'sample', repo: 'packages/api' }` with REPOS includes planOwnerText('sample', 'packages/api') and the substring '`packages/api:sample`', for both DRAFT and APPROVED, and PLAN_ADDRESSING_TEXT appears exactly once; (d) the same child-owned kind with no repo context still includes planOwnerText and PLAN_ADDRESSING_TEXT; (e) `repo: 'packages/api/'` normalizes to the same prompt as 'packages/api'; (f) workspace run-step prompts (mode 'bug', REPOS) remain equal to the no-repo version; (g) buildSubAgentPrompt for the child-owned kind includes planOwnerText and for `{kind:'plan', slug:'sample'}` equals buildSubAgentPrompt with `repo: '.'` (byte identity) for steps 'gather' and 'drive'. Count occurrences with `prompt.split(PLAN_ADDRESSING_TEXT).length - 1`.

   Files: `test/systemPrompt.repos.test.ts`

6. Guard single-repo byte identity in test/systemPrompt.test.ts

   Read test/systemPrompt.test.ts first and add a `describe('owning repo in ConversationKind', ...)` block (do not alter existing assertions): assert buildSystemPrompt({kind:'plan', slug:'x', repo:'.'}, content) === buildSystemPrompt({kind:'plan', slug:'x'}, content) for undefined, a draft and an approved document; assert the default single-repo prompt contains neither 'Addressing plans across repos:' nor '<repoPath>:<slug>'; assert conversationStepFor ignores `repo` (same step with and without it for draft and approved content). If the file already holds full-prompt snapshot strings, they must pass unchanged — that is the byte-identity evidence. Also add to test/roleInstructions.repo.test.ts? No — it is outside this phase's file list and keeps passing; leave it untouched.

   Files: `test/systemPrompt.test.ts`

7. Build, lint and run the full suite

   Run `npm run compile`, `npm run lint` and `npm test -- --reporter dot`. Particular suites to watch: test/systemPrompt*.test.ts, test/chatController.mode.test.ts (compares against buildSystemPrompt for repo-less kinds), test/subAgent.test.ts, test/roleInstructions.repo.test.ts, and any brief/stageContext snapshot test that embeds the step-planner or phased-planner role text (grep test/ for 'Choose the lowest repository' / 'When the phase line carries' and update only those expected strings if a full-text snapshot exists). Run `git diff --check`.

   Files: (none)

## Risks

- Changing PLAN_WRITER_REPO_INSTRUCTION / PLANNER_REPO_INSTRUCTION alters every phased-planner and step-planner brief, including single-repo ones; the byte-identity constraint is stated for system prompts, but if a brief golden/snapshot test embeds those texts it must be updated in this phase (it is outside the listed files — keep that edit minimal).
- Importing normalizeRepoPath/formatPlanRef from planRepos.ts pulls planRepos' imports (activation/repoDiscovery, storage) into systemPrompt's module graph; it is vscode-free today, but if repoDiscovery ever imports vscode this would break purity — inlining the normalization avoids that dependency.
- The ambiguity guidance tells the orchestrator to ask_user instead of quoting the refusal, which deliberately carves an exception from REFUSAL_TEXT; the wording must make that exception narrow (only the multiple-repo slug refusal).
- `run` does not accept `plan_repo` yet (engine facade work is a later phase), so the prompt must not list `run` among the tools that take a qualified slug.
- chatController does not yet pass `repo` in ConversationKind; the owner text is only exercised by tests until the chat-controller phase wires it, so keep the field optional.

## Acceptance

- ConversationKind's plan variant has an optional `repo` field; all existing callers compile unchanged.
- For every kind/content/mode, buildSystemPrompt and buildSubAgentPrompt output with no repo context, a single-repo context, no `repo` field, or `repo: '.'` is byte-identical to the pre-phase output (existing systemPrompt, systemPrompt.mode, systemPrompt.step, chatController.mode and subAgent tests pass unmodified).
- Multi-repo gather and drive prompts contain PLAN_ADDRESSING_TEXT exactly once, teaching `<repoPath>:<slug>`, `plan_repo`, no-precedence bare slugs, and the ask_user reply to an ambiguity refusal; run-step prompts are unchanged.
- A plan kind owned by a non-owner repo yields a prompt (and sub-agent prompt) that names the owning repo and its qualified slug via planOwnerText.
- roleInstructions phased-planner and step-planner texts mention the owning repository and the qualified form; executor, reviewer and investigate texts are unchanged (roleInstructions.repo.test.ts passes).
- No vscode import added to systemPrompt.ts or roleInstructions.ts.
- `npm run compile`, `npm run lint` (0 errors) and `npm test` all pass; `git diff --check` is clean.
