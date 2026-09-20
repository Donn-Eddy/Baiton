# Execute T15

## Summary

T15 probed codex 0.154.0 for a native ask relay and shipped Branch B (record the negative, emit no wiring). The probe established: codex's PreToolUse/PermissionRequest hook system exists and is inline-configurable via -c 'hooks.<Event>=[{matcher="*",hooks=[{type="command",command=…}]}]' (typed-schema validated under --strict-config; unknown top-level keys error, matcher type errors confirm the MatcherGroup contract); the hook fires carrying tool_name/tool_input and honours hookSpecificOutput.permissionDecision allow|deny|ask (deny blocks with 'Command blocked by PreToolUse hook: <reason>', allow runs, and ask is a silent allow under exec); a handler timeout field is accepted; but every enabled hook is gated behind persisted hook trust (HookStateToml {enabled, trusted_hash} written by a TUI review prompt) — an identical hook fires only under --dangerously-bypass-hook-trust and is silently skipped without it, with hooks.json/inline state/trusted_hash/bypass_hook_trust being non-substitutes, so a pure launch() that writes nothing and never emits the bypass flag cannot install a relay. This session re-verified the secret-to-the-outcome legs from a throwaway CODEX_HOME (SessionStart hook fires only with the bypass flag; silently skipped without; trust strings HookStateToml/trusted_hash/SetHookTrusted in the TUI), matching the committed findings. Implementation is the already-committed Branch B work (commit 4c3bc79): CodexAdapter doc-comment degrade 7 (no wiring, probe result, named surface and reason, flags deliberately not used, README pointer, config-driven fallback as whole policy surface), the byte-identical-spec Tests in test/adapter.codex.test.ts ('CodexAdapter ask-relay wiring (probe findings)' built on askRelayDescriptor('/repo','run-123')), and the README 'codex findings' transcript plus the updated relay table row. Verified: npm run compile, mocha test/adapter.codex.test.ts (71 passing), npm run lint, full npm test (1124 passing, 1 pending, 0 failed); git status clean (no scratch artifacts, no $CODEX_HOME changes).

## Files changed

- (none)

## Commands run

- `codex --help`
- `codex --version`
- `CODEX_HOME=<scratch> codex login status (throwaway: Not logged in; real home: Logged in using ChatGPT)`
- `CODEX_HOME=<scratch> codex --strict-config -c <hooks shapes> exec --help / exec 'hi' (shape + negative-control validation)`
- `CODEX_HOME=<scratch> codex exec --skip-git-repo-check --sandbox read-only 'hi' (401 Unauthorized without credentials)`
- `CODEX_HOME=<scratch> codex [--dangerously-bypass-hook-trust] [exec|--dangerously-bypass-hook-trust] with hooks.json / inline -c hooks.SessionStart (hook fires ONLY with the bypass flag; silent skip without)`
- `strings <codex binary> (HookHandlerConfig/HookStateToml{enabled,trusted_hash}/HookTrustStatus/SetHookTrusted/TUI trust prompts)`
- `CODEX_HOME=<scratch> codex plugin list && codex plugin marketplace list && codex doctor (residual negatives)`
- `npm run compile`
- `npx mocha --no-config test/adapter.codex.test.ts --require ts-node/register`
- `npm run lint`
- `npm test`
- `git status --short && git diff --stat`

## Notes

- The probe's decisive leg (d) failed: codex hooks run only under persisted hook trust (HookStateToml{enabled,trusted_hash} in $CODEX_HOME, established via the TUI trust review). Inline -c hooks and the $CODEX_HOME/hooks.json source are silently skipped without trust; the same hook fires under --dangerously-bypass-hook-trust. Inline state={enabled=true}, inline trusted_hash and -c bypass_hook_trust=true do not substitute. Since CodexAdapter.launch() is pure and --dangerously-bypass-hook-trust/--approve-for-me are never emitted, Branch B (emit nothing) is the only admissible outcome.
- Legacy caveat on the probe environment: the scratch CODEX_HOME is unauthenticated, so codex exec turns die with 401 Unauthorized; SessionStart hooks were probed as the model-free hook event, and the trust gate (not auth) was shown to decide firing via the bypass-flag comparison. The README marks the interactive-form parity and the 600s-scale timeout as Unverified, per the plan.
- The Branch B implementation and README record were completed by the prior attempts of this same todo and are committed (4c3bc79 'spec(codex): document findings on ask-relay wiring and hook trust behavior'); this attempt verified the implementation end-to-end (compile, codex suite, lint, full suite, clean git status) and confirmed the committed findings against a fresh independent probe. npm test: 1124 passing / 1 pending (pre-existing) / 0 failed.
- Probe scratch (hook.js, hooklog, hooks.json) lives only under /tmp/opencode/codex-probe with a throwaway CODEX_HOME; nothing was written under the repo, .codex/ or the user's real $CODEX_HOME.
- One consequence recorded in the docs worth flagging to reviewers: in a non-interactive codex exec turn, permissionDecision 'ask' behaves as a silent allow (unlike claude, where it blocks), so a future codex relay must never degrade to 'ask' blindly.
