/**
 * Activation and workspace resolution (task 15.1; Requirements 22.3–22.8, 23.3,
 * 14.5).
 *
 * These are the pure cores the activation sequence is built from — the
 * engine-version guard, the workspace resolver, the agent-executable
 * resolver, and the model-discovery service that refreshes every catalog
 * source on window reload — each taking injected inputs (a reported version
 * string, a folder list + trust flag, a PATH lookup + settings-override seam,
 * a catalog store + adapter registry) so they are unit-testable without a VS
 * Code host (task 15.3). The thin `vscode`-backed shell that reads the real
 * host state and calls these cores lives in `src/extension.ts`.
 */
export * from './engineVersion';
export * from './workspace';
export * from './executable';
export * from './modelDiscovery';
