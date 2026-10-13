import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { resolveWorkspace, canonicalizeRoot } from '../src/activation/workspace';
import type { WorkspaceRepos } from '../src/activation/workspace';
import {
  discoverRepos,
  repoByName,
  repoFor,
  isWithinSubtree,
  reposWithBaiton,
  type DiscoveryFs,
} from '../src/activation/repoDiscovery';
import { createGitServiceRegistry } from '../src/git/gitService';
import type { GitWorktreeService } from '../src/git/types';
import {
  engineVersionAtLeast,
  MINIMUM_VSCODE_VERSION,
} from '../src/activation/engineVersion';
import {
  resolveExecutable,
  resolveAgentExecutables,
  ExecutableLookup,
  OverrideGetter,
} from '../src/activation/executable';
import { isErr, isOk } from '../src/model/result';
import { AGENT_BINARY } from '../src/adapter/adapter';
import { createRunPipelineSeam } from '../src/activation/engineFacade';
import type {
  RunPipelineOutcome,
  RunPipelineRequest,
  RunPipelineStart,
} from '../src/engine/runPipeline';
import type { RunManifest } from '../src/engine/runStore';
import {
  DEFAULT_USAGE_REFRESH_INTERVAL_SECONDS,
  MAX_USAGE_REFRESH_INTERVAL_SECONDS,
  MIN_USAGE_REFRESH_INTERVAL_SECONDS,
} from '../src/usage/usageService';

/**
 * Unit tests for repo discovery and workspace resolution, the engine-version
 * guard, executable resolution, and packaging gating.
 *
 * The three activation cores are pure functions with injected seams, so they
 * run without a VS Code host: workspace resolution takes an injected folder
 * list + trust flag, the engine guard takes version strings, and executable
 * resolution takes injected PATH-lookup and settings-override seams. Packaging
 * gating reads the real `package.json` and `LICENSE` at the repo root plus a
 * bounded scan of `node_modules` for native binaries.
 *
 * Coverage:
 * - discoverRepos: nested Git/Baiton repos, gitfiles, skipped state/internal
 *   directories, symlinks, bounds, multi-root naming, and overlapping roots.
 * - repoFor / isWithinSubtree: deepest path owner and parent-chain membership.
 * - resolveWorkspace: single-folder primary, multi-root Baiton selection,
 *   missing roots, and restricted = !trusted.
 * - createGitServiceRegistry: one memoized service per normalized repo root.
 * - canonicalizeRoot: a symlinked root resolves to the real directory; a
 *   missing path falls back to the input; the injected realpath seam is honoured
 *   (including a throwing one); and the regression the helper exists for — a
 *   run-dir path under a symlinked root is contained in the realpath'd root by
 *   the same `path.relative` rule opencode's external-directory check uses.
 * - engineVersionAtLeast: below / at / above 1.96.0, suffix build, unparseable
 *   (Req 23.2, 23.3).
 * - resolveExecutable: PATH hit, override precedence, stale override, no-path
 *   (Req 22.7, 22.8).
 * - Packaging: extensionKind includes "workspace", engines.vscode "^1.106.0",
 *   MIT license in package.json + LICENSE file, zero native modules
 *   (Req 23.1, 23.2, 23.4); an executable-override setting declared for every
 *   AGENT_BINARY id (Req 22.7); baiton.openConfigPanel and baiton.initialize
 *   contributed without commandPalette gating.
 * - createRunPipelineSeam: a started run maps to `started` carrying the
 *   manifest's branch; `composerMode` is read per call and copied onto the
 *   request, with `explicitMode` false when it equals the dispatched mode and
 *   true when it differs; `files` is copied rather than aliased; `reproduction`
 *   is omitted from the request when absent and forwarded when present; a
 *   `busy` refusal maps to `busy` with no reason leaked and every other refusal
 *   kind to `refused` with the error's message; and a rejecting `completed`
 *   promise reaches the injected `report` (naming the run id) without becoming
 *   an unhandled rejection, and is equally safe with no `report` bound.
 * - Config panel live catalog wiring: over `src/extension.ts`'s source text,
 *   the `CatalogStore`/`ModelDiscoveryService` are built before
 *   `registerConfigPanel`, that call passes both live seams
 *   (`getCapabilities` bound to `catalogStore.table()`,
 *   `onDidChangeCapabilities` to `discovery.onDidChange`) while keeping the
 *   static `capabilities` fallback, and `void discovery.refresh()` still
 * follows the registration .
 */

const REPO_ROOT = path.resolve(__dirname, '..');

type FakeDiscoveryFs = DiscoveryFs & { readonly calls: string[] };

/** In-memory directory tree. Intermediate directories are inferred from keys. */
function fakeFs(tree: Record<string, 'dir' | 'file' | 'link'>): FakeDiscoveryFs {
  const entries = new Map(Object.entries(tree).map(([name, kind]) => [path.posix.normalize(name), kind]));
  const calls: string[] = [];
  return {
    calls,
    async readdir(dir: string) {
      const parent = path.posix.normalize(dir);
      calls.push(parent);
      const isKnownDirectory = entries.get(parent) === 'dir'
        || [...entries.keys()].some((candidate) => candidate.startsWith(`${parent.replace(/\/$/, '')}/`));
      if (!isKnownDirectory) {
        throw new Error(`Unknown directory: ${parent}`);
      }
      const children = new Map<string, 'dir' | 'file' | 'other'>();
      for (const [absolutePath, kind] of entries) {
        const relative = path.posix.relative(parent, absolutePath);
        if (!relative || relative === '..' || relative.startsWith('../') || path.posix.isAbsolute(relative)) {
          continue;
        }
        const [name, ...rest] = relative.split('/');
        if (!name) {
          continue;
        }
        if (rest.length > 0) {
          children.set(name, 'dir');
        } else {
          children.set(name, kind === 'link' ? 'other' : kind);
        }
      }
      return [...children].map(([name, kind]) => ({ name, kind }));
    },
  };
}

function nestedMonorepoFs(): FakeDiscoveryFs {
  return fakeFs({
    '/ws': 'dir',
    '/ws/.git': 'dir',
    '/ws/.baiton': 'dir',
    '/ws/packages': 'dir',
    '/ws/packages/api': 'dir',
    '/ws/packages/api/.git': 'dir',
    '/ws/packages/web': 'dir',
    '/ws/packages/web/.git': 'file',
    '/ws/packages/web/.baiton': 'dir',
    '/ws/tools': 'dir',
    '/ws/tools/x': 'dir',
    '/ws/tools/x/.baiton': 'dir',
  });
}

