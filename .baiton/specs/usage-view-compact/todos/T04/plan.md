# Plan T04

## Steps

1. Rewrite the README Usage view bullet (README.md:55-65)

   Replace the sentence spanning README.md:56-60 ('Each row shows its windows (a bar only when the source gives a percentage), the reset time, the scope/tier, a source line with provenance (provider-reported or Baiton-derived, labelled) and the read time, and a status of ok, stale or unavailable with a reason.') with text equivalent to: 'Each tool card shows a status badge (ok, stale or unavailable) and, for each window, one compact row: the label with its figure beside it on the left and the reset time on the right (the reset wraps onto its own line when the view is narrow), with the scope/tier and a bar (only when the source gives a percentage) below. The source, its provenance (provider-reported or Baiton-derived) and the read time are the status badge's hover/focus hint; a Baiton-derived figure stays marked in the card itself (a Baiton-derived badge and a suffix on the window label). Stale and unavailable cards still show their reason.' Keep the rest of the bullet (lazy probing, refresh/polling, 15 s timebox, Restricted Mode, 'Nothing is written.', and the link to #usage-view-per-tool-probe-findings) unchanged. Keep the existing ~80-column wrap style with two-space continuation indent.

   Files: `README.md`

2. Extend the 'Usage view (per-tool probe findings)' intro paragraph (README.md:1050)

   This paragraph is a single long line. Leave the existing content intact (mechanism, no invented figures, fixed order, coalescing/15 s timebox, stale/unavailable behavior, credential handling) and append one or two sentences at the end of the same line, e.g.: ' Each window is drawn as one row — label and figure on the left, reset on the right (wrapping below when narrow) — with the scope and bar beneath it; the per-card source line (mechanism, detail, provenance and read time, or "Tried: <mechanism>" when unavailable) is the status badge's hover and keyboard-focus hint rather than a line in the card, while the Baiton-derived marker stays visible in the card.' Do not touch the heading text (the anchor #usage-view-per-tool-probe-findings is linked from line 65) or the per-tool findings bullets that follow.

   Files: `README.md`

3. Sanity-check the wording against the shipped code

   Read-only cross-check: media/usage.js windowRow (~line 130), cardView badgeHint (~lines 158-189: ok/stale = source line, unavailable = 'Tried: <mechanism>', loading = ''), buildCard badge title/aria-label/tabindex (~lines 244-247) and row/scope/bar construction (~lines 261-281); media/usage.html .window-row (~line 168), .badge[tabindex] cursor:help and .badge:focus-visible (~lines 139-148). Make sure the README does not claim anything those do not do (e.g. no hint on the loading badge). Grep README.md for any remaining 'source line' phrasing describing the Usage card body and adjust only if it refers to the Usage view.

   Files: `README.md`

4. Run the finish-line checks

   Run `npm run compile`, `npm run lint`, and `npm test`. Earlier todos saw `npm test` fail in the sandbox with EPERM on child-process spawn; if that happens, rerun with elevated permissions. Expected: compile passes; lint passes (one pre-existing warning in src/orchestrator/webviewProtocol.ts:678 is acceptable); tests pass (~2819 passing, 1 pending). If any README-checking test exists (grep test/ for 'README'), make sure it still passes.

   Files: (none)

## Risks

- The intro at README.md:1050 is one very long line; an Edit must match it exactly — prefer appending by matching a unique tail fragment such as 'never logged, stored, put in a reading or sent to the webview.'
- Do not rename the '### Usage view (per-tool probe findings)' heading; the bullet at line 65 links to its anchor.
- Wording must not imply Baiton-derived provenance is hover-only; the spec requires it to stay visible in the card body.
- Sandboxed `npm test` may hit EPERM spawning child processes; this is environmental, not a regression — rerun elevated.
- Only README.md should change in this todo; do not touch media/, test/, or src/.

## Acceptance

- README.md Usage bullet (around lines 55-65) describes each window as one row with label and figure on the left and reset on the right (wrapping when narrow), with scope and bar below, and says the source/provenance/read-time line is the status badge's hover/focus hint while the Baiton-derived marker stays visible.
- The intro paragraph under '### Usage view (per-tool probe findings)' says the same (row layout; source line moved to the badge hover/keyboard-focus hint; Baiton-derived marker stays visible), with all prior content preserved.
- The heading and its anchor link from the Usage bullet are unchanged.
- git diff shows changes only in README.md.
- `npm run compile` passes.
- `npm run lint` passes (pre-existing warning only).
- `npm test` passes.
