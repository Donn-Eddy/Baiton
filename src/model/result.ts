/**
 * A discriminated-union Result type used across all cores.
 *
 * Cores return `Result<T, E>` instead of throwing so callers must handle both
 * the success and the failure branch explicitly (see design "Pure cores, thin
 * shells").
 */
export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

/** Construct a success result. */
export function ok<T, E = never>(value: T): Result<T, E> {
  return { ok: true, value };
}

/** Construct a failure result. */
export function err<E, T = never>(error: E): Result<T, E> {
  return { ok: false, error };
}

/** Type guard narrowing a Result to its success branch. */
export function isOk<T, E>(r: Result<T, E>): r is { ok: true; value: T } {
  return r.ok;
}

/** Type guard narrowing a Result to its failure branch. */
export function isErr<T, E>(r: Result<T, E>): r is { ok: false; error: E } {
  return !r.ok;
}
