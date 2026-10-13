/**
 * The pull/merge-request tool seam (design section 8, "PR"), provider
 * agnostic. The submit flow needs two operations — find an open request for a
 * head branch, and create one — and a read-only state lookup used to derive
 * plan completion, so {@link PrTool} stays small. Two backends ship, both
 * driving the vendor's CLI: `gh` for GitHub and `glab` for GitLab.
 * `config.pr.tool` picks one, or `auto` detects it from the remote URL. The
 * executable is resolved from a settings override, then PATH, then the usual
 * install directories the extension host's PATH often lacks (Homebrew,
 * `~/.local/bin`).
 */
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

/** An existing or newly created pull/merge request. */
export interface PullRequest {
  /** The request's web URL; recorded as the plan's `pr:` frontmatter value. */
  url: string;
  /** The request number (GitHub) or iid (GitLab) when the tool reports it. */
  number?: number;
}

/** One repo's PR as reported to the user or orchestrator. */
export interface RepoPullRequest {
  repo: string;
  pr: PullRequest;
  reused: boolean;
}

/** One repo whose push or PR creation failed. */
export interface RepoPrFailureReport {
  repo: string;
  message: string;
}

/** Render each repo's PR and each failure on its own line. */
export function describeRepoPrs(
  prs: readonly RepoPullRequest[],
  failures: readonly RepoPrFailureReport[] = [],
): string {
  const label = (repo: string): string => repo === '.' ? '(root)' : repo;
  return [
    ...prs.map(({ repo, pr, reused }) => `${label(repo)}: ${pr.url}${reused ? ' (reused)' : ''}`),
    ...failures.map(({ repo, message }) => `${label(repo)}: failed — ${message}`),
  ].join('\n');
}

/** Serialize per-repo PR URLs as one-line JSON in the supplied key order. */
export function formatPrsValue(prs: readonly { repo: string; url: string }[]): string {
  return JSON.stringify(Object.fromEntries(prs.map(({ repo, url }) => [repo, url])));
}

/** Parse a `prs:` value, ignoring malformed data and non-string values. */
export function parsePrsValue(raw: string | undefined): Map<string, string> {
  if (raw === undefined || raw.trim() === '') return new Map();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return new Map();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return new Map();
  return new Map(Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

/** What {@link PrTool.create} needs. */
export interface CreatePrInput {
  base: string;
  head: string;
  title: string;
  body: string;
}

/** A failed tool invocation, carrying the command and its stderr. */
export interface PrToolError {
  command: string;
  exitCode: number | undefined;
  stderr: string;
}

/** A request's lifecycle state as read from the provider; `unknown` when it cannot be established. */
export type PrState = 'open' | 'merged' | 'closed' | 'unknown';

export interface PrTool {
  /** The open request whose head is `branch`, or `undefined` when none. */
  findOpenByHead(branch: string): Promise<PullRequest | undefined>;
  /** Create a request; resolves it, rejects with a {@link PrToolError}. */
  create(input: CreatePrInput): Promise<PullRequest>;
  /**
   * The state of the request at `url`. Never rejects: an unparsable URL, a CLI
   * failure (missing executable, offline, non-zero exit) or unrecognised output
   * all resolve `'unknown'`. Optional so hand-written fakes need not implement
   * it; callers treat an absent method as `'unknown'`.
   */
  stateByUrl?(url: string): Promise<PrState>;
}

/** The supported providers, named after their CLIs. */
export type PrProviderKind = 'gh' | 'glab';
export const PR_PROVIDERS: readonly PrProviderKind[] = ['gh', 'glab'] as const;

/** A recorded request URL split into what the CLIs' `--repo` flags and view commands need. */
export interface ParsedPrUrl {
  kind: PrProviderKind;
  host: string;
  repoPath: string;
  number: number;
}

/** Parse a GitHub pull-request or GitLab merge-request URL; `undefined` otherwise. */
export function parsePrUrl(url: string): ParsedPrUrl | undefined {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(url.trim());
  } catch {
    return undefined;
  }
  if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
    return undefined;
  }

  const segments = parsedUrl.pathname.replace(/\/$/, '').split('/').filter((part) => part.length > 0);
  const gitlabIndex = segments.findIndex((part, index) => part === '-' && segments[index + 1] === 'merge_requests');
  if (gitlabIndex >= 1 && gitlabIndex + 2 === segments.length - 1 && /^\d+$/.test(segments[gitlabIndex + 2])) {
    const number = Number(segments[gitlabIndex + 2]);
    if (number > 0 && Number.isFinite(number)) {
      return {
        kind: 'glab',
        host: parsedUrl.host,
        repoPath: segments.slice(0, gitlabIndex).join('/'),
        number,
      };
    }
    return undefined;
  }

  if (segments.length === 4 && segments[2] === 'pull' && /^\d+$/.test(segments[3])) {
    const number = Number(segments[3]);
    if (segments[0].length > 0 && segments[1].length > 0 && number > 0 && Number.isFinite(number)) {
      return { kind: 'gh', host: parsedUrl.host, repoPath: `${segments[0]}/${segments[1]}`, number };
    }
  }
  return undefined;
}

