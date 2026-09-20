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
| `list_files`, `read_file`, `search`, `git_diff`, `git_log` | yes | no |
| `update_overview`, `add_todo`, `edit_todo`, `remove_todo` | yes | yes |
| `draft_spec` | yes | no |
| `approve_spec` | yes | yes (re-approve) |
| `run`, `submit_pr` | no | yes |

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

### Creating a spec

The orchestrator gathers the requirements; a configured coding agent writes the
spec.

1. Describe the work in the Workspace conversation. The orchestrator reads the
   repository and asks clarifying questions, one at a time.
2. It writes a short **requirements document** — the goal, the constraints, the
   acceptance criteria and the files of interest — and revises it until you
   agree to it. It never proposes the todo list itself.
3. Once you agree it calls `draft_spec`, which asks you to confirm the
   requirements and then launches the **spec writer**: the agent configured for
   the `spec-writer` role in `.baiton/config.json`. That agent studies the
   repository read-only and returns an OVERVIEW plus a dependency-ordered todo
   list; the extension assigns the `T##` ids, renders
   `.baiton/specs/<slug>/spec.md`, and commits it.
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

#### Harness ask relay (per-adapter probe findings)

A launched run's `.baiton/runs/<run-id>/asks/<ask-id>.json` is a harness ask and `<ask-id>.response.json` is the answer written back into it; the run stays paused until the answer file appears.

- **claude findings** (probed `claude --version 2.1.278`):
  - `--settings` accepts an inline JSON string as well as a file path (`<file-or-json>` in `claude --help`), and a `-p` run started with an inline hooks JSON launched cleanly and installed the hook — verified by the probe.
  - `PreToolUse` command hooks fire for every tool call with the exact stdin event `{session_id, transcript_path, cwd, prompt_id, permission_mode, effort, hook_event_name, tool_name, tool_input, tool_use_id}` — the fields Baiton's hook reads (`hook_event_name`, `tool_name`, `tool_input`) are taken verbatim from this probe.
  - The hook's stdout contract is `hookSpecificOutput.permissionDecision ∈ allow|deny|ask` plus `permissionDecisionReason`: `deny` blocked the tool call with the probe's reason string, `allow` let it run, and `ask` (non-interactive `-p`) blocked it the same way `deny` did — all verified by the probe; the `ask` lever only falls back to the interactive prompt in sessions with a terminal.
  - A `timeout` field is accepted on the hook entry and is enforced by the CLI (a 1 s timeout clipped a 2 s hook); the probed CLI did not surface a distinct "timed out" decision to the hook, so Baiton's hook does not rely on the CLI-side timeout — it runs with its own 600 s deadline and degrades **deliberately** to `permissionDecision: "ask"` (never a silent `allow`) on expiry or on any parse/write failure.
  - The `timeout` *field itself* beyond "no rejection" and the above clipping were **not independently re-verified at the 600 s scale**; anything the probe could not confirm is marked **unverified** rather than asserted.
- **Per-adapter relay state**:

  | Adapter | Relay | Verified |
  | --- | --- | --- |
  | claude | native `PreToolUse` hook via inline `--settings` | yes (version 2.1.278, 2026-09-20) |
  | opencode | config-driven fallback | not probed yet |
  | antigravity (agy) | config-driven fallback | not probed yet |
  | codex | config-driven fallback | not probed yet |

- Adapters without a verified native relay fall back to the config-driven
  permission layer (`permissionFlags` / `--allowedTools` /
  `--permission-mode`) and surface nothing inline.

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
