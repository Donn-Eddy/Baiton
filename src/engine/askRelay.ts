/**
 * The ask-relay file protocol (harness permission asks relayed into the chat).
 * A launched run's `.baiton/runs/<run-id>/asks/<ask-id>.json` is the ask;
 * `<ask-id>.response.json` is the answer. Parsing, validation, serialization
 * and the relay descriptor live here; the vscode-backed watcher and Auto mode
 * are wired later.
 *
 * The module is host-free: node `fs`/`path` only, with every filesystem
 * helper's io injectable ({@link AskRelayIo}) so the core is directly
 * testable without touching a real directory.
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync, renameSync } from 'fs';
import * as path from 'path';
import { Result, err, ok } from '../model/result';
import type { InterventionRequest, InterventionAnswer } from '../orchestrator/interventions';
import type { AskRelayDescriptor } from '../adapter/adapter';

/** The directory name under `.baiton/runs/<run-id>/` holding the ask files. */
export const ASKS_DIR_NAME = 'asks';

/** The file suffix of an ask file (`<ask-id>.json`). */
export const ASK_FILE_SUFFIX = '.json';

/** The file suffix of a response file (`<ask-id>.response.json`). */
export const RESPONSE_FILE_SUFFIX = '.response.json';

/** The wire-protocol version stamped on every ask and response. */
export const ASK_RELAY_VERSION = 1;

/**
 * The absolute path of a run's `asks/` directory, computed from the workspace
 * root and run id. Mirrors `allowedResultPath` in `src/engine/resultValidation.ts`.
 */
export function asksDirFor(workspaceRoot: string, runId: string): string {
  return path.join(workspaceRoot, '.baiton', 'runs', runId, ASKS_DIR_NAME);
}

/** The absolute path of an ask file inside an asks directory. */
export function askFilePath(asksDir: string, askId: string): string {
  return path.join(asksDir, askId + ASK_FILE_SUFFIX);
}

/** The absolute path of a response file inside an asks directory. */
export function responseFilePath(asksDir: string, askId: string): string {
  return path.join(asksDir, askId + RESPONSE_FILE_SUFFIX);
}

/**
 * The ask id for a file named `<id>.json`, and `undefined` for anything else.
 *
 * The response suffix is checked FIRST so `a.response.json` is never read as
 * the ask id `a.response` — otherwise the watcher would treat its own
 * responses as new asks and loop answering them. Also `undefined` for names
 * not ending in `.json`, an empty id, and any name containing a path
 * separator or `..`.
 */
export function askIdFromFileName(fileName: string): string | undefined {
  if (fileName.endsWith(RESPONSE_FILE_SUFFIX)) {
    return undefined;
  }
  if (!fileName.endsWith(ASK_FILE_SUFFIX)) {
    return undefined;
  }
  const id = fileName.slice(0, -ASK_FILE_SUFFIX.length);
  if (id.length === 0 || fileName.includes('..') || fileName.includes('/') || fileName.includes('\\')) {
    return undefined;
  }
  return id;
}

/** A harness permission ask (or question) relayed into the chat. */
export interface RelayAsk {
  /** Must equal {@link ASK_RELAY_VERSION}. */
  version: number;
  /** Non-empty; matches the file's `<ask-id>`. */
  id: string;
  /** The run the ask came from. */
  runId: string;
  /** Adapter/agent id, e.g. `'claude'`. */
  agent: string;
  /** Whether the harness wants a permission granted or a question answered. */
  kind: 'permission' | 'question';
  /** Non-empty. */
  prompt: string;
  /** Required when `kind === 'permission'`. */
  tool?: string;
  /** Tool args as JSON text (never parsed by Baiton — untrusted harness data). */
  args?: string;
  /** Human-readable 'what you are approving' text. */
  detail?: string;
  /** Question only: the offered choices. */
  options?: { id: string; label: string; detail?: string }[];
  /** Question only: whether a typed answer is accepted. */
  allowFreeText?: boolean;
  /** ISO-8601, informational. */
  createdAt?: string;
}

/** The user's answer written back for one ask. */
export interface RelayResponse {
  /** {@link ASK_RELAY_VERSION}. */
  version: number;
  /** The ask id being answered. */
  id: string;
  /** Whether the ask was approved or denied. */
  decision: 'approve' | 'deny';
  /** Option id or free text for a question. */
  answer?: string;
  /** One-line rationale / decline reason. */
  reason?: string;
  /** ISO-8601. */
  respondedAt?: string;
}

