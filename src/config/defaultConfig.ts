/**
 * The default {@link Config} written by the Initialize command (Requirement 1.1).
 *
 * The shape mirrors the design "Data Models > Config": a `roles` mapping with an
 * entry for every {@link Role}, a `limits` object whose three integers sit
 * within their allowed ranges (Req 2.3), and a `git` object with a `remote` and
 * `base` branch. `version` is pinned to {@link SUPPORTED_VERSION} (Req 23.5).
 *
 * Every role defaults to Claude Code running Claude Sonnet 5 at medium
 * effort. These are conservative starting values a user is expected to edit. The
 * Initialize command never overwrites an existing `config.json`, so this
 * default is only ever written when none is present (Req 1.3).
 */
import { Role } from '../model';
import { Config, RoleConfig, SUPPORTED_VERSION } from './types';

/**
 * Builds a fresh default configuration object. A factory (rather than a shared
 * constant) is used so each call yields an independent object that a caller may
 * mutate or serialize without affecting later calls.
 */
export function defaultConfig(): Config {
  const roles = {} as Record<Role, RoleConfig>;
  const roleList: readonly Role[] = [
    'spec-writer',
    'planner',
    'plan-reviewer',
    'executor',
    'reviewer',
    'pr-writer',
  ];
  for (const role of roleList) {
    roles[role] = { agent: 'claude', model: 'claude-sonnet-5', effort: 'medium' };
  }

  return {
    version: SUPPORTED_VERSION,
    roles,
    limits: {
      plan_review_rounds: 1,
      exec_attempts: 3,
      stall_notice_minutes: 10,
    },
    git: {
      remote: 'origin',
      base: 'main',
    },
    pr: { tool: 'auto' },
  };
}

/**
 * Serializes the default configuration to the exact text written to
 * `config.json`: two-space-indented JSON with a trailing newline so the file is
 * POSIX-clean and diffs cleanly when a user edits it.
 */
export function defaultConfigJson(): string {
  return `${JSON.stringify(defaultConfig(), null, 2)}\n`;
}
