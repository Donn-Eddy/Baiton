---
version: 1
name: pr-merged-completes-plan
status: approved
mode: manual
base: main
base_commit: 68401755f9865edd1177afcaf202aa32c426cf57
branch: baiton/pr-merged-completes-plan
approved_rev: 6bad46c54a6377d766aece21300d45b010178f29651dffbcf6009ce57dcce65b
---

# Endstate

A plan whose frontmatter `status` is `pr` or `pr-partial` and whose recorded pull/merge requests all read **merged** is listed under **Completed** in the Plan Explorer without any user action. The completion is *derived*, never persisted: the document keeps `status: pr` (or `pr-partial`), its `pr:` / `prs:` URLs, its phase lines and phase states, and its approval hash and `approved_rev` still pass. No file is written, no commit is made, no branch is switched, and a window reload re-derives the same grouping.

The recorded URL set is the union of the `pr:` value and every value in `prs:` (deduplicated). Completed requires **every** URL in that set to read merged, so a multi-repo plan with one open PR stays Active.

A plan stays exactly as today (Active, or wherever `planGroupKind` already puts it) when any recorded request is open or closed-unmerged, or when its state cannot be established: the vendor CLI is missing, the network is down, the remote is not configured, or the URL cannot be parsed. A plan that records no PR URL, and any plan whose status is not `pr`/`pr-partial` (pending, approved, in progress, `done`), is never queried.

Each plan is checked at most once per session for a given recorded-URL set; editing the document so that the URL set changes re-arms the check. Failures are logged at most once per plan per session and never surface as an exception from the explorer's refresh.

A plan grouped Completed this way offers **Show PR** only (no Submit PR retry, even for `pr-partial`), and `submitPr`'s readiness check refuses it with a clear "already merged" message instead of opening a duplicate request because `findOpenByHead` no longer finds the merged one.

# What needs changing

### `src/engine/prTool.ts` — read a request's state

Add a `PrState` type (`'open' | 'merged' | 'closed' | 'unknown'`) and a third method on `PrTool`, e.g. `stateByUrl(url: string): Promise<PrState>`. Add a pure, exported URL parser that extracts the owner/project path and the number/iid from a recorded URL (`https://host/owner/repo/pull/12`, `https://host/group/sub/project/-/merge_requests/7`); an unparsable URL yields `unknown` without invoking the CLI.

- `gh`: one extra subcommand, `pr view <number> --repo <host/owner/repo> --json state`, mapping `OPEN`/`MERGED`/`CLOSED`.
- `glab`: one extra subcommand, `mr view <iid> --repo <group/project> --output json`, mapping `opened`/`merged`/`closed`/`locked`.

Both go through the existing injectable `CliRunner`; any rejection or unrecognised output maps to `unknown` (or rejects with a `PrToolError`, which the caller treats as unknown — pick one and document it). The argument arrays for `findOpenByHead` and `create` are not touched. Export a small pure parser for each CLI's state JSON so tests can pin it.

### `src/engine/transitions.ts` — the pure rule

Beside `planPrStatus`, add a pure function such as `planPrsMerged(recorded: readonly string[], observed: ReadonlyMap<string, PrState>): boolean`: true only when `recorded` is non-empty and every recorded URL is observed `merged`; a missing observation counts as not merged. Add a sibling helper that collects the recorded URL set from the `pr` and `prs` frontmatter values (reusing `parsePrsValue`), deduplicated and in a stable order, so the explorer and `submitPr` derive the same set. No I/O.

### `src/model/treeModel.ts` — grouping takes the fact

