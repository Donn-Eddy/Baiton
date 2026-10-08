# Plan T07

## Steps

1. Define the nested session-id scheme and helpers

   In src/orchestrator/sessionStore.ts add a child-id scheme where a nested id encodes its ancestry, so the existing sync `pathFor(scope, id)` / `meta` / `delete` signatures keep working for any depth. Export `export const CHILD_ID_SEPARATOR = '/';` and `export const CHILDREN_SUFFIX = '.children';`. A top-level id is a single segment (what `create` already returns, which never contains '/'); a child id is `<parentId>/<leaf>`; a grandchild is `<root>/<child leaf>/<leaf>`. Add exported pure helpers: `sessionIdSegments(id: string): string[]` (split on CHILD_ID_SEPARATOR; throws `Error('invalid session id: ' + id)` when any segment is empty, '.', '..', or contains a path separator '\\' — guards against path traversal), `parentIdOf(id: string): string | undefined` (all segments but the last joined with '/', undefined for a single segment), and `sessionDepth(id: string): number` (segments.length - 1; 0 for top-level). Update the module doc comment to describe the layout: children at `<scope dir>/<parentId>.children/<leaf>.jsonl`, grandchildren at `<scope dir>/<root>.children/<child>.children/<leaf>.jsonl`, still no index file, and a child's title deriving from its first `user` record (the task the parent gave it).

   Files: `src/orchestrator/sessionStore.ts`

