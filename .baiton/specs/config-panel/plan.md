# plan result

```json
{
  "steps": [
    {
      "title": "Create src/config/configPanel.ts with the typed message protocol",
      "detail": "New host-free module (no `vscode` import, Node-free: pure data + functions), documented in the house style of src/orchestrator/webviewProtocol.ts (module docblock explaining the host/webview contract and why it is unit-testable). Declare two unions:\n\n`ConfigPanelHostToWebview`:\n- `{ type: 'loaded'; form: ConfigForm; token: string; options: ConfigFormOptions }` — the form parsed from disk plus the conflict token the webview must echo back on save and the dropdown option sets.\n- `{ type: 'loadFailed'; kind: 'absent' | 'unparseable' | 'invalid'; message: string; canReset: boolean }` — error state; `canReset` true for absent/unparseable so the webview shows Reset to defaults.\n- `{ type: 'saved'; token: string; notes?: string[] }` — write succeeded, new conflict token, optional notes naming anything that could not hot-reload (T08 fills these in; the field exists from T01 so the protocol is stable).\n- `{ type: 'saveFailed'; reason: 'invalid' | 'conflict' | 'io'; message: string; errors?: ConfigFieldError[] }` — host-side re-validation rejection, stale-token conflict, or write error.\n- `{ type: 'externalChange'; token: string }` — the file changed on disk (T07 posts it).\n\n`ConfigPanelWebviewToHost`:\n- `{ type: 'ready' }` (webview mounted, ask for the first load), `{ type: 'load' }` (explicit reload/discard-edits),\n- `{ type: 'save'; form: ConfigForm; token: string; overwrite?: boolean }` — `overwrite` set when the user chose Overwrite after a conflict,\n- `{ type: 'reset' }` — write defaultConfigJson() after a modal confirm (host performs the confirm).\n\nKeep every payload plain JSON-serializable data (structured clone must round-trip it); no classes, no Date, no undefined-only fields in arrays.",
      "files": [
        "src/config/configPanel.ts",
        "src/orchestrator/webviewProtocol.ts"
      ]
    },
    {
      "title": "Define the ConfigForm model, its option sets and the error type",
      "detail": "In the same module:\n\n```ts\nexport interface RoleFormEntry { agent: string; model: string; effort: string }\nexport interface ConfigForm {\n  roles: Record<Role, RoleFormEntry>;   // exactly the six ROLES from src/model/role.ts\n  limits: { plan_review_rounds: string; exec_attempts: string; stall_notice_minutes: string };\n  git: { remote: string; base: string };\n}\n```\nHold limits as strings (raw input text) so an empty or non-numeric field is a validation error rather than a coerced NaN, and so the webview's `<input type=number>` value maps 1:1. `effort` is a string with `''` meaning \"unset\" (the config field is optional); do NOT invent a default on the form side.\n\n`export const EFFORT_OPTIONS = ['low', 'medium', 'high'] as const;`\n\n```ts\nexport interface ConfigFormOptions { agents: readonly string[]; efforts: readonly string[] }\nexport function configFormOptions(agentIds: readonly string[], form?: ConfigForm): ConfigFormOptions\n```\nReturns `agents` = the passed ids (callers pass `createAdapterRegistry().ids` — keep the parameter a `readonly string[]` so this module stays free of the adapter import at type level is unnecessary; importing the type is fine but importing the factory is not, to keep the core dependency-light) plus any agent value already present in the form that is not an installed id, and `efforts` = EFFORT_OPTIONS plus any out-of-set effort present in the form, each appended once and in a stable order. This is the spec's \"a saved value outside that set is shown as an extra option so an existing config still round-trips\".\n\n```ts\nexport interface ConfigFieldError { path: string; message: string }\n```\n`path` uses the dotted form the webview keys inline errors by: `roles.<role>.agent`, `roles.<role>.model`, `roles.<role>.effort`, `limits.<field>`, `git.remote`, `git.base`.",
      "files": [
        "src/config/configPanel.ts",
        "src/model/role.ts",
        "src/adapter/index.ts"
      ]
    },
    {
      "title": "Implement formFromConfig (and a raw-document variant)",
      "detail": "`export function formFromConfig(config: Config): ConfigForm` — maps a validated Config to the form: every role in ROLES order, `effort: entry.effort ?? ''`, limits stringified with `String(n)`, git remote/base copied. Deterministic key order (iterate ROLES, not Object.keys) so a round-trip diff is stable.\n\nAlso export `export function formFromDocument(doc: unknown): ConfigForm` (or accept `Record<string, unknown>`) that builds a best-effort form from a *raw* parsed document. The panel needs this because the file may be semantically invalid (loadConfig refuses) yet still editable: coerce missing/wrong-typed leaves to `''` rather than throwing, so the user can fix the bad field in the form instead of hand-editing JSON. Missing roles get empty entries. Keep it total — never throws for any input, including non-objects.",
      "files": [
        "src/config/configPanel.ts",
        "src/config/types.ts",
        "src/config/loadConfig.ts"
      ]
    },
    {
      "title": "Implement validateConfigForm",
      "detail": "`export function validateConfigForm(form: ConfigForm, options: { agents: readonly string[] }): ConfigFieldError[]` — returns every error (not just the first), ordered roles → limits → git so the webview can focus the first one deterministically. Return `[]` for a valid form.\n\nRules, each mirroring what loadConfig would otherwise reject so the panel can never write a file that fails to load:\n- roles: for each role in ROLES — `agent` non-empty after trim, and a member of `options.agents` (message names the installed ids); `model` non-empty after trim; `effort` either `''` (omitted on write) or a non-empty string. Do not restrict effort to EFFORT_OPTIONS — loadConfig accepts any string and an adapter may take a custom value; the dropdown constrains the common case, the validator only rejects whitespace-only.\n- limits: for each key of LIMIT_BOUNDS — the string must match an integer (use an explicit `/^-?\\d+$/` test on the trimmed value plus Number.isInteger, not `parseInt`, so `'3abc'` and `'3.5'` are rejected), then `min <= n <= max` with the message quoting the bounds exactly as loadConfig's does (`must be between {min} and {max} (found {n})`).\n- git: `remote` and `base` non-empty after trim.\n\nImport LIMIT_BOUNDS from ./types and ROLES from ../model; do not re-declare bounds or the role list here — the spec requires one source of truth.",
      "files": [
        "src/config/configPanel.ts",
        "src/config/types.ts",
        "src/model/role.ts"
      ]
    },
    {
      "title": "Implement applyFormToDocument preserving unknown keys",
      "detail": "`export function applyFormToDocument(rawDoc: unknown, form: ConfigForm): Record<string, unknown>` — returns a NEW object (never mutates `rawDoc`; the caller keeps the original for conflict reporting) that is `rawDoc` shallow-cloned with `roles`, `limits` and `git` merged:\n- Start from `isObject(rawDoc) ? { ...rawDoc } : {}`; if `version` is absent or not the supported version, set `version: SUPPORTED_VERSION` (a reset/repair path must produce a loadable file).\n- `roles`: clone the existing roles object so unknown role keys and unknown per-role keys survive; for each role in ROLES set `{ ...existingEntry, agent, model }` and either set `effort` to the trimmed value or `delete` it when the form value is `''` (so \"cleared\" round-trips to absent, matching the optional field).\n- `limits`: clone existing, then write the three fields as numbers (`Number(value.trim())`) — the caller is expected to have validated first; document that precondition.\n- `git`: clone existing so `git.verify` and any unknown git keys survive, then overwrite `remote`/`base` with trimmed values.\n- Leave `pr` and every other top-level key untouched by construction.\nThis is the exact behaviour the spec calls out (`version`, `pr`, `git.verify`, any unknown keys survive).",
      "files": [
        "src/config/configPanel.ts",
        "src/config/types.ts",
        "src/config/defaultConfig.ts"
      ]
    },
    {
      "title": "Export from src/config/index.ts and verify the build",
      "detail": "Add `export * from './configPanel';` to src/config/index.ts, after './defaultConfig' and keeping the file's existing ordering/comment style (update the module docblock if it enumerates the service's parts). Check for name collisions across the barrel (`ConfigForm`, `validateConfigForm`, `applyFormToDocument`, `formFromConfig`, `EFFORT_OPTIONS`, `ConfigFieldError` are all new — grep to confirm). Then run `npm run compile` and `npm run lint` to confirm the new module type-checks and matches the eslint config. No tests are added here — T03 owns them — but keep every export shaped so a test can drive it with plain literals.",
      "files": [
        "src/config/index.ts",
        "src/config/configPanel.ts",
        "package.json"
      ]
    }
  ],
  "risks": [
    "Divergence from loadConfig: if validateConfigForm's rules drift from readRoles/readLimits/readGit, the panel can write a file the extension then refuses to load. Mitigation: import LIMIT_BOUNDS and ROLES rather than copying them, and mirror loadConfig's non-empty-string checks exactly; T03 should include a test that a form passing validation produces a document loadConfig accepts.",
    "Limits held as strings vs numbers is a contract decision that T04 (media/config.js) and T05 (host re-validation) both depend on. Strings are chosen so bad input is reportable rather than silently coerced; if a later task assumes numbers the protocol has to change in two places plus the browser mirror.",
    "agent id validation couples the core to the adapter registry. Passing `agents` in as a parameter (rather than calling createAdapterRegistry() inside the core) keeps the module host-free and testable, but means every caller must remember to pass the registry ids — a caller that passes `[]` would reject every agent.",
    "Unknown-key preservation depends on the raw parsed document being threaded through save. If T05 ever re-serializes from the validated Config instead of the raw doc, `pr`, `git.verify` and unknown keys are silently dropped; applyFormToDocument's rawDoc parameter is the guard against that.",
    "effort '' meaning \"absent\" is ambiguous with a user deliberately wanting an empty string. Treating '' as delete matches the optional field in types.ts, but an existing config with `\"effort\": \"\"` will round-trip to the key being removed — a behaviour change worth noting in T03's tests.",
    "Adding to the src/config barrel widens what every importer of './config' pulls in; keep configPanel.ts free of Node imports (fs/path) so nothing in the webview-facing path drags in Node-only code."
  ],
  "acceptance": [
    "src/config/configPanel.ts exists, contains no `vscode` import and no Node built-in import, and exports ConfigPanelHostToWebview, ConfigPanelWebviewToHost, ConfigForm, RoleFormEntry, ConfigFieldError, ConfigFormOptions, EFFORT_OPTIONS, configFormOptions, formFromConfig, formFromDocument, validateConfigForm and applyFormToDocument.",
    "The protocol unions cover load/loaded/loadFailed/save/saved/saveFailed/externalChange/reset as named in the spec, and every payload is plain JSON-serializable data.",
    "validateConfigForm returns [] for the form derived from defaultConfig() with agents = createAdapterRegistry().ids, and returns a ConfigFieldError with the right dotted path for: an unknown agent, an empty model, a non-integer limit, an out-of-range limit, and an empty git remote/base.",
    "validateConfigForm reuses LIMIT_BOUNDS and ROLES by import — no duplicated bounds table or role list anywhere in the new file.",
    "applyFormToDocument(rawDoc, formFromConfig(loadedConfig)) applied to a document containing `pr`, `git.verify` and an unrecognised top-level key returns a document that still contains all three unchanged, and does not mutate rawDoc.",
    "Clearing a role's effort in the form removes the `effort` key from that role in the produced document; setting it writes the trimmed string.",
    "configFormOptions appends an agent id or effort value present in the form but absent from the installed ids / EFFORT_OPTIONS, exactly once, so an existing config round-trips.",
    "formFromDocument does not throw for a non-object, an empty object, or a document with wrong-typed leaves.",
    "src/config/index.ts re-exports the new module and `npm run compile` and `npm run lint` both pass with no new errors or warnings.",
    "No files outside src/config/configPanel.ts and src/config/index.ts are modified by this todo."
  ]
}
```
