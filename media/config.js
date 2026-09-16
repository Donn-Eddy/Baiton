// @ts-check
/*
 * Config_Panel entry script — spec "Configuration Panel" (config-panel), todos T04, T10.
 *
 * **src/config/configPanel.ts is the source of truth.** This file is its
 * plain-script mirror, exactly as media/protocol.js mirrors
 * src/orchestrator/webviewProtocol.ts. `test/configPanel.mirror.test.ts` runs
 * the same forms through both and fails if they diverge, so any edit to the
 * mirror block below must be made in both places. Keep the mirror block
 * self-contained above the `acquireVsCodeApi` guard so the test loader can
 * evaluate it outside a webview.
 *
 * The view is a pure projection of one state object, exactly like chat.js:
 * host→webview messages replace pieces of `state`, then `render()` redraws
 * the DOM from that state. User actions post webview→host messages defined
 * by `ConfigPanelWebviewToHost`. The webview never constructs a config
 * document itself — `applyFormToDocument` (unknown-key preservation) is
 * host-side only.
 */
(function () {
  'use strict';

  // ----- Mirror of src/config/configPanel.ts (host-free) -----------------
  //
  // Self-contained: no DOM access below this block. Exposed as
  // `window.baitonConfigForm` so T09's fixture test can load this file
  // outside a webview (no `document`, no `acquireVsCodeApi`) and compare its
  // output against the compiled TypeScript core.

  /** Mirrors src/model/role.ts ROLES — same order. */
  var ROLES = ['spec-writer', 'planner', 'plan-reviewer', 'executor', 'reviewer', 'pr-writer'];

  /**
   * Mirrors src/config/types.ts LIMIT_BOUNDS — same key order, because the
   * validator below walks these keys in order and the error order is part of
   * what T09 compares.
   */
  var LIMIT_BOUNDS = {
    plan_review_rounds: { min: 0, max: 10 },
    exec_attempts: { min: 1, max: 10 },
    stall_notice_minutes: { min: 1, max: 1440 },
  };

  /**
   * Mirrors `validateConfigForm` in src/config/configPanel.ts field-for-field
   * and message-for-message (the strings are compared verbatim, not just
   * counted). Never mutates `form`. Returns `[]` for a valid form.
   */
  function validateConfigForm(form, options) {
    var errors = [];

    for (var i = 0; i < ROLES.length; i++) {
      var role = ROLES[i];
      var entry = form.roles[role];
      var agent = entry.agent.trim();
      if (agent.length === 0) {
        errors.push({ path: 'roles.' + role + '.agent', message: '"' + role + '" is missing an agent.' });
      } else if (options.agents.indexOf(agent) === -1) {
        errors.push({
          path: 'roles.' + role + '.agent',
          message: '"' + agent + '" is not an installed agent (installed: ' + options.agents.join(', ') + ').',
        });
      }
      if (entry.model.trim().length === 0) {
        errors.push({ path: 'roles.' + role + '.model', message: '"' + role + '" is missing a model.' });
      }
      if (entry.effort !== '' && entry.effort.trim().length === 0) {
        errors.push({ path: 'roles.' + role + '.effort', message: '"' + role + '" effort must not be blank.' });
      } else if (entry.effort.trim().length > 0) {
        var effort = entry.effort.trim();
        var cap = options.byAgent && options.byAgent[agent];
        if (cap && cap.efforts && cap.efforts.length > 0 && cap.efforts.indexOf(effort) === -1) {
          errors.push({
            path: 'roles.' + role + '.effort',
            message: '"' + role + '" effort "' + effort + '" is not supported by ' + agent + ' (supported: ' + cap.efforts.join(', ') + ').',
          });
        }
      }
    }

    var limitFields = Object.keys(LIMIT_BOUNDS);
    for (var j = 0; j < limitFields.length; j++) {
      var field = limitFields[j];
      var raw = form.limits[field].trim();
      var bounds = LIMIT_BOUNDS[field];
      if (!/^-?\d+$/.test(raw) || !Number.isInteger(Number(raw))) {
        errors.push({ path: 'limits.' + field, message: '"limits.' + field + '" must be an integer.' });
        continue;
      }
      var n = Number(raw);
      if (n < bounds.min || n > bounds.max) {
        errors.push({
          path: 'limits.' + field,
          message: '"limits.' + field + '" must be between ' + bounds.min + ' and ' + bounds.max + ' (found ' + n + ')',
        });
      }
    }

    if (form.git.remote.trim().length === 0) {
      errors.push({ path: 'git.remote', message: 'Git remote must not be empty.' });
    }
    if (form.git.base.trim().length === 0) {
      errors.push({ path: 'git.base', message: 'Git base branch must not be empty.' });
    }

    return errors;
  }

  window.baitonConfigForm = {
    ROLES: ROLES,
    LIMIT_BOUNDS: LIMIT_BOUNDS,
    validateConfigForm: validateConfigForm,
  };

  // The mirror above is what lets T09 unit-test this file outside a webview
  // (a fake `window`, no `acquireVsCodeApi`). Everything past this guard is
  // DOM/host wiring and never runs under that test.
  if (typeof acquireVsCodeApi !== 'function') {
    return;
  }

  // eslint-disable-next-line no-undef
  var vscode = acquireVsCodeApi();

  // ----- Elements ----------------------------------------------------------

  var formEl = /** @type {HTMLFormElement} */ (document.getElementById('config-form'));
  var rolesBody = /** @type {HTMLElement} */ (document.getElementById('roles-body'));
  var saveBtn = /** @type {HTMLButtonElement} */ (document.getElementById('save'));
  var reloadBtn = /** @type {HTMLButtonElement} */ (document.getElementById('reload'));
  var resetBtn = /** @type {HTMLButtonElement} */ (document.getElementById('reset'));
  var bannerEl = /** @type {HTMLElement} */ (document.getElementById('banner'));
  var bannerMessage = /** @type {HTMLElement} */ (document.getElementById('banner-message'));
  var bannerPrimary = /** @type {HTMLButtonElement} */ (document.getElementById('banner-primary'));
  var bannerSecondary = /** @type {HTMLButtonElement} */ (document.getElementById('banner-secondary'));
  var statusEl = /** @type {HTMLElement} */ (document.getElementById('status'));
  var errorView = /** @type {HTMLElement} */ (document.getElementById('error-view'));
  var errorMessage = /** @type {HTMLElement} */ (document.getElementById('error-message'));
  var errorResetBtn = /** @type {HTMLButtonElement} */ (document.getElementById('error-reset'));
  var errorReloadBtn = /** @type {HTMLButtonElement} */ (document.getElementById('error-reload'));

  // ----- State ---------------------------------------------------------------

  var OTHER_MODEL_VALUE = '\u0000other';
  var OTHER_EFFORT_VALUE = '\u0000other';

  /**
   * `{ phase: 'loading'|'ready'|'error', form, baseline, token, options,
   *    errors, failure, banner, status, busy }`
   */
  var state = {
    phase: 'loading',
    form: null,
    baseline: '',
    token: '',
    options: { agents: [], byAgent: {} },
    errors: [],
    // True only right after a host `saveFailed` (reason 'invalid') response,
    // while `state.errors` holds the host's authoritative field errors rather
    // than the client mirror's own recompute. Cleared on the next edit, at
    // which point live client-side validation resumes (renderErrors()).
    errorsFromServer: false,
    failure: null,
    banner: null,
    status: '',
    busy: false,
    pendingExternal: null,
  };

  /** Stable JSON of a form: roles serialized in ROLES order so dirtiness is order-independent. */
  function formJson(form) {
    if (!form) {
      return '';
    }
    var roles = {};
    for (var i = 0; i < ROLES.length; i++) {
      var role = ROLES[i];
      roles[role] = form.roles[role];
    }
    return JSON.stringify({ roles: roles, limits: form.limits, git: form.git });
  }

  function isDirty() {
    return !!state.form && formJson(state.form) !== state.baseline;
  }

  /** Write a single dotted path (e.g. `roles.executor.agent`, `limits.exec_attempts`, `git.base`) into state.form. */
  function setField(path, value) {
    if (!state.form) {
      return;
    }
    var parts = path.split('.');
    if (parts[0] === 'roles') {
      var role = parts[1];
      var field = parts[2];
      state.form.roles[role][field] = value;
    } else if (parts[0] === 'limits') {
      state.form.limits[parts[1]] = value;
    } else if (parts[0] === 'git') {
      state.form.git[parts[1]] = value;
    }
  }

  function persistDraft() {
    vscode.setState({ form: state.form, token: state.token });
  }

  // ----- Rendering -----------------------------------------------------------

  var renderedOptionsSignature = null;

  function roleAgentsSignature() {
    if (!state.form) {
      return '';
    }
    var s = '';
    for (var i = 0; i < ROLES.length; i++) {
      var r = state.form.roles[ROLES[i]];
      s += (r ? r.agent : '') + ',';
    }
    return s;
  }

  /** Runs once per option-set change or role agent change: builds the six role rows from ROLES. */
  function buildRoleRows() {
    var signature = JSON.stringify(state.options) + '|' + roleAgentsSignature();
    if (signature === renderedOptionsSignature) {
      return;
    }
    renderedOptionsSignature = signature;
    rolesBody.textContent = '';

    for (var i = 0; i < ROLES.length; i++) {
      var role = ROLES[i];
      var row = document.createElement('tr');
      row.dataset.role = role;

      var th = document.createElement('th');
      th.setAttribute('scope', 'row');
      th.textContent = role;
      row.appendChild(th);

      var agentCell = document.createElement('td');
      var agentSelect = document.createElement('select');
      agentSelect.id = 'role-' + role + '-agent';
      agentSelect.dataset.path = 'roles.' + role + '.agent';
      agentSelect.className = 'role-agent-select';
      state.options.agents.forEach(function (agentId) {
        var opt = document.createElement('option');
        opt.value = agentId;
        opt.textContent = agentId;
        agentSelect.appendChild(opt);
      });
      var agentErrorId = 'error-roles-' + role + '-agent';
      agentSelect.setAttribute('aria-describedby', agentErrorId);
      agentCell.appendChild(agentSelect);
      var agentError = document.createElement('div');
      agentError.className = 'field-error';
      agentError.id = agentErrorId;
      agentError.dataset.errorFor = 'roles.' + role + '.agent';
      agentCell.appendChild(agentError);
      row.appendChild(agentCell);

      var currentAgent = (state.form && state.form.roles[role] && state.form.roles[role].agent) || (state.options.agents[0] || '');
      var cap = (state.options.byAgent && state.options.byAgent[currentAgent]) || { models: [], efforts: [] };
      var models = cap.models || [];
      var efforts = cap.efforts || [];

      // Model cell
      var modelCell = document.createElement('td');
      var modelGroup = document.createElement('div');
      modelGroup.className = 'select-input-group';

      var modelSelect = document.createElement('select');
      modelSelect.id = 'role-' + role + '-model-select';
      modelSelect.className = 'role-model-select';
      modelSelect.dataset.role = role;
      var modelErrorId = 'error-roles-' + role + '-model';
      modelSelect.setAttribute('aria-describedby', modelErrorId);

      models.forEach(function (m) {
        var opt = document.createElement('option');
        opt.value = m;
        opt.textContent = m;
        modelSelect.appendChild(opt);
      });
      var otherModelOpt = document.createElement('option');
      otherModelOpt.value = OTHER_MODEL_VALUE;
      otherModelOpt.textContent = 'Other…';
      modelSelect.appendChild(otherModelOpt);

      var modelInput = document.createElement('input');
      modelInput.type = 'text';
      modelInput.id = 'role-' + role + '-model-input';
      modelInput.dataset.path = 'roles.' + role + '.model';
      modelInput.setAttribute('aria-describedby', modelErrorId);

      modelGroup.appendChild(modelSelect);
      modelGroup.appendChild(modelInput);

      if (cap.modelLink) {
        var modelLink = document.createElement('a');
        modelLink.className = 'doc-link';
        modelLink.href = cap.modelLink;
        modelLink.target = '_blank';
        modelLink.rel = 'noreferrer noopener';
        modelLink.textContent = 'Documentation';
        modelGroup.appendChild(modelLink);
      }

      modelCell.appendChild(modelGroup);
      var modelError = document.createElement('div');
      modelError.className = 'field-error';
      modelError.id = modelErrorId;
      modelError.dataset.errorFor = 'roles.' + role + '.model';
      modelCell.appendChild(modelError);
      row.appendChild(modelCell);

      // Effort cell
      var effortCell = document.createElement('td');
      var effortGroup = document.createElement('div');
      effortGroup.className = 'select-input-group';

      var effortSelect = document.createElement('select');
      effortSelect.id = 'role-' + role + '-effort-select';
      effortSelect.className = 'role-effort-select';
      effortSelect.dataset.role = role;
      var effortErrorId = 'error-roles-' + role + '-effort';
      effortSelect.setAttribute('aria-describedby', effortErrorId);

      var defaultOpt = document.createElement('option');
      defaultOpt.value = '';
      defaultOpt.textContent = '(default)';
      effortSelect.appendChild(defaultOpt);

      efforts.forEach(function (eff) {
        var opt = document.createElement('option');
        opt.value = eff;
        opt.textContent = eff;
        effortSelect.appendChild(opt);
      });
      var otherEffortOpt = document.createElement('option');
      otherEffortOpt.value = OTHER_EFFORT_VALUE;
      otherEffortOpt.textContent = 'Other…';
      effortSelect.appendChild(otherEffortOpt);

      var effortInput = document.createElement('input');
      effortInput.type = 'text';
      effortInput.id = 'role-' + role + '-effort-input';
      effortInput.dataset.path = 'roles.' + role + '.effort';
      effortInput.setAttribute('aria-describedby', effortErrorId);

      effortGroup.appendChild(effortSelect);
      effortGroup.appendChild(effortInput);

      effortCell.appendChild(effortGroup);
      var effortError = document.createElement('div');
      effortError.className = 'field-error';
      effortError.id = effortErrorId;
      effortError.dataset.errorFor = 'roles.' + role + '.effort';
      effortCell.appendChild(effortError);
      row.appendChild(effortCell);

      rolesBody.appendChild(row);
    }
  }

  /** Write state.form into the controls, skipping the one currently focused. */
  function renderValues() {
    if (!state.form) {
      return;
    }
    var active = document.activeElement;
    for (var i = 0; i < ROLES.length; i++) {
      var role = ROLES[i];
      var entry = state.form.roles[role];
      var agentEl = /** @type {HTMLSelectElement} */ (document.getElementById('role-' + role + '-agent'));
      if (agentEl && agentEl !== active) {
        if (entry.agent) {
          var hasOption = Array.prototype.some.call(agentEl.options, function (o) {
            return o.value === entry.agent;
          });
          if (!hasOption) {
            var extra = document.createElement('option');
            extra.value = entry.agent;
            extra.textContent = entry.agent;
            agentEl.appendChild(extra);
          }
        }
        agentEl.value = entry.agent;
      }

      var cap = (state.options.byAgent && state.options.byAgent[entry.agent]) || { models: [], efforts: [] };
      var models = cap.models || [];
      var efforts = cap.efforts || [];

      var modelSelect = /** @type {HTMLSelectElement} */ (document.getElementById('role-' + role + '-model-select'));
      var modelInput = /** @type {HTMLInputElement} */ (document.getElementById('role-' + role + '-model-input'));
      if (modelSelect && modelInput) {
        if (models.length === 0) {
          modelSelect.style.display = 'none';
          modelInput.style.display = '';
          if (modelInput !== active) {
            modelInput.value = entry.model;
          }
        } else {
          var inModels = models.indexOf(entry.model) !== -1;
          modelSelect.style.display = '';
          if (inModels) {
            if (modelSelect !== active) {
              modelSelect.value = entry.model;
            }
            modelInput.style.display = 'none';
            if (modelInput !== active) {
              modelInput.value = '';
            }
          } else {
            if (modelSelect !== active) {
              modelSelect.value = OTHER_MODEL_VALUE;
            }
            modelInput.style.display = '';
            if (modelInput !== active) {
              modelInput.value = entry.model;
            }
          }
        }
      }

      var effortSelect = /** @type {HTMLSelectElement} */ (document.getElementById('role-' + role + '-effort-select'));
      var effortInput = /** @type {HTMLInputElement} */ (document.getElementById('role-' + role + '-effort-input'));
      if (effortSelect && effortInput) {
        if (efforts.length === 0) {
          effortSelect.style.display = 'none';
          effortInput.style.display = '';
          if (effortInput !== active) {
            effortInput.value = entry.effort;
          }
        } else {
          var inEfforts = entry.effort === '' || efforts.indexOf(entry.effort) !== -1;
          effortSelect.style.display = '';
          if (inEfforts) {
            if (effortSelect !== active) {
              effortSelect.value = entry.effort;
            }
            effortInput.style.display = 'none';
            if (effortInput !== active) {
              effortInput.value = '';
            }
          } else {
            if (effortSelect !== active) {
              effortSelect.value = OTHER_EFFORT_VALUE;
            }
            effortInput.style.display = '';
            if (effortInput !== active) {
              effortInput.value = entry.effort;
            }
          }
        }
      }
    }
    var limitPlan = document.getElementById('limit-plan_review_rounds');
    var limitExec = document.getElementById('limit-exec_attempts');
    var limitStall = document.getElementById('limit-stall_notice_minutes');
    var gitRemote = document.getElementById('git-remote');
    var gitBase = document.getElementById('git-base');
    if (limitPlan && limitPlan !== active) {
      limitPlan.value = state.form.limits.plan_review_rounds;
    }
    if (limitExec && limitExec !== active) {
      limitExec.value = state.form.limits.exec_attempts;
    }
    if (limitStall && limitStall !== active) {
      limitStall.value = state.form.limits.stall_notice_minutes;
    }
    if (gitRemote && gitRemote !== active) {
      gitRemote.value = state.form.git.remote;
    }
    if (gitBase && gitBase !== active) {
      gitBase.value = state.form.git.base;
    }
  }

  function renderErrors() {
    var nodes = formEl.querySelectorAll('.field-error');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = '';
    }
    var controls = formEl.querySelectorAll('[data-path], .role-model-select, .role-effort-select');
    for (var j = 0; j < controls.length; j++) {
      controls[j].removeAttribute('aria-invalid');
      controls[j].classList.remove('invalid');
    }
    if (!state.form) {
      return;
    }
    // A host `saveFailed` (reason 'invalid') response is authoritative: the
    // client mirror considered this exact form valid (client validation
    // gates Save), so recomputing here would silently discard the host's
    // field errors. Render them as-is until the next edit.
    if (!state.errorsFromServer) {
      state.errors = validateConfigForm(state.form, state.options);
    }
    state.errors.forEach(function (error) {
      var slot = formEl.querySelector('[data-error-for="' + error.path + '"]');
      if (slot) {
        slot.textContent = error.message;
      }
      var matchingControls = formEl.querySelectorAll('[data-path="' + error.path + '"]');
      for (var k = 0; k < matchingControls.length; k++) {
        matchingControls[k].setAttribute('aria-invalid', 'true');
        matchingControls[k].classList.add('invalid');
      }
      var parts = error.path.split('.');
      if (parts[0] === 'roles') {
        var r = parts[1];
        var f = parts[2];
        if (f === 'model') {
          var mSel = document.getElementById('role-' + r + '-model-select');
          if (mSel && mSel.style.display !== 'none') {
            mSel.setAttribute('aria-invalid', 'true');
            mSel.classList.add('invalid');
          }
        } else if (f === 'effort') {
          var eSel = document.getElementById('role-' + r + '-effort-select');
          if (eSel && eSel.style.display !== 'none') {
            eSel.setAttribute('aria-invalid', 'true');
            eSel.classList.add('invalid');
          }
        }
      }
    });
  }

  function renderBanner() {
    if (!state.banner) {
      bannerEl.classList.remove('visible');
      return;
    }
    bannerMessage.textContent = state.banner.message;
    bannerPrimary.textContent = state.banner.primary || '';
    bannerPrimary.style.display = state.banner.primary ? '' : 'none';
    bannerPrimary.dataset.action = 'primary';
    bannerSecondary.textContent = state.banner.secondary || '';
    bannerSecondary.style.display = state.banner.secondary ? '' : 'none';
    bannerSecondary.dataset.action = 'secondary';
    bannerEl.classList.add('visible');
  }

  function renderStatus() {
    statusEl.textContent = state.status;
  }

  function renderErrorView() {
    if (state.phase === 'error' && state.failure) {
      errorMessage.textContent = state.failure.message;
      errorResetBtn.style.display = state.failure.canReset ? '' : 'none';
      errorView.classList.add('visible');
      formEl.style.display = 'none';
    } else {
      errorView.classList.remove('visible');
      formEl.style.display = '';
    }
  }

  function updateEnablement() {
    var disabledForBusy = state.busy || state.phase !== 'ready';
    var hasErrors = state.errors.length > 0;
    saveBtn.disabled = state.busy || state.phase !== 'ready' || !isDirty() || hasErrors;
    reloadBtn.disabled = state.busy;
    resetBtn.disabled = state.busy;
    var controls = formEl.querySelectorAll('input, select');
    for (var i = 0; i < controls.length; i++) {
      controls[i].disabled = disabledForBusy;
    }
  }

  function render() {
    renderErrorView();
    if (state.form) {
      buildRoleRows();
      renderValues();
      renderErrors();
    }
    renderBanner();
    renderStatus();
    updateEnablement();
  }

  // ----- Actions ---------------------------------------------------------

  function doSave(overwrite) {
    if (!state.form) {
      return;
    }
    var errors = validateConfigForm(state.form, state.options);
    if (errors.length > 0) {
      state.errors = errors;
      state.errorsFromServer = false;
      render();
      return;
    }
    state.busy = true;
    state.status = '';
    var msg = { type: 'save', form: state.form, token: state.token };
    if (overwrite) {
      msg.overwrite = true;
    }
    vscode.postMessage(msg);
    render();
  }

  formEl.addEventListener('input', function (e) {
    var target = /** @type {HTMLElement} */ (e.target);
    var path = target && target.dataset ? target.dataset.path : undefined;
    if (!path) {
      return;
    }
    setField(path, /** @type {HTMLInputElement} */ (target).value);
    state.status = '';
    state.errorsFromServer = false;
    if (state.banner && (state.banner.kind === 'conflict' || state.banner.kind === 'io')) {
      state.banner = null;
    }
    persistDraft();
    render();
  });

  formEl.addEventListener('change', function (e) {
    var target = /** @type {HTMLElement} */ (e.target);
    if (!target) {
      return;
    }
    if (target.classList.contains('role-model-select')) {
      var role = target.dataset.role;
      var input = /** @type {HTMLInputElement} */ (document.getElementById('role-' + role + '-model-input'));
      var select = /** @type {HTMLSelectElement} */ (target);
      if (select.value === OTHER_MODEL_VALUE) {
        if (input) {
          input.style.display = '';
          input.focus();
          setField('roles.' + role + '.model', input.value);
        }
      } else {
        if (input) {
          input.style.display = 'none';
          input.value = '';
        }
        setField('roles.' + role + '.model', select.value);
      }
      state.status = '';
      state.errorsFromServer = false;
      if (state.banner && (state.banner.kind === 'conflict' || state.banner.kind === 'io')) {
        state.banner = null;
      }
      persistDraft();
      render();
      return;
    }
    if (target.classList.contains('role-effort-select')) {
      var effortRole = target.dataset.role;
      var effortIn = /** @type {HTMLInputElement} */ (document.getElementById('role-' + effortRole + '-effort-input'));
      var effortSel = /** @type {HTMLSelectElement} */ (target);
      if (effortSel.value === OTHER_EFFORT_VALUE) {
        if (effortIn) {
          effortIn.style.display = '';
          effortIn.focus();
          setField('roles.' + effortRole + '.effort', effortIn.value);
        }
      } else {
        if (effortIn) {
          effortIn.style.display = 'none';
          effortIn.value = '';
        }
        setField('roles.' + effortRole + '.effort', effortSel.value);
      }
      state.status = '';
      state.errorsFromServer = false;
      if (state.banner && (state.banner.kind === 'conflict' || state.banner.kind === 'io')) {
        state.banner = null;
      }
      persistDraft();
      render();
      return;
    }
    var path = target.dataset ? target.dataset.path : undefined;
    if (!path) {
      return;
    }
    setField(path, /** @type {HTMLInputElement} */ (target).value);
    state.status = '';
    state.errorsFromServer = false;
    if (state.banner && (state.banner.kind === 'conflict' || state.banner.kind === 'io')) {
      state.banner = null;
    }
    persistDraft();
    render();
  });

  formEl.addEventListener('submit', function (e) {
    e.preventDefault();
    doSave(false);
  });

  saveBtn.addEventListener('click', function () {
    doSave(false);
  });

  function requestReload() {
    state.banner = null;
    state.status = '';
    vscode.postMessage({ type: 'load' });
  }

  reloadBtn.addEventListener('click', requestReload);
  errorReloadBtn.addEventListener('click', requestReload);

  // The confirmation modal is the host's (shown before it replies), so the
  // webview posts directly and shows no confirm dialog of its own.
  function requestReset() {
    vscode.postMessage({ type: 'reset' });
  }

  resetBtn.addEventListener('click', requestReset);
  errorResetBtn.addEventListener('click', requestReset);

  bannerPrimary.addEventListener('click', function () {
    if (!state.banner) {
      return;
    }
    if (state.banner.kind === 'external') {
      requestReload();
    } else if (state.banner.kind === 'conflict') {
      requestReload();
    }
  });

  bannerSecondary.addEventListener('click', function () {
    if (!state.banner) {
      return;
    }
    if (state.banner.kind === 'external') {
      // Keep editing: dismiss the banner, keep the stale token so a later
      // Save surfaces the conflict path.
      state.banner = null;
      render();
    } else if (state.banner.kind === 'conflict') {
      doSave(true);
    }
  });

  // ----- Host messages -----------------------------------------------------

  function applyExternalChange(token) {
    if (state.banner && state.banner.kind === 'conflict') {
      return;
    }
    if (!isDirty()) {
      state.token = token;
      vscode.postMessage({ type: 'load' });
    } else {
      state.banner = {
        kind: 'external',
        message: 'The configuration file changed on disk.',
        primary: 'Reload (discard edits)',
        secondary: 'Keep editing',
      };
    }
  }

  window.addEventListener('message', function (event) {
    var msg = event.data;
    if (!msg || typeof msg.type !== 'string') {
      return;
    }
    switch (msg.type) {
      case 'loaded': {
        var form = msg.form;
        var token = msg.token;
        var persisted = vscode.getState();
        if (persisted && persisted.token === token && persisted.form) {
          form = persisted.form;
        }
        state.phase = 'ready';
        state.form = form;
        state.token = token;
        state.options = msg.options;
        state.baseline = formJson(msg.form);
        state.errors = [];
        state.errorsFromServer = false;
        state.failure = null;
        state.banner = null;
        state.busy = false;
        state.pendingExternal = null;
        break;
      }
      case 'loadFailed':
        state.phase = 'error';
        state.form = null;
        state.failure = { kind: msg.kind, message: msg.message, canReset: msg.canReset };
        state.busy = false;
        state.pendingExternal = null;
        break;
      case 'saved':
        state.token = msg.token;
        state.baseline = formJson(state.form);
        state.busy = false;
        state.pendingExternal = null;
        state.status = 'Saved.' + (msg.notes && msg.notes.length > 0 ? '\n' + msg.notes.join('\n') : '');
        state.banner = null;
        state.errorsFromServer = false;
        break;
      case 'saveFailed': {
        state.busy = false;
        var pending = state.pendingExternal;
        state.pendingExternal = null;
        if (msg.reason === 'invalid') {
          state.errors = msg.errors || [];
          state.errorsFromServer = true;
          state.banner = { kind: 'invalid', message: msg.message };
        } else if (msg.reason === 'conflict') {
          state.banner = { kind: 'conflict', message: msg.message, primary: 'Reload', secondary: 'Overwrite' };
        } else {
          state.banner = { kind: 'io', message: msg.message };
        }
        if (pending !== null) {
          applyExternalChange(pending);
        }
        break;
      }
      case 'externalChange':
        if (state.busy) {
          state.pendingExternal = msg.token;
          break;
        }
        applyExternalChange(msg.token);
        break;
      default:
        // Unknown message: leave the state unchanged rather than throwing.
        return;
    }
    persistDraft();
    render();
  });

  vscode.postMessage({ type: 'ready' });
  // Initial paint (loading phase); the host pushes the first real state
  // through the message channel once the view is bound.
  render();
})();
