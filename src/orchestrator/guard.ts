/**
 * The orchestrator guard layer (Requirements 8.1–8.5, 9.2–9.4, 22.1, 22.2).
 *
 * Every orchestrator tool is wrapped by {@link guardTool}, which enforces the
 * three cross-cutting concerns the design assigns to the guard, independent of
 * what any individual tool does:
 *
 * - **Idempotency** — a mutating call must carry the model's tool-call id as an
 *   idempotency key; a missing key is rejected before any change (Req 8.3, 8.4).
 *   A key already seen returns the stored first result and makes no further
 *   change (Req 8.5). The seen-key → result map is kept per repository, in
 *   memory, for the session (design "Orchestrator: tool registry and guard").
 * - **Path containment** — a mutating tool's target must resolve under
 *   `.baiton/plans/` or legacy `.baiton/specs/` (Req 8.1, 8.2); a read tool's target has its symlinks
 *   resolved and any path escaping the repository root is rejected with no read
 *   (Req 9.2, 9.3); read results are truncated to a fixed cap with a truncation
 *   flag (Req 9.4). The path checks are exposed as helpers on the
 *   {@link GuardContext} so each tool resolves its own argument paths through
 *   the guard rather than re-implementing containment.
 * - **Restricted Mode** — while the workspace is untrusted, every mutating
 *   ("write") tool and every dispatch tool is disabled (Req 22.1, 22.2).
 *
 * The guard is a pure core: it takes the target repository root, the `.baiton/` path,
 * and the restricted flag as plain injected values (never the `vscode` module),
 * so it is directly unit- and property-testable. The activation layer's
 * `WorkspaceContext` (design "Activation") satisfies {@link GuardWorkspace} by
 * passing its `root`/`baitonDir` `fsPath`s and `restricted` flag. A stage uses
 * {@link guardWorkspaceForRepo} to bind containment to its target repository.
 */
import * as fs from 'fs/promises';
import { realpathSync } from 'fs';
import * as path from 'path';
import { LEGACY_SPECS_SUBDIR, PLANS_SUBDIR } from '../storage/documentLocation';
import type { ConversationKind } from './systemPrompt';

/**
 * The result of any tool invocation (design "Orchestrator: tool registry and
 * guard"). A success carries opaque `data`; a failure carries a user-facing
 * `error` string.
 */
export type ToolResult =
  | { ok: true; data: unknown }
  | { ok: false; error: string };

/**
 * The minimal, VS-Code-free view of the workspace the guard needs. The
 * activation layer's `WorkspaceContext` provides these as `Uri.fsPath` values
 * plus its Restricted Mode flag, so it can be adapted without this core
 * depending on the `vscode` module.
 *
 * - `repoRoot`   — absolute path of the stage's TARGET repository root; read paths may not
 *                  resolve outside it (Req 9.3).
 * - `baitonDir`  — absolute path of `.baiton/`; mutating paths must resolve
 *                  under `plans/` or legacy `specs/` (Req 8.1).
 * - `restricted` — whether the workspace is in VS Code Restricted Mode; when
 *                  true, writes and dispatch are disabled (Req 22.1, 22.2).
 */
export interface GuardWorkspace {
  repoRoot: string;
  baitonDir: string;
  restricted: boolean;
}

/** Build a guard bound only to a stage's target repo; containment never widens to a workspace folder or parent repo. Read containment is that repo root, and mutations are limited to its own `.baiton/plans` and `.baiton/specs`. */
export function guardWorkspaceForRepo(
  repo: { root: string; baitonDir?: string },
  restricted: boolean,
): GuardWorkspace {
  return {
    repoRoot: repo.root,
    baitonDir: repo.baitonDir ?? path.join(repo.root, '.baiton'),
    restricted,
  };
}

/**
 * The context passed to every tool's `run` (design "Orchestrator: tool registry
 * and guard").
 *
 * - `callId` — the model's tool-call id, used as the idempotency key. May be
 *              absent (`undefined`) when the model omitted one; the guard
 *              rejects that for mutating calls (Req 8.4).
 * - `ctx`    — the workspace context, exposing the guard's path-containment
 *              helpers so a tool resolves its argument paths through the guard.
 * - `caller` — the chat making the call, so a tool such as `spawn_subagent`
 *              knows who is asking. Absent when the host does not say (e.g.
 *              existing direct calls such as commands.ts approve_plan).
 */
