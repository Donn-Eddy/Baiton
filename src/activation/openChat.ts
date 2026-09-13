/**
 * The `Baiton: Open Chat` command handler (task 13.1; design "Baiton
 * container, views and Open Chat command").
 *
 * This is thin `vscode` glue that reveals the Baiton_Container and moves
 * keyboard focus to the Chat_View using only stable VS Code APIs. VS Code
 * auto-registers a `<viewId>.focus` command for every contributed view, so
 * focusing the webview view is done through the stable
 * `baiton.chatView.focus` command — no internal or non-stable relocation
 * command is used (Req 1.3, 1.5).
 *
 * When the Chat_View (or its container) is not yet registered, the auto-focus
 * command is absent and executing it rejects; this handler contains that
 * rejection so the command completes without throwing and surfaces a
 * user-visible notification that the Chat_View is not available (Req 1.4).
 */
import * as vscode from 'vscode';

/**
 * The stable, VS-Code-generated focus command for the contributed Chat_View
 * (`baiton.chatView`). Executing it reveals the Baiton_Container and moves
 * keyboard focus into the view.
 */
export const CHAT_VIEW_FOCUS_COMMAND = 'baiton.chatView.focus';

/** The notification shown when the Chat_View is not registered (Req 1.4). */
export const CHAT_VIEW_UNAVAILABLE_MESSAGE =
  'Baiton: the Chat view is not available.';

/**
 * Reveal the Baiton_Container and focus the Chat_View.
 *
 * On success VS Code brings the container into view and moves keyboard focus to
 * the webview view. If the view is not yet registered — for example before its
 * provider is wired — the focus command is unknown and rejects; we swallow that
 * rejection, complete normally, and raise an information notification so the
 * user learns the view is unavailable rather than seeing an unhandled error
 * (Req 1.3, 1.4, 1.5).
 */
export async function openChat(): Promise<void> {
  try {
    await vscode.commands.executeCommand(CHAT_VIEW_FOCUS_COMMAND);
  } catch {
    void vscode.window.showInformationMessage(CHAT_VIEW_UNAVAILABLE_MESSAGE);
  }
}