2. Extend SessionMeta with parentId and depth

   Add to `SessionMeta`: `/** The parent session's id for a sub-agent chat; absent for a top-level session. */ parentId?: string;` and `/** Nesting depth: 0 for a top-level session, 1 for a child, 2 for a grandchild. */ depth: number;`. Change the private `metaFor(file, id)` to set `depth: sessionDepth(id)` and, only when `parentIdOf(id)` is defined, `parentId` (do not emit the key as `undefined` for top-level sessions, so existing deepStrictEqual-style comparisons of top-level metas stay clean — build the object and conditionally assign). `list(scope)` is unchanged in behaviour: it still lists only top-level `*.jsonl` files (the `<id>.children` directories are skipped because they don't end in `.jsonl`), and each returned meta now carries `depth: 0`. Check `src/activation/chatController.ts` `toSessionItems` still compiles (it only reads id/title/updatedAt — no change needed there in this todo).

   Files: `src/orchestrator/sessionStore.ts`

3. Nested pathFor, childrenDirFor, ensureDir

   Rewrite `pathFor(scope, id)` as: `const segs = sessionIdSegments(id); let dir = this.dirFor(scope); for (const seg of segs.slice(0, -1)) dir = path.join(dir, seg + CHILDREN_SUFFIX); return path.join(dir, segs[segs.length - 1] + '.jsonl');` — top-level ids produce exactly the old path. Add `public childrenDirFor(scope, id): string` returning the folder holding `id`'s direct children: `path.join(path.dirname(this.pathFor(scope, id)), leaf + CHILDREN_SUFFIX)` where leaf is the last segment. Give `ensureDir` an optional second parameter `ensureDir(scope, id?: string)`: with no id it keeps creating `dirFor(scope)`; with an id it `mkdir(path.dirname(this.pathFor(scope, id)), { recursive: true })` (ChatTranscript's appendFile does not create folders, so this is what makes a child's first append succeed).

   Files: `src/orchestrator/sessionStore.ts`

4. createChild

   Add `public async createChild(scope: SessionScope, parentId: string): Promise<string>`: validate parentId via `sessionIdSegments(parentId)` (throws on a malformed id), allocate a leaf with the existing `this.create(scope)` logic (timestamp + 4-char random suffix), form `const id = parentId + CHILD_ID_SEPARATOR + leaf`, `await this.ensureDir(scope, id)` (creates `<parent>.children/`), and return id. Like `create`, it writes no transcript file — persistence begins at the child's first append. The store does NOT enforce the sub-agent depth cap (MAX_SUBAGENT_DEPTH lives with the runner in a later todo); it supports any depth. Document both points in the JSDoc.

   Files: `src/orchestrator/sessionStore.ts`

5. listChildren and listTree

   Factor the directory scan out of `list` into a private `async listIn(dir: string, idPrefix: string | undefined): Promise<SessionMeta[]>` that readdirs `dir` (ENOENT → []), keeps entries ending `.jsonl` with a non-empty basename, builds id = idPrefix === undefined ? leaf : `${idPrefix}/${leaf}`, calls `metaFor(path.join(dir, name), id)`, and sorts with the existing comparator (updatedAt desc, ties id desc) extracted into a module-level `compareNewestFirst(a, b)`. `list(scope)` becomes `this.listIn(this.dirFor(scope), undefined)`. Add `public async listChildren(scope, parentId): Promise<SessionMeta[]>` = `this.listIn(this.childrenDirFor(scope, parentId), parentId)` — direct children only, newest first, [] when the folder is missing. Add `public async listTree(scope): Promise<SessionMeta[]>`: for each meta of `list(scope)` push it, then recursively (depth-first, pre-order) push each child from `listChildren` followed by that child's own descendants. Children folders whose parent has no transcript file (orphans) are not listed. Also ignore a `.children` entry in readdir that is a file rather than a directory (the scan only picks `.jsonl` names, so this is automatic).

   Files: `src/orchestrator/sessionStore.ts`

6. meta and cascading delete for nested ids

   `meta(scope, id)` needs no logic change beyond using the new pathFor — confirm it returns parentId/depth for a nested id and undefined when the child has no file. Change `delete(scope, id)`: keep the ENOENT-tolerant `unlink(this.pathFor(scope, id))`, then `await rm(this.childrenDirFor(scope, id), { recursive: true, force: true })` (import `rm` from 'fs/promises') so deleting a session removes all its descendants; deleting a child leaves its parent and siblings untouched; deleting an id with no file and no children folder is still a clean no-op. After deleting a nested session, do not remove the (possibly now empty) parent `.children` folder — an empty folder lists as no children.

   Files: `src/orchestrator/sessionStore.ts`

7. Unit tests

   Add a `describe('child sessions', ...)` block to test/sessionStore.test.ts using the existing `newStore`/`writeSession` helpers (writeSession already mkdirs dirname(pathFor), so it works for nested ids). Cases: (1) pathFor nests: `store.pathFor(workspace, 'p/c')` === `path.join(baitonDir, 'chat', 'p.children', 'c.jsonl')` and `pathFor(spec, 'p/c/g')` === `path.join(specsDir, 'my-spec', 'chat', 'p.children', 'c.children', 'g.jsonl')`; top-level unchanged. (2) pathFor throws for 'p//c', '../x', 'p/..' . (3) createChild returns `<parent>/<leaf>` with leaf matching `/^\d{8}-\d{6}-[0-9a-z]{4}$/`, creates the `p.children` folder but no transcript file; createChild on a child id yields depth-2 id. (4) meta of a child: title from its first user record, parentId === 'p', depth 1; top-level meta has depth 0 and `parentId` undefined (`!('parentId' in meta)`). (5) list(scope) still returns only top-level sessions when children exist. (6) listChildren returns direct children newest first, excludes grandchildren, [] for a session without children. (7) listTree order: two parents A (newer) and B, A with children A1, A2 and A1 with grandchild A1x → ids `[A, A?, ..., B]` exactly depth-first pre-order with children newest first, and depths/parentIds correct. (8) delete cascades: deleting A removes A.jsonl and the whole A.children folder, B untouched; deleting child 'A/A1' removes A1 and A1.children but keeps A and A2; deleting a nonexistent nested id is a no-op. (9) an orphan `X.children/` folder with no `X.jsonl` is not listed by listTree.

   Files: `test/sessionStore.test.ts`

8. Property test for the tree

   Add a second `it` to test/sessionStore.property.test.ts: generate a forest with fast-check — `fc.uniqueArray` of top-level sessions (reuse `sessionArb`, maxLength 4), each with `fc.uniqueArray(sessionArb, {selector: s => s.id, maxLength: 3})` children, each child with up to 2 grandchildren (unique ids per sibling set). Write every transcript via `mkdirSync(path.dirname(store.pathFor(scope, fullId)), {recursive: true})` + writeFileSync (records sorted by ts, as in the existing property). Assert over `listTree(scope)`: (a) the set of listed ids equals the set written; (b) each entry's depth === number of '/' in its id and parentId === its id minus the last segment (undefined at depth 0); (c) every non-root entry's parent appears earlier and each subtree is contiguous (all entries after a node until the next entry with depth <= node.depth are its descendants); (d) the depth-0 entries appear in updatedAt-descending order and equal `list(scope)` ids; (e) sibling groups are updatedAt-descending. Then pick one generated id (if any) with `fc` or the first top-level, `delete` it, and assert listTree now equals the previous list minus exactly that id and its descendants (by id prefix `id + '/'`). Use `numRuns: 30` and the same tmpdir/rmSync cleanup pattern.

   Files: `test/sessionStore.property.test.ts`

9. Verify

   Run `npm run compile`, `npm run lint`, and `npm test`; all must pass, including the untouched existing SessionStore tests and the chatController tests that consume SessionMeta. Confirm with a grep that no `vscode` import was added to src/orchestrator/sessionStore.ts.

   Files: (none)

## Risks

- Using '/' as the id separator: session ids flow into the webview (`selectSession`, `deleteSession`, `setActiveSession`) and persisted active-session settings as opaque strings; '/' is safe there, but any code that builds a filename from a session id without pathFor would break — only pathFor/ChatTranscript(pathFor) do today, so keep it that way.
- Adding the required `depth` field to SessionMeta could break any other code or test that constructs SessionMeta literals; grep for `SessionMeta` (chatController.ts imports it) and for object literals typed as it, and add `depth: 0` where needed.
- Top-level metas must not carry an explicit `parentId: undefined` key, or deepStrictEqual assertions elsewhere may fail; assign parentId conditionally.
- pathFor now throws on malformed ids ('..', empty segments); a caller passing an unvalidated id from the webview would get an exception instead of a bad path — this is the intended traversal guard, but callers in later todos should validate or catch.
- A `.children` folder created by createChild before the child's first append leaves an empty folder if the spawn fails; it lists as no children and is removed with the parent's delete, so it is harmless.
- Property test runtime: nested temp trees with many files per run; keep numRuns ~30 and sizes small to stay under mocha's timeout (set `this.timeout` if the suite uses one).

## Acceptance

- SessionMeta has `parentId?: string` and `depth: number`; list/meta/listChildren/listTree populate them (depth 0 and no parentId for top-level).
- `pathFor(scope, 'p/c')` resolves to `<scope dir>/p.children/c.jsonl` and `pathFor(scope, 'p/c/g')` to `<scope dir>/p.children/c.children/g.jsonl`; top-level paths are unchanged; malformed ids throw.
- `createChild(scope, parentId)` returns `<parentId>/<timestamp-suffix>`, creates the children folder, writes no transcript.
- `list(scope)` still returns only top-level sessions; `listChildren` returns direct children newest first; `listTree` returns top-level sessions newest first each followed by its descendants depth-first.
- `delete(scope, id)` removes the session file and its entire `<id>.children` folder, leaves parents and siblings untouched, and is a no-op for a missing session.
- New unit tests in test/sessionStore.test.ts and a tree property test in test/sessionStore.property.test.ts pass alongside all existing tests.
- `npm run compile`, `npm run lint` and `npm test` are green; src/orchestrator/sessionStore.ts has no vscode import.
