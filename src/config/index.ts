/**
 * Config service: the configuration data model, the default config the
 * Initialize command writes, the `.baiton/` scaffolding (Requirement 1), and
 * the Config Panel's host-free form protocol and document I/O.
 * The `loadConfig` load/validate/migrate path lands in task 5.1.
 */
export * from './types';
export * from './loadConfig';
export * from './defaultConfig';
export * from './gitignore';
export * from './initialize';
export * from './configPanel';
export * from './configDocument';
