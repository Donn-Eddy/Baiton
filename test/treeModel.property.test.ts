import * as assert from 'assert';
import * as fc from 'fast-check';
import {
  parsePlan,
  validatePlan,
  isBlocked,
  buildPlanTree,
  legalPlanActions,
  PhaseState,
} from '../src/model';

/**
 * Property test for the host-free tree model (Requirement 4).
 *
 * Feature: baiton-ui-first-pass, Property 3: Tree model reflects parsed phases
 * and derived blocked flags
 *
 * For any valid legacy document, the tree model's phase nodes SHALL be exactly the parsed
 * phases in file order, each carrying that phase's id, title and state, and each
 * node's blocked flag SHALL equal `isBlocked` for that phase
 * (Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 20.4).
 *
 * The generator builds valid legacy documents with varied frontmatter, prose, phase
 * states, and `after`/`files` hints. Validity is guaranteed structurally:
 * ids are unique, `after` targets reference only earlier phases in the list
 * (so there is no self-reference, no missing target, and no cycle), and every
 * generated line matches the phase grammar. The property is asserted against
 * `parsePlan` + `isBlocked` (the reused cores the tree model wraps).
 */

const PHASE_STATES: readonly PhaseState[] = [
  'pending',
  'planning',
  'planned',
  'executing',
  'executed',
  'reviewing',
  'done',
  'failed',
];

/** A title fragment free of characters that would introduce structure. */
const titleFragmentArb: fc.Arbitrary<string> = fc
  .stringOf(
    fc
      .char()
      .filter(
        (c) => c !== '(' && c !== ')' && c !== ';' && c !== '\n' && c !== '\r',
      ),
    { maxLength: 30 },
  )
  .map((s) => s.replace(/\s+/g, ' ').trim())
  // A non-empty title keeps the `- [state] id title` grammar unambiguous.
  .map((s) => (s === '' ? 'task' : s));

/** Prose lines that live under OVERVIEW or between phases; never `- [`. */
const proseLineArb: fc.Arbitrary<string> = fc
  .stringOf(
    fc.char().filter((c) => c !== '\n' && c !== '\r'),
    { maxLength: 40 },
  )
  .filter((s) => !s.startsWith('- [') && !s.startsWith('#'))
  // Avoid accidental merge-conflict markers, which the validator flags.
  .filter(
    (s) =>
      !s.startsWith('<<<<<<<') && !s.startsWith('=======') && !s.startsWith('>>>>>>>'),
  );

/** Frontmatter as flat, order-preserving `key: value` lines. */
const frontmatterArb: fc.Arbitrary<string[]> = fc
  .array(
    fc.record({
      key: fc
        .stringOf(
          fc.char().filter((c) => /[a-z_]/.test(c)),
          { minLength: 1, maxLength: 10 },
        )
        .filter((s) => s !== ''),
      value: fc
        .stringOf(
          fc.char().filter((c) => c !== '\n' && c !== '\r' && c !== ':'),
          { maxLength: 20 },
        )
        .map((s) => s.trim()),
    }),
    { maxLength: 4 },
  )
  .map((entries) => entries.map((e) => `${e.key}: ${e.value}`));

/**
 * These generated `# OVERVIEW` + `# TODOS` + T## documents are explicit legacy
 * fixtures; a separate case below covers plan.md and P## phases.
 * A specification of a valid legacy document: phases where each phase may depend
 * only on the ids of phases declared before it (guaranteeing acyclic, non-self,
 * present dependencies), plus optional files hints, frontmatter and prose.
 */
interface LegacyDocumentFixture {
  frontmatter: string[];
  /** An optional `pr:` frontmatter value; '' models a present-but-empty key. */
  pr: string | undefined;
  /** The approval fact the PlanStore would supply for the document. */
  approved: boolean;
  overviewProse: string[];
  phases: { state: PhaseState; title: string; afterIdx: number[]; files: string[] }[];
}

