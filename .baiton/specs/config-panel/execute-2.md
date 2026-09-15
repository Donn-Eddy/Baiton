# execute result

```json
{
  "summary": "Fixed both findings from the config-panel-T04-review-1 review of media/config.js. (1) 'must' finding: renderErrors() unconditionally recomputed state.errors via the client-side validateConfigForm mirror on every render, which silently discarded the host's authoritative field errors delivered in a saveFailed (reason 'invalid') message right before they could be painted, since the form that triggered that rejection is by definition one the client mirror already considered valid. Fixed by adding a state.errorsFromServer flag: set true only when a saveFailed/'invalid' message arrives (state.errors = msg.errors), which makes renderErrors() render the existing state.errors as-is instead of recomputing; the flag is cleared (restoring live client-side validation) on the next field edit, on a fresh 'loaded', on a successful 'saved', and when doSave's own pre-flight validation produces client errors. (2) 'should' finding: removed the dead readForm() function, which was never called anywhere — all field updates already flow through the input/change listeners calling setField() directly into state.form.",
  "files_changed": [
    "media/config.js"
  ],
  "commands_run": [
    "node --check media/config.js",
    "node /tmp/.../scratchpad/guard-check2.js (ad hoc, confirms window.baitonConfigForm still loads with no document access)",
    "npx ts-node .scratch-parity-check.ts (ad hoc parity check against src/config/configPanel.ts, 22 cases, deleted after passing)",
    "npm run lint",
    "npm run compile",
    "npm test",
    "git status --porcelain"
  ],
  "notes": [
    "Verified by hand-tracing the message/state flow (no jsdom available in node_modules to run a live DOM simulation): loaded -> saveFailed(invalid) now leaves state.errors = msg.errors intact through render() because renderErrors() skips its recompute while errorsFromServer is true; the very next keystroke (input/change handler) clears the flag so client-side live validation resumes on every input as the plan requires.",
    "The 22-case ts-node parity script re-confirmed media/config.js's validateConfigForm, ROLES, EFFORT_OPTIONS and LIMIT_BOUNDS still match src/config/configPanel.ts, src/model/role.ts and src/config/types.ts exactly after these edits (the mirror block itself was untouched).",
    "npm run lint, npm run compile and npm test all pass; git status shows only media/config.js modified, no other files touched.",
    "Save stays disabled while a saveFailed/'invalid' banner and its field errors are showing (updateEnablement's hasErrors check still reads state.errors.length), which is the correct behavior until the user edits the offending field(s)."
  ]
}
```
