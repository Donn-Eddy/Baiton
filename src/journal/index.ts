/**
 * Run journal (`runs.jsonl`) read/write (Requirements 21.1, 21.2). A spec has
 * a spec-level journal plus per-todo `todos/<id>/runs.jsonl` files, read back
 * together with {@link readSpecJournal}.
 *
 * Append a start record when a stage begins and a completion record when it
 * finishes, then parse the file back into merged {@link JournalEntry} values.
 */
export * from './entry';
export * from './journal';