/** A recorded PR URL, an empty value, or no `pr:` key at all. */
const prArb: fc.Arbitrary<string | undefined> = fc.option(
  fc.constantFrom(
    'https://example.com/org/repo/pull/1',
    '  https://example.com/org/repo/pull/2  ',
    '',
    '   ',
  ),
  { nil: undefined },
);

const legacyDocumentFixtureArb: fc.Arbitrary<LegacyDocumentFixture> = fc
  .record({
    frontmatter: frontmatterArb,
    pr: prArb,
    approved: fc.boolean(),
    overviewProse: fc.array(proseLineArb, { maxLength: 3 }),
    count: fc.integer({ min: 0, max: 6 }),
  })
  .chain(({ frontmatter, pr, approved, overviewProse, count }) => {
    const todoArbs: fc.Arbitrary<{
      state: PhaseState;
      title: string;
      afterIdx: number[];
      files: string[];
    }>[] = [];
    for (let i = 0; i < count; i++) {
      todoArbs.push(
        fc.record({
          state: fc.constantFrom(...PHASE_STATES),
          title: titleFragmentArb,
          // `after` targets reference only earlier phases (indices < i).
          afterIdx:
            i === 0
              ? fc.constant<number[]>([])
              : fc.uniqueArray(fc.integer({ min: 0, max: i - 1 }), {
                  maxLength: i,
                }),
          files: fc.array(
            fc
              .stringOf(
                fc.char().filter((c) => /[a-zA-Z0-9_./-]/.test(c)),
                { minLength: 1, maxLength: 15 },
              )
              .filter((s) => s !== '' && !s.includes(',')),
            { maxLength: 3 },
          ),
        }),
      );
    }
    return fc.tuple(...todoArbs).map((phases) => ({
      frontmatter,
      pr,
      approved,
      overviewProse,
      phases,
    }));
  });

/** Renders a LegacyDocumentFixture. Legacy ids are assigned as T00, T01, ... */
function renderLegacyDocument(fixture: LegacyDocumentFixture): string {
  const lines: string[] = [];

  // The `pr:` line goes last so it wins if the random frontmatter happened to
  // generate a `pr` key too (the parser's map keeps the last value).
  const frontmatterLines = [...fixture.frontmatter];
  if (fixture.pr !== undefined) {
    frontmatterLines.push(`pr: ${fixture.pr}`);
  }
  if (frontmatterLines.length > 0) {
    lines.push('---');
    lines.push(...frontmatterLines);
    lines.push('---');
  }

  lines.push('# OVERVIEW', '');
  lines.push(...fixture.overviewProse);
  lines.push('', '# TODOS', '');

  const id = (idx: number) => 'T' + String(idx).padStart(2, '0');

  fixture.phases.forEach((phase, idx) => {
    const hintGroups: string[] = [];
    if (phase.afterIdx.length > 0) {
      hintGroups.push('after ' + phase.afterIdx.map((i) => id(i)).join(', '));
    }
    if (phase.files.length > 0) {
      hintGroups.push('files: ' + phase.files.join(', '));
    }
    const hints = hintGroups.length > 0 ? ` (${hintGroups.join('; ')})` : '';
    lines.push(`- [${phase.state}] ${id(idx)} ${phase.title}${hints}`);
  });

  return lines.join('\n');
}

