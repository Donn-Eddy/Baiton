/**
 * Host-free OpenCode Go usage reader for the Usage view (spec first-party-usage,
 * todo T06). Imports only './model' and './usageService': no editor-host API,
 * no Node built-in module, no import of the opencode adapter. Every effect
 * (reading the stored login, one HTTPS GET) goes through an injected seam and
 * happens only inside the returned reader.
 *
 * Probe findings (opencode 1.18.30, linux, 2026-10-09):
 *  Established route (and only route; mechanism 'provider-endpoint', trusted
 *    workspaces only): `GET https://opencode.ai/zen/go/v1/usage` with
 *    `Authorization: Bearer <stored OpenCode Go key>`. It is read-only, spends
 *    no quota and is NOT documented (https://opencode.ai/docs/go only points at
 *    the web console), so a shape change must yield unavailable, never a crash.
 *    HTTP 200, application/json, no x-ratelimit-* headers. Abridged body:
 *      {"usage":{"rolling":{"status":"ok","percent":0,"resetsAt":"2026-10-09T22:28:06.000Z"},
 *                "weekly":{"status":"ok","percent":1,"resetsAt":"2026-10-12T00:00:00.000Z"},
 *                "monthly":{"status":"ok","percent":11,"resetsAt":"2026-10-13T00:25:21.000Z"}}}
 *    `rolling` is the 5-hour limit. `percent` is the provider's own used percent
 *    (0..100) and `resetsAt` is ISO UTC. No plan tier and no raw dollar figures
 *    are returned, so none are reported.
 *    The login lives in ~/.local/share/opencode/auth.json as
 *    {"opencode-go":{"type":"api","key":"…"}} (`opencode providers list` shows
 *    "OpenCode Go api").
 *  Probed, unusable:
 *    - CLI: no usage/quota/limit/account subcommand (`opencode --help`,
 *      `providers`/`auth`, `models --verbose`, `debug`). `opencode stats` prints
 *      LOCAL session tokens and cost on this machine only; it is not remaining
 *      usage and turning it into one against the documented dollar limits would
 *      be extrapolation.
 *    - CLI server (`opencode serve --hostname 127.0.0.1 --port 0`): /doc lists no
 *      usage/quota/subscription/billing route; GET /provider, /config/providers,
 *      /api/provider/opencode-go, /api/integration and /experimental/console
 *      carry catalogue data and model context/output `limit`s (not usage) only.
 *    - Files: ~/.local/share/opencode (auth.json, opencode.db session store),
 *      ~/.local/state/opencode, ~/.cache/opencode (models.json catalogue) hold
 *      no quota/remaining/reset figures outside per-message session content.
 *    - https://opencode.ai/zen/go/v1/models answers 200 with a catalogue and no
 *      usage headers.
 *  Unverified: other opencode versions; OAuth-type logins; an exhausted limit
 *    (the `status` value is not read; only `percent`); the Zen (pay-as-you-go)
 *    provider; whether the endpoint stays stable; macOS and Windows.
 * Nothing is invented: a limit without a source percent gets no window, and no
 * percent is ever computed from dollar limits or local spend.
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

export const OPENCODE_GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';
/** Provider ids tried, in order, in ~/.local/share/opencode/auth.json. */
export const OPENCODE_GO_AUTH_PROVIDER_KEYS: readonly string[] = ['opencode-go', 'opencode'];

// --- Seams -------------------------------------------------------------------

