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
const SPEC: ConversationKind = { kind: 'spec', slug: 'sample' };
const DEPTHS = [0, 1, 2];

describe('buildSubAgentPrompt', () => {
  it('states the role, refusal, ask_user and prohibitions for every phase and depth', () => {
    for (const phase of ORCHESTRATOR_PHASES) {
      for (const depth of DEPTHS) {
        const prompt = buildSubAgentPrompt(WORKSPACE, phase, depth);
        assert.ok(prompt.includes(SUBAGENT_ROLE_TEXT));
        assert.ok(prompt.includes(REFUSAL_TEXT));
        assert.ok(prompt.includes(ASK_USER_TEXT));
        for (const line of PROHIBITION_LINES) {
          assert.ok(prompt.includes(line));
        }
        assert.ok(prompt.includes('report back concisely'));
        assert.ok(prompt.includes('You never finish a spec'));
      }
    }
  });

  it('includes the run table only in the drive phase', () => {
    assert.ok(buildSubAgentPrompt(SPEC, 'drive', 1).includes(SUBAGENT_DRIVE_TEXT));
    assert.ok(buildSubAgentPrompt(SPEC, 'drive', 1).includes('`pending` -> `run` the `plan` stage.'));
    assert.ok(!buildSubAgentPrompt(SPEC, 'gather', 1).includes(SUBAGENT_DRIVE_TEXT));
    assert.ok(!buildSubAgentPrompt(WORKSPACE, 'run', 1).includes(SUBAGENT_DRIVE_TEXT));
  });

  it('never names the tools a sub-agent lacks or the top-level scope text', () => {
    for (const phase of ORCHESTRATOR_PHASES) {
      const prompt = buildSubAgentPrompt(SPEC, phase, 1, 'content');
      assert.ok(!prompt.includes(DRIVE_TEXT));
      assert.ok(!prompt.includes(SCOPE_TEXT));
      assert.ok(!prompt.includes('`submit_pr`'));
      assert.ok(!prompt.includes('`draft_spec`'));
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

  it('appends spec content only for a spec kind that has it', () => {
    const withContent = buildSubAgentPrompt(SPEC, 'drive', 1, 'SPEC BODY');
    assert.ok(withContent.includes('Current spec file content:\n\nSPEC BODY'));
    assert.ok(!buildSubAgentPrompt(SPEC, 'drive', 1).includes('Current spec file content:'));
    assert.ok(!buildSubAgentPrompt(WORKSPACE, 'run', 1, 'SPEC BODY').includes('Current spec file content:'));
  });

  it('leaves buildSystemPrompt unchanged', () => {
    const content = ['---', 'version: 1', 'name: s', 'status: approved', '---', ''].join('\n');
    const prompt = buildSystemPrompt(SPEC, content);
    assert.ok(prompt.includes(DRIVE_TEXT));
    assert.ok(!prompt.includes(SUBAGENT_ROLE_TEXT));
  });
});
