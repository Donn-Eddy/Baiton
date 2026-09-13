import * as assert from 'assert';
import * as fc from 'fast-check';
import { approvalHash } from '../src/model/hash';
import { parseSpec, ParsedSpec } from '../src/model/parser';
import { TODO_STATES, TodoState } from '../src/model/todoState';

/**
 * Feature: baiton-first-pass, Property 7: Approval hash is invariant under
 * state-box changes and sensitive to content
 *
 * For any spec, changing only the `[state]` boxes of one or more todo lines
 * SHALL leave the approval hash unchanged, while changing the OVERVIEW text,
 * any todo title, id, or hints SHALL change the approval hash.
 *
 * Validates: Requirements 5.1, 5.5
 *
 * The approval hash (src/model/hash.ts) covers the OVERVIEW section plus every
 * todo line with its state box blanked to `[]` (Req 5.1). Blanking makes the
 * hash stable across lifecycle state changes, which is exactly what Re-approve
 * relies on to leave todo states meaningful while re-tying approval to content
 * (Req 5.5). This test generates a spec, renders it, and asserts (a) mutating
 * only the state boxes leaves the hash unchanged, and (b) mutating the OVERVIEW,
 * a todo title, id, or hints changes the hash.
 */

/** The model a generated spec is rendered from and parsed back into. */
interface SpecModel {
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

/** Renders a {@link SpecModel} to canonical spec text `parseSpec` consumes. */
function renderSpec(model: SpecModel): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push('title: sample');
  lines.push('---');
  lines.push('# OVERVIEW');
  for (const l of model.overviewLines) {
    lines.push(l);
  }
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
    groups.push(`after ${t.after.join(',')}`);
  }
  if (t.files.length > 0) {
    groups.push(`files: ${t.files.join(',')}`);
  }
  if (groups.length > 0) {
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
 * A todo title free of the characters the hint/section grammar reserves, so it
 * never collides with a trailing hint group.
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

/**
 * An overview prose line that cannot be mistaken for a section header or a
 * frontmatter fence.
 */
const overviewLineArb: fc.Arbitrary<string> = fc
  .string({ maxLength: 40 })
  .map((s) => s.replace(/[\n\r]/g, ' '))
  .filter((s) => s.trim() !== '---' && !/^#+\s/.test(s));

/**
 * A spec with at least one todo (so state-box and content mutations always have
 * a target). Ids are unique; `after` targets are drawn from the generated ids.
 */
const specModelArb: fc.Arbitrary<SpecModel> = fc
  .record({
    overviewLines: fc.array(overviewLineArb, { maxLength: 6 }),
    ids: fc.uniqueArray(idArb, { minLength: 1, maxLength: 6 }),
  })
  .chain(({ overviewLines, ids }) => {
    const todoArb = fc.tuple(
      ...ids.map((id) =>
        fc
          .record({
            state: fc.constantFrom<TodoState>(...TODO_STATES),
            title: titleArb,
            after: fc.subarray(ids),
            files: fc.array(pathArb, { maxLength: 4 }),
          })
          .map((r) => ({ id, ...r })),
      ),
    );
    return fc.record({
      overviewLines: fc.constant(overviewLines),
      todos: todoArb,
    });
  });

/** A fresh state per todo, drawn independently so mutations can differ. */
const statesArb = (n: number): fc.Arbitrary<TodoState[]> =>
  fc.array(fc.constantFrom<TodoState>(...TODO_STATES), {
    minLength: n,
    maxLength: n,
  });

// --- Property --------------------------------------------------------------

describe('approval hash (property)', () => {
  // Feature: baiton-first-pass, Property 7: Approval hash is invariant under
  // state-box changes and sensitive to content
  it('is invariant under state-box changes', () => {
    fc.assert(
      fc.property(
        specModelArb.chain((model) =>
          fc.record({
            model: fc.constant(model),
            newStates: statesArb(model.todos.length),
          }),
        ),
        ({ model, newStates }) => {
          const original: ParsedSpec = parseSpec(renderSpec(model));
          const baseHash = approvalHash(original);

          // Mutate ONLY the state boxes; keep id/title/hints/overview intact.
          const mutated: SpecModel = {
            overviewLines: model.overviewLines,
            todos: model.todos.map((t, i) => ({ ...t, state: newStates[i] })),
          };
          const mutatedHash = approvalHash(parseSpec(renderSpec(mutated)));

          assert.strictEqual(
            mutatedHash,
            baseHash,
            'state-box-only change must not alter the approval hash',
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: baiton-first-pass, Property 7: Approval hash is invariant under
  // state-box changes and sensitive to content
  it('changes when the OVERVIEW, a title, an id, or hints change', () => {
    fc.assert(
      fc.property(
        specModelArb.chain((model) =>
          fc.record({
            model: fc.constant(model),
            // Which kind of content mutation to apply.
            kind: fc.constantFrom<'overview' | 'title' | 'id' | 'after' | 'files'>(
              'overview',
              'title',
              'id',
              'after',
              'files',
            ),
            idx: fc.nat({ max: Math.max(0, model.todos.length - 1) }),
          }),
        ),
        ({ model, kind, idx }) => {
          const baseHash = approvalHash(parseSpec(renderSpec(model)));
          const mutated = mutateContent(model, kind, idx);
          const mutatedHash = approvalHash(parseSpec(renderSpec(mutated)));

          assert.notStrictEqual(
            mutatedHash,
            baseHash,
            `content change (${kind}) must alter the approval hash`,
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});

/**
 * Produces a copy of `model` with exactly one content change of the given kind,
 * guaranteed to differ from the original so the hash must change. State boxes
 * are never touched here.
 */
function mutateContent(
  model: SpecModel,
  kind: 'overview' | 'title' | 'id' | 'after' | 'files',
  idx: number,
): SpecModel {
  const todos = model.todos.map((t) => ({ ...t, after: [...t.after], files: [...t.files] }));
  const overviewLines = [...model.overviewLines];

  switch (kind) {
    case 'overview':
      // Appending a distinct marker line always changes the OVERVIEW text.
      overviewLines.push('changed-overview-marker');
      break;
    case 'title':
      todos[idx].title = todos[idx].title + ' X';
      break;
    case 'id': {
      // Pick an id not already present so the set stays well-defined and the
      // mutated line differs from the original.
      const used = new Set(todos.map((t) => t.id));
      let n = 0;
      let candidate = 'T' + String(n).padStart(2, '0');
      while (used.has(candidate)) {
        n++;
        candidate = 'T' + String(n).padStart(2, '0');
      }
      todos[idx].id = candidate;
      break;
    }
    case 'after':
      // Append a fresh id to the hint group; this always alters the todo line.
      todos[idx].after = [...todos[idx].after, 'T99'];
      break;
    case 'files':
      todos[idx].files = [...todos[idx].files, 'extra.ts'];
      break;
  }

  return { overviewLines, todos };
}
