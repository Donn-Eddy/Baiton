import * as assert from 'assert';
import { ROLES } from '../src/model/role';
import {
  roleProfile,
  roleAllowList,
  runDirGlob,
  type AgentAllowList,
  type ToolAllowRule,
} from '../src/adapter/roleProfile';
import {
  READ_ONLY_ALLOWED_TOOLS,
  REVIEWER_ALLOWED_TOOLS,
  ACCEPT_EDITS_MODE,
  DEFAULT_PERMISSION_MODE,
  parseAllowedTools,
  claudeAllowList,
  permissionFlags,
} from '../src/adapter/permissions';
import { opencodeAllowList } from '../src/adapter/opencode';
import { agentAllowList } from '../src/adapter';
import {
  TOOL_FAMILIES,
  toolFamily,
  askPaths,
  normalizeAskPath,
  shellCommandIsSafe,
  SAFE_SHELL_PREFIXES,
  allowListDecision,
  askFromPermission,
  type AutoModeDecision,
} from '../src/orchestrator/autoMode';
import type { PermissionRequest } from '../src/orchestrator/interventions';

/**
 * Unit tests for the auto-mode allow-lists (T09): the profile-derived
 * fallback, the claude/opencode derivations, the per-agent lookup, and the
 * pure deterministic first gate.
 *
 * Runs host-free without a `vscode` environment and without touching disk.
 */

/** All write rules reaching outside `.baiton/runs/<runId>/`. */
function writeRulesOutsideRunDir(list: AgentAllowList, runId: string): ToolAllowRule[] {
  const prefix = `.baiton/runs/${runId}/`;
  return list.rules.filter(
    (rule) =>
      rule.family === 'write' &&
      rule.paths !== undefined &&
      rule.paths.some((glob) => !glob.startsWith(prefix) && glob !== '**'),
  );
}

