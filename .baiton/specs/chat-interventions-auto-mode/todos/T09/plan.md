# Plan T09

## Steps

1. Add the shared allow-list vocabulary to the role profile module

   In `src/adapter/roleProfile.ts` (the single source of truth for per-role policy) add, below `runDirPattern`, the host-free types and the profile-derived default allow-list that every adapter specialises.

   Add:
   - `export function runDirGlob(runId: string): string { return `${runDirPattern(runId)}**`; }` — the `**` form is required because `src/orchestrator/glob.ts` treats a single `*` as non-separator-crossing, so opencode's `.baiton/runs/<id>/*` rule would not match `.baiton/runs/<id>/sub/file.json`. Document that in the JSDoc.
   - `export type AllowedToolFamily = 'read' | 'search' | 'write' | 'shell';` — the canonical, CLI-independent families every harness tool name is normalised onto.
   - `export interface ToolAllowRule { family: AllowedToolFamily; /** repo-relative globs the rule is scoped to; absent means any path */ paths?: readonly string[]; /** short human reason used in the audit rationale, e.g. 'run-dir write grant' */ reason: string; }`
   - `export interface AgentAllowList { agent: string; role: Role; runId: string; rules: readonly ToolAllowRule[]; }`
   - `export function roleAllowList(agent: string, role: Role, runId: string): AgentAllowList` — derives rules purely from `ROLE_PROFILES[role]`:
     * always `{ family: 'read', reason: 'every role may read' }` and `{ family: 'search', reason: 'every role may search' }` (no `paths`);
     * `profile.write === 'workspace'` → `{ family: 'write', paths: ['**'], reason: 'workspace write scope' }`; otherwise `{ family: 'write', paths: [runDirGlob(runId)], reason: 'run-dir write grant' }`;
     * `profile.shell === true` → `{ family: 'shell', reason: 'role profile grants shell' }`; when false, emit no shell rule.

   This is the fallback allow-list for adapters with no granular permission data of their own (codex, antigravity — see their JSDoc: codex runs `--sandbox workspace-write` for every role and antigravity has only `--mode plan|accept-edits`, so neither exposes a finer table than the profile).

   Files: `src/adapter/roleProfile.ts`

2. Derive claude's allow-list from the existing --allowedTools / --permission-mode data

   In `src/adapter/permissions.ts`, add a parser over the flag strings that already exist there so the allow-list and the launch flags cannot drift.

   Add:
   - `export function parseAllowedTools(spec: string): { tool: string; paths?: string[] }[]` — splits `READ_ONLY_ALLOWED_TOOLS` / `REVIEWER_ALLOWED_TOOLS` on `,` outside parentheses, and for each entry parses `Name` or `Name(pattern)` into `{ tool, paths }`. So `'Read,Glob,Grep,Write(.baiton/runs/**)'` → `[{tool:'Read'},{tool:'Glob'},{tool:'Grep'},{tool:'Write',paths:['.baiton/runs/**']}]`. Keep it dependency-free and tolerant of whitespace.
   - `export function claudeAllowList(role: Role, runId: string, mode: PermissionMode = DEFAULT_PERMISSION_MODE): AgentAllowList` — calls `permissionFlags(role, mode)` and branches on what it returned:
     * `['--allowedTools', spec]` → map each parsed entry onto a `ToolAllowRule` via a local `CLAUDE_TOOL_FAMILY: Record<string, AllowedToolFamily>` map (`Read`→read, `Glob`/`Grep`→search, `Write`/`Edit`/`MultiEdit`→write, `Bash`→shell), with `reason: 'claude --allowedTools ' + entry`. Substitute the concrete run-dir glob: a parsed `Write` pattern plus `runDirGlob(runId)` (the `--add-dir` grant from `runDirGrant`) become the rule's `paths`.
     * `['--permission-mode', ACCEPT_EDITS_MODE]` → fall back to `roleAllowList('claude', role, runId)`, because accept-edits carries no per-tool table. This covers both the executor row and the `readOnlyFallbackToAcceptEdits` flip.
   - Import `AgentAllowList`, `AllowedToolFamily`, `ToolAllowRule`, `roleAllowList`, `runDirGlob` from `./roleProfile` (that module must not import `permissions.ts` — the dependency already points this way).

   Files: `src/adapter/permissions.ts`, `src/adapter/roleProfile.ts`

