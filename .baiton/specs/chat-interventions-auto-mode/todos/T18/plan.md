# Plan T18

## Steps

1. Add the per-adapter ask-relay selection table to the adapter layer

   In `src/adapter/index.ts`, next to the existing `agentAllowList` (same file, same 'per-agent policy lookup' role), add:

   ```ts
   /** How a launched agent's harness asks reach the run's watched `asks/` directory. */
   export type AskRelayKind = 'native' | 'config-driven';

   /** Probe-derived table; mirrors the README 'Per-adapter relay state' table. */
   export const ASK_RELAY_KIND: Record<AgentId, AskRelayKind> = {
     claude: 'native',        // inline `--settings` PreToolUse hook (claudeRelayFlags)
     opencode: 'config-driven',
     antigravity: 'config-driven',
     codex: 'config-driven',
   };

   export function askRelayKind(agent: string): AskRelayKind {
     return isAgentId(agent) ? ASK_RELAY_KIND[agent] : 'config-driven';
   }

   export function usesConfigDrivenAskRelay(agent: string): boolean {
     return askRelayKind(agent) === 'config-driven';
   }
   ```

   JSDoc must state why each row is what it is, citing the probe outcomes already recorded in README: claude = native hook installable from pure argv; opencode = native plugin hook exists but loads only from a file on disk; antigravity = hooks.json only, and its `allow` cannot grant; codex = hooks gated behind persisted hook trust. An unknown agent id resolves to `config-driven` deliberately — the conservative default, since the fallback only adds brief text and never widens a permission.

   Do not touch `claudeRelayFlags` / `claudeAskRelaySettings` in `src/adapter/permissions.ts`; the claude native path stays exactly as T13 shipped it.

   Files: `src/adapter/index.ts`

