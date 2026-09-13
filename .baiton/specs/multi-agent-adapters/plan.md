# plan result

```json
{
  "steps": [
    {
      "title": "Establish the verification baseline: compile, lint, and the full suite",
      "detail": "Run, in order and from the repo root: `npm run compile` (tsc -p ./, with the copy:media precompile step), `npm run lint` (eslint src test --ext .ts), and `npm test` (mocha over the .mocharc.json glob test/**/*.test.ts). Also run the two split scripts `npm run test:unit` and `npm run test:property` to confirm neither split is silently skipping files the default glob picks up. Baseline measured on the current tree at commit a0f2a1c: compile exit 0, lint exit 0, `npm test` = 515 passing / 1 pending, no failures. The single pending test is 'fails migration for an older version with no upgrade path and leaves the file unchanged' in the config-version migration suite -- it is pre-existing, unrelated to the adapter work, and must be left alone (do NOT try to 'fix' it as part of this todo). If the baseline is still fully green, T12 has no breakage to repair and the todo's work becomes the confirmation coverage in steps 2-5; record the exact command output tails for the result summary either way.",
      "files": [
        "package.json",
        ".mocharc.json"
      ]
    },
    {
      "title": "Fix any breakage surfaced by step 1 (expected: none)",
      "detail": "Only if step 1 is not green. Triage each failure into one of three buckets and fix accordingly. (a) Type errors from the widened `AgentId` union (src/adapter/adapter.ts) -- a test or src site that still assumes `id: 'claude'` or a `Record<'claude', ...>` shape; widen the annotation rather than narrowing the union back. (b) Failures from the per-role wiring -- a test constructing `LaunchDeps`/`RunQueueDeps`/`SpecDraftDeps`/`SubmitPrDeps` with the removed single `adapter` field instead of the `adapterForRole(role)` seam (see src/engine/runQueue.ts:248, src/engine/specDraft.ts:101, src/engine/submitPr.ts:73; src/engine/launcher.ts:105 still takes a single already-selected `adapter`, which is correct -- the caller selects it). (c) Failures from per-agent executable resolution -- a test still assuming one global `canDispatch`; the current shape is `resolveAgentExecutables` returning an `AgentExecutables` table with per-agent `get`/`errorFor` (src/activation/executable.ts) and a per-role gate in src/activation/commands.ts. Prefer fixing the test to match the shipped engine shape; change src only if a genuine defect is proven, and say so explicitly in the result notes.",
      "files": [
        "src/adapter/adapter.ts",
        "src/engine/runQueue.ts",
        "src/engine/specDraft.ts",
        "src/engine/submitPr.ts",
        "src/activation/executable.ts",
        "src/activation/commands.ts"
      ]
    },
    {
      "title": "Pin default (claude-only) config behavior as unchanged, in test/adapter.claude.test.ts",
      "detail": "This is the todo's named deliverable ('confirming default (claude-only) config behavior is unchanged') and the reason test/adapter.claude.test.ts is the listed file. Append one describe block, e.g. describe('default claude-only config is unchanged by the multi-agent wiring'), importing `defaultConfig` from '../src/config/defaultConfig', `createAdapterRegistry` from '../src/adapter', `AGENT_BINARY` from '../src/adapter/adapter', and `ROLES` from '../src/model/role'. Assert: (1) every role in ROLES has `defaultConfig().roles[role].agent === 'claude'` -- the default config still selects claude for all six roles (src/config/defaultConfig.ts). (2) `createAdapterRegistry().get(defaultConfig().roles[role].agent)` is defined and has `id === 'claude'` for every role. (3) The behavioral equivalence that matters: for every role in ROLES, and for both a fresh request and a resume-with-prior-id request, `registry.get('claude')!.launch(req({role, ...}))` deepStrictEqual `new ClaudeAdapter().launch(req({role, ...}))`, and the same for `attach({role, runId, sessionId})` -- i.e. routing through the registry produces byte-identical argv to the pre-T06 direct `new ClaudeAdapter()` construction. (4) `shellPath === AGENT_BINARY.claude` on both launch and attach, which pins the one adapter that still hard-codes its binary name (src/adapter/claude.ts:12 `const CLAUDE_BIN = 'claude'`) against the shared map the executable resolver reads. Reuse the file's existing `req()` and `findPair()` helpers; do not duplicate them.",
      "files": [
        "test/adapter.claude.test.ts",
        "src/config/defaultConfig.ts",
        "src/adapter/index.ts",
        "src/adapter/claude.ts"
      ]
    },
    {
      "title": "Close the T05 registry coverage gap with test/adapter.registry.test.ts",
      "detail": "`createAdapterRegistry`, `isAgentId` and the `AdapterRegistry` interface (src/adapter/index.ts) are the seam every dispatch site now depends on, and nothing under test/ imports them today (only test/activation.gating.test.ts touches the adapter module, and only for AGENT_BINARY). Add a small focused file. Assert: (1) `registry.ids` deepStrictEqual the keys of AGENT_BINARY, in the same order, so a future agent id cannot be added to the map without an instance. (2) For each id in AGENT_BINARY, `registry.require(id).id === id` and `registry.get(id)!.id === id` -- catching a copy-paste mis-wiring such as codex mapped to the antigravity instance. (3) `registry.get()` returns undefined for unknown strings: 'gemini', '', ' claude ', 'CLAUDE' (case-sensitive), and 'toString'/'constructor'/'__proto__' -- the last group pins that `isAgentId` uses `Object.prototype.hasOwnProperty.call` rather than `in`/truthy indexing. (4) Instances are stable within one registry (`registry.get('claude') === registry.get('claude')`) and independent across registries (two `createAdapterRegistry()` calls yield different claude instances), matching the doc comment's stateless-sharing claim. (5) The `mode` argument threads to claude only: build `createAdapterRegistry({readOnlyFallbackToAcceptEdits: true})` and assert its claude adapter's launch args for a read-only role carry the acceptEdits fallback (use the same ACCEPT_EDITS_MODE / READ_ONLY_ALLOWED_TOOLS constants the claude test uses), while the default registry's claude adapter does not, and that the opencode/antigravity/codex adapters' args are byte-identical between the two registries (the flip is claude-specific).",
      "files": [
        "test/adapter.registry.test.ts",
        "src/adapter/index.ts",
        "src/adapter/permissions.ts",
        "test/adapter.claude.test.ts"
      ]
    },
    {
      "title": "Close the unknown-agent branch gap in specDraft and submitPr",
      "detail": "src/engine/runQueue.ts:452-458 has an unknown-agent refusal that is covered (test/runQueue.approvalGate.property.test.ts:308). The mirrored branches at src/engine/specDraft.ts:168-174 and src/engine/submitPr.ts:131-136 are not exercised by any test -- test/engine.specDraft.test.ts:190 and test/submitPr.test.ts:220 both wire `adapterForRole: () => adapter`, so the undefined path never runs. Add one test to each existing file, following the runQueue test's shape: override the existing deps with `adapterForRole: () => undefined`, drive the same entry point the happy-path test uses, and assert the failure `kind` matches the code's refusal kind (read it from the source rather than assuming it is 'unknown-agent' in all three), that the message names the role and points at \"roles.<role>.agent\" in .baiton/config.json, and -- the important part -- that no probe ran and no terminal was created (assert the stub adapter's probe counter stays 0 and the terminal host recorded no creation), pinning that the refusal happens before any process is spawned.",
      "files": [
        "test/engine.specDraft.test.ts",
        "test/submitPr.test.ts",
        "src/engine/specDraft.ts",
        "src/engine/submitPr.ts",
        "test/runQueue.approvalGate.property.test.ts"
      ]
    },
    {
      "title": "Re-verify: compile, lint, full suite, and record the deltas",
      "detail": "Re-run `npm run compile`, `npm run lint`, `npm test`, `npm run test:unit` and `npm run test:property`. All must be exit 0 with zero failures. The passing count must be the 515 baseline plus exactly the tests added in steps 3-5, and the pending count must still be exactly 1 (the pre-existing config-version migration test) -- a second pending entry means something was accidentally skipped rather than fixed. Capture the output tail for the result file. State explicitly in the summary whether step 2 had to change anything (expected: no), and list any src/ file touched with the defect that justified it.",
      "files": [
        "test/adapter.claude.test.ts",
        "test/adapter.registry.test.ts",
        "test/engine.specDraft.test.ts",
        "test/submitPr.test.ts"
      ]
    }
  ],
  "risks": [
    "The premise of T12 ('fix any existing test or type-check breakage') is already satisfied on the current tree: compile, lint and the full 515-test suite are green at commit a0f2a1c. The real hazard is therefore scope drift -- treating a green suite as licence to refactor. Steps 3-5 add confirmation coverage for the genuinely untested seams (registry, default-config equivalence, two unknown-agent branches) and nothing else; do not restructure adapters, config or engine wiring under this todo.",
    "src/adapter/claude.ts still defines its own `const CLAUDE_BIN = 'claude'` (line 12) while opencode/antigravity/codex all derive their binary from `AGENT_BINARY`. That is a latent drift between the adapter's shellPath and the name the executable resolver looks up on PATH. Step 3 pins it with an assertion in the test rather than editing src: changing claude.ts is outside T12's stated scope (T01 owned src/adapter/adapter.ts) and would touch the one adapter this spec promises not to change the behavior of. If the executor believes the src change is warranted, record it as a follow-up rather than making it.",
    "The probe tests in the three new-adapter test files depend on ambient PATH (they accept either outcome by design, and the empty-PATH cases restore process.env.PATH in a finally). Any new test added here must not mutate PATH or cwd without restoring it -- a leak would make the suite order-dependent and would surface as a flake in the full run rather than in a single-file run.",
    "`npm test` runs the default mocha glob, which is the same set as test:unit + test:property combined. Running only one split and reporting it as 'the full suite' would miss breakage; step 1 and step 6 deliberately run all three.",
    "The exact refusal `kind` strings differ or could differ between runQueue, specDraft and submitPr (runQueue uses 'unknown-agent'). Step 5 must read each source's refusal literal rather than copying runQueue's, or the new tests will fail spuriously and tempt an unwarranted src edit.",
    "The default-config equivalence test in step 3 compares registry-routed argv against a directly constructed ClaudeAdapter in the same process; it proves the wiring is transparent but does not prove parity with the pre-T06 released behavior. That stronger claim rests on test/adapter.claude.test.ts and test/adapter.launch.property.test.ts being unmodified since before this spec -- verify with `git log --oneline -- test/adapter.claude.test.ts test/adapter.launch.property.test.ts` and note the finding rather than assuming it.",
    "`registry.ids` deepStrictEqual against Object.keys(AGENT_BINARY) pins insertion order of an object literal. That is intentional (it forces a new agent id to be registered in both places) but will need updating whenever an agent is added; the test comment must say so, or a future contributor will read the failure as a bug."
  ],
  "acceptance": [
    "`npm run compile` (tsc -p ./) exits 0 with no errors.",
    "`npm run lint` (eslint src test --ext .ts) exits 0 with no errors or warnings.",
    "`npm test` exits 0 with zero failures, a passing count equal to the 515 baseline plus the tests added by this todo, and exactly 1 pending -- the pre-existing, unrelated config-version migration test, which is left untouched.",
    "`npm run test:unit` and `npm run test:property` each exit 0 with zero failures.",
    "test/adapter.claude.test.ts contains a block proving default claude-only behavior is unchanged: every role in defaultConfig() is agent 'claude'; the registry resolves each to an adapter with id 'claude'; and registry-routed launch()/attach() argv is deepStrictEqual to directly-constructed ClaudeAdapter argv for every role on both the fresh and resume branches.",
    "The claude adapter's shellPath is asserted equal to AGENT_BINARY.claude on both launch and attach, pinning the hard-coded CLAUDE_BIN literal against the shared agent-id -> binary map.",
    "createAdapterRegistry / isAgentId have direct test coverage: ids match AGENT_BINARY's keys, every id maps to an adapter whose .id is that same id, unknown and prototype-inherited strings return undefined, instances are stable per registry, and the PermissionMode flip affects the claude adapter only.",
    "The unknown-agent refusal branches in src/engine/specDraft.ts and src/engine/submitPr.ts are each covered by a test asserting the refusal kind and message and that no probe ran and no terminal was created.",
    "No behavioral change is made to src/adapter/claude.ts or to any other src/ file unless a genuine defect is demonstrated; the result file names every src/ file touched, with the justification, or states plainly that none were."
  ]
}
```
