# Plan T04

## Steps

1. Mirror the new state field in media/protocol.js initialWebviewState

   In `media/protocol.js`, inside the IIFE, add `autoMode: false,` to the object returned by `initialWebviewState()`, placed immediately after `busy: false,` so the key order matches the TypeScript seed in `src/orchestrator/webviewProtocol.ts` (`conversations, activeId, sessions, activeSessionId, records, busy, autoMode`). Key order is not asserted by deepStrictEqual but keeping it identical makes the two files diff-readable. Do not add `error`/`empty` keys — the TS seed omits them and adding them would break `assert.deepStrictEqual(js, ts)`.

   Files: `media/protocol.js`

2. Mirror the three new reduce cases in media/protocol.js

   Add `showIntervention`, `resolveIntervention` and `setAutoMode` cases to the `reduce` switch in `media/protocol.js`, placed after the existing `updateTool` case and before `setConversations`, matching the TS ordering. Translate the TS bodies literally into ES5-style plain-script code (the file uses `Object.assign`, `slice`, `concat`, `function` callbacks, `const`/`let`, and `// @ts-check` at the top):

   1. `case 'showIntervention': {` — build `const card = { role: 'system', content: msg.intervention.prompt, intervention: Object.assign({}, msg.intervention) };`. Then `const existing = state.records.findIndex(function (r) { return r.intervention !== undefined && r.intervention.id === msg.intervention.id; });`. If `existing >= 0`, copy the array (`const records = state.records.slice(); records[existing] = card;`) and `return Object.assign({}, state, { records: records, empty: undefined });`. Otherwise read `const last = state.records[state.records.length - 1];` and, when `last !== undefined && last.streaming === true`, return `Object.assign({}, state, { records: state.records.slice(0, -1).concat([Object.assign({}, last, { streaming: false }), card]), empty: undefined })`. Fall through to `return Object.assign({}, state, { records: state.records.concat([card]), empty: undefined });`.

   2. `case 'resolveIntervention': {` — mirror the `updateTool` shape: `let found = false;` then `const records = state.records.map(function (record) { const card = record.intervention; if (found || card === undefined || card.id !== msg.id || card.status !== 'pending') { return record; } found = true; return Object.assign({}, record, { intervention: Object.assign({}, card, { status: 'resolved', answer: msg.answer, rationale: msg.rationale, auto: msg.auto }) }); });` then `return found ? Object.assign({}, state, { records: records }) : state;`. Note two contracts that the parity test pins: (a) the no-match / already-resolved path must return the *same* `state` reference, and (b) `rationale` and `auto` are always written, so they are present-with-value-`undefined` when the message omits them — exactly as TS does, since `deepStrictEqual` distinguishes a missing key from an `undefined` one.

   3. `case 'setAutoMode': return Object.assign({}, state, { autoMode: msg.enabled });`

   Use `!== undefined` checks (not truthiness) for `record.intervention` so the JS matches the TS predicate exactly. Leave the `default:` branch as-is: the JS returns `state` for unknown messages while TS throws via `assertNever` — the parity fixtures must therefore only contain valid `HostToWebview` messages.

   Files: `media/protocol.js`

