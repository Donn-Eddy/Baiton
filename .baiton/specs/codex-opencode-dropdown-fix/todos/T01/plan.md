# Plan T01

## Steps

1. Add the model/list request-shape constants and two pure helpers in src/adapter/codex.ts

   In the `--- \`codex app-server\` model discovery ---` block of src/adapter/codex.ts (next to CODEX_APP_SERVER_MODEL_LIST_METHOD / CODEX_APP_SERVER_MODEL_LIST_ID, around lines 151-164), add and export:

   - `export const CODEX_APP_SERVER_MODEL_LIST_INCLUDE_HIDDEN = true;` — doc comment: hidden models are kept because the id is still a valid `--model` value, and the curated list must not silently omit one.
   - `export const CODEX_APP_SERVER_MODEL_LIST_PAGE_SIZE = 100;` — the `limit` sent with every page.
   - `export const CODEX_APP_SERVER_MODEL_LIST_MAX_PAGES = 20;` — a hard page cap so a server that keeps handing back a cursor can never loop forever (20 x 100 ids is far beyond any real catalogue).
   - `export function codexModelListParams(cursor?: string): Record<string, unknown>` — returns `{ includeHidden: CODEX_APP_SERVER_MODEL_LIST_INCLUDE_HIDDEN, limit: CODEX_APP_SERVER_MODEL_LIST_PAGE_SIZE }` and adds a `cursor` key ONLY when `cursor` is a non-empty string (conditional key assignment, never an own `undefined` key — same discipline as `codexEntryFromItem`). Pure, never throws.
   - `export function codexNextCursor(payload: unknown): string | undefined` — pure and total: returns `undefined` for a non-object payload (including an array, which carries no pagination), else the first non-empty trimmed string of `nextCursor` then `next_cursor` via the existing `firstNonEmptyString` helper, else `undefined`.

   Also keep `CODEX_APP_SERVER_MODEL_LIST_ID = 2` as the id of the FIRST page and document that follow-up pages use consecutive ids 3, 4, … so each reply is matched to exactly one request.

   Files: `src/adapter/codex.ts`

2. Teach codexModelsFromAppServer the real app-server reply shape

   Three surgical edits in src/adapter/codex.ts, all inside the existing pure parser (no signature change, still total, still never mutates, still conditional-key entries):

   1. `appServerModelItems` (around line 212): after the bare-array branch, check `obj['data']` FIRST (preferred, this is what `result.data` sends), then `obj['models']`, then `obj['items']`; anything else still `[]`.
   2. `codexEntryFromItem` (around line 244): change the id precedence to `firstNonEmptyString([raw['model'], raw['id'], raw['slug']])` — `model` first, then `id`, then `slug`. (No existing test supplies both `model` and `id` on one item, so this is behaviour-compatible with the current suite.)
   3. `effortsFromSupported` (around line 271): for an object element, read `effort ?? reasoningEffort ?? id ?? name` — i.e. insert `reasoningEffort` after `effort` and before `id`, so the app-server's `{ reasoningEffort, description }` elements parse. Everything else (trim, blank skip, dedupe keeping first-seen order, `undefined` when the list ends up empty) is unchanged.

   `defaultReasoningEffort` / `defaultEffort` handling, the `label` rule (`displayName` then `name`, dropped when equal to the id), the id dedupe and the `[]`-on-unrecognised-payload contract all stay exactly as they are. Update the function's doc comment bullet list to describe `data` (preferred) / `models` / `items`, the `model`-first id precedence, and `reasoningEffort` on effort objects.

   Files: `src/adapter/codex.ts`

