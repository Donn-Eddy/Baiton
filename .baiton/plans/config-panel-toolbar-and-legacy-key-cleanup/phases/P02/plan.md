# Plan P02

## Steps

1. Replace the roles fieldset with an Agent/Model/Effort table in config.html

   In media/config.html, inside <form id="config-form">, replace the whole `<fieldset id="roles-fieldset"><legend>Roles</legend><div id="roles-body"></div></fieldset>` block with a plain headed section:

   <section id="roles-section" class="config-section">
     <h2 class="section-heading">Roles</h2>
     <div class="table-scroll">
       <table id="roles-table">
         <thead>
           <tr>
             <th scope="col" id="roles-col-role">Role</th>
             <th scope="col" id="roles-col-agent">Agent</th>
             <th scope="col" id="roles-col-model">Model</th>
             <th scope="col" id="roles-col-effort">Effort</th>
           </tr>
         </thead>
         <tbody id="roles-body"></tbody>
       </table>
     </div>
   </section>

   Keep the id `roles-body` on the tbody (media/config.js and the modelSelectorRefresh.test.ts stub look it up by that id). Update the header comment block (lines ~22-28) to say config.js builds one table row per role into #roles-body, with the agent/model/effort controls each in their own column cell.

   Files: `media/config.html`

2. Flatten Limits and Git into plain headed sections

   In media/config.html replace `<fieldset id="limits-fieldset"><legend>Limits</legend> … </fieldset>` with `<section id="limits-section" class="config-section"><h2 class="section-heading">Limits</h2> … </section>` and likewise `<fieldset id="git-fieldset"><legend>Git</legend> … </fieldset>` with `<section id="git-section" class="config-section"><h2 class="section-heading">Git</h2> … </section>`. The inner `.field-row` blocks (labels, inputs with ids limit-plan_review_rounds / limit-exec_attempts / limit-stall_notice_minutes / git-remote / git-base, their data-path, aria-describedby, hints and `.field-error` divs with data-error-for) are kept byte-for-byte. Do not touch the toolbar markup, banner, status, error-view, the CSP meta, the nonce'd <style>/<script> tags.

   Files: `media/config.html`

