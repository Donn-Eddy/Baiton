# Plan T10

## Steps

1. guard.ts: add ToolSurface, ToolCaller, caller on ToolContext, subagent flag on Tool

   In src/orchestrator/guard.ts:
   1. Add `import type { ConversationKind } from './systemPrompt';` (type-only, so the systemPrompt -> guard import does not become a runtime cycle).
   2. After ORCHESTRATOR_PHASES add:
   ```ts
   /** Who is asking for the tool surface: a top-level chat, or a sub-agent chat a parent spawned. A sub-agent sees only the read tools, ask_user, run (drive phase) and the two spawn tools; only a top-level chat finishes a spec. */
   export type ToolSurface = 'top' | 'subagent';
   export const TOOL_SURFACES: readonly ToolSurface[] = ['top', 'subagent'] as const;

   /** The chat making a tool call, so a tool (spawn_subagent, send_to_subagent) knows who is calling. depth is 0 for a top-level chat, 1 for its sub-agent, 2 for a sub-agent's sub-agent. */
   export interface ToolCaller {
     sessionKey: string;
     depth: number;
     phase: OrchestratorPhase;
     kind: ConversationKind;
     signal: AbortSignal;
   }
   ```
   3. Extend `ToolContext` with an optional `caller?: ToolCaller;` and document it in the interface's doc comment (absent when the host does not say, e.g. existing direct calls such as commands.ts approve_spec).
   4. Extend `Tool` with `subagent?: boolean;` documented as: 'Whether a sub-agent chat may see and call this tool (in the phases it lists). Unset means top-level only, so a new tool never leaks onto the sub-agent surface by default. Read tools are sub-agent tools by origin (the registry marks them), so they do not set it.' Do not change guardTool.

   Files: `src/orchestrator/guard.ts`

2. seams.ts: SubAgentSeam, request/outcome types and MAX_SUBAGENT_DEPTH

   In src/orchestrator/seams.ts add `import type { ToolCaller } from './guard';` and, after the LandTodo block, add:
   ```ts
   /** The deepest a sub-agent may nest: a top-level chat is depth 0, its sub-agent 1, that sub-agent's sub-agent 2. A caller already at this depth cannot spawn. */
   export const MAX_SUBAGENT_DEPTH = 2;

   export interface SpawnSubAgentRequest { task: string; caller: ToolCaller; }
   export type SpawnSubAgentOutcome =
     | { kind: 'replied'; chatId: string; reply: string }
     | { kind: 'refused'; reason: string };

   export interface SendToSubAgentRequest { chatId: string; message: string; caller: ToolCaller; }
   export type SendToSubAgentOutcome =
     | { kind: 'replied'; reply: string }
     | { kind: 'refused'; reason: string };

   /** The seam spawn_subagent and send_to_subagent go through. The sub-agent runner implements it: spawn creates the child chat, runs its first turn and resolves with its final assistant text; send re-enters the child's loop with a follow-up and resolves with that turn's final text. */
   export interface SubAgentSeam {
     spawn(req: SpawnSubAgentRequest): Promise<SpawnSubAgentOutcome>;
     send(req: SendToSubAgentRequest): Promise<SendToSubAgentOutcome>;
   }
   ```
   Add a `{@link SubAgentSeam}` bullet to the module doc comment.

   Files: `src/orchestrator/seams.ts`

3. toolServices.ts: optional subAgents seam

   Import `SubAgentSeam` from './seams' and add to ToolServices, after `landTodo`:
   ```ts
   /** The seam spawn_subagent and send_to_subagent go through. Optional so a host that has not wired sub-agents still builds a registry; both tools then report themselves unavailable. */
   subAgents?: SubAgentSeam;
   ```
   Add a matching `- subAgents` bullet to the ToolServices doc comment.

   Files: `src/orchestrator/toolServices.ts`

