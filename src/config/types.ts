/**
 * Configuration data model and error taxonomy for the Baiton `.baiton/config.json`
 * file (Requirement 2, Requirement 23.5/23.6).
 *
 * The {@link Config} shape mirrors the design "Data Models > Config": a `roles`
 * mapping (one entry per {@link Role}), a `limits` object with three bounded
 * integers, a `git` object, an optional `pr` seam carried from the tech sheet
 * (unused in the first pass), and a `version` pinned to 1 on read.
 */
import { Role } from '../model';

/** The single configuration schema version this build supports (Req 23.5). */
export const SUPPORTED_VERSION = 1 as const;

/**
 * A single role assignment in the `roles` mapping. `agent` and `model` are
 * required; `effort` is an optional reasoning-effort hint (Req 2.2).
 */
export interface RoleConfig {
  agent: string;
  model: string;
  effort?: string;
}

/**
 * The `limits` object. Each field is an integer constrained to the closed range
 * noted beside it (Req 2.3). The ranges are enforced by {@link loadConfig}.
 */
export interface Limits {
  /** Number of plan-review rounds, 0..10. */
  plan_review_rounds: number;
  /** Number of execute attempts, 1..10. */
  exec_attempts: number;
  /** Idle-notice threshold in minutes, 1..1440. */
  stall_notice_minutes: number;
}

/** The `git` object: remote name, base branch, and an optional verify command (Req 2.4). */
export interface GitConfig {
  remote: string;
  base: string;
  verify?: string;
}

/**
 * The fully validated configuration. `version` is pinned to the supported
 * version on read (Req 23.5). `pr` is an extension seam present in the sheet
 * but unused in the first pass.
 */
export interface Config {
  version: typeof SUPPORTED_VERSION;
  roles: Record<Role, RoleConfig>;
  limits: Limits;
  git: GitConfig;
  pr?: { tool: string };
}

/** The inclusive integer bounds enforced on each `limits` field (Req 2.3). */
export const LIMIT_BOUNDS: Record<keyof Limits, { min: number; max: number }> = {
  plan_review_rounds: { min: 0, max: 10 },
  exec_attempts: { min: 1, max: 10 },
  stall_notice_minutes: { min: 1, max: 1440 },
};

/**
 * Why loading configuration failed. Each variant carries a user-facing
 * `message` and the fields the caller needs to react (Req 2.5–2.8, 23.6).
 *
 * - `absent`      — no `config.json` at the expected path (Req 2.7).
 * - `unparseable` — the file exists but is not valid JSON (Req 2.7).
 * - `missing-section` — a required section (`version`/`roles`/`limits`/`git`)
 *   is missing or malformed; `section` names the offending part (Req 2.7).
 * - `invalid-version` — `version` is absent or not a positive integer, so the
 *   document cannot be interpreted (Req 23.6).
 * - `version-too-new` — `version` exceeds the supported version; `required`
 *   reports the extension version the user needs (Req 2.5).
 * - `migration-failed` — an older config could not be migrated or persisted;
 *   the original file is left unchanged (Req 2.8).
 */
export type ConfigError =
  | { kind: 'absent'; path: string; message: string }
  | { kind: 'unparseable'; path: string; message: string }
  | { kind: 'missing-section'; section: string; message: string }
  | { kind: 'invalid-version'; message: string }
  | { kind: 'version-too-new'; found: number; supported: number; message: string }
  | { kind: 'migration-failed'; from: number; message: string };
