# Review T17

Verdict: **findings**

## Findings

- **must** `test/askWatcher.routing.test.ts`:75 — The required routing suite implements only two combined watcher cases and omits the planned question/option, declined-answer, duplicate-event, malformed/schema-invalid, wrong-run, queue-wired, and unwired-byte-identity cases. In particular, there is no RunQueue coverage proving relayAsks is conditional or that a watcher is created and disposed, so the acceptance criteria for queue integration and regression protection are unmet.

## Tests

- ran: true
- passed: false

```
npm run compile: passed. npm run lint: passed. Focused askWatcher suite: 2 passing. npm test encountered sandbox EPERM/network-related failures in existing process-spawning/model-client/submitPr tests, so the full suite did not pass in this environment.
```
