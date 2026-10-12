import * as assert from 'assert';
import {
  ASK_USER_TEXT,
  buildSystemPrompt,
  ConversationKind,
  DRIVE_TEXT,
  PROHIBITION_LINES,
  REFUSAL_TEXT,
  SCOPE_TEXT,
  conversationStepFor,
} from '../src/orchestrator/systemPrompt';

/**
 * Unit tests for the system-prompt builder.
 *
 * `buildSystemPrompt` is a host-free pure core (no `vscode` import), so these
 * tests exercise it directly. They assert the section-7 role text and
 * Phased Plan flow, the section-5 phase grammar (the eight states, P ids and
 * legacy T ids, and the `after`/`files` hint groups), the section-5 frontmatter
 * rules (the `status`/`mode` enums and extension-written keys), and that a
 * plan conversation includes supplied document content when present.
 *
 * Coverage:
 * - Role text: never edits source, writes only through plan-writing tools,
 *   reads only through read tools — Req 11.1.
 * - Scope: the two jobs and the work that is not the orchestrator's, present
 *   in both conversation steps; the refusal rule — Req 11.1.
 * - Conversation-step split: `conversationStepFor` over the frontmatter `status`, the drive-step
 *   stage table in a driven plan only, the Phased Plan flow while gathering
 *   only — Req 11.1.
 * - Ask / propose / `draft_plan`-after-agreement flow — Req 11.2.
 * - Phase grammar, eight states, id form, hint groups — Req 11.3.
 * - Frontmatter rules, status/mode enums, extension-written keys — Req 11.4.
 * - Plan document content included when supplied — Req 11.5.
 * - Plan document content omitted without error when absent — Req 11.7.
 * - `ask_user` guidance: present verbatim in every phase, naming the tool,
 *   its options/allow_free_text knobs, the blocking call and the
 *   decline-is-a-refusal rule; the style bullet points at the tool.
 */

const WORKSPACE: ConversationKind = { kind: 'workspace' };
// 'plan' is the legacy persisted conversation kind.
const PLAN: ConversationKind = { kind: 'plan', slug: 'my-plan' };

/** A plan document with the given frontmatter `status`. */
function planWithStatus(status: string): string {
  return [
    '---',
    'version: 1',
    'name: my-plan',
    `status: ${status}`,
    '---',
    '',
    '# Endstate',
    '',
    'The desired result exists.',
    '',
    '# What needs changing',
    '',
    'Update the implementation.',
    '',
    '# Limitations & constraints',
    '',
    'Preserve compatibility.',
    '',
    '# PHASES',
    '',
    '- [pending] P01 Do the first thing',
    '',
  ].join('\n');
}

/** A legacy plan document with the given frontmatter `status`. */
function legacySpecWithStatus(status: string): string {
  return [
    '---',
    'version: 1',
    'name: my-plan',
    `status: ${status}`,
    '---',
    '',
    '# OVERVIEW',
    '',
    'Something worth doing.',
    '',
    '# TODOS',
    '',
    '- [pending] T01 Do the first thing',
    '',
  ].join('\n');
}

const DRAFT_PLAN = planWithStatus('draft');
const APPROVED_PLAN = planWithStatus('approved');
const APPROVED_LEGACY_SPEC = legacySpecWithStatus('approved');

const PHASE_STATES = [
  'pending',
  'planning',
  'planned',
  'executing',
  'executed',
  'reviewing',
  'done',
  'failed',
];
const STATUS_VALUES = ['draft', 'approved', 'in-progress', 'review', 'pr', 'pr-partial', 'done'];
const MODE_VALUES = ['manual', 'auto'];
const EXTENSION_WRITTEN_KEYS = ['base', 'base_commit', 'branch', 'approved_rev', 'pr', 'prs'];

