import * as assert from 'assert';
import * as fc from 'fast-check';
import { DocumentKind, parsePlan } from '../src/model';

/**
 * Property tests for the dual-kind document parser (Requirement 3).
 * Legacy cases explicitly render the `# OVERVIEW` + `# TODOS` format.
 *
 * Feature: baiton-first-pass, Property 2: Trailing non-hint parentheses stay in
 * the title
 *
 * For any phase whose title ends with a parenthesized group that does NOT parse
 * as an after/files hint set, parsing SHALL retain that group as part of the
 * title rather than as hints (Requirement 3.7). We generate phase lines whose
 * trailing `(...)` group is deliberately not a valid hint group, parse the
 * document, and assert the whole trailing group survives in the title while
 * `after` and `files` stay empty.
 */

/** A phase id uses its kind's prefix (`P`, or legacy `T`) and two or more digits. */
const idArb = (kind: DocumentKind): fc.Arbitrary<string> => fc
  .integer({ min: 0, max: 999999 })
  .map((n) => (kind === 'plan' ? 'P' : 'T') + String(n).padStart(2, '0'));

/**
 * A base title fragment with no parentheses, semicolons, or newlines so it
 * cannot itself introduce a trailing hint group. May be empty.
 */
const titleFragmentArb: fc.Arbitrary<string> = fc
  .stringOf(
    fc.char().filter((c) => c !== '(' && c !== ')' && c !== ';' && c !== '\n' && c !== '\r'),
    { maxLength: 40 },
  )
  .map((s) => s.replace(/\s+/g, ' ').trim());

/**
 * Inner text (between the trailing parens) that does NOT parse as a hint group.
 * Covers: empty groups, unknown keywords, plain prose, `after`/`files` groups
 * with no usable items, and trailing-semicolon empty groups.
 */
const nonHintInnerArb: fc.Arbitrary<string> = fc.oneof(
  // Empty group -> `()`.
  fc.constant(''),
  // Whitespace-only group.
  fc.constantFrom(' ', '  ', '\t'),
  // Unknown keyword prose (no `after`/`files` keyword, no parens/semicolons).
  fc
    .stringOf(
      fc
        .char()
        .filter(
          (c) => c !== '(' && c !== ')' && c !== ';' && c !== '\n' && c !== '\r',
        ),
      { minLength: 1, maxLength: 30 },
    )
    .map((s) => s.trim())
    .filter((s) => {
      // Exclude anything that could accidentally read as a hint group.
      if (s === '') {
        return false;
      }
      const lower = s.toLowerCase();
      return !/^after\s*:?\s+\S/.test(lower) && !/^files\s*:?\s+\S/.test(lower);
    }),
  // `after` group with no items -> unparseable.
  fc.constantFrom('after', 'after:', 'after: ', 'after   '),
  // `files` group with no items -> unparseable.
  fc.constantFrom('files', 'files:', 'files: ', 'files   '),
  // `after` group whose items are not valid ids, including legacy T ids in a plan.
  fc.constantFrom('after nope', 'after: X1, foo', 'after 12', 'after: bar'),
  // A trailing empty sub-group (trailing `;`) makes the whole group non-hint.
  fc.constantFrom('after T01;', 'files a.ts;', ';', 'after T01; '),
  // A recognized group mixed with an unrecognized one.
  fc.constantFrom('after T01; note stuff', 'files a.ts; misc'),
);

/**
 * Assembles a single phase line whose trailing `(<inner>)` group is not a hint,
 * along with the exact trailing group text that must survive in the title.
 */
const nonHintLineArb: fc.Arbitrary<{
  kind: DocumentKind;
  line: string;
  id: string;
  group: string;
}> = fc
  .record({
    kind: fc.constantFrom<DocumentKind>('plan', 'legacy-spec'),
    prefix: titleFragmentArb,
    inner: nonHintInnerArb,
  })
  .chain(({ kind, prefix, inner }) => idArb(kind).map((id) => {
    const group = '(' + inner + ')';
    // Ensure there is real title text before the group so the id is followed by
    // a title; the parser needs at least a space after the id.
    const titleBody = prefix === '' ? 'task' : prefix;
    const line = `- [pending] ${id} ${titleBody} ${group}`;
    return { kind, line, id, group };
  }));

describe('parser (property harness)', () => {
  // Feature: baiton-first-pass, Property 2: Trailing non-hint parentheses stay
  // in the title
  it('retains a trailing non-hint parenthesized group in the title', () => {
    fc.assert(
      fc.property(nonHintLineArb, ({ kind, line, id, group }) => {
        const raw = kind === 'plan'
          ? ['## Endstate', 'Some endstate.', '# PHASES', '', line].join('\n')
          : ['# OVERVIEW', '', 'Some overview.', '', '# TODOS', '', line].join('\n');
        const plan = parsePlan(raw, kind);
        assert.strictEqual(plan.kind, kind);

        const phase = plan.phases.find((t) => t.id === id);
        assert.ok(phase, `expected a parsed phase with id ${id} for line: ${line}`);

        // The trailing group is not a hint set: no after/files parsed.
        assert.deepStrictEqual(phase!.after, [], `after should be empty for: ${line}`);
        assert.deepStrictEqual(phase!.files, [], `files should be empty for: ${line}`);

        // The trailing group survives verbatim as part of the title (Req 3.7).
        assert.ok(
          phase!.title.endsWith(group),
          `title "${phase!.title}" should end with group "${group}" for: ${line}`,
        );
      }),
      { numRuns: 200 },
    );
  });
});