export interface ToolContext {
  callId: string | undefined;
  ctx: GuardContext;
  caller?: ToolCaller;
}

/**
 * Which of the orchestrator's three jobs a conversation is doing right now
 * (Req 11.1).
 *
 * - `gather` — a Workspace conversation, or a plan still in `draft`: ask
 *              clarifying questions until the requirements are agreed, then
 *              hand them to the plan writer through `draft_plan`.
 * - `drive`  — an approved plan being driven to completion: dispatch the next
 *              legal stage through `run` until every phase is done, then
 *              `submit_pr`.
 * - `run`    — a non-plan (Bug/Quick/Refactor/Investigate) Workspace
 *              conversation: inspect the repository with the read tools, agree
 *              the work, then dispatch one plan-less run through `start_run` or
 *              `investigate`.
 *
 * Each tool declares its conversation phases, so the tool surface advertised
 * to the model and the surface the registry will run match the current job.
 */
export type ConversationStep = 'gather' | 'drive' | 'run';

/** All three orchestrator phases, for iteration in assembly and tests. */
export const CONVERSATION_STEPS: readonly ConversationStep[] = ['gather', 'drive', 'run'] as const;

/** Who is asking for the tool surface: a top-level chat, or a sub-agent chat a parent spawned. A sub-agent sees only the read tools, ask_user, run (drive phase) and the two spawn tools; only a top-level chat finishes a plan. */
export type ToolSurface = 'top' | 'subagent';
export const TOOL_SURFACES: readonly ToolSurface[] = ['top', 'subagent'] as const;

/** The chat making a tool call, so a tool (spawn_subagent, send_to_subagent) knows who is calling. depth is 0 for a top-level chat, 1 for its sub-agent, 2 for a sub-agent's sub-agent. */
export interface ToolCaller {
  sessionKey: string;
  depth: number;
  step: ConversationStep;
  kind: ConversationKind;
  signal: AbortSignal;
}

/**
 * A single orchestrator tool (design "Orchestrator: tool registry and guard").
 *
 * - `mutating` — whether the tool changes files. Mutating tools require an
 *                idempotency key and are disabled under Restricted Mode.
 * - `dispatch` — whether the tool dispatches a stage (e.g. `run`, `start_run`,
 *                `investigate`). Dispatch is disabled under Restricted Mode
 *                (Req 22.2) even though the dispatch tool writes no plan file
 *                itself.
 * - `concurrent` — whether the tool loop may run this call in parallel with
 *                adjacent concurrent-flagged calls of the same completion.
   * - `steps`    — the conversation steps this tool is part of (Req 11.1). A
 *                tool is neither advertised nor runnable outside them.
 * - `schema`   — JSON Schema for the tool's arguments (validated elsewhere in
 *                the registry; carried here to match the design interface).
 */
export interface Tool {
  name: string;
  /**
   * A human-readable summary of what the tool does, sent to the model so it
   * chooses tools by purpose rather than guessing from the name (Req 10.1).
   * Every registered tool must supply one that is at least 10 characters after
   * trimming and not equal to its `name` (Req 10.2); assembly rejects any tool
   * that violates this and sends no definitions (Req 10.5).
   */
  description: string;
  mutating: boolean;
  dispatch?: boolean;
  /**
   * Whether the tool loop may run this call in parallel with the adjacent
   * concurrent-flagged calls of the same completion. Only side-effect-free or
   * self-serializing tools set it (the read tools, `run`); a tool that writes
   * plan files, raises a card or finishes a plan leaves it unset so it runs alone.
   */
  concurrent?: boolean;
  /**
   * The orchestrator phases in which this tool is advertised and may run
   * (Req 11.1). The registry refuses a call whose phase is not listed here
   * before the tool's `run` is reached.
   */
  steps: readonly ConversationStep[];
  /**
   * Whether a sub-agent chat may see and call this tool (in the phases it lists). Unset means top-level only, so a new tool never leaks onto the sub-agent surface by default. Read tools are sub-agent tools by origin (the registry marks them), so they do not set it.
   */
  subagent?: boolean;
  schema: object;
  run(args: unknown, tc: ToolContext): Promise<ToolResult>;
}

/**
 * The fixed maximum size, in bytes of UTF-8 text, a read tool result is
 * truncated to (Req 9.4). Chosen large enough to carry a plan or a bounded file
 * range but small enough to keep a single tool result well within a model
 * context budget.
 */
