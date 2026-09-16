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

## Commands

- **Baiton: Open Chat** (`baiton.openChat`) — reveals the Baiton container and
  moves keyboard focus to the Chat view.
- **Baiton: Set Orchestrator API Key** (`baiton.setOrchestratorApiKey`) — prompts
  for the orchestrator API key with a masked input and stores it securely in VS
  Code SecretStorage.

## Settings

Besides the endpoint, model, streaming and round-bound settings, the
orchestrator accepts `baiton.orchestrator.maxTokens`: the maximum number of
tokens it asks the model to generate per completion, sent as `max_tokens`. It
defaults to `0`, which leaves `max_tokens` off the request entirely so the
endpoint's own default applies.
