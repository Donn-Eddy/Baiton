/**
 * The Initialize command's file scaffolding (Requirement 1).
 *
 * `initialize` creates the `.baiton/` layout — `config.json`, `.gitignore`, and
 * the `runs/` and `specs/` directories (Req 1.1, 1.2, 1.7) — under a workspace
 * root. It never overwrites an existing `config.json` (Req 1.3): when one is
 * present its contents are left untouched and only `.gitignore` (and the
 * directories) are ensured. On any write failure it rolls back exactly the
 * files and directories it created during this invocation and leaves a
 * pre-existing `config.json` unchanged (Req 1.5).
 *
 * To stay unit-testable without a VS Code host, the core takes the absolute
 * filesystem path of the `.baiton/` directory and uses node `fs`. The design's
 * `initialize(ctx: WorkspaceContext)` signature is provided by the thin
 * {@link initializeWorkspace} wrapper, which derives that path from the
 * workspace context. Both return a {@link Result} so callers surface success or
 * the failure branch explicitly (design "Pure cores, thin shells").
 */
import * as fs from 'fs/promises';
import * as path from 'path';
import { Result, err, ok } from '../model';
import { defaultConfigJson } from './defaultConfig';
import { GITIGNORE_CONTENTS } from './gitignore';

/**
 * What `initialize` accomplished on success.
 *
 * - `createdConfig`   — `true` when a new `config.json` was written; `false`
 *                       when one already existed and was left untouched (Req 1.3).
 * - `ensuredGitignore` — always `true` on success: `.gitignore` is written or
 *                       overwritten with the required exclusions regardless of
 *                       whether `config.json` pre-existed (Req 1.2, 1.3).
 */
export interface InitOutcome {
  createdConfig: boolean;
  ensuredGitignore: boolean;
}

/**
 * Why initialization failed. Every variant means the `.baiton/` tree was rolled
 * back to the files/directories that existed before this invocation, with any
 * pre-existing `config.json` left unchanged (Req 1.5).
 *
 * - `write-failed` — creating a directory or writing a file failed; `path`
 *   names the target that failed and `message` is user-facing.
 */
export type InitError = { kind: 'write-failed'; path: string; message: string };

/**
 * Tracks filesystem entries created during a single invocation so they can be
 * removed on failure. Directories are recorded deepest-last (in creation order)
 * so rollback can remove them in reverse — children before parents.
 */
interface CreatedTracker {
  files: string[];
  dirs: string[];
}

/**
 * Scaffolds the `.baiton/` layout at `baitonDir` (an absolute filesystem path).
 *
 * Order of operations, chosen so rollback is precise:
 * 1. Ensure `baitonDir`, `runs/` and `specs/` exist, recording only the
 *    directories this call actually created.
 * 2. Write `.gitignore` (Req 1.2), recording it if newly created.
 * 3. If `config.json` is absent, write the default (Req 1.1) and record it; if
 *    present, leave it untouched and report `createdConfig: false` (Req 1.3).
 *
 * On the first failure the tracker is unwound: created files are unlinked and
 * created directories removed in reverse creation order. A `config.json` that
 * existed before this call is never in the tracker, so it is never removed
 * (Req 1.5).
 */
