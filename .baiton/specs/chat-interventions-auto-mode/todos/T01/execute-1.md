# Execute T01

## Summary

Implemented the core intervention model, pending-ask registry, InterventionSeam, and ConfirmSeam adapter in src/orchestrator/interventions.ts, updated JSDoc in src/orchestrator/seams.ts, re-exported interventions from src/orchestrator/index.ts, added unit tests in test/interventions.test.ts, and ensured all tests pass.

## Files changed

- `src/orchestrator/interventions.ts`
- `src/orchestrator/seams.ts`
- `src/orchestrator/index.ts`
- `test/interventions.test.ts`
- `.mocharc.json`

## Commands run

- `npm run compile`
- `npx mocha --no-config test/interventions.test.ts --require ts-node/register`
- `npm run lint`
- `npm test`

## Notes

- Created host-free src/orchestrator/interventions.ts defining InterventionRequest (question, confirm, permission), Intervention, InterventionAnswer, checkAnswer validator, PendingAskRegistry, InterventionSeam, and confirmSeamFrom adapter.
- checkAnswer enforces validator rules: declined is universally valid, questions validate options or allowed free text and reject approvals, while confirms and permissions only accept approval or decline.
- PendingAskRegistry stores active asks in insertion order, stamps id and timestamp from injected Clock/IdGenerator, settles answers idempotently, and guarantees clean teardown via rejectAll.
- ConfirmSeam in seams.ts documentation updated to explain its role as an adapter over InterventionSeam; index.ts exports all types and helpers without naming collisions.
- Added test/interventions.test.ts covering checkAnswer rules, registry create/resolve/reject/rejectAll/pending lifecycle, presentation failures, and the ConfirmSeam adapter.
- Configured .mocharc.json with node-option no-strip-types so mocha runs cleanly in Node 24.