describe('discoverRepos and repo helpers', function () {
  before(function () {
    if (process.platform === 'win32') {
      this.skip();
    }
  });

  it('always records a single folder root, even when it has no markers', async () => {
    const set = await discoverRepos([{ name: 'ws', root: '/ws' }], fakeFs({ '/ws': 'dir' }));
    assert.deepStrictEqual(set.repos, [{
      name: '.', folderName: 'ws', relPath: '', root: '/ws', hasGit: false, children: [],
    }]);
    assert.strictEqual(set.folderRoots[0], set.repos[0]);
    assert.strictEqual(set.truncated, false);
  });

  it('finds nested git and .baiton repos, including a worktree gitfile', async () => {
    const set = await discoverRepos([{ name: 'ws', root: '/ws' }], nestedMonorepoFs());
    assert.deepStrictEqual(set.repos.map((repo) => repo.name), [
      '.', 'packages/api', 'packages/web', 'tools/x',
    ]);
    assert.deepStrictEqual(set.repos.map((repo) => repo.parent), [undefined, '.', '.', '.']);
    assert.deepStrictEqual(set.repos[0].children, ['packages/api', 'packages/web', 'tools/x']);
    assert.deepStrictEqual(set.repos.map((repo) => repo.hasGit), [true, true, true, false]);
    assert.deepStrictEqual(reposWithBaiton(set).map((repo) => repo.name), [
      '.', 'packages/web', 'tools/x',
    ]);
    assert.strictEqual(set.repos[2].baitonDir, '/ws/packages/web/.baiton');
  });

  it('uses the nearest discovered repo as the parent', async () => {
    const set = await discoverRepos([{ name: 'ws', root: '/ws' }], fakeFs({
      '/ws': 'dir', '/ws/a': 'dir', '/ws/a/.git': 'dir',
      '/ws/a/b': 'dir', '/ws/a/b/.git': 'dir',
    }));
    assert.strictEqual(repoByName(set, 'a/b')?.parent, 'a');
    assert.deepStrictEqual(repoByName(set, 'a')?.children, ['a/b']);
  });

  it('skips node_modules, git internals, and all Baiton state directories', async () => {
    const fs = fakeFs({
      '/ws': 'dir',
      '/ws/node_modules': 'dir', '/ws/node_modules/pkg': 'dir', '/ws/node_modules/pkg/.git': 'dir',
      '/ws/.git': 'dir', '/ws/.git/config': 'file',
      '/ws/.baiton': 'dir', '/ws/.baiton/worktrees': 'dir',
      '/ws/.baiton/worktrees/slug': 'dir', '/ws/.baiton/worktrees/slug/P01': 'dir',
      '/ws/.baiton/worktrees/slug/P01/.git': 'file',
      '/ws/actual': 'dir', '/ws/actual/.git': 'dir',
    });
    const set = await discoverRepos([{ name: 'ws', root: '/ws' }], fs);
    assert.deepStrictEqual(set.repos.map((repo) => repo.name), ['.', 'actual']);
    assert.ok(fs.calls.every((dir) =>
      !dir.includes('/node_modules') && !dir.includes('/.git') && !dir.includes('/.baiton'),
    ));
  });

  it('never descends into a symlinked directory', async () => {
    const fs = fakeFs({
      '/ws': 'dir', '/ws/link': 'link', '/ws/real': 'dir', '/ws/real/.git': 'dir',
    });
    const set = await discoverRepos([{ name: 'ws', root: '/ws' }], fs);
    assert.deepStrictEqual(set.repos.map((repo) => repo.name), ['.', 'real']);
    assert.ok(!fs.calls.includes('/ws/link'));
  });

  it('honors depth and entry bounds and reports whether discovery was cut short', async () => {
    const tree = {
      '/ws': 'dir' as const,
      '/ws/a': 'dir' as const,
      '/ws/a/.git': 'dir' as const,
      '/ws/a/b': 'dir' as const,
      '/ws/a/b/.git': 'dir' as const,
    };
    const boundedDepth = await discoverRepos(
      [{ name: 'ws', root: '/ws' }], fakeFs(tree), { maxDepth: 1 },
    );
    assert.deepStrictEqual(boundedDepth.repos.map((repo) => repo.name), ['.', 'a']);
    assert.strictEqual(boundedDepth.truncated, true);

    const boundedEntries = await discoverRepos(
      [{ name: 'ws', root: '/ws' }], fakeFs(tree), { maxEntries: 1 },
    );
    assert.strictEqual(boundedEntries.truncated, true);

    const unbounded = await discoverRepos([{ name: 'ws', root: '/ws' }], fakeFs(tree));
    assert.strictEqual(unbounded.truncated, false);
  });

  it('names multiple roots, suffixes duplicate folder names, and deduplicates overlap', async () => {
    const twoRoots = await discoverRepos([
      { name: 'api', root: '/w/api' }, { name: 'web', root: '/w/web' },
    ], fakeFs({
      '/w/api': 'dir', '/w/web': 'dir', '/w/web/libs': 'dir',
      '/w/web/libs/ui': 'dir', '/w/web/libs/ui/.git': 'dir',
    }));
    assert.deepStrictEqual(twoRoots.repos.map((repo) => repo.name), ['api', 'web', 'web/libs/ui']);

    const duplicateNames = await discoverRepos([
      { name: 'same', root: '/w/one' }, { name: 'same', root: '/w/two' },
    ], fakeFs({
      '/w/one': 'dir', '/w/two': 'dir', '/w/two/nested': 'dir',
      '/w/two/nested/.git': 'dir',
    }));
    assert.deepStrictEqual(duplicateNames.repos.map((repo) => repo.name), [
      'same', 'same~1', 'same~1/nested',
    ]);

    const overlap = await discoverRepos([
      { name: 'ws', root: '/ws' }, { name: 'api', root: '/ws/packages/api' },
    ], fakeFs({
      '/ws': 'dir', '/ws/packages': 'dir', '/ws/packages/api': 'dir',
      '/ws/packages/api/.git': 'dir',
    }));
    assert.strictEqual(overlap.folderRoots.length, 2);
    assert.strictEqual(overlap.repos.length, 2);
    assert.strictEqual(overlap.folderRoots[1].name, 'ws/packages/api');
  });

  it('resolves the deepest path repo and walks subtree membership by parent names', async () => {
    const set = await discoverRepos([{ name: 'ws', root: '/ws' }], nestedMonorepoFs());
    assert.strictEqual(repoFor(set, '/ws/packages/api/src/index.ts')?.name, 'packages/api');
    assert.strictEqual(repoFor(set, '/ws/.baiton/worktrees/run/P01/file')?.name, '.');
    assert.strictEqual(repoFor(set, '/ws')?.name, '.');
    assert.strictEqual(repoFor(set, '/elsewhere/file'), undefined);
    assert.strictEqual(repoByName(set, 'packages/api')?.root, '/ws/packages/api');
    assert.strictEqual(isWithinSubtree(set, '.', 'packages/api'), true);
    assert.strictEqual(isWithinSubtree(set, 'packages/api', 'packages/api'), true);
    assert.strictEqual(isWithinSubtree(set, 'packages/api', 'packages/web'), false);
    assert.strictEqual(isWithinSubtree(set, 'packages/api', '.'), false);
    assert.strictEqual(isWithinSubtree(set, 'unknown', 'packages/api'), false);
  });
});