3. Rework the CSS: drop fieldset/legend/.role-group rules, add section + roles table rules, keep toolbar compact

   In the <style nonce> block of media/config.html:
   - Delete the `fieldset { … }` rule, the `legend { … }` rule and the trailing `.role-group { … }` rule (nothing uses them after this phase; media/chat.html has its own fieldset styling and is untouched).
   - Add:
     .config-section { margin: 0 0 calc(var(--baiton-gap) * 2) 0; }
     .section-heading { margin: 0 0 var(--baiton-gap) 0; font-size: 1em; font-weight: 600; color: var(--vscode-foreground); padding-bottom: 2px; border-bottom: 1px solid var(--vscode-panel-border); }
     .table-scroll { overflow-x: auto; }
     #roles-table { table-layout: fixed; }
     #roles-table th[scope='row'] { white-space: nowrap; width: 7em; overflow: hidden; text-overflow: ellipsis; }
     #roles-table td { min-width: 0; }
     #roles-table td .field-error, #roles-table td .stale-note, #roles-table td .doc-link { overflow-wrap: anywhere; }
     #roles-table tbody tr + tr th, #roles-table tbody tr + tr td { border-top: 1px solid var(--vscode-panel-border); }
     (Reuse the existing generic `table`, `th, td`, `thead th`, `tbody th` rules; only add what is missing. Keep inputs/selects at width:100% so each cell's control fills its column.)
     Add a narrow-sidebar fallback: `@media (max-width: 360px) { #roles-table th, #roles-table td { padding: 2px 3px; } #roles-table th[scope='row'] { width: 5.5em; } }` so the four columns still read in a narrow sidebar (the .table-scroll wrapper prevents page overflow if it gets tighter still).
   - The toolbar was already tightened in P01 (`.toolbar button { padding: 2px 8px; }`, flex-wrap, gap 4px); leave it as is unless it visually regressed — no changes required to toolbar CSS in this phase.
   - Keep every color as a VS Code theme variable (no literal colors).

   Files: `media/config.html`

4. Rewrite buildRoleRows() to append one <tr> per role with th + three td cells

   In media/config.js, rewrite the body of buildRoleRows() (currently ~L253-402), keeping the `if (rolesBuilt) return; rolesBuilt = true;` guard and the loop over ROLES. For each role:

     var row = document.createElement('tr');
     row.className = 'role-row';
     row.dataset.role = role;
     var nameCell = document.createElement('th');
     nameCell.setAttribute('scope', 'row');
     nameCell.id = 'role-' + role + '-name';
     nameCell.textContent = role;
     row.appendChild(nameCell);

   Agent cell: `var agentCell = document.createElement('td'); agentCell.className = 'role-cell role-cell-agent';` then create agentSelect exactly as today (id 'role-'+role+'-agent', dataset.path 'roles.'+role+'.agent', className 'role-agent-select', aria-describedby agentErrorId) and add `agentSelect.setAttribute('aria-labelledby', 'role-' + role + '-name roles-col-agent');` in place of the old <label>. Append agentSelect, then the agentError div (className 'field-error', id 'error-roles-'+role+'-agent', dataset.errorFor 'roles.'+role+'.agent') to agentCell.

   Model cell: `td.role-cell.role-cell-model`; build modelGroup (.select-input-group) containing modelSelect (id role-<role>-model-select, class role-model-select, dataset.role, aria-describedby modelErrorId, static Other… option with dataset.static='other'), modelInput (type text, id role-<role>-model-input, dataset.path roles.<role>.model, aria-describedby modelErrorId) and modelLink (a.doc-link, id role-<role>-model-link, target _blank, rel 'noreferrer noopener', text 'Documentation', style.display 'none') exactly as today; give modelSelect and modelInput `aria-labelledby = 'role-'+role+'-name roles-col-model'`. Append modelGroup, then staleNote (div.stale-note id role-<role>-stale, dataset.staleFor role), then modelError (div.field-error id error-roles-<role>-model, dataset.errorFor roles.<role>.model) to the model cell — same order as before.

   Effort cell: `td.role-cell.role-cell-effort`; effortGroup (.select-input-group) with effortSelect (id role-<role>-effort-select, class role-effort-select, dataset.role, aria-describedby effortErrorId, static '(default)' option value '' dataset.static='default', static Other… option dataset.static='other') and effortInput (id role-<role>-effort-input, dataset.path roles.<role>.effort, aria-describedby effortErrorId); both get aria-labelledby 'role-'+role+'-name roles-col-effort'. Append effortGroup then effortError (div.field-error id error-roles-<role>-effort, dataset.errorFor roles.<role>.effort).

   Append the three cells to row and `rolesBody.appendChild(row)`. Remove the old fieldset/legend/field-row/label creation entirely. Do not touch renderOptionLists(), renderValues(), renderStale(), renderErrors(), updateEnablement(), the change/input handlers (they key on target.dataset.role and data-path, which are preserved), or the plain-script mirror block above the acquireVsCodeApi guard. Update the JSDoc above buildRoleRows() from 'Builds the six role stacked blocks' to 'Builds the six roles-table rows (one <tr> per role: a row-header <th>, then Agent / Model / Effort cells)' and keep the rest of that comment (build-once, static options, in-place sync). Also update the `rolesBody` variable comment/type if desired (HTMLTableSectionElement) — purely cosmetic.

   Files: `media/config.js`

5. Update the config panel view test DOM stub and role-structure assertions

   In test/configPanel.view.test.ts, loadConfigView() (~L798-835):
   - Change `const rolesBody = make('roles-body', 'div');` to `make('roles-body', 'tbody')`.
   - Replace the `rolesFieldset` containment (~L823-825) with a stub mirroring the new markup: `const rolesTable = make('roles-table', 'table'); const thead = new ViewEl('thead'); const headRow = new ViewEl('tr'); for (const [id, text] of [['roles-col-role','Role'],['roles-col-agent','Agent'],['roles-col-model','Model'],['roles-col-effort','Effort']]) { const th = new ViewEl('th'); th.id = id; th.textContent = text; headRow.appendChild(th); } thead.appendChild(headRow); rolesTable.appendChild(thead); rolesTable.appendChild(rolesBody); const rolesSection = new ViewEl('section'); rolesSection.appendChild(rolesTable); formEl.appendChild(rolesSection);` (keep `make` ids registered so `ids['roles-table']` exists). The limits/git `.field-row` loop stays.
   - In the test 'builds six role groups with the model and effort option lists from loaded' (~L974): rename to 'builds six roles-table rows …' and replace `querySelectorAll('.role-group').length, 6` with assertions: `const rows = view.ids['roles-body'].querySelectorAll('.role-row'); assert.strictEqual(rows.length, 6); assert.deepStrictEqual(rows.map(r => r.dataset.role), [...VIEW_ROLES]); assert.strictEqual(view.ids['config-form'].querySelectorAll('.role-group').length, 0); assert.strictEqual(view.ids['config-form'].querySelectorAll('fieldset').length, 0);`.
   - Add a new test 'puts each role field in its own column cell, with its error in the same cell': for role 'executor', take row = rows.find(r => r.dataset.role === 'executor'); assert row.tagName === 'TR'; row.children.length === 4; row.children[0].tagName === 'TH' and getAttribute('scope') === 'row' and textContent === 'executor'; then for each of cells 1..3 (agent/model/effort) assert tagName 'TD' and that `cell.querySelector('[data-error-for="roles.executor.<field>"]')` is non-null; agent cell contains the element with id role-executor-agent (walk cell.descendants()); model cell contains role-executor-model-select, role-executor-model-input, role-executor-model-link and role-executor-stale; effort cell contains role-executor-effort-select and role-executor-effort-input. Use `byId(...).parentNode` walk-up or `Array.from(cell.descendants()).some(el => el.id === id)` (descendants() is a public generator on ViewEl).
   - Add a test 'a second render does not rebuild the roles table': after loadedView(), capture `view.ids['roles-body'].children.slice()` and `byId('role-executor-model-input')`; send optionsChanged and a second `loaded`; assert the children array has the same 6 node identities and the input node is identical.
   - Existing focus/caret, Other… stickiness, doc-link, staleness, error-rendering and toolbar (P01) tests must pass unchanged; only fix any that relied on the fieldset wrapper.
   - Also add a static-markup check next to 'labels the local overlay as the configuration path' (~L414): read media/config.html and assert it contains `<table id="roles-table">`, `<tbody id="roles-body">`, the three column headers `>Agent<`, `>Model<`, `>Effort<`, and does NOT contain `<fieldset`, `<legend` or `role-group`.

   Files: `test/configPanel.view.test.ts`

6. Keep the other DOM stubs and the mirror test green

   test/configPanel.mirror.test.ts only exercises the plain-script mirror (ROLES, LIMIT_BOUNDS, validateConfigForm) which this phase does not touch; no edit is expected — just run it. test/modelSelectorRefresh.test.ts (~L2711-2739) builds its own stub with `make('roles-body','div')` wrapped in a FakeEl('fieldset'); config.js only needs getElementById('roles-body') and appendChild, so it keeps working. For consistency, optionally change that stub to `make('roles-body','tbody')` wrapped in a FakeEl('table') — but only if it passes; this file is outside the phase's listed files, so prefer leaving it untouched unless a test there fails. Do not grow the mirror block at the top of media/config.js.

   Files: `test/configPanel.mirror.test.ts`, `test/modelSelectorRefresh.test.ts`

7. Build and run tests

   Run `git diff --check`, `npm run compile`, then the focused suites: `npx mocha --no-config --node-option no-strip-types --require ts-node/register --timeout 60000 test/configPanel.mirror.test.ts test/configPanel.controller.test.ts test/configPanel.view.test.ts test/modelSelectorRefresh.test.ts`, then the full `npm test` (P01 notes the sandboxed full run can hit git EPERM; rerun outside the sandbox if so). Finally grep: `grep -n 'fieldset\|legend\|role-group' media/config.html media/config.js` must return nothing.

   Files: (none)

## Risks

- The hand-rolled ViewEl/FakeEl selector matcher only supports a single class, tag or [attr] per comma part — assertions must use simple selectors like '.role-row' or 'tr', not compound ones like 'tr[data-role]'.
- Removing the <label> elements loses click-to-focus labels; aria-labelledby pointing at the row th id and the column th id (roles-col-agent/model/effort) must reference ids that actually exist in config.html, or screen readers lose the field names.
- A four-column table in a narrow sidebar can overflow; table-layout:fixed, width:100% controls, the .table-scroll overflow-x wrapper and the narrow media query are needed so the page itself never scrolls horizontally.
- Renaming the tbody id away from 'roles-body' would break media/config.js and the modelSelectorRefresh.test.ts stub — keep the id.
- Any code or test that depended on the old cell order (stale note before model error inside the model block) must keep that order to avoid subtle rendering/test diffs.
- Accidentally touching the generic `table`/`th, td` rules could restyle other tables if any exist in the view; add roles-specific rules under #roles-table instead.

## Acceptance

- media/config.html contains <table id="roles-table"> with a thead naming Agent / Model / Effort and <tbody id="roles-body">, and contains no <fieldset>, <legend> or .role-group rule; Limits and Git are <section> blocks with an <h2> heading.
- media/config.js buildRoleRows() appends exactly six <tr class="role-row" data-role=…> rows, each with a th scope=row holding the role name followed by Agent, Model and Effort td cells; it still runs only once.
- All existing element ids (role-<role>-agent, -model-select, -model-input, -model-link, -effort-select, -effort-input, -stale, error-roles-<role>-<field>), classes and data-path / data-error-for / data-static / data-role markers are unchanged, and each field's error div sits in the same cell as its control.
- The new and updated tests in test/configPanel.view.test.ts pass: six rows in role order, no .role-group/fieldset, per-cell containment, and node identity preserved across optionsChanged and a re-render.
- test/configPanel.mirror.test.ts, test/configPanel.controller.test.ts, test/modelSelectorRefresh.test.ts and the P01 toolbar tests pass unchanged in behavior; the mirror block at the top of media/config.js is not modified.
- npm run compile succeeds and the full npm test suite is green.
- No change to the CSP, nonce, script tags, toolbar buttons, save/reload/reset behavior, message contract or any src/ file.
