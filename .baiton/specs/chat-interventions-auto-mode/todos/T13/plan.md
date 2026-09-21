# Plan T13

## Steps

1. Probe the claude CLI for a native permission-relay surface and capture the raw evidence

   Before writing any adapter code, establish what the installed `claude` binary actually supports; only verified surfaces get shipped.

   Run and record the exact output of:
   1. `claude --version` (pin the probed version — every README finding is stated against it).
   2. `claude --help` — look for: `--settings` (does it accept an inline JSON string as well as a file path?), `--permission-prompt-tool`, `--permission-mode`, `--allowedTools`, `--add-dir`, any `hook` mention.
   3. `claude --help | grep -i -E 'hook|permission|settings'` for the flag list, and `claude doctor` only if the other two are inconclusive.
   4. Functional check of the inline-settings path (the load-bearing one). In a scratch directory run:
      `claude --settings '{"hooks":{"PreToolUse":[{"matcher":"*","hooks":[{"type":"command","command":"node -e \"process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:\\\"PreToolUse\\\",permissionDecision:\\\"deny\\\",permissionDecisionReason:\\\"baiton probe\\\"}}))\""}]}]}}' -p 'Run the Bash tool to echo hi'`
      and confirm (a) the CLI starts without rejecting the inline JSON, (b) the hook runs, (c) the `permissionDecision` is honoured (the tool call is denied with the probe reason). If inline JSON is rejected, repeat with the same JSON written to a temp file and `--settings /tmp/probe-settings.json` — note which of the two forms works.
   5. Confirm the hook's stdin event shape by replacing the probe command with one that appends its stdin to a temp file, then re-running the same `-p` prompt; record the exact field names observed (expected: `session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`) and the accepted stdout contract (`hookSpecificOutput.permissionDecision` ∈ allow|deny|ask, `permissionDecisionReason`). The adapter code below must use the field names the probe observed, not the ones assumed here.
   6. Note whether a `timeout` field is accepted on the hook entry and what happens when the hook exceeds it (the relay blocks while the user answers, so a long timeout — 600 s — plus a safe `ask` fallback on expiry is required).

   Outcome gate: the wiring in steps 2–3 ships ONLY if the probe verified (a) a settings surface reachable from argv alone (inline JSON preferred, since `Adapter.launch()` is pure and `LaunchSpec` carries only `shellPath`/`shellArgs` — it cannot write a settings file), (b) `PreToolUse` command hooks firing, and (c) the stdout permission-decision contract. If `claude` is not installed or any of (a)–(c) fails, skip steps 2–3 entirely, leave `src/adapter/claude.ts` untouched, and go straight to step 5 recording the negative/inconclusive finding — plus, if only (a) failed, the follow-up requirement that `AskRelayDescriptor` gain a settings-file path written by `src/engine/launcher.ts`.

   Files: `src/adapter/claude.ts`, `README.md`

