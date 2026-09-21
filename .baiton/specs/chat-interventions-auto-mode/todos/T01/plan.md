# Plan T01

## Steps

1. Create src/orchestrator/interventions.ts with the Intervention model

   New host-free file (no `vscode` import; only `import { Clock, IdGenerator, systemClock } from './seams';`). Follow the file-header JSDoc style used by `src/orchestrator/seams.ts` and `chatTranscript.ts`.

   Export these types:

   ```ts
   export type InterventionKind = 'question' | 'confirm' | 'permission';

   /** One selectable answer of an option question. */
   export interface InterventionOption {
     /** Stable id the answer names; unique within one request. */
     id: string;
     /** The button/radio label shown to the user. */
     label: string;
     /** Optional secondary line under the label. */
     detail?: string;
   }

   /** The orchestrator (or a sub-agent) asks the user a question. */
   export interface QuestionRequest {
     kind: 'question';
     /** The question text. */
     prompt: string;
     /** Offered choices; absent or empty means a free-text-only question. */
     options?: InterventionOption[];
     /** True when a typed answer is accepted in addition to any options. */
     allowFreeText?: boolean;
     /** Placeholder for the free-text input. */
     placeholder?: string;
   }

   /** A yes/no confirmation (what today's modal ConfirmSeam shows). */
   export interface ConfirmRequest {
     kind: 'confirm';
     prompt: string;
     detail?: string;
     /** Defaults are applied by the view, not here. */
     confirmLabel?: string;
     declineLabel?: string;
   }

   /** A sub-agent harness permission ask relayed into the chat. */
   export interface PermissionRequest {
     kind: 'permission';
     prompt: string;
     /** The agent/adapter id the ask came from (e.g. 'claude'). */
     agent: string;
     /** The tool the harness wants to run (e.g. 'Bash'). */
     tool: string;
     /** The tool arguments as JSON text, when the harness supplied them. */
     args?: string;
     /** Human-readable 'what you are approving' text. */
     detail?: string;
   }

   export type InterventionRequest = QuestionRequest | ConfirmRequest | PermissionRequest;

   /** A created, pending or settled ask: a request plus its identity. */
   export type Intervention = InterventionRequest & {
     /** Registry-assigned id; the key every resolve/reject names. */
     id: string;
     /** ISO-8601 creation time from the injected Clock. */
     createdAt: string;
     /** Conversation scope the card belongs to ('workspace' or a spec slug). */
     scopeId?: string;
   };

   /** The user's answer to one intervention. */
   export type InterventionAnswer =
     | { kind: 'option'; optionId: string; label?: string }
     | { kind: 'text'; text: string }
     | { kind: 'approved' }
     | { kind: 'declined'; reason?: string };
   ```

   Also export a pure validator used by the registry and reusable by the controller:

   ```ts
   export type AnswerCheck = { ok: true } | { ok: false; reason: string };
   export function checkAnswer(req: InterventionRequest, answer: InterventionAnswer): AnswerCheck;
   ```

   Rules (implement exactly, each with its own test):
   - `declined` is always valid for every kind.
   - `kind: 'question'`: `option` valid only when `req.options` contains an option with that `id` (otherwise `reason: 'unknown option "<id>"'`); `text` valid when `req.allowFreeText === true` or `req.options` is undefined/empty (otherwise `reason: 'this question does not accept a typed answer'`); `approved` invalid (`reason: 'a question cannot be answered with an approval'`).
   - `kind: 'confirm'` and `kind: 'permission'`: `approved` valid; `option`/`text` invalid (`reason: 'a <kind> is answered by approving or declining'`).
   - Use an `assertNever`-style exhaustive switch on `req.kind` (mirror the helper already in `webviewProtocol.ts`).

   Files: `src/orchestrator/interventions.ts`

2. Add the pending-ask registry to interventions.ts

   In the same file, add the pure registry that owns pending asks and their promises. No I/O, no timers.

   ```ts
   export type ResolveOutcome =
     | { kind: 'resolved' }
     | { kind: 'unknown' }
     | { kind: 'invalid'; reason: string };

   export interface PendingAskRegistryDeps {
     ids: IdGenerator;
     clock?: Clock; // defaults to systemClock
   }

   export class PendingAskRegistry {
     constructor(deps: PendingAskRegistryDeps);
     /** Register a new ask; returns the stamped Intervention and the promise that settles with the user's answer. */
     create(request: InterventionRequest): { intervention: Intervention; answer: Promise<InterventionAnswer> };
     /** Settle the ask with the user's answer. */
     resolve(id: string, answer: InterventionAnswer): ResolveOutcome;
     /** Settle the ask as declined (Stop, a card's Decline, or a failed presentation). */
     reject(id: string, reason?: string): ResolveOutcome;
     /** Decline every pending ask; returns how many were settled. */
     rejectAll(reason?: string): number;
     /** The pending asks in creation order (a fresh array; entries are copies-by-reference of the stored Intervention). */
     pending(): Intervention[];
     has(id: string): boolean;
     get size(): number;
   }
   ```

   Implementation notes:
   - Back it with a `Map<string, { intervention: Intervention; settle: (a: InterventionAnswer) => void }>`; a `Map` preserves insertion order, which `pending()` relies on.
   - `create` stamps `id = this.ids.next()` and `createdAt = this.clock.now()`, stores the entry, and returns a `new Promise<InterventionAnswer>` whose `resolve` is captured as `settle`. The promise never rejects — every settlement is an `InterventionAnswer`, so callers never need try/catch.
   - `resolve` on an id that is absent (never created, or already settled) returns `{ kind: 'unknown' }` — this makes double-answering idempotent and harmless. On a present id it runs `checkAnswer(entry.intervention, answer)`; an invalid answer returns `{ kind: 'invalid', reason }` and leaves the ask **pending**. A valid answer deletes the entry first, then calls `settle(answer)`.
   - `reject(id, reason)` is `resolve(id, { kind: 'declined', reason })` (reason defaults to `'declined'`).
   - `rejectAll(reason = 'the run was stopped')` snapshots `[...map.keys()]`, rejects each, and returns the count; it must be safe to call when empty (returns 0) and must not throw if a settle handler re-enters the registry.
   - Freeze nothing; keep `Intervention` objects plain so protocol code can spread them later.

   Files: `src/orchestrator/interventions.ts`

