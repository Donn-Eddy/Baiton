import * as assert from 'assert';
import * as fc from 'fast-check';
import {
  parseSpec,
  validateSpec,
  isBlocked,
  buildSpecTree,
  legalSpecActions,
  TodoState,
} from '../src/model';

/**
 * Property test for the host-free tree model (Requirement 4).
 *
 * Feature: baiton-ui-first-pass, Property 3: Tree model reflects parsed todos
 * and derived blocked flags
 *
 * For any valid spec, the tree model's todo nodes SHALL be exactly the parsed
 * todos in file order, each carrying that todo's id, title and state, and each
 * node's blocked flag SHALL equal `isBlocked` for that todo
 * (Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 20.4).
 *
 * The generator builds valid spec texts with varied frontmatter, prose, todo
 * states, and `after`/`files` hints. Validity is guaranteed structurally:
 * ids are unique, `after` targets reference only earlier todos in the list
 * (so there is no self-reference, no missing target, and no cycle), and every
 * generated line matches the todo grammar. The property is asserted against
 * `parseSpec` + `isBlocked` (the reused cores the tree model wraps).
 */

const TODO_STATES: readonly TodoState[] = [
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

/** Prose lines that live under OVERVIEW or between todos; never `- [`. */
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
 * A specification of a valid spec: a list of todos where each todo may depend
 * only on the ids of todos declared before it (guaranteeing acyclic, non-self,
 * present dependencies), plus optional files hints, frontmatter and prose.
 */
interface SpecSpec {
  frontmatter: string[];
  /** An optional `pr:` frontmatter value; '' models a present-but-empty key. */
  pr: string | undefined;
  /** The approval fact the SpecStore would supply for this spec. */
  approved: boolean;
  overviewProse: string[];
  todos: { state: TodoState; title: string; afterIdx: number[]; files: string[] }[];
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

const specSpecArb: fc.Arbitrary<SpecSpec> = fc
  .record({
    frontmatter: frontmatterArb,
    pr: prArb,
    approved: fc.boolean(),
    overviewProse: fc.array(proseLineArb, { maxLength: 3 }),
    count: fc.integer({ min: 0, max: 6 }),
  })
  .chain(({ frontmatter, pr, approved, overviewProse, count }) => {
    const todoArbs: fc.Arbitrary<{
      state: TodoState;
      title: string;
      afterIdx: number[];
      files: string[];
    }>[] = [];
    for (let i = 0; i < count; i++) {
      todoArbs.push(
        fc.record({
          state: fc.constantFrom(...TODO_STATES),
          title: titleFragmentArb,
          // `after` targets reference only earlier todos (indices < i).
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
    return fc.tuple(...todoArbs).map((todos) => ({
      frontmatter,
      pr,
      approved,
      overviewProse,
      todos,
    }));
  });

/** Renders a SpecSpec into raw spec text. Ids are assigned as T00, T01, ... */
function renderSpec(spec: SpecSpec): string {
  const lines: string[] = [];

  // The `pr:` line goes last so it wins if the random frontmatter happened to
  // generate a `pr` key too (the parser's map keeps the last value).
  const frontmatterLines = [...spec.frontmatter];
  if (spec.pr !== undefined) {
    frontmatterLines.push(`pr: ${spec.pr}`);
  }
  if (frontmatterLines.length > 0) {
    lines.push('---');
    lines.push(...frontmatterLines);
    lines.push('---');
  }

  lines.push('# OVERVIEW', '');
  lines.push(...spec.overviewProse);
  lines.push('', '# TODOS', '');

  const id = (idx: number) => 'T' + String(idx).padStart(2, '0');

  spec.todos.forEach((todo, idx) => {
    const hintGroups: string[] = [];
    if (todo.afterIdx.length > 0) {
      hintGroups.push('after ' + todo.afterIdx.map((i) => id(i)).join(', '));
    }
    if (todo.files.length > 0) {
      hintGroups.push('files: ' + todo.files.join(', '));
    }
    const hints = hintGroups.length > 0 ? ` (${hintGroups.join('; ')})` : '';
    lines.push(`- [${todo.state}] ${id(idx)} ${todo.title}${hints}`);
  });

  return lines.join('\n');
}

describe('tree model (property)', () => {
  // Feature: baiton-ui-first-pass, Property 3: Tree model reflects parsed todos
  // and derived blocked flags
  it('tree todo nodes equal parsed todos in order with matching id/title/state and blocked flag', () => {
    fc.assert(
      fc.property(specSpecArb, (specSpec) => {
        const raw = renderSpec(specSpec);

        // Guard: the generator is designed to only produce valid specs. If a
        // generated spec is not valid, the generator (not the model) is wrong,
        // so skip it rather than assert the property on invalid input.
        const parsed = parseSpec(raw);
        fc.pre(validateSpec(parsed, raw).length === 0);

        const nodes = buildSpecTree([
          { slug: 'demo', raw, approved: false, sessions: new Set<string>() },
        ]);
        assert.strictEqual(nodes.length, 1);
        const node = nodes[0];

        // A valid spec is not invalid and carries todo (not error) children.
        assert.strictEqual(node.invalid, false);
        assert.strictEqual(node.children.kind, 'todos');
        if (node.children.kind !== 'todos') {
          return;
        }
        const todoNodes = node.children.todos;

        // Exactly the parsed todos, in file order.
        assert.strictEqual(todoNodes.length, parsed.todos.length);
        parsed.todos.forEach((todo, i) => {
          const tn = todoNodes[i];
          assert.strictEqual(tn.slug, 'demo');
          assert.strictEqual(tn.id, todo.id);
          assert.strictEqual(tn.title, todo.title);
          assert.strictEqual(tn.state, todo.state);
          // Blocked flag equals the reused core for that todo.
          assert.strictEqual(tn.blocked, isBlocked(todo, parsed.todos));
        });
      }),
      { numRuns: 200 },
    );
  });

  // The spec root carries the trimmed frontmatter `pr` URL and exactly the
  // actions the host-free `legalSpecActions` derives from its own facts.
  it('spec root prUrl and actions equal the derived frontmatter pr and legalSpecActions', () => {
    fc.assert(
      fc.property(specSpecArb, (specSpec) => {
        const raw = renderSpec(specSpec);

        const parsed = parseSpec(raw);
        fc.pre(validateSpec(parsed, raw).length === 0);

        const approved = specSpec.approved;
        const nodes = buildSpecTree([
          { slug: 'demo', raw, approved, sessions: new Set<string>() },
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
          legalSpecActions({
            approved,
            invalid: false,
            prUrl: expectedPrUrl,
            todoStates: parsed.todos.map((t) => t.state),
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
              parsed.todos.length > 0 &&
              parsed.todos.every((t) => t.state === 'done'),
          );
        }
      }),
      { numRuns: 200 },
    );
  });
});