3. Send the real request and follow nextCursor in CodexAdapter.discoverModels

   In `CodexAdapter.discoverModels` (src/adapter/codex.ts, around lines 722-890), inside the existing `new Promise<ModelEntry[] | undefined>` body, keep the JSONL framing, the single idempotent `finish`, the unref'd timeout timer, the kill-on-every-path teardown and the `undefined`-on-failure contract. Add page accumulation:

   - Declare, beside `buffer`/`settled`: `const collected: ModelEntry[] = [];`, `const collectedIds = new Set<string>();`, `let pendingListId = CODEX_APP_SERVER_MODEL_LIST_ID;`, `let pageCount = 0;`, `const seenCursors = new Set<string>();`.
   - Add `const settleWithPages = (reason?: string): void => finish(collected.length > 0 ? [...collected] : undefined, reason);` — a failed, exited, closed or timed-out FOLLOW-UP settles with the pages already received; with no page at all it still settles `undefined`.
   - Add `const appendPage = (payload: unknown): void => { for (const entry of codexModelsFromAppServer(payload)) { if (!collectedIds.has(entry.id)) { collectedIds.add(entry.id); collected.push(entry); } } }` — cross-page dedupe, first occurrence wins.
   - In the `initialize` branch, replace the `params: {}` model/list write with `writeMessage({ jsonrpc: '2.0', id: CODEX_APP_SERVER_MODEL_LIST_ID, method: CODEX_APP_SERVER_MODEL_LIST_METHOD, params: codexModelListParams() })`.
   - Replace the `raw.id === CODEX_APP_SERVER_MODEL_LIST_ID` branch of `dispatch` with `raw.id === pendingListId` (so page 2 answers id 3, page 3 id 4, …; replies with any other id are still ignored and never answered). Inside it:
     - `if (raw.error) { settleWithPages(`${CODEX_BIN} ${CODEX_APP_SERVER_SUBCOMMAND} model/list failed`); return; }` — unchanged reason text, so the existing first-page error test still sees `undefined` plus a non-empty log line.
     - `appendPage(raw.result); pageCount += 1;`
     - `const cursor = codexNextCursor(raw.result);`
     - `if (cursor !== undefined && !seenCursors.has(cursor) && pageCount < CODEX_APP_SERVER_MODEL_LIST_MAX_PAGES) { seenCursors.add(cursor); pendingListId += 1; writeMessage({ jsonrpc: '2.0', id: pendingListId, method: CODEX_APP_SERVER_MODEL_LIST_METHOD, params: codexModelListParams(cursor) }); return; }`
     - else `finish([...collected]);` (an absent, blank, repeated or cap-exceeding cursor ends pagination).
   - Change the timeout, `exit`, `close` and `error` handlers and the `writeMessage` write-failure path from `finish(undefined, reason)` to `settleWithPages(reason)`, keeping every reason string byte-identical so the existing assertions on the logged reasons still hold. Leave the ABORT path as `finish(undefined, …)`: a cancelled refresh yields nothing, not a partial list.
   - After the promise: the existing `entries === undefined || entries.length === 0 → undefined`, the `hasEfforts` union / `CODEX_EFFORTS` fallback and `capabilitiesFromEntries` are unchanged.

   Update the `discoverModels` doc comment to state that `model/list` is sent with `includeHidden` and `limit`, that a non-empty `nextCursor` is followed on consecutive request ids up to `CODEX_APP_SERVER_MODEL_LIST_MAX_PAGES` within the same timebox, that a repeated cursor ends pagination, and that a failed/timed-out follow-up page settles with the pages already received while a first-page failure still resolves `undefined`.

   Files: `src/adapter/codex.ts`

