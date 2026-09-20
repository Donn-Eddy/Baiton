# Plan T05

## Steps

1. Add intervention-card CSS to the chat shell

   In media/chat.html, inside the existing <style nonce="${nonce}"> block, add an 'Intervention cards' section directly after the tool-row rules (.tool-args/.tool-result-body) and before the '/* Empty state */' section. Every colour must come from a VS Code theme variable (no literal colours) to match the file's existing convention. Rules to add:

   - extend the existing direct-child rule to `#transcript > .message, #transcript > .tool-group, #transcript > .intervention { flex-shrink: 0; }` (the transcript is a column flex container; without this a card gets squeezed).
   - `.intervention { display:flex; flex-direction:column; gap:6px; padding:var(--baiton-gap); border:1px solid var(--vscode-panel-border); border-left:2px solid var(--vscode-focusBorder); border-radius:3px; background-color:var(--vscode-editorWidget-background); }`
   - `.intervention.resolved { border-left-color:var(--vscode-panel-border); }`
   - `.intervention-head { display:flex; align-items:baseline; gap:6px; font-size:0.85em; text-transform:uppercase; letter-spacing:0.04em; color:var(--vscode-descriptionForeground); }`
   - `.intervention-meta { font-family:var(--vscode-editor-font-family, monospace); text-transform:none; letter-spacing:normal; }`
   - `.intervention-prompt { word-break:break-word; }` (the element also carries the existing `body` class so rendered markdown picks up the .body p/pre/code/a rules).
   - `.intervention-detail { color:var(--vscode-descriptionForeground); white-space:pre-wrap; word-break:break-word; }`
   - `.intervention-args > summary { cursor:pointer; color:var(--vscode-descriptionForeground); }` and `.intervention-args pre { margin:4px 0 0 0; padding:4px 6px; background-color:var(--vscode-textCodeBlock-background); white-space:pre-wrap; word-break:break-word; font-family:var(--vscode-editor-font-family, monospace); max-height:12em; overflow-y:auto; }`
   - `.intervention-options { display:flex; flex-wrap:wrap; gap:6px; border:none; margin:0; padding:0; }` and `fieldset.intervention-options { flex-direction:column; align-items:flex-start; }`
   - `.intervention-legend { padding:0; font-size:0.85em; color:var(--vscode-descriptionForeground); }`
   - `.intervention-radio { display:flex; align-items:baseline; gap:6px; cursor:pointer; }`
   - `.intervention-option-detail { font-size:0.9em; color:var(--vscode-descriptionForeground); }`
   - `.intervention-answer-row { display:flex; align-items:center; gap:6px; }`
   - `.intervention-input { flex:1 1 auto; min-width:0; box-sizing:border-box; padding:4px; font-family:var(--vscode-font-family); font-size:var(--vscode-font-size); color:var(--vscode-input-foreground); background-color:var(--vscode-input-background); border:1px solid var(--vscode-input-border, var(--vscode-panel-border)); }` plus `.intervention-input::placeholder { color:var(--vscode-input-placeholderForeground); }`
   - `.intervention-actions { display:flex; gap:6px; }`
   - `.intervention-settled { display:flex; flex-direction:column; gap:2px; }`
   - `.intervention-decision { color:var(--vscode-foreground); word-break:break-word; }`
   - `.intervention-auto { align-self:flex-start; padding:0 4px; font-size:0.8em; text-transform:uppercase; letter-spacing:0.04em; border:1px solid var(--vscode-panel-border); border-radius:3px; color:var(--vscode-descriptionForeground); }`
   - `.intervention-rationale { color:var(--vscode-descriptionForeground); word-break:break-word; }`

   Buttons inside a card reuse the file's global `button` / `button.secondary` / `button:disabled` rules — do not restyle them. No new element ids, no inline event handlers and no new external resources: the CSP block and the four <script> tags at the bottom stay exactly as they are. Finally extend the top-of-file HTML comment with one line noting that the transcript also renders inline intervention cards (question / confirm / permission) built by chat.js.

   Files: `media/chat.html`

2. Add per-card view state and the answer poster to chat.js

   In media/chat.js, in the '----- State -----' section next to `expandedTools`, add two module-level maps, each keyed by the (globally unique) intervention id and deliberately NOT cleared on `renderConversation`:

     // Cards the user has answered in this webview but the host has not settled
     // yet; their controls render disabled so one ask is never answered twice.
     let answeredInterventions = {};
     // Unsent per-card input: { text: string, optionId: string } keyed by ask id,
     // so a re-render (a stream delta, a tool update) never loses typing.
     let interventionDrafts = {};

   Add `function cardDraft(id) { if (!interventionDrafts[id]) { interventionDrafts[id] = { text: '', optionId: '' }; } return interventionDrafts[id]; }`.

   Add the single outbound action, near the other `vscode.postMessage` call sites in the '----- Actions -----' section:

     function answerIntervention(id, answer) {
       if (answeredInterventions[id]) { return; }
       answeredInterventions[id] = true;
       vscode.postMessage({ type: 'answerIntervention', id: id, answer: answer });
       render();
     }

   The posted message must match the WebviewToHost variant exactly: `{ type: 'answerIntervention', id, answer }` where `answer` is one of `{ kind: 'option', optionId, label }`, `{ kind: 'text', text }`, `{ kind: 'approved' }`, `{ kind: 'declined' }`. Do not invent extra fields; the host validates with `checkAnswer`. Also update the file's top comment block to mention that intervention cards are rendered from `record.intervention` and answered with `answerIntervention`.

   Files: `media/chat.js`

