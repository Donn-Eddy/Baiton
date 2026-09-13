import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { recoverJournal, HOST_EXITED_NOTE, type ProcessControl } from '../src/engine/recovery';
import type { SpecStore } from '../src/engine/runQueue';
import type { GitService } from '../src/git';
import { appendStart } from '../src/journal';
import type { TodoState } from '../src/model/todoState';

/**
 * Unit tests for crash recovery's revert-on-`fromState` behaviour (Req 1.3;
 * design "Recovery"). Host-free: a fake git seam (no `Run-Id` commit ever
 * landed, so every entry falls into the "no commit landed" branch), a fake
 * process seam (no live pids to kill), and a fake spec store recording every
 * `writeState` call.
 *
 * Covers one entry that records `fromState` (reverted to that state with
 * `HOST_EXITED_NOTE`, action `reverted-state`) and one legacy entry without
 * `fromState` (marked `failed` with `HOST_EXITED_NOTE`, action `marked-failed`),
 * per the design's no-commit branch:
 * `applyState(deps, entry, entry.fromState ?? 'failed', HOST_EXITED_NOTE)`.
 */
describe('recovery: revert to fromState on the no-commit-landed branch (Req 1.3)', () => {
  let tmpDir: string;
  let journalPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-recovery-revert-'));
    journalPath = path.join(tmpDir, 'runs.jsonl');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** A git seam that never finds a landed Run-Id commit. */
  const noCommitGit: Pick<GitService, 'findCommitByRunId'> = {
    findCommitByRunId: async () => undefined,
  };

  /** A process seam with no live pids to kill. */
  const noLiveProcess: ProcessControl = {
    isAlive: () => false,
    kill: () => {
      throw new Error('kill should never be called for a dead/absent pid');
    },
  };

  /** A spec store recording every writeState call. */
  function makeRecordingSpecStore(): Pick<SpecStore, 'writeState'> & {
    calls: Array<{ slug: string; todoId: string; state: TodoState; note?: string }>;
  } {
    const calls: Array<{ slug: string; todoId: string; state: TodoState; note?: string }> = [];
    return {
      calls,
      writeState: async (slug, todoId, state, note) => {
        calls.push({ slug, todoId, state, note });
        return true;
      },
    };
  }

  it('reverts a fromState-carrying entry to its From_State with `host exited` (action reverted-state)', async () => {
    appendStart(journalPath, {
      runId: 'run-with-fromstate',
      todoId: 'T01',
      stage: 'execute',
      attempt: 1,
      startHead: 'head0',
      inputRev: 'rev0',
      fromState: 'planned',
      sessionId: 'session-1',
    });

    const specStore = makeRecordingSpecStore();
    const outcomes = await recoverJournal({
      slug: 'demo',
      journalPath,
      git: noCommitGit,
      process: noLiveProcess,
      specStore,
    });

    assert.strictEqual(outcomes.length, 1);
    const outcome = outcomes[0];
    assert.strictEqual(outcome.runId, 'run-with-fromstate');
    assert.strictEqual(outcome.action, 'reverted-state', 'fromState entry reverts, not marks-failed');
    assert.strictEqual(outcome.killedPid, false);
    assert.strictEqual(outcome.commit, undefined, 'no Run-Id commit landed');

    assert.strictEqual(specStore.calls.length, 1);
    assert.deepStrictEqual(specStore.calls[0], {
      slug: 'demo',
      todoId: 'T01',
      state: 'planned',
      note: HOST_EXITED_NOTE,
    });
  });

  it('marks a legacy entry without fromState `failed` with `host exited` (action marked-failed)', async () => {
    appendStart(journalPath, {
      runId: 'run-legacy',
      todoId: 'T02',
      stage: 'execute',
      attempt: 1,
      startHead: 'head0',
      inputRev: 'rev0',
      // No fromState/sessionId: an entry written before this change.
    });

    const specStore = makeRecordingSpecStore();
    const outcomes = await recoverJournal({
      slug: 'demo',
      journalPath,
      git: noCommitGit,
      process: noLiveProcess,
      specStore,
    });

    assert.strictEqual(outcomes.length, 1);
    const outcome = outcomes[0];
    assert.strictEqual(outcome.runId, 'run-legacy');
    assert.strictEqual(outcome.action, 'marked-failed', 'a legacy entry keeps the marked-failed behaviour');
    assert.strictEqual(outcome.killedPid, false);
    assert.strictEqual(outcome.commit, undefined);

    assert.strictEqual(specStore.calls.length, 1);
    assert.deepStrictEqual(specStore.calls[0], {
      slug: 'demo',
      todoId: 'T02',
      state: 'failed',
      note: HOST_EXITED_NOTE,
    });
  });
});
