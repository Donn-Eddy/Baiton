# Plan T08

## Steps

1. Add the `ask_user` control tool to src/orchestrator/controlTools.ts

   Add a new factory `askUserTool(services: ToolServices): Tool` alongside the existing `draftSpecTool`/`approveSpecTool`/`runTool`/`submitPrTool`, and register it in `createControlTools` (put it first in the returned array: `[askUserTool(services), draftSpecTool(services), approveSpecTool(services), runTool(services), submitPrTool(services)]`).

   Import the intervention types at the top of the file: `import type { InterventionOption } from './interventions';`.

   Tool shape:
   - `name: 'ask_user'`
   - `description: 'Ask the user a question and wait for their answer: offer a short list of options, accept a typed reply, or both. Use this instead of ending your turn with a question.'`
   - `mutating: false` (so the guard needs no idempotency key), NO `dispatch` property (it launches nothing, so it must stay usable under Restricted Mode)
   - `phases: ['gather', 'drive']`
   - `schema`:
   ```ts
   {
     type: 'object',
     properties: {
       question: { type: 'string' },
       options: {
         type: 'array',
         items: {
           type: 'object',
           properties: {
             id: { type: 'string' },
             label: { type: 'string' },
             detail: { type: 'string' },
           },
           required: ['id', 'label'],
           additionalProperties: false,
         },
       },
       allow_free_text: { type: 'boolean' },
       placeholder: { type: 'string' },
     },
     required: ['question'],
     additionalProperties: false,
   }
   ```

   `async run(args, _tc)` body, in this exact order (every validation happens before the seam is touched, so a malformed call never raises a card):
   1. `const question = readString(args, 'question');` — if `undefined` or `question.trim().length === 0` return `{ ok: false, error: 'ask_user requires a non-empty string "question"' }`.
   2. Parse options with a new local helper `readOptions(args)` (below). On `{ ok: false, error }` return it as the tool error.
   3. Read `allow_free_text` with a new local helper `readBoolean(args, 'allow_free_text')` (returns `boolean | undefined`; a present non-boolean value is an error: `'ask_user "allow_free_text" must be a boolean'`). Read `placeholder` with `readString(args, 'placeholder')`.
   4. If `services.intervention === undefined` return `{ ok: false, error: 'ask_user is not available in this host' }` (mirrors the `draft_spec`/`submit_pr` unavailable wording).
   5. Build the request and await the seam:
   ```ts
   const answer = await services.intervention.ask({
     kind: 'question',
     prompt: question.trim(),
     ...(options.length > 0 ? { options } : {}),
     ...(allowFreeText !== undefined ? { allowFreeText } : {}),
     ...(placeholder !== undefined ? { placeholder } : {}),
   });
   ```
      Note `QuestionRequest.options` is optional, so omit the key entirely when there are no options — that is what makes `checkAnswer` accept a free-text answer.
   6. Map the `InterventionAnswer` to a `ToolResult`:
      - `answer.kind === 'option'` -> `{ ok: true, data: { answer: 'option', optionId: answer.optionId, label: answer.label ?? options.find((o) => o.id === answer.optionId)?.label } }`
      - `answer.kind === 'text'` -> `{ ok: true, data: { answer: 'text', text: answer.text } }`
      - `answer.kind === 'declined'` -> `{ ok: false, error: 'the question was not answered' + (answer.reason ? `: ${answer.reason}` : '') }` — a decline is a refusal so the orchestrator quotes it and stops, per the prompt's refusal rule.
      - `answer.kind === 'approved'` -> `{ ok: false, error: 'ask_user received an approval instead of an answer' }` (defensive; `checkAnswer` already rejects it at the registry).

   New module-private helpers, placed next to the existing `readString`:
   ```ts
   /** The most options one ask_user card may offer; more than this is a list, not a choice. */
   const MAX_ASK_USER_OPTIONS = 8;

   type OptionsRead = { ok: true; options: InterventionOption[] } | { ok: false; error: string };

   /** Read and validate the optional `options` array: objects with unique non-empty id/label. */
   function readOptions(args: unknown): OptionsRead { ... }

   /** Read an optional boolean field; `undefined` when absent, an error when present but not a boolean. */
   function readBoolean(args: unknown, key: string): { ok: true; value: boolean | undefined } | { ok: false; error: string } { ... }
   ```
   `readOptions` rules and exact error strings:
   - absent or `undefined` -> `{ ok: true, options: [] }`
   - not an array -> `'ask_user "options" must be an array'`
   - `length > MAX_ASK_USER_OPTIONS` -> `` `ask_user accepts at most ${MAX_ASK_USER_OPTIONS} options` ``
   - an entry that is not an object, or whose `id`/`label` is missing, not a string, or empty after trimming -> `'each ask_user option needs a non-empty string "id" and "label"'`
   - a repeated `id` -> `` `duplicate ask_user option id: ${id}` ``
   - otherwise map each entry to `{ id: id.trim(), label: label.trim(), ...(detail string && non-empty ? { detail } : {}) }`.

   Finally extend the module's top-of-file JSDoc block with a bullet for the new tool, in the same voice as the others:
   `- \`ask_user(question, options?, allow_free_text?, placeholder?)\` (neither mutating nor dispatch) — ask the user a question through the intervention seam and return their answer as the tool result. The call blocks until the card is answered; a decline (including Stop) comes back as a refusal.` Also extend the existing "Each tool declares the orchestrator phases it belongs to" paragraph to say `ask_user` is available in both phases.

   Files: `src/orchestrator/controlTools.ts`

