# Execute T05

## Summary

T05: rendered inline intervention cards in the chat webview. Added all card CSS (theme-variable only) to media/chat.html, extended the transcript flex-child rule and the top-of-file comment. In media/chat.js: added answeredInterventions/interventionDrafts state with cardDraft(), the answerIntervention poster (single postMessage site, matches the WebviewToHost variant, guarded against double-answering), renderInterventionCard with kindLabel/decisionSummary helpers (pending option-button, radio+free-text, free-text-only, and confirm/permission branches, settled decision/auto-badge/rationale block; only the prompt passes through renderMarkdown, everything else uses textContent), wired cards into renderTranscript before the tool branch with focus/caret restore via data-attribute scanning, and force-scroll on showIntervention. npm run compile, lint, and test all pass at 912/1/0.

## Files changed

- `media/chat.html`
- `media/chat.js`

## Commands run

- `node --check media/chat.js`
- `npm run compile`
- `npm run lint`
- `npm test`

## Notes

- Suite unchanged: 912 passing / 1 pending / 0 failing.
- Read-back confirmed: exactly one answerIntervention postMessage site in chat.js; no inline event handlers, no external URLs, no hardcoded colours in either file.
- No DOM harness exists for chat.js, so behavioural verification relied on node --check plus read-back; the scratch-window-console checks from the plan were not run because no Extension Development Host session was available.
- Auto-mode toggle scope boundary respected: composer control row in chat.html untouched, no setAutoMode usage added to the webview composer.