4. controlTools.ts: spawn_subagent and send_to_subagent tools; mark ask_user and run as sub-agent tools

   In src/orchestrator/controlTools.ts:
   1. Import `MAX_SUBAGENT_DEPTH` from './seams'.
   2. Add `subagent: true` to askUserTool and runTool (run keeps `phases: ['drive']`, so a sub-agent only sees it while driving). Do NOT add it to draft_spec, start_run, investigate, approve_spec, land_todo or submit_pr.
   3. Append `spawnSubAgentTool(services)` and `sendToSubAgentTool(services)` to the array in createControlTools (after submitPrTool).
   4. spawnSubAgentTool:
   ```ts
   name: 'spawn_subagent',
   description: 'Start a sub-agent chat to do one task and wait for its first reply. The sub-agent has its own tool loop and transcript; returns its chat id (for send_to_subagent) and its reply.',
   mutating: false,
   concurrent: true,
   subagent: true,
   phases: ['gather', 'drive', 'run'],
   schema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'], additionalProperties: false },
   ```
   run(args, tc): `const task = readString(args, 'task')`; undefined or blank after trim -> `{ ok:false, error: 'spawn_subagent requires a non-empty string "task"' }`. Then `const caller = tc.caller`; undefined -> `{ ok:false, error: 'spawn_subagent needs a calling chat; it is not available here' }`. Then depth cap BEFORE the seam: `if (caller.depth >= MAX_SUBAGENT_DEPTH) return { ok:false, error: subAgentDepthRefusal(caller.depth) }`. Then `services.subAgents === undefined` -> `'spawn_subagent is not available in this host'`. Then `const outcome = await services.subAgents.spawn({ task: task.trim(), caller })`; map `replied` -> `{ ok:true, data: { chatId: outcome.chatId, reply: outcome.reply } }`, `refused` -> `{ ok:false, error: `the sub-agent did not start: ${outcome.reason}` }`, default -> 'spawn_subagent returned an unknown outcome'.
   Export the message builder so tests and the runner share it:
   ```ts
   export function subAgentDepthRefusal(depth: number): string {
     return `spawn_subagent refused: sub-agents may nest at most ${MAX_SUBAGENT_DEPTH} levels deep (MAX_SUBAGENT_DEPTH = ${MAX_SUBAGENT_DEPTH}) and this chat is already at depth ${depth}. Do the task yourself or report back to your parent.`;
   }
   ```
   5. sendToSubAgentTool:
   ```ts
   name: 'send_to_subagent',
   description: 'Send a follow-up message to a sub-agent chat you started with spawn_subagent and wait for its reply.',
   mutating: false, concurrent: true, subagent: true,
   phases: ['gather', 'drive', 'run'],
   schema: { type: 'object', properties: { chat_id: { type: 'string' }, message: { type: 'string' } }, required: ['chat_id', 'message'], additionalProperties: false },
   ```
   run: read `chat_id` and `message` with readString; either missing/blank -> `'send_to_subagent requires a non-empty string "chat_id" and "message"'`; no tc.caller -> `'send_to_subagent needs a calling chat; it is not available here'`; no seam -> `'send_to_subagent is not available in this host'`; `await services.subAgents.send({ chatId: chatId.trim(), message: message.trim(), caller })`; `replied` -> `{ ok:true, data: { reply } }`, `refused` -> `{ ok:false, error: `sub-agent "${chatId}" did not answer: ${reason}` }`.
   6. Update the module doc comment: list both tools, note they are on every phase and on both surfaces, and that ask_user/run plus the read tools are the only other sub-agent tools.

   Files: `src/orchestrator/controlTools.ts`

5. registry.ts: surface axis on definitionsFor / assembleFor / call

   In src/orchestrator/registry.ts:
   1. Import `ToolCaller` and `ToolSurface` from './guard'.
   2. Add `subagent: boolean` to the private RegisteredTool interface. In the constructor build `const reads = createReadTools(services)` separately; register read tools with `subagent: true` (sub-agent tools by origin) and spec-write + control tools with `subagent: tool.subagent === true`.
   3. Add a private helper `private onSurface(entry: RegisteredTool, surface: ToolSurface): boolean { return surface === 'top' || entry.subagent; }`.
   4. `definitionsFor(phase: OrchestratorPhase, surface: ToolSurface = 'top'): Tool[]` -> iterate `this.registered.values()` in registration order, keep entries where `entry.tool.phases.includes(phase) && this.onSurface(entry, surface)`, map to `entry.tool`. The default keeps every existing caller (commands.ts specsForPhase, chatController) unchanged.
   5. `assembleFor(phase, surface: ToolSurface = 'top')` -> `assembleToolSpecs(this.definitionsFor(phase, surface))`.
   6. `call(name, args, callId, ctx, phase, surface: ToolSurface = 'top', caller?: ToolCaller)`: after the unknown-tool and phase checks add `if (!this.onSurface(entry, surface)) return { ok:false, error: `tool "${name}" is not available to a sub-agent; only the top-level chat may use it` };` (refused before the guard and before run). Then `return entry.guardedRun(args, { callId, ctx, ...(caller !== undefined ? { caller } : {}) });`.
   7. Update the module and method doc comments: a sub-agent surface is the read tools, ask_user, run (drive only) and spawn_subagent/send_to_subagent within the current phase; never draft_spec, approve_spec, submit_pr, land_todo, start_run, investigate or the spec-write tools.
   No other src file needs to change: chatController.callTool keeps calling with 5 args (top surface, no caller) until the runner/controller todo wires caller and surface.

   Files: `src/orchestrator/registry.ts`

