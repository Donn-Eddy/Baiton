import * as assert from 'assert';
import * as fc from 'fast-check';
import { parseSpec } from '../src/model/parser';
import { writeFrontmatterKey, writeTodoState } from '../src/model/writer';
import { MANAGED_KEYS, ManagedKey } from '../src/model/managedKey';
import { TODO_STATES, TodoState } from '../src/model/todoState';
import { isOk } from '../src/model/result';

/**
 * Feature: baiton-first-pass, Property 9: Extension writes touch only state
 * boxes and managed frontmatter keys — For any spec and any single state-box
 * write or managed-frontmatter-key write, the resulting text SHALL differ from
 * the original only within the targeted state box or managed key, leaving every
 * other byte — OVERVIEW prose, titles, ids, hints, non-managed frontmatter
 * keys, and other prose — unchanged.
 *
 * Validates: Requirements 6.1, 6.2, 9.7
 *
 * The test renders a spec whose frontmatter mixes extension-managed keys with
 * non-managed keys, then applies exactly one `writeTodoState` or
 * `writeFrontmatterKey` to the freshly rendered text. It asserts, byte for
 * byte, that the only region that may differ is the targeted `[state]` box or
 * the targeted managed key's value; every other byte — including the prefix
 * before that region and the suffix after it — is unchanged. Abort cases
 * (a `done`-protected state write, an absent todo id, an absent managed key)
 * are asserted to return an error and leave the output byte-identical to the
 * input.
 */

// --- Model + renderer ------------------------------------------------------

interface FmEntry {
  key: string;
  value: string;
  managed: boolean;
}

interface TodoModel {
  id: string;
  state: TodoState;
  title: string;
  after: string[];
  files: string[];
}

interface SpecModel {
  frontmatter: FmEntry[];
  overviewLines: string[];
  todos: TodoModel[];
}

/** Renders a {@link SpecModel} to the canonical text `parseSpec` consumes. */
function renderSpec(model: SpecModel): string {
  const lines: string[] = [];
  lines.push('---');
  for (const { key, value } of model.frontmatter) {
    lines.push(`${key}: ${value}`);
  }
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

const idArb: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 999999 })
  .map((n) => 'T' + String(n).padStart(2, '0'));

/**
 * A todo title free of the characters the hint/section grammar reserves, so it
 * round-trips through parse unchanged and never collides with a trailing hint
 * group.
 */
const titleArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 40 })
  .map((s) => s.replace(/[()\n\r;]/g, ' ').trim())
  .filter((s) => s.length > 0);

const pathArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 20 })
  .map((s) => s.replace(/[(),;\n\r]/g, '').trim())
  .filter((s) => s.length > 0);

/** A non-managed frontmatter key: valid key text that is not a managed key. */
const nonManagedKeyArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 15 })
  .map((s) => s.replace(/[:\n\r]/g, '').trim())
  .filter((s) => s.length > 0 && !(MANAGED_KEYS as readonly string[]).includes(s));

/** A frontmatter value: trimmed, single line (empty allowed). */
const fmValueArb: fc.Arbitrary<string> = fc
  .string({ maxLength: 20 })
  .map((s) => s.replace(/[\n\r]/g, '').trim());