describe('resolveWorkspace (Req 22.3-22.8)', function () {
  before(function () {
    if (process.platform === 'win32') {
      this.skip();
    }
  });

  const toUri = (fsPath: string): string => fsPath;
  const discover = (folders: readonly { name: string; root: string }[], tree: Record<string, 'dir' | 'file' | 'link'>) =>
    discoverRepos(folders, fakeFs(tree));

  it('returns no-folder when there are no workspace folders', async () => {
    const repos = await discover([], {});
    const r = resolveWorkspace(repos, true, toUri);
    assert.ok(isErr(r));
    if (isErr(r)) {
      assert.strictEqual(r.error.kind, 'no-folder');
      assert.match(r.error.message, /\.baiton\/ directory/);
    }
  });

  it('keeps a single uninitialized folder as primary and derives its baiton path', async () => {
    const repos = await discover([{ name: 'fresh', root: '/ws/fresh' }], { '/ws/fresh': 'dir' });
    const r = resolveWorkspace(repos, true, toUri);
    assert.ok(isOk(r));
    if (isOk(r)) {
      assert.strictEqual(r.value.primary.root, '/ws/fresh');
      assert.strictEqual(r.value.primary.baitonDir, '/ws/fresh/.baiton');
    }
  });

  it('keeps the single folder primary even when only a child has .baiton/', async () => {
    const repos = await discover([{ name: 'ws', root: '/ws' }], {
      '/ws': 'dir', '/ws/child': 'dir', '/ws/child/.baiton': 'dir',
    });
    const r = resolveWorkspace(repos, true, toUri);
    assert.ok(isOk(r));
    if (isOk(r)) {
      assert.strictEqual(r.value.primary.repo.name, '.');
      assert.strictEqual(r.value.primary.root, '/ws');
    }
  });

  it('selects the first .baiton folder root when multiple roots are initialized', async () => {
    const repos = await discover([
      { name: 'a', root: '/ws/a' }, { name: 'b', root: '/ws/b' },
    ], { '/ws/a': 'dir', '/ws/a/.baiton': 'dir', '/ws/b': 'dir', '/ws/b/.baiton': 'dir' });
    const r = resolveWorkspace(repos, true, toUri);
    assert.ok(isOk(r));
    if (isOk(r)) {
      assert.strictEqual(r.value.primary.root, '/ws/a');
    }
  });

  it('selects the only initialized folder root in a multi-root workspace', async () => {
    const repos = await discover([
      { name: 'a', root: '/ws/a' }, { name: 'b', root: '/ws/b' },
    ], { '/ws/a': 'dir', '/ws/b': 'dir', '/ws/b/.baiton': 'dir' });
    const r = resolveWorkspace(repos, true, toUri);
    assert.ok(isOk(r));
    if (isOk(r)) {
      assert.strictEqual(r.value.primary.root, '/ws/b');
    }
  });

  it('accepts several .baiton roots and prefers their first folder root', async () => {
    const repos = await discover([
      { name: 'a', root: '/ws/a' }, { name: 'b', root: '/ws/b' },
    ], { '/ws/a': 'dir', '/ws/a/.baiton': 'dir', '/ws/b': 'dir', '/ws/b/.baiton': 'dir' });
    const r = resolveWorkspace(repos, true, toUri);
    assert.ok(isOk(r));
    if (isOk(r)) {
      assert.strictEqual(r.value.primary.repo.name, 'a');
      assert.strictEqual(r.value.repos, repos);
    }
  });

  it('selects a nested Baiton repo when no folder root has .baiton/', async () => {
    const repos = await discover([
      { name: 'a', root: '/w/a' }, { name: 'b', root: '/w/b' },
    ], {
      '/w/a': 'dir', '/w/b': 'dir', '/w/b/libs': 'dir',
      '/w/b/libs/ui': 'dir', '/w/b/libs/ui/.baiton': 'dir',
    });
    const r = resolveWorkspace(repos, true, toUri);
    assert.ok(isOk(r));
    if (isOk(r)) {
      assert.strictEqual(r.value.primary.repo.name, 'b/libs/ui');
    }
  });

  it('returns no-baiton-root for a multi-root workspace with no .baiton repo', async () => {
    const repos = await discover([
      { name: 'a', root: '/w/a' }, { name: 'b', root: '/w/b' },
    ], { '/w/a': 'dir', '/w/b': 'dir' });
    const r = resolveWorkspace(repos, true, toUri);
    assert.ok(isErr(r));
    if (isErr(r)) {
      assert.strictEqual(r.error.kind, 'no-baiton-root');
      assert.match(r.error.message, /\.baiton\/ directory/);
      assert.match(r.error.message, /Baiton: Initialize/);
    }
  });

  it('carries restricted mode on the workspace set and its primary repo', async () => {
    const repos = await discover([{ name: 'a', root: '/w/a' }], {
      '/w/a': 'dir', '/w/a/.baiton': 'dir',
    });
    const untrusted = resolveWorkspace(repos, false, toUri);
    assert.ok(isOk(untrusted));
    if (isOk(untrusted)) {
      const value: WorkspaceRepos<string> = untrusted.value;
      assert.strictEqual(value.restricted, true);
      assert.strictEqual(value.primary.restricted, true);
    }
    const trusted = resolveWorkspace(repos, true, toUri);
    assert.ok(isOk(trusted));
    if (isOk(trusted)) {
      assert.strictEqual(trusted.value.restricted, false);
      assert.strictEqual(trusted.value.primary.restricted, false);
    }
  });
});

