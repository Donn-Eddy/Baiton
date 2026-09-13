/**
 * The terminal-creation seam (Requirement 11.1).
 *
 * The launcher must create a terminal whose own process is the CLI executable
 * (`shellPath`/`shellArgs`) with `cwd` at the workspace root and no intervening
 * shell, then send it the one-line initial prompt. In the running extension
 * that is `vscode.window.createTerminal(...)` followed by `terminal.sendText`,
 * but the launcher must not hard-depend on the `vscode` module so it stays
 * testable. This interface is that seam: the activation layer provides the real
 * `vscode`-backed implementation later; tests provide a fake.
 */

/** Options for creating a terminal, mirroring the fields the launcher sets. */
export interface CreateTerminalOptions {
  /** Terminal display name. */
  name: string;
  /** The executable to run as the terminal's own process (Req 11.1). */
  shellPath: string;
  /** Arguments passed to that executable (Req 11.1). */
  shellArgs: string[];
  /** The terminal working directory: the workspace root (Req 11.2). */
  cwd: string;
  /** Optional environment overrides for the launched process. */
  env?: Record<string, string>;
}

/** A created terminal the launcher can drive, dispose, and later identify. */
export interface HostTerminal {
  /** Send a line of text to the terminal (the initial prompt, Req 11.4). */
  sendText(text: string): void;
  /**
   * Dispose the terminal. The result watcher calls this once a stage produces
   * a valid result (Req 12.5), and the run queue calls it to cancel a running
   * stage (Req 20). In the `vscode`-backed implementation this wraps
   * `vscode.Terminal.dispose`. Idempotent.
   */
  dispose(): void;
  /**
   * The process id of the terminal's own process, when known. Recorded in the
   * Run_Journal so crash recovery can reconcile it (Req 21). May resolve to
   * `undefined` when the host cannot report it.
   */
  readonly processId?: Promise<number | undefined>;
  /**
   * Reveal the terminal in the UI (Requirement 3.3). In the `vscode`-backed
   * implementation this wraps `terminal.show(true)`.
   */
  show(): void;
}

/**
 * Creates terminals. The real implementation wraps
 * `vscode.window.createTerminal` and is supplied by the activation layer; the
 * launcher depends only on this interface.
 */
export interface TerminalHost {
  createTerminal(options: CreateTerminalOptions): HostTerminal;
}
