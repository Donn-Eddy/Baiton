import * as assert from 'assert';
import * as fc from 'fast-check';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { defaultConfig, defaultConfigJson } from '../src/config/defaultConfig';
import { loadConfig } from '../src/config/loadConfig';
import { SUPPORTED_VERSION } from '../src/config/types';

/**
 * Feature: baiton-first-pass, Property 25: Generated frontmatter always records version 1
 *
 * For any spec/config the extension generates, the recorded version is exactly
 * 1. The extension records `version: 1` in both its configuration schema and
 * its generated frontmatter output (Req 23.5).
 *
 * Validates: Requirements 23.5
 *
 * The extension generates two kinds of versioned artifacts:
 *   1. the default `config.json` (this task), and
 *   2. the `create_spec` tool's `spec.md` frontmatter (task 13.2).
 *
 * The `create_spec` tool is not built yet, so this test covers the currently
 * generated versioned artifact: the default configuration. `defaultConfig()`
 * takes no varying input, so `fast-check` is used to drive many independent,
 * repeated generations (and incidental interleaving) and assert the invariant
 * holds on every one — the recorded `version` is exactly `SUPPORTED_VERSION`,
 * which itself is `1`. Coverage of `create_spec`'s spec frontmatter is deferred
 * to when task 13.2 introduces that generator.
 */

describe('generated frontmatter version (property)', () => {
  // Feature: baiton-first-pass, Property 25: Generated frontmatter always records version 1
  it('Property 25: SUPPORTED_VERSION is exactly 1', () => {
    // The single supported schema version is pinned to 1 (Req 23.5). Every
    // generated artifact below records this value, so anchoring it here makes
    // the invariant the property asserts explicit.
    assert.strictEqual(SUPPORTED_VERSION, 1);
  });

  // Feature: baiton-first-pass, Property 25: Generated frontmatter always records version 1
  it('Property 25: every generated default config records version 1', () => {
    fc.assert(
      // `repeat` drives many independent generations; `nonce` introduces
      // incidental variation across runs so the invariant is exercised as a
      // universal property rather than a single fixed call.
      fc.property(fc.integer({ min: 1, max: 50 }), fc.integer(), (repeat, _nonce) => {
        for (let i = 0; i < repeat; i++) {
          const config = defaultConfig();

          // The generated object records exactly version 1, equal to the
          // pinned supported version.
          assert.strictEqual(config.version, 1);
          assert.strictEqual(config.version, SUPPORTED_VERSION);

          // The serialized form the extension writes to `config.json` also
          // records version 1: `version` parses back to 1 and appears in the
          // emitted text.
          const json = defaultConfigJson();
          const reparsed = JSON.parse(json) as { version: unknown };
          assert.strictEqual(reparsed.version, 1);
        }
      }),
      { numRuns: 100 },
    );
  });

  // Feature: baiton-first-pass, Property 25: Generated frontmatter always records version 1
  it('Property 25: a generated config round-trips through loadConfig at version 1', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer(), async (_nonce) => {
        const dir = mkdtempSync(join(tmpdir(), 'baiton-config-version-'));
        try {
          // Write the exact bytes the Initialize command generates, then load
          // them back: the loaded config records version 1 (pinned on read).
          writeFileSync(join(dir, 'config.json'), defaultConfigJson(), 'utf8');

          const result = await loadConfig(dir);

          assert.ok(
            result.ok,
            `expected the generated default config to load, got ` +
              `${result.ok ? '' : JSON.stringify(result.error)}`,
          );
          assert.strictEqual(result.value.version, 1);
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }),
      { numRuns: 100 },
    );
  });
});
