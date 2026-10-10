# Plan T11

## Steps

1. Confirm current README state (most of the Usage docs already landed with T04–T10)

   README.md already has: (a) the Usage bullet in '## The Baiton views' (around lines 56-66) describing the collapsed webview, fixed order Claude Code/Codex/Antigravity/OpenCode Go, bars only for source percentages, provenance labels, ok/stale/unavailable with reason, never-before-expand, re-read on visible + every baiton.usage.refreshIntervalSeconds while visible, 15 s overrun -> stale/unavailable, Restricted Mode, nothing written, and a link to #usage-view-per-tool-probe-findings; (b) '### Usage view (per-tool probe findings)' (around line 1056) with codex, antigravity (agy) and opencode (OpenCode Go) findings bullets; (c) 'Baiton: Refresh Usage' (baiton.usage.refresh) in '## Commands'; (d) baiton.usage.refreshIntervalSeconds (default 300, clamped 30–86400) in '## Settings'. These match the code (src/usage/usageService.ts DEFAULT_USAGE_READ_TIMEOUT_MS=15_000, DEFAULT_USAGE_REFRESH_INTERVAL_SECONDS=300, MIN 30, MAX 86_400; src/activation/usageViewController.ts setVisible() stops polling when hidden; src/activation/usageView.ts refresh command focuses baiton.usageView.focus when never expanded). Do NOT rewrite these; only the defects below need fixing. Re-read them once to be sure nothing else is inconsistent.

   Files: `README.md`

2. Move the misplaced Claude Code usage findings into the Usage view section

   Defect: the bullet beginning `- **claude findings** (probed `claude --version` → 2.1.295 (Claude Code), 2026-10-08):` (around README line 962, with its 7 sub-bullets: Established route `claude -p /usage --output-format json`, Returned, Probed unusable, Probed fallback only (api.anthropic.com/api/oauth/usage), Fallback handling, Restricted Mode, Unverified) sits INSIDE '### Harness ask relay (per-adapter probe findings)', between the opencode ask-relay findings and the codex ask-relay findings (the bullet starting `- **codex findings** (probed `codex --version` → `codex-cli 0.154.0`...`). It is about usage, not the ask relay. Cut that whole bullet (header line + all its sub-bullets, stopping before the `- **codex findings** (probed ... 0.154.0` line) out of the ask-relay section, leaving the ask-relay section's opencode bullet immediately followed by its codex bullet, unchanged otherwise. Paste it into '### Usage view (per-tool probe findings)' as the FIRST bullet, directly after the intro paragraph and before `- **codex findings** (probed `codex --version` → 0.157.0, 2026-10-08):`, so the per-tool order matches the view: Claude Code, Codex, Antigravity, OpenCode Go. Rename its header to `- **claude (Claude Code) findings** (probed `claude --version` → 2.1.295 (Claude Code), 2026-10-08):` to parallel `antigravity (agy)` / `opencode (OpenCode Go)` and to distinguish it from the ask-relay `claude findings` bullet at line ~948 (which must stay where it is, untouched).

   Files: `README.md`

3. Align the moved Claude bullet with the code

   In the moved bullet make these factual tweaks so the docs match src/usage/claude.ts: (1) 'Established route (primary): ...' — append the mechanism like the other tools, e.g. '(mechanism `cli-command`)'; the existing note 'Baiton runs it from a neutral directory with no shell' is correct (usageViewSeams.ts USAGE_NEUTRAL_CWD = os.tmpdir(), shell:false) — keep it. (2) 'Probed, fallback only:' — note mechanism `provider-endpoint`, trusted workspaces only. (3) 'Fallback handling:' — the tier sentence should read that the plan tier shown is `subscriptionType`, or `rateLimitTier` when that is missing (extractClaudeCredential uses str(subscriptionType) ?? str(rateLimitTier)); and mention API-key logins (`primaryApiKey`/`apiKey` only) report unavailable with 'API-key accounts have no plan usage windows'. (4) Mention that `extra_usage` is shown as an 'Extra usage' window only when `is_enabled` is true, with raw used/limit credits (parseClaudeOauthUsage). Keep the existing Restricted Mode text (it matches the code's reason string exactly) and the Unverified list. Use the same terse, single-line-per-sub-bullet style as the codex/antigravity/opencode usage bullets.

   Files: `README.md`

4. Tighten the section intro

   Extend the intro paragraph of '### Usage view (per-tool probe findings)' by one sentence stating the shared rules the per-tool bullets rely on, consistent with src/usage/usageService.ts: rows appear in the fixed order Claude Code, Codex, Antigravity, OpenCode Go; each tool's read is coalesced and timeboxed (15 s); a failed read keeps the last good reading as stale with its age and the failure reason, or reports unavailable with a reason when there was none; a stored credential is a fallback only, read only in a trusted workspace, for one request, never logged, stored, put in a reading or sent to the webview. Keep it short; don't duplicate the views bullet verbatim.

   Files: `README.md`

5. Verify

   Run `grep -n 'findings\*\*' README.md` and confirm: the ask-relay section contains claude (2.1.278), opencode (1.18.30, 2026-09-20), codex (0.154.0/0.155.1) … bullets with no usage bullet among them; the Usage section contains, in order, claude (Claude Code) 2.1.295, codex 0.157.0, antigravity (agy) 1.3.2, opencode (OpenCode Go) 1.18.30. Confirm the anchor link `#usage-view-per-tool-probe-findings` in the views bullet still matches the heading text (heading unchanged). Run `npm run compile`, `npm run lint`, `npm test` to confirm nothing regressed (README is not read by tests; no source change is expected). No file other than README.md is modified.

   Files: `README.md`

## Risks

- Cutting the wrong span: the misplaced Claude usage bullet is adjacent to multi-paragraph ask-relay bullets for opencode and codex; the cut must start at the `- **claude findings** (probed `claude --version` → 2.1.295` line and end just before `- **codex findings** (probed `codex --version` → `codex-cli 0.154.0``. The other `claude findings` bullet (2.1.278, ask relay) must not be moved.
- README lines are very long single lines; edit with exact-string replacements rather than line-number-based sed to avoid truncating content.
- Over-editing: the views bullet, Commands and Settings entries are already accurate; rewriting them risks introducing claims that diverge from the code (e.g. timer semantics: polling stops when hidden, not only on dispose).
- Do not claim verification the probes did not perform; keep every 'Unverified' item as is.

## Acceptance

- README.md '### Harness ask relay (per-adapter probe findings)' no longer contains the Claude Code usage (/usage, oauth/usage) findings, and its remaining bullets are byte-identical to before.
- README.md '### Usage view (per-tool probe findings)' lists per-tool findings in the order Claude Code, Codex, Antigravity, OpenCode Go, each giving the established mechanism, what it returned, mechanisms probed and found unusable, fallback/Restricted Mode handling and unverified items.
- The Claude bullet states the tier comes from subscriptionType or rateLimitTier, and that the stored login is used only in a trusted workspace for one request and never logged/stored/sent to the webview.
- The views bullet, the baiton.usage.refresh command entry and the baiton.usage.refreshIntervalSeconds setting entry remain present and consistent with the code (15 s timeout, default 300 s, clamp 30–86400).
- Only README.md changed; `npm run compile`, `npm run lint` and `npm test` pass.
