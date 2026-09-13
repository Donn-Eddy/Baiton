/**
 * The `Baiton: Set Orchestrator API Key` command handler (task 13.2; design
 * "Set API Key").
 *
 * This is thin `vscode` glue that prompts for the orchestrator API key with a
 * masked (password) input and persists it to VS Code SecretStorage under the
 * key the Model_Client reads (`baiton.orchestrator.apiKey`). It never reveals
 * the stored value in any message (Req 17.2, 17.3, 17.4).
 *
 * The handler is defensive about the several ways a prompt can end:
 *  - Cancel (the user dismisses the box): the stored key is left unchanged and
 *    no confirmation is shown (Req 17.5).
 *  - Empty / whitespace-only submit: the stored key is left unchanged and a
 *    "no value provided" message is shown (Req 17.6).
 *  - Write failure: any previously stored key is left unchanged and an error
 *    message is shown (Req 17.7).
 */
import * as vscode from 'vscode';

/**
 * The SecretStorage key under which the orchestrator API key is stored. This is
 * the same key the Model_Client configuration reads via `context.secrets`, so
 * writing here makes the key immediately available to the Tool_Loop.
 */
export const API_KEY_SECRET = 'baiton.orchestrator.apiKey';

/** The prompt title/label shown in the masked input box (Req 17.2). */
export const API_KEY_PROMPT = 'Enter your Baiton orchestrator API key';

/** Confirmation shown after a successful write, revealing no value (Req 17.4). */
export const API_KEY_SAVED_MESSAGE = 'Baiton: the orchestrator API key was saved.';

/** Message shown when the submitted value has no non-whitespace character (Req 17.6). */
export const API_KEY_NO_VALUE_MESSAGE = 'Baiton: no value provided; the API key was left unchanged.';

/** Error message shown when the SecretStorage write fails (Req 17.7). */
export const API_KEY_SAVE_FAILED_MESSAGE = 'Baiton: the orchestrator API key could not be saved.';

/**
 * Prompt for the orchestrator API key and store it in SecretStorage.
 *
 * On a submit with at least one non-whitespace character, the trimmed value is
 * written to `baiton.orchestrator.apiKey` and a confirmation is shown that does
 * not reveal the value (Req 17.3, 17.4). Cancelling the prompt (an `undefined`
 * result) leaves the key untouched with no message (Req 17.5). An empty or
 * whitespace-only submit leaves the key untouched and reports that no value was
 * provided (Req 17.6). If the write throws, any previous key is left unchanged
 * and an error is surfaced (Req 17.7).
 *
 * @param secrets The VS Code SecretStorage to write the key into. Passed in so
 *   the handler is testable without a running host.
 */
export async function setOrchestratorApiKey(
  secrets: vscode.SecretStorage,
): Promise<void> {
  const input = await vscode.window.showInputBox({
    prompt: API_KEY_PROMPT,
    password: true,
    ignoreFocusOut: true,
  });

  // Cancel: the input box was dismissed. Leave the stored key unchanged and
  // show nothing (Req 17.5).
  if (input === undefined) {
    return;
  }

  // Empty / whitespace-only submit: nothing meaningful to store. Leave the key
  // unchanged and report that no value was provided (Req 17.6).
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    void vscode.window.showWarningMessage(API_KEY_NO_VALUE_MESSAGE);
    return;
  }

  try {
    await secrets.store(API_KEY_SECRET, trimmed);
  } catch {
    // Write failure: any previously stored key is untouched by a failed store.
    // Surface an error and do not confirm a save (Req 17.7).
    void vscode.window.showErrorMessage(API_KEY_SAVE_FAILED_MESSAGE);
    return;
  }

  // Success: confirm without revealing the stored value (Req 17.4).
  void vscode.window.showInformationMessage(API_KEY_SAVED_MESSAGE);
}
