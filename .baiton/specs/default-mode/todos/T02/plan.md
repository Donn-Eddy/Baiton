# Plan T02

## Steps

1. Refuse mode 'default' in RunPipeline.start

   In src/engine/runPipeline.ts, RunPipeline.start step 1 (around line 319-326) currently reads `if (req.mode === 'spec' || !isSpecless(req.mode)) { return refuse({ kind: 'invalid-mode', message: 'mode "spec" has no run pipeline: a spec conversation dispatches draft_spec' }); }`. Since T01 made isSpecless('default') true, this no longer catches 'default'. Keep the existing spec branch byte-identical (same condition and same message), and add a second check immediately after it, before the busy check: `if (req.mode === 'default') { return refuse({ kind: 'invalid-mode', message: 'mode "default" has no run pipeline: Default recommends a mode and dispatches it with start_run or investigate, or a spec conversation dispatches draft_spec' }); }`. The message must contain the literal substring `draft_spec` and `"default"`. Update the step-1 comment to say that neither 'spec' nor 'default' is ever a run ('default' is spec-less per isSpecless but only recommends a concrete mode). Also update the RunPipelineRequest.mode doc comment (line ~100) from `never 'spec'` to `never 'spec' or 'default'`, and the composerMode comment may note it can be 'default'. Do not touch RunPipelineRefusal (reuse kind 'invalid-mode').

   Files: `src/engine/runPipeline.ts`

