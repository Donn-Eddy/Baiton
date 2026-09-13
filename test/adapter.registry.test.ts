import * as assert from 'assert';
import { createAdapterRegistry, isAgentId } from '../src/adapter';
import { AGENT_BINARY } from '../src/adapter/adapter';
import type { LaunchRequest } from '../src/adapter/adapter';
import { ACCEPT_EDITS_MODE, READ_ONLY_ALLOWED_TOOLS, READ_ONLY_ROLES } from '../src/adapter/permissions';

/**
 * T12 — focused coverage for the `createAdapterRegistry` / `isAgentId` seam
 * (src/adapter/index.ts). This is the lookup every dispatch site now depends
 * on to go from an unvalidated config agent string to a concrete adapter, and
 * it previously had no direct test coverage.
 */

/** Build a launch request with sensible defaults, overridable per test. */
function req(overrides: Partial<LaunchRequest> = {}): LaunchRequest {
  return {
    role: 'spec-writer',
    model: 'sonnet',
    prompt: 'Read brief.md and do what it says.',
    runId: 'run-123',
    resume: false,
    sessionId: 'session-abc',
    ...overrides,
  };
}

/** Find the index of an adjacent (flag, value) pair, or -1 when absent. */
function findPair(args: string[], flag: string, value: string): number {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag && args[i + 1] === value) {
      return i;
    }
  }
  return -1;
}

describe('createAdapterRegistry ids', () => {
  it('exposes ids matching the keys of AGENT_BINARY, in the same order', () => {
    // Pinning insertion order forces a future agent id to be added to both
    // AGENT_BINARY and the registry's instance map together; a mismatch here
    // is a wiring omission, not a test bug that needs updating for its own sake.
    const registry = createAdapterRegistry();
    assert.deepStrictEqual(registry.ids, Object.keys(AGENT_BINARY));
  });

  it('resolves every known id to an adapter whose own id matches', () => {
    const registry = createAdapterRegistry();
    for (const id of registry.ids) {
      assert.strictEqual(registry.require(id).id, id, `require(${id}) returned an adapter with a different id`);
      assert.strictEqual(registry.get(id)?.id, id, `get(${id}) returned an adapter with a different id`);
    }
  });
});

describe('isAgentId / registry.get unknown-string handling', () => {
  const unknownStrings = [
    'gemini',
    '',
    ' claude ',
    'CLAUDE',
    'toString',
    'constructor',
    '__proto__',
  ];

  for (const value of unknownStrings) {
    it(`returns undefined for the unknown/edge string ${JSON.stringify(value)}`, () => {
      const registry = createAdapterRegistry();
      assert.strictEqual(isAgentId(value), false);
      assert.strictEqual(registry.get(value), undefined);
    });
  }
});

describe('createAdapterRegistry instance sharing', () => {
  it('returns the same instance for repeated lookups within one registry', () => {
    const registry = createAdapterRegistry();
    assert.strictEqual(registry.get('claude'), registry.get('claude'));
  });

  it('returns independent claude instances across separate registries', () => {
    const a = createAdapterRegistry();
    const b = createAdapterRegistry();
    assert.notStrictEqual(a.get('claude'), b.get('claude'));
  });
});

describe('createAdapterRegistry PermissionMode threading (Req 15.7)', () => {
  it('flips the claude adapter to the acceptEdits fallback for a read-only role, but not the default registry', () => {
    const role = READ_ONLY_ROLES[0];
    const fallbackRegistry = createAdapterRegistry({ readOnlyFallbackToAcceptEdits: true });
    const defaultRegistry = createAdapterRegistry();

    const fallbackSpec = fallbackRegistry.require('claude').launch(req({ role }));
    const defaultSpec = defaultRegistry.require('claude').launch(req({ role }));

    assert.ok(
      findPair(fallbackSpec.shellArgs, '--permission-mode', ACCEPT_EDITS_MODE) >= 0,
      `expected the acceptEdits fallback: ${JSON.stringify(fallbackSpec.shellArgs)}`,
    );
    assert.ok(
      findPair(defaultSpec.shellArgs, '--allowedTools', READ_ONLY_ALLOWED_TOOLS) >= 0,
      `expected the scoped allow-list by default: ${JSON.stringify(defaultSpec.shellArgs)}`,
    );
  });

  it('does not affect the other three adapters: their args are byte-identical between registries', () => {
    const role = READ_ONLY_ROLES[0];
    const fallbackRegistry = createAdapterRegistry({ readOnlyFallbackToAcceptEdits: true });
    const defaultRegistry = createAdapterRegistry();

    for (const id of ['opencode', 'antigravity', 'codex'] as const) {
      const fallbackSpec = fallbackRegistry.require(id).launch(req({ role }));
      const defaultSpec = defaultRegistry.require(id).launch(req({ role }));
      assert.deepStrictEqual(
        fallbackSpec,
        defaultSpec,
        `${id}'s launch args must not be affected by the claude-specific PermissionMode flip`,
      );
    }
  });
});
