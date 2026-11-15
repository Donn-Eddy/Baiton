/**
 * Session store unit tests.
 *
 * The store is the host-free core behind the Chat_View's per-scope chat
 * sessions: workspace sessions at `.baiton/chat/<id>.jsonl`, plan sessions at
 * `.baiton/plans/<slug>/chat/<id>.jsonl`, with all metadata derived from the
 * transcript files themselves. These run against real directories under
 * `os.tmpdir()`, so the filesystem behaviour is exercised, not mocked.
 */
import * as assert from 'assert';
import { mkdtempSync, mkdirSync, readdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  DEFAULT_TITLE,
  SessionStore,
  TITLE_MAX_CHARS,
  parseScopeId,
  scopeId,
  type SessionScope,
} from '../src/orchestrator/sessionStore';
import { normalizeRepoPath } from '../src/orchestrator/planRepos';

describe('SessionStore', () => {
  const workspace: SessionScope = { kind: 'workspace' };
  const planScope: SessionScope = { kind: 'plan', slug: 'my-plan' };
  const legacyPlanScope: SessionScope = { kind: 'plan', slug: 'my-legacy-plan' };

  /** A fresh temp `.baiton` layout plus a store over it. */
  function newStore(): { store: SessionStore; baitonDir: string; legacySpecsDir: string } {
    const baitonDir = path.join(mkdtempSync(path.join(os.tmpdir(), 'baiton-sessions-')), '.baiton');
    const legacySpecsDir = path.join(baitonDir, 'specs');
    mkdirSync(path.join(baitonDir, 'plans', 'my-plan'), { recursive: true });
    mkdirSync(path.join(legacySpecsDir, 'my-legacy-plan'), { recursive: true });
    writeFileSync(path.join(baitonDir, 'plans', 'my-plan', 'plan.md'), '# PHASES\n', 'utf8');
    writeFileSync(path.join(legacySpecsDir, 'my-legacy-plan', 'spec.md'), '# OVERVIEW\n\n# TODOS\n', 'utf8');
    return { store: new SessionStore({ baitonDir }), baitonDir, legacySpecsDir };
  }

  /** A second repository's `.baiton` with both current and legacy documents. */
  function newChildBaiton(): string {
    const baitonDir = path.join(mkdtempSync(path.join(os.tmpdir(), 'baiton-child-sessions-')), '.baiton');
    mkdirSync(path.join(baitonDir, 'plans', 'my-plan'), { recursive: true });
    mkdirSync(path.join(baitonDir, 'specs', 'legacy-child'), { recursive: true });
    writeFileSync(path.join(baitonDir, 'plans', 'my-plan', 'plan.md'), '# PHASES\n', 'utf8');
    writeFileSync(path.join(baitonDir, 'specs', 'legacy-child', 'spec.md'), '# OVERVIEW\n', 'utf8');
    return baitonDir;
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
    assert.deepStrictEqual(await store.list(planScope), []);
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
    writeSession(store, planScope, 's1', [
      { ts: '2026-09-01T11:00:00.000Z', role: 'user', content: 'plan one' },
    ]);

    assert.deepStrictEqual((await store.list(workspace)).map((m) => m.id), ['w1']);
    assert.deepStrictEqual((await store.list(planScope)).map((m) => m.id), ['s1']);
  });

  it('pathFor places sessions under the scope folder and create allocates an id without a file', () => {
    const { store, baitonDir } = newStore();
    const id = store.create(workspace);

    assert.match(id, /^\d{8}-\d{6}-[0-9a-z]{4}$/);
    assert.strictEqual(store.pathFor(workspace, id), path.join(baitonDir, 'chat', `${id}.jsonl`));
    assert.strictEqual(
      store.pathFor(planScope, 'abc'),
      path.join(baitonDir, 'plans', 'my-plan', 'chat', 'abc.jsonl'),
    );
    // Persistence begins at the first append: nothing was written.
    assert.strictEqual(existsSync(store.pathFor(workspace, id)), false);
  });

  it('routes plan and legacy document sessions to their resolved roots', () => {
    const { store, baitonDir } = newStore();
    assert.strictEqual(store.dirFor(planScope), path.join(baitonDir, 'plans', 'my-plan', 'chat'));
    assert.strictEqual(
      store.dirFor(legacyPlanScope),
      path.join(baitonDir, 'specs', 'my-legacy-plan', 'chat'),
    );
    assert.strictEqual(
      store.legacyPathFor(legacyPlanScope),
      path.join(baitonDir, 'specs', 'my-legacy-plan', 'chat.jsonl'),
    );
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
      assert.strictEqual(await store.migrateLegacy(planScope), undefined);

      const legacy = store.legacyPathFor(planScope);
      mkdirSync(path.dirname(legacy), { recursive: true });
      writeFileSync(
        legacy,
        `${JSON.stringify({ ts: '2026-09-02T08:00:00.000Z', role: 'user', content: 'plan legacy' })}\n`,
        'utf8',
      );

      const first = await store.migrateLegacy(planScope);
      const second = await store.migrateLegacy(planScope);

      assert.ok(first);
      assert.strictEqual(second, undefined);
      assert.deepStrictEqual((await store.list(planScope)).map((m) => m.id), [first]);
    });
  });

  describe('child sessions', () => {
    const rec = (ts: string, content = 'task') => [{ ts, role: 'user', content }];

    it('pathFor nests children and leaves top-level paths unchanged', () => {
      const { store, baitonDir } = newStore();
      assert.strictEqual(
        store.pathFor(workspace, 'p/c'),
        path.join(baitonDir, 'chat', 'p.children', 'c.jsonl'),
      );
      assert.strictEqual(
        store.pathFor(planScope, 'p/c/g'),
        path.join(baitonDir, 'plans', 'my-plan', 'chat', 'p.children', 'c.children', 'g.jsonl'),
      );
      assert.strictEqual(store.pathFor(workspace, 'p'), path.join(baitonDir, 'chat', 'p.jsonl'));
    });

    it('pathFor throws for malformed ids', () => {
      const { store } = newStore();
      for (const bad of ['p//c', '../x', 'p/..', '', 'p/.', 'a\\b']) {
        assert.throws(() => store.pathFor(workspace, bad), /invalid session id/);
      }
    });

    it('createChild allocates a nested id and the children folder, but no transcript', async () => {
      const { store } = newStore();
      const id = await store.createChild(workspace, 'p');
      assert.match(id, /^p\/\d{8}-\d{6}-[0-9a-z]{4}$/);
      assert.strictEqual(existsSync(store.childrenDirFor(workspace, 'p')), true);
      assert.strictEqual(existsSync(store.pathFor(workspace, id)), false);

      const grand = await store.createChild(workspace, id);
      assert.match(grand, /^p\/[^/]+\/[^/]+$/);
      assert.strictEqual((await store.meta(workspace, grand)), undefined);
      await assert.rejects(store.createChild(workspace, '../x'), /invalid session id/);
    });

    it('meta of a child carries parentId and depth; top-level has depth 0 and no parentId', async () => {
      const { store } = newStore();
      writeSession(store, workspace, 'p', rec('2026-09-01T10:00:00.000Z', 'parent'));
      writeSession(store, workspace, 'p/c', rec('2026-09-01T11:00:00.000Z', 'do the child task'));

      const child = await store.meta(workspace, 'p/c');
      assert.strictEqual(child?.title, 'do the child task');
      assert.strictEqual(child?.parentId, 'p');
      assert.strictEqual(child?.depth, 1);

      const top = await store.meta(workspace, 'p');
      assert.strictEqual(top?.depth, 0);
      assert.ok(top && !('parentId' in top));
    });

    it('list returns only top-level sessions when children exist', async () => {
      const { store } = newStore();
      writeSession(store, workspace, 'p', rec('2026-09-01T10:00:00.000Z'));
      writeSession(store, workspace, 'p/c', rec('2026-09-01T11:00:00.000Z'));
      assert.deepStrictEqual((await store.list(workspace)).map((m) => m.id), ['p']);
    });

    it('listChildren returns direct children newest first, excluding grandchildren', async () => {
      const { store } = newStore();
      writeSession(store, workspace, 'p', rec('2026-09-01T10:00:00.000Z'));
      writeSession(store, workspace, 'p/a', rec('2026-09-02T10:00:00.000Z'));
      writeSession(store, workspace, 'p/b', rec('2026-09-03T10:00:00.000Z'));
      writeSession(store, workspace, 'p/a/g', rec('2026-09-04T10:00:00.000Z'));

      assert.deepStrictEqual((await store.listChildren(workspace, 'p')).map((m) => m.id), ['p/b', 'p/a']);
      assert.deepStrictEqual(await store.listChildren(workspace, 'p/b'), []);
    });

    it('listTree is depth-first pre-order with siblings newest first', async () => {
      const { store } = newStore();
      writeSession(store, workspace, 'A', rec('2026-09-10T10:00:00.000Z'));
      writeSession(store, workspace, 'B', rec('2026-09-01T10:00:00.000Z'));
      writeSession(store, workspace, 'A/A1', rec('2026-09-05T10:00:00.000Z'));
      writeSession(store, workspace, 'A/A2', rec('2026-09-06T10:00:00.000Z'));
      writeSession(store, workspace, 'A/A1/A1x', rec('2026-09-07T10:00:00.000Z'));

      const tree = await store.listTree(workspace);
      assert.deepStrictEqual(
        tree.map((m) => m.id),
        ['A', 'A/A2', 'A/A1', 'A/A1/A1x', 'B'],
      );
      assert.deepStrictEqual(tree.map((m) => m.depth), [0, 1, 1, 2, 0]);
      assert.deepStrictEqual(tree.map((m) => m.parentId), [undefined, 'A', 'A', 'A/A1', undefined]);
    });

    it('delete cascades to descendants and leaves relatives alone', async () => {
      const { store } = newStore();
      writeSession(store, workspace, 'A', rec('2026-09-10T10:00:00.000Z'));
      writeSession(store, workspace, 'B', rec('2026-09-01T10:00:00.000Z'));
      writeSession(store, workspace, 'A/A1', rec('2026-09-05T10:00:00.000Z'));
      writeSession(store, workspace, 'A/A2', rec('2026-09-06T10:00:00.000Z'));
      writeSession(store, workspace, 'A/A1/g', rec('2026-09-07T10:00:00.000Z'));

      await store.delete(workspace, 'A/A1');
      assert.deepStrictEqual((await store.listTree(workspace)).map((m) => m.id), ['A', 'A/A2', 'B']);
      await store.delete(workspace, 'A/nope/deeper');

      await store.delete(workspace, 'A');
      assert.strictEqual(existsSync(store.pathFor(workspace, 'A')), false);
      assert.strictEqual(existsSync(store.childrenDirFor(workspace, 'A')), false);
      assert.deepStrictEqual((await store.listTree(workspace)).map((m) => m.id), ['B']);
    });

    it('does not list an orphan children folder', async () => {
      const { store } = newStore();
      writeSession(store, workspace, 'X/c', rec('2026-09-01T10:00:00.000Z'));
      assert.deepStrictEqual(await store.listTree(workspace), []);
    });
  });

  describe('owner-aware session scopes', () => {
    it('keeps owner plan and legacy spec ids and paths compatible', () => {
      const { store, baitonDir } = newStore();
      const planScopes: SessionScope[] = [
        { kind: 'plan', slug: 'my-plan' },
        { kind: 'plan', slug: 'my-plan', repo: '.' },
        { kind: 'plan', slug: 'my-plan', repo: './' },
        { kind: 'plan', slug: 'my-plan', repo: '.', baitonDir },
      ];
      const legacyScopes: SessionScope[] = [
        { kind: 'plan', slug: 'my-legacy-plan' },
        { kind: 'plan', slug: 'my-legacy-plan', repo: '.' },
        { kind: 'plan', slug: 'my-legacy-plan', repo: './' },
        { kind: 'plan', slug: 'my-legacy-plan', repo: '.', baitonDir },
      ];

      for (const scope of planScopes) {
        assert.strictEqual(scopeId(scope), 'my-plan');
        assert.strictEqual(store.dirFor(scope), path.join(baitonDir, 'plans', 'my-plan', 'chat'));
        assert.strictEqual(store.pathFor(scope, 'a'), path.join(baitonDir, 'plans', 'my-plan', 'chat', 'a.jsonl'));
        assert.strictEqual(
          store.childrenDirFor(scope, 'a'),
          path.join(baitonDir, 'plans', 'my-plan', 'chat', 'a.children'),
        );
        assert.strictEqual(store.legacyPathFor(scope), path.join(baitonDir, 'plans', 'my-plan', 'chat.jsonl'));
      }
      for (const scope of legacyScopes) {
        assert.strictEqual(scopeId(scope), 'my-legacy-plan');
        assert.strictEqual(store.dirFor(scope), path.join(baitonDir, 'specs', 'my-legacy-plan', 'chat'));
        assert.strictEqual(store.pathFor(scope, 'a'), path.join(baitonDir, 'specs', 'my-legacy-plan', 'chat', 'a.jsonl'));
        assert.strictEqual(
          store.childrenDirFor(scope, 'a'),
          path.join(baitonDir, 'specs', 'my-legacy-plan', 'chat', 'a.children'),
        );
        assert.strictEqual(store.legacyPathFor(scope), path.join(baitonDir, 'specs', 'my-legacy-plan', 'chat.jsonl'));
      }
    });

    it('qualifies child repo ids and resolves plan and legacy paths in that repo', () => {
      const { store } = newStore();
      const childBaiton = newChildBaiton();
      const childScope: SessionScope = {
        kind: 'plan', slug: 'my-plan', repo: 'packages/child', baitonDir: childBaiton,
      };
      const childLegacyScope: SessionScope = {
        kind: 'plan', slug: 'legacy-child', repo: 'packages/child', baitonDir: childBaiton,
      };
      const id = scopeId(childScope);

      assert.strictEqual(id, 'packages%2Fchild:my-plan');
      assert.ok(!id.includes('/'));
      assert.notStrictEqual(id, 'my-plan');
      assert.strictEqual(store.dirFor(childScope), path.join(childBaiton, 'plans', 'my-plan', 'chat'));
      assert.strictEqual(
        store.pathFor(childScope, 'p/c'),
        path.join(childBaiton, 'plans', 'my-plan', 'chat', 'p.children', 'c.jsonl'),
      );
      assert.strictEqual(store.legacyPathFor(childScope), path.join(childBaiton, 'plans', 'my-plan', 'chat.jsonl'));
      assert.strictEqual(store.dirFor(childLegacyScope), path.join(childBaiton, 'specs', 'legacy-child', 'chat'));
    });

    it('lists and deletes same-slug sessions independently across repos', async () => {
      const { store } = newStore();
      const childBaiton = newChildBaiton();
      const ownerScope: SessionScope = { kind: 'plan', slug: 'my-plan' };
      const childScope: SessionScope = { kind: 'plan', slug: 'my-plan', repo: 'packages/child', baitonDir: childBaiton };
      writeSession(store, ownerScope, 'owner-session', [
        { ts: '2026-09-01T10:00:00.000Z', role: 'user', content: 'owner' },
      ]);
      writeSession(store, childScope, 'child-session', [
        { ts: '2026-09-02T10:00:00.000Z', role: 'user', content: 'child' },
      ]);

      assert.deepStrictEqual((await store.list(ownerScope)).map((m) => m.id), ['owner-session']);
      assert.deepStrictEqual((await store.list(childScope)).map((m) => m.id), ['child-session']);
      await store.delete(ownerScope, 'owner-session');
      assert.deepStrictEqual((await store.list(ownerScope)).map((m) => m.id), []);
      assert.deepStrictEqual((await store.list(childScope)).map((m) => m.id), ['child-session']);
    });

    it("migrates a child's legacy transcript without touching the owner's", async () => {
      const { store, baitonDir } = newStore();
      const childBaiton = newChildBaiton();
      const ownerScope: SessionScope = { kind: 'plan', slug: 'my-plan' };
      const childScope: SessionScope = { kind: 'plan', slug: 'my-plan', repo: 'packages/child', baitonDir: childBaiton };
      const ownerLegacy = store.legacyPathFor(ownerScope);
      const childLegacy = store.legacyPathFor(childScope);
      const ownerText = `${JSON.stringify({ ts: '2026-09-01T10:00:00.000Z', role: 'user', content: 'owner legacy' })}\n`;
      const childText = `${JSON.stringify({ ts: '2026-09-02T10:00:00.000Z', role: 'user', content: 'child legacy' })}\n`;
      writeFileSync(ownerLegacy, ownerText, 'utf8');
      writeFileSync(childLegacy, childText, 'utf8');

      const id = await store.migrateLegacy(childScope);

      assert.strictEqual(id, '20260902-100000-legacy');
      assert.strictEqual(existsSync(childLegacy), false);
      assert.strictEqual(existsSync(store.pathFor(childScope, id)), true);
      assert.strictEqual(existsSync(ownerLegacy), true);
      assert.strictEqual(path.dirname(ownerLegacy), path.join(baitonDir, 'plans', 'my-plan'));
      assert.strictEqual(readFileSync(ownerLegacy, 'utf8'), ownerText);
    });

    it('creates and lists child sessions only inside the child repo', async () => {
      const { store, baitonDir } = newStore();
      const childBaiton = newChildBaiton();
      const ownerScope: SessionScope = { kind: 'plan', slug: 'my-plan' };
      const childScope: SessionScope = { kind: 'plan', slug: 'my-plan', repo: 'packages/child', baitonDir: childBaiton };
      writeSession(store, ownerScope, 'p', [{ ts: '2026-09-01T10:00:00.000Z', role: 'user', content: 'owner parent' }]);
      writeSession(store, childScope, 'p', [{ ts: '2026-09-02T10:00:00.000Z', role: 'user', content: 'child parent' }]);
      const childId = await store.createChild(childScope, 'p');
      writeSession(store, childScope, childId, [{ ts: '2026-09-03T10:00:00.000Z', role: 'user', content: 'child task' }]);

      assert.strictEqual(
        existsSync(path.join(childBaiton, 'plans', 'my-plan', 'chat', 'p.children')),
        true,
      );
      assert.strictEqual(
        existsSync(path.join(baitonDir, 'plans', 'my-plan', 'chat', 'p.children')),
        false,
      );
      assert.deepStrictEqual((await store.listTree(childScope)).map((m) => m.id), ['p', childId]);
      assert.deepStrictEqual((await store.listTree(ownerScope)).map((m) => m.id), ['p']);
    });

    it('requires baitonDir for non-owner repos', () => {
      const { store } = newStore();
      assert.throws(
        () => store.dirFor({ kind: 'plan', slug: 'my-plan', repo: 'packages/child' }),
        /has no baitonDir/,
      );
    });

    it('parses scope ids and rejects malformed qualified ids', () => {
      const scopes: SessionScope[] = [
        { kind: 'workspace' },
        { kind: 'plan', slug: 'my-plan' },
        { kind: 'plan', slug: 'nested', repo: 'packages/child' },
        { kind: 'plan', slug: 'absolute', repo: '/abs/repo' },
      ];
      for (const scope of scopes) {
        assert.deepStrictEqual(parseScopeId(scopeId(scope)), scope.kind === 'plan'
          ? { kind: 'plan', slug: scope.slug, ...(scope.repo === undefined ? {} : { repo: scope.repo }) }
          : { kind: 'workspace' });
      }
      for (const malformed of ['', ':slug', 'repo:', '%E0%A4%A:x']) {
        assert.strictEqual(parseScopeId(malformed), undefined);
      }
    });

    it('normalizes repo paths like planRepos', () => {
      for (const repo of [' packages\\child/../child/ ', '/abs/repo/', 'C:\\repo\\', './', 'foo//bar']) {
        const normalized = normalizeRepoPath(repo) ?? repo;
        const parsed = parseScopeId(scopeId({ kind: 'plan', slug: 'x', repo }));
        if (normalized === '.') {
          assert.deepStrictEqual(parsed, { kind: 'plan', slug: 'x' });
        } else {
          assert.deepStrictEqual(parsed, { kind: 'plan', slug: 'x', repo: normalized });
        }
      }
    });
  });

  it('scopeId names the workspace scope and each plan by slug', () => {
    assert.strictEqual(scopeId(workspace), 'workspace');
    assert.strictEqual(scopeId(planScope), 'my-plan');
  });
});
