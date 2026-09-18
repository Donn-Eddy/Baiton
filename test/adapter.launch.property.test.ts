import * as assert from 'assert';
import * as fc from 'fast-check';
import { ClaudeAdapter } from '../src/adapter/claude';
import { OpencodeAdapter, OPENCODE_CONFIG_ENV } from '../src/adapter/opencode';
import { CodexAdapter } from '../src/adapter/codex';
import { AntigravityAdapter } from '../src/adapter/antigravity';
import { RESULT_FILE_SENTENCE, roleProfile } from '../src/adapter/roleProfile';
import {
  DEFAULT_PERMISSION_MODE,
  PermissionMode,
  READ_ONLY_ALLOWED_TOOLS,
  REVIEWER_ALLOWED_TOOLS,
  ACCEPT_EDITS_MODE,
} from '../src/adapter/permissions';
import { ROLES, Role } from '../src/model/role';

/**
 * Property test for the Claude adapter's per-role launch argument construction
 * (Requirement 15, design "Claude adapter" permission table).
 *
 * Feature: baiton-first-pass, Property 21: Per-role Claude launch arguments
 * match the permission table
 *
 * For any role and request, the launch arguments the adapter builds SHALL match
 * the design's permission table: read-only roles (planner, plan-reviewer,
 * pr-writer) get `--allowedTools "Read,Glob,Grep,Write(.baiton/runs/**)"`
 * (Requirement 15.1); reviewer additionally gets `Bash` (Requirement 15.2);
 * executor gets `--permission-mode acceptEdits` (Requirement 15.3); every role
 * is granted write access to its own `.baiton/runs/<run-id>/` directory via
 * `--add-dir` (Requirement 15.4). On resume the continue flag `-c` leads the
 * arguments (Requirements 13.2, 13.3), and the `--model`/`--effort` flags carry
 * the request's model and effort.
 *
 * The test generates random roles, models, efforts, run ids, prompts, and
 * resume flags, builds the launch spec, and asserts every table entry holds for
 * the produced `shellArgs`.
 */

/** The expected `--allowedTools` value / permission-mode row for a role. */
function expectedPermissionArgs(role: Role, mode: PermissionMode): string[] {
  if (role === 'executor') {
    return ['--permission-mode', ACCEPT_EDITS_MODE];
  }
  if (role === 'reviewer') {
    return ['--allowedTools', REVIEWER_ALLOWED_TOOLS];
  }
  // Read-only roles: planner, plan-reviewer, pr-writer.
  if (mode.readOnlyFallbackToAcceptEdits) {
    return ['--permission-mode', ACCEPT_EDITS_MODE];
  }
  return ['--allowedTools', READ_ONLY_ALLOWED_TOOLS];
}

/**
 * Find the index of a contiguous flag/value pair (`flag`, `value`) inside args.
 * Returns the index of `flag`, or -1 when the pair does not appear adjacently.
 */
function findPair(args: string[], flag: string, value: string): number {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === flag && args[i + 1] === value) {
      return i;
    }
  }
  return -1;
}

/** A generator over the five known roles. */
const roleArb: fc.Arbitrary<Role> = fc.constantFrom(...(ROLES as readonly Role[]));

/** A non-empty model identifier without whitespace surprises. */
const modelArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 20 })
  .filter((s) => s.trim().length > 0);

/** An optional effort: either absent, empty (dropped), or a non-empty value. */
const effortArb: fc.Arbitrary<string | undefined> = fc.option(
  fc.string({ minLength: 0, maxLength: 12 }),
  { nil: undefined },
);

/** A run id used to scope the per-run write grant. */
const runIdArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 16 })
  .filter((s) => s.trim().length > 0 && !s.includes('/'));

/** The initial prompt handed to the CLI. */
const promptArb: fc.Arbitrary<string> = fc.string({ minLength: 1, maxLength: 40 });

/** The fresh-launch Claude `--session-id` UUID. */
const sessionIdArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 16 })
  .filter((s) => s.trim().length > 0);

