/**
 * Host-free Antigravity usage reader for the Usage view (spec first-party-usage,
 * todo T05). Imports only './model' and './usageService': no editor-host API,
 * no Node built-in module, no import of the antigravity adapter. Every effect
 * (running `agy`) goes through an injected seam and happens only inside the
 * returned reader.
 *
 * Probe findings (agy 1.3.2, linux, 2026-10-09):
 *  Established route (primary, mechanism 'cli-command'):
 *    `agy -p /usage --output-format json` runs the built-in /usage command
 *    locally: `num_turns: 0`, all token counts 0, no model turn, nothing
 *    written under ~/.gemini. (`agy -p /usage` without the flag prints the same
 *    figures as tab-separated lines; `/quota` is an alias.) Abridged stdout:
 *      {"conversation_id":"","status":"SUCCESS","response":"Gemini Models\tWeekly Limit Remaining\t99%\t2026-10-15T00:53:08Z\n…",
 *       "num_turns":0,"usage":{…0…},"command":{"name":"usage","data":{"description":"Within each group, models share a weekly limit and a 5-hour limit…",
 *        "groups":[{"name":"Gemini Models","description":"Models within this group: Gemini Flash, Gemini Pro",
 *          "buckets":[{"id":"gemini-weekly","name":"Weekly Limit Remaining","window":"weekly","remaining_fraction":0.9929834604263306,"reset_time":"2026-10-15T00:53:08Z"},
 *                     {"id":"gemini-5h","name":"Five Hour Limit Remaining","window":"5h","remaining_fraction":1,"reset_time":"2026-10-09T22:37:49Z"}]},
 *         {"name":"Claude and GPT models","buckets":[{"id":"3p-weekly",…},{"id":"3p-5h",…}]}]}}}
 *    Quota is per GROUP of models (Gemini; Claude and GPT), not per model, so a
 *    window is one bucket of one group. `remaining_fraction` (0..1) is the
 *    provider's own figure: usedPercent = (1 - fraction) * 100. `reset_time` is
 *    ISO UTC when piped. A full 5-hour bucket reports a reset that rolls
 *    forward on every call (it is "now + 5h"), so only the percent is stable.
 *    The text lines carry only a rounded remaining percent; they are parsed as
 *    a fallback when the JSON is absent. The output carries no plan tier, so
 *    this route reports none. agy exits 0 even on error: stdout is judged.
 *  Probed, unusable: no usage/quota subcommand (`agy --help`, `agy models
 *    --help` have no quota flag; `agy models` prints `id<TAB>label` only);
 *    no server/daemon mode to query (`agy remote-control` is a tunnel to
 *    another device, not a usage server); no quota/state file under
 *    ~/.gemini/antigravity-cli (settings.json holds model/permissions/trusted
 *    workspaces only; no remainingFraction/quota key outside conversation data);
 *    provider endpoint fallback NOT wired: no credential file exists under
 *    ~/.gemini or ~/.config/Antigravity (the login is not stored in a file Baiton
 *    can read, probably the OS secret service), so
 *    cloudcode-pa.googleapis.com endpoints could not be exercised and are not coded.
 *  Unverified: other agy versions; an exhausted bucket (whether
 *    `remaining_fraction` is 0 or omitted; an omitted fraction yields no window,
 *    never an invented 0 or 100); API-key (GEMINI_API_KEY) and enterprise
 *    logins; per-model quotas; macOS and Windows.
 * Nothing is invented: a bucket without a source fraction gets no window.
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

export const ANTIGRAVITY_USAGE_BIN = 'agy';
export const ANTIGRAVITY_USAGE_CLI_ARGS: readonly string[] = ['-p', '/usage', '--output-format', 'json'];

const CLI_MAX_TIMEOUT_MS = 15_000;

// --- Seams -------------------------------------------------------------------

/** Every effect of the reader. A seam left out means that mechanism is skipped. */
export interface AntigravityUsageSeams {
  /** Runs `agy <args>` (no shell, neutral cwd) and returns its exit code and stdout. */
  readonly runCli?: (
    args: readonly string[],
    signal: AbortSignal,
    timeoutMs: number,
  ) => Promise<{ code: number | null; stdout: string }>;
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

function makeWindow(
  id: string,
  label: string,
  usedPercent: number,
  resetsAt: number | undefined,
): UsageWindow {
  return {
    id,
    label,
    usedPercent,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
    provenance: 'provider-reported',
  };
}

function pushUnique(windows: UsageWindow[], seen: Set<string>, w: UsageWindow): void {
  if (seen.has(w.id)) return;
  seen.add(w.id);
  windows.push(w);
}

/** Windows of the structured `/usage` JSON: `command.data.groups[].buckets[]`. */
function groupsWindows(groups: unknown): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const seen = new Set<string>();
  if (!Array.isArray(groups)) return windows;
  for (const group of groups) {
    if (!isRec(group) || !Array.isArray(group.buckets)) continue;
    const groupName = str(group.name);
    for (const bucket of group.buckets) {
      if (!isRec(bucket)) continue;
      const fraction = num(bucket.remaining_fraction);
      if (fraction === undefined) continue;
      const name = str(bucket.name)?.replace(/\s*Limit Remaining\s*$/i, '').trim();
      const kind = str(bucket.window) ?? name ?? 'limit';
      const id = str(bucket.id) ?? slug(`${groupName ?? ''} ${kind}`);
      if (!id) continue;
      const label = [groupName, name ?? kind].filter(Boolean).join(' — ');
      pushUnique(windows, seen, makeWindow(id, label, (1 - fraction) * 100, toEpochMs(bucket.reset_time)));
    }
  }
  return windows;
}