3. Add the shared fixture file test/fixtures/protocolCases.ts

   New file exporting the cases both reducers are folded over. Shape it after `test/fixtures/configFormCases.ts` (a `const cases: ProtocolCase[] = []` built up with numbered `// (n) …` comment blocks and a final `export const PROTOCOL_CASES: readonly ProtocolCase[] = cases;`).

   Declare:
   ```ts
   import type { HostToWebview, RenderRecord, WebviewState, InterventionView } from '../../src/orchestrator/webviewProtocol';

   export interface ProtocolCase {
     name: string;
     /** Starting state; omit for `initialWebviewState()`. */
     state?: WebviewState;
     /** Messages folded left-to-right over the starting state. */
     messages: HostToWebview[];
     /** True when the fold must return the identical state reference (no-op). */
     sameReference?: boolean;
   }
   ```
   Add small local builders mirroring the reducer test: `export function seed(over: Partial<WebviewState> = {}): WebviewState` returning a fresh literal (`{ conversations: [], activeId: '', sessions: [], activeSessionId: '', records: [], busy: false, autoMode: false, ...over }`) and `export function ask(over: Partial<InterventionView> = {}): InterventionView` returning `{ id: 'a1', kind: 'confirm', prompt: 'Approve?', status: 'pending', ...over }`. Do not import `initialWebviewState` for the seed — build literals so a divergence in the seed itself is still caught by the dedicated seed assertion in the test.

   Cover, at minimum, one case per reduce branch plus the intervention edge cases:
   - renderConversation over a non-empty state (and over a state carrying `empty`);
   - appendMessage onto an empty state, onto a trailing streaming record with an `assistant` record (replacement), and with a `user` record (finalize-then-append);
   - streamDelta starting a record, streamDelta growing one, streamEnd on a streaming record, streamEnd with no streaming record (`sameReference: true`);
   - updateTool hitting a pending row (`ok` and `error`), and updateTool with an unmatched call id (`sameReference: true`);
   - showIntervention appended to an empty conversation; showIntervention replacing an already-rendered card with the same id in place (state pre-seeded with a pending card record); showIntervention after a trailing streaming record (finalizes it first); showIntervention for each kind — `confirm`, a `question` with `options` + `allowFreeText` + `placeholder`, and a `permission` carrying `agent`/`tool`/`args`/`detail`;
   - resolveIntervention settling a pending card with each `InterventionAnswer` variant (`{kind:'option',optionId,label}`, `{kind:'text',text}`, `{kind:'approved'}`, `{kind:'declined',reason}`), once with `rationale` + `auto: true` and once with both omitted (this pins the `undefined`-key behaviour); resolveIntervention for an unknown id (`sameReference: true`); resolveIntervention for a card already `status: 'resolved'` (`sameReference: true`); resolveIntervention when two records carry the same id and only the first pending one settles;
   - setAutoMode true, then false, and a multi-message sequence interleaving `setAutoMode` with `showIntervention`/`resolveIntervention` so ordering is pinned;
   - setConversations, setActive, setSessions, setActiveSession, showError (with and without `action`), setBusy, setEmptyState (with `null` endpoint/model).

   Every `messages` entry must be a valid `HostToWebview` variant — an unknown `type` would make TS throw while JS returns state.

   Files: `test/fixtures/protocolCases.ts`

4. Add the parity suite test/webviewProtocol.mirror.test.ts

   New file modelled directly on `test/configPanel.mirror.test.ts`.

   Loader:
   ```ts
   import * as assert from 'assert';
   import * as fs from 'fs';
   import * as path from 'path';
   import * as vm from 'vm';
   import { HostToWebview, WebviewState, initialWebviewState, reduce } from '../src/orchestrator/webviewProtocol';
   import { PROTOCOL_CASES } from './fixtures/protocolCases';

   export interface ProtocolMirror {
     reduce(state: WebviewState, msg: HostToWebview): WebviewState;
     initialWebviewState(): WebviewState;
   }

   export function loadProtocolMirror(): ProtocolMirror {
     const sourcePath = path.join(__dirname, '..', 'media', 'protocol.js');
     const source = fs.readFileSync(sourcePath, 'utf8');
     const sandbox: { window: { baitonProtocol?: ProtocolMirror } } = { window: {} };
     vm.runInNewContext(source, sandbox, { filename: 'media/protocol.js' });
     const raw = sandbox.window.baitonProtocol;
     assert.ok(raw, 'window.baitonProtocol was not exported by media/protocol.js');
     return raw;
   }
   ```

   `describe('webview protocol browser mirror (chat-interventions-auto-mode T04)')` with a `before(() => { mirror = loadProtocolMirror(); })` and these tests:
   1. exports `window.baitonProtocol` with `reduce` and `initialWebviewState` as functions;
   2. `assert.deepStrictEqual(mirror.initialWebviewState(), initialWebviewState())` — this is what catches a missing `autoMode` in the JS seed;
   3. a `describe('reduce parity over fixture cases')` looping `PROTOCOL_CASES`: for each case take `const start = c.state ?? initialWebviewState();`, fold the messages twice over *independent deep clones* of `start` (`JSON.parse(JSON.stringify(start))`, or rebuild via the fixture builder) so neither reducer can see the other's output, then `assert.deepStrictEqual(jsResult, tsResult, \`Mirror state does not match TypeScript state for "${c.name}"\`)`. When `c.sameReference === true`, also assert `assert.strictEqual(tsResult, tsStart)` and `assert.strictEqual(jsResult, jsStart)` so the no-op identity contract is pinned on both sides;
   4. a purity check over a multi-message case: clone the start state twice, fold with the TS reducer, assert the input clone still deep-equals the untouched clone; repeat with the mirror.

   Do not weaken any assertion to compare only a subset of the state — mirror the note at the top of `configPanel.mirror.test.ts` with an equivalent comment explaining that full-state `deepStrictEqual` is intentional and that a divergence is the sync guard working, not a flake.

   Files: `test/webviewProtocol.mirror.test.ts`, `test/fixtures/protocolCases.ts`

