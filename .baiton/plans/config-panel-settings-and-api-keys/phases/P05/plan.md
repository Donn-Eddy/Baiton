# Plan P05

## Steps

1. Add the local config and atomic temp-file patterns to GITIGNORE_CONTENTS

   In src/config/gitignore.ts, insert two lines into the GITIGNORE_CONTENTS array right after '/.lock' and before '/chat.jsonl':
     '/config.local.json',
     '/.config*json.*.tmp',
   so the array begins: '# Baiton-owned files that must never be committed.', '/.lock', '/config.local.json', '/.config*json.*.tmp', '/chat.jsonl', ... (the rest unchanged, trailing '' kept so the text still ends with exactly one newline). The temp pattern must match the name writeJsonAtomic builds in src/config/loadConfig.ts:510 (`.config.json.<pid>.<ms>.tmp`): `.config*json` matches `.config.json` and `.*.tmp` matches `.<pid>.<ms>.tmp`. It would also cover a future `.config.local.json.*.tmp`. Do NOT change writeJsonAtomic. Update the module doc comment's bullet list with two entries: `config.local.json` (the personal, gitignored config overlay the Config Panel and Initialize write; the committed `config.json` baseline stays tracked) and `.config*json.*.tmp` (the sibling temp files writeJsonAtomic renames over the config, ignored so an interrupted write never shows up in git status). Add both to the list of anchored patterns in the 'anchored with a leading /' sentence. refreshGitignore itself needs no change: it already rewrites any file whose text differs from GITIGNORE_CONTENTS.

   Files: `src/config/gitignore.ts`

