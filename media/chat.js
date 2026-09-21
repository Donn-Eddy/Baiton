// @ts-check
/*
 * Chat_View entry script (Requirements 12, 14, 16, 19.2).
 *
 * The view is a pure projection of a single `WebviewState`. Host→webview
 * messages are folded into that state through the shared `reduce` reducer
 * (`window.baitonProtocol`, mirrored from `src/orchestrator/webviewProtocol.ts`,
 * Req 9.9, 19.4); after each fold the DOM is re-rendered from the new state.
 * User actions post `WebviewToHost` messages back to the host.
 *
 * Rendering is safe by construction: assistant text is turned into HTML by the
 * vendored markdown renderer (task 11.2) with raw HTML disabled, then always
 * passed through the owned sanitizer (`window.baitonSanitizeHtml`) before it
 * touches the DOM. Any raw HTML in the source therefore appears as literal
 * escaped text and malformed markdown degrades to escaped plain text without
 * failing the message (Req 12.1, 12.2, 19.5). Tool-call rows render collapsed
 * with an ok/error/pending indicator and a toggle (Req 12.3, 12.4). The
 * transcript also renders inline intervention cards built from
 * record.intervention; a pending card offers answer controls and the user's
 * choice is posted back with `answerIntervention`, a resolved card shows the
 * decision as a durable inline record. The composer control row also carries
 * an Auto-mode toggle immediately left of Stop that reflects `state.autoMode`,
 * stays enabled while busy, and posts `setAutoMode`.
 *
 * The input box characters survive hide/show because they are persisted to the
 * webview state via acquireVsCodeApi().setState (Req 16.5) — retained across
 * the retainContextWhenHidden lifecycle and restored on load.
 */