5. Leave test/configPanel.mirror.test.ts unchanged unless a helper is genuinely shared

   The brief lists `test/configPanel.mirror.test.ts` only as the model to copy. Do not refactor it, do not extract a shared `loadMirror` helper out of it, and do not rename `loadConfigMirror`/`ConfigMirror` — the new suite carries its own `loadProtocolMirror`. Touch it only if the compiler forces it (it should not).

   Files: `test/configPanel.mirror.test.ts`

6. Verify

   Run `npm run compile`, `npm run lint`, then `npm test`. The whole suite must pass (T02 left it at 863 passing, 1 pending; the new fixtures add cases on top). If the parity suite fails, fix `media/protocol.js` to match the TypeScript source — the TS core in `src/orchestrator/webviewProtocol.ts` is the source of truth and must not be changed to satisfy the mirror. `media/chat.js` is out of scope for this todo: it still ignores the three new message types, which is expected until the webview rendering todo lands.

   Files: `media/protocol.js`, `test/fixtures/protocolCases.ts`, `test/webviewProtocol.mirror.test.ts`

## Risks

- deepStrictEqual distinguishes a missing key from a key whose value is `undefined`. The TS `resolveIntervention` always writes `rationale` and `auto`, and several TS branches always write `empty: undefined`; the JS mirror must write the same keys unconditionally or the parity assertions fail on messages that omit those fields.
- The TS `reduce` throws via `assertNever` on an unknown message type while the JS mirror returns the state unchanged. This divergence is deliberate and must not be 'fixed'; instead the fixtures must contain only valid HostToWebview variants, or the parity loop will throw instead of comparing.
- `media/protocol.js` runs under `// @ts-check`. Untyped locals in the new cases (e.g. shadowing `card`) can raise checkJs errors in `npm run compile`/lint even though the file is plain JS; keep the code in the same defensive `!== undefined` style as the existing cases and add JSDoc casts only if the checker demands them.
- The mirror is loaded with `vm.runInNewContext` into a bare `{ window: {} }` sandbox. Any new top-level reference in protocol.js to a browser global other than `window` (e.g. `document`, `structuredClone`, `Array.prototype.at`) would throw at load time; stick to ES5-compatible array/object operations as the file already does.
- Folding both reducers over the *same* starting object would let a mutation bug in one reducer hide a divergence in the other. Each fold must start from its own deep clone, and shared fixture `state` objects must be rebuilt (or cloned) per case so mocha ordering cannot leak state between tests.
- `toRenderRecords`, `interventionRecord`, `interventionUpdate` and `pendingToolRecord` exist only in the TypeScript core and are intentionally NOT mirrored in protocol.js. Do not add them to the mirror or assert on them in the parity suite; this todo pins `reduce` and `initialWebviewState` only.

## Acceptance

- `media/protocol.js` handles `showIntervention`, `resolveIntervention` and `setAutoMode` with bodies behaviourally identical to `src/orchestrator/webviewProtocol.ts`, and its `initialWebviewState()` includes `autoMode: false`.
- `test/fixtures/protocolCases.ts` exists and exports `PROTOCOL_CASES` covering every `HostToWebview` variant, including the intervention edge cases: in-place replacement by id, finalizing a trailing streaming record, first-pending-card settlement, unknown id no-op, already-resolved no-op, and each `InterventionAnswer` variant with and without `rationale`/`auto`.
- `test/webviewProtocol.mirror.test.ts` loads `media/protocol.js` via `vm.runInNewContext` into a `{ window: {} }` sandbox, asserts `window.baitonProtocol` is exported, asserts seed parity, and asserts full-state `deepStrictEqual` parity of the TS and JS folds for every fixture case.
- Cases marked `sameReference` assert reference identity of the returned state on both the TS and the JS side.
- A purity test asserts neither reducer mutates the state object it is given.
- Deliberately breaking one mirrored branch in `media/protocol.js` (e.g. dropping `auto` from the resolved card) makes the new suite fail — the guard demonstrably bites.
- `npm run compile`, `npm run lint` and `npm test` all pass with no changes to `src/orchestrator/webviewProtocol.ts`, `src/orchestrator/chatTranscript.ts` or `media/chat.js`.
