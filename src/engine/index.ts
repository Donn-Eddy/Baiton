/**
 * Stage engine: brief writer, terminal launcher (task 10.1), result watcher and
 * validation-to-artifact flow (task 10.2), the pure state-machine transition
 * table and the serialized run queue + stage lifecycle (task 11.1), and crash
 * recovery over the journal (task 11.2).
 */
export * from './roleInstructions';
export * from './brief';
export * from './terminalHost';
export * from './launcher';
export * from './resultWatcher';
export * from './resultValidation';
export * from './resultFlow';
export * from './transitions';
export * from './stageContext';
export * from './runQueue';
export * from './recovery';
export * from './specDraft';
export * from './prTool';
export * from './submitPr';
