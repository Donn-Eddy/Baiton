import * as assert from 'assert';
import { DEFAULT_MODE, RUN_MODES, RunMode, isSpecless } from '../src/model/mode';
import {
  ASK_USER_TEXT,
  ConversationKind,
  MODE_PROPOSAL_TEXT,
  PROHIBITION_LINES,
  REFUSAL_TEXT,
  RUN_FLOW_TEXT,
  RUN_ROLE_TEXT,
  RUN_SCOPE_TEXT,
  buildSystemPrompt,
  phaseFor,
} from '../src/orchestrator/systemPrompt';

/**
 * Unit tests for the mode-scoped system prompt (T10).
 *
 * Coverage:
 * - Spec output is byte-for-byte unchanged when `mode` is absent, `'spec'` or
 *   `DEFAULT_MODE`, for a workspace conversation and for a draft, approved and
 *   contentless spec conversation.
 * - `phaseFor` maps every spec-less mode on a workspace conversation to the
 *   single `run` phase, and Spec mode to today's `gather`.
 * - A spec conversation ignores the mode entirely: its gather/drive split and
 *   its prompt are unchanged by any mode value.
 * - The run prompt's content per mode: run role and scope text, the unchanged
 *   refusal and `ask_user` guidance, every prohibition line, the mode's own
 *   flow text, the mode-proposal paragraph and the style rules — and none of
 *   the spec flow, drive table, todo grammar, frontmatter rules or spec
 *   content.
 * - Each mode names its own dispatch tool and framing.
 * - Every spec-less mode has non-empty flow text, and only those.
 * - The builder stays pure: two calls return strictly equal strings.
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

/** Every mode whose conversation is in the `run` phase. */
const SPECLESS_MODES = RUN_MODES.filter(
  (mode): mode is Exclude<RunMode, 'spec'> => mode !== 'spec',
);

describe('mode-scoped system prompt: Spec output is unchanged', () => {
  it('builds an identical workspace prompt with no mode, "spec" and DEFAULT_MODE', () => {
    assert.strictEqual(buildSystemPrompt(WORKSPACE), buildSystemPrompt(WORKSPACE, undefined, 'spec'));
    assert.strictEqual(
      buildSystemPrompt(WORKSPACE),
      buildSystemPrompt(WORKSPACE, undefined, DEFAULT_MODE),
    );
  });

  it('builds an identical draft-spec prompt with no mode, "spec" and DEFAULT_MODE', () => {
    assert.strictEqual(
      buildSystemPrompt(SPEC, DRAFT_SPEC),
      buildSystemPrompt(SPEC, DRAFT_SPEC, 'spec'),
    );
    assert.strictEqual(
      buildSystemPrompt(SPEC, DRAFT_SPEC),
      buildSystemPrompt(SPEC, DRAFT_SPEC, DEFAULT_MODE),
    );
  });

  it('builds an identical approved-spec prompt with no mode, "spec" and DEFAULT_MODE', () => {
    assert.strictEqual(
      buildSystemPrompt(SPEC, APPROVED_SPEC),
      buildSystemPrompt(SPEC, APPROVED_SPEC, 'spec'),
    );
    assert.strictEqual(
      buildSystemPrompt(SPEC, APPROVED_SPEC),
      buildSystemPrompt(SPEC, APPROVED_SPEC, DEFAULT_MODE),
    );
  });

  it('builds an identical contentless-spec prompt with no mode, "spec" and DEFAULT_MODE', () => {
    assert.strictEqual(buildSystemPrompt(SPEC), buildSystemPrompt(SPEC, undefined, 'spec'));
    assert.strictEqual(buildSystemPrompt(SPEC), buildSystemPrompt(SPEC, undefined, DEFAULT_MODE));
  });
});

describe('mode-scoped system prompt: phaseFor mapping', () => {
  it('keeps a Spec-mode workspace conversation in gather', () => {
    assert.strictEqual(phaseFor(WORKSPACE), 'gather');
    assert.strictEqual(phaseFor(WORKSPACE, undefined, 'spec'), 'gather');
    assert.strictEqual(phaseFor(WORKSPACE, undefined, DEFAULT_MODE), 'gather');
  });

  for (const mode of SPECLESS_MODES) {
    it(`maps a ${mode} workspace conversation to the run phase`, () => {
      assert.strictEqual(phaseFor(WORKSPACE, undefined, mode), 'run');
      // Spec content is irrelevant for a workspace conversation.
      assert.strictEqual(phaseFor(WORKSPACE, APPROVED_SPEC, mode), 'run');
    });
  }

  it('maps every known mode, so a new RunMode is forced into this test', () => {
    for (const mode of RUN_MODES) {
      assert.strictEqual(
        phaseFor(WORKSPACE, undefined, mode),
        isSpecless(mode) ? 'run' : 'gather',
        `mode ${mode}`,
      );
    }
  });
});

