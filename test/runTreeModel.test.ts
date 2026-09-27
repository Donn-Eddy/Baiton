import * as assert from 'assert';

import {
  RUN_LABEL_MAX_CHARS,
  RUN_OUTCOME_MESSAGE_MAX_CHARS,
  buildRunNode,
  buildRunTree,
  legalRunActions,
  runContextValue,
  runOutcomeLabel,
  runStageFor,
  runStatementLabel,
  runStatementText,
} from '../src/model/runTreeModel';
import { RUN_STATES, type RunManifest, isRunComplete } from '../src/engine/runStore';

/** A valid manifest, with the fields a case cares about overridden. */
function manifest(overrides: Partial<RunManifest> = {}): RunManifest {
  return {
    version: 1,
    id: 'bug-20260926-120000-a1b2',
    mode: 'bug',
    composerMode: 'bug',
    explicitMode: false,
    statement: 'Fix the crash on empty input',
    files: ['src/a.ts'],
    baseBranch: 'main',
    baseHead: 'abc1234',
    branch: 'baiton/bug/bug-20260926-120000-a1b2',
    worktreeDir: '.baiton/worktrees/bug-20260926-120000-a1b2',
    state: 'planning',
    attempts: { plan: 1, execute: 0, review: 0, investigate: 0 },
    createdAt: '2026-09-26T12:00:00.000Z',
    updatedAt: '2026-09-26T12:00:00.000Z',
    ...overrides,
  };
}

