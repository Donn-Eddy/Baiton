import * as assert from 'assert';
import * as fc from 'fast-check';
import { DocumentKind, parsePlan } from '../src/model/parser';
import { validatePlan } from '../src/model/validator';
import { PHASE_STATES, PhaseState } from '../src/model/phaseState';

/**
 * Feature: baiton-first-pass, Property 3: Validator flags each malformed
 * construct
 *
 * For any document that contains at least one of — a `- [` line violating the phase
 * grammar, two phases sharing an id, an unknown state value, an `after`
 * reference to an absent id, a phase listing its own id in `after`, or a
 * merge-conflict marker on any line — the validator SHALL report the document
 * invalid and SHALL leave the document text unchanged, and for any document free of all
 * such constructs and of dependency cycles the validator SHALL report it valid.
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.8
 *
 * Strategy: generate a clean, acyclic base document (unique ids, known states,
 * every `after` target present, no self-references, no conflict markers). The
 * base is asserted valid. Then, for the invalid half, inject exactly one
 * malformed construct into that base and assert the validator reports at least
 * one error while leaving the raw text byte-for-byte unchanged.
 * The generated OVERVIEW/phases/T## documents are legacy fixtures; a separate
 * prefix mutation property covers both document kinds.
 */

// --- Shared generators -----------------------------------------------------

/** A phase id uses P for plans or T for the legacy format. */
const idArb = (kind: DocumentKind): fc.Arbitrary<string> => fc
  .integer({ min: 0, max: 999999 })
  .map((n) => (kind === 'plan' ? 'P' : 'T') + String(n).padStart(2, '0'));

/**
 * A phase title with no characters that could form a trailing hint group, so the
 * only `after` dependencies a line carries are the ones we explicitly render.
 */
const titleArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 30 })
  .map((s) => s.replace(/[()\n\r;]/g, ' ').trim())
  .filter((s) => s.length > 0);

/** A frontmatter value with no newline (empty allowed). */
const fmValueArb: fc.Arbitrary<string> = fc
  .string({ maxLength: 20 })
  .map((s) => s.replace(/[\n\r]/g, '').trim());

/** One clean phase used to build a base document. */
interface CleanPhase {
  id: string;
  state: PhaseState;
  title: string;
  after: string[];
}

/** Renders a clean phase to a grammar-conformant item line. */
function renderPhase(t: CleanPhase): string {
  let line = `- [${t.state}] ${t.id} ${t.title}`;
  if (t.after.length > 0) {
    line += ` (after ${t.after.join(',')})`;
  }
  return line;
}

/**
 * A clean base document: unique ids, known states, `after` targets restricted to
 * OTHER present ids (so no missing target, no self-reference), and no cycles.
 * Acyclicity is guaranteed by only allowing a phase to depend on ids that appear
 * strictly earlier in the list.
 */
