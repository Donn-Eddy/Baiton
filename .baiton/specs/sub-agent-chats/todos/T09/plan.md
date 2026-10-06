# Plan T09

## Steps

1. Add `concurrent?: boolean` to the Tool interface

   In src/orchestrator/guard.ts, interface `Tool` (around line 118): add an optional field `concurrent?: boolean;` right after `dispatch?: boolean;`. Give it a JSDoc comment like the ones nearby: 'Whether the tool loop may run this call in parallel with the adjacent concurrent-flagged calls of the same completion. Only side-effect-free or self-serializing tools set it (the read tools, `run`); a tool that writes spec files, raises a card or finishes a spec leaves it unset so it runs alone.' Also add a `concurrent` bullet to the block comment above the interface (lines 104-117), in the same style as `mutating`/`dispatch`. guardTool and the registry need no change: the guard treats the flag as opaque.

   Files: `src/orchestrator/guard.ts`

2. Flag every read tool and `run` as concurrent

   src/orchestrator/readTools.ts: add `concurrent: true,` (next to `mutating: false,`) in all eight tool factories: `list_specs` (~l.49), `read_spec` (~l.85), `list_files` (~l.128), `read_file` (~l.159), `search` (~l.219), `git_status` (~l.286), `git_diff` (~l.312), `git_log` (~l.342). src/orchestrator/controlTools.ts: in `runTool` (~l.677) add `concurrent: true,` after `dispatch: true,` (the run queue is per todo and already refuses a second stage for the same todo with `busy`, so two parallel `run` calls are safe). Do NOT flag `ask_user`, `draft_spec`, `start_run`, `investigate`, `approve_spec`, `land_todo`, `submit_pr`, nor any tool in specWriteTools.ts. Optionally add one sentence to the readTools.ts module comment saying read tools are flagged concurrent.

   Files: `src/orchestrator/readTools.ts`, `src/orchestrator/controlTools.ts`

3. Add an `isConcurrent` seam to ToolLoopDeps

   In src/orchestrator/toolLoop.ts, `ToolLoopDeps` gains an optional member: `isConcurrent?(name: string): boolean;` documented as: 'Whether a tool call may run in parallel with its concurrent neighbours (the tool's `concurrent` flag). Absent, every call runs one after another as before.' Keep `tools: ToolSpec[]` unchanged (ToolSpec is the wire shape sent to the model; do not add the flag there). Add a bullet for it to the dep list comment above the interface, and extend the module header comment with a sentence: within one completion, maximal runs of consecutive concurrent-flagged calls run in parallel, every other call runs alone, and results are appended in the model's call order.

   Files: `src/orchestrator/toolLoop.ts`

4. Run concurrent segments in parallel inside runToolLoop

   Replace the per-call loop at toolLoop.ts lines 179-197 with segment execution. Add two private helpers below `toolResultContent`:

   1. `async function runOneCall(toolCall: ToolCall, deps: ToolLoopDeps): Promise<ToolResult>` — the existing try { await deps.call(toolCall.name, toolCall.arguments, toolCall.id, deps.signal) } catch (err) { return { ok: false, error: err instanceof Error ? err.message : String(err) } } logic, so it never rejects.

   2. `function segmentCalls(calls: readonly ToolCall[], isConcurrent: (name: string) => boolean): ToolCall[][]` — splits the calls, preserving order, into segments: a maximal run of consecutive calls for which `isConcurrent(call.name)` is true forms one segment; every non-concurrent call is a segment of its own. Example [r1, r2, w, r3] → [[r1, r2], [w], [r3]]. (Segmenting rather than 'all concurrent first' keeps a read issued after a write seeing the write.)

   Then in the loop body:
   ```ts
   const isConcurrent = deps.isConcurrent ?? (() => false);
   for (const segment of segmentCalls(completion.tool_calls, isConcurrent)) {
     if (deps.signal.aborted) {
       await appendMessage(history, deps, { role: 'assistant', content: STOPPED_NOTICE });
       return;
     }
     // Start every call of the segment before awaiting any (a one-call segment is just sequential).
     const results = await Promise.all(segment.map((toolCall) => runOneCall(toolCall, deps)));
     // Append in the model's call order so transcript/history shape is unchanged.
     for (let i = 0; i < segment.length; i += 1) {
       await appendMessage(history, deps, { role: 'tool', content: toolResultContent(results[i]), tool_call_id: segment[i].id });
     }
   }
   ```
   Keep the comment '(Req 9.2–9.4)'. Everything else is unchanged: the abort check before each segment mirrors today's check before each call (with no concurrent flags each segment has one call, so behaviour is byte-identical to today); the post-loop abort check (lines 199-203), the round bound, the result cap (`toolResultContent` → `boundToolResult`) and the assistant `tool_calls` record are untouched. Appends stay strictly sequential (never inside Promise.all). Import `ToolCall` is already imported.

   Files: `src/orchestrator/toolLoop.ts`

