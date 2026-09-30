# Plan T02

## Steps

1. Extract a shared UTF-8 cut helper in guard.ts

   In src/orchestrator/guard.ts add a module-private function `cutUtf8(text: string, maxBytes: number): { text: string; truncated: boolean; keptBytes: number; totalBytes: number }` holding the logic now inlined in `GuardContext.boundRead` (lines 316-327): `const bytes = Buffer.from(text, 'utf8')`; if `bytes.byteLength <= maxBytes` return `{ text, truncated: false, keptBytes: bytes.byteLength, totalBytes: bytes.byteLength }`; otherwise `new TextDecoder('utf-8', { fatal: false }).decode(bytes.subarray(0, maxBytes)).replace(/\uFFFD+$/u, '')`, and report `keptBytes = Buffer.byteLength(decoded, 'utf8')`, `totalBytes = bytes.byteLength`. Rewrite `boundRead` to `const cut = cutUtf8(text, READ_RESULT_CAP_BYTES); return { text: cut.text, truncated: cut.truncated };` so its behaviour is byte-for-byte unchanged (the existing property test guards this).

   Files: `src/orchestrator/guard.ts`

2. Add TOOL_RESULT_CAP_BYTES and boundToolResult to guard.ts

   Directly after `READ_RESULT_CAP_BYTES` (and the `BoundedText` interface) export `export const TOOL_RESULT_CAP_BYTES = 64 * 1024;` with a doc comment: the fixed cap, in UTF-8 bytes, on the content of every `tool` message the chat tool loop appends to history and persists, whatever tool produced it, so one unbounded result cannot blow the model's context or grow the transcript without limit. Then export a free (non-method, host-free) function `export function boundToolResult(text: string): string` (it must be a standalone export, not a GuardContext method, because toolLoop has no GuardContext): `const cut = cutUtf8(text, TOOL_RESULT_CAP_BYTES); if (!cut.truncated) return text; return `${cut.text}\n[truncated: ${cut.keptBytes} of ${cut.totalBytes} bytes]`;`. Contract to document in its JSDoc: input at or under the cap is returned verbatim (identity, same string); over the cap the body is cut on a valid UTF-8 character boundary to at most TOOL_RESULT_CAP_BYTES bytes, followed by a newline and exactly one note line `[truncated: <n> of <m> bytes]` where n = UTF-8 bytes kept and m = UTF-8 bytes of the original. Optionally mention in the module header comment (lines 13-19 area) that every tool result is additionally bounded by boundToolResult in the loop.

   Files: `src/orchestrator/guard.ts`

3. Apply the bound in toolLoop.toolResultContent

   In src/orchestrator/toolLoop.ts change the import to `import { ToolResult, boundToolResult } from './guard';` and rewrite `toolResultContent` (lines 62-68) so both branches go through the bound: `if (result.ok) { return boundToolResult(typeof result.data === 'string' ? result.data : JSON.stringify(result.data)); } return boundToolResult(`Error: ${result.error}`);`. Bound the error string AFTER prefixing with 'Error: ' so the prefix webviewProtocol's TOOL_ERROR_PREFIX relies on is always kept (it is within the first 7 bytes). Leave the call site at line 147 unchanged: because `appendMessage` pushes the same `record` to `history` and passes it to `deps.append`, the capped content automatically reaches both the in-memory history and the persisted transcript. Update the toolResultContent doc comment to say the content is bounded to TOOL_RESULT_CAP_BYTES with a truncation note. Guard against `JSON.stringify(undefined)` returning undefined? Current code already has that latent case (data: undefined); keep behaviour by using `?? ''` only if TypeScript complains — prefer `String(JSON.stringify(result.data) ?? '')`-free minimal change: if the compiler accepts `boundToolResult(JSON.stringify(...))` (JSON.stringify is typed as returning string) no extra handling is needed; but since boundToolResult calls Buffer.from, a runtime undefined would throw where it previously did not, so write `JSON.stringify(result.data) ?? ''`? NO — that changes output for undefined from undefined to ''. Instead, inside toolResultContent compute `const raw = ...; return typeof raw === 'string' ? boundToolResult(raw) : raw;` is not needed either: make boundToolResult itself tolerate it by leaving it typed `string` and in toolResultContent pass through unchanged when `raw` is not a string (cast). Simplest acceptable form: `const raw: string = typeof result.data === 'string' ? result.data : JSON.stringify(result.data); return typeof raw === 'string' ? boundToolResult(raw) : raw;` so the no-budget/under-cap path is identical to today for every input.

   Files: `src/orchestrator/toolLoop.ts`

