# execute result

```json
{
  "summary": "Verified the baseline was already fully green (npm run compile, npm run lint, npm test = 515 passing / 1 pending, npm run test:unit = 456 passing / 1 pending) at commit a0f2a1c, so no src/ breakage needed fixing (step 2 was a no-op, as the plan expected). Added the confirmation coverage the todo asks for: (1) a new describe block in test/adapter.claude.test.ts pinning that defaultConfig() still selects claude for every role, that the registry resolves each role's agent to the claude adapter, that registry-routed launch()/attach() argv is byte-identical to a directly constructed ClaudeAdapter for every role on both the fresh and resume branches, and that shellPath equals AGENT_BINARY.claude on both launch and attach; (2) a new file test/adapter.registry.test.ts covering createAdapterRegistry/isAgentId directly: ids match AGENT_BINARY's keys in order, every id resolves to an adapter with a matching .id, unknown/edge strings (including prototype-inherited names) return undefined, instances are stable within a registry and independent across registries, and the PermissionMode flip affects only the claude adapter (opencode/antigravity/codex argv is byte-identical between a flipped and default registry); (3) one new test each in test/engine.specDraft.test.ts and test/submitPr.test.ts covering the previously-uncovered unknown-agent refusal branches in specDraft.ts and submitPr.ts, asserting the refusal kind ('unknown-agent'), the message content, and that no probe ran (added a probeCount counter to each file's StubAdapter) and no terminal was created. Re-ran the full verification suite after the additions: compile and lint remain clean, and npm test / npm run test:unit / npm run test:property all report 534 passing (515 baseline + 19 new tests) and exactly 1 pending (the pre-existing, untouched config-version migration test) -- zero failures, zero unexpected skips.",
  "files_changed": [
    "test/adapter.claude.test.ts",
    "test/adapter.registry.test.ts",
    "test/engine.specDraft.test.ts",
    "test/submitPr.test.ts"
  ],
  "commands_run": [
    "npm run compile",
    "npm run lint",
    "npm test",
    "npm run test:unit",
    "npm run test:property"
  ],
  "notes": [
    "No src/ file was modified. Step 2 (fix any breakage) had nothing to do: the tree was already green at commit a0f2a1c before any T12 work.",
    "Pre-existing, out-of-scope observation: the `test:property` npm script (`mocha \"test/**/*.test.ts\" ... ` via .mocharc.json's configured `spec`) does not actually isolate the 34 `*.property.test.ts` files -- it runs the full 515/534-test suite regardless of the glob passed on the command line, because mocha's config-file `spec` setting takes precedence over the CLI positional glob unless a filtering flag like `--ignore` is also given (which is why `test:unit`'s `--ignore` flag correctly narrows to 456/475 tests while `test:property`'s bare glob does not narrow at all). This does not hide any failures -- it just means `npm run test:property` currently runs strictly more than its name implies. It predates this todo's changes, is unrelated to the multi-agent adapter work, and was left unfixed per the plan's explicit scope boundary (do not restructure anything beyond the todo's named deliverables); flagging it here as a follow-up rather than touching package.json/.mocharc.json.",
    "src/adapter/claude.ts still hard-codes `const CLAUDE_BIN = 'claude'` instead of deriving it from AGENT_BINARY.claude, per the plan's flagged risk. Left unchanged (out of scope for T12, which owns test coverage rather than adapter behavior); pinned instead with an assertion (shellPath === AGENT_BINARY.claude) in the new adapter.claude.test.ts block so any future drift between the literal and the shared map fails loudly.",
    "git log --oneline -- test/adapter.claude.test.ts test/adapter.launch.property.test.ts shows a single prior commit ('Refactor code structure for improved readability and maintainability'), consistent with the plan's caveat about verifying parity assumptions rather than assuming them; no evidence either file was altered specifically for this spec's adapter work.",
    "Passing count went from 515 to 534, i.e. exactly 19 new tests: 4 in adapter.claude.test.ts, 13 in the new adapter.registry.test.ts, and 1 each in engine.specDraft.test.ts and submitPr.test.ts. Pending count stayed at exactly 1 (the pre-existing config-version migration test) in every run."
  ]
}
```
