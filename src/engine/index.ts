/**
 * Stage engine: brief writer, terminal launcher (task 10.1), result watcher and
 * validation-to-artifact flow (task 10.2), the pure state-machine transition
 * table and the serialized run queue + stage lifecycle (task 11.1), crash
 * recovery over the journal (task 11.2), the ask-relay file protocol, the per-mode run
 * brief context builder for plan-less runs, and the
 * run manifest store for plan-less runs (`.baiton/runs/<run-id>/run.json`) and
 * the run worktree lifecycle (`.baiton/worktrees/<run-id>/` create, merge and
 * remove), the per-phase worktree lifecycle (`.baiton/worktrees/<slug>/<phase-id>/` on
 * `baiton-phase/<slug>/<phase-id>` (legacy specs use `baiton-todo/`): create/reuse,
 * land into the plan branch, remove, unlanded listing), the per-slug serialized
 * plan-branch writer (state, artifact and journal writes to the document folder in
 * the main checkout, committed path-scoped), and the plan-less run pipeline itself (plan -> execute -> review in
 * the run's own worktree, plus the read-only investigate dispatch).
 */
export * from './roleInstructions';
export * from './brief';
export * from './terminalHost';
export * from './launcher';
export * from './askRelay';
export * from './resultWatcher';
export * from './resultValidation';
export * from './resultFlow';
export * from './transitions';
export * from './stageContext';
export * from './runContext';
export * from './runQueue';
export * from './planBranchWriter';
export * from './recovery';
export * from './planDraft';
export * from './runStore';
export * from './runWorktree';
export * from './phaseWorktree';
export * from './runPipeline';
export * from './prTool';
export * from './submitPr';