2. Document the `intervention` seam as `ask_user`'s dependency in toolServices.ts

   No type changes are needed — `ToolServices.intervention?: InterventionSeam` already exists from T01/T07. Update its JSDoc so the contract names its first direct consumer:

   ```
     /**
      * The human-in-the-loop seam every richer ask goes through (question /
      * confirm / permission). `ask_user` asks through it directly; `confirm`
      * above is the narrow yes/no adapter over the same seam
      * (`confirmSeamFrom`). Optional so a host that has not wired the chat still
      * builds a registry — `ask_user` then reports itself unavailable, and a host
      * that supplies only `confirm` keeps working unchanged.
      */
   ```
   Also add `ask_user` to the bullet list in the interface's leading doc comment (the `- \`confirm\` — ...` block) so the bundle's documentation lists the seam's users.

   Files: `src/orchestrator/toolServices.ts`

3. Add `ask_user` guidance to the system prompt

   In `src/orchestrator/systemPrompt.ts`:

   1. Add an exported const next to `SCOPE_TEXT`/`REFUSAL_TEXT` (exported so the test can assert it verbatim and so it can be reused):
   ```ts
   /**
    * When and how to use `ask_user` (the intervention seam's question tool). A
    * question typed into a reply ends the turn and leaves the user to restart it;
    * a question asked through `ask_user` keeps the turn alive and comes back as a
    * tool result.
    */
   export const ASK_USER_TEXT = [
     'When you need an answer from the user, call `ask_user` instead of ending your turn with a question.',
     '- `ask_user` shows the question as a card in the chat and blocks until the user answers; their answer comes back as the tool result, so the turn continues.',
     '- Offer `options` when the useful answers are a short closed set. Each option needs a stable `id` and a short `label`; add `detail` only when the label is not enough.',
     '- Set `allow_free_text` when a typed answer is also useful. A question with no options is always answered by typing.',
     '- Ask one question per call and wait for the answer before asking the next.',
     '- If the user declines the question, the call refuses: treat it like any other refusal — quote it and stop.',
   ].join('\n');
   ```
   2. Include it in every phase, right after the refusal rule, inside `buildSystemPrompt`:
   `const sections: string[] = [ROLE_TEXT, SCOPE_TEXT, REFUSAL_TEXT, ASK_USER_TEXT];`
   3. Amend the last `STYLE_TEXT` bullet so the style rule points at the tool, keeping the existing wording the tests match (`/one clarifying question at a time/i`):
   `'- Ask one clarifying question at a time with `ask_user`, and wait for the answer before asking the next.'`
   4. Extend the module JSDoc's list of what the prompt always states to mention the `ask_user` rule ("...how to treat a tool refusal (Req 11.1), when to ask through `ask_user` rather than ending the turn, ...").

   Files: `src/orchestrator/systemPrompt.ts`

4. Wire the intervention seam into the real host's ToolServices

   Without this, `ask_user` is registered but always answers 'ask_user is not available in this host'. In `src/activation/commands.ts`:

   1. Add a parameter to `buildToolServices` (declared around line 1343) after `confirm`:
   `  intervention: InterventionSeam,`
   and include `intervention,` in the returned object literal (next to `confirm,`). Import the type: add `InterventionSeam` to the existing import from `../orchestrator/interventions` (the file already imports `PendingAskRegistry`, `createInterventionSeam`, `confirmSeamFrom`, `PresentIntervention`, `Intervention` from there); use `import type` if the existing import line is type-only.
   2. Update its JSDoc to say the bundle also carries the intervention seam itself, which `ask_user` asks through.
   3. Pass `interventionSeam` at both call sites (around lines 307–316 for `draftServices`, and line 333 inside `createToolRegistry({ ...buildToolServices(...) })`): append `interventionSeam` as the new last argument after `confirm`.

   Change nothing else in commands.ts — the registry, the modal fallback and `presentThroughModal` already handle a `question` ask (it declines with 'the Baiton chat view is not open' before the chat view resolves, which `ask_user` surfaces as its refusal).

   Files: `src/activation/commands.ts`

