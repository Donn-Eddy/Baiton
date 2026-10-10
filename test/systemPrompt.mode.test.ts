import * as assert from 'assert';
import { DEFAULT_MODE, RUN_MODES, RunMode, isPlanless } from '../src/model/mode';
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
  conversationStepFor,
} from '../src/orchestrator/systemPrompt';

/**
 * Unit tests for the mode-scoped system prompt.
 *
 * Coverage:
 * - Phased Plan output is byte-for-byte unchanged when `mode` is absent or `'plan'`
 *   (and `DEFAULT_MODE` for plan conversations), for a workspace conversation
 *   and for a draft, approved and contentless plan conversation.
 * - `DEFAULT_MODE` on a workspace conversation is the Default run prompt.
 * - Default's recommend-and-confirm flow text.
 * - `conversationStepFor` maps every plan-less mode on a workspace conversation to the
 *   single `run` step, and Plan mode to today's `gather`.
 * - A plan conversation ignores the mode entirely: its gather/drive split and
 *   its prompt are unchanged by any mode value.
 * - The run prompt's content per mode: run role and scope text, the unchanged
 *   refusal and `ask_user` guidance, every prohibition line, the mode's own
 *   flow text, the mode-proposal paragraph and the style rules — and none of
 *   the Phased Plan flow, drive table, phase grammar, frontmatter rules or plan
 *   document content.
 * - Each mode names its own dispatch tool and framing.
 * - Every plan-less mode has non-empty flow text, and only those.
 * - The builder stays pure: two calls return strictly equal strings.
 */

const WORKSPACE: ConversationKind = { kind: 'workspace' };
// 'spec' is the legacy persisted conversation kind.
const PLAN: ConversationKind = { kind: 'spec', slug: 'my-plan' };

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

const DRAFT_PLAN = planWithStatus('draft');
const APPROVED_PLAN = planWithStatus('approved');

/** Every mode whose conversation is in the `run` step. */
const PLANLESS_MODES = RUN_MODES.filter(
  (mode): mode is Exclude<RunMode, 'plan'> => mode !== 'plan',
);

describe('mode-scoped system prompt: Phased Plan output is unchanged', () => {
  it('builds an identical workspace prompt with no mode and "plan"', () => {
    assert.strictEqual(buildSystemPrompt(WORKSPACE), buildSystemPrompt(WORKSPACE, undefined, 'plan'));
  });

  it('builds the Default run prompt, not the Plan prompt, for DEFAULT_MODE on a workspace conversation', () => {
    assert.strictEqual(DEFAULT_MODE, 'default');
    assert.strictEqual(
      buildSystemPrompt(WORKSPACE, undefined, DEFAULT_MODE),
      buildSystemPrompt(WORKSPACE, undefined, 'default'),
    );
    assert.notStrictEqual(buildSystemPrompt(WORKSPACE, undefined, DEFAULT_MODE), buildSystemPrompt(WORKSPACE));
  });

  it('builds an identical draft-plan prompt with no mode, "plan" and DEFAULT_MODE', () => {
    assert.strictEqual(
      buildSystemPrompt(PLAN, DRAFT_PLAN),
      buildSystemPrompt(PLAN, DRAFT_PLAN, 'plan'),
    );
    assert.strictEqual(
      buildSystemPrompt(PLAN, DRAFT_PLAN),
      buildSystemPrompt(PLAN, DRAFT_PLAN, DEFAULT_MODE),
    );
  });

  it('builds an identical approved-plan prompt with no mode, "plan" and DEFAULT_MODE', () => {
    assert.strictEqual(
      buildSystemPrompt(PLAN, APPROVED_PLAN),
      buildSystemPrompt(PLAN, APPROVED_PLAN, 'plan'),
    );
    assert.strictEqual(
      buildSystemPrompt(PLAN, APPROVED_PLAN),
      buildSystemPrompt(PLAN, APPROVED_PLAN, DEFAULT_MODE),
    );
  });

  it('builds an identical contentless-plan prompt with no mode, "plan" and DEFAULT_MODE', () => {
    assert.strictEqual(buildSystemPrompt(PLAN), buildSystemPrompt(PLAN, undefined, 'plan'));
    assert.strictEqual(buildSystemPrompt(PLAN), buildSystemPrompt(PLAN, undefined, DEFAULT_MODE));
  });
});