2. Initialize seeds config.local.json and never creates config.json

   In src/config/initialize.ts:
   - Import `configFilePath, localConfigFilePath` from './loadConfig'. Replace `const configPath = path.join(baitonDir, 'config.json')` with `const baselinePath = configFilePath(baitonDir); const localPath = localConfigFilePath(baitonDir);`.
   - Step 3 becomes: `const localPreexisted = await pathExists(localPath); const baselinePreexisted = await pathExists(baselinePath); const seedLocal = !localPreexisted && !baselinePreexisted; if (seedLocal) { await fs.writeFile(localPath, defaultConfigJson(), 'utf8'); created.files.push(localPath); } return ok({ createdConfig: seedLocal, ensuredGitignore: true });`. Rationale: the local file holds the full effective document and wins every key, so seeding defaults locally while a committed baseline exists would silently shadow the team baseline; when a baseline exists Initialize leaves both files alone (createdConfig false). An existing config.local.json is never overwritten. config.json is never written, opened for write, or removed by any path (it is never pushed into `created`, so rollback can't remove it).
   - Keep the step order (directories, then .gitignore, then the config seed) so the existing rollback tests still fail at the .gitignore write before any config is seeded.
   - Update the docs: the module header (the layout is now `config.local.json` seeded when no config exists, `.gitignore`, `runs/`, `plans/`; a pre-existing `config.json` is a read-only team baseline that Initialize never touches); the InitOutcome.createdConfig doc ('true when a new `config.local.json` was seeded from the defaults; false when a `config.local.json` or a committed `config.json` baseline already existed, in which case both are left byte-for-byte untouched'); the InitError and initialize() doc comments and the inline comments in steps 2/3 and the catch block, replacing 'config.json' with the local/baseline wording.

   Files: `src/config/initialize.ts`

3. Fix the Initialize success message (one-line user-facing text)

   src/activation/commands.ts:1363-1365 (registerInitializeCommand's handler) still says 'created .baiton/ with a default config.json' / 'existing config.json left unchanged', which would now be false. Change it to: createdConfig ? 'created .baiton/ with a default config.local.json' : 'ensured .baiton/ layout (existing configuration left unchanged)'. No test asserts this string (grep confirms). This file is outside the phase's listed files but the change is limited to these two string literals. Do not touch anything else in commands.ts.

   Files: `src/activation/commands.ts`

4. Refresh .gitignore before the config-load gate and name the local file in activation text

   In src/extension.ts completeActivation():
   - Move the existing `if (!workspace.restricted) { for (const repo of reposWithBaiton(repos)) { try { await refreshGitignore(repo.baitonDir!); } catch (e) { surface.warn(...) } } }` block (currently after runCrashRecovery, ~lines 386-400) up to right after `const workspace = workspaceRepos.primary;` and before `// 4. Config load`. Reason: when loadConfig fails (absent/unparseable/invalid) activation returns early and the refresh never ran, yet the Config Panel (registered before the gate) can still Reset/Save into config.local.json; refreshing first ensures an older workspace ignores config.local.json before anything writes it. Keep it skipped under Restricted Mode and keep the same warn text. Update its comment to mention config.local.json and why it runs before the gate. Do not otherwise reorder activation steps.
   - Line ~357 child-repo warning: change `${repo.name}/.baiton/config.json` to `${repo.name}/.baiton configuration` (e.g. `Baiton could not load the ${repo.name}/.baiton configuration: ${message}`) since ConfigError messages already name the exact file that failed.
   - Doc comments: line ~72 ('Config load — validate `.baiton/config.json`') → 'validate the effective configuration (`.baiton/config.json` baseline merged with the gitignored `.baiton/config.local.json`)'; line ~99 ActivationState.config doc likewise; line ~205 comment ('repairs an absent or unparseable `.baiton/config.json`') → name `.baiton/config.local.json`.
   - Do not wire openSettings/manageApiKeys here; that belongs to a later phase.

   Files: `src/extension.ts`

5. Gitignore tests

   In test/config.gitignore.test.ts, in describe('GITIGNORE_CONTENTS') add:
   - 'ignores the personal config overlay, anchored at the .baiton root': exactly one line === '/config.local.json'; and no pattern equals 'config.json' or '/config.json' (the baseline stays trackable).
   - 'ignores the atomic config temp files': exactly one line === '/.config*json.*.tmp'.
   - 'lists the config patterns after /.lock and before /chat.jsonl': indexOf('/config.local.json') === indexOf('/.lock') + 1 and indexOf('/.config*json.*.tmp') === indexOf('/config.local.json') + 1 and both < indexOf('/chat.jsonl').
   - Optional glob sanity check without new deps: convert the temp pattern to a RegExp in-test (escape '.', '*' → '[^/]*', strip leading '/') and assert it matches `.config.json.${process.pid}.${Date.now()}.tmp` and `.config.local.json.1.2.tmp` but not `config.json` or `config.local.json`.
   In describe('refreshGitignore') add 'rewrites a .gitignore from a build without the config.local.json patterns': derive stale text by filtering out '/config.local.json' and '/.config*json.*.tmp' from GITIGNORE_CONTENTS (as the /worktrees/ test does), assert it differs, write it, expect 'rewritten' and canonical contents. Update the file's header comment to mention the new patterns. Existing duplicate/trailing-newline tests must still pass.

   Files: `test/config.gitignore.test.ts`

6. Initialize tests

   In test/config.test.ts (import `localConfigFilePath` from '../src/config/loadConfig' or use path.join(baitonDir, 'config.local.json')):
   - Rename/replace 'writes a default config.json on a fresh directory' with 'seeds config.local.json from the defaults on a fresh directory and creates no config.json': createdConfig true, ensuredGitignore true, config.local.json text === defaultConfigJson(), fs.existsSync(config.json) === false, .gitignore === GITIGNORE_CONTENTS, and `await loadConfig(baitonDir)` isOk (local-only loads).
   - Keep 'leaves an existing config.json untouched but still ensures .gitignore' and additionally assert createdConfig false AND config.local.json does not exist (baseline is not shadowed).
   - New 'leaves an existing config.local.json untouched': write a custom config.local.json (e.g. configJson({...configDoc(SUPPORTED_VERSION), custom: 'mine'})), run initialize, assert createdConfig false, local text byte-identical, no config.json created, .gitignore ensured.
   - New 'is idempotent': initialize twice on a fresh dir; second call createdConfig false and local text still defaultConfigJson().
   - Rollback 'rolls back its own creations and preserves a pre-existing config.json': additionally assert config.local.json does not exist. Add a variant with a pre-existing config.local.json (no config.json) and the .gitignore-directory trick: error kind 'write-failed', local text unchanged, no config.json.
   - Fresh-tree read-only rollback test: also assert config.local.json does not exist.
   - Update the header coverage comment for the new Initialize behaviour.

   Files: `test/config.test.ts`

7. Verify

   Run: `npm run compile`; `npx mocha --no-config --require ts-node/register --node-option no-strip-types --reporter spec test/config.test.ts test/config.gitignore.test.ts test/config.overlay.test.ts`; `npx mocha --no-config --require ts-node/register --node-option no-strip-types --reporter dot test/configPanel.*.test.ts test/activation*.test.ts`; `npx eslint src/config/gitignore.ts src/config/initialize.ts src/extension.ts src/activation/commands.ts test/config.gitignore.test.ts test/config.test.ts`; `npm test` (tests spawning git may hit EPERM in a sandbox; rerun with escalation if so); `git diff --check`. Finally grep src/ for writes to config.json: `configFilePath(` must only feed reads (loadConfig/configDocument read paths), never writeJsonAtomic/fs.writeFile.

   Files: (none)

## Risks

- Seeding policy choice: Initialize seeds config.local.json only when neither config.local.json nor config.json exists. Seeding when only a baseline exists would make the full-document local file shadow the whole team baseline; the existing 'existing config.json' test (createdConfig false) stays valid under this rule.
- The temp-file pattern '/.config*json.*.tmp' relies on gitignore '*' not crossing '/'; it is root-anchored and writeJsonAtomic always writes temps next to the target in .baiton/, so it matches. Do not rename writeJsonAtomic's temp file.
- Moving refreshGitignore ahead of the config-load gate means it now also runs for workspaces whose config fails to load; it still never creates .baiton/ (refreshGitignore rejects on a missing dir and the warn path handles it) and is still skipped under Restricted Mode. Check no activation test asserts the old ordering.
- src/activation/commands.ts is outside the phase's listed files; the edit is two string literals only. If the executor is strictly limited to the listed files, skip it and leave a note — the message would then be inaccurate until a later phase.
- Other phases (configDocument/controller/panel) may still write config.json until they land; this phase must not touch them.

## Acceptance

- GITIGNORE_CONTENTS contains exactly one '/config.local.json' and one '/.config*json.*.tmp' line, placed right after '/.lock', no pattern ignoring config.json, no duplicates, single trailing newline.
- refreshGitignore rewrites a .gitignore lacking the new patterns to the canonical text.
- initialize on a fresh directory writes .baiton/config.local.json === defaultConfigJson(), returns createdConfig true, and creates no config.json; loadConfig then succeeds.
- initialize with an existing config.local.json or an existing config.json leaves both byte-for-byte unchanged, returns createdConfig false, and does not create the other file.
- initialize rollback on a write failure removes only its own creations, never creates config.json or config.local.json, and preserves any pre-existing config file.
- completeActivation refreshes .baiton/.gitignore (outside Restricted Mode) before the config-load gate; activation messages/comments no longer claim the extension writes .baiton/config.json.
- npm run compile, eslint on changed files, the config/configPanel/activation test suites and npm test all pass; git diff --check is clean.
