/**
 * The user-facing error/notification surface for the VS Code command layer
 * (task 15.2; design "Error Handling").
 *
 * The design routes every error to the channel closest to the user's action:
 * chat tool results for orchestrator calls, notifications for command failures,
 * and a single output channel for the running log. This module owns the shared
 * output channel and the notification helpers the command wiring uses so
 * probe-failure, invalid-result, git, and recovery errors are surfaced
 * consistently and never silently swallowed (Req 5.3, 10.3, 14.5, 19.1).
 *
 * It is the one place in the wiring layer that imports `vscode` for
 * user-visible output, kept thin so the pure cores stay host-independent.
 *
 * Surface also owns a second, silent 'API' channel that records one line per
 * failed outbound API call through the host-free `createApiLog`, and nothing on
 * that path reveals the channel or notifies.
 */
import * as vscode from 'vscode';
import type { DispatchError } from '../engine';
import { createApiLog, type ApiFailureEntry, type ApiLog } from '../orchestrator/apiLog';

/** The display name of the shared Baiton output channel. */
const OUTPUT_CHANNEL_NAME = 'Baiton';

/** The display name of the silent API-failure output channel. */
export const API_CHANNEL_NAME = 'API';

/**
 * A thin façade over a `vscode.OutputChannel` plus notification helpers. One
 * instance is created at activation and shared by every command handler, the
 * run-queue reporter, the result-validation reporter, and crash recovery so all
 * of them log to the same running log and raise notifications the same way.
 */
export class Surface {
  private readonly channel: vscode.OutputChannel;
  private readonly apiChannel: vscode.OutputChannel;
  public readonly apiLog: ApiLog;

  constructor(channel?: vscode.OutputChannel, apiChannel?: vscode.OutputChannel) {
    this.channel =
      channel ?? vscode.window.createOutputChannel(OUTPUT_CHANNEL_NAME);
    this.apiChannel =
      apiChannel ?? vscode.window.createOutputChannel(API_CHANNEL_NAME);
    this.apiLog = createApiLog((line) => this.apiChannel.appendLine(line));
  }

  /** The underlying channel, so activation can register it for disposal. */
  public get outputChannel(): vscode.OutputChannel {
    return this.channel;
  }

  /** The API-failure channel, so activation can register it for disposal. */
  public get apiOutputChannel(): vscode.OutputChannel {
    return this.apiChannel;
  }

  /** Record one failed outbound API call on the silent API channel. Never reveals the channel or raises a notification. */
  public logApiFailure(entry: ApiFailureEntry): void {
    this.apiLog.failure(entry);
  }

  /** Append a timestamped line to the running log (design "output channel"). */
  public log(message: string): void {
    const ts = new Date().toISOString();
    this.channel.appendLine(`[${ts}] ${message}`);
  }

  /** Log an informational line and raise an information notification. */
  public info(message: string): void {
    this.log(message);
    void vscode.window.showInformationMessage(message);
  }

  /** Log a warning line and raise a warning notification (Req 14.5, 19.1). */
  public warn(message: string): void {
    this.log(`WARN: ${message}`);
    void vscode.window.showWarningMessage(message);
  }

  /** Log an error line and raise an error notification (design "notifications"). */
  public error(message: string): void {
    this.log(`ERROR: ${message}`);
    void vscode.window.showErrorMessage(message);
  }

  /**
   * Surface a run-queue {@link DispatchError} through the channel closest to the
   * user's action (design "Error Handling"). Probe failure, invalid result,
   * git-state drift, a non-zero reset, an unsupported configured agent, and the
   * other refusal kinds are logged to the running log and raised as a
   * notification whose severity matches the kind: a hard halt
   * (probe/launch/reset/git/unknown-agent) is an error; a guard refusal
   * (busy/blocked/not-approved/illegal/dirty/input-rev/outcome) is a warning
   * the user can act on (Req 5.3, 10.3, 14.5, 19.1).
   */
  public reportDispatchError(error: DispatchError): void {
    const message = `Baiton: ${error.message}`;
    if (isHardHalt(error.kind)) {
      this.error(message);
    } else {
      this.warn(message);
    }
  }
}

/**
 * Whether a dispatch error kind is a hard halt (surfaced as an error) rather
 * than a recoverable guard refusal (surfaced as a warning).
 */
function isHardHalt(kind: DispatchError['kind']): boolean {
  switch (kind) {
    case 'probe-failed':
    case 'launch-failed':
    case 'reset-failed':
    case 'git-state-changed':
    case 'spec-write-failed':
    case 'unknown-agent':
      return true;
    default:
      return false;
  }
}
