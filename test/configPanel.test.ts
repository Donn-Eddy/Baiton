import * as assert from 'assert';
import {
  ConfigFieldError,
  ConfigForm,
  EFFORT_OPTIONS,
  applyFormToDocument,
  configFormOptions,
  formFromConfig,
  formFromDocument,
  validateConfigForm,
} from '../src/config/configPanel';
import { defaultConfig, defaultConfigJson } from '../src/config/defaultConfig';
import { LIMIT_BOUNDS, Limits, SUPPORTED_VERSION } from '../src/config/types';
import { ROLES } from '../src/model';
import { createAdapterRegistry } from '../src/adapter';

/**
 * Unit tests for the Config Panel host-free core (spec "Config Panel",
 * config-panel T03): the form mapping (`formFromConfig`/`formFromDocument`),
 * validation (`validateConfigForm`), the dropdown option sets
 * (`configFormOptions`), the merge back into a raw document
 * (`applyFormToDocument`), and the round trips between them.
 *
 * This file carries no `vscode` import and no Node built-in import, matching
 * the module under test.
 */

describe('config panel core (config-panel T03)', () => {
  const AGENTS = createAdapterRegistry().ids;
  const OPTIONS = { agents: AGENTS };

  /** A fresh valid form built from the default config. */
  function validForm(): ConfigForm {
    return formFromConfig(defaultConfig());
  }

  /** Deep-clone a JSON-safe value. */
  function clone<T>(v: T): T {
    return JSON.parse(JSON.stringify(v)) as T;
  }

  /** The `path` of every error, for asserting on the stable path contract. */
  function paths(errors: ConfigFieldError[]): string[] {
    return errors.map((e) => e.path);
  }

  describe('formFromConfig', () => {
    it('orders role keys by ROLES, not by the config object', () => {
      const form = formFromConfig(defaultConfig());
      assert.deepStrictEqual(Object.keys(form.roles), [...ROLES]);
    });

    it('renders limits as their decimal text', () => {
      const config = defaultConfig();
      const form = formFromConfig(config);
      assert.strictEqual(form.limits.plan_review_rounds, String(config.limits.plan_review_rounds));
      assert.strictEqual(form.limits.exec_attempts, String(config.limits.exec_attempts));
      assert.strictEqual(form.limits.stall_notice_minutes, String(config.limits.stall_notice_minutes));
    });

    it('leaves effort "" when unset and copies it verbatim when set', () => {
      const config = defaultConfig();
      delete config.roles.planner.effort;
      const form = formFromConfig(config);
      assert.strictEqual(form.roles.planner.effort, '');
      assert.strictEqual(form.roles.executor.effort, config.roles.executor.effort);
    });

    it('copies git.remote and git.base verbatim', () => {
      const config = defaultConfig();
      const form = formFromConfig(config);
      assert.strictEqual(form.git.remote, config.git.remote);
      assert.strictEqual(form.git.base, config.git.base);
    });
  });

  describe('formFromDocument', () => {
    /** Assert `form` is the fully-empty form every ROLES entry has when the document has nothing usable. */
    function assertEmptyForm(form: ConfigForm): void {
      assert.deepStrictEqual(Object.keys(form.roles), [...ROLES]);
      for (const role of ROLES) {
        assert.deepStrictEqual(form.roles[role], { agent: '', model: '', effort: '' });
      }
      assert.strictEqual(form.limits.plan_review_rounds, '');
      assert.strictEqual(form.limits.exec_attempts, '');
      assert.strictEqual(form.limits.stall_notice_minutes, '');
      assert.strictEqual(form.git.remote, '');
      assert.strictEqual(form.git.base, '');
    }

    it('yields the empty form for {}', () => {
      assertEmptyForm(formFromDocument({}));
    });

    it('never throws and yields the empty form for non-object inputs', () => {
      for (const value of [null, [], 3, 'x', undefined]) {
        assertEmptyForm(formFromDocument(value));
      }
    });

    it('coerces wrong-typed leaves to ""', () => {
      const doc = JSON.parse(defaultConfigJson());
      doc.roles.planner.agent = 42;
      doc.limits.exec_attempts = '3';
      doc.limits.plan_review_rounds = NaN;
      doc.limits.stall_notice_minutes = Infinity;
      doc.git.base = null;

      const form = formFromDocument(doc);

      assert.strictEqual(form.roles.planner.agent, '');
      assert.strictEqual(form.limits.exec_attempts, '');
      assert.strictEqual(form.limits.plan_review_rounds, '');
      assert.strictEqual(form.limits.stall_notice_minutes, '');
      assert.strictEqual(form.git.base, '');
    });

    it('renders a finite non-integer limit as its decimal text (validation rejects it later)', () => {
      const doc = JSON.parse(defaultConfigJson());
      doc.limits.exec_attempts = 2.5;
      const form = formFromDocument(doc);
      assert.strictEqual(form.limits.exec_attempts, '2.5');
    });

    it('ignores unknown role keys and treats a non-object "roles" as empty', () => {
      const doc = JSON.parse(defaultConfigJson());
      doc.roles.custom = { agent: 'claude', model: 'x' };
      const form = formFromDocument(doc);
      assert.strictEqual((form.roles as Record<string, unknown>).custom, undefined);
      assert.deepStrictEqual(Object.keys(form.roles), [...ROLES]);

      for (const rolesValue of [[], 'x']) {
        assertEmptyForm(formFromDocument({ roles: rolesValue }));
      }
    });
  });

  describe('validateConfigForm', () => {
    it('returns [] for a clean valid form', () => {
      assert.deepStrictEqual(validateConfigForm(validForm(), OPTIONS), []);
    });

    it('accepts every installed agent id, since the dropdown and the validator share the registry', () => {
      for (const id of AGENTS) {
        const form = validForm();
        form.roles.planner.agent = id;
        assert.deepStrictEqual(validateConfigForm(form, OPTIONS), []);
      }
    });

    it('flags an empty or whitespace-only agent at roles.<role>.agent', () => {
      for (const value of ['', '   ']) {
        const form = validForm();
        form.roles.planner.agent = value;
        const errors = validateConfigForm(form, OPTIONS);
        assert.deepStrictEqual(paths(errors), ['roles.planner.agent']);
      }
    });

    it('flags an agent not in the registry, naming it and the installed list', () => {
      const form = validForm();
      form.roles.planner.agent = 'nope';
      const errors = validateConfigForm(form, OPTIONS);
      assert.deepStrictEqual(paths(errors), ['roles.planner.agent']);
      assert.ok(errors[0].message.includes('nope'));
      assert.ok(errors[0].message.includes(AGENTS.join(', ')));
    });

    it('flags an empty or whitespace-only model at roles.<role>.model', () => {
      for (const value of ['', '   ']) {
        const form = validForm();
        form.roles.executor.model = value;
        const errors = validateConfigForm(form, OPTIONS);
        assert.deepStrictEqual(paths(errors), ['roles.executor.model']);
      }
    });

    it('effort: "" is valid (unset), whitespace-only is an error, out-of-set is valid', () => {
      // Deliberate: effort has no closed set at the form/validator boundary.
      // "" means "not set" and is fine; a non-blank value is passed through
      // even when it falls outside EFFORT_OPTIONS, so a config saved with a
      // future effort level still round-trips through the panel instead of
      // being rejected by an older build's validator.
      const unset = validForm();
      unset.roles.reviewer.effort = '';
      assert.deepStrictEqual(validateConfigForm(unset, OPTIONS), []);

      const blank = validForm();
      blank.roles.reviewer.effort = '   ';
      assert.deepStrictEqual(paths(validateConfigForm(blank, OPTIONS)), ['roles.reviewer.effort']);

      const outOfSet = validForm();
      outOfSet.roles.reviewer.effort = 'xhigh';
      assert.deepStrictEqual(validateConfigForm(outOfSet, OPTIONS), []);
    });

    it('limits: boundaries validate clean, one-past-bounds fails with both bounds and the value named', () => {
      const fields = Object.keys(LIMIT_BOUNDS) as (keyof Limits)[];
      for (const field of fields) {
        const bounds = LIMIT_BOUNDS[field];

        for (const ok of [bounds.min, bounds.max]) {
          const form = validForm();
          form.limits[field] = String(ok);
          assert.deepStrictEqual(validateConfigForm(form, OPTIONS), []);
        }

        for (const bad of [bounds.min - 1, bounds.max + 1]) {
          const form = validForm();
          form.limits[field] = String(bad);
          const errors = validateConfigForm(form, OPTIONS);
          assert.deepStrictEqual(paths(errors), [`limits.${field}`]);
          assert.ok(errors[0].message.includes(String(bounds.min)));
          assert.ok(errors[0].message.includes(String(bounds.max)));
          assert.ok(errors[0].message.includes(String(bad)));
        }
      }
    });

    it('limits: non-integer text fails as "must be an integer" with no second range error', () => {
      const fields = Object.keys(LIMIT_BOUNDS) as (keyof Limits)[];
      for (const field of fields) {
        for (const bad of ['', 'abc', '1.5', '1e3', '0x2', '  ']) {
          const form = validForm();
          form.limits[field] = bad;
          const errors = validateConfigForm(form, OPTIONS);
          assert.strictEqual(errors.length, 1, `expected exactly one error for ${field}=${JSON.stringify(bad)}`);
          assert.strictEqual(errors[0].path, `limits.${field}`);
          assert.ok(/integer/.test(errors[0].message));
        }
      }
    });

    it('limits: padded-but-integer text within range validates clean', () => {
      const form = validForm();
      form.limits.exec_attempts = ' 2 ';
      assert.deepStrictEqual(validateConfigForm(form, OPTIONS), []);
    });

    it('flags empty or whitespace-only git.remote / git.base', () => {
      for (const value of ['', '   ']) {
        const remoteForm = validForm();
        remoteForm.git.remote = value;
        assert.deepStrictEqual(paths(validateConfigForm(remoteForm, OPTIONS)), ['git.remote']);

        const baseForm = validForm();
        baseForm.git.base = value;
        assert.deepStrictEqual(paths(validateConfigForm(baseForm, OPTIONS)), ['git.base']);
      }
    });

    it('aggregates every error, ordered roles -> limits -> git', () => {
      const form = validForm();
      form.roles.planner.agent = '';
      form.roles.executor.model = '';
      form.limits.exec_attempts = 'abc';
      form.git.remote = '';
      form.git.base = '';

      const errors = validateConfigForm(form, OPTIONS);

      assert.deepStrictEqual(paths(errors), [
        'roles.planner.agent',
        'roles.executor.model',
        'limits.exec_attempts',
        'git.remote',
        'git.base',
      ]);
    });
  });

  describe('configFormOptions', () => {
    it('with no form, returns the installed agents and EFFORT_OPTIONS as copies', () => {
      const before = createAdapterRegistry().ids;
      const result = configFormOptions(AGENTS);
      assert.deepStrictEqual(result, { agents: [...AGENTS], efforts: [...EFFORT_OPTIONS] });

      // Mutating the result must not disturb the registry.
      (result.agents as string[]).push('mutated');
      (result.efforts as string[]).push('mutated');
      assert.deepStrictEqual(createAdapterRegistry().ids, before);
    });

    it('appends an unknown agent and effort once each, after the known values, in ROLES order', () => {
      const form = validForm();
      form.roles.planner.agent = 'unknown-agent';
      form.roles.executor.effort = 'unknown-effort';
      // Duplicate the unknown agent in a later role to prove it is only appended once.
      form.roles.reviewer.agent = 'unknown-agent';
      form.roles['plan-reviewer'].effort = 'unknown-effort';

      const options = configFormOptions(AGENTS, form);

      assert.deepStrictEqual(options.agents, [...AGENTS, 'unknown-agent']);
      assert.deepStrictEqual(options.efforts, [...EFFORT_OPTIONS, 'unknown-effort']);
    });

    it('never duplicates installed ids / in-set efforts and ignores ""', () => {
      const form = validForm();
      form.roles.planner.effort = '';
      const options = configFormOptions(AGENTS, form);
      assert.deepStrictEqual(options.agents, [...AGENTS]);
      assert.deepStrictEqual(options.efforts, [...EFFORT_OPTIONS]);
    });
  });

  describe('applyFormToDocument', () => {
    /** A default document plus keys the form never manages. */
    function docWithUnmanagedKeys(): Record<string, unknown> {
      const raw = JSON.parse(defaultConfigJson());
      raw.pr = { tool: 'gh' };
      raw.git.verify = 'npm test';
      raw.roles.executor.notes = 'keep me';
      raw.roles.custom = { agent: 'x' };
      raw.experimental = { x: 1 };
      return raw;
    }

    it('preserves every unmanaged key, trims and applies edits, and does not mutate the input', () => {
      const raw = docWithUnmanagedKeys();
      const before = clone(raw);

      const form = validForm();
      const newAgent = AGENTS[AGENTS.length - 1];
      form.roles.planner.agent = `  ${newAgent}  `;
      form.roles.planner.model = '  new-model  ';
      form.roles.planner.effort = '  ';
      form.roles.executor.effort = '  high  ';
      form.limits.plan_review_rounds = ' 2 ';
      form.limits.exec_attempts = ' 4 ';
      form.limits.stall_notice_minutes = ' 20 ';
      form.git.remote = '  upstream  ';
      form.git.base = '  develop  ';

      const out = applyFormToDocument(raw, form);

      // Preserved keys, byte-equal.
      assert.deepStrictEqual(out.pr, before.pr);
      assert.deepStrictEqual((out.git as Record<string, unknown>).verify, (before.git as Record<string, unknown>).verify);
      assert.strictEqual((out.roles as Record<string, unknown>).custom !== undefined, true);
      assert.deepStrictEqual(
        (out.roles as Record<string, unknown>).custom,
        (before.roles as Record<string, unknown>).custom,
      );
      assert.deepStrictEqual(out.experimental, before.experimental);
      const outExecutor = (out.roles as Record<string, Record<string, unknown>>).executor;
      assert.strictEqual(outExecutor.notes, 'keep me');

      // Edited fields present and trimmed.
      const outPlanner = (out.roles as Record<string, Record<string, unknown>>).planner;
      assert.strictEqual(outPlanner.agent, newAgent);
      assert.strictEqual(outPlanner.model, 'new-model');
      assert.ok(!('effort' in outPlanner), 'cleared effort should be absent, not undefined');
      assert.strictEqual(outExecutor.effort, 'high');

      const outLimits = out.limits as Record<string, unknown>;
      assert.strictEqual(outLimits.plan_review_rounds, 2);
      assert.strictEqual(typeof outLimits.plan_review_rounds, 'number');
      assert.strictEqual(outLimits.exec_attempts, 4);
      assert.strictEqual(outLimits.stall_notice_minutes, 20);

      const outGit = out.git as Record<string, unknown>;
      assert.strictEqual(outGit.remote, 'upstream');
      assert.strictEqual(outGit.base, 'develop');

      // rawDoc is not mutated.
      assert.deepStrictEqual(raw, before);
    });

    it('rewrites an absent, wrong-typed, or too-new version to SUPPORTED_VERSION; leaves a correct one as is', () => {
      // Deliberate (see risks): applyFormToDocument always writes the
      // supported version; it does not refuse a document declaring a newer
      // one. loadConfig itself still rejects a too-new version on read.
      const form = validForm();

      for (const version of [undefined, 'x', SUPPORTED_VERSION + 1]) {
        const raw = JSON.parse(defaultConfigJson());
        if (version === undefined) {
          delete raw.version;
        } else {
          raw.version = version;
        }
        const out = applyFormToDocument(raw, form);
        assert.strictEqual(out.version, SUPPORTED_VERSION);
      }

      const raw = JSON.parse(defaultConfigJson());
      raw.version = SUPPORTED_VERSION;
      const out = applyFormToDocument(raw, form);
      assert.strictEqual(out.version, SUPPORTED_VERSION);
    });

    it('produces a complete document for null / [] rawDoc', () => {
      for (const rawDoc of [null, []]) {
        const out = applyFormToDocument(rawDoc, validForm());
        assert.deepStrictEqual(Object.keys(out.roles as Record<string, unknown>), [...ROLES]);
        assert.strictEqual(Object.keys(out.limits as Record<string, unknown>).length >= 3, true);
        assert.ok(out.git !== undefined);
      }
    });
  });

  describe('round trips', () => {
    it('identity: applying an unedited form changes nothing', () => {
      const raw = JSON.parse(defaultConfigJson());
      const out = applyFormToDocument(raw, formFromConfig(defaultConfig()));
      assert.deepStrictEqual(out, JSON.parse(defaultConfigJson()));
    });

    it('formFromDocument(applyFormToDocument(raw, form)) equals the trimmed form', () => {
      const raw = JSON.parse(defaultConfigJson());
      const form = validForm();
      form.roles.planner.agent = '  claude  ';
      form.git.remote = '  origin  ';

      const applied = applyFormToDocument(raw, form);
      const roundTripped = formFromDocument(applied);

      const expected: ConfigForm = clone(form);
      for (const role of ROLES) {
        expected.roles[role] = {
          agent: expected.roles[role].agent.trim(),
          model: expected.roles[role].model.trim(),
          effort: expected.roles[role].effort.trim(),
        };
      }
      expected.limits = {
        plan_review_rounds: expected.limits.plan_review_rounds.trim(),
        exec_attempts: expected.limits.exec_attempts.trim(),
        stall_notice_minutes: expected.limits.stall_notice_minutes.trim(),
      };
      expected.git = {
        remote: expected.git.remote.trim(),
        base: expected.git.base.trim(),
      };

      assert.deepStrictEqual(roundTripped, expected);
    });
  });
});