describe('createGitServiceRegistry', () => {
  it('memoizes one service per normalized repo root', () => {
    const calls: string[] = [];
    const makeService = (): GitWorktreeService => ({} as GitWorktreeService);
    const registry = createGitServiceRegistry((root) => {
      calls.push(root);
      return makeService();
    });
    const a = registry.forRepo('/r/a');
    assert.strictEqual(registry.forRepo('/r/a'), a);
    assert.notStrictEqual(registry.forRepo('/r/b'), a);
    assert.strictEqual(registry.forRepo('/r/a/'), a);
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(calls, [path.resolve('/r/a'), path.resolve('/r/b')]);
  });
});

describe('engineVersionAtLeast (Req 23.2, 23.3)', () => {
  it('rejects a version below 1.96.0', () => {
    assert.strictEqual(engineVersionAtLeast('1.95.0', MINIMUM_VSCODE_VERSION), false);
    assert.strictEqual(engineVersionAtLeast('1.89.3', MINIMUM_VSCODE_VERSION), false);
    assert.strictEqual(engineVersionAtLeast('0.99.0', MINIMUM_VSCODE_VERSION), false);
  });

  it('accepts a version equal to 1.96.0', () => {
    assert.strictEqual(engineVersionAtLeast('1.96.0', MINIMUM_VSCODE_VERSION), true);
  });

  it('accepts a version above 1.96.0', () => {
    assert.strictEqual(engineVersionAtLeast('1.96.1', MINIMUM_VSCODE_VERSION), true);
    assert.strictEqual(engineVersionAtLeast('1.97.0', MINIMUM_VSCODE_VERSION), true);
    assert.strictEqual(engineVersionAtLeast('2.0.0', MINIMUM_VSCODE_VERSION), true);
  });

  it('accepts an insiders build suffix such as 1.96.0-insider', () => {
    assert.strictEqual(engineVersionAtLeast('1.96.0-insider', MINIMUM_VSCODE_VERSION), true);
    assert.strictEqual(engineVersionAtLeast('1.97.0-insider', MINIMUM_VSCODE_VERSION), true);
  });

  it('treats an unparseable version as not meeting the minimum', () => {
    assert.strictEqual(engineVersionAtLeast('not-a-version', MINIMUM_VSCODE_VERSION), false);
    assert.strictEqual(engineVersionAtLeast('', MINIMUM_VSCODE_VERSION), false);
  });
});

describe('resolveExecutable (Req 22.7, 22.8)', () => {
  const AGENT = 'claude';
  const EXE = 'claude';

  /** A PATH lookup that resolves the given names to fixed absolute paths. */
  function lookupFrom(table: Record<string, string>): ExecutableLookup {
    return (nameOrPath) => table[nameOrPath];
  }

  /** An override getter returning a fixed value for the agent. */
  function overrideOf(value: string | undefined): OverrideGetter {
    return () => value;
  }

  it('resolves an executable found on PATH when no override is set (Req 22.7)', () => {
    const r = resolveExecutable(
      AGENT,
      EXE,
      lookupFrom({ claude: '/usr/local/bin/claude' }),
      overrideOf(undefined),
    );
    assert.ok(isOk(r));
    if (isOk(r)) {
      assert.strictEqual(r.value.path, '/usr/local/bin/claude');
      assert.strictEqual(r.value.override, false);
    }
  });

  it('prefers a settings override over PATH (Req 22.7)', () => {
    const r = resolveExecutable(
      AGENT,
      EXE,
      lookupFrom({
        claude: '/usr/local/bin/claude',
        '/opt/claude/bin/claude': '/opt/claude/bin/claude',
      }),
      overrideOf('/opt/claude/bin/claude'),
    );
    assert.ok(isOk(r));
    if (isOk(r)) {
      assert.strictEqual(r.value.path, '/opt/claude/bin/claude');
      assert.strictEqual(r.value.override, true);
    }
  });

  it('reports override-missing for a stale override rather than falling through to PATH (Req 22.7, 22.8)', () => {
    const r = resolveExecutable(
      AGENT,
      EXE,
      // PATH would resolve the bare name, but the override must not fall through.
      lookupFrom({ claude: '/usr/local/bin/claude' }),
      overrideOf('/gone/claude'),
    );
    assert.ok(isErr(r));
    if (isErr(r)) {
      assert.strictEqual(r.error.kind, 'override-missing');
      if (r.error.kind === 'override-missing') {
        assert.strictEqual(r.error.overridePath, '/gone/claude');
      }
    }
  });

  it('reports not-on-path when no override is set and PATH misses (Req 22.8)', () => {
    const r = resolveExecutable(
      AGENT,
      EXE,
      lookupFrom({}),
      overrideOf(undefined),
    );
    assert.ok(isErr(r));
    if (isErr(r)) {
      assert.strictEqual(r.error.kind, 'not-on-path');
    }
  });

  it('treats a blank override as unset and searches PATH (Req 22.7)', () => {
    const r = resolveExecutable(
      AGENT,
      EXE,
      lookupFrom({ claude: '/usr/local/bin/claude' }),
      overrideOf('   '),
    );
    assert.ok(isOk(r));
    if (isOk(r)) {
      assert.strictEqual(r.value.override, false);
    }
  });

  it('does not dispatch (returns an error) when a lookup throws', () => {
    const r = resolveExecutable(
      AGENT,
      EXE,
      () => {
        throw new Error('PATH walk failed');
      },
      overrideOf(undefined),
    );
    assert.ok(isErr(r));
    if (isErr(r)) {
      assert.strictEqual(r.error.kind, 'not-on-path');
    }
  });
});