describe('buildSystemPrompt', () => {
  describe('role text (Req 11.1)', () => {
    it('states the orchestrator never edits source', () => {
      const prompt = buildSystemPrompt(WORKSPACE);
      assert.match(prompt, /never edits? source/i);
    });

    it('states writes go only through the plan-writing tools', () => {
      const prompt = buildSystemPrompt(WORKSPACE);
      assert.match(prompt, /plan-writing tools/i);
      assert.ok(prompt.includes('`.baiton/plans/**`'));
    });

    it('states the repository is inspected only through the read tools', () => {
      const prompt = buildSystemPrompt(WORKSPACE);
      assert.match(prompt, /read tools/i);
    });
  });

  describe('Phased Plan flow (Req 11.2)', () => {
    it('states the ask / restatement / agreement / draft_plan flow', () => {
      const prompt = buildSystemPrompt(WORKSPACE);
      assert.match(prompt, /clarifying questions/i);
      assert.match(prompt, /draft_plan/);
      assert.match(prompt, /agree/i);
      for (const part of ['Endstate', 'What needs changing', 'Limitations & constraints']) {
        assert.ok(prompt.includes(part), `prompt should mention "${part}"`);
      }
      assert.match(prompt, /revise it until they agree/i);
      assert.ok(
        prompt.indexOf('Restate the change') < prompt.indexOf('call `draft_plan`'),
        'the restatement comes before draft_plan',
      );
    });

    it('forbids the orchestrator from proposing the phases itself', () => {
      const prompt = buildSystemPrompt(WORKSPACE);
      assert.match(prompt, /never propose the phases yourself/i);
    });

    it('tells the user where the draft is written and where to watch it', () => {
      const prompt = buildSystemPrompt(WORKSPACE);
      assert.match(prompt, /harness|plan-writer agent/i);
      assert.match(prompt, /watch/i);
      assert.match(prompt, /Plan Explorer/);
    });

    it('no longer mentions the removed create_spec tool', () => {
      const prompt = buildSystemPrompt(WORKSPACE);
      assert.ok(!prompt.includes('create_spec'), 'prompt must not advertise create_spec');
      assert.ok(!prompt.includes('requirements document'));
    });
  });

  describe('style guidance', () => {
    it('tells the orchestrator to answer first', () => {
      const prompt = buildSystemPrompt(WORKSPACE);
      assert.match(prompt, /answer first/i);
    });

    it("tells it not to restate the user's request", () => {
      const prompt = buildSystemPrompt(WORKSPACE);
      assert.match(prompt, /not restate the user's request/i);
    });

    it('tells it not to summarize tool output the user can expand', () => {
      const prompt = buildSystemPrompt(WORKSPACE);
      assert.match(prompt, /not summarize tool output/i);
      assert.match(prompt, /expand/i);
    });

    it('bounds replies to a few sentences, excepting the restatement', () => {
      const prompt = buildSystemPrompt(WORKSPACE);
      assert.match(prompt, /few sentences/i);
      assert.match(prompt, /restatement, which you present in full/i);
    });

    it('asks for one clarifying question at a time', () => {
      const prompt = buildSystemPrompt(WORKSPACE);
      assert.match(prompt, /one clarifying question at a time/i);
    });

    it('carries the style guidance in a plan conversation too', () => {
      const prompt = buildSystemPrompt(PLAN, '# PHASES');
      assert.match(prompt, /answer first/i);
    });
  });

  describe('phase grammar (Req 11.3)', () => {
    it('includes the `- [<state>] <id> <title>` line shape', () => {
      const prompt = buildSystemPrompt(WORKSPACE);
      assert.ok(
        prompt.includes('- [<state>] <id> <title>'),
        'prompt should include the phase line shape',
      );
    });

    it('includes all eight allowed states', () => {
      const prompt = buildSystemPrompt(WORKSPACE);
      for (const state of PHASE_STATES) {
        assert.ok(prompt.includes(state), `prompt should mention state "${state}"`);
      }
    });

    it('describes plan P ids and legacy plan T ids', () => {
      const prompt = buildSystemPrompt(WORKSPACE);
      assert.match(prompt, /`P`.*two or more digits/i);
      assert.match(prompt, /legacy spec[^\n]*`T` ids/i);
    });

    it('describes the `after` and `files:` hint groups separated by `;`', () => {
      const prompt = buildSystemPrompt(WORKSPACE);
      assert.match(prompt, /after/);
      assert.match(prompt, /files:/);
      assert.ok(
        prompt.includes('separated by `;`'),
        'prompt should describe hint groups separated by `;`',
      );
    });
  });

  describe('frontmatter rules (Req 11.4)', () => {
    it('states frontmatter is a flat key: value block with no nesting', () => {
      const prompt = buildSystemPrompt(WORKSPACE);
      assert.match(prompt, /flat `key: value` block/i);
      assert.match(prompt, /no nesting/i);
    });

    it('includes all allowed status values', () => {
      const prompt = buildSystemPrompt(WORKSPACE);
      for (const value of STATUS_VALUES) {
        assert.ok(prompt.includes(value), `prompt should mention status "${value}"`);
      }
    });

    it('includes all allowed mode values', () => {
      const prompt = buildSystemPrompt(WORKSPACE);
      for (const value of MODE_VALUES) {
        assert.ok(prompt.includes(value), `prompt should mention mode "${value}"`);
      }
    });

    it('names the extension-written frontmatter keys', () => {
      const prompt = buildSystemPrompt(WORKSPACE);
      for (const key of EXTENSION_WRITTEN_KEYS) {
        assert.ok(prompt.includes(key), `prompt should mention key "${key}"`);
      }
    });
  });

  describe('plan document content inclusion (Req 11.5, 11.7)', () => {
    it('includes supplied plan content in a plan conversation', () => {
      const content = planWithStatus('draft');
      const prompt = buildSystemPrompt(PLAN, content);
      assert.ok(prompt.includes(content), 'prompt should embed the supplied plan content');
    });

    it('builds without error and omits content when absent for a plan conversation', () => {
      const prompt = buildSystemPrompt(PLAN);
      assert.ok(typeof prompt === 'string' && prompt.length > 0);
      // The role text and grammar are still present even without plan content.
      assert.match(prompt, /never edits? source/i);
      assert.ok(prompt.includes('- [<state>] <id> <title>'));
    });

    it('ignores document content for a workspace conversation', () => {
      const marker = 'WORKSPACE_SHOULD_NOT_EMBED_THIS';
      const prompt = buildSystemPrompt(WORKSPACE, marker);
      assert.ok(!prompt.includes(marker), 'workspace prompt should not embed document content');
    });
  });

  describe('scope (Req 11.1)', () => {
    const PROMPTS: Array<[string, string]> = [
      ['workspace', buildSystemPrompt(WORKSPACE)],
      ['a draft plan', buildSystemPrompt(PLAN, DRAFT_PLAN)],
      ['an approved plan', buildSystemPrompt(PLAN, APPROVED_PLAN)],
      ['a plan with no content', buildSystemPrompt(PLAN)],
    ];

    for (const [label, prompt] of PROMPTS) {
      it(`states the two jobs and the prohibitions in ${label}`, () => {
        assert.ok(prompt.includes(SCOPE_TEXT), 'the scope text is present verbatim');
        for (const line of PROHIBITION_LINES) {
          assert.ok(prompt.includes(line), `the prompt states "${line}" verbatim`);
        }
      });

      it(`states the refusal rule in ${label}`, () => {
        assert.ok(prompt.includes(REFUSAL_TEXT), 'the refusal text is present verbatim');
      });
    }

    it('names both jobs with the tool that ends each', () => {
      assert.match(SCOPE_TEXT, /exactly two jobs/i);
      assert.match(SCOPE_TEXT, /clarifying questions/i);
      assert.match(SCOPE_TEXT, /agree/i);
      assert.ok(SCOPE_TEXT.includes('`draft_plan`'), 'job one ends at draft_plan');
      assert.ok(SCOPE_TEXT.includes('`run`'), 'job two dispatches with run');
      assert.ok(SCOPE_TEXT.includes('`submit_pr`'), 'job two ends at submit_pr');
      assert.ok(SCOPE_TEXT.includes('`land_phase`'), 'job two lands each done phase');
      assert.match(SCOPE_TEXT, /phased plan/i);
    });

    it('says a configured coding agent does the work it refuses', () => {
      assert.ok(
        PROHIBITION_LINES.includes('A configured coding agent does each of those when you dispatch it.'),
        'the prohibitions say who does the work instead',
      );
    });

    it('tells the orchestrator to quote a refusal and stop, not to work around it', () => {
      assert.match(REFUSAL_TEXT, /quote the refusal/i);
      assert.match(REFUSAL_TEXT, /stop/i);
      assert.match(REFUSAL_TEXT, /do not diagnose/i);
      assert.match(REFUSAL_TEXT, /different stage/i);
      assert.match(REFUSAL_TEXT, /read files to work around it/i);
    });
  });

  describe('ask_user guidance', () => {
    for (const [label, prompt] of [
      ['workspace', buildSystemPrompt(WORKSPACE)],
      ['a draft plan', buildSystemPrompt(PLAN, DRAFT_PLAN)],
      ['an approved plan', buildSystemPrompt(PLAN, APPROVED_PLAN)],
      ['a plan with no content', buildSystemPrompt(PLAN)],
    ] as Array<[string, string]>) {
      it(`carries the ask_user guidance verbatim in ${label}`, () => {
        assert.ok(prompt.includes(ASK_USER_TEXT), 'the ask_user text is present verbatim');
      });
    }

    it('tells the model to call ask_user instead of ending the turn with a question', () => {
      assert.match(ASK_USER_TEXT, /instead of ending your turn with a question/i);
      assert.ok(ASK_USER_TEXT.includes('`ask_user`'), 'the text names the ask_user tool');
    });

    it('describes options, allow_free_text and the blocking call', () => {
      assert.ok(ASK_USER_TEXT.includes('options'), 'the text mentions options');
      assert.ok(ASK_USER_TEXT.includes('allow_free_text'), 'the text mentions allow_free_text');
      assert.match(ASK_USER_TEXT, /blocks until the user answers/i);
    });

    it('makes a decline a refusal', () => {
      assert.match(ASK_USER_TEXT, /declines/i);
      assert.match(ASK_USER_TEXT, /refus/i);
    });

    it('styles the one-question-at-a-time rule through the tool', () => {
      assert.match(buildSystemPrompt(WORKSPACE), /one clarifying question at a time with `ask_user`/i);
    });
  });

  describe('conversation-step split (Req 11.1)', () => {
    it('conversationStepFor is gather for a workspace conversation', () => {
      assert.strictEqual(conversationStepFor(WORKSPACE), 'gather');
      assert.strictEqual(conversationStepFor(WORKSPACE, APPROVED_PLAN), 'gather');
    });

    it('conversationStepFor is gather for a draft plan and for missing content', () => {
      assert.strictEqual(conversationStepFor(PLAN, DRAFT_PLAN), 'gather');
      assert.strictEqual(conversationStepFor(PLAN), 'gather');
      assert.strictEqual(conversationStepFor(PLAN, ''), 'gather');
      assert.strictEqual(conversationStepFor(PLAN, 'not a plan at all'), 'gather');
      assert.strictEqual(conversationStepFor(PLAN, '---\nstatus: nonsense\n---\n'), 'gather');
    });

    it('conversationStepFor is drive for every status past draft', () => {
      for (const status of ['approved', 'in-progress', 'review', 'pr', 'done']) {
        assert.strictEqual(
          conversationStepFor(PLAN, planWithStatus(status)),
          'drive',
          `status "${status}" is driven`,
        );
      }
    });

    it('conversationStepFor is drive for an approved legacy plan document too', () => {
      assert.strictEqual(conversationStepFor(PLAN, APPROVED_LEGACY_SPEC), 'drive');
      assert.ok(buildSystemPrompt(PLAN, APPROVED_LEGACY_SPEC).includes(DRIVE_TEXT));
    });

    it('includes the drive text only for a plan past draft', () => {
      const driving = buildSystemPrompt(PLAN, APPROVED_PLAN);
      assert.ok(driving.includes(DRIVE_TEXT), 'an approved plan carries the drive text');
      for (const [label, prompt] of [
        ['workspace', buildSystemPrompt(WORKSPACE)],
        ['a draft plan', buildSystemPrompt(PLAN, DRAFT_PLAN)],
        ['a plan with no content', buildSystemPrompt(PLAN)],
      ] as Array<[string, string]>) {
        assert.ok(!prompt.includes(DRIVE_TEXT), `${label} carries no drive text`);
      }
    });

    it('includes the Phased Plan flow only while gathering', () => {
      const gathering = buildSystemPrompt(PLAN, DRAFT_PLAN);
      assert.match(gathering, /Phased Plan flow:/);
      const driving = buildSystemPrompt(PLAN, APPROVED_PLAN);
      assert.ok(!driving.includes('Phased Plan flow:'), 'a driven plan is past the gather flow');
    });

    it('gives the next legal stage for each phase state while driving', () => {
      assert.ok(DRIVE_TEXT.includes('`pending` -> `run` the `plan` stage.'));
      assert.ok(DRIVE_TEXT.includes('`planned` -> `run` the `execute` stage.'));
      assert.ok(DRIVE_TEXT.includes('`executed` -> `run` the `review` stage.'));
      assert.match(DRIVE_TEXT, /review that sends the phase back.*`execute`/);
      assert.match(DRIVE_TEXT, /`done` \(unlanded\) -> `land_phase`/);
    });

    it('offers submit_pr only once every phase is done and landed', () => {
      assert.match(DRIVE_TEXT, /every phase is `done` and landed/);
      assert.match(DRIVE_TEXT, /`submit_pr` refuses while any phase is unlanded/);
      assert.match(DRIVE_TEXT, /after.*done and landed/);
    });

    it('mentions land_phase only in the drive prompt, never the run prompt', () => {
      assert.ok(buildSystemPrompt(PLAN, APPROVED_PLAN).includes('`land_phase`'));
      assert.ok(!buildSystemPrompt(WORKSPACE, undefined, 'bug').includes('land_phase'));
    });

    it('states that run blocks and leaves nothing to poll or read', () => {
      assert.match(DRIVE_TEXT, /`run` blocks until the stage finishes/);
      assert.match(DRIVE_TEXT, /nothing to poll/i);
      assert.match(DRIVE_TEXT, /one phase at a time/i);
      assert.match(DRIVE_TEXT, /`submit_pr`/);
    });

    it('does not advertise plan-review as a stage to run', () => {
      const driving = buildSystemPrompt(PLAN, APPROVED_PLAN);
      assert.ok(!driving.includes('plan-review'), 'plan-review is not a stage the orchestrator runs');
    });
  });
});
