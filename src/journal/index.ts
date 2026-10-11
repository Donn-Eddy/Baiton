/**
 * Run journal (`runs.jsonl`) read/write (Requirements 21.1, 21.2). A plan has
 * a document-level journal plus per-phase journals in `phases/<id>/`; Legacy
 * Legacy documents keep `todos/<id>/`. All files are read together with
 * {@link readPlanJournal}.
 *
 * Append a start record when a stage begins and a completion record when it
 * finishes, then parse the file back into merged {@link JournalEntry} values.
 */
export * from './entry';
export * from './journal';
