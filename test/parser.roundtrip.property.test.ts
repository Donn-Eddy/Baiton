import * as assert from 'assert';
import * as fc from 'fast-check';
import { DocumentKind, parsePlan, ParsedPlan, Phase } from '../src/model/parser';
import { PHASE_STATES, PhaseState } from '../src/model/phaseState';

/**
 * Feature: baiton-first-pass, Property 1: Document parse/serialize round trip —
 * For any valid document model (frontmatter, preamble prose, and a list of
 * well-formed phases with arbitrary titles, states, after and files hints),
 * serializing it to text and parsing that text back SHALL produce an equivalent
 * model, and all non-phase prose lines SHALL be preserved unchanged.
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.8
 *
 * Since a dedicated full-document serializer is not yet built (only the
 * minimal-edit writers of task 4 are planned), this test carries a small,
 * test-local canonical renderer for both document kinds. The legacy branch
 * Legacy: intentionally keeps `# OVERVIEW`, `# TODOS` and T ids as documented fixtures.
 */

/** The model a generated document is rendered from and parsed back into. */
interface DocumentModel {
  kind: DocumentKind;
  frontmatter: [string, string][];
  preambleLines: string[];
  phases: PhaseModel[];
}

interface PhaseModel {
  id: string;
  state: PhaseState;
  title: string;
  after: string[];
  files: string[];
}

/**
 * Renders a {@link DocumentModel} to canonical document text. This is the serialize
 * half of the round trip; `parsePlan` is the parse half.
 */
function renderDocument(model: DocumentModel): string {
  const lines: string[] = [];

  // Frontmatter: `---`-fenced flat `key: value`, one key per line (Req 3.1).
  lines.push('---');
  for (const [key, value] of model.frontmatter) {
    lines.push(`${key}: ${value}`);
  }
  lines.push('---');

  if (model.kind === 'legacy-spec') {
    lines.push('# OVERVIEW');
    lines.push(...model.preambleLines);
    lines.push('# TODOS');
  } else {
    lines.push('## Endstate');
    lines.push(...model.preambleLines);
    lines.push('## What needs changing');
    lines.push('Change the requested behavior.');
    lines.push('## Limitations & constraints');
    lines.push('');
    lines.push('# PHASES');
  }
  for (const t of model.phases) {
    lines.push(renderPhaseLine(t));
  }

  return lines.join('\n');
}

/** Renders one phase line: `- [state] id title` with an optional hint group. */
function renderPhaseLine(t: PhaseModel): string {
  let line = `- [${t.state}] ${t.id} ${t.title}`;
  const groups: string[] = [];
  if (t.after.length > 0) {
    groups.push(`after ${t.after.join(',')}`); // comma-separated ids (Req 3.4)
  }
  if (t.files.length > 0) {
    groups.push(`files: ${t.files.join(',')}`); // comma-separated paths (Req 3.5)
  }
  if (groups.length > 0) {
    // `;` separates hint groups (Req 3.6).
    line += ` (${groups.join('; ')})`;
  }
  return line;
}

// --- Generators ------------------------------------------------------------

/** A phase id uses the document prefix (`P`, or legacy `T`) and two or more digits (Req 3.3). */
const idArb = (kind: DocumentKind): fc.Arbitrary<string> => fc
  .integer({ min: 0, max: 999999 })
  .map((n) => (kind === 'plan' ? 'P' : 'T') + String(n).padStart(2, '0'));

/**
 * A phase title that survives the round trip: non-empty, single line, trimmed,
 * and free of the characters the hint/section grammar reserves. Excluding `(`,
 * `)`, and `;` keeps the title from ever being mistaken for (or colliding with)
 * a trailing hint group; Property 2 covers the deliberate non-hint-paren case.
 */
const titleArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 40 })
  .map((s) => s.replace(/[()\n\r;]/g, ' ').trim())
  .filter((s) => s.length > 0);

/** A file path hint: non-empty, no comma/semicolon/paren/newline. */
const pathArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 20 })
  .map((s) => s.replace(/[(),;\n\r]/g, '').trim())
  .filter((s) => s.length > 0);

