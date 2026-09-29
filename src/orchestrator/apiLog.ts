/**
 * Host-free API failure log.
 *
 * One entry is written per FAILED outbound API call; successful calls never
 * touch it. Redaction is applied inside `failure()` so a call site cannot
 * forget it. The sink is injectable, exactly like the catalog
 * `log?: (message: string) => void` callback in modelCatalog.ts, and this
 * module has no imports (no `vscode`), so it can be unit-tested in isolation.
 */

/** Why an outbound API call failed. */
export type ApiFailureKind =
  | 'http-status'
  | 'timeout'
  | 'connection'
  | 'abort'
  | 'malformed-response'
  | 'refused';

export const API_FAILURE_KINDS: readonly ApiFailureKind[] = [
  'http-status',
  'timeout',
  'connection',
  'abort',
  'malformed-response',
  'refused',
];

/** One failed API call. */
export interface ApiFailureEntry {
  /** Provider id, 'copilot', a CatalogSourceId or an agent id. */
  readonly surface: string;
  /** Short verb noun, e.g. 'completion', 'model list'. */
  readonly operation: string;
  /** URL or model id, when known. */
  readonly target?: string;
  readonly kind: ApiFailureKind;
  /** HTTP status for 'http-status' failures. */
  readonly status?: number;
  readonly message: string;
  /** Raw response body (bounded and redacted by `failure()`). */
  readonly bodyExcerpt?: string;
}

export type ApiLogSink = (line: string) => void;

export interface ApiLog {
  failure(entry: ApiFailureEntry): void;
}

export const BODY_EXCERPT_MAX = 500;
export const REDACTED = '[REDACTED]';

/**
 * Scrub secrets from `text`: Authorization header/field values, Bearer
 * tokens, api-key / x-api-key / api_key / apikey values and long `sk-` /
 * `key-` opaque tokens. Idempotent. Over-redaction is preferred to leaking.
 */
export function redactSecrets(text: string): string {
  return text
    .replace(/\b(authorization)("?\s*[:=]\s*"?)([^\r\n"',;}]+)/gi, `$1$2${REDACTED}`)
    .replace(/\bBearer\s+(?!\[REDACTED\])[^\s"',;]+/gi, `Bearer ${REDACTED}`)
    .replace(/\b((?:x-)?api[-_]?key)("?\s*[:=]\s*"?)(?!\[REDACTED\])([^\s"'&,;}]+)/gi, `$1$2${REDACTED}`)
    .replace(/\b(?:sk|key)-[A-Za-z0-9_-]{16,}/g, REDACTED);
}

/** Collapse newlines to single spaces and trim; never longer than BODY_EXCERPT_MAX. */
export function excerpt(body: string): string {
  const collapsed = oneLine(body);
  return collapsed.length > BODY_EXCERPT_MAX ? collapsed.slice(0, BODY_EXCERPT_MAX - 1) + '…' : collapsed;
}

function oneLine(text: string): string {
  return text.replace(/\s*[\r\n]+\s*/g, ' ').trim();
}

/** Format one failure as a single, redacted line. */
export function formatApiFailure(entry: ApiFailureEntry, timestamp: string): string {
  const message = oneLine(redactSecrets(entry.message));
  const target =
    entry.target !== undefined && entry.target !== '' ? oneLine(redactSecrets(entry.target)) : undefined;
  // Redact first, then bound, so truncation cannot cut a secret below its recognisable length.
  const body =
    entry.bodyExcerpt !== undefined && entry.bodyExcerpt.trim() !== ''
      ? excerpt(redactSecrets(entry.bodyExcerpt))
      : undefined;
  return (
    `[${timestamp}] ${entry.surface} ${entry.operation} ${entry.kind}` +
    (entry.status !== undefined ? ` HTTP ${entry.status}` : '') +
    (target ? ` ${target}` : '') +
    ` — ${message}` +
    (body ? ` | body: ${body}` : '')
  );
}

/** Create a log that writes one formatted line to `sink` per `failure()` call. */
export function createApiLog(sink: ApiLogSink, now: () => string = () => new Date().toISOString()): ApiLog {
  return {
    failure(entry: ApiFailureEntry): void {
      let line: string;
      try {
        line = formatApiFailure(entry, now());
      } catch {
        return;
      }
      try {
        sink(line);
      } catch {
        /* logging must never break the call site */
      }
    },
  };
}

/** Default when a caller injects nothing, so every `apiLog?:` option stays optional. */
export const noopApiLog: ApiLog = Object.freeze({
  failure: (_entry: ApiFailureEntry): void => undefined,
});
