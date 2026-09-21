# Plan T02

## Steps

1. Add the InterventionView card shape to webviewProtocol.ts

   In `src/orchestrator/webviewProtocol.ts`, above the `HostToWebview` union, add a type-only import from the T01 core so the card shape reuses the existing vocabulary without any runtime coupling:

   ```ts
   import type { InterventionAnswer, InterventionKind, InterventionOption } from './interventions';
   ```
   (Keep it a `import type` — this module must stay host-free and side-effect-free; `src/orchestrator/index.ts` re-exports both modules with `export *`, so do NOT re-export `Intervention`, `InterventionAnswer`, `InterventionKind` or `InterventionOption` from here — a duplicate export would break the barrel.)

   Then declare the view-side record of one intervention card, named `InterventionView` (deliberately distinct from the core's `Intervention` to avoid a barrel name collision):

   ```ts
   /** One intervention card as the conversation renders it (pending or settled). */
   export interface InterventionView {
     /** The registry ask id; the key `resolveIntervention` settles the card by. */
     id: string;
     /** Which kind of ask the card presents. */
     kind: InterventionKind;
     /** The question/confirmation/permission prompt text. */
     prompt: string;
     /** Offered choices of an option question; absent means free text only. */
     options?: InterventionOption[];
     /** True when a typed answer is accepted in addition to any options. */
     allowFreeText?: boolean;
     /** Placeholder for the free-text input. */
     placeholder?: string;
     /** Secondary 'what you are approving' text, for confirms and permissions. */
     detail?: string;
     /** For a permission ask: the agent/adapter id the ask came from. */
     agent?: string;
     /** For a permission ask: the tool the harness wants to run. */
     tool?: string;
     /** For a permission ask: the tool arguments as JSON text. */
     args?: string;
     /** Pending until answered, then settled with `answer`. */
     status: 'pending' | 'resolved';
     /** The user's (or Auto mode's) answer; present once `status` is 'resolved'. */
     answer?: InterventionAnswer;
     /** One-line reason shown on a settled card (auto-approval or escalation). */
     rationale?: string;
     /** True when Auto mode settled the card rather than the user. */
     auto?: boolean;
   }
   ```

   Extend `RenderRecord` with one optional field (leave every existing field untouched so current deep-equality assertions keep passing):

   ```ts
     /** Present for an intervention card row: the ask and its settled state. */
     intervention?: InterventionView;
   ```

   Files: `src/orchestrator/webviewProtocol.ts`

2. Add the three host→webview messages and the two webview→host messages

   In `src/orchestrator/webviewProtocol.ts`:

   Append to the `HostToWebview` union (keep the existing `updateTool` member and move its trailing `;` accordingly):

   ```ts
     /**
      * Post a pending intervention card at the end of the conversation. A card
      * whose id is already rendered is replaced in place, so a re-post after a
      * re-render never duplicates the ask.
      */
     | { type: 'showIntervention'; intervention: InterventionView }
     /**
      * Settle the rendered card carrying `id`: flips it to `resolved` and attaches
      * the answer, an optional one-line rationale, and whether Auto mode decided.
      * An id that matches no pending card leaves the state unchanged.
      */
     | { type: 'resolveIntervention'; id: string; answer: InterventionAnswer; rationale?: string; auto?: boolean }
     /** Set the Auto-mode toggle shown left of Stop. */
     | { type: 'setAutoMode'; enabled: boolean };
   ```

   Append to the `WebviewToHost` union:

   ```ts
     /** The user answered an intervention card. */
     | { type: 'answerIntervention'; id: string; answer: InterventionAnswer }
     /** The user flipped the Auto-mode toggle. */
     | { type: 'setAutoMode'; enabled: boolean };
   ```

   Note the two unions each get their own `setAutoMode` member — that is intended (host echo vs. user action) and is not a conflict, since the unions are separate types.

   Files: `src/orchestrator/webviewProtocol.ts`

3. Add `autoMode` to WebviewState and the reducer seed

   In `WebviewState` add:

   ```ts
     /** Whether Auto mode is on: safe asks are auto-approved, the rest escalate. */
     autoMode: boolean;
   ```

   and set `autoMode: false` in `initialWebviewState()` (after `busy: false`). Keep it a required field with an explicit seed value so the reducer's output shape is total; existing tests that build states with `{ ...initialWebviewState(), ... }` keep compiling unchanged.

   Files: `src/orchestrator/webviewProtocol.ts`

4. Implement the three new reduce cases

   In `reduce`, add three cases before the `default:` exhaustiveness guard (the guard stays as-is; `assertNever(msg)` must still typecheck, which proves all three were handled).

   `showIntervention` — replace in place when the id is already rendered, otherwise append, finalizing a trailing streaming record first (same rule `appendMessage` applies to a non-assistant record) and clearing `empty`:

   ```ts
       case 'showIntervention': {
         const card: RenderRecord = {
           role: 'system',
           content: msg.intervention.prompt,
           intervention: { ...msg.intervention },
         };
         const existing = state.records.findIndex(
           (r) => r.intervention !== undefined && r.intervention.id === msg.intervention.id,
         );
         if (existing >= 0) {
           const records = state.records.slice();
           records[existing] = card;
           return { ...state, records, empty: undefined };
         }
         const last = state.records[state.records.length - 1];
         if (last !== undefined && last.streaming === true) {
           return {
             ...state,
             records: [...state.records.slice(0, -1), { ...last, streaming: false }, card],
             empty: undefined,
           };
         }
         return { ...state, records: [...state.records, card], empty: undefined };
       }
   ```

   `resolveIntervention` — settle the first pending card with that id; a miss returns the same state reference (mirrors `updateTool`'s no-op contract):

   ```ts
       case 'resolveIntervention': {
         let found = false;
         const records = state.records.map((record) => {
           const card = record.intervention;
           if (found || card === undefined || card.id !== msg.id || card.status !== 'pending') {
             return record;
           }
           found = true;
           return {
             ...record,
             intervention: {
               ...card,
               status: 'resolved' as const,
               answer: msg.answer,
               rationale: msg.rationale,
               auto: msg.auto,
             },
           };
         });
         return found ? { ...state, records } : state;
       }
   ```

   `setAutoMode`:

   ```ts
       case 'setAutoMode':
         return { ...state, autoMode: msg.enabled };
   ```

   Update the `reduce` JSDoc bullet list with one line per new message describing exactly these rules.

   Files: `src/orchestrator/webviewProtocol.ts`

5. Persist and project intervention records

   Still in `src/orchestrator/webviewProtocol.ts`, extend the structural `ConversationRecord` (the transcript's shape as this core sees it) with:

   ```ts
     /** For an intervention record: the card and its settled state. */
     intervention?: InterventionView;
   ```

   In `toRenderRecords`, the branch that handles a record with no tool calls currently drops everything but role and content:

   ```ts
       if (calls === undefined || calls.length === 0) {
         out.push({ role: record.role, content: record.content });
         return;
       }
   ```

   Change it to carry an intervention through, without adding the key when absent (so every existing `deepStrictEqual` on projected records keeps passing):

   ```ts
       if (calls === undefined || calls.length === 0) {
         out.push(
           record.intervention === undefined
             ? { role: record.role, content: record.content }
             : { role: record.role, content: record.content, intervention: { ...record.intervention } },
         );
         return;
       }
   ```

   Also mirror the field on `TranscriptRecord` in `src/orchestrator/chatTranscript.ts` so a card can be persisted and read back:

   ```ts
     /** For an intervention record: the card and its settled state. */
     intervention?: InterventionView;
   ```
   with `import type { InterventionView } from './webviewProtocol';` at the top of that file (type-only; `chatTranscript.ts` already imports `ToolCall` as a type the same way).

   Finally add two constructor helpers next to `pendingToolRecord`/`toolUpdate`, following their naming and style:

   ```ts
   /** The pending card row posted when an intervention is raised. */
   export function interventionRecord(view: InterventionView): RenderRecord {
     return { role: 'system', content: view.prompt, intervention: { ...view, status: view.status } };
   }

   /** The `resolveIntervention` message settling `id` with the given answer. */
   export function interventionUpdate(
     id: string,
     answer: InterventionAnswer,
     opts: { rationale?: string; auto?: boolean } = {},
   ): HostToWebview {
     return { type: 'resolveIntervention', id, answer, rationale: opts.rationale, auto: opts.auto };
   }
   ```

   Files: `src/orchestrator/webviewProtocol.ts`, `src/orchestrator/chatTranscript.ts`

6. Extend the reducer test suite

   In `test/webviewProtocol.reducer.test.ts`, import the new symbols (`InterventionView`, `interventionRecord`, `interventionUpdate`) alongside the existing ones and add a `describe('interventions', …)` block after the `updateTool` block. Use a local helper, e.g.

   ```ts
   const ask = (over: Partial<InterventionView> = {}): InterventionView => ({
     id: 'a1', kind: 'confirm', prompt: 'Approve the spec?', status: 'pending', ...over,
   });
   ```

   Cases to cover:
   - `showIntervention` appends a `system` record whose `content` is the prompt and whose `intervention` equals the posted card, and clears `empty`.
   - `showIntervention` with an id already rendered replaces that record in place (records length unchanged, the later fields win) rather than appending a duplicate.
   - `showIntervention` after a `streamDelta` finalizes the trailing streaming record first (`streaming: false`), then appends the card.
   - `showIntervention` copies the card (`next.records[0].intervention !== posted`) and does not mutate the input state.
   - `resolveIntervention` flips the matching pending card to `status: 'resolved'` and attaches `answer`, `rationale` and `auto`; the input state's card is still `pending` afterwards.
   - `resolveIntervention` settles only the first pending card with that id and leaves a second card (different id) pending.
   - `resolveIntervention` for an unknown id, and for a card already `resolved`, returns the same state reference (`assert.strictEqual(reduce(state, …), state)`).
   - `interventionUpdate('a1', { kind: 'approved' }, { auto: true, rationale: 'allow-listed' })` produces the expected `resolveIntervention` message and settles a row built by `interventionRecord`.
   - an option question card resolves with `{ kind: 'option', optionId: 'b' }` and a free-text card with `{ kind: 'text', text: 'ship it' }`; a `permission` card carrying `agent`/`tool`/`args` round-trips those fields through `showIntervention`.
   - `setAutoMode` sets `autoMode` both ways and `initialWebviewState().autoMode === false`.
   - extend the existing 'does not mutate the input state on any message' test with `showIntervention`, `resolveIntervention` and `setAutoMode` calls.

   In the `toRenderRecords` describe block, add one case: a `ConversationRecord` carrying `intervention` projects to a record that keeps the card (copied, not aliased), and a record without one still projects to exactly `{ role, content }` with no `intervention` key (`assert.deepStrictEqual` against the bare object).

   Files: `test/webviewProtocol.reducer.test.ts`

7. Verify

   Run, from the repo root: `npm run compile`, `npm run lint`, then `npm test`. Fix any failure before finishing. Do not touch `media/protocol.js`, `media/chat.js`, the controller, or Auto-mode/seam wiring — those belong to later todos; this todo lands only the typed protocol, state and projection plus their unit tests.

   Files: (none)

## Risks

- `src/orchestrator/index.ts` re-exports both `./interventions` and `./webviewProtocol` with `export *`; re-exporting (rather than type-only importing) `Intervention`, `InterventionAnswer`, `InterventionKind` or `InterventionOption` from webviewProtocol would collide and break the barrel build. Keep the import `import type` and name the new interface `InterventionView`.
- `media/protocol.js` mirrors `reduce` by hand and is intentionally left untouched here, so it drifts from the TS reducer until the webview/mirror-test todo lands. The webview simply ignores the three new message types in the meantime (its switch falls through), which is inert but must not be mistaken for a bug.
- Existing tests assert projected records with `deepStrictEqual` against bare `{ role, content }` objects; adding an always-present `intervention: undefined` key would fail them. Only attach the key when a card exists.
- Making `autoMode` a required field on `WebviewState` breaks any object literal built without spreading `initialWebviewState()`. Compile after the change and fix such literals by spreading the seed rather than by making the field optional.
- `resolveIntervention` must return the identical state reference on a miss (unknown id or already-resolved card); returning a fresh object would defeat the webview's cheap identity check and the no-op test.

## Acceptance

- `npm run compile` succeeds: `HostToWebview` carries `showIntervention`, `resolveIntervention` and `setAutoMode`, `WebviewToHost` carries `answerIntervention` and `setAutoMode`, and `reduce`'s `default:` branch still typechecks as `assertNever(msg)` (proving exhaustiveness).
- `WebviewState.autoMode` exists, `initialWebviewState()` seeds it to `false`, and `setAutoMode` sets it both ways.
- `RenderRecord.intervention` and `ConversationRecord.intervention` are typed as the new `InterventionView`, and `TranscriptRecord` in `src/orchestrator/chatTranscript.ts` carries the same optional field.
- `showIntervention` appends a copied pending card as a `system` record, replaces a card with the same id in place, finalizes a trailing streaming record first, and clears `empty`.
- `resolveIntervention` settles the first matching pending card with `answer`, `rationale` and `auto`, and returns the same state reference for an unknown or already-resolved id.
- `toRenderRecords` projects a persisted intervention record with its card intact (copied, not aliased) and still projects a plain record to exactly `{ role, content }`.
- `interventionRecord` and `interventionUpdate` are exported and used in the tests to build a card row and the message that settles it.
- `npm test` passes with the new cases in `test/webviewProtocol.reducer.test.ts`, and every pre-existing reducer, `toRenderRecords` and `updateTool` test still passes unchanged.
- `npm run lint` is clean, and no file outside `src/orchestrator/webviewProtocol.ts`, `src/orchestrator/chatTranscript.ts` and `test/webviewProtocol.reducer.test.ts` was modified.
