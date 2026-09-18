import * as assert from 'assert';
import * as fc from 'fast-check';
import { parseSpec } from '../src/model/parser';
import {
  ConversationKind,
  DRIVE_TEXT,
  REFUSAL_TEXT,
  SCOPE_TEXT,
  buildSystemPrompt,
  phaseFor,
} from '../src/orchestrator/systemPrompt';

/**
 * Feature: baiton-first-pass, Property: the orchestrator's phase follows the
 * spec's status and nothing else.
 *
 * For ANY spec content, a spec conversation is in the `drive` phase if and only
 * if the frontmatter `status` the parser reads is one of the five values that
 * mean the spec has been approved (`approved`, `in-progress`, `review`, `pr`,
 * `done`). Every other content — `draft`, an unknown status, a malformed or
 * absent frontmatter block, arbitrary prose — is `gather`, which is the phase
 * that can still write the spec but cannot dispatch a stage (Req 11.1).
 *
 * Validates: Requirement 11.1
 *
 * Strategy: generate spec-shaped content whose frontmatter is assembled from
 * arbitrary keys and values (sometimes including `status`, sometimes not,
 * sometimes with a broken fence), plus free-form text that is not a spec at
 * all. For each, the property compares `phaseFor` against the status
 * `parseSpec` itself reports, so the test cannot drift from the parser. The
 * scope and refusal text must survive in both phases, and the drive text must
 * appear exactly when the phase is `drive`.
 */

const SPEC: ConversationKind = { kind: 'spec', slug: 'my-spec' };
const WORKSPACE: ConversationKind = { kind: 'workspace' };

/** The statuses that mean the spec is being driven (Req 11.1). */
const DRIVE_STATUSES = ['approved', 'in-progress', 'review', 'pr', 'done'];

/** A frontmatter value: the real enum values plus near-misses and noise. */
const statusValueArb: fc.Arbitrary<string> = fc.oneof(
  fc.constantFrom(
    'draft',
    'approved',
    'in-progress',
    'review',
    'pr',
    'done',
    'DRAFT',
    'Approved',
    'approved ',
    ' approved',
    'approvedish',
    'in progress',
    '',
  ),
  fc.stringOf(
    fc.char().filter((c) => c !== '\n' && c !== '\r' && c !== ':'),
    { maxLength: 12 },
  ),
);

/** An arbitrary non-`status` frontmatter line. */
const otherKeyArb: fc.Arbitrary<string> = fc
  .constantFrom('version', 'name', 'mode', 'base', 'branch', 'approved_rev', 'statuses')
  .chain((key) =>
    fc
      .stringOf(
        fc.char().filter((c) => c !== '\n' && c !== '\r'),
        { maxLength: 10 },
      )
      .map((value) => `${key}: ${value}`),
  );

/** Spec-shaped content: an optional frontmatter block plus a body. */
const specContentArb: fc.Arbitrary<string> = fc
  .record({
    withFence: fc.boolean(),
    closed: fc.boolean(),
    withStatus: fc.boolean(),
    status: statusValueArb,
    others: fc.array(otherKeyArb, { maxLength: 3 }),
    body: fc.array(
      fc.constantFrom(
        '# OVERVIEW',
        '',
        'Some prose about the work.',
        '# TODOS',
        '- [pending] T01 Do the first thing',
        '- [done] T02 Do the second thing',
        'status: approved',
      ),
      { maxLength: 6 },
    ),
  })
  .map(({ withFence, closed, withStatus, status, others, body }) => {
    const lines: string[] = [];
    if (withFence) {
      lines.push('---');
      lines.push(...others);
      if (withStatus) {
        lines.push(`status: ${status}`);
      }
      if (closed) {
        lines.push('---');
      }
    }
    lines.push(...body);
    return lines.join('\n');
  });

/** Free-form content that is not spec-shaped at all. */
const freeTextArb: fc.Arbitrary<string> = fc.string({ maxLength: 120 });

const contentArb: fc.Arbitrary<string> = fc.oneof(specContentArb, freeTextArb);

describe('orchestrator phase derivation (property, Req 11.1)', () => {
  // Feature: baiton-first-pass, Property: phase follows the parsed status
  it('is drive if and only if the parsed status is a non-draft enum value', () => {
    fc.assert(
      fc.property(contentArb, (content) => {
        const parsedStatus = (parseSpec(content).frontmatter.get('status') ?? '').trim();
        const expected = DRIVE_STATUSES.includes(parsedStatus) ? 'drive' : 'gather';
        assert.strictEqual(
          phaseFor(SPEC, content),
          expected,
          `status "${parsedStatus}" should be ${expected}\n---\n${content}`,
        );
      }),
      { numRuns: 500 },
    );
  });

  // Feature: baiton-first-pass, Property: a workspace conversation never drives
  it('is gather for a workspace conversation whatever content is passed', () => {
    fc.assert(
      fc.property(contentArb, (content) => {
        assert.strictEqual(phaseFor(WORKSPACE, content), 'gather');
      }),
      { numRuns: 200 },
    );
  });

  // Feature: baiton-first-pass, Property: scope is stated in every prompt
  it('always states the scope and the refusal rule, and the drive text exactly when driving', () => {
    fc.assert(
      fc.property(contentArb, (content) => {
        const prompt = buildSystemPrompt(SPEC, content);
        assert.ok(prompt.includes(SCOPE_TEXT), 'every prompt states the scope');
        assert.ok(prompt.includes(REFUSAL_TEXT), 'every prompt states the refusal rule');
        assert.strictEqual(
          prompt.includes(DRIVE_TEXT),
          phaseFor(SPEC, content) === 'drive',
          'the drive text appears exactly in the drive phase',
        );
      }),
      { numRuns: 300 },
    );
  });
});
