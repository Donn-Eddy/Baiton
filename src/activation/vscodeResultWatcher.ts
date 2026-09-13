/**
 * The `vscode`-backed {@link ResultWatcher} and its factory (task 15.2; design
 * "Result file as the sole completion signal").
 *
 * A launched stage's completion signal is its `result.json` appearing or being
 * rewritten (Req 12.1, 12.7); the terminal closing before any valid result is
 * the `closed` outcome (Req 12.8). In the running extension the first is a
 * `vscode.FileSystemWatcher` scoped to the single result path and the second is
 * `vscode.window.onDidCloseTerminal`. This module binds both to the flow's
 * host-independent {@link ResultWatcher} seam so the run queue can await the
 * outcome without importing `vscode`.
 */
import * as fs from 'fs';
import * as vscode from 'vscode';
import type {
  HostTerminal,
  ResultWatcher,
  ResultWatcherFactory,
  Unsubscribe,
} from '../engine';
import type { VscodeBackedTerminal } from './vscodeTerminalHost';

/** Whether a host terminal carries an underlying `vscode.Terminal`. */
function isVscodeBacked(
  terminal: HostTerminal,
): terminal is VscodeBackedTerminal {
  return (
    typeof (terminal as { raw?: unknown }).raw === 'object' &&
    (terminal as { raw?: unknown }).raw !== null
  );
}

/**
 * A {@link ResultWatcher} over one run's `result.json` and its terminal. The
 * file watcher fires `onResult` on create and change (Req 12.1, 12.7), reading
 * the current file contents for the listener to parse and validate. The
 * terminal-close listener fires `onTerminalClose` when the run's own terminal
 * is closed (Req 12.8).
 */
class VscodeResultWatcher implements ResultWatcher {
  private readonly fileWatcher: vscode.FileSystemWatcher;
  private readonly closeSub: vscode.Disposable;
  private readonly resultListeners = new Set<(raw: string) => void>();
  private readonly closeListeners = new Set<(code: number | undefined) => void>();
  private disposed = false;

  constructor(resultPath: string, ownTerminal: vscode.Terminal | undefined) {
    // Scope the watcher to exactly the run's result.json (Req 12.1).
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(resultPath);
    const onChange = (): void => this.emitResult(resultPath);
    this.fileWatcher.onDidCreate(onChange);
    this.fileWatcher.onDidChange(onChange);

    // A close of this run's own terminal drives the `closed` outcome (Req 12.8).
    this.closeSub = vscode.window.onDidCloseTerminal((closed) => {
      if (ownTerminal !== undefined && closed !== ownTerminal) {
        return;
      }
      const code = closed.exitStatus?.code;
      for (const listener of [...this.closeListeners]) {
        listener(code);
      }
    });
  }

  onResult(listener: (rawContents: string) => void): Unsubscribe {
    this.resultListeners.add(listener);
    return () => this.resultListeners.delete(listener);
  }

  onTerminalClose(listener: (exitCode: number | undefined) => void): Unsubscribe {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    this.fileWatcher.dispose();
    this.closeSub.dispose();
    this.resultListeners.clear();
    this.closeListeners.clear();
  }

  /** Read the result file and hand its contents to each result listener. */
  private emitResult(resultPath: string): void {
    let raw: string;
    try {
      raw = fs.readFileSync(resultPath, 'utf8');
    } catch {
      // A create/change event may race the file's finalization; a rewrite will
      // fire another event the flow re-validates (Req 12.7).
      return;
    }
    for (const listener of [...this.resultListeners]) {
      listener(raw);
    }
  }
}

/**
 * Build a {@link ResultWatcherFactory} that creates `vscode`-backed watchers.
 * The queue passes the run's `resultPath` and its {@link HostTerminal}; when the
 * terminal is a live `vscode.Terminal` its close event is matched to this run so
 * an unrelated terminal closing does not resolve the outcome.
 */
export function createVscodeResultWatcherFactory(): ResultWatcherFactory {
  return {
    create(input: {
      slug: string;
      runId: string;
      resultPath: string;
      terminal: HostTerminal;
    }): ResultWatcher {
      const ownTerminal = isVscodeBacked(input.terminal)
        ? input.terminal.raw
        : undefined;
      return new VscodeResultWatcher(input.resultPath, ownTerminal);
    },
  };
}