2. Refuse mode 'default' in RunStore.create

   In src/engine/runStore.ts RunStore.create (around line 557-564), after the existing `if (input.mode === 'spec') { return err({ kind: 'invalid-id', runId: input.id, message: 'mode "spec" has no run manifest: a spec conversation dispatches draft_spec, not a run.' }); }` block (leave it unchanged), add: `if (input.mode === 'default') { return err({ kind: 'invalid-id', runId: input.id, message: 'mode "default" has no run manifest: Default dispatches the picked mode (start_run or investigate), and a spec conversation dispatches draft_spec, not a run.' }); }`. Same error kind as the spec refusal ('invalid-id', since RunStoreError has no invalid-mode kind — verify by reading the RunStoreError union and reuse whatever kind the spec refusal uses). Message must contain `draft_spec`. Update the create() doc comment 'refusing a bad id, a spec mode, or a re-create' to 'refusing a bad id, a spec or default mode, or a re-create'. Update the NewRunInput / RunManifest field comments: `mode` 'never `spec`' -> 'never `spec` or `default`'; `composerMode` may note it can be `default` (the composer's Mode control).

   Files: `src/engine/runStore.ts`

3. Reject 'default' as manifest mode but accept it as composerMode in parseRunManifest

   parseRunManifest lives in src/engine/runStore.ts (around line 397-405), not in controlTools.ts. After the existing `if (raw.mode === 'spec') { return err('mode "spec" has no run manifest'); }` (leave unchanged), add `if (raw.mode === 'default') { return err('mode "default" has no run manifest'); }`. Leave the composerMode check (`isRunMode(raw.composerMode)`) unchanged: since T01 made isRunMode('default') true, composerMode 'default' already parses; do NOT add any composerMode restriction. serializeRunManifest, isRunId, runBranchFor are untouched.

   Files: `src/engine/runStore.ts`

4. controlTools.ts: comment only, no behaviour change

   In src/orchestrator/controlTools.ts, RUN_TOOL_MODES (line ~910) must stay exactly ['bug', 'quick', 'refactor'] and the start_run schema enum (line ~309) must stay unchanged; start_run already rejects 'default' because it is not in RUN_TOOL_MODES. Only update the RUN_TOOL_MODES doc comment to: 'The three build modes `start_run` accepts. `investigate` is dispatched by its own tool, `spec` is the spec pipeline, and `default` only recommends one of these modes, so none of them is accepted here.' Do not change the start_run error message text (tests may pin it). If you prefer zero edits here, that is acceptable; do not alter any runtime logic in this file.

   Files: `src/orchestrator/controlTools.ts`

5. Add runPipeline test for the 'default' refusal

   In test/runPipeline.test.ts, next to the existing `it('refuses mode "spec"', ...)` (line ~1019), add `it('refuses mode "default"', async () => { const h = track(makeHarness()); const refused = await h.pipeline.start(bugRequest({ mode: 'default' })); assert.strictEqual(refused.ok, false); if (!refused.ok) { assert.strictEqual(refused.error.kind, 'invalid-mode'); assert.match(refused.error.message, /draft_spec/); assert.match(refused.error.message, /default/); } assert.ok(!fs.existsSync(path.join(h.root, '.baiton', 'runs'))); });`. Also add a test that a dispatch from Default records composerMode 'default': reuse the pattern of an existing successful-start test (e.g. the one using bugRequest() then h.settle(...)), or minimally: `const h = track(makeHarness()); const started = await h.pipeline.start(bugRequest({ composerMode: 'default', explicitMode: true })); assert.ok(started.ok); ` then assert `started.manifest.mode === 'bug'`, `started.manifest.composerMode === 'default'`, `started.manifest.explicitMode === true`, `started.runId.startsWith('bug-')` (only if the harness's newRunId is the default one — check makeHarness; if it injects a fixed RUN_ID, instead assert manifest.branch === `baiton/bug/${started.runId}`), read `<runDir>/run.json` via parseRunManifest (import from '../src/engine/runStore' if not already imported) and assert it parses ok with composerMode 'default'. Then drive the run to completion or cancel it the way sibling tests do (e.g. `await h.settle(0, PLAN_RESULT); await h.settle(1, EXECUTE_RESULT); await h.settle(2, REVIEW_PASS); await started.completed;` or `h.pipeline.cancel()` + await completed) so no stage is left dangling. Leave the existing spec test unchanged.

   Files: `test/runPipeline.test.ts`

6. Add runStore tests for create refusal and manifest parsing

   In test/runStore.test.ts: (a) In describe('create'), add `it('refuses a default mode, writing nothing', () => { const d = store.create(inputFor('r1', { mode: 'default' })); assert.ok(!d.ok); assert.strictEqual(d.error.kind, 'invalid-id'); assert.match(d.error.message, /draft_spec/); assert.strictEqual(fs.existsSync(path.join(root, '.baiton', 'runs')), false); });` (use the same error kind the implementation returns). Leave 'refuses a spec mode and a dotted id' unchanged. (b) Add `it('writes a valid run.json for a dispatch from Default', ...)`: `const created = store.create(inputFor('bug-20260926-141501-a1b2', { mode: 'bug', composerMode: 'default', explicitMode: true }));` assert ok, assert value.composerMode === 'default', value.explicitMode === true, value.mode === 'bug', value.branch === 'baiton/bug/bug-20260926-141501-a1b2'; then `parseRunManifest(fs.readFileSync(runManifestPathFor(root, id), 'utf8'))` is ok and deepStrictEqual to created.value; and store.read(id) ok. (c) In describe('read') 'classifies a bad shape as invalid', add the case `'default mode': { ...base, mode: 'default' }` to the cases record. (d) Add in describe('read') `it('accepts composerMode default', () => { const base = validManifest(); writeRaw('r1', JSON.stringify({ ...base, composerMode: 'default', explicitMode: true }, null, 2) + '\n'); const read = store.read('r1'); assert.ok(read.ok); assert.strictEqual(read.value.composerMode, 'default'); assert.strictEqual(read.value.explicitMode, true); });` and optionally assert parseRunManifest directly on that text is ok.

   Files: `test/runStore.test.ts`

7. Verify

   Run `npx tsc -p ./ --noEmit` (the only pre-existing error expected is TS2741 in src/orchestrator/systemPrompt.ts RUN_FLOW_TEXT missing a 'default' key, owned by a later todo; no new errors in the touched files). Run `TS_NODE_TRANSPILE_ONLY=true npx mocha` (the .mocharc runs the whole suite) and confirm every test in test/runPipeline.test.ts and test/runStore.test.ts passes, including the new ones. Pre-existing failures in chatController/webviewProtocol/systemPrompt tests from T01 are out of scope; note them but do not fix.

   Files: (none)

## Risks

- isSpecless('default') is true after T01, so the existing `req.mode === 'spec' || !isSpecless(req.mode)` guard does NOT catch 'default'; an explicit `req.mode === 'default'` check is required.
- The spec refusal messages and conditions must stay byte-identical (Spec-mode behaviour unchanged); add new branches rather than editing the spec ones.
- RunStoreError may not have an 'invalid-mode' kind; the spec refusal in create uses 'invalid-id', so the default refusal should reuse that kind unless the union offers a better fit — do not widen the union.
- parseRunManifest must keep accepting composerMode 'default'; accidentally applying the new mode check to composerMode would break Default dispatches' run.json.
- The runPipeline success-path test must fully settle or cancel the run, otherwise the harness may leak an in-flight stage into later tests; copy the settle sequence from an existing passing bug-run test. If makeHarness injects a fixed run id, assert the branch/mode rather than the id prefix.
- Plain `npx mocha` fails to type-check due to the systemPrompt.ts RUN_FLOW_TEXT gap from T01; use TS_NODE_TRANSPILE_ONLY=true.
- RUN_TOOL_MODES and the start_run schema enum must not change; the controlTools edit is comment-only.

## Acceptance

- RunPipeline.start({ mode: 'default', ... }) returns { ok: false } with error.kind 'invalid-mode' and a message containing 'draft_spec', and writes nothing under .baiton/runs.
- RunStore.create({ mode: 'default', ... }) returns an error (same kind as the spec refusal) whose message contains 'draft_spec', and writes nothing.
- parseRunManifest rejects a manifest with mode 'default' (store.read classifies it 'invalid') and accepts one with composerMode 'default'.
- A run created with mode 'bug', composerMode 'default', explicitMode true writes a run.json that parseRunManifest reads back deepStrictEqual, with branch baiton/bug/<id>.
- Existing spec refusal tests in test/runPipeline.test.ts and test/runStore.test.ts pass unmodified.
- RUN_TOOL_MODES, the start_run schema enum, serializeRunManifest, isRunId and runBranchFor are unchanged.
- `TS_NODE_TRANSPILE_ONLY=true npx mocha` shows all runPipeline and runStore tests passing; `npx tsc -p ./ --noEmit` introduces no errors beyond the known systemPrompt.ts RUN_FLOW_TEXT gap.
