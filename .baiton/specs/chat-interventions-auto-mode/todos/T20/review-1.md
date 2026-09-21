# Review T20

Verdict: **findings**

## Findings

- **must** `README.md`:144 — The documentation says Shift+Enter inserts a newline in every free-text intervention. The free-text-only branch in media/chat.js renders `<input type="text">`; its key handler only prevents Enter without Shift, so Shift+Enter cannot insert a newline in that single-line control. Narrow the claim to the multiline option-plus-free-text control, or change the UI to make the documented behavior true.

## Tests

- ran: true
- passed: false

```
npm run compile and npm run lint passed. npm test completed with 1122 passing, 1 pending, and 40 failing (35s). Failures include spawnSync git EPERM in temp-repository tests; the suite did not reach the stated baseline in this sandbox.
```
