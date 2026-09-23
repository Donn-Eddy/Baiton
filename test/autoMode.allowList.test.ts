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
  shellCommandIsReadOnly,
  classifyShellCommand,
  splitShellPipeline,
  scriptPathCandidates,
  askShellCommand,
  askCwd,
  SAFE_SHELL_PREFIXES,
  READ_ONLY_SHELL_PREFIXES,
  VERIFICATION_SHELL_PREFIXES,
  READ_ONLY_SHELL_RULE,
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

    it('maps the antigravity (agy) tool names', () => {
      assert.strictEqual(toolFamily('run_command'), 'shell');
      assert.strictEqual(toolFamily('read_file'), 'read');
      assert.strictEqual(toolFamily('view_file'), 'read');
      assert.strictEqual(toolFamily('list_dir'), 'search');
      assert.strictEqual(toolFamily('find_by_name'), 'search');
      assert.strictEqual(toolFamily('grep_search'), 'search');
      assert.strictEqual(toolFamily('write_to_file'), 'write');
      assert.strictEqual(toolFamily('replace_file_content'), 'write');
      assert.strictEqual(toolFamily('edit_file'), 'write');
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
      assert.ok(!shellCommandIsSafe('ls & rm x'));
      assert.ok(!shellCommandIsSafe('ls || rm x'));
      assert.ok(!shellCommandIsSafe('ls\nrm x'));
      assert.ok(!shellCommandIsSafe('echo "$(rm x)"'));
      assert.ok(!shellCommandIsSafe('echo \\" ; rm x \\"'));
      assert.ok(!shellCommandIsSafe('echo "unterminated'));
    });

    it('splits read-only and verification prefixes into two lists', () => {
      assert.deepStrictEqual([...SAFE_SHELL_PREFIXES].sort(), [...READ_ONLY_SHELL_PREFIXES, ...VERIFICATION_SHELL_PREFIXES].sort());
      for (const prefix of READ_ONLY_SHELL_PREFIXES) {
        assert.strictEqual(classifyShellCommand(prefix), 'read-only', prefix);
      }
      for (const prefix of VERIFICATION_SHELL_PREFIXES) {
        assert.strictEqual(classifyShellCommand(prefix), 'verification', prefix);
      }
      for (const banned of ['node -e', 'python -c', 'curl', 'wget', 'rm', 'mv', 'cp', 'chmod']) {
        assert.ok(!SAFE_SHELL_PREFIXES.includes(banned), banned);
      }
    });

    it('recognises read-only commands and pipelines of them', () => {
      for (const cmd of [
        'ls -la src',
        'grep -rn foo src',
        'grep -E "a|b" src/x.ts',
        "sed -n 1,20p x",
        "sed -n '/foo/p' x",
        'cat x | head',
        'git log --oneline | head -20',
        'find . -name "*.ts" | wc -l',
        'awk \'{print $1}\' x | sort | uniq -c',
        'git branch -a',
        'git branch --contains HEAD',
        'jq .name package.json',
        'npx tsc --noEmit',
        'git remote -v',
      ]) {
        assert.ok(shellCommandIsReadOnly(cmd), cmd);
      }
    });

    it('rejects mutating flags on otherwise read-only commands', () => {
      for (const cmd of [
        'sed -i s/a/b/ x',
        'sed -n -i 1p x',
        "sed -n 'w out' x",
        'find . -delete',
        'find . -name x -exec rm {} ;',
        'find . -execdir rm {} +',
        'sort -o out.txt in.txt',
        'uniq in.txt out.txt',
        'tree -o out.txt',
        'rg --pre ./evil foo',
        'git grep -O foo',
        'git diff --output=patch.diff',
        'git branch new-feature',
        'git branch -D main',
        'git remote -v add x y',
        'git push',
        'git commit -m x',
        'awk \'{ system("rm x") }\' f',
        'python --version script.py',
        'echo x > f',
      ]) {
        assert.strictEqual(classifyShellCommand(cmd), undefined, cmd);
      }
    });

    it('classes a pipeline with a verification segment as verification', () => {
      assert.strictEqual(classifyShellCommand('npm test | tail -5'), 'verification');
      assert.strictEqual(classifyShellCommand('npx tsc'), 'verification');
    });
  });

  describe('splitShellPipeline', () => {
    it('splits on single pipes and unquotes tokens', () => {
      assert.deepStrictEqual(splitShellPipeline(`grep -E 'a|b' "x y" | head`), [['grep', '-E', 'a|b', 'x y'], ['head']]);
    });

    it('rejects empty segments and dangling pipes', () => {
      assert.strictEqual(splitShellPipeline('ls |'), undefined);
      assert.strictEqual(splitShellPipeline('| ls'), undefined);
      assert.strictEqual(splitShellPipeline('   '), undefined);
    });
  });

  describe('askShellCommand / askCwd / scriptPathCandidates', () => {
    it('reads command, cmd and agy CommandLine', () => {
      assert.strictEqual(askShellCommand('{"command":"ls"}'), 'ls');
      assert.strictEqual(askShellCommand('{"cmd":"ls"}'), 'ls');
      assert.strictEqual(askShellCommand('{"CommandLine":"ls -la","Cwd":"/w"}'), 'ls -la');
      assert.strictEqual(askShellCommand('{"command":"  "}'), undefined);
      assert.strictEqual(askShellCommand('{oops'), undefined);
    });

    it('reads cwd and agy Cwd', () => {
      assert.strictEqual(askCwd('{"CommandLine":"ls","Cwd":"/w/sub"}'), '/w/sub');
      assert.strictEqual(askCwd('{"command":"ls","cwd":"sub"}'), 'sub');
      assert.strictEqual(askCwd('{"command":"ls"}'), undefined);
    });

    it('names script-looking tokens once, quotes stripped', () => {
      assert.deepStrictEqual(
        scriptPathCandidates(`cd x && python "scripts/analyze.py" --in a.csv; bash run.sh | node tool.mjs scripts/analyze.py`),
        ['scripts/analyze.py', 'run.sh', 'tool.mjs'],
      );
      assert.deepStrictEqual(scriptPathCandidates('ls -la'), []);
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

    it('escalates a claude/planner verification command (planner has no shell rule)', () => {
      const d = decide({ agent: 'claude', tool: 'Bash', args: '{"command":"npm test"}' }, planner);
      assert.strictEqual(d.kind, 'escalate');
      if (d.kind === 'escalate') {
        assert.ok(d.reason.includes('shell'));
      }
    });

    for (const command of ['ls -la src', 'grep -rn foo src', 'sed -n 1,20p x', 'cat x | head', 'git log --oneline | head']) {
      it(`approves read-only shell for every role: ${command}`, () => {
        for (const list of [planner, reviewer, executor]) {
          const d = decide({ agent: 'claude', tool: 'Bash', args: JSON.stringify({ command }) }, list);
          assert.strictEqual(d.kind, 'approve', `${list.role}: ${command}`);
          if (d.kind === 'approve') {
            assert.strictEqual(d.rationale, `claude/${list.role}: read-only shell command, equivalent to read/search`);
            assert.deepStrictEqual(d.rule, READ_ONLY_SHELL_RULE);
          }
        }
      });
    }

    for (const command of ['sed -i s/a/b/ x', 'find . -delete', 'python script.py', 'rm -rf build', 'a && b', 'echo x > f']) {
      it(`escalates a non-read-only command for the planner: ${command}`, () => {
        const d = decide({ agent: 'claude', tool: 'Bash', args: JSON.stringify({ command }) }, planner);
        assert.strictEqual(d.kind, 'escalate', command);
        if (d.kind === 'escalate') {
          assert.ok(!d.reason.includes('may not use'), d.reason);
        }
      });
    }

    it('approves an agy run_command ls via CommandLine for the planner', () => {
      const list = agentAllowList('antigravity', 'planner', 'run-1');
      const d = decide(
        { agent: 'antigravity', tool: 'run_command', args: '{"CommandLine":"ls","Cwd":"/w"}' },
        list,
      );
      assert.strictEqual(d.kind, 'approve');
    });

    it('escalates the codex PermissionRequest shapes the probe observed (apply_patch patch text, Bash curl)', () => {
      // codex 0.155.1: apply_patch names its target only inside the patch
      // text under `command`, so no path is provable and the write escalates.
      const executor = agentAllowList('codex', 'executor', 'run-1');
      const patch = decide(
        {
          agent: 'codex',
          tool: 'apply_patch',
          args: JSON.stringify({ command: '*** Begin Patch\n*** Add File: /elsewhere/x.txt\n+hi\n*** End Patch' }),
        },
        executor,
      );
      assert.strictEqual(patch.kind, 'escalate');
      const fetch = decide(
        {
          agent: 'codex',
          tool: 'Bash',
          args: JSON.stringify({ command: 'curl -fsSL https://example.com', description: 'May I fetch it?' }),
        },
        executor,
      );
      assert.strictEqual(fetch.kind, 'escalate');
    });

    it('escalates a shell ask with no determinable command', () => {
      const d = decide({ agent: 'claude', tool: 'Bash', args: '{}' }, planner);
      assert.strictEqual(d.kind, 'escalate');
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