4. Extend test/adapter.codex.test.ts: parser cases and pagination cases

   In the `codexModelsFromAppServer (model-selector-refresh T05)` describe block, add:
   - `it('prefers result.data over models/items and parses its entries')` — `codexModelsFromAppServer({ data: [{ model: 'gpt-6-astra' }], models: [{ id: 'ignored' }] })` deep-equals `[{ id: 'gpt-6-astra' }]`; also assert `{ models: [...], items: [...] }` still prefers `models`.
   - `it('takes the id from model before id and slug')` — `{ data: [{ model: ' m ', id: 'i', slug: 's' }] }` → `[{ id: 'm' }]`.
   - `it('reads reasoningEffort objects in supportedReasoningEfforts')` — `{ data: [{ model: 'm', supportedReasoningEfforts: [{ reasoningEffort: 'low', description: 'x' }, { reasoningEffort: ' high ' }, { reasoningEffort: '' }, { reasoningEffort: 'low' }], defaultReasoningEffort: 'low' }] }` → `[{ id: 'm', efforts: ['low', 'high'], defaultEffort: 'low' }]`.
   - `it('codexNextCursor reads nextCursor/next_cursor and nothing else')` — trims, `undefined` for blank, non-string, arrays, non-objects.
   - `it('codexModelListParams sends includeHidden and limit, and cursor only when non-empty')` — `codexModelListParams()` deep-equals `{ includeHidden: true, limit: CODEX_APP_SERVER_MODEL_LIST_PAGE_SIZE }`; `codexModelListParams('c1')` adds `cursor: 'c1'`; `codexModelListParams('')` has no own `cursor` key.

   In the `CodexAdapter.discoverModels` describe block (reusing the existing `fakeAppServer` / `happyScript` / `parsedWrites` helpers):
   - FIX the existing happy-path assertion at test/adapter.codex.test.ts:1237: the third written message's `params` becomes `codexModelListParams()` (i.e. `{ includeHidden: true, limit: CODEX_APP_SERVER_MODEL_LIST_PAGE_SIZE }`), not `{}`.
   - `it('follows nextCursor across pages, concatenating and de-duplicating the ids')` — a script that answers id 2 with `{ data: [{ model: 'a' }, { model: 'b' }], nextCursor: 'c1' }`, id 3 with `{ data: [{ model: 'b' }, { model: 'c' }], nextCursor: '' }`; assert `caps.models` is `['a','b','c']` and that `parsedWrites(fake)` holds exactly four messages, the fourth being `{ jsonrpc: '2.0', id: CODEX_APP_SERVER_MODEL_LIST_ID + 1, method: CODEX_APP_SERVER_MODEL_LIST_METHOD, params: codexModelListParams('c1') }`.
   - `it('a failed follow-up page settles with the pages already received')` — id 2 replies `{ data: [{ model: 'a' }], nextCursor: 'c1' }`, id 3 replies an `error`; assert `caps.models` deep-equals `['a']` and a non-empty reason was logged.
   - `it('a timed-out follow-up page settles with the pages already received')` — same first page, then no reply for id 3, with `ctx({ timeoutMs: 40 })`; assert `['a']` and that the child was killed.
   - `it('an early exit after one page settles with that page, and before any page resolves undefined')` — two sub-cases over the same shape.
   - `it('a repeated cursor and the page cap both end pagination')` — a script that always answers with the SAME `nextCursor`; assert the number of model/list writes equals `CODEX_APP_SERVER_MODEL_LIST_MAX_PAGES` at most (with a repeated cursor: exactly one follow-up is never sent, so exactly one model/list write), and the promise settles with the collected ids rather than hanging.
   - `it('keeps a hidden model in the list')` — a page item `{ model: 'internal-x', hidden: true }` still appears in `caps.models`.
   Every existing test in both describe blocks must keep passing unchanged apart from the line-1237 params fix.

   Files: `test/adapter.codex.test.ts`

5. Correct the README codex discovery bullet

   In README.md, under `#### Agent Model & Effort Discovery (CLI Probing & Architecture)` → **Sources**, rewrite the `codex` bullet (currently README.md:782-786) to state: `codex app-server` over stdio JSON-RPC (`initialize` → `initialized` → `model/list`, JSONL framed); `model/list` is sent with `includeHidden: true` and a `limit`, and a non-empty `nextCursor` is followed within the same timebox so a paged catalogue arrives whole; the reply is read from `result.data` (or `models`/`items`), each model's id from its `model` field, and each model's `supportedReasoningEfforts` (string or `{ reasoningEffort }` elements) becomes its effort list, whose union becomes the agent's effort dropdown. Note that a failed or timed-out follow-up page keeps the pages already received, while a first-page failure keeps the previous list and marks it stale. Change nothing else in the section (the claude / opencode / antigravity bullets belong to later todos).

   Files: `README.md`

