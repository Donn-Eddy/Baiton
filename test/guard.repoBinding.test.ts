import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { createReadTools } from '../src/orchestrator/readTools';
import { GuardContext, guardWorkspaceForRepo } from '../src/orchestrator/guard';
import type { ToolServices } from '../src/orchestrator/toolServices';

describe('repo-bound stage guard', () => {
  let parent: string;
  let child: string;

  beforeEach(() => {
    parent = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-guard-parent-'));
    child = path.join(parent, 'packages/api');
    fs.mkdirSync(path.join(parent, 'src'), { recursive: true });
    fs.mkdirSync(path.join(child, 'src'), { recursive: true });
    fs.mkdirSync(path.join(parent, 'packages/web'), { recursive: true });
    fs.writeFileSync(path.join(parent, 'src/a.ts'), 'parentOnly\n');
    fs.writeFileSync(path.join(child, 'src/b.ts'), 'childOnly\n');
    fs.writeFileSync(path.join(parent, 'packages/web/c.ts'), 'siblingOnly\n');
  });

  afterEach(() => fs.rmSync(parent, { recursive: true, force: true }));

  it('confines reads, mutations and enumeration to the target repo', async () => {
    const ctx = new GuardContext(guardWorkspaceForRepo({ root: child }, false));
    assert.strictEqual(ctx.baitonDir, path.join(fs.realpathSync(child), '.baiton'));
    assert.ok((await ctx.resolveReadPath('src/b.ts')).ok);
    assert.ok(!(await ctx.resolveReadPath(path.join(parent, 'src/a.ts'))).ok);
    assert.ok(!(await ctx.resolveReadPath('../web/c.ts')).ok);
    assert.ok(!(await ctx.resolveReadPath(parent)).ok);
    assert.ok(!(await ctx.resolveMutatingPath(path.join(parent, '.baiton/plans/x/plan.md'))).ok);
    assert.ok((await ctx.resolveMutatingPath(path.join(child, '.baiton/plans/x/plan.md'))).ok);

    const tools = createReadTools({ repoRoot: parent, baitonDir: path.join(parent, '.baiton') } as ToolServices);
    const context = { callId: undefined, ctx };
    const list = await tools.find((tool) => tool.name === 'list_files')!.run({ glob: '**/*' }, context);
    assert.ok(list.ok);
    if (list.ok) assert.deepStrictEqual((list.data as { files: string[] }).files, ['src/b.ts']);
    const search = await tools.find((tool) => tool.name === 'search')!.run({ pattern: '.' }, context);
    assert.ok(search.ok);
    if (search.ok) {
      const matches = (search.data as { matches: { file: string }[] }).matches;
      assert.deepStrictEqual(matches.map((match) => match.file), ['src/b.ts']);
    }
  });
});