export const READ_RESULT_CAP_BYTES = 64 * 1024;

/** A read tool's payload after the guard's fixed-cap truncation (Req 9.4). */
export interface BoundedText {
  /** The (possibly truncated) UTF-8 text, never exceeding {@link READ_RESULT_CAP_BYTES}. */
  text: string;
  /** True when the original exceeded the cap and `text` was cut (Req 9.4). */
  truncated: boolean;
}

/**
 * The fixed cap, in UTF-8 bytes, on the content of every `tool` message the chat
 * tool loop appends to history and persists, whatever tool produced it, so one
 * unbounded result cannot blow the model's context or grow the transcript
 * without limit.
 */
export const TOOL_RESULT_CAP_BYTES = 64 * 1024;

/**
 * Cuts `text` to at most `maxBytes` UTF-8 bytes on a valid character boundary.
 * Reports the bytes kept and the original total so callers can note the cut.
 */
function cutUtf8(
  text: string,
  maxBytes: number,
): { text: string; truncated: boolean; keptBytes: number; totalBytes: number } {
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.byteLength <= maxBytes) {
    return { text, truncated: false, keptBytes: bytes.byteLength, totalBytes: bytes.byteLength };
  }
  // Slice on a byte boundary, then decode dropping any partial trailing
  // multibyte sequence so the result is always valid UTF-8.
  const decoded = new TextDecoder('utf-8', { fatal: false })
    .decode(bytes.subarray(0, maxBytes))
    .replace(/\uFFFD+$/u, '');
  return {
    text: decoded,
    truncated: true,
    keptBytes: Buffer.byteLength(decoded, 'utf8'),
    totalBytes: bytes.byteLength,
  };
}

/**
 * Bounds one tool result's content to {@link TOOL_RESULT_CAP_BYTES}. Input at or
 * under the cap is returned verbatim (the same string). Over the cap, the body is
 * cut on a valid UTF-8 character boundary to at most the cap, followed by a
 * newline and exactly one note line `[truncated: <n> of <m> bytes]`, where n is
 * the UTF-8 bytes kept and m the UTF-8 bytes of the original. The note is
 * appended after the body, so the whole string may exceed the cap by the note.
 */
export function boundToolResult(text: string): string {
  const cut = cutUtf8(text, TOOL_RESULT_CAP_BYTES);
  if (!cut.truncated) {
    return text;
  }
  return `${cut.text}\n[truncated: ${cut.keptBytes} of ${cut.totalBytes} bytes]`;
}

/** Why a guarded path resolution was rejected. */
export type PathError =
  /** A mutating target resolved outside `.baiton/plans/` and legacy `.baiton/specs/` (Req 8.2). */
  | { kind: 'outside-documents'; requested: string; message: string }
  /** A read target resolved outside the repository root (Req 9.3). */
  | { kind: 'outside-repo'; requested: string; message: string };

/**
 * A resolved Result for path helpers. Distinct from the model `Result` only to
 * keep this module free of a cross-import; the shape is identical.
 */
export type PathResolution =
  | { ok: true; resolved: string }
  | { ok: false; error: PathError };

/**
 * Resolves symlinks in a path, falling back to a lexical resolution for the
 * portion that does not yet exist on disk. `fs.realpath` throws when the target
 * (or a parent) is missing, which is expected for a mutating call that will
 * *create* a file — so we walk up to the nearest existing ancestor, resolve
 * that, and re-join the missing tail. This still defeats symlink escapes
 * through any existing ancestor (Req 9.2) while allowing not-yet-created
 * targets under `.baiton/plans/` or legacy `.baiton/specs/`.
 */
async function realpathAllowingMissing(target: string): Promise<string> {
  const absolute = path.resolve(target);
  try {
    return await fs.realpath(absolute);
  } catch {
    // Walk up to the nearest existing ancestor and resolve it, then re-append
    // the not-yet-existing tail so symlinked ancestors are still collapsed.
    let existing = path.dirname(absolute);
    const tail: string[] = [path.basename(absolute)];
    // Guard against an unbounded loop at the filesystem root.
    while (existing !== path.dirname(existing)) {
      try {
        const realExisting = await fs.realpath(existing);
        return path.join(realExisting, ...tail.reverse());
      } catch {
        tail.push(path.basename(existing));
        existing = path.dirname(existing);
      }
    }
    // No existing ancestor found (e.g. a non-existent root); return the lexical
    // resolution so containment is still decided against a normalized path.
    return absolute;
  }
}