/** A frontmatter key: non-empty, trimmed, no `:` or newline. */
const fmKeyArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 15 })
  .map((s) => s.replace(/[:\n\r]/g, '').trim())
  .filter((s) => s.length > 0);

/** A frontmatter value: trimmed, no newline (empty allowed). */
const fmValueArb: fc.Arbitrary<string> = fc
  .string({ maxLength: 20 })
  .map((s) => s.replace(/[\n\r]/g, '').trim());

/**
 * A preamble prose line that cannot be mistaken for a section header or a
 * frontmatter fence. Blank lines are allowed. Property 3.8 preservation is
 * asserted by comparing the joined preamble text exactly.
 */
const overviewLineArb: fc.Arbitrary<string> = fc
  .string({ maxLength: 40 })
  .map((s) => s.replace(/[\n\r]/g, ' '))
  .filter((s) => s.trim() !== '---' && !/^#+\s/.test(s));

/**
 * A full document model. Phase ids are made unique so the model has a well-defined
 * set of phases; `after` targets are drawn from the generated ids so the graph
 * references only present phases (parse equivalence, not validity, is the
 * concern here).
 */
const documentModelArb: fc.Arbitrary<DocumentModel> = fc
  .record({
    kind: fc.constantFrom<DocumentKind>('plan', 'legacy-spec'),
    frontmatter: fc.uniqueArray(fc.tuple(fmKeyArb, fmValueArb), {
      maxLength: 6,
      selector: ([k]) => k,
    }),
    preambleLines: fc.array(overviewLineArb, { maxLength: 6 }),
  })
  .chain(({ kind, frontmatter, preambleLines }) =>
    fc.uniqueArray(idArb(kind), { minLength: 0, maxLength: 6 }).chain((ids) => {
    const phaseArb =
      ids.length === 0
        ? fc.constant<PhaseModel[]>([])
        : fc.tuple(
            ...ids.map((id) =>
              fc
                .record({
                  state: fc.constantFrom<PhaseState>(...PHASE_STATES),
                  title: titleArb,
                  after: fc.subarray(ids),
                  files: fc.array(pathArb, { maxLength: 4 }),
                })
                .map((r) => ({ id, ...r }))
            )
          );
    return fc.record({
      kind: fc.constant(kind),
      frontmatter: fc.constant(frontmatter),
      preambleLines: fc.constant(preambleLines),
      phases: phaseArb,
    });
    }),
  );

// --- Property --------------------------------------------------------------

describe('parser round trip (property)', () => {
  it('Property 1: render then parse yields an equivalent model and preserves prose', () => {
    fc.assert(
      fc.property(documentModelArb, (model) => {
        const text = renderDocument(model);
        const parsed: ParsedPlan = parsePlan(text);
        assert.strictEqual(parsed.kind, model.kind, 'document kind');

        // Frontmatter equivalence: every key/value round trips (Req 3.1).
        assert.strictEqual(
          parsed.frontmatter.size,
          model.frontmatter.length,
          'frontmatter key count'
        );
        for (const [key, value] of model.frontmatter) {
          assert.strictEqual(parsed.frontmatter.get(key), value, `frontmatter ${key}`);
        }

        // The complete preamble is preserved unchanged for either document kind.
        assert.strictEqual(
          parsed.preamble,
          model.kind === 'legacy-spec'
            ? model.preambleLines.join('\n')
            : [
                '## Endstate',
                ...model.preambleLines,
                '## What needs changing',
                'Change the requested behavior.',
                '## Limitations & constraints',
                '',
              ].join('\n'),
          'preamble text'
        );

        // Phase equivalence: id, state, title, after and files (Req 3.2–3.6).
        assert.strictEqual(parsed.phases.length, model.phases.length, 'phase count');
        for (let i = 0; i < model.phases.length; i++) {
          const expected = model.phases[i];
          const actual: Phase = parsed.phases[i];
          assert.strictEqual(actual.id, expected.id, 'phase id');
          assert.strictEqual(actual.state, expected.state, 'phase state');
          assert.strictEqual(actual.title, expected.title, 'phase title');
          assert.deepStrictEqual(actual.after, expected.after, 'phase after');
          assert.deepStrictEqual(actual.files, expected.files, 'phase files');
        }
      }),
      { numRuns: 200 }
    );
  });
});
