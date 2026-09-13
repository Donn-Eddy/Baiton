/**
 * The adapter boundary and the single first-pass Claude adapter (probe,
 * per-role launch args, continue flag). The adapter owns only launch args, the
 * probe and the continue flag — nothing else (Requirement 14.1).
 */
export * from './adapter';
export * from './permissions';
export * from './claude';
