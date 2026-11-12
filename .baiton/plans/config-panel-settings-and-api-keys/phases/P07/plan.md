# Plan P07

## Steps

1. Rewrite the config panel's reset-path and external-change bullets for the local overlay

   In README.md, section `### The config panel` (around lines 774-833):
   - 'The reset path' bullet (~line 815): change 'works even when `.baiton/config.json` is absent or unparseable' to say it works when neither `.baiton/config.json` nor `.baiton/config.local.json` exists, or when either fails to parse (the error names the file that failed). Say **Reset to defaults** writes the default configuration to `.baiton/config.local.json` and never touches `.baiton/config.json`.
   - 'External changes and conflict handling' bullet (~line 821): the panel watches `.baiton/config.local.json` (the file it edits, which holds the conflict token) and also `.baiton/config.json`, so a hand edit to the committed baseline is noticed too. Keep the existing pristine-reload, conflict-banner and save-conflict wording.
   - 'Preservation of unmanaged keys' bullet: add that the panel saves the full effective (merged) document to `.baiton/config.local.json` and leaves `.baiton/config.json` byte-for-byte untouched. Keep the two-space indent and trailing-newline sentence.
   - 'Live configuration hot-reload' bullet: change 'writes the file' to 'writes `.baiton/config.local.json`'.

   Files: `README.md`

2. Add a 'Local config overlay' subsection

   Directly after the `### The config panel` bullet list and before `#### Agent Model & Effort Discovery`, add a `#### Local config overlay` subsection. Write it as short prose or bullets that cover:
   - **Two files.** `.baiton/config.local.json` is personal and gitignored; it is the only file the Config Panel and **Initialize** (`baiton.initialize`) write. `.baiton/config.json` is an optional committed team baseline that Baiton only reads. Nothing Baiton writes for configuration ever appears as a git change.
   - **Merge.** `loadConfig` reads the baseline if present and the local file if present, then deep-merges local over baseline: objects merge key by key, and arrays and scalars are replaced. The merged result is then validated. Baseline only, local only and both all load. Neither file present means 'not initialized' and points to Initialize.
   - **Initialize** seeds `config.local.json` from the defaults, never overwrites an existing local file, leaves any existing `config.json` alone, and creates no tracked `config.json`.
   - **Migration.** A version migration persists the migrated document to `config.local.json`, never to the baseline.
   - **Errors.** A parse error names the exact file that failed to parse. A validation error names `config.local.json`, the file the panel can fix.
   - **Shadowing trade-off.** The local file holds the full effective document, so after a local save the local file keeps its values even when the baseline is later updated by a commit. Delete `config.local.json` (or Reset and re-edit) to pick up the baseline again. Phrase this carefully: Reset writes defaults, not the baseline.
   - **Gitignore.** `.baiton/.gitignore` (`GITIGNORE_CONTENTS` in `src/config/gitignore.ts`) now has `/config.local.json` and `/.config*json.*.tmp` (the atomic-write temp files). `refreshGitignore` updates existing workspaces at activation, so they need no `git rm --cached` or manual step. A repo that already tracks `config.json` keeps it as a read-only baseline.
   - **API keys** are unchanged: they stay in SecretStorage and were already local. Link to **Per-provider API keys**.

   Files: `README.md`