/** An optional resume Session_Id: either absent (falls back to `-c`) or a value. */
const resumeSessionIdArb: fc.Arbitrary<string | undefined> = fc.option(
  fc.string({ minLength: 1, maxLength: 16 }).filter((s) => s.trim().length > 0),
  { nil: undefined },
);

describe('Claude adapter per-role launch arguments (property harness)', () => {
  // Feature: baiton-first-pass, Property 21: Per-role Claude launch arguments
  // match the permission table
  it('builds shellArgs matching the permission table for any role and request', () => {
    fc.assert(
      fc.property(
        roleArb,
        modelArb,
        effortArb,
        runIdArb,
        promptArb,
        fc.boolean(),
        fc.boolean(),
        sessionIdArb,
        resumeSessionIdArb,
        (role, model, effort, runId, prompt, resume, fallback, sessionId, resumeSessionId) => {
          const mode: PermissionMode = fallback
            ? { readOnlyFallbackToAcceptEdits: true }
            : DEFAULT_PERMISSION_MODE;
          const adapter = new ClaudeAdapter(mode);

          const spec = adapter.launch({
            role,
            model,
            effort,
            prompt,
            runId,
            resume,
            sessionId,
            resumeSessionId,
          });
          const args = spec.shellArgs;

          // The adapter always launches the `claude` binary directly.
          assert.strictEqual(spec.shellPath, 'claude');

          // Model flag carries the requested model as an adjacent pair.
          assert.ok(
            findPair(args, '--model', model) >= 0,
            `expected --model ${model} in ${JSON.stringify(args)}`,
          );

          // Effort flag appears iff a non-empty effort was requested.
          const effortPresent = effort !== undefined && effort.length > 0;
          if (effortPresent) {
            assert.ok(
              findPair(args, '--effort', effort as string) >= 0,
              `expected --effort ${effort} in ${JSON.stringify(args)}`,
            );
          } else {
            assert.ok(
              !args.includes('--effort'),
              `unexpected --effort flag in ${JSON.stringify(args)}`,
            );
          }

          // The per-role permission row matches the table exactly.
          const permArgs = expectedPermissionArgs(role, mode);
          assert.ok(
            findPair(args, permArgs[0], permArgs[1]) >= 0,
            `expected permission pair ${JSON.stringify(permArgs)} for role ${role} in ${JSON.stringify(args)}`,
          );

          // Read-only roles never get Bash; only reviewer's allowedTools does.
          if (role !== 'reviewer' && role !== 'executor') {
            const allowedIdx = args.indexOf('--allowedTools');
            if (allowedIdx >= 0 && !mode.readOnlyFallbackToAcceptEdits) {
              assert.ok(
                !args[allowedIdx + 1].includes('Bash'),
                `read-only role ${role} must not be granted Bash: ${args[allowedIdx + 1]}`,
              );
            }
          }

          // Every role is granted write to its own per-run directory.
          assert.ok(
            findPair(args, '--add-dir', `.baiton/runs/${runId}/`) >= 0,
            `expected per-run grant for ${runId} in ${JSON.stringify(args)}`,
          );

          // Fresh launch always carries --session-id; resume carries exactly
          // one of --resume <id> / -c depending on whether a prior Session_Id
          // is known (Requirements 3.1, 3.2).
          if (!resume) {
            assert.ok(
              findPair(args, '--session-id', sessionId) === 0,
              `fresh launch must lead with --session-id ${sessionId}: ${JSON.stringify(args)}`,
            );
            assert.ok(!args.includes('-c'));
            assert.ok(!args.includes('--resume'));
          } else if (resumeSessionId !== undefined && resumeSessionId.length > 0) {
            assert.ok(
              findPair(args, '--resume', resumeSessionId) === 0,
              `resume with a known session must lead with --resume ${resumeSessionId}: ${JSON.stringify(args)}`,
            );
            assert.ok(!args.includes('-c'));
            assert.ok(!args.includes('--session-id'));
          } else {
            assert.strictEqual(
              args[0],
              '-c',
              `resume without a known session must lead with -c: ${JSON.stringify(args)}`,
            );
            assert.ok(!args.includes('--resume'));
            assert.ok(!args.includes('--session-id'));
          }

          // The prompt is passed as the final argument.
          assert.strictEqual(
            args[args.length - 1],
            prompt,
            `prompt must be the final argument: ${JSON.stringify(args)}`,
          );
        },
      ),
      { numRuns: 200 },
    );
  });
});

