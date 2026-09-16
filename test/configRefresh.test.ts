/**
 * Unit tests for the host-free live configuration refresher (spec "Config Panel", todo T08).
 *
 * This suite statically imports {@link createConfigRefresh} with no `vscodeLoader`
 * hook, proving that `src/activation/configRefresh.ts` remains host-free.
 */
import * as assert from 'assert';
import {
  createConfigRefresh,
  IN_FLIGHT_NOTE,
  NOT_ACTIVATED_NOTE,
  FOLDER_MISMATCH_NOTE,
  type ConfigRefreshTarget,
} from '../src/activation/configRefresh';
import type { AgentExecutables, ExecutableError, ResolvedExecutable } from '../src/activation/executable';
import { defaultConfig } from '../src/config/defaultConfig';
import type { Config } from '../src/config/types';
import { ROLES } from '../src/model/role';

function fakeExecutables(
  errors: ExecutableError[] = [],
  resolvedMap: Record<string, string> = {},
): AgentExecutables {
  const errMap = new Map(errors.map((e) => [e.agent, e]));
  return {
    get(agent: string): ResolvedExecutable | undefined {
      if (errMap.has(agent)) {
        return undefined;
      }
      return {
        agent,
        path: resolvedMap[agent] ?? `/usr/local/bin/${agent}`,
        override: false,
      };
    },
    errorFor(agent: string): ExecutableError | undefined {
      return errMap.get(agent);
    },
    errors,
    agents: Object.keys(resolvedMap),
  };
}

