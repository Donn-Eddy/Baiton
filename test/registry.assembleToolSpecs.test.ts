import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  MIN_TOOL_DESCRIPTION_LENGTH,
  assembleToolSpecs,
  createToolRegistry,
} from '../src/orchestrator/registry';
import { Tool, ToolContext, ToolResult } from '../src/orchestrator/guard';
import { ToolServices } from '../src/orchestrator/toolServices';
import { GitService, GitStatus } from '../src/git';
import { Result, ok } from '../src/model/result';
import { RunDispatchOutcome, RunDispatchRequest } from '../src/orchestrator/seams';

/**
 * Unit tests for tool-description assembly rejection (Task 8.2).
 *
 * Covers Req 10.5 (and 10.2–10.4 by way of it):
 *  - `assembleToolSpecs` rejects a tool whose description is missing (empty),
 *    shorter than {@link MIN_TOOL_DESCRIPTION_LENGTH} after trimming, or equal
 *    to the tool's `name`; the rejection names the offending tool and produces
 *    NO definitions (nothing is sent to the model).
 *  - A valid tool list assembles into a `ToolSpec[]` whose every description is
 *    set from that tool's `description` field (never its `name`).
 *  - The real registry, whose every registered tool carries a real
 *    description, assembles successfully with matching descriptions.
 */

/** Build a minimal {@link Tool} with a given name and description for assembly. */
function fakeTool(name: string, description: string): Tool {
  return {
    name,
    description,
    mutating: false,
    schema: { type: 'object' },
    // Assembly never runs the tool; this stub is only here to satisfy the type.
    run: async (_args: unknown, _tc: ToolContext): Promise<ToolResult> => ({
      ok: true,
      data: null,
    }),
  };
}

