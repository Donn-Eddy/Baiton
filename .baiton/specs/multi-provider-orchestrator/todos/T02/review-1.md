# Review T02

Verdict: **findings**

## Findings

- **must** `src/orchestrator/modelClient.ts`:367 — Gemini tool-message buckets are read but never drained. If an assistant turn contains the same tool-call id twice (or that id is reused by a later assistant turn), every matching tool response is emitted for each occurrence, duplicating results and attaching them to multiple turns. Delete/drain the bucket after its first emission (while preserving its transcript-order entries) so each recorded tool message is output once.

## Tests

- ran: true
- passed: true

```
npx tsc --noEmit -p tsconfig.json passed. Elevated loopback mock-server check: OpenAiModelClient 44 passing (118ms). test/providers.test.ts and eslint on the three changed files completed successfully.
```