5. Wire the seam in the chat controller (one line)

   So the flag takes effect in the real app, in src/activation/chatController.ts at the `runToolLoop(history, { ... })` call (~l.1159) add `isConcurrent: (name) => this.deps.registry.definitions().some((t) => t.name === name && t.concurrent === true),` next to `call:`. `this.deps.registry` is the `ToolRegistry` already held by the controller (field at ~l.285). This is a one-line wiring outside the todo's listed files; it adds no behaviour beyond the flag the todo introduces. If a reviewer insists on the file list, it may be dropped and left to the sub-agent/controller todo — the loop default (absent seam → sequential) keeps everything green either way.

   Files: `src/activation/chatController.ts`

6. Unit tests for parallel execution in test/toolLoop.test.ts

   First make `makeDeps` forward the new seam: add `...(overrides.isConcurrent !== undefined ? { isConcurrent: overrides.isConcurrent } : {}),`. Add a helper `multiCallCompletion(calls: Array<{ id: string; name: string }>): CompletionResult` returning `{ content: undefined, tool_calls: calls.map(c => ({ id: c.id, name: c.name, arguments: '{}' })) }`, and a deferred helper (`function deferred<T>() { let resolve!: (v: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }`). New `describe('concurrent tool calls', ...)` with:
   (a) 'starts every concurrent call of a segment before any resolves': calls c1,c2,c3 all named 'read_file', isConcurrent = () => true; the fake `call` records `started.push(callId)` then awaits a per-call deferred; after `started.length === 3` (poll with `await new Promise(setImmediate)` a few times, or have the third call resolve all) resolve them in reverse order (c3, c2, c1); assert all three started before the first resolved, and the appended `tool` messages' `tool_call_id`s are ['c1','c2','c3'] (call order, not completion order) with contents matching each call's own result.
   (b) 'runs non-concurrent calls alone and in order': calls [r1 (concurrent), r2 (concurrent), w (not), r3 (concurrent)] with isConcurrent = name => name.startsWith('read'); track an in-flight counter in `call` (increment on entry, yield with `await Promise.resolve()`, record max overlap seen while `w` runs, decrement on exit); assert `w` never overlapped any call, r1/r2 overlapped (max in-flight 2 during their segment), r3 started only after w finished, and appended tool ids are [r1,r2,w,r3].
   (c) 'without isConcurrent every call runs sequentially' (no seam given, two calls, assert max in-flight is 1).
   (d) 'a throwing concurrent call becomes an error tool message without affecting its siblings': c1 throws Error('boom'), c2 ok; assert contents 'Error: boom' and 'ok' in order, loop continues to the final completion.
   (e) 'abort during a concurrent segment appends every result of the segment, then the stopped notice': c1 calls controller.abort() and returns; c2 returns ok; followed by a second completion that must never be requested; assert requests.length === 1, both tool messages appended in order, last message is STOPPED_NOTICE.
   (f) 'abort between segments skips later segments': [r1 concurrent (aborts), w non-concurrent]; assert w was never called, r1's tool message is appended, last message is STOPPED_NOTICE.
   (g) 'caps oversized concurrent results': two concurrent calls each returning 'x'.repeat(TOOL_RESULT_CAP_BYTES + 100); assert both tool contents are bounded the same way the existing cap tests assert (reuse their assertion style).

   Files: `test/toolLoop.test.ts`

