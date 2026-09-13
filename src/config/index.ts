/**
 * Config service: the configuration data model, the default config the
 * Initialize command writes, and the `.baiton/` scaffolding (Requirement 1).
 * The `loadConfig` load/validate/migrate path lands in task 5.1.
 */
export * from './types';
export * from './loadConfig';
export * from './defaultConfig';
export * from './gitignore';
export * from './initialize';
