import * as assert from 'assert';
import {
  ASK_USER_TEXT,
  buildSystemPrompt,
  ConversationKind,
  DRIVE_TEXT,
  PROHIBITION_LINES,
  REFUSAL_TEXT,
  SCOPE_TEXT,
  phaseFor,
} from '../src/orchestrator/systemPrompt';

/**
 * Unit tests for the system-prompt builder (Task 3.2).
 *
 * `buildSystemPrompt` is a host-free pure core (no `vscode` import), so these
 * tests exercise it directly. They assert the section-7 role text and
 * new-spec flow, the section-5 todo grammar (the eight states, the `T`+digits
 * id form, and the `after`/`files` hint groups), the section-5 frontmatter
 * rules (the `status`/`mode` enums and the extension-written keys), and that a
 * spec conversation includes supplied `spec.md` content while building without
 * it and without error when absent.
 *
 * Coverage:
 * - Role text: never edits source, writes only through spec-writing tools,
 *   reads only through read tools — Req 11.1.
 * - Scope: the two jobs and the work that is not the orchestrator's, present
 *   in both phases; the refusal rule — Req 11.1.
 * - Phase split: `phaseFor` over the frontmatter `status`, the drive-phase
 *   stage table in a driven spec only, the new-spec flow while gathering
 *   only — Req 11.1.
 * - Ask / propose / `create_spec`-after-agreement flow — Req 11.2.
 * - Todo grammar, eight states, id form, hint groups — Req 11.3.
 * - Frontmatter rules, status/mode enums, extension-written keys — Req 11.4.
 * - Spec content included when supplied — Req 11.5.
 * - Spec content omitted without error when absent — Req 11.7.
 * - `ask_user` guidance: present verbatim in every phase, naming the tool,
 *   its options/allow_free_text knobs, the blocking call and the
 *   decline-is-a-refusal rule; the style bullet points at the tool.
 */

const WORKSPACE: ConversationKind = { kind: 'workspace' };
const SPEC: ConversationKind = { kind: 'spec', slug: 'my-spec' };

