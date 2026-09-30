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

  it('lists a session forest as a contiguous depth-first tree and cascades deletes', async () => {
    const leafArb = fc.uniqueArray(sessionArb, { selector: (s) => s.id, maxLength: 2 });
    const childArb = fc.record({
      ...{ id: sessionArb.map((s) => s.id), records: fc.array(recordArb, { maxLength: 4 }) },
      kids: leafArb,
    });
    const childrenArb = fc.uniqueArray(childArb, { selector: (s) => s.id, maxLength: 3 });
    const rootArb = fc.record({
      id: fc.hexaString({ minLength: 4, maxLength: 10 }),
      records: fc.array(recordArb, { maxLength: 4 }),
      kids: childrenArb,
    });

    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(rootArb, { selector: (s) => s.id, maxLength: 4 }),
        async (roots) => {
          const root = mkdtempSync(path.join(os.tmpdir(), 'baiton-session-tree-'));
          try {
            const baitonDir = path.join(root, '.baiton');
            const store = new SessionStore({ baitonDir, specsDir: path.join(baitonDir, 'specs') });
            const written: string[] = [];
            const write = (id: string, records: GenRecord[]): void => {
              const file = store.pathFor(scope, id);
              mkdirSync(path.dirname(file), { recursive: true });
              const ordered = [...records].sort((a, b) => (a.ts < b.ts ? -1 : 1));
              writeFileSync(file, ordered.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf8');
              written.push(id);
            };
            for (const r of roots) {
              write(r.id, r.records);
              for (const c of r.kids) {
                write(`${r.id}/${c.id}`, c.records);
                for (const g of c.kids) {
                  write(`${r.id}/${c.id}/${g.id}`, g.records);
                }
              }
            }

            const tree = await store.listTree(scope);
            const ids = tree.map((m) => m.id);
            assert.deepStrictEqual([...ids].sort(), [...written].sort());

            tree.forEach((m, i) => {
              const segs = m.id.split('/');
              assert.strictEqual(m.depth, segs.length - 1);
              assert.strictEqual(m.parentId, segs.length > 1 ? segs.slice(0, -1).join('/') : undefined);
              if (m.parentId !== undefined) {
                assert.ok(ids.indexOf(m.parentId) < i, 'parent precedes child');
              }
              // Every entry until the next one at depth <= m.depth is a descendant.
              for (let j = i + 1; j < tree.length && tree[j].depth > m.depth; j++) {
                assert.ok(tree[j].id.startsWith(`${m.id}/`), 'subtree is contiguous');
              }
              // A descendant never appears after the subtree ends.
              const end = tree.findIndex((t, j) => j > i && t.depth <= m.depth);
              const stop = end === -1 ? tree.length : end;
              for (let j = stop; j < tree.length; j++) {
                assert.ok(!tree[j].id.startsWith(`${m.id}/`), 'no stray descendants');
              }
            });

            const top = tree.filter((m) => m.depth === 0);
            assert.deepStrictEqual(top.map((m) => m.id), (await store.list(scope)).map((m) => m.id));
            const sortedDesc = (metas: typeof tree): void => {
              for (let i = 1; i < metas.length; i++) {
                assert.ok(metas[i - 1].updatedAt >= metas[i].updatedAt, 'siblings newest first');
              }
            };
            sortedDesc(top);
            for (const m of tree) {
              sortedDesc(tree.filter((t) => t.parentId === m.id));
            }

            if (written.length > 0) {
              const victim = roots.length > 0 ? written[written.length >> 1] : written[0];
              await store.delete(scope, victim);
              const after = (await store.listTree(scope)).map((m) => m.id);
              assert.deepStrictEqual(
                after,
                ids.filter((id) => id !== victim && !id.startsWith(`${victim}/`)),
              );
            }
          } finally {
            rmSync(root, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 30 },
    );
  });
});
