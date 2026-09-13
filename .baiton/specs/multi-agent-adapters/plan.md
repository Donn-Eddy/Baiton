# plan result

```json
{
  "steps": [
    {
      "title": "Re-verify the adapter surface the registry will wire",
      "detail": "Read-only confirmation before editing: src/adapter/adapter.ts already exports `AgentId = 'claude' | 'opencode' | 'antigravity' | 'codex'` and `AGENT_BINARY` (T01, done). The four adapter classes exist and are exported: `ClaudeAdapter` (src/adapter/claude.ts:22, `readonly id = 'claude' as const`, constructor takes an optional `PermissionMode` defaulting to `DEFAULT_PERMISSION_MODE`), `OpencodeAdapter` (src/adapter/opencode.ts:42), `AntigravityAdapter` (src/adapter/antigravity.ts:44), `CodexAdapter` (src/adapter/codex.ts:79) — the latter three take no constructor arguments and carry their own per-CLI permission mapping (opencodeAgentFlags / antigravityModeFlags / codexPermissionFlags), so the `PermissionMode` flip applies to claude only. Confirm there are no top-level export-name collisions between the four modules before adding `export *` lines: the only module-level helper shared by name is the non-exported `describeProbeError`/`PROBE_TIMEOUT_MS` in each file, which do not leak through a barrel. No source change in this step.",
      "files": [
        "src/adapter/adapter.ts",
        "src/adapter/claude.ts",
        "src/adapter/opencode.ts",
        "src/adapter/antigravity.ts",
        "src/adapter/codex.ts",
        "src/adapter/permissions.ts"
      ]
    },
    {
      "title": "Export the three new adapters from the src/adapter barrel",
      "detail": "In src/adapter/index.ts, add `export * from './opencode';`, `export * from './antigravity';` and `export * from './codex';` after the existing `export * from './claude';`, keeping the existing order (adapter, permissions, claude, then the new ones). Update the file's leading doc comment: it currently says the barrel ships 'the single first-pass Claude adapter'; reword to state that the barrel exposes the adapter boundary, the shared permission helpers, and the four per-CLI adapters (claude, opencode, antigravity/agy, codex) plus the agent-id keyed registry, still keeping the Requirement 14.1 reference that an adapter owns only launch args, the probe and the continue flag.",
      "files": [
        "src/adapter/index.ts"
      ]
    },
    {
      "title": "Add an `isAgentId` type guard for unvalidated config strings",
      "detail": "In src/adapter/index.ts (below the re-exports), add `export function isAgentId(value: string): value is AgentId` implemented as `Object.prototype.hasOwnProperty.call(AGENT_BINARY, value)` (derive from the `AGENT_BINARY` keys rather than a second hand-written literal list, so adding a future agent id to adapter.ts cannot desync the guard). This is needed because `RoleConfig.agent` is an unconstrained `string` (src/config/types.ts:20) and loadConfig.ts only checks it is non-empty (src/config/loadConfig.ts:293) — T06's per-role lookup and T07's per-agent executable resolution both need to narrow a config string to `AgentId` and report a clear error for an unknown one. Import `AGENT_BINARY` and the `AgentId` type from './adapter' at the top of index.ts (a value import for AGENT_BINARY, `import type` for AgentId, matching the codebase's existing type-import style).",
      "files": [
        "src/adapter/index.ts",
        "src/adapter/adapter.ts",
        "src/config/types.ts",
        "src/config/loadConfig.ts"
      ]
    },
    {
      "title": "Add the agent-id -> Adapter registry in src/adapter/index.ts",
      "detail": "Add to src/adapter/index.ts:\n\n1. `export interface AdapterRegistry` with: `get(agent: string): Adapter | undefined` (returns undefined for any string that is not a known agent id — callers surface the error, the registry never throws and never silently falls back to claude); `require(agent: AgentId): Adapter` (non-optional accessor for call sites that have already narrowed, so they need no non-null assertion); and `readonly ids: readonly AgentId[]` (the known ids, for diagnostics and for T07's 'resolve one executable per distinct configured agent id' loop).\n\n2. `export function createAdapterRegistry(mode: PermissionMode = DEFAULT_PERMISSION_MODE): AdapterRegistry` — builds one instance per id eagerly into a `Record<AgentId, Adapter>`: `{ claude: new ClaudeAdapter(mode), opencode: new OpencodeAdapter(), antigravity: new AntigravityAdapter(), codex: new CodexAdapter() }`. Typing the literal as `Record<AgentId, Adapter>` makes a future `AgentId` addition a compile error here, which is the point of the registry. Adapters are stateless (launch/attach are pure; probe only spawns `<bin> --version`), so sharing one instance per id across roles and runs is safe and keeps `probe()` call sites unchanged. `mode` is threaded to `ClaudeAdapter` only — document in the doc comment that the `readOnlyFallbackToAcceptEdits` flip (Requirement 15.7) is claude-specific and the other three carry their own CLI-native permission mapping.\n\n3. Implement `get` as `isAgentId(agent) ? instances[agent] : undefined`.\n\nWrite doc comments in the established house style: a block comment above the interface and the factory explaining the why (roles may mix agents, so the engine needs a per-role lookup instead of the single `new ClaudeAdapter()` at src/activation/commands.ts:164) and citing Requirement 14.1 for the adapter boundary. Do not add a mutable register/deregister API — the id set is closed by `AgentId`, and a fixed factory keeps the wiring auditable.",
      "files": [
        "src/adapter/index.ts",
        "src/adapter/adapter.ts",
        "src/adapter/permissions.ts",
        "src/adapter/claude.ts",
        "src/adapter/opencode.ts",
        "src/adapter/antigravity.ts",
        "src/adapter/codex.ts"
      ]
    },
    {
      "title": "Leave all engine/activation wiring untouched",
      "detail": "Do not modify src/activation/commands.ts, src/engine/launcher.ts, src/engine/runQueue.ts, src/engine/specDraft.ts, src/engine/submitPr.ts, src/activation/executable.ts, src/extension.ts or package.json in this todo. The registry must be additive: `new ClaudeAdapter()` at src/activation/commands.ts:164 and the single `Adapter` threaded through `LaunchDeps`/`RunQueue`/`specDraft`/`submitPr` keep working exactly as today, and the swap to a per-role lookup is T06 (with executable resolution in T07 and the settings entries in T08). Existing tests that construct `new ClaudeAdapter()` directly (test/adapter.claude.test.ts, test/adapter.launch.property.test.ts, test/engineFacade.resume.test.ts) must not need edits.",
      "files": [
        "src/activation/commands.ts",
        "src/engine/launcher.ts",
        "src/engine/runQueue.ts",
        "src/engine/specDraft.ts",
        "src/engine/submitPr.ts"
      ]
    },
    {
      "title": "Verify: type-check, lint, and the existing suite",
      "detail": "Run `npm run compile` (tsc -p ./) to confirm the widened barrel and the `Record<AgentId, Adapter>` literal type-check and that no re-export in the barrel collides. Run `npm run lint` (eslint src test --ext .ts) for the new file content. Run `npm test` (mocha) — nothing in this todo changes behavior, so the suite must be green with no test edits; a failure here means the barrel export or the registry leaked into existing wiring and should be undone rather than papered over with a test change.",
      "files": [
        "package.json",
        "test/adapter.claude.test.ts"
      ]
    }
  ],
  "risks": [
    "Barrel export collisions: `export * from` four sibling modules silently drops nothing but fails to compile on a duplicate top-level export name. Today the four adapter modules use per-CLI prefixes (OPENCODE_*, ANTIGRAVITY_*, CODEX_*) and distinct class names, so there is no clash — but a later adapter that exports an unprefixed helper would break the barrel. `npm run compile` is the guard.",
    "Sharing one adapter instance per id assumes adapters stay stateless. `launch`/`attach` are pure and `probe` only spawns `<bin> --version`, which holds for all four today; if a future adapter caches per-run state, the registry would need per-call construction instead.",
    "The registry's `mode: PermissionMode` parameter only reaches `ClaudeAdapter`. That is correct today (the other three map permissions via their own CLI-native flags: opencode `--agent`, agy `--mode`, codex `--sandbox`/`--ask-for-approval`), but it is an asymmetry worth documenting so nobody assumes flipping `readOnlyFallbackToAcceptEdits` changes the non-claude roles.",
    "`RoleConfig.agent` is an unvalidated `string`, so an unknown agent id can only be caught at lookup time. `get` returning `undefined` (rather than throwing or defaulting to claude) pushes the user-facing error onto T06/T07; if those todos forget to handle `undefined`, the failure mode is a crash or a silent claude fallback. Calling that out here is why `require` exists as the narrowed-only accessor.",
    "No test is added for the registry in this todo (the spec's test todos are T09–T11 for the three adapters, with T12 running the full suite). The registry therefore has no direct coverage until T06 exercises it; if the reviewer wants coverage sooner, a small test asserting `get` for each id, `get('nope') === undefined`, and that `ids` matches the `AGENT_BINARY` keys is cheap to add.",
    "Scope creep into the engine: it is tempting to also switch src/activation/commands.ts to the registry while the file is open. Doing so here would collide with T06 and would break the 'default (claude-only) config behavior unchanged' check that T12 makes."
  ],
  "acceptance": [
    "src/adapter/index.ts re-exports './opencode', './antigravity' and './codex' alongside the existing './adapter', './permissions' and './claude', and its leading doc comment no longer describes the barrel as shipping only the first-pass Claude adapter.",
    "`import { OpencodeAdapter, AntigravityAdapter, CodexAdapter } from '../src/adapter'` resolves and type-checks (previously only `ClaudeAdapter` was reachable from the barrel).",
    "`createAdapterRegistry()` returns a registry whose `get('claude')`, `get('opencode')`, `get('antigravity')` and `get('codex')` each yield an `Adapter` whose `id` equals the requested key.",
    "`get` returns `undefined` for an unrecognized agent string (e.g. 'gemini', '', 'Claude') without throwing, so callers can surface their own error; `require(id)` returns a non-optional `Adapter` for a narrowed `AgentId`.",
    "`registry.ids` contains exactly the four `AgentId` values and matches the keys of `AGENT_BINARY`, and `isAgentId` is derived from `AGENT_BINARY` rather than a duplicated literal list.",
    "`createAdapterRegistry(mode)` passes `mode` to the claude adapter (a registry built with `{ readOnlyFallbackToAcceptEdits: true }` produces claude launch args using the acceptEdits fallback) while the other three adapters are unaffected.",
    "The registry's `Record<AgentId, Adapter>` construction makes an omitted agent id a compile error, so adding an id to `AgentId` in adapter.ts forces a registry update.",
    "No file outside src/adapter/index.ts is modified: src/activation/commands.ts still constructs `new ClaudeAdapter()` and the engine still takes a single injected `Adapter`.",
    "`npm run compile`, `npm run lint` and `npm test` all pass with no edits to existing tests."
  ]
}
```
