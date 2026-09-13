import * as assert from 'assert';
import { buildBrief } from '../src/engine/brief';
import { EXECUTOR_NO_GIT_INSTRUCTION } from '../src/engine/roleInstructions';
import { initialPromptFor } from '../src/engine/launcher';
import { awaitStageResult } from '../src/engine/resultFlow';
import type { HostTerminal } from '../src/engine/terminalHost';
import type { ResultWatcher, Unsubscribe } from '../src/engine/resultWatcher';
import { artifactPathFor } from '../src/engine/resultFlow';

/**
 * Unit tests for the brief writer, the launcher's initial prompt, and the
 * result-watcher completion flow (task 10.4).
 *
 * These cover the parts of the stage engine that have observable structure
 * without a VS Code host: the fixed section ordering of the Brief (schema and
 * stop instruction last), the executor no-git instruction, the exact initial
 * prompt wording, and the three terminal outcomes of the result flow (valid →
 * completed, invalid → stays open then a valid rewrite → completed, terminal
 * close before a result → closed).
 *
 * Validates: Requirements 11.3, 11.4, 17.5, 12.3, 12.6, 12.8
 */

/** A fake terminal that records whether/when it was disposed (Req 12.5). */
class FakeTerminal implements HostTerminal {
  public disposeCount = 0;
  public readonly sentText: string[] = [];

  sendText(text: string): void {
    this.sentText.push(text);
  }

  dispose(): void {
    this.disposeCount += 1;
  }

  show(): void {
    /* no-op */
  }
}

/**
 * A fake {@link ResultWatcher} that lets the test drive result appearances and
 * terminal-close events directly, and records disposal so a test can assert the
 * flow tore the watcher down on a terminal outcome.
 */
class FakeResultWatcher implements ResultWatcher {
  public disposeCount = 0;
  private resultListeners: Array<(raw: string) => void> = [];
  private closeListeners: Array<(exitCode: number | undefined) => void> = [];

  onResult(listener: (rawContents: string) => void): Unsubscribe {
    this.resultListeners.push(listener);
    return () => {
      this.resultListeners = this.resultListeners.filter((l) => l !== listener);
    };
  }

  onTerminalClose(
    listener: (exitCode: number | undefined) => void,
  ): Unsubscribe {
    this.closeListeners.push(listener);
    return () => {
      this.closeListeners = this.closeListeners.filter((l) => l !== listener);
    };
  }

  dispose(): void {
    this.disposeCount += 1;
    this.resultListeners = [];
    this.closeListeners = [];
  }

  /** Test driver: simulate the result file appearing or being rewritten. */
  emitResult(rawContents: string): void {
    for (const listener of [...this.resultListeners]) {
      listener(rawContents);
    }
  }

  /** Test driver: simulate the terminal closing. */
  emitClose(exitCode: number | undefined): void {
    for (const listener of [...this.closeListeners]) {
      listener(exitCode);
    }
  }
}

/** A conformant execute result the schema accepts. */
const VALID_EXECUTE_RESULT = JSON.stringify({
  summary: 'implemented the todo',
  files_changed: ['src/a.ts'],
  commands_run: ['npm test'],
  notes: [],
});

