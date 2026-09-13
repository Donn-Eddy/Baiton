/**
 * Session store unit tests.
 *
 * The store is the host-free core behind the Chat_View's per-scope chat
 * sessions: workspace sessions at `.baiton/chat/<id>.jsonl`, spec sessions at
 * `.baiton/specs/<slug>/chat/<id>.jsonl`, with all metadata derived from the
 * transcript files themselves. These run against real directories under
 * `os.tmpdir()`, so the filesystem behaviour is exercised, not mocked.
 */
import * as assert from 'assert';
import { mkdtempSync, mkdirSync, readdirSync, existsSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DEFAULT_TITLE,
  SessionStore,
  TITLE_MAX_CHARS,
  scopeId,
  type SessionScope,
} from '../src/orchestrator/sessionStore';

describe('SessionStore', () => {
  const workspace: SessionScope = { kind: 'workspace' };
  const spec: SessionScope = { kind: 'spec', slug: 'my-spec' };

  /** A fresh temp `.baiton` layout plus a store over it. */
  function newStore(): { store: SessionStore; baitonDir: string; specsDir: string } {
    const baitonDir = path.join(mkdtempSync(path.join(os.tmpdir(), 'baiton-sessions-')), '.baiton');
    const specsDir = path.join(baitonDir, 'specs');
    mkdirSync(specsDir, { recursive: true });
    return { store: new SessionStore({ baitonDir, specsDir }), baitonDir, specsDir };
  }

  /** Write a session transcript file directly, with one record per entry. */
  function writeSession(
    store: SessionStore,
    scope: SessionScope,
    id: string,
    records: { ts: string; role: string; content: string }[],
  ): string {
    const file = store.pathFor(scope, id);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, records.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf8');
    return file;
  }

  it('lists nothing when the scope has no session folder', async () => {
    const { store } = newStore();
    assert.deepStrictEqual(await store.list(workspace), []);
    assert.deepStrictEqual(await store.list(spec), []);
  });

  it('lists sessions newest first by updatedAt', async () => {
    const { store } = newStore();
    writeSession(store, workspace, 'old', [
      { ts: '2026-09-01T10:00:00.000Z', role: 'user', content: 'oldest' },
      { ts: '2026-09-01T10:05:00.000Z', role: 'assistant', content: 'ok' },
    ]);
    writeSession(store, workspace, 'newest', [
      { ts: '2026-09-10T08:00:00.000Z', role: 'user', content: 'latest' },
    ]);
    writeSession(store, workspace, 'middle', [
      { ts: '2026-09-05T08:00:00.000Z', role: 'user', content: 'middling' },
    ]);

    const listed = await store.list(workspace);
    assert.deepStrictEqual(
      listed.map((m) => m.id),
      ['newest', 'middle', 'old'],
    );
    assert.strictEqual(listed[2].createdAt, '2026-09-01T10:00:00.000Z');
    assert.strictEqual(listed[2].updatedAt, '2026-09-01T10:05:00.000Z');
    assert.strictEqual(listed[0].title, 'latest');
  });

  it("keeps each scope's sessions separate", async () => {
    const { store } = newStore();
    writeSession(store, workspace, 'w1', [
      { ts: '2026-09-01T10:00:00.000Z', role: 'user', content: 'workspace one' },
    ]);
    writeSession(store, spec, 's1', [
      { ts: '2026-09-01T11:00:00.000Z', role: 'user', content: 'spec one' },
    ]);

    assert.deepStrictEqual((await store.list(workspace)).map((m) => m.id), ['w1']);
    assert.deepStrictEqual((await store.list(spec)).map((m) => m.id), ['s1']);
  });

  it('pathFor places sessions under the scope folder and create allocates an id without a file', () => {
    const { store, baitonDir, specsDir } = newStore();
    const id = store.create(workspace);

    assert.match(id, /^\d{8}-\d{6}-[0-9a-z]{4}$/);
    assert.strictEqual(store.pathFor(workspace, id), path.join(baitonDir, 'chat', `${id}.jsonl`));
    assert.strictEqual(
      store.pathFor(spec, 'abc'),
      path.join(specsDir, 'my-spec', 'chat', 'abc.jsonl'),
    );
    // Persistence begins at the first append: nothing was written.
    assert.strictEqual(existsSync(store.pathFor(workspace, id)), false);
  });

  it('create allocates distinct ids', () => {
    const { store } = newStore();
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      ids.add(store.create(workspace));
    }
    // Collisions are possible in principle within one second; require variety.
    assert.ok(ids.size > 1, 'expected the random suffix to vary');
  });

  it('delete removes exactly one session file', async () => {
    const { store } = newStore();
    writeSession(store, workspace, 'a', [{ ts: '2026-09-01T10:00:00.000Z', role: 'user', content: 'a' }]);
    writeSession(store, workspace, 'b', [{ ts: '2026-09-02T10:00:00.000Z', role: 'user', content: 'b' }]);

    await store.delete(workspace, 'a');

    assert.deepStrictEqual(readdirSync(store.dirFor(workspace)).sort(), ['b.jsonl']);
    // Deleting a session with no file is a clean no-op.
    await store.delete(workspace, 'never-existed');
    assert.deepStrictEqual(readdirSync(store.dirFor(workspace)).sort(), ['b.jsonl']);
  });

  it('meta reads one session and returns undefined for a session with no file', async () => {
    const { store } = newStore();
    writeSession(store, workspace, 'a', [
      { ts: '2026-09-01T10:00:00.000Z', role: 'user', content: 'hello there' },
    ]);

    const meta = await store.meta(workspace, 'a');
    assert.strictEqual(meta?.title, 'hello there');
    assert.strictEqual(await store.meta(workspace, 'nope'), undefined);
  });

  describe('title derivation', () => {
    it('uses the first user record, whitespace-collapsed', async () => {
      const { store } = newStore();
      writeSession(store, workspace, 'a', [
        { ts: '2026-09-01T10:00:00.000Z', role: 'system', content: 'a note' },
        { ts: '2026-09-01T10:01:00.000Z', role: 'user', content: '  add\n\tthe   login   flow \n' },
        { ts: '2026-09-01T10:02:00.000Z', role: 'user', content: 'second message' },
      ]);

      const meta = await store.meta(workspace, 'a');
      assert.strictEqual(meta?.title, 'add the login flow');
    });

    it('truncates a long first message to the title budget', async () => {
      const { store } = newStore();
      writeSession(store, workspace, 'a', [
        { ts: '2026-09-01T10:00:00.000Z', role: 'user', content: 'x'.repeat(300) },
      ]);

      const meta = await store.meta(workspace, 'a');
      assert.strictEqual(meta?.title.length, TITLE_MAX_CHARS);
      assert.ok(meta?.title.endsWith('…'));
    });

    it('falls back to the default title with no usable user record', async () => {
      const { store } = newStore();
      writeSession(store, workspace, 'a', [
        { ts: '2026-09-01T10:00:00.000Z', role: 'user', content: '   ' },
        { ts: '2026-09-01T10:01:00.000Z', role: 'assistant', content: 'hello' },
      ]);

      const meta = await store.meta(workspace, 'a');
      assert.strictEqual(meta?.title, DEFAULT_TITLE);
    });

    it('falls back to the file mtime for an empty transcript', async () => {
      const { store } = newStore();
      writeSession(store, workspace, 'a', []);

      const listed = await store.list(workspace);
      assert.strictEqual(listed.length, 1);
      assert.strictEqual(listed[0].title, DEFAULT_TITLE);
      assert.ok(!Number.isNaN(Date.parse(listed[0].updatedAt)));
      assert.strictEqual(listed[0].createdAt, listed[0].updatedAt);
    });

    it('skips unparseable lines when deriving metadata', async () => {
      const { store } = newStore();
      const file = store.pathFor(workspace, 'a');
      mkdirSync(path.dirname(file), { recursive: true });
      writeFileSync(
        file,
        [
          'not json at all',
          JSON.stringify({ ts: '2026-09-01T10:00:00.000Z', role: 'user', content: 'real one' }),
          '',
        ].join('\n'),
        'utf8',
      );

      const meta = await store.meta(workspace, 'a');
      assert.strictEqual(meta?.title, 'real one');
      assert.strictEqual(meta?.createdAt, '2026-09-01T10:00:00.000Z');
    });
  });

  describe('migrateLegacy', () => {
    it('moves a non-empty legacy transcript into the session folder', async () => {
      const { store } = newStore();
      const legacy = store.legacyPathFor(workspace);
      mkdirSync(path.dirname(legacy), { recursive: true });
      writeFileSync(
        legacy,
        `${JSON.stringify({ ts: '2026-09-01T10:00:00.000Z', role: 'user', content: 'legacy chat' })}\n`,
        'utf8',
      );

      const id = await store.migrateLegacy(workspace);

      assert.ok(id, 'expected a migrated session id');
      assert.strictEqual(existsSync(legacy), false);
      const listed = await store.list(workspace);
      assert.deepStrictEqual(listed.map((m) => m.id), [id]);
      assert.strictEqual(listed[0].title, 'legacy chat');
    });

    it('removes an empty legacy transcript without creating a session', async () => {
      const { store } = newStore();
      const legacy = store.legacyPathFor(workspace);
      mkdirSync(path.dirname(legacy), { recursive: true });
      writeFileSync(legacy, '', 'utf8');

      const id = await store.migrateLegacy(workspace);

      assert.strictEqual(id, undefined);
      assert.strictEqual(existsSync(legacy), false);
      assert.deepStrictEqual(await store.list(workspace), []);
    });

    it('is a no-op when there is no legacy transcript, and idempotent on a second run', async () => {
      const { store } = newStore();
      assert.strictEqual(await store.migrateLegacy(spec), undefined);

      const legacy = store.legacyPathFor(spec);
      mkdirSync(path.dirname(legacy), { recursive: true });
      writeFileSync(
        legacy,
        `${JSON.stringify({ ts: '2026-09-02T08:00:00.000Z', role: 'user', content: 'spec legacy' })}\n`,
        'utf8',
      );

      const first = await store.migrateLegacy(spec);
      const second = await store.migrateLegacy(spec);

      assert.ok(first);
      assert.strictEqual(second, undefined);
      assert.deepStrictEqual((await store.list(spec)).map((m) => m.id), [first]);
    });
  });

  it('scopeId names the workspace scope and each spec by slug', () => {
    assert.strictEqual(scopeId(workspace), 'workspace');
    assert.strictEqual(scopeId(spec), 'my-spec');
  });
});
