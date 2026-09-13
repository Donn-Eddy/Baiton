/**
 * A fake `vscode` module for host-free unit tests (Task 13.3).
 *
 * The extension source imports `vscode` as a bare specifier, but there is no
 * requireable `vscode` runtime outside a running VS Code host. `vscodeLoader.mjs`
 * redirects that bare specifier to this module so glue code such as
 * `setOrchestratorApiKey` can be exercised without a host.
 *
 * The module is stateless: each `window` function delegates to the mutable fake
 * a test installs on `globalThis.__vscodeFake`. Delegating (rather than closing
 * over state) lets a test swap the fake between cases while this module stays a
 * singleton in the loader graph.
 */

/** The live fake a test has installed, or a throwing guard when none is set. */
function fake() {
  const installed = globalThis.__vscodeFake;
  if (!installed) {
    throw new Error('No vscode fake installed on globalThis.__vscodeFake');
  }
  return installed;
}

export const window = {
  showInputBox: (options) => fake().window.showInputBox(options),
  showInformationMessage: (message) => fake().window.showInformationMessage(message),
  showWarningMessage: (message) => fake().window.showWarningMessage(message),
  showErrorMessage: (message) => fake().window.showErrorMessage(message),
};
