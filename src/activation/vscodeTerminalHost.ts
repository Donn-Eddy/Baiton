/**
 * The `vscode`-backed {@link TerminalHost} (task 15.2; design "Stage engine").
 *
 * The stage launcher creates a terminal whose own process is the CLI executable
 * (`shellPath`/`shellArgs`) with `cwd` at the workspace root and no intervening
 * shell (Req 11.1, 11.2). In the running extension that is
 * `vscode.window.createTerminal({ name, shellPath, shellArgs, cwd, env })`, with
 * `terminal.dispose()` for teardown and `terminal.processId` recorded in the
 * journal so crash recovery can reconcile it (Req 21.1). This adapter is the one
 * place that binds those `vscode` calls to the launcher's host-independent
 * {@link TerminalHost} seam.
 */
import * as vscode from 'vscode';
import type {
  CreateTerminalOptions,
  HostTerminal,
  TerminalHost,
} from '../engine';

/**
 * A {@link HostTerminal} carrying its underlying `vscode.Terminal` so the
 * result watcher can match the terminal-close event to the run that owns it.
 */
export interface VscodeBackedTerminal extends HostTerminal {
  /** The live `vscode.Terminal` this host terminal wraps. */
  readonly raw: vscode.Terminal;
}

/** A {@link HostTerminal} backed by a live `vscode.Terminal`. */
class VscodeHostTerminal implements VscodeBackedTerminal {
  constructor(public readonly raw: vscode.Terminal) {
    this.terminal = raw;
  }

  private readonly terminal: vscode.Terminal;

  sendText(text: string): void {
    // `addNewLine: true` submits the one-line initial prompt (Req 11.4).
    this.terminal.sendText(text, true);
  }

  dispose(): void {
    this.terminal.dispose();
  }

  show(): void {
    this.terminal.show(true);
  }

  /** The terminal's own process id, for the journal (Req 21.1). */
  get processId(): Promise<number | undefined> {
    return Promise.resolve(this.terminal.processId);
  }
}

/**
 * Create a {@link TerminalHost} that builds real `vscode` terminals. The
 * launcher passes the adapter's `shellPath`/`shellArgs` and the workspace root
 * as `cwd`; `strictEnv: false` merges the optional overrides onto the host
 * environment so the CLI still sees the user's PATH.
 */
export function createVscodeTerminalHost(): TerminalHost {
  return {
    createTerminal(options: CreateTerminalOptions): HostTerminal {
      const terminal = vscode.window.createTerminal({
        name: options.name,
        shellPath: options.shellPath,
        shellArgs: options.shellArgs,
        cwd: options.cwd,
        ...(options.env !== undefined ? { env: options.env } : {}),
      });
      terminal.show(true);
      return new VscodeHostTerminal(terminal);
    },
  };
}
