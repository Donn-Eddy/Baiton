/**
 * The real Node seams of the Usage view (spec first-party-usage, todo T10).
 *
 * This module is Node-only and imports no `vscode`, so it is unit-testable
 * without the loader. It supplies the effects `createUsageReaders` leaves
 * injectable: running a CLI without a shell from a neutral cwd, spawning the
 * Codex app-server, reading the newest Codex rollout and the stored credential
 * files, and one read-only GET. Nothing here writes any file, and credential
 * text flows only to the reader that asked for it — it is never logged or cached.
 */
import * as fs from 'fs';
import * as fsp from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import type { AgentId } from '../adapter';
import { claudeCredentialsPath } from '../adapter/claude';
import type {
  CodexUsageProcess,
  UsageCliName,
  UsageCommandResult,
  UsageFetchJson,
  UsageReaderTableSeams,
} from '../usage';

/** Which Baiton agent id each usage CLI belongs to (so `baiton.agents.<agent>.path` applies). */
export const USAGE_CLI_AGENT: Readonly<Record<UsageCliName, AgentId>> = {
  claude: 'claude',
  codex: 'codex',
  agy: 'antigravity',
};

/** Spawned CLIs never run in the workspace. */
export const USAGE_NEUTRAL_CWD = (): string => os.tmpdir();

const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_ROLLOUT_BYTES = 2 * 1024 * 1024;

/** Runs `<executable> <args>` without a shell; killed on abort, timeout or output overflow. */
export function nodeRunCommand(
  executable: string,
  args: readonly string[],
  signal: AbortSignal,
  timeoutMs: number,
): Promise<UsageCommandResult> {
  return new Promise<UsageCommandResult>((resolve, reject) => {
    if (signal.aborted) {
      reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      return;
    }
    const child = spawn(executable, [...args], {
      cwd: USAGE_NEUTRAL_CWD(),
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const kill = (): void => {
      try {
        child.kill('SIGTERM');
      } catch {
        // already gone
      }
    };
    const onAbort = (): void => kill();
    const timer = setTimeout(kill, timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    const cleanup = (): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
    };
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > MAX_STDOUT_BYTES) {
        kill();
        return;
      }
      chunks.push(buf);
    });
    child.stderr?.on('data', () => {
      // drained and discarded
    });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(e);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ code, stdout: Buffer.concat(chunks).toString('utf8') });
    });
  });
}

/** Spawns `<executable> <args>` with piped stdio; the codex reader owns killing it. */
export function nodeSpawnProcess(executable: string, args: readonly string[]): CodexUsageProcess {
  return spawn(executable, [...args], {
    cwd: USAGE_NEUTRAL_CWD(),
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  }) as unknown as CodexUsageProcess;
}

/** `$CODEX_HOME` when non-empty, else `~/.codex`. */
export function codexHomeDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const v = env.CODEX_HOME;
  return typeof v === 'string' && v.trim() !== '' ? v : path.join(home, '.codex');
}

/** `$XDG_DATA_HOME/opencode` when set, else `~/.local/share/opencode`. */
export function opencodeDataDir(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const v = env.XDG_DATA_HOME;
  return typeof v === 'string' && v.trim() !== ''
    ? path.join(v, 'opencode')
    : path.join(home, '.local', 'share', 'opencode');
}

function errCode(e: unknown): string | undefined {
  return (e as { code?: unknown } | null)?.code as string | undefined;
}

/** Text of `file`, or undefined when it does not exist. Throws on other errors and on files over 1 MiB. */
export async function readTextIfExists(file: string): Promise<string | undefined> {
  try {
    const st = await fsp.stat(file);
    if (st.size > MAX_FILE_BYTES) throw new Error('file too large');
    return await fsp.readFile(file, 'utf8');
  } catch (e) {
    const code = errCode(e);
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw e;
  }
}

async function numericDirsDescending(dir: string): Promise<string[]> {
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((d) => d.isDirectory() && /^\d+$/.test(d.name))
    .map((d) => d.name)
    .sort((a, b) => Number(b) - Number(a));
}