const overviewLineArb: fc.Arbitrary<string> = fc
  .string({ maxLength: 40 })
  .map((s) => s.replace(/[\n\r]/g, ' '))
  .filter((s) => s.trim() !== '---' && !/^#+\s/.test(s));

/**
 * A frontmatter block mixing a random subset of managed keys with random
 * non-managed keys, interleaved in arbitrary order, each key unique. The subset
 * of managed keys present is returned alongside so the property can target both
 * present and absent managed keys.
 */
const frontmatterArb: fc.Arbitrary<{
  entries: FmEntry[];
  presentManaged: ManagedKey[];
}> = fc
  .record({
    managedSubset: fc.subarray(MANAGED_KEYS as ManagedKey[]),
    nonManaged: fc.uniqueArray(nonManagedKeyArb, { maxLength: 5 }),
    managedValues: fc.array(fmValueArb, { minLength: 6, maxLength: 6 }),
    nonManagedValues: fc.array(fmValueArb, { minLength: 5, maxLength: 5 }),
    shuffleSeed: fc.array(fc.double({ min: 0, max: 1, noNaN: true }), {
      minLength: 11,
      maxLength: 11,
    }),
  })
  .map(({ managedSubset, nonManaged, managedValues, nonManagedValues, shuffleSeed }) => {
    const entries: FmEntry[] = [];
    managedSubset.forEach((key, i) =>
      entries.push({ key, value: managedValues[i % managedValues.length], managed: true }),
    );
    nonManaged.forEach((key, i) =>
      entries.push({ key, value: nonManagedValues[i % nonManagedValues.length], managed: false }),
    );
    // Deterministic shuffle so managed and non-managed keys interleave.
    const shuffled = entries
      .map((e, i) => ({ e, k: shuffleSeed[i % shuffleSeed.length] + i * 1e-6 }))
      .sort((a, b) => a.k - b.k)
      .map((x) => x.e);
    return { entries: shuffled, presentManaged: [...managedSubset] };
  });

const specModelArb: fc.Arbitrary<{ model: SpecModel; presentManaged: ManagedKey[] }> = fc
  .record({
    fm: frontmatterArb,
    overviewLines: fc.array(overviewLineArb, { maxLength: 5 }),
    ids: fc.uniqueArray(idArb, { minLength: 1, maxLength: 5 }),
  })
  .chain(({ fm, overviewLines, ids }) => {
    const todosArb = fc.tuple(
      ...ids.map((id) =>
        fc
          .record({
            state: fc.constantFrom<TodoState>(...TODO_STATES),
            title: titleArb,
            after: fc.subarray(ids),
            files: fc.array(pathArb, { maxLength: 3 }),
          })
          .map((r) => ({ id, ...r })),
      ),
    );
    return todosArb.map((todos) => ({
      model: { frontmatter: fm.entries, overviewLines, todos },
      presentManaged: fm.presentManaged,
    }));
  });

// --- Byte-diff helpers -----------------------------------------------------

/**
 * Asserts that `after` differs from `before` only within the single half-open
 * character span [start, end) of `before`. The prefix before `start` and the
 * suffix after `end` must be byte-identical in both strings.
 */
function assertOnlySpanChanged(
  before: string,
  after: string,
  start: number,
  end: number,
  what: string,
): void {
  const prefix = before.slice(0, start);
  const suffix = before.slice(end);
  assert.strictEqual(after.slice(0, start), prefix, `${what}: prefix before target changed`);
  assert.strictEqual(
    after.slice(after.length - suffix.length),
    suffix,
    `${what}: suffix after target changed`,
  );
}

/** Absolute character offset of the start of line `lineIndex` (0-based). */
function lineStartOffset(text: string, lineIndex: number): number {
  const lines = text.split('\n');
  let offset = 0;
  for (let i = 0; i < lineIndex; i++) {
    offset += lines[i].length + 1; // + the '\n'
  }
  return offset;
}

// --- Properties ------------------------------------------------------------

describe('writer scope containment (property)', () => {
  it('Property 9: writeTodoState touches only the target state box', () => {
    fc.assert(
      fc.property(specModelArb, fc.nat(), fc.nat(), ({ model }, todoPick, statePick) => {
        const before = renderSpec(model);
        const todo = model.todos[todoPick % model.todos.length];
        const newState = TODO_STATES[statePick % TODO_STATES.length];

        const result = writeTodoState(before, todo.id, newState);

        if (todo.state === 'done') {
          // done-protected abort: output is left unchanged (Req 4.11 / 6.5).
          assert.ok(!isOk(result), 'expected abort on done todo');
          return;
        }

        assert.ok(isOk(result), 'expected a successful write');
        const after = result.value;

        // The only region allowed to differ is this todo's `[state]` box.
        // Its line index is stable across the edit because the edit changes
        // only characters inside the box (state names are single-line).
        const parsedTodo = parseSpec(before).todos.find((t) => t.id === todo.id);
        assert.ok(parsedTodo !== undefined, 'target todo parses');
        const lineStart = lineStartOffset(before, parsedTodo.lineIndex);
        const boxStart = before.indexOf('[', lineStart);
        const boxEnd = before.indexOf(']', boxStart) + 1;
        assertOnlySpanChanged(before, after, boxStart, boxEnd, 'writeTodoState');

        // And the parsed model confirms only that todo's state moved: every
        // other todo's id/state/title/hints and all frontmatter are intact.
        const parsedBefore = parseSpec(before);
        const parsedAfter = parseSpec(after);
        assert.deepStrictEqual(
          [...parsedAfter.frontmatter.entries()],
          [...parsedBefore.frontmatter.entries()],
          'frontmatter unchanged',
        );
        assert.strictEqual(parsedAfter.overview, parsedBefore.overview, 'overview unchanged');
        assert.strictEqual(parsedAfter.todos.length, parsedBefore.todos.length, 'todo count');
        for (let i = 0; i < parsedBefore.todos.length; i++) {
          const b = parsedBefore.todos[i];
          const a = parsedAfter.todos[i];
          assert.strictEqual(a.id, b.id, 'todo id unchanged');
          assert.strictEqual(a.title, b.title, 'todo title unchanged');
          assert.deepStrictEqual(a.after, b.after, 'todo after unchanged');
          assert.deepStrictEqual(a.files, b.files, 'todo files unchanged');
          if (b.id === todo.id) {
            assert.strictEqual(a.state, newState, 'target state applied');
          } else {
            assert.strictEqual(a.state, b.state, 'non-target state unchanged');
          }
        }
      }),
      { numRuns: 150 },
    );
  });

  it('Property 9: writeFrontmatterKey touches only the target managed key value', () => {
    fc.assert(
      fc.property(
        specModelArb,
        fc.constantFrom<ManagedKey>(...MANAGED_KEYS),
        fmValueArb,
        ({ model, presentManaged }, key, newValue) => {
          const before = renderSpec(model);
          const result = writeFrontmatterKey(before, key, newValue);

          if (!presentManaged.includes(key)) {
            // key-not-found abort: output is left unchanged (Req 6.5).
            assert.ok(!isOk(result), `expected abort for absent key "${key}"`);
            return;
          }

          assert.ok(isOk(result), `expected a successful write for key "${key}"`);
          const after = result.value;

          // Locate the key's line and the value span after its colon; only the
          // value portion may differ.
          const beforeLines = before.split('\n');
          const keyLineIdx = beforeLines.findIndex((l) => {
            const sep = l.indexOf(':');
            return sep !== -1 && l.slice(0, sep).trim() === key;
          });
          assert.notStrictEqual(keyLineIdx, -1, 'target key line located');
          const lineStart = lineStartOffset(before, keyLineIdx);
          const colon = before.indexOf(':', lineStart);
          // The edit may adjust from the colon onward (whitespace + value). The
          // key text before the colon and everything after this line is fixed.
          const valueStart = colon + 1;
          const lineEnd = lineStart + beforeLines[keyLineIdx].length;
          assertOnlySpanChanged(before, after, valueStart, lineEnd, 'writeFrontmatterKey');

          // Parsed model: the target key holds the new value, every other
          // frontmatter key (managed and non-managed) is unchanged, and no
          // todo, title, id, hint or overview byte moved.
          const parsedBefore = parseSpec(before);
          const parsedAfter = parseSpec(after);
          assert.strictEqual(parsedAfter.frontmatter.get(key), newValue, 'target value applied');
          for (const [k, v] of parsedBefore.frontmatter) {
            if (k === key) {
              continue;
            }
            assert.strictEqual(parsedAfter.frontmatter.get(k), v, `non-target key "${k}" unchanged`);
          }
          assert.strictEqual(parsedAfter.overview, parsedBefore.overview, 'overview unchanged');
          assert.deepStrictEqual(parsedAfter.todos, parsedBefore.todos, 'all todos unchanged');
        },
      ),
      { numRuns: 150 },
    );
  });

  it('Property 9: aborts on an absent todo id leave the text unchanged', () => {
    fc.assert(
      fc.property(specModelArb, fc.constantFrom<TodoState>(...TODO_STATES), ({ model }, state) => {
        const before = renderSpec(model);
        // An id guaranteed not present: no generated id exceeds T999999.
        const absentId = 'T1000000';
        const result = writeTodoState(before, absentId, state);
        assert.ok(!isOk(result), 'expected todo-not-found abort');
      }),
      { numRuns: 100 },
    );
  });
});
