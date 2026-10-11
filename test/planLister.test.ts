import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { listPhasePlans, listPlans, phasePlanPath } from '../src/activation/planLister';

describe('plan lister', () => {
  let root: string;
  let baitonDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-plan-lister-'));
    baitonDir = path.join(root, '.baiton');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function write(relative: string, contents: string): void {
    const target = path.join(baitonDir, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
  }

  it('lists resolved plan and legacy documents once each in slug order', async () => {
    write('specs/z-legacy/spec.md', '# OVERVIEW\nLegacy.\n');
    write('plans/a-plan/plan.md', '# PHASES\n');
    write('specs/shared/spec.md', 'legacy\n');
    write('plans/shared/plan.md', 'plan\n');
    write('plans/draft/other.txt', 'no document\n');

    assert.deepStrictEqual(await listPlans(baitonDir), [
      { slug: 'a-plan', kind: 'plan', raw: '# PHASES\n' },
      { slug: 'shared', kind: 'plan', raw: 'plan\n' },
      { slug: 'z-legacy', kind: 'legacy-spec', raw: '# OVERVIEW\nLegacy.\n' },
    ]);
  });

  it('reports non-ENOENT document read failures and locates phase plans by kind', async () => {
    fs.mkdirSync(path.join(baitonDir, 'plans', 'unreadable', 'plan.md'), { recursive: true });
    write('specs/legacy/spec.md', '# OVERVIEW\n');
    write('specs/legacy/todos/T01/plan.md', '# Legacy plan\n');
    write('plans/new/plan.md', '# PHASES\n');
    write('plans/new/phases/P01/plan.md', '# Plan P01\n');

    const listed = await listPlans(baitonDir);
    const readFailure = listed.find((item) => item.slug === 'unreadable');
    assert.strictEqual(readFailure?.kind, 'plan');
    assert.match(readFailure?.readError ?? '', /EISDIR/);
    assert.strictEqual(phasePlanPath(baitonDir, 'legacy', 'T01'), path.join(baitonDir, 'specs', 'legacy', 'todos', 'T01', 'plan.md'));
    assert.strictEqual(phasePlanPath(baitonDir, 'new', 'P01'), path.join(baitonDir, 'plans', 'new', 'phases', 'P01', 'plan.md'));
    assert.deepStrictEqual([...await listPhasePlans(baitonDir, 'legacy')], ['T01']);
    assert.deepStrictEqual([...await listPhasePlans(baitonDir, 'new')], ['P01']);
  });
});
