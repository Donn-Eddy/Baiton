# Execute T09

## Summary

Implemented T09 Auto mode core: persona-derivable allow-lists plus a pure deterministic first gate.

1. `src/adapter/roleProfile.ts`: added `runDirGlob(runId)`, `AllowedToolFamily`, `ToolAllowRule`, `AgentAllowList`, and `roleAllowList(agent, role, runId)` deriving rules purely from `ROLE_PROFILES` (read/search always unscoped; write scoped by the profile's write scope; shell rule only when `profile.shell`).
2. `src/adapter/permissions.ts`: added dependency-free `parseAllowedTools` (comma split outside parentheses, `Name(pattern)` entries, whitespace tolerant) and `claudeAllowList(role, runId, mode)` derived from `permissionFlags` output — `--allowedTools` specs map through a `CLAUDE_TOOL_FAMILY` table onto `ToolAllowRule`s, with the Write rule substituted by the concrete `runDirGlob(runId)` so no rule reaches beyond the agent's own run dir; `--permission-mode acceptEdits` falls back to `roleAllowList`.
3. `src/adapter/opencode.ts`: added `opencodeAllowList(role, runId)` derived from `opencodeAgentDefinition` — `edit` allow keys become write paths via `toGlob` (trailing `/*` widened to `/**/*`, bare `*` to the any-file glob), deny keys dropped; no `bash` block (or a non-blocking one) yields a shell rule; read/search always unscoped.
4. `src/adapter/index.ts`: added `agentAllowList(agent, role, runId, mode?)` dispatching claude → `claudeAllowList`, opencode → `opencodeAllowList`, and everything else (codex, antigravity, unknown ids) → the profile-derived `roleAllowList`.
5. `src/orchestrator/autoMode.ts` (new, host-free: no vscode/fs/activation/model imports): exports `AutoModeAsk`, `askFromPermission`, `AutoModeDecision`, `TOOL_FAMILIES`, `toolFamily` (own-property `__proto__` guard), `askPaths`, `normalizeAskPath` (rejects absolute/drive/`file://`/`..` paths), `SAFE_SHELL_PREFIXES`, `shellCommandIsSafe` (rejects `; && || | \` $( > < <<newline>>` and unrecognised prefixes), and the pure gate `allowListDecision` (agent check → tool family → rule family → unscoped read/search approve → write path-glob check with every-path-must-match → shell safe-prefix check), with approve rationales one-lining agent/role/tool/rule and escalate reasons non-empty; export added to `src/orchestrator/index.ts` after `interventions`.
6. `test/autoMode.allowList.test.ts` (new, host-free): parseAllowedTools tables, the loop over every `Role` × 5 agent ids asserting run-dir write confinement and the shell-rule/profile equivalence, claude/opencode derivation specifics, `toolFamily`/`askPaths`/`normalizeAskPath`/`shellCommandIsSafe` helpers, the full allowListDecision table (12 rows), agent mismatch, determinism + allow-list immutability via structuredClone, and `askFromPermission`.

Verification: `npm run compile`, `npx mocha test/autoMode.allowList.test.ts`, `npm run lint`, and full `npm test` all pass with 0 failures (1005 tests); the pre-existing adapter tests pass unchanged.

One deliberate deviation from the plan text, documented in code: `runDirGlob` returns `.baiton/runs/<id>/**/*` (not `<prefix>**`). Empirical check against `src/orchestrator/glob.ts` (`globToRegExp`) shows `**` compiles to segments-only `(?:[^/]+/)*` with no trailing file component, so `<dir>/**` matches directories but never a file such as `.baiton/runs/<id>/result.json`; appending the final `/*` component (`**` then `/*`) compiles to `(?:[^/]+/)*[^/]*`, which matches both direct and nested run-dir files, pinning the nested-path acceptance row. Similarly, opencode's `edit` star is normalised to `**/*` and the profile's `workspace: 'write'` scope emits `['**', '**/*']`.

## Files changed

- `src/adapter/roleProfile.ts`
- `src/adapter/permissions.ts`
- `src/adapter/opencode.ts`
- `src/adapter/index.ts`
- `src/orchestrator/autoMode.ts`
- `src/orchestrator/index.ts`
- `test/autoMode.allowList.test.ts`

## Commands run

- `npm run compile`
- `npx mocha test/autoMode.allowList.test.ts`
- `npm run lint`
- `npm test`
- `npx mocha test/autoMode.allowList.test.ts test/adapter.roleProfile.test.ts test/adapter.claude.test.ts test/adapter.opencode.test.ts test/adapter.index.test.ts`

## Notes

- Glob semantics deviation (documented): glob.ts compiles `**` to `(?:[^/]+/)*` — no trailing file component — so `dir/**` matches directories only. runDirGlob uses `<prefix>**/*` (compiled `(?:[^/]+/)*[^/]*`) to cover nested files; opencode's `/*` rule is rewritten to `**/*` the same way and the workspace-write scope emits `['**', '**/*']`.
- claude write-rule paths substitute the concrete runDirGlob(runId) for the spec's broad `.baiton/runs/**` pattern, since the acceptance criterion forbids any write rule reaching outside `.baiton/runs/<runId>/`; the substitution is recorded in the rule's reason string (e.g. `claude --allowedTools Write(.baiton/runs/**)`).
- JSDoc cannot spell the `**/*` sequence literally (it contains `*/`, closing the comment); the docs describe it as a `**` then `/*` form instead.
- autoMode.ts stays stage-(a)-pure: no ModelClient, transcript, activation or workspaceState coupling — escalations are exactly the interface stage (b) will consume.
