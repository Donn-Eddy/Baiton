/**
 * Activation and workspace resolution (task 15.1; Requirements 22.3–22.8, 23.3,
 * 14.5).
 *
 * These are the pure cores the activation sequence is built from — the
 * engine-version guard, the workspace resolver, and the agent-executable
 * resolver — each taking injected inputs (a reported version string, a folder
 * list + trust flag, a PATH lookup + settings-override seam) so they are
 * unit-testable without a VS Code host (task 15.3). The thin `vscode`-backed
 * shell that reads the real host state and calls these cores lives in
 * `src/extension.ts`.
 */
export * from './engineVersion';
export * from './workspace';
export * from './executable';
