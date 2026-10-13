import * as assert from 'assert';
import type { RunMode } from '../src/model/mode';
import {
  buildSystemPrompt,
  type ConversationKind,
  DRIVE_TEXT,
  REPO_DRIVE_TEXT,
  REPO_GATHER_TEXT,
  REPO_HINT_GRAMMAR_LINE,
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
    const kinds = [WORKSPACE, PLAN];
    const contents = [undefined, DRAFT, APPROVED];
    for (const kind of kinds) {
      for (const content of contents) {
        for (const mode of MODES) {
          const without = buildSystemPrompt(kind, content, mode);
          assert.strictEqual(buildSystemPrompt(kind, content, mode, undefined), without);
          assert.strictEqual(
            buildSystemPrompt(kind, content, mode, { repos: [{ path: '.', hasBaiton: true }] }),
            without,
          );
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

  it('leaves run-step prompts unchanged when repo context is supplied', () => {
    assert.strictEqual(
      buildSystemPrompt(WORKSPACE, undefined, 'bug', REPOS),
      buildSystemPrompt(WORKSPACE, undefined, 'bug'),
    );
  });

  it('keeps the phase grammar unchanged without repository context', () => {
    const prompt = buildSystemPrompt(WORKSPACE);
    assert.ok(prompt.includes('Phase line grammar (tech-sheet section 5):\n- Each phase line has the shape `- [<state>] <id> <title>`, optionally followed by ` (<hints>)` as the last thing on the line.'));
    assert.ok(!prompt.includes(REPO_HINT_GRAMMAR_LINE));
    assert.ok(prompt.includes('Phased Plan flow:'));
    assert.ok(!prompt.includes(DRIVE_TEXT));
  });
});
