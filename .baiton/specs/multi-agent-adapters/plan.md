# plan result

```json
{
  "steps": [
    {
      "title": "Widen the Adapter.id union to the four agent ids",
      "detail": "In src/adapter/adapter.ts change the `Adapter` interface's `readonly id: 'claude'` to `readonly id: 'claude' | 'opencode' | 'antigravity' | 'codex'`. This is the only change needed to the interface itself: `ClaudeAdapter.id = 'claude' as const` in src/adapter/claude.ts already satisfies the widened union without modification, and the new adapters (T02-T04) will each declare their own literal id ('opencode' | 'antigravity' | 'codex' respectively) which will now type-check against the interface.",
      "files": [
        "src/adapter/adapter.ts"
      ]
    },
    {
      "title": "Add a canonical AgentId type alongside the widened union",
      "detail": "Introduce an exported `export type AgentId = 'claude' | 'opencode' | 'antigravity' | 'codex';` in src/adapter/adapter.ts and change `Adapter.id` to `readonly id: AgentId;`. Centralizing the union in one named type (rather than repeating the literal union) gives T05 (the adapter registry) and T06/T07 (per-role adapter/executable lookup) a single type to import and key their `Record<AgentId, ...>` maps against, avoiding drift between the adapter id union and the registry/executable-map keys.",
      "files": [
        "src/adapter/adapter.ts"
      ]
    },
    {
      "title": "Add the agent-id -> CLI-binary-name map",
      "detail": "In src/adapter/adapter.ts add an exported constant, e.g. `export const AGENT_BINARY: Record<AgentId, string> = { claude: 'claude', opencode: 'opencode', antigravity: 'agy', codex: 'codex' };`. Place it near the top of the file next to the `Adapter` interface (adapter.ts is the shared adapter-boundary module all four adapter implementations and the future registry/executable resolver import from, per the OVERVIEW's requirement for 'one canonical home'). Each adapter implementation (claude.ts today, opencode.ts/antigravity.ts/codex.ts in T02-T04) should reference `AGENT_BINARY[<its id>]` instead of hard-coding its own `_BIN` constant, so the mapping lives in exactly one place.",
      "files": [
        "src/adapter/adapter.ts",
        "src/adapter/claude.ts"
      ]
    },
    {
      "title": "Update ClaudeAdapter to source its binary name from the shared map (optional but recommended for T01 scope)",
      "detail": "In src/adapter/claude.ts, either leave `const CLAUDE_BIN = 'claude';` as-is (since it already matches AGENT_BINARY.claude and T01's stated file scope is only src/adapter/adapter.ts) or, if the map is meant to be authoritative from the start, replace the local constant with `import { AGENT_BINARY } from './adapter'` and use `AGENT_BINARY.claude`. Recommendation: keep claude.ts untouched in T01 to honor the todo's stated file scope (files: src/adapter/adapter.ts only) and let T02-T04 establish the AGENT_BINARY-based pattern in the new adapter files; revisit claude.ts's local constant only if T12's cleanup pass flags the duplication.",
      "files": [
        "src/adapter/adapter.ts"
      ]
    },
    {
      "title": "Verify no other code depends on the narrower literal id type",
      "detail": "Search for `.id ===` / `Adapter['id']` / any place that pattern-matches on `id: 'claude'` narrowly (src/adapter/index.ts re-exports only; src/extension.ts and src/activation/executable.ts use free-standing string constants CLAUDE_AGENT/CLAUDE_EXECUTABLE, not Adapter.id, so they are unaffected by this widening). Confirm with a repo-wide grep for `adapter.id` and `Adapter.id` that nothing assumes the id is always `'claude'` in a way that would now fail to type-check or behave incorrectly once other ids become possible.",
      "files": [
        "src/adapter/adapter.ts"
      ]
    },
    {
      "title": "Type-check and run the existing test suite",
      "detail": "Run the project's TypeScript compiler/build and `test/adapter.claude.test.ts` to confirm the widened union and the new AGENT_BINARY map compile cleanly and change no runtime behavior for the existing single-adapter (claude-only) path. No test file changes should be required for T01 since ClaudeAdapter's behavior and id are unchanged; T09-T11 add the new adapters' own test files later.",
      "files": [
        "src/adapter/adapter.ts",
        "test/adapter.claude.test.ts"
      ]
    }
  ],
  "risks": [
    "Widening `Adapter.id` to a union removes the type-level guarantee that any given Adapter instance is specifically ClaudeAdapter; any code (now or added later) that relies on `id` narrowing to `'claude'` by default must be checked, though today's single-adapter wiring (src/activation/commands.ts:164) constructs ClaudeAdapter directly and does not branch on `.id`, so this risk is currently theoretical.",
    "If `AGENT_BINARY`'s keys and the `AgentId` union are defined separately rather than derived from one another, they can drift as new agents are added; using `Record<AgentId, string>` (rather than a plain object) makes TypeScript enforce that every AgentId has a binary name and vice versa, closing this gap at compile time.",
    "The OVERVIEW notes agy's binary name ('agy') differs from its adapter id ('antigravity') — a naive implementation might reuse the id as the binary name; the map must be consulted rather than assumed to guard against this specific mismatch.",
    "Downstream tasks (T02-T07) depend on this file's exact export names (`AgentId`, `AGENT_BINARY`); picking clear, stable names now avoids rework, since T05's registry and T07's executable resolution are both specified to read from 'one canonical home' introduced here."
  ],
  "acceptance": [
    "src/adapter/adapter.ts exports a type (e.g. `AgentId`) that is the union `'claude' | 'opencode' | 'antigravity' | 'codex'`, and `Adapter.id` is typed as that union instead of the literal `'claude'`.",
    "src/adapter/adapter.ts exports a `Record<AgentId, string>` constant mapping claude->claude, opencode->opencode, antigravity->agy, codex->codex.",
    "The existing ClaudeAdapter in src/adapter/claude.ts continues to type-check and its exported `id` value (`'claude'`) is still assignable to the widened `Adapter.id` type with no behavior change.",
    "The full existing test suite (in particular test/adapter.claude.test.ts) and the TypeScript build pass unchanged, confirming default (claude-only) config behavior is unaffected by this widening.",
    "No other source files besides src/adapter/adapter.ts are modified in this task, matching the todo's declared file scope; T02-T07 pick up the new type/map from this single file."
  ]
}
```