/** `gh pr view --json state` output → PrState: OPEN/MERGED/CLOSED (case-insensitive); anything else unknown. */
export function parseGhPrState(stdout: string): PrState {
  const state = parseStateField(stdout);
  return state === 'open' || state === 'merged' || state === 'closed' ? state : 'unknown';
}

/** `glab mr view --output json` output → PrState: opened→open, merged, closed and locked→closed; anything else unknown. */
export function parseGlabMrState(stdout: string): PrState {
  const state = parseStateField(stdout);
  if (state === 'opened') return 'open';
  if (state === 'merged') return 'merged';
  if (state === 'closed' || state === 'locked') return 'closed';
  return 'unknown';
}

function parseStateField(stdout: string): string | undefined {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined;
  const state = (parsed as Record<string, unknown>).state;
  return typeof state === 'string' ? state.toLowerCase() : undefined;
}

/** The `config.pr.tool` value: a provider, or `auto` to detect from the remote. */
export type PrToolSelection = PrProviderKind | 'auto';
export const DEFAULT_PR_TOOL: PrToolSelection = 'auto';

export function isPrToolSelection(value: string): value is PrToolSelection {
  return value === 'auto' || (PR_PROVIDERS as readonly string[]).includes(value);
}

/**
 * Pick the provider for a remote URL: any host containing `gitlab` is GitLab,
 * everything else (github.com, GitHub Enterprise, unknown) is GitHub. Self-
 * hosted GitLab on an unrelated hostname needs `pr.tool: "glab"` explicitly.
 */
export function detectProvider(remoteUrl: string): PrProviderKind {
  const host = remoteHost(remoteUrl).toLowerCase();
  return host.includes('gitlab') ? 'glab' : 'gh';
}

/** The host part of an https, ssh:// or scp-style (`git@host:path`) remote URL. */
export function remoteHost(remoteUrl: string): string {
  const trimmed = remoteUrl.trim();
  const scheme = /^[a-z+]+:\/\/(?:[^@/]+@)?([^/:]+)/i.exec(trimmed);
  if (scheme) {
    return scheme[1];
  }
  const scp = /^(?:[^@/]+@)?([^/:]+):/.exec(trimmed);
  return scp ? scp[1] : '';
}

/** Resolve `auto` against the remote; pass a concrete provider through. */
export function selectProvider(selection: PrToolSelection, remoteUrl: string): PrProviderKind {
  return selection === 'auto' ? detectProvider(remoteUrl) : selection;
}

/**
 * Directories searched for a provider CLI after PATH. The extension host is
 * often launched from a desktop session whose PATH lacks the shell's
 * additions, so a `gh` installed by Homebrew is invisible to it.
 */
export function fallbackExecutableDirs(home: string = os.homedir()): string[] {
  return [
    path.join(home, '.local', 'bin'),
    '/home/linuxbrew/.linuxbrew/bin',
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
  ];
}

export interface ResolveExecutableOptions {
  /** A settings override: an explicit path or a bare name; empty means unset. */
  override?: string;
  /** The PATH to search; defaults to the process environment's. */
  pathEnv?: string;
  /** Extra directories searched after PATH; defaults to {@link fallbackExecutableDirs}. */
  fallbackDirs?: string[];
  /** Existence + executability check; defaults to a real `fs` check. */
  isExecutable?: (candidate: string) => boolean;
}

/**
 * Find the provider CLI. An override that is a path is used as-is when it is
 * executable; a bare name (override or the provider's own) is searched across
 * PATH, then the fallback directories. Returns `undefined` when nothing matches.
 */
