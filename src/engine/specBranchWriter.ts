/**
 * The per-slug serialized spec-branch writer.
 *
 * Spec state (`spec.md`), persisted stage artifacts and per-todo journals are
 * written only in the main checkout, on the spec branch, through one writer per
 * slug. {@link SpecBranchWriter.apply} runs its callback under an async FIFO
 * lock keyed by slug, so concurrent writers for two todos of one spec are
 * applied one after another, each on freshly re-read content. Commits are
 * path-scoped via `commitPaths` to the spec folder, so they never sweep
 * unrelated working-tree changes.
 *
 * Host-free: no `vscode`; only `path` and the git types.
 */
import * as path from 'path';
import type { GitWorktreeService } from '../git';

export interface SpecBranchWriterDeps {
  /** Absolute `.baiton/specs/` directory of the MAIN checkout. */
  specsDir: string;
  /** Git bound to the main checkout; only `commitPaths` is used. */
  git: Pick<GitWorktreeService, 'commitPaths'>;
}

/** What a callback running under the slug's lock may do. */
export interface SpecWriteScope {
  readonly slug: string;
  /** Absolute spec folder `<specsDir>/<slug>`. */
  readonly dir: string;
  /**
   * Commit ONLY the spec folder: `commitPaths([specFolderPathspec(slug)], message, trailers)`.
   * Rejects like `commitPaths` (nothing to commit, git failure).
   */
  commit(message: string, trailers?: Record<string, string>): Promise<string>;
}

export interface SpecBranchWriter {
  /**
   * Run `fn` under the slug's lock; resolves/rejects with `fn`'s own result. A
   * rejection releases the lock and never poisons later calls. Different slugs
   * never wait on each other.
   */
  apply<T>(slug: string, fn: (scope: SpecWriteScope) => Promise<T> | T): Promise<T>;
}

/** `.baiton/specs/<slug>` — the repo-relative pathspec of a spec folder (forward slashes). */
export function specFolderPathspec(slug: string): string {
  return `.baiton/specs/${slug}`;
}

export function createSpecBranchWriter(deps: SpecBranchWriterDeps): SpecBranchWriter {
  const tails = new Map<string, Promise<void>>();
  return {
    apply<T>(slug: string, fn: (scope: SpecWriteScope) => Promise<T> | T): Promise<T> {
      const scope: SpecWriteScope = {
        slug,
        dir: path.join(deps.specsDir, slug),
        commit: (message, trailers) =>
          deps.git.commitPaths([specFolderPathspec(slug)], message, trailers),
      };
      const prev = tails.get(slug) ?? Promise.resolve();
      const run = prev.then(() => fn(scope));
      const tail = run.then(
        () => undefined,
        () => undefined,
      );
      tails.set(slug, tail);
      void tail.then(() => {
        if (tails.get(slug) === tail) {
          tails.delete(slug);
        }
      });
      return run;
    },
  };
}