/**
 * Feature: baiton-role-profiles, Property: every adapter's launch is pure and
 * role-consistent, including the role-profile outputs it now carries.
 *
 * The role profile (`src/adapter/roleProfile.ts`) is translated by four
 * different adapters into three different mechanisms — claude's
 * `--append-system-prompt`, opencode's `OPENCODE_CONFIG_CONTENT` custom agent,
 * codex's `-c developer_instructions=` — and antigravity deliberately carries
 * none (Decision 3). This property pins that each translation is a pure
 * function of (role, runId) and that it never disagrees with the table it is
 * derived from.
 */
describe('Every adapter delivers the role profile purely and consistently (property harness)', () => {
  it('is pure and profile-consistent for any role, run id and request', () => {
    fc.assert(
      fc.property(
        roleArb,
        modelArb,
        effortArb,
        runIdArb,
        promptArb,
        sessionIdArb,
        (role, model, effort, runId, prompt, sessionId) => {
          const request = { role, model, effort, prompt, runId, resume: false, sessionId };
          const profile = roleProfile(role);

          for (const adapter of [
            new ClaudeAdapter(),
            new OpencodeAdapter(),
            new CodexAdapter(),
            new AntigravityAdapter(),
          ]) {
            // Purity: launch is a function of its request alone.
            assert.deepStrictEqual(
              adapter.launch(request),
              adapter.launch(request),
              `${adapter.id}.launch is not pure`,
            );
          }

          // claude: the profile prompt rides --append-system-prompt verbatim.
          const claudeArgs = new ClaudeAdapter().launch(request).shellArgs;
          assert.ok(
            findPair(claudeArgs, '--append-system-prompt', profile.systemPrompt) >= 0,
            `claude dropped ${role}'s profile prompt`,
          );

          // codex: the same text, TOML-quoted behind -c developer_instructions.
          const codexArgs = new CodexAdapter().launch(request).shellArgs;
          const codexValue = codexArgs[codexArgs.indexOf('-c') + 1];
          assert.strictEqual(
            JSON.parse(codexValue.slice('developer_instructions='.length)),
            profile.systemPrompt,
            `codex mangled ${role}'s profile prompt`,
          );

          // opencode: one custom agent keyed by the profile's agent name,
          // carrying the prompt and the write/shell rules from the table.
          const env = new OpencodeAdapter().launch(request).env as Record<string, string>;
          const parsed = JSON.parse(env[OPENCODE_CONFIG_ENV]) as {
            agent: Record<string, { prompt: string; permission: { edit: Record<string, string>; bash?: Record<string, string> } }>;
          };
          assert.deepStrictEqual(Object.keys(parsed.agent), [profile.agentName]);
          const agent = parsed.agent[profile.agentName];
          assert.strictEqual(agent.prompt, profile.systemPrompt);
          assert.strictEqual(
            agent.permission.edit['*'],
            profile.write === 'workspace' ? 'allow' : 'deny',
            `opencode edit rule disagrees with ${role}'s write scope`,
          );
          if (profile.write === 'run-dir') {
            assert.strictEqual(agent.permission.edit[`.baiton/runs/${runId}/*`], 'allow');
          }
          assert.strictEqual(
            agent.permission.bash === undefined,
            profile.shell,
            `opencode bash rule disagrees with ${role}'s shell bit`,
          );

          // antigravity: no profile prompt anywhere on argv (Decision 3).
          const agyArgs = new AntigravityAdapter().launch(request).shellArgs;
          assert.ok(!agyArgs.includes('--append-system-prompt'));
          assert.ok(!agyArgs.some((a) => a.includes(RESULT_FILE_SENTENCE)));
        },
      ),
      { numRuns: 200 },
    );
  });
});
