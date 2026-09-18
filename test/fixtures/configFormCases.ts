import {
  AgentFormCapability,
  ConfigForm,
  formFromConfig,
} from '../../src/config/configPanel';
import { defaultConfig } from '../../src/config/defaultConfig';
import { agentCapabilities, createAdapterRegistry } from '../../src/adapter';
import { LIMIT_BOUNDS, Limits } from '../../src/config/types';

/** The installed agent ids from the adapter registry, shared as the default option set. */
export const AGENT_IDS: readonly string[] = createAdapterRegistry().ids;

/** Default validation options using the installed agent ids and capabilities. */
export const DEFAULT_OPTIONS: {
  agents: readonly string[];
  byAgent: Readonly<Record<string, AgentFormCapability>>;
} = {
  agents: AGENT_IDS,
  byAgent: agentCapabilities(),
};

/** A fresh valid ConfigForm built from the default configuration. */
export function validForm(): ConfigForm {
  return formFromConfig(defaultConfig());
}

/** Deep-clone helper that applies mutator edits to a copy of the base form. */
export function withEdits(base: ConfigForm, mutator: (draft: ConfigForm) => void): ConfigForm {
  const cloned: ConfigForm = JSON.parse(JSON.stringify(base));
  mutator(cloned);
  return cloned;
}

/** One test fixture pinning a ConfigForm, its validation options, and its expected error paths. */
export interface ConfigFormCase {
  name: string;
  form: ConfigForm;
  options: {
    agents: readonly string[];
    byAgent: Readonly<Record<string, AgentFormCapability>>;
  };
  expectedPaths: readonly string[];
}

const cases: ConfigFormCase[] = [];

// (1) Default config — valid
cases.push({
  name: 'default config is valid',
  form: validForm(),
  options: DEFAULT_OPTIONS,
  expectedPaths: [],
});

// (2) Empty / whitespace agent on one role
cases.push({
  name: 'empty agent on planner role',
  form: withEdits(validForm(), (f) => {
    f.roles.planner.agent = '';
  }),
  options: DEFAULT_OPTIONS,
  expectedPaths: ['roles.planner.agent'],
});
cases.push({
  name: 'whitespace-only agent on executor role',
  form: withEdits(validForm(), (f) => {
    f.roles.executor.agent = '   ';
  }),
  options: DEFAULT_OPTIONS,
  expectedPaths: ['roles.executor.agent'],
});

// (3) Agent not in options.agents (exercises message interpolation)
cases.push({
  name: 'agent not in options.agents',
  form: withEdits(validForm(), (f) => {
    f.roles.planner.agent = 'uninstalled-agent';
  }),
  options: DEFAULT_OPTIONS,
  expectedPaths: ['roles.planner.agent'],
});

// (4) Out-of-set agent that IS passed in options.agents (round-trip case) — valid
cases.push({
  name: 'out-of-set agent passed in options.agents is valid',
  form: withEdits(validForm(), (f) => {
    f.roles.planner.agent = 'custom-agent';
  }),
  options: {
    agents: [...AGENT_IDS, 'custom-agent'],
    byAgent: {
      ...DEFAULT_OPTIONS.byAgent,
      'custom-agent': { models: [], efforts: [] },
    },
  },
  expectedPaths: [],
});

// (5) Empty and whitespace-only model
cases.push({
  name: 'empty model on reviewer role',
  form: withEdits(validForm(), (f) => {
    f.roles.reviewer.model = '';
  }),
  options: DEFAULT_OPTIONS,
  expectedPaths: ['roles.reviewer.model'],
});
cases.push({
  name: 'whitespace-only model on spec-writer role',
  form: withEdits(validForm(), (f) => {
    f.roles['spec-writer'].model = '   ';
  }),
  options: DEFAULT_OPTIONS,
  expectedPaths: ['roles.spec-writer.model'],
});

// (6) Effort: whitespace vs unset '' vs closed/open catalogue rules
cases.push({
  name: 'whitespace-only non-empty effort on executor role',
  form: withEdits(validForm(), (f) => {
    f.roles.executor.effort = '   ';
  }),
  options: DEFAULT_OPTIONS,
  expectedPaths: ['roles.executor.effort'],
});
cases.push({
  name: 'unset effort ("") on executor role is valid',
  form: withEdits(validForm(), (f) => {
    f.roles.executor.effort = '';
  }),
  options: DEFAULT_OPTIONS,
  expectedPaths: [],
});
// (a) a closed-set agent with an out-of-table effort — one roles.<role>.effort error
cases.push({
  name: 'closed-set agent with an out-of-table effort',
  form: withEdits(validForm(), (f) => {
    f.roles.executor.effort = 'unsupported-effort';
  }),
  options: DEFAULT_OPTIONS,
  expectedPaths: ['roles.executor.effort'],
});
// (b) the same case with that effort injected into byAgent — valid, the round-trip rule
cases.push({
  name: 'closed-set agent with out-of-table effort injected into byAgent is valid (round-trip rule)',
  form: withEdits(validForm(), (f) => {
    f.roles.executor.effort = 'unsupported-effort';
  }),
  options: {
    agents: DEFAULT_OPTIONS.agents,
    byAgent: {
      ...DEFAULT_OPTIONS.byAgent,
      claude: {
        ...DEFAULT_OPTIONS.byAgent.claude,
        efforts: [...DEFAULT_OPTIONS.byAgent.claude.efforts, 'unsupported-effort'],
      },
    },
  },
  expectedPaths: [],
});
// (c) opencode with a provider/model model and a hand-typed variant — valid
cases.push({
  name: 'opencode with a provider/model model and a hand-typed variant is valid',
  form: withEdits(validForm(), (f) => {
    f.roles.executor.agent = 'opencode';
    f.roles.executor.model = 'anthropic/claude-sonnet-5';
    f.roles.executor.effort = 'custom-variant';
  }),
  options: DEFAULT_OPTIONS,
  expectedPaths: [],
});
// (d) an out-of-table model on a closed-set agent — valid, pinning the deliberate absence of a model rule
cases.push({
  name: 'out-of-table model on a closed-set agent is valid (advisory dropdown)',
  form: withEdits(validForm(), (f) => {
    f.roles.executor.agent = 'claude';
    f.roles.executor.model = 'brand-new-claude-model-xyz';
  }),
  options: DEFAULT_OPTIONS,
  expectedPaths: [],
});