describe('resolveAgentExecutables (Req 22.7, 22.8, 14.5)', () => {
  /** A PATH lookup that resolves the given names to fixed absolute paths. */
  function lookupFrom(table: Record<string, string>): ExecutableLookup {
    return (nameOrPath) => table[nameOrPath];
  }

  /** An override getter reading from a per-agent table. */
  function overrideTable(t: Record<string, string>): OverrideGetter {
    return (agent) => t[agent];
  }

  it('resolves several distinct agents in one call, honouring the antigravity -> agy binary mapping', () => {
    const table = resolveAgentExecutables(
      ['claude', 'antigravity'],
      lookupFrom({ claude: '/usr/local/bin/claude', agy: '/usr/local/bin/agy' }),
      overrideTable({}),
    );
    assert.strictEqual(table.get('claude')?.path, '/usr/local/bin/claude');
    assert.strictEqual(table.get('antigravity')?.path, '/usr/local/bin/agy');
    assert.strictEqual(table.errors.length, 0);
  });

  it('de-duplicates repeated agent ids, preserving first-seen order', () => {
    let claudeLookups = 0;
    const lookup: ExecutableLookup = (nameOrPath) => {
      if (nameOrPath === 'claude') {
        claudeLookups++;
        return '/usr/local/bin/claude';
      }
      if (nameOrPath === 'codex') {
        return '/usr/local/bin/codex';
      }
      return undefined;
    };
    const table = resolveAgentExecutables(['claude', 'claude', 'codex'], lookup, overrideTable({}));
    assert.strictEqual(claudeLookups, 1);
    assert.deepStrictEqual(table.agents, ['claude', 'codex']);
  });

  it('reports partial failure per agent: one missing agent does not fail the rest', () => {
    const table = resolveAgentExecutables(
      ['claude', 'opencode'],
      lookupFrom({ claude: '/usr/local/bin/claude' }),
      overrideTable({}),
    );
    assert.strictEqual(table.get('claude')?.path, '/usr/local/bin/claude');
    assert.strictEqual(table.errorFor('opencode')?.kind, 'not-on-path');
    assert.strictEqual(table.errors.length, 1);
  });

  it('resolves a per-agent override independently of PATH', () => {
    const table = resolveAgentExecutables(
      ['claude', 'codex'],
      lookupFrom({ claude: '/usr/local/bin/claude', '/opt/codex/codex': '/opt/codex/codex' }),
      overrideTable({ codex: '/opt/codex/codex' }),
    );
    assert.strictEqual(table.get('claude')?.override, false);
    assert.strictEqual(table.get('codex')?.path, '/opt/codex/codex');
    assert.strictEqual(table.get('codex')?.override, true);
  });

  it('reports unknown-agent for an id isAgentId rejects, naming the supported ids', () => {
    const table = resolveAgentExecutables(['nope'], lookupFrom({}), overrideTable({}));
    assert.strictEqual(table.get('nope'), undefined);
    const failure = table.errorFor('nope');
    assert.strictEqual(failure?.kind, 'unknown-agent');
    assert.ok(failure?.message.includes('claude'));
    assert.ok(failure?.message.includes('opencode'));
    assert.ok(failure?.message.includes('antigravity'));
    assert.ok(failure?.message.includes('codex'));
  });

  it('returns undefined from both get and errorFor for an agent never asked for', () => {
    const table = resolveAgentExecutables(
      ['claude'],
      lookupFrom({ claude: '/usr/local/bin/claude' }),
      overrideTable({}),
    );
    assert.strictEqual(table.get('codex'), undefined);
    assert.strictEqual(table.errorFor('codex'), undefined);
  });
});

