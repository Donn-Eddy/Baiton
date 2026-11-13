# Plan P04

## Steps

1. Rewrite the legacy alias paragraph in 'Per-provider API keys'

   In README.md, under '#### Per-provider API keys', replace the whole paragraph that starts '**Baiton: Set Orchestrator API Key** (`baiton.setOrchestratorApiKey`) stays registered as an alias…' (currently ~L670–676, ending '…the legacy secret is never deleted and is no longer read.'). Leave the preceding paragraph about **Baiton: Set Provider API Key** (L658–668) unchanged. The new paragraph must not contain any of these strings: `setOrchestratorApiKey`, `migrateLegacyApiKey`, `keyMigrated`, `LEGACY_API_KEY_SECRET`, `API_KEY_SECRET`. Suggested text: 'The old **Set Orchestrator API Key** alias command and the one-time migration of the pre-multi-provider single secret into the `openai` slot have been removed. Baiton no longer reads or writes that secret. If your only key was stored there, set it again with **Baiton: Set Provider API Key** (or the Configuration view\'s **Manage API keys…** button).' Do not write the literal command id `baiton.setOrchestratorApiKey`, so the grep stays empty. Naming the old secret `baiton.orchestrator.apiKey` is allowed (no forbidden token matches it), but leaving it out is simpler and is preferred.

   Files: `README.md`

2. Update the Toolbar bullet in 'The config panel'

   In README.md, in the '- **Toolbar** —' bullet (~L827–841), replace the sentence '**More settings…** opens VS Code Settings filtered to `baiton.orchestrator` (`workbench.action.openSettings`), the same destination as the Chat view\'s inline-error **open settings** fix.' with: '**More settings…** opens VS Code Settings filtered to every Baiton setting (`workbench.action.openSettings` with the `@baiton` query), not only the `baiton.orchestrator` group. The Chat view\'s inline-error **open settings** fix still targets `baiton.orchestrator`.' Keep the lead list 'Save, Reload, Reset…, **More settings…** and **Manage API keys…**'. Also keep the rest of the bullet as it is: the Manage API keys description, works-in-every-state, no key value crosses into the webview, and registered only after activation.

   Files: `README.md`

3. Describe the roles table in 'Managed fields'

   In README.md, in the '- **Managed fields** —' bullet (~L781–800), add one or two sentences right after the opening clause that lists the six roles. Keep all the existing model/effort dropdown detail. Suggested text: 'The roles appear as a single flat table with one row per role and **Agent**, **Model** and **Effort** columns. Each cell holds that field\'s dropdown, its `Other…` input, any documentation link or staleness note, and its inline error, directly under the column header. Limits and Git follow as plain headed sections, with no nested boxes.' Make sure the sentence still reads grammatically with the existing 'with an agent dropdown populated from installed adapters; …' clauses. Restructuring the start to 'edits the six role entries (…) in a roles table …; each row has an agent dropdown …' is fine. Do not change role names, bounds or validation statements.

   Files: `README.md`

4. Verify

   Run `grep -nE 'setOrchestratorApiKey|LEGACY_API_KEY_SECRET|migrateLegacyApiKey|keyMigrated|API_KEY_SECRET' README.md src test media package.json`. It must return nothing. Run `grep -n 'filtered to `baiton.orchestrator`' README.md`; it must return nothing. Run `git diff --check`. Only README.md may change, so no compile is needed. Optionally run `npm test` to confirm the suite is still green (a README-only change cannot affect it, unless a docs test greps the README; if one fails, fix the wording).

   Files: `README.md`

## Risks

- Some test may assert README content (for example a docs consistency test). Run `grep -rn README test/` before finishing. If a test references the old alias paragraph or the toolbar wording, the change must keep its asserted strings or (if it asserted legacy text) the test needs updating, which would extend the phase beyond README.md.
- Writing the literal `baiton.setOrchestratorApiKey` or `keyMigrated` in the explanatory paragraph would break the plan-wide empty-grep requirement. Describe the removed alias by its title only.
- Editing the Managed fields sentence could garble the long existing sentence about model/effort dropdowns. Keep the edit additive and re-read the bullet afterwards.

## Acceptance

- README.md 'Per-provider API keys' says the Set Orchestrator API Key alias and the legacy-secret migration were removed, and that a user whose only key was the old secret must set it again via Baiton: Set Provider API Key.
- README.md Toolbar bullet lists Save, Reload, Reset…, More settings… and Manage API keys…, and says More settings… opens all Baiton settings (`@baiton` filter) rather than only `baiton.orchestrator`.
- README.md Managed fields bullet describes the roles table: one row per role, Agent/Model/Effort columns, controls and inline errors in their cells, and Limits/Git as plain headed sections.
- `grep -nE 'setOrchestratorApiKey|LEGACY_API_KEY_SECRET|migrateLegacyApiKey|keyMigrated|API_KEY_SECRET' README.md src test media package.json` returns no matches.
- Only README.md is modified; `git diff --check` is clean and the test suite remains green.