describe('tree model (property)', () => {
  it('builds plan nodes with P phases and records their kind', () => {
    const raw = [
      '## Endstate',
      'A working result.',
      '## What needs changing',
      'Implement the behavior.',
      '## Limitations & constraints',
      'Keep the public API stable.',
      '# PHASES',
      '- [pending] P01 First phase',
    ].join('\n');
    const nodes = buildPlanTree([{
      slug: 'plan-demo',
      raw,
      approved: false,
      sessions: new Set<string>(),
      plans: new Set<string>(),
    }]);
    assert.strictEqual(nodes[0].kind, 'plan');
    assert.strictEqual(nodes[0].children.kind, 'phases');
    if (nodes[0].children.kind === 'phases') {
      assert.deepStrictEqual(nodes[0].children.phases.map((phase) => phase.id), ['P01']);
    }
  });

  // Feature: baiton-ui-first-pass, Property 3: Tree model reflects parsed phases
  // and derived blocked flags
  it('tree phase nodes equal parsed phases in order with matching id/title/state and blocked flag', () => {
    fc.assert(
      fc.property(legacyDocumentFixtureArb, (fixture) => {
        const raw = renderLegacyDocument(fixture);

        // Guard: the generator is designed to produce valid legacy documents.
        // Invalid generated documents point to a generator, not a model defect,
        // so skip it rather than assert the property on invalid input.
        const parsed = parsePlan(raw);
        fc.pre(validatePlan(parsed, raw).length === 0);

        const nodes = buildPlanTree([
          {
            slug: 'demo',
            raw,
            approved: false,
            sessions: new Set<string>(),
            plans: new Set<string>(),
          },
        ]);
        assert.strictEqual(nodes.length, 1);
        const node = nodes[0];

        // A valid legacy document is not invalid and carries phase children.
        assert.strictEqual(node.invalid, false);
        assert.strictEqual(node.children.kind, 'phases');
        assert.strictEqual(node.kind, 'legacy-spec');
        if (node.children.kind !== 'phases') {
          return;
        }
        const phaseNodes = node.children.phases;

        // Exactly the parsed phases, in file order.
        assert.strictEqual(phaseNodes.length, parsed.phases.length);
        parsed.phases.forEach((phase, i) => {
          const tn = phaseNodes[i];
          assert.strictEqual(tn.slug, 'demo');
          assert.strictEqual(tn.id, phase.id);
          assert.strictEqual(tn.title, phase.title);
          assert.strictEqual(tn.state, phase.state);
          // Blocked flag equals the reused core for that phase.
          assert.strictEqual(tn.blocked, isBlocked(phase, parsed.phases));
        });
      }),
      { numRuns: 200 },
    );
  });

  // The plan root carries the trimmed frontmatter `pr` URL and exactly the
  // actions the host-free `legalPlanActions` derives from its own facts.
  it('plan root prUrl and actions equal the derived frontmatter pr and legalPlanActions', () => {
    fc.assert(
      fc.property(legacyDocumentFixtureArb, (fixture) => {
        const raw = renderLegacyDocument(fixture);

        const parsed = parsePlan(raw);
        fc.pre(validatePlan(parsed, raw).length === 0);

        const approved = fixture.approved;
        const nodes = buildPlanTree([
          {
            slug: 'demo',
            raw,
            approved,
            sessions: new Set<string>(),
            plans: new Set<string>(),
          },
        ]);
        const node = nodes[0];

        // Derive the expectation from what the parser actually read, not from
        // the generator's intent: the random frontmatter may also carry `pr`.
        const rawPr = parsed.frontmatter.get('pr');
        const trimmed = rawPr === undefined ? undefined : rawPr.trim();
        const expectedPrUrl = trimmed === undefined || trimmed === '' ? undefined : trimmed;
        assert.strictEqual(node.prUrl, expectedPrUrl);

        assert.deepStrictEqual(
          node.actions,
          legalPlanActions({
            approved,
            invalid: false,
            prUrl: expectedPrUrl,
            phaseStates: parsed.phases.map((t) => t.state),
          }),
        );

        // Spelled out against the rules, independently of the function above.
        if (expectedPrUrl !== undefined) {
          assert.deepStrictEqual(node.actions, ['showPr']);
        } else {
          assert.strictEqual(node.actions.includes('approve'), !approved);
          assert.strictEqual(
            node.actions.includes('submitPr'),
            approved &&
              parsed.phases.length > 0 &&
              parsed.phases.every((t) => t.state === 'done'),
          );
        }
      }),
      { numRuns: 200 },
    );
  });
});
