# Plan T01

## Steps

1. Add host-free toHistory (and move the intervention text helpers) into transcriptReader.ts

   In src/orchestrator/transcriptReader.ts add type-only imports: `import type { ChatMessage } from './modelClient'; import type { InterventionAnswer } from './interventions'; import type { InterventionView } from './webviewProtocol';` (all type-only, so no runtime cycle and no vscode import).

   Move `interventionHistoryText(view: InterventionView): string` and `describeAnswer(answer: InterventionAnswer | undefined): string` verbatim from src/activation/chatController.ts (currently at ~lines 1544-1564) into this file. Export `interventionHistoryText` (keep describeAnswer module-private). Output must stay byte-identical: `[intervention] ${view.prompt}\nDecision: ${describeAnswer(view.answer)}`, with the same answer wording ('approved', 'declined' / 'declined (<reason>)', 'chose "<label ?? optionId>"', 'answered: <text>', 'no answer was recorded').

   Add `export function toHistory(records: readonly TranscriptRecord[]): ChatMessage[]` with this algorithm:
   1. Pre-scan: build `settledById = new Map<string, InterventionView>()` — for every record with `intervention`, set the map entry to that view if none exists yet OR if the new view has `status === 'resolved'` (so the settled card wins over a pending one for the same id; a later resolved record overwrites an earlier one).
   2. Walk records in order keeping: `out: ChatMessage[]`, `openCallIds: Set<string> | undefined` (call ids of the assistant record whose window is open), `deferred: ChatMessage[]` (intervention messages held while a window is open), `emittedIds = new Set<string>()`.
      - Helper `flush()`: push all `deferred` onto `out`, clear `deferred`, set `openCallIds = undefined`.
      - `record.intervention !== undefined`: if `emittedIds.has(id)` skip (this collapses the pending+settled pair to one message at the FIRST occurrence's position). Otherwise add id to emittedIds and build `{ role: 'assistant', content: interventionHistoryText(settledById.get(id)!) }`; if `openCallIds !== undefined` push it to `deferred`, else push to `out`. The record does NOT open or close the window.
      - `record.role === 'tool'`: if `openCallIds === undefined` or `record.tool_call_id === undefined` or `!openCallIds.has(record.tool_call_id)`, drop it (defensive, mirrors dropOrphanToolRecords so toHistory is safe on any input). Otherwise push `{ role: 'tool', content, tool_call_id }` directly to `out` (never after a deferred card, because deferred cards are only flushed when the window closes).
      - any other record (user / assistant / system without intervention): call `flush()` first, then push the converted message: role = `record.role === 'system' ? 'assistant' : record.role`, `content`, plus `tool_call_id` / `tool_calls` only when defined (exactly the spread shape toChatMessage uses today). Then if it is an assistant record with `tool_calls !== undefined && tool_calls.length > 0`, set `openCallIds = new Set(tool_calls.map(c => c.id))`.
   3. After the loop call `flush()` (a trailing card after the last tool record is still emitted) and return `out`.

   The window therefore stays open across a run of tool records and any interleaved cards and closes at the next non-tool, non-intervention record; that is the point at which the window's last tool record has been emitted. Do not change `readTranscript` or `dropOrphanToolRecords`. Update the file's header doc comment with a short paragraph describing toHistory: record→message replay lives here, tool messages always directly follow their assistant tool_calls entry, intervention cards met inside an open call window are deferred until the window closes, pending/settled pairs for one id collapse to the settled card, and plain system records replay as assistant. `src/orchestrator/index.ts` already has `export * from './transcriptReader'`, so no index change is needed.

   Files: `src/orchestrator/transcriptReader.ts`

2. Make ChatController.loadHistory use toHistory and delete the local replay helpers

   In src/activation/chatController.ts: add `toHistory` to the value import list from '../orchestrator' (~line 68-89, keep the list's existing style). Change `loadHistory` (~line 1308) to:
   ```ts
   private async loadHistory(file: string): Promise<ChatMessage[]> {
     return toHistory(await readTranscript(file));
   }
   ```
   Delete the module-level functions `toChatMessage`, `interventionHistoryText` and `describeAnswer` (~lines 1524-1564). Keep `toRenderRecord` (still used). Then check the type imports: `InterventionAnswer`, `InterventionView`, `TranscriptRecord` and `ChatMessage` are still used elsewhere in the file (askCard/autoApprove/settleCard, toInterventionView, append, loadHistory) — keep them; remove any import that `npm run lint`/`tsc` reports as unused. Optionally update the '[intervention]' mention in the class doc comment to say history replay goes through `toHistory`. No behaviour change beyond ordering: in-memory history is untouched.

   Files: `src/activation/chatController.ts`

3. Unit, regression and property tests for toHistory

   In test/transcriptReader.test.ts, import `toHistory` (and `interventionHistoryText` if handy) from '../src/orchestrator/transcriptReader', `ChatMessage` type from '../src/orchestrator/modelClient', and `* as fc from 'fast-check'` (already a devDependency, used by e.g. test/apiLog.test.ts). Add `describe('toHistory replay', ...)` — these tests are pure (no fs) and call toHistory on in-memory TranscriptRecord arrays.

   Unit cases:
   (a) 2026-09-30 regression: records = user 'hi'; assistant '' with tool_calls [{id:'call_ask', name:'ask_user', arguments:'{"question":"Which?"}'}]; system card {id:'q1', kind:'question', prompt:'Which?', status:'resolved', answer:{kind:'text', text:'the blue one'}} (content 'Which?'); tool 'the blue one' tool_call_id 'call_ask'; assistant 'ok'; user 'next'. Assert deepStrictEqual to [user, assistant(tool_calls), {role:'tool', content:'the blue one', tool_call_id:'call_ask'}, {role:'assistant', content:'[intervention] Which?\nDecision: answered: the blue one'}, {role:'assistant', content:'ok'}, {role:'user', content:'next'}] and explicitly assert the message right after the tool_calls assistant has role 'tool'.
   (b) pending+settled pair: assistant tool_calls [c1, c2]; tool c1; pending permission card id 'p1'; resolved card id 'p1' (answer declined, reason 'no'); tool c2; assistant 'done'. Expect assistant, tool c1, tool c2, exactly one `[intervention] <prompt>\nDecision: declined (no)`, assistant 'done'.
   (c) a pending card with no settled twin outside any window replays with 'Decision: no answer was recorded'.
   (d) a plain system record (no intervention) replays as `{role:'assistant', content}`; a legacy transcript with no interventions maps 1:1 (roles, content, tool_call_id, tool_calls preserved, no extra keys).
   (e) a trailing card after the window's last tool record at end of input is still emitted, after the tool.
   (f) an orphan tool record (no open window) is dropped.

   Property test (fc.assert with ~200 runs): generate a transcript as a list of turns; each turn = a user record, 0-3 rounds, then an optional plain assistant reply, and optionally a plain system note between turns. A round = an assistant record with 1-3 tool_calls with globally unique ids (e.g. `c${turn}_${round}_${k}`), followed by one tool record per call in order; into the round insert 0-2 interventions at random positions after the assistant record (between/after tool records), each either a single resolved card or a pending card followed later (still in the round) by a resolved card with the same id; ids unique per intervention. Also allow interventions between turns. Stamp ts as increasing ISO strings. Assertions on `toHistory(records)`: (1) for every message with role 'tool', walking backwards over consecutive 'tool' messages reaches an 'assistant' message whose tool_calls contains its tool_call_id (i.e. no non-tool message between a tool message and its call); (2) the count of tool messages equals the count of tool records; (3) each intervention id yields exactly one '[intervention] ' message, and its Decision text is that of the resolved view; (4) no message has role 'system'; (5) the relative order of user messages and of tool messages is preserved.

   Keep all existing tests in this file unchanged (readTranscript still passes cards through in file order).

   Files: `test/transcriptReader.test.ts`

4. Controller-level regression: reloaded history keeps tool adjacent to its call

   In test/chatController.interventions.test.ts add an `it('replays a reloaded conversation with each tool message directly after its call', ...)` next to 'feeds the model the settled card as one assistant history message'. Same flow: startSend(), wait for the pending card, answer approved, awaitRunEnd(); then send `{ type: 'sendText', text: 'continue' }` and awaitRunEnd(3) (the second send also raises a confirm card via the queued default? — note the queue is empty after the first run, so the fake client returns `{content:'done', tool_calls:[]}` and no card is raised; if awaitRunEnd(3) is what the existing test uses, mirror it exactly). Take `const messages = client.requests[client.requests.length - 1] as unknown as ChatMessage[]` (import the ChatMessage type from '../src/orchestrator'). Assert: the index of the assistant message whose tool_calls contains id 'c1' is followed immediately by `{ role: 'tool', tool_call_id: 'c1' }`; the '[intervention] Approve spec "x"?' message appears after that tool message; and generally every tool message is preceded (over consecutive tool messages) by the assistant carrying its call. Update the file's header coverage list with a numbered item for this test. The existing 'feeds the model the settled card…' test must keep passing unmodified.

   Files: `test/chatController.interventions.test.ts`

5. Verify

   Run `npm run compile`, `npm run lint` and `npm test`; all must be green. Grep src/orchestrator/transcriptReader.ts to confirm there is no `vscode` import and grep chatController.ts to confirm `toChatMessage`, `interventionHistoryText` and `describeAnswer` no longer exist there.

   Files: (none)

## Risks

- Collapsing pending+settled pairs by pre-scan means the card text uses the settled view but the position of the first (pending) occurrence; if that occurrence is inside a call window it is deferred to window close, which is the intended fix — do not emit at the settled record's position or the pair could land on both sides of a tool record.
- An assistant record whose tool_calls were never answered (a crash mid-call) still produces an assistant(tool_calls) with no tool messages; this is pre-existing behaviour and out of scope for T01 — do not add synthetic tool messages.
- Moving interventionHistoryText/describeAnswer must keep the text byte-identical, otherwise the existing controller test that looks for '[intervention] Approve spec "x"?' and 'Decision: approved' breaks.
- Removing toChatMessage may leave type imports (InterventionView/InterventionAnswer/TranscriptRecord) looking unused only if they really are; verify with tsc/lint rather than deleting blindly — they are still used by askCard/settleCard/toInterventionView/append.
- transcriptReader.ts must import ChatMessage/InterventionAnswer/InterventionView with `import type` to avoid a runtime import cycle through webviewProtocol/modelClient.
- The controller test's second send: FakeModelClient returns {content:'done'} once the queue is empty, so no card is raised on the second send; mirror the existing test's awaitRunEnd(3) count exactly or the wait can time out.

## Acceptance

- src/orchestrator/transcriptReader.ts exports `toHistory(records: readonly TranscriptRecord[]): ChatMessage[]` and has no vscode import.
- ChatController.loadHistory is `toHistory(await readTranscript(file))`; toChatMessage, interventionHistoryText and describeAnswer no longer exist in src/activation/chatController.ts.
- For records user → assistant(tool_calls ask_user) → system intervention card → tool → assistant, toHistory returns the tool message immediately after the assistant tool_calls message and the '[intervention] <prompt>\nDecision: <answer>' assistant message after the tool message.
- A pending and a settled record with the same intervention id produce exactly one history message carrying the settled decision.
- A system record without intervention replays as an assistant message; a transcript with no interventions maps 1:1 as before.
- The fast-check property test over random valid transcripts passes: every tool message is adjacent (over consecutive tool messages) to the assistant message carrying its call, no tool record is lost, each intervention id appears once, and no 'system' role is emitted.
- The new controller test shows a reloaded conversation's request has the tool message for 'c1' directly after the assistant tool_calls entry; the existing intervention tests pass unchanged.
- npm run compile, npm run lint and npm test are green.
