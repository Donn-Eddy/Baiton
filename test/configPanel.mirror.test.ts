import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import {
  ConfigFieldError,
  ConfigForm,
  EFFORT_OPTIONS,
  validateConfigForm,
} from '../src/config/configPanel';
import { LIMIT_BOUNDS } from '../src/config/types';
import { ROLES } from '../src/model';
import { CONFIG_FORM_CASES } from './fixtures/configFormCases';

/**
 * Parity tests asserting that the browser mirror `media/config.js` and the
 * TypeScript core `src/config/configPanel.ts` behave identically.
 *
 * NOTE: `assert.deepStrictEqual` over the error arrays compares `message`
 * strings verbatim (path AND verbatim message, in order). That is the intent:
 * any wording change to a validation message must be made in both files or
 * this suite will fail, which is the sync guard working, not a flake. Do not
 * weaken the assertions to compare paths only.
 */

export interface ConfigMirror {
  ROLES: readonly string[];
  EFFORT_OPTIONS: readonly string[];
  LIMIT_BOUNDS: Record<string, { min: number; max: number }>;
  validateConfigForm(
    form: ConfigForm,
    options: { agents: readonly string[] },
  ): ConfigFieldError[];
}

export function loadConfigMirror(): ConfigMirror {
  const sourcePath = path.join(__dirname, '..', 'media', 'config.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const sandbox: { window: { baitonConfigForm?: ConfigMirror } } = { window: {} };
  vm.runInNewContext(source, sandbox, { filename: 'media/config.js' });
  const raw = sandbox.window.baitonConfigForm;
  assert.ok(raw, 'window.baitonConfigForm was not exported by media/config.js');
  return {
    ROLES: Array.from(raw.ROLES),
    EFFORT_OPTIONS: Array.from(raw.EFFORT_OPTIONS),
    LIMIT_BOUNDS: JSON.parse(JSON.stringify(raw.LIMIT_BOUNDS)),
    validateConfigForm(form, options) {
      const errors = raw.validateConfigForm(form, options);
      return Array.from(errors, (e) => ({ path: e.path, message: e.message }));
    },
  };
}

describe('config panel browser mirror (config-panel T09)', () => {
  let mirror: ConfigMirror;

  before(() => {
    mirror = loadConfigMirror();
  });

  it('exports window.baitonConfigForm when evaluated outside a webview', () => {
    assert.ok(mirror);
    assert.strictEqual(typeof mirror.validateConfigForm, 'function');
  });

  it('mirrors ROLES with identical element order', () => {
    assert.deepStrictEqual(mirror.ROLES, ROLES);
  });

  it('mirrors EFFORT_OPTIONS with identical element order', () => {
    assert.deepStrictEqual(mirror.EFFORT_OPTIONS, [...EFFORT_OPTIONS]);
  });

  it('mirrors LIMIT_BOUNDS values and explicit key order', () => {
    assert.deepStrictEqual(mirror.LIMIT_BOUNDS, LIMIT_BOUNDS);
    assert.deepStrictEqual(Object.keys(mirror.LIMIT_BOUNDS), Object.keys(LIMIT_BOUNDS));
  });

  describe('validation parity over fixture cases', () => {
    for (const c of CONFIG_FORM_CASES) {
      it(c.name, () => {
        const tsErrors = validateConfigForm(c.form, c.options);
        const jsErrors = mirror.validateConfigForm(c.form, c.options);

        // Verbatim comparison of full ConfigFieldError objects (path + message) in order
        assert.deepStrictEqual(
          jsErrors,
          tsErrors,
          `Mirror errors do not match TypeScript errors for "${c.name}"`,
        );

        // Pin behaviour against the expected paths contract
        assert.deepStrictEqual(
          tsErrors.map((e) => e.path),
          c.expectedPaths,
          `TypeScript error paths do not match expectedPaths for "${c.name}"`,
        );
      });
    }
  });

  it('neither validator mutates the form it is given (purity check)', () => {
    const multiErrorCase = CONFIG_FORM_CASES.find((c) => c.expectedPaths.length > 3);
    assert.ok(multiErrorCase, 'Multi-error fixture must exist');

    const formClone1: ConfigForm = JSON.parse(JSON.stringify(multiErrorCase.form));
    const formClone2: ConfigForm = JSON.parse(JSON.stringify(multiErrorCase.form));

    validateConfigForm(formClone1, multiErrorCase.options);
    assert.deepStrictEqual(formClone1, formClone2, 'TS validateConfigForm mutated input form');

    mirror.validateConfigForm(formClone1, multiErrorCase.options);
    assert.deepStrictEqual(formClone1, formClone2, 'Mirror validateConfigForm mutated input form');
  });
});
