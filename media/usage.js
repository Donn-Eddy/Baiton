// @ts-check
/*
 * Usage view entry script — spec first-party-usage, todo T09.
 *
 * Consumes the host messages defined in src/usage/protocol.ts
 * ({ type: 'readings', rows, now } and { type: 'state', state }) and posts only
 * { type: 'ready' } and { type: 'refresh' }. The tool order, labels and
 * mechanism labels mirror src/usage/model.ts; test/usageView.media.test.ts
 * keeps them in sync. The pure helpers sit above the `acquireVsCodeApi` guard
 * so a test can evaluate them outside a webview.
 *
 * The view writes textContent only. It performs no network access and keeps
 * no persisted state.
 */
(function () {
  'use strict';

  // ----- Host-free formatting mirror (no DOM access) ----------------------

  var TOOL_ORDER = ['claude', 'codex', 'antigravity', 'opencode-go'];

  var TOOL_LABELS = {
    claude: 'Claude Code',
    codex: 'Codex',
    antigravity: 'Antigravity',
    'opencode-go': 'OpenCode Go',
  };

  var MECHANISM_LABELS = {
    'cli-command': 'CLI command',
    'cli-server': 'CLI server',
    'cli-files': 'CLI files',
    'provider-endpoint': 'Provider account endpoint',
  };

  var BADGE_TEXT = {
    loading: 'Loading…',
    ok: 'OK',
    stale: 'Stale',
    unavailable: 'Unavailable',
  };

  function isFiniteNumber(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function str(v) {
    return typeof v === 'string' ? v : '';
  }

  function isObject(v) {
    return typeof v === 'object' && v !== null;
  }

  function formatAge(ms) {
    if (!isFiniteNumber(ms) || ms < 0) return '';
    var s = Math.floor(ms / 1000);
    if (s < 60) return 'just now';
    var m = Math.floor(s / 60);
    if (m < 60) return m + ' min ago';
    var h = Math.floor(m / 60);
    if (h < 24) return h + ' h ago';
    return Math.floor(h / 24) + ' d ago';
  }

  function formatReset(resetsAt, now) {
    if (!isFiniteNumber(resetsAt)) return { relative: '', absolute: '' };
    var absolute = '';
    try {
      absolute = new Date(resetsAt).toLocaleString();
    } catch (e) {
      absolute = '';
    }
    var base = isFiniteNumber(now) ? now : Date.now();
    var diff = resetsAt - base;
    if (diff <= 0) return { relative: 'resets now', absolute: absolute };
    var totalMin = Math.floor(diff / 60000);
    var days = Math.floor(totalMin / 1440);
    var hours = Math.floor((totalMin % 1440) / 60);
    var mins = totalMin % 60;
    var rel;
    if (days >= 1) rel = days + 'd ' + hours + 'h';
    else if (hours >= 1) rel = hours + 'h ' + mins + 'm';
    else rel = mins + 'm';
    return { relative: 'resets in ' + rel, absolute: absolute };
  }

  function formatRaw(raw) {
    if (!isObject(raw)) return '';
    var unit = typeof raw.unit === 'string' && raw.unit ? ' ' + raw.unit : '';
    var hasUsed = isFiniteNumber(raw.used);
    var hasLimit = isFiniteNumber(raw.limit);
    var hasRemaining = isFiniteNumber(raw.remaining);
    var parts = [];
    if (hasUsed && hasLimit) parts.push(raw.used + ' / ' + raw.limit + unit + ' used');
    else if (hasUsed) parts.push(raw.used + unit + ' used');
    else if (hasLimit) parts.push('limit ' + raw.limit + unit);
    if (hasRemaining) parts.push(raw.remaining + unit + ' remaining');
    return parts.join(', ');
  }

  function windowView(w, now) {
    var win = isObject(w) ? w : {};
    var scope = isObject(win.scope) ? win.scope : {};
    var scopeParts = [];
    if (typeof scope.model === 'string' && scope.model) scopeParts.push('model: ' + scope.model);
    if (typeof scope.plan === 'string' && scope.plan) scopeParts.push('plan: ' + scope.plan);
    var hasBar = isFiniteNumber(win.usedPercent);
    var remaining;
    var figure;
    if (hasBar) {
      remaining = 100 - Math.min(100, Math.max(0, win.usedPercent));
      figure = Math.round(remaining) + '% remaining';
    } else {
      figure = formatRaw(win.raw) || 'No figure reported';
    }
    var reset = formatReset(win.resetsAt, now);
    return {
      label: str(win.label),
      scopeText: scopeParts.join(' · '),
      hasBar: hasBar,
      remainingPercent: remaining,
      figure: figure,
      resetText: reset.relative,
      resetAbsolute: reset.absolute,
      derived: win.provenance === 'baiton-derived',
    };
  }

  function windowRow(w) {
    var v = isObject(w) ? w : {};
    var reset = str(v.resetText);
    return {
      label: str(v.label) + (v.derived === true ? ' · Baiton-derived' : ''),
      figure: str(v.figure),
      reset: reset,
      resetTitle: reset ? str(v.resetAbsolute) : '',
    };
  }

  function cardView(row, now) {
    var r = isObject(row) ? row : {};
    var reading = isObject(r.reading) ? r.reading : undefined;
    var status = reading && (reading.status === 'ok' || reading.status === 'stale' || reading.status === 'unavailable')
      ? reading.status
      : 'loading';
    var tool = str(r.tool);
    var view = {
      tool: tool,
      label: str(r.label) || TOOL_LABELS[tool] || tool,
      refreshing: r.refreshing === true,
      status: status,
      badge: BADGE_TEXT[status],
      tier: '',
      windows: [],
      reason: '',
      ageText: '',
      sourceLine: '',
      derived: false,
    };
    if (!reading) return view;

    if (status === 'unavailable') {
      view.reason = str(reading.reason);
      var tried = MECHANISM_LABELS[reading.mechanism];
      if (tried) view.sourceLine = 'Tried: ' + tried;
      return view;
    }

    var source = isObject(reading.source) ? reading.source : {};
    var windows = Array.isArray(reading.windows) ? reading.windows : [];
    view.tier = str(reading.tier);
    view.windows = windows.map(function (w) {
      return windowView(w, now);
    });
    var age = isFiniteNumber(source.readAt) && isFiniteNumber(now) ? formatAge(now - source.readAt) : '';
    view.ageText = age;
    if (status === 'stale') view.reason = 'Last read failed: ' + str(reading.reason);
    var sourceDerived = source.provenance === 'baiton-derived';
    view.derived = sourceDerived || view.windows.some(function (w) { return w.derived; });
    var mech = MECHANISM_LABELS[source.mechanism] || '';
    var pieces = [];
    if (mech || str(source.detail)) pieces.push(mech + (mech && source.detail ? ' — ' : '') + str(source.detail));
    pieces.push(sourceDerived ? 'Baiton-derived' : 'Provider-reported');
    if (age) pieces.push('read ' + age);
    view.sourceLine = pieces.join(' · ');
    return view;
  }

  // Exposed so tests can load the helpers outside a webview.
  if (typeof window !== 'undefined') {
    window.baitonUsageView = {
      TOOL_ORDER: TOOL_ORDER,
      TOOL_LABELS: TOOL_LABELS,
      MECHANISM_LABELS: MECHANISM_LABELS,
      formatAge: formatAge,
      formatReset: formatReset,
      formatRaw: formatRaw,
      windowView: windowView,
      windowRow: windowRow,
      cardView: cardView,
    };
  }

  if (typeof acquireVsCodeApi !== 'function') {
    return;
  }

  // ----- DOM / host wiring -------------------------------------------------

  var vscode = acquireVsCodeApi();

  var RESTRICTED_TEXT =
    'Restricted Mode: Baiton reads no stored credentials, so provider-endpoint fallbacks are skipped. Trust this workspace to enable them.';

  var state = { rows: null, now: Date.now(), viewState: null };
  var lastTick = Date.now();

  function placeholderRows() {
    return TOOL_ORDER.map(function (tool) {
      return { tool: tool, label: TOOL_LABELS[tool], refreshing: false };
    });
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function buildCard(row) {
    var v = cardView(row, state.now);
    var card = el('div', 'card');
    card.setAttribute('data-tool', v.tool);

    var header = el('div', 'card-header');
    header.appendChild(el('span', 'card-title', v.label));
    var badges = el('span', 'badges');
    badges.appendChild(el('span', 'badge ' + v.status, v.badge));
    if (v.derived) badges.appendChild(el('span', 'badge derived', 'Baiton-derived'));
    if (v.refreshing) badges.appendChild(el('span', 'refreshing', 'Refreshing…'));
    header.appendChild(badges);
    card.appendChild(header);

    if (v.tier) card.appendChild(el('div', 'tier', 'Plan: ' + v.tier));
    if (v.status === 'stale' && v.ageText) {
      card.appendChild(el('div', 'muted', 'Showing data from ' + v.ageText));
    }

    v.windows.forEach(function (w) {
      var r = windowRow(w);
      var box = el('div', 'window');
      var rowEl = el('div', 'window-row');
      var head = el('div', 'window-head');
      head.appendChild(el('span', 'window-label', r.label));
      head.appendChild(el('span', 'window-figure', r.figure));
      rowEl.appendChild(head);
      if (r.reset) {
        var reset = el('span', 'window-reset', r.reset);
        if (r.resetTitle) reset.title = r.resetTitle;
        rowEl.appendChild(reset);
      }
      box.appendChild(rowEl);
      if (w.scopeText) box.appendChild(el('div', 'window-scope', w.scopeText));
      if (w.hasBar) {
        var track = el('div', 'bar');
        track.setAttribute('role', 'progressbar');
        track.setAttribute('aria-valuemin', '0');
        track.setAttribute('aria-valuemax', '100');
        track.setAttribute('aria-valuenow', String(w.remainingPercent));
        track.setAttribute('aria-label', w.label + ' remaining');
        var fill = el('div', 'bar-fill');
        fill.style.width = w.remainingPercent + '%';
        track.appendChild(fill);
        box.appendChild(track);
      }
      card.appendChild(box);
    });

    if (v.reason) card.appendChild(el('div', 'reason', v.reason));
    if (v.sourceLine) card.appendChild(el('div', 'source-line', v.sourceLine));
    return card;
  }

  function render() {
    var cards = document.getElementById('cards');
    var summary = document.getElementById('summary');
    var note = document.getElementById('restricted-note');
    var refresh = /** @type {HTMLButtonElement | null} */ (document.getElementById('refresh'));
    var vs = state.viewState;

    if (cards) {
      while (cards.firstChild) cards.removeChild(cards.firstChild);
      var rows = state.rows || placeholderRows();
      var byTool = {};
      rows.forEach(function (row) {
        if (isObject(row) && TOOL_ORDER.indexOf(row.tool) >= 0) byTool[row.tool] = row;
      });
      TOOL_ORDER.forEach(function (tool) {
        var row = byTool[tool] || { tool: tool, label: TOOL_LABELS[tool], refreshing: false };
        cards.appendChild(buildCard(row));
      });
    }

    if (summary) {
      if (vs && vs.refreshing) summary.textContent = 'Refreshing…';
      else if (vs && isFiniteNumber(vs.refreshIntervalSeconds)) {
        summary.textContent = 'Auto-refresh every ' + vs.refreshIntervalSeconds + ' s';
      } else summary.textContent = '';
    }

    if (note) {
      if (vs && vs.trusted === false) {
        note.textContent = RESTRICTED_TEXT;
        note.classList.add('visible');
      } else {
        note.textContent = '';
        note.classList.remove('visible');
      }
    }

    if (refresh) refresh.disabled = !!(vs && vs.refreshing);
  }

  var refreshButton = document.getElementById('refresh');
  if (refreshButton) {
    refreshButton.addEventListener('click', function () {
      vscode.postMessage({ type: 'refresh' });
    });
  }

  window.addEventListener('message', function (event) {
    var msg = event && event.data;
    if (!isObject(msg) || typeof msg.type !== 'string') return;
    if (msg.type === 'readings') {
      if (!Array.isArray(msg.rows)) return;
      state.rows = msg.rows;
      state.now = isFiniteNumber(msg.now) ? msg.now : Date.now();
    } else if (msg.type === 'state') {
      if (!isObject(msg.state)) return;
      state.viewState = msg.state;
      if (isFiniteNumber(msg.state.now)) state.now = msg.state.now;
    } else {
      return;
    }
    lastTick = Date.now();
    render();
  });

  // Keep ages current between host messages: advance the host clock by the
  // local time elapsed. No messages, no network.
  setInterval(function () {
    var t = Date.now();
    state.now += t - lastTick;
    lastTick = t;
    render();
  }, 30000);

  vscode.postMessage({ type: 'ready' });
  render();
})();
