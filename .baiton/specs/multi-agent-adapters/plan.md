# plan result

```json
{
  "steps": [
    {
      "title": "Re-confirm the seam surface before editing (read-only)",
      "detail": "Confirm what T05 landed and what T06 must consume. src/adapter/index.ts now exports `isAgentId(value: string): value is AgentId`, `AdapterRegistry` (`get(agent: string): Adapter | undefined`, `require(agent: AgentId): Adapter`, `readonly ids: readonly AgentId[]`) and `createAdapterRegistry(mode?: PermissionMode): AdapterRegistry`, with `get` returning `undefined` (never throwing, never falling back to claude) for an unrecognised string. The single wiring point to replace is `const adapter = new ClaudeAdapter();` at src/activation/commands.ts:164, which is threaded into four places: `createRunQueue({ adapter, ... })` (commands.ts:187), `submitPr(slug, { adapter, ... })` (commands.ts:236), `createSpecDraftRunner({ adapter, ... })` (commands.ts:272), and `registerViewCommand(..., adapter, ...)` (commands.ts:327) which forwards to `runView` and calls `adapter.attach(...)` at commands.ts:686. The engine consumes the adapter in exactly five places: `RunQueueDeps.adapter` (runQueue.ts:232), `this.deps.adapter.probe()` (runQueue.ts:443), `{ adapter: this.deps.adapter, ... }` passed to `launchStage` (runQueue.ts:595), `SpecDraftDeps.adapter` (specDraft.ts:86) used at specDraft.ts:163 and :187, and `SubmitPrDeps.adapter` (submitPr.ts:59) used at submitPr.ts:125 and :163. `launchStage` has only three callers, all in src/engine, and each already probes before launching. No source change in this step.",
      "files": [
        "src/adapter/index.ts",
        "src/adapter/adapter.ts",
        "src/activation/commands.ts",
        "src/engine/runQueue.ts",
        "src/engine/specDraft.ts",
        "src/engine/submitPr.ts",
        "src/engine/launcher.ts"
      ]
    },
    {
      "title": "Keep LaunchDeps.adapter as a resolved Adapter (deliberate non-change to launcher.ts)",
      "detail": "Do NOT turn `LaunchDeps.adapter: Adapter` (src/engine/launcher.ts:97) into a per-role lookup. Rationale, to be recorded in the launcher's `LaunchDeps` doc comment as a one-line note: every caller must resolve the role's adapter *before* `launchStage` anyway, because Requirement 14.2 makes each dispatch site probe the same adapter it is about to launch (runQueue.ts:443, specDraft.ts:163, submitPr.ts:125). Injecting a lookup into `launchStage` would resolve the same role twice and would force a new `LaunchError` variant (`unknown-agent`) into a function whose documented job is 'write the Brief, then create the terminal', pushing config-validation into the host-independent launcher. So: the per-role selection happens once at each dispatch site, and `launchStage` keeps receiving the already-chosen `Adapter`. The only edit to launcher.ts is the doc-comment sentence on `LaunchDeps.adapter` saying it is the adapter already selected for `input.role` by the caller, not a global one. This keeps launcher.ts's three callers and every existing launcher assertion untouched.",
      "files": [
        "src/engine/launcher.ts"
      ]
    },
    {
      "title": "Replace RunQueueDeps.adapter with an adapterForRole lookup",
      "detail": "In src/engine/runQueue.ts:\n\n1. Replace `adapter: Adapter;` (line 232) with `adapterForRole(role: Role): Adapter | undefined;`, placed immediately next to the existing `modelForRole(role: Role): { model: string; effort?: string }` (line 239) so the two per-role config lookups sit together, and document it in the same voice: 'Per-role adapter, selected from the role's configured `agent` id; `undefined` when that id is not a known agent (Requirement 14.1).' Keep `import type { Adapter } from '../adapter';` and add `Role` — it is already imported at line 38.\n\n2. Add a new refusal kind to `DispatchError` (line 104 region): `| { kind: 'unknown-agent'; message: string }`, with a matching bullet in the doc block above it: '`unknown-agent` — the role's configured `agent` is not a supported agent id; no stage is launched and state is unchanged.'\n\n3. In `runRequest` (around line 440), resolve the adapter immediately *before* the existing probe and refuse when it is missing, so an unknown agent id is reported as a config problem rather than as a probe failure:\n```ts\nconst adapter = this.deps.adapterForRole(req.role);\nif (adapter === undefined) {\n  return this.refuse({\n    kind: 'unknown-agent',\n    message: `role \"${req.role}\" is configured with an unsupported agent; update \"roles.${req.role}.agent\" in .baiton/config.json`,\n  });\n}\nconst probe = await adapter.probe();\n```\nKeep the refusal *after* the guard checks and before the probe, matching the existing ordering comment (guards -> probe -> launch).\n\n4. In `launchAndComplete` (the `launchStage` call at line 594), replace `adapter: this.deps.adapter` with a re-resolution for `req.role`. Because `createAdapterRegistry` hands out one shared instance per id, re-resolving yields the identical object that was probed, so there is no probe/launch divergence. Use a small private helper on `SerialRunQueue` — `private adapterFor(role: Role): Adapter | undefined { return this.deps.adapterForRole(role); }` is not worth it; instead resolve inline and treat a (structurally impossible) `undefined` as a `launch-failed` refusal with the same wording, so the code has no non-null assertion:\n```ts\nconst adapter = this.deps.adapterForRole(req.role);\nif (adapter === undefined) {\n  return this.refuse({ kind: 'unknown-agent', message: ... });\n}\n```\nAlternatively (preferred if it reads cleanly against the actual method boundary): thread the already-resolved `adapter` from `runRequest` into `launchAndComplete` as an extra parameter alongside `stage`, which resolves once and removes the second lookup entirely. Pick this second form if `launchAndComplete`'s signature is private to the class (it is), since it is strictly better than re-resolving.\n\n5. Update the module doc block's line 33 ('Everything host-specific is injected — the adapter, git service, ...') to say 'the per-role adapter lookup' instead of 'the adapter'.",
      "files": [
        "src/engine/runQueue.ts"
      ]
    },
    {
      "title": "Replace SpecDraftDeps.adapter with the same lookup",
      "detail": "In src/engine/specDraft.ts: replace `adapter: Adapter;` (line 86) with `adapterForRole(role: Role): Adapter | undefined;` beside the existing `modelForRole` (line 96), with the same doc wording. Add `| { kind: 'unknown-agent'; message: string }` to `SpecDraftRefusal` (line 68-73) with a doc bullet. In `start`, resolve `const adapter = this.deps.adapterForRole(SPEC_WRITER_ROLE);` just before the probe at line 163, refusing with `{ kind: 'unknown-agent', message: 'role \"spec-writer\" is configured with an unsupported agent; update \"roles.spec-writer.agent\" in .baiton/config.json' }` when undefined; then `await adapter.probe()` and pass `{ adapter, terminalHost: this.deps.terminalHost }` to `launchStage` at line 187 using that same local. `SPEC_WRITER_ROLE` is already the module constant, so the role that picks the adapter is provably the role that is launched. Update the module doc line 22-23 ('adapter, terminal host, ...') to name the per-role adapter lookup.",
      "files": [
        "src/engine/specDraft.ts"
      ]
    },
    {
      "title": "Replace SubmitPrDeps.adapter with the same lookup",
      "detail": "In src/engine/submitPr.ts: replace `adapter: Adapter;` (line 59) with `adapterForRole(role: Role): Adapter | undefined;` beside `modelForRole` (line 69). Add `| { kind: 'unknown-agent'; message: string }` to `SubmitPrError` (around line 77-82). `submitPr` is a plain function, so resolve once near the top of the launch section: replace the probe at line 125 with a resolve-then-probe pair keyed on the literal role `'pr-writer'` (the same literal already used at line 144 for `modelForRole` and line 151 for the launch input), failing with `fail({ kind: 'unknown-agent', message: 'role \"pr-writer\" is configured with an unsupported agent; update \"roles.pr-writer.agent\" in .baiton/config.json' })`. Pass the resolved local into `launchStage` at line 163 (`{ adapter, terminalHost: deps.terminalHost }`). Update the module doc line 20 the same way. Note `describeSubmitPrError` (commands.ts:896) only special-cases `verify-failed` and otherwise returns `error.message`, so the new kind needs no change there.",
      "files": [
        "src/engine/submitPr.ts",
        "src/activation/commands.ts"
      ]
    },
    {
      "title": "Wire the registry and a config-backed adapterForRole in commands.ts",
      "detail": "In src/activation/commands.ts:\n\n1. Change the import at line 81-82 from `import { ClaudeAdapter } from '../adapter';` to `import { createAdapterRegistry } from '../adapter';`, keeping `import type { Adapter } from '../adapter';` (still needed for the View command's parameter types) and adding `import type { AdapterRegistry } from '../adapter';`.\n\n2. Replace `const adapter = new ClaudeAdapter();` (line 164) with `const adapters = createAdapterRegistry();` plus a bound lookup right below the existing shared seams:\n```ts\nconst adapters = createAdapterRegistry();\nconst adapterForRole = (role: Role): Adapter | undefined =>\n  adapters.get(config.roles[role].agent);\n```\nAdd a short comment in the house voice: roles may mix agents, so each dispatch site selects its adapter from the role's configured `agent` id instead of sharing one instance (Requirement 14.1). `createAdapterRegistry()` is called with no argument so the claude adapter keeps `DEFAULT_PERMISSION_MODE` — identical to today's `new ClaudeAdapter()`.\n\n3. Add a sibling to the existing `modelForRole` helper at the bottom of the file (line 1184) so the two per-role config reads live together and are unit-testable in the same shape: `function adapterForRole(config: Config, adapters: AdapterRegistry, role: Role): Adapter | undefined { return adapters.get(config.roles[role].agent); }` and call it as `(role) => adapterForRole(config, adapters, role)` at each wiring site. Use whichever of (2) or (3) matches the file's existing style — do not do both.\n\n4. Replace the three `adapter,` dep entries with `adapterForRole: (role) => adapterForRole(config, adapters, role),` at `createRunQueue` (line 187), `submitPr` (line 236) and `createSpecDraftRunner` (line 272), placing each next to the existing `modelForRole` line.\n\n5. The View command (line 327, 635, 669, 686) attaches to a *recorded* run, whose role comes from `STAGE_ROLE[entry.stage]` — that role's configured agent is what must attach. Change `registerViewCommand`'s and `runView`'s `adapter: Adapter` parameters to `adapterForRole: (role: Role) => Adapter | undefined`, and in `runView` resolve after the journal entry is read:\n```ts\nconst role = STAGE_ROLE[entry.stage];\nconst adapter = adapterForRole(role);\nif (adapter === undefined) {\n  surface.warn(`Baiton: role \"${role}\" is configured with an unsupported agent; update \"roles.${role}.agent\" in .baiton/config.json`);\n  return;\n}\nconst spec = adapter.attach({ role, runId: entry.runId, sessionId: entry.sessionId });\n```\nThis is the one attach path in the codebase, so a mixed-agent config now reopens the session in the CLI that created it — note this in `runView`'s doc comment. Pass the lookup through at line 327.\n\n6. Leave `ensureExecutable`/`ensureCanDispatch` (lines 732-755) and their 'Claude executable' wording exactly as they are — per-agent executable resolution and per-role dispatch gating are T07.",
      "files": [
        "src/activation/commands.ts",
        "src/adapter/index.ts",
        "src/config/types.ts"
      ]
    },
    {
      "title": "Classify unknown-agent as a hard halt in the surface",
      "detail": "src/activation/surface.ts:89 has an `isHardHalt(kind)` switch over `DispatchError['kind']` with a `default: return false`, so the new kind compiles without an edit but would be surfaced as a soft warning. A misconfigured `roles.<role>.agent` is a configuration fault the user must fix before any stage of that role can run — the same class as `probe-failed` — so add `case 'unknown-agent':` to the hard-halt list and extend the method's doc comment listing ('Probe failure, invalid result, git-state drift, ...') to mention an unsupported configured agent. This is the only file outside the todo's named set that changes, and it is a two-line edit.",
      "files": [
        "src/activation/surface.ts",
        "src/engine/runQueue.ts"
      ]
    },
    {
      "title": "Update the engine test doubles that construct the renamed dep",
      "detail": "Renaming the dep is a compile break in the existing suite, and the tree must compile at the end of this todo (T12 only re-runs and confirms). Apply the mechanical rename `adapter: X` -> `adapterForRole: () => X` in each deps literal — the doubles are role-agnostic stubs, so a constant-returning arrow is faithful:\n- test/runQueue.approvalGate.property.test.ts:190 (`okAdapter`)\n- test/runQueue.revert.property.test.ts:273 (the `const adapter: Adapter` double at :231)\n- test/runQueue.serialization.property.test.ts:253 (double at :207)\n- test/runQueue.attemptCount.property.test.ts:234 (double at :181)\n- test/integration.plan-execute-review.test.ts:456 and :767 (`new StubAdapter()`)\n- test/engineFacade.resume.test.ts:150 and :205 (`new ClaudeAdapter()`)\n- test/submitPr.test.ts:214 (the harness's `adapter` local at :207; keep returning the same instance so the `h.adapter.launches` assertions at :308-309 still observe it)\n- test/engine.specDraft.test.ts:186 and :201 (the `StubAdapter` at :164; keep `h.adapter` reachable for the assertion at :265)\nDo not weaken or delete any assertion. test/adapter.claude.test.ts and test/adapter.launch.property.test.ts construct `ClaudeAdapter` directly and need no change.",
      "files": [
        "test/runQueue.approvalGate.property.test.ts",
        "test/runQueue.revert.property.test.ts",
        "test/runQueue.serialization.property.test.ts",
        "test/runQueue.attemptCount.property.test.ts",
        "test/integration.plan-execute-review.test.ts",
        "test/engineFacade.resume.test.ts",
        "test/submitPr.test.ts",
        "test/engine.specDraft.test.ts"
      ]
    },
    {
      "title": "Add focused coverage for the unknown-agent refusal",
      "detail": "Add one small test to the existing run-queue suite (test/runQueue.approvalGate.property.test.ts already builds a full deps literal; prefer whichever run-queue test file has the lightest harness, or a new test/runQueue.unknownAgent.test.ts if none fits) asserting that a queue whose `adapterForRole` returns `undefined` refuses an otherwise-legal dispatch with `kind: 'unknown-agent'`, launches no terminal, does not call `probe`, and leaves the todo's state unchanged. This is the one behavioural addition in T06 and the registry's first real exercise (the T05 plan flagged that the registry had no direct coverage), so it is worth a test even though T09-T11 cover the adapters themselves.",
      "files": [
        "test/runQueue.approvalGate.property.test.ts",
        "src/engine/runQueue.ts"
      ]
    },
    {
      "title": "Verify: type-check, lint, suite, and default-config behaviour",
      "detail": "Run `npm run compile` (tsc -p ./), `npm run lint` (eslint src test --ext .ts) and `npm test` (mocha). All three must pass. Then confirm the no-behaviour-change property that T12 will re-check: with the default config (every role's `agent` is `claude`), `adapterForRole(role)` returns the registry's single `ClaudeAdapter` built with `DEFAULT_PERMISSION_MODE`, so every launch/attach spec is byte-identical to today's — the existing launch-argument assertions in test/adapter.launch.property.test.ts and the integration test passing unchanged is the evidence. Check the default `.baiton/config.json` shipped/templated by the repo still names `claude` for all six roles.",
      "files": [
        "package.json",
        "src/config/loadConfig.ts",
        "test/adapter.launch.property.test.ts",
        "test/integration.plan-execute-review.test.ts"
      ]
    }
  ],
  "risks": [
    "Probe/launch divergence: Requirement 14.2 demands the adapter that is probed be the adapter that launches. Resolving twice (once before the probe, once at the launchStage call) is only safe because `createAdapterRegistry` returns one shared instance per id and `config` is captured once at `registerCommands` time. Threading the resolved `adapter` from `runRequest` into `launchAndComplete` as a parameter removes the assumption entirely and is the recommended form.",
    "Renaming `RunQueueDeps.adapter` / `SpecDraftDeps.adapter` / `SubmitPrDeps.adapter` breaks eight test files at compile time. They are mechanical one-line renames, but if any is missed the whole suite fails to compile and the failure will look unrelated to this todo. `npm run compile` before `npm test` localises it.",
    "Adding `unknown-agent` to `DispatchError`, `SpecDraftRefusal` and `SubmitPrError` widens three public unions. Consumers are non-exhaustive today (`isHardHalt` has a `default`, `describeSubmitPrError` falls through to `error.message`), so nothing breaks — but that also means a forgotten `surface.ts` case would silently downgrade a config fault to a warning. That is exactly why the surface edit is its own step.",
    "`config.roles[role].agent` is an unvalidated string (src/config/types.ts:20; loadConfig.ts only checks non-empty), so a typo like `Claude` or `agy` (the binary name, not the agent id `antigravity`) resolves to `undefined` and refuses at dispatch rather than at config load. That is the behaviour T05 deliberately chose (`get` never falls back to claude), but it means the user only learns at first dispatch. Tightening validation in loadConfig is out of scope here; if it is wanted, it belongs in its own todo, not smuggled into T06.",
    "Scope creep into T07: it is tempting, while commands.ts is open, to also make `ensureExecutable`/`canDispatch` per-agent and to feed the resolved executable path into the adapter's `shellPath`. Doing so here would collide with T07 and break the 'default config behaviour unchanged' check. Adapters keep emitting the bare binary name as `shellPath` in this todo.",
    "The View/attach path is the one place where the role comes from a journal entry rather than a live request. If a role's configured agent is changed between a run and a later View, `attach` will use the *new* agent's CLI against a session id minted by the old one. The journal records no agent id today, so this todo cannot fix it; the mitigation is only that the unknown-agent branch warns instead of crashing. Worth flagging to the reviewer as a known limitation of mixed-agent configs.",
    "`submitPr` and `specDraft` hard-code their roles (`'pr-writer'`, `SPEC_WRITER_ROLE`). Resolving the adapter from those same literals keeps selection and launch in lockstep, but a future caller that parameterises the role must remember to resolve from the same value — hence resolving into a single local that is used for both the probe and the launch input."
  ],
  "acceptance": [
    "`src/activation/commands.ts` no longer constructs `new ClaudeAdapter()`; it builds one `createAdapterRegistry()` and derives a per-role lookup from `config.roles[role].agent`.",
    "`RunQueueDeps`, `SpecDraftDeps` and `SubmitPrDeps` each expose `adapterForRole(role: Role): Adapter | undefined` in place of `adapter: Adapter`, sited next to the existing `modelForRole`.",
    "In every dispatch site the adapter that is probed is the same instance passed to `launchStage` for that role, with no non-null assertion and no fallback to claude.",
    "`LaunchDeps.adapter` is still a resolved `Adapter` and `launchStage`'s signature, return type and `LaunchError` union are unchanged; only its doc comment records that the caller selects the adapter for `input.role`.",
    "A role configured with an unrecognised agent id refuses the dispatch with `kind: 'unknown-agent'`, writes no state, creates no terminal, and never calls `probe()`; the message names the role and points at `roles.<role>.agent` in `.baiton/config.json`.",
    "The same refusal exists for the spec-draft runner (`SpecDraftRefusal`) and for `submitPr` (`SubmitPrError`), and `surface.ts` classifies the run-queue `unknown-agent` kind as a hard halt (error, not warning).",
    "The View command resolves its adapter from `STAGE_ROLE[entry.stage]`'s configured agent and warns rather than throwing when that agent id is unknown.",
    "With the default all-claude config, every launch and attach spec is identical to before this todo: test/adapter.launch.property.test.ts and test/integration.plan-execute-review.test.ts pass with no assertion changes.",
    "No change to `src/activation/executable.ts`, `src/extension.ts` or `package.json` (T07/T08), and adapters still emit the bare binary name as `shellPath`.",
    "`npm run compile`, `npm run lint` and `npm test` all pass, including a new test covering the `unknown-agent` refusal."
  ]
}
```
