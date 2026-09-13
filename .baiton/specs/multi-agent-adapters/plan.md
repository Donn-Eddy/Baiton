# plan result

```json
{
  "steps": [
    {
      "title": "Re-read the two anchor files before writing anything (read-only)",
      "detail": "What exists today. test/adapter.claude.test.ts is the shape to mirror: plain mocha + node `assert`, a module-level doc comment naming the contracts it pins, a local `req(overrides)` builder producing a full `LaunchRequest` ({role:'executor', model:'sonnet', prompt, runId:'run-123', resume:false, sessionId:'session-abc'}), a local `findPair(args, flag, value)` helper that looks for an ADJACENT flag/value pair and returns its index or -1, and one `describe` per contract group (probe shape / session-id branches / attach / permission table). src/adapter/opencode.ts is the unit under test: it exports `OpencodeAdapter`, the two profile constants `OPENCODE_PLAN_AGENT = 'plan'` and `OPENCODE_BUILD_AGENT = 'build'`, and the helper `opencodeAgentFlags(role)`. Its `launch()` builds `['run', ...(resume ? (resumeSessionId?.length ? ['-s', id] : ['-c']) : []), '-m', model, '--agent', <plan|build>, ...(effort ? ['--variant', effort] : []), '-i', prompt]` and its `attach()` builds exactly `['run', '-s', sessionId, '--agent', <plan|build>, '-i']`. Two facts drive most of the assertions and must be re-verified in the source before writing them: (a) unlike claude, the arg list ALWAYS leads with the `run` subcommand, so the resume/fresh discriminator sits at index 1, not index 0 — every `slice(0, 2)`-style assertion copied from the claude test has to shift by one; (b) opencode emits no `--add-dir`, no `--allowedTools`, no `--permission-mode`, and `req.runId`/`req.sessionId` are deliberately unused by `launch()`. No source file is modified by this todo.",
      "files": [
        "test/adapter.claude.test.ts",
        "src/adapter/opencode.ts",
        "src/adapter/adapter.ts",
        "src/adapter/permissions.ts"
      ]
    },
    {
      "title": "Create test/adapter.opencode.test.ts with the mirrored scaffolding",
      "detail": "New file, same skeleton as the claude test so the two read as a family.\n\nImports: `import * as assert from 'assert';`, `import { OpencodeAdapter, OPENCODE_PLAN_AGENT, OPENCODE_BUILD_AGENT, opencodeAgentFlags } from '../src/adapter/opencode';`, `import type { LaunchRequest } from '../src/adapter/adapter';`, `import { AGENT_BINARY } from '../src/adapter/adapter';`, `import { isReadOnlyRole } from '../src/adapter/permissions';`, `import { ROLES, Role } from '../src/model/role';`. Import only what is used — `npm run lint` runs eslint over `test` as well as `src`, so an unused import fails the build.\n\nModule doc comment: state that this file mirrors test/adapter.claude.test.ts for the opencode CLI and pins (1) the probe `{version, ok, reason?}` contract including the non-empty reason on failure (Req 14.2-14.4), (2) the fresh-vs-resume `-s`/`-c` branches behind the leading `run` subcommand (Req 13.2, 13.3), (3) `attach()`'s no-prompt reopen (Req 3.3, 3.4), and (4) the two documented degrades — no run-dir grant (no `--add-dir`, Req 15.4 unenforceable here) and `req.sessionId` ignored on a fresh launch.\n\nCopy the two local helpers verbatim from the claude test (`req()` and `findPair()`), with one change to `req()`: use an opencode-shaped model id, `model: 'anthropic/claude-sonnet-5'`, because opencode model ids are `provider/model` and the adapter passes `req.model` through unchanged. Instantiate the adapter once per describe block as `const adapter = new OpencodeAdapter();` (it takes no constructor argument — the `PermissionMode` flip is claude-specific and passing one is a type error).",
      "files": [
        "test/adapter.opencode.test.ts",
        "test/adapter.claude.test.ts",
        "src/adapter/opencode.ts"
      ]
    },
    {
      "title": "Probe success/failure cases (Req 14.2, 14.3, 14.4)",
      "detail": "`describe('OpencodeAdapter probe shape (Req 14.2, 14.3, 14.4)')` with the two cases from the claude test, adapted:\n\n1. `it('reports ok:false with a non-empty reason and empty version when the CLI is missing')` — save `process.env.PATH`, set it to `''`, `await new OpencodeAdapter().probe()` inside a `try`, restore in `finally`. Assert `typeof result.version === 'string'`, `typeof result.ok === 'boolean'`, `result.ok === false`, `result.version === ''`, `typeof result.reason === 'string'` and `(result.reason as string).length > 0`. Additionally assert the reason names the binary: `assert.ok((result.reason as string).includes(AGENT_BINARY.opencode))` — this is the one assertion worth adding beyond the claude mirror, because `describeProbeError()` is per-adapter and a copy-paste slip that left `claude` in the message would otherwise pass silently. Deriving the expected name from `AGENT_BINARY.opencode` rather than the literal `'opencode'` keeps the test honest if the binary name ever changes.\n2. `it('returns a value conforming to the ProbeResult shape regardless of outcome')` — no PATH manipulation; assert the shape, and branch: when `ok` is true assert `version.length > 0` and `reason === undefined`; when false assert a non-empty string reason. This case must stay outcome-agnostic because opencode may or may not be installed on the machine running the suite.\n\nDo not stub `child_process.execFile` and do not add a mocking dependency: the claude test drives the real failure path through PATH and the suite has no mocking library. Keep the `finally` restore exact (`process.env.PATH = savedPath;`), including the case where `savedPath` is `undefined`, so a failure in one case cannot cascade into the rest of the file.",
      "files": [
        "test/adapter.opencode.test.ts",
        "src/adapter/opencode.ts",
        "src/adapter/adapter.ts"
      ]
    },
    {
      "title": "Fresh vs resume launch args, including the ignored session id",
      "detail": "`describe('OpencodeAdapter launch session branches (Req 3.1, 3.2, 13.2, 13.3)')`:\n\n1. Fresh launch: `adapter.launch(req({resume: false, sessionId: 'session-xyz'}))`. Assert `spec.shellPath === AGENT_BINARY.opencode`; `spec.shellArgs[0] === 'run'`; the args contain neither `-s` nor `-c`; and — the degrade that matters — `assert.ok(!spec.shellArgs.includes('session-xyz'))` plus `assert.ok(!spec.shellArgs.includes('--session-id'))`, pinning that opencode mints its own id and `req.sessionId` is dropped rather than smuggled in under some other flag.\n2. Resume with a prior id: `req({resume: true, resumeSessionId: 'prior-session'})` → `assert.deepStrictEqual(spec.shellArgs.slice(0, 3), ['run', '-s', 'prior-session'])`, and `!includes('-c')`.\n3. Resume with no prior id: `req({resume: true, resumeSessionId: undefined})` → `slice(0, 2)` is `['run', '-c']`, exactly one `-c`, no `-s`.\n4. Empty-string prior id behaves as \"no prior id\": `req({resume: true, resumeSessionId: ''})` → `slice(0, 2)` is `['run', '-c']`. The adapter's guard is `!== undefined && .length > 0`, and this case pins the second half of it (the claude test has no equivalent; it is cheap and guards a real off-by-one in the condition).\n5. Branch-equivalence: fresh vs no-id resume differ only by the inserted `-c`, i.e. `assert.deepStrictEqual(fresh.shellArgs.slice(1), resumed.shellArgs.slice(2))` — the claude test's `slice(2)/slice(1)` pair shifted right by the `run` subcommand.\n6. Model/effort/prompt tail: with `effort: 'high'`, assert `findPair(args, '-m', 'anthropic/claude-sonnet-5') >= 0` (model passed through verbatim, `provider/model` shape untouched) and `findPair(args, '--variant', 'high') >= 0`; with `effort` omitted, assert `!args.includes('--variant')`. Then pin the trailing-positional contract, which is opencode's key divergence from claude: `assert.strictEqual(args[args.length - 1], req.prompt)`, `assert.strictEqual(args[args.length - 2], '-i')`, and `assert.ok(!args.includes('--'))` — the prompt is a bare positional, NOT behind a `--` separator.",
      "files": [
        "test/adapter.opencode.test.ts",
        "src/adapter/opencode.ts"
      ]
    },
    {
      "title": "attach() and the per-role --agent mapping",
      "detail": "`describe('OpencodeAdapter attach() (Req 3.3, 3.4)')`:\n\n1. `adapter.attach({role: 'executor', runId: 'run-9', sessionId: 'session-42'})` — because attach's output is short and fully determined, assert the whole array: `assert.deepStrictEqual(spec.shellArgs, ['run', '-s', 'session-42', '--agent', OPENCODE_BUILD_AGENT, '-i'])`, and `spec.shellPath === AGENT_BINARY.opencode`. Then the negative contracts: no prompt is appended (`args.length === 6`, no `-m`, no `--model`), and `runId` never appears (`!args.includes('run-9')`, `!args.includes('--add-dir')`) — attach accepts `runId` only to satisfy the `Adapter` signature.\n2. A read-only role: `attach({role: 'planner', ...})` → `findPair(args, '--agent', OPENCODE_PLAN_AGENT) >= 0`.\n\n`describe('OpencodeAdapter role -> --agent profile mapping')`: loop `for (const role of ROLES)` and assert, for both `launch(req({role}))` and `attach({role, runId: 'run-1', sessionId: 's-1'})`, that `findPair(args, '--agent', isReadOnlyRole(role) ? OPENCODE_PLAN_AGENT : OPENCODE_BUILD_AGENT) >= 0`. Driving expectations from `isReadOnlyRole` (not a hand-written role list) means a role added to `READ_ONLY_ROLES` later is covered automatically. Add one direct case for the exported helper: `assert.deepStrictEqual(opencodeAgentFlags('planner'), ['--agent', OPENCODE_PLAN_AGENT])` and the executor equivalent. Assert the profile constants' concrete values once (`OPENCODE_PLAN_AGENT === 'plan'`, `OPENCODE_BUILD_AGENT === 'build'`) so the rest of the file can reference the constants without becoming vacuous.",
      "files": [
        "test/adapter.opencode.test.ts",
        "src/adapter/opencode.ts",
        "src/adapter/permissions.ts",
        "src/model/role.ts"
      ]
    },
    {
      "title": "Pin the missing-run-dir-grant degrade explicitly, for every role",
      "detail": "`describe('OpencodeAdapter documented degrades (no run-dir grant, no claude permission flags)')` — this block is the reason T09 is not just a copy of the claude test, and it should be written as an intentional characterisation of a known gap, not as an aspiration.\n\nFor every `role of ROLES`, for both `launch(req({role, runId: 'run-777'}))` and `attach({role, runId: 'run-777', sessionId: 's-1'})`, assert the args contain none of: `'--add-dir'`, `'.baiton/runs/run-777/'`, `'--allowedTools'`, `'--permission-mode'`, and `'--auto'`. The `--auto` exclusion is a real guard, not padding: the OVERVIEW rules it out as \"dangerous\" (it auto-approves everything), so a future edit reaching for it to approximate acceptEdits should fail a test rather than pass review. Include a comment above the block stating plainly that opencode has no `--add-dir` and no granular allow-list, so Requirement 15.4's per-run write scoping is UNENFORCED for opencode roles and is conveyed only by the brief — the test asserts today's true behaviour so the gap stays visible, and it is the test to change (not delete) if opencode ever gains the flag.\n\nDo NOT import `runDirGrant` or `READ_ONLY_ALLOWED_TOOLS` to build these assertions; the point is the literal absence of claude's vocabulary from opencode's arg list, and unused-after-refactor imports would trip lint.",
      "files": [
        "test/adapter.opencode.test.ts",
        "src/adapter/opencode.ts",
        "src/adapter/permissions.ts"
      ]
    },
    {
      "title": "Verify: lint, compile, and run the new file plus the suite",
      "detail": "1. `npx mocha test/adapter.opencode.test.ts` — fastest feedback loop; `.mocharc.json` already registers `ts-node/register`, so no extra flags are needed and no build step precedes it.\n2. `npm run lint` — eslint covers `test` as well as `src`; unused imports/vars and missing return types are the realistic failures in a new test file.\n3. `npm run compile` — `tsc -p ./` type-checks the test tree too; `req({role})` inside a `for (const role of ROLES)` loop needs `role` to be typed `Role`, which it is when iterating `ROLES`.\n4. `npm test` — the full suite must stay green. If something outside test/adapter.opencode.test.ts fails, note it and leave it: cross-cutting breakage from the widened union and the per-role wiring is explicitly T12's job, not this todo's.\n5. Scope discipline: create exactly one new file. Do not modify src/adapter/opencode.ts even if a test exposes something arguable (record it in the execution summary instead), do not touch test/adapter.claude.test.ts or test/adapter.launch.property.test.ts, and do not write the antigravity or codex tests (T10, T11).",
      "files": [
        "test/adapter.opencode.test.ts",
        ".mocharc.json",
        "package.json"
      ]
    }
  ],
  "risks": [
    "The single most likely defect is copying the claude test's index arithmetic unchanged. opencode's arg list always begins with the `run` subcommand, so the fresh/resume discriminator is at index 1: `shellArgs.slice(0, 2) === ['--resume', id]` becomes `slice(0, 3) === ['run', '-s', id]`, and the branch-equivalence assertion becomes `fresh.slice(1)` vs `resumed.slice(2)`. An off-by-one here yields a test that fails for the wrong reason, or worse, one that passes vacuously.",
    "The probe failure case depends on `PATH=''` producing ENOENT. On some POSIX systems an empty PATH falls back to a confstr default path, so if `opencode` is installed in that default location the probe could succeed and the case would fail. The existing claude test carries the same assumption, so mirroring it is the consistent choice — but if it proves flaky, the fix is to point PATH at an empty temp directory rather than to weaken the assertions.",
    "Symmetrically, the machine running the suite may or may not have opencode installed, so no test may assume the probe succeeds. Only the outcome-agnostic shape case may run without PATH manipulation, and it must branch on `result.ok`.",
    "`OpencodeAdapter`'s constructor takes no arguments — the `PermissionMode` / `readOnlyFallbackToAcceptEdits` flip is claude-specific. Mirroring the claude test's `new ClaudeAdapter(fallbackMode)` blocks would be both a type error and conceptually wrong; the opencode analogue of the permission-table block is the `--agent plan|build` mapping.",
    "Asserting the absence of `--add-dir` codifies a known gap as expected behaviour. That is deliberate (the OVERVIEW asks for the degrade to be visible rather than silently implied), but a reader could mistake it for endorsement — the block needs the comment explaining that run-dir scoping is unenforced for opencode and that the test should be updated, not deleted, if the CLI gains the flag.",
    "`attach()`'s exact-array assertion is the tightest in the file and will fail on any benign reordering of the adapter's flags. That strictness is the point for a six-element deterministic list, but the executor should not loosen the launch-side assertions to match: launch uses `findPair`/positional checks precisely so that adding a future flag does not break unrelated cases.",
    "Scope creep toward T10-T12 is easy here: a shared helper file for all three new adapter tests, or a generalised parameterised suite, would pull antigravity and codex into this todo. Keep the file standalone and duplicate the small `req`/`findPair` helpers, exactly as the claude test does."
  ],
  "acceptance": [
    "test/adapter.opencode.test.ts exists, is picked up by the `test/**/*.test.ts` spec glob in .mocharc.json, and uses only mocha + node `assert` with no new dependency.",
    "Probe coverage: one case forces `ok:false` with `version === ''` and a non-empty reason that names the `opencode` binary, and one case asserts the `{version, ok, reason?}` shape holds regardless of whether the CLI is installed; PATH is restored in a `finally`.",
    "Launch coverage: a fresh launch leads with `run`, carries no `-s`/`-c`, and provably drops `req.sessionId`; resume with a prior id leads `['run', '-s', <id>]`; resume with an absent OR empty prior id leads `['run', '-c']`; the fresh and no-id-resume tails are otherwise identical.",
    "The model is asserted to pass through verbatim in opencode's `provider/model` shape, `--variant <effort>` appears exactly when `req.effort` is set, and the prompt is the final positional preceded by `-i`, with no `--` separator.",
    "attach() is asserted as the exact array `['run', '-s', <sessionId>, '--agent', <profile>, '-i']` with no prompt, no model flag, and no appearance of the run id.",
    "The `--agent` mapping is asserted for every role in ROLES, for both launch and attach, with the expected profile derived from `isReadOnlyRole` rather than a hand-written list, and `opencodeAgentFlags` is exercised directly.",
    "A dedicated block asserts, for every role and for both launch and attach, that the args contain no `--add-dir`, no run-dir path, no `--allowedTools`, no `--permission-mode` and no `--auto`, with a comment stating that per-run write scoping is unenforced for opencode.",
    "`npm run lint`, `npm run compile` and `npm test` pass; no file under src/ is modified and no other test file is touched.",
    "The antigravity and codex adapter tests (T10, T11) and the cross-cutting suite sweep (T12) are not started."
  ]
}
```
