import * as assert from 'assert';
import type { RunMode } from '../src/model/mode';
import {
  buildSystemPrompt,
  buildSubAgentPrompt,
  type ConversationKind,
  DRIVE_TEXT,
  PLAN_ADDRESSING_TEXT,
  REPO_DRIVE_TEXT,
  REPO_GATHER_TEXT,
  REPO_HINT_GRAMMAR_LINE,
  planOwnerText,
  repoListText,
  type PromptRepoContext,
} from '../src/orchestrator/systemPrompt';

const REPOS: PromptRepoContext = {
  repos: [
    { path: '.', hasBaiton: true },
    { path: 'packages/api', hasBaiton: true },
    { path: 'packages/web', hasBaiton: false },
  ],
};
const WORKSPACE: ConversationKind = { kind: 'workspace' };
const PLAN: ConversationKind = { kind: 'plan', slug: 'sample' };
const DRAFT = '---\nstatus: draft\n---\n# PHASES\n';
const APPROVED = '---\nstatus: approved\n---\n# PHASES\n';
const MODES: readonly RunMode[] = ['plan', 'default', 'bug', 'quick', 'refactor', 'investigate'];

describe('system prompt repository context', () => {
  it('preserves byte identity with absent, undefined and single-repo contexts for every kind, content and mode', () => {
    const kinds = [
      WORKSPACE,
      PLAN,
      { kind: 'plan', slug: 'sample', repo: '.' } as const,
      { kind: 'plan', slug: 'sample', repo: './' } as const,
    ];
    const contents = [undefined, DRAFT, APPROVED];
    const contexts = [undefined, { repos: [{ path: '.', hasBaiton: true }] }];
    for (const kind of kinds) {
      for (const content of contents) {
        for (const mode of MODES) {
          for (const context of contexts) {
            const baselineKind: ConversationKind = kind.kind === 'plan' ? PLAN : kind;
            assert.strictEqual(
              buildSystemPrompt(kind, content, mode, context),
              buildSystemPrompt(baselineKind, content, mode, context),
            );
          }
        }
      }
    }
  });

  it('adds repo selection rules and the hint grammar to the gather prompt', () => {
    const prompt = buildSystemPrompt(PLAN, DRAFT, 'plan', REPOS);
    assert.ok(prompt.includes(repoListText(REPOS)));
    assert.ok(prompt.includes(REPO_GATHER_TEXT));
    assert.ok(prompt.includes(REPO_HINT_GRAMMAR_LINE));
    assert.match(prompt, /lowest repo/);
    assert.ok(!prompt.includes(REPO_DRIVE_TEXT));
  });

  it('adds per-repo execution guidance to an approved plan prompt', () => {
    const prompt = buildSystemPrompt(PLAN, APPROVED, 'plan', REPOS);
    assert.ok(prompt.includes(REPO_DRIVE_TEXT));
    assert.ok(!prompt.includes(REPO_GATHER_TEXT));
  });

  it('teaches qualified plan addressing once in multi-repo gather and drive prompts', () => {
    for (const content of [DRAFT, APPROVED]) {
      const prompt = buildSystemPrompt(PLAN, content, 'plan', REPOS);
      assert.strictEqual(prompt.split(PLAN_ADDRESSING_TEXT).length - 1, 1);
      assert.ok(prompt.includes('<repoPath>:<slug>'));
      const ambiguityLine = PLAN_ADDRESSING_TEXT.split('\n').find((line) => line.includes('one refusal'));
      assert.ok(ambiguityLine);
      assert.match(ambiguityLine, /ask_user/);
      assert.ok(prompt.includes(PLAN_ADDRESSING_TEXT));
    }
  });

  it('omits qualified plan addressing for absent and single-repo contexts', () => {
    for (const context of [undefined, { repos: [{ path: '.', hasBaiton: true }] }]) {
      assert.ok(!buildSystemPrompt(PLAN, DRAFT, 'plan', context).includes(PLAN_ADDRESSING_TEXT));
    }
  });

  it('names a child-owned plan in gather and drive prompts with repo context', () => {
    const childPlan: ConversationKind = { kind: 'plan', slug: 'sample', repo: 'packages/api' };
    for (const content of [DRAFT, APPROVED]) {
      const prompt = buildSystemPrompt(childPlan, content, 'plan', REPOS);
      assert.ok(prompt.includes(planOwnerText('sample', 'packages/api')));
      assert.ok(prompt.includes('`packages/api:sample`'));
      assert.strictEqual(prompt.split(PLAN_ADDRESSING_TEXT).length - 1, 1);
    }
  });

  it('explains qualified addressing for a child-owned plan without repo context', () => {
    const prompt = buildSystemPrompt(
      { kind: 'plan', slug: 'sample', repo: 'packages/api' },
      DRAFT,
    );
    assert.ok(prompt.includes(planOwnerText('sample', 'packages/api')));
    assert.strictEqual(prompt.split(PLAN_ADDRESSING_TEXT).length - 1, 1);
  });

  it('normalizes a trailing slash on the owning repo', () => {
    assert.strictEqual(
      buildSystemPrompt({ kind: 'plan', slug: 'sample', repo: 'packages/api/' }, DRAFT),
      buildSystemPrompt({ kind: 'plan', slug: 'sample', repo: 'packages/api' }, DRAFT),
    );
  });

  it('leaves run-step prompts unchanged when repo context is supplied', () => {
    assert.strictEqual(
      buildSystemPrompt(WORKSPACE, undefined, 'bug', REPOS),
      buildSystemPrompt(WORKSPACE, undefined, 'bug'),
    );
  });

  it('adds owning-repo guidance to sub-agent prompts and preserves dot-owner identity', () => {
    for (const step of ['gather', 'drive'] as const) {
      const child = buildSubAgentPrompt(
        { kind: 'plan', slug: 'sample', repo: 'packages/api' },
        step,
        1,
      );
      assert.ok(child.includes(planOwnerText('sample', 'packages/api')));
      assert.ok(child.includes('`packages/api:sample`'));
      assert.strictEqual(
        buildSubAgentPrompt({ kind: 'plan', slug: 'sample' }, step, 1),
        buildSubAgentPrompt({ kind: 'plan', slug: 'sample', repo: '.' }, step, 1),
      );
    }
  });

  it('keeps the phase grammar unchanged without repository context', () => {
    const prompt = buildSystemPrompt(WORKSPACE);
    assert.ok(prompt.includes('Phase line grammar (tech-sheet section 5):\n- Each phase line has the shape `- [<state>] <id> <title>`, optionally followed by ` (<hints>)` as the last thing on the line.'));
    assert.ok(!prompt.includes(REPO_HINT_GRAMMAR_LINE));
    assert.ok(prompt.includes('Phased Plan flow:'));
    assert.ok(!prompt.includes(DRIVE_TEXT));
  });
});