/**
 * Synchronous counterpart of {@link realpathAllowingMissing} for the workspace
 * roots, which are fixed at construction. Targets are compared after symlink
 * resolution, so the roots must be resolved the same way or a root reached
 * through a symlink (e.g. `/home` -> `/var/home` on ostree systems) would make
 * every target look like it escaped.
 */
function realpathSyncAllowingMissing(target: string): string {
  const absolute = path.resolve(target);
  let existing = absolute;
  const tail: string[] = [];
  while (existing !== path.dirname(existing)) {
    try {
      return path.join(realpathSync(existing), ...tail.reverse());
    } catch {
      tail.push(path.basename(existing));
      existing = path.dirname(existing);
    }
  }
  return absolute;
}

/** Whether `child` lies at or under `parent`, both absolute and normalized. */
function isWithin(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * The guard's per-tool context, injected as `ToolContext.ctx`. It carries the
 * workspace shape and exposes the path-containment helpers each tool uses to
 * resolve its own argument paths under the guard's rules. Truncation of read
 * output is likewise offered here so every read tool caps and flags its result
 * identically (Req 9.4).
 */
export class GuardContext {
  private readonly workspace: GuardWorkspace;
  private readonly documentRoots: readonly string[];

  constructor(workspace: GuardWorkspace) {
    // Resolve the roots once, symlinks included, so containment checks compare
    // them against targets in the same resolved form.
    const baitonDir = realpathSyncAllowingMissing(workspace.baitonDir);
    const plansDir = realpathSyncAllowingMissing(path.join(baitonDir, PLANS_SUBDIR));
    // Legacy: protect the old document root while existing spec.md files remain supported.
    const legacySpecsDir = realpathSyncAllowingMissing(path.join(baitonDir, LEGACY_SPECS_SUBDIR));
    this.workspace = {
      repoRoot: realpathSyncAllowingMissing(workspace.repoRoot),
      baitonDir,
      restricted: workspace.restricted,
    };
    this.documentRoots = [plansDir, legacySpecsDir];
  }

  /** Whether the workspace is in Restricted Mode (Req 22.1, 22.2). */
  public get restricted(): boolean {
    return this.workspace.restricted;
  }

  /** Absolute, normalized `.baiton/plans/` directory. */
  public get plansDir(): string {
    return this.documentRoots[0];
  }

  /** Absolute, normalized legacy `.baiton/specs/` directory. */
  public get legacySpecsDir(): string {
    return this.documentRoots[1];
  }

  /** Absolute, normalized repository root. */
  public get repoRoot(): string {
    return this.workspace.repoRoot;
  }

  /** Absolute, normalized `.baiton/` directory. */
  public get baitonDir(): string {
    return this.workspace.baitonDir;
  }

  /**
   * Resolves a mutating tool's target path and confirms it lies under
   * `.baiton/plans/` or legacy `.baiton/specs/` after symlink resolution (Req 8.1, 8.2). A target outside
   * those roots is rejected with an `outside-documents` error and the caller must
   * make no change. The target need not yet exist (a create is allowed), but
   * any existing ancestor symlink is collapsed first so it cannot escape.
   */
  public async resolveMutatingPath(requested: string): Promise<PathResolution> {
    const resolved = await realpathAllowingMissing(this.absoluteFrom(requested));
    if (!this.documentRoots.some((root) => isWithin(root, resolved))) {
      return {
        ok: false,
        error: {
          kind: 'outside-documents',
          requested,
          // Legacy: specs/ remains protected while existing documents are supported.
          message: `mutating tool target is outside .baiton/plans/ and .baiton/specs/: ${requested}`,
        },
      };
    }
    return { ok: true, resolved };
  }

  /**
   * Resolves a read tool's target path, following all symlinks, and rejects any
   * path that escapes the repository root (Req 9.2, 9.3). On rejection the
   * caller must perform no read.
   */
  public async resolveReadPath(requested: string): Promise<PathResolution> {
    const resolved = await realpathAllowingMissing(this.absoluteFrom(requested));
    if (!isWithin(this.workspace.repoRoot, resolved)) {
      return {
        ok: false,
        error: {
          kind: 'outside-repo',
          requested,
          message: `read tool target is outside the repository root: ${requested}`,
        },
      };
    }
    return { ok: true, resolved };
  }

  /**
   * Truncates read output to the fixed cap and flags whether truncation
   * occurred (Req 9.4). Truncation is measured in UTF-8 bytes so multibyte
   * content cannot slip past the cap; the returned text is cut on a valid
   * character boundary.
   */
  public boundRead(text: string): BoundedText {
    const cut = cutUtf8(text, READ_RESULT_CAP_BYTES);
    return { text: cut.text, truncated: cut.truncated };
  }

  /** Resolves a requested path against the repo root when it is relative. */
  private absoluteFrom(requested: string): string {
    return path.isAbsolute(requested)
      ? requested
      : path.resolve(this.workspace.repoRoot, requested);
  }
}

/**
 * The per-repository idempotency store: a callId → stored-result map kept in
 * memory for the session (design "Orchestrator: tool registry and guard"). A
 * mutating call whose key is already present returns the stored result without
 * re-running the tool, so a repeated key changes nothing (Req 8.5).
 */
export class IdempotencyStore {
  private readonly seen = new Map<string, ToolResult>();

  /** The stored result for `callId`, or `undefined` when unseen. */
  public get(callId: string): ToolResult | undefined {
    return this.seen.get(callId);
  }

  /** Whether `callId` has already been processed. */
  public has(callId: string): boolean {
    return this.seen.has(callId);
  }

  /** Records the first result for `callId`. Subsequent sets are ignored. */
  public remember(callId: string, result: ToolResult): void {
    if (!this.seen.has(callId)) {
      this.seen.set(callId, result);
    }
  }

  /** The number of distinct keys recorded, for tests and diagnostics. */
  public get size(): number {
    return this.seen.size;
  }
}

/**
 * Wraps a {@link Tool} so every invocation is subject to the guard's cross-
 * cutting rules before (and around) the tool's own `run`:
 *
 * 1. **Restricted Mode** — a mutating or dispatch tool is disabled while the
 *    workspace is untrusted, returning an error and running nothing
 *    (Req 22.1, 22.2).
 * 2. **Idempotency key presence** — a mutating call without a `callId` is
 *    rejected before any change (Req 8.4).
 * 3. **Idempotency replay** — a mutating call whose `callId` was already seen
 *    returns the stored first result and runs nothing (Req 8.5).
 * 4. **Run + remember** — otherwise the tool runs; a mutating tool's result is
 *    stored under its key so a later repeat replays it (Req 8.5).
 *
 * Path containment (Req 8.1–8.2, 9.2–9.4) is enforced inside each tool via the
 * {@link GuardContext} helpers rather than here, because only the tool knows
 * which of its arguments are paths.
 *
 * The returned function has the same call shape as `Tool.run`, so the registry
 * can treat guarded and raw tools uniformly.
 */
export function guardTool(
  tool: Tool,
  store: IdempotencyStore,
): (args: unknown, tc: ToolContext) => Promise<ToolResult> {
  const isWriteOrDispatch = tool.mutating || tool.dispatch === true;

  return async (args: unknown, tc: ToolContext): Promise<ToolResult> => {
    // 1. Restricted Mode disables all writes and dispatch (Req 22.1, 22.2).
    if (isWriteOrDispatch && tc.ctx.restricted) {
      return {
        ok: false,
        error:
          `tool "${tool.name}" is disabled in Restricted Mode: ` +
          'trust this workspace to enable writes and stage dispatch',
      };
    }

    // 2 & 3 & 4 apply only to mutating tools; reads carry no idempotency key.
    if (tool.mutating) {
      // 2. A mutating call must carry an idempotency key (Req 8.3, 8.4).
      if (tc.callId === undefined || tc.callId === '') {
        return {
          ok: false,
          error: `mutating tool "${tool.name}" requires an idempotency key (tool-call id)`,
        };
      }

      // 3. A key already seen replays the stored first result, no change (Req 8.5).
      const prior = store.get(tc.callId);
      if (prior !== undefined) {
        return prior;
      }

      // 4. Run once, then remember the result under the key (Req 8.5).
      const result = await tool.run(args, tc);
      store.remember(tc.callId, result);
      return result;
    }

    // Non-mutating tools run directly; containment is enforced within `run`.
    return tool.run(args, tc);
  };
}
