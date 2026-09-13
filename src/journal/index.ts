/**
 * Run journal (`runs.jsonl`) read/write (Requirements 21.1, 21.2).
 *
 * Append a start record when a stage begins and a completion record when it
 * finishes, then parse the file back into merged {@link JournalEntry} values.
 */
export * from './entry';
export * from './journal';