describe('packaging gating (Req 23.1, 23.2, 23.4)', () => {
  let pkg: Record<string, unknown>;

  before(() => {
    const raw = fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8');
    pkg = JSON.parse(raw) as Record<string, unknown>;
  });

  it('declares extensionKind including "workspace"', () => {
    const kind = pkg.extensionKind;
    assert.ok(Array.isArray(kind), 'extensionKind must be an array');
    assert.ok((kind as unknown[]).includes('workspace'));
  });

  it('declares the VS Code engine as "^1.106.0" (Req 23.2)', () => {
    // 1.106 is the release that finalized the `secondarySidebar` view-container
    // location the Baiton Chat container is contributed to.
    const engines = pkg.engines as Record<string, string> | undefined;
    assert.ok(engines, 'engines must be present');
    assert.strictEqual(engines.vscode, '^1.106.0');
  });

  it('contributes the Plan Explorer, the Runs view, the collapsed Usage view and the bottom Configuration section to the activity bar in order and the Chat to the secondary side bar', () => {
    interface ViewContrib {
      id: string;
      name?: string;
      type?: string;
      visibility?: string;
    }
    const contributes = pkg.contributes as
      | {
          viewsContainers?: {
            activitybar?: { id: string }[];
            secondarySidebar?: { id: string }[];
          };
          views?: {
            baiton?: ViewContrib[];
            'baiton-chat'?: ViewContrib[];
          };
        }
      | undefined;
    const containers = contributes?.viewsContainers;
    assert.ok(containers, 'viewsContainers must be present');
    assert.deepStrictEqual(containers.activitybar?.map((c) => c.id), ['baiton']);
    assert.deepStrictEqual(containers.secondarySidebar?.map((c) => c.id), ['baiton-chat']);

    const views = contributes?.views;
    assert.ok(views, 'views must be present');
    assert.deepStrictEqual(
      views.baiton?.map((v) => v.id),
      ['baiton.planExplorer', 'baiton.runsView', 'baiton.usageView', 'baiton.configPanel'],
    );
    const usageView = views.baiton?.find((v) => v.id === 'baiton.usageView');
    assert.strictEqual(usageView?.name, 'Usage');
    assert.strictEqual(usageView?.type, 'webview');
    assert.strictEqual(usageView?.visibility, 'collapsed');
    const configView = views.baiton?.find((v) => v.id === 'baiton.configPanel');
    assert.strictEqual(configView?.type, 'webview');
    assert.strictEqual(configView?.visibility, 'collapsed');
    assert.deepStrictEqual(views['baiton-chat']?.map((v) => v.id), ['baiton.chatView']);
  });


  it('contributes the Plan Explorer metadata and phase command titles without retired wording', () => {
    const contributes = pkg.contributes as {
      views?: { baiton?: { id: string; name?: string }[] };
      commands?: { command: string; title?: string }[];
      menus?: { 'view/item/context'?: { command: string; when?: string }[] };
    };
    const explorer = contributes.views?.baiton?.find((view) => view.id === 'baiton.planExplorer');
    assert.strictEqual(explorer?.name, 'Plan Explorer');

    const expectedTitles: Record<string, string> = {
      'baiton.approve': 'Approve Plan',
      'baiton.plan': 'Plan Phase',
      'baiton.execute': 'Execute Phase',
      'baiton.review': 'Review Phase',
      'baiton.replan': 'Re-plan Phase',
    };
    for (const [command, title] of Object.entries(expectedTitles)) {
      assert.strictEqual(contributes.commands?.find((entry) => entry.command === command)?.title, title);
    }

    const context = contributes.menus?.['view/item/context'] ?? [];
    for (const entry of context.filter((item) => !item.command.startsWith('baiton.runs'))) {
      assert.ok(entry.when?.startsWith('view == baiton.planExplorer'), `${entry.command} is scoped to Plan Explorer`);
    }
    const retiredTerms = [['sp', 'ec'], ['to', 'do']].map((parts) => parts.join(''));
    assert.ok(!new RegExp(`\\b(?:${retiredTerms.join('|')})\\b`, 'i').test(JSON.stringify(pkg)));
  });

  it('declares the MIT license in package.json (Req 23.4)', () => {
    assert.strictEqual(pkg.license, 'MIT');
  });

  it('ships a LICENSE file containing the MIT license text (Req 23.4)', () => {
    const licensePath = path.join(REPO_ROOT, 'LICENSE');
    assert.ok(fs.existsSync(licensePath), 'LICENSE file must exist at the repo root');
    const text = fs.readFileSync(licensePath, 'utf8');
    assert.match(text, /MIT License/);
    assert.match(text, /Permission is hereby granted, free of charge/);
    assert.match(text, /THE SOFTWARE IS PROVIDED "AS IS"/);
  });

  it('declares only the pure-JS runtime dependency ajv (Req 23.1)', () => {
    const deps = (pkg.dependencies as Record<string, string>) ?? {};
    assert.deepStrictEqual(Object.keys(deps).sort(), ['ajv']);
  });

  it('includes zero native (compiled binary) modules under node_modules (Req 23.1)', () => {
    const nativeArtifacts = findNativeArtifacts(
      path.join(REPO_ROOT, 'node_modules'),
    );
    assert.deepStrictEqual(
      nativeArtifacts,
      [],
      `expected no native modules, found: ${nativeArtifacts.join(', ')}`,
    );
  });

  it('declares an executable-override setting for every supported agent id (Req 22.7)', () => {
    type SettingProps = Record<string, { type?: string; default?: unknown }>;
    const contributes = pkg.contributes as { configuration?: { properties?: SettingProps } };
    const props: SettingProps | undefined = contributes.configuration?.properties;
    assert.ok(props, 'contributes.configuration.properties must be present');
    for (const agent of Object.keys(AGENT_BINARY)) {
      const entry: { type?: string; default?: unknown } | undefined = props[`baiton.agents.${agent}.path`];
      assert.ok(entry, `missing baiton.agents.${agent}.path setting`);
      assert.strictEqual(entry.type, 'string');
      assert.strictEqual(entry.default, '');
    }
  });

  it('contributes baiton.usage.refresh as a Usage view title button, not gated in the palette', () => {
    const contributes = pkg.contributes as {
      commands?: { command: string; title: string; category?: string; icon?: string }[];
      menus?: Record<string, { command: string; when?: string; group?: string }[]>;
    };
    const cmd = contributes.commands?.find((c) => c.command === 'baiton.usage.refresh');
    assert.ok(cmd, 'baiton.usage.refresh must be contributed');
    assert.strictEqual(cmd.category, 'Baiton');
    assert.strictEqual(cmd.icon, '$(refresh)');
    const title = contributes.menus?.['view/title']?.find((m) => m.command === 'baiton.usage.refresh');
    assert.ok(title, 'baiton.usage.refresh must be in menus["view/title"]');
    assert.strictEqual(title.when, 'view == baiton.usageView');
    assert.strictEqual(title.group, 'navigation');
    const palette = contributes.menus?.commandPalette ?? [];
    assert.strictEqual(palette.find((m) => m.command === 'baiton.usage.refresh'), undefined);
  });

  it('contributes baiton.usage.refreshIntervalSeconds matching the usage service bounds', () => {
    const props = (pkg.contributes as { configuration: { properties: Record<string, Record<string, unknown>> } })
      .configuration.properties;
    const entry = props['baiton.usage.refreshIntervalSeconds'];
    assert.ok(entry, 'setting must be contributed');
    assert.strictEqual(entry.type, 'integer');
    assert.strictEqual(entry.default, DEFAULT_USAGE_REFRESH_INTERVAL_SECONDS);
    assert.strictEqual(entry.minimum, MIN_USAGE_REFRESH_INTERVAL_SECONDS);
    assert.strictEqual(entry.maximum, MAX_USAGE_REFRESH_INTERVAL_SECONDS);
    assert.deepStrictEqual([entry.default, entry.minimum, entry.maximum], [300, 30, 86400]);
  });

  it('contributes baiton.openConfigPanel without commandPalette gating', () => {
    interface CommandContrib {
      command: string;
      title: string;
      category?: string;
    }
    interface MenuContrib {
      command: string;
      when?: string;
    }
    const contributes = pkg.contributes as {
      commands?: CommandContrib[];
      menus?: { commandPalette?: MenuContrib[] };
    };

    const commands = contributes?.commands ?? [];
    const openConfig = commands.find((c) => c.command === 'baiton.openConfigPanel');
    assert.ok(openConfig, 'baiton.openConfigPanel must be contributed under contributes.commands');
    assert.strictEqual(openConfig.title, 'Open Config Panel');
    assert.strictEqual(openConfig.category, 'Baiton');

    const palette = contributes?.menus?.commandPalette ?? [];
    const openConfigPalette = palette.find((m) => m.command === 'baiton.openConfigPanel');
    assert.strictEqual(
      openConfigPalette,
      undefined,
      'baiton.openConfigPanel must not be in commandPalette (must remain visible when baiton.activated is false)',
    );

    const initPalette = palette.find((m) => m.command === 'baiton.initialize');
    assert.strictEqual(
      initPalette,
      undefined,
      'baiton.initialize must not be in commandPalette (must remain visible when baiton.activated is false)',
    );
  });
});

