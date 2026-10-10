import * as assert from 'assert';
import {
  ASK_USER_TEXT,
  DRIVE_TEXT,
  PROHIBITION_LINES,
  REFUSAL_TEXT,
  SCOPE_TEXT,
  SUBAGENT_DRIVE_TEXT,
  SUBAGENT_ROLE_TEXT,
  buildSubAgentPrompt,
  buildSystemPrompt,
  subAgentSpawnText,
} from '../src/orchestrator/systemPrompt';
import type { ConversationKind } from '../src/orchestrator/systemPrompt';
import { ORCHESTRATOR_PHASES } from '../src/orchestrator/guard';
import { MAX_SUBAGENT_DEPTH } from '../src/orchestrator/seams';

const WORKSPACE: ConversationKind = { kind: 'workspace' };
// 'spec' is the legacy persisted conversation kind.
const PLAN: ConversationKind = { kind: 'spec', slug: 'sample' };
const DEPTHS = [0, 1, 2];

describe('buildSubAgentPrompt', () => {
  it('states the role, refusal, ask_user and prohibitions for every conversation step and depth', () => {
    for (const step of ORCHESTRATOR_PHASES) {
      for (const depth of DEPTHS) {
        const prompt = buildSubAgentPrompt(WORKSPACE, step, depth);
        assert.ok(prompt.includes(SUBAGENT_ROLE_TEXT));
        assert.ok(prompt.includes(REFUSAL_TEXT));
        assert.ok(prompt.includes(ASK_USER_TEXT));
        for (const line of PROHIBITION_LINES) {
          assert.ok(prompt.includes(line));
        }
        assert.ok(prompt.includes('report back concisely'));
        assert.ok(prompt.includes('You never finish a plan'));
      }
    }
  });

  it('includes the run table only in the drive step', () => {
    assert.ok(buildSubAgentPrompt(PLAN, 'drive', 1).includes(SUBAGENT_DRIVE_TEXT));
    assert.ok(buildSubAgentPrompt(PLAN, 'drive', 1).includes('`pending` -> `run` the `plan` stage.'));
    assert.match(SUBAGENT_DRIVE_TEXT, /move a phase forward/);
    assert.match(SUBAGENT_DRIVE_TEXT, /review that sends the phase back/);
    assert.ok(!buildSubAgentPrompt(PLAN, 'gather', 1).includes(SUBAGENT_DRIVE_TEXT));
    assert.ok(!buildSubAgentPrompt(WORKSPACE, 'run', 1).includes(SUBAGENT_DRIVE_TEXT));
  });

  it('never names the tools a sub-agent lacks or the top-level scope text', () => {
    for (const step of ORCHESTRATOR_PHASES) {
      const prompt = buildSubAgentPrompt(PLAN, step, 1, 'content');
      assert.ok(!prompt.includes(DRIVE_TEXT));
      assert.ok(!prompt.includes(SCOPE_TEXT));
      assert.ok(!prompt.includes('`submit_pr`'));
      assert.ok(!prompt.includes('`draft_plan`'));
      assert.ok(!prompt.includes('offer to `submit_pr`'));
    }
  });

  it('says whether the sub-agent may spawn based on its depth', () => {
    for (const depth of [0, 1]) {
      const prompt = buildSubAgentPrompt(WORKSPACE, 'gather', depth);
      assert.ok(prompt.includes(subAgentSpawnText(depth)));
      assert.ok(prompt.includes('You may start your own sub-agents'));
      assert.ok(prompt.includes('`spawn_subagent`'));
    }
    const capped = buildSubAgentPrompt(WORKSPACE, 'gather', MAX_SUBAGENT_DEPTH);
    assert.ok(capped.includes('You may not start sub-agents'));
    assert.ok(capped.includes(String(MAX_SUBAGENT_DEPTH)));
    assert.ok(!capped.includes('You may start your own sub-agents'));
  });

  it('appends document content only for a plan kind that has it', () => {
    const withContent = buildSubAgentPrompt(PLAN, 'drive', 1, 'PLAN BODY');
    assert.ok(withContent.includes('Current plan document content:\n\nPLAN BODY'));
    assert.ok(!buildSubAgentPrompt(PLAN, 'drive', 1).includes('Current plan document content:'));
    assert.ok(!buildSubAgentPrompt(WORKSPACE, 'run', 1, 'PLAN BODY').includes('Current plan document content:'));
  });

  it('leaves buildSystemPrompt unchanged', () => {
    const content = ['---', 'version: 1', 'name: s', 'status: approved', '---', ''].join('\n');
    const prompt = buildSystemPrompt(PLAN, content);
    assert.ok(prompt.includes(DRIVE_TEXT));
    assert.ok(!prompt.includes(SUBAGENT_ROLE_TEXT));
  });
});
