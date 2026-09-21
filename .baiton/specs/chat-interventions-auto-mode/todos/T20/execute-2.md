# Execute T20

## Summary

T20 retry: fixed the review's must finding by narrowing the Shift+Enter claim in README.md to match media/chat.js's single-line free-text input; README-only change, suite back at baseline.

## Files changed

- `README.md`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`
- `git status --short && git diff --stat`

## Notes

- Verified the reviewer's finding in the tree before editing: both free-text branches in media/chat.js renderIntervention (the option-plus-free-text branch around line 480 and the free-text-only branch around line 510) build a single-line <input type="text"> whose keydown handler only prevents Enter without Shift, so Shift+Enter cannot insert a newline in either. Fixed by documentation (the todo is README-only), not by changing the UI.
- README.md only: 'a free-text question renders a text input plus **Send** (Enter submits, Shift+Enter puts in a newline)' is now 'a free-text question renders a single-line text input plus **Send** (Enter submits; the answer box holds one line, so there is no Shift+Enter newline there)', rewrapped at ~80 columns to match the surrounding section. No other Shift+Enter claim existed in the file.
- Everything else from the first execution (Interventions section, ask_user row and prose, draft_spec inline-card wording, Auto mode section, relay subsection edits, ASK_RELAY_KIND pointer, promoted '### Harness ask relay' heading, untouched findings blocks and Unverified markers) is already in the tree from the adopted first pass and is untouched by this fix.
- Verification: npm run compile and npm run lint clean; npm test 1163 passing / 1 pre-existing pending, matching the stated baseline (the reviewer's 40 spawnSync EPERM failures were a reviewer-sandbox git permission issue and do not reproduce here). git status shows README.md as the only modified file (+4/-3).