3. Build the card renderer: header, prompt, detail, args

   In media/chat.js, add `renderInterventionCard(record)` just after `renderToolRow`. It reads `const card = record.intervention;` and builds, with document.createElement only (no innerHTML except the sanitized prompt):

     const wrap = document.createElement('div');
     wrap.className = 'intervention ' + card.kind + ' ' + (card.status === 'resolved' ? 'resolved' : 'pending');
     wrap.dataset.interventionId = card.id;
     wrap.setAttribute('role', 'group');
     wrap.setAttribute('aria-label', kindLabel(card.kind));

   Add `function kindLabel(kind) { return kind === 'confirm' ? 'Confirmation' : kind === 'permission' ? 'Permission request' : 'Question'; }`.

   Children, in order:
   1. `.intervention-head` div containing a `<span class="intervention-kind">` with `kindLabel(card.kind)` and, when `card.agent` or `card.tool` is set, a `<span class="intervention-meta">` whose textContent is `[card.agent, card.tool].filter(Boolean).join(' \u00b7 ')`.
   2. `<div class="body intervention-prompt">` whose innerHTML is `renderMarkdown(card.prompt || record.content)` — the existing sanitize-on-every-path helper; never assign unsanitized HTML.
   3. when `card.detail` is a non-empty string, `<div class="intervention-detail">` with `textContent = card.detail` (this is the 'what you are approving / why it was flagged' text, and it renders in BOTH the pending and the settled state).
   4. when `card.args` is a non-empty string, `<details class="intervention-args"><summary>Arguments</summary><pre></pre></details>` with the `<pre>` textContent set to `card.args` (plain text, never markdown).

   Everything except the prompt is inserted as textContent, so harness-supplied agent/tool/args strings can never inject markup.

   Files: `media/chat.js`

4. Render the pending controls per kind and post the answer

   Continue `renderInterventionCard`: when `card.status !== 'resolved'`, append a controls block. Let `const options = card.options || [];` and `const locked = Boolean(answeredInterventions[card.id]);` — every control built below sets `.disabled = locked` (and only that: controls must NOT be disabled by `state.busy`, because an ask normally arrives while a pipeline is running).

   Every focusable control gets `el.dataset.interventionId = card.id` and `el.dataset.interventionField = <field>` so step 6 can restore focus. Field names: `'opt:' + option.id` for a radio or option button, `'text'`, `'submit'`, `'approve'`, `'decline'`.

   A) question with options and no free text (`card.kind === 'question' && options.length > 0 && card.allowFreeText !== true`): a `<div class="intervention-options">` holding one `<button type="button" class="intervention-option">` per option; the button contains a label span (textContent = option.label) and, when `option.detail` is set, a `<span class="intervention-option-detail">` with that detail; `click` → `answerIntervention(card.id, { kind: 'option', optionId: option.id, label: option.label })`.

   B) question with options AND `card.allowFreeText === true`: a `<fieldset class="intervention-options">` with `<legend class="intervention-legend">Choose an option</legend>` and one `<label class="intervention-radio">` per option wrapping `<input type="radio" name="intervention-" + card.id>` (checked when `cardDraft(card.id).optionId === option.id`), the label text and any option.detail span; a radio's `change` sets `cardDraft(card.id).optionId = option.id` and refreshes the submit button's disabled state. Then the same answer row as (C). Submit semantics, exactly: non-whitespace text wins (`{ kind: 'text', text: input.value }`); otherwise a checked radio posts `{ kind: 'option', optionId, label }`; with neither, Submit is disabled.

   C) question with no options: an `<div class="intervention-answer-row">` holding `<input type="text" class="intervention-input">` (placeholder `card.placeholder || 'Type your answer\u2026'`, `value = cardDraft(card.id).text`, aria-label = 'Answer') and a `<button type="button">Send</button>`. The input's `input` event writes `cardDraft(card.id).text = input.value` and re-evaluates the button's `disabled`; `keydown` with `e.key === 'Enter' && !e.shiftKey` calls `e.preventDefault()` and submits. Submit posts `{ kind: 'text', text: input.value }` and is disabled while `input.value.trim().length === 0` (or `locked`).

   D) `card.kind === 'confirm'` or `'permission'`: a `<div class="intervention-actions">` with `<button type="button">Approve</button>` → `answerIntervention(card.id, { kind: 'approved' })` and `<button type="button" class="secondary">Decline</button>` → `answerIntervention(card.id, { kind: 'declined' })`. Approve comes first so it is the natural first tab stop.

   Unknown/absent `card.kind` (forward compatibility): render no controls rather than throwing.

   Files: `media/chat.js`

