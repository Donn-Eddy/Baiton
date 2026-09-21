# Execute T20

## Summary

T20 done: README.md now documents inline interventions, ask_user, Auto mode and the relay capability linkage, verified against the shipped symbols.

## Files changed

- `README.md`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`
- `git status --short && git diff --stat`

## Notes

- Added '### Interventions in chat' after '### Chat sessions': three kinds (question/confirm/permission), per-kind controls (option buttons, free-text input + Send with Enter/Shift+Enter, Approve/Decline), settled state with decision line + Auto badge + rationale, ChatController.scopeForAsk routing, interventionTranscriptRecord persistence (escalated asks recorded twice, projected as one card), and Stop triggering declinePendingAsks/PendingAskRegistry.rejectAll.
- Added `ask_user` row '| `ask_user` | yes | yes |' directly under the always-available tools row, plus prose under the table: ask_user(question, options?, allow_free_text?, placeholder?), blocks until answered with the answer as tool result, MAX_ASK_USER_OPTIONS cap of 8, Restricted Mode usable, decline = refusal (ASK_USER_TEXT in systemPrompt.ts), cross-referenced from the Interventions section.
- Fixed the stale draft_spec wording in 'Creating a spec' step 3: it now raises an inline confirm card, not a modal dialog, and declining leaves the repository untouched.
- Added '### Auto mode' after 'Driving a spec': Auto: Off/On toggle left of Stop (aria-pressed, enabled mid-run, workspaceState key baiton.chat.autoMode, host-authoritative echo), gating only permission asks while on, stage (a) agentAllowList with the path narrowings and the verbatim SAFE_SHELL_PREFIXES list plus chain/pipe/redirect/substitution escalation and TOOL_FAMILIES normalisation keyed on AutoModeRunContext, stage (b) evaluateAsk/RISK_EVALUATION_PROMPT criteria and the JSON approve/escalate reply contract, fail-safe direction (every failure escalates), and the audit trace (auto-approval posts already-settled with Auto badge; escalation appended pending and again settled).
- Relay subsection: extended the lead with the purpose sentence (asks become permission cards; Stop/run-end declines pending asks), added the ASK_RELAY_KIND/askRelayKind() single-source sentence, and promoted '#### Harness ask relay' to '###' so it reads as a peer section; findings blocks and all 'Unverified' markers left untouched and unreflowed.
- Verification: every named symbol read out of the tree first (labels 'Auto: On'/'Auto: Off'/'Approve'/'Decline'/'Send' in media/chat.js, aria-pressed, workspaceState key, SAFE_SHELL_PREFIXES, TOOL_FAMILIES, MAX_ASK_USER_OPTIONS=8, ASK_RELAY_KIND/askRelayKind, interventionTranscriptRecord, scopeForAsk, declinePendingAsks/rejectAll, autoDecision fail-catch). npm run compile, npm run lint and npm test pass with counts unchanged (1163 passing / 1 pre-existing pending); git status shows README.md as the only modified file (+143/-8).