export function resolveProviderExecutable(
  kind: PrProviderKind,
  options: ResolveExecutableOptions = {},
): string | undefined {
  const isExecutable = options.isExecutable ?? isExecutableFile;
  const override = (options.override ?? '').trim();
  if (override.length > 0 && (override.includes('/') || override.includes(path.sep))) {
    return isExecutable(override) ? path.resolve(override) : undefined;
  }
  const name = override.length > 0 ? override : kind;
  const pathDirs = (options.pathEnv ?? process.env.PATH ?? '')
    .split(path.delimiter)
    .filter((d) => d.length > 0);
  const dirs = [...pathDirs, ...(options.fallbackDirs ?? fallbackExecutableDirs())];
  const exts = process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      if (isExecutable(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function isExecutableFile(candidate: string): boolean {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isFile()) {
      return false;
    }
    if (process.platform !== 'win32') {
      fs.accessSync(candidate, fs.constants.X_OK);
    }
    return true;
  } catch {
    return false;
  }
}

/** Runs the provider CLI; injectable so tests can pin the argument shapes. */
export type CliRunner = (executable: string, args: string[], cwd: string) => Promise<string>;

export interface CreatePrToolInput {
  kind: PrProviderKind;
  /** The resolved CLI executable (see {@link resolveProviderExecutable}). */
  executable: string;
  repoRoot: string;
  run?: CliRunner;
}

/** How long a single CLI call may take before it is abandoned (ms). */
const CLI_TIMEOUT_MS = 120_000;

/** Build the {@link PrTool} for a provider over its CLI. */
export function createPrTool(input: CreatePrToolInput): PrTool {
  const run = input.run ?? execCli;
  const cli = (args: string[]): Promise<string> => run(input.executable, args, input.repoRoot);
  return input.kind === 'glab' ? glabTool(cli) : ghTool(cli);
}

function ghTool(cli: (args: string[]) => Promise<string>): PrTool {
  return {
    async findOpenByHead(branch) {
      const out = await cli([
        'pr', 'list', '--head', branch, '--state', 'open', '--json', 'number,url', '--limit', '1',
      ]);
      return parsePrList(out)[0];
    },
    async create(input) {
      const out = await cli([
        'pr', 'create',
        '--base', input.base,
        '--head', input.head,
        '--title', input.title,
        '--body', input.body,
      ]);
      return parseCreatedPr(out);
    },
    async stateByUrl(url) {
      const parsed = parsePrUrl(url);
      if (parsed === undefined || parsed.kind !== 'gh') return 'unknown';
      try {
        const out = await cli([
          'pr', 'view', String(parsed.number), '--repo', `${parsed.host}/${parsed.repoPath}`, '--json', 'state',
        ]);
        return parseGhPrState(out);
      } catch {
        return 'unknown';
      }
    },
  };
}

function glabTool(cli: (args: string[]) => Promise<string>): PrTool {
  return {
    async findOpenByHead(branch) {
      // `mr list` shows opened requests by default; `-F json` yields API-shaped
      // objects with `iid` and `web_url`.
      const out = await cli(['mr', 'list', '--source-branch', branch, '--output', 'json']);
      return parsePrList(out)[0];
    },
    async create(input) {
      const out = await cli([
        'mr', 'create',
        '--source-branch', input.head,
        '--target-branch', input.base,
        '--title', input.title,
        '--description', input.body,
        '--yes',
      ]);
      return parseCreatedPr(out);
    },
    async stateByUrl(url) {
      const parsed = parsePrUrl(url);
      if (parsed === undefined || parsed.kind !== 'glab') return 'unknown';
      try {
        const out = await cli([
          'mr', 'view', String(parsed.number), '--repo', parsed.repoPath, '--output', 'json',
        ]);
        return parseGlabMrState(out);
      } catch {
        return 'unknown';
      }
    },
  };
}

/**
 * A JSON list of requests → {@link PullRequest}s. Accepts GitHub's
 * `{number, url}` and GitLab's `{iid, web_url}`; tolerates empty or non-JSON
 * output by yielding nothing.
 */
export function parsePrList(stdout: string): PullRequest[] {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return [];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const prs: PullRequest[] = [];
  for (const item of parsed) {
    if (typeof item !== 'object' || item === null) {
      continue;
    }
    const rec = item as Record<string, unknown>;
    const url = typeof rec.url === 'string' ? rec.url : typeof rec.web_url === 'string' ? rec.web_url : undefined;
    if (url === undefined) {
      continue;
    }
    const number = typeof rec.number === 'number' ? rec.number : typeof rec.iid === 'number' ? rec.iid : undefined;
    prs.push({ url, ...(number !== undefined ? { number } : {}) });
  }
  return prs;
}

/**
 * Both CLIs print the new request's URL as the last line of stdout; the
 * number is the trailing path segment (`/pull/12`, `/merge_requests/7`).
 */
export function parseCreatedPr(stdout: string): PullRequest {
  const lines = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  const url = [...lines].reverse().find((l) => /^https?:\/\//.test(l));
  if (url === undefined) {
    const err: PrToolError = {
      command: 'create',
      exitCode: 0,
      stderr: `the CLI did not print the created request's URL: ${stdout.trim()}`,
    };
    throw Object.assign(new Error(err.stderr), err);
  }
  const match = /\/(\d+)\/?$/.exec(url);
  return match ? { url, number: Number(match[1]) } : { url };
}

function execCli(executable: string, args: string[], cwd: string): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      executable,
      args,
      { cwd, timeout: CLI_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as { code?: unknown }).code;
          const err: PrToolError = {
            command: [path.basename(executable), ...args].join(' '),
            exitCode: typeof code === 'number' ? code : undefined,
            stderr:
              code === 'ENOENT' ? `${executable} was not found` : stderr.trim() || error.message,
          };
          reject(err);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

/** Render a {@link PrToolError} (or anything thrown) for the user. */
export function describePrToolError(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'command' in e) {
    const pe = e as PrToolError;
    return `${pe.command} failed${pe.stderr ? `: ${pe.stderr}` : ''}`;
  }
  return e instanceof Error ? e.message : String(e);
}
