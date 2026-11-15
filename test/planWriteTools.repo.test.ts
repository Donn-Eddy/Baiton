import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createGitService, type GitService } from '../src/git';
import { parsePlan } from '../src/model/parser';
import { approvalHash, computeInputRev } from '../src/model/hash';
import { validatePlan } from '../src/model/validator';
import { createPlanRepoSeam, formatPlanRef } from '../src/orchestrator/planRepos';
import { GuardContext, type Tool } from '../src/orchestrator/guard';
import type { PlanRepoSeam } from '../src/orchestrator/seams';
import { createPlanWriteTools } from '../src/orchestrator/planWriteTools';
import { singleRepoPlanRepos, type ToolServices } from '../src/orchestrator/toolServices';
import type { Repo, RepoSet } from '../src/activation/repoDiscovery';
import { locationFor } from '../src/storage/documentLocation';

function repo(input: Partial<Repo> & Pick<Repo, 'name' | 'root'>): Repo {
  return { folderName: 'workspace', relPath: input.name, hasGit: false, children: [], ...input };
}

function gitStub(commits: string[]): GitService {
  return { commit: async (message: string) => { commits.push(message); return 'c'.repeat(40); } } as GitService;
}

function documentText(): string {
  return [
    '---', 'version: 1', 'name: sample', 'status: draft', '---', '',
    '# Endstate', '', 'The work is complete.', '',
    '# What needs changing', '', 'Update the code.', '',
    '# Limitations & constraints', '', 'Keep compatibility.', '',
    '# PHASES', '',
    '- [pending] P01 First phase',
    '- [pending] P02 Work',
    '',
  ].join('\n');
}

function writePlan(baitonDir: string, slug: string, content = documentText()): string {
  const file = locationFor(baitonDir, slug, 'plan').documentPath;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, 'utf8');
  return file;
}

function toolByName(tools: Tool[], name: string): Tool {
  const found = tools.find((tool) => tool.name === name);
  assert.ok(found);
  return found;
}

function makeFixture(): {
  root: string;
  ownerRoot: string;
  childRoot: string;
  siblingRoot: string;
  noBaitonRoot: string;
  set: RepoSet;
  planRepos: PlanRepoSeam;
  ownerCommits: string[];
  childCommits: string[];
  siblingCommits: string[];
  services: ToolServices;
  guard: GuardContext;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-planwrite-repos-'));
  const ownerRoot = path.join(root, 'owner');
  const childRoot = path.join(ownerRoot, 'packages', 'api');
  const nestedRoot = path.join(childRoot, 'service');
  const noBaitonRoot = path.join(ownerRoot, 'packages', 'uninitialized');
  const siblingRoot = path.join(root, 'sibling');
  for (const dir of [ownerRoot, childRoot, nestedRoot, noBaitonRoot, siblingRoot]) fs.mkdirSync(dir, { recursive: true });
  const entries = [
    repo({ name: 'workspace', root, children: ['owner', 'sibling'] }),
    repo({ name: 'owner', root: ownerRoot, parent: 'workspace', children: ['api', 'no-baiton'], baitonDir: path.join(ownerRoot, '.baiton') }),
    repo({ name: 'api', root: childRoot, parent: 'owner', children: ['service'], baitonDir: path.join(childRoot, '.baiton') }),
    repo({ name: 'service', root: nestedRoot, parent: 'api' }),
    repo({ name: 'no-baiton', root: noBaitonRoot, parent: 'owner' }),
    repo({ name: 'sibling', root: siblingRoot, parent: 'workspace', baitonDir: path.join(siblingRoot, '.baiton') }),
  ];
  for (const entry of entries) if (entry.baitonDir !== undefined) fs.mkdirSync(entry.baitonDir, { recursive: true });
  const set: RepoSet = { repos: entries, folderRoots: [entries[0]], truncated: false };
  const ownerCommits: string[] = [];
  const childCommits: string[] = [];
  const siblingCommits: string[] = [];
  const ownerGit = gitStub(ownerCommits);
  const childGit = gitStub(childCommits);
  const siblingGit = gitStub(siblingCommits);
  const planRepos = createPlanRepoSeam({
    repos: () => set,
    ownerRoot,
    restricted: () => false,
    gitFor: (repoRoot) => path.resolve(repoRoot) === path.resolve(childRoot)
      ? childGit
      : path.resolve(repoRoot) === path.resolve(siblingRoot) ? siblingGit : ownerGit,
    exists: async (target) => fs.promises.access(target).then(() => true, () => false),
  });
  const services = {
    repoRoot: ownerRoot,
    baitonDir: path.join(ownerRoot, '.baiton'),
    git: ownerGit,
    confirm: { confirm: async () => true },
    runQueue: { dispatch: async () => ({ kind: 'busy' as const }) },
    clock: { now: () => '2026-01-01T00:00:00.000Z' },
    ids: { next: () => 'id-1' },
    gitSettings: { remote: 'origin', base: 'main' },
    planRepos,
  } as unknown as ToolServices;
  return {
    root,
    ownerRoot,
    childRoot,
    siblingRoot,
    noBaitonRoot,
    set,
    planRepos,
    ownerCommits,
    childCommits,
    siblingCommits,
    services,
    guard: new GuardContext({ repoRoot: ownerRoot, baitonDir: path.join(ownerRoot, '.baiton'), restricted: false }),
  };
}