2. Build the claude relay settings + hook command in src/adapter/permissions.ts

   Add a new exported section at the end of `src/adapter/permissions.ts` (it already owns the claude translation of Baiton policy, so the hook JSON belongs beside `permissionFlags`/`claudeAllowList`). Import `type { AskRelayDescriptor } from './adapter'` (type-only — `permissions.ts` must stay host-free; no `fs`, no `child_process`).

   Add:

   - `export const CLAUDE_RELAY_HOOK_TIMEOUT_SECONDS = 600;` — the hook blocks while the user answers the inline card; on expiry the hook returns `ask` so the interactive terminal prompt still appears (never a silent allow). Only emit the `timeout` field if the probe verified it is accepted.
   - `export const CLAUDE_RELAY_HOOK_MATCHER = '*';`
   - `function shellQuote(value: string): string` — POSIX single-quote wrap: `"'" + value.replace(/'/g, "'\\''") + "'"`. The hook `command` is executed through a shell, so the asks dir, suffixes and run id must each be quoted.
   - `export const CLAUDE_RELAY_HOOK_SCRIPT: string` — the node program run with `node -e`, passed its parameters as argv rather than interpolated, so no descriptor value is ever spliced into JavaScript source. It must contain NO single-quote characters (it is wrapped in single quotes in the command line); use double quotes and string concatenation throughout. Shape:

     `const fs=require("fs"),path=require("path");const a=process.argv.slice(1);const dir=a[0],askSuffix=a[1],respSuffix=a[2],runId=a[3],deadline=Date.now()+Number(a[4]);` then read all of stdin, `JSON.parse` it in a try/catch (an unparseable event degrades to `done("ask", ...)`), mint `const id=String(Date.now())+"-"+String(process.pid)`, build the ask object exactly matching `RelayAsk` in `src/engine/askRelay.ts` — `{version:1,id,runId,agent:"claude",kind:"permission",prompt:"claude wants to use "+tool,tool,args:JSON.stringify(ev.tool_input===undefined?{}:ev.tool_input),createdAt:new Date().toISOString()}` — `fs.mkdirSync(dir,{recursive:true})`, write `path.join(dir,id+askSuffix)` with `JSON.stringify(ask,null,2)+"\n"` (2-space indent + trailing newline, so the file is byte-identical to `serializeAsk`), then poll `path.join(dir,id+respSuffix)` every 200 ms with `setTimeout` until it reads, `JSON.parse`-ing it and calling `done(r.decision==="approve"?"allow":"deny", String(r.reason||""))`; on `deadline` expiry or any write/parse failure call `done("ask", <reason>)`. `function done(decision,reason){process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:decision,permissionDecisionReason:reason}}));process.exit(0)}` (hoisted declaration, referenced from the callbacks above).
     Use the event field names the step-1 probe actually observed for `tool_name`/`tool_input`.
   - `export function claudeAskRelayHookCommand(relay: AskRelayDescriptor): string` — `` `node -e ${shellQuote(CLAUDE_RELAY_HOOK_SCRIPT)} ${shellQuote(relay.dir)} ${shellQuote(relay.askSuffix)} ${shellQuote(relay.responseSuffix)} ${shellQuote(relay.runId)} ${CLAUDE_RELAY_HOOK_TIMEOUT_SECONDS * 1000}` ``.
   - `export function claudeAskRelaySettings(relay: AskRelayDescriptor): Record<string, unknown>` — `{ hooks: { PreToolUse: [ { matcher: CLAUDE_RELAY_HOOK_MATCHER, hooks: [ { type: 'command', command: claudeAskRelayHookCommand(relay), timeout: CLAUDE_RELAY_HOOK_TIMEOUT_SECONDS } ] } ] } }`.
   - `export function claudeRelayFlags(relay?: AskRelayDescriptor): string[]` — returns `[]` when `relay === undefined` OR `relay.protocol !== 'file-v1'` (forward-compatibility: an unknown protocol must never emit a half-understood hook), otherwise `['--settings', JSON.stringify(claudeAskRelaySettings(relay))]`.

   Document each export with the same JSDoc density as the rest of the file, and state in the module header comment that the hook shape is the one verified by the probe recorded in the README (naming the probed `claude --version`).

   Files: `src/adapter/permissions.ts`

3. Emit the relay flags from ClaudeAdapter.launch()

   In `src/adapter/claude.ts`:
   - extend the existing import from `./permissions` with `claudeRelayFlags`.
   - in `launch(req)`, insert `args.push(...claudeRelayFlags(req.relay));` immediately after `args.push(...runDirGrant(req.runId));` and before `args.push(...claudeSystemPromptFlags(req.role));`, so the settings pair stays ahead of the `--` end-of-options marker and the prompt remains the last argument.
   - leave `attach()` unchanged: its request carries no relay, and re-opening a finished session must not re-arm the hook.
   - update the `launch()` JSDoc to mention that a `req.relay` descriptor adds `--settings <inline JSON>` carrying the `PreToolUse` ask-relay hook, and that with no descriptor the argv is byte-identical to before.
   No other adapter is touched by this todo (opencode/agy/codex keep ignoring `LaunchRequest.relay`).

   Files: `src/adapter/claude.ts`

