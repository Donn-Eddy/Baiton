# Review T17

Verdict: **findings**

## Findings

- **must** `test/askWatcher.routing.test.ts`:87 — The test suite in test/askWatcher.routing.test.ts implements only 2 tests, omitting 10 of the 12 required test cases specified in Step 6 of the plan and in the acceptance criteria. Specifically missing are:
- Case 2 & 3 full coverage: verifying onDidCreate for a new <id>.json raises a card with prompt/agent/tool/args/detail matching the file, and parseResponse yields version: 1, id, decision: 'approve', respondedAt.
- Case 4: Answering {kind: 'declined', reason: 'no'} writes decision: 'deny' with reason: 'no'.
- Case 5: A kind: 'question' ask with options raises a question card and {kind: 'option', optionId: 'b'} answer writes decision: 'approve', answer: 'b'.
- Case 6: Verifying onDidCreate for <id>.response.json.tmp raises no card.
- Case 7: Verifying duplicate events for the same ask id raise exactly one card and write exactly one response.
- Case 8: Verifying malformed-JSON asks and schema-invalid asks raise no card, write no response file, leave the ask on disk, and log the rejection with the file name.
- Case 9: Verifying an ask whose runId names a different run is ignored.
- Case 10: Verifying events after dispose() are no-ops.
- Cases 11 & 12: RunQueue integration cases verifying (11) dispatching a stage with an askWatcherFactory wired creates the watcher with {slug, todoId, runId, agent: 'claude', asksDir} and disposes it once the dispatch resolves, and (12) dispatching without askWatcherFactory receives LaunchRequest with relay undefined and produces identical LaunchStageInput without creating an asks/ directory.

## Tests

- ran: true
- passed: true

```
  vscode ask watcher routing
    ✔ catches up asks, scopes cards, and writes approved responses
    ✔ ignores response files and declines pending cards on disposal

  2 passing (60ms)

  1140 passing (38s)
  1 pending
```