3. Add InterventionSeam and the ConfirmSeam adapter

   Still in `interventions.ts`:

   ```ts
   /** The seam every human-in-the-loop ask goes through. Resolves with the user's answer. */
   export interface InterventionSeam {
     ask(request: InterventionRequest): Promise<InterventionAnswer>;
   }

   /** Shows a pending card to the user; the host implements it (chat post / webview message). */
   export type PresentIntervention = (intervention: Intervention) => void | Promise<void>;

   export function createInterventionSeam(
     registry: PendingAskRegistry,
     present: PresentIntervention,
   ): InterventionSeam;
   ```

   `createInterventionSeam` returns `{ async ask(request) { const { intervention, answer } = registry.create(request); try { await present(intervention); } catch (err) { registry.reject(intervention.id, `the ask could not be shown: ${message(err)}`); } return answer; } }`. Presentation failure must decline rather than hang, so a broken host still returns control to the caller. Add a small local `function message(err: unknown): string` (`err instanceof Error ? err.message : String(err)`) unless an equivalent helper already exists in the package to reuse.

   Then the backwards-compatible adapter that keeps `approve_spec` / `draft_spec` / `submit_pr` compiling unchanged:

   ```ts
   /** Adapt an InterventionSeam to the legacy yes/no ConfirmSeam. */
   export function confirmSeamFrom(seam: InterventionSeam): ConfirmSeam;
   ```

   It sends `{ kind: 'confirm', prompt: message }` and returns `answer.kind === 'approved'`; every other answer (`declined`, and the impossible `option`/`text`) returns `false`, preserving the existing contract that only an affirmative confirmation proceeds. Import `ConfirmSeam` as a type from `./seams`.

   Files: `src/orchestrator/interventions.ts`, `src/orchestrator/seams.ts`

4. Update seams.ts docs and export the module from index.ts

   `src/orchestrator/seams.ts`: no type changes — `ConfirmSeam` keeps its exact shape (`confirm(message: string): Promise<boolean>`) so `ToolServices.confirm`, `controlTools.ts` (three call sites: `draft_spec` ~line 115, `approve_spec` ~line 205, `submit_pr` ~line 480), `chatController.ts` and `commands.ts` all keep compiling untouched. Edit only the JSDoc: in the file header bullet for `ConfirmSeam` and on the interface itself, state that it is now the narrow yes/no adapter over `InterventionSeam` in `./interventions` (built with `confirmSeamFrom`) and that hosts should prefer the intervention seam for new asks.

   `src/orchestrator/index.ts`: add `export * from './interventions';` (place it next to `export * from './seams';`). Verify no exported name collides with an existing orchestrator export (`Intervention*`, `PendingAskRegistry`, `checkAnswer`, `confirmSeamFrom`, `createInterventionSeam`, `ResolveOutcome`, `AnswerCheck`, `PresentIntervention` are all new) — a duplicate would break `tsc`.

   Do not modify `controlTools.ts`, `toolServices.ts`, `chatController.ts`, `commands.ts`, `webviewProtocol.ts` or any `media/` file in this todo; the chat wiring, protocol records and Auto mode land in later todos.

   Files: `src/orchestrator/seams.ts`, `src/orchestrator/index.ts`

