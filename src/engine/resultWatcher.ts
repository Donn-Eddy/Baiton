/**
 * The Result_File watcher seam (Requirement 12.1, 12.7).
 *
 * The extension watches a run's `result.json` as the sole completion signal for
 * a stage (design "Result file as the sole completion signal"). In the running
 * extension that is a `vscode.FileSystemWatcher` scoped to the single result
 * path, plus the terminal-close event from `vscode.window.onDidCloseTerminal`.
 * Neither may be a hard dependency of the flow logic, so both are abstracted
 * behind this seam: the activation layer wires the real `vscode`-backed
 * implementation later, and tests drive file-appearance, rewrite, and
 * terminal-close events directly.
 *
 * A {@link ResultWatcher} reports three events for one run:
 *
 *   - `onResult`      — the `result.json` appeared or was rewritten (Req 12.1,
 *                       12.7). The listener re-reads and re-validates each time.
 *   - `onTerminalClose` — the sub-agent's terminal closed (Req 12.8). If no
 *                       valid result has landed, the outcome is `closed`.
 *   - `dispose`       — tear down both subscriptions; called once the run
 *                       reaches a terminal outcome.
 */

/** A cancellable subscription; calling it removes the listener. */
export type Unsubscribe = () => void;

/**
 * Watches exactly one run's `result.json` and its terminal. Implementations
 * must fire `onResult` on both the file's first appearance and every rewrite
 * (Req 12.1, 12.7), and `onTerminalClose` when the terminal is disposed or its
 * process exits (Req 12.8).
 */
export interface ResultWatcher {
  /**
   * Register a listener for the result file appearing or being rewritten. The
   * listener receives the raw file contents to parse and validate.
   */
  onResult(listener: (rawContents: string) => void): Unsubscribe;

  /**
   * Register a listener for the terminal closing. The listener receives the
   * process exit code when the host reports one, otherwise `undefined`.
   */
  onTerminalClose(listener: (exitCode: number | undefined) => void): Unsubscribe;

  /** Tear down both subscriptions. Idempotent. */
  dispose(): void;
}