export async function initialize(baitonDir: string): Promise<Result<InitOutcome, InitError>> {
  const created: CreatedTracker = { files: [], dirs: [] };

  const configPath = path.join(baitonDir, 'config.json');
  const gitignorePath = path.join(baitonDir, '.gitignore');
  const runsDir = path.join(baitonDir, 'runs');
  const specsDir = path.join(baitonDir, 'specs');

  try {
    // 1. Directories. `ensureDir` records only directories it actually creates,
    //    so a pre-existing `.baiton/` (or its subdirs) is never rolled back.
    await ensureDir(baitonDir, created);
    await ensureDir(runsDir, created);
    await ensureDir(specsDir, created);

    // 2. `.gitignore` is always ensured with the required exclusions, whether
    //    or not `config.json` already exists (Req 1.2, 1.3). Writing it fresh
    //    each time keeps the exclusions correct even if a stale copy existed.
    const gitignorePreexisted = await pathExists(gitignorePath);
    await fs.writeFile(gitignorePath, GITIGNORE_CONTENTS, 'utf8');
    if (!gitignorePreexisted) {
      created.files.push(gitignorePath);
    }

    // 3. `config.json` is written only when absent; an existing one is left
    //    byte-for-byte unchanged and reported as not created (Req 1.3).
    const configPreexisted = await pathExists(configPath);
    if (!configPreexisted) {
      await fs.writeFile(configPath, defaultConfigJson(), 'utf8');
      created.files.push(configPath);
    }

    return ok({ createdConfig: !configPreexisted, ensuredGitignore: true });
  } catch (cause) {
    // Any write failure rolls back this invocation's creations and preserves a
    // pre-existing config.json (Req 1.5). Rollback is best-effort: it must not
    // mask the original failure, so cleanup errors are swallowed.
    const failedPath = errorPath(cause) ?? baitonDir;
    await rollback(created);
    return err({
      kind: 'write-failed',
      path: failedPath,
      message: `failed to initialize .baiton/ layout: ${errorMessage(cause)}`,
    });
  }
}

/**
 * Creates `dir` if it does not already exist, recording it in `created` only
 * when this call actually created it. Uses a stat-then-create sequence rather
 * than `mkdir(recursive)` alone so the tracker reflects precisely what to roll
 * back — a directory that already existed is left out of the tracker and thus
 * never removed on failure (Req 1.5).
 */
async function ensureDir(dir: string, created: CreatedTracker): Promise<void> {
  if (await pathExists(dir)) {
    return;
  }
  await fs.mkdir(dir, { recursive: true });
  created.dirs.push(dir);
}

/** Whether a filesystem entry exists at `p`. */
async function pathExists(p: string): Promise<boolean> {
  try {
    await fs.stat(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes everything recorded in `created`, files first and then directories in
 * reverse creation order (children before parents). Best-effort: individual
 * removal failures are ignored so a partial rollback still returns the original
 * write failure to the caller.
 */
async function rollback(created: CreatedTracker): Promise<void> {
  for (const file of created.files) {
    try {
      await fs.rm(file, { force: true });
    } catch {
      // Ignore: rollback must not mask the original failure.
    }
  }
  for (let i = created.dirs.length - 1; i >= 0; i--) {
    try {
      await fs.rmdir(created.dirs[i]);
    } catch {
      // Ignore: a non-empty or already-removed directory is left as-is.
    }
  }
}

/** Extracts a user-facing message from an unknown thrown value. */
function errorMessage(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
}

/** Extracts the offending path from a node fs error, when present. */
function errorPath(cause: unknown): string | undefined {
  if (cause !== null && typeof cause === 'object' && 'path' in cause) {
    const p = (cause as { path?: unknown }).path;
    if (typeof p === 'string') {
      return p;
    }
  }
  return undefined;
}

/**
 * The minimal view of a `WorkspaceContext` the Initialize command needs: the
 * filesystem path of the `.baiton/` directory. The activation layer's full
 * `WorkspaceContext` (design "Activation") carries `baitonDir` as a
 * `vscode.Uri`, whose `fsPath` satisfies this shape — so the VS Code command
 * handler can pass its context straight through without this core depending on
 * the `vscode` module.
 */
export interface BaitonDirLike {
  baitonDir: { fsPath: string };
}

/**
 * Design-signature wrapper over {@link initialize}. Derives the `.baiton/`
 * filesystem path from the workspace context and delegates, so the VS Code
 * command handler calls `initializeWorkspace(ctx)` while the file logic stays
 * host-independent and unit-testable (Req 1.1–1.7).
 */
export function initializeWorkspace(ctx: BaitonDirLike): Promise<Result<InitOutcome, InitError>> {
  return initialize(ctx.baitonDir.fsPath);
}
