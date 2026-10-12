/**
 * Derived blocked status and the content hashes (Requirements 4.10, 5.1, 18.5).
 *
 * These are pure functions over a {@link ParsedPlan}. `isBlocked` derives a
 * phase's blocked status from its `after` targets and is NEVER written back into
 * the document (Req 4.10). `approvalHash` and `computeInputRev` produce stable
 * SHA-256 digests over document content: the approval hash ties approval to the
 * OVERVIEW plus every phase line with its state box blanked (Req 5.1), and the
 * input rev ties a plan to the OVERVIEW plus a single phase's line (Req 18.5,
 * the Input_Rev definition).
 */
import { createHash } from 'crypto';
import { ParsedPlan, Phase } from './parser';

/**
 * Whether a phase is blocked: true if and only if at least one of its `after`
 * targets is in a state other than `done` (Req 4.10). An `after` id with no
 * matching phase in `all` is treated as not-done and therefore blocking, since
 * an unmet/unknown dependency cannot be considered complete.
 *
 * This status is derived on demand and is never persisted into the document.
 */
export function isBlocked(phase: Phase, all: Phase[]): boolean {
  if (phase.after.length === 0) {
    return false;
  }
  const byId = new Map<string, Phase>();
  for (const t of all) {
    byId.set(t.id, t);
  }
  return phase.after.some((depId) => {
    const dep = byId.get(depId);
    return dep === undefined || dep.state !== 'done';
  });
}

/**
 * The Approval_Hash: a SHA-256 over the document preamble combined with every
 * phase line whose state box has been blanked to `[]`, excluding all other
 * frontmatter and prose (Req 5.1). Blanking the state box makes the hash
 * invariant under lifecycle state changes while remaining sensitive to the
 * preamble and to any phase title, id or hints (design Property 7). The
 * `repo:` hint is part of the hinted content and is deliberately hashed as
 * written, without path normalization.
 */
export function approvalHash(plan: ParsedPlan): string {
  const blankedPhaseLines = plan.phases.map((phase) =>
    blankStateBox(plan.rawLines[phase.lineIndex]),
  );
  return sha256(hashPayload(plan.preamble, blankedPhaseLines));
}

/**
 * The Input_Rev for a single phase: a SHA-256 over the preamble combined
 * with that phase's line (Req 18.5 / the Input_Rev definition). The state box is
 * blanked so the rev is stable across the state transitions that occur between
 * recording a plan and requesting Execute, while still tracking changes to the
 * preamble or to the phase's own title, id or hints. A `repo:` hint is included
 * exactly as written and is deliberately not normalized before hashing.
 *
 * Returns the empty string when no phase with `phaseId` exists in the plan.
 */
export function computeInputRev(plan: ParsedPlan, phaseId: string): string {
  const phase = plan.phases.find((t) => t.id === phaseId);
  if (phase === undefined) {
    return '';
  }
  const blankedLine = blankStateBox(plan.rawLines[phase.lineIndex]);
  return sha256(hashPayload(plan.preamble, [blankedLine]));
}

/**
 * Replaces the first `[<state>]` box on a phase line with an empty `[]` box,
 * leaving the rest of the line untouched. Applied to the raw on-disk line so
 * the hash reflects the exact user-owned content minus the lifecycle state.
 */
function blankStateBox(line: string): string {
  return line.replace(/^(- )\[[^\]]*\]/, '$1[]');
}

/**
 * Builds the canonical byte payload for a content hash. The kind is not mixed
 * into this payload: a legacy preamble is exactly its old OVERVIEW value, so
 * existing approval and input revision hashes remain valid. The preamble and
 * each phase line are joined with a newline separator so that reordering or moving
 * content between the two sections cannot collide.
 */
function hashPayload(preamble: string, phaseLines: string[]): string {
  return [preamble, ...phaseLines].join('\n');
}

/** Hex-encoded SHA-256 digest of a UTF-8 string. */
function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}
