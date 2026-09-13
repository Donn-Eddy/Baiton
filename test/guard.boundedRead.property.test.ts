import * as assert from 'assert';
import * as fc from 'fast-check';
import {
  GuardContext,
  READ_RESULT_CAP_BYTES,
} from '../src/orchestrator/guard';

/**
 * Property test for the guard's fixed-cap read-tool truncation
 * (Requirement 9.4, design "Orchestrator: tool registry and guard").
 *
 * Feature: baiton-first-pass, Property 12: Read-tool output is bounded and
 * flagged
 *
 * For any read-tool result larger than the fixed maximum size
 * ({@link READ_RESULT_CAP_BYTES}), the returned content is truncated to at most
 * that size and carries a truncation indicator. Concretely, `boundRead(text)`
 * SHALL satisfy, for any input string:
 *
 * - the returned text is at most `READ_RESULT_CAP_BYTES` bytes in UTF-8;
 * - `truncated === true` iff the original text exceeded the cap in UTF-8 bytes;
 * - when not truncated, the returned text equals the input verbatim;
 * - the returned text is always valid UTF-8 — no partial trailing multibyte
 *   sequence is left dangling by the byte-boundary cut.
 *
 * The test generates strings of varied lengths, including inputs well over the
 * cap and multibyte/unicode content, so the byte-boundary cut is exercised on
 * characters that straddle the cap.
 */

/** UTF-8 byte length of a string, the unit the cap is measured in. */
function utf8Len(s: string): number {
  return Buffer.byteLength(s, 'utf8');
}

/**
 * Whether a string is valid UTF-8 with no lone/partial surrogate or partial
 * multibyte tail. A round-trip through a non-fatal UTF-8 decoder is stable only
 * when the input contained no undecodable bytes; any partial trailing multibyte
 * sequence would have been re-encoded as U+FFFD and changed the bytes.
 */
function isValidUtf8(s: string): boolean {
  const bytes = Buffer.from(s, 'utf8');
  const decoded = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  return decoded === s && !s.includes('\uFFFD');
}

/** A context whose only exercised behavior here is `boundRead`. */
function makeContext(): GuardContext {
  return new GuardContext({
    repoRoot: '/repo',
    specsDir: '/repo/.baiton/specs',
    restricted: false,
  });
}

/**
 * Generators over strings of varied lengths and byte widths:
 *
 * - short/ASCII strings well under the cap (exercise the pass-through branch);
 * - unicode strings mixing 1–4 byte code points;
 * - large strings built by repeating a multibyte unit so a code point is very
 *   likely to straddle the byte-boundary cut when truncated.
 */
const asciiArb = fc.string({ minLength: 0, maxLength: 200 });

const unicodeArb = fc.stringOf(
  fc.constantFrom(
    'a',
    'é', // 2 bytes
    '€', // 3 bytes
    '😀', // 4 bytes (surrogate pair)
    '中', // 3 bytes
    '\n',
  ),
  { minLength: 0, maxLength: 500 },
);

/** A unit repeated to comfortably exceed the cap, straddling the boundary. */
const overCapArb = fc
  .constantFrom('a', 'é', '€', '中', '😀')
  .chain((unit) => {
    const perUnit = utf8Len(unit);
    // Enough repeats to exceed the cap by a healthy margin.
    const minRepeats = Math.ceil((READ_RESULT_CAP_BYTES + 4096) / perUnit);
    return fc
      .integer({ min: minRepeats, max: minRepeats + 2000 })
      .map((n) => unit.repeat(n));
  });

const inputArb = fc.oneof(asciiArb, unicodeArb, overCapArb);

describe('Guard bounded read-tool output (property harness)', () => {
  // Feature: baiton-first-pass, Property 12: Read-tool output is bounded and
  // flagged
  it('caps read output to the byte limit and flags truncation for any input', () => {
    const ctx = makeContext();

    fc.assert(
      fc.property(inputArb, (input) => {
        const { text, truncated } = ctx.boundRead(input);

        const originalBytes = utf8Len(input);
        const returnedBytes = utf8Len(text);

        // The returned text never exceeds the fixed cap in UTF-8 bytes.
        assert.ok(
          returnedBytes <= READ_RESULT_CAP_BYTES,
          `returned ${returnedBytes} bytes exceeds cap ${READ_RESULT_CAP_BYTES}`,
        );

        // truncated === true iff the original exceeded the cap.
        assert.strictEqual(
          truncated,
          originalBytes > READ_RESULT_CAP_BYTES,
          `truncated flag (${truncated}) must match original ${originalBytes} > cap ${READ_RESULT_CAP_BYTES}`,
        );

        // When not truncated, the text is returned verbatim.
        if (!truncated) {
          assert.strictEqual(
            text,
            input,
            'untruncated output must equal the input exactly',
          );
        }

        // The returned text is always valid UTF-8 (no partial trailing byte).
        assert.ok(
          isValidUtf8(text),
          'truncated text must be valid UTF-8 with no partial trailing sequence',
        );
      }),
      { numRuns: 200 },
    );
  });
});
