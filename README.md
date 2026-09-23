# Baiton

Spec-driven development with heterogeneous coding CLI agents. Baiton is an
open-source VS Code extension: a chat orchestrator authors and drives spec
files, and the editor renders those specs and their todos.

## The Baiton views

Baiton contributes two view containers, one on each side of the window:

- the **activity bar** container (the `$(rocket)` icon, titled **Baiton**),
  holding the **Spec Explorer**;
- the **secondary side bar** container (the `$(comment-discussion)` icon,
  titled **Baiton Chat**), holding the **Chat** view. If the secondary side bar
  is hidden, run **View: Toggle Secondary Side Bar** to reveal it.

Specs therefore sit on one side of the editor and the chat on the other, with
no manual dragging. If you dragged the Chat view somewhere yourself in an
earlier version, VS Code remembers that placement and keeps it; run
**View: Reset View Locations** once to put both views back where Baiton
contributes them.

The two views:

- **Spec Explorer** — a tree listing each `.baiton/specs/<slug>/spec.md` in the
  repository. Every spec shows its slug, its frontmatter `status` (or an
  unset-status indication), and an approved marker when it has been approved.
  Under a valid spec you get one node per todo with its id, title, state and a
  blocked marker; under an invalid spec you get one node per validation error
  with its reason and 1-based line number. Each todo node carries inline
  actions for whichever of **Plan**, **Execute**, **Review**, **Re-plan** and
  **Stop** are legal for its current state, plus **View** when the todo is
  running or has a recorded sub-agent session and **View plan** once it has
  been planned; the CodeLens over the todo in `spec.md` shows the same
  state-gated set. **View** reveals the running stage's terminal, or, once it
  has finished, opens a new terminal resuming its sub-agent session. **View
  plan** opens the todo's plan (`.baiton/specs/<slug>/todos/<id>/plan.md`),
  which you can edit before running Execute — the executor is briefed from the
  file as it stands at launch. **Stop** cancels a running stage or, on a todo that
  is not running, reverts it from `planning`, `executing` or `reviewing` back
  to the state its current stage started from. Each spec root carries an
  **Approve** action. These actions are hidden while the workspace is in
  Restricted Mode. The tree refreshes automatically when files under
  `.baiton/specs/**` change.

- **Chat** — a webview hosting the orchestrator conversations: one Workspace
  conversation for creating new specs, plus one conversation per spec. Selecting
  a spec in the Spec Explorer (or opening its `spec.md`) switches the chat to
  that spec's conversation. Each tool the orchestrator calls appears as a
  collapsed one-line row — the tool name, its first argument and a status dot —
  that you can expand to see the arguments and the result.

### What the orchestrator does

The orchestrator has exactly two jobs:

1. **Create a spec** — ask you clarifying questions until you agree on what the
   work is, then hand the agreed requirements to the spec writer with
   `draft_spec`.
2. **Drive an approved spec** — dispatch each stage with `run` until every todo
   is done, then `submit_pr`.

It writes no specs, no plans and no code, and it reviews nothing: the agent
configured for each role does that work when the orchestrator dispatches it.
When a tool refuses, the orchestrator quotes the refusal to you and stops
rather than diagnosing it or trying another route.

Its tools follow the job it is doing, so it can only act within it:

| tools | creating a spec | driving a spec |
|---|---|---|
| `list_specs`, `read_spec`, `git_status` | yes | yes |
| `ask_user` | yes | yes |
| `list_files`, `read_file`, `search`, `git_diff`, `git_log` | yes | no |
| `update_overview`, `add_todo`, `edit_todo`, `remove_todo` | yes | yes |
| `draft_spec` | yes | no |
| `approve_spec` | yes | yes (re-approve) |
| `run`, `submit_pr` | no | yes |

`ask_user` joins `list_specs`, `read_spec` and `git_status` as a tool that is
available in both phases. Where a point needs your answer, the orchestrator
calls `ask_user(question, options?, allow_free_text?, placeholder?)` instead of
ending its turn with a question: the question appears as an inline card in the
conversation and the call blocks until you answer it, so your answer comes back
as the tool result and the turn continues. `options` are for a short closed set
(at most the tool's `MAX_ASK_USER_OPTIONS` cap of **8** options, each with an
`id` and a `label`), `allow_free_text` additionally accepts a typed reply, and
a question with no options is always answered by typing. Like those other
always-available tools it is non-mutating and not a dispatch, so it stays
usable under Restricted Mode. Declining the card refuses the call, which the
orchestrator quotes to you and stops on, exactly like any other refusal — the
instruction that tells the model this is what it receives in its system prompt
(`ASK_USER_TEXT` in `src/orchestrator/systemPrompt.ts`). See
**Interventions in chat** below for the cards themselves.

A spec conversation counts as "creating" while its frontmatter `status` is
`draft`, and as "driving" from `approved` onwards. There is no tool for reading
a stage's artifacts: the plan and the review write-ups are for you, through
**View plan** and the todo's folder under `.baiton/specs/<slug>/todos/<id>/`,
not for the orchestrator to second-guess.

### Chat sessions

The top of the Chat view lists the saved chat sessions of the selected
conversation, newest first, each showing its title (taken from your first
message) and when it was last used. Click a session to reopen it; the session
you were last in is restored on the next window reload.

- **New Chat** starts a fresh session in the selected conversation. A session
  that has no messages yet is reused rather than duplicated, and nothing is
  written to disk until you send the first message.
- The **✕** button on a row deletes that session after a confirmation; its
  transcript cannot be recovered. Both actions are disabled while a run is in
  flight, and switching or deleting the running session is refused until it
  finishes.

Transcripts are stored per session, one append-only JSONL file each:

- `.baiton/chat/<id>.jsonl` — Workspace conversation sessions.
- `.baiton/specs/<slug>/chat/<id>.jsonl` — a spec conversation's sessions.

There is no index file: each session's title and timestamps are derived from
its transcript. A transcript from before sessions existed (`.baiton/chat.jsonl`
or `.baiton/specs/<slug>/chat.jsonl`) is migrated into the new layout as one
session the first time the view opens that conversation, and an empty one is
removed. All of these paths are covered by `.baiton/.gitignore`.

### Interventions in chat

Every point where a human is needed appears as one interactive card inline in
the conversation and is answered in place — no modal dialog. There are three
kinds:

- **question** — the orchestrator asking you something, through its `ask_user`
  tool (see **What the orchestrator does** above);
- **confirm** — a confirmation, such as the one `draft_spec` and `approve_spec`
  raise before they act;
- **permission** — a sub-agent harness ask relayed out of a running stage,
  carrying the agent id, the tool name and the tool arguments.

The controls depend on the kind. An option question renders one button per
offered choice (each option carries a stable `id` and a visible `label`, with
an optional `detail` line); a free-text question renders a single-line text
input plus a **Send** button (Enter submits; the answer box holds one line, so
there is no Shift+Enter newline there). Confirms and permission asks render
**Approve** and **Decline**.

