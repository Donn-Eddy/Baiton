import * as assert from 'assert';
import * as os from 'os';
import * as path from 'path';
import * as fsp from 'fs/promises';
import * as fc from 'fast-check';
import { GuardContext } from '../src/orchestrator/guard';

/**
 * Property test for the guard's path containment
 * (Requirements 8.1, 8.2, 9.2, 9.3; design "Orchestrator: tool registry and
 * guard").
 *
 * Feature: baiton-first-pass, Property 10: Orchestrator path containment
 *
 * For any target path:
 *
 * - a mutating tool call is permitted (`resolveMutatingPath` returns `ok`) iff
 *   the fully symlink-resolved path lies under `.baiton/specs/` (Req 8.1, 8.2);
 * - a read tool call is rejected (`resolveReadPath` returns `!ok`, performing no
 *   read) iff the symlink-resolved path escapes the repository root
 *   (Req 9.2, 9.3).
 *
 * The test builds a real temporary repository on disk with a
 * `.baiton/specs/` subtree, plus areas inside the repo but outside specs, and a
 * sibling directory outside the repo entirely. It generates target paths across
 * four families:
 *
 *   1. inside `.baiton/specs/` (possibly not-yet-existing, for a create);
 *   2. inside the repo but outside `.baiton/specs/`;
 *   3. outside the repo root;
 *   4. via symlinks — including a symlink that lives inside the repo but points
 *      outside it, whose resolution must escape and therefore be rejected.
 *
 * Because the guard's own containment logic is what's under test, the oracle is
 * computed independently: it symlink-resolves the target the same way the
 * production code does (nearest-existing-ancestor `realpath`, then re-join the
 * missing tail) and then applies a plain lexical within-check. Both helpers are
 * re-derived here rather than imported so the test does not merely restate the
 * implementation.
 */

/** Whether `child` lies at or under `parent`, both absolute and normalized. */
function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Independently resolve a target the way the guard does: `realpath` the whole
 * path when it exists, otherwise walk up to the nearest existing ancestor,
 * `realpath` that, and re-join the not-yet-existing tail. This collapses any
 * symlinked ancestor while permitting a not-yet-created leaf.
 */
async function oracleResolve(target: string): Promise<string> {
  const absolute = path.resolve(target);
  try {
    return await fsp.realpath(absolute);
  } catch {
    let existing = path.dirname(absolute);
    const tail: string[] = [path.basename(absolute)];
    while (existing !== path.dirname(existing)) {
      try {
        const realExisting = await fsp.realpath(existing);
        return path.join(realExisting, ...tail.reverse());
      } catch {
        tail.push(path.basename(existing));
        existing = path.dirname(existing);
      }
    }
    return absolute;
  }
}

interface Fixture {
  /** Symlink-resolved repository root (temp dirs on macOS live under /var -> /private/var). */
  repoRoot: string;
  specsDir: string;
  /** A directory outside the repo root entirely. */
  outsideDir: string;
  /** A symlink inside the repo that points at `outsideDir` (escapes on resolve). */
  escapingLink: string;
  /** A symlink inside .baiton/specs that points at a real dir under specs. */
  specsInternalLink: string;
  cleanup: () => Promise<void>;
}

/**
 * Build a real on-disk repo with:
 *   <root>/.baiton/specs/<slug>/spec.md         (a real spec tree)
 *   <root>/.baiton/specs/link-to-slug -> <slug>  (symlink staying under specs)
 *   <root>/src/index.ts                          (in-repo, outside specs)
 *   <root>/escape -> <outsideDir>                (in-repo symlink escaping root)
 *   <sibling outside root>/secret.txt            (outside the repo)
 *
 * Roots are `realpath`-ed so the harness compares against the same canonical
 * paths the guard resolves to (temp roots are themselves symlinked on some OSes).
 */
