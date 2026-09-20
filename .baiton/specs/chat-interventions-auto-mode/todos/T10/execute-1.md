# Execute T10

## Summary

Implemented T10: the auto-mode stage-(b) risk evaluator. Made `CompletionRequest.tools` optional in modelClient.ts (`toWireTools(req.tools ?? [])`, JSDoc updated). Appended the stage-(b) section to src/orchestrator/autoMode.ts with a type-only `./modelClient` import (host-free preserved): `EvaluatedDecision`, `EvaluateOptions`, `MAX_FIELD_CHARS`/`MAX_ARGS_CHARS` with `oneLine`/`truncateArgs` helpers, the `RISK_EVALUATION_PROMPT` (untrusted-data rule, when-in-doubt-escalate rule, one-JSON reply contract), pure `buildEvaluationMessages`, total defensive `parseEvaluation` (every malformed/ambiguous reply escalates; no approve without a non-empty rationale), `evaluateAsk` calling the injected client tool-free with signal forwarding and all thrown errors mapped to escalate, and `decideAsk` composing allow-list-first (zero client calls on a stage-(a) approval) with model stage mapping. Added test/autoMode.evaluator.test.ts covering prompt shape/determinism, args truncation, approve/escalate, fenced and prose-wrapped JSON, whitespace normalisation, ten malformed-reply refusal rows, client-throws (UnreachableEndpointError and plain Error), signal forwarding, prompt injection contained in the <ask> fence, and both decideAsk branches.

## Files changed

- `src/orchestrator/modelClient.ts`
- `src/orchestrator/autoMode.ts`
- `test/autoMode.evaluator.test.ts`

## Commands run

- `npm run compile`
- `npx mocha test/autoMode.evaluator.test.ts`
- `npm run lint`
- `grep -n "^import" src/orchestrator/autoMode.ts`

## Notes

- npm run compile passes with no TypeScript errors.
- The project's mocha run executes the whole suite: 1043 passing, 1 pending, 0 failures, including the new evaluator suite and test/autoMode.allowList.test.ts.
- npm run lint reports no problems.
- src/orchestrator/autoMode.ts stays host-free: the only ./modelClient import is `import type { ChatMessage, ModelClient }`, erasing http/https at compile time.
- AgentAllowList lookup tests use agentAllowList('claude', 'planner', 'run-1') for the read approval and 'reviewer' for the `rm -rf /` case — planner's claude allow-list has no shell rule, so the escalation reason there is 'planner may not use shell tools', not the unsafe-command reason.
