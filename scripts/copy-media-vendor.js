// Dev-only copy step for the vendored webview libraries (task 11.2, Req 19.1,
// 19.2, 19.5). It copies the checked-in pure-JS browser builds from `vendor/`
// into `media/vendor/`, which is where `media/chat.html` loads them from and
// which the Chat webview provider admits via `localResourceRoots`.
//
// This runs under Node during `compile`/`package` (see package.json). It is not
// shipped and adds no runtime or bundler dependency — the alternative of a
// dev-only bundler (esbuild) was deliberately not chosen (see vendor/README.md).
//
// The script is idempotent: it recreates `media/vendor/` from the sources on
// every run and skips non-library files such as this directory's README.
'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const sourceDir = path.join(repoRoot, 'vendor');
const targetDir = path.join(repoRoot, 'media', 'vendor');

// Files under vendor/ that document the vendoring but are not loaded by the
// webview, so they are not copied into the packaged media/.
const skip = new Set(['README.md']);

function isVendoredLib(name) {
  return !skip.has(name) && name.endsWith('.js');
}

function main() {
  if (!fs.existsSync(sourceDir)) {
    console.error(`[copy-media-vendor] source directory not found: ${sourceDir}`);
    process.exit(1);
  }

  fs.mkdirSync(targetDir, { recursive: true });

  const entries = fs
    .readdirSync(sourceDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && isVendoredLib(entry.name));

  if (entries.length === 0) {
    console.error(`[copy-media-vendor] no vendored .js libraries found in ${sourceDir}`);
    process.exit(1);
  }

  for (const entry of entries) {
    const from = path.join(sourceDir, entry.name);
    const to = path.join(targetDir, entry.name);
    fs.copyFileSync(from, to);
    console.log(`[copy-media-vendor] ${path.relative(repoRoot, from)} -> ${path.relative(repoRoot, to)}`);
  }
}

main();
