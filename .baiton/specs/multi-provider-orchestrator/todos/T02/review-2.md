# Review T02

Verdict: **findings**

## Findings

- **must** `src/orchestrator/modelClient.ts`:367 — Gemini tool-message buckets are read but never drained. If a tool_call id is repeated (either twice in one assistant turn or in later assistant turns), every matching tool response is emitted once for each occurrence; later responses can also be attached to an earlier turn. This violates the required drain/attachment ordering. Consume/delete each bucket after its first matching call (and add a repeated-id regression test).

## Tests

- ran: true
- passed: false

```
npx tsc --noEmit -p tsconfig.json passed. npx mocha --no-config --require ts-node/register test/modelClient.test.ts: 20 passing, 21 failing because this sandbox rejects mock-server binding with listen EPERM: operation not permitted 127.0.0.1; failures are environmental.
```
