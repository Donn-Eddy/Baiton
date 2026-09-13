/**
 * Workspace resolution (Requirements 22.3–22.8; design "Activation and
 * workspace resolution").
 *
 * On activation the extension must decide which single folder it operates on:
 *
 *   - a single-folder workspace → that folder (Req 22.3);
 *   - a multi-root workspace with exactly one root containing a `.baiton/`
 *     directory → that root (Req 22.4);
 *   - zero or more than one qualifying root → refuse, surfacing that exactly
 *     one `.baiton/` root is required (Req 22.5).
 *
 * The design's signature is `resolveWorkspace(): Result<WorkspaceContext,
 * WorkspaceError>` reading `vscode.workspace.workspaceFolders` and
 * `vscode.workspace.isTrusted` directly. To keep the decision unit-testable
 * without a VS Code host (task 15.3), the core here takes the folder list and
 * the trust flag as **injected inputs**: a list of {@link WorkspaceFolder}
 * descriptors (each carrying an opaque `uri` and a `hasBaitonDir` flag the
 * shell computes) plus a `trusted` boolean. The thin `vscode`-backed shell in
 * `extension.ts` reads the real `workspaceFolders`, probes each for a
 * `.baiton/` directory, reads `isTrusted`, and calls {@link resolveWorkspace}.
 *
 * The `Uri` type is a generic parameter so the pure core carries no dependency
 * on `vscode`; the shell instantiates it with `vscode.Uri`.
 */
import { Result, ok, err } from '../model/result';

/**
 * A workspace-folder descriptor handed to {@link resolveWorkspace}. `uri` is
 * opaque to the core (any value the shell wants to carry through, typically a
 * `vscode.Uri`); `hasBaitonDir` is whether that folder contains a `.baiton/`
 * directory, which the shell determines by a filesystem check (Req 22.4).
 */
export interface WorkspaceFolder<TUri> {
  /** The folder's location, carried through opaquely to the result. */
  readonly uri: TUri;
  /** Whether this folder contains a `.baiton/` directory (Req 22.4). */
  readonly hasBaitonDir: boolean;
}

/**
 * The resolved workspace the extension operates on (design "WorkspaceContext").
 * `baitonDir` is the `.baiton/` directory under `root`; the shell derives it by
 * joining `root` with `.baiton`. `restricted` mirrors VS Code Restricted Mode:
 * when true, all write tools and stage dispatch are disabled (Req 22.1, 22.2).
 */
export interface WorkspaceContext<TUri> {
  /** The single workspace root the extension operates on. */
  readonly root: TUri;
  /** `<root>/.baiton`, derived by the shell. */
  readonly baitonDir: TUri;
  /** VS Code Restricted Mode: true disables writes and dispatch (Req 22.1, 22.2). */
  readonly restricted: boolean;
}

/**
 * Why workspace resolution failed (Req 22.5). Both variants carry a user-facing
 * `message` indicating that exactly one `.baiton/` root is required.
 *
 * - `no-folder`   — no workspace folder is open at all.
 * - `no-baiton-root` — a multi-root workspace with zero roots containing a
 *   `.baiton/` directory.
 * - `multiple-baiton-roots` — a multi-root workspace with more than one root
 *   containing a `.baiton/` directory; `count` reports how many.
 */
export type WorkspaceError =
  | { kind: 'no-folder'; message: string }
  | { kind: 'no-baiton-root'; message: string }
  | { kind: 'multiple-baiton-roots'; count: number; message: string };

/** The guidance every resolution failure surfaces (Req 22.5). */
const ONE_ROOT_REQUIRED = 'Baiton requires exactly one workspace root containing a .baiton/ directory.';

/**
 * Resolve the single workspace root the extension operates on (Req 22.3–22.5).
 *
 * Rules, in order:
 *   1. No folders open → `no-folder`.
 *   2. Exactly one folder → operate on it regardless of `.baiton/` presence
 *      (Req 22.3); the config-load step decides whether it is initialized.
 *   3. Multi-root → operate on the single root containing `.baiton/`
 *      (Req 22.4); refuse on zero (`no-baiton-root`) or more than one
 *      (`multiple-baiton-roots`) qualifying root (Req 22.5).
 *
 * `restricted` is carried straight into the {@link WorkspaceContext} so the
 * caller can gate writes and dispatch (Req 22.1, 22.2). `makeBaitonDir` derives
 * `<root>/.baiton` from the chosen root's `uri`; the shell passes a joiner over
 * `vscode.Uri`.
 */
export function resolveWorkspace<TUri>(
  folders: readonly WorkspaceFolder<TUri>[],
  trusted: boolean,
  makeBaitonDir: (root: TUri) => TUri,
): Result<WorkspaceContext<TUri>, WorkspaceError> {
  if (folders.length === 0) {
    return err({
      kind: 'no-folder',
      message: `No workspace folder is open. ${ONE_ROOT_REQUIRED}`,
    });
  }

  // A single-folder workspace: operate on that folder (Req 22.3). Whether it is
  // actually initialized is the config-load step's concern, not resolution's.
  if (folders.length === 1) {
    return ok(context(folders[0].uri, makeBaitonDir, trusted));
  }

  // Multi-root: exactly one root must contain a `.baiton/` directory (Req 22.4).
  const qualifying = folders.filter((f) => f.hasBaitonDir);
  if (qualifying.length === 0) {
    return err({
      kind: 'no-baiton-root',
      message: `No workspace root contains a .baiton/ directory. ${ONE_ROOT_REQUIRED}`,
    });
  }
  if (qualifying.length > 1) {
    return err({
      kind: 'multiple-baiton-roots',
      count: qualifying.length,
      message:
        `${qualifying.length} workspace roots contain a .baiton/ directory. ${ONE_ROOT_REQUIRED}`,
    });
  }

  return ok(context(qualifying[0].uri, makeBaitonDir, trusted));
}

/** Build a {@link WorkspaceContext} for a chosen root. */
function context<TUri>(
  root: TUri,
  makeBaitonDir: (root: TUri) => TUri,
  trusted: boolean,
): WorkspaceContext<TUri> {
  return {
    root,
    baitonDir: makeBaitonDir(root),
    restricted: !trusted,
  };
}
