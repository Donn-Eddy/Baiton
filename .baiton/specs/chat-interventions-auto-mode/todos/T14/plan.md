# Plan T14

## Steps

1. Probe the installed opencode CLI and capture raw evidence

   Do the probing first; nothing is written to src/ or README.md until a surface is actually observed. Work in a scratch dir (e.g. /tmp/baiton-opencode-probe), never in the repo.

   1. `command -v opencode && opencode --version`. Record the exact version string; it goes into the README row. If opencode is not on PATH, STOP probing: that is itself the finding (see step 5's 'unavailable' branch) and no wiring may be emitted.
   2. `opencode --help` and `opencode run --help`. Look specifically for: any flag that installs a hook/callback for permission decisions, any `--permission*` flag, `--plugin`, `--config`, and how `opencode run` behaves non-interactively. Save the help text.
   3. Config-layer surface: opencode already receives an inline config through `OPENCODE_CONFIG_CONTENT` (see `opencodeConfigEnv` in src/adapter/opencode.ts). Probe whether that inline layer accepts (a) a top-level or per-agent `permission` value of `"ask"` (today the adapter only emits `"allow"`/`"deny"`), and (b) a top-level `plugin` array. Test each by launching a trivial non-interactive run, e.g.
      `OPENCODE_CONFIG_CONTENT='{"agent":{...},"permission":{"bash":"ask"}}' opencode run -m <model> --agent baiton-executor -i 'run: echo hi'`
      and observe: does opencode start cleanly (config accepted), does the tool call block, auto-reject, or proceed? Record the literal stdout/stderr.
   4. Plugin/hook surface: if a `plugin` array is accepted, write a scratch plugin file that exports the permission/tool hook opencode documents for the probed version (candidates to try in order: a `permission.ask` hook and a `tool.execute.before` hook), have it append every invocation to a log file and set the decision to deny. Register it BOTH ways — via the inline `OPENCODE_CONFIG_CONTENT` `plugin` entry and via a `.opencode/plugin/<name>.js` file in the scratch cwd — and run a prompt that forces a bash/edit tool call. Record for each way: did the plugin load, did the hook fire, were the tool name and arguments present in the event, and did the returned decision actually allow/deny the call.
   5. Critically, record whether a working plugin can be installed WITHOUT writing a file to disk (inline only). `launch()` is a pure function and must not touch the filesystem, and this todo's file list does not include the launcher, so a relay that requires writing a plugin file is NOT shippable here — it is a recorded finding, not wiring.
   6. Keep a transcript of every command and its output; the README bullets must quote observed behaviour, not documentation.

   Files: (none)

2. If and only if an inline-installable native relay was verified: emit it from src/adapter/opencode.ts

   Mirror the claude wiring (`claudeRelayFlags`/`claudeAskRelaySettings` in src/adapter/permissions.ts, called from `ClaudeAdapter.launch`), but keep it inside src/adapter/opencode.ts since opencode's whole policy travels in the env layer.

   Add, next to `opencodeAgentDefinition`:
   - `export const OPENCODE_RELAY_TIMEOUT_SECONDS = 600;` — the deadline after which the relay degrades to opencode's own behaviour, matching `CLAUDE_RELAY_HOOK_TIMEOUT_SECONDS`.
   - `export const OPENCODE_RELAY_HOOK_SOURCE: string` — the plugin/hook program, written the same way as `CLAUDE_RELAY_HOOK_SCRIPT`: string concatenation with double quotes only, containing no `'` character, taking its parameters (asks dir, ask suffix, response suffix, run id, deadline ms) from argv/config rather than being spliced into the source. It must mint an ask file whose bytes `parseAsk` (src/engine/askRelay.ts) accepts — the same shape the claude hook writes: `{version:1,id,runId,agent:"opencode",kind:"permission",prompt,tool,args,createdAt}` with `args` a JSON string — poll for `<id><responseSuffix>` and map `decision==="approve"` to allow and anything else to deny.
   - `export function opencodeRelayConfig(relay: AskRelayDescriptor): Record<string, unknown>` — the extra inline-config keys the probe verified (e.g. `{ plugin: [...] }` and/or a `permission` table). Return `{}` for `relay.protocol !== 'file-v1'`: an unknown protocol must never emit half-understood wiring, exactly as `claudeRelayFlags` does.

   Change `opencodeConfigEnv(role, runId)` to `opencodeConfigEnv(role: Role, runId: string, relay?: AskRelayDescriptor)`, spreading `opencodeRelayConfig(relay)` over the existing `{ agent: { ... } }` object only when `relay !== undefined`. With `relay` omitted the produced JSON string must be byte-identical to today's — do not reorder keys, do not add an empty key.

   In `OpencodeAdapter.launch`, pass `req.relay` through: `env: opencodeConfigEnv(req.role, req.runId, req.relay)`. Leave `shellArgs` untouched — no new flags — unless the probe verified a launch flag, and never emit `--auto`. `attach()` keeps taking no relay (re-opening a finished session must not install a relay), matching the claude adapter.

   Update the `OpencodeAdapter` class doc comment with a numbered point (3.) stating which relay surface is wired and that it is the probed, verified one.

   If the probe verified nothing inline-installable, SKIP this step entirely: make no change to src/adapter/opencode.ts beyond (optionally) a doc-comment sentence recording that `LaunchRequest.relay` is deliberately ignored because the probe found no inline-installable native relay, and that the config-driven permission layer in `opencodeAgentDefinition` is the fallback.

   Files: `src/adapter/opencode.ts`

3. Pin the outcome in test/adapter.opencode.test.ts

   Add one new `describe('OpencodeAdapter ask-relay wiring (probe findings)')` block at the end of the file, built with the real producer so the test cannot drift from the relay core: `import { askRelayDescriptor } from '../src/engine/askRelay';` and `const relay = askRelayDescriptor('/repo', 'run-123');`, mirroring `describe('ClaudeAdapter ask-relay hook wiring')` in test/adapter.claude.test.ts.

   Always assert (both branches):
   - `adapter.launch(req({ relay: undefined }))` deep-equals `adapter.launch(req())` — the no-relay launch is unchanged.
   - `adapter.launch(req({ relay })).shellArgs` deep-equals the no-relay `shellArgs` (opencode's relay, if any, never touches argv) and still contains none of the forbidden flags already listed in the 'documented degrades' block, `--auto` included.
   - `adapter.attach({ role, runId, sessionId })` env deep-equals `opencodeConfigEnv(role, runId)` — attach installs no relay.
   - for every role in `ROLES`, the `agent.baiton-<role>.permission` block inside the parsed `OPENCODE_CONFIG_ENV` value is identical with and without the relay (the per-role policy is unaffected), mirroring claude's 'per-role permission rows are unaffected by the relay' test.

   If no native relay shipped, add the decisive negative test: `assert.deepStrictEqual(adapter.launch(req({ relay })), adapter.launch(req()))` with a comment naming the probe finding and the README section, so a future native relay forces this test to be revisited deliberately.

   If a native relay shipped, additionally assert:
   - the relay env value parses as JSON and, once the relay-only keys are deleted, deep-equals the no-relay config object (the relay is purely additive);
   - the emitted wiring names `relay.dir`, `relay.askSuffix`, `relay.responseSuffix` and `relay.runId`;
   - a descriptor with `protocol: 'file-v2' as unknown as AskRelayDescriptor` produces the no-relay env and `opencodeRelayConfig` returns `{}`;
   - `OPENCODE_RELAY_HOOK_SOURCE` contains no `'` character (it is single-quote wrapped downstream);
   - a behavioural test of the hook program, only if it can be executed host-free: spawn it with `process.execPath` against an `fs.mkdtempSync` asks dir exactly as test/adapter.claude.test.ts does, covering approve→allow, decline→deny, and deadline-expiry→degrade (never a silent allow). Give that describe a `this.timeout(10_000)` and per-test timeouts like the claude block.

   Files: `test/adapter.opencode.test.ts`

4. Record the findings in README.md under 'Harness ask relay (per-adapter probe findings)'

   Edit the existing section (README.md around lines 208-229).

   1. Add an `- **opencode findings** (probed `opencode --version <exact version>`, <YYYY-MM-DD>):` bullet block directly after the claude findings block, in the same style: one sub-bullet per probed surface, each stating what was run and what was literally observed. Cover at minimum: the `--help`/`run --help` search for a permission-hook flag; whether `OPENCODE_CONFIG_CONTENT` accepts a `permission: "ask"` value and what a non-interactive `opencode run` then does with a blocked tool call; whether a `plugin` entry is accepted inline and whether a plugin registered that way (and via `.opencode/plugin/`) actually fired with the tool name and arguments; and whether the decision returned by the hook changed the outcome.
   2. Mark anything not observed directly as **unverified** rather than asserting it, exactly as the claude block does for the 600 s `timeout` scale. State explicitly if a working relay would require writing a plugin file to disk, since that conflicts with the adapter's 'nothing is written to disk' invariant.
   3. Update the opencode row of the per-adapter table to the probe's actual outcome — either `| opencode | native <surface name> via inline OPENCODE_CONFIG_CONTENT | yes (version <v>, <date>) |` or `| opencode | config-driven fallback | probed <date>, version <v> — no inline-installable native relay |`. Do not leave it reading 'not probed yet'.
   4. If the CLI was unavailable, say so in the row and in one findings bullet (`opencode not installed on the probing machine on <date>; nothing verified, no wiring emitted`) rather than inventing a result.

   Files: `README.md`

5. Verify

   Run, in order, from the repo root: `npm run compile`; `npx mocha --no-config test/adapter.opencode.test.ts --require ts-node/register`; `npm run lint`; `npm test` (the full suite was 1088 passing / 1 pending after T12 — the count may only go up by the tests added here). Also re-run `npx mocha --no-config test/adapter.launch.property.test.ts --require ts-node/register` and the claude suite, since `opencodeConfigEnv`'s signature changed. Finish with `git status --short && git diff --stat` and confirm only the three planned files (plus nothing under .baiton/ or any scratch probe dir) are modified.

   Files: (none)

## Risks

- The core risk is fabricating a relay: opencode's plugin/permission surface must not be wired from documentation or memory. If a surface cannot be exercised end-to-end on the installed CLI, it is recorded as unverified and no code is emitted for it — the todo explicitly says 'emit only verified wiring'.
- opencode may not be installed on the machine running this todo. Then nothing can be verified; the honest outcome is README findings saying so, the fallback row, and the byte-identical negative test. Do not mark the todo done by shipping speculative wiring.
- opencode's plugin loader may only accept plugins as files (`.opencode/plugin/*.js`) or npm specs, not inline source. `OpencodeAdapter.launch` is pure and must not write files, and the launcher is outside this todo's file list, so a file-only plugin is a finding, not shippable wiring here.
- `opencodeConfigEnv` gains an optional third parameter; every existing caller (adapter launch/attach and test/adapter.opencode.test.ts) must keep producing byte-identical JSON when it is omitted, or the whole existing per-role policy suite and the launch property test break.
- The inline config travels in an environment variable; a large embedded plugin source can run into platform env-size limits and makes the terminal command line/env unwieldy. Keep the hook source minimal and parameterised, as the claude script is.
- opencode config schema varies across versions; a `permission` or `plugin` key accepted by the probed version may be rejected by another. The README row must name the exact probed version so the claim is scoped.
- Relay wiring must never silently auto-allow. Any failure path (unparseable event, unwritable ask, unreadable response, deadline expiry) must degrade to opencode's own permission behaviour, matching the claude hook's deliberate `ask` degradation.

## Acceptance

- The opencode row in README.md's per-adapter relay table no longer says 'not probed yet' and names the exact probed CLI version and date (or states that the CLI was unavailable).
- README.md contains an 'opencode findings' bullet block that describes what was actually run and observed for each probed surface, with anything not directly observed labelled unverified.
- src/adapter/opencode.ts emits relay wiring only for a surface the probe verified end-to-end; if nothing was verified it emits none and `LaunchRequest.relay` is documented as deliberately ignored.
- `OpencodeAdapter.launch(req)` with `relay` omitted or undefined produces a spec byte-identical to the pre-change behaviour (argv and env), and `attach()` never carries relay wiring.
- For every role, the `agent.baiton-<role>.permission` table inside `OPENCODE_CONFIG_CONTENT` is identical with and without a relay descriptor, and the argv still contains no claude-only permission flag and no `--auto`.
- A descriptor whose `protocol` is not `file-v1` produces no relay wiring at all.
- test/adapter.opencode.test.ts has a new ask-relay describe block that pins the shipped outcome (including the negative byte-identical assertion when no native relay ships), built from the real `askRelayDescriptor` producer.
- If a hook/plugin program ships, it writes ask files that `parseAsk` from src/engine/askRelay.ts accepts, maps `approve`→allow and anything else→deny, degrades rather than auto-allows on every failure path, and contains no single-quote character.
- `npm run compile`, `npx mocha --no-config test/adapter.opencode.test.ts --require ts-node/register`, `npm run lint` and `npm test` all pass, with no test count regression from T12's 1088 passing / 1 pending.
- `git status --short` shows only src/adapter/opencode.ts, test/adapter.opencode.test.ts and README.md modified; no probe scratch files are left in the repo.