6. systemPrompt.ts: buildSubAgentPrompt and its text constants

   In src/orchestrator/systemPrompt.ts import `MAX_SUBAGENT_DEPTH` from './seams'. Leave buildSystemPrompt and every existing constant byte-for-byte unchanged. Add exported constants:
   ```ts
   export const SUBAGENT_ROLE_TEXT = [
     'You are a Baiton sub-agent: a chat another Baiton chat started to do one task for it.',
     'Do the task you were given, then report back concisely: lead with the result, then only the detail your parent needs to act on it.',
     'You never finish a spec. You do not draft, approve, land or submit; only the top-level chat does that, and those tools are not yours.',
     'You never edit source code and you write nothing yourself. You inspect the repository only through the read tools you have been given.',
   ].join('\n');

   export const SUBAGENT_DRIVE_TEXT = [
     'Your parent is driving an approved spec. When your task is to move a todo forward, dispatch the next legal stage with `run`:',
     '- `pending` -> `run` the `plan` stage.',
     '- `planned` -> `run` the `execute` stage.',
     '- `executed` -> `run` the `review` stage.',
     '- A review that sends the todo back -> `run` the `execute` stage again.',
     '- `done` -> stop and report; landing it with `land_todo` is your parent\'s job.',
     '`run` blocks until the stage finishes and returns its outcome; there is nothing to poll afterwards.',
   ].join('\n');

   export function subAgentSpawnText(depth: number): string { ... }
   ```
   subAgentSpawnText: when `depth < MAX_SUBAGENT_DEPTH` return `You may start your own sub-agents with \`spawn_subagent\` and follow up with \`send_to_subagent\`. You are at depth ${depth}; sub-agents nest at most ${MAX_SUBAGENT_DEPTH} deep.`; otherwise return `You may not start sub-agents: you are at depth ${depth}, the most sub-agents may nest (${MAX_SUBAGENT_DEPTH}). \`spawn_subagent\` will refuse; do the work yourself.`
   Then:
   ```ts
   export function buildSubAgentPrompt(
     kind: ConversationKind,
     phase: OrchestratorPhase,
     depth: number,
     specContent?: string,
   ): string {
     const sections = [SUBAGENT_ROLE_TEXT, PROHIBITION_LINES.join('\n'), REFUSAL_TEXT, ASK_USER_TEXT];
     if (phase === 'drive') sections.push(SUBAGENT_DRIVE_TEXT);
     sections.push(subAgentSpawnText(depth), STYLE_TEXT);
     if (kind.kind === 'spec' && specContent !== undefined) {
       sections.push(['Current spec file content:', '', specContent].join('\n'));
     }
     return sections.join('\n\n');
   }
   ```
   The phase is passed in (the parent's phase), not derived, so a sub-agent of a run-phase conversation never sees the drive table. Add a module-doc paragraph describing buildSubAgentPrompt. Do not mention SCOPE_TEXT/DRIVE_TEXT/FLOW_TEXT in it (they name draft_spec/land_todo/submit_pr which a sub-agent lacks).

   Files: `src/orchestrator/systemPrompt.ts`

7. Update registry.controlTools tests for the new tools and add surface + spawn tests

   In test/registry.controlTools.test.ts:
   1. Add 'spawn_subagent' and 'send_to_subagent' to EXPECTED_TOOLS (control tools section) and to every phase list in EXPECTED_PHASE_TOOLS (gather, drive, run).
   2. Extend makeServices with a trailing optional `subAgents?: SubAgentSeam` param spread in like runPipeline. Add a `recordingSubAgents(spawnOutcome, sendOutcome)` helper recording `spawnCalls` / `sendCalls` and answering fixed outcomes. Add a `makeCaller(depth: number, phase: OrchestratorPhase = 'gather'): ToolCaller` helper ({ sessionKey: 'chat-1', depth, phase, kind: { kind: 'workspace' }, signal: new AbortController().signal }).
   3. New `describe('sub-agent surface', ...)` with:
    - EXPECTED_SUBAGENT_TOOLS: Record<OrchestratorPhase,string[]> = gather: the 8 read tools + ask_user, spawn_subagent, send_to_subagent; drive: list_specs, read_spec, git_status, ask_user, run, spawn_subagent, send_to_subagent; run: the 8 read tools + ask_user, spawn_subagent, send_to_subagent. Assert `registry.definitionsFor(phase, 'subagent')` names (sorted) equal it for every phase, and that `definitionsFor(phase)` equals `definitionsFor(phase, 'top')`.
    - for every phase and each of ['draft_spec','approve_spec','submit_pr','land_todo','start_run','investigate','update_overview','add_todo','edit_todo','remove_todo'], none appear on the subagent surface of any phase.
    - `registry.assembleFor(phase, 'subagent')` is ok and its names equal definitionsFor(phase,'subagent') in order.
    - `call('submit_pr', {slug}, 'id', guard, 'drive', 'subagent')` and `call('land_todo', ...)`, `call('draft_spec', ..., 'gather', 'subagent')`, `call('start_run', ..., 'run', 'subagent')` refuse with an error matching the tool name and /sub-agent/, using throwingGit + recording confirm/draft/pipeline to prove nothing ran (confirm.calls, draft.calls, pipeline.calls all 0; spec bytes unchanged).
    - `call('read_spec', {slug}, undefined, guard, phase, 'subagent')` succeeds in every phase.
   4. New `describe('spawn_subagent and send_to_subagent', ...)`:
    - spawn with caller depth 0 calls the seam once with `{ task: 'trimmed task', caller }` and returns data { chatId, reply }.
    - spawn from depth 2 (`makeCaller(MAX_SUBAGENT_DEPTH)`) refuses, error matches /2/ and /depth/ and equals subAgentDepthRefusal(2), seam never called; depth 1 is allowed.
    - spawn with blank task refuses before the seam; spawn with no caller (call without the caller arg) refuses before the seam; no seam wired -> /not available/.
    - seam `refused` maps to ok:false with the reason in the error.
    - send passes `{ chatId, message, caller }` and returns data { reply }; missing chat_id or message refuses before the seam; refused outcome maps to an error naming the chat id.
    - both tools are flagged `concurrent: true` and are not mutating (check via registry.definitions()).
    - spawn and send run on the subagent surface too: `call('spawn_subagent', {task}, 'c', guard, 'drive', 'subagent', makeCaller(1,'drive'))` reaches the seam.

   Files: `test/registry.controlTools.test.ts`

8. Update registry.assembleToolSpecs tests for per-surface assembly

   In test/registry.assembleToolSpecs.test.ts, inside 'per-phase assembly (Req 11.1)' add:
    - 'assembles the sub-agent surface of each phase as a subset of the top surface': for each ORCHESTRATOR_PHASES phase, `assembleFor(phase, 'subagent')` is ok, every name is in `assembleFor(phase)` names, the count is strictly smaller, specs match `definitionsFor(phase,'subagent')` in order, each description equals its tool's description.
    - 'the run phase advertises spawn_subagent and send_to_subagent on both surfaces' and that `run` (the tool) appears on the subagent surface only in drive.
    - a fakeTool-based check that `assembleToolSpecs` with a bad-description tool that is top-only does not block `assembleFor(.., 'subagent')` is not possible via the real registry, so skip it.
   The existing 'fewer tools than the whole registry' assertion stays valid (spawn tools are in every phase but draft_spec/start_run etc. are not).

   Files: `test/registry.assembleToolSpecs.test.ts`

9. New test/systemPrompt.subagent.test.ts

   Create test/systemPrompt.subagent.test.ts (mocha + assert, like test/systemPrompt.test.ts) importing buildSubAgentPrompt, SUBAGENT_ROLE_TEXT, SUBAGENT_DRIVE_TEXT, subAgentSpawnText, REFUSAL_TEXT, ASK_USER_TEXT, PROHIBITION_LINES, DRIVE_TEXT, SCOPE_TEXT from '../src/orchestrator/systemPrompt' and MAX_SUBAGENT_DEPTH from '../src/orchestrator/seams'. Cases:
    - every phase x depth in {0,1,2}: prompt includes SUBAGENT_ROLE_TEXT, REFUSAL_TEXT, ASK_USER_TEXT and each PROHIBITION_LINES entry; contains 'report back concisely' and 'You never finish a spec'.
    - drive phase includes SUBAGENT_DRIVE_TEXT ('`pending` -> `run` the `plan` stage.' etc.); gather and run phases do not include it.
    - never includes DRIVE_TEXT, SCOPE_TEXT, '`submit_pr`', '`draft_spec`' or 'offer to `submit_pr`' (a sub-agent cannot finish a spec), except the role line mentions land via plain words only — assert `!prompt.includes('`submit_pr`')` and `!prompt.includes('`draft_spec`')`.
    - depth 0 and 1 include '`spawn_subagent`' allowance text (subAgentSpawnText(d)) and 'You may start your own sub-agents'; depth MAX_SUBAGENT_DEPTH includes 'You may not start sub-agents' and the number 2, and does not include 'You may start your own sub-agents'.
    - spec kind with content appends 'Current spec file content:' followed by the content; spec kind without content and a workspace kind with content omit it; no throw when content is absent.
    - buildSystemPrompt output for a spec in drive is unchanged by this todo (spot-check it still contains DRIVE_TEXT and not SUBAGENT_ROLE_TEXT).

   Files: `test/systemPrompt.subagent.test.ts`

10. Verify

   Run `npm run compile`, `npm run lint`, `npm test`. Fix any other test that enumerates the full tool list or per-phase tool list (grep test/ for `'investigate',` lists and `definitionsFor(`) by adding the two spawn tools. Confirm `grep -rn "from 'vscode'" src/orchestrator` stays empty.

   Files: (none)

## Risks

- guard.ts imports ConversationKind from systemPrompt.ts while systemPrompt.ts imports guard.ts: use `import type` so it is erased at runtime; if lint complains, define the kind union structurally in guard.ts instead.
- The surface filter is an intersection with the phase: a drive-phase sub-agent only sees drive's read tools (list_specs, read_spec, git_status), not all eight. This matches 'tools declare phases as today' but if the reviewer reads the OVERVIEW as 'all read tools on every phase' the expected lists must change.
- Adding spawn_subagent/send_to_subagent to every phase changes the top-level tool surface: every test that pins exact per-phase or full tool lists (registry.controlTools EXPECTED_TOOLS / EXPECTED_PHASE_TOOLS, possibly integration.run-modes) must be updated or it fails.
- chatController and commands.ts are not in this todo's file list: they keep calling registry.call with 5 args, so caller is never set at the top level yet and spawn_subagent from a real chat refuses with 'needs a calling chat' until the runner/controller todo wires `caller` and `surface`. That is acceptable for T10 but should not be mistaken for a bug.
- spawn_subagent is not dispatch-flagged, so it stays available under Restricted Mode; the sub-agent's own run/dispatch tools are still guarded, so it can do nothing a restricted top-level chat could not.
- The depth check lives in the tool (before the seam); the later SubAgentRunner must use the same `subAgentDepthRefusal` / MAX_SUBAGENT_DEPTH to avoid divergent messages.

## Acceptance

- `ToolSurface = 'top' | 'subagent'` and `ToolCaller` are exported from src/orchestrator/guard.ts; `ToolContext.caller?` and `Tool.subagent?` exist.
- `ToolRegistry.definitionsFor(phase, surface = 'top')`, `assembleFor(phase, surface = 'top')` and `call(name, args, callId, ctx, phase, surface = 'top', caller?)` exist; existing 5-argument calls behave exactly as before.
- On the 'subagent' surface each phase advertises only read tools of that phase, ask_user, run (drive only), spawn_subagent and send_to_subagent; draft_spec, approve_spec, submit_pr, land_todo, start_run, investigate, update_overview, add_todo, edit_todo and remove_todo are never advertised and a call to them on that surface is refused before the guard and the tool run.
- spawn_subagent and send_to_subagent are registered on all three phases, non-mutating, concurrent: true, go through `ToolServices.subAgents` (SubAgentSeam), and return `{ chatId, reply }` / `{ reply }`.
- A spawn from a caller at depth >= MAX_SUBAGENT_DEPTH (2) is refused before the seam with a message naming the cap (2) and the caller's depth.
- `buildSubAgentPrompt(kind, phase, depth, specContent?)` in systemPrompt.ts states the sub-agent role (do the task, report concisely, never finish a spec), includes the run table only in drive, includes REFUSAL_TEXT and ASK_USER_TEXT, says whether it may spawn based on depth, and appends spec content for a spec kind when given; buildSystemPrompt output is unchanged.
- test/registry.assembleToolSpecs.test.ts, test/registry.controlTools.test.ts and new test/systemPrompt.subagent.test.ts cover surface filtering per phase, spawn/send behaviour including the depth refusal, and the prompt text.
- No `vscode` import under src/orchestrator; `npm run compile`, `npm run lint` and `npm test` all pass.