function clean(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

describe('plan-writing tools with repository hints', () => {
  it('keeps the old hintless line and refuses non-owner hints in a single-repo workspace', async () => {
    const fixture = makeFixture();
    try {
      const slug = 'plain';
      const file = writePlan(path.join(fixture.ownerRoot, '.baiton'), slug);
      const services = { ...fixture.services, planRepos: singleRepoPlanRepos(fixture.ownerRoot, fixture.services.git) };
      const add = toolByName(createPlanWriteTools(services), 'add_phase');
      const normal = await add.run({ slug, id: 'P03', title: 'Third phase' }, { callId: 'plain-1', ctx: fixture.guard });
      assert.strictEqual(normal.ok, true);
      assert.ok(fs.readFileSync(file, 'utf8').includes('- [pending] P03 Third phase'));

      const before = fs.readFileSync(file, 'utf8');
      const refused = await add.run({ slug, id: 'P04', title: 'Child phase', repo: 'packages/api' }, { callId: 'plain-2', ctx: fixture.guard });
      assert.deepStrictEqual(refused, { ok: false, error: 'add_phase: repo hints need a workspace with nested repos; omit "repo"' });
      assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
    } finally {
      clean(fixture.root);
    }
  });

  it('renders and parses valid child hints, and refuses sibling, ancestor, unknown and malformed hints without writing', async () => {
    const fixture = makeFixture();
    try {
      const slug = 'hints';
      const file = writePlan(path.join(fixture.ownerRoot, '.baiton'), slug);
      const add = toolByName(createPlanWriteTools(fixture.services), 'add_phase');
      const valid = await add.run({ slug, id: 'P03', title: 'Third phase', after: ['P01'], files: ['src/x.ts'], repo: 'packages/api' }, { callId: 'hint-valid', ctx: fixture.guard });
      assert.strictEqual(valid.ok, true);
      const content = fs.readFileSync(file, 'utf8');
      assert.ok(content.includes('- [pending] P03 Third phase (after P01; files: src/x.ts; repo: packages/api)'));
      const parsed = parsePlan(content);
      assert.strictEqual(parsed.phases[2].repo, 'packages/api');
      const ownerTarget = fixture.planRepos.target('.');
      assert.strictEqual(ownerTarget.ok, true);
      assert.deepStrictEqual(validatePlan(parsed, content, ownerTarget.ok ? ownerTarget.target.topology : undefined), []);

      for (const [index, repoHint] of ['../sibling', '..', 'packages/missing', 'packages/api;repo:other'].entries()) {
        const before = fs.readFileSync(file, 'utf8');
        const commitsBefore = fixture.ownerCommits.length;
        const result = await add.run({ slug, id: `P${String(index + 4).padStart(2, '0')}`, title: 'Refused', repo: repoHint }, { callId: `hint-bad-${index}`, ctx: fixture.guard });
        assert.strictEqual(result.ok, false, `${repoHint} should be refused`);
        assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
        assert.strictEqual(fixture.ownerCommits.length, commitsBefore);
      }
    } finally {
      clean(fixture.root);
    }
  });

  it('preserves an omitted edit hint, clears it with dot, and hashes repo changes', async () => {
    const fixture = makeFixture();
    try {
      const slug = 'edit-hint';
      const file = writePlan(path.join(fixture.ownerRoot, '.baiton'), slug);
      const edit = toolByName(createPlanWriteTools(fixture.services), 'edit_phase');
      const initial = parsePlan(fs.readFileSync(file, 'utf8'));
      const initialApproval = approvalHash(initial);
      const initialInput = computeInputRev(initial, 'P02');

      const added = await edit.run({ slug, id: 'P02', repo: 'packages/api' }, { callId: 'edit-hint-add', ctx: fixture.guard });
      assert.strictEqual(added.ok, true);
      const withHintText = fs.readFileSync(file, 'utf8');
      const withHint = parsePlan(withHintText);
      assert.notStrictEqual(approvalHash(withHint), initialApproval);
      assert.notStrictEqual(computeInputRev(withHint, 'P02'), initialInput);

      const unchanged = await edit.run({ slug, id: 'P02' }, { callId: 'edit-hint-keep', ctx: fixture.guard });
      assert.strictEqual(unchanged.ok, true);
      assert.strictEqual(fs.readFileSync(file, 'utf8'), withHintText);
      const stillHinted = parsePlan(fs.readFileSync(file, 'utf8'));
      assert.strictEqual(approvalHash(stillHinted), approvalHash(withHint));
      assert.strictEqual(computeInputRev(stillHinted, 'P02'), computeInputRev(withHint, 'P02'));

      const cleared = await edit.run({ slug, id: 'P02', repo: '.' }, { callId: 'edit-hint-clear', ctx: fixture.guard });
      assert.strictEqual(cleared.ok, true);
      const finalText = fs.readFileSync(file, 'utf8');
      const finalPlan = parsePlan(finalText);
      assert.ok(!finalText.includes('repo: packages/api'));
      assert.notStrictEqual(approvalHash(finalPlan), approvalHash(withHint));
      assert.notStrictEqual(computeInputRev(finalPlan, 'P02'), computeInputRev(withHint, 'P02'));
      assert.strictEqual(approvalHash(finalPlan), initialApproval);
      assert.strictEqual(computeInputRev(finalPlan, 'P02'), initialInput);
    } finally {
      clean(fixture.root);
    }
  });

  it('edits a child-owned plan through that child guard and commits only in its git repo', async () => {
    const fixture = makeFixture();
    try {
      const parentGit = (root: string): void => {
        execFileSync('git', ['-C', root, 'init', '-q']);
        execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid']);
        execFileSync('git', ['-C', root, 'config', 'user.name', 'Baiton Test']);
      };
      parentGit(fixture.ownerRoot);
      fs.writeFileSync(path.join(fixture.ownerRoot, 'README.md'), 'owner\n');
      execFileSync('git', ['-C', fixture.ownerRoot, 'add', 'README.md']);
      execFileSync('git', ['-C', fixture.ownerRoot, 'commit', '-qm', 'owner baseline']);
      const parentHead = execFileSync('git', ['-C', fixture.ownerRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

      parentGit(fixture.childRoot);
      const childFile = writePlan(path.join(fixture.childRoot, '.baiton'), 'child-only');
      const qualifiedFile = writePlan(path.join(fixture.childRoot, '.baiton'), 'qualified-child');
      execFileSync('git', ['-C', fixture.childRoot, 'add', '.']);
      execFileSync('git', ['-C', fixture.childRoot, 'commit', '-qm', 'child baseline']);

      const actualPlanRepos = createPlanRepoSeam({
        repos: () => fixture.set,
        ownerRoot: fixture.ownerRoot,
        restricted: () => false,
        gitFor: (root) => createGitService(root),
        exists: async (target) => fs.promises.access(target).then(() => true, () => false),
      });
      const services = { ...fixture.services, git: createGitService(fixture.ownerRoot), planRepos: actualPlanRepos };
      const edit = toolByName(createPlanWriteTools(services), 'edit_phase');
      const childGuard = actualPlanRepos.target('packages/api');
      assert.strictEqual(childGuard.ok, true);
      if (!childGuard.ok) return;
      const parentDocument = writePlan(path.join(fixture.ownerRoot, '.baiton'), 'parent-doc');
      assert.strictEqual((await childGuard.target.guard.resolveMutatingPath(parentDocument)).ok, false);

      const result = await edit.run({ slug: 'child-only', plan_repo: 'packages/api', id: 'P02', title: 'Edited in child' }, { callId: 'child-edit', ctx: fixture.guard });
      assert.strictEqual(result.ok, true);
      if (result.ok) {
        const data = result.data as { slug: string; repo: string; id: string; commit: string };
        assert.deepStrictEqual({ slug: data.slug, repo: data.repo, id: data.id }, { slug: 'child-only', repo: 'packages/api', id: 'P02' });
        assert.match(data.commit, /^[a-f0-9]{40}$/);
      }
      assert.ok(fs.readFileSync(childFile, 'utf8').includes('P02 Edited in child'));
      const qualified = await edit.run({ slug: 'packages/api:qualified-child', id: 'P02', title: 'Qualified edit' }, { callId: 'qualified-edit', ctx: fixture.guard });
      assert.strictEqual(qualified.ok, true);
      if (qualified.ok) {
        const data = qualified.data as { slug: string; repo: string; id: string; commit: string };
        assert.deepStrictEqual({ slug: data.slug, repo: data.repo, id: data.id }, { slug: 'qualified-child', repo: 'packages/api', id: 'P02' });
        assert.match(data.commit, /^[a-f0-9]{40}$/);
      }
      assert.ok(fs.readFileSync(qualifiedFile, 'utf8').includes('P02 Qualified edit'));
      const childSubjects = execFileSync('git', ['-C', fixture.childRoot, 'log', '-2', '--format=%s'], { encoding: 'utf8' }).trim().split('\n');
      assert.deepStrictEqual(childSubjects, ['plan(qualified-child): P02 edit P02', 'plan(child-only): P02 edit P02']);
      assert.strictEqual(execFileSync('git', ['-C', fixture.ownerRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), parentHead);
      const conflict = await edit.run({ slug: 'packages/api:child-only', plan_repo: '../sibling', id: 'P02' }, { callId: 'qualified-conflict', ctx: fixture.guard });
      assert.deepStrictEqual(conflict, { ok: false, error: 'plan_repo "../sibling" conflicts with qualified slug "packages/api:child-only"' });
    } finally {
      clean(fixture.root);
    }
  });

  it('refuses a bare slug that collides between the owner and a child with both candidates', async () => {
    const fixture = makeFixture();
    try {
      const ownerFile = writePlan(path.join(fixture.ownerRoot, '.baiton'), 'dup');
      const childFile = writePlan(path.join(fixture.childRoot, '.baiton'), 'dup');
      const ownerBefore = fs.readFileSync(ownerFile, 'utf8');
      const childBefore = fs.readFileSync(childFile, 'utf8');
      const edit = toolByName(createPlanWriteTools(fixture.services), 'edit_phase');
      const result = await edit.run({ slug: 'dup', id: 'P02', title: 'Changed' }, { callId: 'collision', ctx: fixture.guard });
      assert.deepStrictEqual(result, {
        ok: false,
        error: `plan "dup" exists in more than one repo; pass "plan_repo" or use a qualified slug: ${formatPlanRef('.', 'dup')}, ${formatPlanRef('packages/api', 'dup')}`,
      });
      assert.strictEqual(fs.readFileSync(ownerFile, 'utf8'), ownerBefore);
      assert.strictEqual(fs.readFileSync(childFile, 'utf8'), childBefore);
      assert.deepStrictEqual(fixture.ownerCommits, []);
      assert.deepStrictEqual(fixture.childCommits, []);
    } finally {
      clean(fixture.root);
    }
  });

  it('writes and commits a sibling-owned plan in the sibling repo', async () => {
    const fixture = makeFixture();
    try {
      const file = writePlan(path.join(fixture.siblingRoot, '.baiton'), 's');
      const edit = toolByName(createPlanWriteTools(fixture.services), 'edit_phase');
      const result = await edit.run({ slug: '../sibling:s', id: 'P02', title: 'Sibling edit' }, { callId: 'sibling-edit', ctx: fixture.guard });
      assert.strictEqual(result.ok, true);
      if (result.ok) assert.deepStrictEqual(result.data, { slug: 's', repo: '../sibling', id: 'P02', commit: 'c'.repeat(40) });
      assert.ok(fs.readFileSync(file, 'utf8').includes('P02 Sibling edit'));
      assert.deepStrictEqual(fixture.ownerCommits, []);
      assert.deepStrictEqual(fixture.childCommits, []);
      assert.deepStrictEqual(fixture.siblingCommits, ['plan(s): P02 edit P02']);
    } finally {
      clean(fixture.root);
    }
  });

  it('inherits a restricted conversation guard for child writes even when the seam is unrestricted', async () => {
    const fixture = makeFixture();
    try {
      const file = writePlan(path.join(fixture.childRoot, '.baiton'), 'restricted-child');
      const before = fs.readFileSync(file, 'utf8');
      const restricted = new GuardContext({ repoRoot: fixture.ownerRoot, baitonDir: path.join(fixture.ownerRoot, '.baiton'), restricted: true });
      const edit = toolByName(createPlanWriteTools(fixture.services), 'edit_phase');
      const result = await edit.run({ slug: 'restricted-child', plan_repo: 'packages/api', id: 'P02', title: 'Blocked' }, { callId: 'restricted-child-edit', ctx: restricted });
      assert.deepStrictEqual(result, { ok: false, error: 'plan writes are disabled in Restricted Mode' });
      assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
      assert.deepStrictEqual(fixture.childCommits, []);
    } finally {
      clean(fixture.root);
    }
  });

  it('validates child phase repo hints against the child repo topology', async () => {
    const fixture = makeFixture();
    try {
      const file = writePlan(path.join(fixture.childRoot, '.baiton'), 'child-hints');
      const add = toolByName(createPlanWriteTools(fixture.services), 'add_phase');
      const nested = await add.run({ slug: 'child-hints', plan_repo: 'packages/api', id: 'P03', title: 'Nested target', repo: 'service' }, { callId: 'child-nested-hint', ctx: fixture.guard });
      assert.strictEqual(nested.ok, true);
      assert.ok(fs.readFileSync(file, 'utf8').includes('repo: service'));
      const before = fs.readFileSync(file, 'utf8');
      const ancestor = await add.run({ slug: 'child-hints', plan_repo: 'packages/api', id: 'P04', title: 'Owner ancestor', repo: '..' }, { callId: 'child-owner-ancestor', ctx: fixture.guard });
      assert.deepStrictEqual(ancestor, { ok: false, error: 'add_phase: phase "P04" targets repo "owner", which is an ancestor of the owning repo "api"; a phase may only target the owning repo or a repo nested beneath it' });
      assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
    } finally {
      clean(fixture.root);
    }
  });

  it('refuses an ambiguous lookup without writing or committing', async () => {
    const fixture = makeFixture();
    try {
      const file = writePlan(path.join(fixture.childRoot, '.baiton'), 'ambiguous');
      const original = fs.readFileSync(file, 'utf8');
      const ambiguous: PlanRepoSeam = {
        ...fixture.planRepos,
        locate: async () => ({ kind: 'ambiguous', repos: ['packages/api', 'packages/other'] }),
      };
      const services = { ...fixture.services, planRepos: ambiguous };
      const edit = toolByName(createPlanWriteTools(services), 'edit_phase');
      const result = await edit.run({ slug: 'ambiguous', id: 'P02', title: 'Changed' }, { callId: 'ambiguous-edit', ctx: fixture.guard });
      assert.deepStrictEqual(result, { ok: false, error: 'plan "ambiguous" exists in more than one repo; pass "plan_repo" or use a qualified slug: packages/api:ambiguous, packages/other:ambiguous' });
      assert.strictEqual(fs.readFileSync(file, 'utf8'), original);
      assert.deepStrictEqual(fixture.ownerCommits, []);
      assert.deepStrictEqual(fixture.childCommits, []);
    } finally {
      clean(fixture.root);
    }
  });
});