/**
 * Why an ask or response file was rejected. Both variants mean the file is
 * left alone (never answered, never deleted) and the problem surfaced.
 *
 * - `malformed-json` — the file contents were not well-formed JSON.
 * - `invalid`        — the parsed value failed the wire validation.
 */
export type AskRelayError =
  | { kind: 'malformed-json'; message: string }
  | { kind: 'invalid'; message: string };

/** Render an {@link AskRelayError} as a single user-facing line. */
export function describeAskRelayError(error: AskRelayError): string {
  return error.message;
}

/** Extract a message from an unknown thrown value. */
function errorMessage(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
}

/** True for a non-null, non-array object. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** True when `value` is a string containing at least one non-whitespace char. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** True when `value` is absent or a string. */
function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

/** Validate one `{id, label}` option entry; returns the error message or undefined. */
function optionError(option: unknown): string | undefined {
  if (!isPlainObject(option)) {
    return 'each option must be an object';
  }
  if (!isNonEmptyString(option.id)) {
    return 'each option needs a non-empty string "id"';
  }
  if (!isNonEmptyString(option.label)) {
    return 'each option needs a non-empty string "label"';
  }
  if (option.detail !== undefined && typeof option.detail !== 'string') {
    return 'each option "detail" must be a string';
  }
  return undefined;
}

/**
 * Parse a raw ask file's contents. Pure: `JSON.parse` in a try/catch, then
 * field-by-field validation. On success returns a normalized object holding
 * only the known fields — unknown extras are dropped so downstream code never
 * re-exports untrusted harness data verbatim.
 */
export function parseAsk(rawContents: string): Result<RelayAsk, AskRelayError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContents);
  } catch (cause) {
    return err({
      kind: 'malformed-json',
      message: `ask is not well-formed JSON: ${errorMessage(cause)}`,
    });
  }
  if (!isPlainObject(parsed)) {
    return err({ kind: 'invalid', message: 'ask must be a JSON object' });
  }
  if (parsed.version !== ASK_RELAY_VERSION) {
    return err({
      kind: 'invalid',
      message: `unsupported ask relay version ${JSON.stringify(parsed.version)}`,
    });
  }
  if (!isNonEmptyString(parsed.id)) {
    return err({ kind: 'invalid', message: 'ask "id" must be a non-empty string' });
  }
  if (!isNonEmptyString(parsed.runId)) {
    return err({ kind: 'invalid', message: 'ask "runId" must be a non-empty string' });
  }
  if (!isNonEmptyString(parsed.agent)) {
    return err({ kind: 'invalid', message: 'ask "agent" must be a non-empty string' });
  }
  if (!isNonEmptyString(parsed.prompt)) {
    return err({ kind: 'invalid', message: 'ask "prompt" must be a non-empty string' });
  }
  if (parsed.kind !== 'permission' && parsed.kind !== 'question') {
    return err({
      kind: 'invalid',
      message: 'ask "kind" must be "permission" or "question"',
    });
  }
  if (parsed.kind === 'permission' && !isNonEmptyString(parsed.tool)) {
    return err({ kind: 'invalid', message: 'a permission ask needs a non-empty "tool"' });
  }
  if (!isOptionalString(parsed.args)) {
    return err({ kind: 'invalid', message: 'ask "args" must be a string' });
  }
  if (!isOptionalString(parsed.detail)) {
    return err({ kind: 'invalid', message: 'ask "detail" must be a string' });
  }
  if (!isOptionalString(parsed.createdAt)) {
    return err({ kind: 'invalid', message: 'ask "createdAt" must be a string' });
  }
  if (parsed.options !== undefined) {
    if (!Array.isArray(parsed.options)) {
      return err({ kind: 'invalid', message: 'ask "options" must be an array' });
    }
    for (const option of parsed.options) {
      const problem = optionError(option);
      if (problem !== undefined) {
        return err({ kind: 'invalid', message: `ask "options": ${problem}` });
      }
    }
  }
  if (parsed.allowFreeText !== undefined && typeof parsed.allowFreeText !== 'boolean') {
    return err({ kind: 'invalid', message: 'ask "allowFreeText" must be a boolean' });
  }

  const ask: RelayAsk = {
    version: parsed.version,
    id: parsed.id,
    runId: parsed.runId,
    agent: parsed.agent,
    kind: parsed.kind,
    prompt: parsed.prompt,
  };
  if (parsed.tool !== undefined) {
    ask.tool = parsed.tool as string;
  }
  if (parsed.args !== undefined) {
    ask.args = parsed.args as string;
  }
  if (parsed.detail !== undefined) {
    ask.detail = parsed.detail as string;
  }
  if (parsed.options !== undefined) {
    ask.options = (parsed.options as Record<string, unknown>[]).map((option) => {
      const mapped: { id: string; label: string; detail?: string } = {
        id: option.id as string,
        label: option.label as string,
      };
      if (option.detail !== undefined) {
        mapped.detail = option.detail as string;
      }
      return mapped;
    });
  }
  if (parsed.allowFreeText !== undefined) {
    ask.allowFreeText = parsed.allowFreeText as boolean;
  }
  if (parsed.createdAt !== undefined) {
    ask.createdAt = parsed.createdAt as string;
  }
  return ok(ask);
}

