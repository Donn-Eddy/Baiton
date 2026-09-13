import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import {
  resolveWorkspace,
  WorkspaceFolder,
} from '../src/activation/workspace';
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

/**
 * Unit tests for workspace resolution, the engine-version guard, executable
 * resolution, and packaging gating (Task 15.3).
 *
 * The three activation cores are pure functions with injected seams, so they
 * run without a VS Code host: workspace resolution takes an injected folder
 * list + trust flag, the engine guard takes version strings, and executable
 * resolution takes injected PATH-lookup and settings-override seams. Packaging
 * gating reads the real `package.json` and `LICENSE` at the repo root plus a
 * bounded scan of `node_modules` for native binaries.
 *
 * Coverage:
 * - resolveWorkspace: single-folder (Req 22.3); multi-root one .baiton root
 *   (Req 22.4); zero folders / zero .baiton roots / >1 .baiton roots refuse
 *   (Req 22.5); restricted = !trusted (Req 22.5-22.8, 22.1-22.2).
 * - engineVersionAtLeast: below / at / above 1.96.0, suffix build, unparseable
 *   (Req 23.2, 23.3).
 * - resolveExecutable: PATH hit, override precedence, stale override, no-path
 *   (Req 22.7, 22.8).
 * - Packaging: extensionKind includes "workspace", engines.vscode "^1.106.0",
 *   MIT license in package.json + LICENSE file, zero native modules
 *   (Req 23.1, 23.2, 23.4); an executable-override setting declared for every
 *   AGENT_BINARY id (Req 22.7).
 */

const REPO_ROOT = path.resolve(__dirname, '..');

/** A folder descriptor with an easily-asserted string uri. */
function folder(uri: string, hasBaitonDir: boolean): WorkspaceFolder<string> {
  return { uri, hasBaitonDir };
}

/** Derive `<root>/.baiton` for the injected joiner. */
const makeBaitonDir = (root: string): string => `${root}/.baiton`;

describe('resolveWorkspace (Req 22.3-22.8)', () => {
  it('resolves a single-folder workspace to that folder (Req 22.3)', () => {
    const r = resolveWorkspace([folder('/ws/only', false)], true, makeBaitonDir);
    assert.ok(isOk(r));
    if (isOk(r)) {
      assert.strictEqual(r.value.root, '/ws/only');
      assert.strictEqual(r.value.baitonDir, '/ws/only/.baiton');
      assert.strictEqual(r.value.restricted, false);
    }
  });

  it('resolves a single folder even when it has no .baiton/ (Req 22.3)', () => {
    // Whether the single folder is initialized is the config-load step's
    // concern; resolution still selects it.
    const r = resolveWorkspace([folder('/ws/fresh', false)], true, makeBaitonDir);
    assert.ok(isOk(r));
    if (isOk(r)) {
      assert.strictEqual(r.value.root, '/ws/fresh');
    }
  });

  it('resolves multi-root to the single root containing .baiton/ (Req 22.4)', () => {
    const r = resolveWorkspace(
      [
        folder('/ws/a', false),
        folder('/ws/b', true),
        folder('/ws/c', false),
      ],
      true,
      makeBaitonDir,
    );
    assert.ok(isOk(r));
    if (isOk(r)) {
      assert.strictEqual(r.value.root, '/ws/b');
      assert.strictEqual(r.value.baitonDir, '/ws/b/.baiton');
    }
  });

  it('refuses when no workspace folder is open (Req 22.5)', () => {
    const r = resolveWorkspace([], true, makeBaitonDir);
    assert.ok(isErr(r));
    if (isErr(r)) {
      assert.strictEqual(r.error.kind, 'no-folder');
      assert.match(r.error.message, /\.baiton\/ (directory|root)/);
    }
  });

  it('refuses multi-root with zero .baiton/ roots (Req 22.5)', () => {
    const r = resolveWorkspace(
      [folder('/ws/a', false), folder('/ws/b', false)],
      true,
      makeBaitonDir,
    );
    assert.ok(isErr(r));
    if (isErr(r)) {
      assert.strictEqual(r.error.kind, 'no-baiton-root');
    }
  });

  it('refuses multi-root with more than one .baiton/ root, reporting the count (Req 22.5)', () => {
    const r = resolveWorkspace(
      [
        folder('/ws/a', true),
        folder('/ws/b', false),
        folder('/ws/c', true),
      ],
      true,
      makeBaitonDir,
    );
    assert.ok(isErr(r));
    if (isErr(r)) {
      assert.strictEqual(r.error.kind, 'multiple-baiton-roots');
      if (r.error.kind === 'multiple-baiton-roots') {
        assert.strictEqual(r.error.count, 2);
      }
    }
  });

  it('sets restricted = !trusted on the resolved context (Req 22.1, 22.2, 22.5-22.8)', () => {
    const untrusted = resolveWorkspace([folder('/ws/only', false)], false, makeBaitonDir);
    assert.ok(isOk(untrusted));
    if (isOk(untrusted)) {
      assert.strictEqual(untrusted.value.restricted, true);
    }

    const trusted = resolveWorkspace([folder('/ws/b', true), folder('/ws/a', false)], true, makeBaitonDir);
    assert.ok(isOk(trusted));
    if (isOk(trusted)) {
      assert.strictEqual(trusted.value.restricted, false);
    }
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

  it('contributes the Spec Explorer to the activity bar and the Chat to the secondary side bar', () => {
    const contributes = pkg.contributes as
      | { viewsContainers?: Record<string, { id: string }[]>; views?: Record<string, { id: string }[]> }
      | undefined;
    const containers = contributes?.viewsContainers;
    assert.ok(containers, 'viewsContainers must be present');
    assert.deepStrictEqual(containers.activitybar.map((c) => c.id), ['baiton']);
    assert.deepStrictEqual(containers.secondarySidebar.map((c) => c.id), ['baiton-chat']);

    const views = contributes?.views;
    assert.ok(views, 'views must be present');
    assert.deepStrictEqual(views.baiton.map((v) => v.id), ['baiton.specExplorer']);
    assert.deepStrictEqual(views['baiton-chat'].map((v) => v.id), ['baiton.chatView']);
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
});

/**
 * Bounded scan of `node_modules` for signs of native (compiled binary)
 * dependencies: `.node` binaries or a `binding.gyp` build descriptor. The walk
 * skips nested `node_modules` recursion depth beyond a package's own `build`/
 * `prebuilds` output and caps total visited entries so a runaway tree cannot
 * hang the test. Returns the relative paths of any offending artifacts.
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
        walk(full);
      } else if (entry.isFile()) {
        if (entry.name.endsWith('.node') || entry.name === 'binding.gyp') {
          offenders.push(path.relative(REPO_ROOT, full));
        }
      }
    }
  };

  walk(nodeModules);
  return offenders;
}
