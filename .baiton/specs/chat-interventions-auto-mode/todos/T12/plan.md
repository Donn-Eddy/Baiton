# Plan T12

## Steps

1. Create the host-free ask-relay core module

   Create `src/engine/askRelay.ts`. No `vscode` import; node `fs`/`path` only (same posture as `src/engine/launcher.ts`). Module JSDoc: 'The ask-relay file protocol (harness permission asks relayed into the chat). A launched run's `.baiton/runs/<run-id>/asks/<ask-id>.json` is the ask; `<ask-id>.response.json` is the answer. Parsing, validation, serialization and the relay descriptor live here; the vscode-backed watcher and Auto mode are wired later.'

   Export constants and path helpers:
   - `export const ASKS_DIR_NAME = 'asks';`
   - `export const ASK_FILE_SUFFIX = '.json';`
   - `export const RESPONSE_FILE_SUFFIX = '.response.json';`
   - `export const ASK_RELAY_VERSION = 1;`
   - `export function asksDirFor(workspaceRoot: string, runId: string): string` → `path.join(workspaceRoot, '.baiton', 'runs', runId, ASKS_DIR_NAME)` (mirrors `allowedResultPath` in `src/engine/resultValidation.ts`).
   - `export function askFilePath(asksDir: string, askId: string): string` → `path.join(asksDir, askId + ASK_FILE_SUFFIX)`.
   - `export function responseFilePath(asksDir: string, askId: string): string` → `path.join(asksDir, askId + RESPONSE_FILE_SUFFIX)`.
   - `export function askIdFromFileName(fileName: string): string | undefined` — returns the ask id for a file named `<id>.json`, and `undefined` for anything else, including `<id>.response.json` (check the response suffix FIRST so `a.response.json` is never read as ask id `a.response`), names not ending in `.json`, an empty id, and any name containing a path separator or `..`.

   Define the wire types (all fields JSON-serializable, no `Date`):
   ```ts
   export interface RelayAsk {
     version: number;            // must equal ASK_RELAY_VERSION
     id: string;                 // non-empty; matches the file's <ask-id>
     runId: string;              // the run the ask came from
     agent: string;              // adapter/agent id, e.g. 'claude'
     kind: 'permission' | 'question';
     prompt: string;             // non-empty
     tool?: string;              // required when kind === 'permission'
     args?: string;              // tool args as JSON text
     detail?: string;            // 'what you are approving'
     options?: { id: string; label: string; detail?: string }[]; // question only
     allowFreeText?: boolean;    // question only
     createdAt?: string;         // ISO-8601, informational
   }

   export interface RelayResponse {
     version: number;            // ASK_RELAY_VERSION
     id: string;                 // the ask id being answered
     decision: 'approve' | 'deny';
     answer?: string;            // option id or free text for a question
     reason?: string;            // one-line rationale / decline reason
     respondedAt?: string;       // ISO-8601
   }
   ```

   Error union + describer, modelled on `ResultValidationError`/`describeValidationError`:
   ```ts
   export type AskRelayError =
     | { kind: 'malformed-json'; message: string }
     | { kind: 'invalid'; message: string };
   export function describeAskRelayError(error: AskRelayError): string; // returns error.message
   ```

   Pure parsers returning `Result<T, AskRelayError>` from `../model/result` (`ok`/`err`):
   - `export function parseAsk(rawContents: string): Result<RelayAsk, AskRelayError>` — `JSON.parse` in a try/catch → `malformed-json` with `ask is not well-formed JSON: <message>`; then reject (as `invalid`, message naming the offending field): non-object/array/null, `version !== ASK_RELAY_VERSION` (`unsupported ask relay version <v>`), missing/blank `id`, `runId`, `agent`, `prompt`, a `kind` outside `permission|question`, `kind === 'permission'` with missing/blank `tool`, non-string `args`/`detail`/`createdAt` when present, `options` present but not an array of `{id, label}` objects with non-empty string ids/labels, non-boolean `allowFreeText`. On success return a normalized object containing only the known fields (drop unknown extras) so downstream code never re-exports harness data verbatim.
   - `export function parseResponse(rawContents: string): Result<RelayResponse, AskRelayError>` — same shape; rejects a `decision` outside `approve|deny`, blank `id`, wrong `version`, non-string `answer`/`reason`/`respondedAt`.

   Serializers (stable field order, 2-space indent, trailing newline, so a hook writing them by hand and Baiton's own writes look identical):
   - `export function serializeAsk(ask: RelayAsk): string`
   - `export function serializeResponse(response: RelayResponse): string`

   Bridge to the intervention core (`../orchestrator/interventions`, type-only imports of `InterventionRequest`, `InterventionAnswer`):
   - `export function toInterventionRequest(ask: RelayAsk): InterventionRequest` — `kind: 'permission'` → `{ kind: 'permission', prompt, agent: ask.agent, tool: ask.tool!, ...(args), ...(detail) }`; `kind: 'question'` → `{ kind: 'question', prompt, ...(options), ...(allowFreeText), }`.
   - `export function responseFromAnswer(ask: RelayAsk, answer: InterventionAnswer, respondedAt?: string): RelayResponse` — `approved` → `{ decision: 'approve' }`; `declined` → `{ decision: 'deny', reason: answer.reason ?? 'declined' }`; `option` → `{ decision: 'approve', answer: answer.optionId }`; `text` → `{ decision: 'approve', answer: answer.text }`. Always stamps `version: ASK_RELAY_VERSION` and `id: ask.id`, and includes `respondedAt` only when the caller passes it (keeps the function pure/deterministic for tests).

   Filesystem helpers kept thin and injectable so the core stays testable:
   ```ts
   export interface AskRelayIo {
     mkdir(dir: string): void;
     writeFile(file: string, contents: string): void;
     readFile(file: string): string;
     readdir(dir: string): string[];
   }
   export const nodeAskRelayIo: AskRelayIo; // mkdirSync({recursive:true}) / writeFileSync utf8 / readFileSync utf8 / readdirSync
   export function ensureAsksDir(workspaceRoot: string, runId: string, io?: AskRelayIo): string; // creates and returns the dir
   export function writeResponse(asksDir: string, response: RelayResponse, io?: AskRelayIo): string; // writes to <id>.response.json via a `<id>.response.json.tmp` file + rename when io is the node one, returns the path
   export function listPendingAskIds(asksDir: string, io?: AskRelayIo): string[]; // ids whose ask file exists and whose response file does not, sorted
   ```
   Every helper defaults its `io` argument to `nodeAskRelayIo`. `listPendingAskIds` must swallow a missing directory (return `[]`) rather than throw.

   Files: `src/engine/askRelay.ts`

2. Add the relay descriptor to the adapter LaunchRequest

   In `src/adapter/adapter.ts`, above `LaunchRequest`, add:
   ```ts
   /**
    * Where a launched run's harness asks are relayed. An adapter that has a
    * verified native permission hook/delegate wires it to these paths; adapters
    * without one ignore the descriptor and the config-driven fallback applies.
    */
   export interface AskRelayDescriptor {
     /** The wire protocol; only `file-v1` exists today. */
     protocol: 'file-v1';
     /** Absolute path of the run's `asks/` directory. */
     dir: string;
     /** File suffix of an ask (`.json`). */
     askSuffix: string;
     /** File suffix of a response (`.response.json`). */
     responseSuffix: string;
     /** The run id the asks belong to. */
     runId: string;
   }
   ```
   Add the optional field to `LaunchRequest`:
   ```ts
     /**
      * Where to relay harness permission asks, when the caller enabled the ask
      * relay for this launch. Absent means no relay: the adapter launches exactly
      * as before.
      */
     relay?: AskRelayDescriptor;
   ```
   Do not change any adapter implementation in this todo — the four adapters keep ignoring the field until their probe todos land. Keep the type in `adapter.ts` (not `askRelay.ts`) so `src/adapter` gains no dependency on `src/engine`; `askRelay.ts` may `import type { AskRelayDescriptor } from '../adapter/adapter'` for its builder.

   Files: `src/adapter/adapter.ts`

3. Build the descriptor in askRelay and plumb it through launchStage

   In `src/engine/askRelay.ts` add:
   ```ts
   export function askRelayDescriptor(workspaceRoot: string, runId: string): AskRelayDescriptor {
     return {
       protocol: 'file-v1',
       dir: asksDirFor(workspaceRoot, runId),
       askSuffix: ASK_FILE_SUFFIX,
       responseSuffix: RESPONSE_FILE_SUFFIX,
       runId,
     };
   }
   ```
   In `src/engine/launcher.ts`:
   1. Import `askRelayDescriptor` and `ensureAsksDir` from `./askRelay`, and `AskRelayDescriptor` as a type from `../adapter`.
   2. Add to `LaunchStageInput`: `/** True to relay this run's harness asks through `.baiton/runs/<run-id>/asks/` (Auto mode + inline permission cards). Default false keeps the previous launch behaviour. */ relayAsks?: boolean;`.
   3. In `launchStage`, after `runDir`/`briefPath`/`resultPath` are computed and BEFORE the `deps.adapter.launch(...)` call, compute `const relay = input.relayAsks === true ? askRelayDescriptor(root, input.runId) : undefined;` and pass `...(relay ? { relay } : {})` into the `launch({...})` argument object, so an unset flag produces byte-identical requests to today.
   4. Create the asks directory alongside the existing `mkdirSync(runDir, { recursive: true })` in step 3 of the function — `if (relay) { ensureAsksDir(root, input.runId); }` inside the same try/catch, so a failure surfaces as the existing `brief-write` error and no terminal is created.
   5. Add `relay` to `LaunchStageOutput` as `/** The ask-relay descriptor handed to the adapter, when the relay was enabled. */ relay?: AskRelayDescriptor;` and include it in the returned `ok({...})` only when defined.
   Update the file's header JSDoc bullet list to mention the optional asks directory.
   Finally, add `export * from './askRelay';` to `src/engine/index.ts` (after `./launcher`) and extend that file's module JSDoc with 'and the ask-relay file protocol'.

   Files: `src/engine/askRelay.ts`, `src/engine/launcher.ts`, `src/engine/index.ts`

4. Unit-test the relay core and the launcher plumbing

   Create `test/engine.askRelay.test.ts` following `test/engine.launcher.test.ts` conventions: `import * as assert from 'assert'`, `fs`/`os`/`path`, `describe`/`it`, `fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-askrelay-'))` in `beforeEach` and `fs.rmSync(root, { recursive: true, force: true })` in `afterEach`. Cover:
   - Path helpers: `asksDirFor(root, 'run-1')` ends with `.baiton/runs/run-1/asks`; `askFilePath`/`responseFilePath` produce `<id>.json` / `<id>.response.json`.
   - `askIdFromFileName`: `'a1.json'` → `'a1'`; `'a1.response.json'` → `undefined`; `'notes.txt'` → `undefined`; `'.json'` → `undefined`; `'../x.json'` and `'sub/x.json'` → `undefined`.
   - `parseAsk`: a full valid permission ask round-trips through `serializeAsk` → `parseAsk` unchanged; unknown extra fields are dropped from the parsed value; malformed JSON yields `kind: 'malformed-json'`; each of version mismatch, blank `id`, missing `runId`, missing `agent`, bad `kind`, permission-without-`tool`, non-string `args`, and a malformed `options` entry yields `kind: 'invalid'` with a message naming the field.
   - `parseResponse`: valid approve and deny round-trip; a `decision` of `'maybe'` and a wrong `version` are `invalid`; malformed JSON is `malformed-json`.
   - `toInterventionRequest`: a permission ask maps to `{ kind: 'permission', agent, tool, args, detail, prompt }`; a question ask maps to `{ kind: 'question', prompt, options, allowFreeText }` and carries no `tool`.
   - `responseFromAnswer` for each `InterventionAnswer` variant (`approved`, `declined` with and without a reason, `option`, `text`), asserting `decision`, `answer`, `reason`, and that `respondedAt` is absent unless passed.
   - `ensureAsksDir` creates the directory (idempotent on a second call), `writeResponse` writes parseable JSON at `responseFilePath` and leaves no `.tmp` file behind, and `listPendingAskIds` returns ids with an ask but no response, sorted, and `[]` for a missing directory.
   - Launcher plumbing, reusing a `StubTerminalHost`/`adapterThat(...)` pair copied from `test/engine.launcher.test.ts` that records the received `LaunchRequest`: with `relayAsks: true` the adapter sees `req.relay` with `protocol: 'file-v1'`, the run's asks dir path and both suffixes, the directory exists on disk after the call, and `result.value.relay` matches; with the flag omitted, `req.relay` is `undefined`, `result.value.relay` is `undefined`, and no `asks/` directory is created.
   Run `npm run compile`, `npx mocha --no-config test/engine.askRelay.test.ts --require ts-node/register`, `npm run lint`, then `npm test`.

   Files: `test/engine.askRelay.test.ts`

## Risks

- Adding a field to `LaunchRequest` touches every adapter's structural typing; keep it optional and change no adapter in this todo so `test/adapter.launch.property.test.ts` and the four per-adapter suites stay green.
- Defaulting `relayAsks` to true would change existing launch behaviour and could break `test/engine.launcher.test.ts` and `test/runQueue.*` expectations. It must default to off; T13/T17/T18 turn it on per adapter.
- `askIdFromFileName` is the seam where `a.response.json` could be mistaken for an ask named `a.response` — check the response suffix before the `.json` suffix, or the watcher in T17 will loop answering its own responses.
- The asks directory sits under `.baiton/runs/<run-id>/`, which `isAllowedSubAgentWrite` (src/engine/resultValidation.ts) still confines to `result.json` only. Do not relax that confinement here; the harness hook, not the sub-agent's own tools, writes ask files, and any widening is a separate decision.
- Response writes race a watcher reading the same directory; write to a `.tmp` sibling and rename so a partially written response is never observed.
- `args` is untrusted harness-supplied text. Keep it a plain string, never `JSON.parse` it into the intervention, and drop unknown fields during parsing so nothing else leaks through.

## Acceptance

- `src/engine/askRelay.ts` exists, imports no `vscode`, and exports the path helpers, `RelayAsk`/`RelayResponse` types, `parseAsk`/`parseResponse` returning `Result<_, AskRelayError>`, `serializeAsk`/`serializeResponse`, `toInterventionRequest`, `responseFromAnswer`, `askRelayDescriptor`, `ensureAsksDir`, `writeResponse` and `listPendingAskIds`.
- `src/engine/index.ts` re-exports `./askRelay` and `src/adapter/adapter.ts` exports `AskRelayDescriptor` with `LaunchRequest.relay?: AskRelayDescriptor`.
- `launchStage` passes a `relay` descriptor to `adapter.launch` and creates the `asks/` directory exactly when `input.relayAsks === true`, and produces byte-identical requests to the previous behaviour when it is omitted.
- `npx mocha --no-config test/engine.askRelay.test.ts --require ts-node/register` passes with tests covering the path helpers, valid and invalid ask/response parses, serialize→parse round-trips, the intervention bridge in both directions, the fs helpers, and both launcher branches.
- `npm run compile`, `npm run lint` and `npm test` all pass with no changes to any adapter implementation or to existing tests.
