import * as assert from 'assert';
import * as path from 'path';
import * as fc from 'fast-check';
import {
  allowedResultPath,
  isAllowedSubAgentWrite,
} from '../src/engine/resultValidation';

/**
 * Property test for sub-agent write confinement under `.baiton/`
 * (Requirements 24.1, 24.2; design "Stage engine: result watcher").
 *
 * Feature: baiton-first-pass, Property 22: Sub-agent write confinement
 *
 * For any path a Sub_Agent attempts to write under `.baiton/`,
 * `isAllowedSubAgentWrite(workspaceRoot, runId, target)` returns true if and
 * only if `target` resolves to exactly that Sub_Agent's own
 * `runs/<run-id>/result.json` (Req 24.1). Every other write under `.baiton/` is
 * denied — a sibling run's `result.json`, the run's own `brief.md`, a nested
 * path below the run dir, a `..` traversal that lands on another run, and any
 * arbitrary `.baiton/` path (Req 24.2).
 *
 * The oracle is independent of the implementation: a target is permitted iff
 * its resolved absolute path is byte-for-byte equal to the resolved allowed
 * path (`allowedResultPath(root, runId)`). Targets are generated across the
 * required families so both the true and false branches are exercised, and the
 * single positive family (the exact allowed path, expressed absolutely and
 * relatively) guarantees the "iff" is non-vacuous.
 */

/** Path-safe id segment: lowercase letters, digits, and dashes. */
const idSegmentArb: fc.Arbitrary<string> = fc
  .stringOf(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789-'.split('')), {
    minLength: 1,
    maxLength: 12,
  })
  .filter((s) => s.length > 0 && s !== '.' && s !== '..');

/** A generated workspace root — absolute, with 0..3 leading segments. */
const workspaceRootArb: fc.Arbitrary<string> = fc
  .array(idSegmentArb, { minLength: 0, maxLength: 3 })
  .map((segs) => path.resolve(path.sep, 'ws', ...segs));

/** A run id distinct from a chosen "other" run id (kept unequal for siblings). */
const runIdArb: fc.Arbitrary<string> = idSegmentArb;

describe('Sub-agent write confinement (property harness)', () => {
  // Feature: baiton-first-pass, Property 22: Sub-agent write confinement
  it('permits a write iff it resolves to exactly runs/<run-id>/result.json', () => {
    fc.assert(
      fc.property(
        workspaceRootArb,
        runIdArb,
        idSegmentArb,
        fc.array(idSegmentArb, { minLength: 1, maxLength: 3 }),
        fc.string({ maxLength: 20 }),
        (root, runId, otherIdRaw, nestedTail, arbitraryLeaf) => {
          // Ensure the sibling run id differs from this run's id.
          const otherId = otherIdRaw === runId ? `${runId}-x` : otherIdRaw;

          const allowed = allowedResultPath(root, runId);
          const runsDir = path.join(root, '.baiton', 'runs');
          const ownRunDir = path.join(runsDir, runId);

          // Target families: exactly one permitted family, the rest denied.
          const targets: { target: string; expected: boolean; why: string }[] = [
            // Permitted: the exact allowed path, absolute.
            { target: allowed, expected: true, why: 'exact allowed path (absolute)' },
            // Permitted: the exact allowed path expressed relative to the root.
            {
              target: path.join('.baiton', 'runs', runId, 'result.json'),
              expected: true,
              why: 'exact allowed path (relative to root)',
            },
            // Denied: a sibling run's result.json.
            {
              target: path.join(runsDir, otherId, 'result.json'),
              expected: false,
              why: 'sibling run result.json',
            },
            // Denied: this run's own brief.md.
            {
              target: path.join(ownRunDir, 'brief.md'),
              expected: false,
              why: "own run's brief.md",
            },
            // Denied: a nested path below the run dir.
            {
              target: path.join(ownRunDir, ...nestedTail, 'result.json'),
              expected: false,
              why: 'nested path below the run dir',
            },
            // Denied: a `..` traversal that climbs to another run's result.json.
            {
              target: path.join(ownRunDir, '..', otherId, 'result.json'),
              expected: false,
              why: 'traversal to another run result.json',
            },
            // Denied: an arbitrary .baiton path.
            {
              target: path.join(root, '.baiton', `${arbitraryLeaf || 'x'}.json`),
              expected: false,
              why: 'arbitrary .baiton path',
            },
          ];

          for (const { target, expected, why } of targets) {
            // Independent oracle: resolved target equals the resolved allowed path.
            const resolvedTarget = path.resolve(
              path.isAbsolute(target) ? target : path.join(root, target),
            );
            const oracle = resolvedTarget === path.resolve(allowed);
            assert.strictEqual(
              oracle,
              expected,
              `oracle disagrees with the family expectation for ${why}: ${target}`,
            );

            const actual = isAllowedSubAgentWrite(root, runId, target);
            assert.strictEqual(
              actual,
              expected,
              `isAllowedSubAgentWrite must be ${expected} for ${why}: ${target}`,
            );
          }
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: baiton-first-pass, Property 22: Sub-agent write confinement
  it('a traversal that lands back on the allowed path is permitted (iff by resolution, not by spelling)', () => {
    fc.assert(
      fc.property(workspaceRootArb, runIdArb, idSegmentArb, (root, runId, detour) => {
        // runs/<run-id>/../<run-id>/result.json normalizes to the allowed path.
        const ownRunDir = path.join(root, '.baiton', 'runs', runId);
        const roundTrip = path.join(ownRunDir, '..', runId, 'result.json');
        assert.strictEqual(
          isAllowedSubAgentWrite(root, runId, roundTrip),
          true,
          'a traversal normalizing back to the allowed path must be permitted',
        );

        // But a traversal into a *different* run dir is denied.
        const detourId = detour === runId ? `${runId}-y` : detour;
        const escaped = path.join(ownRunDir, '..', detourId, 'result.json');
        assert.strictEqual(
          isAllowedSubAgentWrite(root, runId, escaped),
          false,
          'a traversal into a different run dir must be denied',
        );
      }),
      { numRuns: 200 },
    );
  });
});
