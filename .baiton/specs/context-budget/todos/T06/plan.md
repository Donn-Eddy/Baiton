# Plan T06

## Steps

1. Add the compaction marker to the transcript record

   In src/orchestrator/chatTranscript.ts:
   1. Export `interface CompactionMarker { id: string; fromTs: string; toTs: string; messages: number; }` with doc comments: `id` unique per compaction; `fromTs`/`toTs` inclusive ISO range of the records the summary replaces in the model history; `messages` = number of history messages that were summarised.
   2. Add `compaction?: CompactionMarker;` to `TranscriptRecord`, documented as: 'For a compaction record: the range of earlier records the summary in `content` replaces when replaying history. The view still renders every record.'
   3. Export `compactionTranscriptRecord(summary: string, marker: CompactionMarker): Omit<TranscriptRecord, 'ts'>` returning `{ role: 'system', content: summary, compaction: { ...marker } }` (mirrors `interventionTranscriptRecord`).
   4. Extend the file header comment with one paragraph: compaction records are `system` records carrying `compaction`; older readers replay them as a plain system note, which is backward compatible.

   Files: `src/orchestrator/chatTranscript.ts`

2. Validate compaction records in readTranscript

   In src/orchestrator/transcriptReader.ts `isTranscriptRecord`, after the intervention check add: `if (rec.compaction !== undefined && (rec.role !== 'system' || !isCompactionMarker(rec.compaction))) { return false; }`. Add a private `isCompactionMarker(value: unknown): boolean`: object, non-null, `typeof id === 'string' && id.length > 0`, `typeof fromTs === 'string'`, `typeof toTs === 'string'`, `Number.isInteger(messages) && messages >= 0`. Extra fields tolerated. `dropOrphanToolRecords` needs no change (a compaction record is an intervention-less system record and closes a call window, which is correct since it is only ever appended at a turn boundary).

   Files: `src/orchestrator/transcriptReader.ts`

3. Honour compaction records in toHistory and add compactionCut

   In src/orchestrator/transcriptReader.ts:
   1. Export `const CONTEXT_SUMMARY_PREFIX = '[context summary] ';` and `export function compactionHistoryText(summary: string): string { return `${CONTEXT_SUMMARY_PREFIX}${summary}`; }`.
   2. At the top of `toHistory`, before the main loop, compute coverage with a private helper `compactionPlan(records): { covered: Set<number>; summaryAt: Map<number, string> }`:
      - collect indices `c` of records with `compaction !== undefined`; iterate them from LAST to FIRST;
      - keep `ranges: { fromTs, toTs }[]` of compactions already applied; if the current compaction's range lies within an applied one (`r.fromTs <= m.fromTs && m.toTs <= r.toTs`) or `covered.has(c)`, it is superseded: `covered.add(c)` and continue (no summary);
      - otherwise for every `j < c` with `!covered.has(j)` and `m.fromTs <= records[j].ts && records[j].ts <= m.toTs` (ISO strings compare lexicographically): `covered.add(j)`, remembering the first such `j`; then `covered.add(c)`; `summaryAt.set(first ?? c, compactionHistoryText(records[c].content))`; push the range.
      Only records BEFORE the compaction record in file order are eligible, so later records sharing a timestamp are never hidden.
   3. In the main loop, first thing per index `i` (switch the `for...of` to an indexed loop): `if (covered.has(i)) { const s = plan.summaryAt.get(i); if (s !== undefined) { flush(); out.push({ role: 'assistant', content: s }); } continue; }`. Because the summary goes through `flush()` like any non-tool record, `openCallIds` resets; a `tool` record whose assistant was covered is dropped by the existing pairing check, so adjacency is preserved.
      Note: `settledById` is still built over all records (unchanged).
   4. Export `compactionCut(records: readonly TranscriptRecord[], keepTurns: number): number | undefined` — the index of the first record to keep: the `keepTurns`-th `user` record counted from the end. Return `undefined` when there are fewer than `keepTurns` user records, when that index is 0, or when `records[cut].ts === records[cut - 1].ts` (a timestamp collision would let the ts range hide a kept record; skip compaction rather than risk it).
   5. Update the header's 'Replay' paragraph: a compaction record hides the records in its `[fromTs, toTs]` range that precede it and replays its summary once, as `[context summary] …`, at the first hidden record's position; a later compaction whose range contains an earlier one supersedes it.

   Files: `src/orchestrator/transcriptReader.ts`

