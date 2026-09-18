/**
 * The `Baiton: Open Config Panel` command handler (spec "Config Panel", config-panel todo T11).
 *
 * This is thin `vscode` glue that reveals the Baiton container and moves
 * keyboard focus to the Configuration view using only stable VS Code APIs. VS Code
 * auto-registers a `<viewId>.focus` command for every contributed view, so
 * focusing the webview view is done through the stable
 * `baiton.configPanel.focus` command — no internal or non-stable relocation
 * command is used.
 *
 * When the Configuration view (or its container) is not yet registered, the auto-focus
 * command is absent and executing it rejects; this handler contains that
 * rejection so the command completes without throwing and surfaces a
 * user-visible notification that the Configuration view is not available.
 */
import * as vscode from 'vscode';

/**
 * The stable, VS-Code-generated focus command for the contributed Configuration view
 * (`baiton.configPanel`). Executing it reveals the Baiton container and moves
 * keyboard focus into the view.
 */
export const CONFIG_VIEW_FOCUS_COMMAND = 'baiton.configPanel.focus';

/** The notification shown when the Configuration view is not registered. */
export const CONFIG_VIEW_UNAVAILABLE_MESSAGE =
  'Baiton: the Configuration view is not available.';

/**
 * Reveal the Baiton container and focus the Configuration view.
 *
 * On success VS Code brings the container into view and moves keyboard focus to
 * the webview view. If the view is not yet registered — for example before its
 * provider is wired — the focus command is unknown and rejects; we swallow that
 * rejection, complete normally, and raise an information notification so the
 * user learns the view is unavailable rather than seeing an unhandled error.
 */
export async function revealConfigPanel(): Promise<void> {
  try {
    await vscode.commands.executeCommand(CONFIG_VIEW_FOCUS_COMMAND);
  } catch {
    void vscode.window.showInformationMessage(CONFIG_VIEW_UNAVAILABLE_MESSAGE);
  }
}
