# Execute T04

## Summary

Added an optional `cwd?: string` run-root override to LaunchStageInput and made launchStage resolve one `base` path (validated with the same resolveRoot, so a bad override returns a root-resolution error before anything is written) that now backs the run dir/brief/result paths, the ask-relay descriptor, relay-file resolution and containment, ensureAsksDir and the terminal cwd. Doc comments updated to say "run root"; with `cwd` absent the launch is byte-identical. Added a `launchStage cwd override` suite (9 cases) to test/engine.launcher.test.ts; compile and full mocha suite green (1795 passing).

## Files changed

- `src/engine/launcher.ts`
- `test/engine.launcher.test.ts`

## Commands run

- `npm run compile`
- `npm test`

## Notes

- No existing caller was edited: grepped src/engine/specDraft.ts, src/engine/submitPr.ts and src/engine/runQueue.ts — none constructs a LaunchStageInput with a `cwd` property (their `cwd` hits are unrelated local params in submitPr's runCommand and runQueue's resolveSessionId).
- resolveRoot's signature, error kind ('root-resolution') and messages are unchanged; an invalid `cwd` reuses the same variant, so the error union is stable. The only doc change there is the LaunchError comment line.
- resultValidation.ts and the run-dir watchers still resolve against workspaceRoot — deliberately untouched, as the plan's risk note says a later todo owns making those worktree-aware.
- Test factory spreads `cwd` conditionally (`...(cwd !== undefined ? { cwd } : {})`) like the existing relayAsks factories, so exactOptionalPropertyTypes strictness is not tripped.
- Per the plan's risk note, no test asserts that a non-existent absolute `cwd` is rejected — the launcher mkdirs the run dir recursively.
