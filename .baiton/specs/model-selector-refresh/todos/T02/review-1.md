# Review T02

Verdict: **findings**

## Findings

- **must** `test/fixtures/modelsDev.sample.json`:92 — The Baseten fixture declares the Chutes endpoint (`https://inference.chutes.ai/api/v1/`) and also includes `CHUTES_API_TOKEN`. This is not Baseten's OpenAI-compatible base (`https://inference.baseten.co/v1`) and makes the purported real-feed excerpt provide incorrect provider metadata to downstream catalog consumers.

## Tests

- ran: true
- passed: false

```
npm run compile passed; npm run lint completed with 0 errors (1 existing warning); npx mocha test/modelsDev.test.ts passed (22 passing). npm run test:unit was blocked by the sandbox: tests requiring localhost listeners and spawnSync git failed with EPERM.
```
