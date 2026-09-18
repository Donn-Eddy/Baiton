import * as assert from 'assert';
import * as fc from 'fast-check';
import {
  ConfigForm,
  ConfigFormOptions,
  RoleFormEntry,
  validateConfigForm,
} from '../src/config/configPanel';
import { LIMIT_BOUNDS, Limits } from '../src/config/types';
import { Role, ROLES } from '../src/model';
import { AGENT_IDS } from './fixtures/configFormCases';
import { loadConfigMirror } from './configPanel.mirror.test';

/**
 * Feature: config-panel, Property: the browser mirror validates identically to the TS core
 */

describe('config panel mirror properties (config-panel T09)', () => {
  const mirror = loadConfigMirror();

  const roleEntryArb: fc.Arbitrary<RoleFormEntry> = fc.record({
    agent: fc.constantFrom(...AGENT_IDS, '', '  ', 'nope'),
    model: fc.oneof(fc.constantFrom('', ' ', 'm'), fc.string()),
    effort: fc.constantFrom('', ' ', 'low', 'medium', 'high', 'xhigh'),
  });

  const rolesRecord = {} as Record<Role, fc.Arbitrary<RoleFormEntry>>;
  for (const role of ROLES) {
    rolesRecord[role] = roleEntryArb;
  }
  const rolesArb = fc.record(rolesRecord);

  function fieldLimitArb(field: keyof Limits): fc.Arbitrary<string> {
    const bounds = LIMIT_BOUNDS[field];
    return fc.oneof(
      fc.constantFrom('', 'abc', '1.5', '+3', '-1'),
      fc.integer({ min: bounds.min - 3, max: bounds.max + 3 }).map(String),
    );
  }

  const limitsArb = fc.record({
    plan_review_rounds: fieldLimitArb('plan_review_rounds'),
    exec_attempts: fieldLimitArb('exec_attempts'),
    stall_notice_minutes: fieldLimitArb('stall_notice_minutes'),
  });

  const gitArb = fc.record({
    remote: fc.oneof(fc.constantFrom('', ' '), fc.string()),
    base: fc.oneof(fc.constantFrom('', ' '), fc.string()),
  });

  const formArb: fc.Arbitrary<ConfigForm> = fc.record({
    roles: rolesArb,
    limits: limitsArb,
    git: gitArb,
  });

  const byAgentEntryArb = fc.record({
    models: fc.array(fc.string({ minLength: 1, maxLength: 20 }), { maxLength: 3 }),
    efforts: fc.array(fc.constantFrom('low', 'medium', 'high', 'custom'), { maxLength: 3 }),
  });

  const optionsArb: fc.Arbitrary<ConfigFormOptions> = fc.record({
    agents: fc
      .subarray([...AGENT_IDS], { minLength: 0 })
      .chain((subset) =>
        fc.boolean().map((extra) => (extra ? [...subset, 'extra-agent'] : subset)),
      ),
    byAgent: fc.oneof(
      fc.constant({}),
      fc.dictionary(fc.constantFrom(...AGENT_IDS, 'extra-agent', 'other'), byAgentEntryArb),
    ),
  });

  // Feature: config-panel, Property: the browser mirror validates identically to the TS core
  it('the browser mirror validateConfigForm returns verbatim identical errors to TypeScript core', () => {
    fc.assert(
      fc.property(formArb, optionsArb, (form, options) => {
        const tsErrors = validateConfigForm(form, options);
        const jsErrors = mirror.validateConfigForm(form, options);
        assert.deepStrictEqual(jsErrors, tsErrors);
      }),
      { numRuns: 200 },
    );
  });
});
