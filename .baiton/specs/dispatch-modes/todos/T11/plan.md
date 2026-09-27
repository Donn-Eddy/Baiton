# Plan T11

## Steps

1. Import RunMode into the protocol core

   In `src/orchestrator/webviewProtocol.ts`, add `import type { RunMode } from '../model/mode';` beside the existing `import type { InterventionAnswer, InterventionKind, InterventionOption } from './interventions';` and `import type { ModelSelection, ProviderId } from './providers';`. Use `import type` only and do NOT re-export `RunMode` from this module: `src/orchestrator/index.ts` does `export * from './webviewProtocol'` and a value re-export would risk a duplicate-export clash with the other orchestrator modules that already import `RunMode` (`seams.ts`, `controlTools.ts`, `systemPrompt.ts`). `src/model/mode.ts` already exists from T01 and exports `RunMode = 'spec' | 'bug' | 'quick' | 'refactor' | 'investigate'`, `RUN_MODES`, `DEFAULT_MODE = 'spec'`, `isRunMode` and `isSpecless`.

   Files: `src/orchestrator/webviewProtocol.ts`

2. Add `setMode` and `setRunActive` to HostToWebview

   In the `HostToWebview` union in `src/orchestrator/webviewProtocol.ts`, the last member is currently `/** Set the Auto-mode toggle shown left of Stop. */ | { type: 'setAutoMode'; enabled: boolean };`. Change that member's terminating `;` to keep the union open and append two new members after it, in this order:

   ```ts
     /** Set the Auto-mode toggle shown left of Stop. */
     | { type: 'setAutoMode'; enabled: boolean }
     /**
      * Set the conversation's mode. The host is authoritative: the composer's
      * Mode control repaints only on this echo, so a webview `setMode` that the
      * host rejects (a spec conversation is always Spec) simply never comes back.
      */
     | { type: 'setMode'; mode: RunMode }
     /**
      * Set whether a spec-less run is in flight for this workspace. The Mode
      * control is disabled while it is true, so a run's mode cannot change under
      * it mid-flight.
      */
     | { type: 'setRunActive'; active: boolean };
   ```

   The payload key for `setRunActive` is `active` (boolean), matching the `enabled`/`busy` style of the neighbouring flag messages.

   Files: `src/orchestrator/webviewProtocol.ts`

