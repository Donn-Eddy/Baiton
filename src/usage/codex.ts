/**
 * Host-free Codex usage reader for the Usage view (spec first-party-usage,
 * todo T03). Imports only './model' and './usageService': no editor-host API,
 * no Node built-in module, no import of the codex adapter. Every effect (spawning
 * `codex app-server`, reading a rollout file or auth.json, an HTTP request)
 * goes through an injected seam and happens only inside the returned reader.
 *
 * Mechanisms, in order (probed with codex-cli 0.157.0, see the README):
 *  1. `codex app-server` JSON-RPC `account/rateLimits/read` (cli-server)
 *  2. the newest session rollout's `token_count` rate_limits (cli-files)
 *  3. fallback, trusted workspaces only: the stored ChatGPT login against
 *     chatgpt.com `wham/usage` (provider-endpoint)
 * Nothing is invented: a window without a source percentage gets no bar, and
 * a window that has already reset in an old snapshot is dropped, not zeroed.
 */

import {
  type UsageMechanism,
  type UsageReading,
  type UsageWindow,
  okReading,
  unavailableReading,
} from './model';
import { type UsageReader, redactSecrets } from './usageService';

// --- Constants ---------------------------------------------------------------

export const CODEX_USAGE_APP_SERVER_SUBCOMMAND = 'app-server';
export const CODEX_USAGE_RATE_LIMITS_METHOD = 'account/rateLimits/read';
export const CODEX_USAGE_INITIALIZE_ID = 1;
export const CODEX_USAGE_RATE_LIMITS_ID = 2;
export const CODEX_WHAM_USAGE_URL = 'https://chatgpt.com/backend-api/wham/usage';

const APP_SERVER_MAX_TIMEOUT_MS = 10_000;
const CLIENT_INFO = { name: 'baiton', version: '1.0.0' };

// --- Seams -------------------------------------------------------------------

/** The child-process surface the reader uses; structurally identical to CodexAppServerProcess. */
export interface CodexUsageProcess {
  readonly stdin: { write(chunk: string): unknown; end(): unknown };
  readonly stdout: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown };
  readonly stderr?: { on(event: 'data', listener: (chunk: Buffer | string) => void): unknown };
  on(event: 'error' | 'exit' | 'close', listener: (...args: unknown[]) => void): unknown;
  kill(signal?: string): unknown;
}

/** Every effect of the reader. A seam left out means that mechanism is skipped. */
export interface CodexUsageSeams {
  /** Spawns `codex app-server` with piped stdio (from a neutral cwd, not the workspace). */
  readonly spawnAppServer?: () => CodexUsageProcess;
  /** Text of the newest rollout-*.jsonl, or undefined when there is none. */
  readonly readLatestRollout?: (signal: AbortSignal) => Promise<string | undefined>;
  /** Text of $CODEX_HOME/auth.json, or undefined when absent. */
  readonly readAuthFile?: () => Promise<string | undefined>;
  readonly fetchJson?: (
    url: string,
    init: { headers: Record<string, string>; signal: AbortSignal },
  ) => Promise<{ status: number; body: unknown }>;
  readonly log?: (message: string) => void;
}

// --- Parsers -----------------------------------------------------------------

type Rec = Record<string, unknown>;

