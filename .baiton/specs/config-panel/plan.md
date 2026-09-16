# plan result

```json
{
  "steps": [
    {
      "title": "Add the shared validation fixture set",
      "detail": "Create `test/fixtures/configFormCases.ts` (a plain module, not a `*.test.ts`, so mocha's `test/**/*.test.ts` spec glob does not treat it as a suite). Export `AGENT_IDS = createAdapterRegistry().ids` for the default option set, a `validForm()` helper that builds a `ConfigForm` from `defaultConfig()` via `formFromConfig`, a `withEdits(...)` deep-clone helper, and `export const CONFIG_FORM_CASES: readonly ConfigFormCase[]` where `ConfigFormCase = { name: string; form: ConfigForm; options: { agents: readonly string[] }; expectedPaths: readonly string[] }`. `expectedPaths` is the ordered list of `ConfigFieldError.path` values the case must produce, so the fixtures pin the actual behaviour rather than only asserting that the two implementations agree with each other. Cover, at minimum: (1) the default config — valid, `[]`; (2) empty `agent` on one role; (3) an `agent` not in `options.agents` (exercises the `installed: a, b` message interpolation); (4) an out-of-set agent that IS passed in `options.agents` (the round-trip case from `configFormOptions`) — valid; (5) empty and whitespace-only `model`; (6) whitespace-only non-empty `effort` (`' '`) vs `''` (unset, valid) vs an out-of-set effort such as `'xhigh'` (valid — effort is not range-checked); (7) each limit non-integer (`''`, `'abc'`, `'1.5'`, `'1e3'`, `' 2 '` which is valid after trim, `'+3'` which is NOT matched by `/^-?\\d+$/`); (8) each limit below min and above max, including the exact boundaries from `LIMIT_BOUNDS` (0/10, 1/10, 1/1440) as valid; (9) empty and whitespace-only `git.remote` and `git.base`; (10) a multi-error form that violates a role rule, a limits rule and a git rule at once, whose `expectedPaths` pins the roles -> limits -> git ordering and the ROLES ordering within the roles block. Build every case by cloning the valid form so the fixtures stay readable and one rule is exercised per case.",
      "files": [
        "test/fixtures/configFormCases.ts",
        "src/config/configPanel.ts",
        "src/config/defaultConfig.ts",
        "src/config/types.ts",
        "src/adapter/index.ts"
      ]
    },
    {
      "title": "Add a loader that evaluates media/config.js outside a webview",
      "detail": "In the new parity test, add a small `loadConfigMirror()` helper that reads `media/config.js` with `fs.readFileSync(path.join(__dirname, '..', 'media', 'config.js'), 'utf8')` and evaluates it with `vm.runInNewContext(source, sandbox, { filename: 'media/config.js' })`, where `sandbox` is `{ window: {} }` and nothing else. This is exactly the environment the mirror block was written for: the IIFE assigns `window.baitonConfigForm` and then returns at the `typeof acquireVsCodeApi !== 'function'` guard, so no DOM global is ever touched. `typeof` on an unbound identifier does not throw in a fresh vm context, so no `acquireVsCodeApi` stub is needed. Return `sandbox.window.baitonConfigForm` typed through a local interface (`ConfigMirror` with `ROLES: string[]`, `EFFORT_OPTIONS: string[]`, `LIMIT_BOUNDS: Record<string, { min: number; max: number }>`, `validateConfigForm(form: ConfigForm, options: { agents: readonly string[] }): ConfigFieldError[]`) rather than `any`, so the file stays clean under the repo's `@typescript-eslint/recommended` setup. Assert in the loader (or in a first `it`) that the export is present, which turns 'someone moved code above the guard and the IIFE now throws on `document`' into a clear failure.",
      "files": [
        "test/configPanel.mirror.test.ts",
        "media/config.js"
      ]
    },
    {
      "title": "Add test/configPanel.mirror.test.ts asserting TS/mirror parity",
      "detail": "New mocha suite `describe('config panel browser mirror (config-panel T09)')`, written in the style of `test/webviewProtocol.reducer.test.ts` (plain `assert`, one behaviour per `it`). Load the mirror once in a `before`. Assertions: (a) `assert.deepStrictEqual(mirror.ROLES, ROLES)` against `src/model`'s `ROLES` — element order included, since the validator's error order depends on it; (b) `assert.deepStrictEqual(mirror.EFFORT_OPTIONS, [...EFFORT_OPTIONS])` against `src/config/configPanel`; (c) `assert.deepStrictEqual(mirror.LIMIT_BOUNDS, LIMIT_BOUNDS)` AND, separately, `assert.deepStrictEqual(Object.keys(mirror.LIMIT_BOUNDS), Object.keys(LIMIT_BOUNDS))`, because `deepStrictEqual` ignores key order while both validators walk `Object.keys(LIMIT_BOUNDS)` and emit limit errors in that order; (d) a loop over `CONFIG_FORM_CASES` that, per case, computes `tsErrors = validateConfigForm(case.form, case.options)` and `jsErrors = mirror.validateConfigForm(case.form, case.options)`, then asserts `deepStrictEqual(jsErrors, tsErrors)` (full objects — `path` AND verbatim `message`, in order) and `deepStrictEqual(tsErrors.map(e => e.path), case.expectedPaths)`; (e) a purity check: deep-clone one multi-error fixture form, run both validators over it, and assert the form still deep-equals the clone, so neither implementation mutates its input. Use `case.name` in the `it` titles (or in the assert messages of a single table-driven `it`) so a divergence report names the offending fixture.",
      "files": [
        "test/configPanel.mirror.test.ts",
        "test/fixtures/configFormCases.ts",
        "test/webviewProtocol.reducer.test.ts",
        "src/config/configPanel.ts",
        "src/model/role.ts"
      ]
    },
    {
      "title": "Add a fast-check parity property over generated forms",
      "detail": "Add `test/configPanel.mirror.property.test.ts` (the `*.property.test.ts` suffix keeps it in `npm run test:property`, matching `test/configPanel.form.property.test.ts`). Header comment in the repo's format: 'Feature: config-panel, Property: the browser mirror validates identically to the TS core'. Build a `ConfigForm` arbitrary that deliberately straddles every rule: agent drawn from `fc.constantFrom(...AGENT_IDS, '', '  ', 'nope')`, model from `fc.oneof(fc.constantFrom('', ' ', 'm'), fc.string())`, effort from `fc.constantFrom('', ' ', 'low', 'medium', 'high', 'xhigh')`, each limit from `fc.oneof(fc.constantFrom('', 'abc', '1.5', '+3', '-1'), fc.integer({ min: bounds.min - 3, max: bounds.max + 3 }).map(String))` reusing the `limitArb` shape already in `configPanel.form.property.test.ts`, and git fields from `fc.oneof(fc.constantFrom('', ' '), fc.string())`. Also vary `options.agents` (a subset of the installed ids, sometimes with an extra id appended) so the 'not an installed agent' message's `join(', ')` interpolation is compared under more than one agent list. Assert `deepStrictEqual` of the two error arrays for every generated form. This is what catches divergence the hand-written fixtures do not enumerate; the fixture suite remains the readable, behaviour-pinning half.",
      "files": [
        "test/configPanel.mirror.property.test.ts",
        "test/configPanel.form.property.test.ts",
        "test/fixtures/configFormCases.ts",
        "src/config/configPanel.ts"
      ]
    },
    {
      "title": "Reconcile any divergence and cross-reference the two implementations",
      "detail": "Run the new suites first and fix whatever they surface, treating `src/config/configPanel.ts` as the source of truth and editing `media/config.js` to match (the mirror block is a verbatim port, so a fix is a port, not a redesign). A read of both today shows the constants and every validation rule and message string already agree — `includes` vs `indexOf(...) === -1` is the only textual difference and is equivalent for the string values involved — so expect no behavioural change; if the suites pass unchanged, make no logic edit. Then close the documentation loop the mirror already promises: update the header comment in `media/config.js` to say the parity test exists and name it (it currently reads 'Todo T09 adds a fixture test...' in the future tense), and add a matching one-line note to the module doc of `src/config/configPanel.ts` naming `media/config.js` as its plain-script mirror and `test/configPanel.mirror.test.ts` as the guard, so an edit starting from the TypeScript side is told about the mirror too. Keep the mirror block in `media/config.js` self-contained above the `acquireVsCodeApi` guard — the loader in step 2 depends on that, and the comment should say so.",
      "files": [
        "media/config.js",
        "src/config/configPanel.ts"
      ]
    },
    {
      "title": "Document the Open Config Panel command in the README",
      "detail": "Add a `### The config panel` subsection (under `## The Baiton views`, after `### Driving a spec`) plus a bullet in the existing `## Commands` list: '**Baiton: Open Config Panel** (`baiton.openConfigPanel`) — opens `.baiton/config.json` as a form.' Keep the prose to the repo's tone and to what the code actually does: (1) the panel edits the six role entries (agent dropdown from the installed adapter ids, model text, effort `low`/`medium`/`high` with `(default)` for unset), the three limits with their bounds, and `git.remote`/`git.base`; (2) every other key in the file — `version`, `pr`, `git.verify`, unknown keys, an out-of-set agent or effort — is preserved, and the file is rewritten two-space-indented with a trailing newline; (3) fields validate as you type and again host-side on Save, so the webview cannot write a config `loadConfig` would reject; (4) the **reset path**: the command is registered before the activation gate, so it opens even when `.baiton/config.json` is absent or unparseable — the panel shows that error with **Reset to defaults**, which asks for confirmation and then writes the default config, discarding the current contents (quote the behaviour, not `RESET_CONFIRM_MESSAGE` verbatim); (5) external edits — the file is watched while the panel is open, a pristine form reloads itself, a dirty one offers Reload/Keep editing, and a Save against a stale file is refused with Reload/Overwrite; (6) the **reload-after-save note**: saving applies the new configuration to the running extension in place, so no window reload is needed, and the panel reports anything that could not take effect immediately — a stage already in flight keeps the model, effort and agent it launched with (new values apply to the next run), a missing agent binary is reported, and a panel opened against a different workspace folder than the activated one writes the file without applying it live. Check the wording against `IN_FLIGHT_NOTE`, `NOT_ACTIVATED_NOTE` and `FOLDER_MISMATCH_NOTE` in `src/activation/configRefresh.ts` so the README does not overstate the hot-reload guarantee.",
      "files": [
        "README.md",
        "src/activation/configRefresh.ts",
        "src/activation/configPanelController.ts",
        "src/config/configPanel.ts",
        "package.json"
      ]
    },
    {
      "title": "Verify",
      "detail": "Run `npm run compile` (tsc is strict with `noUnusedLocals`/`noUnusedParameters`, so the new fixture module must export everything it defines), `npm run lint` (covers `src` and `test`; `media/**/*.js` is in eslint's `ignorePatterns`), then `npx mocha test/configPanel.mirror.test.ts test/configPanel.mirror.property.test.ts` for the new suites and the full `npm test` to confirm nothing else regressed. Sanity-check the loader in isolation once — a stray `document` reference above the guard in `media/config.js` would make the vm evaluation throw, and that should be a loud failure, not a skipped suite.",
      "files": [
        "package.json",
        ".mocharc.json",
        "tsconfig.json",
        ".eslintrc.json"
      ]
    }
  ],
  "risks": [
    "The mirror is loaded by evaluating `media/config.js` in a `node:vm` context with only `{ window: {} }`. That works today because the mirror block is self-contained above the `acquireVsCodeApi` guard, but any future edit that reaches for `document`, `acquireVsCodeApi` or another browser global above that guard makes the loader throw. Mitigation: the comment in `media/config.js` states the constraint explicitly, and the loader asserts `window.baitonConfigForm` exists so the failure names the cause.",
    "`assert.deepStrictEqual` over the error arrays compares `message` strings verbatim. That is the intent (the spec says the strings are compared, not just counted), but it means any wording change to a validation message must be made in both files or the suite goes red — which is the guard working, not a flake. Say so in the test's header comment so the next person does not weaken the assertion to comparing paths only.",
    "`deepStrictEqual` ignores object key order, so comparing `LIMIT_BOUNDS` alone would not catch a reordered mirror even though both validators emit limit errors in `Object.keys` order. The explicit `Object.keys(...)` comparison in step 3 is load-bearing, not redundant.",
    "The fixtures must pin expected paths, not merely assert that the two implementations agree. Two identically-wrong implementations would otherwise pass. `expectedPaths` per case is what prevents that.",
    "`validateConfigForm`'s agent rule depends on the `options.agents` passed in, which at runtime comes from `createAdapterRegistry().ids`. Fixtures that hard-code an agent id would break when an adapter is added or renamed; derive the default option set from the registry (as `test/configPanel.form.property.test.ts` already does) and use literal ids only for the deliberately-not-installed cases.",
    "The limits rule is `/^-?\\d+$/` plus `Number.isInteger`, so `'+3'` and `'1e3'` are rejected while `' 2 '` passes after `.trim()`. These edges are easy to get wrong in a fixture's `expectedPaths`; derive the expectation from reading the rule, and let the property test in step 4 catch anything the hand-written table mis-states.",
    "README accuracy on hot reload: T08 landed live config reload, and the panel reports non-reloadable factors as notes rather than asking for a window reload. The README must match `IN_FLIGHT_NOTE` / `NOT_ACTIVATED_NOTE` / `FOLDER_MISMATCH_NOTE` and the stale `ACTIVATION_VALUES_NOTE` fallback in `configPanelController.ts`, and must not promise that every consumer picks up every value instantly.",
    "Scope discipline: this todo is a sync guard plus documentation. If the parity suites reveal a genuine behavioural bug in the mirror, port the fix; do not take the opportunity to restructure `media/config.js` or extend the validator, which would fall outside T09."
  ],
  "acceptance": [
    "`test/configPanel.mirror.test.ts` exists, loads `media/config.js` outside a webview, and passes under `npm test`.",
    "A single fixture set (`test/fixtures/configFormCases.ts`) is consumed by both the TypeScript assertions and the mirror comparison — the same `ConfigForm` values run through `validateConfigForm` from `src/config/configPanel.ts` and through `window.baitonConfigForm.validateConfigForm`.",
    "The suite compares full `ConfigFieldError` objects (path and verbatim message) in order, not just error counts, and pins the expected error paths per fixture so both implementations are held to the documented rules rather than merely to each other.",
    "`ROLES`, `EFFORT_OPTIONS` and `LIMIT_BOUNDS` are asserted equal across the two files, with `LIMIT_BOUNDS` key order checked explicitly.",
    "Fixtures cover every rule in `validateConfigForm`: missing agent, not-installed agent, an out-of-set agent that is present in `options.agents` (valid), missing/whitespace model, blank-but-non-empty effort, unset effort (valid), out-of-set effort (valid), each limit non-integer, each limit below min and above max, each limit on both boundaries (valid), empty/whitespace `git.remote` and `git.base`, and a multi-error form pinning the roles -> limits -> git ordering.",
    "A deliberate one-character edit to either `validateConfigForm` implementation (e.g. changing a message or a bound in `media/config.js` only) makes the suite fail — verify this by hand once before reverting the edit.",
    "`test/configPanel.mirror.property.test.ts` cross-checks the two validators over fast-check-generated forms and varying agent lists, and passes under `npm run test:property`.",
    "Neither validator mutates the form it is given, asserted by the suite.",
    "`media/config.js` and `src/config/configPanel.ts` each name the other and name the parity test, so an edit starting from either side is told to update both.",
    "`README.md` documents **Baiton: Open Config Panel** (`baiton.openConfigPanel`): what the form edits, that unmanaged keys are preserved, the reset-to-defaults path when the config is absent or unparseable, the external-change and conflict handling, and that a save applies live without a window reload while reporting anything that could not take effect immediately.",
    "`npm run compile`, `npm run lint` and `npm test` all succeed with no new failures or errors.",
    "No behavioural change to `validateConfigForm` in either file unless the new suites proved a divergence; if one was proved, `src/config/configPanel.ts` was treated as the source of truth."
  ]
}
```