describe('mode-scoped system prompt: conversationStepFor mapping', () => {
  it('keeps a Plan-mode workspace conversation in gather', () => {
    assert.strictEqual(conversationStepFor(WORKSPACE), 'gather');
    assert.strictEqual(conversationStepFor(WORKSPACE, undefined, 'plan'), 'gather');
  });

  it('maps DEFAULT_MODE on a workspace conversation to the run step', () => {
    assert.strictEqual(conversationStepFor(WORKSPACE, undefined, DEFAULT_MODE), 'run');
  });

  for (const mode of PLANLESS_MODES) {
    it(`maps a ${mode} workspace conversation to the run step`, () => {
      assert.strictEqual(conversationStepFor(WORKSPACE, undefined, mode), 'run');
      // Plan document content is irrelevant for a workspace conversation.
      assert.strictEqual(conversationStepFor(WORKSPACE, APPROVED_PLAN, mode), 'run');
    });
  }

  it('maps every known mode, so a new RunMode is forced into this test', () => {
    for (const mode of RUN_MODES) {
      assert.strictEqual(
        conversationStepFor(WORKSPACE, undefined, mode),
        isPlanless(mode) ? 'run' : 'gather',
        `mode ${mode}`,
      );
    }
  });
});

describe('mode-scoped system prompt: a plan conversation is always Phased Plan', () => {
  for (const mode of PLANLESS_MODES) {
    it(`ignores mode ${mode} on a plan conversation`, () => {
      assert.strictEqual(conversationStepFor(PLAN, DRAFT_PLAN, mode), 'gather');
      assert.strictEqual(conversationStepFor(PLAN, APPROVED_PLAN, mode), 'drive');
      assert.strictEqual(conversationStepFor(PLAN, undefined, mode), 'gather');
      assert.strictEqual(
        buildSystemPrompt(PLAN, APPROVED_PLAN, mode),
        buildSystemPrompt(PLAN, APPROVED_PLAN),
      );
    });
  }
});