7. Extend the termination property test with ordering and pairing invariants

   In test/toolLoop.termination.property.test.ts keep the existing property unchanged and add a second `it(...)` (or broaden the generator; prefer a second property to keep the original intact). Changes:
   - New reply shape: `type MultiReply = { kind: 'text'; content: string } | { kind: 'tools'; calls: Array<{ concurrent: boolean; delay: number; fail: boolean }> }` with `calls` generated by `fc.array(fc.record({ concurrent: fc.boolean(), delay: fc.integer({ min: 0, max: 3 }), fail: fc.boolean() }), { minLength: 1, maxLength: 4 })`.
   - A `MultiFakeClient` like FakeClient that, for a `tools` reply at completion n, emits tool calls with ids `call-${n}-${i}` and names encoding the flags, e.g. `${concurrent ? 'c' : 's'}-${delay}-${fail ? 'f' : 'k'}`; once replies run out it emits a single non-concurrent call (always-tool case).
   - `isConcurrent: (name) => name.startsWith('c-')`.
   - Fake `call`: increments `inFlight`, records `{ callId, concurrent, inFlightAtStart }` and appends callId to `started`; yields `delay` microtasks (`for (k<delay) await Promise.resolve()`); for a non-concurrent call asserts/records that `inFlight === 1` throughout (record a violation flag if not); decrements; returns `{ ok: false, error: 'boom' }` (or throws) when `fail`, else `{ ok: true, data: callId }`.
   - Capture appended records including `tool_calls`.
   - Invariants to assert per run: (1) completions <= roundBound and the last message is the bound notice iff no scripted text reply within the bound (reuse the existing logic); (2) pairing: walking `appended`, every assistant record with `tool_calls` is immediately followed by tool records whose `tool_call_id` sequence equals exactly its `tool_calls` ids in order (the final round may be followed by the bound notice; no abort here so it is always complete), and every tool record answers the nearest preceding assistant tool_calls; (3) no tool record appears without a preceding assistant tool_calls, and no call id is answered twice; (4) every emitted call id was passed to `call` exactly once; (5) a non-concurrent call never overlapped another call (violation flag false); (6) segment order: for each completion, a call never starts before every call of an earlier segment has finished (track `finished` set; at start of a call assert all ids of earlier segments in that completion are in `finished`); (7) content of each tool record is `call-…` for ok calls and starts with 'Error: ' for failing ones.
   - Optionally a third small property with abort: an extra generated `abortAt` index — the call with that global index invokes controller.abort(); assert the last message is the stopped notice, completions never increase after the abort, and the pairing invariant holds except the final assistant tool_calls may be answered by only a prefix made of whole segments.
   - Keep `numRuns: 200`; microtask delays keep it fast. Update the file header comment to mention the new ordering/pairing property.

   Files: `test/toolLoop.termination.property.test.ts`

8. Verify

   Run `npm run compile`, `npm run lint` and `npm test`; all must pass. Check that every existing toolLoop/registry/readTools/controlTools test still passes unchanged (no seam → sequential path is identical). Grep that `concurrent: true` appears exactly 9 times in src/orchestrator (8 in readTools.ts, 1 for `run` in controlTools.ts) and nowhere in specWriteTools.ts.

   Files: (none)

## Risks

- Abort semantics: with parallel segments, all calls of a segment are already started when the abort lands, so all their results are appended before the stopped notice; that matches today's per-call behaviour only at segment granularity. Keep the abort check before each segment, not inside Promise.all.
- Appending from inside Promise.all would interleave transcript writes and break call-order pairing; appends must happen after the segment settles, sequentially.
- runOneCall must never reject (catch everything) or Promise.all would short-circuit and drop sibling results.
- Running non-concurrent calls alongside a concurrent batch (instead of segmenting) would let a read race a preceding write; segmenting by consecutive runs avoids that.
- The chatController wiring is outside the listed files; if dropped, the feature is inert in the app until a later todo wires `isConcurrent` (tests still cover the loop).
- Property test flakiness: use microtask yields, not timers, so overlap is deterministic and runs stay fast; ensure call ids are unique across completions.
- Two parallel `run` calls for the same todo rely on the per-todo queue's `busy` refusal; that is existing behaviour, not something this todo must add.

## Acceptance

- `Tool` in src/orchestrator/guard.ts has an optional documented `concurrent?: boolean`.
- All eight read tools in readTools.ts and the `run` tool in controlTools.ts set `concurrent: true`; ask_user, draft_spec, start_run, investigate, approve_spec, land_todo, submit_pr and the spec-write tools do not.
- `ToolLoopDeps.isConcurrent?(name)` exists; when absent the loop runs every call sequentially with output identical to before.
- Within one completion, consecutive concurrent-flagged calls start before any of them is awaited; non-concurrent calls run alone; tool results are appended in the model's call order with matching tool_call_ids.
- A thrown or failed concurrent call yields an 'Error: …' tool message without affecting its siblings; results are capped as before.
- Abort before a segment appends the stopped notice and runs no further calls; round bound behaviour is unchanged.
- test/toolLoop.test.ts covers parallel start, call-order appending, non-concurrent isolation, default sequential, error, abort-in-segment and cap cases.
- test/toolLoop.termination.property.test.ts keeps the original property and adds ordering and pairing invariants over multi-call completions with mixed concurrent flags.
- `npm run compile`, `npm run lint` and `npm test` pass.
