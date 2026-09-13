/**
 * Session store properties.
 *
 * For any set of sessions whose transcripts carry arbitrary records:
 *  - `list` returns them ordered by `updatedAt` descending (the newest chat
 *    first), and every listed session is one of the files written;
 *  - every derived title is non-empty and never longer than the title budget,
 *    whatever the first user message looks like (empty, whitespace-only, very
 *    long, multi-line).
 *
 * The sessions are written as real files under `os.tmpdir()`, so the property
 * holds over the actual filesystem behaviour, not a stub.
 */
import * as assert from 'assert';
import * as fc from 'fast-check';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  SessionStore,
  TITLE_MAX_CHARS,
  type SessionScope,
} from '../src/orchestrator/sessionStore';

/** One generated transcript record. */
interface GenRecord {
  ts: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
}

/** An ISO timestamp drawn from a bounded window, so ordering is meaningful. */
const tsArb = fc
  .integer({ min: 0, max: 400 })
  .map((minutes) => new Date(Date.UTC(2026, 0, 1) + minutes * 60_000).toISOString());

const recordArb: fc.Arbitrary<GenRecord> = fc.record({
  ts: tsArb,
  role: fc.constantFrom<GenRecord['role']>('user', 'assistant', 'tool', 'system'),
  content: fc.oneof(
    fc.string({ maxLength: 40 }),
    fc.string({ minLength: 80, maxLength: 300 }),
    fc.constant('   \n\t  '),
    fc.constant(''),
  ),
});

/** A generated session: an id and its records in append (timestamp) order. */
const sessionArb = fc.record({
  id: fc.hexaString({ minLength: 4, maxLength: 10 }).filter((s) => s.length > 0),
  records: fc.array(recordArb, { maxLength: 6 }),
});

describe('SessionStore properties', () => {
  const scope: SessionScope = { kind: 'workspace' };

  it('lists sessions in descending updatedAt order with sane derived titles', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(sessionArb, { selector: (s) => s.id, maxLength: 6 }),
        async (sessions) => {
          const root = mkdtempSync(path.join(os.tmpdir(), 'baiton-session-prop-'));
          try {
            const baitonDir = path.join(root, '.baiton');
            const store = new SessionStore({
              baitonDir,
              specsDir: path.join(baitonDir, 'specs'),
            });
            mkdirSync(store.dirFor(scope), { recursive: true });
            for (const session of sessions) {
              // Records are appended in timestamp order, as the recorder writes them.
              const ordered = [...session.records].sort((a, b) => (a.ts < b.ts ? -1 : 1));
              writeFileSync(
                store.pathFor(scope, session.id),
                ordered.map((r) => `${JSON.stringify(r)}\n`).join(''),
                'utf8',
              );
            }

            const listed = await store.list(scope);

            // Exactly the written sessions are listed.
            assert.deepStrictEqual(
              listed.map((m) => m.id).sort(),
              sessions.map((s) => s.id).sort(),
            );

            // Newest first.
            for (let i = 1; i < listed.length; i++) {
              assert.ok(
                listed[i - 1].updatedAt >= listed[i].updatedAt,
                `expected ${listed[i - 1].updatedAt} >= ${listed[i].updatedAt}`,
              );
            }

            for (const meta of listed) {
              assert.ok(meta.title.length > 0, 'a title is never empty');
              assert.ok(
                meta.title.length <= TITLE_MAX_CHARS,
                `title longer than ${TITLE_MAX_CHARS}: ${meta.title.length}`,
              );
              // createdAt never comes after updatedAt.
              assert.ok(meta.createdAt <= meta.updatedAt);
            }
          } finally {
            rmSync(root, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 40 },
    );
  });
});