async function makeFixture(): Promise<Fixture> {
  const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'baiton-pathcontain-'));
  const realBase = await fsp.realpath(base);

  const repoRoot = path.join(realBase, 'repo');
  const specsDir = path.join(repoRoot, '.baiton', 'specs');
  const slugDir = path.join(specsDir, 'my-spec');
  await fsp.mkdir(slugDir, { recursive: true });
  await fsp.writeFile(path.join(slugDir, 'spec.md'), '# OVERVIEW\n', 'utf8');

  await fsp.mkdir(path.join(repoRoot, 'src'), { recursive: true });
  await fsp.writeFile(path.join(repoRoot, 'src', 'index.ts'), 'export {};\n', 'utf8');

  // A directory that lives outside the repository root.
  const outsideDir = path.join(realBase, 'outside');
  await fsp.mkdir(outsideDir, { recursive: true });
  await fsp.writeFile(path.join(outsideDir, 'secret.txt'), 'secret\n', 'utf8');

  // A symlink inside the repo that points outside it — resolving it escapes.
  const escapingLink = path.join(repoRoot, 'escape');
  await fsp.symlink(outsideDir, escapingLink, 'dir');

  // A symlink under .baiton/specs pointing at a real dir still under specs.
  const specsInternalLink = path.join(specsDir, 'link-to-slug');
  await fsp.symlink(slugDir, specsInternalLink, 'dir');

  return {
    repoRoot,
    specsDir,
    outsideDir,
    escapingLink,
    specsInternalLink,
    cleanup: () => fsp.rm(realBase, { recursive: true, force: true }),
  };
}