4. Add the contextSummarizeAt setting

   package.json: next to `baiton.orchestrator.contextTrimAt` add `"baiton.orchestrator.contextSummarizeAt": { "type": "number", "default": 0.8, "minimum": 0, "maximum": 1, "description": "Fraction of the model's context window at which the chat, after trimming, summarises every message older than the last two turns into one context summary (goals, decisions taken, files touched, open questions). The summary is appended to the transcript; the full conversation stays visible. Applies only when the context window is known." }`.
   src/activation/commands.ts (one line, required for production wiring; outside the todo's file list but mirrors T05's `contextTrimAt` seam at ~line 854): add `contextSummarizeAt: () => orchCfg().get('orchestrator.contextSummarizeAt'),` to the ChatController deps object.

   Files: `package.json`, `src/activation/commands.ts`

5. Controller: pure summary helpers and the new dep

   In src/activation/chatController.ts:
   1. Add to `ChatControllerDeps`: `/** The raw `baiton.orchestrator.contextSummarizeAt` value, resolved through `resolveContextSummarizeAt`. Absent → 0.8. */ contextSummarizeAt?(): unknown;`
   2. Export constants/helpers (pure, beside `MAX_INPUT_CHARS`):
      - `export const DEFAULT_CONTEXT_SUMMARIZE_AT = 0.8;`
      - `export const SUMMARY_KEEP_TURNS = 2;`
      - `export const SUMMARY_TOOL_RESULT_BYTES = 2048;` and `export const SUMMARY_MESSAGE_BYTES = 8192;`
      - `export function resolveContextSummarizeAt(configured: unknown): number` — finite number with 0 < v <= 1, else 0.8 (same rule as `resolveContextTrimAt`).
      - `export const SUMMARY_SYSTEM_PROMPT` = 'You compact a coding-assistant conversation so it can continue with less context. Summarise the conversation you are given under exactly these headings: Goals, Decisions taken, Files touched, Open questions. Keep file paths, identifiers, commands and decisions verbatim; be concise; omit pleasantries. Reply with the summary only.'
      - `export function summaryRequestMessages(older: readonly ChatMessage[], maxTokens: number): ChatMessage[]` — flattens `older` into ONE user message (no `tool_calls`/`tool` roles, so strict endpoints never see unpaired tool messages and no tool schema is needed). Each message becomes a block: `user:` / `assistant:` / `tool result (<call id>):` followed by content clipped on a UTF-8 boundary to SUMMARY_TOOL_RESULT_BYTES for tool messages and SUMMARY_MESSAGE_BYTES otherwise (append ` …[clipped]`); an assistant's tool calls render as `assistant called <name>(<arguments clipped to 512 bytes>)`. If `estimateTokens(joined) > maxTokens`, drop blocks from the oldest end until it fits and prefix `[earlier messages omitted]`. Return `[{ role: 'system', content: SUMMARY_SYSTEM_PROMPT }, { role: 'user', content: 'Conversation to summarise:\n\n' + joined }]`. Import `estimateTokens` from '../orchestrator/contextBudget'; do UTF-8 clipping with `Buffer.from(s,'utf8').subarray(0,n).toString('utf8')` then strip a trailing U+FFFD.
   3. Import `compactionCut`, `compactionTranscriptRecord` (via '../orchestrator', which re-exports both modules) and `CompactionMarker` type.

   Files: `src/activation/chatController.ts`