describe('assembleToolSpecs description validation (Task 8.2)', () => {
  describe('rejection cases (Req 10.5)', () => {
    it('rejects an empty description, names the tool, and produces no definitions', () => {
      const tools = [
        fakeTool('list_specs', 'Lists every spec in the workspace.'),
        fakeTool('read_spec', ''),
      ];

      const result = assembleToolSpecs(tools);

      assert.strictEqual(result.ok, false, 'an empty description must be rejected');
      if (!result.ok) {
        assert.strictEqual(
          result.error.tool,
          'read_spec',
          'the rejection names the offending tool',
        );
        assert.match(result.error.reason, /empty/i, 'the reason explains the failure');
        // No `value` (definitions) is present on a rejection: nothing is sent.
        assert.strictEqual(
          (result as { value?: unknown }).value,
          undefined,
          'a rejection carries no definitions',
        );
      }
    });

    it('rejects a whitespace-only description as empty after trimming', () => {
      const tools = [fakeTool('read_spec', '   \n\t  ')];

      const result = assembleToolSpecs(tools);

      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.strictEqual(result.error.tool, 'read_spec');
        assert.match(result.error.reason, /empty/i);
      }
    });

    it('rejects a description shorter than the minimum after trimming, and names the tool', () => {
      // 9 visible chars, padded with whitespace that trims away.
      const shortDescription = '  too short  ';
      assert.ok(
        shortDescription.trim().length < MIN_TOOL_DESCRIPTION_LENGTH,
        'the fixture must actually be under the minimum after trimming',
      );
      const tools = [
        fakeTool('list_specs', 'Lists every spec in the workspace.'),
        fakeTool('read_file', shortDescription),
      ];

      const result = assembleToolSpecs(tools);

      assert.strictEqual(result.ok, false, 'a too-short description must be rejected');
      if (!result.ok) {
        assert.strictEqual(result.error.tool, 'read_file');
        assert.match(result.error.reason, /shorter than|10/i);
      }
    });

    it('rejects a description equal to the tool name, and names the tool', () => {
      // The name is >= MIN_TOOL_DESCRIPTION_LENGTH so it clears the length gate
      // and the name-equality check is the one that fires (Req 10.2, 10.4).
      const name = 'update_overview';
      assert.ok(
        name.length >= MIN_TOOL_DESCRIPTION_LENGTH,
        'the fixture name must be long enough to reach the name-equality check',
      );
      const tools = [fakeTool(name, name)];

      const result = assembleToolSpecs(tools);

      assert.strictEqual(result.ok, false, 'a name-equal description must be rejected');
      if (!result.ok) {
        assert.strictEqual(result.error.tool, name);
        assert.match(result.error.reason, /name/i);
      }
    });

    it('rejects a description equal to the tool name only after trimming whitespace', () => {
      const name = 'update_overview';
      const tools = [fakeTool(name, `  ${name}  `)];

      const result = assembleToolSpecs(tools);

      assert.strictEqual(result.ok, false);
      if (!result.ok) {
        assert.strictEqual(result.error.tool, name);
        assert.match(result.error.reason, /name/i);
      }
    });
  });

  describe('successful assembly (Req 10.3, 10.4)', () => {
    it('assembles a ToolSpec per tool with each description set from the tool field', () => {
      const tools = [
        fakeTool('list_specs', 'Lists every spec in the workspace.'),
        fakeTool('read_spec', 'Reads the raw text of one spec by slug.'),
      ];

      const result = assembleToolSpecs(tools);

      assert.strictEqual(result.ok, true, 'valid descriptions assemble');
      if (result.ok) {
        assert.strictEqual(result.value.length, tools.length);
        for (let i = 0; i < tools.length; i += 1) {
          assert.strictEqual(result.value[i].name, tools[i].name);
          assert.strictEqual(
            result.value[i].description,
            tools[i].description,
            'the spec description comes from the tool description field',
          );
          assert.notStrictEqual(
            result.value[i].description,
            tools[i].name,
            'the spec description is never the tool name',
          );
          assert.strictEqual(result.value[i].parameters, tools[i].schema);
        }
      }
    });
  });

  describe('the real registry assembles (Req 10.2, 10.3)', () => {
    const repos: string[] = [];

    function newRepo(): string {
      const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-assemble-'));
      repos.push(repo);
      return repo;
    }

    afterEach(() => {
      while (repos.length > 0) {
        const repo = repos.pop()!;
        fs.rmSync(repo, { recursive: true, force: true });
      }
    });

    it('a registry with every tool given a real description assembles, each spec matching its tool', () => {
      const repo = newRepo();
      const registry = createToolRegistry(makeServices(repo));

      const definitions = registry.definitions();
      const result = registry.assemble();

      assert.strictEqual(result.ok, true, 'the real registry must assemble');
      if (result.ok) {
        assert.strictEqual(
          result.value.length,
          definitions.length,
          'one spec per registered tool',
        );
        const byName = new Map(result.value.map((s) => [s.name, s]));
        for (const def of definitions) {
          const spec = byName.get(def.name);
          assert.ok(spec, `assembled specs include "${def.name}"`);
          assert.strictEqual(
            spec!.description,
            def.description,
            `"${def.name}" spec description matches its tool field`,
          );
          assert.notStrictEqual(
            spec!.description,
            def.name,
            `"${def.name}" description is not its name (Req 10.4)`,
          );
          assert.ok(
            spec!.description.trim().length >= MIN_TOOL_DESCRIPTION_LENGTH,
            `"${def.name}" description is long enough (Req 10.2)`,
          );
        }
      }
    });
  });
});

/** A benign git stub; assembly never reaches git, but services require one. */
function benignGit(): GitService {
  return {
    status: async (): Promise<GitStatus> => ({ clean: true, changes: [] }),
    isCleanExceptSpecFolder: async () => true,
    fetch: async () => undefined,
    resolveBaseCommit: async () => '0'.repeat(40),
    createSpecBranch: async () => undefined,
    checkout: async () => undefined,
    commit: async () => 'a'.repeat(40),
    head: async () => 'a'.repeat(40),
    currentBranch: async () => 'main',
    diff: async () => '',
    diffAgainstWorkingTree: async () => '',
    log: async () => '',
    resetWorkingTree: async (): Promise<Result<void, never>> => ok(undefined),
    findCommitByRunId: async () => undefined,
    push: async () => undefined,
    remoteUrl: async () => '',
  };
}

/** Build {@link ToolServices} rooted at `repoRoot` for registry construction. */
function makeServices(repoRoot: string): ToolServices {
  return {
    repoRoot,
    baitonDir: path.join(repoRoot, '.baiton'),
    git: benignGit(),
    confirm: { confirm: async () => true },
    runQueue: {
      dispatch: async (_req: RunDispatchRequest): Promise<RunDispatchOutcome> => ({
        kind: 'busy' as const,
      }),
    },
    clock: { now: () => '2024-01-01T00:00:00.000Z' },
    ids: { next: () => 'id-1' },
    gitSettings: { remote: 'origin', base: 'main' },
  };
}
