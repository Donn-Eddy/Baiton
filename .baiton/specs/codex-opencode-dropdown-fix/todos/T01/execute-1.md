# Execute T01

## Summary

Fixed codex app-server model discovery. src/adapter/codex.ts now sends model/list with includeHidden: true and limit (new CODEX_APP_SERVER_MODEL_LIST_INCLUDE_HIDDEN / _PAGE_SIZE / _MAX_PAGES constants and the pure codexModelListParams / codexNextCursor helpers), and follows a non-empty nextCursor on consecutive request ids (3, 4, ...) inside the same timebox, stopping on an absent/blank/repeated cursor or at the 20-page cap. The parser reads result.data first (then models, then items), takes each entry's id from `model` before `id`/`slug`, and reads `reasoningEffort` in supportedReasoningEfforts objects. discoverModels accumulates pages with cross-page id de-duplication (first occurrence wins): a failed, timed-out, exited or closed FOLLOW-UP page settles with the pages already received, while a first-page failure, abort, ENOENT, throwing spawner/write, empty list or malformed reply still resolves undefined. Tests and the README codex discovery bullet updated. npm run compile, npm run lint and npm test all pass (2093 passing), and a manual probe against the installed codex-cli 0.157.0 confirms the new request shape and returns 9 real models with per-model efforts.

## Files changed

- `src/adapter/codex.ts`
- `test/adapter.codex.test.ts`
- `README.md`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`
- `codex --version`
- `node /tmp/claude-1000/.../probe.js  (raw codex app-server initialize -> initialized -> model/list with includeHidden+limit)`
- `node /tmp/claude-1000/.../probe2.js (new CodexAdapter().discoverModels against the real installed CLI)`

## Notes

- Manual check of the plan's riskiest assumption: codex-cli 0.157.0 ACCEPTS params {includeHidden: true, limit: 100} (no JSON-RPC error) and answers with result.data[]; each item carries BOTH `model` and `id` holding the same slug, `displayName` as the label, `hidden`, and supportedReasoningEfforts as [{reasoningEffort, description}] objects. The plan's `model`-first id precedence is therefore harmless on the real payload.
- End-to-end against the installed CLI, discoverModels now returns models ['gpt-6-astra','gpt-6-sol','gpt-6-luna','gpt-reserve','gpt-5.6-sol','gpt-5.6-terra','gpt-5.6-luna','gpt-5.5','codex-auto-review'] and the effort union ['low','medium','high','xhigh','max','ultra'] - note 'max' and 'ultra' are real levels the curated CODEX_EFFORTS list does not have.
- The real reply carried no nextCursor for this account's catalogue, so pagination is covered by the new unit tests rather than by a live paged response.
- Test-helper detail: the plan's `pagedScript(pages)` helper is typed `readonly unknown[]` because a TS union with `unknown` collapses to `unknown`; the function-valued page elements are annotated at the call sites instead.
- Repeated-cursor arithmetic: with the SAME cursor on every page, page 1's cursor is unseen so exactly ONE follow-up is sent and page 2's repeat stops pagination - i.e. 2 model/list writes, not 1. The test asserts that exact count plus <= CODEX_APP_SERVER_MODEL_LIST_MAX_PAGES, and a second sub-case with a fresh cursor every page pins the hard cap at exactly CODEX_APP_SERVER_MODEL_LIST_MAX_PAGES writes.
- npm run lint reports one pre-existing warning in src/orchestrator/webviewProtocol.ts:626 ('_legacy' unused), untouched by this todo; 0 errors.
- Scope kept to the codex request/parse path, its tests and the codex README bullet - no changes to the claude/opencode/antigravity adapters, src/extension.ts, src/config/configPanel.ts or media/config.js.