/**
 * Parse a raw response file's contents. Same shape as {@link parseAsk}:
 * `malformed-json` for unparseable text, `invalid` (message naming the
 * offending field) for anything outside the wire schema.
 */
export function parseResponse(rawContents: string): Result<RelayResponse, AskRelayError> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawContents);
  } catch (cause) {
    return err({
      kind: 'malformed-json',
      message: `response is not well-formed JSON: ${errorMessage(cause)}`,
    });
  }
  if (!isPlainObject(parsed)) {
    return err({ kind: 'invalid', message: 'response must be a JSON object' });
  }
  if (parsed.version !== ASK_RELAY_VERSION) {
    return err({
      kind: 'invalid',
      message: `unsupported response relay version ${JSON.stringify(parsed.version)}`,
    });
  }
  if (!isNonEmptyString(parsed.id)) {
    return err({ kind: 'invalid', message: 'response "id" must be a non-empty string' });
  }
  if (parsed.decision !== 'approve' && parsed.decision !== 'deny') {
    return err({
      kind: 'invalid',
      message: 'response "decision" must be "approve" or "deny"',
    });
  }
  if (!isOptionalString(parsed.answer)) {
    return err({ kind: 'invalid', message: 'response "answer" must be a string' });
  }
  if (!isOptionalString(parsed.reason)) {
    return err({ kind: 'invalid', message: 'response "reason" must be a string' });
  }
  if (!isOptionalString(parsed.respondedAt)) {
    return err({ kind: 'invalid', message: 'response "respondedAt" must be a string' });
  }

  const response: RelayResponse = {
    version: parsed.version,
    id: parsed.id,
    decision: parsed.decision,
  };
  if (parsed.answer !== undefined) {
    response.answer = parsed.answer as string;
  }
  if (parsed.reason !== undefined) {
    response.reason = parsed.reason as string;
  }
  if (parsed.respondedAt !== undefined) {
    response.respondedAt = parsed.respondedAt as string;
  }
  return ok(response);
}

/**
 * Serialize an ask with a stable field order, 2-space indent and a trailing
 * newline, so a hook writing the file by hand and Baiton's own writes look
 * identical (byte-for-byte).
 */
export function serializeAsk(ask: RelayAsk): string {
  const wire: Record<string, unknown> = {
    version: ask.version,
    id: ask.id,
    runId: ask.runId,
    agent: ask.agent,
    kind: ask.kind,
    prompt: ask.prompt,
    tool: ask.tool,
    args: ask.args,
    detail: ask.detail,
    options: ask.options,
    allowFreeText: ask.allowFreeText,
    createdAt: ask.createdAt,
  };
  return `${JSON.stringify(wire, null, 2)}\n`;
}

/**
 * Serialize a response the same way as {@link serializeAsk}: stable field
 * order, 2-space indent, trailing newline.
 */
export function serializeResponse(response: RelayResponse): string {
  const wire: Record<string, unknown> = {
    version: response.version,
    id: response.id,
    decision: response.decision,
    answer: response.answer,
    reason: response.reason,
    respondedAt: response.respondedAt,
  };
  return `${JSON.stringify(wire, null, 2)}\n`;
}

/**
 * Bridge an ask to the intervention core: the data model the chat cards
 * render. A permission ask carries the agent, tool and (untrusted, never
 * parsed) args text; a question carries its options and free-text flag.
 */
export function toInterventionRequest(ask: RelayAsk): InterventionRequest {
  if (ask.kind === 'permission') {
    return {
      kind: 'permission',
      prompt: ask.prompt,
      agent: ask.agent,
      tool: ask.tool as string,
      ...(ask.args !== undefined ? { args: ask.args } : {}),
      ...(ask.detail !== undefined ? { detail: ask.detail } : {}),
    };
  }
  return {
    kind: 'question',
    prompt: ask.prompt,
    ...(ask.options !== undefined ? { options: ask.options } : {}),
    ...(ask.allowFreeText !== undefined ? { allowFreeText: ask.allowFreeText } : {}),
  };
}

