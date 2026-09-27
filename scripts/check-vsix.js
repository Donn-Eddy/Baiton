// Post-package sanity check for the built vsix (`npm run package:verify`).
//
// A vsix is a zip. This reads its central directory with a minimal reader
// (no dependency, no `unzip` binary) and fails when a file the installed
// extension cannot activate without is missing: the compiled entry point
// named by package.json `main`, and the one production dependency, `ajv`,
// which src/schema/index.ts requires at module load. A vsix packaged with no
// `node_modules` installs cleanly and then fails activation with
// "Cannot find module 'ajv'", so this catches it before anyone installs it.
//
// Usage: node scripts/check-vsix.js [path/to/file.vsix]
// With no argument, the newest *.vsix in the repository root is checked.
'use strict';

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');

// Paths inside the vsix (vsce stores the extension under `extension/`).
const REQUIRED = [
  {
    entry: 'extension/out/src/extension.js',
    why: 'the compiled entry point (package.json "main"); run `npm run compile` before packaging',
  },
  {
    entry: 'extension/node_modules/ajv/package.json',
    why:
      'the production dependency ajv, required at module load; ' +
      'run `npm ci` and package without --no-dependencies',
  },
];

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const EOCD_MIN_SIZE = 22;
const MAX_COMMENT = 0xffff;

function fail(message, code = 1) {
  console.error(`[check-vsix] ${message}`);
  process.exit(code);
}

/** The newest `*.vsix` directly under the repository root, or undefined. */
function newestVsix() {
  const candidates = fs
    .readdirSync(repoRoot, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith('.vsix'))
    .map((entry) => {
      const full = path.join(repoRoot, entry.name);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return candidates.length > 0 ? candidates[0].full : undefined;
}

/**
 * Every entry name in the zip's central directory. Throws on anything this
 * minimal reader does not understand (not a zip, truncated, ZIP64).
 */
function zipEntryNames(buffer) {
  const searchStart = Math.max(0, buffer.length - (EOCD_MIN_SIZE + MAX_COMMENT));
  let eocd = -1;
  for (let i = buffer.length - EOCD_MIN_SIZE; i >= searchStart; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIGNATURE) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error('no end-of-central-directory record: not a zip file');
  }
  const total = buffer.readUInt16LE(eocd + 10);
  const offset = buffer.readUInt32LE(eocd + 16);
  if (total === 0xffff || offset === 0xffffffff) {
    throw new Error('ZIP64 archives are not supported by this checker');
  }
  const names = [];
  let at = offset;
  for (let n = 0; n < total; n++) {
    if (at + 46 > buffer.length || buffer.readUInt32LE(at) !== CENTRAL_HEADER_SIGNATURE) {
      throw new Error(`corrupt central directory at entry ${n}`);
    }
    const nameLength = buffer.readUInt16LE(at + 28);
    const extraLength = buffer.readUInt16LE(at + 30);
    const commentLength = buffer.readUInt16LE(at + 32);
    names.push(buffer.toString('utf8', at + 46, at + 46 + nameLength));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return names;
}

function main() {
  const arg = process.argv[2];
  const vsix = arg !== undefined ? path.resolve(arg) : newestVsix();
  if (vsix === undefined) {
    fail(`no *.vsix found in ${repoRoot}; build one with \`npx @vscode/vsce package\``, 2);
  }
  if (!fs.existsSync(vsix)) {
    fail(`vsix not found: ${vsix}`, 2);
  }

  let names;
  try {
    names = zipEntryNames(fs.readFileSync(vsix));
  } catch (err) {
    fail(`cannot read ${vsix}: ${err instanceof Error ? err.message : String(err)}`, 2);
  }
  const present = new Set(names);
  const missing = REQUIRED.filter((req) => !present.has(req.entry));
  const bundledModules = names.filter((name) => name.startsWith('extension/node_modules/')).length;

  console.log(
    `[check-vsix] ${path.relative(process.cwd(), vsix) || vsix}: ` +
      `${names.length} entries, ${bundledModules} under extension/node_modules/`,
  );
  if (missing.length > 0) {
    for (const req of missing) {
      console.error(`[check-vsix] MISSING ${req.entry} — ${req.why}`);
    }
    fail(`${missing.length} required file(s) missing; this vsix would fail to activate`);
  }
  console.log('[check-vsix] OK: entry point and ajv are bundled');
}

main();
