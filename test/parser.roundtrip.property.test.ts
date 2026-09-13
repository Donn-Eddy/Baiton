import * as assert from 'assert';
import * as fc from 'fast-check';
import { parseSpec, ParsedSpec, Todo } from '../src/model/parser';
import { TODO_STATES, TodoState } from '../src/model/todoState';

/**
 * Feature: baiton-first-pass, Property 1: Spec parse/serialize round trip —
 * For any valid spec model (frontmatter, overview prose, and a list of
 * well-formed todos with arbitrary titles, states, after and files hints),
 * serializing it to text and parsing that text back SHALL produce an equivalent
 * model, and all non-todo prose lines SHALL be preserved unchanged.
 *
 * Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.8
 *
 * Since a dedicated full-spec serializer is not yet built (only the
 * minimal-edit writers of task 4 are planned), this test carries a small,
 * test-local canonical renderer that emits the exact shape `parseSpec`
 * consumes: a `---`-fenced flat frontmatter block, a `# OVERVIEW` section, and
 * a `# TODOS` section whose todo lines read `- [state] id title (hints)`. The
 * renderer is the inverse the property asserts against; it is intentionally not
 * production code.
 */

/** The model a generated spec is rendered from and parsed back into. */
interface SpecModel {
  frontmatter: [string, string][];
  overviewLines: string[];
  todos: TodoModel[];
}

interface TodoModel {
  id: string;
  state: TodoState;
  title: string;
  after: string[];
  files: string[];
}

/**
 * Renders a {@link SpecModel} to canonical spec text. This is the serialize
 * half of the round trip; `parseSpec` is the parse half.
 */
function renderSpec(model: SpecModel): string {
  const lines: string[] = [];

  // Frontmatter: `---`-fenced flat `key: value`, one key per line (Req 3.1).
  lines.push('---');
  for (const [key, value] of model.frontmatter) {
    lines.push(`${key}: ${value}`);
  }
  lines.push('---');

  // OVERVIEW section (Req 3.1). Prose lines are preserved verbatim (Req 3.8).
  lines.push('# OVERVIEW');
  for (const l of model.overviewLines) {
    lines.push(l);
  }

  // TODOS section (Req 3.1) with one `- [state] id title (hints)` line each.
  lines.push('# TODOS');
  for (const t of model.todos) {
    lines.push(renderTodoLine(t));
  }

  return lines.join('\n');
}

/** Renders one todo line: `- [state] id title` with an optional hint group. */
function renderTodoLine(t: TodoModel): string {
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

/** A todo id: `T` followed by two or more decimal digits (Req 3.3). */
const idArb: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 999999 })
  .map((n) => 'T' + String(n).padStart(2, '0'));

/**
 * A todo title that survives the round trip: non-empty, single line, trimmed,
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
 * An overview prose line that cannot be mistaken for a section header or a
 * frontmatter fence. Blank lines are allowed. Property 3.8 preservation is
 * asserted by comparing the joined overview text exactly.
 */
const overviewLineArb: fc.Arbitrary<string> = fc
  .string({ maxLength: 40 })
  .map((s) => s.replace(/[\n\r]/g, ' '))
  .filter((s) => s.trim() !== '---' && !/^#+\s/.test(s));

/**
 * A full spec model. Todo ids are made unique so the model has a well-defined
 * set of todos; `after` targets are drawn from the generated ids so the graph
 * references only present todos (parse equivalence, not validity, is the
 * concern here).
 */
const specModelArb: fc.Arbitrary<SpecModel> = fc
  .record({
    frontmatter: fc.uniqueArray(fc.tuple(fmKeyArb, fmValueArb), {
      maxLength: 6,
      selector: ([k]) => k,
    }),
    overviewLines: fc.array(overviewLineArb, { maxLength: 6 }),
    ids: fc.uniqueArray(idArb, { minLength: 0, maxLength: 6 }),
  })
  .chain(({ frontmatter, overviewLines, ids }) => {
    const todoArb =
      ids.length === 0
        ? fc.constant<TodoModel[]>([])
        : fc.tuple(
            ...ids.map((id) =>
              fc
                .record({
                  state: fc.constantFrom<TodoState>(...TODO_STATES),
                  title: titleArb,
                  after: fc.subarray(ids),
                  files: fc.array(pathArb, { maxLength: 4 }),
                })
                .map((r) => ({ id, ...r }))
            )
          );
    return fc.record({
      frontmatter: fc.constant(frontmatter),
      overviewLines: fc.constant(overviewLines),
      todos: todoArb,
    });
  });

// --- Property --------------------------------------------------------------

describe('parser round trip (property)', () => {
  it('Property 1: render then parse yields an equivalent model and preserves prose', () => {
    fc.assert(
      fc.property(specModelArb, (model) => {
        const text = renderSpec(model);
        const parsed: ParsedSpec = parseSpec(text);

        // Frontmatter equivalence: every key/value round trips (Req 3.1).
        assert.strictEqual(
          parsed.frontmatter.size,
          model.frontmatter.length,
          'frontmatter key count'
        );
        for (const [key, value] of model.frontmatter) {
          assert.strictEqual(parsed.frontmatter.get(key), value, `frontmatter ${key}`);
        }

        // Overview prose preserved unchanged, line for line (Req 3.8).
        assert.strictEqual(
          parsed.overview,
          model.overviewLines.join('\n'),
          'overview prose'
        );

        // Todo equivalence: id, state, title, after and files (Req 3.2–3.6).
        assert.strictEqual(parsed.todos.length, model.todos.length, 'todo count');
        for (let i = 0; i < model.todos.length; i++) {
          const expected = model.todos[i];
          const actual: Todo = parsed.todos[i];
          assert.strictEqual(actual.id, expected.id, 'todo id');
          assert.strictEqual(actual.state, expected.state, 'todo state');
          assert.strictEqual(actual.title, expected.title, 'todo title');
          assert.deepStrictEqual(actual.after, expected.after, 'todo after');
          assert.deepStrictEqual(actual.files, expected.files, 'todo files');
        }
      }),
      { numRuns: 200 }
    );
  });
});