/** Every effect of the reader. A seam left out means that mechanism is skipped. */
export interface OpencodeGoUsageSeams {
  /** Contents of ~/.local/share/opencode/auth.json, or undefined when absent. */
  readonly readAuthFile?: () => Promise<string | undefined>;
  /** One read-only GET. */
  readonly fetchJson?: (
    url: string,
    options: { headers: Record<string, string>; signal: AbortSignal },
  ) => Promise<{ status: number; body: unknown; headers?: Record<string, string> }>;
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

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

const KNOWN_LIMITS: Readonly<Record<string, { id: string; label: string }>> = {
  rolling: { id: 'five-hour', label: '5-hour' },
  weekly: { id: 'weekly', label: 'Weekly' },
  monthly: { id: 'monthly', label: 'Monthly' },
};

/**
 * Parses the body of GET /zen/go/v1/usage (an object, or its JSON text). Total;
 * a window only for limits the source gave a percent for.
 */
export function parseOpencodeGoUsage(input: unknown, _now: number): { windows: UsageWindow[]; tier?: string } {
  try {
    const body: unknown = typeof input === 'string' ? JSON.parse(input) : input;
    if (!isRec(body) || !isRec(body.usage)) return { windows: [] };
    const windows: UsageWindow[] = [];
    const seen = new Set<string>();
    for (const [name, entry] of Object.entries(body.usage)) {
      if (!isRec(entry)) continue;
      const percent = num(entry.percent);
      if (percent === undefined) continue;
      const known = KNOWN_LIMITS[name.toLowerCase()];
      const id = known?.id ?? slug(name);
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const resetsAt = toEpochMs(entry.resetsAt);
      windows.push({
        id,
        label: known?.label ?? name,
        usedPercent: percent,
        ...(resetsAt !== undefined ? { resetsAt } : {}),
        provenance: 'provider-reported',
      });
    }
    return { windows };
  } catch {
    return { windows: [] };
  }
}

/** The stored OpenCode Go credential: `key` for type 'api', `access` for type 'oauth'. Never throws. */
export function extractOpencodeGoCredential(authJson: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(authJson);
    if (!isRec(parsed)) return undefined;
    for (const providerKey of OPENCODE_GO_AUTH_PROVIDER_KEYS) {
      const entry = parsed[providerKey];
      if (!isRec(entry)) continue;
      if (entry.type === 'api') return str(entry.key);
      if (entry.type === 'oauth') return str(entry.access);
      return undefined;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

// --- The reader --------------------------------------------------------------

function describe(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error';
}

/** Builds the OpenCode Go reader. Constructing it runs and reads nothing. */
export function createOpencodeGoUsageReader(seams: OpencodeGoUsageSeams): UsageReader {
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
      if (ctx.signal.aborted) {
        return unavailableReading('opencode-go', 'The OpenCode Go usage read was aborted.', ctx.now(), last);
      }

      // The only route is the provider endpoint with the stored login (trusted workspaces only).
      if (!ctx.trusted) {
        reasons.push('Restricted Mode: Baiton does not read the stored OpenCode login.');
      } else if (seams.readAuthFile && seams.fetchJson) {
        last = 'provider-endpoint';
        try {
          const token = extractOpencodeGoCredential((await seams.readAuthFile()) ?? '');
          if (token === undefined) {
            reasons.push('no stored OpenCode login found');
          } else if (ctx.signal.aborted) {
            return unavailableReading('opencode-go', 'The OpenCode Go usage read was aborted.', ctx.now(), last);
          } else {
            const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
            const response = await seams.fetchJson(OPENCODE_GO_USAGE_URL, { headers, signal: ctx.signal });
            if (response.status < 200 || response.status >= 300) {
              reasons.push(`Provider usage endpoint returned HTTP ${response.status}`);
            } else {
              const { windows, tier } = parseOpencodeGoUsage(response.body, ctx.now());
              if (windows.length > 0) {
                return okReading(
                  'opencode-go',
                  {
                    mechanism: 'provider-endpoint',
                    detail: 'opencode.ai zen/go/v1/usage (stored OpenCode login)',
                    provenance: 'provider-reported',
                    readAt: ctx.now(),
                  },
                  windows,
                  tier,
                );
              }
              reasons.push(
                'Provider usage endpoint reported no OpenCode Go usage windows (signed out or no Go subscription?)',
              );
            }
          }
        } catch (e) {
          reasons.push(`Provider usage endpoint failed: ${redactSecrets(describe(e))}`);
        }
      } else {
        reasons.push('the provider usage endpoint is not wired');
      }

      const reason = redactSecrets(reasons.join('; '));
      log(`opencode-go usage unavailable: ${reason}`);
      return unavailableReading('opencode-go', reason, ctx.now(), last);
    } catch (e) {
      return unavailableReading(
        'opencode-go',
        redactSecrets(`OpenCode Go usage read failed: ${describe(e)}`),
        ctx.now(),
        last,
      );
    }
  };
}
