# plan result

```json
{
  "steps": [
    {
      "title": "Re-confirm the settings surface before editing (read-only)",
      "detail": "What exists today. package.json's `contributes.configuration` block (line 220) declares a flat `properties` map whose only agent entry is `baiton.agents.claude.path` (223-227): `{\"type\": \"string\", \"default\": \"\", \"description\": \"Override path to the Claude CLI executable. When set, this path is used instead of searching PATH.\"}`. The remaining properties (`baiton.git.remote`, `baiton.pr.toolPath`, `baiton.git.base`, `baiton.orchestrator.*`) follow; the block ends at line 270. The consumer is `settingsOverride` in src/extension.ts:267-271: it reads `vscode.workspace.getConfiguration('baiton').get<string>(`agents.${agent}.path`)` and treats an unset/blank value as no override, so the key shape is already fully generic — this todo only makes the three new keys *declared* (a VS Code `getConfiguration().get` on an undeclared key returns `undefined`, which is why T07's plan recorded the new-agent overrides as inert until now). The canonical id list is `AGENT_BINARY` at src/adapter/adapter.ts:16-21 (`claude`->`claude`, `opencode`->`opencode`, `antigravity`->`agy`, `codex`->`codex`); T07 landed `resolveAgentExecutables`, which resolves one executable per distinct configured agent through that map and the same `settingsOverride` seam. No source change in this step, and no source change is needed at all for the override to start working — the plumbing is already agent-keyed.",
      "files": [
        "package.json",
        "src/extension.ts",
        "src/activation/executable.ts",
        "src/adapter/adapter.ts"
      ]
    },
    {
      "title": "Declare the three new baiton.agents.<agent>.path settings in package.json",
      "detail": "In `contributes.configuration.properties`, immediately after `baiton.agents.claude.path` (so the four agent overrides sit together and read in `AGENT_BINARY` declaration order), add:\n\n```json\n\"baiton.agents.opencode.path\": {\n  \"type\": \"string\",\n  \"default\": \"\",\n  \"description\": \"Override path to the opencode CLI executable. When set, this path is used instead of searching PATH.\"\n},\n\"baiton.agents.antigravity.path\": {\n  \"type\": \"string\",\n  \"default\": \"\",\n  \"description\": \"Override path to the Antigravity CLI executable (agy). When set, this path is used instead of searching PATH.\"\n},\n\"baiton.agents.codex.path\": {\n  \"type\": \"string\",\n  \"default\": \"\",\n  \"description\": \"Override path to the Codex CLI executable. When set, this path is used instead of searching PATH.\"\n},\n```\n\nThree points of care:\n1. The key segment is the *agent id*, not the binary name — `baiton.agents.antigravity.path`, never `baiton.agents.agy.path`. `settingsOverride` interpolates the id it was handed (`agents.${agent}.path`) and `resolveAgentExecutables` hands it the id from `config.roles[role].agent`, so an `agy`-keyed setting would never be read. The binary name belongs only in the description, where it tells the user which executable the path must point at.\n2. Keep the description sentence shape identical to claude's (\"Override path to the X CLI executable. When set, this path is used instead of searching PATH.\") so the four rows read as one family in the Settings UI; the antigravity row is the only one that needs the extra `(agy)` disambiguation, because its id and binary differ.\n3. `\"default\": \"\"` is what makes the blank-means-unset contract in `settingsOverride` correct — do not use `null` or omit the default, and do not add `\"scope\"`, since the existing claude entry uses the implicit `window` scope and the override is read from the window-level configuration.\n\nNothing else in package.json changes: no new `activationEvents`, `commands`, `menus`, or dependencies.",
      "files": [
        "package.json"
      ]
    },
    {
      "title": "Add a packaging-gating test that ties the settings to AGENT_BINARY",
      "detail": "The todo names only package.json, but a manifest-only change has no compile-time guard at all: nothing in src/ references these keys by literal, so a typo (`antigrvaity`, `.paht`, a missing entry for a future id) ships silently and shows up only as an override that mysteriously does nothing. The cheapest guard is one case in the existing `describe('packaging gating (Req 23.1, 23.2, 23.4)')` block of test/activation.gating.test.ts (line 362), which already parses the real package.json into `pkg` in a `before` hook.\n\nAdd:\n```ts\nit('declares an executable-override setting for every supported agent id (Req 22.7)', () => {\n  const props = (pkg.contributes as { configuration?: { properties?: Record<string, { type?: string; default?: unknown }> } })\n    .configuration?.properties;\n  assert.ok(props, 'contributes.configuration.properties must be present');\n  for (const agent of Object.keys(AGENT_BINARY)) {\n    const entry = props[`baiton.agents.${agent}.path`];\n    assert.ok(entry, `missing baiton.agents.${agent}.path setting`);\n    assert.strictEqual(entry.type, 'string');\n    assert.strictEqual(entry.default, '');\n  }\n});\n```\nImport `AGENT_BINARY` from '../src/adapter/adapter' (the map's canonical home; the test file already imports from '../src/...' paths directly). Driving the loop from `Object.keys(AGENT_BINARY)` rather than a literal list is the whole point — a fifth agent id added later fails this test until its setting is declared. Extend the file's coverage doc comment (lines 31-41) with a bullet for the new case. If the executing agent judges this out of T08's stated file list, it is the one deviation worth taking; record it in the execution summary.",
      "files": [
        "test/activation.gating.test.ts",
        "src/adapter/adapter.ts",
        "package.json"
      ]
    },
    {
      "title": "Verify the manifest and the suite",
      "detail": "1. `node -e \"JSON.parse(require('fs').readFileSync('package.json','utf8'))\"` — a stray/missing comma in a hand-edited manifest is the realistic failure mode here and it would not be caught by tsc.\n2. `grep -n 'baiton.agents' package.json` — expect exactly four lines, ids `claude`, `opencode`, `antigravity`, `codex`, matching `Object.keys(AGENT_BINARY)`.\n3. `npm run compile`, `npm run lint`, `npm test` — all three must pass (compile/lint only matter if step 3's test was added; the suite must stay green either way, with the new case included).\n4. Sanity-check the end-to-end path by reading, not running: `settingsOverride` (src/extension.ts:267) now returns a real value for e.g. `baiton.agents.codex.path`, `resolveAgentExecutables` passes it to `resolveExecutable`, and a stale override yields the existing `override-missing` error rather than a silent PATH fallback — that is the pre-existing, intended behaviour and this todo does not change it.\n5. Do not touch src/ at all, do not add test/adapter.*.test.ts files (T09-T11), and do not run the wider breakage sweep (T12).",
      "files": [
        "package.json",
        "test/activation.gating.test.ts",
        "src/extension.ts"
      ]
    }
  ],
  "risks": [
    "The obvious trap is keying the antigravity setting by its binary name: `baiton.agents.agy.path` looks right next to `AGENT_BINARY.antigravity === 'agy'` but would never be read, because `settingsOverride` interpolates the agent *id* from `config.roles[role].agent`. The setting key must be `baiton.agents.antigravity.path`; the string `agy` appears only in the human-readable description.",
    "A hand-edited JSON manifest has no type checking — a missing or trailing comma breaks extension activation entirely and no test in the suite except the packaging block's `JSON.parse` would notice. Validate the file parses before committing.",
    "A stale override is a hard failure, not a fallback: `resolveExecutable` reports `override-missing` when the configured path does not exist rather than searching PATH. Declaring these keys therefore gives users a new way to disable an agent for themselves by pointing at a path that later disappears. That is the existing, deliberate claude behaviour extended to three more agents, not a regression — but it is worth a sentence in the execution summary.",
    "The declaration alone does not make the new CLIs work end to end; T09-T11 (adapter tests) and T12 (suite sweep) are still pending, and the override is read once at activation, so changing it needs a window reload. Do not widen this todo into making the new agents reachable, and do not add a settings watcher.",
    "The settings-UI rows are ordered by declaration; inserting the three entries anywhere other than beside the claude row would scatter the agent overrides among the git/pr/orchestrator settings. Cosmetic, but it is the only reason placement is specified.",
    "Adding a case to test/activation.gating.test.ts goes beyond the todo's declared file list (`package.json`). It is a deliberate, small deviation to give the manifest a guard; a reviewer who wants strict scope adherence can drop step 3 without affecting the rest of the todo."
  ],
  "acceptance": [
    "package.json declares `baiton.agents.opencode.path`, `baiton.agents.antigravity.path` and `baiton.agents.codex.path` alongside the existing `baiton.agents.claude.path`, each `\"type\": \"string\"` with `\"default\": \"\"`.",
    "Every setting key is segmented by the agent *id*, so the set of `baiton.agents.<id>.path` keys equals `Object.keys(AGENT_BINARY)` exactly; no key is named after a binary (`agy`).",
    "Each description follows the claude row's sentence shape, and the antigravity description names the `agy` binary so the user knows which executable the path must point at.",
    "The four agent overrides appear together, in `AGENT_BINARY` order, ahead of the git/pr/orchestrator settings.",
    "package.json still parses as JSON and no other part of the manifest (activationEvents, commands, menus, views, dependencies, scripts) is modified.",
    "No file under src/ is modified: the override plumbing (`settingsOverride`, `resolveAgentExecutables`) already handles arbitrary agent ids and needs no change.",
    "A packaging-gating test derives the expected setting keys from `AGENT_BINARY` so a future agent id cannot be added without its override setting (or, if step 3 was dropped, the omission is stated explicitly in the execution summary).",
    "`npm run compile`, `npm run lint` and `npm test` all pass, with no change in behaviour for a default all-claude config."
  ]
}
```