5. Extend test/registry.controlTools.test.ts for `ask_user`

   1. Add `'ask_user'` to the `EXPECTED_TOOLS` array (in the control-tools group) and to BOTH arrays of `EXPECTED_PHASE_TOOLS` (`gather` and `drive`) so the existing 'advertises exactly the expected tools' / 'advertises exactly the tools of each phase' assertions cover it.
   2. Add a recording intervention seam helper next to `recordingConfirm`:
   ```ts
   /** An intervention seam that records the requests it received and answers a fixed answer. */
   function recordingIntervention(answer: InterventionAnswer): {
     seam: InterventionSeam;
     calls: InterventionRequest[];
   } {
     const calls: InterventionRequest[] = [];
     return {
       calls,
       seam: {
         ask: async (request: InterventionRequest): Promise<InterventionAnswer> => {
           calls.push(request);
           return answer;
         },
       },
     };
   }
   ```
   importing `InterventionAnswer`, `InterventionRequest`, `InterventionSeam` from `'../src/orchestrator/interventions'`.
   3. Give `makeServices` an extra trailing optional parameter `intervention?: InterventionSeam` and spread it in the same conditional style as `draftSpec`: `...(intervention !== undefined ? { intervention } : {})`. Existing call sites are unchanged.
   4. Add a `describe('ask_user', () => { ... })` block with these cases, each building the registry over `throwingGit()` (the tool must touch no git) and calling `registry.call('ask_user', args, 'call-ask-N', makeGuard(repo), 'gather')`:
      - forwards an option question to the seam and returns the chosen option: options `[{ id: 'a', label: 'Option A' }, { id: 'b', label: 'Option B' }]`, seam answers `{ kind: 'option', optionId: 'b' }`; assert `result.ok === true`, `result.data` deep-equals `{ answer: 'option', optionId: 'b', label: 'Option B' }`, and `calls[0]` deep-equals `{ kind: 'question', prompt: '<question>', options: [...] }` (no `options` key transformation, no `allowFreeText` when not supplied).
      - returns a typed answer for a free-text question: no `options`, seam answers `{ kind: 'text', text: 'ship it' }`; assert data `{ answer: 'text', text: 'ship it' }` and that `calls[0]` has NO `options` property (`assert.ok(!('options' in calls[0]))`) so `checkAnswer` would accept text.
      - passes `allow_free_text` and `placeholder` through as `allowFreeText`/`placeholder`.
      - a decline is a refusal: seam answers `{ kind: 'declined', reason: 'the run was stopped' }`; assert `result.ok === false` and `assert.match(result.error, /the run was stopped/)`.
      - without a wired seam (`makeServices(repo, throwingGit(), recordingConfirm(true))`, no intervention): `result.ok === false` and `assert.match(result.error, /not available in this host/)`.
      - rejects an empty/missing question before the seam: two calls (`{}` and `{ question: '   ' }`); both `ok === false`, and `calls.length === 0`.
      - rejects malformed options before the seam: an option missing `label`, a duplicate `id`, a non-array `options`, and nine options; each `ok === false` with `calls.length === 0`.
      - is callable without an idempotency key (it is non-mutating): call with `undefined` as the `callId` argument and assert it still reaches the seam (`calls.length === 1`).
      - is available while driving: same successful call with phase `'drive'` returns `ok === true`.
      Extend the file's top JSDoc coverage list with a line for `ask_user`.

   Files: `test/registry.controlTools.test.ts`

