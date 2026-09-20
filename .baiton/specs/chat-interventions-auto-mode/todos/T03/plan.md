# Plan T03

## Steps

1. Add the persisted-intervention record helper to chatTranscript.ts

   `TranscriptRecord.intervention?: InterventionView` already exists (added in T02) and `ChatTranscript.append` already serialises it, because it JSON-stringifies the whole record. What is missing is the one canonical way to build that record, so the controller (later todos) and the tests agree on its shape.

   In `src/orchestrator/chatTranscript.ts`, below the `ChatTranscript` class, export:

   ```ts
   /**
    * The transcript record that persists one intervention card. Cards are stored
    * once, in settled form: a card is appended when it resolves, so a reloaded
    * conversation shows the decision inline and never re-offers an ask whose
    * promise died with the window. `content` mirrors the prompt so a reader that
    * ignores `intervention` still sees the text.
    */
   export function interventionTranscriptRecord(
     view: InterventionView,
   ): Omit<TranscriptRecord, 'ts'> {
     return { role: 'system', content: view.prompt, intervention: { ...view } };
   }

   /** The settled card to persist: `view` flipped to 'resolved' with its answer. */
   export function settledInterventionView(
     view: InterventionView,
     answer: InterventionAnswer,
     opts: { rationale?: string; auto?: boolean } = {},
   ): InterventionView {
     return {
       ...view,
       status: 'resolved',
       answer,
       ...(opts.rationale !== undefined ? { rationale: opts.rationale } : {}),
       ...(opts.auto !== undefined ? { auto: opts.auto } : {}),
     };
   }
   ```

   Import `InterventionAnswer` as a type from `./interventions` alongside the existing `import type { InterventionView } from './webviewProtocol'`. Keep both imports `import type` so chatTranscript stays free of runtime coupling and the `src/orchestrator/index.ts` `export *` barrel gains no duplicate names (`interventionTranscriptRecord` and `settledInterventionView` do not collide with webviewProtocol's `interventionRecord`/`interventionUpdate`). No change to index.ts is needed — it already re-exports `./chatTranscript`.

   Also extend the module doc-comment at the top of the file with a sentence stating that intervention cards are persisted as `system` records carrying `intervention`, appended when the ask settles, so they are part of the append-only history like any other message.

   Files: `src/orchestrator/chatTranscript.ts`

2. Validate the persisted `intervention` field in transcriptReader.ts

   `isTranscriptRecord` in `src/orchestrator/transcriptReader.ts` currently ignores `rec.intervention`, so a line whose `intervention` is a string, a number or a card with no `id` is accepted and flows straight into `toRenderRecords`, where the webview would try to render a card it cannot key or settle. Make the reader's existing tolerance policy cover it: a record whose `intervention` is present but malformed is not a record, so the line is skipped like any other unparseable line.

   Add to `isTranscriptRecord`, after the `tool_calls` check and before `return true`:

   ```ts
     if (rec.intervention !== undefined && !isInterventionView(rec.intervention)) {
       return false;
     }
   ```

   and add a structural guard next to `isToolCallList`:

   ```ts
   /**
    * Structural check for a persisted intervention card. Only the fields the view
    * needs in order to key, label and settle a card are required; the optional
    * fields (options, detail, agent, tool, args, answer, rationale, auto) are
    * tolerated in any shape, so a card written by a newer version still loads.
    */
   function isInterventionView(value: unknown): boolean {
     if (typeof value !== 'object' || value === null) {
       return false;
     }
     const view = value as Record<string, unknown>;
     return (
       typeof view.id === 'string' &&
       view.id.length > 0 &&
       (view.kind === 'question' || view.kind === 'confirm' || view.kind === 'permission') &&
       typeof view.prompt === 'string' &&
       (view.status === 'pending' || view.status === 'resolved')
     );
   }
   ```

   Do not import `InterventionView` for a type predicate here — the file's existing guards (`isToolCallList`) return plain booleans; match that style so no new import is added.

   Files: `src/orchestrator/transcriptReader.ts`

3. Stop an intervention record from orphaning the tool records that follow it

   This is the one real defect persistence introduces, and it must be fixed for reloads to survive. `dropOrphanToolRecords` tracks `openCallIds` from the most recent `assistant` record and resets it to `undefined` on every other non-`tool` record. A confirmation ask raised from inside a tool (today `approve_spec`/`draft_spec`) is appended between the assistant record that requested the call and the `tool` record that answers it, so the sequence on disk becomes:

     assistant(tool_calls:[c1]) → system(intervention) → tool(tool_call_id:c1)

   With today's code the `system` record clears `openCallIds`, the answering `tool` record is classified as an orphan and dropped, and the reloaded conversation loses the tool result (and the endpoint-facing history loses the answer to a call it still advertises).

   Fix: an intervention record is inert with respect to tool pairing — it neither opens nor closes a call window. In the loop body of `dropOrphanToolRecords`, before the `openCallIds` reassignment, add:

   ```ts
       if (record.intervention !== undefined) {
         // An intervention card can be appended between an assistant turn and the
         // tool record answering it (a tool that asks for confirmation mid-call).
         // It is inert for pairing: keep the open call window intact.
         out.push(record);
         continue;
       }
   ```

   Note the ordering: this check must come after the `record.role === 'tool'` branch (a record is never both in practice, but the tool branch owns `tool` records) and before the `openCallIds = …` assignment. Update the module doc-comment's "Pair awareness" paragraph to state that intervention records are passed through without disturbing the open call window.

   Files: `src/orchestrator/transcriptReader.ts`

4. Collapse repeated cards by id in toRenderRecords

   `toRenderRecords` in `src/orchestrator/webviewProtocol.ts` already carries `record.intervention` through (T02). Persistence adds one hazard it does not yet handle: the transcript is append-only, so the same card id can appear more than once on disk — a pending record appended when the ask is raised and a resolved record appended when it settles, or a re-post after a re-render. Projected naively, one ask renders as two cards, one of them permanently pending and unanswerable.

   Make the projection idempotent by id: the card renders once, at the position of its first occurrence, carrying the last recorded state for that id (last write wins, so a resolved record supersedes the pending one).

   Implementation, inside `toRenderRecords`, alongside the existing `answers` pre-pass:

   ```ts
     // Last recorded state of each intervention card, by ask id: a card may be
     // persisted pending and then again resolved, and renders once, settled.
     const cards = new Map<string, ConversationRecord['intervention']>();
     const cardFirstIndex = new Map<string, number>();
     records.forEach((record, index) => {
       const card = record.intervention;
       if (card !== undefined) {
         cards.set(card.id, card);
         if (!cardFirstIndex.has(card.id)) {
           cardFirstIndex.set(card.id, index);
         }
       }
     });
   ```

   Then in the main `records.forEach` body, in the branch that handles a record with no tool calls, replace the current push with:

   ```ts
       const card = record.intervention;
       if (card !== undefined) {
         // Only the first record for an id emits a row; later ones update it.
         if (cardFirstIndex.get(card.id) !== index) {
           return;
         }
         const latest = cards.get(card.id) ?? card;
         out.push({ role: record.role, content: record.content, intervention: { ...latest } });
         return;
       }
       out.push({ role: record.role, content: record.content });
       return;
   ```

   Keep the copy (`{ ...latest }`) — the existing test asserts the projected card is not the same object reference as the input. Keep the `content` of the *first* record (the prompt), not the later one, so the row's text is stable. A record with no card must still project to exactly `{ role, content }` with no `intervention` key — the existing assertions depend on it.

   Update the `toRenderRecords` doc-comment to document the new rule: "A record carrying an `intervention` card renders as one card row; when the same ask id appears more than once (persisted pending, then resolved) the row keeps the first occurrence's position and the last occurrence's card state."

   Files: `src/orchestrator/webviewProtocol.ts`

5. Test the reader: intervention records round-trip, validate and do not break pairing

   Add a new `describe('intervention records (Task T03)')` block to `test/transcriptReader.test.ts`, reusing the file's existing `newDir` / `writeTranscript` / `line` helpers and the `user` record fixture used by the orphan-tool block. Import `InterventionView` as a type from `../src/orchestrator/webviewProtocol`.

   Cases:
   1. `returns a resolved intervention record unchanged` — write `user` plus a record `{ ts, role: 'system', content: 'Approve the spec?', intervention: { id: 'a1', kind: 'confirm', prompt: 'Approve the spec?', status: 'resolved', answer: { kind: 'approved' }, rationale: 'matched the allow-list', auto: true } }`; assert `deepStrictEqual(records, [user, card])` — every field of the card survives the JSON round trip.
   2. `keeps a permission card's agent/tool/args fields` — a `kind: 'permission'` card with `agent: 'claude'`, `tool: 'Bash'`, `args: '{"command":"ls"}'`, `status: 'resolved'`, `answer: { kind: 'declined', reason: 'declined' }`; assert it is returned byte-identical in content.
   3. `keeps an option question card's options` — a `kind: 'question'` card with `options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B', detail: 'the other one' }]`, `allowFreeText: true`, `answer: { kind: 'option', optionId: 'b' }`.
   4. `skips a record whose intervention is malformed but keeps its neighbours` — three lines: `user`, a line whose `intervention` is `{ kind: 'confirm', prompt: 'x', status: 'pending' }` (no `id`), and a valid assistant record; assert the result is `[user, assistant]`. Add a sibling case where `intervention` is the string `'nope'`.
   5. `does not orphan the tool record that follows an intervention` — the regression test for step 3 of this plan: write `user`, `assistant` with `tool_calls: [{ id: 'call_ok', name: 'approve_spec', arguments: '{}' }]`, then the `system` intervention card record, then `tool` with `tool_call_id: 'call_ok'`; assert `deepStrictEqual(records, [user, assistant, card, tool])` with a message like 'an intervention between the call and its answer must not orphan the answer'. Also assert the inverse still holds: a plain `system` record (no `intervention`) in that position still drops the following tool record, so the existing tolerance rule is unchanged.

   Use literal `ts` strings in ascending order (`'2024-01-01T00:00:0N.000Z'`), matching the file's existing style.

   Files: `test/transcriptReader.test.ts`

6. Test the projection: one row per ask id, last state wins

   Extend the existing `describe('toRenderRecords')` block in `test/webviewProtocol.reducer.test.ts` (the `InterventionView` and `ConversationRecord` imports are already present). Leave the existing 'projects an intervention record with its card intact and a plain record bare' test untouched — it must keep passing.

   Add:
   1. `collapses a pending and a resolved record for the same ask into one settled row` — records: `{ role: 'system', content: 'Approve?', intervention: { id: 'a1', kind: 'confirm', prompt: 'Approve?', status: 'pending' } }`, `{ role: 'user', content: 'hi' }`, `{ role: 'system', content: 'Approve?', intervention: { id: 'a1', kind: 'confirm', prompt: 'Approve?', status: 'resolved', answer: { kind: 'approved' }, rationale: 'allow-listed', auto: true } }`. Assert the output has length 2, that `out[0].intervention` is the resolved card (status `'resolved'`, `answer.kind === 'approved'`, `auto === true`), that `out[1]` is `{ role: 'user', content: 'hi' }`, and that the card row sits at index 0 — first-occurrence position, last-occurrence state.
   2. `keeps two distinct asks as two rows in order` — two cards with ids `a1` and `a2`; assert `out.map(r => r.intervention?.id)` is `['a1', 'a2']`.
   3. `still projects a tool row after an intervention record` — `assistant` with `tool_calls: [call('c1','approve_spec','{}')]`, then the `system` card record, then `{ role: 'tool', content: 'ok', tool_call_id: 'c1' }`; assert the tool row is present with `result: 'ok'` and that the card row is present, i.e. the card between them does not break pairing in the projection either.
   4. Extend a purity assertion: after calling `toRenderRecords` on a records array holding a card, assert the input card object is unchanged (`deepStrictEqual` against a pre-call `JSON.stringify` snapshot) and that `out[0].intervention` is not the same reference as the input card.

   No new reducer cases are needed — `showIntervention`, `resolveIntervention` and `setAutoMode` were covered in T02.

   Files: `test/webviewProtocol.reducer.test.ts`

7. Verify with the repo's own gates

   Run, in order: `npm run compile`, `npm run lint`, `npm test`. The full suite stood at 863 passing / 1 pending after T02; it must stay green with the new cases added. If `npm test` is slow to narrow a failure, a single file can be run with `npx mocha --no-config test/transcriptReader.test.ts --require ts-node/register` (the pattern T01 used), but the final verification is the full `npm test`.

   Files: (none)

## Risks

- The append-order hazard is the crux of this todo: the transcript is append-only, so a card that is persisted pending and later persisted resolved yields two lines for one ask. The projection change (step 4) makes that harmless, but the intended write policy is still 'append once, when the ask settles' — `interventionTranscriptRecord` is documented that way so the later controller todo does not invent a second convention.
- `dropOrphanToolRecords` silently dropping the tool record that follows an intervention is a live bug the moment cards are persisted (approve_spec asks from inside a tool call). If step 3 is skipped, reloading a conversation loses tool results and hands the endpoint an assistant turn whose advertised call has no answer — the exact failure the pair-awareness rule exists to prevent.
- `toChatMessage` in src/activation/chatController.ts maps a persisted `system` record to an `assistant` message, so a persisted card's prompt text re-enters the model history as assistant text on reload. That file is outside this todo's scope and the behaviour is pre-existing for `system` records, but it means a card's prompt is visible to the model; flag it for the controller todo rather than changing it here.
- media/protocol.js is deliberately untouched (T02 left it that way and the mirror test is a later todo), so the JS reducer does not yet mirror the new projection rule. Nothing in this todo depends on it, but TS/JS parity remains outstanding until the mirror-test todo lands.
- Several existing assertions use `deepStrictEqual` on whole projected records and on whole read-back transcript records, so any stray `intervention: undefined` key or reordered field will break them. Attach the `intervention` key only when a card exists, and build the settled card with conditional spreads so absent `rationale`/`auto` never serialise as `undefined`.
- test/transcript.roundtrip.property.test.ts generates records without `intervention`; it is unaffected, but if its arbitraries are ever extended to cover cards, the reader's new structural guard becomes part of the round-trip contract.

## Acceptance

- `npm run compile` succeeds with no TypeScript errors.
- `npm run lint` is clean.
- `npm test` passes with no regressions against the post-T02 baseline (863 passing, 1 pending) plus the new cases.
- src/orchestrator/chatTranscript.ts exports `interventionTranscriptRecord` and `settledInterventionView`, both reachable through the src/orchestrator/index.ts barrel with no duplicate-export error, and chatTranscript still imports InterventionView/InterventionAnswer as types only.
- readTranscript returns an intervention record with every card field intact — including kind-specific fields (options/allowFreeText for a question; agent/tool/args for a permission) and settled fields (answer, rationale, auto) — for all three kinds.
- readTranscript skips a line whose `intervention` is malformed (missing id, wrong kind, non-object) while returning the surrounding records in order.
- A transcript of assistant(tool_calls:[c1]) → system(intervention) → tool(c1) reads back with all four records, and a plain `system` record in that same position still drops the tool record (the pre-existing rule is unchanged).
- toRenderRecords renders one row per ask id: a pending record followed by a resolved record for the same id yields a single row at the first occurrence's position carrying the resolved card's status, answer, rationale and auto flag.
- toRenderRecords still projects a record with no card to exactly `{ role, content }` (no `intervention` key), copies the card rather than aliasing it, and does not mutate its input.