function isRec(value: unknown): value is Rec {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** Seconds (< 1e12) or milliseconds to epoch ms; undefined when not finite. */
function toEpochMs(value: unknown): number | undefined {
  const n = num(value);
  if (n === undefined) return undefined;
  return n < 1e12 ? n * 1000 : n;
}

/** Id and label for a window of `minutes` minutes. */
function windowLabel(minutes: number | undefined, fallbackId: string): { id: string; label: string } {
  if (minutes === undefined || minutes <= 0) return { id: fallbackId, label: fallbackId };
  if (minutes === 300) return { id: 'five-hour', label: '5-hour' };
  if (minutes === 10080) return { id: 'weekly', label: 'Weekly' };
  const rounded = Math.round(minutes);
  if (rounded % 1440 === 0) return { id: `${rounded}-minute`, label: `${rounded / 1440}d` };
  if (rounded % 60 === 0) return { id: `${rounded}-minute`, label: `${rounded / 60}h` };
  return { id: `${rounded}-minute`, label: `${rounded}m` };
}

function buildWindow(
  fallbackId: string,
  usedPercent: unknown,
  minutes: number | undefined,
  resetsAt: number | undefined,
  model?: string,
): UsageWindow | undefined {
  const percent = num(usedPercent);
  if (percent === undefined) return undefined;
  const { id, label } = windowLabel(minutes, fallbackId);
  return {
    id: model ? `${model}:${id}` : id,
    label: model ? `${label} (${model})` : label,
    usedPercent: percent,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(model ? { scope: { model } } : {}),
    provenance: 'provider-reported',
  };
}

function appServerWindows(limits: unknown, model?: string): UsageWindow[] {
  if (!isRec(limits)) return [];
  const out: UsageWindow[] = [];
  for (const key of ['primary', 'secondary'] as const) {
    const w = limits[key];
    if (!isRec(w)) continue;
    const built = buildWindow(
      key,
      w.usedPercent ?? w.used_percent,
      num(w.windowDurationMins ?? w.window_minutes),
      toEpochMs(w.resetsAt ?? w.resets_at),
      model,
    );
    if (built) out.push(built);
  }
  return out;
}

/** Parses the `result` of `account/rateLimits/read`. Total. */
export function parseCodexAppServerRateLimits(result: unknown): { windows: UsageWindow[]; tier?: string } {
  try {
    if (!isRec(result)) return { windows: [] };
    const limits = result.rateLimits;
    const windows = appServerWindows(limits);
    let tier = isRec(limits) ? str(limits.planType ?? limits.plan_type) : undefined;
    const byId = result.rateLimitsByLimitId;
    if (isRec(byId)) {
      for (const [limitId, entry] of Object.entries(byId)) {
        if (!isRec(entry)) continue;
        // The default bucket duplicates `rateLimits`; only extra buckets add rows.
        const name = str(entry.limitName) ?? limitId;
        if (isRec(limits) && (str(limits.limitId) ?? 'codex') === limitId) continue;
        windows.push(...appServerWindows(entry, name));
        tier = tier ?? str(entry.planType ?? entry.plan_type);
      }
    }
    return tier ? { windows, tier } : { windows };
  } catch {
    return { windows: [] };
  }
}

/** Parses the newest `token_count` rate_limits out of a rollout file. Total. */
export function parseCodexRolloutRateLimits(
  jsonl: string,
  now: number,
): { windows: UsageWindow[]; tier?: string; snapshotAt?: number } {
  try {
    if (typeof jsonl !== 'string') return { windows: [] };
    const lines = jsonl.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      const text = lines[i].trim();
      if (!text) continue;
      let line: unknown;
      try {
        line = JSON.parse(text);
      } catch {
        continue;
      }
      if (!isRec(line) || !isRec(line.payload)) continue;
      const payload = line.payload;
      if (payload.type !== 'token_count' || !isRec(payload.rate_limits)) continue;
      const limits = payload.rate_limits;
      const parsedAt = typeof line.timestamp === 'string' ? Date.parse(line.timestamp) : NaN;
      const snapshotAt = Number.isFinite(parsedAt) ? parsedAt : undefined;
      const windows: UsageWindow[] = [];
      for (const key of ['primary', 'secondary'] as const) {
        const w = limits[key];
        if (!isRec(w)) continue;
        let resetsAt = toEpochMs(w.resets_at);
        const relative = num(w.resets_in_seconds);
        if (resetsAt === undefined && relative !== undefined && snapshotAt !== undefined) {
          resetsAt = snapshotAt + relative * 1000;
        }
        // A window that has reset since the snapshot no longer holds its old percent.
        if (resetsAt !== undefined && resetsAt <= now) continue;
        const built = buildWindow(key, w.used_percent, num(w.window_minutes), resetsAt);
        if (built) windows.push(built);
      }
      const tier = str(limits.plan_type);
      return {
        windows,
        ...(tier ? { tier } : {}),
        ...(snapshotAt !== undefined ? { snapshotAt } : {}),
      };
    }
    return { windows: [] };
  } catch {
    return { windows: [] };
  }
}

/** Parses the body of chatgpt.com `wham/usage`. Total. */
export function parseCodexWhamUsage(body: unknown, now: number = Date.now()): { windows: UsageWindow[]; tier?: string } {
  try {
    if (!isRec(body)) return { windows: [] };
    const windows: UsageWindow[] = [];
    const limit = body.rate_limit;
    if (isRec(limit)) {
      for (const [key, id] of [['primary_window', 'primary'], ['secondary_window', 'secondary']] as const) {
        const w = limit[key];
        if (!isRec(w)) continue;
        const seconds = num(w.limit_window_seconds);
        let resetsAt = toEpochMs(w.reset_at);
        const after = num(w.reset_after_seconds);
        if (resetsAt === undefined && after !== undefined) resetsAt = now + after * 1000;
        const built = buildWindow(id, w.used_percent, seconds === undefined ? undefined : seconds / 60, resetsAt);
        if (built) windows.push(built);
      }
    }
    const tier = str(body.plan_type);
    return tier ? { windows, tier } : { windows };
  } catch {
    return { windows: [] };
  }
}