3. Add `setMode` to WebviewToHost

   In the `WebviewToHost` union in the same file, whose last member is `/** The user flipped the Auto-mode toggle. */ | { type: 'setAutoMode'; enabled: boolean };`, append one member:

   ```ts
     /** The user flipped the Auto-mode toggle. */
     | { type: 'setAutoMode'; enabled: boolean }
     /**
      * The user picked a mode in the composer's Mode control. The host decides
      * whether the change takes: it persists the choice and echoes a host→webview
      * `setMode`, which is the only thing that moves the rendered control.
      */
     | { type: 'setMode'; mode: RunMode };
   ```

   There is no `runActive` message in this direction — run activity is host-owned. No compile fallout is expected: `ChatController.handle` in `src/activation/chatController.ts:436` switches over `WebviewToHost` without a `default`/`assertNever` arm, so an added variant does not break it (wiring the case is T12's job).

   Files: `src/orchestrator/webviewProtocol.ts`

4. Add `mode` and `runActive` to WebviewState and the seed

   In the `WebviewState` interface, immediately after the `autoMode: boolean;` field, add:

   ```ts
     /** The active conversation's mode; `'spec'` unless the host says otherwise. */
     mode: RunMode;
     /** Whether a spec-less run is in flight; the Mode control is locked while true. */
     runActive: boolean;
   ```

   Both are required (non-optional) so the seed and every `{ ...state }` spread carry them and `deepStrictEqual` parity stays tight. In `initialWebviewState()`, add `mode: DEFAULT_MODE,` and `runActive: false,` after `autoMode: false,` — import `DEFAULT_MODE` as a value: change the import from step 1 to `import { DEFAULT_MODE, type RunMode } from '../model/mode';` (or add a second `import { DEFAULT_MODE } from '../model/mode';` line, matching whichever form the file's neighbours use; the file currently uses only `import type`, so the combined form is the tidier fit).

   Files: `src/orchestrator/webviewProtocol.ts`

5. Handle the two new messages in the TypeScript `reduce`

   In `reduce`, directly after `case 'setAutoMode': return { ...state, autoMode: msg.enabled };`, add:

   ```ts
       case 'setMode':
         return { ...state, mode: msg.mode };
       case 'setRunActive':
         return { ...state, runActive: msg.active };
   ```

   Do not validate the mode here (no `isRunMode` guard): the host is authoritative and the browser mirror cannot import the predicate, so a guard would break mirror parity. The `assertNever(msg)` default arm already proves exhaustiveness — omitting either case is a compile error. Also extend the `reduce` doc comment's bullet list (the one that currently ends with `setProviders replaces the provider groups…`) with two bullets, placed next to the existing `setAutoMode` bullet:
   - `` `setMode` sets the conversation's mode; the host is authoritative. ``
   - `` `setRunActive` sets whether a spec-less run is in flight. ``

   Files: `src/orchestrator/webviewProtocol.ts`

6. Mirror both cases and the seed in media/protocol.js

   `media/protocol.js` is the browser mirror loaded by `test/webviewProtocol.mirror.test.ts` through `vm.runInNewContext`; it must fold identically. Two edits inside the IIFE:

   1. In `initialWebviewState()`, after `autoMode: false,`, add `mode: 'spec',` and `runActive: false,` with a comment noting the literal mirrors `DEFAULT_MODE` in `src/model/mode.ts` (the mirror is a plain script and cannot import it).
   2. In `reduce`, after `case 'setAutoMode': return Object.assign({}, state, { autoMode: msg.enabled });`, add:

   ```js
         case 'setMode':
           return Object.assign({}, state, { mode: msg.mode });
         case 'setRunActive':
           return Object.assign({}, state, { runActive: msg.active });
   ```

   Keep the field order in the seed object identical to the TypeScript seed. The `default:` arm (return the state unchanged) is untouched. `media/chat.js` needs no change for this todo — its `window.addEventListener('message', …)` handler folds any message through `protocol.reduce` and then re-renders; rendering the Mode control is T12's work. `.eslintrc.json` ignores `**/*.js`, so the mirror is not linted.

   Files: `media/protocol.js`

7. Update the shared fixture seed and add parity cases

   In `test/fixtures/protocolCases.ts`:

   1. Update the `seed()` helper's literal (deliberately a literal, not `initialWebviewState()`, so seed drift is caught) to include `mode: 'spec',` and `runActive: false,` after `autoMode: false,`. Add `import { RUN_MODES } from '../../src/model/mode';` at the top beside the existing type-only import from `../../src/orchestrator/webviewProtocol`.
   2. Append new numbered cases after the last one (`// (51) setProviders then setEmptyState then a stale re-post`), keeping the file's `// (n) …` comment convention and `cases.push({ … })` style, before the closing `export const PROTOCOL_CASES`:
      - `(52)` one case per mode, generated with `for (const mode of RUN_MODES) { cases.push({ name: \`setMode sets the mode to ${mode}\`, messages: [{ type: 'setMode', mode }] }); }` — five cases covering `spec`, `bug`, `quick`, `refactor`, `investigate`.
      - `setMode overwrites a previously set mode`: `state: seed({ mode: 'bug' })`, message `{ type: 'setMode', mode: 'refactor' }`.
      - `setMode leaves the rest of the state alone`: start from a rich `seed({ records: [{ role: 'user', content: 'hi' }], busy: true, autoMode: true, providers: [group()], selection: { provider: 'google', model: 'gemini-2.5-pro' }, empty: { endpoint: null, model: null } })` and fold `{ type: 'setMode', mode: 'quick' }`.
      - `setRunActive turns the run flag on` and `setRunActive turns the run flag off` (the latter from `seed({ runActive: true })`).
      - `setRunActive does not disturb the mode`: `state: seed({ mode: 'investigate' })`, message `{ type: 'setRunActive', active: true }`.
      - `setMode then setRunActive then setRunActive off` — a multi-message fold exercising both new messages in sequence.
      - `setMode interleaved with setBusy and setAutoMode`: `[{ type: 'setMode', mode: 'bug' }, { type: 'setBusy', busy: true }, { type: 'setAutoMode', enabled: true }, { type: 'setRunActive', active: true }, { type: 'setMode', mode: 'quick' }]` — pins that the new fields and the old ones do not clobber one another in either reducer.

   No change is needed in `test/webviewProtocol.mirror.test.ts`: it already iterates `PROTOCOL_CASES` and already asserts `deepStrictEqual(hardClone(mirror.initialWebviewState()), initialWebviewState())`, so the seed additions are checked for free and any drift between the two seeds fails that test.

   Files: `test/fixtures/protocolCases.ts`

8. Add reducer tests for the new fields and messages

   In `test/webviewProtocol.reducer.test.ts`:

   1. Add `import { DEFAULT_MODE, RUN_MODES } from '../src/model/mode';` beside the existing imports.
   2. Add a `describe('conversation mode and run activity', () => { … })` block at the top level, placed after the existing `describe('interventions', …)` block (which ends with the `setAutoMode sets the flag both ways…` test and the `provider selection` sub-describe), covering:
      - `'a fresh state starts in the default mode with no run in flight'`: `assert.strictEqual(initialWebviewState().mode, DEFAULT_MODE)` and `assert.strictEqual(initialWebviewState().mode, 'spec')` and `assert.strictEqual(initialWebviewState().runActive, false)`.
      - `'setMode sets every mode'`: loop `for (const mode of RUN_MODES)` folding `{ type: 'setMode', mode }` over `initialWebviewState()` and asserting `next.mode === mode`.
      - `'setMode replaces a previous mode'`: `spec` → `bug` → `spec`.
      - `'setMode leaves the rest of the state alone'`: seed a state with `records`, `busy: true`, `autoMode: true`, `activeId`, `sessions`, `providers`, `selection`, `empty`, fold `{ type: 'setMode', mode: 'refactor' }`, and assert each of those is unchanged (mirrors the existing `setProviders leaves the rest of the state alone` test).
      - `'setRunActive sets the flag both ways'`.
      - `'setRunActive does not change the mode and setMode does not change runActive'`.
      - `'setMode and setRunActive do not mutate the input state'`: snapshot `JSON.stringify(seed)` before and after, as the existing purity tests do.
      - `'a webview setMode carries the chosen mode'`: `const msg: WebviewToHost = { type: 'setMode', mode: 'investigate' }; assert.strictEqual(msg.type, 'setMode'); assert.strictEqual(msg.mode, 'investigate');` — the type annotation is the real assertion (it would not compile if the variant were missing), matching the existing `selectModel carries the provider and the model` test.
   3. Extend the existing `it('does not mutate the input state on any message', …)` test (around line 205) with `reduce(seed, { type: 'setMode', mode: 'bug' });` and `reduce(seed, { type: 'setRunActive', active: true });` after the `setAutoMode` line, so the every-message purity sweep stays complete.

   Files: `test/webviewProtocol.reducer.test.ts`

9. Verify

   Run `npm run compile`, `npm run lint` and `npm test` from the repo root. Expect zero TypeScript errors and zero new lint errors; note that `npm run lint` already reports one pre-existing warning (`'_legacy' is assigned a value but never used` at `src/orchestrator/webviewProtocol.ts:591`, from `projectCard`) — leave it alone. The full suite must pass with only additions to the counts (the baseline after T01 was 1736 passing / 1 pending / 0 failing); no existing assertion may be weakened or removed.

   Files: (none)

## Risks

- Seed drift is the main trap: `initialWebviewState()` in `src/orchestrator/webviewProtocol.ts`, the mirror seed in `media/protocol.js` and the literal in `seed()` in `test/fixtures/protocolCases.ts` are three hand-maintained copies. Missing any one fails `test/webviewProtocol.mirror.test.ts` ('mirrors the initial seed state exactly') or every fixture case at once. That failure is the sync guard working — fix the copy, do not relax the `deepStrictEqual`.
- Making `mode`/`runActive` required on `WebviewState` is deliberate; if a partial state literal anywhere fails to compile, add the fields rather than making them optional — an optional field would let a present-undefined key diverge between the two reducers.
- Validating the incoming mode (e.g. with `isRunMode`) in the TypeScript `reduce` would silently break mirror parity, since `media/protocol.js` cannot import the predicate. Keep both reducers dumb; the host is the authority.
- `test/fixtures/protocolCases.ts` currently imports only types from the protocol module. Importing the value `RUN_MODES` from `../../src/model/mode` is fine (that module is host-free with no `vscode` import), but the fixture must keep every `messages` entry a valid `HostToWebview` variant: the TS reducer throws on an unknown type while the mirror returns the state unchanged, so a typo in `'setRunActive'` diverges before any comparison runs.
- `ChatController.handle` switches over `WebviewToHost` with no exhaustiveness guard, so adding `setMode` compiles without wiring it. That is intended here — the controller, `media/chat.js`, `media/chat.html` and `workspaceState` persistence belong to the later chat-mode-control todo — but it means nothing in this todo proves the message is handled end to end; the reducer and parity tests are the whole acceptance surface.

## Acceptance

- `src/orchestrator/webviewProtocol.ts` declares `{ type: 'setMode'; mode: RunMode }` and `{ type: 'setRunActive'; active: boolean }` in `HostToWebview`, `{ type: 'setMode'; mode: RunMode }` in `WebviewToHost`, and `mode: RunMode` plus `runActive: boolean` as required fields of `WebviewState`.
- `initialWebviewState()` returns `mode: DEFAULT_MODE` (i.e. `'spec'`) and `runActive: false`, and `media/protocol.js`'s seed returns the same two fields with the same values in the same object position.
- `reduce` handles `setMode` (sets `state.mode`) and `setRunActive` (sets `state.runActive`) in both the TypeScript core and the `media/protocol.js` mirror, leaving every other field untouched; the `assertNever` default arm still compiles, proving the TS switch is exhaustive.
- `test/fixtures/protocolCases.ts` covers all five modes through `setMode`, both `setRunActive` values, mode replacement, a mode-preserving `setRunActive`, and at least one multi-message fold interleaving `setMode`/`setRunActive` with `setBusy`/`setAutoMode`; `test/webviewProtocol.mirror.test.ts` passes over every case with no change to that test file.
- `test/webviewProtocol.reducer.test.ts` asserts the seed defaults, every-mode `setMode`, `setRunActive` both ways, non-interference between the two new fields and the existing state, a typed `WebviewToHost` `setMode` literal, and includes both new messages in the every-message purity sweep.
- `npm run compile` is clean, `npm run lint` reports no new errors (the pre-existing `_legacy` warning at `src/orchestrator/webviewProtocol.ts:591` may remain), and `npm test` passes with no pre-existing test modified other than the additive lines in the 'does not mutate the input state on any message' case and the `seed()` helper.
