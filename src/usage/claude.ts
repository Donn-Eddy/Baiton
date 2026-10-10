/**
 * Host-free Claude Code usage reader for the Usage view (spec first-party-usage,
 * todo T04). Imports only './model' and './usageService': no editor-host API,
 * no Node built-in module, no import of the claude adapter. Every effect
 * (running `claude`, reading the stored login, an HTTP request) goes through an
 * injected seam and happens only inside the returned reader.
 *
 * Probe findings (claude 2.1.295 (Claude Code), linux, 2026-10-08):
 *  Established route (primary, mechanism 'cli-command'):
 *    `claude -p /usage --output-format json` runs the built-in /usage command
 *    locally: `local_command: "usage"`, `num_turns: 0`, `total_cost_usd: 0`, no
 *    model turn, nothing written under the config directory. `result` is text:
 *      You are currently using your subscription to power your Claude Code usage
 *      Current session: 13% used · resets Oct 9, 12:39am (America/Los_Angeles)
 *      Current week (all models): 2% used · resets Oct 15, 6:59pm (America/Los_Angeles)
 *    The percent is the provider's own figure. The reset has no year and is in
 *    the named IANA zone (the time may drop its minutes: "7pm"), so it is
 *    converted with Intl; when it cannot be converted the window keeps its
 *    percent and gets no reset. Per-model lines ("Current week (Opus)" /
 *    "(Sonnet only)") are mapped by name; none were present on the probed plan.
 *    The text carries no plan tier, so this route reports none.
 *  Fallback (trusted workspaces only, mechanism 'provider-endpoint'):
 *    GET https://api.anthropic.com/api/oauth/usage with
 *    `Authorization: Bearer <claudeAiOauth.accessToken>` and
 *    `anthropic-beta: oauth-2025-04-20` returned HTTP 200:
 *      {"five_hour":{"utilization":13.0,"resets_at":"2026-10-09T07:39:59.799934+00:00"},
 *       "seven_day":{"utilization":2.0,"resets_at":"…"}, "seven_day_opus":null,
 *       "seven_day_sonnet":null, "seven_day_oauth_apps":null, "extra_usage":{"is_enabled":false,
 *       "monthly_limit":7000,"used_credits":0.0,"utilization":0.0,…}, …other buckets, "limits":[…]}
 *    `utilization` is 0..100 (13.0 matched `/usage` "13% used"), used verbatim.
 *    A bad token gave HTTP 401. The stored login is
 *    `<config dir>/.credentials.json` → `claudeAiOauth.{accessToken, refreshToken,
 *    expiresAt (ms), refreshTokenExpiresAt, scopes, subscriptionType,
 *    rateLimitTier}`; the plan tier reported is `subscriptionType` (e.g. 'pro'),
 *    or `rateLimitTier` when that is missing. An expired token is never
 *    refreshed (that would rewrite the CLI's credential store).
 *  Probed, unusable: no usage/limits subcommand (`claude --help`, `claude doctor`
 *    only report installation health); session logs under `<config>/projects`
 *    hold per-message token counts only (summing them would invent a figure) and
 *    no rate-limit percent or reset; `~/.claude.json` `cachedUsageUtilization` is
 *    a CLI-internal cache with its own fetch time, not a documented file, so it
 *    is not read; statusline `rate_limits` are delivered only to a configured
 *    statusline command, which would mean writing the user's settings.
 *  Unverified: other claude versions; API-key logins (the key field name is a
 *    guess: `primaryApiKey` / `apiKey`) and signed-out output of /usage (matched
 *    by wording only); per-model lines of /usage; macOS, where the login lives in
 *    the keychain item 'Claude Code-credentials' — not wired here, a host may
 *    supply it through `readCredentials`.
 * Nothing is invented: a window without a source percentage gets no bar.
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

export const CLAUDE_USAGE_CLI_ARGS: readonly string[] = ['-p', '/usage', '--output-format', 'json'];
export const CLAUDE_OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
export const CLAUDE_OAUTH_BETA_HEADER = 'oauth-2025-04-20';

const CLI_MAX_TIMEOUT_MS = 15_000;

// --- Seams -------------------------------------------------------------------

/** Every effect of the reader. A seam left out means that mechanism is skipped. */
export interface ClaudeUsageSeams {
  /** Runs `claude <args>` (no shell, neutral cwd) and returns its exit code and stdout. */
  readonly runCli?: (
    args: readonly string[],
    signal: AbortSignal,
    timeoutMs: number,
  ) => Promise<{ code: number | null; stdout: string }>;
  /** Text of <config>/.credentials.json (or the keychain item), undefined when absent. */
  readonly readCredentials?: () => Promise<string | undefined>;
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

/** ISO string, or seconds (< 1e12) / milliseconds, to epoch ms; undefined when not finite. */
function toEpochMs(value: unknown): number | undefined {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  const n = num(value);
  if (n === undefined) return undefined;
  return n < 1e12 ? n * 1000 : n;
}

interface WindowKind {
  readonly id: string;
  readonly label: string;
  readonly model?: string;
}

const OAUTH_BUCKETS: ReadonlyArray<readonly [string, WindowKind]> = [
  ['five_hour', { id: 'five-hour', label: '5-hour' }],
  ['seven_day', { id: 'weekly', label: 'Weekly (all models)' }],
  ['seven_day_sonnet', { id: 'weekly:sonnet', label: 'Weekly (Sonnet)', model: 'sonnet' }],
  ['seven_day_opus', { id: 'weekly:opus', label: 'Weekly (Opus)', model: 'opus' }],
  ['seven_day_oauth_apps', { id: 'weekly:oauth-apps', label: 'Weekly (OAuth apps)' }],
];

function makeWindow(kind: WindowKind, usedPercent: number, resetsAt: number | undefined): UsageWindow {
  return {
    id: kind.id,
    label: kind.label,
    usedPercent,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    ...(kind.model ? { scope: { model: kind.model } } : {}),
    provenance: 'provider-reported',
  };
}

function oauthBucketWindow(kind: WindowKind, bucket: unknown): UsageWindow | undefined {
  if (!isRec(bucket)) return undefined;
  const percent = num(bucket.utilization);
  if (percent === undefined) return undefined;
  return makeWindow(kind, percent, toEpochMs(bucket.resets_at));
}

/** Parses the body of the provider `oauth/usage` endpoint. Total. */
export function parseClaudeOauthUsage(body: unknown): { windows: UsageWindow[] } {
  try {
    if (!isRec(body)) return { windows: [] };
    const windows: UsageWindow[] = [];
    const known = new Set<string>(['extra_usage']);
    for (const [key, kind] of OAUTH_BUCKETS) {
      known.add(key);
      const built = oauthBucketWindow(kind, body[key]);
      if (built) windows.push(built);
    }
    for (const [key, value] of Object.entries(body)) {
      if (known.has(key)) continue;
      const built = oauthBucketWindow({ id: key, label: key.replace(/_/g, ' ') }, value);
      if (built) windows.push(built);
    }
    const extra = body.extra_usage;
    if (isRec(extra) && extra.is_enabled === true) {
      const percent = num(extra.utilization);
      const used = num(extra.used_credits);
      const limit = num(extra.monthly_limit);
      const hasRaw = used !== undefined || limit !== undefined;
      if (percent !== undefined || hasRaw) {
        windows.push({
          id: 'extra-usage',
          label: 'Extra usage',
          ...(percent !== undefined ? { usedPercent: percent } : {}),
          ...(hasRaw
            ? { raw: { ...(used !== undefined ? { used } : {}), ...(limit !== undefined ? { limit } : {}), unit: 'credits' } }
            : {}),
          provenance: 'provider-reported',
        });
      }
    }
    return { windows };
  } catch {
    return { windows: [] };
  }
}

/** Reads the stored login out of .credentials.json text. Never throws; never logs. */
export function extractClaudeCredential(
  text: string,
): { accessToken: string; expiresAt?: number; tier?: string } | { apiKeyOnly: true } | undefined {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRec(parsed)) return undefined;
    const oauth = parsed.claudeAiOauth;
    if (isRec(oauth)) {
      const accessToken = str(oauth.accessToken);
      if (accessToken) {
        const expiresAt = num(oauth.expiresAt);
        const tier = str(oauth.subscriptionType) ?? str(oauth.rateLimitTier);
        return {
          accessToken,
          ...(expiresAt !== undefined ? { expiresAt } : {}),
          ...(tier ? { tier } : {}),
        };
      }
    }
    if (str(parsed.primaryApiKey) || str(parsed.apiKey)) return { apiKeyOnly: true };
    return undefined;
  } catch {
    return undefined;
  }
}