/** Reads the stored login out of auth.json text. Never throws; never logs. */
export function extractCodexCredential(
  authJson: string,
): { accessToken: string; accountId?: string } | { apiKeyOnly: true } | undefined {
  try {
    const parsed: unknown = JSON.parse(authJson);
    if (!isRec(parsed)) return undefined;
    const tokens = parsed.tokens;
    if (isRec(tokens)) {
      const accessToken = str(tokens.access_token);
      if (accessToken) {
        const accountId = str(tokens.account_id);
        return accountId ? { accessToken, accountId } : { accessToken };
      }
    }
    if (str(parsed.OPENAI_API_KEY)) return { apiKeyOnly: true };
    return undefined;
  } catch {
    return undefined;
  }
}

// --- app-server transport ----------------------------------------------------

/**
 * Runs initialize → initialized → account/rateLimits/read and resolves the
 * `result`. Every path ends stdin and kills the child; rejections carry a
 * redacted plain message.
 */
export function readCodexAppServerRateLimits(
  spawn: () => CodexUsageProcess,
  signal: AbortSignal,
  timeoutMs: number,
): Promise<unknown> {
  return new Promise<unknown>((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('codex app-server read aborted'));
      return;
    }
    let child: CodexUsageProcess;
    try {
      child = spawn();
    } catch (e) {
      reject(new Error(spawnMessage(e)));
      return;
    }
    let settled = false;
    let buffer = '';
    const budget = Math.min(timeoutMs > 0 ? timeoutMs : APP_SERVER_MAX_TIMEOUT_MS, APP_SERVER_MAX_TIMEOUT_MS);
    const onAbort = (): void => finish(undefined, 'codex app-server read aborted');
    const timer = setTimeout(() => finish(undefined, `codex app-server timed out after ${budget}ms`), budget);
    (timer as { unref?: () => void }).unref?.();

    function finish(result: unknown, failure?: string): void {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      try {
        child.stdin.end();
      } catch {
        // best-effort
      }
      try {
        child.kill('SIGTERM');
      } catch {
        // best-effort
      }
      if (failure !== undefined) reject(new Error(redactSecrets(failure)));
      else resolve(result);
    }

    const write = (message: unknown): void => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch {
        finish(undefined, 'codex app-server stdin write failed');
      }
    };

    const dispatch = (message: unknown): void => {
      if (!isRec(message)) return;
      if (message.id === CODEX_USAGE_INITIALIZE_ID) {
        if (message.error) {
          finish(undefined, `codex app-server initialize failed: ${rpcError(message.error)}`);
          return;
        }
        write({ jsonrpc: '2.0', method: 'initialized', params: {} });
        write({ jsonrpc: '2.0', id: CODEX_USAGE_RATE_LIMITS_ID, method: CODEX_USAGE_RATE_LIMITS_METHOD, params: {} });
      } else if (message.id === CODEX_USAGE_RATE_LIMITS_ID) {
        if (message.error) {
          finish(undefined, `codex app-server ${CODEX_USAGE_RATE_LIMITS_METHOD} failed: ${rpcError(message.error)}`);
          return;
        }
        finish(message.result);
      }
    };

    signal.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk) => {
      buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let nl = buffer.indexOf('\n');
      while (nl >= 0) {
        const line = buffer.slice(0, nl).trim();
        buffer = buffer.slice(nl + 1);
        if (line) {
          try {
            dispatch(JSON.parse(line));
          } catch {
            // not JSON: ignore
          }
        }
        nl = buffer.indexOf('\n');
      }
    });
    // Drain stderr so a full pipe cannot stall the child; its content is never used.
    child.stderr?.on('data', () => undefined);
    child.on('error', (e) => finish(undefined, spawnMessage(e)));
    child.on('exit', () => finish(undefined, 'codex app-server exited before replying'));
    child.on('close', () => finish(undefined, 'codex app-server exited before replying'));
    write({
      jsonrpc: '2.0',
      id: CODEX_USAGE_INITIALIZE_ID,
      method: 'initialize',
      params: { clientInfo: CLIENT_INFO },
    });
  });
}

function rpcError(error: unknown): string {
  if (isRec(error) && typeof error.message === 'string') return error.message;
  return 'unknown error';
}

function spawnMessage(error: unknown): string {
  if (isRec(error) && error.code === 'ENOENT') return 'codex was not found on PATH';
  return `codex app-server failed: ${error instanceof Error ? error.message : 'unknown error'}`;
}

// --- The reader --------------------------------------------------------------

function describe(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error';
}

