# plan result

```json
{
  "steps": [
    {
      "title": "Create test/adapter.codex.test.ts with the shared scaffolding mirrored from the antigravity test",
      "detail": "Create the new file following the exact structure of test/adapter.antigravity.test.ts (the closest sibling, itself mirrored from test/adapter.claude.test.ts). Imports: `import * as assert from 'assert';`, the adapter and its exported helpers/constants from '../src/adapter/codex' (CodexAdapter, CODEX_READ_ONLY_SANDBOX, CODEX_WORKSPACE_WRITE_SANDBOX, CODEX_ASK_FOR_APPROVAL, CODEX_EFFORT_CONFIG_KEY, codexPermissionFlags, codexEffortFlags), `type { LaunchRequest }` and `AGENT_BINARY` from '../src/adapter/adapter', `isReadOnlyRole` from '../src/adapter/permissions', and `ROLES` from '../src/model/role'. Add the same two local helpers verbatim: `req(overrides: Partial<LaunchRequest> = {}): LaunchRequest` returning {role:'executor', model:'sonnet', prompt:'Read brief.md and do what it says.', runId:'run-123', resume:false, sessionId:'session-abc', ...overrides}, and `findPair(args, flag, value): number` scanning for an adjacent flag/value pair. Open with a file-level doc comment naming what this file pins (probe contract Req 14.2-14.4; fresh vs `codex resume <id>` vs `codex resume --last` branches Req 3.1/3.2/13.2/13.3; attach() no-prompt reopen Req 3.3/3.4; the --sandbox/--ask-for-approval permission mapping and --add-dir run-dir grant Req 15.1-15.4; and the codex-specific degrades: dropped req.sessionId, the --config model_reasoning_effort effort degrade, the interactive-form-not-`exec` choice, and the prompt dropped on the `resume --last` branch). No mocha/ts-node config change is needed: .mocharc.json already globs test/**/*.test.ts.",
      "files": [
        "test/adapter.codex.test.ts",
        "test/adapter.antigravity.test.ts",
        "test/adapter.claude.test.ts"
      ]
    },
    {
      "title": "describe('CodexAdapter probe shape (Req 14.2, 14.3, 14.4)')",
      "detail": "Two tests, mirroring the antigravity file. (1) 'reports ok:false with a non-empty reason and empty version when the CLI is missing': save process.env.PATH, set it to '', call `await new CodexAdapter().probe()` in a try/finally that restores PATH. Assert typeof result.version === 'string', typeof result.ok === 'boolean', result.ok === false, result.version === '', typeof result.reason === 'string', reason.length > 0, and reason.includes(AGENT_BINARY.codex) — this covers describeProbeError's ENOENT and generic branches without pinning which one fires. (2) 'returns a value conforming to the ProbeResult shape regardless of outcome': probe with the ambient PATH and assert the discriminated shape — when ok, version.length > 0 and reason === undefined; when not ok, reason is a non-empty string. Do NOT assert a concrete version string: codex prints the prefixed 'codex-cli 0.154.0' and the adapter keeps the whole trimmed stdout, so asserting content would make the test machine-dependent. Optionally add a comment noting that the prefixed-version tolerance is why no format assertion exists here.",
      "files": [
        "test/adapter.codex.test.ts",
        "src/adapter/codex.ts"
      ]
    },
    {
      "title": "describe('CodexAdapter launch session branches (Req 3.1, 3.2, 13.2, 13.3)')",
      "detail": "Instantiate one `const adapter = new CodexAdapter();`. Tests: (a) fresh launch — spec.shellPath === AGENT_BINARY.codex (i.e. 'codex'), shellArgs[0] === '--model', args do not include 'resume', '--last', '-c', '--continue', '--session-id', 'exec', nor the dropped 'session-xyz' value (pins degrade 1 and the interactive-not-exec choice). (b) resume with a prior id — `req({resume:true, resumeSessionId:'prior-session'})` gives shellArgs.slice(0,2) deepStrictEqual ['resume','prior-session'], and args do not include '--last' or '-c'. (c) resume with no prior id — `resumeSessionId: undefined` gives shellArgs.slice(0,2) deepStrictEqual ['resume','--last']; assert exactly one 'resume' occurrence. (d) empty-string resumeSessionId behaves as no prior id (same ['resume','--last']), pinning the `.length > 0` guard. (e) fresh/resume tails identical: fresh.shellArgs deepStrictEqual resumeWithId.shellArgs.slice(2). (f) prompt placement — on fresh and on resume-with-id, the last two args are ['--', req.prompt] (defensive separator, mirroring the claude adapter). (g) the `resume --last` prompt-drop degrade — assert the args do NOT include '--' and do NOT include the prompt text, and add a comment explaining why (a trailing positional there binds to SESSION_ID, not PROMPT). (h) model/effort: with `effort:'high'`, findPair(args,'--model','sonnet') >= 0 and args include '--config' immediately followed by `${CODEX_EFFORT_CONFIG_KEY}=high` (use findPair(args,'--config','model_reasoning_effort=high') >= 0); with effort undefined and with effort '', args do not include '--config' at all.",
      "files": [
        "test/adapter.codex.test.ts",
        "src/adapter/codex.ts"
      ]
    },
    {
      "title": "describe('CodexAdapter attach() (Req 3.3, 3.4)')",
      "detail": "Mirror the antigravity attach block. (1) Exact-shape test: `adapter.attach({role:'executor', runId:'run-9', sessionId:'session-42'})` deepStrictEqual shellArgs ['resume','session-42','--sandbox',CODEX_WORKSPACE_WRITE_SANDBOX,'--ask-for-approval',CODEX_ASK_FOR_APPROVAL,'--add-dir','.baiton/runs/run-9/'], shellPath === AGENT_BINARY.codex, shellArgs.length === 8, and assert absence of '--', the prompt text, '--model', '--config', '--last' and '-c' (no prompt, no model on a reopen). (2) Read-only role test: `attach({role:'planner', runId:'run-1', sessionId:'session-1'})` has findPair(args,'--sandbox',CODEX_READ_ONLY_SANDBOX) >= 0 and findPair(args,'--add-dir','.baiton/runs/run-1/') >= 0.",
      "files": [
        "test/adapter.codex.test.ts",
        "src/adapter/codex.ts"
      ]
    },
    {
      "title": "describe('CodexAdapter role -> sandbox/approval permission mapping (Req 15.1-15.4)')",
      "detail": "(1) Pin the constants: CODEX_READ_ONLY_SANDBOX === 'read-only', CODEX_WORKSPACE_WRITE_SANDBOX === 'workspace-write', CODEX_ASK_FOR_APPROVAL === 'on-request', CODEX_EFFORT_CONFIG_KEY === 'model_reasoning_effort'; add notStrictEqual guards that the sandbox values are neither 'danger-full-access' nor claude's 'acceptEdits'/agy's 'accept-edits', the copy-paste defects this file exists to catch. (2) Loop `for (const role of ROLES)` asserting, for both launch(req({role})) and attach({role, runId:'run-1', sessionId:'s-1'}): findPair(args,'--sandbox', isReadOnlyRole(role) ? CODEX_READ_ONLY_SANDBOX : CODEX_WORKSPACE_WRITE_SANDBOX) >= 0, exactly one '--sandbox' occurrence, findPair(args,'--ask-for-approval', CODEX_ASK_FOR_APPROVAL) >= 0 for every role (codex differs from claude/agy in that the approval flag is role-independent), and exactly one '--ask-for-approval'. (3) Helper-level tests: codexPermissionFlags('planner') deepStrictEqual ['--sandbox','read-only','--ask-for-approval','on-request']; codexPermissionFlags('executor') deepStrictEqual ['--sandbox','workspace-write','--ask-for-approval','on-request']; codexEffortFlags('medium') deepStrictEqual ['--config','model_reasoning_effort=medium']; codexEffortFlags(undefined) and codexEffortFlags('') both deepStrictEqual []. (4) Run-dir grant + forbidden-flag loop over ROLES for launch and attach: findPair(args,'--add-dir','.baiton/runs/run-777/') >= 0, and none of ['--dangerously-bypass-approvals-and-sandbox','--dangerously-bypass-hook-trust','--approve-for-me','--permission-mode','--allowedTools','--mode','--agent','--auto','--dangerously-skip-permissions','--prompt-interactive','--variant','--effort'] appear, plus assert the args contain neither the value 'danger-full-access' nor 'never' (the forbidden --sandbox/--ask-for-approval values, which are values rather than flags so must be checked with includes on the whole array).",
      "files": [
        "test/adapter.codex.test.ts",
        "src/adapter/codex.ts",
        "src/adapter/permissions.ts"
      ]
    },
    {
      "title": "Verify: compile, lint, and run the new test file",
      "detail": "Run `npx mocha test/adapter.codex.test.ts` (ts-node/register comes from .mocharc.json), then `npm run lint` and `npm run compile` to confirm no type or lint breakage. If a test fails, fix the TEST to match src/adapter/codex.ts's actual behavior — T11 is a test-only todo and must not modify the adapter; if a failure looks like a genuine adapter defect rather than a test-expectation mismatch, record it for T12 rather than changing src here. Do not run the full suite as part of this todo (that is T12).",
      "files": [
        "test/adapter.codex.test.ts"
      ]
    }
  ],
  "risks": [
    "The probe tests must not assume a `codex` binary is installed. Test 2 of the probe block is written to accept either outcome; only the empty-PATH test asserts a concrete failure result. Mutating process.env.PATH must always be restored in a finally block or it will leak into every later test in the mocha process.",
    "Emptying PATH may not make execFile fail on every platform/Node version if the adapter ever resolved an absolute path; here CODEX_BIN is the bare name 'codex', so ENOENT is expected, but the assertion is deliberately on `ok === false` + non-empty reason rather than on the specific ENOENT wording.",
    "Copy-paste drift from adapter.antigravity.test.ts is the main hazard: agy uses `--mode`/`--effort`/`--prompt-interactive` and a bare (no-subcommand) fresh launch, while codex uses `--sandbox`/`--ask-for-approval`/`--config`/`-- <prompt>` and a `resume` subcommand. Every flag name and the argv-position assertions must be re-derived from src/adapter/codex.ts, not copied.",
    "The adapter emits the long `--config` form while the spec text described `-c key=value`. The test must pin what the code does (`--config`); if the executor writes `-c` from the spec text the test will fail spuriously. Note this discrepancy in a comment rather than changing the adapter.",
    "Exact deepStrictEqual argv assertions (attach, and the ['resume','--last'] prefix) are intentionally brittle so that flag-order regressions surface, but they will need updating if the adapter later adds a flag; keep those exact-shape assertions confined to attach() and to slice-based prefixes on launch.",
    "The `resume --last` prompt-drop is a behavior that looks like a bug at a glance; without the explanatory comment a future reader may 'fix' the adapter and break the test. The comment is part of the deliverable.",
    "isReadOnlyRole/ROLES are imported rather than hard-coding the role list, so the mapping loop stays correct if a role is added; do not inline a literal role array."
  ],
  "acceptance": [
    "test/adapter.codex.test.ts exists and is picked up by the existing .mocharc.json glob with no config change.",
    "`npx mocha test/adapter.codex.test.ts` passes with every test green, both with and without a `codex` binary on PATH.",
    "`npm run compile` (tsc -p ./) and `npm run lint` (eslint src test) both pass with no new errors.",
    "The file covers all four areas named in T11: probe success/failure shape, fresh vs `codex resume <id>` vs `codex resume --last` launch args, attach()'s no-prompt reopen, and the `--config model_reasoning_effort=<effort>` override mapping (present when effort is set, absent when undefined or '').",
    "The per-role `--sandbox read-only|workspace-write` mapping and the `--ask-for-approval on-request` flag are asserted for every role in ROLES on both launch and attach, and the per-run `--add-dir .baiton/runs/<run-id>/` grant is asserted present.",
    "Forbidden escape hatches (--dangerously-bypass-approvals-and-sandbox, --dangerously-bypass-hook-trust, --approve-for-me, and the values danger-full-access / never) are asserted absent from every emitted arg list.",
    "The three codex-specific degrades are each pinned by an assertion with an explanatory comment: req.sessionId dropped on a fresh launch, the prompt dropped on the `resume --last` branch, and the interactive form used rather than the `exec` subcommand.",
    "No file under src/ is modified by this todo."
  ]
}
```