describe('autoMode allow-lists', () => {
  describe('parseAllowedTools', () => {
    it('parses READ_ONLY_ALLOWED_TOOLS into per-tool entries', () => {
      assert.deepStrictEqual(parseAllowedTools(READ_ONLY_ALLOWED_TOOLS), [
        { tool: 'Read' },
        { tool: 'Glob' },
        { tool: 'Grep' },
        { tool: 'Write', paths: ['.baiton/runs/**'] },
      ]);
    });

    it('parses REVIEWER_ALLOWED_TOOLS including Bash', () => {
      assert.deepStrictEqual(parseAllowedTools(REVIEWER_ALLOWED_TOOLS), [
        { tool: 'Read' },
        { tool: 'Glob' },
        { tool: 'Grep' },
        { tool: 'Bash' },
        { tool: 'Write', paths: ['.baiton/runs/**'] },
      ]);
    });

    it('is tolerant of whitespace around entries and patterns', () => {
      assert.deepStrictEqual(parseAllowedTools(' Read , Glob , Write( .baiton/runs/** ) '), [
        { tool: 'Read' },
        { tool: 'Glob' },
        { tool: 'Write', paths: ['.baiton/runs/**'] },
      ]);
    });
  });

  describe('derivation over every role and agent', () => {
    const AGENTS = ['claude', 'opencode', 'codex', 'antigravity', 'some-future-agent'];

    for (const agent of AGENTS) {
      for (const role of ROLES) {
        it(`${agent}/${role}: write stays inside the run dir for run-dir roles, shell matches the profile`, () => {
          const list = agentAllowList(agent, role, 'run-1');
          assert.strictEqual(list.agent, agent);
          assert.strictEqual(list.role, role);
          assert.strictEqual(list.runId, 'run-1');

          const profile = roleProfile(role);
          if (profile.write === 'run-dir') {
            assert.deepStrictEqual(writeRulesOutsideRunDir(list, 'run-1'), []);
          }

          const shellRules = list.rules.filter((r) => r.family === 'shell');
          assert.strictEqual(shellRules.length > 0, profile.shell);
        });
      }
    }
  });

  describe('claude specifics', () => {
    it('the accept-edits fallback flips a planner onto the profile-derived list', () => {
      const fallbackMode = { readOnlyFallbackToAcceptEdits: true };
      const list = claudeAllowList('planner', 'run-1', fallbackMode);
      assert.deepStrictEqual(list, roleAllowList('claude', 'planner', 'run-1'));
    });

    it("the reviewer's list has a shell rule and the planner's does not", () => {
      const reviewer = claudeAllowList('reviewer', 'run-1');
      const planner = claudeAllowList('planner', 'run-1');
      assert.ok(reviewer.rules.some((r) => r.family === 'shell'));
      assert.ok(!planner.rules.some((r) => r.family === 'shell'));
    });

    it('the write rule carries the run-dir glob accepted by the matcher', () => {
      const list = claudeAllowList('planner', 'run-1');
      const write = list.rules.find((r) => r.family === 'write');
      assert.ok(write);
      assert.ok(write.paths);
      assert.ok(write.paths.includes(runDirGlob('run-1')));
    });

    it('the executor falls back to the profile list (accept-edits has no tool table)', () => {
      assert.deepStrictEqual(
        claudeAllowList('executor', 'run-1'),
        roleAllowList('claude', 'executor', 'run-1'),
      );
    });

    it('the parsed list always mirrors what permissionFlags emits', () => {
      for (const role of ROLES) {
        const flags = permissionFlags(role, DEFAULT_PERMISSION_MODE);
        if (flags[0] !== '--allowedTools') {
          continue;
        }
        const list = claudeAllowList(role, 'run-1');
        for (const entry of parseAllowedTools(flags[1])) {
          assert.ok(
            list.rules.some((r) => r.reason.includes(`claude --allowedTools ${entry.tool}`)),
            `${role}: ${entry.tool} missing from claudeAllowList`,
          );
        }
      }
      assert.strictEqual(ACCEPT_EDITS_MODE, 'acceptEdits');
    });
  });

  describe('opencode specifics', () => {
    it("the planner's write paths contain the **-widened run-dir glob and no bare '*'", () => {
      const list = opencodeAllowList('planner', 'run-1');
      const write = list.rules.find((r) => r.family === 'write');
      assert.ok(write);
      assert.ok(write.paths);
      assert.ok(write.paths.includes('.baiton/runs/run-1/**/*'));
      assert.ok(!write.paths.includes('*'));
    });

    it("the executor's write paths contain '**'", () => {
      const list = opencodeAllowList('executor', 'run-1');
      const write = list.rules.find((r) => r.family === 'write');
      assert.ok(write);
      assert.ok(write.paths);
      assert.ok(write.paths.includes('**/*'));
    });

    it('non-shell roles get no shell rule', () => {
      for (const role of ROLES.filter((r) => !roleProfile(r).shell)) {
        const list = opencodeAllowList(role, 'run-1');
        assert.ok(!list.rules.some((r) => r.family === 'shell'), role);
      }
    });
  });

  describe('toolFamily', () => {
    it('maps known names in mixed case', () => {
      assert.strictEqual(toolFamily('Read'), 'read');
      assert.strictEqual(toolFamily('NOTEBOOKREAD'), 'read');
      assert.strictEqual(toolFamily('Glob'), 'search');
      assert.strictEqual(toolFamily('list_files'), 'search');
      assert.strictEqual(toolFamily('Edit'), 'write');
      assert.strictEqual(toolFamily('apply_patch'), 'write');
      assert.strictEqual(toolFamily('Bash'), 'shell');
      assert.strictEqual(toolFamily('execute_command'), 'shell');
    });

    it('returns undefined for deliberately unmapped names', () => {
      assert.strictEqual(toolFamily('WebFetch'), undefined);
      assert.strictEqual(toolFamily('Task'), undefined);
      assert.strictEqual(toolFamily(''), undefined);
      assert.strictEqual(toolFamily('__proto__'), undefined);
    });

    it('covers every value of TOOL_FAMILIES consistently', () => {
      for (const key of Object.keys(TOOL_FAMILIES)) {
        assert.strictEqual(toolFamily(key), TOOL_FAMILIES[key]);
      }
    });
  });

  describe('askPaths', () => {
    it('extracts file_path and paths[]', () => {
      const parsed = askPaths('{"file_path":"a.txt","paths":["b.txt","c.txt"]}');
      assert.deepStrictEqual(parsed, { ok: true, paths: ['a.txt', 'b.txt', 'c.txt'] });
    });

    it('returns an empty path list for missing or blank args', () => {
      assert.deepStrictEqual(askPaths(undefined), { ok: true, paths: [] });
      assert.deepStrictEqual(askPaths('   '), { ok: true, paths: [] });
    });

    it('rejects malformed JSON', () => {
      const parsed = askPaths('{not json');
      assert.strictEqual(parsed.ok, false);
      if (!parsed.ok) {
        assert.ok(parsed.reason.length > 0);
      }
    });

    it('rejects a non-object args value', () => {
      assert.strictEqual(askPaths('[1,2]').ok, false);
      assert.strictEqual(askPaths('42').ok, false);
      assert.strictEqual(askPaths('null').ok, false);
    });
  });

  describe('normalizeAskPath', () => {
    it('rejects absolute paths, drives, file URLs and .. segments', () => {
      assert.strictEqual(normalizeAskPath('/etc/passwd'), undefined);
      assert.strictEqual(normalizeAskPath('C:\\x'), undefined);
      assert.strictEqual(normalizeAskPath('file:///x'), undefined);
      assert.strictEqual(normalizeAskPath('../outside.txt'), undefined);
      assert.strictEqual(normalizeAskPath('a/../../b'), undefined);
    });

    it('accepts and normalises relative paths', () => {
      assert.strictEqual(normalizeAskPath('./.baiton/runs/run-1/result.json'), '.baiton/runs/run-1/result.json');
      assert.strictEqual(normalizeAskPath('a\\b\\c.txt'), 'a/b/c.txt');
      assert.strictEqual(normalizeAskPath('src/app.ts'), 'src/app.ts');
    });
  });

  describe('shellCommandIsSafe', () => {
    it('approves every safe prefix', () => {
      for (const prefix of SAFE_SHELL_PREFIXES) {
        assert.ok(shellCommandIsSafe(prefix), prefix);
      }
      assert.ok(shellCommandIsSafe('git status --porcelain'));
      assert.ok(shellCommandIsSafe('  npm   test  '));
    });

    it('rejects chaining, redirection, substitution and unknown commands', () => {
      assert.ok(!shellCommandIsSafe('git status && rm x'));
      assert.ok(!shellCommandIsSafe('cat a; rm b'));
      assert.ok(!shellCommandIsSafe('cat a | sh'));
      assert.ok(!shellCommandIsSafe('echo $(rm x)'));
      assert.ok(!shellCommandIsSafe('cat a > b'));
      assert.ok(!shellCommandIsSafe('cat a < b'));
      assert.ok(!shellCommandIsSafe('`rm x`'));
      assert.ok(!shellCommandIsSafe('rm -rf build'));
      assert.ok(!shellCommandIsSafe(''));
    });
  });

  describe('allowListDecision', () => {
    const planner = agentAllowList('claude', 'planner', 'run-1');
    const reviewer = agentAllowList('claude', 'reviewer', 'run-1');
    const executor = agentAllowList('claude', 'executor', 'run-1');

    function decide(ask: { agent: string; tool: string; args?: string }, list: AgentAllowList): AutoModeDecision {
      return allowListDecision(ask, list);
    }

    it('approves claude/planner Read with no args', () => {
      const d = decide({ agent: 'claude', tool: 'Read' }, planner);
      assert.strictEqual(d.kind, 'approve');
      if (d.kind === 'approve') {
        assert.ok(d.rationale.includes('claude/planner'));
        assert.ok(d.rationale.includes('Read'));
        assert.strictEqual(d.rule.family, 'read');
      }
    });

    it('approves claude/planner Write inside the run dir', () => {
      const d = decide(
        { agent: 'claude', tool: 'Write', args: '{"file_path":".baiton/runs/run-1/result.json"}' },
        planner,
      );
      assert.strictEqual(d.kind, 'approve');
    });

    it('escalates claude/planner Write to src/app.ts', () => {
      const d = decide({ agent: 'claude', tool: 'Write', args: '{"file_path":"src/app.ts"}' }, planner);
      assert.strictEqual(d.kind, 'escalate');
      if (d.kind === 'escalate') {
        assert.ok(d.reason.length > 0);
      }
    });

    it('approves a nested run-dir write (pins the ** widening)', () => {
      const d = decide(
        { agent: 'claude', tool: 'Write', args: '{"file_path":".baiton/runs/run-1/asks/a.json"}' },
        planner,
      );
      assert.strictEqual(d.kind, 'approve');
    });

    it('escalates claude/planner Bash (planner has no shell rule)', () => {
      const d = decide({ agent: 'claude', tool: 'Bash', args: '{"command":"npm test"}' }, planner);
      assert.strictEqual(d.kind, 'escalate');
      if (d.kind === 'escalate') {
        assert.ok(d.reason.includes('shell'));
      }
    });

    it('approves claude/reviewer Bash npm test', () => {
      const d = decide({ agent: 'claude', tool: 'Bash', args: '{"command":"npm test"}' }, reviewer);
      assert.strictEqual(d.kind, 'approve');
    });

    it('escalates claude/reviewer Bash rm -rf build', () => {
      const d = decide({ agent: 'claude', tool: 'Bash', args: '{"command":"rm -rf build"}' }, reviewer);
      assert.strictEqual(d.kind, 'escalate');
      if (d.kind === 'escalate') {
        assert.ok(d.reason.length > 0);
      }
    });

    it('escalates chained shell commands', () => {
      const d = decide({ agent: 'claude', tool: 'Bash', args: '{"command":"git status && rm x"}' }, reviewer);
      assert.strictEqual(d.kind, 'escalate');
    });

    it('approves claude/executor Edit in the workspace', () => {
      const d = decide({ agent: 'claude', tool: 'Edit', args: '{"file_path":"src/app.ts"}' }, executor);
      assert.strictEqual(d.kind, 'approve');
    });

    it('escalates an agent mismatch', () => {
      const d = decide({ agent: 'opencode', tool: 'Read' }, planner);
      assert.strictEqual(d.kind, 'escalate');
      if (d.kind === 'escalate') {
        assert.ok(d.reason.includes('different agent'));
      }
    });

    it('escalates a write with one in-scope and one out-of-scope path', () => {
      const d = decide(
        {
          agent: 'claude',
          tool: 'Write',
          args: '{"paths":[".baiton/runs/run-1/a.json","src/leak.ts"]}',
        },
        planner,
      );
      assert.strictEqual(d.kind, 'escalate');
    });

    it('escalates unparseable args on a Write', () => {
      const d = decide({ agent: 'claude', tool: 'Write', args: '{oops' }, planner);
      assert.strictEqual(d.kind, 'escalate');
      if (d.kind === 'escalate') {
        assert.ok(d.reason.length > 0);
      }
    });

    it('escalates unmapped tools', () => {
      const d = decide({ agent: 'claude', tool: 'WebFetch', args: '{"url":"https://x"}' }, planner);
      assert.strictEqual(d.kind, 'escalate');
      if (d.kind === 'escalate') {
        assert.ok(d.reason.includes('WebFetch'));
      }
    });
  });

  describe('purity', () => {
    it('calling allowListDecision twice is deterministic and does not mutate the allow-list', () => {
      const list = agentAllowList('claude', 'reviewer', 'run-1');
      const snapshot = structuredClone(list);
      const ask = { agent: 'claude', tool: 'Bash', args: '{"command":"npm test"}' };

      const first = allowListDecision(ask, list);
      const second = allowListDecision(ask, list);

      assert.deepStrictEqual(first, second);
      assert.deepStrictEqual(list, snapshot);
    });
  });

  describe('askFromPermission', () => {
    it('maps a PermissionRequest onto the gate ask', () => {
      const req: PermissionRequest = {
        kind: 'permission',
        prompt: 'Allow Bash?',
        agent: 'claude',
        tool: 'Bash',
        args: '{"command":"ls"}',
        detail: 'runs npm test',
      };
      assert.deepStrictEqual(askFromPermission(req), {
        agent: 'claude',
        tool: 'Bash',
        args: '{"command":"ls"}',
      });
    });
  });
});