describe('runTreeModel', () => {
  describe('buildRunTree', () => {
    it('returns exactly two groups, Active then Complete, both present when empty', () => {
      const groups = buildRunTree([]);
      assert.strictEqual(groups.length, 2);
      assert.deepStrictEqual(
        groups.map((g) => [g.kind, g.label, g.contextValue, g.runs.length]),
        [
          ['active', 'Active', 'baiton.runGroup.active', 0],
          ['complete', 'Complete', 'baiton.runGroup.complete', 0],
        ],
      );
    });

    it('splits every run state exactly as isRunComplete predicts', () => {
      for (const state of RUN_STATES) {
        const [active, complete] = buildRunTree([manifest({ state })]);
        const group = isRunComplete(state) ? complete : active;
        const other = isRunComplete(state) ? active : complete;
        assert.strictEqual(group.runs.length, 1, `state ${state} landed in the wrong group`);
        assert.strictEqual(other.runs.length, 0, `state ${state} landed in both groups`);
        assert.strictEqual(group.runs[0].complete, isRunComplete(state));
      }
    });

    it('preserves input order inside each group', () => {
      const groups = buildRunTree([
        manifest({ id: 'a', state: 'planning' }),
        manifest({ id: 'b', state: 'done' }),
        manifest({ id: 'c', state: 'executing' }),
        manifest({ id: 'd', state: 'cancelled' }),
      ]);
      assert.deepStrictEqual(groups[0].runs.map((r) => r.runId), ['a', 'c']);
      assert.deepStrictEqual(groups[1].runs.map((r) => r.runId), ['b', 'd']);
    });

    it('does not throw for degenerate manifests', () => {
      assert.doesNotThrow(() => {
        const groups = buildRunTree([
          manifest({ files: [], worktreeDir: undefined, statement: '   \n  ' }),
          manifest({ id: 'x', state: 'done', outcome: undefined, worktreeDir: undefined }),
          manifest({ id: 'y', state: 'failed', outcome: undefined }),
        ]);
        assert.strictEqual(groups.length, 2);
      });
    });
  });

  describe('descriptions and labels', () => {
    it('carries the manifest facts verbatim', () => {
      const node = buildRunNode(
        manifest({ mode: 'refactor', branch: 'baiton/refactor/r1', baseBranch: 'develop' }),
      );
      assert.strictEqual(node.mode, 'refactor');
      assert.strictEqual(node.statement, 'Fix the crash on empty input');
      assert.strictEqual(node.branch, 'baiton/refactor/r1');
      assert.strictEqual(node.baseBranch, 'develop');
      assert.strictEqual(node.state, 'planning');
      assert.strictEqual(node.hasWorktree, true);
      assert.strictEqual(node.worktreeDir, '.baiton/worktrees/bug-20260926-120000-a1b2');
    });

    it('one-lines and truncates the label but leaves the statement whole', () => {
      const long = 'Fix  the\ncrash '.repeat(20);
      const node = buildRunNode(manifest({ statement: long }));
      assert.ok(!node.label.includes('\n'));
      assert.strictEqual(node.label.length, RUN_LABEL_MAX_CHARS);
      assert.ok(node.label.endsWith('…'));
      assert.strictEqual(node.statement, runStatementText(long));
      assert.ok(node.statement.length > RUN_LABEL_MAX_CHARS);

      assert.strictEqual(runStatementLabel('a\nb  c'), 'a b c');
      assert.strictEqual(runStatementLabel('   \n\t '), '(no statement)');
      assert.strictEqual(buildRunNode(manifest({ statement: '  \n ' })).label, '(no statement)');
    });

    it('describes an active run by its live stage', () => {
      const m = manifest({ state: 'executing' });
      assert.strictEqual(
        buildRunNode(m, { runId: m.id, stage: 'execute', attempt: 1 }).description,
        'bug · execute',
      );
      assert.strictEqual(
        buildRunNode(m, { runId: m.id, stage: 'execute', attempt: 2 }).description,
        'bug · execute (attempt 2)',
      );
    });

    it('falls back to the state when no stage is live', () => {
      assert.strictEqual(buildRunNode(manifest({ state: 'planned' })).description, 'bug · planned');
      const invest = manifest({ mode: 'investigate', state: 'confirmed', worktreeDir: undefined });
      assert.strictEqual(buildRunNode(invest).description, 'investigate · confirmed');
    });

    it('reports a live investigate stage for a run still in state confirmed', () => {
      const m = manifest({ mode: 'investigate', state: 'confirmed', worktreeDir: undefined });
      const node = buildRunNode(m, { runId: m.id, stage: 'investigate', attempt: 1 });
      assert.strictEqual(node.stage, 'investigate');
      assert.strictEqual(node.attempt, 1);
      assert.strictEqual(node.description, 'investigate · investigate');
    });

    it('puts outcomeLabel on complete nodes only, and uses it in the description', () => {
      const active = buildRunNode(manifest({ state: 'planning' }));
      assert.ok(!('outcomeLabel' in active));

      const complete = buildRunNode(
        manifest({ state: 'done', outcome: { kind: 'verdict', verdict: 'pass' } }),
      );
      assert.strictEqual(complete.outcomeLabel, 'review passed');
      assert.strictEqual(complete.description, `bug · ${complete.outcomeLabel}`);
    });

    it('builds a tooltip from the run facts, omitting the lines that do not apply', () => {
      const m = manifest({ state: 'executing' });
      const live = buildRunNode(m, { runId: m.id, stage: 'execute', attempt: 2 });
      assert.ok(live.tooltip.includes('bug run bug-20260926-120000-a1b2'));
      assert.ok(live.tooltip.includes('Fix the crash on empty input'));
      assert.ok(live.tooltip.includes('Branch: baiton/bug/bug-20260926-120000-a1b2 (from main)'));
      assert.ok(live.tooltip.includes('State: executing'));
      assert.ok(live.tooltip.includes('Stage: execute (attempt 2)'));
      assert.ok(!live.tooltip.includes('Outcome:'));

      const idle = buildRunNode(manifest({ state: 'planned' }));
      assert.ok(!idle.tooltip.includes('Stage:'));

      const done = buildRunNode(
        manifest({ state: 'done', outcome: { kind: 'verdict', verdict: 'pass' } }),
      );
      assert.ok(done.tooltip.includes('Outcome: review passed'));
      assert.ok(!done.tooltip.includes('Stage:'));
    });
  });

  describe('runOutcomeLabel', () => {
    it('names each ending', () => {
      assert.strictEqual(
        runOutcomeLabel(manifest({ state: 'done', outcome: { kind: 'verdict', verdict: 'pass' } })),
        'review passed',
      );
      assert.strictEqual(runOutcomeLabel(manifest({ state: 'done' })), 'done');
      assert.strictEqual(
        runOutcomeLabel(
          manifest({ state: 'failed', outcome: { kind: 'failed', message: 'the plan refused' } }),
        ),
        'failed: the plan refused',
      );
      assert.strictEqual(
        runOutcomeLabel(
          manifest({ state: 'failed', outcome: { kind: 'verdict', verdict: 'findings' } }),
        ),
        'review reported findings',
      );
      assert.strictEqual(runOutcomeLabel(manifest({ state: 'failed' })), 'failed');
      assert.strictEqual(runOutcomeLabel(manifest({ state: 'cancelled' })), 'cancelled');
      assert.strictEqual(runOutcomeLabel(manifest({ state: 'answered' })), 'answered');
      assert.strictEqual(runOutcomeLabel(manifest({ state: 'merged' })), 'merged');
    });

    it('one-lines and truncates a long failure message', () => {
      const message = 'it broke\nbadly '.repeat(20);
      const label = runOutcomeLabel(manifest({ state: 'failed', outcome: { kind: 'failed', message } }));
      assert.ok(label.startsWith('failed: '));
      assert.ok(!label.includes('\n'));
      assert.ok(label.endsWith('…'));
      assert.strictEqual(label.length, 'failed: '.length + RUN_OUTCOME_MESSAGE_MAX_CHARS + 1);
    });
  });

  describe('legalRunActions and contextValue', () => {
    it('offers cancel only for an active run with a stage in flight', () => {
      assert.deepStrictEqual(
        legalRunActions({ state: 'executing', hasWorktree: true, stageRunning: true }),
        ['cancel'],
      );
      assert.deepStrictEqual(
        legalRunActions({ state: 'planned', hasWorktree: true, stageRunning: false }),
        [],
      );
      // A stale live fact on a complete run must not resurrect Cancel.
      const m = manifest({ state: 'cancelled' });
      const node = buildRunNode(m, { runId: m.id, stage: 'execute', attempt: 1 });
      assert.ok(!node.actions.includes('cancel'));
      assert.strictEqual(node.stage, undefined);
    });

    it('offers viewDiff and merge per the completion rules', () => {
      assert.deepStrictEqual(
        legalRunActions({ state: 'done', hasWorktree: true, stageRunning: false }),
        ['viewDiff', 'merge'],
      );
      assert.deepStrictEqual(
        legalRunActions({ state: 'failed', hasWorktree: true, stageRunning: false }),
        ['viewDiff'],
      );
      assert.deepStrictEqual(
        legalRunActions({ state: 'cancelled', hasWorktree: true, stageRunning: false }),
        ['viewDiff'],
      );
      assert.deepStrictEqual(
        legalRunActions({ state: 'merged', hasWorktree: true, stageRunning: false }),
        [],
      );
      assert.deepStrictEqual(
        legalRunActions({ state: 'answered', hasWorktree: false, stageRunning: false }),
        [],
      );
    });

    it('produces space-separated tokens the when clauses can match', () => {
      assert.strictEqual(runContextValue('active', ['cancel']), 'baiton.run.active cancel');
      assert.strictEqual(
        runContextValue('complete', ['viewDiff', 'merge']),
        'baiton.run.complete viewDiff merge',
      );
      assert.strictEqual(runContextValue('complete', []), 'baiton.run.complete');

      assert.ok(/\bcancel\b/.test(runContextValue('active', ['cancel'])));
      const both = runContextValue('complete', ['viewDiff', 'merge']);
      assert.ok(/\bviewDiff\b/.test(both));
      assert.ok(/\bmerge\b/.test(both));
      assert.ok(!/\bmerge\b/.test(runContextValue('active', ['cancel'])));
    });

    it('keeps every node contextValue equal to runContextValue over its own facts', () => {
      const m = manifest({ state: 'executing' });
      const active = buildRunNode(m, { runId: m.id, stage: 'execute', attempt: 1 });
      assert.strictEqual(active.contextValue, runContextValue('active', active.actions));
      assert.strictEqual(active.contextValue, 'baiton.run.active cancel');

      const done = buildRunNode(
        manifest({ state: 'done', outcome: { kind: 'verdict', verdict: 'pass' } }),
      );
      assert.strictEqual(done.contextValue, runContextValue('complete', done.actions));
      assert.strictEqual(done.contextValue, 'baiton.run.complete viewDiff merge');
    });
  });

  describe('runStageFor', () => {
    it('returns the live stage only for the matching, still-active run', () => {
      const m = manifest({ state: 'executing' });
      assert.deepStrictEqual(runStageFor(m, { runId: m.id, stage: 'execute', attempt: 3 }), {
        stage: 'execute',
        attempt: 3,
      });
      assert.strictEqual(
        runStageFor(m, { runId: 'someone-else', stage: 'execute', attempt: 1 }),
        undefined,
      );
      assert.strictEqual(runStageFor(m), undefined);
      assert.strictEqual(
        runStageFor(manifest({ state: 'done' }), { runId: m.id, stage: 'review', attempt: 1 }),
        undefined,
      );
    });
  });
});