describe('mode-scoped system prompt: run prompt content', () => {
  for (const mode of PLANLESS_MODES) {
    it(`assembles the ${mode} run prompt from the run-step sections`, () => {
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

    it(`omits every plan-only section from the ${mode} run prompt`, () => {
      const prompt = buildSystemPrompt(WORKSPACE, undefined, mode);
      assert.ok(!/draft_plan/.test(prompt), 'no spec flow');
      assert.ok(!/submit_pr/.test(prompt), 'no drive stage table');
      assert.ok(!/Phase line grammar/.test(prompt), 'no phase grammar');
      assert.ok(!/Plan frontmatter rules/.test(prompt), 'no frontmatter rules');
      assert.ok(!/Phased Plan flow:/.test(prompt), 'no Phased Plan flow');
      assert.ok(!prompt.includes('Current plan document content:'), 'no plan document content block');
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

  it('names the one-small-change rule in the Quick Fix flow', () => {
    assert.match(RUN_FLOW_TEXT.quick, /^Quick Fix flow:/);
    assert.match(RUN_FLOW_TEXT.quick, /small, self-contained/i);
    assert.match(RUN_FLOW_TEXT.quick, /Phased Plan/);
  });

  it('says an investigation writes nothing', () => {
    assert.match(RUN_FLOW_TEXT.investigate, /changes nothing|read-only/i);
  });
});

describe('mode-scoped system prompt: Default recommends and confirms', () => {
  const flow = RUN_FLOW_TEXT.default;
  const prompt = buildSystemPrompt(WORKSPACE, undefined, 'default');

  it('puts the Default flow in the Default run prompt', () => {
    assert.ok(prompt.includes(flow), 'flow in prompt');
    assert.strictEqual(conversationStepFor(WORKSPACE, undefined, 'default'), 'run');
  });

  it('inspects with the read tools and states the work with guessed files', () => {
    assert.match(flow, /read tools/);
    assert.match(flow, /one line/);
    assert.match(flow, /files/);
  });

  it('recommends exactly one mode with a why', () => {
    assert.match(flow, /Recommend exactly one mode/);
    assert.match(flow, /why/);
  });

  it('asks one ask_user card listing the five concrete modes, recommendation first, free text allowed', () => {
    assert.match(flow, /`ask_user` once/);
    assert.match(flow, /recommendation first/);
    assert.match(flow, /allow_free_text/);
    for (const name of ['Phased Plan', 'Bug', 'Quick Fix', 'Refactor', 'Investigate']) {
      assert.ok(flow.includes(name), `names ${name}`);
    }
    for (const id of ['plan', 'bug', 'quick', 'refactor', 'investigate']) {
      assert.ok(flow.includes('`' + id + '`'), `option id ${id}`);
    }
    assert.ok(!/`default`/.test(flow), 'Default is not offered as an option');
  });

  it('dispatches bug/quick/refactor through start_run with the picked mode and investigate through investigate', () => {
    for (const m of ['bug', 'quick', 'refactor']) {
      assert.ok(flow.includes('`start_run` with `mode: "' + m + '"`'), `start_run for ${m}`);
    }
    assert.match(flow, /call `investigate`/);
    assert.ok(!/mode: "default"/.test(flow), 'never dispatches default');
    assert.ok(!/mode: "plan"/.test(flow), 'never dispatches plan');
  });

  it('asks for the ask_user pick before any dispatch', () => {
    const ask = flow.indexOf('`ask_user`');
    assert.ok(ask >= 0 && ask < flow.indexOf('`start_run`'), 'ask before start_run');
    assert.ok(ask < flow.indexOf('call `investigate`'), 'ask before investigate');
  });

  it('dispatches nothing for a Phased Plan pick and points at the Mode control', () => {
    assert.match(flow, /Phased Plan -> dispatch nothing/);
    assert.match(flow, /change the Mode control in the composer to Phased Plan/);
    assert.match(flow, /again/);
  });

  it('dispatches nothing on a decline or a typed answer', () => {
    assert.match(flow, /declines[^\n]*dispatch nothing/);
    assert.match(flow, /type an answer[^\n]*dispatch nothing/);
  });

  it('never dispatches without the pick and defers to the confirm card', () => {
    assert.match(flow, /Never dispatch without the user's pick/);
    assert.match(flow, /confirm card/);
  });

  it('leaves the Mode control as it is', () => {
    assert.match(flow, /Leave the Mode control as it is/);
  });

  it('never mentions plan-writing tools', () => {
    assert.ok(!/draft_plan/.test(flow), 'no draft_plan');
  });
});

describe('mode-scoped system prompt: mode proposal', () => {
  for (const mode of PLANLESS_MODES) {
    it(`tells the ${mode} prompt to propose a different mode through ask_user`, () => {
      const prompt = buildSystemPrompt(WORKSPACE, undefined, mode);
      assert.match(prompt, /propose the mode that does with `ask_user`/);
    });
  }

  it('names all five modes', () => {
    for (const name of ['Phased Plan', 'Bug', 'Quick Fix', 'Refactor', 'Investigate']) {
      assert.ok(MODE_PROPOSAL_TEXT.includes(name), `names ${name}`);
    }
    assert.match(MODE_PROPOSAL_TEXT, /dependency-ordered phases -> Phased Plan/);
  });
});

describe('mode-scoped system prompt: every plan-less mode has flow text', () => {
  it('has non-empty flow text for each plan-less mode and for no other', () => {
    for (const mode of RUN_MODES) {
      if (mode === 'plan') {
        assert.ok(!isPlanless(mode), 'plan is the only non-plan-less mode');
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
