/**
 * Per-slug serialized plan-branch writer. Document state, artifacts and phase
 * journals are committed only beneath that document's resolved folder.
 */
import type { GitWorktreeService } from '../git';
import { resolveDocument, type DocumentLocation } from '../storage/documentLocation';

export interface PlanBranchWriterDeps {
  /** Absolute `.baiton` directory of the MAIN checkout. */
  baitonDir: string;
  git: Pick<GitWorktreeService, 'commitPaths'>;
}

export interface PlanWriteScope {
  readonly slug: string;
  readonly dir: string;
  readonly location: DocumentLocation;
  commit(message: string, trailers?: Record<string, string>): Promise<string>;
}

export interface PlanBranchWriter {
  apply<T>(slug: string, fn: (scope: PlanWriteScope) => Promise<T> | T): Promise<T>;
}

export function planFolderPathspec(location: DocumentLocation): string {
  return location.pathspec;
}

export function createPlanBranchWriter(deps: PlanBranchWriterDeps): PlanBranchWriter {
  const tails = new Map<string, Promise<void>>();
  const scopeFor = (slug: string): PlanWriteScope => {
    const location = resolveDocument(deps.baitonDir, slug);
    return {
      slug,
      dir: location.dir,
      location,
      commit: (message, trailers) =>
        deps.git.commitPaths([planFolderPathspec(location)], message, trailers),
    };
  };

  return {
    apply<T>(slug: string, fn: (scope: PlanWriteScope) => Promise<T> | T): Promise<T> {
      const prev = tails.get(slug) ?? Promise.resolve();
      // Resolve after prior queued work so a newly created document selects its
      // location before the next callback stages or writes anything.
      const run = prev.then(() => fn(scopeFor(slug)));
      const tail = run.then(() => undefined, () => undefined);
      tails.set(slug, tail);
      void tail.then(() => {
        if (tails.get(slug) === tail) tails.delete(slug);
      });
      return run;
    },
  };
}