/** Windows of the tab-separated text: `group<TAB>name<TAB>N%<TAB>reset`. */
function textWindows(text: string): UsageWindow[] {
  const windows: UsageWindow[] = [];
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const cols = line.split('\t').map((c) => c.trim());
    if (cols.length < 3) continue;
    const m = /^(\d+(?:\.\d+)?)\s*%$/.exec(cols[2]);
    if (!m || !cols[0] || !cols[1]) continue;
    const remaining = Number(m[1]);
    if (!Number.isFinite(remaining)) continue;
    const name = cols[1].replace(/\s*Limit Remaining\s*$/i, '').trim();
    const id = slug(`${cols[0]} ${name}`);
    if (!id) continue;
    pushUnique(windows, seen, makeWindow(id, `${cols[0]} — ${name}`, 100 - remaining, toEpochMs(cols[3])));
  }
  return windows;
}

/**
 * Parses the stdout of `agy -p /usage --output-format json` (or its plain
 * tab-separated text). Total; windows only for buckets the source gave a
 * fraction or percent for.
 */
export function parseAntigravityCliUsage(stdout: string): { windows: UsageWindow[] } {
  try {
    if (typeof stdout !== 'string') return { windows: [] };
    let text = stdout;
    try {
      const parsed: unknown = JSON.parse(stdout);
      if (isRec(parsed)) {
        const data = isRec(parsed.command) && isRec(parsed.command.data) ? parsed.command.data : undefined;
        const structured = data ? groupsWindows(data.groups) : [];
        if (structured.length > 0) return { windows: structured };
        text = typeof parsed.response === 'string' ? parsed.response : '';
      }
    } catch {
      // plain text output
    }
    return { windows: textWindows(text) };
  } catch {
    return { windows: [] };
  }
}

// --- The reader --------------------------------------------------------------

function describe(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === 'string' ? error : 'unknown error';
}

function cliFailureMessage(error: unknown): string {
  if (isRec(error) && error.code === 'ENOENT') return `${ANTIGRAVITY_USAGE_BIN} was not found on PATH`;
  return `agy /usage failed: ${redactSecrets(describe(error))}`;
}

/** Builds the Antigravity reader. Constructing it runs and reads nothing. */
export function createAntigravityUsageReader(seams: AntigravityUsageSeams): UsageReader {
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
        return unavailableReading('antigravity', 'The Antigravity usage read was aborted.', ctx.now(), last);
      }

      if (seams.runCli) {
        last = 'cli-command';
        try {
          const budget = Math.min(ctx.timeoutMs > 0 ? ctx.timeoutMs : CLI_MAX_TIMEOUT_MS, CLI_MAX_TIMEOUT_MS);
          const result = await seams.runCli(ANTIGRAVITY_USAGE_CLI_ARGS, ctx.signal, budget);
          const { windows } = parseAntigravityCliUsage(result.stdout);
          if (windows.length > 0) {
            return okReading(
              'antigravity',
              {
                mechanism: 'cli-command',
                detail: 'agy -p /usage',
                provenance: 'provider-reported',
                readAt: ctx.now(),
              },
              windows,
            );
          }
          reasons.push('agy /usage reported no usage windows (signed out?)');
        } catch (e) {
          reasons.push(cliFailureMessage(e));
        }
      } else {
        reasons.push('the agy CLI is not wired');
      }

      const reason = redactSecrets(reasons.join('; '));
      log(`antigravity usage unavailable: ${reason}`);
      return unavailableReading('antigravity', reason, ctx.now(), last);
    } catch (e) {
      return unavailableReading(
        'antigravity',
        redactSecrets(`Antigravity usage read failed: ${describe(e)}`),
        ctx.now(),
        last,
      );
    }
  };
}