4. Extend test/adapter.claude.test.ts with the relay-wiring tests

   Add a `describe('ClaudeAdapter ask-relay hook wiring', ...)` block to the existing file, reusing its `req()` and `findPair()` helpers. Build the descriptor with the real producer so the test cannot drift: `import { askRelayDescriptor } from '../src/engine/askRelay'` and `const relay = askRelayDescriptor('/repo', 'run-123')`.

   Tests:
   1. No relay → unchanged argv: `assert.deepStrictEqual(adapter.launch(req()).shellArgs, adapter.launch(req({ relay: undefined })).shellArgs)` and `assert.ok(!adapter.launch(req()).shellArgs.includes('--settings'))`.
   2. With relay → exactly one `--settings`, positioned before the `--` separator, with the prompt still last (mirror the existing 'places the flag before the -- separator' assertions).
   3. Dropping the `--settings` pair from the relay argv yields the no-relay argv (proves nothing else moved).
   4. The `--settings` value parses as JSON and has `hooks.PreToolUse[0].matcher === CLAUDE_RELAY_HOOK_MATCHER`, one `type: 'command'` entry, and `timeout === CLAUDE_RELAY_HOOK_TIMEOUT_SECONDS`.
   5. The hook command mentions `relay.dir`, `relay.askSuffix`, `relay.responseSuffix` and `relay.runId`, each single-quoted, and `CLAUDE_RELAY_HOOK_SCRIPT` contains no `'` character (the wrapping invariant).
   6. A descriptor whose `protocol` is not `'file-v1'` (cast through `as unknown as AskRelayDescriptor`) produces no `--settings`.
   7. Per-role permission rows are unaffected: for every `ROLES` entry, the relay argv still contains the same `permissionFlags(role)` pair as the non-relay argv.
   8. Round-trip behaviour test of the emitted script, using `child_process.spawnSync(process.execPath, ['-e', CLAUDE_RELAY_HOOK_SCRIPT, dir, '.json', '.response.json', 'run-123', '3000'], { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }), encoding: 'utf8' })` against a `fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-relay-'))` directory, with a small watcher (`setInterval` is not available synchronously — instead pre-seed the loop by spawning asynchronously with `child_process.spawn`, waiting for the ask file to appear, writing the response with `writeResponse` from `src/engine/askRelay`, and awaiting exit). Assert: the ask file parses through `parseAsk` (proving the hook writes the exact wire shape the relay core accepts), stdout parses to `permissionDecision: 'allow'` for an approve response and `'deny'` for a deny response, and a run with no response written before a short (e.g. 800 ms) timeout yields `permissionDecision: 'ask'`. Give this block a generous mocha timeout (`this.timeout(10_000)`) and write it with `function () {}` (not an arrow) so `this` works. If step 1's probe was negative and no wiring shipped, omit tests 2–8 and keep test 1 as the regression pin that the claude argv is unchanged.

   Files: `test/adapter.claude.test.ts`

5. Record the probe findings and the per-adapter relay table in README.md

   Add a new `#### Harness ask relay (per-adapter probe findings)` subsection immediately after the existing `#### Agent Model & Effort Discovery (CLI Probing & Architecture)` block (README.md ends at line 224; this lands before `## Commands`). Content:

   - One sentence on the file protocol: a launched run's `.baiton/runs/<run-id>/asks/<ask-id>.json` is the ask, `<ask-id>.response.json` the answer; the run stays paused until the answer is written.
   - A **claude findings** list, each line stating the claim and the evidence from step 1, against the probed `claude --version`: whether `--settings` accepts inline JSON, that `PreToolUse` command hooks fire with `{session_id, cwd, hook_event_name, tool_name, tool_input}` on stdin, the accepted stdout contract `hookSpecificOutput.permissionDecision ∈ allow|deny|ask` with `permissionDecisionReason`, the hook `timeout` behaviour, and the deliberate `ask` fallback on relay timeout/error. Mark anything the probe could not confirm explicitly as **unverified** rather than asserting it.
   - A relay table with a row per adapter and columns `Adapter | Relay | Verified`:
     - `claude | native `PreToolUse` hook via inline `--settings` | yes (version X.Y.Z, <date>)` — or `not verified — config-driven fallback` if step 1 was negative/inconclusive.
     - `opencode`, `antigravity (agy)`, `codex` → `config-driven fallback | not probed yet` (their probes are separate todos; do not invent findings for them).
   - One line saying adapters without a verified native relay fall back to the config-driven permission layer (`permissionFlags` / `--allowedTools` / `--permission-mode`) and surface nothing inline.

   Keep the README's existing prose style (bold lead-ins, nested bullets) and wrap at the file's current width.

   Files: `README.md`

