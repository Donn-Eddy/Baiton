/**
 * An ESM customization hook that redirects the bare `vscode` specifier to the
 * in-repo fake module (Task 13.3).
 *
 * The extension source under `src/activation/` imports `vscode`, which only
 * resolves inside a running VS Code host. Registering this hook (via
 * `module.register`) before importing such glue lets host-free unit tests load
 * it with a controllable fake standing in for the host surface.
 *
 * Only the exact bare specifier `vscode` is redirected; every other specifier
 * falls through to the default resolver unchanged.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const fakeUrl = pathToFileURL(
  join(dirname(fileURLToPath(import.meta.url)), 'vscodeFake.mjs'),
).href;

export async function resolve(specifier, context, nextResolve) {
  if (specifier === 'vscode') {
    return { url: fakeUrl, shortCircuit: true };
  }
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    // A dynamic import of an extensionless relative TypeScript module (as the
    // test uses to load the handler) is not resolved with a `.ts` extension by
    // the default resolver. Retry with the extension so the test source can
    // stay extensionless and still compile under the project's CommonJS tsc.
    if (
      (specifier.startsWith('./') || specifier.startsWith('../')) &&
      !/\.[cm]?[jt]s$/.test(specifier)
    ) {
      return await nextResolve(`${specifier}.ts`, context);
    }
    throw error;
  }
}
