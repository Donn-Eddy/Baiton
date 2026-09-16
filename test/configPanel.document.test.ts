import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ABSENT_TOKEN,
  configToken,
  readConfigDocument,
  readConfigToken,
  writeConfigDocument,
} from '../src/config/configDocument';
import { configFilePath, loadConfig } from '../src/config/loadConfig';
import { defaultConfigJson } from '../src/config/defaultConfig';
import { LIMIT_BOUNDS } from '../src/config/types';
import { isErr, isOk } from '../src/model/result';
import { applyFormToDocument, formFromDocument, validateConfigForm } from '../src/config/configPanel';
import { agentCapabilities, createAdapterRegistry } from '../src/adapter';

/**
 * Unit tests for the Config Panel document I/O (spec "Config Panel",
 * config-panel T03): reading and classifying `config.json`
 * (`readConfigDocument`), the lightweight token read (`readConfigToken`), the
 * conflict-guarded write (`writeConfigDocument`), and an end-to-end path
 * through the host-free core down to `loadConfig`.
 *
 * Everything runs against a throwaway directory under `os.tmpdir()` playing
 * the role of `.baiton/`, following the style of test/config.test.ts.
 */

describe('config panel document I/O (config-panel T03)', () => {
  const dirs: string[] = [];

  /** Allocate a fresh temp directory registered for cleanup. */
  function newDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-config-doc-'));
    dirs.push(dir);
    return dir;
  }

  /** Write `config.json` into `dir`, creating the directory as needed. */
  function writeConfig(dir: string, text: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'config.json'), text, 'utf8');
  }

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('readConfigDocument classification', () => {
    it('reports "absent" for a missing file', async () => {
      const dir = newDir();
      const result = await readConfigDocument(dir);
      assert.ok(isErr(result));
      if (isErr(result)) {
        assert.strictEqual(result.error.kind, 'absent');
        assert.strictEqual(result.error.path, configFilePath(dir));
        assert.ok(result.error.message.includes(configFilePath(dir)));
        assert.ok(result.error.message.includes('Baiton: Initialize'));
      }
    });

    it('reports "unparseable" for malformed JSON', async () => {
      const dir = newDir();
      writeConfig(dir, '{ bad json');
      const result = await readConfigDocument(dir);
      assert.ok(isErr(result));
      if (isErr(result)) {
        assert.strictEqual(result.error.kind, 'unparseable');
        assert.ok(result.error.message.includes(configFilePath(dir)));
      }
    });

    it('reports "unparseable" for a parsed non-object root', async () => {
      // Deliberately diverges from loadConfig, which reports a non-object root
      // as missing-section: root (T02's documented decision); T05 must not
      // expect a missing-section here.
      for (const text of ['[]', 'null', '42', '"text"']) {
        const dir = newDir();
        writeConfig(dir, text);
        const result = await readConfigDocument(dir);
        assert.ok(isErr(result));
        if (isErr(result)) {
          assert.strictEqual(result.error.kind, 'unparseable');
          assert.ok(result.error.message.includes('must be a JSON object'));
        }
      }
    });

    it('reads a valid document with exact text, doc, path and a matching token', async () => {
      const dir = newDir();
      const text = defaultConfigJson();
      writeConfig(dir, text);

      const result = await readConfigDocument(dir);

      assert.ok(isOk(result));
      if (isOk(result)) {
        assert.strictEqual(result.value.text, fs.readFileSync(path.join(dir, 'config.json'), 'utf8'));
        assert.deepStrictEqual(result.value.doc, JSON.parse(defaultConfigJson()));
        assert.strictEqual(result.value.path, configFilePath(dir));
        assert.match(result.value.token, /^[0-9a-f]{64}$/);
        assert.strictEqual(result.value.token, configToken(text));
      }
    });

    it('token is stable across unchanged reads and sensitive to whitespace-only changes', async () => {
      const dir = newDir();
      writeConfig(dir, defaultConfigJson());

      const first = await readConfigDocument(dir);
      const second = await readConfigDocument(dir);
      assert.ok(isOk(first) && isOk(second));
      if (isOk(first) && isOk(second)) {
        assert.strictEqual(first.value.token, second.value.token);
      }

      writeConfig(dir, `${defaultConfigJson()}\n`);
      const third = await readConfigDocument(dir);
      assert.ok(isOk(third));
      if (isOk(first) && isOk(third)) {
        assert.notStrictEqual(first.value.token, third.value.token);
      }
    });

    it('accepts a Uri-like { fsPath } as well as a string', async () => {
      const dir = newDir();
      writeConfig(dir, defaultConfigJson());
      const result = await readConfigDocument({ fsPath: dir });
      assert.ok(isOk(result));
    });

    it('reports "io" when the path is unreadable as a file (EISDIR)', async () => {
      const dir = newDir();
      fs.mkdirSync(path.join(dir, 'config.json'));
      const result = await readConfigDocument(dir);
      assert.ok(isErr(result));
      if (isErr(result)) {
        assert.strictEqual(result.error.kind, 'io');
      }
    });
  });

  describe('readConfigToken', () => {
    it('returns ABSENT_TOKEN ("") for a missing file', async () => {
      assert.strictEqual(ABSENT_TOKEN, '');
      const dir = newDir();
      const result = await readConfigToken(dir);
      assert.ok(isOk(result));
      if (isOk(result)) {
        assert.strictEqual(result.value, ABSENT_TOKEN);
      }
    });

    it('matches configToken(text) and readConfigDocument\'s token for a present file', async () => {
      const dir = newDir();
      const text = defaultConfigJson();
      writeConfig(dir, text);

      const tokenResult = await readConfigToken(dir);
      const docResult = await readConfigDocument(dir);
      assert.ok(isOk(tokenResult) && isOk(docResult));
      if (isOk(tokenResult) && isOk(docResult)) {
        assert.strictEqual(tokenResult.value, configToken(text));
        assert.strictEqual(tokenResult.value, docResult.value.token);
      }
    });

    it('still yields a token for an unparseable file', async () => {
      const dir = newDir();
      writeConfig(dir, '{ bad json');
      const result = await readConfigToken(dir);
      assert.ok(isOk(result));
      if (isOk(result)) {
        assert.strictEqual(result.value, configToken('{ bad json'));
      }
    });
  });

  describe('writeConfigDocument', () => {
    it('writes and returns the new token when expectedToken matches', async () => {
      const dir = newDir();
      writeConfig(dir, defaultConfigJson());
      const loaded = await readConfigDocument(dir);
      assert.ok(isOk(loaded));
      if (!isOk(loaded)) {
        return;
      }

      const edited = { ...loaded.value.doc, git: { ...(loaded.value.doc.git as Record<string, unknown>), remote: 'upstream' } };
      const written = await writeConfigDocument(dir, edited, { expectedToken: loaded.value.token });

      assert.ok(isOk(written));
      if (isOk(written)) {
        const onDisk = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
        assert.strictEqual(onDisk, written.value.text);
        const freshToken = await readConfigToken(dir);
        assert.ok(isOk(freshToken));
        if (isOk(freshToken)) {
          assert.strictEqual(written.value.token, configToken(onDisk));
          assert.strictEqual(written.value.token, freshToken.value);
        }
        assert.notStrictEqual(written.value.token, loaded.value.token);
      }
    });

    it('refuses with "conflict" on a stale expectedToken, leaving the file and directory untouched', async () => {
      const dir = newDir();
      writeConfig(dir, defaultConfigJson());
      const loaded = await readConfigDocument(dir);
      assert.ok(isOk(loaded));
      if (!isOk(loaded)) {
        return;
      }

      const externalText = `${defaultConfigJson()}\n`;
      writeConfig(dir, externalText);

      const result = await writeConfigDocument(dir, { ...loaded.value.doc }, { expectedToken: loaded.value.token });

      assert.ok(isErr(result));
      if (isErr(result)) {
        assert.strictEqual(result.error.kind, 'conflict');
        if (result.error.kind === 'conflict') {
          assert.strictEqual(result.error.token, configToken(externalText));
        }
        assert.ok(result.error.message.includes(configFilePath(dir)));
      }
      assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), externalText);
      assert.deepStrictEqual(fs.readdirSync(dir), ['config.json']);
    });

    it('overwrites unconditionally when expectedToken is omitted, even after an external edit', async () => {
      const dir = newDir();
      writeConfig(dir, defaultConfigJson());
      const external = `${defaultConfigJson()}\n`;
      writeConfig(dir, external);

      const result = await writeConfigDocument(dir, JSON.parse(defaultConfigJson()));

      assert.ok(isOk(result));
      assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), defaultConfigJson());
    });

    it('ABSENT_TOKEN succeeds against a missing file and conflicts once a file exists', async () => {
      const dir = newDir();
      fs.mkdirSync(dir, { recursive: true });

      const first = await writeConfigDocument(dir, JSON.parse(defaultConfigJson()), { expectedToken: ABSENT_TOKEN });
      assert.ok(isOk(first));

      const second = await writeConfigDocument(dir, JSON.parse(defaultConfigJson()), { expectedToken: ABSENT_TOKEN });
      assert.ok(isErr(second));
      if (isErr(second)) {
        assert.strictEqual(second.error.kind, 'conflict');
      }
    });

    it('pins serialization to defaultConfigJson(): two-space indent, single trailing newline', async () => {
      const dir = newDir();
      fs.mkdirSync(dir, { recursive: true });

      // This pins writeJsonAtomic's serialization to writeConfigDocument's
      // re-derived text; do not delete as "redundant" with the round-trip
      // tests above — it is the one test that would catch the two drifting
      // apart.
      const result = await writeConfigDocument(dir, JSON.parse(defaultConfigJson()));
      assert.ok(isOk(result));
      if (isOk(result)) {
        assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), defaultConfigJson());
        assert.strictEqual(result.value.text, defaultConfigJson());
      }
    });

    it('returns a structurally-equal but independent doc object', async () => {
      const dir = newDir();
      fs.mkdirSync(dir, { recursive: true });
      const value = JSON.parse(defaultConfigJson());
      const result = await writeConfigDocument(dir, value);
      assert.ok(isOk(result));
      if (isOk(result)) {
        assert.deepStrictEqual(result.value.doc, value);
        (result.value.doc as Record<string, unknown>).mutated = true;
        assert.strictEqual((value as Record<string, unknown>).mutated, undefined);
      }
    });
  });

  describe('end-to-end through the core (the T05 path, without a VS Code host)', () => {
    it('a form that validates yields a document loadConfig accepts, with edits applied and unmanaged keys intact', async () => {
      const dir = newDir();
      const seed = JSON.parse(defaultConfigJson());
      seed.pr = { tool: 'gh' };
      seed.git.verify = 'npm test';
      seed.roles.custom = { agent: 'claude', model: 'x' };
      seed.unknownTop = { keep: true };
      writeConfig(dir, `${JSON.stringify(seed, null, 2)}\n`);

      const loaded = await readConfigDocument(dir);
      assert.ok(isOk(loaded));
      if (!isOk(loaded)) {
        return;
      }

      const form = formFromDocument(loaded.value.doc);
      form.roles.executor.model = 'new-model';
      form.limits.exec_attempts = '5';

      const options = { agents: createAdapterRegistry().ids, byAgent: agentCapabilities() };
      assert.deepStrictEqual(validateConfigForm(form, options), []);

      const next = applyFormToDocument(loaded.value.doc, form);
      const written = await writeConfigDocument(dir, next, { expectedToken: loaded.value.token });
      assert.ok(isOk(written));

      const reRead = await readConfigDocument(dir);
      assert.ok(isOk(reRead));
      if (isOk(reRead)) {
        assert.deepStrictEqual(reRead.value.doc.pr, seed.pr);
        assert.strictEqual((reRead.value.doc.git as Record<string, unknown>).verify, seed.git.verify);
        assert.deepStrictEqual((reRead.value.doc.roles as Record<string, unknown>).custom, seed.roles.custom);
        assert.deepStrictEqual(reRead.value.doc.unknownTop, seed.unknownTop);
        assert.strictEqual((reRead.value.doc.roles as Record<string, Record<string, unknown>>).executor.model, 'new-model');
        assert.strictEqual((reRead.value.doc.limits as Record<string, unknown>).exec_attempts, 5);
      }

      const finalConfig = await loadConfig(dir);
      assert.ok(isOk(finalConfig));
      if (isOk(finalConfig)) {
        assert.strictEqual(finalConfig.value.roles.executor.model, 'new-model');
        assert.strictEqual(finalConfig.value.limits.exec_attempts, 5);
      }
    });

    it('a form the validator rejects produces a document loadConfig refuses', async () => {
      const dir = newDir();
      writeConfig(dir, defaultConfigJson());
      const loaded = await readConfigDocument(dir);
      assert.ok(isOk(loaded));
      if (!isOk(loaded)) {
        return;
      }

      const form = formFromDocument(loaded.value.doc);
      form.limits.exec_attempts = String(LIMIT_BOUNDS.exec_attempts.max + 1);

      const options = { agents: createAdapterRegistry().ids, byAgent: agentCapabilities() };
      const errors = validateConfigForm(form, options);
      assert.ok(errors.length > 0);

      const next = applyFormToDocument(loaded.value.doc, form);
      const written = await writeConfigDocument(dir, next, { expectedToken: loaded.value.token });
      assert.ok(isOk(written));

      const result = await loadConfig(dir);
      assert.ok(isErr(result));
    });
  });
});