5. Write test/interventions.test.ts

   Mocha + ts-node, host-free, `import * as assert from 'assert';` and import the unit under test from `'../src/orchestrator/interventions'` — match the header-comment and `describe`/`it` style of `test/modelClient.test.ts`.

   Helpers at the top: `function counterIds(): IdGenerator` returning `ask-1`, `ask-2`, … and `const fixedClock: Clock = { now: () => '2026-01-01T00:00:00.000Z' }`.

   Cases to cover:
   - **checkAnswer**: option answer accepted for a declared option id and rejected (with a reason naming the id) for an undeclared one; text accepted when `allowFreeText` is true or no options are declared and rejected otherwise; `approved` rejected for `question` and accepted for `confirm` and `permission`; `option`/`text` rejected for `confirm` and `permission`; `declined` accepted for all three kinds.
   - **create**: stamps the injected id and clock onto the returned `Intervention`, preserves every request field (including `options`, `agent`/`tool`/`args`), `size` becomes 1, `has(id)` is true, and the answer promise is still unsettled (assert with `Promise.race` against a resolved sentinel).
   - **resolve**: a valid answer settles the promise with exactly that answer value and removes the entry (`size` 0, `has` false); resolving the same id again returns `{ kind: 'unknown' }` and does not throw; an unknown id returns `{ kind: 'unknown' }`; an invalid answer returns `{ kind: 'invalid' }` with a non-empty reason and leaves the ask pending and unsettled.
   - **reject**: settles with `{ kind: 'declined', reason }`, and with a default reason when none is given.
   - **rejectAll**: three pending asks all settle as declined, the return value is 3, `size` is 0 afterwards, and a second `rejectAll()` returns 0. This is the Stop path — assert every promise settles (await `Promise.all`).
   - **pending()**: returns the asks in creation order and excludes settled ones.
   - **createInterventionSeam**: `ask` calls `present` exactly once with the stamped `Intervention`; resolving that intervention's id through the registry settles the `ask` promise with the answer; when `present` throws (and when it returns a rejected promise), `ask` resolves to a `declined` answer whose reason mentions the failure and leaves no pending entry.
   - **confirmSeamFrom**: `confirm('msg')` issues a `confirm` intervention whose `prompt` is `'msg'`; answering `{ kind: 'approved' }` resolves `true`; `{ kind: 'declined' }` resolves `false`; `rejectAll` while a confirm is outstanding resolves it `false` (the Stop-returns-control guarantee).

   Each test drives the registry directly (no fake timers, no filesystem, no `vscode`).

   Files: `test/interventions.test.ts`

6. Verify the build, tests and lint

   Run `npm run compile` (must be clean — in particular the untouched `controlTools.ts`/`chatController.ts`/`commands.ts` still typecheck against the unchanged `ConfirmSeam`), `npx mocha test/interventions.test.ts` (all green), then the full `npm test` to confirm no existing suite regressed, and `npm run lint`.

   Files: `src/orchestrator/interventions.ts`, `test/interventions.test.ts`

## Risks

- Changing `ConfirmSeam`'s shape would break three `controlTools.ts` call sites, `ToolServices`, `chatController.callTool` and `buildConfirmSeam` in `commands.ts`. Keep the interface byte-identical and add only the adapter; this todo must be a pure addition.
- `interventions.ts` imports `Clock`/`IdGenerator`/`ConfirmSeam` from `./seams`; do not add an import back from `seams.ts` into `interventions.ts` or a module cycle appears in the orchestrator barrel. Keep the model, registry and seam in `interventions.ts` and limit `seams.ts` to doc edits.
- A pending ask whose promise never settles would hang the tool loop. Every exit path (invalid presentation, Stop, double answer) must settle or be explicitly idempotent; the promise returned by `create` must never reject.
- Resolving an ask from inside a settle handler (re-entrancy during `rejectAll`) must not corrupt iteration — snapshot the key list before rejecting.
- The answer union and `Intervention` shape are consumed by later todos (protocol records, transcript persistence, Auto mode, the ask relay). Keep every field JSON-serializable — no class instances, no `Date` objects, no functions on `Intervention`.
- `export * from './interventions'` in the barrel will fail the build on any name collision with an existing orchestrator export; check before committing.

## Acceptance

- `src/orchestrator/interventions.ts` exists, imports no `vscode`, and exports `Intervention`, `InterventionRequest` (with `question`/`confirm`/`permission` variants), `InterventionOption`, `InterventionAnswer`, `checkAnswer`, `PendingAskRegistry`, `ResolveOutcome`, `InterventionSeam`, `createInterventionSeam` and `confirmSeamFrom`.
- `PendingAskRegistry` supports create / resolve / reject / rejectAll / pending / has / size with injected `IdGenerator` and `Clock`; resolving an unknown or already-settled id returns `{ kind: 'unknown' }` without throwing, and an answer invalid for the ask's kind returns `{ kind: 'invalid', reason }` and leaves the ask pending.
- `rejectAll()` settles every outstanding ask as `{ kind: 'declined' }` and returns the count, so Stop always returns control to the user.
- `confirmSeamFrom` yields a value assignable to `ConfirmSeam`; it resolves `true` only for an `approved` answer and `false` for declined, invalid or stopped asks.
- `ConfirmSeam` in `src/orchestrator/seams.ts` is unchanged apart from documentation, and `src/orchestrator/index.ts` re-exports `./interventions`.
- `test/interventions.test.ts` covers the validator rules, registry lifecycle (including double-resolve, unknown id, invalid answer, rejectAll), seam presentation failure and the ConfirmSeam adapter, and runs without a VS Code host.
- `npm run compile`, `npm test` and `npm run lint` all pass with no changes to `controlTools.ts`, `toolServices.ts`, `chatController.ts`, `commands.ts`, `webviewProtocol.ts` or `media/`.
