import * as assert from 'assert';
import * as fc from 'fast-check';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { GitService, GitStatus } from '../src/git';
import { PHASE_STATES, PhaseState } from '../src/model/phaseState';
import type { DocumentKind } from '../src/model/parser';
import { Result, ok } from '../src/model/result';
import { createPlanWriteTools } from '../src/orchestrator/planWriteTools';
import { GuardContext, Tool, ToolResult } from '../src/orchestrator/guard';
import { RunDispatchOutcome, RunDispatchRequest } from '../src/orchestrator/seams';
import { ToolServices } from '../src/orchestrator/toolServices';

const PROTECTED: ReadonlySet<PhaseState> = new Set<PhaseState>([
  'done', 'failed', 'planning', 'executing', 'reviewing',
]);

function stubGit(commits: string[] = []): GitService {
  const notUsed = (name: string) => (): never => {
    throw new Error(`stub git: ${name} not expected in this test`);
  };
  return {
    status: async (): Promise<GitStatus> => ({ clean: true, changes: [] }),
    isCleanExceptPlanFolder: async () => true,
    fetch: async () => undefined,
    resolveBaseCommit: async () => '0'.repeat(40),
    createPlanBranch: async () => undefined,
    checkout: async () => undefined,
    commit: async (message: string) => { commits.push(message); return 'a'.repeat(40); },
    head: async () => 'a'.repeat(40),
    currentBranch: async () => 'main',
    diff: async () => '',
    diffAgainstWorkingTree: async () => '',
    log: async () => '',
    resetWorkingTree: async (): Promise<Result<void, never>> => ok(undefined),
    findCommitByRunId: notUsed('findCommitByRunId'),
    push: async () => undefined,
    remoteUrl: async () => '',
  };
}

const alwaysConfirm = { confirm: async (): Promise<boolean> => true };
const noRunQueue = {
  dispatch: async (_req: RunDispatchRequest): Promise<RunDispatchOutcome> => ({ kind: 'busy' as const }),
};

function makeServices(repoRoot: string, commits: string[] = []): ToolServices {
  return {
    repoRoot,
    baitonDir: path.join(repoRoot, '.baiton'),
    git: stubGit(commits),
    confirm: alwaysConfirm,
    runQueue: noRunQueue,
    clock: { now: () => '2024-01-01T00:00:00.000Z' },
    ids: { next: () => 'id-1' },
    gitSettings: { remote: 'origin', base: 'main' },
  };
}

function makeGuard(repoRoot: string): GuardContext {
  return new GuardContext({ repoRoot, baitonDir: path.join(repoRoot, '.baiton'), restricted: false });
}

function toolByName(tools: Tool[], name: string): Tool {
  const tool = tools.find((entry) => entry.name === name);
  assert.ok(tool !== undefined, `tool "${name}" must exist`);
  return tool;
}

function renderDocument(kind: DocumentKind): { text: string; phases: { id: string; state: PhaseState }[] } {
  const prefix = kind === 'plan' ? 'P' : 'T';
  const lines = [
    '---', 'version: 1', 'name: sample', 'status: draft', '---', '',
    ...(kind === 'plan'
      ? ['# Endstate', '', 'A sample plan.', '', '# What needs changing', '', 'Nothing yet.', '', '# Limitations & constraints', '', 'None.', '', '# PHASES']
      : ['# OVERVIEW', '', 'A sample legacy spec.', '', '# TODOS']),
    '',
  ];
  const phases: { id: string; state: PhaseState }[] = [];
  PHASE_STATES.forEach((state, i) => {
    const id = `${prefix}${String(i + 1).padStart(2, '0')}`;
    phases.push({ id, state });
    lines.push(`- [${state}] ${id} Phase in ${state} state`);
  });
  lines.push('');
  return { text: lines.join('\n'), phases };
}

function makeRepo(slug: string, kind: DocumentKind): {
  repoRoot: string;
  documentFile: string;
  phases: { id: string; state: PhaseState }[];
} {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-planwrite-'));
  const root = kind === 'plan' ? 'plans' : 'specs';
  const fileName = kind === 'plan' ? 'plan.md' : 'spec.md';
  const dir = path.join(repoRoot, '.baiton', root, slug);
  fs.mkdirSync(dir, { recursive: true });
  const rendered = renderDocument(kind);
  const documentFile = path.join(dir, fileName);
  fs.writeFileSync(documentFile, rendered.text, 'utf8');
  return { repoRoot, documentFile, phases: rendered.phases };
}