## Risks

- The existing happy-path handshake assertion (test/adapter.codex.test.ts:1237) pins `params: {}` for model/list and WILL fail until it is updated to `codexModelListParams()`; it is the only place in src/ or test/ that pins those params, so nothing else breaks.
- Switching the id precedence to `model` before `id` changes behaviour for an item carrying both fields. No current fixture does, but a real app-server reply where `model` is a display-ish string and `id` the launchable slug would regress; the brief pins `model` first, so keep it and rely on the parser tests.
- Matching model/list replies by a mutable `pendingListId` instead of the fixed constant means a duplicated or late reply for an earlier page id is now ignored rather than settling. That is the intended framing, but a server that re-sends page 1 after page 2 was requested would contribute nothing — acceptable, since the page was already collected.
- Pagination runs inside the SINGLE existing wall-clock timebox (min(ctx.timeoutMs, DEFAULT_DISCOVERY_TIMEOUT_MS)); a slow multi-page server can burn the whole budget. Mitigated by settling with the pages already received on timeout, so a partial catalogue still refreshes instead of marking the list stale.
- A server that keeps returning a fresh cursor forever is bounded only by CODEX_APP_SERVER_MODEL_LIST_MAX_PAGES and the timebox; the repeated-cursor guard catches the common degenerate case but not a cursor that changes every page.
- An app-server build that rejects the unknown `includeHidden` / `limit` params with a JSON-RPC error would now fail discovery where `params: {}` succeeded. The failure is safe (undefined → previous list kept, marked stale) but would silently stop refreshing codex; worth a manual `codex app-server` check against the installed CLI during execution.
- Scope discipline: this todo must touch only the codex request/parse path, its tests and the codex README bullet. The claude/opencode/antigravity adapters, src/extension.ts, src/config/configPanel.ts and media/config.js belong to later todos and must not be edited here.

## Acceptance

- `codexModelsFromAppServer({ data: [...] })` parses entries, preferring `data` over `models`/`items`; a bare array and the `models`/`items` shapes still parse; unrecognised payloads still yield `[]` and the parser still never throws or mutates its input.
- An item's id comes from `model` first, then `id`, then `slug`; `{ reasoningEffort }` objects inside `supportedReasoningEfforts` yield effort names (trimmed, blanks dropped, duplicates dropped, order preserved), and `effort`/`id`/`name` elements still work.
- The model/list request carries `includeHidden: true` and `limit: CODEX_APP_SERVER_MODEL_LIST_PAGE_SIZE`; a non-empty `nextCursor` produces a further `model/list` request on the next consecutive id carrying `cursor`, and the pages' entries are concatenated with cross-page id de-duplication (first occurrence wins).
- Pagination stops on an absent/blank cursor, a repeated cursor, or CODEX_APP_SERVER_MODEL_LIST_MAX_PAGES, and never hangs past the timebox.
- A failed, timed-out, exited or closed FOLLOW-UP page resolves the pages already received; a first-page error, timeout, ENOENT, early exit/close, throwing spawner, throwing stdin write, empty list or malformed reply still resolves `undefined` (never the curated list), and discoverModels still never rejects.
- An already-aborted signal still spawns no process and a mid-flight abort still resolves `undefined`; the child is still killed and its stdin ended on every path, and the timeout timer is still cleared and unref'd.
- Capability shaping is unchanged: `capabilitiesFromEntries` with the per-model union of efforts, falling back to `CODEX_EFFORTS` when no model discloses any, and no own `source`/`stale`/`staleReason`/`fetchedAt`/`modelLink` key.
- Launch/attach argv, `codexEffortFlags`, the permission mapping, the ask-relay wiring and the curated `CODEX_MODELS`/`CODEX_EFFORTS` values are untouched.
- `npm run compile`, `npm run lint` and `npm test` all pass; test/adapter.codex.test.ts covers every case listed above.