6. Verify the whole change with the repo's standard gates

   Run, in order, and report actual output:
   1. `npm run compile`
   2. `npx mocha --no-config test/adapter.claude.test.ts --require ts-node/register` (the focused suite)
   3. `npm run lint`
   4. `npm test` (full suite — `test/adapter.launch.property.test.ts` and `test/engine.askRelay.test.ts` must stay green; the no-relay argv is byte-identical so the property test should be untouched)
   5. `git status --short && git diff --stat` to confirm only the four planned files changed.
   If any gate fails, fix it before declaring the todo done; do not leave a failing or skipped test in place.

   Files: `src/adapter/claude.ts`, `src/adapter/permissions.ts`, `test/adapter.claude.test.ts`, `README.md`

## Risks

- The probe may be impossible to run: `claude` may not be installed on the machine or may not be authenticated. In that case nothing may be shipped from the adapter — record the finding as unverified in the README, keep the claude argv byte-identical, and keep only the regression test. Do not implement the hook 'on spec' and describe it as verified.
- `Adapter.launch()` is pure and `LaunchSpec` carries only `shellPath`/`shellArgs` — the adapter cannot write a settings file. If the probe shows `--settings` accepts only a file path and not inline JSON, the whole approach must be deferred: record it and note the follow-up (a settings-file path added to `AskRelayDescriptor` and written by `src/engine/launcher.ts`, which is outside this todo's file list).
- Hook event/stdout field names are assumed here (`tool_name`, `tool_input`, `hookSpecificOutput.permissionDecision`). They must be taken from the step-1 probe output; a mismatch produces a hook that silently never relays.
- The hook command is executed through a shell, so any unquoted descriptor value (a workspace path containing spaces or quotes) breaks the command. Every interpolated value goes through `shellQuote`, and the node script itself must contain no single-quote character.
- Blocking the hook while the user answers means the claude process is stalled. A missing timeout (or a timeout that yields `allow`) would either hang the run forever or auto-approve unattended: the expiry path must return `ask`, falling back to claude's own interactive prompt.
- A `matcher: '*'` PreToolUse hook fires for every tool call, including reads, which would flood the chat with cards. Auto mode's allow-list (T-series auto-mode work) absorbs these; if the probe shows a narrower matcher syntax is supported, prefer it and record it — but do not change the allow-list core in this todo.
- The end-to-end script test spawns a child process and polls the filesystem; keep the timeouts generous and the temp dir per-test, or it will be flaky in CI.
- Changing the no-relay argv by even one position would break `test/adapter.launch.property.test.ts` and the registry-parity tests; the flags must be additive and gated strictly on `req.relay` being present.

## Acceptance

- `npm run compile`, `npm run lint` and `npm test` are all green, with the full suite showing no new failures or pending tests.
- With no `relay` on the `LaunchRequest`, `ClaudeAdapter.launch()` and `attach()` produce argv byte-identical to before the change (pinned by a test and by the unchanged `adapter.launch.property.test.ts`).
- With a `file-v1` relay descriptor, `launch()` emits exactly one `--settings <json>` pair before the `--` separator, the prompt is still the final argument, and every other flag is unchanged.
- The `--settings` value parses as JSON into a `hooks.PreToolUse` entry with a single `type: 'command'` hook whose command names the descriptor's dir, both suffixes and the run id, each shell-quoted.
- Running the emitted hook script with a synthetic PreToolUse event writes an ask file that `parseAsk` from `src/engine/askRelay.ts` accepts, and the script emits `permissionDecision: 'allow'` for an approve response, `'deny'` for a deny response and `'ask'` when no response arrives before the timeout — all covered by tests.
- A relay descriptor with an unrecognized `protocol` emits no `--settings` flag.
- README.md contains a harness-ask-relay subsection recording the claude probe findings against the probed CLI version, explicitly marking anything unverified, plus a per-adapter relay table that lists claude's relay and leaves opencode/agy/codex as not-yet-probed fallback rows.
- Only `src/adapter/claude.ts`, `src/adapter/permissions.ts`, `test/adapter.claude.test.ts` and `README.md` are modified.
- Every behaviour shipped from the adapter is traceable to something the step-1 probe actually verified; anything unverified is documented in the README instead of implemented.