5. Render the settled state (decision, auto badge, rationale)

   Still in `renderInterventionCard`: when `card.status === 'resolved'`, append `<div class="intervention-settled">` containing
   - `<span class="intervention-decision">` with `textContent = decisionSummary(card)`;
   - when `card.auto === true`, `<span class="intervention-auto">Auto</span>` with `title = 'Decided by Auto mode'`;
   - when `card.rationale` is a non-empty string, `<div class="intervention-rationale">` with that text.

   Add the pure helper next to it:

     function decisionSummary(card) {
       const answer = card.answer || {};
       if (answer.kind === 'option') {
         const options = card.options || [];
         for (let i = 0; i < options.length; i++) {
           if (options[i].id === answer.optionId) { return 'Answered: ' + options[i].label; }
         }
         return 'Answered: ' + (answer.label || answer.optionId);
       }
       if (answer.kind === 'text') { return 'Answered: ' + answer.text; }
       if (answer.kind === 'approved') { return 'Approved'; }
       if (answer.kind === 'declined') {
         return answer.reason ? 'Declined \u2014 ' + answer.reason : 'Declined';
       }
       return 'Answered';
     }

   A resolved card renders no inputs and no buttons at all, so a settled ask can never be re-answered from the view, and it still shows its prompt, detail and (for a permission ask) its collapsed arguments, which is what makes it a durable inline record of the decision.

   Files: `media/chat.js`

6. Wire cards into renderTranscript, preserving focus and caret

   In `renderTranscript` in media/chat.js:

   1. Before `transcriptEl.textContent = ''`, capture the focused card control so the rebuild does not drop the caret:

        const active = document.activeElement;
        const focusCard = active && active.dataset ? active.dataset.interventionId : undefined;
        const focusField = active && active.dataset ? active.dataset.interventionField : undefined;
        const caret = active && typeof active.selectionStart === 'number' ? active.selectionStart : null;

   2. In the record loop, add a branch BEFORE the existing `record.tool` branch so a card always breaks a tool group:

        if (record.intervention) {
          group = null;
          transcriptEl.appendChild(renderInterventionCard(record));
        } else if (record.tool) { ...existing... } else { ...existing renderMessage... }

      (Records carrying `intervention` have role `system` and no `tool`, so `renderMessage` must no longer be reached for them.)

   3. After the loop and `renderedRecordCount = state.records.length;`, restore focus by scanning rather than by building a selector (ask ids are host-generated and must not be interpolated into a CSS selector):

        if (focusCard && focusField) {
          const controls = transcriptEl.querySelectorAll('[data-intervention-field]');
          for (let i = 0; i < controls.length; i++) {
            const el = controls[i];
            if (el.dataset.interventionId === focusCard && el.dataset.interventionField === focusField && !el.disabled) {
              el.focus();
              if (caret !== null && typeof el.setSelectionRange === 'function') { el.setSelectionRange(caret, caret); }
              break;
            }
          }
        }

      Do this before the `if (stick) { transcriptEl.scrollTop = ... }` line so focusing cannot fight the scroll decision.

   Leave `renderStreamingTail` untouched: it only rewrites a trailing streaming assistant body, and a card record is never streaming.

   Files: `media/chat.js`

7. Scroll a newly posted card into view

   In the `window.addEventListener('message', ...)` handler in media/chat.js, next to the existing `renderConversation` special case, add:

        if (msg.type === 'showIntervention') { forceScrollToBottom = true; }

   so a pending ask is always visible even if the user had scrolled up in the transcript. Do not touch the `state = protocol.reduce(state, msg);` line or the `streamDelta` fast path: `showIntervention` and `resolveIntervention` are already folded by the shared reducer (media/protocol.js, mirrored and parity-tested), and this todo adds no reducer logic to the webview script.

   Files: `media/chat.js`