describe('mode-scoped system prompt: a spec conversation is always Spec', () => {
  for (const mode of SPECLESS_MODES) {
    it(`ignores mode ${mode} on a spec conversation`, () => {
      assert.strictEqual(phaseFor(SPEC, DRAFT_SPEC, mode), 'gather');
      assert.strictEqual(phaseFor(SPEC, APPROVED_SPEC, mode), 'drive');
      assert.strictEqual(phaseFor(SPEC, undefined, mode), 'gather');
      assert.strictEqual(
        buildSystemPrompt(SPEC, APPROVED_SPEC, mode),
        buildSystemPrompt(SPEC, APPROVED_SPEC),
      );
    });
  }
});

describe('mode-scoped system prompt: run prompt content', () => {
  for (const mode of SPECLESS_MODES) {
    it(`assembles the ${mode} run prompt from the run-phase sections`, () => {
      const prompt = buildSystemPrompt(WORKSPACE, undefined, mode);
      assert.ok(prompt.includes(RUN_ROLE_TEXT), 'run role text');
      assert.ok(prompt.includes(RUN_SCOPE_TEXT), 'run scope text');
      assert.ok(prompt.includes(REFUSAL_TEXT), 'refusal text');
      assert.ok(prompt.includes(ASK_USER_TEXT), 'ask_user text');
      assert.ok(prompt.includes(RUN_FLOW_TEXT[mode]), 'flow text');
      assert.ok(prompt.includes(MODE_PROPOSAL_TEXT), 'mode proposal text');
      for (const line of PROHIBITION_LINES) {
        assert.ok(prompt.includes(line), `prohibition: ${line}`);
      }
      assert.match(prompt, /read tools/i);
      assert.match(prompt, /Answer first/);
    });

    it(`omits every spec-only section from the ${mode} run prompt`, () => {
      const prompt = buildSystemPrompt(WORKSPACE, undefined, mode);
      assert.ok(!/draft_spec/.test(prompt), 'no spec flow');
      assert.ok(!/submit_pr/.test(prompt), 'no drive stage table');
      assert.ok(!/Todo line grammar/.test(prompt), 'no todo grammar');
      assert.ok(!/Spec frontmatter rules/.test(prompt), 'no frontmatter rules');
      assert.ok(!prompt.includes('Current spec file content:'), 'no spec content block');
    });
  }
});

describe('mode-scoped system prompt: each mode names its own tool and framing', () => {
  for (const mode of ['bug', 'quick', 'refactor'] as const) {
    it(`points ${mode} at start_run with its own mode value`, () => {
      const prompt = buildSystemPrompt(WORKSPACE, undefined, mode);
      assert.match(prompt, /`start_run`/);
      assert.match(prompt, new RegExp(`mode: "${mode}"`));
      assert.ok(
        !/call `investigate`/i.test(RUN_FLOW_TEXT[mode]),
        'a build mode never dispatches through investigate',
      );
    });
  }

  it('points investigate at the investigate tool only', () => {
    const prompt = buildSystemPrompt(WORKSPACE, undefined, 'investigate');
    assert.match(prompt, /`investigate`/);
    assert.ok(!/start_run/.test(RUN_FLOW_TEXT.investigate), 'investigate never calls start_run');
  });

  it('names reproduction in the bug flow', () => {
    assert.match(RUN_FLOW_TEXT.bug, /reproduc/i);
  });

  it('names behaviour preservation and the verify command in the refactor flow', () => {
    assert.match(RUN_FLOW_TEXT.refactor, /not change behaviour/i);
    assert.match(RUN_FLOW_TEXT.refactor, /verify/i);
  });

  it('names the one-small-change rule in the quick flow', () => {
    assert.match(RUN_FLOW_TEXT.quick, /small, self-contained/i);
  });

  it('says an investigation writes nothing', () => {
    assert.match(RUN_FLOW_TEXT.investigate, /changes nothing|read-only/i);
  });
});

describe('mode-scoped system prompt: mode proposal', () => {
  for (const mode of SPECLESS_MODES) {
    it(`tells the ${mode} prompt to propose a different mode through ask_user`, () => {
      const prompt = buildSystemPrompt(WORKSPACE, undefined, mode);
      assert.match(prompt, /propose the mode that does with `ask_user`/);
    });
  }

  it('names all five modes', () => {
    for (const name of ['Spec', 'Bug', 'Quick', 'Refactor', 'Investigate']) {
      assert.ok(MODE_PROPOSAL_TEXT.includes(name), `names ${name}`);
    }
  });
});

describe('mode-scoped system prompt: every spec-less mode has flow text', () => {
  it('has non-empty flow text for each spec-less mode and for no other', () => {
    for (const mode of RUN_MODES) {
      if (mode === 'spec') {
        assert.ok(!isSpecless(mode), 'spec is the only non-spec-less mode');
        continue;
      }
      const text = RUN_FLOW_TEXT[mode];
      assert.ok(typeof text === 'string' && text.trim().length > 0, `flow text for ${mode}`);
    }
    assert.strictEqual(Object.keys(RUN_FLOW_TEXT).length, RUN_MODES.length - 1);
  });
});

describe('mode-scoped system prompt: purity', () => {
  it('returns strictly equal strings for repeated calls', () => {
    assert.strictEqual(
      buildSystemPrompt(WORKSPACE, undefined, 'bug'),
      buildSystemPrompt(WORKSPACE, undefined, 'bug'),
    );
  });
});
