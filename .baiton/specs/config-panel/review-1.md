# review result

```json
{
  "verdict": "findings",
  "findings": [
    {
      "severity": "must",
      "file": "media/config.js",
      "line": 379,
      "text": "In the `saveFailed` host-message handler (case 'saveFailed', reason === 'invalid', around line 593-595) `state.errors` is set from the host-authoritative `msg.errors`, but the very next `render()` call invokes `renderErrors()`, which unconditionally recomputes `state.errors = validateConfigForm(state.form, { agents: state.options.agents })` (line 379) and overwrites it before anything is painted. Because the form that triggered a host-side 'invalid' rejection is by definition one the client-side mirror considered valid (client validation gates Save), the recompute typically yields `[]`, silently discarding the host's field-level errors and message association, re-enabling Save (via `updateEnablement`'s `hasErrors` check), and leaving the user with only the generic banner text and no indication of which field is wrong. This violates the plan's explicit acceptance criterion that `saveFailed` with reason 'invalid' renders `msg.errors` as the field errors because 'host-side re-validation is authoritative'. Fix by having `renderErrors()` skip its own recompute (or merge server errors) when `state.phase === 'ready'` and the errors originated from a `saveFailed` response, or by not calling `renderErrors()`'s recompute after that message (e.g. render the server errors directly without re-invoking `validateConfigForm`)."
    },
    {
      "severity": "should",
      "file": "media/config.js",
      "line": 172,
      "text": "`readForm()` (defined at line 172) is never called anywhere in the file — all field updates go through the `input`/`change` listeners calling `setField()` directly into `state.form`. This is dead code left over from an earlier design; since media/ is outside eslint's globs nothing will flag it, but it should be removed (or, if it's meant as a defensive re-sync path, actually wired in) to avoid confusing future readers about how form state is populated."
    }
  ],
  "tests": {
    "ran": true,
    "passed": true,
    "output_tail": "583 passing (21s)\n1 pending\n\nAdditional checks performed: `node --check media/config.js` passes; loading media/config.js with a bare `global.window = {}` (no acquireVsCodeApi) exposes `window.baitonConfigForm` with ROLES/EFFORT_OPTIONS/LIMIT_BOUNDS/validateConfigForm and touches no DOM. A throwaway ts-node parity script (22 cases: default form, all-agents-blank, unknown agent, missing model, blank effort, each limit field at min-1/min/max/max+1 and non-integer, empty git.remote/git.base) confirmed media/config.js's validateConfigForm output is byte-identical, in the same order, to src/config/configPanel.ts's compiled validator, and that ROLES, EFFORT_OPTIONS and LIMIT_BOUNDS (including key order) match src/model/role.ts and src/config/types.ts exactly. `npm run lint` and `npm run compile` pass cleanly. `git status --porcelain` is clean (media/config.html and media/config.js are already committed; no stray files)."
  }
}
```
