import * as assert from 'assert';
import {
  buildSystemPrompt,
  ConversationKind,
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
 * - Ask / propose / `create_spec`-after-agreement flow — Req 11.2.
 * - Todo grammar, eight states, id form, hint groups — Req 11.3.
 * - Frontmatter rules, status/mode enums, extension-written keys — Req 11.4.
 * - Spec content included when supplied — Req 11.5.
 * - Spec content omitted without error when absent — Req 11.7.
 */

const WORKSPACE: ConversationKind = { kind: 'workspace' };
const SPEC: ConversationKind = { kind: 'spec', slug: 'my-spec' };

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
});