6. Extend test/systemPrompt.test.ts for the ask_user guidance

   Import `ASK_USER_TEXT` from `'../src/orchestrator/systemPrompt'` and add a `describe('ask_user guidance', () => { ... })` block:
   - for each of the four prompts already built in the `scope` block's `PROMPTS` table shape (workspace, draft spec, approved spec, spec with no content), assert `prompt.includes(ASK_USER_TEXT)` so the guidance is present verbatim in both phases;
   - assert `assert.match(ASK_USER_TEXT, /instead of ending your turn with a question/i)`;
   - assert `ASK_USER_TEXT.includes('`ask_user`')` and that it mentions `options`, `allow_free_text` and that the call blocks until the user answers;
   - assert the decline-is-a-refusal line: `assert.match(ASK_USER_TEXT, /declines/i)` plus `/refus/i`;
   - assert the style bullet still names the tool: `assert.match(buildSystemPrompt(WORKSPACE), /one clarifying question at a time with `ask_user`/i)`.
   Extend the file's top JSDoc coverage list with an `ask_user` line.

   Files: `test/systemPrompt.test.ts`

7. Compile, lint and run the suite

   Run `npm run compile`, `npm run lint` and `npm test` from the repo root; all three must pass. The T07 baseline was 920 passing / 1 pending / 0 failing, so expect roughly 935 passing once the new registry and prompt cases land — and in particular confirm no pre-existing case regressed (the `advertises exactly the expected tools`, `advertises exactly the tools of each phase`, `every registered tool belongs to at least one phase`, and the style-guidance prompt tests are the ones this todo's edits touch).

   Files: (none)

## Risks

- The registry's 'advertises exactly the expected tools' and 'advertises exactly the tools of each phase' assertions are exact-set comparisons, so adding `ask_user` fails those existing tests until `EXPECTED_TOOLS` and both `EXPECTED_PHASE_TOOLS` entries are updated in the same change.
- `ask_user` must NOT set `dispatch: true`. The guard disables every dispatch tool under Restricted Mode (Req 22.2), and asking the user a question launches nothing — marking it dispatch would silently remove the orchestrator's only way to ask a question in an untrusted workspace.
- `QuestionRequest.options` must be omitted entirely (not set to `[]`) for a free-text question: `checkAnswer` accepts a text answer when `allowFreeText === true` OR `options` is absent/empty, and an accidental non-empty options array would make every typed answer invalid.
- `ToolServices.intervention` is optional, so `ask_user` compiles and registers even when no host wired the seam. Without the commands.ts wiring step the tool is registered but permanently answers 'not available in this host' — the todo looks done while doing nothing.
- The seam call is unbounded: `ask_user` blocks until the card is answered. Stop already settles every pending ask as declined through `PendingAskRegistry.rejectAll` (T01/T07), so the decline branch is the only path back — it must return `ok: false`, not a success with an empty answer, or the model will treat a stopped run as an answered question.
- Before the Chat_View resolves, `presentThroughModal` in commands.ts declines `question` asks outright (there is no modal question form). That is the intended fallback, but it means an `ask_user` call made from a tree-triggered flow with no chat open refuses rather than prompting; do not try to widen it in this todo.
- Changing the `STYLE_TEXT` clarifying-question bullet risks breaking the existing `/one clarifying question at a time/i` assertion — keep that exact phrase in the amended line.

## Acceptance

- `npm run compile`, `npm run lint` and `npm test` all pass, with no previously passing case failing.
- `createToolRegistry(...).names()` includes `ask_user`, and `definitionsFor('gather')` and `definitionsFor('drive')` both advertise it.
- The registered `ask_user` tool has `mutating === false`, no `dispatch` flag, `phases` equal to `['gather', 'drive']`, and a description of at least 10 characters that differs from its name (so `assembleToolSpecs` accepts it).
- Calling `ask_user` with a question and options forwards a `{ kind: 'question', prompt, options }` request to `ToolServices.intervention.ask` and returns `{ ok: true, data: { answer: 'option', optionId, label } }` for an option answer.
- Calling `ask_user` with no options forwards a request with no `options` key and returns `{ ok: true, data: { answer: 'text', text } }` for a typed answer.
- A declined answer (including the Stop-driven `rejectAll` decline) returns `{ ok: false, error }` whose message carries the decline reason.
- A missing/empty `question`, a non-array `options`, an option missing `id` or `label`, a duplicate option `id`, more than eight options, and a non-boolean `allow_free_text` each return `{ ok: false, error }` without the seam being called once.
- With no `intervention` in `ToolServices`, `ask_user` returns an error naming that it is not available in this host, and no other tool's behaviour changes.
- `buildSystemPrompt` includes `ASK_USER_TEXT` verbatim for a workspace conversation, a draft spec, an approved spec and a spec with no content, and that text tells the model to call `ask_user` instead of ending its turn with a question.
- `src/activation/commands.ts` passes the shared `interventionSeam` into both `buildToolServices` call sites, so the registry built for the real host can reach the seam.