describe('brief writer, launcher prompt, and watcher outcomes (unit)', () => {
  describe('buildBrief section ordering (Req 11.3)', () => {
    it('orders sections role → result path → schema → write-and-stop, with schema and stop last', () => {
      const brief = buildBrief({
        stage: 'plan',
        role: 'planner',
        resultPath: '/repo/.baiton/runs/run-1/result.json',
      });

      const roleIdx = brief.indexOf('# Role');
      const resultIdx = brief.indexOf('# Result file');
      const schemaIdx = brief.indexOf('# Result schema');
      const stopIdx = brief.indexOf('# When you are done');

      assert.ok(roleIdx >= 0, 'brief has a role section');
      assert.ok(resultIdx >= 0, 'brief has a result path section');
      assert.ok(schemaIdx >= 0, 'brief has a schema section');
      assert.ok(stopIdx >= 0, 'brief has a write-and-stop section');

      // Role instructions first, then the result path, then the schema, then
      // the write-and-stop instruction — schema and stop LAST (Req 11.3).
      assert.ok(roleIdx < resultIdx, 'role instructions come before the result path');
      assert.ok(resultIdx < schemaIdx, 'result path comes before the schema');
      assert.ok(schemaIdx < stopIdx, 'schema comes before the write-and-stop instruction');
    });

    it('places the schema and the stop instruction as the final two sections for every stage', () => {
      for (const stage of ['plan', 'plan-review', 'execute', 'review'] as const) {
        const brief = buildBrief({
          stage,
          role: 'planner',
          resultPath: '/repo/.baiton/runs/run-1/result.json',
        });
        const schemaIdx = brief.indexOf('# Result schema');
        const stopIdx = brief.indexOf('# When you are done');
        const roleIdx = brief.indexOf('# Role');
        const resultIdx = brief.indexOf('# Result file');

        assert.ok(
          roleIdx < schemaIdx && resultIdx < schemaIdx,
          `[${stage}] schema is preceded by role and result path`,
        );
        assert.ok(
          stopIdx > schemaIdx,
          `[${stage}] stop instruction is the last section, after the schema`,
        );
      }
    });

    it('embeds the absolute result path in the result-file section', () => {
      const resultPath = '/repo/.baiton/runs/run-42/result.json';
      const brief = buildBrief({ stage: 'plan', role: 'planner', resultPath });
      assert.ok(brief.includes(resultPath), 'the brief names the exact result path');
    });
  });

  describe('spec-writer brief', () => {
    const brief = (): string =>
      buildBrief({
        stage: 'spec-draft',
        role: 'spec-writer',
        resultPath: '/repo/.baiton/runs/draft-1/result.json',
        context: '## Requirements\n\nBuild a greeting module.',
      });

    it('orders role → context → result path → schema → write-and-stop', () => {
      const text = brief();
      const roleIdx = text.indexOf('# Role');
      const contextIdx = text.indexOf('# Context');
      const resultIdx = text.indexOf('# Result file');
      const schemaIdx = text.indexOf('# Result schema');
      const stopIdx = text.indexOf('# When you are done');

      assert.ok(roleIdx >= 0 && contextIdx >= 0 && resultIdx >= 0);
      assert.ok(roleIdx < contextIdx, 'role comes before the context');
      assert.ok(contextIdx < resultIdx, 'context comes before the result path');
      assert.ok(resultIdx < schemaIdx, 'result path comes before the schema');
      assert.ok(schemaIdx < stopIdx, 'schema comes before the write-and-stop instruction');
    });

    it('carries the read-only instruction and the todo grammar rules', () => {
      const text = brief();
      assert.match(text, /read-only/i);
      assert.match(text, /never assign an id/i);
      assert.ok(text.includes('T01'), 'brief explains the assigned id form');
      assert.match(text, /1-based positions/i);
      assert.match(text, /`files` lists/);
    });

    it('carries the supplied requirements as the brief context', () => {
      assert.ok(brief().includes('Build a greeting module.'));
    });

    it('embeds the spec-draft result schema, not another stage schema', () => {
      const text = brief();
      assert.ok(text.includes('"overview"'), 'schema section carries the overview property');
      assert.ok(text.includes('"todos"'), 'schema section carries the todos property');
    });

    it('does not carry the executor no-git instruction', () => {
      assert.ok(!brief().includes('Do not commit, stash, or change branches'));
    });
  });

  describe('executor no-git instruction (Req 17.5)', () => {
    it('includes the do-not-commit/stash/switch instruction in an executor brief', () => {
      const brief = buildBrief({
        stage: 'execute',
        role: 'executor',
        resultPath: '/repo/.baiton/runs/run-1/result.json',
      });
      assert.ok(
        brief.includes(EXECUTOR_NO_GIT_INSTRUCTION),
        'the executor brief carries the no-git instruction verbatim',
      );
    });

    it('does not carry the no-git instruction in a non-executor (planner) brief', () => {
      const brief = buildBrief({
        stage: 'plan',
        role: 'planner',
        resultPath: '/repo/.baiton/runs/run-1/result.json',
      });
      assert.ok(
        !brief.includes(EXECUTOR_NO_GIT_INSTRUCTION),
        'a planner brief has no executor-only git instruction',
      );
    });
  });

  describe('initialPromptFor (Req 11.4)', () => {
    it('returns exactly "Read <briefPath> and do what it says."', () => {
      const briefPath = '/repo/.baiton/runs/run-7/brief.md';
      assert.strictEqual(
        initialPromptFor(briefPath),
        `Read ${briefPath} and do what it says.`,
      );
    });
  });

  describe('awaitStageResult outcomes', () => {
    it('resolves completed on a valid result, persists the artifact, and disposes the terminal (Req 12.5)', async () => {
      const terminal = new FakeTerminal();
      const watcher = new FakeResultWatcher();
      const written: Array<{ path: string; contents: string }> = [];
      const reported: string[] = [];

      const outcomePromise = awaitStageResult(
        {
          workspaceRoot: '/repo',
          slug: 'my-spec',
          stage: 'execute',
          index: 1,
          terminal,
          watcher,
        },
        {
          writeArtifact: (path, contents) => written.push({ path, contents }),
          reportInvalid: (detail) => reported.push(detail),
        },
      );

      watcher.emitResult(VALID_EXECUTE_RESULT);
      const outcome = await outcomePromise;

      assert.strictEqual(outcome.kind, 'completed');
      assert.strictEqual(written.length, 1, 'the artifact was persisted once');
      assert.strictEqual(
        written[0].path,
        artifactPathFor('/repo', 'my-spec', 'execute', 1),
        'artifact persisted at the numbered execute stage path',
      );
      assert.strictEqual(terminal.disposeCount, 1, 'terminal disposed on a valid result');
      assert.strictEqual(watcher.disposeCount, 1, 'watcher disposed on the terminal outcome');
      assert.strictEqual(reported.length, 0, 'no validation failure was surfaced');
    });

    it('does not resolve on an invalid result: keeps the terminal open, reports, then a valid rewrite completes (Req 12.3, 12.6, 12.7)', async () => {
      const terminal = new FakeTerminal();
      const watcher = new FakeResultWatcher();
      const written: Array<{ path: string; contents: string }> = [];
      const reported: string[] = [];

      const outcomePromise = awaitStageResult(
        {
          workspaceRoot: '/repo',
          slug: 'my-spec',
          stage: 'execute',
          index: 1,
          terminal,
          watcher,
        },
        {
          writeArtifact: (path, contents) => written.push({ path, contents }),
          reportInvalid: (detail) => reported.push(detail),
        },
      );

      // First: malformed JSON → invalid (Req 12.3).
      watcher.emitResult('{ this is not json');
      // Then: schema-violating JSON → invalid (Req 12.6).
      watcher.emitResult(JSON.stringify({ summary: 42 }));

      // The invalid results left the run open: nothing persisted, terminal
      // still open, no outcome yet, and the failures were surfaced (Req 12.6).
      assert.strictEqual(written.length, 0, 'no artifact persisted while invalid');
      assert.strictEqual(terminal.disposeCount, 0, 'terminal stays open while invalid');
      assert.strictEqual(watcher.disposeCount, 0, 'watcher stays subscribed while invalid');
      assert.strictEqual(reported.length, 2, 'each invalid result surfaced what was invalid');

      // Race a marker against the promise: it must still be pending here.
      const pendingMarker = Symbol('pending');
      const raced = await Promise.race([
        outcomePromise,
        Promise.resolve(pendingMarker),
      ]);
      assert.strictEqual(raced, pendingMarker, 'the flow has not resolved on invalid results');

      // A valid rewrite arrives through the same watcher → completed (Req 12.7).
      watcher.emitResult(VALID_EXECUTE_RESULT);
      const outcome = await outcomePromise;

      assert.strictEqual(outcome.kind, 'completed');
      assert.strictEqual(written.length, 1, 'the valid rewrite persisted the artifact');
      assert.strictEqual(terminal.disposeCount, 1, 'terminal disposed on the valid rewrite');
      assert.strictEqual(watcher.disposeCount, 1, 'watcher disposed on the terminal outcome');
    });

    it('resolves closed when the terminal closes before any result (Req 12.8)', async () => {
      const terminal = new FakeTerminal();
      const watcher = new FakeResultWatcher();
      const written: Array<{ path: string; contents: string }> = [];

      const outcomePromise = awaitStageResult(
        {
          workspaceRoot: '/repo',
          slug: 'my-spec',
          stage: 'execute',
          index: 1,
          terminal,
          watcher,
        },
        {
          writeArtifact: (path, contents) => written.push({ path, contents }),
          reportInvalid: () => {},
        },
      );

      watcher.emitClose(137);
      const outcome = await outcomePromise;

      assert.strictEqual(outcome.kind, 'closed');
      assert.ok(
        outcome.kind === 'closed' && outcome.exitCode === 137,
        'the closed outcome carries the host exit code',
      );
      assert.strictEqual(written.length, 0, 'no artifact persisted on a close-before-result');
      assert.strictEqual(watcher.disposeCount, 1, 'watcher disposed on the closed outcome');
    });
  });
});
