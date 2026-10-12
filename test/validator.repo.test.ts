import * as assert from 'assert';
import * as path from 'path';
import { parsePlan, DocumentKind } from '../src/model/parser';
import {
  normalizeRepoHint,
  RepoTopology,
  resolvePhaseRepo,
  validatePlan,
} from '../src/model/validator';

const ROOT_TOPOLOGY: RepoTopology = {
  owner: '.',
  repos: [
    { name: '.', root: path.resolve('/ws') },
    { name: 'packages/api', root: path.resolve('/ws/packages/api'), parent: '.' },
    { name: 'packages/api/sub', root: path.resolve('/ws/packages/api/sub'), parent: 'packages/api' },
    { name: 'packages/web', root: path.resolve('/ws/packages/web'), parent: '.' },
  ],
};

function document(line: string, kind: DocumentKind = 'plan'): { raw: string; parsed: ReturnType<typeof parsePlan> } {
  const raw = kind === 'legacy-spec'
    ? ['# OVERVIEW', 'Overview.', '# TODOS', line].join('\n')
    : ['# PHASES', line].join('\n');
  return { raw, parsed: parsePlan(raw, kind) };
}

function validateLine(line: string, topology?: RepoTopology, kind: DocumentKind = 'plan') {
  const { raw, parsed } = document(line, kind);
  return validatePlan(parsed, raw, topology);
}

describe('repo hint validation', () => {
  it('accepts the owner and discovered descendants', () => {
    for (const hint of ['packages/api', 'packages/api/sub', './packages/api/', '.']) {
      assert.deepStrictEqual(validateLine(`- [pending] P01 Work (repo: ${hint})`, ROOT_TOPOLOGY), []);
    }
  });

  it('reports unknown repositories and plain directories at the phase line', () => {
    for (const hint of ['packages/nope', 'packages']) {
      const errors = validateLine(`- [pending] P01 Work (repo: ${hint})`, ROOT_TOPOLOGY);
      assert.strictEqual(errors.length, 1);
      assert.strictEqual(errors[0].line, 2);
      assert.match(errors[0].reason, /targets unknown repo/);
    }
  });

  it('rejects sibling, ancestor and absolute bindings from a nested owner', () => {
    const topology: RepoTopology = { ...ROOT_TOPOLOGY, owner: 'packages/api' };
    const sibling = validateLine('- [pending] P01 Work (repo: ../web)', topology);
    assert.match(sibling[0].reason, /sibling of the owning repo/);
    const ancestor = validateLine('- [pending] P01 Work (repo: ..)', topology);
    assert.match(ancestor[0].reason, /ancestor of the owning repo/);
    assert.deepStrictEqual(validateLine('- [pending] P01 Work (repo: sub)', topology), []);
    const absolute = validateLine('- [pending] P01 Work (repo: /abs)', topology);
    assert.match(absolute[0].reason, /invalid repo hint/);
  });

  it('only accepts implicit and explicit owner bindings without topology', () => {
    assert.deepStrictEqual(validateLine('- [pending] P01 Work'), []);
    assert.deepStrictEqual(validateLine('- [pending] P01 Work (repo: .)'), []);
    const unknown = validateLine('- [pending] P01 Work (repo: packages/api)');
    assert.strictEqual(unknown.length, 1);
    assert.match(unknown[0].reason, /targets unknown repo/);
  });

  it('flags malformed trailing repo hint groups and uses the legacy todo noun', () => {
    const malformed = validateLine('- [pending] P01 Work (repo: a; repo: b)', ROOT_TOPOLOGY);
    assert.strictEqual(malformed.length, 1);
    assert.match(malformed[0].reason, /malformed repo hint/);
    const legacy = validateLine('- [pending] T01 Work (repo: packages/nope)', ROOT_TOPOLOGY, 'legacy-spec');
    assert.match(legacy[0].reason, /^todo /);
  });

  it('normalizes hints and resolves owner, descendant, sibling and ancestor details', () => {
    assert.strictEqual(normalizeRepoHint(' ./packages\\api/ '), 'packages/api');
    assert.strictEqual(normalizeRepoHint('C:\\repo'), undefined);
    assert.deepStrictEqual(resolvePhaseRepo(undefined, ROOT_TOPOLOGY), {
      ok: true, target: '.', isOwner: true,
    });
    assert.deepStrictEqual(resolvePhaseRepo('./packages/api/', ROOT_TOPOLOGY), {
      ok: true, target: 'packages/api', isOwner: false,
    });
    const nestedOwner: RepoTopology = { ...ROOT_TOPOLOGY, owner: 'packages/api' };
    assert.deepStrictEqual(resolvePhaseRepo('..', nestedOwner), {
      ok: false, reason: 'ancestor', target: '.',
    });
    assert.deepStrictEqual(resolvePhaseRepo('../web', nestedOwner), {
      ok: false, reason: 'sibling', target: 'packages/web',
    });
  });
});