/**
 * Bridge the user's answer back to the wire. `approved` → approve; `declined`
 * → deny (with the answer's reason, or the bare `'declined'` fallback);
 * `option`/`text` → approve carrying the answer as the response's `answer`.
 * `respondedAt` is stamped only when the caller passes it, keeping the
 * function pure and deterministic for tests.
 */
export function responseFromAnswer(
  ask: RelayAsk,
  answer: InterventionAnswer,
  respondedAt?: string,
): RelayResponse {
  const response: RelayResponse = {
    version: ASK_RELAY_VERSION,
    id: ask.id,
    decision: 'approve',
  };
  switch (answer.kind) {
    case 'approved':
      break;
    case 'declined':
      response.decision = 'deny';
      response.reason = answer.reason ?? 'declined';
      break;
    case 'option':
      response.answer = answer.optionId;
      break;
    case 'text':
      response.answer = answer.text;
      break;
  }
  if (respondedAt !== undefined) {
    response.respondedAt = respondedAt;
  }
  return response;
}

/**
 * The ask-relay descriptor handed to an adapter on launch, naming the run's
 * asks directory and the two file suffixes.
 */
export function askRelayDescriptor(workspaceRoot: string, runId: string): AskRelayDescriptor {
  return {
    protocol: 'file-v1',
    dir: asksDirFor(workspaceRoot, runId),
    askSuffix: ASK_FILE_SUFFIX,
    responseSuffix: RESPONSE_FILE_SUFFIX,
    runId,
  };
}

/**
 * The filesystem seam of the relay, injected so the core stays testable.
 * All methods are synchronous and throw on failure except where the helper
 * documents otherwise.
 */
export interface AskRelayIo {
  mkdir(dir: string): void;
  writeFile(file: string, contents: string): void;
  readFile(file: string): string;
  readdir(dir: string): string[];
}

/** The real node `fs`-backed {@link AskRelayIo}. */
export const nodeAskRelayIo: AskRelayIo = {
  mkdir(dir: string): void {
    mkdirSync(dir, { recursive: true });
  },
  writeFile(file: string, contents: string): void {
    writeFileSync(file, contents, 'utf8');
  },
  readFile(file: string): string {
    return readFileSync(file, 'utf8');
  },
  readdir(dir: string): string[] {
    return readdirSync(dir);
  },
};

/**
 * Create (idempotently) the run's asks directory and return its path.
 */
export function ensureAsksDir(workspaceRoot: string, runId: string, io: AskRelayIo = nodeAskRelayIo): string {
  const dir = asksDirFor(workspaceRoot, runId);
  io.mkdir(dir);
  return dir;
}

/**
 * Write a response file atomically and return its path.
 *
 * When `io` is the node one the contents go to a `<id>.response.json.tmp`
 * sibling first and are renamed into place, so a watcher reading the
 * directory never observes a partially written response. Custom io
 * implementations are written directly.
 */
export function writeResponse(asksDir: string, response: RelayResponse, io: AskRelayIo = nodeAskRelayIo): string {
  const file = responseFilePath(asksDir, response.id);
  if (io === nodeAskRelayIo) {
    const tmp = `${file}.tmp`;
    io.writeFile(tmp, serializeResponse(response));
    renameSync(tmp, file);
  } else {
    io.writeFile(file, serializeResponse(response));
  }
  return file;
}

/**
 * The ids whose ask file exists and whose response file does not yet, sorted.
 * A missing directory is swallowed and yields `[]` rather than a throw; any
 * other read failure propagates.
 */
export function listPendingAskIds(asksDir: string, io: AskRelayIo = nodeAskRelayIo): string[] {
  let entries: string[];
  try {
    entries = io.readdir(asksDir);
  } catch (cause) {
    if (
      typeof cause === 'object' &&
      cause !== null &&
      (cause as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      return [];
    }
    throw cause;
  }
  const pending: string[] = [];
  for (const entry of entries) {
    const askId = askIdFromFileName(entry);
    if (askId === undefined) {
      continue;
    }
    try {
      io.readFile(responseFilePath(asksDir, askId));
    } catch (cause) {
      if (
        typeof cause === 'object' &&
        cause !== null &&
        (cause as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        pending.push(askId);
        continue;
      }
      throw cause;
    }
  }
  return pending.sort();
}