/** Text (the trailing 2 MiB at most) of the newest rollout in the latest date directory, or undefined. Read-only. */
export async function nodeReadCodexLatestRollout(
  signal: AbortSignal,
  root: string = path.join(codexHomeDir(), 'sessions'),
): Promise<string | undefined> {
  for (const y of await numericDirsDescending(root)) {
    if (signal.aborted) return undefined;
    for (const m of await numericDirsDescending(path.join(root, y))) {
      if (signal.aborted) return undefined;
      for (const d of await numericDirsDescending(path.join(root, y, m))) {
        if (signal.aborted) return undefined;
        const dayDir = path.join(root, y, m, d);
        let names: string[];
        try {
          names = await fsp.readdir(dayDir);
        } catch {
          continue;
        }
        let best: { file: string; mtimeMs: number; size: number } | undefined;
        for (const name of names) {
          if (!/^rollout-.*\.jsonl$/.test(name)) continue;
          const file = path.join(dayDir, name);
          try {
            const st = await fsp.stat(file);
            if (st.isFile() && (best === undefined || st.mtimeMs > best.mtimeMs)) {
              best = { file, mtimeMs: st.mtimeMs, size: st.size };
            }
          } catch {
            // vanished between readdir and stat
          }
        }
        if (best === undefined) continue;
        if (signal.aborted) return undefined;
        return readTail(best.file, best.size);
      }
    }
  }
  return undefined;
}

async function readTail(file: string, size: number): Promise<string> {
  if (size <= MAX_ROLLOUT_BYTES) return fsp.readFile(file, 'utf8');
  const handle = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(MAX_ROLLOUT_BYTES);
    const { bytesRead } = await handle.read(buf, 0, MAX_ROLLOUT_BYTES, size - MAX_ROLLOUT_BYTES);
    const text = buf.subarray(0, bytesRead).toString('utf8');
    const nl = text.indexOf('\n');
    return nl === -1 ? '' : text.slice(nl + 1);
  } finally {
    await handle.close();
  }
}

interface FetchResponseLike {
  readonly status: number;
  text(): Promise<string>;
  readonly headers: { forEach(cb: (value: string, key: string) => void): void };
}
type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; signal: AbortSignal },
) => Promise<FetchResponseLike>;

/** One read-only GET. Errors never carry headers or the URL query. */
export const nodeFetchJson: UsageFetchJson = async (url, init) => {
  const f = (globalThis as { fetch?: FetchLike }).fetch;
  if (typeof f !== 'function') throw new Error('fetch is unavailable in this runtime');
  const res = await f(url, { method: 'GET', headers: init.headers, signal: init.signal });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const headers: Record<string, string> = {};
  res.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  return { status: res.status, body, headers };
};

export interface NodeUsageSeamOptions {
  resolveExecutable(cli: UsageCliName): string | undefined;
  isTrusted(): boolean;
  log(message: string): void;
  env?: NodeJS.ProcessEnv;
  home?: string;
}

/** The full seam table backed by the real machine. Constructing it touches nothing. */
export function createNodeUsageSeams(opts: NodeUsageSeamOptions): UsageReaderTableSeams {
  const env = opts.env ?? process.env;
  const home = opts.home ?? os.homedir();
  return {
    resolveExecutable: opts.resolveExecutable,
    runCommand: nodeRunCommand,
    spawnProcess: nodeSpawnProcess,
    readCodexLatestRollout: (signal) =>
      nodeReadCodexLatestRollout(signal, path.join(codexHomeDir(env, home), 'sessions')),
    fetchJson: nodeFetchJson,
    credentials: {
      claude: () => readTextIfExists(claudeCredentialsPath()),
      codex: () => readTextIfExists(path.join(codexHomeDir(env, home), 'auth.json')),
      opencodeGo: () => readTextIfExists(path.join(opencodeDataDir(env, home), 'auth.json')),
    },
    isTrusted: opts.isTrusted,
    log: opts.log,
  };
}