// (7) Each limit non-integer: '', 'abc', '1.5', '1e3', '+3', and padded ' 2 ' (valid)
const limitFields = Object.keys(LIMIT_BOUNDS) as (keyof Limits)[];
for (const field of limitFields) {
  for (const bad of ['', 'abc', '1.5', '1e3', '+3']) {
    cases.push({
      name: `limit ${field} non-integer "${bad}"`,
      form: withEdits(validForm(), (f) => {
        f.limits[field] = bad;
      }),
      options: DEFAULT_OPTIONS,
      expectedPaths: [`limits.${field}`],
    });
  }
  cases.push({
    name: `limit ${field} padded integer " 2 " is valid`,
    form: withEdits(validForm(), (f) => {
      f.limits[field] = ' 2 ';
    }),
    options: DEFAULT_OPTIONS,
    expectedPaths: [],
  });
}

// (8) Each limit below min and above max, including exact boundaries from LIMIT_BOUNDS
for (const field of limitFields) {
  const bounds = LIMIT_BOUNDS[field];

  // Min boundary (valid)
  cases.push({
    name: `limit ${field} at min boundary (${bounds.min}) is valid`,
    form: withEdits(validForm(), (f) => {
      f.limits[field] = String(bounds.min);
    }),
    options: DEFAULT_OPTIONS,
    expectedPaths: [],
  });

  // Max boundary (valid)
  cases.push({
    name: `limit ${field} at max boundary (${bounds.max}) is valid`,
    form: withEdits(validForm(), (f) => {
      f.limits[field] = String(bounds.max);
    }),
    options: DEFAULT_OPTIONS,
    expectedPaths: [],
  });

  // Below min
  cases.push({
    name: `limit ${field} below min (${bounds.min - 1})`,
    form: withEdits(validForm(), (f) => {
      f.limits[field] = String(bounds.min - 1);
    }),
    options: DEFAULT_OPTIONS,
    expectedPaths: [`limits.${field}`],
  });

  // Above max
  cases.push({
    name: `limit ${field} above max (${bounds.max + 1})`,
    form: withEdits(validForm(), (f) => {
      f.limits[field] = String(bounds.max + 1);
    }),
    options: DEFAULT_OPTIONS,
    expectedPaths: [`limits.${field}`],
  });
}

// (9) Empty and whitespace-only git.remote and git.base
cases.push({
  name: 'empty git.remote',
  form: withEdits(validForm(), (f) => {
    f.git.remote = '';
  }),
  options: DEFAULT_OPTIONS,
  expectedPaths: ['git.remote'],
});
cases.push({
  name: 'whitespace-only git.remote',
  form: withEdits(validForm(), (f) => {
    f.git.remote = '   ';
  }),
  options: DEFAULT_OPTIONS,
  expectedPaths: ['git.remote'],
});
cases.push({
  name: 'empty git.base',
  form: withEdits(validForm(), (f) => {
    f.git.base = '';
  }),
  options: DEFAULT_OPTIONS,
  expectedPaths: ['git.base'],
});
cases.push({
  name: 'whitespace-only git.base',
  form: withEdits(validForm(), (f) => {
    f.git.base = '   ';
  }),
  options: DEFAULT_OPTIONS,
  expectedPaths: ['git.base'],
});

// (10) Multi-error form pinning roles -> limits -> git and ROLES ordering
cases.push({
  name: 'multi-error form pinning roles -> limits -> git ordering and ROLES ordering',
  form: withEdits(validForm(), (f) => {
    f.roles['spec-writer'].agent = '';
    f.roles.planner.agent = 'uninstalled';
    f.roles['plan-reviewer'].model = '   ';
    f.roles.executor.effort = '   ';
    f.limits.plan_review_rounds = '11';
    f.limits.exec_attempts = 'abc';
    f.limits.stall_notice_minutes = '0';
    f.git.remote = '';
    f.git.base = '   ';
  }),
  options: DEFAULT_OPTIONS,
  expectedPaths: [
    'roles.spec-writer.agent',
    'roles.planner.agent',
    'roles.plan-reviewer.model',
    'roles.executor.effort',
    'limits.plan_review_rounds',
    'limits.exec_attempts',
    'limits.stall_notice_minutes',
    'git.remote',
    'git.base',
  ],
});

export const CONFIG_FORM_CASES: readonly ConfigFormCase[] = cases;