describe('config panel live catalog wiring ', () => {
  let source = '';
  /** The text of the `registerConfigPanel({ ... })` call, braces balanced. */
  let call = '';

  before(() => {
    source = fs.readFileSync(path.join(REPO_ROOT, 'src', 'extension.ts'), 'utf8');
    const start = source.indexOf('registerConfigPanel({');
    assert.ok(start >= 0, 'src/extension.ts must call registerConfigPanel({...})');
    const open = source.indexOf('{', start);
    let depth = 0;
    let end = -1;
    for (let i = open; i < source.length; i += 1) {
      if (source[i] === '{') depth += 1;
      else if (source[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }
    assert.ok(end > open, 'the registerConfigPanel call must have balanced braces');
    call = source.slice(open, end + 1);
  });

  it('builds the catalog store and discovery service before registering the config panel', () => {
    const store = source.indexOf('new CatalogStore(');
    const discovery = source.indexOf('new ModelDiscoveryService(');
    const register = source.indexOf('registerConfigPanel({');
    assert.ok(store >= 0, 'expected a `new CatalogStore(` construction');
    assert.ok(discovery >= 0, 'expected a `new ModelDiscoveryService(` construction');
    assert.ok(
      store < register,
      'the CatalogStore must be built before registerConfigPanel so the first load() shows the seeded list',
    );
    assert.ok(
      discovery < register,
      'the ModelDiscoveryService must be built before registerConfigPanel so onDidChangeCapabilities can bind to it',
    );
  });

  it('passes getCapabilities bound to the store table', () => {
    assert.match(
      call,
      /getCapabilities:\s*\(\)\s*=>\s*agentCapabilities\(\s*catalogStore\.table\(\)\s*\)/,
      'getCapabilities must re-read catalogStore.table() per call, not a frozen snapshot',
    );
  });

  it('passes onDidChangeCapabilities bound to the discovery service', () => {
    assert.ok(
      call.includes('onDidChangeCapabilities:'),
      'expected onDidChangeCapabilities in the registerConfigPanel call',
    );
    assert.match(
      call,
      /discovery\.onDidChange\(/,
      'onDidChangeCapabilities must subscribe to discovery.onDidChange',
    );
  });

  it('keeps the static capabilities fallback', () => {
    assert.match(
      call,
      /capabilities:\s*agentCapabilities\(\)/,
      'the static capabilities fallback must still be passed',
    );
  });

  it('still kicks the refresh off without awaiting it, after the panel is registered', () => {
    const refresh = source.indexOf('void discovery.refresh()');
    assert.ok(refresh >= 0, 'activate() must kick discovery.refresh() off without awaiting it');
    assert.ok(
      refresh > source.indexOf('registerConfigPanel({'),
      'refresh must run after the panel is registered so the first optionsChanged cannot be lost',
    );
  });
});

/**
 * The containment rule opencode applies before reading a file: a target is
 * inside the project directory iff `path.relative(projectDir, target)` is
 * non-empty, does not start with `..`, and is not absolute. Re-derived here
 * rather than imported so the test pins the external contract Baiton relies on.
 */
function containedUnder(parent: string, target: string): boolean {
  const rel = path.relative(parent, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

describe('canonicalizeRoot', () => {
  // `os.tmpdir()` can itself be a symlink (it is on macOS), so every expectation
  // is written against realpath'd values rather than the raw temp path.
  let base: string | undefined;
  let realRoot: string | undefined;
  let linkRoot: string | undefined;

  before(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-canonroot-'));
    const realDir = path.join(base, 'real');
    fs.mkdirSync(realDir, { recursive: true });
    const link = path.join(base, 'link');
    try {
      fs.symlinkSync(realDir, link, 'dir');
    } catch {
      // Symlink creation can be refused (Windows without developer mode); the
      // symlink-dependent cases skip rather than fail.
      return;
    }
    realRoot = fs.realpathSync.native(realDir);
    linkRoot = link;
  });

  after(() => {
    if (base !== undefined) {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  it('resolves a symlinked root to the real directory', function () {
    if (linkRoot === undefined || realRoot === undefined) {
      this.skip();
      return;
    }
    assert.strictEqual(canonicalizeRoot(linkRoot), realRoot);
  });

  it('falls back to the input when the path does not exist', () => {
    const missing = path.join(os.tmpdir(), 'baiton-definitely-not-here', 'repo');
    assert.strictEqual(canonicalizeRoot(missing), missing);
  });

  it('uses the injected realpath seam', () => {
    assert.strictEqual(canonicalizeRoot('/ws/root', () => '/canonical/root'), '/canonical/root');
  });

  it('falls back to the input when the injected realpath throws', () => {
    const throwing = (): string => {
      throw new Error('ENOENT');
    };
    assert.strictEqual(canonicalizeRoot('/ws/root', throwing), '/ws/root');
  });

  it('makes a run-dir path under a symlinked root contained in the real root (regression)', function () {
    if (linkRoot === undefined || realRoot === undefined) {
      this.skip();
      return;
    }
    const tail = ['.baiton', 'runs', 'r1', 'brief.md'];
    const canonicalBrief = path.join(canonicalizeRoot(linkRoot), ...tail);
    assert.strictEqual(
      containedUnder(realRoot, canonicalBrief),
      true,
      'a brief path under the canonicalized root must be inside the realpath\'d root',
    );

    const rawBrief = path.join(linkRoot, ...tail);
    assert.strictEqual(
      containedUnder(realRoot, rawBrief),
      false,
      'the un-canonicalized brief path must look external, which is the bug this helper fixes',
    );
  });
});

/**
 * Bounded scan of `node_modules` for signs of native (compiled binary)
 * dependencies: `.node` binaries or a `binding.gyp` build descriptor. Only
 * the PRODUCTION packages are scanned — the ones `package-lock.json` does not
 * mark `dev: true`, which is exactly what vsce ships in the vsix — so a dev
 * tool with a native addon (`@vscode/vsce` pulls in `keytar`) does not count.
 * Each package directory is walked without descending into its nested
 * `node_modules` (those packages are separate lockfile entries); with no
 * lockfile the whole tree is walked. Total visited entries are capped so a
 * runaway tree cannot hang the test. Returns the relative paths of any
 * offending artifacts.
 */
function findNativeArtifacts(nodeModules: string): string[] {
  if (!fs.existsSync(nodeModules)) {
    return [];
  }
  const offenders: string[] = [];
  const MAX_ENTRIES = 50000;
  let visited = 0;

  const walk = (dir: string): void => {
    if (visited >= MAX_ENTRIES) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= MAX_ENTRIES) {
        return;
      }
      visited += 1;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!(productionDirs !== undefined && entry.name === 'node_modules')) {
          walk(full);
        }
      } else if (entry.isFile()) {
        if (entry.name.endsWith('.node') || entry.name === 'binding.gyp') {
          offenders.push(path.relative(REPO_ROOT, full));
        }
      }
    }
  };

  const productionDirs = productionPackageDirs(path.dirname(nodeModules));
  if (productionDirs === undefined) {
    walk(nodeModules);
  } else {
    for (const dir of productionDirs) {
      walk(dir);
    }
  }
  return offenders;
}

/**
 * The absolute directories of every non-dev package `package-lock.json`
 * (lockfile v2/v3 `packages` map) lists under `root`, or undefined when there
 * is no readable lockfile.
 */
function productionPackageDirs(root: string): string[] | undefined {
  let lock: { packages?: Record<string, { dev?: boolean }> };
  try {
    lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  } catch {
    return undefined;
  }
  if (lock.packages === undefined) {
    return undefined;
  }
  return Object.entries(lock.packages)
    .filter(([key, meta]) => key.startsWith('node_modules/') && meta.dev !== true)
    .map(([key]) => path.join(root, key));
}

/** A `RunPipeline.start` double that records its request and answers a scripted result. */
function fakePipeline(answer: RunPipelineStart) {
  const requests: RunPipelineRequest[] = [];
  return {
    requests,
    start: async (req: RunPipelineRequest): Promise<RunPipelineStart> => {
      requests.push(req);
      return answer;
    },
  };
}

/**
 * A `{ ok: true }` start result. Only `manifest.branch` is read by the seam, so
 * the manifest is a minimal literal cast rather than a hand-built whole one.
 */
function startedResult(
  runId: string,
  branch: string,
  completed: Promise<RunPipelineOutcome>,
): RunPipelineStart {
  return { ok: true, runId, manifest: { branch } as RunManifest, completed };
}

/** A `completed` promise that never settles, for the cases that ignore it. */
function pendingCompletion(): Promise<RunPipelineOutcome> {
  return new Promise<RunPipelineOutcome>(() => {});
}

describe('createRunPipelineSeam', () => {
  it('maps a started run to started with the manifest branch', async () => {
    const pipeline = fakePipeline(startedResult('bug-1', 'baiton/bug/bug-1', pendingCompletion()));
    const seam = createRunPipelineSeam(pipeline, () => 'bug');

    const outcome = await seam.start({ mode: 'bug', statement: 'crash on save', files: [] });

    assert.deepStrictEqual(outcome, {
      kind: 'started',
      runId: 'bug-1',
      branch: 'baiton/bug/bug-1',
    });
  });

  it('reads composerMode per call and leaves explicitMode false when it matches', async () => {
    const pipeline = fakePipeline(startedResult('bug-1', 'b', pendingCompletion()));
    let reads = 0;
    const seam = createRunPipelineSeam(pipeline, () => {
      reads += 1;
      return 'bug';
    });

    await seam.start({ mode: 'bug', statement: 's', files: [] });
    await seam.start({ mode: 'bug', statement: 's', files: [] });

    assert.strictEqual(reads, 2);
    assert.strictEqual(pipeline.requests.length, 2);
    for (const request of pipeline.requests) {
      assert.strictEqual(request.composerMode, 'bug');
      assert.strictEqual(request.explicitMode, false);
    }
  });

  it('sets explicitMode when the dispatched mode differs from the composer mode', async () => {
    const pipeline = fakePipeline(startedResult('inv-1', 'b', pendingCompletion()));
    const seam = createRunPipelineSeam(pipeline, () => 'bug');

    await seam.start({ mode: 'investigate', statement: 'why?', files: [] });

    const request = pipeline.requests[0];
    assert.strictEqual(request.mode, 'investigate');
    assert.strictEqual(request.composerMode, 'bug');
    assert.strictEqual(request.explicitMode, true);
  });

  it('copies files rather than aliasing the caller array', async () => {
    const pipeline = fakePipeline(startedResult('bug-1', 'b', pendingCompletion()));
    const seam = createRunPipelineSeam(pipeline, () => 'bug');
    const files = ['src/a.ts'];

    await seam.start({ mode: 'bug', statement: 's', files });
    files.push('src/b.ts');

    assert.deepStrictEqual(pipeline.requests[0].files, ['src/a.ts']);
  });

  it('omits reproduction when the caller omits it and forwards it when present', async () => {
    const pipeline = fakePipeline(startedResult('bug-1', 'b', pendingCompletion()));
    const seam = createRunPipelineSeam(pipeline, () => 'bug');

    await seam.start({ mode: 'bug', statement: 's', files: [] });
    assert.strictEqual('reproduction' in pipeline.requests[0], false);

    await seam.start({ mode: 'bug', statement: 's', files: [], reproduction: 'save twice' });
    assert.strictEqual(pipeline.requests[1].reproduction, 'save twice');
  });

  it('maps a busy refusal to busy with no reason leaked', async () => {
    const pipeline = fakePipeline({
      ok: false,
      error: { kind: 'busy', message: 'a stage is already running' },
    });
    const seam = createRunPipelineSeam(pipeline, () => 'bug');

    const outcome = await seam.start({ mode: 'bug', statement: 's', files: [] });

    assert.deepStrictEqual(outcome, { kind: 'busy' });
  });

  it('maps every other refusal kind to refused with the error message', async () => {
    const kinds = ['invalid-mode', 'detached-head', 'no-base-head', 'manifest', 'worktree'] as const;
    for (const kind of kinds) {
      const message = `${kind} went wrong`;
      const pipeline = fakePipeline({ ok: false, error: { kind, message } });
      const seam = createRunPipelineSeam(pipeline, () => 'bug');

      const outcome = await seam.start({ mode: 'bug', statement: 's', files: [] });

      assert.deepStrictEqual(outcome, { kind: 'refused', reason: message }, kind);
    }
  });

  it('swallows a rejecting completed promise and reports it naming the run id', async () => {
    const completed = Promise.reject(new Error('manifest write failed'));
    const pipeline = fakePipeline(startedResult('bug-7', 'b', completed));
    const reported: string[] = [];
    const seam = createRunPipelineSeam(pipeline, () => 'bug', (m) => reported.push(m));

    const outcome = await seam.start({ mode: 'bug', statement: 's', files: [] });
    assert.strictEqual(outcome.kind, 'started');

    await new Promise((r) => setTimeout(r, 0));
    assert.strictEqual(reported.length, 1);
    assert.ok(reported[0].includes('bug-7'), reported[0]);
    assert.ok(reported[0].includes('manifest write failed'), reported[0]);
  });

  it('is safe with no report sink when completed rejects', async () => {
    const completed = Promise.reject(new Error('boom'));
    const pipeline = fakePipeline(startedResult('bug-8', 'b', completed));
    const seam = createRunPipelineSeam(pipeline, () => 'bug');

    const outcome = await seam.start({ mode: 'bug', statement: 's', files: [] });
    assert.strictEqual(outcome.kind, 'started');

    // No unhandled rejection: the seam attached its own catch before resolving.
    await new Promise((r) => setTimeout(r, 0));
  });
});