Once answered the card stays in place showing the decision line, an **Auto**
badge when Auto mode decided it rather than you, and the one-line rationale —
for an escalated ask, the one plain sentence saying what you approved.

A card lands on the conversation the ask belongs to. A relayed harness ask is
routed to the spec conversation of the run it came from, switching the view
there if needed (`ChatController.scopeForAsk`), so you answer it in the context
the run was launched from.

Cards are persisted: each is appended to the session transcript JSONL as a
`system` record carrying an `intervention` field (`interventionTranscriptRecord`
in `src/orchestrator/chatTranscript.ts`), so a settled card is an inline record
of the decision that survives switching conversations, reloading the window and
re-rendering. An escalated ask is written twice — once pending, once settled —
and the two records are projected back as the one card in its original
position.

**Stop** aborts the in-flight run *and* declines every ask still waiting for an
answer (`ChatController.onStop` → `declinePendingAsks` /
`PendingAskRegistry.rejectAll`), so a flow paused on a card always gets control
back instead of hanging. A declined `ask_user` comes back to the model as a
refusal; a declined permission ask is written back to the run as a denial.

### Creating a spec

The orchestrator gathers the requirements; a configured coding agent writes the
spec.

1. Describe the work in the Workspace conversation. The orchestrator reads the
   repository and asks clarifying questions, one at a time.
2. It writes a short **requirements document** — the goal, the constraints, the
   acceptance criteria and the files of interest — and revises it until you
   agree to it. It never proposes the todo list itself.
3. Once you agree it calls `draft_spec`, which raises a **confirm** card inline
   in the conversation to confirm the requirements — an in-place answer, not a
   modal dialog; declining it leaves the repository untouched — and then
   launches the **spec writer**: the agent configured for the `spec-writer`
   role in `.baiton/config.json`. That agent studies the repository read-only
   and returns an OVERVIEW plus a dependency-ordered todo list; the extension
   assigns the `T##` ids, renders `.baiton/specs/<slug>/spec.md`, and commits it.
4. Watch the draft in its terminal while it runs. When it finishes, a note lands
   in the Workspace conversation and the new spec appears in the Spec Explorer
   and in the conversation selector.

Only one stage runs per repository, so a spec draft and a todo stage never run
at the same time. A `spec-writer` entry missing from an existing
`.baiton/config.json` is filled in from the `planner` entry. After the draft
lands you can refine it in chat with `update_overview`, `add_todo`, `edit_todo`
and `remove_todo`.

### Driving a spec

Once a spec is approved, its chat conversation drives it one todo at a time.
The orchestrator dispatches the next legal stage for the todo's current state —
`pending` → `plan`, `planned` → `execute`, `executed` → `review`, and `execute`
again when a review sends the todo back — and each `run` blocks until that
stage reaches a terminal outcome, so there is nothing to poll. `plan-review` is
not a stage it can trigger: it runs inside the plan stage's own review rounds.
When every todo is `done`, the orchestrator offers `submit_pr`. You can still
run any stage yourself from the Spec Explorer.

### Auto mode

Auto mode lets the host answer the routine asks on your behalf, under a
two-stage gate, while everything it decided is written into the conversation as
an audit trace you can read. Its default is off.

- **The toggle** — a button in the composer's control row immediately left of
  **Stop**, labelled **Auto: Off** / **Auto: On** (`media/chat.js`
  `renderAutoMode`, with its state driven by `aria-pressed`). It stays enabled
  while a pipeline is running, so it can be flipped mid-run — an ask normally
  arrives while a run is in flight. The host is authoritative: the click posts
  `setAutoMode` and the button repaints only when the host echoes it back. The
  state is remembered per workspace in VS Code's `workspaceState` under the key
  `baiton.chat.autoMode` (`src/activation/commands.ts`, `autoModeMemory`), so a
  window reload comes back in the mode you left it in; it is not a
  `settings.json` setting.
- **What is gated** — only harness **permission** asks that arrive *while the
  toggle is on* (`ChatController.autoDecision` returns nothing unless Auto mode
  is on, a gate is wired and `ask.kind === 'permission'`). Confirmations and
  questions are never auto-answered: they carry human intent, not a harness
  capability.