6. Controller: the summarise step (private compact) and its trigger in onSend

   In src/activation/chatController.ts:
   1. Add `private async compact(transcript: ChatTranscript, key: string, signal: AbortSignal, sessionId: string): Promise<ChatMessage[] | undefined>` (structured so T07's manual command can call it too):
      a. `const records = await readTranscript(transcript.path); const cut = compactionCut(records, SUMMARY_KEEP_TURNS); if (cut === undefined) return undefined;`
      b. `const older = toHistory(records.slice(0, cut));` if `older.length === 0` or (`older.length === 1` and `older[0].content.startsWith(CONTEXT_SUMMARY_PREFIX)`) return undefined (nothing new to summarise).
      c. `const window = this.deps.contextWindow?.();` `const budget = window !== undefined ? Math.floor(window / 2) : 32_000;` build `messages = summaryRequestMessages(older, budget)`.
      d. `try { const result = await this.deps.client.complete({ messages, signal, sessionId }); summary = result.content.trim(); if (summary.length === 0) throw new Error('the model returned an empty summary'); } catch (err) { if (signal.aborted) return undefined; this.deps.log(`Baiton chat: context summary failed: ${describe(err)}`); if (err instanceof UnreachableEndpointError) log err.message too; this.deps.webview.post({ type: 'showError', message: `Compacting the conversation failed: ${describe(err)}. The conversation was left as it was.` }); return undefined; }` — no `tools`, no `onDelta` (text-only, like `evaluateAsk`).
      e. On success: `const marker: CompactionMarker = { id: `compaction-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, fromTs: records[0].ts, toTs: records[cut - 1].ts, messages: older.length }; const rec = compactionTranscriptRecord(summary, marker); await this.append(transcript, rec); this.deps.webview.post({ type: 'appendMessage', record: toRenderRecord(rec) }); this.trackerFor(key).reset(); return toHistory(await readTranscript(transcript.path));` (re-reading means a failed append — logged by `append` — simply yields the uncompacted history).
      fromTs is ALWAYS the first record's ts, so a new compaction covers (and supersedes) every earlier one.
   2. Add `private async shouldSummarize(history: readonly ChatMessage[], tools: ToolSpec[], systemPrompt: string, autoApprovedLines: ReadonlySet<string>): boolean`: window via `this.deps.contextWindow?.()`; return false unless a positive integer. `estimate = (h) => estimateMessages([{ role: 'system', content: systemPrompt }]) + estimateMessages(h, tools)`; `trimAt = resolveContextTrimAt(this.deps.contextTrimAt?.())`; `const sendable = estimate(history) / window > trimAt ? trimHistory(history, { targetTokens: Math.floor(window * trimAt), estimate, autoApprovedLines }) : history;` return `estimate(sendable) / window > resolveContextSummarizeAt(this.deps.contextSummarizeAt?.())`.
   3. In `onSend`, change `const history` to `let history`. Inside the `try`, BEFORE `runToolLoop` (after `this.abort` is created and busy is set; the user record is already appended and pushed): `if (this.shouldSummarize(history, tools, await this.buildPrompt(slug, mode), autoApprovedLines)) { const compacted = await this.compact(transcript, key, this.abort.signal, sessionId); if (compacted !== undefined) { history = compacted; } }` then pass `history` to `runToolLoop`. Also recompute `autoApprovedLines` is unnecessary (same records). Summary failure never throws out of `compact`, so the loop still runs with the full history (the budget seam's trim still applies).
   4. Update the class header's responsibilities list with one bullet: after trimming, summarise messages older than the last two turns at `contextSummarizeAt` into a compaction record; the view keeps rendering the full transcript.
   `renderConversation` / `toRenderRecords` are unchanged: covered records still render, and the compaction record renders as a system note carrying the summary.

   Files: `src/activation/chatController.ts`

7. Reader tests: validation, round trip and replay of compaction records

   In test/transcriptReader.test.ts add `describe('compaction records', ...)` using a local `rec(role, content, ts, extra?)` builder with distinct ascending ts (`2026-01-01T00:00:0N.000Z`):
   - round trip: write lines for u1, a1, a compaction record `{ ts, role: 'system', content: 'S', compaction: { id: 'c1', fromTs, toTs, messages: 2 } }` to a temp file; `readTranscript` returns them deepStrictEqual.
   - validation: a compaction line with `messages: '2'`, one with empty `id`, one missing `toTs`, and one with `role: 'assistant'` are each skipped; neighbours survive.
   - replay (realistic order, compaction appended after the new user record): records u1, a1(tool_calls [c1]), t1(c1), u2, a2, u3, C{fromTs: u1.ts, toTs: a1/t1 last ts before u2} → `toHistory` deepStrictEqual `[{assistant '[context summary] S'}, u2, a2, u3]`; the summary appears exactly once and no `tool` message is present.
   - 2026-09-30 shape inside the kept region: an assistant tool_calls → intervention card → tool after the cut still yields tool directly after its call.
   - supersede: C1 covering u1..a1 appended after u2, then C2 covering u1..a2 appended after u3 → exactly one summary message, equal to C2's, at index 0; C1's text absent.
   - a compaction whose range precedes every record (covers nothing) emits its summary at its own position.
   - a record AFTER the compaction record with ts equal to toTs is not hidden.
   - `compactionCut`: returns index of the 2nd-last user; undefined with <2 users; undefined when that user is at index 0; undefined on ts collision with the previous record.
   - property (fast-check, 100 runs): generate turns (user + optional assistant/tool pairs + optional intervention cards inside call windows, distinct ascending ts), insert a compaction record after a random user record covering `[records[0].ts, ts of the record before some earlier user record]`; assert every `tool` message in `toHistory` output is immediately preceded by an assistant whose tool_calls contain its id or by a tool message answering the same assistant, and the number of messages starting with '[context summary] ' is exactly 1.

   Files: `test/transcriptReader.test.ts`

8. Round-trip property covers compaction records

   In test/transcript.roundtrip.property.test.ts add `compactionArb: fc.Arbitrary<Omit<TranscriptRecord, 'ts'>>` = `fc.record({ content: contentArb, id: fc.string({ minLength: 1, maxLength: 20 }), fromTs: fc.string({ maxLength: 30 }), toTs: fc.string({ maxLength: 30 }), messages: fc.nat({ max: 500 }) }).map(({ content, id, fromTs, toTs, messages }) => ({ role: 'system' as const, content, compaction: { id, fromTs, toTs, messages } }))`, and include `compactionArb.map((m) => [m])` in the `fc.oneof` of `messagesArb`. Update the doc comment to mention compaction records. The existing exact-equality assertion then proves they round-trip.

   Files: `test/transcript.roundtrip.property.test.ts`

9. Controller compaction tests

   Create test/chatController.compaction.test.ts, static import of ChatController (no vscode loader). Copy the harness shape of test/chatController.mode.test.ts (tmp dir, `baitonDir`, `specsDir`, FakeWebview with `all/last`, registry stub, `waitFor`). Fake client records full requests `{ messages, tools }` and pops a scripted queue of results or Errors. Deps: `contextWindow: () => 1000`, `contextTrimAt: () => 0.5`, `contextSummarizeAt: () => 0.8`, `toolsFor: () => []`, `sessionMemory: { get: () => 'seed', set: async () => {} }`. Seed `<baitonDir>/chat/seed.jsonl` via `new ChatTranscript(file, tickingClock)` (distinct ascending ts per append — REQUIRED, see risks) with 3 turns of large plain text: u1 (1600 'a'), a1 (1600 'b'), u2 (1600 'c'), a2 (1600 'd'), u3, a3 short. Then `controller.start()`, wait for first render, `webview.send({ type: 'sendText', text: 'next' })`, wait for busy false.
   Cases:
   1. over threshold: 2 requests. requests[0] has `tools` undefined, 2 messages (system SUMMARY_SYSTEM_PROMPT, user containing 'aaaa' and 'bbbb' but not 'next'); queue answers `{ content: 'Goals: g', tool_calls: [] }`. requests[1].messages[1] is `{ role: 'assistant', content: '[context summary] Goals: g' }` and no later message contains 1600-char a1/u1 content; u3 and 'next' are present. The transcript (readTranscript) still contains every seed record plus exactly one compaction record (`role: 'system'`, `compaction.fromTs === u1.ts`, `compaction.toTs === a2.ts`? — use the cut: keep last two users 'u3'? note: with the new user 'next' appended, cut is at u3, so toTs === a2.ts and messages === 4). The last `renderConversation` post includes records whose content equals u1's and a1's content (view renders the full transcript) and a record with content 'Goals: g'.
   2. failure: queue first entry is `new Error('boom')`: a `showError` whose message starts 'Compacting the conversation failed: boom' is posted, no compaction record is written, requests[1] still carries u1's content, and the send completes (busy false, final assistant appended).
   3. below threshold: small seed contents → exactly 1 request, no compaction record.
   4. unknown window (`contextWindow: () => undefined`) with large seed → 1 request, no compaction.
   5. replay after reload: a second send after case 1 reads history through toHistory; its first request's messages[1] is the summary and u1 content is absent (a second compaction may run or not — assert summary count exactly 1 among messages).
   Also unit-test `resolveContextSummarizeAt` (0.8 for undefined/0/-1/1.5/'x'/NaN; passes 0.6 and 1) and `summaryRequestMessages` (tool results clipped to 2048 bytes + marker, oldest blocks dropped with '[earlier messages omitted]' when over maxTokens, no tool role in output).

   Files: `test/chatController.compaction.test.ts`

10. Verify

   Run `npm run compile`, `npm run lint`, `npm test`. All existing tests must still pass unchanged (toolLoop without budget untouched; toHistory output unchanged for transcripts without compaction records). Confirm `grep -rn "from 'vscode'" src/orchestrator` finds nothing new.

   Files: (none)

## Risks

- Timestamp collisions: coverage is by ts range; records written in the same millisecond as toTs but after the cut would be hidden. Mitigated by (a) only records preceding the compaction record being eligible and (b) compactionCut refusing a cut whose record shares ts with its predecessor. Tests must seed transcripts with a ticking clock, or everything collapses into one range.
- ChatBudget.prepare is synchronous, so summarisation cannot run mid-loop; T06 summarises once per send, before runToolLoop. Mid-loop growth past the window is left to T07's pre-flight (which may make the seam async and reuse `compact`).
- The summary request itself can be large; summaryRequestMessages clips each message and drops oldest blocks to ~half the window, so very old detail can be lost from the summary (lossy by design).
- Placing the compaction record after the new user record means the rendered summary note appears below the user's bubble; acceptable (render order = file order) but visible.
- commands.ts is outside the todo's listed files but needs one line to wire the new setting in production; without it the controller falls back to the 0.8 default, which still works.
- A compaction record whose summary text coincidentally matches an auto-approved intervention line would be dropped by trim pass 1 — practically impossible given the '[context summary] ' prefix.
- Older Baiton versions replay a compaction record as an extra assistant note without hiding covered records — backward compatible but not size-reducing, as intended by the spec.

## Acceptance

- TranscriptRecord has optional `compaction: { id, fromTs, toTs, messages }`; compactionTranscriptRecord builds a `system` record with it; readTranscript round-trips it and skips malformed compaction markers.
- toHistory hides records preceding a compaction record whose ts lies in [fromTs, toTs], emits `[context summary] <summary>` exactly once as an assistant message at the first hidden record's position, lets a later enclosing compaction supersede an earlier one, and never places anything between an assistant tool_calls entry and its tool messages (unit + property tests).
- Transcripts without compaction records replay exactly as before (existing transcriptReader and chatController tests pass unchanged).
- `baiton.orchestrator.contextSummarizeAt` (number, default 0.8, 0..1) exists in package.json and is wired to the controller's `contextSummarizeAt` dep.
- When the window is known and the estimate after trimming exceeds contextSummarizeAt, onSend issues one text-only completion (no tools) summarising all messages older than the last two turns, appends the compaction record, and the loop's first request carries the summary instead of those messages.
- A failed or empty summary completion posts an inline showError starting 'Compacting the conversation failed:', writes no compaction record, and the send proceeds with the unchanged history.
- After compaction the rendered conversation still contains every original record (full transcript) plus the summary note.
- No `vscode` import in src/orchestrator; `npm run compile`, `npm run lint` (no new warnings) and `npm test` pass.
