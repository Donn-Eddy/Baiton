import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig } from '../src/config/loadConfig';
import { initialize } from '../src/config/initialize';
import { defaultConfig, defaultConfigJson } from '../src/config/defaultConfig';
import { GITIGNORE_CONTENTS } from '../src/config/gitignore';
import { SUPPORTED_VERSION } from '../src/config/types';
import { isErr, isOk } from '../src/model/result';

/**
 * Unit tests for the config service and the Initialize command (Task 5.5).
 *
 * Everything runs against a throwaway `.baiton/`-style directory under
 * `os.tmpdir()` so the tests exercise the real Node `fs` paths without a VS
 * Code host. Each test allocates its own temp directory and every directory is
 * removed afterwards.
 *
 * Coverage:
 * - loadConfig version gating (newer refused, older with no migration path
 *   failing while leaving the file unchanged) — Req 2.5, 2.6, 2.8.
 * - loadConfig absent / unparseable / missing-section naming — Req 2.7, 25.1.
 * - initialize not overwriting an existing config.json while still ensuring
 *   `.gitignore` — Req 1.3.
 * - initialize rolling back its own creations on a write failure and preserving
 *   a pre-existing config.json — Req 1.5.
 */

/** Build a config document object at a given version with valid sections. */
function configDoc(version: number): Record<string, unknown> {
  const base = defaultConfig();
  return { ...base, version };
}

/** Serialize a config document to the two-space JSON the loader reads. */
function configJson(doc: Record<string, unknown>): string {
  return `${JSON.stringify(doc, null, 2)}\n`;
}

