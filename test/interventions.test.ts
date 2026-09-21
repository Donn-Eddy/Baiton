import * as assert from 'assert';
import {
  Clock,
  IdGenerator,
} from '../src/orchestrator/seams';
import {
  checkAnswer,
  confirmSeamFrom,
  createInterventionSeam,
  Intervention,
  InterventionAnswer,
  PendingAskRegistry,
  QuestionRequest,
  ConfirmRequest,
  PermissionRequest,
} from '../src/orchestrator/interventions';

/**
 * Unit tests for the intervention model, pending-ask registry,
 * InterventionSeam, and ConfirmSeam adapter (T01).
 *
 * Runs host-free without a `vscode` environment.
 */

function counterIds(): IdGenerator {
  let counter = 0;
  return {
    next: () => `ask-${++counter}`,
  };
}

const fixedClock: Clock = { now: () => '2026-01-01T00:00:00.000Z' };

describe('interventions', () => {
  describe('checkAnswer', () => {
    it('validates question answers correctly', () => {
      const q: QuestionRequest = {
        kind: 'question',
        prompt: 'Choose color',
        options: [
          { id: 'red', label: 'Red' },
          { id: 'blue', label: 'Blue' },
        ],
      };

      // Declared option accepted
      assert.deepStrictEqual(checkAnswer(q, { kind: 'option', optionId: 'red' }), { ok: true });
      assert.deepStrictEqual(checkAnswer(q, { kind: 'option', optionId: 'blue', label: 'Blue' }), { ok: true });

      // Undeclared option rejected with reason naming the id
      const undeclared = checkAnswer(q, { kind: 'option', optionId: 'green' });
      assert.strictEqual(undeclared.ok, false);
      if (!undeclared.ok) {
        assert.strictEqual(undeclared.reason, 'unknown option "green"');
      }

      // Text rejected when options are declared and allowFreeText is false or omitted
      const textRejected = checkAnswer(q, { kind: 'text', text: 'yellow' });
      assert.strictEqual(textRejected.ok, false);
      if (!textRejected.ok) {
        assert.strictEqual(textRejected.reason, 'this question does not accept a typed answer');
      }

      // Text accepted when allowFreeText is true
      const qFreeText: QuestionRequest = { ...q, allowFreeText: true };
      assert.deepStrictEqual(checkAnswer(qFreeText, { kind: 'text', text: 'yellow' }), { ok: true });

      // Text accepted when options are undefined
      const qNoOptions: QuestionRequest = { kind: 'question', prompt: 'Your name?' };
      assert.deepStrictEqual(checkAnswer(qNoOptions, { kind: 'text', text: 'Alice' }), { ok: true });

      // Text accepted when options array is empty
      const qEmptyOptions: QuestionRequest = { kind: 'question', prompt: 'Your name?', options: [] };
      assert.deepStrictEqual(checkAnswer(qEmptyOptions, { kind: 'text', text: 'Alice' }), { ok: true });

      // Approved rejected for question
      const approvedCheck = checkAnswer(q, { kind: 'approved' });
      assert.strictEqual(approvedCheck.ok, false);
      if (!approvedCheck.ok) {
        assert.strictEqual(approvedCheck.reason, 'a question cannot be answered with an approval');
      }

      // Declined accepted for question
      assert.deepStrictEqual(checkAnswer(q, { kind: 'declined' }), { ok: true });
      assert.deepStrictEqual(checkAnswer(q, { kind: 'declined', reason: 'cancelled' }), { ok: true });
    });

    it('validates confirm and permission answers correctly', () => {
      const c: ConfirmRequest = {
        kind: 'confirm',
        prompt: 'Apply changes?',
        detail: 'This will modify files',
      };
      const p: PermissionRequest = {
        kind: 'permission',
        prompt: 'Run bash command?',
        agent: 'claude',
        tool: 'Bash',
        args: '{"cmd":"ls"}',
        detail: 'List files',
      };

      // Approved accepted for confirm and permission
      assert.deepStrictEqual(checkAnswer(c, { kind: 'approved' }), { ok: true });
      assert.deepStrictEqual(checkAnswer(p, { kind: 'approved' }), { ok: true });

      // Option rejected for confirm and permission
      const optC = checkAnswer(c, { kind: 'option', optionId: 'yes' });
      assert.strictEqual(optC.ok, false);
      if (!optC.ok) {
        assert.strictEqual(optC.reason, 'a confirm is answered by approving or declining');
      }

      const optP = checkAnswer(p, { kind: 'option', optionId: 'yes' });
      assert.strictEqual(optP.ok, false);
      if (!optP.ok) {
        assert.strictEqual(optP.reason, 'a permission is answered by approving or declining');
      }

      // Text rejected for confirm and permission
      const textC = checkAnswer(c, { kind: 'text', text: 'sure' });
      assert.strictEqual(textC.ok, false);
      if (!textC.ok) {
        assert.strictEqual(textC.reason, 'a confirm is answered by approving or declining');
      }

      const textP = checkAnswer(p, { kind: 'text', text: 'sure' });
      assert.strictEqual(textP.ok, false);
      if (!textP.ok) {
        assert.strictEqual(textP.reason, 'a permission is answered by approving or declining');
      }

      // Declined accepted for confirm and permission
      assert.deepStrictEqual(checkAnswer(c, { kind: 'declined' }), { ok: true });
      assert.deepStrictEqual(checkAnswer(c, { kind: 'declined', reason: 'declined by user' }), { ok: true });
      assert.deepStrictEqual(checkAnswer(p, { kind: 'declined' }), { ok: true });
      assert.deepStrictEqual(checkAnswer(p, { kind: 'declined', reason: 'rejected tool' }), { ok: true });
    });
  });

  describe('PendingAskRegistry', () => {
    it('create stamps id and clock, preserves request fields, and leaves answer promise unsettled', async () => {
      const registry = new PendingAskRegistry({
        ids: counterIds(),
        clock: fixedClock,
      });

      const request: PermissionRequest = {
        kind: 'permission',
        prompt: 'Run tool?',
        agent: 'claude',
        tool: 'Bash',
        args: '{"command":"npm test"}',
        detail: 'Runs tests',
      };

      const { intervention, answer } = registry.create(request);

      assert.strictEqual(intervention.id, 'ask-1');
      assert.strictEqual(intervention.createdAt, '2026-01-01T00:00:00.000Z');
      assert.strictEqual(intervention.kind, 'permission');
      assert.strictEqual(intervention.prompt, 'Run tool?');
      assert.strictEqual(intervention.agent, 'claude');
      assert.strictEqual(intervention.tool, 'Bash');
      assert.strictEqual(intervention.args, '{"command":"npm test"}');
      assert.strictEqual(intervention.detail, 'Runs tests');

      assert.strictEqual(registry.size, 1);
      assert.strictEqual(registry.has('ask-1'), true);

      // Verify answer promise is still unsettled via Promise.race against a resolved sentinel
      const sentinel = Symbol('sentinel');
      const winner = await Promise.race([answer, Promise.resolve(sentinel)]);
      assert.strictEqual(winner, sentinel);
    });

    it('resolve settles the promise with a valid answer and removes the entry', async () => {
      const registry = new PendingAskRegistry({
        ids: counterIds(),
        clock: fixedClock,
      });

      const { intervention, answer } = registry.create({
        kind: 'confirm',
        prompt: 'Proceed?',
      });

      const validAnswer: InterventionAnswer = { kind: 'approved' };
      const outcome = registry.resolve(intervention.id, validAnswer);

      assert.deepStrictEqual(outcome, { kind: 'resolved' });
      assert.strictEqual(registry.size, 0);
      assert.strictEqual(registry.has(intervention.id), false);

      const settled = await answer;
      assert.deepStrictEqual(settled, validAnswer);

      // Resolving the same id again returns unknown and does not throw
      const secondOutcome = registry.resolve(intervention.id, validAnswer);
      assert.deepStrictEqual(secondOutcome, { kind: 'unknown' });

      // Resolving an unknown id returns unknown
      const unknownOutcome = registry.resolve('non-existent', validAnswer);
      assert.deepStrictEqual(unknownOutcome, { kind: 'unknown' });
    });

    it('resolve rejects invalid answers, returning { kind: "invalid" } and leaving ask pending', async () => {
      const registry = new PendingAskRegistry({
        ids: counterIds(),
        clock: fixedClock,
      });

      const { intervention, answer } = registry.create({
        kind: 'confirm',
        prompt: 'Proceed?',
      });

      const invalidAnswer: InterventionAnswer = { kind: 'text', text: 'yes' };
      const outcome = registry.resolve(intervention.id, invalidAnswer);

      assert.strictEqual(outcome.kind, 'invalid');
      if (outcome.kind === 'invalid') {
        assert.ok(outcome.reason.length > 0);
      }

      assert.strictEqual(registry.size, 1);
      assert.strictEqual(registry.has(intervention.id), true);

      const sentinel = Symbol('sentinel');
      const winner = await Promise.race([answer, Promise.resolve(sentinel)]);
      assert.strictEqual(winner, sentinel);
    });

    it('reject settles with { kind: "declined", reason } and uses default reason when none is given', async () => {
      const registry = new PendingAskRegistry({
        ids: counterIds(),
        clock: fixedClock,
      });

      const { intervention: i1, answer: a1 } = registry.create({
        kind: 'confirm',
        prompt: 'Proceed 1?',
      });
      const outcome1 = registry.reject(i1.id);
      assert.deepStrictEqual(outcome1, { kind: 'resolved' });
      const settled1 = await a1;
      assert.deepStrictEqual(settled1, { kind: 'declined', reason: 'declined' });

      const { intervention: i2, answer: a2 } = registry.create({
        kind: 'confirm',
        prompt: 'Proceed 2?',
      });
      const outcome2 = registry.reject(i2.id, 'user aborted');
      assert.deepStrictEqual(outcome2, { kind: 'resolved' });
      const settled2 = await a2;
      assert.deepStrictEqual(settled2, { kind: 'declined', reason: 'user aborted' });
    });

    it('rejectAll declines every pending ask, returns the count, and subsequent calls return 0', async () => {
      const registry = new PendingAskRegistry({
        ids: counterIds(),
        clock: fixedClock,
      });

      const { answer: a1 } = registry.create({ kind: 'confirm', prompt: 'Prompt 1' });
      const { answer: a2 } = registry.create({ kind: 'confirm', prompt: 'Prompt 2' });
      const { answer: a3 } = registry.create({ kind: 'confirm', prompt: 'Prompt 3' });

      assert.strictEqual(registry.size, 3);

      const count = registry.rejectAll();
      assert.strictEqual(count, 3);
      assert.strictEqual(registry.size, 0);

      const settled = await Promise.all([a1, a2, a3]);
      assert.deepStrictEqual(settled, [
        { kind: 'declined', reason: 'the run was stopped' },
        { kind: 'declined', reason: 'the run was stopped' },
        { kind: 'declined', reason: 'the run was stopped' },
      ]);

      const secondCount = registry.rejectAll();
      assert.strictEqual(secondCount, 0);
    });

    it('pending() returns asks in creation order and excludes settled ones', () => {
      const registry = new PendingAskRegistry({
        ids: counterIds(),
        clock: fixedClock,
      });

      const { intervention: i1 } = registry.create({ kind: 'confirm', prompt: 'Ask 1' });
      const { intervention: i2 } = registry.create({ kind: 'confirm', prompt: 'Ask 2' });
      const { intervention: i3 } = registry.create({ kind: 'confirm', prompt: 'Ask 3' });

      let list = registry.pending();
      assert.strictEqual(list.length, 3);
      assert.strictEqual(list[0].id, i1.id);
      assert.strictEqual(list[1].id, i2.id);
      assert.strictEqual(list[2].id, i3.id);

      // Settle the middle one
      registry.resolve(i2.id, { kind: 'approved' });

      list = registry.pending();
      assert.strictEqual(list.length, 2);
      assert.strictEqual(list[0].id, i1.id);
      assert.strictEqual(list[1].id, i3.id);
    });
  });

  describe('createInterventionSeam', () => {
    it('calls present once with stamped intervention and resolves when answer is provided', async () => {
      const registry = new PendingAskRegistry({
        ids: counterIds(),
        clock: fixedClock,
      });

      const presented: Intervention[] = [];
      const seam = createInterventionSeam(registry, (intervention) => {
        presented.push(intervention);
      });

      const askPromise = seam.ask({
        kind: 'question',
        prompt: 'Choose one',
        options: [{ id: 'opt-a', label: 'Option A' }],
      });

      assert.strictEqual(presented.length, 1);
      assert.strictEqual(presented[0].id, 'ask-1');
      assert.strictEqual(presented[0].prompt, 'Choose one');

      registry.resolve('ask-1', { kind: 'option', optionId: 'opt-a' });

      const answer = await askPromise;
      assert.deepStrictEqual(answer, { kind: 'option', optionId: 'opt-a' });
    });

    it('declines ask when present throws synchronously and leaves no pending entry', async () => {
      const registry = new PendingAskRegistry({
        ids: counterIds(),
        clock: fixedClock,
      });

      const seam = createInterventionSeam(registry, () => {
        throw new Error('presentation crashed');
      });

      const answer = await seam.ask({
        kind: 'confirm',
        prompt: 'Confirm?',
      });

      assert.strictEqual(answer.kind, 'declined');
      if (answer.kind === 'declined') {
        assert.ok(answer.reason?.includes('presentation crashed'));
      }
      assert.strictEqual(registry.size, 0);
    });

    it('declines ask when present rejects asynchronously and leaves no pending entry', async () => {
      const registry = new PendingAskRegistry({
        ids: counterIds(),
        clock: fixedClock,
      });

      const seam = createInterventionSeam(registry, async () => {
        throw new Error('async presentation failed');
      });

      const answer = await seam.ask({
        kind: 'confirm',
        prompt: 'Confirm?',
      });

      assert.strictEqual(answer.kind, 'declined');
      if (answer.kind === 'declined') {
        assert.ok(answer.reason?.includes('async presentation failed'));
      }
      assert.strictEqual(registry.size, 0);
    });
  });

  describe('confirmSeamFrom', () => {
    it('issues confirm intervention and maps approved to true and declined to false', async () => {
      const registry = new PendingAskRegistry({
        ids: counterIds(),
        clock: fixedClock,
      });

      let presentedIntervention: Intervention | undefined;
      const interventionSeam = createInterventionSeam(registry, (intervention) => {
        presentedIntervention = intervention;
      });

      const confirmSeam = confirmSeamFrom(interventionSeam);

      // Test approved -> true
      const confirm1Promise = confirmSeam.confirm('Proceed with step 1?');
      assert.ok(presentedIntervention);
      assert.strictEqual(presentedIntervention.kind, 'confirm');
      assert.strictEqual(presentedIntervention.prompt, 'Proceed with step 1?');

      registry.resolve(presentedIntervention.id, { kind: 'approved' });
      const result1 = await confirm1Promise;
      assert.strictEqual(result1, true);

      // Test declined -> false
      const confirm2Promise = confirmSeam.confirm('Proceed with step 2?');
      assert.ok(presentedIntervention);
      assert.strictEqual(presentedIntervention.prompt, 'Proceed with step 2?');

      registry.resolve(presentedIntervention.id, { kind: 'declined', reason: 'no thanks' });
      const result2 = await confirm2Promise;
      assert.strictEqual(result2, false);

      // Test rejectAll while confirm is outstanding -> false (Stop returns control)
      const confirm3Promise = confirmSeam.confirm('Proceed with step 3?');
      registry.rejectAll();
      const result3 = await confirm3Promise;
      assert.strictEqual(result3, false);
    });
  });
});
