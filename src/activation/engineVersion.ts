/**
 * Engine-version guard (Requirement 23.2, 23.3; design "Activation / host").
 *
 * The extension declares a minimum supported VS Code engine of 1.96.0 and no
 * maximum bound (Req 23.2). When loaded in a host reporting a version below
 * that minimum, activation must refuse and surface a message naming the minimum
 * required version (Req 23.3).
 *
 * The comparison is kept as a pure function that takes the reported version
 * string and the minimum string as injected inputs — it does not read
 * `vscode.version` itself — so it is unit-testable without a VS Code host
 * (task 15.3). The thin `vscode`-backed shell in `extension.ts` reads the real
 * `vscode.version` and calls {@link engineVersionAtLeast}.
 */

/** The minimum VS Code engine version the extension supports (Req 23.2). */
export const MINIMUM_VSCODE_VERSION = '1.96.0';

/**
 * A parsed semantic version reduced to its numeric `major.minor.patch` core.
 * Any pre-release/build suffix (e.g. `-insider`) is dropped before comparison
 * because the host may report an insiders build such as `1.96.0-insider`.
 */
interface SemVer {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parse the leading `major.minor.patch` numbers out of a version string,
 * tolerating a missing patch (`1.96` → `1.96.0`) and any suffix after the core
 * (`1.96.0-insider` → `1.96.0`). Returns `undefined` when no leading numeric
 * major can be read at all, so the caller can decide how to treat an
 * unparseable version.
 */
function parseSemVer(version: string): SemVer | undefined {
  const match = /^\s*(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(version);
  if (match === null) {
    return undefined;
  }
  return {
    major: Number(match[1]),
    minor: match[2] !== undefined ? Number(match[2]) : 0,
    patch: match[3] !== undefined ? Number(match[3]) : 0,
  };
}

/** Numeric compare of two parsed versions: negative / zero / positive. */
function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) {
    return a.major - b.major;
  }
  if (a.minor !== b.minor) {
    return a.minor - b.minor;
  }
  return a.patch - b.patch;
}

/**
 * Whether `version` is greater than or equal to `minimum` under
 * `major.minor.patch` semantics (Req 23.3). Pre-release/build suffixes on
 * either side are ignored — an insiders build of the minimum version counts as
 * meeting it.
 *
 * An unparseable `version` (no leading numeric major) is treated as **not**
 * meeting the minimum: activation should refuse rather than run on a host whose
 * version it cannot verify.
 */
export function engineVersionAtLeast(version: string, minimum: string): boolean {
  const have = parseSemVer(version);
  const need = parseSemVer(minimum);
  if (need === undefined) {
    // A malformed minimum is a programming error; treat nothing as meeting it.
    return false;
  }
  if (have === undefined) {
    return false;
  }
  return compareSemVer(have, need) >= 0;
}

/**
 * The message surfaced when the host is below the minimum (Req 23.3). Names the
 * minimum required version and the version actually reported so the user can
 * see the gap.
 */
export function unsupportedEngineMessage(
  version: string,
  minimum: string = MINIMUM_VSCODE_VERSION,
): string {
  return (
    `Baiton requires VS Code ${minimum} or newer, but this host reports ` +
    `${version.trim().length > 0 ? version.trim() : 'an unknown version'}. ` +
    `The extension will not activate.`
  );
}