describe('plan-writing tools: protected-state phase edit/remove', () => {
  it('refuses protected phase states and accepts the others for plans and legacy plans', async () => {
    let callSeq = 0;
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom<DocumentKind>('plan', 'legacy-spec'),
        fc.nat({ max: PHASE_STATES.length - 1 }),
        fc.constantFrom<'edit_phase' | 'remove_phase'>('edit_phase', 'remove_phase'),
        fc.string({ minLength: 1, maxLength: 30 }),
        async (kind, phasePick, toolName, rawTitle) => {
          const slug = 'sample';
          const { repoRoot, documentFile, phases } = makeRepo(slug, kind);
          try {
            const tool = toolByName(createPlanWriteTools(makeServices(repoRoot)), toolName);
            const guard = makeGuard(repoRoot);
            const target = phases[phasePick];
            const before = fs.readFileSync(documentFile, 'utf8');
            const title = rawTitle.replace(/[()\n\r;]/g, ' ').trim() || 'edited title';
            const args = toolName === 'edit_phase'
              ? { slug, id: target.id, title }
              : { slug, id: target.id };
            const result: ToolResult = await tool.run(args, { callId: `call-${callSeq++}`, ctx: guard });
            const after = fs.readFileSync(documentFile, 'utf8');

            if (PROTECTED.has(target.state)) {
              assert.strictEqual(result.ok, false, `${toolName} on ${target.state} ${target.id} must be refused`);
              if (!result.ok) assert.match(result.error, /protected state/i);
              assert.strictEqual(after, before, `${toolName} must leave protected phase lines unchanged`);
            } else {
              assert.strictEqual(result.ok, true, `${toolName} on ${target.state} ${target.id} must be accepted`);
              assert.notStrictEqual(after, before);
              if (toolName === 'remove_phase') {
                assert.ok(!after.includes(` ${target.id} `), `remove_phase must delete ${target.id}`);
              } else {
                assert.ok(after.includes(`- [${target.state}] ${target.id} ${title}`));
              }
            }
          } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
          }
        },
      ),
      { numRuns: 120 },
    );
  });

  for (const kind of ['plan', 'legacy-spec'] as const) {
    const prefix = kind === 'plan' ? 'P' : 'T';
    const section = kind === 'plan' ? 'PHASES' : 'TODOS';
    it(`add_phase appends a pending ${prefix} id under # ${section}`, async () => {
      const slug = 'sample';
      const { repoRoot, documentFile } = makeRepo(slug, kind);
      try {
        const commits: string[] = [];
        const tool = toolByName(createPlanWriteTools(makeServices(repoRoot, commits)), 'add_phase');
        const result = await tool.run({ slug, id: `${prefix}09`, title: 'New work' }, { callId: 'add-1', ctx: makeGuard(repoRoot) });
        assert.strictEqual(result.ok, true);
        const after = fs.readFileSync(documentFile, 'utf8');
        assert.ok(after.includes(`# ${section}\n`));
        assert.ok(after.includes(`- [pending] ${prefix}09 New work`));
        assert.deepStrictEqual(commits, [`plan(${slug}): ${prefix}09 add ${prefix}09`]);
      } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });

    it(`add_phase refuses the other document kind's prefix for ${kind}`, async () => {
      const slug = 'sample';
      const { repoRoot, documentFile } = makeRepo(slug, kind);
      try {
        const wrongPrefix = kind === 'plan' ? 'T01' : 'P01';
        const tool = toolByName(createPlanWriteTools(makeServices(repoRoot)), 'add_phase');
        const before = fs.readFileSync(documentFile, 'utf8');
        const result = await tool.run({ slug, id: wrongPrefix, title: 'Wrong prefix' }, { callId: 'bad-1', ctx: makeGuard(repoRoot) });
        assert.strictEqual(result.ok, false);
        assert.strictEqual(fs.readFileSync(documentFile, 'utf8'), before);
      } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
      }
    });
  }

  it('update_overview replaces a plan preamble and preserves frontmatter and every phase line', async () => {
    const slug = 'sample';
    const { repoRoot, documentFile } = makeRepo(slug, 'plan');
    try {
      const tool = toolByName(createPlanWriteTools(makeServices(repoRoot)), 'update_overview');
      const before = fs.readFileSync(documentFile, 'utf8');
      const phases = before.slice(before.indexOf('# PHASES'));
      const frontmatterEnd = before.indexOf('\n---\n') + '\n---'.length;
      const frontmatter = before.slice(0, frontmatterEnd);
      const result = await tool.run({ slug, text: '# Endstate\n\nReplacement.\n\n# What needs changing\n\nNew work.\n\n# Limitations & constraints\n\nNone.' }, { callId: 'overview-plan', ctx: makeGuard(repoRoot) });
      assert.strictEqual(result.ok, true);
      const after = fs.readFileSync(documentFile, 'utf8');
      assert.ok(after.startsWith(frontmatter));
      assert.strictEqual(after.slice(after.indexOf('# PHASES')), phases);
      assert.ok(after.includes('Replacement.'));
      assert.ok(after.includes('# What needs changing'));
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it('update_overview retains the legacy OVERVIEW body behavior', async () => {
    const slug = 'sample';
    const { repoRoot, documentFile } = makeRepo(slug, 'legacy-spec');
    try {
      const tool = toolByName(createPlanWriteTools(makeServices(repoRoot)), 'update_overview');
      const before = fs.readFileSync(documentFile, 'utf8');
      const todos = before.slice(before.indexOf('# TODOS'));
      const result = await tool.run({ slug, text: 'Updated legacy overview.' }, { callId: 'overview-legacy', ctx: makeGuard(repoRoot) });
      assert.strictEqual(result.ok, true);
      const after = fs.readFileSync(documentFile, 'utf8');
      assert.ok(after.includes('Updated legacy overview.'));
      assert.strictEqual(after.slice(after.indexOf('# TODOS')), todos);
      assert.ok(!after.includes('A sample legacy spec.'));
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
