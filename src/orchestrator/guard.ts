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
 *   `.baiton/specs/` (Req 8.1, 8.2); a read tool's target has its symlinks
 *   resolved and any path escaping the repository root is rejected with no read
 *   (Req 9.2, 9.3); read results are truncated to a fixed cap with a truncation
 *   flag (Req 9.4). The path checks are exposed as helpers on the
 *   {@link GuardContext} so each tool resolves its own argument paths through
 *   the guard rather than re-implementing containment.
 * - **Restricted Mode** — while the workspace is untrusted, every mutating
 *   ("write") tool and every dispatch tool is disabled (Req 22.1, 22.2).
 *
 * The guard is a pure core: it takes the repository root, the `.baiton/` path,
 * and the restricted flag as plain injected values (never the `vscode` module),
 * so it is directly unit- and property-testable. The activation layer's
 * `WorkspaceContext` (design "Activation") satisfies {@link GuardWorkspace} by
 * passing its `root`/`baitonDir` `fsPath`s and `restricted` flag.
 */
import * as fs from 'fs/promises';
import { realpathSync } from 'fs';
import * as path from 'path';

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
 * - `repoRoot`   — absolute path of the repository root; read paths may not
 *                  resolve outside it (Req 9.3).
 * - `specsDir`   — absolute path of `.baiton/specs/`; mutating paths must
 *                  resolve under it (Req 8.1).
 * - `restricted` — whether the workspace is in VS Code Restricted Mode; when
 *                  true, writes and dispatch are disabled (Req 22.1, 22.2).
 */
export interface GuardWorkspace {
  repoRoot: string;
  specsDir: string;
  restricted: boolean;
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
 */
export interface ToolContext {
  callId: string | undefined;
  ctx: GuardContext;
}

/**
 * A single orchestrator tool (design "Orchestrator: tool registry and guard").
 *
 * - `mutating` — whether the tool changes files. Mutating tools require an
 *                idempotency key and are disabled under Restricted Mode.
 * - `dispatch` — whether the tool dispatches a stage (e.g. `run`). Dispatch is
 *                disabled under Restricted Mode (Req 22.2) even though the
 *                dispatch tool writes no spec file itself.
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
  schema: object;
  run(args: unknown, tc: ToolContext): Promise<ToolResult>;
}

/**
 * The fixed maximum size, in bytes of UTF-8 text, a read tool result is
 * truncated to (Req 9.4). Chosen large enough to carry a spec or a bounded file
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

/** Why a guarded path resolution was rejected. */
export type PathError =
  /** A mutating target resolved outside `.baiton/specs/` (Req 8.2). */
  | { kind: 'outside-specs'; requested: string; message: string }
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
 * targets under `.baiton/specs/`.
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

  constructor(workspace: GuardWorkspace) {
    // Resolve the roots once, symlinks included, so containment checks compare
    // them against targets in the same resolved form.
    this.workspace = {
      repoRoot: realpathSyncAllowingMissing(workspace.repoRoot),
      specsDir: realpathSyncAllowingMissing(workspace.specsDir),
      restricted: workspace.restricted,
    };
  }

  /** Whether the workspace is in Restricted Mode (Req 22.1, 22.2). */
  public get restricted(): boolean {
    return this.workspace.restricted;
  }

  /** Absolute, normalized `.baiton/specs/` directory. */
  public get specsDir(): string {
    return this.workspace.specsDir;
  }

  /** Absolute, normalized repository root. */
  public get repoRoot(): string {
    return this.workspace.repoRoot;
  }

  /**
   * Resolves a mutating tool's target path and confirms it lies under
   * `.baiton/specs/` after symlink resolution (Req 8.1, 8.2). A target outside
   * that subtree is rejected with an `outside-specs` error and the caller must
   * make no change. The target need not yet exist (a create is allowed), but
   * any existing ancestor symlink is collapsed first so it cannot escape.
   */
  public async resolveMutatingPath(requested: string): Promise<PathResolution> {
    const resolved = await realpathAllowingMissing(this.absoluteFrom(requested));
    if (!isWithin(this.workspace.specsDir, resolved)) {
      return {
        ok: false,
        error: {
          kind: 'outside-specs',
          requested,
          message: `mutating tool target is outside .baiton/specs/: ${requested}`,
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
    const bytes = Buffer.from(text, 'utf8');
    if (bytes.byteLength <= READ_RESULT_CAP_BYTES) {
      return { text, truncated: false };
    }
    // Slice on a byte boundary, then decode dropping any partial trailing
    // multibyte sequence so the result is always valid UTF-8.
    const slice = bytes.subarray(0, READ_RESULT_CAP_BYTES);
    const decoder = new TextDecoder('utf-8', { fatal: false });
    const decoded = decoder.decode(slice).replace(/\uFFFD+$/u, '');
    return { text: decoded, truncated: true };
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
