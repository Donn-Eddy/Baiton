# Execute T13

## Summary

T13 complete. (1) Probed the installed claude CLI (version 2.1.278): `--help` documents `--settings <file-or-json>`; a functional `-p` probe with an inline hooks JSON accepted the flag, fired a `PreToolUse` command hook, and honoured the stdout contract (`deny` blocked the tool with the probe reason, `allow` let it run, `ask` blocked in non-interactive mode). The hook's stdin event fields were captured verbatim (`session_id, transcript_path, cwd, prompt_id, permission_mode, effort, hook_event_name, tool_name, tool_input, tool_use_id`). A 1 s CLI-side `timeout` clipped a 2 s hook, so the emitted hook owns its own deadline and degrades to `ask`. All probe evidence recorded in README. (2) Added to src/adapter/permissions.ts: CLAUDE_RELAY_HOOK_TIMEOUT_SECONDS (600), CLAUDE_RELAY_HOOK_MATCHER ('*'), shellQuote, CLAUDE_RELAY_HOOK_SCRIPT (no single quotes, argv-parameterised, writes an ask byte-identical to serializeAsk, polls 200 ms, approve→allow / deny→deny, ask on any error or expiry), claudeAskRelayHookCommand, claudeAskRelaySettings, claudeRelayFlags (empty for missing descriptor or protocol !== 'file-v1'). (3) ClaudeAdapter.launch() inserts claudeRelayFlags(req.relay) after runDirGrant and before claudeSystemPromptFlags, ahead of `--`; attach() unchanged; JSDoc updated. (4) Added a 'ClaudeAdapter ask-relay hook wiring' suite (9 tests incl. no-relay byte-identity pin, --settings placement/shape, shell-quoting invariant, protocol gate, per-role permission-row parity, and three child_process round-trips through parseAsk/writeResponse proving allow/deny/ask). (5) Added the 'Harness ask relay (per-adapter probe findings)' README subsection with claude findings (unverified items marked) and the per-adapter relay table (opencode/agy/codex = not probed yet). All acceptance gates green.

## Files changed

- `src/adapter/permissions.ts`
- `src/adapter/claude.ts`
- `test/adapter.claude.test.ts`
- `README.md`

## Commands run

- `claude --version  (probe step 1.1 — 2.1.278 (Claude Code))`
- `claude --help  (probe step 1.2 — `--settings <file-or-json>` documented; --permission-mode/--allowedTools/--add-dir present; --permission-prompts/--permission-prompt-tool runtime surfaces noted)`
- `claude --help | grep -i -E 'hook|permission|settings'  (probe step 1.3)`
- `claude --settings '<inline hooks JSON, deny>' -p 'Run the Bash tool to echo hi'  (probe step 1.4 — CLI accepted inline JSON; hook ran; tool denied with reason 'baiton probe')`
- `claude --settings '<inline hooks JSON, stdin-tapping hook>' -p ...  (probe step 1.5 — stdin event captured verbatim)`
- `claude --settings '<inline hooks JSON, 2 s hook + timeout: 1>' -p ...  (probe step 1.6 — CLI-side timeout clipped the hook; hook must own its expiry)`
- `claude --settings '<allow leg>' -p ... && claude --settings '<ask leg>' -p ...  (stdout contract legs)`
- `npm run compile  (clean)`
- `npx mocha --no-config test/adapter.claude.test.ts --require ts-node/register  (42 passing)`
- `npm run lint  (clean)`
- `npm test  (1098 passing, 1 pending)`
- `npx mocha  (identified the single pending as the pre-existing config.test.ts version-gating test; confirmed pre-existing via git stash round-trip)`
- `git status --short && git diff --stat  (only the four planned files changed)`

## Notes

- Probe outcome gate passed on all three legs (inline --settings via argv, PreToolUse command hooks firing, stdout permission-decision contract), so the wiring was shipped; every shipped behaviour is traceable to a probe observation.
- Stdin event field names used by the hook are exactly the probed ones: tool_name / tool_input (the plan's assumed names happened to match, but the hook uses the observed event verbatim).
- CLI-side `timeout` clips the hook but its post-expiry disposition was not user-controllable from Baiton's side, so the hook enforces its own 600 s deadline and returns `ask` (with reason mentioning the timeout) on expiry or any failure — never a silent allow. The README marks the one unverifiable residual (no re-verification of timeouts at the 600 s scale) explicitly.
- The full `npm test` run shows 1098 passing with 1 pending; the pending test (test/config.test.ts, loadConfig version-gating migration test) was verified pre-existing — `npx mocha` after `git stash` on the clean tree shows the same single pending item, and no test was added as pending or failing by this change.
- `claude --help` also documents `--permission-prompts host|none` / `--permission-prompt-tool` as a native delegation surface; the inline `--settings` hook path was chosen because it is reachable from pure argv alone (Adapter.launch() is pure and LaunchSpec carries only shellPath/shellArgs), which is exactly the plan's preference. The launcher.ts settings-file follow-up was therefore not needed.
- Only the four planned files were modified; property test and registry-parity tests stayed green (no-relay argv pinned byte-identical).