8. Verify

   Run `npm run compile`, `npm run lint` and `npm test`. All three must stay green; the suite baseline after T04 is 912 passing / 1 pending / 0 failing and this todo must not change those numbers (media/*.js is outside both tsconfig `include` and the `eslint src test --ext .ts` scope, so the commands are a no-regression check, not a check of the new code).

   Because the repo has no DOM harness for media/chat.js, verify the new behaviour by hand in the Extension Development Host once the host side can post the messages, or by temporarily driving the webview from the developer tools console with `window.postMessage({type:'showIntervention', intervention:{...}}, '*')` for each of: an option-only question, a question with options plus free text, a free-text-only question, a confirm, and a permission ask carrying agent/tool/args; then `resolveIntervention` for each id and confirm the settled card shows the decision, the rationale and (with `auto:true`) the Auto badge. Do not leave any such scratch code in the file. Also confirm with a quick read-back that media/chat.js contains exactly one `answerIntervention` postMessage site and that neither media/chat.html nor media/chat.js gained an inline event handler, an external URL, or a hardcoded colour.

   Files: `media/chat.js`, `media/chat.html`

## Risks

- Scope boundary: the Auto-mode toggle left of Stop belongs to the Auto-mode todo, not this one. This todo must not add the toggle, the `setAutoMode` postMessage, or any use of `state.autoMode` in the composer — its files are media/chat.js and media/chat.html only, and the composer's control row must be left exactly as it is.
- Card controls must stay enabled while `state.busy` is true. An ask almost always arrives mid-run, so wiring the buttons/inputs into `updateEnablement`'s busy logic (as send/input/new-chat are) would make every card unanswerable and deadlock the run.
- The whole transcript DOM is rebuilt on every render, and renders are triggered by unrelated host messages (stream deltas, tool updates). Without the `interventionDrafts` map and the focus/caret restore, a user typing a free-text answer loses their text and their caret mid-typing.
- Double answering: without the `answeredInterventions` lock a fast second click posts a second `answerIntervention` for the same id. The host registry treats the second as unknown, but the lock keeps the view honest and stops the card looking live after it was answered.
- Untrusted content: a permission ask's prompt, detail, agent, tool and args come from a sub-agent harness. Only the prompt may go through `renderMarkdown` (which sanitizes); everything else must be assigned with `textContent`, or the card becomes an injection surface inside the CSP-protected view.
- No automated coverage: chat.js has no test harness in this repo (no jsdom; only media/config.js and media/protocol.js have vm-loaded mirror tests, and those export pure functions). Regressions in card rendering will not be caught by `npm test`, so keep the rendering helpers small and the decision logic (`decisionSummary`, `kindLabel`) free of DOM state.
- `record.content` and `card.prompt` can diverge for a persisted card (the transcript projection copies the prompt into content, but a later card state is authoritative). Render `card.prompt || record.content` so the card always shows the ask's own text.
- Forward compatibility: a record with an unrecognised `card.kind` or a `resolved` status with no `answer` must degrade (no controls, generic 'Answered' line) rather than throw — an exception inside `renderTranscript` would blank the entire conversation view.

## Acceptance

- A `RenderRecord` carrying `intervention` renders in media/chat.js as a single `.intervention` card element, not as a plain system message, and a card never joins or continues a `.tool-group`.
- A pending `question` card with options and no free text renders one clickable button per option; clicking posts `{ type: 'answerIntervention', id, answer: { kind: 'option', optionId, label } }`.
- A pending `question` card with `allowFreeText: true` renders radios for the options plus a text input and a submit button; non-whitespace text wins over a selected radio, a selected radio is posted otherwise, and submit is disabled when neither is present.
- A pending `question` card with no options renders a text input honouring `card.placeholder` plus a submit button; Enter (without Shift) submits and posts `{ kind: 'text', text }`.
- A pending `confirm` or `permission` card renders Approve and Decline, posting `{ kind: 'approved' }` and `{ kind: 'declined' }` respectively; a permission card also shows its `agent`/`tool` in the header and its `args` in a collapsed `<details>`.
- A card with `status: 'resolved'` renders no inputs or buttons and shows the decision line derived from `answer` (option label, typed text, Approved, or Declined with any reason), the `rationale` line when present, and an Auto badge when `auto === true`; `detail` remains visible in the settled state.
- Card controls are enabled while `state.busy` is true, and are disabled only once the card has been answered locally or the host has resolved it.
- Typed free-text and a selected radio survive an unrelated re-render (e.g. a `streamDelta` or `updateTool` message arriving while the card is open), and keyboard focus plus caret position are restored to the same control after the rebuild.
- Answering one card twice in quick succession posts `answerIntervention` exactly once for that id.
- `showIntervention` scrolls the transcript to the bottom so the new card is visible even if the user had scrolled up.
- All card text other than the prompt is inserted with `textContent`; the prompt goes through `renderMarkdown` (vendored renderer + owned sanitizer), so raw HTML in any field renders as literal text.
- media/chat.html gains only CSS for the new card classes, using VS Code theme variables exclusively, with the CSP meta tag, the script tags and the composer markup unchanged.
- `npm run compile`, `npm run lint` and `npm test` all pass with the suite unchanged at 912 passing / 1 pending / 0 failing.