(function () {
  'use strict';

  // eslint-disable-next-line no-undef
  const vscode = acquireVsCodeApi();
  const protocol = window.baitonProtocol;
  const sanitize = window.baitonSanitizeHtml;

  // ----- Elements --------------------------------------------------------

  const selectEl = /** @type {HTMLSelectElement} */ (document.getElementById('conversation-select'));
  const errorBanner = /** @type {HTMLElement} */ (document.getElementById('error-banner'));
  const errorMessage = /** @type {HTMLElement} */ (document.getElementById('error-message'));
  const errorFix = /** @type {HTMLButtonElement} */ (document.getElementById('error-fix'));
  const transcriptEl = /** @type {HTMLElement} */ (document.getElementById('transcript'));
  const emptyState = /** @type {HTMLElement} */ (document.getElementById('empty-state'));
  const emptyEndpoint = /** @type {HTMLElement} */ (document.getElementById('empty-endpoint'));
  const emptyModel = /** @type {HTMLElement} */ (document.getElementById('empty-model'));
  const emptySetKey = /** @type {HTMLButtonElement} */ (document.getElementById('empty-set-key'));
  const inputEl = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'));
  const sendBtn = /** @type {HTMLButtonElement} */ (document.getElementById('send'));
  const stopBtn = /** @type {HTMLButtonElement} */ (document.getElementById('stop'));
  const autoBtn = /** @type {HTMLButtonElement} */ (document.getElementById('auto-mode'));
  const newChatBtn = /** @type {HTMLButtonElement} */ (document.getElementById('new-chat'));
  const sessionListEl = /** @type {HTMLElement} */ (document.getElementById('session-list'));

  const MAX_INPUT_CHARS = 100000;

  // ----- State -----------------------------------------------------------

  // Restore any persisted state (input draft is restored on load so it survives
  // hide/show, Req 16.5).
  const persisted = vscode.getState() || {};
  let state = protocol.initialWebviewState();
  if (persisted.inputDraft) {
    inputEl.value = persisted.inputDraft;
  }
  // Track which tool rows the user has expanded, keyed by record index, so a
  // re-render preserves their open/closed state across state updates.
  let expandedTools = {};
  // Cards the user has answered in this webview but the host has not settled
  // yet; their controls render disabled so one ask is never answered twice.
  let answeredInterventions = {};
  // Unsent per-card input: { text: string, optionId: string } keyed by ask id,
  // so a re-render (a stream delta, a tool update) never loses typing.
  let interventionDrafts = {};
  // How many records the transcript DOM was last built from. Consecutive tool
  // rows are grouped, so the element count is not the record count; this is what
  // the streaming fast path checks the DOM against.
  let renderedRecordCount = 0;
  // The signature the session list DOM was last built from; the list is rebuilt
  // only when it changes, so clicking a row does not clobber focus.
  let renderedSessionSignature = null;
  // Set when the host replaced the whole conversation: that render always snaps
  // to the bottom, whatever the previous scroll position was.
  let forceScrollToBottom = true;

  /** How close to the bottom (px) still counts as "following" the transcript. */
  const SCROLL_STICK_PX = 40;

  /** Whether the transcript is scrolled to (or very near) its bottom. */
  function isAtBottom() {
    return (
      transcriptEl.scrollHeight - transcriptEl.scrollTop - transcriptEl.clientHeight <=
      SCROLL_STICK_PX
    );
  }

  function persistDraft() {
    vscode.setState(Object.assign({}, vscode.getState() || {}, { inputDraft: inputEl.value }));
  }

  /** Per-card unsent draft { text, optionId }, created lazily. */
  function cardDraft(id) {
    if (!interventionDrafts[id]) {
      interventionDrafts[id] = { text: '', optionId: '' };
    }
    return interventionDrafts[id];
  }

  // ----- Rendering -------------------------------------------------------

  /** Escape text for safe insertion as literal characters. */
  function escapeText(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  /**
   * Turn assistant markdown into sanitized HTML. Raw HTML in the source is
   * disabled at the renderer and therefore surfaces as literal escaped text;
   * the output always passes through the owned sanitizer; a renderer failure
   * degrades to escaped plain text without throwing (Req 12.1, 12.2, 19.5).
   */
  function renderMarkdown(text) {
    let html;
    try {
      const marked = window.marked;
      if (marked && typeof marked.parse === 'function') {
        html = marked.parse(text, { async: false, gfm: true, breaks: true });
      } else if (typeof marked === 'function') {
        html = marked(text);
      } else {
        // No vendored renderer yet (task 11.2 adds it): fall back to escaped
        // plain text with preserved line breaks.
        html = '<p>' + escapeText(text).replace(/\n/g, '<br>') + '</p>';
      }
    } catch (_e) {
      html = '<p>' + escapeText(text).replace(/\n/g, '<br>') + '</p>';
    }
    return sanitize(String(html));
  }

  /** Fill a message body from its record (sanitized markdown or literal text). */
  function fillBody(body, record) {
    if (record.role === 'assistant' || record.role === 'system') {
      // Sanitized markdown (Req 12.1).
      body.innerHTML = renderMarkdown(record.content);
    } else {
      // User content is shown as literal text.
      body.textContent = record.content;
    }
  }

  /** Build a message element for a non-tool record. */
  function renderMessage(record) {
    const wrap = document.createElement('div');
    wrap.className = 'message ' + record.role + (record.streaming ? ' streaming' : '');

    const role = document.createElement('div');
    role.className = 'role';
    role.textContent = record.role;
    wrap.appendChild(role);

    const body = document.createElement('div');
    body.className = 'body';
    fillBody(body, record);
    wrap.appendChild(body);
    return wrap;
  }

  /**
   * Fast path for a streamed fragment: when the trailing DOM element already
   * shows the trailing streaming record, re-render only that body instead of
   * the whole transcript. Returns false when a full render is needed.
   */
  function renderStreamingTail() {
    const record = state.records[state.records.length - 1];
    const el = transcriptEl.lastElementChild;
    if (
      !record ||
      !record.streaming ||
      !el ||
      !el.classList.contains('streaming') ||
      renderedRecordCount !== state.records.length
    ) {
      return false;
    }
    const body = el.querySelector('.body');
    if (!body) {
      return false;
    }
    // Whether to follow the stream is decided before the DOM grows.
    const stick = isAtBottom();
    fillBody(body, record);
    if (stick) {
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
    }
    return true;
  }

  /** The first string argument of a tool call's JSON arguments, if any. */
  function firstStringArg(args) {
    let parsed;
    try {
      parsed = JSON.parse(args);
    } catch (_e) {
      return '';
    }
    if (!parsed || typeof parsed !== 'object') {
      return typeof parsed === 'string' ? parsed : '';
    }
    const keys = Object.keys(parsed);
    for (let i = 0; i < keys.length; i++) {
      const value = parsed[keys[i]];
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }
    return '';
  }

  /** Truncate a summary detail to the one-line budget. */
  function truncate(text, max) {
    const flat = String(text).replace(/\s+/g, ' ').trim();
    return flat.length > max ? flat.slice(0, max - 1) + '\u2026' : flat;
  }

  /**
   * Build a collapsible tool-call row (Req 12.3, 12.4). Rows are closed by
   * default: the summary is one compact line — the tool name, its first string
   * argument, and a small status dot coloured from the theme. Expanding shows
   * the argument JSON and the result body.
   */
  function renderToolRow(record, index) {
    const details = document.createElement('details');
    details.className = 'tool-row';
    details.open = Boolean(expandedTools[index]);
    details.addEventListener('toggle', function () {
      expandedTools[index] = details.open;
    });

    const summary = document.createElement('summary');
    summary.className = 'tool-summary';

    const indicator = record.tool.result; // one of 'ok' | 'error' | 'pending'
    const dot = document.createElement('span');
    dot.className = 'tool-dot ' + indicator;
    dot.setAttribute('aria-hidden', 'true');
    summary.appendChild(dot);

    const name = document.createElement('span');
    name.className = 'tool-name';
    name.textContent = record.tool.name;
    summary.appendChild(name);

    const detail = document.createElement('span');
    detail.className = 'tool-detail';
    detail.textContent = truncate(firstStringArg(record.tool.args), 60);
    summary.appendChild(detail);

    // The indicator is conveyed by colour alone in the summary line, so name it
    // for assistive technology.
    const status = document.createElement('span');
    status.className = 'tool-status-label';
    status.textContent = indicator;
    summary.appendChild(status);

    details.appendChild(summary);

    const args = document.createElement('pre');
    args.className = 'tool-args';
    args.textContent = record.tool.args;
    details.appendChild(args);

    if (record.content) {
      const result = document.createElement('pre');
      result.className = 'tool-result-body';
      result.textContent = record.content;
      details.appendChild(result);
    }

    return details;
  }

  /** Human label for a card kind, used in the header and as the group name. */
  function kindLabel(kind) {
    return kind === 'confirm' ? 'Confirmation' : kind === 'permission' ? 'Permission request' : 'Question';
  }

  /** One-line summary of a resolved card's decision, pure (no DOM access). */
  function decisionSummary(card) {
    const answer = card.answer || {};
    if (answer.kind === 'option') {
      const options = card.options || [];
      for (let i = 0; i < options.length; i++) {
        if (options[i].id === answer.optionId) {
          return 'Answered: ' + options[i].label;
        }
      }
      return 'Answered: ' + (answer.label || answer.optionId);
    }
    if (answer.kind === 'text') {
      return 'Answered: ' + answer.text;
    }
    if (answer.kind === 'approved') {
      return 'Approved';
    }
    if (answer.kind === 'declined') {
      return answer.reason ? 'Declined \u2014 ' + answer.reason : 'Declined';
    }
    return 'Answered';
  }

  /**
   * Build one inline intervention card from a record carrying `intervention`.
   *
   * Everything except the prompt is assigned with textContent (the prompt is
   * the only field that goes through renderMarkdown), so harness-supplied
   * agent/tool/args strings can never inject markup. A pending card renders
   * kind-specific controls that depend only on the local answered-lock — never
   * on `state.busy`, because an ask normally arrives while a pipeline runs. A
   * resolved card renders no controls at all, only the decision, which is what
   * makes it a durable inline record. An unrecognised kind renders the prompt
   * with no controls rather than throwing.
   */
  function renderInterventionCard(record) {
    const card = record.intervention;

    const wrap = document.createElement('div');
    wrap.className = 'intervention ' + card.kind + ' ' + (card.status === 'resolved' ? 'resolved' : 'pending');
    wrap.dataset.interventionId = card.id;
    wrap.setAttribute('role', 'group');
    wrap.setAttribute('aria-label', kindLabel(card.kind));

    const head = document.createElement('div');
    head.className = 'intervention-head';
    const kind = document.createElement('span');
    kind.className = 'intervention-kind';
    kind.textContent = kindLabel(card.kind);
    head.appendChild(kind);
    if (card.agent || card.tool) {
      const meta = document.createElement('span');
      meta.className = 'intervention-meta';
      meta.textContent = [card.agent, card.tool].filter(Boolean).join(' \u00b7 ');
      head.appendChild(meta);
    }
    wrap.appendChild(head);

    // The prompt is markdown; it carries the body class so the existing
    // .body p/pre/code/a rules apply. It is always sanitized.
    const prompt = document.createElement('div');
    prompt.className = 'body intervention-prompt';
    prompt.innerHTML = renderMarkdown(card.prompt || record.content);
    wrap.appendChild(prompt);

    if (typeof card.detail === 'string' && card.detail.length > 0) {
      const detail = document.createElement('div');
      detail.className = 'intervention-detail';
      detail.textContent = card.detail;
      wrap.appendChild(detail);
    }

    if (typeof card.args === 'string' && card.args.length > 0) {
      const args = document.createElement('details');
      args.className = 'intervention-args';
      const summary = document.createElement('summary');
      summary.textContent = 'Arguments';
      args.appendChild(summary);
      const pre = document.createElement('pre');
      pre.textContent = card.args;
      args.appendChild(pre);
      wrap.appendChild(args);
    }

    const pending = card.status !== 'resolved';
    const options = card.options || [];
    const locked = Boolean(answeredInterventions[card.id]);
    // Tag every focusable control so a re-render can restore focus/caret.
    function tagControl(el, field) {
      el.dataset.interventionId = card.id;
      el.dataset.interventionField = field;
    }

    if (pending && card.kind === 'question' && options.length > 0 && card.allowFreeText !== true) {
      // Option buttons only: one click answers outright.
      const opts = document.createElement('div');
      opts.className = 'intervention-options';
      for (let i = 0; i < options.length; i++) {
        const option = options[i];
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'intervention-option';
        btn.disabled = locked;
        tagControl(btn, 'opt:' + option.id);
        const label = document.createElement('span');
        label.textContent = option.label;
        btn.appendChild(label);
        if (option.detail) {
          const detail = document.createElement('span');
          detail.className = 'intervention-option-detail';
          detail.textContent = option.detail;
          btn.appendChild(detail);
        }
        btn.addEventListener('click', function () {
          answerIntervention(card.id, { kind: 'option', optionId: option.id, label: option.label });
        });
        opts.appendChild(btn);
      }
      wrap.appendChild(opts);
    } else if (pending && card.kind === 'question' && options.length > 0 && card.allowFreeText === true) {
      // Radios plus a free-text row: typed text wins over a selected radio.
      const draft = cardDraft(card.id);
      const opts = document.createElement('fieldset');
      opts.className = 'intervention-options';
      const legend = document.createElement('legend');
      legend.className = 'intervention-legend';
      legend.textContent = 'Choose an option';
      opts.appendChild(legend);
      let submit = null;
      for (let i = 0; i < options.length; i++) {
        const option = options[i];
        const label = document.createElement('label');
        label.className = 'intervention-radio';
        const radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'intervention-' + card.id;
        radio.checked = draft.optionId === option.id;
        radio.disabled = locked;
        tagControl(radio, 'opt:' + option.id);
        radio.addEventListener('change', function () {
          if (radio.checked) {
            cardDraft(card.id).optionId = option.id;
          }
          refresh();
        });
        label.appendChild(radio);
        const span = document.createElement('span');
        span.textContent = option.label;
        label.appendChild(span);
        if (option.detail) {
          const detail = document.createElement('span');
          detail.className = 'intervention-option-detail';
          detail.textContent = option.detail;
          label.appendChild(detail);
        }
        opts.appendChild(label);
      }
      wrap.appendChild(opts);

      const row = document.createElement('div');
      row.className = 'intervention-answer-row';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'intervention-input';
      input.placeholder = card.placeholder || 'Type your answer\u2026';
      input.value = draft.text;
      input.ariaLabel = 'Answer';
      input.disabled = locked;
      tagControl(input, 'text');
      submit = document.createElement('button');
      submit.type = 'button';
      submit.textContent = 'Submit';
      submit.disabled = locked;
      tagControl(submit, 'submit');
      function refresh() {
        // Non-whitespace text or a selected radio is enough to submit; Submit
        // is disabled only when neither is present (or the card is locked).
        submit.disabled =
          locked || input.value.trim().length === 0 && !draft.optionId;
      }
      input.addEventListener('input', function () {
        cardDraft(card.id).text = input.value;
        refresh();
      });
      submit.addEventListener('click', submitAnswer);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          submitAnswer();
        }
      });
      function submitAnswer() {
        if (locked) {
          return;
        }
        if (input.value.trim().length > 0) {
          answerIntervention(card.id, { kind: 'text', text: input.value });
          return;
        }
        if (draft.optionId) {
          for (let i = 0; i < options.length; i++) {
            if (options[i].id === draft.optionId) {
              answerIntervention(card.id, {
                kind: 'option',
                optionId: draft.optionId,
                label: options[i].label,
              });
              return;
            }
          }
        }
      }
      refresh();
      row.appendChild(input);
      row.appendChild(submit);
      wrap.appendChild(row);
    } else if (pending && card.kind === 'question') {
      // Free text only.
      const row = document.createElement('div');
      row.className = 'intervention-answer-row';
      const input = document.createElement('input');
      input.type = 'text';
      input.className = 'intervention-input';
      input.placeholder = card.placeholder || 'Type your answer\u2026';
      input.value = cardDraft(card.id).text;
      input.ariaLabel = 'Answer';
      input.disabled = locked;
      tagControl(input, 'text');
      const submit = document.createElement('button');
      submit.type = 'button';
      submit.textContent = 'Send';
      submit.disabled = locked;
      tagControl(submit, 'submit');
      function refresh() {
        submit.disabled = locked || input.value.trim().length === 0;
      }
      function submitAnswer() {
        if (locked || input.value.trim().length === 0) {
          return;
        }
        answerIntervention(card.id, { kind: 'text', text: input.value });
      }
      input.addEventListener('input', function () {
        cardDraft(card.id).text = input.value;
        refresh();
      });
      submit.addEventListener('click', submitAnswer);
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          submitAnswer();
        }
      });
      refresh();
      row.appendChild(input);
      row.appendChild(submit);
      wrap.appendChild(row);
    } else if (pending && (card.kind === 'confirm' || card.kind === 'permission')) {
      const actions = document.createElement('div');
      actions.className = 'intervention-actions';
      const approve = document.createElement('button');
      approve.type = 'button';
      approve.textContent = 'Approve';
      approve.disabled = locked;
      tagControl(approve, 'approve');
      approve.addEventListener('click', function () {
        answerIntervention(card.id, { kind: 'approved' });
      });
      const decline = document.createElement('button');
      decline.type = 'button';
      decline.className = 'secondary';
      decline.textContent = 'Decline';
      decline.disabled = locked;
      tagControl(decline, 'decline');
      decline.addEventListener('click', function () {
        answerIntervention(card.id, { kind: 'declined' });
      });
      actions.appendChild(approve);
      actions.appendChild(decline);
      wrap.appendChild(actions);
    }

    if (!pending) {
      const settled = document.createElement('div');
      settled.className = 'intervention-settled';
      const decision = document.createElement('span');
      decision.className = 'intervention-decision';
      decision.textContent = decisionSummary(card);
      settled.appendChild(decision);
      if (card.auto === true) {
        const auto = document.createElement('span');
        auto.className = 'intervention-auto';
        auto.textContent = 'Auto';
        auto.title = 'Decided by Auto mode';
        settled.appendChild(auto);
      }
      if (typeof card.rationale === 'string' && card.rationale.length > 0) {
        const rationale = document.createElement('div');
        rationale.className = 'intervention-rationale';
        rationale.textContent = card.rationale;
        settled.appendChild(rationale);
      }
      wrap.appendChild(settled);
    }

    return wrap;
  }


  function renderTranscript() {
    // Capture the focused card control before the rebuild so focus and caret
    // survive an unrelated re-render (a stream delta, a tool update).
    const active = document.activeElement;
    const focusCard = active && active.dataset ? active.dataset.interventionId : undefined;
    const focusField = active && active.dataset ? active.dataset.interventionField : undefined;
    const caret = active && typeof active.selectionStart === 'number' ? active.selectionStart : null;
    // Only snap to the bottom when the user was already following the tail (or
    // the host just replaced the conversation); otherwise expanding a tool row
    // mid-history would yank the view down.
    const stick = forceScrollToBottom || isAtBottom();
    transcriptEl.textContent = '';
    // Consecutive tool rows are grouped into one compact block so a long run of
    // calls reads as a single tight list rather than a stack of cards.
    let group = null;
    for (let i = 0; i < state.records.length; i++) {
      const record = state.records[i];
      if (record.intervention) {
        // A card always breaks a tool group; it is never a plain message.
        group = null;
        transcriptEl.appendChild(renderInterventionCard(record));
      } else if (record.tool) {
        if (group === null) {
          group = document.createElement('div');
          group.className = 'tool-group';
          transcriptEl.appendChild(group);
        }
        group.appendChild(renderToolRow(record, i));
      } else {
        group = null;
        transcriptEl.appendChild(renderMessage(record));
      }
    }
    renderedRecordCount = state.records.length;
    // Restore focus to the previously focused card control by scanning (ask ids
    // are host-generated and must not be interpolated into a CSS selector). Done
    // before the scroll decision so focusing cannot fight it.
    if (focusCard && focusField) {
      const controls = transcriptEl.querySelectorAll('[data-intervention-field]');
      for (let i = 0; i < controls.length; i++) {
        const el = controls[i];
        if (
          el.dataset.interventionId === focusCard &&
          el.dataset.interventionField === focusField &&
          !el.disabled
        ) {
          el.focus();
          if (caret !== null && typeof el.setSelectionRange === 'function') {
            el.setSelectionRange(caret, caret);
          }
          break;
        }
      }
    }
    if (stick) {
      transcriptEl.scrollTop = transcriptEl.scrollHeight;
    }
    forceScrollToBottom = false;
  }

  function renderSelector() {
    // Rebuild only when the entries changed to avoid clobbering focus.
    const want = state.conversations.map(function (c) { return c.id; }).join('\u0000');
    const have = Array.prototype.map
      .call(selectEl.options, function (o) { return o.value; })
      .join('\u0000');
    if (want !== have) {
      selectEl.textContent = '';
      state.conversations.forEach(function (c) {
        const opt = document.createElement('option');
        opt.value = c.id;
        opt.textContent = c.label;
        selectEl.appendChild(opt);
      });
    }
    if (state.activeId) {
      selectEl.value = state.activeId;
    }
  }

  /** A short relative time such as "5m ago", "2h ago", "3d ago", else a date. */
  function relativeTime(value) {
    const then = typeof value === 'number' ? value : Date.parse(String(value));
    if (!then || isNaN(then)) {
      return '';
    }
    const seconds = Math.floor((Date.now() - then) / 1000);
    if (seconds < 60) {
      return 'just now';
    }
    if (seconds < 3600) {
      return Math.floor(seconds / 60) + 'm ago';
    }
    if (seconds < 86400) {
      return Math.floor(seconds / 3600) + 'h ago';
    }
    if (seconds < 7 * 86400) {
      return Math.floor(seconds / 86400) + 'd ago';
    }
    const date = new Date(then);
    return (date.getMonth() + 1) + '/' + date.getDate();
  }

  /** Build one session row. */
  function renderSessionRow(session) {
    const row = document.createElement('div');
    row.className = 'session-row' + (session.id === state.activeSessionId ? ' active' : '');
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', session.id === state.activeSessionId ? 'true' : 'false');
    row.tabIndex = session.id === state.activeSessionId ? 0 : -1;
    row.dataset.sessionId = session.id;

    const title = document.createElement('span');
    title.className = 'session-title';
    title.textContent = session.title;
    title.title = session.title;
    row.appendChild(title);

    const time = document.createElement('span');
    time.className = 'session-time';
    time.textContent = relativeTime(session.updatedAt);
    row.appendChild(time);

    const del = document.createElement('button');
    del.className = 'session-delete';
    del.type = 'button';
    del.textContent = '\u2715';
    del.setAttribute('aria-label', 'Delete session');
    del.title = 'Delete this session';
    del.disabled = state.busy;
    del.addEventListener('click', function (e) {
      e.stopPropagation();
      if (state.busy) {
        return;
      }
      vscode.postMessage({ type: 'deleteSession', sessionId: session.id });
    });
    row.appendChild(del);

    row.addEventListener('click', function () {
      if (session.id === state.activeSessionId) {
        return;
      }
      vscode.postMessage({ type: 'selectSession', sessionId: session.id });
    });
    return row;
  }

  function renderSessions() {
    const signature = state.sessions
      .map(function (s) {
        return [s.id, s.title, s.updatedAt, s.id === state.activeSessionId, state.busy].join(
          '\u0001',
        );
      })
      .join('\u0000');
    if (signature === renderedSessionSignature) {
      return;
    }
    renderedSessionSignature = signature;
    sessionListEl.textContent = '';
    if (state.sessions.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'session-empty';
      empty.textContent = 'No saved chats yet.';
      sessionListEl.appendChild(empty);
      return;
    }
    state.sessions.forEach(function (session) {
      sessionListEl.appendChild(renderSessionRow(session));
    });
  }

  function renderError() {
    if (state.error) {
      errorMessage.textContent = state.error.message;
      if (state.error.action) {
        errorFix.style.display = '';
        errorFix.textContent =
          state.error.action === 'setApiKey' ? 'Set Orchestrator API Key' : 'Open Baiton Settings';
        errorFix.dataset.action = state.error.action;
      } else {
        errorFix.style.display = 'none';
        delete errorFix.dataset.action;
      }
      errorBanner.classList.add('visible');
    } else {
      errorBanner.classList.remove('visible');
    }
  }

  function renderEmptyState() {
    if (state.empty) {
      emptyEndpoint.textContent = state.empty.endpoint || 'not configured';
      emptyModel.textContent = state.empty.model || 'not configured';
      emptyState.classList.add('visible');
      transcriptEl.style.display = 'none';
    } else {
      emptyState.classList.remove('visible');
      transcriptEl.style.display = '';
    }
  }

  /**
   * The Auto-mode toggle is a pure projection of `state.autoMode`: the host is
   * authoritative, so the button never writes the flag locally — it posts
   * `setAutoMode` and repaints when the host echoes `setAutoMode` back through
   * the reducer. It is deliberately never disabled: an ask normally arrives
   * while a pipeline is running, so Auto must be flippable mid-run.
   */
  function renderAutoMode() {
    const on = Boolean(state.autoMode);
    autoBtn.setAttribute('aria-pressed', on ? 'true' : 'false');
    autoBtn.textContent = on ? 'Auto: On' : 'Auto: Off';
    autoBtn.title = on
      ? 'Auto mode on: safe asks are auto-approved, the rest are escalated as cards. Click to turn off.'
      : 'Auto mode off: every ask waits for you. Click to turn on.';
    autoBtn.disabled = false;
  }

  function updateEnablement() {
    // Send/stop enablement follows the busy flag; send additionally requires a
    // non-whitespace, in-limit input (Req 14.2, 14.3, 14.4, 14.5). The host
    // ChatController enforces the authoritative guard.
    const text = inputEl.value;
    const hasContent = text.trim().length > 0 && text.length <= MAX_INPUT_CHARS;
    sendBtn.disabled = state.busy || !hasContent;
    stopBtn.disabled = !state.busy;
    inputEl.disabled = state.busy;
    // New Chat (and each row's delete) is offered only while idle; the host
    // confirms before deleting a session.
    newChatBtn.disabled = state.busy;
  }

  function render() {
    renderSelector();
    renderSessions();
    renderError();
    renderEmptyState();
    renderTranscript();
    renderAutoMode();
    updateEnablement();
  }

  // ----- Actions ---------------------------------------------------------

  function send() {
    const text = inputEl.value;
    if (state.busy) {
      return;
    }
    if (text.trim().length === 0 || text.length > MAX_INPUT_CHARS) {
      return;
    }
    vscode.postMessage({ type: 'sendText', text: text });
    inputEl.value = '';
    persistDraft();
    updateEnablement();
  }

  /**
   * Answer an intervention ask exactly once per id: the local lock disables the
   * card's controls immediately so a fast second click cannot post twice, and
   * the answer is sent to the host which validates it with checkAnswer.
   */
  function answerIntervention(id, answer) {
    if (answeredInterventions[id]) {
      return;
    }
    answeredInterventions[id] = true;
    vscode.postMessage({ type: 'answerIntervention', id: id, answer: answer });
    render();
  }

  sendBtn.addEventListener('click', send);

  newChatBtn.addEventListener('click', function () {
    if (state.busy) {
      return;
    }
    vscode.postMessage({ type: 'newChat' });
    inputEl.focus();
  });

  // Keyboard support for the listbox: arrows move the focused option, Enter
  // selects it, Delete asks the host to delete it.
  sessionListEl.addEventListener('keydown', function (e) {
    const rows = Array.prototype.slice.call(sessionListEl.querySelectorAll('.session-row'));
    if (rows.length === 0) {
      return;
    }
    let index = rows.indexOf(document.activeElement);
    if (index < 0) {
      index = rows.findIndex(function (r) {
        return r.classList.contains('active');
      });
      if (index < 0) {
        index = 0;
      }
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const next = e.key === 'ArrowDown' ? Math.min(index + 1, rows.length - 1) : Math.max(index - 1, 0);
      rows[next].tabIndex = 0;
      rows[next].focus();
      return;
    }
    const row = rows[index];
    const sessionId = row && row.dataset ? row.dataset.sessionId : undefined;
    if (!sessionId) {
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      vscode.postMessage({ type: 'selectSession', sessionId: sessionId });
      return;
    }
    if (e.key === 'Delete') {
      e.preventDefault();
      if (state.busy) {
        return;
      }
      vscode.postMessage({ type: 'deleteSession', sessionId: sessionId });
    }
  });

  autoBtn.addEventListener('click', function () {
    // Host-authoritative: request the flip and let the host's `setAutoMode`
    // echo drive the repaint, exactly as `sendText` leaves `busy` to the host.
    vscode.postMessage({ type: 'setAutoMode', enabled: !state.autoMode });
  });

  stopBtn.addEventListener('click', function () {
    vscode.postMessage({ type: 'stop' });
  });

  inputEl.addEventListener('input', function () {
    persistDraft();
    updateEnablement();
  });

  // Enter sends; Shift+Enter inserts a newline.
  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  selectEl.addEventListener('change', function () {
    vscode.postMessage({ type: 'selectConversation', conversationId: selectEl.value });
  });

  errorFix.addEventListener('click', function () {
    const action = errorFix.dataset.action;
    if (action) {
      vscode.postMessage({ type: 'triggerFix', action: action });
    }
  });

  emptySetKey.addEventListener('click', function () {
    vscode.postMessage({ type: 'triggerFix', action: 'setApiKey' });
  });

  // ----- Host messages ---------------------------------------------------

  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (!msg || typeof msg.type !== 'string') {
      return;
    }
    // A fresh conversation render resets the per-index tool expansion tracking.
    if (msg.type === 'renderConversation') {
      expandedTools = {};
      forceScrollToBottom = true;
    }
    // A newly posted ask must be visible even if the user had scrolled up.
    if (msg.type === 'showIntervention') {
      forceScrollToBottom = true;
    }
    state = protocol.reduce(state, msg);
    if (msg.type === 'streamDelta' && renderStreamingTail()) {
      return;
    }
    render();
  });

  // Initial paint from the seeded state; the host pushes the first real state
  // through the message channel once the view is bound.
  render();
})();