const baseDocumentArb: fc.Arbitrary<{ kind: DocumentKind; ids: string[]; phases: CleanPhase[]; preamble: string }> =
  fc
    .record({
      kind: fc.constantFrom<DocumentKind>('plan', 'legacy-spec'),
      preamble: fmValueArb.filter((value) => !/^#+\s+(PHASES|phases|OVERVIEW)\s*$/.test(value)),
    })
    .chain(({ kind, preamble }) =>
      fc.uniqueArray(idArb(kind), { minLength: 1, maxLength: 6 }).chain((ids) =>
        fc
          .tuple(
            ...ids.map((_id, index) =>
              fc.record({
                state: fc.constantFrom<PhaseState>(...PHASE_STATES),
                title: titleArb,
                after: fc.subarray(ids.slice(0, index)),
              }),
            ),
          )
          .map((parts) => ({
            kind,
            preamble,
            ids,
            phases: parts.map((p, i) => ({ id: ids[i], ...p })),
          })),
      ),
    );

/** Assembles the selected document kind. Legacy output is a compatibility fixture. */
function renderDocument(kind: DocumentKind, preamble: string, phaseLines: string[]): string {
  const body = kind === 'plan'
    ? ['## Endstate', preamble, '## What needs changing', 'Change behavior.', '## Limitations & constraints', 'None.', '# PHASES']
    : ['# OVERVIEW', '', preamble, '', '# TODOS'];
  return ['---', 'status: draft', '---', ...body, '', ...phaseLines].join('\n');
}

// --- Valid half ------------------------------------------------------------

describe('validator flags malformed constructs (property)', () => {
  it('rejects an item when its prefix is changed to the other document kind', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<DocumentKind>('plan', 'legacy-spec'),
        fc.constantFrom('phase work', 'review', 'change'),
        (kind, title) => {
          const prefix = kind === 'plan' ? 'P' : 'T';
          const otherPrefix = kind === 'plan' ? 'T' : 'P';
          const section = kind === 'plan' ? '# PHASES' : '# TODOS';
          const valid = section + '\n- [pending] ' + prefix + '01 ' + title;
          assert.deepStrictEqual(validatePlan(parsePlan(valid, kind), valid), []);
          const invalid = valid.replace(prefix + '01', otherPrefix + '01');
          const errors = validatePlan(parsePlan(invalid, kind), invalid);
          assert.ok(errors.some((error) => error.line === 2 && error.reason.includes('malformed id')));
        },
      ),
      { numRuns: 100 },
    );
  });

  // Feature: baiton-first-pass, Property 3: Validator flags each malformed
  // construct
  it('reports clean, acyclic documents as valid', () => {
    fc.assert(
      fc.property(baseDocumentArb, ({ kind, preamble, phases }) => {
        const raw = renderDocument(kind, preamble, phases.map(renderPhase));
        const errors = validatePlan(parsePlan(raw), raw);
        assert.deepStrictEqual(
          errors,
          [],
          `expected clean document valid, got: ${JSON.stringify(errors)}\n---\n${raw}`,
        );
      }),
      { numRuns: 150 },
    );
  });

  // --- Invalid half: inject exactly one malformed construct ----------------

  // Feature: baiton-first-pass, Property 3: Validator flags each malformed
  // construct
      it('reports a document invalid when exactly one malformed construct is injected, leaving text unchanged', () => {
    fc.assert(
      fc.property(
        baseDocumentArb,
        // Which construct to inject.
        fc.constantFrom(
          'grammar',
          'duplicate',
          'unknown-state',
          'missing-after',
          'self-after',
          'conflict',
        ),
        fc.integer({ min: 0, max: 100000 }),
        (base, mutation, seed) => {
          const raw = injectMalformed(base, mutation, seed);

          // The base itself is clean, so any invalidity comes from the injection.
          const errors = validatePlan(parsePlan(raw), raw);
          assert.ok(
            errors.length > 0,
            `expected "${mutation}" injection to be flagged invalid, but got no errors\n---\n${raw}`,
          );

          // The validator never mutates the text (Req 4.2). Re-validating the
          // same string must be idempotent and the string is untouched.
          const rawCopy = raw.slice();
          validatePlan(parsePlan(raw), raw);
          assert.strictEqual(raw, rawCopy, 'validator must leave the raw text unchanged');
        },
      ),
      { numRuns: 150 },
    );
  });
});

/**
 * Produces document text from a clean base with exactly one malformed construct
 * injected according to `mutation`. `seed` selects which phase/position is affected
 * deterministically so shrinking stays meaningful.
 */
function injectMalformed(
  base: { kind: DocumentKind; ids: string[]; phases: CleanPhase[]; preamble: string },
  mutation: string,
  seed: number,
): string {
  const lines = base.phases.map(renderPhase);
  const pick = seed % base.phases.length;

  switch (mutation) {
    case 'grammar': {
      // A `- [` line that cannot parse against the grammar (Req 4.1, 4.2).
      lines.splice(pick, 0, '- [pending] notanid missing digits');
      return renderDocument(base.kind, base.preamble, lines);
    }
    case 'duplicate': {
      const dupId = base.phases[pick].id;
      lines.push(`- [pending] ${dupId} a duplicate phase`);
      return renderDocument(base.kind, base.preamble, lines);
    }
    case 'unknown-state': {
      const phase = base.phases[pick];
      lines[pick] = `- [bogusstate] ${phase.id} ${phase.title}`;
      return renderDocument(base.kind, base.preamble, lines);
    }
    case 'missing-after': {
      const phase = base.phases[pick];
      const absent = pickAbsentId(base.ids, seed, base.kind);
      lines[pick] = `- [${phase.state}] ${phase.id} ${phase.title} (after ${absent})`;
      return renderDocument(base.kind, base.preamble, lines);
    }
    case 'self-after': {
      const phase = base.phases[pick];
      lines[pick] = `- [${phase.state}] ${phase.id} ${phase.title} (after ${phase.id})`;
      return renderDocument(base.kind, base.preamble, lines);
    }
    case 'conflict': {
      // A merge-conflict marker on some line of the file (Req 4.8).
      const marker = ['<<<<<<< HEAD', '=======', '>>>>>>> branch'][seed % 3];
      lines.splice(pick, 0, marker);
      return renderDocument(base.kind, base.preamble, lines);
    }
    default:
      throw new Error(`unknown injection kind: ${mutation}`);
  }
}

/** An id guaranteed not to be present in `ids`, for the missing-after case. */
function pickAbsentId(ids: string[], seed: number, kind: DocumentKind): string {
  let n = 1000000 + (seed % 1000000);
  const present = new Set(ids);
  const prefix = kind === 'plan' ? 'P' : 'T';
  let candidate = prefix + String(n);
  while (present.has(candidate)) {
    n += 1;
    candidate = prefix + String(n);
  }
  return candidate;
}
