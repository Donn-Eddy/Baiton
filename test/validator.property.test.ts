import * as assert from 'assert';
import * as fc from 'fast-check';
import { parseSpec } from '../src/model/parser';
import { validateSpec } from '../src/model/validator';
import { TODO_STATES, TodoState } from '../src/model/todoState';

/**
 * Feature: baiton-first-pass, Property 3: Validator flags each malformed
 * construct
 *
 * For any spec that contains at least one of — a `- [` line violating the todo
 * grammar, two todos sharing an id, an unknown state value, an `after`
 * reference to an absent id, a todo listing its own id in `after`, or a
 * merge-conflict marker on any line — the validator SHALL report the spec
 * invalid and SHALL leave the spec text unchanged, and for any spec free of all
 * such constructs and of dependency cycles the validator SHALL report it valid.
 *
 * Validates: Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.8
 *
 * Strategy: generate a clean, acyclic base spec (unique ids, known states,
 * every `after` target present, no self-references, no conflict markers). The
 * base is asserted valid. Then, for the invalid half, inject exactly one
 * malformed construct into that base and assert the validator reports at least
 * one error while leaving the raw text byte-for-byte unchanged.
 */

// --- Shared generators -----------------------------------------------------

/** A todo id: `T` followed by two or more decimal digits (Req 3.3). */
const idArb: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 999999 })
  .map((n) => 'T' + String(n).padStart(2, '0'));

/**
 * A todo title with no characters that could form a trailing hint group, so the
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

/** One clean todo used to build a base spec. */
interface CleanTodo {
  id: string;
  state: TodoState;
  title: string;
  after: string[];
}

/** Renders a clean todo to a grammar-conformant `- [state] id title (after ...)` line. */
function renderTodo(t: CleanTodo): string {
  let line = `- [${t.state}] ${t.id} ${t.title}`;
  if (t.after.length > 0) {
    line += ` (after ${t.after.join(',')})`;
  }
  return line;
}

/**
 * A clean base spec: unique ids, known states, `after` targets restricted to
 * OTHER present ids (so no missing target, no self-reference), and no cycles.
 * Acyclicity is guaranteed by only allowing a todo to depend on ids that appear
 * strictly earlier in the list.
 */
const baseSpecArb: fc.Arbitrary<{ ids: string[]; todos: CleanTodo[]; overview: string }> =
  fc
    .record({
      ids: fc.uniqueArray(idArb, { minLength: 1, maxLength: 6 }),
      overview: fmValueArb,
    })
    .chain(({ ids, overview }) =>
      fc
        .tuple(
          ...ids.map((_id, index) =>
            fc.record({
              state: fc.constantFrom<TodoState>(...TODO_STATES),
              title: titleArb,
              // Depend only on earlier ids -> acyclic, present, non-self.
              after: fc.subarray(ids.slice(0, index)),
            }),
          ),
        )
        .map((parts) => ({
          overview,
          ids,
          todos: parts.map((p, i) => ({ id: ids[i], ...p })),
        })),
    );

/** Assembles full spec text from a base spec's todos and overview. */
function renderSpec(overview: string, todoLines: string[]): string {
  return [
    '---',
    'status: draft',
    '---',
    '# OVERVIEW',
    '',
    overview,
    '',
    '# TODOS',
    '',
    ...todoLines,
  ].join('\n');
}

// --- Valid half ------------------------------------------------------------

describe('validator flags malformed constructs (property)', () => {
  // Feature: baiton-first-pass, Property 3: Validator flags each malformed
  // construct
  it('reports clean, acyclic specs as valid', () => {
    fc.assert(
      fc.property(baseSpecArb, ({ overview, todos }) => {
        const raw = renderSpec(overview, todos.map(renderTodo));
        const errors = validateSpec(parseSpec(raw), raw);
        assert.deepStrictEqual(
          errors,
          [],
          `expected clean spec valid, got: ${JSON.stringify(errors)}\n---\n${raw}`,
        );
      }),
      { numRuns: 150 },
    );
  });

  // --- Invalid half: inject exactly one malformed construct ----------------

  // Feature: baiton-first-pass, Property 3: Validator flags each malformed
  // construct
  it('reports a spec invalid when exactly one malformed construct is injected, leaving text unchanged', () => {
    fc.assert(
      fc.property(
        baseSpecArb,
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
        (base, kind, seed) => {
          const raw = injectMalformed(base, kind, seed);

          // The base itself is clean, so any invalidity comes from the injection.
          const errors = validateSpec(parseSpec(raw), raw);
          assert.ok(
            errors.length > 0,
            `expected "${kind}" injection to be flagged invalid, but got no errors\n---\n${raw}`,
          );

          // The validator never mutates the text (Req 4.2). Re-validating the
          // same string must be idempotent and the string is untouched.
          const rawCopy = raw.slice();
          validateSpec(parseSpec(raw), raw);
          assert.strictEqual(raw, rawCopy, 'validator must leave the raw text unchanged');
        },
      ),
      { numRuns: 150 },
    );
  });
});

/**
 * Produces spec text from a clean base with exactly one malformed construct
 * injected according to `kind`. `seed` selects which todo/position is affected
 * deterministically so shrinking stays meaningful.
 */
function injectMalformed(
  base: { ids: string[]; todos: CleanTodo[]; overview: string },
  kind: string,
  seed: number,
): string {
  const todos = base.todos.map(renderTodo);
  const pick = base.todos.length > 0 ? seed % base.todos.length : 0;

  switch (kind) {
    case 'grammar': {
      // A `- [` line that cannot parse against the grammar (Req 4.1, 4.2).
      todos.splice(pick, 0, '- [pending] notanid missing digits');
      return renderSpec(base.overview, todos);
    }
    case 'duplicate': {
      // Two todos sharing an id (Req 4.3). Reuse an existing id on a new line.
      const dupId = base.todos[pick].id;
      todos.push(`- [pending] ${dupId} a second todo with the same id`);
      return renderSpec(base.overview, todos);
    }
    case 'unknown-state': {
      // A todo whose state is not a known state (Req 4.4).
      const t = base.todos[pick];
      todos[pick] = `- [bogusstate] ${t.id} ${t.title}`;
      return renderSpec(base.overview, todos);
    }
    case 'missing-after': {
      // An `after` reference to an id that no todo declares (Req 4.5).
      const t = base.todos[pick];
      const absent = pickAbsentId(base.ids, seed);
      todos[pick] = `- [${t.state}] ${t.id} ${t.title} (after ${absent})`;
      return renderSpec(base.overview, todos);
    }
    case 'self-after': {
      // A todo listing its own id among its `after` dependencies (Req 4.6).
      const t = base.todos[pick];
      todos[pick] = `- [${t.state}] ${t.id} ${t.title} (after ${t.id})`;
      return renderSpec(base.overview, todos);
    }
    case 'conflict': {
      // A merge-conflict marker on some line of the file (Req 4.8).
      const marker = ['<<<<<<< HEAD', '=======', '>>>>>>> branch'][seed % 3];
      todos.splice(pick, 0, marker);
      return renderSpec(base.overview, todos);
    }
    default:
      throw new Error(`unknown injection kind: ${kind}`);
  }
}

/** An id guaranteed not to be present in `ids`, for the missing-after case. */
function pickAbsentId(ids: string[], seed: number): string {
  let n = 1000000 + (seed % 1000000);
  const present = new Set(ids);
  let candidate = 'T' + String(n);
  while (present.has(candidate)) {
    n += 1;
    candidate = 'T' + String(n);
  }
  return candidate;
}
