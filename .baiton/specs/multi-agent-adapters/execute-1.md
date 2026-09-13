# execute result

```json
{
  "summary": "Replaced the single ClaudeAdapter instance threaded through commands.ts, RunQueue, SpecDraftRunner, and submitPr with a per-role adapter lookup (adapterForRole) resolved from the T05 AdapterRegistry and each role's configured `agent` id. Every dispatch site now resolves and probes the role's own adapter (never a shared/default one) before launching, and refuses with a new `unknown-agent` kind (classified as a hard halt in surface.ts) when a role names an unsupported agent id. The View command resolves its adapter from the journal-recorded stage's role and warns instead of throwing on an unknown agent. LaunchDeps.adapter and launchStage's signature/behavior are unchanged except for a clarifying doc comment. Updated all engine test doubles to the renamed dependency and added a new test asserting the unknown-agent refusal writes no state, launches no terminal, and never probes.",
  "files_changed": [
    "src/adapter/index.ts",
    "src/engine/runQueue.ts",
    "src/engine/specDraft.ts",
    "src/engine/submitPr.ts",
    "src/engine/launcher.ts",
    "src/activation/commands.ts",
    "src/activation/surface.ts",
    "test/runQueue.approvalGate.property.test.ts",
    "test/runQueue.attemptCount.property.test.ts",
    "test/runQueue.revert.property.test.ts",
    "test/runQueue.serialization.property.test.ts",
    "test/integration.plan-execute-review.test.ts",
    "test/engineFacade.resume.test.ts",
    "test/submitPr.test.ts",
    "test/engine.specDraft.test.ts"
  ],
  "commands_run": [
    "npm run compile",
    "npm run lint",
    "npm test"
  ],
  "notes": [
    "src/adapter/index.ts was not modified beyond what T05 already landed; it already exposed isAgentId/AdapterRegistry/createAdapterRegistry exactly as this todo's plan assumed, so it required no edits.",
    "runQueue.ts's launchAndComplete takes the already-resolved Adapter as an explicit parameter (the plan's preferred form) rather than re-resolving adapterForRole a second time, removing any probe/launch divergence risk.",
    "commands.ts gained a private `adapterForRole(config, adapters, role)` helper sited next to the existing `modelForRole` helper, matching that file's existing style (option 3 in the plan).",
    "Default .baiton/config.json still names `claude` for all six roles, so every launch/attach spec remains byte-identical to before this todo; test/adapter.launch.property.test.ts and test/integration.plan-execute-review.test.ts pass unchanged.",
    "No changes to src/activation/executable.ts, src/extension.ts, or package.json (left for T07/T08); adapters still emit the bare binary name as shellPath.",
    "All 410 existing tests plus the new unknown-agent test pass; npm run compile and npm run lint are clean."
  ]
}
```