3. Document the two new Configuration toolbar buttons

   Add a new bullet to the `### The config panel` list (after 'The reset path' or as a 'Toolbar' bullet at the top). Spell it as **Toolbar** — Save, Reload, Reset…, **More settings…** and **Manage API keys…**.
   - **More settings…** opens VS Code Settings filtered to `baiton.orchestrator` (`workbench.action.openSettings`), the same place the Chat view's inline-error 'open settings' fix goes.
   - **Manage API keys…** runs **Baiton: Set Provider API Key** (`baiton.setProviderApiKey`) with no provider argument. It shows the provider quick pick, where each row shows `API key set` / `No API key set`, then a masked input. Submitting empty clears the key. This one flow changes an existing key or adds a first key, and provider availability refreshes as usual.
   - Both buttons work in every panel state, including after a load failure and while a load or save is in flight. Neither touches the form, unsaved edits or Save's enablement.
   - No key value or set/not-set flag ever reaches the webview.
   - `baiton.setProviderApiKey` is registered only after activation succeeds. In an uninitialised folder or after a failed activation, **Manage API keys…** therefore logs the failure and does nothing, and the panel stays usable.

   In `#### Per-provider API keys` (~line 654), add one sentence that the command is also reachable from the Configuration view's **Manage API keys…** button.

   Files: `README.md`

4. Fix the remaining stray `config.json` mentions

   Check every other `config.json` mention in README.md and reword only where the claim is now wrong:
   - ~line 243: the `.baiton/.gitignore` sentence lists `/runs/` and `/worktrees/`. Extend it to also mention `/config.local.json` and the config temp files, or leave it alone if it reads as a run-scope sentence only. The text is 'everything a plan-less run owns', so adding a short separate clause is enough.
   - ~line 310 ('A `plan-writer` entry missing from an existing `.baiton/config.json`'), ~line 399 ('`.baiton/config.json` needs no new role'), ~line 613 (`roles.spec-writer` in `config.json`) and ~line 920 ('existing `.baiton/config.json` values'): these describe configuration in general. Reword each to 'the configuration' or '`.baiton/config.json` / `config.local.json`' so it does not imply the tracked file is the one that gets edited. Do not change the meaning of the rules.
   Run `grep -n 'config\.json' README.md` afterwards. Every remaining hit should either describe the read-only baseline or appear next to `config.local.json`.

   Files: `README.md`

## Risks

- When this plan was written, `media/config.html` had no `more-settings` / `manage-api-keys` buttons and `media/config.js` posted no `openSettings` / `manageApiKeys` messages. The controller seams and the `src/extension.ts` wiring do exist. The README describes the intended endstate, so it may be ahead of the shipped webview if no earlier phase added the buttons. The executor should check with `grep -n 'more-settings\|manage-api-keys' media/config.html media/config.js` and flag it in their notes if the buttons are still missing. This phase may change only README.md.
- Do not over-claim the Reset behaviour. Reset writes `defaultConfig()` to the local file, not the baseline's values. To get the baseline back, delete `config.local.json`.
- Keep the edits small. README.md is large and other sections (discovery, providers) must not be rewritten. Change only the config-file wording and add the new subsection and bullets.
- Do not document new commands or settings. None were added, and the Commands and Settings sections stay as they are.

## Acceptance

- README.md is the only file changed (`git diff --name-only` shows only README.md).
- `### The config panel` names `.baiton/config.local.json` as the file the panel saves to, resets to and watches for conflicts. It says `.baiton/config.json` is never written and is also watched for baseline edits.
- A `#### Local config overlay` subsection describes: local over baseline deep merge (objects merged per key, arrays and scalars replaced), the baseline-only / local-only / both / neither cases, Initialize seeding `config.local.json`, migration persisting to the local file, which file each error names, the shadowing trade-off, and the gitignore patterns `/config.local.json` and `/.config*json.*.tmp` applied by `refreshGitignore` at activation.
- The panel docs describe **More settings…** (opens Settings filtered to `baiton.orchestrator`) and **Manage API keys…** (runs `baiton.setProviderApiKey` with no argument; quick pick with set/not-set, masked input, empty submit clears). They say both work in every panel state, never affect the form, and that Manage API keys degrades to a logged no-op before activation.
- `#### Per-provider API keys` mentions the **Manage API keys…** button.
- `grep -n 'config\.json' README.md` shows no remaining sentence that implies Baiton writes or edits the tracked `.baiton/config.json`.
- `git diff --check` passes.