/** Builds the Codex reader. Constructing it spawns and reads nothing. */
export function createCodexUsageReader(seams: CodexUsageSeams): UsageReader {
  return async (ctx): Promise<UsageReading> => {
    const reasons: string[] = [];
    let last: UsageMechanism | undefined;
    const log = (m: string): void => {
      try {
        seams.log?.(redactSecrets(m));
      } catch {
        // logging must never break a read
      }
    };
    try {
      if (ctx.signal.aborted) return unavailableReading('codex', 'The Codex usage read was aborted.', ctx.now(), last);

      // 1. codex app-server
      if (seams.spawnAppServer) {
        last = 'cli-server';
        try {
          const result = await readCodexAppServerRateLimits(seams.spawnAppServer, ctx.signal, ctx.timeoutMs);
          const { windows, tier } = parseCodexAppServerRateLimits(result);
          if (windows.length > 0) {
            return okReading(
              'codex',
              {
                mechanism: 'cli-server',
                detail: `codex ${CODEX_USAGE_APP_SERVER_SUBCOMMAND} ${CODEX_USAGE_RATE_LIMITS_METHOD}`,
                provenance: 'provider-reported',
                readAt: ctx.now(),
              },
              windows,
              tier,
            );
          }
          reasons.push('codex app-server reported no rate-limit windows');
        } catch (e) {
          reasons.push(redactSecrets(describe(e)));
        }
      } else {
        reasons.push('codex app-server is not wired');
      }

      // 2. newest rollout file
      if (ctx.signal.aborted) return unavailableReading('codex', reasons.join('; '), ctx.now(), last);
      if (seams.readLatestRollout) {
        last = 'cli-files';
        try {
          const text = await seams.readLatestRollout(ctx.signal);
          if (text === undefined) {
            reasons.push('no Codex session log found');
          } else {
            const parsed = parseCodexRolloutRateLimits(text, ctx.now());
            if (parsed.windows.length > 0) {
              const at = parsed.snapshotAt;
              return okReading(
                'codex',
                {
                  mechanism: 'cli-files',
                  detail: `latest codex session log (token_count at ${at === undefined ? 'unknown time' : new Date(at).toISOString()})`,
                  provenance: 'provider-reported',
                  readAt: at ?? ctx.now(),
                },
                parsed.windows,
                parsed.tier,
              );
            }
            reasons.push('latest Codex session log has no current rate-limit windows');
          }
        } catch (e) {
          reasons.push(`Codex session log unreadable: ${redactSecrets(describe(e))}`);
        }
      } else {
        reasons.push('Codex session logs are not wired');
      }

      // 3. provider endpoint with the stored login (trusted workspaces only)
      if (ctx.signal.aborted) return unavailableReading('codex', reasons.join('; '), ctx.now(), last);
      if (!ctx.trusted) {
        reasons.push('Restricted Mode: Baiton does not read the stored Codex login.');
      } else if (seams.readAuthFile && seams.fetchJson) {
        last = 'provider-endpoint';
        try {
          const credential = extractCodexCredential((await seams.readAuthFile()) ?? '');
          if (credential === undefined) {
            reasons.push('no stored Codex login found');
          } else if ('apiKeyOnly' in credential) {
            reasons.push('Codex is signed in with an API key; API-key accounts have no plan usage windows.');
          } else {
            const headers: Record<string, string> = { Authorization: `Bearer ${credential.accessToken}` };
            if (credential.accountId) headers['ChatGPT-Account-Id'] = credential.accountId;
            const response = await seams.fetchJson(CODEX_WHAM_USAGE_URL, { headers, signal: ctx.signal });
            if (response.status < 200 || response.status >= 300) {
              reasons.push(`Provider usage endpoint returned HTTP ${response.status}`);
            } else {
              const { windows, tier } = parseCodexWhamUsage(response.body, ctx.now());
              if (windows.length > 0) {
                return okReading(
                  'codex',
                  {
                    mechanism: 'provider-endpoint',
                    detail: 'chatgpt.com wham/usage (stored Codex login)',
                    provenance: 'provider-reported',
                    readAt: ctx.now(),
                  },
                  windows,
                  tier,
                );
              }
              reasons.push('Provider usage endpoint reported no usage windows');
            }
          }
        } catch (e) {
          reasons.push(`Provider usage endpoint failed: ${redactSecrets(describe(e))}`);
        }
      } else {
        reasons.push('the provider usage endpoint is not wired');
      }

      const reason = redactSecrets(reasons.join('; '));
      log(`codex usage unavailable: ${reason}`);
      return unavailableReading('codex', reason, ctx.now(), last);
    } catch (e) {
      return unavailableReading('codex', redactSecrets(`Codex usage read failed: ${describe(e)}`), ctx.now(), last);
    }
  };
}