// --- `claude -p /usage` text -------------------------------------------------

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** Wall-clock parts of `ts` in the IANA zone `tz`. Throws on an unknown zone. */
function zoneParts(ts: number, tz: string): { y: number; mo: number; d: number; h: number; mi: number; s: number } {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
  const out: Record<string, number> = {};
  for (const p of fmt.formatToParts(new Date(ts))) out[p.type] = Number(p.value);
  return { y: out.year, mo: out.month, d: out.day, h: out.hour, mi: out.minute, s: out.second };
}

function zoneOffsetMs(ts: number, tz: string): number {
  const p = zoneParts(ts, tz);
  return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - Math.floor(ts / 1000) * 1000;
}

/** Epoch ms of a wall-clock time in `tz`. */
function zonedToEpoch(y: number, mo: number, d: number, h: number, mi: number, tz: string): number {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const first = guess - zoneOffsetMs(guess, tz);
  return guess - zoneOffsetMs(first, tz);
}

/**
 * Parses the reset text of a /usage line, e.g. "Oct 9, 12:39am (America/Los_Angeles)",
 * "7pm (UTC)". The year is inferred from `now`. Undefined when it cannot be read.
 */
function parseCliReset(text: string, now: number): number | undefined {
  try {
    const m = /^(?:([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*([ap]m)\s*(?:\(([^)]+)\))?\s*$/i.exec(text.trim());
    if (!m) return undefined;
    const tz = m[6]?.trim();
    if (!tz) return undefined;
    let hour = Number(m[3]) % 12;
    if (m[5].toLowerCase() === 'pm') hour += 12;
    const minute = m[4] ? Number(m[4]) : 0;
    if (Number(m[3]) < 1 || Number(m[3]) > 12 || minute > 59) return undefined;
    const today = zoneParts(now, tz);
    if (m[1]) {
      const month = MONTHS.indexOf(m[1].toLowerCase()) + 1;
      if (month === 0) return undefined;
      let at = zonedToEpoch(today.y, month, Number(m[2]), hour, minute, tz);
      // No year is printed: a date far in the past is next year's.
      if (at < now - 30 * 86_400_000) at = zonedToEpoch(today.y + 1, month, Number(m[2]), hour, minute, tz);
      return Number.isFinite(at) ? at : undefined;
    }
    let at = zonedToEpoch(today.y, today.mo, today.d, hour, minute, tz);
    if (at <= now) at += 86_400_000;
    return Number.isFinite(at) ? at : undefined;
  } catch {
    return undefined;
  }
}

function cliWindowKind(name: string): WindowKind {
  const lower = name.toLowerCase();
  if (/^current session\b/.test(lower)) return { id: 'five-hour', label: '5-hour' };
  const week = /^current week\s*(?:\((.*)\))?\s*$/.exec(lower);
  if (week) {
    const qualifier = (week[1] ?? '').trim();
    if (!qualifier || /^all models?$/.test(qualifier)) return { id: 'weekly', label: 'Weekly (all models)' };
    for (const model of ['opus', 'sonnet']) {
      if (qualifier.includes(model)) {
        return { id: `weekly:${model}`, label: `Weekly (${model === 'opus' ? 'Opus' : 'Sonnet'})`, model };
      }
    }
    const slug = qualifier.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return { id: `weekly:${slug || 'other'}`, label: `Weekly (${qualifier})` };
  }
  const label = name.replace(/^current\s+/i, '').trim();
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return { id: slug || 'other', label: label || name };
}

const SIGNED_OUT = /not logged in|not signed in|please (?:run )?\/?login|run \/login|sign in|log in/i;

/** Parses the stdout of `claude -p /usage --output-format json` (or its plain text). Total. */
export function parseClaudeCliUsage(
  stdout: string,
  now: number = Date.now(),
): { windows: UsageWindow[]; signedOut?: boolean } {
  try {
    if (typeof stdout !== 'string') return { windows: [] };
    let text = stdout;
    let failed = false;
    try {
      const parsed: unknown = JSON.parse(stdout);
      if (isRec(parsed)) {
        failed = parsed.is_error === true;
        text = typeof parsed.result === 'string' ? parsed.result : '';
      }
    } catch {
      // plain text output
    }
    const windows: UsageWindow[] = [];
    for (const line of text.split('\n')) {
      const m = /^\s*(Current [^:]+?)\s*:\s*(\d+(?:\.\d+)?)\s*%\s*used(?:\s*[·•|-]\s*resets?\s+(.+?))?\s*$/i.exec(line);
      if (!m) continue;
      const percent = Number(m[2]);
      if (!Number.isFinite(percent)) continue;
      windows.push(makeWindow(cliWindowKind(m[1]), percent, m[3] ? parseCliReset(m[3], now) : undefined));
    }
    if (windows.length === 0 && (failed || SIGNED_OUT.test(text))) return { windows, signedOut: true };
    return { windows };
  } catch {
    return { windows: [] };
  }
}

// --- The reader --------------------------------------------------------------

function describe(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error';
}

function cliFailureMessage(error: unknown): string {
  if (isRec(error) && error.code === 'ENOENT') return 'claude was not found on PATH';
  return `claude /usage failed: ${redactSecrets(describe(error))}`;
}

/** Builds the Claude Code reader. Constructing it runs and reads nothing. */
export function createClaudeUsageReader(seams: ClaudeUsageSeams): UsageReader {
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
      if (ctx.signal.aborted) return unavailableReading('claude', 'The Claude usage read was aborted.', ctx.now(), last);

      // 1. `claude -p /usage`
      if (seams.runCli) {
        last = 'cli-command';
        try {
          const budget = Math.min(ctx.timeoutMs > 0 ? ctx.timeoutMs : CLI_MAX_TIMEOUT_MS, CLI_MAX_TIMEOUT_MS);
          const result = await seams.runCli(CLAUDE_USAGE_CLI_ARGS, ctx.signal, budget);
          const parsed = parseClaudeCliUsage(result.stdout, ctx.now());
          if (parsed.windows.length > 0) {
            return okReading(
              'claude',
              {
                mechanism: 'cli-command',
                detail: 'claude -p /usage',
                provenance: 'provider-reported',
                readAt: ctx.now(),
              },
              parsed.windows,
            );
          }
          if (parsed.signedOut) reasons.push('Claude Code is signed out (run `claude` to log in)');
          else if (result.code !== 0) reasons.push(`claude /usage exited with code ${result.code}`);
          else reasons.push('claude /usage reported no usage windows');
        } catch (e) {
          reasons.push(cliFailureMessage(e));
        }
      } else {
        reasons.push('the claude CLI is not wired');
      }

      // 2. provider endpoint with the stored login (trusted workspaces only)
      if (ctx.signal.aborted) return unavailableReading('claude', reasons.join('; '), ctx.now(), last);
      if (!ctx.trusted) {
        reasons.push('Restricted Mode: Baiton does not read the stored Claude Code login.');
      } else if (seams.readCredentials && seams.fetchJson) {
        last = 'provider-endpoint';
        try {
          const credential = extractClaudeCredential((await seams.readCredentials()) ?? '');
          if (credential === undefined) {
            reasons.push('no stored Claude Code login found (signed out?)');
          } else if ('apiKeyOnly' in credential) {
            reasons.push('Claude Code is signed in with an API key; API-key accounts have no plan usage windows.');
          } else if (credential.expiresAt !== undefined && credential.expiresAt <= ctx.now()) {
            reasons.push('the stored Claude Code login has expired; run `claude` once to refresh it');
          } else {
            const response = await seams.fetchJson(CLAUDE_OAUTH_USAGE_URL, {
              headers: {
                Authorization: `Bearer ${credential.accessToken}`,
                'anthropic-beta': CLAUDE_OAUTH_BETA_HEADER,
                Accept: 'application/json',
              },
              signal: ctx.signal,
            });
            if (response.status < 200 || response.status >= 300) {
              const hint = response.status === 401 || response.status === 403 ? ' (sign in again with `claude`)' : '';
              reasons.push(`Provider usage endpoint returned HTTP ${response.status}${hint}`);
            } else {
              const { windows } = parseClaudeOauthUsage(response.body);
              if (windows.length > 0) {
                return okReading(
                  'claude',
                  {
                    mechanism: 'provider-endpoint',
                    detail: 'api.anthropic.com oauth/usage (stored Claude Code login)',
                    provenance: 'provider-reported',
                    readAt: ctx.now(),
                  },
                  windows,
                  credential.tier,
                );
              }
              reasons.push('Provider usage endpoint returned an unknown response shape');
            }
          }
        } catch (e) {
          reasons.push(`Provider usage endpoint failed: ${redactSecrets(describe(e))}`);
        }
      } else {
        reasons.push('the provider usage endpoint is not wired');
      }

      const reason = redactSecrets(reasons.join('; '));
      log(`claude usage unavailable: ${reason}`);
      return unavailableReading('claude', reason, ctx.now(), last);
    } catch (e) {
      return unavailableReading('claude', redactSecrets(`Claude usage read failed: ${describe(e)}`), ctx.now(), last);
    }
  };
}