`PlanGroupFacts` gains an optional `prsMerged?: boolean`; `planGroupKind` returns `completed` when status is `done` **or** when status is `pr`/`pr-partial` and `prsMerged` is true. `PlanInput` gains the same optional field and `buildPlanNode` threads it into every `planGroupKind` call and into `legalPlanActions`. `PlanNode` may carry the fact so the node stays self-describing (its doc comment says `group` equals `planGroupKind` over the node's facts). The node's `status` is still the persisted value.

### `src/model/planActions.ts` — Show PR only

`PlanActionInput` gains an optional `prsMerged?: boolean`. When it is true and a PR URL is present, `legalPlanActions` returns `['showPr']` — the `pr-partial` retry branch no longer offers `submitPr`.

### `src/activation/planExplorer.ts` — derive, memoise, never block

`PlanExplorerOptions` gains an injected dependency, e.g. `prsMerged?: (input: { slug: string; repo?: string; urls: readonly string[] }) => Promise<boolean>`. During `refresh`, for each listed plan whose parsed status is `pr`/`pr-partial` and whose recorded URL set is non-empty, the explorer consults a per-session memo keyed by owning repo + slug + the joined URL set. A cached result is fed into `PlanInput.prsMerged`; a miss starts the check once (storing the in-flight promise so concurrent refreshes share it), builds the tree with `prsMerged: false` for now, and schedules a refresh when the check settles with `true`. A rejected check stores `false`, logs once for that plan, and never propagates. The refresh never awaits the CLI, so a slow or hung CLI cannot stall the tree.

### `src/activation/commands.ts` — wiring

Factor the provider resolution already used by `submitPrForSlug` (`cfg().pr.tool` → `isPrToolSelection` → the configured remote's URL → `selectProvider` → `resolveProviderExecutable` with `readPrToolPath()`) into a small local helper that yields a `PrTool` for a repo root, or `undefined` when any step fails. Build one `prsMerged` checker from it: per URL, choose the repo (primary, or the `prs` key's repo via the existing repo configs for multi-repo), call `stateByUrl`, and apply `planPrsMerged`. Pass it to `new PlanExplorer(...)` through `PlanExplorerOptions`, and to `submitPr` as a new optional dep. Unresolvable provider → not merged, no throw. Nothing is gated on Restricted Mode, since it only reads.

### `src/engine/submitPr.ts` — refuse a merged plan

`SubmitPrDeps` gains an optional `prsMerged?: (urls: readonly string[]) => Promise<boolean>`. `checkReady`, after the existing `done` check, collects the recorded URL set for `pr`/`pr-partial` plans and, when the checker reports every one merged, fails with `kind: 'not-ready'` and a message like `plan "<slug>" has already been merged (<url>)`. A checker failure is treated as not merged so today's behaviour (including the partial retry) is unchanged when the state is unknown.

### Tests

Extend `test/prTool.test.ts` (new argument shapes for both CLIs, URL parsing, state mapping, failure → unknown; existing shape assertions untouched), `test/transitions.prStatus.test.ts` (rule examples + a property: true iff non-empty and all merged), `test/treeModel.property.test.ts` and `test/planActions.property.test.ts` (merged `pr`/`pr-partial` → completed / `showPr` only; absent fact → unchanged), `test/planExplorer.test.ts` (memo: one check per plan per URL set, re-arm on URL change, non-`pr` plans never queried, failure logs once and degrades), and `test/submitPr.test.ts` / `test/submitPr.multiRepo.test.ts` (merged plan refused, unknown state unchanged).

# Limitations & constraints

- **Read-only, derived state.** No document write, no `setFrontmatterKey`, no commit, no push, no branch change, no working-tree change. `status`, `pr`, `prs`, `approved_rev` and the approval hash must be byte-identical after the explorer has shown a plan as Completed. Phase lines and phase states are never touched; a merged PR changes grouping and actions only.
- **Works in Restricted Mode.** The check is a read; do not gate it on `workspace.restricted`. (Inline actions remain hidden there as today.)
- **No new configuration.** No new `config.json` keys and no new VS Code settings. Reuse `pr.tool`, `baiton.pr.toolPath` and the configured git remote (per-repo remote from repo configs for multi-repo), exactly as `submitPrForSlug` resolves them.
- **Narrow query scope.** Only plans whose trimmed status is `pr` or `pr-partial` and that record at least one URL are ever checked. Pending, approved, in-progress and `done` plans, and plans with an empty URL set, must never invoke the CLI — tests should assert the runner is not called.
- **Once per session per plan.** Memoise by owning repo + slug + recorded-URL set, including in-flight promises, so overlapping refreshes and the watcher's debounce do not spawn duplicate CLI calls. Re-arm only when the URL set changes. Unknown results are memoised too.
- **Fail soft.** Missing CLI, offline, unconfigured remote, unparsable URL, non-zero exit, malformed JSON: all degrade to "not complete" (the plan stays where it is today). Each plan logs at most once per session. Nothing thrown may escape into `PlanExplorer.refresh`, and the refresh must not await the CLI (its 120 s timeout must never delay the tree).
- **Multi-repo.** Completed requires every URL in `prs` (plus `pr`) to read merged; a single open, closed-unmerged or unknown entry keeps the plan out of Completed.
- **Additive CLI changes.** The existing `findOpenByHead` and `create` argument arrays for `gh` and `glab`, `parsePrList`, `parseCreatedPr`, `planPrStatus`, `reposToSubmit`, `isPartialPrStatus` and the existing `planGroupKind` cases keep their behaviour; all existing tests must pass unchanged. New optional fields default so that callers which do not supply them get today's results.
- **Readiness refusal is conservative.** `checkReady` refuses only when the checker positively reports every recorded URL merged; an unknown state leaves the current flow (including `pr-partial` retry) intact.
- Match the surrounding style: doc comments on exported symbols, injectable seams instead of direct `child_process` use in tests, and pure helpers in `src/engine` / `src/model` with no VS Code imports.

# PHASES

- [done] P01 Add a read of one request's state by URL to the PrTool seam for gh and glab (files: src/engine/prTool.ts, test/prTool.test.ts)
- [done] P02 Add the pure all-recorded-PRs-merged rule and recorded-URL-set helper beside planPrStatus (after P01; files: src/engine/transitions.ts, src/engine/prTool.ts, test/transitions.prStatus.test.ts)
- [done] P03 Thread the merged fact through planGroupKind, buildPlanNode and legalPlanActions (files: src/model/treeModel.ts, src/model/planActions.ts, test/treeModel.property.test.ts, test/planActions.property.test.ts)
- [done] P04 Derive and memoise PR completeness in the Plan Explorer refresh and wire the checker from commands (after P01, P02, P03; files: src/activation/planExplorer.ts, src/activation/commands.ts, test/planExplorer.test.ts)
- [reviewing] P05 Refuse Submit PR for a plan whose recorded PRs are all merged (after P02, P04; files: src/engine/submitPr.ts, src/activation/commands.ts, test/submitPr.test.ts, test/submitPr.multiRepo.test.ts)