4. Unit tests in test/toolLoop.test.ts

   Import `TOOL_RESULT_CAP_BYTES` from '../src/orchestrator/guard' alongside ToolResult. Add, inside describe('runToolLoop'), using the existing ScriptedClient/makeDeps/toolCallCompletion/finalCompletion helpers: (1) 'caps an oversized string success result in history and the transcript': call returns `{ ok: true, data: 'x'.repeat(TOOL_RESULT_CAP_BYTES + 1000) }`; assert the appended tool record content starts with 'x'.repeat(TOOL_RESULT_CAP_BYTES) followed by exactly `\n[truncated: 65536 of 66536 bytes]` (build the expected string from the constant), assert `Buffer.byteLength(content) - noteBytes <= TOOL_RESULT_CAP_BYTES`, and assert the second request's messages (client.requests[1].messages) contain a tool message with that same capped content (history == transcript). (2) 'caps an oversized JSON (non-string) success payload': data `{ blob: 'y'.repeat(200_000) }`; content ends with a `[truncated: <n> of <m> bytes]` line where m = Buffer.byteLength(JSON.stringify(data)) — match with a regex `/\n\[truncated: (\d+) of (\d+) bytes\]$/` and check both numbers. (3) 'caps an oversized error result and keeps the Error: prefix': call returns `{ ok: false, error: 'e'.repeat(TOOL_RESULT_CAP_BYTES * 2) }`; content matches /^Error: /, has the truncation note, m = byteLength('Error: ' + error). (4) Same for a thrown Error with a huge message (the catch path at line 141-144). (5) 'leaves a result at exactly the cap untouched': data 'z'.repeat(TOOL_RESULT_CAP_BYTES) → content strictly equals input, no '[truncated:' substring. Existing tests must pass unmodified.

   Files: `test/toolLoop.test.ts`

5. Property test for boundToolResult in test/guard.boundedRead.property.test.ts

   Extend the import with `TOOL_RESULT_CAP_BYTES, boundToolResult`. Add a second `it(...)` in the same describe (or a sibling describe 'Guard bounded tool results (property harness)') that reuses `inputArb` (and an over-cap arbitrary built the same way as overCapArb but from TOOL_RESULT_CAP_BYTES; since both caps are 64 KiB the existing overCapArb suffices, but derive from TOOL_RESULT_CAP_BYTES for robustness) with numRuns 200. For every input: let out = boundToolResult(input), orig = utf8Len(input). If orig <= TOOL_RESULT_CAP_BYTES: assert out === input and !out.includes('[truncated:') unless the input itself contained it (inputs from these arbitraries never do). Else: match `/^([\s\S]*)\n\[truncated: (\d+) of (\d+) bytes\]$/`; assert a match; body = m[1]; assert utf8Len(body) <= TOOL_RESULT_CAP_BYTES; assert Number(m[2]) === utf8Len(body); assert Number(m[3]) === orig; assert input.startsWith(body) (prefix, no reordering); assert isValidUtf8(body); assert the body is maximal in the sense utf8Len(body) > TOOL_RESULT_CAP_BYTES - 4 (a cut loses at most one partial code point). Also add a tiny example test: `assert.strictEqual(TOOL_RESULT_CAP_BYTES, 64 * 1024)`. Keep the existing boundRead property untouched.

   Files: `test/guard.boundedRead.property.test.ts`

6. Verify

   Run `npm run compile`, `npm run lint`, `npm test`. Confirm with a grep that no `vscode` import was added under src/orchestrator/ and that guard.ts still exports READ_RESULT_CAP_BYTES and GuardContext.boundRead with unchanged behaviour.

   Files: (none)

## Risks

- The note is appended after a body cut to the full cap, so a truncated result is up to ~40 bytes larger than TOOL_RESULT_CAP_BYTES; tests must assert the body (not the whole string) is <= cap. Choosing to fit the note inside the cap is also acceptable but then the tests must be written to match — pick one and keep guard doc, implementation and tests consistent.
- Refactoring boundRead onto the shared cutUtf8 helper must not change its output; the existing Property 12 test is the regression check.
- JSON.stringify(undefined) returns undefined at runtime; feeding that into Buffer.from would throw where today's code does not. Keep the non-string passthrough so a success with data undefined behaves as before.
- Error content must be bounded after the 'Error: ' prefix is added so webviewProtocol's TOOL_ERROR_PREFIX detection (and the /^Error:/ test) keeps working.
- Read tools already cap their text at READ_RESULT_CAP_BYTES but wrap it in JSON ({path,text,truncated}), so a JSON-escaped read result can now exceed 64 KiB and be truncated a second time by boundToolResult, producing invalid JSON in the tool message. This is intended by the spec (every result bounded) and the note tells the model it was cut; do not try to JSON-aware truncate.
- Large repeated-string fixtures (hundreds of KB) in property tests can slow mocha; keep numRuns at 200 and repeats bounded as overCapArb already does.

## Acceptance

- src/orchestrator/guard.ts exports `TOOL_RESULT_CAP_BYTES === 64 * 1024` beside READ_RESULT_CAP_BYTES and a standalone `boundToolResult(text: string): string`.
- boundToolResult returns its input unchanged when its UTF-8 size is <= TOOL_RESULT_CAP_BYTES; otherwise it returns a valid-UTF-8 prefix of at most TOOL_RESULT_CAP_BYTES bytes followed by `\n[truncated: <n> of <m> bytes]` with n = kept bytes and m = original bytes.
- toolResultContent in src/orchestrator/toolLoop.ts applies boundToolResult to success content (string and JSON-serialised) and to `Error: ...` content, including thrown tool failures; the same capped string is pushed to history, sent on the next completion, and passed to deps.append.
- GuardContext.boundRead behaviour is unchanged and the existing Property 12 test passes unmodified.
- New tests in test/toolLoop.test.ts cover oversized string, JSON, error and thrown results plus the exactly-at-cap passthrough; a new property in test/guard.boundedRead.property.test.ts covers boundToolResult's size, prefix, note and UTF-8 validity.
- All pre-existing toolLoop tests pass unmodified; no `vscode` import appears under src/orchestrator/.
- `npm run compile`, `npm run lint` and `npm test` are green.
