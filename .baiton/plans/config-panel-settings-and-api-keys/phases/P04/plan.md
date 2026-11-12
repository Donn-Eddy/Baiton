# Plan P04

## Steps

1. Add localConfigFilePath and an exported deep-merge helper

   In src/config/loadConfig.ts, directly below `configFilePath`, add:

   ```ts
   /** The single place that spells the `config.local.json` filename: the personal, gitignored overlay the extension writes. */
   export function localConfigFilePath(baitonDir: DirLike): string {
     return path.join(toDir(baitonDir), 'config.local.json');
   }
   ```
   Update the `configFilePath` doc comment to say it is the optional committed team baseline (read-only for the extension).

   Add an exported pure helper (later phases' `configDocument.ts` will reuse it, so export it):
   ```ts
   /**
    * Deep-merges the local overlay over the committed baseline: plain objects merge key by key (recursively),
    * arrays and scalars from `local` replace the baseline's value. Neither input is mutated; keys present on only one side are kept.
    */
   export function mergeConfigLayers(baseline: Record<string, unknown>, local: Record<string, unknown>): Record<string, unknown> {
     const out: Record<string, unknown> = { ...baseline };
     for (const [key, value] of Object.entries(local)) {
       const prev = out[key];
       out[key] = isObject(prev) && isObject(value) ? mergeConfigLayers(prev, value) : value;
     }
     return out;
   }
   ```
   (`isObject` already exists in the file and excludes arrays, which gives array replacement for free.) Guard against `__proto__`: build `out` with `Object.entries` + plain assignment is fine for JSON.parse output, but to be safe skip a key equal to `'__proto__'` or use `Object.defineProperty`; simplest is `if (key === '__proto__') continue;`.

   Files: `src/config/loadConfig.ts`

2. Factor per-file read+parse into a helper that names the failing file

   In src/config/loadConfig.ts add a private helper:

   ```ts
   /** Reads and parses one config layer. `undefined` value means the file does not exist. */
   async function readLayer(filePath: string): Promise<Result<Record<string, unknown> | undefined, ConfigError>>
   ```
   Behaviour, moved verbatim from today's loadConfig body but parameterised on `filePath`:
   - `fs.readFile(filePath,'utf8')`; ENOENT (`isNotFound`) → `ok(undefined)`.
   - other read error → `err({ kind: 'unparseable', path: filePath, message: `Could not read configuration at ${filePath}: ${describe(e)}.` })`.
   - `JSON.parse` failure → `err({ kind: 'unparseable', path: filePath, message: `Configuration at ${filePath} is not valid JSON: ${describe(e)}.` })`.
   - parsed value not `isObject` → `err({ kind: 'missing-section', section: 'root', message: `Configuration at ${filePath} must be a JSON object.` })`.
   - else `ok(parsed)`.
   Keep the message strings byte-identical apart from the path so existing assertions (e.g. 'must be a JSON object') keep matching.

   Files: `src/config/loadConfig.ts`

3. Rewrite loadConfig to read both layers, merge, then validate

   Replace the read/parse prologue of `loadConfig`:

   ```ts
   const baselinePath = configFilePath(baitonDir);
   const localPath = localConfigFilePath(baitonDir);
   const baseline = await readLayer(baselinePath);
   if (!baseline.ok) return baseline;
   const local = await readLayer(localPath);
   if (!local.ok) return local;
   if (baseline.value === undefined && local.value === undefined) {
     return err({
       kind: 'absent',
       path: localPath,
       message: `No configuration found at ${localPath} or ${baselinePath}. Run "Baiton: Initialize" first.`,
     });
   }
   const parsed = baseline.value === undefined ? local.value! : local.value === undefined ? baseline.value : mergeConfigLayers(baseline.value, local.value);
   ```
   (Read baseline first so a corrupt baseline is reported naming config.json and a corrupt local file names config.local.json; whichever is corrupt is named.)

   Everything after (readVersion, version-too-new, migration, readRoles/readLimits/readGit/readPr, building `Config`) operates unchanged on the merged `parsed`. In the `version-too-new` message use `localPath` when a local file exists, else `baselinePath` (a helper const `namedPath = local.value !== undefined ? localPath : baselinePath`). Validation (`missing-section`) messages carry no path, unchanged.

   Update the module doc comment and the `loadConfig` doc comment to describe: optional committed `config.json` baseline + optional gitignored `config.local.json` overlay, deep-merged with local winning (objects key-by-key, arrays/scalars replaced), validated after merging; `absent` only when neither exists; migration persists to the local file only.

   Files: `src/config/loadConfig.ts`

4. Make migration persist to the local file only, creating .baiton/ when needed

   Change the call to `await migrateAndPersist(localPath, doc, version)` so the migrated (merged) document is written to `config.local.json`; `config.json` is never written. Inside `migrateAndPersist`, rename the first parameter to `targetPath`, and before `writeJsonAtomic(targetPath, current)` add `await fs.mkdir(path.dirname(targetPath), { recursive: true });` inside the same try (a failure stays a `migration-failed`). Update its messages to name `targetPath` (the 'cannot migrate'/'Migrating ... failed' messages may keep naming the file; 'The file was left unchanged.' remains accurate since nothing is written on failure).

   To make the persist path testable (MIGRATIONS is empty and SUPPORTED_VERSION is 1, so no reachable version triggers migration through loadConfig), add an optional last parameter `migrations: Record<number, (doc: Record<string, unknown>) => Record<string, unknown>> = MIGRATIONS` and use it instead of `MIGRATIONS` in the loop, and export the function with a doc tag: `/** @internal Exported for tests; production callers go through loadConfig. */ export async function migrateAndPersist(...)`. Since `MIGRATIONS` is declared after the function as a `const`, move the `MIGRATIONS` declaration above `migrateAndPersist` (default parameter values are evaluated at call time, so either order works at runtime, but moving it avoids lint TDZ warnings). Do not change `writeJsonAtomic` (signature, temp naming `.config.json.<pid>.<ts>.tmp`, and `JSON.stringify(value, null, 2) + '\n'` formatting all stay).

   Files: `src/config/loadConfig.ts`

5. Adjust existing loadConfig tests in test/config.test.ts

   Only touch the loadConfig describe blocks; leave the initialize blocks for the phase that changes initialize.ts.
   - 'reports an absent config when no file exists': change the path assertion to `assert.strictEqual(result.error.path, path.join(dir, 'config.local.json'))` and add `assert.ok(result.error.message.includes('Initialize'))` and that the message mentions both `config.local.json` and `config.json`.
   - 'reports unparseable JSON' (baseline-only): additionally assert `result.error.kind === 'unparseable' && result.error.path === path.join(dir, 'config.json')`.
   - All other existing cases write only `config.json` and must pass unchanged (backward compatibility); additionally in 'refuses a newer version...' and 'rejects version 0...' assert `fs.existsSync(path.join(dir, 'config.local.json')) === false` so no overlay is created on refusal.
   - Update the file's coverage doc comment to mention the overlay tests live in test/config.overlay.test.ts.

   Files: `test/config.test.ts`

6. Add test/config.overlay.test.ts

   New mocha suite (same style/imports as test/config.test.ts: assert, fs, os, path, `loadConfig`, `configFilePath`, `localConfigFilePath`, `mergeConfigLayers`, `migrateAndPersist` from '../src/config/loadConfig', `defaultConfig`/`defaultConfigJson`, `isOk`/`isErr`; mkdtemp dirs cleaned in afterEach; helpers `writeBaseline(dir, text)` and `writeLocal(dir, text)`). Cases:
   1. `localConfigFilePath(dir)` === `path.join(dir,'config.local.json')`; accepts `{ fsPath }` like configFilePath.
   2. Local wins on scalars: baseline = defaults with `limits.exec_attempts: 3`, `git.remote: 'origin'`; local = `{ version: 1, limits: { exec_attempts: 7 } }` → loaded `limits.exec_attempts === 7`, other limits fields from baseline, `git.remote === 'origin'`.
   3. Objects merge per key at depth: local `{ roles: { planner: { model: 'local-model' } } }` → planner.model 'local-model', planner.agent from baseline, other roles from baseline.
   4. Arrays replaced, unknown keys preserved: pure unit test on `mergeConfigLayers({ a: [1,2,3], keep: 'b', nested: { x: 1 } }, { a: [9], extra: true, nested: { y: 2 } })` deepStrictEqual `{ a: [9], keep: 'b', extra: true, nested: { x: 1, y: 2 } }`; also assert neither input was mutated; also local object replacing baseline array and local array replacing baseline object.
   5. Baseline-only loads (defaultConfigJson in config.json) and creates no config.local.json.
   6. Local-only loads (defaultConfigJson in config.local.json, no config.json) and config.json is still absent afterwards.
   7. Neither → `absent`, path is the local file.
   8. Local corrupt with valid baseline → `unparseable`, `error.path === localConfigFilePath(dir)`, message includes 'config.local.json'; baseline bytes unchanged.
   9. Baseline corrupt with valid local → `unparseable` naming config.json (merge needs both).
   10. Local is a JSON array/`null` → `missing-section` section 'root', message names config.local.json.
   11. Merged result is validated: baseline valid, local `{ limits: { exec_attempts: 99 } }` → `missing-section` 'limits.exec_attempts'; local `{ version: 2 }` → `version-too-new`.
   12. Both files unchanged byte-for-byte after any successful load (read both before/after).
   13. Migration persists to the local file: call `migrateAndPersist(localConfigFilePath(sub), { ...defaultConfig(), version: 0, extra: 'x' }, 0, { 0: d => ({ ...d, version: 1 }) })` where `sub` is a not-yet-existing `.baiton` subdirectory of a temp dir that already holds nothing, and separately a variant where `sub` contains a baseline config.json; assert result ok, config.local.json exists with exactly `JSON.stringify({...doc, version: 1}, null, 2) + '\n'`, the directory was created, and the baseline config.json bytes are unchanged (or still absent).
   14. Migration with a throwing step / missing step → `migration-failed`, no config.local.json written.

   Files: `test/config.overlay.test.ts`

7. Compile and run the test suite

   Run the project's typecheck and unit tests (see package.json scripts, e.g. `npm run compile` / `npm test` or the mocha command used for test/*.test.ts). Ensure test/config.test.ts, test/config.overlay.test.ts, test/config.version.property.test.ts, test/config.limits.property.test.ts, test/configPanel.*.test.ts and test/configRefresh.test.ts all pass. Grep the src tree to confirm no code path in loadConfig.ts calls `writeJsonAtomic(configFilePath(...))` or otherwise writes config.json.

   Files: (none)

## Risks

- Changing the `absent` error's `path` from config.json to config.local.json could break other tests asserting the old path (e.g. activation/gating or configRefresh tests); grep test/ for `'absent'` and `config.json'` path assertions and update only those that check loadConfig's error.path. configDocument.ts has its own absent error and is out of scope for this phase.
- Until the Initialize phase lands, a fresh Initialize still writes config.json, which loads fine as a baseline-only workspace; the absent message pointing at config.local.json is still accurate once that phase lands. Do not modify initialize.ts here.
- The migration branch is unreachable via loadConfig while SUPPORTED_VERSION is 1 (version 0 fails readVersion first), so the persist-to-local behaviour is only verifiable through the exported migrateAndPersist with injected migrations; keep the default parameter so production behaviour is identical.
- Moving MIGRATIONS above migrateAndPersist must not change its contents (still `{}`).
- mergeConfigLayers must not mutate inputs or allow prototype pollution via a `__proto__` key in a hand-edited local file.
- Read order matters for which file a corrupt-file error names; read the baseline first, then the local file, and report the first failure — tests 8/9 fix this behaviour.

## Acceptance

- src/config/loadConfig.ts exports `localConfigFilePath(baitonDir)` returning `<dir>/config.local.json`, and it is the only place in src/ that spells `config.local.json` as a path segment introduced by this phase.
- loadConfig loads with only config.json (behaviour identical to before), only config.local.json, or both; with both, local values win, nested objects merge key by key, arrays and scalars are replaced, and keys from either side survive the merge.
- loadConfig returns `absent` (path = config.local.json, message mentioning Initialize) only when neither file exists.
- A corrupt config.local.json yields `unparseable` whose path and message name config.local.json; a corrupt config.json yields `unparseable` naming config.json.
- The merged document is validated by the existing readVersion/readRoles/readLimits/readGit/readPr rules, so an invalid local override is refused.
- loadConfig never writes config.json; migrateAndPersist writes the migrated document only to config.local.json (creating the directory if needed) using writeJsonAtomic, whose signature, temp-file naming and formatting are unchanged.
- test/config.overlay.test.ts exists with the cases listed and passes; test/config.test.ts loadConfig cases pass with the updated absent-path assertion; the full existing test suite and typecheck pass.