describe('Guard path containment (property harness)', function () {
  // Symlink + realpath work touches disk; give the suite room under load.
  this.timeout(120000);

  let fx: Fixture;
  let ctx: GuardContext;

  before(async () => {
    fx = await makeFixture();
    ctx = new GuardContext({
      repoRoot: fx.repoRoot,
      specsDir: fx.specsDir,
      restricted: false,
    });
  });

  after(async () => {
    if (fx) {
      await fx.cleanup();
    }
  });

  // Feature: baiton-first-pass, Property 10: Orchestrator path containment
  it('permits a mutating path iff it resolves under .baiton/specs/, and rejects a read path iff it escapes the repo root', async () => {
    /**
     * A generated target path across the four families. Segments are
     * constrained to safe path components; families steer where the target
     * lands relative to specs / repo / outside and whether it traverses a
     * symlink.
     */
    const segmentArb = fc
      .stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-_'.split('')), {
        minLength: 1,
        maxLength: 8,
      })
      .filter((s) => s.length > 0);

    const tailArb = fc.array(segmentArb, { minLength: 0, maxLength: 3 });

    // '..' traversal segments used to try to climb out of a base directory.
    const dotdotArb = fc.integer({ min: 1, max: 4 }).map((n) => Array(n).fill('..'));

    const targetArb: fc.Arbitrary<string> = fc.oneof(
      // 1. Inside .baiton/specs/ (real or not-yet-created leaf).
      tailArb.map((tail) => path.join(fx.specsDir, 'my-spec', ...tail)),
      // 1b. Through the internal specs symlink — still resolves under specs.
      tailArb.map((tail) => path.join(fx.specsInternalLink, ...tail)),
      // 2. Inside the repo but outside specs.
      tailArb.map((tail) => path.join(fx.repoRoot, 'src', ...tail)),
      // 2b. The repo root itself and .baiton (outside specs).
      fc.constantFrom(fx.repoRoot, path.join(fx.repoRoot, '.baiton')),
      // 3. Outside the repo root entirely.
      tailArb.map((tail) => path.join(fx.outsideDir, ...tail)),
      // 3b. Lexical climb out of specs with '..' (must be caught after resolve).
      fc
        .tuple(dotdotArb, tailArb)
        .map(([dots, tail]) => path.join(fx.specsDir, ...dots, ...tail)),
      // 4. Through the escaping symlink — resolution lands outside the repo.
      tailArb.map((tail) => path.join(fx.escapingLink, ...tail)),
    );

    await fc.assert(
      fc.asyncProperty(targetArb, async (target) => {
        // Independent oracle: resolve symlinks the same way, then lexical check.
        const resolved = await oracleResolve(target);
        const underSpecs = isWithin(fx.specsDir, resolved);
        const underRepo = isWithin(fx.repoRoot, resolved);

        // --- Mutating: ok iff resolved path is under .baiton/specs/ (8.1, 8.2).
        const mut = await ctx.resolveMutatingPath(target);
        assert.strictEqual(
          mut.ok,
          underSpecs,
          `resolveMutatingPath ok (${mut.ok}) must equal under-specs (${underSpecs}) for ${target} -> ${resolved}`,
        );
        if (mut.ok) {
          assert.strictEqual(mut.resolved, resolved, 'resolved path must match the oracle');
          assert.ok(isWithin(fx.specsDir, mut.resolved), 'permitted mutating path must lie under specs');
        } else {
          assert.strictEqual(
            mut.error.kind,
            'outside-specs',
            'rejected mutating path must report outside-specs',
          );
        }

        // --- Read: rejected iff resolved path escapes the repo root (9.2, 9.3).
        const rd = await ctx.resolveReadPath(target);
        assert.strictEqual(
          !rd.ok,
          !underRepo,
          `resolveReadPath rejected (${!rd.ok}) must equal escapes-repo (${!underRepo}) for ${target} -> ${resolved}`,
        );
        if (rd.ok) {
          assert.strictEqual(rd.resolved, resolved, 'resolved read path must match the oracle');
          assert.ok(isWithin(fx.repoRoot, rd.resolved), 'permitted read path must lie under the repo root');
        } else {
          assert.strictEqual(
            rd.error.kind,
            'outside-repo',
            'rejected read path must report outside-repo',
          );
        }
      }),
      { numRuns: 200 },
    );
  });

  // Feature: baiton-first-pass, Property 10: Orchestrator path containment
  it('rejects a symlink that escapes the repo root on read (concrete symlink case)', async () => {
    // The in-repo `escape` symlink points at a directory outside the repo; a
    // read through it must be rejected because its resolution escapes the root.
    const throughLink = path.join(fx.escapingLink, 'secret.txt');
    const rd = await ctx.resolveReadPath(throughLink);
    assert.strictEqual(rd.ok, false, 'read through an escaping symlink must be rejected');
    if (!rd.ok) {
      assert.strictEqual(rd.error.kind, 'outside-repo');
    }

    // A mutating call through the same escaping link is likewise outside specs.
    const mut = await ctx.resolveMutatingPath(throughLink);
    assert.strictEqual(mut.ok, false, 'mutating through an escaping symlink must be rejected');
    if (!mut.ok) {
      assert.strictEqual(mut.error.kind, 'outside-specs');
    }

    // The internal specs symlink resolves to a dir still under specs, so a
    // mutating create through it is permitted.
    const throughInternal = path.join(fx.specsInternalLink, 'plan.md');
    const okMut = await ctx.resolveMutatingPath(throughInternal);
    assert.strictEqual(okMut.ok, true, 'mutating under an internal specs symlink must be permitted');
  });

  it('accepts in-repo targets when the workspace root itself is reached through a symlink', async () => {
    // Mirrors ostree hosts where `/home` -> `/var/home`: VS Code reports the
    // symlinked root, while targets realpath to the canonical one. Roots must be
    // resolved the same way or every target looks like an escape.
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'baiton-symroot-'));
    try {
      const real = path.join(base, 'real', 'repo');
      await fsp.mkdir(path.join(real, '.baiton', 'specs'), { recursive: true });
      await fsp.writeFile(path.join(real, '.baiton', 'config.json'), '{}', 'utf8');
      await fsp.symlink(path.join(base, 'real'), path.join(base, 'link'));
      const linkedRoot = path.join(base, 'link', 'repo');

      const linked = new GuardContext({
        repoRoot: linkedRoot,
        specsDir: path.join(linkedRoot, '.baiton', 'specs'),
        restricted: false,
      });
      const mut = await linked.resolveMutatingPath('.baiton/specs/new-spec/spec.md');
      assert.strictEqual(mut.ok, true, 'create under specs must be permitted through a symlinked root');
      const rd = await linked.resolveReadPath('.baiton/config.json');
      assert.strictEqual(rd.ok, true, 'read inside the repo must be permitted through a symlinked root');
      const escape = await linked.resolveReadPath(path.join(base, 'outside.txt'));
      assert.strictEqual(escape.ok, false, 'a path outside the repo must still be rejected');
    } finally {
      await fsp.rm(base, { recursive: true, force: true });
    }
  });
});