2. Write the config-driven relay instruction text in roleInstructions.ts

   In `src/engine/roleInstructions.ts` add the brief section body for agents with no native relay. Import `type { AskRelayDescriptor } from '../adapter'` and `{ serializeAsk, serializeResponse } from './askRelay'` (no cycle: `askRelay.ts` imports only `../model/result` and adapter/orchestrator types).

   Export:

   ```ts
   /** The heading of the ask-relay section in a Brief. */
   export const ASK_RELAY_SECTION_HEADING = '# Asking for permission or a decision';

   /** The rule that makes the relay safe: a pending or denied ask is never self-approved. */
   export const ASK_RELAY_NO_SELF_APPROVE_INSTRUCTION =
     'Never carry out the action you asked about until a response file exists and its ' +
     '"decision" is "approve". A "deny" is final: do not retry the action, do not work ' +
     'around it — record that it was denied and continue with the rest of your work, or ' +
     'stop and say so if you cannot.';

   /** The example ask a Brief shows, rendered with `serializeAsk` so it cannot drift from the wire format. */
   export function askRelayExampleAsk(agent: string, runId: string): RelayAsk  // (import the type)

   /** The whole section body (no heading) for one launched run. */
   export function askRelayInstruction(input: { agent: string; relay: AskRelayDescriptor }): string
   ```

   `askRelayExampleAsk` returns a deterministic `RelayAsk` (no clock, no randomness): `{ version: 1, id: 'ask-0001', runId, agent, kind: 'permission', prompt: '<agent> needs permission to run a shell command', tool: 'bash', args: '{\"command\":\"npm test\"}', detail: 'Runs the test suite in the workspace root.' }`. Omit `createdAt` so the text is pure.

   `askRelayInstruction` composes markdown prose that states, in this order:
   1. Why: this CLI has no native permission relay, so when you need a human decision you must ask through a file instead of printing a question into the terminal (nobody is watching the terminal; the harness's own prompt may auto-deny).
   2. Where: write the ask to `<relay.dir>/<ask-id><relay.askSuffix>`; the answer appears at `<relay.dir>/<ask-id><relay.responseSuffix>`. Interpolate `relay.dir`, `relay.askSuffix`, `relay.responseSuffix` and `relay.runId` verbatim — never hardcode `.json` / `.response.json`.
   3. The ask-id rule: any short unique id you like, with no `/`, `\\` or `..` in it (mirrors `askIdFromFileName`).
   4. The exact JSON body, shown as a fenced ```json block emitted by `serializeAsk(askRelayExampleAsk(input.agent, input.relay.runId))`, followed by a field list: `version` is always 1; `runId` must be `<relay.runId>`; `agent` must be `<input.agent>`; `kind` is `"permission"` (needs a non-empty `tool`, plus `args` as a JSON *string* and an optional human-readable `detail`) or `"question"` (optional `options: [{id,label,detail?}]` and `allowFreeText: true`).
   5. The response, shown as a fenced ```json block emitted by `serializeResponse({ version: 1, id: 'ask-0001', decision: 'approve' })`, with the field meanings: `decision` is `"approve"` or `"deny"`; `answer` carries the chosen option id or typed text for a question; `reason` is a one-line rationale.
   6. How to wait: poll for the response file (e.g. every second); it is written atomically so a file that exists is complete. If it never appears, stop rather than proceeding.
   7. `ASK_RELAY_NO_SELF_APPROVE_INSTRUCTION`, verbatim, as the closing paragraph.

   Keep the module's existing tone (pure lookup/compose, no fs) and its file-level JSDoc, extending that JSDoc with one paragraph naming this section and pointing at `src/engine/askRelay.ts` as the wire-format owner.

   Files: `src/engine/roleInstructions.ts`, `src/engine/askRelay.ts`

3. Render the section from buildBrief without disturbing the required order

   In `src/engine/brief.ts`:

   - Add `export interface BriefAskRelay { agent: string; relay: AskRelayDescriptor }` (import the type from `../adapter`).
   - Add the optional field to `BriefInput`: `/** When set, the Brief carries the config-driven ask-relay instructions for this agent. */ askRelay?: BriefAskRelay;`.
   - In `buildBrief`, build `const askRelay = input.askRelay !== undefined ? [`${ASK_RELAY_SECTION_HEADING}\n\n${askRelayInstruction(input.askRelay)}`] : [];` and splice it into `sections` **after** the optional `# Context` section and **before** `# Result file`, i.e. `[role, ...context, ...askRelay, resultFile, schema, stop]`.
   - Update the file-level JSDoc's numbered section list so the documented order is: role instructions, optional context, optional ask-relay instructions, result path, schema, write-and-stop — and state that the schema and the stop instruction remain last (Req 11.3), which the new section preserves.
   - `writeBrief` needs no change: it forwards `BriefInput` unchanged.

   Files: `src/engine/brief.ts`

4. Select the fallback per adapter in launchStage

   In `src/engine/launcher.ts`:

   - Import `usesConfigDrivenAskRelay` from `../adapter` (the file already imports `AdapterLaunchError` and types from there).
   - After the existing `const relay = input.relayAsks === true ? askRelayDescriptor(root, input.runId) : undefined;`, add:

   ```ts
   // Adapters with a verified native relay (claude's inline --settings PreToolUse
   // hook) wire the asks themselves; the rest get the config-driven fallback,
   // which is brief-carried instructions to write the same ask files.
   const briefAskRelay =
     relay !== undefined && usesConfigDrivenAskRelay(deps.adapter.id)
       ? { agent: deps.adapter.id, relay }
       : undefined;
   ```

   - Pass it through in the `writeBriefFn(briefPath, {...})` call: `...(briefAskRelay !== undefined ? { askRelay: briefAskRelay } : {})`, placed after the existing spread of `briefContext` so an omitted relay produces the byte-identical previous Brief.
   - Add `/** How this launch relays asks, when the relay was enabled. */ askRelayKind?: AskRelayKind;` to `LaunchStageOutput` and return it (`...(relay !== undefined ? { askRelayKind: askRelayKind(deps.adapter.id) } : {})`) so the run queue/tests can assert which route a launch took without re-deriving it. Import `askRelayKind`/`AskRelayKind` alongside `usesConfigDrivenAskRelay`.
   - Extend the module JSDoc paragraph about `relayAsks` with one sentence: adapters without a verified native mechanism receive the relay instructions in the Brief instead, at the same `asks/` location, and nothing else about the launch changes.
   - Do not change `ensureAsksDir` handling: the directory is still created whenever `relay` is set, for both routes.
   - No change is needed in `src/engine/runQueue.ts` (it already sets `relayAsks: true` whenever an `askWatcherFactory` is wired) or in `src/activation/vscodeAskWatcher.ts` (the watcher is already adapter-agnostic and reads `agent` from the ask file).

   Files: `src/engine/launcher.ts`

5. Test the fallback selection and the emitted Brief

   Extend `test/engine.launcher.test.ts` with a `describe('launchStage config-driven ask-relay fallback', ...)` that reuses the file's existing `StubTerminalHost`, `adapterThat` helper (widen it to take an optional `id: AgentId` so tests can build a claude-id and an unknown-id adapter) and the tmpdir `beforeEach`/`afterEach`. Read the produced Brief with `fs.readFileSync(path.join(root, '.baiton','runs','run-1','brief.md'),'utf8')`. Cases:

   1. Fallback adapter (`id: 'antigravity'`) + `relayAsks: true` → the Brief contains `ASK_RELAY_SECTION_HEADING`, the absolute `asksDirFor(root,'run-1')` path, `.response.json`, `"runId": "run-1"` and `"agent": "antigravity"`, and `ASK_RELAY_NO_SELF_APPROVE_INSTRUCTION` verbatim.
   2. Section order invariant: `indexOf('# Role') < indexOf(ASK_RELAY_SECTION_HEADING) < indexOf('# Result file') < indexOf('# Result schema') < indexOf('# When you are done')`, and with a `briefContext` supplied, `# Context` sits between `# Role` and the relay heading.
   3. Wire-format pin: extract the first ```json fenced block after the relay heading and assert `parseAsk(block).ok === true` (import from `../src/engine/askRelay`), and that the second fenced block passes `parseResponse`. This is what stops the brief's example drifting from the parser.
   4. Native adapter (`id: 'claude'`) + `relayAsks: true` → the Brief does **not** contain `ASK_RELAY_SECTION_HEADING`, and is byte-identical to the same launch with `relayAsks` omitted; `result.value.askRelayKind === 'native'`; the adapter still received the `relay` descriptor in its `LaunchRequest`.
   5. `relayAsks` omitted on a fallback adapter → Brief byte-identical to the pre-change text (no relay heading), `result.value.askRelayKind` undefined, no `asks/` directory.
   6. Unknown agent id (`{ ...adapter, id: 'future-cli' as unknown as AgentId }`) + `relayAsks: true` → the section is present (conservative default) and `askRelayKind` is `'config-driven'`.

   Also add, in `test/engine.briefWatcher.test.ts`'s `buildBrief section ordering` describe, one pure `buildBrief` case asserting the same ordering with `askRelay` supplied and one asserting that omitting `askRelay` leaves the previous text unchanged — keeping the ordering guarantee tested at the pure level too. Optionally add one direct unit test of `askRelayKind`/`usesConfigDrivenAskRelay` in `test/adapter.index.test.ts` covering all four ids plus an unknown id.

   Files: `test/engine.launcher.test.ts`, `test/engine.briefWatcher.test.ts`, `test/adapter.index.test.ts`

6. Update the README's relay closing paragraph

   In `README.md`, the 'Harness ask relay (per-adapter probe findings)' subsection currently ends with: 'Adapters without a verified native relay fall back to the config-driven permission layer (`permissionFlags` / `--allowedTools` / `--permission-mode`) and surface nothing inline.' That is now false. Replace it with a short paragraph stating what ships: adapters whose probe found no argv-installable native mechanism (opencode, antigravity, codex — and any unknown agent id) receive a **config-driven fallback relay**: the Brief carries an 'Asking for permission or a decision' section telling the sub-agent to write `<run>/asks/<ask-id>.json` in the same `file-v1` wire format and to wait for `<ask-id>.response.json`, so the same `vscodeAskWatcher` routes those asks to the same inline chat cards and Auto mode applies unchanged; the config-driven permission layer (`permissionFlags` / `--allowedTools` / `--permission-mode`) remains the enforcement floor underneath, and the selection lives in `ASK_RELAY_KIND` in `src/adapter/index.ts`. State plainly that this route is instruction-driven, not enforced by the CLI: a model that ignores the instruction simply asks in its terminal as before, and nothing is auto-approved on its behalf. Leave the four per-adapter findings blocks and the relay table rows untouched.

   Files: `README.md`

## Risks

- The fallback is advisory: nothing in opencode/agy/codex forces the sub-agent to write an ask file, so a model may still stall on its own terminal prompt. Mitigation: the instruction is explicit about why the terminal is unwatched, and the permission layer still bounds what can happen without a decision. The README must say this plainly rather than implying enforcement.
- Brief growth. The new section adds prose to every fallback-agent Brief, ahead of the result path. Ordering is preserved (schema and stop stay last), but keep the section tight — the wire example is generated, not hand-written prose.
- Double-asking on claude. If the section were emitted for claude too, the native PreToolUse hook and the instruction would both mint asks for the same tool call. The `ASK_RELAY_KIND` gate prevents this and test case 4 pins it (byte-identical claude Brief with and without `relayAsks`).
- Drift between the brief's example JSON and `parseAsk`. Mitigated by generating both fenced blocks with `serializeAsk` / `serializeResponse` and asserting in tests that the extracted blocks parse.
- Byte-identity regressions for existing launches. Any launch without `relayAsks` must produce exactly the previous Brief text and argv; the new spread is conditional and test case 5 pins it.
- Import direction: `roleInstructions.ts` gains imports from `./askRelay` and the adapter types. Confirm no cycle appears (`askRelay.ts` imports only `../model/result` plus types) and that `src/engine/index.ts`'s existing `export *` ordering still compiles.
- An ask id chosen by the sub-agent could contain a separator or `..`; `askIdFromFileName` already rejects those, and the instruction states the rule, but the watcher's existing rejection is the real guard — do not relax it.

## Acceptance

- `npm run compile` is clean.
- `npm run lint` is clean.
- `npx mocha --no-config test/engine.launcher.test.ts test/engine.briefWatcher.test.ts test/engine.askRelay.test.ts test/adapter.index.test.ts --require ts-node/register` passes, including the new fallback cases.
- `npx mocha --no-config test/adapter.claude.test.ts test/adapter.opencode.test.ts test/adapter.codex.test.ts test/adapter.antigravity.test.ts test/adapter.launch.property.test.ts test/askWatcher.routing.test.ts --require ts-node/register` passes unchanged (no adapter argv changed).
- `npm test` passes with no new failures and no newly pending test; the only pending remains the pre-existing `test/config.test.ts` version-gating case (baseline: 1124 passing, 1 pending).
- A launch with `relayAsks: true` on a config-driven adapter writes a `brief.md` whose ask-relay section names the run's absolute `asks/` directory, both file suffixes, the run id and the agent id, and whose two fenced JSON blocks are accepted by `parseAsk` / `parseResponse`.
- A claude launch with `relayAsks: true` produces a `brief.md` byte-identical to the same launch with `relayAsks` omitted, and still receives the `--settings` relay hook flags in its argv.
- `askRelayKind` returns `native` for claude, `config-driven` for opencode/antigravity/codex and for an unknown agent id.
- `git status --short` shows only the planned files: src/adapter/index.ts, src/engine/roleInstructions.ts, src/engine/brief.ts, src/engine/launcher.ts, test/engine.launcher.test.ts, test/engine.briefWatcher.test.ts, test/adapter.index.test.ts, README.md.
