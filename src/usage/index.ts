/** Host-free usage core — see model.ts and usageService.ts. */
export * from './model';
export * from './usageService';
export * from './codex';
export * from './claude';
export * from './antigravity';
export * from './opencode';

// --- Reader table composition ------------------------------------------------
//
// The table is built lazily: constructing it resolves, spawns and reads nothing.
// Every effect arrives through UsageReaderTableSeams and runs only inside a read.

import { USAGE_TOOL_IDS, type UsageToolId } from './model';
import { type UsageReader, type UsageReadContext, redactSecrets } from './usageService';
import { createClaudeUsageReader } from './claude';
import { createCodexUsageReader, CODEX_USAGE_APP_SERVER_SUBCOMMAND, type CodexUsageProcess } from './codex';
import { createAntigravityUsageReader, ANTIGRAVITY_USAGE_BIN } from './antigravity';
import { createOpencodeGoUsageReader } from './opencode';

/** CLI names the readers run; resolution maps each to a path. */
export type UsageCliName = 'claude' | 'codex' | 'agy';
export interface UsageCommandResult {
  readonly code: number | null;
  readonly stdout: string;
}
export interface UsageFetchResponse {
  readonly status: number;
  readonly body: unknown;
  readonly headers?: Record<string, string>;
}
export type UsageFetchJson = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<UsageFetchResponse>;
export type UsageCredentialRead = () => Promise<string | undefined>;

/** Every external surface of the four readers. A seam left out skips that route. */
export interface UsageReaderTableSeams {
  /** Resolves a CLI (settings override, then PATH) to an executable path, or undefined when not installed. Called only inside a read. */
  readonly resolveExecutable?: (cli: UsageCliName) => string | undefined;
  /** Runs `<executable> <args>` without a shell, from a neutral cwd, killed on signal/timeout. */
  readonly runCommand?: (
    executable: string,
    args: readonly string[],
    signal: AbortSignal,
    timeoutMs: number,
  ) => Promise<UsageCommandResult>;
  /** Spawns `<executable> <args>` with piped stdio from a neutral cwd (codex app-server). */
  readonly spawnProcess?: (executable: string, args: readonly string[]) => CodexUsageProcess;
  /** Text of the newest Codex rollout-*.jsonl, undefined when none. */
  readonly readCodexLatestRollout?: (signal: AbortSignal) => Promise<string | undefined>;
  /** One read-only GET; used only by the credential fallbacks. */
  readonly fetchJson?: UsageFetchJson;
  /** Stored-credential readers; never invoked unless isTrusted() is true. */
  readonly credentials?: {
    readonly claude?: UsageCredentialRead;
    readonly codex?: UsageCredentialRead;
    readonly opencodeGo?: UsageCredentialRead;
  };
  /** Live workspace-trust flag. Default () => false (fail closed). */
  readonly isTrusted?: () => boolean;
  /** Diagnostics; every message is passed through redactSecrets. */
  readonly log?: (message: string) => void;
}

/** The CLI each tool's command route runs (opencode-go has none). */
export const USAGE_TOOL_CLI: Readonly<Partial<Record<UsageToolId, UsageCliName>>> = {
  claude: 'claude',
  codex: 'codex',
  antigravity: ANTIGRAVITY_USAGE_BIN as UsageCliName,
};

const RESTRICTED_CREDENTIAL_MESSAGE = 'Restricted Mode: Baiton does not read stored credentials.';

/** Builds the per-tool reader table in USAGE_TOOL_IDS order. Calls no seam. */
export function createUsageReaders(seams: UsageReaderTableSeams = {}): Readonly<Record<UsageToolId, UsageReader>> {
  const isTrusted = (): boolean => {
    try {
      return seams.isTrusted?.() === true;
    } catch {
      return false;
    }
  };
  const log = (message: string): void => {
    try {
      seams.log?.(redactSecrets(message));
    } catch {
      // diagnostics must never throw
    }
  };
  const notFound = (cli: string): Error =>
    Object.assign(new Error(`${cli} was not found on PATH`), { code: 'ENOENT' });
  const resolve = (cli: UsageCliName): string | undefined => {
    if (!seams.resolveExecutable) return cli;
    try {
      const p = seams.resolveExecutable(cli);
      return typeof p === 'string' && p.trim() ? p.trim() : undefined;
    } catch {
      return undefined;
    }
  };
  const runCliFor = (cli: UsageCliName) => {
    const run = seams.runCommand;
    if (!run) return undefined;
    return async (args: readonly string[], signal: AbortSignal, timeoutMs: number): Promise<UsageCommandResult> => {
      const exe = resolve(cli);
      if (!exe) throw notFound(cli);
      return run(exe, args, signal, timeoutMs);
    };
  };
  const spawn = seams.spawnProcess;
  const spawnCodexAppServer = spawn
    ? (): CodexUsageProcess => {
        const exe = resolve('codex');
        if (!exe) throw notFound('codex');
        return spawn(exe, [CODEX_USAGE_APP_SERVER_SUBCOMMAND]);
      }
    : undefined;
  const guardCredential = (read?: UsageCredentialRead): UsageCredentialRead | undefined =>
    read
      ? async () => {
          if (!isTrusted()) throw new Error(RESTRICTED_CREDENTIAL_MESSAGE);
          return read();
        }
      : undefined;
  const fetchSeam = seams.fetchJson;
  const guardedFetch: UsageFetchJson | undefined = fetchSeam
    ? async (url, init) => {
        if (!isTrusted()) throw new Error(RESTRICTED_CREDENTIAL_MESSAGE);
        return fetchSeam(url, init);
      }
    : undefined;
  const withTrust =
    (reader: UsageReader): UsageReader =>
    (ctx: UsageReadContext) =>
      reader({ ...ctx, trusted: ctx.trusted === true && isTrusted() });

  const build: Record<UsageToolId, () => UsageReader> = {
    claude: () =>
      createClaudeUsageReader({
        runCli: runCliFor('claude'),
        readCredentials: guardCredential(seams.credentials?.claude),
        fetchJson: guardedFetch,
        log,
      }),
    codex: () =>
      createCodexUsageReader({
        spawnAppServer: spawnCodexAppServer,
        readLatestRollout: seams.readCodexLatestRollout,
        readAuthFile: guardCredential(seams.credentials?.codex),
        fetchJson: guardedFetch,
        log,
      }),
    antigravity: () => createAntigravityUsageReader({ runCli: runCliFor('agy'), log }),
    'opencode-go': () =>
      createOpencodeGoUsageReader({
        readAuthFile: guardCredential(seams.credentials?.opencodeGo),
        fetchJson: guardedFetch,
        log,
      }),
  };

  const table = {} as Record<UsageToolId, UsageReader>;
  for (const tool of USAGE_TOOL_IDS) table[tool] = withTrust(build[tool]());
  return Object.freeze(table);
}