describe('configRefresh (T08)', () => {
  it('replaces the config object as a whole (strict reference equality)', async () => {
    const initialConfig = defaultConfig();
    const executables = fakeExecutables();
    const target: ConfigRefreshTarget = {
      config: initialConfig,
      executables,
    };

    const newConfig: Config = {
      ...defaultConfig(),
      roles: {
        ...defaultConfig().roles,
        executor: { agent: 'claude', model: 'claude-3-opus-custom', effort: 'high' },
      },
      limits: {
        ...defaultConfig().limits,
        exec_attempts: 99,
      },
    };

    const refresh = createConfigRefresh({
      state: () => target,
      resolveExecutables: () => fakeExecutables(),
      completeActivation: async () => [],
      runningSlugs: () => [],
      log: () => {},
    });

    const notes = await refresh(newConfig);
    assert.deepStrictEqual(notes, []);
    // Must be exact same object reference, not a cloned merge
    assert.strictEqual(target.config, newConfig);
    assert.strictEqual(target.config.roles.executor.model, 'claude-3-opus-custom');
    assert.strictEqual(target.config.limits.exec_attempts, 99);
  });

  it('re-resolves executables from new role agents in ROLES order and updates target', async () => {
    const target: ConfigRefreshTarget = {
      config: defaultConfig(),
      executables: fakeExecutables(),
    };

    const newConfig: Config = {
      ...defaultConfig(),
      roles: {
        ...defaultConfig().roles,
        planner: { agent: 'codex', model: 'gpt-4' },
        executor: { agent: 'opencode', model: 'deepseek-coder' },
        reviewer: { agent: 'antigravity', model: 'gemini-pro' },
      },
    };

    let resolvedAgents: readonly string[] | undefined;
    const freshExecutables = fakeExecutables([], {
      claude: '/bin/claude',
      codex: '/bin/codex',
      opencode: '/bin/opencode',
      antigravity: '/bin/agy',
    });

    const refresh = createConfigRefresh({
      state: () => target,
      resolveExecutables: (agents) => {
        resolvedAgents = agents;
        return freshExecutables;
      },
      completeActivation: async () => [],
      runningSlugs: () => [],
      log: () => {},
    });

    const notes = await refresh(newConfig);
    assert.deepStrictEqual(notes, []);
    const expectedAgents = ROLES.map((r) => newConfig.roles[r].agent);
    assert.deepStrictEqual(resolvedAgents, expectedAgents);
    assert.strictEqual(target.executables, freshExecutables);
  });

  it('surfaces executable errors in returned notes when an agent resolution fails', async () => {
    const target: ConfigRefreshTarget = {
      config: defaultConfig(),
      executables: fakeExecutables(),
    };

    const failure: ExecutableError = {
      kind: 'not-on-path',
      agent: 'missing-agent',
      message: 'the "missing-agent" executable was not found on PATH',
    };
    const brokenExecutables = fakeExecutables([failure]);

    const newConfig: Config = {
      ...defaultConfig(),
      roles: {
        ...defaultConfig().roles,
        executor: { agent: 'missing-agent', model: 'custom-model' },
      },
    };

    const refresh = createConfigRefresh({
      state: () => target,
      resolveExecutables: () => brokenExecutables,
      completeActivation: async () => [],
      runningSlugs: () => [],
      log: () => {},
    });

    const notes = await refresh(newConfig);
    assert.strictEqual(target.executables, brokenExecutables);
    assert.strictEqual(notes.length, 1);
    assert.strictEqual(notes[0], failure.message);
  });

  it('reports an in-flight note when stages are currently running', async () => {
    const target: ConfigRefreshTarget = {
      config: defaultConfig(),
      executables: fakeExecutables(),
    };

    // 1. Single running slug
    const refresh1 = createConfigRefresh({
      state: () => target,
      resolveExecutables: () => fakeExecutables(),
      completeActivation: async () => [],
      runningSlugs: () => ['alpha'],
      log: () => {},
    });

    const notes1 = await refresh1(defaultConfig());
    assert.deepStrictEqual(notes1, [IN_FLIGHT_NOTE(['alpha'])]);

    // 2. Multiple running slugs including synthetic spec draft
    const refresh2 = createConfigRefresh({
      state: () => target,
      resolveExecutables: () => fakeExecutables(),
      completeActivation: async () => [],
      runningSlugs: () => ['alpha', 'beta', '(spec draft)'],
      log: () => {},
    });

    const notes2 = await refresh2(defaultConfig());
    assert.deepStrictEqual(notes2, [IN_FLIGHT_NOTE(['alpha', 'beta', '(spec draft)'])]);

    // 3. Nothing running -> no in-flight note
    const refresh3 = createConfigRefresh({
      state: () => target,
      resolveExecutables: () => fakeExecutables(),
      completeActivation: async () => [],
      runningSlugs: () => [],
      log: () => {},
    });

    const notes3 = await refresh3(defaultConfig());
    assert.deepStrictEqual(notes3, []);
  });

  it('delegates to completeActivation when activation state is not yet initialized', async () => {
    let completedCalled = 0;
    const activationNotes = ['Activated successfully after repairing corrupt config'];

    const refresh = createConfigRefresh({
      state: () => undefined,
      resolveExecutables: () => {
        throw new Error('should not be called on unactivated state');
      },
      completeActivation: async () => {
        completedCalled++;
        return activationNotes;
      },
      runningSlugs: () => [],
      log: () => {},
    });

    const notes = await refresh(defaultConfig());
    assert.strictEqual(completedCalled, 1);
    assert.deepStrictEqual(notes, activationNotes);
  });

  it('returns non-reloadable note when late activation is still blocked', async () => {
    const blockedReason = NOT_ACTIVATED_NOTE('Ambiguous workspace folders (multiple candidates with .baiton)');
    const refresh = createConfigRefresh({
      state: () => undefined,
      resolveExecutables: () => fakeExecutables(),
      completeActivation: async () => [blockedReason],
      runningSlugs: () => [],
      log: () => {},
    });

    const notes = await refresh(defaultConfig());
    assert.deepStrictEqual(notes, [blockedReason]);
  });

  it('logs a line recording replacement and note count', async () => {
    const target: ConfigRefreshTarget = {
      config: defaultConfig(),
      executables: fakeExecutables(),
    };
    const logged: string[] = [];

    const refresh = createConfigRefresh({
      state: () => target,
      resolveExecutables: () => fakeExecutables(),
      completeActivation: async () => [],
      runningSlugs: () => ['slug-1'],
      log: (line) => logged.push(line),
    });

    await refresh(defaultConfig());
    assert.strictEqual(logged.length, 1);
    assert.strictEqual(logged[0], 'Live config reloaded (1 note).');
  });

  it('exports FOLDER_MISMATCH_NOTE for multi-root workspace scoping', () => {
    assert.ok(typeof FOLDER_MISMATCH_NOTE === 'string' && FOLDER_MISMATCH_NOTE.length > 0);
  });
});
