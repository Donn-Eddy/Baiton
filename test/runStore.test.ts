import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  RUN_MANIFEST_FILE,
  RUN_MANIFEST_VERSION,
  RUN_STAGES,
  RUN_STATES,
  RunManifest,
  createRunStore,
  isRunComplete,
  isRunId,
  isRunLaunchDirName,
  isRunStage,
  isRunState,
  launchIdFor,
  newRunId,
  parseLaunchId,
  parseRunManifest,
  runArtifactPathFor,
  runArtifactWriter,
  runBranchFor,
  runDirFor,
  runJournalPathFor,
  runManifestPathFor,
  runWorktreeDirFor,
  serializeRunManifest,
} from '../src/engine/runStore';
import type { NewRunInput, RunStore } from '../src/engine/runStore';

/**
 * Unit tests for the run manifest store.
 *
 * Everything here runs against a real temp directory with an injected clock, so
 * the manifest's shape, its classified failures, the launch-id composition and
 * the run-dir artifact writer are exercised exactly as the run pipeline will use
 * them — without a VS Code host, a spec, or a sub-agent.
 */

/** A controllable ISO clock: each read returns the current `value`. */
class StubClock {
  public value = '2026-09-26T14:15:01.000Z';
  public readonly now = (): string => this.value;
}

/** The minimum a `create` needs, with every field distinct and recognisable. */
function inputFor(id: string, overrides: Partial<NewRunInput> = {}): NewRunInput {
  return {
    id,
    mode: 'bug',
    composerMode: 'quick',
    explicitMode: true,
    statement: 'the login button does nothing',
    files: ['src/ui/login.ts'],
    baseBranch: 'main',
    baseHead: 'abc1234',
    worktreeDir: `.baiton/worktrees/${id}`,
    ...overrides,
  };
}

