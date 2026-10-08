# Execute T03

## Summary

Todo-level journaling now goes to per-todo todos/<id>/runs.jsonl files, and a new merged readSpecJournal reader is used by the engine facade, spec store, View command, CodeLens, spec explorer, submit PR attempt count and crash recovery. Spec-level runs.jsonl is kept for spec-draft, PR and legacy entries. compile, lint and the full test suite pass (2500 passing).

## Files changed

- `src/journal/journal.ts`
- `src/journal/index.ts`
- `src/engine/runQueue.ts`
- `src/engine/recovery.ts`
- `src/engine/submitPr.ts`
- `src/activation/engineFacade.ts`
- `src/activation/specStore.ts`
- `src/activation/commands.ts`
- `src/activation/specExplorer.ts`
- `src/extension.ts`
- `test/journal.roundtrip.property.test.ts`
- `test/engineFacade.resume.test.ts`
- `test/recovery.revert.test.ts`
- `test/specStore.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`

## Notes

- Files outside the todo's declared list were also changed: runQueue.ts (adds optional journalPathFor/readJournal deps), specExplorer.ts, extension.ts and test/specStore.test.ts.
- RecoveryDeps is now a union: either specsDir (merged reader) or journalPath (single file), so the integration test using journalPath is unchanged.
- Per-todo journals are not gitignored (only specs/*/runs.jsonl is), so they get committed with the spec folder; gitignore.ts was left unchanged.
- readSpecJournal does not preserve cross-todo order (spec-level file first, then per-todo files by sorted id). This is documented in its doc comment.
- appendRecord now creates parent directories.
- Lint reports one warning, an unused '_legacy' in src/orchestrator/webviewProtocol.ts, in a file this change did not touch.