describe('config service and Initialize command (Task 5.5)', () => {
  const dirs: string[] = [];

  /** Allocate a fresh temp directory registered for cleanup. */
  function newDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-config-'));
    dirs.push(dir);
    return dir;
  }

  /** Write `config.json` into `baitonDir`, creating the directory as needed. */
  function writeConfig(baitonDir: string, contents: string): void {
    fs.mkdirSync(baitonDir, { recursive: true });
    fs.writeFileSync(path.join(baitonDir, 'config.json'), contents, 'utf8');
  }

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('loadConfig version gating (Req 2.5, 2.6, 2.8)', () => {
    it('refuses a newer version as version-too-new and leaves the file unchanged', async () => {
      const dir = newDir();
      const configPath = path.join(dir, 'config.json');
      const original = configJson(configDoc(SUPPORTED_VERSION + 1));
      writeConfig(dir, original);

      const result = await loadConfig(dir);

      assert.ok(isErr(result), 'a newer version should be refused');
      assert.strictEqual(result.error.kind, 'version-too-new');
      if (result.error.kind === 'version-too-new') {
        assert.strictEqual(result.error.found, SUPPORTED_VERSION + 1);
        assert.strictEqual(result.error.supported, SUPPORTED_VERSION);
        // The message should point the user at a newer extension build.
        assert.ok(
          /version/i.test(result.error.message),
          'message should mention the version mismatch',
        );
      }
      // Req 2.5: the config file is left unchanged.
      assert.strictEqual(fs.readFileSync(configPath, 'utf8'), original);
    });

    it('fails migration for an older version with no upgrade path and leaves the file unchanged', async function () {
      // The migration path is only reachable for a positive-integer version
      // strictly below the supported one. When the supported version is 1 there
      // is no such value (version 0 is rejected earlier as invalid), so there is
      // nothing to migrate; skip rather than assert an unreachable branch.
      const olderVersion = SUPPORTED_VERSION - 1;
      if (olderVersion < 1) {
        this.skip();
      }

      const dir = newDir();
      const configPath = path.join(dir, 'config.json');
      // No migration step is registered for this version, so migration fails.
      const original = configJson(configDoc(olderVersion));
      writeConfig(dir, original);

      const result = await loadConfig(dir);

      assert.ok(isErr(result), 'an un-migratable older version should be refused');
      assert.strictEqual(result.error.kind, 'migration-failed');
      if (result.error.kind === 'migration-failed') {
        assert.strictEqual(result.error.from, olderVersion);
      }
      // Req 2.8: the original file is left byte-for-byte unchanged.
      assert.strictEqual(fs.readFileSync(configPath, 'utf8'), original);
    });

    it('rejects version 0 as invalid before reaching migration and leaves the file unchanged', async () => {
      const dir = newDir();
      const configPath = path.join(dir, 'config.json');
      // Version 0 is not a supported positive integer, so it is refused as an
      // invalid version and the file is left untouched (Req 23.6, 2.8-style).
      const original = configJson(configDoc(0));
      writeConfig(dir, original);

      const result = await loadConfig(dir);

      assert.ok(isErr(result), 'version 0 should be refused');
      assert.strictEqual(result.error.kind, 'invalid-version');
      assert.strictEqual(fs.readFileSync(configPath, 'utf8'), original);
    });

    it('rejects a non-integer / absent version as invalid-version', async () => {
      const dir = newDir();
      const doc = configDoc(SUPPORTED_VERSION);
      delete doc.version;
      writeConfig(dir, configJson(doc));

      const result = await loadConfig(dir);

      assert.ok(isErr(result), 'a config with no version should be refused');
      assert.strictEqual(result.error.kind, 'invalid-version');
    });

    it('loads a valid current-version config and pins version to the supported value', async () => {
      const dir = newDir();
      writeConfig(dir, defaultConfigJson());

      const result = await loadConfig(dir);

      assert.ok(isOk(result), 'a valid default config should load');
      if (isOk(result)) {
        assert.strictEqual(result.value.version, SUPPORTED_VERSION);
        assert.ok(result.value.roles.planner, 'planner role should be present');
        assert.strictEqual(result.value.limits.exec_attempts, 3);
        assert.strictEqual(result.value.git.remote, 'origin');
      }
    });
  });

  describe('loadConfig role fallbacks', () => {
    it('fills a missing "spec-writer" entry from the planner so older configs still load', async () => {
      const dir = newDir();
      const doc = configDoc(SUPPORTED_VERSION) as { roles: Record<string, unknown> };
      doc.roles = { ...doc.roles };
      doc.roles.planner = { agent: 'claude', model: 'planner-model', effort: 'high' };
      delete doc.roles['spec-writer'];
      writeConfig(dir, configJson(doc as unknown as Record<string, unknown>));

      const result = await loadConfig(dir);

      assert.ok(isOk(result), 'a config without a spec-writer entry should still load');
      if (isOk(result)) {
        assert.deepStrictEqual(result.value.roles['spec-writer'], {
          agent: 'claude',
          model: 'planner-model',
          effort: 'high',
        });
      }
    });

    it('prefers an explicit "spec-writer" entry over the planner fallback', async () => {
      const dir = newDir();
      const doc = configDoc(SUPPORTED_VERSION) as { roles: Record<string, unknown> };
      doc.roles = { ...doc.roles, 'spec-writer': { agent: 'claude', model: 'writer-model' } };
      writeConfig(dir, configJson(doc as unknown as Record<string, unknown>));

      const result = await loadConfig(dir);

      assert.ok(isOk(result));
      if (isOk(result)) {
        assert.strictEqual(result.value.roles['spec-writer'].model, 'writer-model');
      }
    });

    it('still reports a missing section when the fallback source is absent too', async () => {
      const dir = newDir();
      const doc = configDoc(SUPPORTED_VERSION) as { roles: Record<string, unknown> };
      doc.roles = { ...doc.roles };
      delete doc.roles['spec-writer'];
      delete doc.roles.planner;
      writeConfig(dir, configJson(doc as unknown as Record<string, unknown>));

      const result = await loadConfig(dir);

      assert.ok(isErr(result), 'no fallback source means the role is genuinely missing');
    });
  });

  describe('loadConfig absent / unparseable / missing-section (Req 2.7, 25.1)', () => {
    it('reports an absent config when no file exists', async () => {
      const dir = newDir();

      const result = await loadConfig(dir);

      assert.ok(isErr(result), 'a missing config should be refused');
      assert.strictEqual(result.error.kind, 'absent');
      if (result.error.kind === 'absent') {
        assert.ok(
          result.error.path.endsWith(path.join(dir, 'config.json')) ||
            result.error.path === path.join(dir, 'config.json'),
          'the error should name the expected config path',
        );
      }
    });

    it('reports unparseable JSON', async () => {
      const dir = newDir();
      writeConfig(dir, '{ this is not : valid json');

      const result = await loadConfig(dir);

      assert.ok(isErr(result), 'malformed JSON should be refused');
      assert.strictEqual(result.error.kind, 'unparseable');
    });

    it('names the missing "roles" section', async () => {
      const dir = newDir();
      const doc = configDoc(SUPPORTED_VERSION);
      delete doc.roles;
      writeConfig(dir, configJson(doc));

      const result = await loadConfig(dir);

      assert.ok(isErr(result), 'a config missing roles should be refused');
      assert.strictEqual(result.error.kind, 'missing-section');
      if (result.error.kind === 'missing-section') {
        assert.strictEqual(result.error.section, 'roles');
        assert.ok(
          /roles/.test(result.error.message),
          'the message should name the offending section',
        );
      }
    });

    it('names the missing "limits" section', async () => {
      const dir = newDir();
      const doc = configDoc(SUPPORTED_VERSION);
      delete doc.limits;
      writeConfig(dir, configJson(doc));

      const result = await loadConfig(dir);

      assert.ok(isErr(result), 'a config missing limits should be refused');
      assert.strictEqual(result.error.kind, 'missing-section');
      if (result.error.kind === 'missing-section') {
        assert.strictEqual(result.error.section, 'limits');
      }
    });

    it('names the missing "git" section', async () => {
      const dir = newDir();
      const doc = configDoc(SUPPORTED_VERSION);
      delete doc.git;
      writeConfig(dir, configJson(doc));

      const result = await loadConfig(dir);

      assert.ok(isErr(result), 'a config missing git should be refused');
      assert.strictEqual(result.error.kind, 'missing-section');
      if (result.error.kind === 'missing-section') {
        assert.strictEqual(result.error.section, 'git');
      }
    });
  });

  describe('initialize no-overwrite of existing config.json (Req 1.3)', () => {
    it('leaves an existing config.json untouched but still ensures .gitignore', async () => {
      const dir = newDir();
      const baitonDir = path.join(dir, '.baiton');
      const existing = configJson({ ...configDoc(SUPPORTED_VERSION), custom: 'user-value' });
      writeConfig(baitonDir, existing);

      const result = await initialize(baitonDir);

      assert.ok(isOk(result), 'initialize should succeed with an existing config');
      if (isOk(result)) {
        // Req 1.3: it did not create/overwrite the config.
        assert.strictEqual(result.value.createdConfig, false);
        assert.strictEqual(result.value.ensuredGitignore, true);
      }
      // The user's config is byte-for-byte preserved.
      assert.strictEqual(
        fs.readFileSync(path.join(baitonDir, 'config.json'), 'utf8'),
        existing,
      );
      // .gitignore is ensured with the required exclusions.
      const gitignore = fs.readFileSync(path.join(baitonDir, '.gitignore'), 'utf8');
      assert.strictEqual(gitignore, GITIGNORE_CONTENTS);
      // The runs/ and specs/ directories exist.
      assert.ok(fs.existsSync(path.join(baitonDir, 'runs')), 'runs/ should exist');
      assert.ok(fs.existsSync(path.join(baitonDir, 'specs')), 'specs/ should exist');
    });

    it('writes a default config.json on a fresh directory', async () => {
      const dir = newDir();
      const baitonDir = path.join(dir, '.baiton');

      const result = await initialize(baitonDir);

      assert.ok(isOk(result), 'initialize should succeed on a fresh directory');
      if (isOk(result)) {
        assert.strictEqual(result.value.createdConfig, true);
        assert.strictEqual(result.value.ensuredGitignore, true);
      }
      assert.strictEqual(
        fs.readFileSync(path.join(baitonDir, 'config.json'), 'utf8'),
        defaultConfigJson(),
      );
    });
  });

  describe('initialize rollback on a write failure (Req 1.5)', () => {
    it('rolls back its own creations and preserves a pre-existing config.json', async () => {
      const dir = newDir();
      const baitonDir = path.join(dir, '.baiton');
      const existing = configJson({ ...configDoc(SUPPORTED_VERSION), custom: 'user-value' });
      writeConfig(baitonDir, existing);

      // Force the `.gitignore` write to fail by making a directory sit exactly
      // where the file must go, so `fs.writeFile` cannot create it. This
      // triggers the write-failed / rollback path while a config.json already
      // exists (Req 1.5).
      const gitignorePath = path.join(baitonDir, '.gitignore');
      fs.mkdirSync(gitignorePath, { recursive: true });

      const result = await initialize(baitonDir);

      assert.ok(isErr(result), 'a write failure should be surfaced');
      assert.strictEqual(result.error.kind, 'write-failed');
      // Req 1.5: the pre-existing config.json is preserved unchanged.
      assert.strictEqual(
        fs.readFileSync(path.join(baitonDir, 'config.json'), 'utf8'),
        existing,
      );
    });

    it('rolls back created directories and files when a write fails on a fresh tree', async function () {
      // Root-owned processes ignore the read-only bit, so this simulation of a
      // write failure is meaningless when running as root; skip it there.
      if (typeof process.getuid === 'function' && process.getuid() === 0) {
        this.skip();
      }

      const dir = newDir();
      const baitonDir = path.join(dir, '.baiton');
      // Pre-create the .baiton directory and make it read-only so writing
      // .gitignore inside it fails, exercising the rollback path on a tree with
      // no pre-existing config.json.
      fs.mkdirSync(baitonDir, { recursive: true });
      const originalMode = fs.statSync(baitonDir).mode;
      fs.chmodSync(baitonDir, 0o500); // r-x------: cannot create children

      try {
        const result = await initialize(baitonDir);

        assert.ok(isErr(result), 'the blocked write should be surfaced');
        assert.strictEqual(result.error.kind, 'write-failed');
      } finally {
        // Restore write permission so cleanup (and any created children) works.
        fs.chmodSync(baitonDir, originalMode);
      }

      // No config was ever written, and rollback removed anything this
      // invocation created inside the directory.
      assert.strictEqual(
        fs.existsSync(path.join(baitonDir, 'config.json')),
        false,
        'no config.json should have been created',
      );
      assert.strictEqual(
        fs.existsSync(path.join(baitonDir, '.gitignore')),
        false,
        '.gitignore created this invocation should be rolled back',
      );
    });
  });
});