describe('runStore', () => {
  let root: string;
  let clock: StubClock;
  let store: RunStore;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-runstore-'));
    clock = new StubClock();
    store = createRunStore({ workspaceRoot: root, now: clock.now });
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  describe('run vocabulary', () => {
    it('lists the eleven run states in lifecycle order', () => {
      assert.deepStrictEqual(RUN_STATES, [
        'confirmed',
        'planning',
        'planned',
        'executing',
        'executed',
        'reviewing',
        'done',
        'failed',
        'cancelled',
        'answered',
        'merged',
      ]);
      assert.strictEqual(RUN_STATES.length, 11);
      for (const state of RUN_STATES) {
        assert.ok(isRunState(state), `${state} should be a run state`);
      }
      assert.strictEqual(isRunState('bogus'), false);
    });

    it('marks exactly the terminal states complete', () => {
      const complete = RUN_STATES.filter((s) => isRunComplete(s));
      assert.deepStrictEqual(complete, ['done', 'failed', 'cancelled', 'answered', 'merged']);
    });

    it('lists the four run stages and rejects the spec-only ones', () => {
      assert.deepStrictEqual(RUN_STAGES, ['plan', 'execute', 'review', 'investigate']);
      for (const stage of RUN_STAGES) {
        assert.ok(isRunStage(stage), `${stage} should be a run stage`);
      }
      assert.strictEqual(isRunStage('spec-draft'), false);
      assert.strictEqual(isRunStage('plan-review'), false);
      assert.strictEqual(isRunStage('pr'), false);
      assert.strictEqual(isRunStage('nope'), false);
    });
  });

  describe('paths and ids', () => {
    it('resolves run paths under .baiton/runs/<id>/', () => {
      assert.strictEqual(runDirFor(root, 'r1'), path.join(root, '.baiton', 'runs', 'r1'));
      assert.strictEqual(
        runManifestPathFor(root, 'r1'),
        path.join(root, '.baiton', 'runs', 'r1', 'run.json'),
      );
      assert.strictEqual(
        runJournalPathFor(root, 'r1'),
        path.join(root, '.baiton', 'runs', 'r1', 'runs.jsonl'),
      );
      assert.strictEqual(
        runWorktreeDirFor(root, 'r1'),
        path.join(root, '.baiton', 'worktrees', 'r1'),
      );
      assert.strictEqual(store.dirFor('r1'), runDirFor(root, 'r1'));
      assert.strictEqual(store.manifestPath('r1'), runManifestPathFor(root, 'r1'));
      assert.strictEqual(store.worktreeDirFor('r1'), runWorktreeDirFor(root, 'r1'));
    });

    it('derives the run branch from the mode', () => {
      assert.strictEqual(runBranchFor('bug', 'r1'), 'baiton/bug/r1');
      assert.strictEqual(runBranchFor('investigate', 'r1'), 'baiton/investigate/r1');
    });

    it('accepts plain run ids and rejects anything with a dot or separator', () => {
      assert.ok(isRunId('bug-20260926-141501-a1b2'));
      assert.ok(isRunId('r1'));
      assert.strictEqual(isRunId(''), false);
      assert.strictEqual(isRunId('a.b'), false);
      assert.strictEqual(isRunId('..'), false);
      assert.strictEqual(isRunId('a/b'), false);
      assert.strictEqual(isRunId('-leading'), false);
    });

    it('allocates a deterministic run id from the injected clock and randomness', () => {
      const id = newRunId('quick', clock.now, () => 0);
      assert.strictEqual(id, 'quick-20260926-141501-0000');
      assert.strictEqual(newRunId('quick', clock.now, () => 0), id);
      assert.ok(id.startsWith('quick-'));
      assert.ok(isRunId(id));
      const other = newRunId('bug', clock.now, () => 0.5);
      assert.ok(other.startsWith('bug-'));
      assert.ok(isRunId(other));
      assert.notStrictEqual(other, id);
    });
  });

  describe('launch ids', () => {
    it('composes a launch id from the run, stage and attempt', () => {
      assert.strictEqual(launchIdFor('r1', 'execute', 2), 'r1.execute.2');
    });

    it('round-trips every run stage', () => {
      for (const stage of RUN_STAGES) {
        const id = launchIdFor('bug-20260926-141501-a1b2', stage, 3);
        assert.deepStrictEqual(parseLaunchId(id), {
          runId: 'bug-20260926-141501-a1b2',
          stage,
          attempt: 3,
        });
      }
    });

    it('rejects strings that are not launch ids', () => {
      for (const bad of ['r1.plan', 'r1.plan.0', 'r1.plan.x', 'r1.plan-review.1', 'a.b.c.d', 'r1']) {
        assert.strictEqual(parseLaunchId(bad), undefined, `${bad} should not parse`);
      }
    });

    it('tells a launch directory apart from a run directory', () => {
      assert.strictEqual(isRunLaunchDirName('r1.plan.1'), true);
      assert.strictEqual(isRunLaunchDirName('r1'), false);
    });
  });

  describe('create', () => {
    it('writes a confirmed manifest that reads back identically', () => {
      const created = store.create(inputFor('r1'));
      assert.ok(created.ok, 'create should succeed');
      const manifest = created.value;

      assert.strictEqual(manifest.version, RUN_MANIFEST_VERSION);
      assert.strictEqual(manifest.state, 'confirmed');
      assert.deepStrictEqual(manifest.attempts, {
        plan: 0,
        execute: 0,
        review: 0,
        investigate: 0,
      });
      assert.strictEqual(manifest.branch, 'baiton/bug/r1');
      assert.strictEqual(manifest.createdAt, manifest.updatedAt);
      assert.strictEqual(manifest.outcome, undefined);
      assert.strictEqual(manifest.completedAt, undefined);

      const file = runManifestPathFor(root, 'r1');
      assert.ok(fs.existsSync(file));
      const parsed = parseRunManifest(fs.readFileSync(file, 'utf8'));
      assert.ok(parsed.ok, 'the written file should parse');
      assert.deepStrictEqual(parsed.value, manifest);
      const read = store.read('r1');
      assert.ok(read.ok);
      assert.deepStrictEqual(read.value, manifest);
    });

    it('refuses a duplicate without touching the existing file', () => {
      assert.ok(store.create(inputFor('r1')).ok);
      const file = runManifestPathFor(root, 'r1');
      const before = fs.readFileSync(file, 'utf8');

      const again = store.create(inputFor('r1', { statement: 'something else' }));
      assert.ok(!again.ok);
      assert.strictEqual(again.error.kind, 'duplicate');
      assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
    });

    it('refuses a spec mode and a dotted id, writing nothing', () => {
      const spec = store.create(inputFor('r1', { mode: 'spec' }));
      assert.ok(!spec.ok);
      assert.strictEqual(spec.error.kind, 'invalid-id');

      const dotted = store.create(inputFor('r.1'));
      assert.ok(!dotted.ok);
      assert.strictEqual(dotted.error.kind, 'invalid-id');

      assert.strictEqual(fs.existsSync(path.join(root, '.baiton', 'runs')), false);
    });

    it('refuses a default mode, writing nothing', () => {
      const d = store.create(inputFor('r1', { mode: 'default' }));
      assert.ok(!d.ok);
      assert.strictEqual(d.error.kind, 'invalid-id');
      assert.match(d.error.message, /draft_spec/);
      assert.strictEqual(fs.existsSync(path.join(root, '.baiton', 'runs')), false);
    });

    it('writes a valid run.json for a dispatch from Default', () => {
      const id = 'bug-20260926-141501-a1b2';
      const created = store.create(inputFor(id, { mode: 'bug', composerMode: 'default', explicitMode: true }));
      assert.ok(created.ok);
      assert.strictEqual(created.value.composerMode, 'default');
      assert.strictEqual(created.value.explicitMode, true);
      assert.strictEqual(created.value.mode, 'bug');
      assert.strictEqual(created.value.branch, `baiton/bug/${id}`);
      const parsed = parseRunManifest(fs.readFileSync(runManifestPathFor(root, id), 'utf8'));
      assert.ok(parsed.ok);
      assert.deepStrictEqual(parsed.value, created.value);
      assert.ok(store.read(id).ok);
    });

    it('omits the worktree dir for an investigate run', () => {
      const created = store.create(
        inputFor('r2', { mode: 'investigate', worktreeDir: undefined }),
      );
      assert.ok(created.ok);
      assert.strictEqual(created.value.worktreeDir, undefined);
      assert.strictEqual('worktreeDir' in created.value, false);
    });
  });

  describe('read', () => {
    /** Hand-write a run's `run.json` with arbitrary text. */
    function writeRaw(runId: string, text: string): void {
      const file = runManifestPathFor(root, runId);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text, 'utf8');
    }

    /** A valid manifest object, for mutation into an invalid one. */
    function validManifest(): RunManifest {
      const created = store.create(inputFor('r1'));
      assert.ok(created.ok);
      return created.value;
    }

    it('classifies an unknown run as absent', () => {
      const read = store.read('nope');
      assert.ok(!read.ok);
      assert.strictEqual(read.error.kind, 'absent');
      assert.strictEqual(read.error.kind === 'absent' && read.error.path, runManifestPathFor(root, 'nope'));
    });

    it('classifies a bad id as invalid-id', () => {
      const read = store.read('a.b');
      assert.ok(!read.ok);
      assert.strictEqual(read.error.kind, 'invalid-id');
    });

    it('classifies broken JSON as unparseable', () => {
      writeRaw('r1', '{');
      const read = store.read('r1');
      assert.ok(!read.ok);
      assert.strictEqual(read.error.kind, 'unparseable');
    });

    it('classifies a bad shape as invalid', () => {
      const base = validManifest();

      const cases: Record<string, unknown> = {
        'bad state': { ...base, state: 'nope' },
        'spec mode': { ...base, mode: 'spec' },
        'default mode': { ...base, mode: 'default' },
        'missing counter': { ...base, attempts: { plan: 0, execute: 0, investigate: 0 } },
        'wrong version': { ...base, version: 2 },
      };
      for (const [label, value] of Object.entries(cases)) {
        writeRaw('r1', JSON.stringify(value, null, 2) + '\n');
        const read = store.read('r1');
        assert.ok(!read.ok, `${label} should not read`);
        assert.strictEqual(read.error.kind, 'invalid', `${label} should be invalid`);
      }
    });

    it('accepts composerMode default', () => {
      const base = validManifest();
      const text = JSON.stringify({ ...base, composerMode: 'default', explicitMode: true }, null, 2) + '\n';
      writeRaw('r1', text);
      const read = store.read('r1');
      assert.ok(read.ok);
      assert.strictEqual(read.value.composerMode, 'default');
      assert.strictEqual(read.value.explicitMode, true);
      assert.ok(parseRunManifest(text).ok);
    });

    it('drops unknown keys', () => {
      const base = validManifest();
      writeRaw('r1', JSON.stringify({ ...base, mystery: 'value', extra: 7 }, null, 2) + '\n');
      const read = store.read('r1');
      assert.ok(read.ok);
      assert.deepStrictEqual(read.value, base);
      assert.strictEqual('mystery' in read.value, false);
    });

    it('serializes with a trailing newline', () => {
      const text = serializeRunManifest(validManifest());
      assert.ok(text.endsWith('}\n'));
    });
  });

  describe('update', () => {
    beforeEach(() => {
      assert.ok(store.create(inputFor('r1')).ok);
    });

    it('moves state and updatedAt while createdAt stays put', () => {
      const created = store.read('r1');
      assert.ok(created.ok);
      clock.value = '2026-09-26T15:00:00.000Z';

      const updated = store.update('r1', { state: 'planning' });
      assert.ok(updated.ok);
      assert.strictEqual(updated.value.state, 'planning');
      assert.strictEqual(updated.value.updatedAt, '2026-09-26T15:00:00.000Z');
      assert.strictEqual(updated.value.createdAt, created.value.createdAt);
      assert.strictEqual(updated.value.id, created.value.id);
      assert.strictEqual(updated.value.mode, created.value.mode);
      assert.strictEqual(updated.value.branch, created.value.branch);
      assert.strictEqual(updated.value.baseBranch, created.value.baseBranch);
      assert.strictEqual(updated.value.baseHead, created.value.baseHead);
    });

    it('merges attempts key by key', () => {
      const updated = store.update('r1', { attempts: { execute: 3 } });
      assert.ok(updated.ok);
      assert.deepStrictEqual(updated.value.attempts, {
        plan: 0,
        execute: 3,
        review: 0,
        investigate: 0,
      });
    });

    it('stamps completedAt once and clears it on a move back', () => {
      clock.value = '2026-09-26T16:00:00.000Z';
      const done = store.update('r1', { state: 'done' });
      assert.ok(done.ok);
      assert.strictEqual(done.value.completedAt, '2026-09-26T16:00:00.000Z');

      clock.value = '2026-09-26T17:00:00.000Z';
      const again = store.update('r1', { state: 'merged' });
      assert.ok(again.ok);
      assert.strictEqual(again.value.completedAt, '2026-09-26T16:00:00.000Z');
      assert.strictEqual(again.value.updatedAt, '2026-09-26T17:00:00.000Z');

      const back = store.update('r1', { state: 'executing' });
      assert.ok(back.ok);
      assert.strictEqual(back.value.completedAt, undefined);
      const reread = store.read('r1');
      assert.ok(reread.ok);
      assert.strictEqual(reread.value.completedAt, undefined);
    });

    it('round-trips every outcome through disk', () => {
      const verdict = store.update('r1', { outcome: { kind: 'verdict', verdict: 'findings' } });
      assert.ok(verdict.ok);
      let read = store.read('r1');
      assert.ok(read.ok);
      assert.deepStrictEqual(read.value.outcome, { kind: 'verdict', verdict: 'findings' });

      const finding = store.update('r1', { outcome: { kind: 'finding', finding: 'the cache key' } });
      assert.ok(finding.ok);
      read = store.read('r1');
      assert.ok(read.ok);
      assert.deepStrictEqual(read.value.outcome, { kind: 'finding', finding: 'the cache key' });
    });

    it('records a worktree dir a create omitted', () => {
      const updated = store.update('r1', { worktreeDir: '.baiton/worktrees/r1' });
      assert.ok(updated.ok);
      assert.strictEqual(updated.value.worktreeDir, '.baiton/worktrees/r1');
    });

    it('reports an unknown run as absent', () => {
      const updated = store.update('nope', { state: 'done' });
      assert.ok(!updated.ok);
      assert.strictEqual(updated.error.kind, 'absent');
    });
  });

  describe('bumpAttempt', () => {
    beforeEach(() => {
      assert.ok(store.create(inputFor('r1')).ok);
    });

    it('returns 1-based attempts and their launch ids', () => {
      for (const expected of [1, 2, 3]) {
        const bumped = store.bumpAttempt('r1', 'execute');
        assert.ok(bumped.ok);
        assert.strictEqual(bumped.value.attempt, expected);
        assert.strictEqual(bumped.value.launchId, `r1.execute.${expected}`);
        assert.strictEqual(bumped.value.manifest.attempts.execute, expected);
      }
      const read = store.read('r1');
      assert.ok(read.ok);
      assert.strictEqual(read.value.attempts.execute, 3);
    });

    it('leaves the other stage counters alone', () => {
      assert.ok(store.bumpAttempt('r1', 'execute').ok);
      const bumped = store.bumpAttempt('r1', 'plan');
      assert.ok(bumped.ok);
      assert.deepStrictEqual(bumped.value.manifest.attempts, {
        plan: 1,
        execute: 1,
        review: 0,
        investigate: 0,
      });
      assert.strictEqual(bumped.value.launchId, 'r1.plan.1');
    });
  });

  describe('list', () => {
    it('is empty when .baiton/runs/ does not exist', () => {
      assert.deepStrictEqual(store.list(), []);
    });

    it('returns only real runs, newest first', () => {
      clock.value = '2026-09-26T10:00:00.000Z';
      assert.ok(store.create(inputFor('older')).ok);
      clock.value = '2026-09-26T12:00:00.000Z';
      assert.ok(store.create(inputFor('newer')).ok);
      clock.value = '2026-09-26T12:00:00.000Z';
      assert.ok(store.create(inputFor('newest-tie')).ok);

      // A launch directory of one run, with the brief a launch really holds.
      const launchDir = path.join(root, '.baiton', 'runs', 'newer.plan.1');
      fs.mkdirSync(launchDir, { recursive: true });
      fs.writeFileSync(path.join(launchDir, 'brief.md'), '# Brief\n', 'utf8');
      // A directory with no manifest at all.
      fs.mkdirSync(path.join(root, '.baiton', 'runs', 'stray'), { recursive: true });
      // A directory whose manifest is malformed.
      const brokenDir = path.join(root, '.baiton', 'runs', 'broken');
      fs.mkdirSync(brokenDir, { recursive: true });
      fs.writeFileSync(path.join(brokenDir, RUN_MANIFEST_FILE), '{ nope', 'utf8');

      const ids = store.list().map((m) => m.id);
      assert.deepStrictEqual(ids, ['newest-tie', 'newer', 'older']);
    });
  });

  describe('artifact writer', () => {
    it('names each stage artifact inside the run directory', () => {
      const dir = runDirFor(root, 'r1');
      assert.strictEqual(runArtifactPathFor(root, 'r1', 'plan'), path.join(dir, 'plan.md'));
      assert.strictEqual(
        runArtifactPathFor(root, 'r1', 'execute', 2),
        path.join(dir, 'execute-2.md'),
      );
      assert.strictEqual(
        runArtifactPathFor(root, 'r1', 'review', 1),
        path.join(dir, 'review-1.md'),
      );
      assert.strictEqual(
        runArtifactPathFor(root, 'r1', 'investigate'),
        path.join(dir, 'finding.md'),
      );
    });

    it('throws when a numbered stage is given no attempt', () => {
      assert.throws(() => runArtifactPathFor(root, 'r1', 'execute'));
    });

    it('ignores the spec-relative path it is handed', () => {
      const target = runArtifactWriter(root, 'r1', 'execute', 2);
      assert.strictEqual(target.path, runArtifactPathFor(root, 'r1', 'execute', 2));

      const ignored = path.join(root, '.baiton', 'specs', 'some-slug', 'todos', 'T01', 'execute-2.md');
      target.write(ignored, 'body');

      assert.strictEqual(fs.readFileSync(target.path, 'utf8'), 'body');
      assert.strictEqual(fs.existsSync(ignored), false);
      assert.strictEqual(fs.existsSync(path.join(root, '.baiton', 'specs')), false);
    });
  });

  describe('atomic write', () => {
    it('leaves no temp files behind', () => {
      assert.ok(store.create(inputFor('r1')).ok);
      assert.ok(store.update('r1', { state: 'planning' }).ok);
      assert.ok(store.update('r1', { state: 'planned' }).ok);
      assert.deepStrictEqual(fs.readdirSync(runDirFor(root, 'r1')), [RUN_MANIFEST_FILE]);
    });
  });
});
