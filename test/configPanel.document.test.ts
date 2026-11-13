import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ABSENT_TOKEN,
  configToken,
  readBaselineToken,
  readConfigDocument,
  readConfigToken,
  writeConfigDocument,
} from '../src/config/configDocument';
import { configFilePath, localConfigFilePath, loadConfig } from '../src/config/loadConfig';
import { defaultConfigJson } from '../src/config/defaultConfig';
import { LIMIT_BOUNDS } from '../src/config/types';
import { isErr, isOk } from '../src/model/result';
import { applyFormToDocument, formFromDocument, validateConfigForm } from '../src/config/configPanel';
import { agentCapabilities, createAdapterRegistry } from '../src/adapter';

/**
 * Unit tests for the Config Panel document I/O (plan "Config Panel",
 * config-panel ): reading and classifying the merged config layers
 * (`readConfigDocument`), the lightweight token read (`readConfigToken`), the
 * conflict-guarded write (`writeConfigDocument`), and an end-to-end path
 * through the host-free core down to `loadConfig`.
 *
 * Everything runs against a throwaway directory under `os.tmpdir()` playing
 * the role of `.baiton/`, following the style of test/config.test.ts.
 */

describe('config panel document I/O ', () => {
  const dirs: string[] = [];

  /** Allocate a fresh temp directory registered for cleanup. */
  function newDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-config-doc-'));
    dirs.push(dir);
    return dir;
  }

  /** Write the local overlay into `dir`, creating the directory as needed. */
  function writeLocal(dir: string, text: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(localConfigFilePath(dir), text, 'utf8');
  }

  /** Write the committed baseline into `dir`, creating the directory as needed. */
  function writeBaseline(dir: string, text: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configFilePath(dir), text, 'utf8');
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
        assert.strictEqual(result.error.path, localConfigFilePath(dir));
        assert.ok(result.error.message.includes(localConfigFilePath(dir)));
        assert.ok(result.error.message.includes(configFilePath(dir)));
        assert.ok(result.error.message.includes('Baiton: Initialize'));
      }
    });

    it('reports "unparseable" for malformed JSON', async () => {
      const dir = newDir();
      writeLocal(dir, '{ bad json');
      const result = await readConfigDocument(dir);
      assert.ok(isErr(result));
      if (isErr(result)) {
        assert.strictEqual(result.error.kind, 'unparseable');
        assert.strictEqual(result.error.path, localConfigFilePath(dir));
        assert.ok(result.error.message.includes(localConfigFilePath(dir)));
      }
    });

    it('reports "unparseable" for a parsed non-object root', async () => {
      // Deliberately diverges from loadConfig, which reports a non-object root
 // as missing-section: root ; must not
      // expect a missing-section here.
      for (const text of ['[]', 'null', '42', '"text"']) {
        const dir = newDir();
        writeLocal(dir, text);
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
      writeLocal(dir, text);

      const result = await readConfigDocument(dir);

      assert.ok(isOk(result));
      if (isOk(result)) {
        assert.strictEqual(result.value.text, fs.readFileSync(localConfigFilePath(dir), 'utf8'));
        assert.deepStrictEqual(result.value.doc, JSON.parse(defaultConfigJson()));
        assert.strictEqual(result.value.path, localConfigFilePath(dir));
        assert.match(result.value.token, /^[0-9a-f]{64}$/);
        assert.strictEqual(result.value.token, configToken(text));
        assert.strictEqual(result.value.baselineToken, ABSENT_TOKEN);
      }
    });

    it('loads a baseline-only workspace without creating the local overlay', async () => {
      const dir = newDir();
      const baselineText = `${JSON.stringify({ baselineOnly: true, nested: { keep: 1 } })}\n`;
      writeBaseline(dir, baselineText);

      const result = await readConfigDocument(dir);

      assert.ok(isOk(result));
      if (isOk(result)) {
        assert.deepStrictEqual(result.value.doc, JSON.parse(baselineText));
        assert.strictEqual(result.value.path, localConfigFilePath(dir));
        assert.strictEqual(result.value.text, '');
        assert.strictEqual(result.value.token, ABSENT_TOKEN);
        assert.strictEqual(result.value.baselineToken, configToken(baselineText));
      }
      assert.ok(!fs.existsSync(localConfigFilePath(dir)));
    });

    it('merges both layers deeply, with local values replacing baseline arrays and scalars', async () => {
      const dir = newDir();
      const baselineText = JSON.stringify({
        scalar: 'baseline',
        git: { remote: 'origin', base: 'main' },
        list: ['baseline'],
        baselineUnknown: { keep: true },
      });
      const localText = JSON.stringify({
        scalar: 'local',
        git: { base: 'develop' },
        list: ['local'],
        localUnknown: 7,
      });
      writeBaseline(dir, baselineText);
      writeLocal(dir, localText);

      const result = await readConfigDocument(dir);

      assert.ok(isOk(result));
      if (isOk(result)) {
        assert.deepStrictEqual(result.value.doc, {
          scalar: 'local',
          git: { remote: 'origin', base: 'develop' },
          list: ['local'],
          baselineUnknown: { keep: true },
          localUnknown: 7,
        });
        assert.strictEqual(result.value.token, configToken(localText));
        assert.strictEqual(result.value.baselineToken, configToken(baselineText));
      }
    });

    it('attributes corrupt baseline and local layers to their exact file paths', async () => {
      const localCorrupt = newDir();
      writeBaseline(localCorrupt, defaultConfigJson());
      writeLocal(localCorrupt, '{ broken local');
      const localResult = await readConfigDocument(localCorrupt);
      assert.ok(isErr(localResult));
      if (isErr(localResult)) {
        assert.strictEqual(localResult.error.kind, 'unparseable');
        assert.strictEqual(localResult.error.path, localConfigFilePath(localCorrupt));
        assert.ok(localResult.error.message.includes(localConfigFilePath(localCorrupt)));
      }

      const baselineCorrupt = newDir();
      writeBaseline(baselineCorrupt, '{ broken baseline');
      writeLocal(baselineCorrupt, defaultConfigJson());
      const baselineResult = await readConfigDocument(baselineCorrupt);
      assert.ok(isErr(baselineResult));
      if (isErr(baselineResult)) {
        assert.strictEqual(baselineResult.error.kind, 'unparseable');
        assert.strictEqual(baselineResult.error.path, configFilePath(baselineCorrupt));
        assert.ok(baselineResult.error.message.includes(configFilePath(baselineCorrupt)));
      }
    });

    it('token is stable across unchanged reads and sensitive to whitespace-only changes', async () => {
      const dir = newDir();
      writeLocal(dir, defaultConfigJson());

      const first = await readConfigDocument(dir);
      const second = await readConfigDocument(dir);
      assert.ok(isOk(first) && isOk(second));
      if (isOk(first) && isOk(second)) {
        assert.strictEqual(first.value.token, second.value.token);
      }

      writeLocal(dir, `${defaultConfigJson()}\n`);
      const third = await readConfigDocument(dir);
      assert.ok(isOk(third));
      if (isOk(first) && isOk(third)) {
        assert.notStrictEqual(first.value.token, third.value.token);
      }
    });

    it('accepts a Uri-like { fsPath } as well as a string', async () => {
      const dir = newDir();
      writeLocal(dir, defaultConfigJson());
      const result = await readConfigDocument({ fsPath: dir });
      assert.ok(isOk(result));
    });

    it('reports "io" when the path is unreadable as a file (EISDIR)', async () => {
      const dir = newDir();
      fs.mkdirSync(localConfigFilePath(dir));
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
      writeLocal(dir, text);

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
      writeLocal(dir, '{ bad json');
      const result = await readConfigToken(dir);
      assert.ok(isOk(result));
      if (isOk(result)) {
        assert.strictEqual(result.value, configToken('{ bad json'));
      }
    });

    it('returns ABSENT_TOKEN for a missing local file even when the baseline exists', async () => {
      const dir = newDir();
      const baselineText = defaultConfigJson();
      writeBaseline(dir, baselineText);

      const localToken = await readConfigToken(dir);
      const baselineToken = await readBaselineToken(dir);

      assert.ok(isOk(localToken));
      assert.ok(isOk(baselineToken));
      if (isOk(localToken)) {
        assert.strictEqual(localToken.value, ABSENT_TOKEN);
      }
      if (isOk(baselineToken)) {
        assert.strictEqual(baselineToken.value, configToken(baselineText));
      }
    });

    it('readBaselineToken returns ABSENT_TOKEN when the baseline is missing', async () => {
      const result = await readBaselineToken(newDir());
      assert.ok(isOk(result));
      if (isOk(result)) {
        assert.strictEqual(result.value, ABSENT_TOKEN);
      }
    });
  });

  describe('writeConfigDocument', () => {
    it('writes and returns the new token when expectedToken matches', async () => {
      const dir = newDir();
      writeLocal(dir, defaultConfigJson());
      const loaded = await readConfigDocument(dir);
      assert.ok(isOk(loaded));
      if (!isOk(loaded)) {
        return;
      }

      const edited = { ...loaded.value.doc, git: { ...(loaded.value.doc.git as Record<string, unknown>), remote: 'upstream' } };
      const written = await writeConfigDocument(dir, edited, { expectedToken: loaded.value.token });

      assert.ok(isOk(written));
      if (isOk(written)) {
        const onDisk = fs.readFileSync(localConfigFilePath(dir), 'utf8');
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
      writeLocal(dir, defaultConfigJson());
      const loaded = await readConfigDocument(dir);
      assert.ok(isOk(loaded));
      if (!isOk(loaded)) {
        return;
      }

      const externalText = `${defaultConfigJson()}\n`;
      writeLocal(dir, externalText);

      const result = await writeConfigDocument(dir, { ...loaded.value.doc }, { expectedToken: loaded.value.token });

      assert.ok(isErr(result));
      if (isErr(result)) {
        assert.strictEqual(result.error.kind, 'conflict');
        if (result.error.kind === 'conflict') {
          assert.strictEqual(result.error.token, configToken(externalText));
        }
        assert.ok(result.error.message.includes(localConfigFilePath(dir)));
      }
      assert.strictEqual(fs.readFileSync(localConfigFilePath(dir), 'utf8'), externalText);
      assert.deepStrictEqual(fs.readdirSync(dir), ['config.local.json']);
    });

    it('overwrites unconditionally when expectedToken is omitted, even after an external edit', async () => {
      const dir = newDir();
      writeLocal(dir, defaultConfigJson());
      const external = `${defaultConfigJson()}\n`;
      writeLocal(dir, external);

      const result = await writeConfigDocument(dir, JSON.parse(defaultConfigJson()));

      assert.ok(isOk(result));
      assert.strictEqual(fs.readFileSync(localConfigFilePath(dir), 'utf8'), defaultConfigJson());
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

    it('ABSENT_TOKEN succeeds with a baseline-only workspace and writes only the local file', async () => {
      const dir = newDir();
      const baselineText = defaultConfigJson();
      writeBaseline(dir, baselineText);

      const result = await writeConfigDocument(dir, JSON.parse(defaultConfigJson()), {
        expectedToken: ABSENT_TOKEN,
      });

      assert.ok(isOk(result));
      assert.strictEqual(fs.readFileSync(configFilePath(dir), 'utf8'), baselineText);
      assert.strictEqual(fs.readFileSync(localConfigFilePath(dir), 'utf8'), defaultConfigJson());
    });

    it('unconditional overwrite leaves the committed baseline byte-for-byte unchanged', async () => {
      const dir = newDir();
      const baselineText = `${defaultConfigJson()}\n`;
      writeBaseline(dir, baselineText);

      const result = await writeConfigDocument(dir, JSON.parse(defaultConfigJson()));

      assert.ok(isOk(result));
      assert.strictEqual(fs.readFileSync(configFilePath(dir), 'utf8'), baselineText);
      assert.strictEqual(fs.readFileSync(localConfigFilePath(dir), 'utf8'), defaultConfigJson());
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
        assert.strictEqual(fs.readFileSync(localConfigFilePath(dir), 'utf8'), defaultConfigJson());
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

 describe('end-to-end through the core ', () => {
    it('applies a form over merged layers and writes the full effective document locally', async () => {
      const dir = newDir();
      const baselineDoc = JSON.parse(defaultConfigJson()) as Record<string, unknown>;
      baselineDoc.unknownBaseline = { keep: true };
      const baselineText = `${JSON.stringify(baselineDoc, null, 2)}\n`;
      const localText = '{"git":{"base":"develop"}}\n';
      writeBaseline(dir, baselineText);
      writeLocal(dir, localText);

      const loaded = await readConfigDocument(dir);
      assert.ok(isOk(loaded));
      if (!isOk(loaded)) {
        return;
      }
      const form = formFromDocument(loaded.value.doc);
      form.roles.executor.model = 'local-layer-edit';
      const next = applyFormToDocument(loaded.value.doc, form);
      const written = await writeConfigDocument(dir, next, { expectedToken: loaded.value.token });

      assert.ok(isOk(written));
      assert.strictEqual(fs.readFileSync(configFilePath(dir), 'utf8'), baselineText);
      const localAfter = JSON.parse(fs.readFileSync(localConfigFilePath(dir), 'utf8'));
      assert.deepStrictEqual(localAfter.unknownBaseline, { keep: true });
      assert.strictEqual(
        localAfter.git.remote,
        (baselineDoc.git as Record<string, unknown>).remote,
      );
      const finalConfig = await loadConfig(dir);
      assert.ok(isOk(finalConfig));
      if (isOk(finalConfig)) {
        assert.strictEqual(finalConfig.value.roles.executor.model, 'local-layer-edit');
      }
    });

    it('a form that validates yields a document loadConfig accepts, with edits applied and unmanaged keys intact', async () => {
      const dir = newDir();
      const seed = JSON.parse(defaultConfigJson());
      seed.pr = { tool: 'gh' };
      seed.git.verify = 'npm test';
      seed.roles.custom = { agent: 'claude', model: 'x' };
      seed.unknownTop = { keep: true };
      writeLocal(dir, `${JSON.stringify(seed, null, 2)}\n`);

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
      writeLocal(dir, defaultConfigJson());
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