- **Stage (a), the deterministic allow-list** — a pure per-agent allow-list
  (`agentAllowList(agent, role, runId)` in `src/adapter/index.ts`, derived from
  claude's `--allowedTools` sets, opencode's agent permission rules and the
  role profile's shell/write bits) decides without any model round-trip. It is
  deliberately narrow for writes: a write auto-approves only when every
  target path is repo-relative and matches one of the rule's globs: an
  absolute path, a `file://` URL, any `..` segment, unparseable `args` or an
  undeterminable target all escalate. Shell is decided on the command itself,
  before any role rule:
  - A recognised **read-only** command — or a `|` pipeline made only of them —
    is equivalent to a read or search and auto-approves for **every role and
    every agent**; role remit is not a criterion here, because the harness
    enforces the role floor outside Auto mode. `READ_ONLY_SHELL_PREFIXES` in
    `src/orchestrator/autoMode.ts` is verbatim: ls, cat, head, tail, wc, pwd,
    which, rg, grep, find, sed -n, awk, sort, uniq, cut, tr, diff, stat, file,
    tree, du, df, jq, echo, printf, basename, dirname, realpath, git status,
    git diff, git log, git show, git branch, git grep, git blame, git
    ls-files, git rev-parse, git remote -v, git stash list, node --version,
    python --version, python3 --version, npm ls, npm --version, npx tsc
    --noEmit. Known mutating flags are rejected even on these (`sed -i` or any
    `sed` script that is not a plain print, `find -delete`/`-exec`/`-ok`,
    `sort -o`, `uniq` with an output file, `tree -o`, `rg --pre`, `git grep
    -O`, git `--output`, `git branch` creating/deleting/renaming a branch,
    `awk` with `system`/redirects).
  - A recognised **verification** command (`VERIFICATION_SHELL_PREFIXES`: npm
    test, npm run lint, npm run compile, npm run build, npx tsc) runs project
    code, so it clears the gate only for a role whose profile grants shell
    (executor, reviewer); for other roles it goes to stage (b).
  - Chaining and substitution (`;`, `&`, `&&`, `||`, backtick, `$(`, `>`,
    `<`, parentheses, newline, an unterminated quote) and anything not on
    the lists go to stage (b) however the command starts. Quotes are
    honoured, so `grep -E "a|b"` is one command, not a pipe.

  Tool names are normalised through `TOOL_FAMILIES` onto read, search, write
  and shell (including agy's `run_command`, `view_file`, `list_dir`, … its
  `CommandLine` argument, and its `AbsolutePath` / `TargetFile` path keys); an unmapped tool (`webfetch`, `websearch`, `task`,
  `agent`, anything new) escalates, so a missing name costs a round-trip and
  never an unsafe approval. A relayed ask
  is keyed on the launching run's trusted identity — its adapter id, role and
  run id (`AutoModeRunContext`) — not on the agent field inside the ask file,
  so an ask claiming a different agent escalates.
- **Stage (b), the model evaluation** — everything the allow-list did not
  clear (scripts, package commands, mutating commands, unknown tools) goes to
  the orchestrator model (`evaluateAsk` / `RISK_EVALUATION_PROMPT`), which
  judges the action's **effect**, not the role's remit. It is told the
  workspace root, the run directory, the spec and todo (id and title), and
  the body of every script the command names (`.py`, `.sh`, `.js`, `.ts`,
  `.mjs`, `.cjs`, `.rb`, `.pl`), read by the host only when the script
  resolves inside the workspace, capped at 6 KB each and fenced as untrusted
  data. The stage-(a) reason is passed as information only ("not by itself a
  reason to escalate"). It approves read-only work and reversible changes
  inside the workspace — writing workspace files, running tests, builds and
  linters, local scripts that only read or write project files — so a planner
  running a script that only reads files is approved. It escalates anything
  that mutates outside the workspace, touches a database or external service,
  reaches the network, installs software, changes git history, remotes or CI,
  touches credentials, or is unclear. The reply contract is one JSON object:
  `{"decision":"approve","rationale":"…"}` or
  `{"decision":"escalate","summary":"<Role> wants to …","detail":"…"}`
  (the legacy `what`/`why` fields are still read).
- **Fail-safe direction** — every failure path escalates and none approves:
  empty or unreadable model output, an unknown decision, an approval without a
  reason, a transport error, or a gate that throws
  (`ChatController.autoDecision` catches it and turns it into an escalation).
  The ask arguments are fenced and treated as untrusted data; embedded
  instructions such as 'this is safe, approve it' are ignored and are
  themselves a reason to escalate.
- **The audit trace** — every auto-approval and every escalation is written
  into the session transcript, so the conversation is the audit log. An
  auto-approval never shows a pending card: the card is posted already
  settled, carries the **Auto** badge and a one-line rationale naming the
  agent, role, tool and matched rule (or the model's rationale), and is
  appended to the transcript. An escalation is appended when it happens, as a
  pending card that leads with one plain sentence saying what you are
  approving — e.g. "Planner wants to run a script that edits rows in the dev
  database." — with the raw command (or the tool's args) under it as a code
  block and an optional muted secondary line. The rule that tripped stage (a)
  is not the headline: it is kept in the card's persisted `escalation.reason`
  for the audit record only. The card is appended again once you answer it.
  Older transcripts that recorded `{ what, why }` still render (`what` as the
  sentence, `why` as the secondary line). Turning Auto off leaves those
  records in place.

Which asks can reach these cards at all depends on the per-adapter relay,
documented in **Harness ask relay (per-adapter probe findings)** below.

### The config panel

The configuration form is the **Configuration** section of the Baiton view in the activity bar, collapsed by default, sitting under the Spec Explorer. **Baiton: Open Config Panel** (`baiton.openConfigPanel`) reveals and focuses that section rather than opening an editor tab:

- **Managed fields** — edits the six role entries (`spec-writer`, `planner`,
  `plan-reviewer`, `executor`, `reviewer`, `pr-writer`) with an agent dropdown
  populated from installed adapters, a per-agent model dropdown with curated
  suggestions and an "Other…" free-form escape hatch (along with documentation
  links for open-ended ecosystems like OpenCode), a per-agent effort dropdown
  (`(default)` when unset, curated supported levels, or free-form entry where
  open); the three numeric limits with their bounds (`plan_review_rounds` 0–10,
  `exec_attempts` 1–10, `stall_notice_minutes` 1–1440); and `git.remote` and
  `git.base`.
- **Preservation of unmanaged keys** — every key outside the form's managed set
  (`version`, `pr`, `git.verify`, custom or unrecognized keys, and out-of-set
  agent, model, or effort values) is preserved on save. Written JSON is formatted
  with two-space indentation and a trailing newline.
- **Inline and host-side validation** — fields validate as you type with inline
  error indicators, and the host re-validates the submitted form before writing,
  guaranteeing the webview cannot write a configuration that the extension
  loader would reject. Effort validates against each agent's closed set of supported
  levels when applicable; models remain open and advisory with full support for
  custom variants via "Other…".
- **The reset path** — the Configuration view and **Baiton: Open Config Panel** are registered before the
  extension's configuration-loading gate, so the view works even when
  `.baiton/config.json` is absent or unparseable. In that state the view
  displays the error and offers **Reset to defaults**, which confirms with a
  modal prompt and writes the default configuration, discarding any unparseable
  contents.
- **External changes and conflict handling** — the panel watches
  `.baiton/config.json` while open. If the file changes on disk, a pristine form
  reloads automatically; a form with unsaved edits displays a conflict banner
  offering to reload and discard edits or keep editing. Saving against a file
  modified since it was loaded is refused with conflict options to reload or
  overwrite.
- **Live configuration hot-reload** — saving applies the updated configuration
  to the running extension in place without requiring a window reload. Any
  factor that cannot take effect immediately is reported in the save outcome:
  stages already running keep the model, effort, and agent they launched with
  (new settings apply to the next run), missing agent CLI binaries are flagged,
  and saving in a window opened for a different folder than the activated
  workspace folder writes the file without updating the running session.

#### Agent Model & Effort Discovery (CLI Probing & Architecture)

Baiton uses curated static capability catalogues in each adapter module rather than invoking agent CLI processes on the fly when opening the configuration panel:

- **CLI capabilities investigation**:
  - `claude` (Anthropic Claude Code): Does not provide a `models` subcommand; non-flag arguments launch an interactive prompt session. System health and auth can be probed via `claude doctor`. Supported effort levels (`low`, `medium`, `high`) are passed via `--effort`.
  - `antigravity` (`agy`): Provides a dedicated `agy models` subcommand that queries available Gemini and Claude models from the API. Supports `--effort (low|medium|high)`.
  - `codex` (OpenAI Codex CLI): Does not provide a `models` subcommand; positional arguments launch interactive sessions. System status is available via `codex doctor`. Reasoning effort is passed via `--config model_reasoning_effort=<effort>`.
  - `opencode`: Provides a dedicated `opencode models` command listing provider-prefixed model identifiers (e.g. `anthropic/claude-3-7-sonnet`, `openai/o3-mini`). Due to its pluggable multi-provider nature, any provider/model string is accepted, and effort is open-ended.
- **Why static capability catalogues**:
  - *Zero latency*: The config panel renders instantly without spawning subprocesses or waiting on network API round-trips.
  - *Offline and air-gapped reliability*: The configuration panel is fully operable when disconnected from the network or prior to agent CLI authentication.
  - *Host-free purity*: Keeps the config panel core completely free of Node `child_process` dependencies, preserving unit testability and browser-mirror parity.
  - *Robust fallback*: The "Other…" input option guarantees users are never blocked from specifying newly-released models or custom deployments.
- **Roadmap for dynamic discovery**:
  - Future iterations may introduce background caching or an asynchronous "Refresh models from CLI" button for CLIs that support dynamic querying (`agy models`, `opencode models`), caching results in workspace storage while retaining static defaults as resilient fallbacks.

### Harness ask relay (per-adapter probe findings)

A launched run's `.baiton/runs/<run-id>/asks/<ask-id>.json` is a harness ask and `<ask-id>.response.json` is the answer written back into it; the run stays paused until the answer file appears. These asks are what become **permission** intervention cards in the run's spec conversation (see **Interventions in chat**), answered in place in the chat, with Auto mode applied to them when it is on; the run stays paused until the response file appears, and **Stop** — or a run that ends — declines any ask still pending, so nothing hangs.

- **claude findings** (probed `claude --version 2.1.278`):
  - `--settings` accepts an inline JSON string as well as a file path (`<file-or-json>` in `claude --help`), and a `-p` run started with an inline hooks JSON launched cleanly and installed the hook — verified by the probe.
  - `PreToolUse` command hooks fire for every tool call with the exact stdin event `{session_id, transcript_path, cwd, prompt_id, permission_mode, effort, hook_event_name, tool_name, tool_input, tool_use_id}` — the fields Baiton's hook reads (`hook_event_name`, `tool_name`, `tool_input`) are taken verbatim from this probe.
  - The hook's stdout contract is `hookSpecificOutput.permissionDecision ∈ allow|deny|ask` plus `permissionDecisionReason`: `deny` blocked the tool call with the probe's reason string, `allow` let it run, and `ask` (non-interactive `-p`) blocked it the same way `deny` did — all verified by the probe; the `ask` lever only falls back to the interactive prompt in sessions with a terminal.
  - A `timeout` field is accepted on the hook entry and is enforced by the CLI (a 1 s timeout clipped a 2 s hook); the probed CLI did not surface a distinct "timed out" decision to the hook, so Baiton's hook does not rely on the CLI-side timeout — it runs with its own 600 s deadline and degrades **deliberately** to `permissionDecision: "ask"` (never a silent `allow`) on expiry or on any parse/write failure.
  - The `timeout` *field itself* beyond "no rejection" and the above clipping were **not independently re-verified at the 600 s scale**; anything the probe could not confirm is marked **unverified** rather than asserted.
- **opencode findings** (probed `opencode --version` → `1.18.30`, 2026-09-20):
  - Neither `opencode --help` nor `opencode run --help` documents any permission-hook, callback or delegation flag. The only permission-related flag is `--auto` ("auto-approve permissions that are not explicitly denied (dangerous!)"), which Baiton never emits. There is no `--settings`-style inline-hook equivalent, so the whole probe moved to the config layer the adapter already uses (`OPENCODE_CONFIG_CONTENT`).
  - The inline config accepts a top-level `permission` table: a run launched with `{"permission":{"bash":"allow"}}` executed `echo baiton-probe-allow` and printed its output. With `{"permission":{"bash":"ask"}}` the same run printed `! permission requested: bash (echo baiton-probe-ask); auto-rejecting` and the model was told `The user rejected permission to use this specific tool call.` — **`ask` is therefore not a relay in non-interactive `opencode run`; it is a deny with extra steps.**
  - The inline config also accepts a top-level `plugin` array, and a plugin registered there as an absolute `file://` URL really loads: the probe plugin logged its loader argument keys (`client, project, worktree, directory, experimental_workspace, serverUrl, $`) and its `tool.execute.before` hook fired with `{"tool":"bash","sessionID":"ses_…","callID":"call_…"}` and `{"args":{"command":"echo hi"}}` — the tool name and the arguments are both present.
  - The hook's decision really changes the outcome: a plugin whose `tool.execute.before` throws turned the same run into `✗ echo hi failed` / `Error: baiton probe denied this tool call`, and the model acknowledged the denial instead of running the command. Registering the identical plugin as `.opencode/plugin/baiton-probe.js` in the run's cwd behaved the same way (hook fired with the same payload).
  - **This surface is nevertheless not installable from `launch()`.** opencode loads a plugin only from a file: a `file://` path or npm module named in `plugin`, or a file under `.opencode/plugin/`. A `data:text/javascript;base64,…` entry carrying the source inline was silently ignored — no load, no error, and the tool call ran normally. A working opencode relay would therefore require Baiton to **write a plugin file to disk**, which conflicts with `OpencodeAdapter.launch()` being a pure function that writes nothing (and the launcher is outside this change). So no wiring is emitted and `LaunchRequest.relay` is deliberately ignored; the generic fallback covers opencode's asks.
  - **Unverified:** whether a plugin can instead answer opencode's own `permission.asked` event through the `client` handed to it (the binary does carry `permission.asked`/`permission.replied` event names and a `session.permission.reply` endpoint). Three runs combining `permission: "ask"` with a plugin stalled before producing any output — the plugin loaded each time, but no permission event was ever observed — so this leg is recorded as **unverified**, not as a result. It would in any case need the same on-disk plugin file, so it does not change the outcome above.
  - **Unverified:** whether a plugin file shipped *inside the installed extension* (static, never written at launch time) and parameterised through environment variables would be an acceptable future relay. The probe shows the mechanism would work; the plumbing (an extension path reaching the adapter) does not exist today.
- **codex findings** (probed `codex --version` → `codex-cli 0.154.0`, 2026-09-20, and re-probed → **`codex-cli 0.155.1`, 2026-09-22**; the 0.155.1 legs come first and supersede the two 0.154.0 "decisive"/"silent allow" legs further down, which ran under `codex exec` only). All 0.155.1 legs used a scratch directory `<scratch>` for hook scripts, logs and marker files; interactive legs ran under a `python3` `pty.fork` driver (`timeout 130 python3 ptydrive.py 110 <raw> codex …`, no keystrokes sent) with the cwd at this repository, a project the developer had already trusted in codex. Nothing was written to `~/.codex` by the probe (codex itself records its usual session rollouts there). `<hook>` below is `bash <scratch>/hookm.sh <log> <mode>`, which logs its stdin and prints a canned reply.
  - **0.155.1 — the `PermissionRequest` hook contract.** The binary's embedded JSON schema defines a `PermissionRequest` hook whose stdout contract is `{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"|"deny","message":"…"}}}`. `interrupt`, `updatedInput` and `updatedPermissions` are reserved and make the hook fail closed if present (strings "hook returned invalid permission-request JSON output", "PermissionRequest hook exited with code 2 but did not write a denial reason to stderr"); Baiton never emits them.
  - **0.155.1 leg B — headless regression (`PreToolUse`).** `codex exec --skip-git-repo-check --dangerously-bypass-hook-trust --sandbox workspace-write -c 'hooks.PreToolUse=[{matcher="*",hooks=[{type="command",command="<hook>",timeout=60}]}]' -C <scratch>/ws '<prompt>' < /dev/null` → the hook fired with stdin `{"session_id","turn_id","transcript_path","cwd","hook_event_name":"PreToolUse","model","permission_mode":"bypassPermissions","tool_name":"Bash","tool_input":{"command":…}}`. `codex exec` reads the prompt from stdin when stdin is open (hence `< /dev/null`), rejects `--ask-for-approval`, and ignores `-c approval_policy="on-request"` ("this session's approval policy prevents requesting execution outside the sandbox"), so `PermissionRequest` cannot be probed headless.
  - **0.155.1 leg D-allow — interactive, decisive.** `codex --dangerously-bypass-hook-trust --sandbox read-only --ask-for-approval on-request -c 'hooks.PermissionRequest=[{matcher="*",hooks=[{type="command",command="<hook allow>",timeout=60}]}]' -c '<PreToolUse hook>' '<prompt: touch <scratch>/ws/marker-allow, requesting approval>'` → the `PermissionRequest` hook fired with stdin `{…,"hook_event_name":"PermissionRequest","permission_mode":"default","tool_name":"Bash","tool_input":{"command":"touch …/marker-allow","description":"Allow creating the requested empty marker file outside the read-only sandbox?"}}`, answered `behavior:"allow"`, and the marker WAS created with no keystroke: the hook replaced codex's approval prompt.
  - **0.155.1 leg D-deny.** Identical with `behavior:"deny","message":"baiton probe denied this"` → the marker was NOT created and the TUI showed "baiton probe denied this. The file was not…", so the model saw the reason.
  - **0.155.1 — project trust also gates hooks.** From an untrusted cwd (the scratch directory) codex showed its "trust this folder" dialog, whose text says trusting "allows hooks", and no hook fired; an inline `-c 'projects."<dir>".trust_level="trusted"'` did NOT bypass it. The dialog was never answered. Baiton launches in the user's workspace, so **the relay needs that workspace to be trusted in codex** (normally done the first time the user ran codex there); in an untrusted workspace the asks stay in codex's terminal.
  - **0.155.1 leg 1a — every hook failure falls back to codex's own prompt.** `codex --dangerously-bypass-hook-trust --sandbox read-only --ask-for-approval on-request -c 'hooks.PermissionRequest=[{matcher="*",hooks=[{type="command",command="<hook mode>",timeout=<t>}]}]' '<prompt: touch <scratch>/ws/marker-a-<mode>, requesting escalation>'`, one run per mode: hook prints `{"hookSpecificOutput":{"hookEventName":"PermissionRequest"}}` (no decision, `timeout=60`); hook exits 0 with empty stdout (`timeout=60`); hook exits 1 (`timeout=60`, screen: "Hook failed └ hook exited with code 1"); hook sleeps 30 s (`timeout=5`, screen: "Hook failed └ hook timed out after 5s"). In all four the hook fired, the screen then showed codex's own "Would you like to run the following command? › 1. Yes, proceed (y)" prompt, and no marker was created within the 110 s window. Baiton's hook script therefore degrades by printing the event name with no decision, which lands on codex's prompt — never an allow, and unlike agy never a forced deny.
  - **0.155.1 leg 1b — a long wait is honoured.** Same form, `timeout=600`, hook sleeping 70 s and then answering `allow` → the hook logged its wake-up 70 s after firing and `touch <scratch>/ws/marker-b-70` ran. The 600 s scale itself was not exercised.
  - **0.155.1 leg 1c — which tools raise `PermissionRequest`.** Same form, a prompt asking for a file outside the sandbox via the edit tool (hook `allow`): the hook saw `tool_name:"apply_patch"`, `tool_input:{"command":"*** Begin Patch\n*** Add File: <scratch>/ws/patched.txt\n+hello baiton\n*** End Patch"}` (no `description`; the target path only inside the patch text), and the file was written. A prompt asking to fetch `https://example.com` (hook `deny`): the model asked through `Bash` (`tool_input:{"command":"curl -fsSL https://example.com","description":"May I fetch https://example.com outside the sandbox to read its page title?"}`), and the screen showed "Blocked by hook └ baiton probe denied this". No other tool name was observed. Both names are already in Auto mode's `TOOL_FAMILIES`; an `apply_patch` names no provable path, so Auto mode's stage (a) escalates it to stage (b).
  - **0.155.1 leg 1d — end to end with the shipped wiring.** The compiled `CodexAdapter.launch()` output for an executor relay run (`askRelayDescriptor(<scratch>/ws, baiton-e2e-<leg>)`: `codex --model gpt-6-astra --sandbox workspace-write --ask-for-approval on-request --add-dir .baiton/runs/baiton-e2e-<leg>/ -c developer_instructions=… --dangerously-bypass-hook-trust -c hooks.PermissionRequest=[…] -- '<prompt: touch <scratch>/ws/marker-e2e-<leg>, requesting escalation>'`) under the pty driver, with a responder answering every ask file. `approve` → the ask passed `parseAsk` (`tool=Bash`, args carrying `command` and `description`, `detail` = codex's `description`) and `marker-e2e-approve` was created; `deny` → the ask passed `parseAsk`, the screen showed "Blocked by hook" and "The approval review rejected the command with reason: “probe deny.” The command did not run.", and no marker was created.
  - **Unverified (0.155.1):** the handler `timeout` at the full 600 s scale (70 s was the longest); whether `PermissionRequest` also fires for MCP or web-search tools (none were used); whether `--dangerously-bypass-hook-trust` affects any hook source other than the inline one (none is configured on this machine); `codex resume` with the relay flags (the flags are documented in `codex resume --help`, but no resumed run was probed).
  - The mechanism exists and is inline-configurable. `codex --help` documents `-c/--config <key=value>` whose value half is parsed as TOML, and the binary carries a full hooks contract: events `PreToolUse`/`PermissionRequest`/`PostToolUse`/`UserPromptSubmit`/`SessionStart`/`SubagentStart`/…, a `HookEventsToml` config table, `HookHandlerConfig` variants `command`/`mcp_tool`/`agent` (`prompt` hooks report ": prompt hooks are not supported yet"), and an embedded JSON schema `pre-tool-use.command.output` whose contract is `hookSpecificOutput.permissionDecision ∈ allow|deny|ask` plus `permissionDecisionReason` — the same shape claude uses.
  - The accepted inline shape is `-c 'hooks.PreToolUse=[{matcher="*",hooks=[{type="command",command="…",timeout=600}]}]'`. (`--strict-config` could not be used to tell "accepted" from "ignored": `codex --strict-config … debug …` fails with ``Error: `--strict-config` is not supported for `codex debug` ``, and on `codex exec --help` the help path short-circuits before config validation. Acceptance was therefore established the decisive way — by observing the hook actually run.)
  - The hook fires with the tool name and its arguments. `codex exec --skip-git-repo-check --dangerously-bypass-hook-trust --sandbox workspace-write -c '<hooks value>' -- 'run the shell command: echo baiton-probe'` ran the hook, whose stdin was verbatim `{"session_id":"01a0c0a6-…","turn_id":"01a0c0a6-…","transcript_path":"…/sessions/2026/09/20/rollout-….jsonl","cwd":"…","hook_event_name":"PreToolUse","model":"gpt-6-astra","permission_mode":"bypassPermissions","tool_name":"Bash","tool_input":{"command":"echo baiton-probe"},"tool_use_id":"exec-12b30802-…"}` — no argv is passed, everything arrives on stdin.
  - The decision really changes the outcome. `permissionDecision: "deny"` blocked the call: `ERROR codex_core::tools::router: error=Command blocked by PreToolUse hook: baiton probe denied this tool call. Command: echo baiton-probe`, surfaced as `hook: PreToolUse Blocked`, and the model was told "The command was blocked by the environment's PreToolUse hook … It did not run." `"allow"` let it run.
  - **(0.154.0; superseded — exec-only, and the relay now uses `PermissionRequest`, whose failures fall back to the prompt per 0.155.1 leg 1a) `ask` is not a fallback-to-prompt in a non-interactive run — it is a silent allow.** With `permissionDecision: "ask"` under `codex exec` (`approval: never`) the command *ran*. This is the opposite of claude's probed behaviour, where `ask` blocked, and it is why a codex relay could not reuse claude's "degrade to `ask`" safety valve unchanged.
  - A hook may block for a long time: a hook sleeping 45 s with `timeout=600` on the handler entry ran to completion and its decision was honoured (whole turn: 53 s). The `timeout` field is accepted; it was **not** verified at the full 600 s scale.
  - **Decisive leg (0.154.0; superseded — Baiton now emits `--dangerously-bypass-hook-trust` on relay launches for the one hook it authors, see 0.155.1 legs D and 1d) — hook trust: the hook is not installable from argv alone.** The byte-identical run *without* `--dangerously-bypass-hook-trust` silently skipped the hook: no log file, no warning, no error, and `echo baiton-probe` simply ran. codex gates every enabled hook behind persisted trust (`HookStateToml { enabled, trusted_hash }`), reviewed and written back through the TUI — the binary carries "New hook - review required", "Modified since last trusted - review required", `TrustHook`/`SetHookTrusted` actions and `config/batchWrite failed while updating hook trust in TUI`. Three argv-only attempts to satisfy it all failed with the hook still silently skipped: inline `state={enabled=true}`, inline `state={enabled=true,trusted_hash="000…0"}` (no error naming an expected hash — codex just ignores the hook), and `-c bypass_hook_trust=true` (the key exists internally as `bypass_hook_trust`, but is not a `config.toml` override). The only argv route that worked is the flag `--dangerously-bypass-hook-trust` ("Run enabled hooks without requiring persisted hook trust for this invocation. DANGEROUS."), which Baiton never emits. Establishing trust instead means writing into `$CODEX_HOME`, and `CodexAdapter.launch()` is a pure function that writes nothing. **Hence: no wiring emitted.**
  - **Unverified (0.154.0; closed by 0.155.1 legs D and 1a):** whether the hook behaves identically under the *interactive* form `codex [OPTIONS] [PROMPT]`, which is what Baiton actually launches (adapter degrade 2). The probe ran through `codex exec` because the TUI needs a pty. Trust gating is not exec-specific — the trust-review UI lives *in* the TUI — so interactive is if anything more gated, not less, but this leg is recorded as unverified rather than asserted. The `ask` finding above is likewise exec-only; in a session with a terminal `ask` may well reach codex's own prompt.
  - Residual surfaces, each a one-line negative: `codex plugin` installs only from marketplaces (`codex plugin list` shows a remote catalogue of `…@openai-curated-remote` entries; `codex plugin add <PLUGIN[@MARKETPLACE]>` takes a selector, not a path), so it is an on-disk install, not argv-installable. `-p/--profile <CONFIG_PROFILE_V2>` layers `$CODEX_HOME/<name>.config.toml`, i.e. it needs a file. The `mcp_tool` handler type would need a running MCP server, and `agent` handlers are themselves model calls — neither is a file-protocol relay. `codex doctor` reports install/auth/runtime health only and exposes no hook or approval delegation.
- **antigravity (agy) findings** (probed `agy --version` → 1.2.7, 2026-09-20, and re-probed → **1.2.8, 2026-09-22**; the 1.2.8 legs come first and supersede the two 1.2.7 "decisive legs" further down). All 1.2.8 legs ran in a scratch directory with a scratch `<run>/.agents/hooks.json`; nothing was written to `~/.gemini` or to a real workspace `.agents/`. `<run>` / `<cwd>` / `<ws>` below are scratch directories; the hook handler logged its stdin and printed a canned decision.
  - **1.2.8 leg a — the hook loads from the run directory, but only for an ABSOLUTE `--add-dir`.** `cd <cwd> && agy --mode accept-edits --add-dir <abs run> --log-file a.log --print-timeout 120s -p 'run the shell command: echo baiton-probe'` with the handler answering `deny` logged `loaded 1 named hooks from 1 hooks.json file(s)`, the handler ran (its working directory was `<run>/.agents`, stdin `{"toolCall":{"name":"run_command","args":{"CommandLine":"echo baiton-probe","Cwd":"<run>",…}},…}`), and the run ended `tool call denied by pre-tool hook: baiton probe denied this tool call`. **But** with the cwd at the workspace root and the RELATIVE grant Baiton emits (`--add-dir .baiton/runs/run-f/`, also tried without the trailing slash and as `./.baiton/runs/run-f/`) agy logged `loaded 0 named hooks from 0 hooks.json file(s)`; the absolute path, with or without the trailing slash, logged `loaded 1`, and passing both forms logged `loaded 1`. A first wiring attempt that relied on the relative grant, launched with `--dangerously-skip-permissions`, ran `touch <ws>/marker-f1` with no hook at all — which is why the relay launch adds the absolute run directory as a second `--add-dir`.
  - **1.2.8 leg b — interactive `allow` does NOT grant.** Under a pty (`python3` `pty.fork` driver, `timeout 120`, no `script`/`expect` on the host): `agy --mode accept-edits --add-dir <abs run> --log-file b.log --prompt-interactive 'run the shell command: touch <run>/marker-b'` with the handler answering `{"decision":"allow"}`. The handler fired (step 2), and agy then logged `Surfacing tool confirmation: "RunCommand" at step 2`; the marker was never created in 85 s (repeated: 54 s, same result). This closes the 1.2.7 "unverified" interactive leg: the hook is a veto, not a grant, in both modes. Caveat: the TUI itself sat at its "Do you trust the contents of this project?" dialog (answering it would have written trust state into `~/.gemini`), so the confirmation was observed in the log, not on screen; the conversation ran regardless.
  - **1.2.8 leg c — with `--dangerously-skip-permissions`, the hook is the sole authority.** Same setup plus the flag: handler `deny` → blocked, headless (`-p`, `tool call denied by pre-tool hook: …`) and interactive (pty; hook fired once, no marker). Handler `allow` → interactive run executed `touch <run>/marker-c2` with no confirmation surfaced. Failure modes, headless, flag on, handler `timeout` 5 s: handler exits 1 with no output → blocked (`JSON hook … failed: command failed: exit status 1`); handler sleeps 20 s → blocked (`timed out and was killed (signal: killed)`); handler prints `not json` → blocked (`failed to unmarshal result from hook … via protojson`); handler prints `{}` → blocked (`tool call denied by pre-tool hook: `); **handler exits 0 with EMPTY stdout → the command RAN**. Baiton's hook script therefore starts with exit code 1 and exits 0 only after writing a decision.
  - **1.2.8 leg d — the hook fires for read and write tools too.** Headless, flag on, handler `allow`, a prompt asking for directory listing, file view, search, find, create and edit via file tools: the handler saw `view_file` (`AbsolutePath`), `write_to_file` (`TargetFile`, `CodeContent`, `Overwrite`, …), `replace_file_content` (`TargetFile`, `TargetContent`, `ReplacementContent`, `StartLine`, `EndLine`, …) and, in another run, `run_command` (`CommandLine`, `Cwd`). This model/CLI exposed no `list_dir`, `grep_search` or `find_by_name` tool (the model said so and fell back to `view_file`); those names stay mapped in `TOOL_FAMILIES` but were **not observed**. `AbsolutePath` and `TargetFile` were added to Auto mode's path keys.
  - **1.2.8 leg e — skip-permissions lifts `--mode plan`'s edit ban.** `agy --mode plan --dangerously-skip-permissions --add-dir <abs run> -p 'Create the file <run>/plan-e.txt containing hello …'` with handler `allow` wrote the file (after `write_to_file` calls for its own plan artifacts under `~/.gemini/antigravity-cli/brain/…`, which the hook also saw). On a relay launch the hook — Baiton's cards and Auto mode's gate — is therefore the enforcement floor for read-only roles too; `--mode plan` is not.
  - **1.2.8 leg f — end to end with the shipped wiring.** The compiled adapter's `relayFiles()` output written to `<ws>/.baiton/runs/run-f/.agents/hooks.json`, a responder answering every ask file, and the exact argv `launch()` returns (`--model gemini-3.8-flash-high --mode accept-edits --add-dir .baiton/runs/run-f/ --add-dir <ws>/.baiton/runs/run-f --dangerously-skip-permissions --prompt-interactive …`) under a pty with the cwd at `<ws>`: `approve` → the ask file passed `parseAsk` (`tool=run_command`, args carrying `CommandLine`) and `touch <ws>/marker-approve` ran; `deny` → the command did not run. No `Surfacing tool confirmation` in either log. (The first attempt at this leg exposed an escaping bug in the script; node exited with a SyntaxError and agy blocked the call — the fail-closed path, observed live.)
  - **Unverified (1.2.8):** whether agy re-reads `hooks.json` while a session runs (the script denies any tool call whose arguments name an `.agents` `hooks.json`, so the agent cannot rewrite it through its tools either way); the `ask`/`force_ask` decisions; the handler `timeout` at the full 600 s scale (only 5 s and 60 s were used); whether `--sandbox` interacts with the hook.
  - `agy --help` documents no `--settings`, `--hooks` or permission-callback flag. The full flag surface is `--add-dir, --agent, -c/--continue, --conversation, --dangerously-skip-permissions, --disable-slash-commands, --effort, -i, --input-format, --json-schema, --log-file, --mode, --model, --new-project, --output-format, -p/--print, --print-timeout, --project, --prompt, --prompt-interactive, --remote-control, --sandbox`, so there is no inline-config route of claude's `--settings` kind. `--dangerously-skip-permissions` ("Auto-approve all tool permission requests without prompting") exists but is never emitted — it is a blanket auto-approve, not a relay, so it is not a route here.
  - **agy does ship the mechanism, and the probe watched it work.** The binary carries a `hooks.json` lifecycle-hook contract (events `PreToolUse`/`PostToolUse`/`PreInvocation`/`PostInvocation`/`Stop`; a `matcher`+`hooks` wrapper for the tool events; handlers `{type:"command", command, timeout}` defaulting to 30 s) and the runtime strings to match (`loaded %d named hooks from %d hooks.json file(s)`, `No hooks.json found at %s`, `pre-tool hooks failed: %v`). With `<workspace>/.agents/hooks.json` in place the log printed `loaded 1 named hooks from 1 hooks.json file(s)` and the handler ran.
  - The hook fires with the tool name and its arguments, on stdin. Verbatim: `{"artifactDirectoryPath":"…","conversationId":"efbf7480-…","modelName":"gemini-3.8-flash-high","stepIdx":2,"toolCall":{"args":{"CommandLine":"echo baiton-probe","Cwd":"…/ws","WaitMsBeforeAsync":5000,"toolAction":"Running echo command","toolSummary":"Run echo command"},"name":"run_command"},"transcriptPath":"…/transcript_full.jsonl","workspacePaths":["…/ws"]}` — keys are camelCase (protojson), and nothing is passed on argv.
  - A `deny` really changes the outcome. `agy --mode accept-edits --add-dir <ws> --print-timeout 200s -p='run the shell command: echo baiton-probe'` with a handler answering `{"decision":"deny","reason":"baiton probe denied this tool call"}` ended with ``The command execution was denied by the pre-tool hook: `tool call denied by pre-tool hook: baiton probe denied this tool call` `` and the command did not run.
  - **Decisive leg 1 (1.2.7; superseded — the launcher now writes the file inside the run directory, see 1.2.8 leg a) — the hook is not installable without writing a file.** Hooks load only from an on-disk `hooks.json` in a customization root: `<workspace>/.agents/hooks.json`, or the shared `~/.gemini/config/hooks.json`. The workspace-local file is loaded only once that directory is a workspace — the identical run *without* `--add-dir <ws>` logged `loaded 0 named hooks from 0 hooks.json file(s)` and the handler never ran, even with the file sitting in the cwd. No flag carries the config inline and no environment variable does either (`env | grep -i agy` is empty, and the `AGY_*` names in the binary are telemetry/TUI switches: `AGY_CLI_HIDE_LOGO`, `AGY_ONBOARDING_*`, …). Installing a relay therefore means Baiton writing a `hooks.json`, and `AntigravityAdapter.launch()` is a pure function that writes nothing (the launcher is outside this change) — the same disqualifier that stopped opencode's plugin file and codex's hook trust.
  - **Decisive leg 2 (1.2.7; confirmed for interactive runs by 1.2.8 leg b, and worked around by 1.2.8 leg c) — the hook is veto-only, so it could not carry an approval relay anyway.** `{"decision":"allow"}` did *not* grant the permission: the byte-identical run ended in agy's headless soft-deny, `jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied.` Adding the documented `"permissionOverrides":["command(echo)"]` alongside `allow` did not change it either. The handler demonstrably fired in both runs (its stdin was captured each time), so this is observed veto-only behaviour, not a hook that failed to load. A relay must be able to say **yes**; this one can only say no.
  - Residual surfaces, each a one-line negative: `agy agents` still prints nothing on 1.2.7 and `agy help agent` documents only "List available agents", so agents remain undefinable (the adapter's degrade 5, re-verified). `agy plugin` installs from a marketplace target (`install <target>`, `import [source]`, `validate [path]`) and `agy plugin list` reports "No imported plugins." — an on-disk install, not argv-installable, and plugin-bundled hooks land in `plugins/<name>/hooks.json`, a file again. `agy mcp` only edits a stored server config (`agy mcp list` → "No MCP servers configured.") and would need a running process, not a file-protocol hook. `agy remote-control` is a systemd user daemon (`agy remote-control status` → "Daemon status: inactive … journalctl --user -u antigravity-cli-daemon.service"), which needs persisted registration and a background process, so it fails the same "installable from a pure `launch()`" test.
  - **Unverified (1.2.7; closed by 1.2.8 leg b — it does not):** whether `{"decision":"allow"}` grants the permission in the *interactive* `--prompt-interactive` form Baiton actually launches. Under a pty the hook was confirmed to fire with the same `toolCall` payload, but the run was stopped while the tool call was still pending at step 1, so the grant leg was never observed. Decisive leg 1 is unaffected either way — the file still has to be written.
  - **Unverified:** the `"ask"` and `"force_ask"` decisions were never exercised, in either mode. Given the headless soft-deny observed above, `ask` in `-p` is at best a deny with extra steps, as it is on opencode — but that is an inference, not a probe result.
  - **Unverified:** the `~/.gemini/config/hooks.json` global path was not exercised (the probe declined to write into the developer's real config), the handler `timeout` field was used only at 60 s and not at any larger scale, and the `permissionOverrides` target grammar was tried in one form only (`command(echo)`).
  - **Unverified:** the `permissions.allow` / `settings.json` layer that agy's own denial message recommends (`Add an allow-rule under permissions.allow in settings.json (e.g. command(<target>))`). The running config carries a built-in allow-list (`command(ls) command(cat) … command(npm test)`, `toolPermission=request-review`), but where that `settings.json` is read from, and whether any flag or env var can supply it, was not probed. It is in any case a static allow-list rather than a callback, so it cannot relay an ask.
- **Per-adapter relay state**:

  | Adapter | Relay | Verified |
  | --- | --- | --- |
  | claude | native `PreToolUse` hook via inline `--settings` | yes (version 2.1.278, 2026-09-20) |
  | opencode | config-driven fallback | probed 2026-09-20, version 1.18.30 — no inline-installable native relay |
  | antigravity (agy) | native `PreToolUse` hook in the launcher-written `.baiton/runs/<run-id>/.agents/hooks.json`, loaded via an absolute `--add-dir <run dir>`, with `--dangerously-skip-permissions` so the hook (which degrades to `deny`) is the sole authority | yes (version 1.2.8, 2026-09-22) |
  | codex | native `PermissionRequest` hook via inline `-c hooks.PermissionRequest=[…]` plus `--dangerously-bypass-hook-trust`; fires only where codex would prompt, so `--sandbox workspace-write --ask-for-approval on-request` stays the floor; needs the workspace to be trusted in codex | yes (version 0.155.1, 2026-09-22) |

- antigravity's native relay differs from claude's in two ways worth knowing.
  The hook file is written by the launcher (`Adapter.relayFiles()`; the
  adapter's `launch()` stays pure, and the launcher refuses any path outside
  `.baiton/runs/<run-id>/`), and `launch()` refuses to emit
  `--dangerously-skip-permissions` unless the launcher lists that file as
  written. And an unanswered or failed ask **blocks the tool call** (`deny`)
  instead of falling back to the CLI's own prompt, because with the flag on
  there is no prompt left; the hook sees every tool call, reads included, and
  `--mode plan` no longer holds on its own (1.2.8 leg e), so for agy runs the
  cards and Auto mode's gate are the permission floor.
- codex's native relay is pure argv like claude's, but hooks codex's
  `PermissionRequest` event rather than `PreToolUse`: it fires only where codex
  would otherwise show its own approval prompt (a command or edit leaving the
  `workspace-write` sandbox), so in-sandbox work never produces a card and the
  sandbox plus `--ask-for-approval on-request` remain the enforcement floor.
  `--dangerously-bypass-hook-trust` is emitted only on relay launches, to run
  the hook Baiton itself authors; it bypasses hook trust only.
  `--dangerously-bypass-approvals-and-sandbox` and `--approve-for-me` are never
  emitted. An unanswered or failed ask falls back to codex's own terminal
  prompt, never to an allow. The hook also needs codex's project trust: in a
  workspace you have never trusted in codex, codex shows its "trust this
  folder" dialog, no hook fires, and asks stay in the terminal. A re-opened
  session (`attach()`) carries no relay.
- Adapters whose probe found no native mechanism Baiton can install (opencode
  — and any unknown agent id) receive a **config-driven
  fallback relay**: the Brief carries an 'Asking for permission or a decision'
  section telling the sub-agent to write `<run>/asks/<ask-id>.json` in the same
  `file-v1` wire format and to wait for `<ask-id>.response.json`, so the same
  `vscodeAskWatcher` routes those asks to the same inline chat cards and Auto
  mode applies unchanged. The config-driven permission layer
  (`permissionFlags` / `--allowedTools` / `--permission-mode`) remains the
  enforcement floor underneath, and the selection lives in `ASK_RELAY_KIND` in
  `src/adapter/index.ts`. This route is instruction-driven, not enforced by the
  CLI: a model that ignores the instruction simply asks in its terminal as
  before, and nothing is auto-approved on its behalf.

The state table above is the thing that decides which relay each adapter uses: the selection it records is the selection encoded in `ASK_RELAY_KIND` / `askRelayKind()` in `src/adapter/index.ts`, so the documented findings and the shipped behaviour have one source.

## Commands

- **Baiton: Open Chat** (`baiton.openChat`) — reveals the Baiton container and
  moves keyboard focus to the Chat view.
- **Baiton: Open Config Panel** (`baiton.openConfigPanel`) — reveals the Baiton
  container and moves keyboard focus to the Configuration view.
- **Baiton: Set Orchestrator API Key** (`baiton.setOrchestratorApiKey`) — prompts
  for the orchestrator API key with a masked input and stores it securely in VS
  Code SecretStorage.

## Settings

Besides the endpoint, model, streaming and round-bound settings, the
orchestrator accepts `baiton.orchestrator.maxTokens`: the maximum number of
tokens it asks the model to generate per completion, sent as `max_tokens`. It
defaults to `0`, which leaves `max_tokens` off the request entirely so the
endpoint's own default applies.