/** A spec file with the given frontmatter `status`. */
function specWithStatus(status: string): string {
  return [
    '---',
    'version: 1',
    'name: my-spec',
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

const DRAFT_SPEC = specWithStatus('draft');
const APPROVED_SPEC = specWithStatus('approved');

const TODO_STATES = [
  'pending',
  'planning',
  'planned',
  'executing',
  'executed',
  'reviewing',
  'done',
  'failed',
];
const STATUS_VALUES = ['draft', 'approved', 'in-progress', 'review', 'pr', 'done'];
const MODE_VALUES = ['manual', 'auto'];
const EXTENSION_WRITTEN_KEYS = ['base', 'base_commit', 'branch', 'approved_rev', 'pr'];

describe('buildSystemPrompt', () => {
  describe('role text (Req 11.1)', () => {
    it('states the orchestrator never edits source', () => {
      const prompt = buildSystemPrompt(WORKSPACE);
      assert.match(prompt, /never edits? source/i);
    });

    it('states writes go only through the spec-writing tools', () => {
      const prompt = buildSystemPrompt(WORKSPACE);
      assert.match(prompt, /spec-writing tools/i);
    });

    it('states the repository is inspected only through the read tools', () => {
      const prompt = buildSystemPrompt(WORKSPACE);
      assert.match(prompt, /read tools/i);
    });
  });

  describe('new-spec flow (Req 11.2)', () => {
    it('states the ask / requirements-document / agreement / draft_spec flow', () => {
      const prompt = buildSystemPrompt(WORKSPACE);
      assert.match(prompt, /clarifying questions/i);
      assert.match(prompt, /requirements document/i);
      assert.match(prompt, /draft_spec/);
      assert.match(prompt, /agree/i);
    });

    it('names the parts a requirements document must cover', () => {
      const prompt = buildSystemPrompt(WORKSPACE);
      for (const part of ['goal', 'constraints', 'acceptance criteria', 'files of interest']) {
        assert.ok(prompt.includes(part), `prompt should mention "${part}"`);
      }
    });

    it('forbids the orchestrator from proposing the todo list itself', () => {
      const prompt = buildSystemPrompt(WORKSPACE);
      assert.match(prompt, /never propose the todo list yourself/i);
    });

    it('tells the user where the draft is written and where to watch it', () => {
      const prompt = buildSystemPrompt(WORKSPACE);
      assert.match(prompt, /harness|spec-writer agent/i);
      assert.match(prompt, /watch/i);
    });

    it('no longer mentions the removed create_spec tool', () => {
      const prompt = buildSystemPrompt(WORKSPACE);
      assert.ok(!prompt.includes('create_spec'), 'prompt must not advertise create_spec');
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

    it('bounds replies to a few sentences, excepting a requirements document', () => {
      const prompt = buildSystemPrompt(WORKSPACE);
      assert.match(prompt, /few sentences/i);
      assert.match(prompt, /requirements document/i);
    });

    it('asks for one clarifying question at a time', () => {
      const prompt = buildSystemPrompt(WORKSPACE);
      assert.match(prompt, /one clarifying question at a time/i);
    });

    it('carries the style guidance in a spec conversation too', () => {
      const prompt = buildSystemPrompt(SPEC, '# OVERVIEW');
      assert.match(prompt, /answer first/i);
    });
  });

  describe('todo grammar (Req 11.3)', () => {
    it('includes the `- [<state>] <id> <title>` line shape', () => {
      const prompt = buildSystemPrompt(WORKSPACE);
      assert.ok(
        prompt.includes('- [<state>] <id> <title>'),
        'prompt should include the todo line shape',
      );
    });

    it('includes all eight allowed states', () => {
      const prompt = buildSystemPrompt(WORKSPACE);
      for (const state of TODO_STATES) {
        assert.ok(prompt.includes(state), `prompt should mention state "${state}"`);
      }
    });

    it('describes the `T`-plus-two-or-more-digits id form', () => {
      const prompt = buildSystemPrompt(WORKSPACE);
      assert.match(prompt, /`T`.*two or more digits/i);
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

  describe('spec content inclusion (Req 11.5, 11.7)', () => {
    it('includes supplied spec content in a spec conversation', () => {
      const content = '---\nstatus: draft\n---\n\n# OVERVIEW\n\n- [pending] T01 Do the thing';
      const prompt = buildSystemPrompt(SPEC, content);
      assert.ok(prompt.includes(content), 'prompt should embed the supplied spec content');
    });

    it('builds without error and omits content when absent for a spec conversation', () => {
      const prompt = buildSystemPrompt(SPEC);
      assert.ok(typeof prompt === 'string' && prompt.length > 0);
      // The role text and grammar are still present even without spec content.
      assert.match(prompt, /never edits? source/i);
      assert.ok(prompt.includes('- [<state>] <id> <title>'));
    });

    it('ignores spec content for a workspace conversation', () => {
      const marker = 'WORKSPACE_SHOULD_NOT_EMBED_THIS';
      const prompt = buildSystemPrompt(WORKSPACE, marker);
      assert.ok(!prompt.includes(marker), 'workspace prompt should not embed spec content');
    });
  });

  describe('scope (Req 11.1)', () => {
    const PROMPTS: Array<[string, string]> = [
      ['workspace', buildSystemPrompt(WORKSPACE)],
      ['a draft spec', buildSystemPrompt(SPEC, DRAFT_SPEC)],
      ['an approved spec', buildSystemPrompt(SPEC, APPROVED_SPEC)],
      ['a spec with no content', buildSystemPrompt(SPEC)],
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
      assert.ok(SCOPE_TEXT.includes('`draft_spec`'), 'job one ends at draft_spec');
      assert.ok(SCOPE_TEXT.includes('`run`'), 'job two dispatches with run');
      assert.ok(SCOPE_TEXT.includes('`submit_pr`'), 'job two ends at submit_pr');
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
      ['a draft spec', buildSystemPrompt(SPEC, DRAFT_SPEC)],
      ['an approved spec', buildSystemPrompt(SPEC, APPROVED_SPEC)],
      ['a spec with no content', buildSystemPrompt(SPEC)],
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

  describe('phase split (Req 11.1)', () => {
    it('phaseFor is gather for a workspace conversation', () => {
      assert.strictEqual(phaseFor(WORKSPACE), 'gather');
      assert.strictEqual(phaseFor(WORKSPACE, APPROVED_SPEC), 'gather');
    });

    it('phaseFor is gather for a draft spec and for missing content', () => {
      assert.strictEqual(phaseFor(SPEC, DRAFT_SPEC), 'gather');
      assert.strictEqual(phaseFor(SPEC), 'gather');
      assert.strictEqual(phaseFor(SPEC, ''), 'gather');
      assert.strictEqual(phaseFor(SPEC, 'not a spec at all'), 'gather');
      assert.strictEqual(phaseFor(SPEC, '---\nstatus: nonsense\n---\n'), 'gather');
    });

    it('phaseFor is drive for every status past draft', () => {
      for (const status of ['approved', 'in-progress', 'review', 'pr', 'done']) {
        assert.strictEqual(
          phaseFor(SPEC, specWithStatus(status)),
          'drive',
          `status "${status}" is driven`,
        );
      }
    });

    it('includes the drive text only for a spec past draft', () => {
      const driving = buildSystemPrompt(SPEC, APPROVED_SPEC);
      assert.ok(driving.includes(DRIVE_TEXT), 'an approved spec carries the drive text');
      for (const [label, prompt] of [
        ['workspace', buildSystemPrompt(WORKSPACE)],
        ['a draft spec', buildSystemPrompt(SPEC, DRAFT_SPEC)],
        ['a spec with no content', buildSystemPrompt(SPEC)],
      ] as Array<[string, string]>) {
        assert.ok(!prompt.includes(DRIVE_TEXT), `${label} carries no drive text`);
      }
    });

    it('includes the new-spec flow only while gathering', () => {
      const gathering = buildSystemPrompt(SPEC, DRAFT_SPEC);
      assert.match(gathering, /New spec flow:/);
      const driving = buildSystemPrompt(SPEC, APPROVED_SPEC);
      assert.ok(!driving.includes('New spec flow:'), 'a driven spec is past the new-spec flow');
    });

    it('gives the next legal stage for each todo state while driving', () => {
      assert.ok(DRIVE_TEXT.includes('`pending` -> `run` the `plan` stage.'));
      assert.ok(DRIVE_TEXT.includes('`planned` -> `run` the `execute` stage.'));
      assert.ok(DRIVE_TEXT.includes('`executed` -> `run` the `review` stage.'));
      assert.match(DRIVE_TEXT, /review that sends the todo back.*`execute`/);
    });

    it('states that run blocks and leaves nothing to poll or read', () => {
      assert.match(DRIVE_TEXT, /`run` blocks until the stage finishes/);
      assert.match(DRIVE_TEXT, /nothing to poll/i);
      assert.match(DRIVE_TEXT, /one todo at a time/i);
      assert.match(DRIVE_TEXT, /`submit_pr`/);
    });

    it('does not advertise plan-review as a stage to run', () => {
      const driving = buildSystemPrompt(SPEC, APPROVED_SPEC);
      assert.ok(!driving.includes('plan-review'), 'plan-review is not a stage the orchestrator runs');
    });
  });
});
