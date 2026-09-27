# Execute T03

## Summary

T03 execution resolved per an approved human decision (ask-0002, answer 'scope-change'). The recurring review finding was that each execution commit contains todos/T03/execute-<n>.md — an artifact Baiton's extension itself generates from the run's mandatory result.json and commits at run end, so it is outside the four code files through no editable cause; attempt 3's commit changed only that artifact and was not even test-run. I escalated with asks/ask-0002.json, and the human approved widening T03's allowed-file list so the extension-generated .baiton/specs/model-selector-refresh/todos/T03/execute-<n>.md is permitted alongside the four code files. With that scope change the T03 implementation is complete: src/adapter/adapter.ts carries the discovery vocabulary (DEFAULT_DISCOVERY_TIMEOUT_MS, DiscoveryContext, AGENT_CATALOG_SOURCE, capabilitiesFromEntries, capabilitiesToCatalogFetch, the optional never-throw discoverModels seam), src/adapter/index.ts splits agentCapabilities() into exported builtinAgentCapabilities() plus a snapshot overlay (claude keeps claude-sonnet-5 via mergePreservingExisting; empty refreshed lists never wipe curated ones and keep source 'builtin' with the snapshot's stale metadata; opencode keeps its modelLink; antigravity is never overlaid), src/adapter/antigravity.ts has comment-only opt-out documentation, and test/adapter.index.test.ts adds the overlay/AGENT_CATALOG_SOURCE/discoverModels-seam/capability-helper suites. No code files were modified in this attempt; the working tree holds the attempt-1 implementation unchanged and the harness artifacts execute-1 removed / execute-2, execute-3 present.

## Files changed

- (none)

## Commands run

- `npx tsc --noEmit -p tsconfig.json (exit 0)`
- `npm run compile (exit 0)`
- `npx eslint src/adapter/adapter.ts src/adapter/index.ts src/adapter/antigravity.ts test/adapter.index.test.ts --ext .ts (clean)`
- `npm run test:unit (1415 passing, 1 pending, 1 failing: the pre-existing 'packaging gating: includes zero native modules' keytar assertion)`

## Notes

- Human decision recorded at asks/ask-0002.response.json: decision 'approve', answer 'scope-change' — T03's acceptance scope is widened so the extension-generated execute-<n>.md artifact is an allowed file; the four-file list plus that artifact is the new scope. Reviews of T03 commits should no longer flag the artifact.
- No code changes in this attempt: attempts 1-2 already implemented the full todo and the reviews consistently recorded the tests passing with only the artifact-scope finding (tests were skipped in attempt 3's review solely for scope). Verification re-run for this record: tsc, compile, eslint clean; test:unit green except the baseline-documented keytar gating failure.
- Prior escalation context: ask-0001 of execute-3 expired ('the run ended before this ask was answered'); ask-0002 of this run was answered by a human.
- The single failing suite on every run is the pre-existing 'packaging gating: includes zero native modules' keytar/node_modules check in test/activation.gating.test.ts, documented at baseline in the T01 run.
