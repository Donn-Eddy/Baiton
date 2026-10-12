import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createGitService, type GitService } from '../src/git';
import { parsePlan } from '../src/model/parser';
import { approvalHash, computeInputRev } from '../src/model/hash';
import { validatePlan } from '../src/model/validator';
import { createPlanRepoSeam } from '../src/orchestrator/planRepos';
import { GuardContext, type Tool } from '../src/orchestrator/guard';
import type { PlanRepoSeam } from '../src/orchestrator/seams';
import { createPlanWriteTools } from '../src/orchestrator/planWriteTools';
import type { ToolServices } from '../src/orchestrator/toolServices';
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
  services: ToolServices;
  guard: GuardContext;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-planwrite-repos-'));
  const ownerRoot = path.join(root, 'owner');
  const childRoot = path.join(ownerRoot, 'packages', 'api');
  const noBaitonRoot = path.join(ownerRoot, 'packages', 'uninitialized');
  const siblingRoot = path.join(root, 'sibling');
  for (const dir of [ownerRoot, childRoot, noBaitonRoot, siblingRoot]) fs.mkdirSync(dir, { recursive: true });
  const entries = [
    repo({ name: 'workspace', root, children: ['owner', 'sibling'] }),
    repo({ name: 'owner', root: ownerRoot, parent: 'workspace', children: ['api', 'no-baiton'], baitonDir: path.join(ownerRoot, '.baiton') }),
    repo({ name: 'api', root: childRoot, parent: 'owner', baitonDir: path.join(childRoot, '.baiton') }),
    repo({ name: 'no-baiton', root: noBaitonRoot, parent: 'owner' }),
    repo({ name: 'sibling', root: siblingRoot, parent: 'workspace', baitonDir: path.join(siblingRoot, '.baiton') }),
  ];
  for (const entry of entries) if (entry.baitonDir !== undefined) fs.mkdirSync(entry.baitonDir, { recursive: true });
  const set: RepoSet = { repos: entries, folderRoots: [entries[0]], truncated: false };
  const ownerCommits: string[] = [];
  const childCommits: string[] = [];
  const ownerGit = gitStub(ownerCommits);
  const childGit = gitStub(childCommits);
  const planRepos = createPlanRepoSeam({
    repos: () => set,
    ownerRoot,
    restricted: () => false,
    gitFor: (repoRoot) => path.resolve(repoRoot) === path.resolve(childRoot) ? childGit : ownerGit,
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
    services,
    guard: new GuardContext({ repoRoot: ownerRoot, baitonDir: path.join(ownerRoot, '.baiton'), restricted: false }),
  };
}

function clean(root: string): void {
  fs.rmSync(root, { recursive: true, force: true });
}

describe('plan-writing tools with repository hints', () => {
  it('keeps the old hintless line and refuses non-owner hints without a repo seam', async () => {
    const fixture = makeFixture();
    try {
      const slug = 'plain';
      const file = writePlan(path.join(fixture.ownerRoot, '.baiton'), slug);
      const services = { ...fixture.services, planRepos: undefined };
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

      const result = await edit.run({ slug: 'child-only', id: 'P02', title: 'Edited in child' }, { callId: 'child-edit', ctx: fixture.guard });
      assert.strictEqual(result.ok, true);
      assert.ok(fs.readFileSync(childFile, 'utf8').includes('P02 Edited in child'));
      const childSubject = execFileSync('git', ['-C', fixture.childRoot, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim();
      assert.strictEqual(childSubject, 'plan(child-only): P02 edit P02');
      assert.strictEqual(execFileSync('git', ['-C', fixture.ownerRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), parentHead);
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
      assert.deepStrictEqual(result, { ok: false, error: 'plan "ambiguous" exists in more than one nested repo (packages/api, packages/other); open it from its own repo' });
      assert.strictEqual(fs.readFileSync(file, 'utf8'), original);
      assert.deepStrictEqual(fixture.ownerCommits, []);
      assert.deepStrictEqual(fixture.childCommits, []);
    } finally {
      clean(fixture.root);
    }
  });
});