3. Derive opencode's allow-list from its agent definition's permission rules

   In `src/adapter/opencode.ts`, add `export function opencodeAllowList(role: Role, runId: string): AgentAllowList` built from `opencodeAgentDefinition(role, runId)` rather than from the role profile directly, so the gate reads exactly the table opencode is launched with.

   Implementation:
   - Read `definition.permission.edit`: collect every key whose value is `'allow'` into the write rule's `paths`, normalising each opencode glob through a local `toGlob(pattern)` that rewrites a trailing `/*` to `/**` (same non-separator-crossing reason as `runDirGlob`) and leaves `*` alone → `'**'`. Keys whose value is `'deny'` are dropped (they are the default-deny backdrop; a path only auto-approves when it matches an `allow` glob).
   - If `definition.permission.bash` is absent, emit `{ family: 'shell', reason: 'opencode agent has no bash deny rule' }`; if present with `{'*': 'deny'}`, emit no shell rule.
   - Always emit the unscoped `read` and `search` rules (opencode grants read/search to every agent; there is no rule table for them).
   - Return `{ agent: 'opencode', role, runId, rules }`.

   Files: `src/adapter/opencode.ts`

4. Expose one per-agent lookup from the adapter barrel

   In `src/adapter/index.ts`, add:

   ```ts
   export function agentAllowList(
     agent: string,
     role: Role,
     runId: string,
     mode: PermissionMode = DEFAULT_PERMISSION_MODE,
   ): AgentAllowList {
     switch (agent) {
       case 'claude': return claudeAllowList(role, runId, mode);
       case 'opencode': return opencodeAllowList(role, runId);
       // codex (--sandbox workspace-write for every role) and antigravity
       // (--mode plan|accept-edits) expose no finer table than the profile.
       default: return roleAllowList(agent, role, runId);
     }
   }
   ```

   Import `claudeAllowList` from `./permissions`, `opencodeAllowList` from `./opencode`, `roleAllowList`/`AgentAllowList` from `./roleProfile`, and `Role` from `../model/role`. An unknown agent string falls through to the profile-derived list, which is the conservative default (and never widens beyond the role's own policy). The existing `export *` lines already re-export the new symbols; do not add duplicate exports.

   Files: `src/adapter/index.ts`

5. Write the pure first gate in src/orchestrator/autoMode.ts

   New host-free module (no `vscode` import, no fs, no async). It consumes the `PermissionRequest` shape already defined in `src/orchestrator/interventions.ts` (`kind: 'permission'`, `agent`, `tool`, `args?`, `prompt`, `detail?`) and an `AgentAllowList`.

   Exports:
   - `export interface AutoModeAsk { agent: string; tool: string; args?: string; }` plus `export function askFromPermission(req: PermissionRequest): AutoModeAsk` so callers can pass an intervention straight through.
   - `export type AutoModeDecision = { kind: 'approve'; rationale: string; rule: ToolAllowRule } | { kind: 'escalate'; reason: string };` — `escalate` is what stage (b), the model evaluator, will consume in a later todo; this module never calls a model.
   - `export const TOOL_FAMILIES: Readonly<Record<string, AllowedToolFamily>>` keyed by lower-cased harness tool name: read/view/notebookread → `read`; glob/grep/list/ls/list_files/search → `search`; write/edit/multiedit/patch/apply_patch/notebookedit → `write`; bash/shell/run/execute_command → `shell`. Deliberately unmapped (so they escalate): webfetch, websearch, task, agent, and anything else.
   - `export function toolFamily(tool: string): AllowedToolFamily | undefined` — `TOOL_FAMILIES[tool.trim().toLowerCase()]` via an own-property check (a tool literally named `__proto__` must not hit the prototype; mirror the guard used in `antigravity.ts`).
   - `export function askPaths(args: string | undefined): { ok: true; paths: string[] } | { ok: false; reason: string }` — parses `args` as JSON and collects string values under the keys `file_path`, `filePath`, `path`, `notebook_path`, `file`, `target`, plus every string in an array under `paths` or `files`. Missing/blank `args` → `{ok:true,paths:[]}`; unparseable JSON or a non-object → `{ok:false, reason:'the tool arguments could not be read'}`.
   - `export function normalizeAskPath(p: string): string | undefined` — backslashes → `/`, strip a leading `./`; return `undefined` for an absolute path (`/…` or a Windows drive), a `file://` URL, or any `..` segment. `undefined` means "cannot be proven in-scope" and forces an escalate.
   - `export function shellCommandIsSafe(command: string): boolean` — deterministic conservative check: returns false when the command contains any of `;`, `&&`, `||`, `|`, `` ` ``, `$(`, `>`, `<`, or a newline; otherwise true only when its first token (after an optional leading `env`-free trim) matches `SAFE_SHELL_PREFIXES`. Export `SAFE_SHELL_PREFIXES: readonly string[]` containing read-only/verification commands: `ls`, `cat`, `head`, `tail`, `wc`, `pwd`, `which`, `rg`, `grep`, `find`, `git status`, `git diff`, `git log`, `git show`, `git branch`, `npm test`, `npm run lint`, `npm run compile`, `npm run build`, `npx tsc`, `node --version`. Match longest-prefix-first against the command's normalised whitespace.
   - `export function allowListDecision(ask: AutoModeAsk, allowList: AgentAllowList): AutoModeDecision` — the gate:
     1. `ask.agent !== allowList.agent` → escalate (`'the ask came from a different agent than the allow-list'`).
     2. `toolFamily(ask.tool)` undefined → escalate (`` `"${ask.tool}" is not on the allow-list` ``).
     3. No rule in `allowList.rules` with that family → escalate (`` `${allowList.role} may not use ${family} tools` ``).
     4. Family `read`/`search` with a rule that has no `paths` → approve. If the rule is path-scoped, fall through to the path check.
     5. Family `write`: `askPaths(ask.args)`; on `ok:false` escalate with its reason; on an empty path list escalate (`'the write target could not be determined'`); normalise every path and escalate if any is `undefined`; approve only when EVERY path matches at least one of the rule's `paths` via `matchesGlob` from `../orchestrator/glob` (import it as `./glob`).
     6. Family `shell`: extract the command from `args` (`command` or `cmd` key, same JSON parse as `askPaths` — factor the parse into a private `parseArgs`); missing command → escalate; `shellCommandIsSafe(command) === false` → escalate (`'the command is not a recognised read-only or verification command'`); otherwise approve. Document plainly in the module JSDoc that the profile's `shell: true` bit alone is not blanket approval: it makes shell *eligible*, and only the recognised safe prefixes clear the first gate — everything else goes to stage (b).
     7. Approvals return `rationale` as one line naming the agent, role, tool and matched rule reason, e.g. `` `claude/planner: Read allowed (every role may read)` `` — this string is what the later transcript audit record will carry.

   Also add `export * from './autoMode';` to `src/orchestrator/index.ts`, after the `interventions` line. Check for name collisions across the barrel (there are none for the names above) before adding it.

   Files: `src/orchestrator/autoMode.ts`, `src/orchestrator/index.ts`, `src/orchestrator/glob.ts`, `src/orchestrator/interventions.ts`

6. Unit-test the allow-list and the gate host-free

   New `test/autoMode.allowList.test.ts`, mocha + `assert`, matching the style of `test/interventions.test.ts` (plain `describe`/`it`, no vscode import, no fixtures on disk). Cover:

   - `parseAllowedTools`: `READ_ONLY_ALLOWED_TOOLS` and `REVIEWER_ALLOWED_TOOLS` parse to the expected entries, including the parenthesised `Write(.baiton/runs/**)` pattern and whitespace tolerance.
   - Derivation: for every `Role` in `ROLES` and every agent id, `agentAllowList(agent, role, 'run-1')` (a) never gives a `write` rule reaching outside `.baiton/runs/run-1/` for a role whose profile has `write: 'run-dir'`, and (b) has a `shell` rule exactly when `roleProfile(role).shell` is true (assert this as a loop over `ROLES` so a new role cannot be added without a decision).
   - claude specifics: the `readOnlyFallbackToAcceptEdits: true` mode makes a planner's list fall back to the profile-derived one; the reviewer's list has a shell rule and the planner's does not.
   - opencode specifics: `opencodeAllowList('planner','run-1')` write paths contain the `**`-widened run-dir glob and no `'*'`; `opencodeAllowList('executor','run-1')` write paths contain `'**'`; the non-shell roles get no shell rule.
   - `toolFamily`: known names in mixed case map correctly; `'WebFetch'`, `'Task'`, `''` and `'__proto__'` return `undefined`.
   - `askPaths` / `normalizeAskPath`: extracts `file_path`, `paths[]`; rejects malformed JSON; rejects `/etc/passwd`, `../outside.txt`, `C:\\x`, `file:///x`; accepts and normalises `./.baiton/runs/run-1/result.json`.
   - `allowListDecision` table, per row asserting the decision kind and (for escalations) a non-empty reason:
     * claude/planner `Read` with no args → approve.
     * claude/planner `Write {"file_path":".baiton/runs/run-1/result.json"}` → approve.
     * claude/planner `Write {"file_path":"src/app.ts"}` → escalate.
     * claude/planner `Write` with a nested run-dir path `.baiton/runs/run-1/asks/a.json` → approve (pins the `**` widening).
     * claude/planner `Bash {"command":"npm test"}` → escalate (planner has no shell rule).
     * claude/reviewer `Bash {"command":"npm test"}` → approve.
     * claude/reviewer `Bash {"command":"rm -rf build"}` → escalate.
     * claude/reviewer `Bash {"command":"git status && rm x"}` → escalate (chaining).
     * claude/executor `Edit {"file_path":"src/app.ts"}` → approve.
     * agent mismatch (`ask.agent = 'opencode'` against a claude list) → escalate.
     * `Write` with two paths, one in scope and one out → escalate.
     * unparseable `args` on a `Write` → escalate.
   - Purity: calling `allowListDecision` twice with the same inputs returns deep-equal decisions and does not mutate the allow-list (`assert.deepStrictEqual` on a structuredClone taken before the call).

   Files: `test/autoMode.allowList.test.ts`

7. Verify

   Run, from the repo root: `npm run compile`, `npx mocha test/autoMode.allowList.test.ts` (the repo `.mocharc.json` already supplies `ts-node/register` and `--node-option no-strip-types`), `npm run lint`, then the full `npm test`. The adapter changes are additive, so `test/adapter.roleProfile.test.ts`, `test/adapter.claude.test.ts`, `test/adapter.opencode.test.ts` and `test/adapter.index.test.ts` must all still pass unchanged — if any of them breaks, the derivation changed launch behaviour and that is a defect, not a test to update.

   Files: (none)

## Risks

- Glob semantics: `src/orchestrator/glob.ts` treats a single `*` as non-separator-crossing, so opencode's own `.baiton/runs/<id>/*` rule and any bare `*` would silently fail to match nested paths. The plan widens both to `**` when building the allow-list; if that widening is wrong for some future rule, the gate over-approves within the run dir.
- Blanket shell approval: the OVERVIEW derives the allow-list partly from the role profile's shell bit, which could be read as 'approve any Bash for a shell-capable role'. This plan deliberately narrows that to a recognised safe-prefix set and escalates everything else to stage (b). If the intended behaviour was blanket approval, the change is confined to step 5 rule 6 and `SAFE_SHELL_PREFIXES`.
- Tool-name coverage: harness tool names differ per CLI and per version (claude `Read`/`Bash`, opencode `read`/`bash`/`edit`, codex `apply_patch`). Any name missing from `TOOL_FAMILIES` escalates rather than approving, so the failure mode is extra round-trips, not unsafe approvals — but the map will need extending once T13-style probes report the real names.
- Derivation coupling: `claudeAllowList` parses the same string constants `permissionFlags` emits, so a future change to `READ_ONLY_ALLOWED_TOOLS` shape (for example a rule with multiple comma-separated patterns inside one set of parentheses) must be reflected in `parseAllowedTools`. The loop-over-`ROLES` test is the guard against silent drift.
- Scope discipline: this todo is stage (a) only. `autoMode.ts` must not import `ModelClient`, the transcript, or anything from `src/activation`; the model evaluator, the transcript audit records and the workspaceState toggle belong to later todos and adding them here would make this module host-coupled.

## Acceptance

- `src/orchestrator/autoMode.ts` exists, imports nothing from `vscode`, `fs`, or `src/activation`, and exports `AutoModeAsk`, `AutoModeDecision`, `TOOL_FAMILIES`, `toolFamily`, `askPaths`, `normalizeAskPath`, `SAFE_SHELL_PREFIXES`, `shellCommandIsSafe`, `askFromPermission` and `allowListDecision`.
- `allowListDecision` is pure and synchronous: same inputs give deep-equal decisions and the passed `AgentAllowList` is unmodified after the call.
- `agentAllowList(agent, role, runId, mode?)` is exported from `src/adapter/index.ts` and returns a claude list parsed from `permissionFlags`, an opencode list derived from `opencodeAgentDefinition`, and the profile-derived `roleAllowList` for codex, antigravity and any unknown agent id.
- For every `Role` with `write: 'run-dir'`, no agent's allow-list contains a write rule whose paths reach outside `.baiton/runs/<runId>/`; a shell rule is present exactly when `roleProfile(role).shell` is true.
- An ask for an unmapped tool, an unparseable `args`, an absolute or `..`-containing path, an out-of-scope write target, a chained shell command, or an unrecognised shell command all return `{ kind: 'escalate' }` with a non-empty reason; no such case returns `approve`.
- Every `approve` decision carries a one-line `rationale` naming agent, role, tool and the matched rule, plus the matched `rule` object.
- `test/autoMode.allowList.test.ts` exists, runs host-free, and covers the derivation loop over `ROLES`, the `toolFamily`/`askPaths`/`normalizeAskPath` helpers, the shell-safety check and the full `allowListDecision` table above.
- `npm run compile`, `npm run lint` and `npm test` all pass, with the pre-existing adapter tests unchanged.
