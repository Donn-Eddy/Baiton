/**
 * Unit tests for the host-free Config Panel controller (spec "Config Panel",
 * config-panel todo T05).
 *
 * This suite imports {@link ConfigPanelController} statically with no
 * `test/fixtures/vscodeLoader.mjs` hook, proving that the controller carries no
 * `vscode` imports and remains fully host-free and unit-testable.
 *
 * Coverage:
 * 1. `ready` against a valid file -> exactly one `loaded`, whose `token` equals
 *    `configToken(<file text>)`, whose `form` matches `formFromConfig` of the
 *    loaded config, and whose `options.agents` equals the injected ids.
 * 2. `ready` with no file -> `loadFailed { kind: 'absent', canReset: true }`;
 *    with `{ not json` -> `loadFailed { kind: 'unparseable', canReset: true }`.
 * 3. load -> change a role model -> `save` with the loaded token -> `saved`;
 *    the file parses to the edited value, still carries an unknown top-level
 *    key and `pr`, and is two-space indented with a trailing newline.
 * 4. `save` with a blank model -> `saveFailed { reason: 'invalid' }` carrying the
 *    `roles.<role>.model` path, and the file byte-for-byte unchanged.
 * 5. `save` with a stale token after an external edit ->
 *    `saveFailed { reason: 'conflict' }` with the external edit still on disk;
 *    replaying the same save with `overwrite: true` succeeds and preserves an
 *    unknown key the external edit introduced (re-read-before-overwrite rule).
 * 6. `reset` declined -> no write, file unchanged, `confirmReset` called once;
 *    accepted -> file text exactly `defaultConfigJson()` and a fresh `loaded`
 *    follows. Plus a reset into a directory that does not exist yet (mkdir path).
 * 7. Hot-reload: after a successful save `applyConfig` is called once with a
 *    `Config` carrying the new values and its notes appear in `saved.notes`;
 *    with no `applyConfig` injected, `saved.notes` is the single activation-values
 *    note; an `applyConfig` that throws still yields `saved` (never `saveFailed`)
 *    with a note and a logged line; wiring a real `createConfigRefresh` over a
 *    fake target updates target.config.roles.<role>.model with no notes.
 * 8. `notifyExternalChange` (T07):
 *    - external edit with different bytes -> exactly one `externalChange` with new token;
 *    - self-write (save or accepted reset) -> no `externalChange` posted;
 *    - identical rewrite -> no message;
 *    - deletion -> `externalChange` with `ABSENT_TOKEN` (''), and following `load` yields
 *      `loadFailed { kind: 'absent', canReset: true }`;
 *    - stale token after external edit without reload -> `save` yields `saveFailed { reason: 'conflict' }`;
 *    - after `dispose()`, `notifyExternalChange` posts nothing.
 */
import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ACTIVATION_VALUES_NOTE,
  ConfigPanelController,
  ConfigPanelWebview,
  RESET_CONFIRM_MESSAGE,
} from '../src/activation/configPanelController';
import { createConfigRefresh } from '../src/activation/configRefresh';
import type {
  ConfigPanelHostToWebview,
  ConfigPanelWebviewToHost,
} from '../src/config/configPanel';
import { formFromConfig } from '../src/config/configPanel';
import { ABSENT_TOKEN, configToken } from '../src/config/configDocument';
import { defaultConfig, defaultConfigJson } from '../src/config/defaultConfig';
import { configFilePath, loadConfig } from '../src/config/loadConfig';
import type { Config } from '../src/config/types';
import { isOk } from '../src/model/result';

class RecordingWebview implements ConfigPanelWebview {
  public messages: ConfigPanelHostToWebview[] = [];
  private handler?: (msg: ConfigPanelWebviewToHost) => void | Promise<void>;

  post(msg: ConfigPanelHostToWebview): void {
    this.messages.push(msg);
  }

  onMessage(handler: (msg: ConfigPanelWebviewToHost) => void | Promise<void>): void {
    this.handler = handler;
  }

  async send(msg: ConfigPanelWebviewToHost): Promise<void> {
    if (!this.handler) {
      throw new Error('RecordingWebview: no handler registered.');
    }
    await this.handler(msg);
  }
}

describe('ConfigPanelController (config-panel T05)', () => {
  const dirs: string[] = [];

  function newDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-config-panel-'));
    dirs.push(dir);
    return dir;
  }

  function writeConfigFile(dir: string, text: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configFilePath(dir), text, 'utf8');
  }

  afterEach(() => {
    while (dirs.length > 0) {
      const dir = dirs.pop()!;
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('1. ready against a valid file -> loaded with token, form matching formFromConfig, and injected agents', async () => {
    const dir = newDir();
    const text = defaultConfigJson();
    writeConfigFile(dir, text);

    const webview = new RecordingWebview();
    const logs: string[] = [];
    const agentIds = ['claude', 'agent-b'];
    const controller = new ConfigPanelController({
      webview,
      baitonDir: dir,
      agentIds,
      confirmReset: async () => false,
      log: (msg) => logs.push(msg),
    });

    controller.start();
    await webview.send({ type: 'ready' });

    assert.strictEqual(webview.messages.length, 1);
    const msg = webview.messages[0];
    assert.strictEqual(msg.type, 'loaded');
    if (msg.type === 'loaded') {
      assert.strictEqual(msg.token, configToken(text));
      const loaded = await loadConfig(dir);
      assert.ok(isOk(loaded));
      if (isOk(loaded)) {
        assert.deepStrictEqual(msg.form, formFromConfig(loaded.value));
      }
      assert.deepStrictEqual(msg.options.agents, agentIds);
    }
  });

  it('2. ready with no file -> loadFailed { kind: "absent", canReset: true }; with malformed json -> unparseable', async () => {
    const dir1 = newDir();
    const webview1 = new RecordingWebview();
    const controller1 = new ConfigPanelController({
      webview: webview1,
      baitonDir: dir1,
      agentIds: ['claude'],
      confirmReset: async () => false,
      log: () => {},
    });
    controller1.start();
    await webview1.send({ type: 'ready' });

    assert.strictEqual(webview1.messages.length, 1);
    const msg1 = webview1.messages[0];
    assert.strictEqual(msg1.type, 'loadFailed');
    if (msg1.type === 'loadFailed') {
      assert.strictEqual(msg1.kind, 'absent');
      assert.strictEqual(msg1.canReset, true);
    }

    const dir2 = newDir();
    writeConfigFile(dir2, '{ not json');
    const webview2 = new RecordingWebview();
    const controller2 = new ConfigPanelController({
      webview: webview2,
      baitonDir: dir2,
      agentIds: ['claude'],
      confirmReset: async () => false,
      log: () => {},
    });
    controller2.start();
    await webview2.send({ type: 'ready' });

    assert.strictEqual(webview2.messages.length, 1);
    const msg2 = webview2.messages[0];
    assert.strictEqual(msg2.type, 'loadFailed');
    if (msg2.type === 'loadFailed') {
      assert.strictEqual(msg2.kind, 'unparseable');
      assert.strictEqual(msg2.canReset, true);
    }
  });

  it('3. load -> change a role model -> save -> saved; preserves unknown keys, pr, indentation and newline', async () => {
    const dir = newDir();
    const initialObj = {
      ...defaultConfig(),
      custom_unknown_key: 'preserved_value',
      pr: { tool: 'custom-pr-tool' },
    };
    const initialText = `${JSON.stringify(initialObj, null, 2)}\n`;
    writeConfigFile(dir, initialText);

    const webview = new RecordingWebview();
    const controller = new ConfigPanelController({
      webview,
      baitonDir: dir,
      agentIds: ['claude'],
      confirmReset: async () => false,
      log: () => {},
    });
    controller.start();
    await webview.send({ type: 'load' });

    assert.strictEqual(webview.messages.length, 1);
    const loadedMsg = webview.messages[0];
    assert.strictEqual(loadedMsg.type, 'loaded');
    if (loadedMsg.type !== 'loaded') {
      return;
    }

    const editedForm = { ...loadedMsg.form };
    editedForm.roles = {
      ...editedForm.roles,
      planner: {
        ...editedForm.roles.planner,
        model: 'new-planner-model',
      },
    };

    await webview.send({
      type: 'save',
      form: editedForm,
      token: loadedMsg.token,
    });

    assert.strictEqual(webview.messages.length, 2);
    const savedMsg = webview.messages[1];
    assert.strictEqual(savedMsg.type, 'saved');

    const fileTextOnDisk = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
    assert.ok(fileTextOnDisk.endsWith('\n'), 'file must end with trailing newline');
    const parsed = JSON.parse(fileTextOnDisk);
    assert.strictEqual(parsed.roles.planner.model, 'new-planner-model');
    assert.strictEqual(parsed.custom_unknown_key, 'preserved_value');
    assert.deepStrictEqual(parsed.pr, { tool: 'custom-pr-tool' });
    assert.strictEqual(fileTextOnDisk, `${JSON.stringify(parsed, null, 2)}\n`);
  });

  it('4. save with a blank model -> saveFailed { reason: "invalid" } with path, file byte-for-byte unchanged', async () => {
    const dir = newDir();
    const initialText = defaultConfigJson();
    writeConfigFile(dir, initialText);

    const webview = new RecordingWebview();
    const controller = new ConfigPanelController({
      webview,
      baitonDir: dir,
      agentIds: ['claude'],
      confirmReset: async () => false,
      log: () => {},
    });
    controller.start();
    await webview.send({ type: 'load' });
    assert.strictEqual(webview.messages.length, 1);
    const loadedMsg = webview.messages[0];
    assert.strictEqual(loadedMsg.type, 'loaded');
    if (loadedMsg.type !== 'loaded') {
      return;
    }

    const badForm = { ...loadedMsg.form };
    badForm.roles = {
      ...badForm.roles,
      planner: {
        ...badForm.roles.planner,
        model: '   ',
      },
    };

    await webview.send({
      type: 'save',
      form: badForm,
      token: loadedMsg.token,
    });

    assert.strictEqual(webview.messages.length, 2);
    const saveFailedMsg = webview.messages[1];
    assert.strictEqual(saveFailedMsg.type, 'saveFailed');
    if (saveFailedMsg.type === 'saveFailed') {
      assert.strictEqual(saveFailedMsg.reason, 'invalid');
      assert.ok(saveFailedMsg.errors);
      const hasPlannerModelError = saveFailedMsg.errors.some(
        (e) => e.path === 'roles.planner.model',
      );
      assert.ok(hasPlannerModelError, 'must report roles.planner.model error path');
    }

    const fileAfter = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
    assert.strictEqual(fileAfter, initialText, 'file on disk must remain byte-for-byte unchanged');
  });

  it('5. save with stale token -> conflict; replay with overwrite: true succeeds and preserves external unknown key', async () => {
    const dir = newDir();
    writeConfigFile(dir, defaultConfigJson());

    const webview = new RecordingWebview();
    const controller = new ConfigPanelController({
      webview,
      baitonDir: dir,
      agentIds: ['claude'],
      confirmReset: async () => false,
      log: () => {},
    });
    controller.start();
    await webview.send({ type: 'load' });
    const loadedMsg = webview.messages[0];
    assert.strictEqual(loadedMsg.type, 'loaded');
    if (loadedMsg.type !== 'loaded') {
      return;
    }

    // External edit introduces a new unknown key on disk
    const externalDoc = {
      ...defaultConfig(),
      external_extra_key: 'external_value',
    };
    const externalText = `${JSON.stringify(externalDoc, null, 2)}\n`;
    fs.writeFileSync(path.join(dir, 'config.json'), externalText, 'utf8');

    // Attempt save with original loaded token -> conflict refusal
    const editedForm = { ...loadedMsg.form };
    editedForm.roles = {
      ...editedForm.roles,
      executor: {
        ...editedForm.roles.executor,
        model: 'executor-updated-model',
      },
    };

    await webview.send({
      type: 'save',
      form: editedForm,
      token: loadedMsg.token,
    });

    assert.strictEqual(webview.messages.length, 2);
    const conflictMsg = webview.messages[1];
    assert.strictEqual(conflictMsg.type, 'saveFailed');
    if (conflictMsg.type === 'saveFailed') {
      assert.strictEqual(conflictMsg.reason, 'conflict');
    }

    // External edit is still on disk
    assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), externalText);

    // Replay same save with overwrite: true
    await webview.send({
      type: 'save',
      form: editedForm,
      token: loadedMsg.token,
      overwrite: true,
    });

    assert.strictEqual(webview.messages.length, 3);
    const savedMsg = webview.messages[2];
    assert.strictEqual(savedMsg.type, 'saved');

    const fileAfterOverwrite = fs.readFileSync(path.join(dir, 'config.json'), 'utf8');
    const parsedAfter = JSON.parse(fileAfterOverwrite);
    assert.strictEqual(parsedAfter.roles.executor.model, 'executor-updated-model');
    assert.strictEqual(parsedAfter.external_extra_key, 'external_value');
  });

  it('6. reset: declined -> no write; accepted -> defaultConfigJson() on disk; reset into nonexistent dir creates dir', async () => {
    const dir = newDir();
    const customConfig = {
      ...defaultConfig(),
      unmanaged: 123,
    };
    const customText = `${JSON.stringify(customConfig, null, 2)}\n`;
    writeConfigFile(dir, customText);

    let confirmAnswer = false;
    let confirmCalls = 0;
    const webview = new RecordingWebview();
    const controller = new ConfigPanelController({
      webview,
      baitonDir: dir,
      agentIds: ['claude'],
      confirmReset: async (prompt) => {
        confirmCalls++;
        assert.strictEqual(prompt, RESET_CONFIRM_MESSAGE);
        return confirmAnswer;
      },
      log: () => {},
    });
    controller.start();

    // 1. Reset declined
    await webview.send({ type: 'reset' });
    assert.strictEqual(confirmCalls, 1);
    assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), customText);
    assert.strictEqual(webview.messages.length, 1);
    assert.strictEqual(webview.messages[0].type, 'loaded');

    // 2. Reset accepted
    confirmAnswer = true;
    await webview.send({ type: 'reset' });
    assert.strictEqual(confirmCalls, 2);
    const expectedDefaults = defaultConfigJson();
    assert.strictEqual(fs.readFileSync(path.join(dir, 'config.json'), 'utf8'), expectedDefaults);
    assert.strictEqual(webview.messages.length, 2);
    assert.strictEqual(webview.messages[1].type, 'loaded');

    // 3. Reset into nonexistent dir
    const baseDir = newDir();
    const nonExistentSubdir = path.join(baseDir, 'nested', 'baiton');
    const webview3 = new RecordingWebview();
    const controller3 = new ConfigPanelController({
      webview: webview3,
      baitonDir: nonExistentSubdir,
      agentIds: ['claude'],
      confirmReset: async () => true,
      log: () => {},
    });
    controller3.start();
    await webview3.send({ type: 'reset' });
    assert.strictEqual(
      fs.readFileSync(path.join(nonExistentSubdir, 'config.json'), 'utf8'),
      expectedDefaults,
    );
    assert.strictEqual(webview3.messages.length, 1);
    assert.strictEqual(webview3.messages[0].type, 'loaded');
  });

  it('7. hot-reload: applyConfig called with new Config and notes reported; fallback note when unset; throw turns into note', async () => {
    const dir = newDir();
    writeConfigFile(dir, defaultConfigJson());

    // 1. With applyConfig injected
    let appliedConfig: Config | undefined;
    const webview1 = new RecordingWebview();
    const controller1 = new ConfigPanelController({
      webview: webview1,
      baitonDir: dir,
      agentIds: ['claude'],
      confirmReset: async () => false,
      applyConfig: async (config) => {
        appliedConfig = config;
        return ['Note 1: Adapter reloaded', 'Note 2: Git base branch updated'];
      },
      log: () => {},
    });
    controller1.start();
    await webview1.send({ type: 'load' });
    const loaded1 = webview1.messages[0];
    assert.strictEqual(loaded1.type, 'loaded');
    if (loaded1.type !== 'loaded') {
      return;
    }

    const edit1 = { ...loaded1.form };
    edit1.git = { remote: 'upstream', base: 'develop' };
    await webview1.send({ type: 'save', form: edit1, token: loaded1.token });

    assert.strictEqual(webview1.messages.length, 2);
    const saved1 = webview1.messages[1];
    assert.strictEqual(saved1.type, 'saved');
    if (saved1.type === 'saved') {
      assert.deepStrictEqual(saved1.notes, [
        'Note 1: Adapter reloaded',
        'Note 2: Git base branch updated',
      ]);
      assert.ok(appliedConfig);
      assert.strictEqual(appliedConfig?.git.remote, 'upstream');
      assert.strictEqual(appliedConfig?.git.base, 'develop');
    }

    // 2. Without applyConfig injected
    const webview2 = new RecordingWebview();
    const controller2 = new ConfigPanelController({
      webview: webview2,
      baitonDir: dir,
      agentIds: ['claude'],
      confirmReset: async () => false,
      log: () => {},
    });
    controller2.start();
    await webview2.send({ type: 'load' });
    const loaded2 = webview2.messages[0];
    assert.strictEqual(loaded2.type, 'loaded');
    if (loaded2.type !== 'loaded') {
      return;
    }

    await webview2.send({ type: 'save', form: loaded2.form, token: loaded2.token });
    assert.strictEqual(webview2.messages.length, 2);
    const saved2 = webview2.messages[1];
    assert.strictEqual(saved2.type, 'saved');
    if (saved2.type === 'saved') {
      assert.deepStrictEqual(saved2.notes, [ACTIVATION_VALUES_NOTE]);
    }

    // 3. When applyConfig throws: saved message still posted (never saveFailed), note and log captured
    const loggedLines: string[] = [];
    const webview3 = new RecordingWebview();
    const controller3 = new ConfigPanelController({
      webview: webview3,
      baitonDir: dir,
      agentIds: ['claude'],
      confirmReset: async () => false,
      applyConfig: () => {
        throw new Error('hot-reload-explosion');
      },
      log: (line) => loggedLines.push(line),
    });
    controller3.start();
    await webview3.send({ type: 'load' });
    const loaded3 = webview3.messages[0];
    assert.strictEqual(loaded3.type, 'loaded');
    if (loaded3.type !== 'loaded') {
      return;
    }

    await webview3.send({ type: 'save', form: loaded3.form, token: loaded3.token });
    assert.strictEqual(webview3.messages.length, 2);
    const saved3 = webview3.messages[1];
    assert.strictEqual(saved3.type, 'saved');
    if (saved3.type === 'saved') {
      assert.ok(saved3.notes && saved3.notes.length > 0);
      assert.ok(saved3.notes[0].includes('hot-reload-explosion'));
    }
    assert.ok(loggedLines.some((l) => l.includes('hot-reload-explosion')));

    // 4. End-to-end with real createConfigRefresh over a fake target
    const target = {
      config: defaultConfig(),
      executables: {
        get: () => undefined,
        errorFor: () => undefined,
        errors: [],
        agents: [],
      },
    };
    const realRefresh = createConfigRefresh({
      state: () => target,
      resolveExecutables: () => target.executables,
      completeActivation: async () => [],
      runningSlugs: () => [],
      log: () => {},
    });

    const webview4 = new RecordingWebview();
    const controller4 = new ConfigPanelController({
      webview: webview4,
      baitonDir: dir,
      agentIds: ['claude'],
      confirmReset: async () => false,
      applyConfig: realRefresh,
      log: () => {},
    });
    controller4.start();
    await webview4.send({ type: 'load' });
    const loaded4 = webview4.messages[0];
    assert.strictEqual(loaded4.type, 'loaded');
    if (loaded4.type !== 'loaded') {
      return;
    }

    const edit4 = { ...loaded4.form };
    edit4.roles.executor = { ...edit4.roles.executor, model: 'claude-3-sonnet-custom' };
    await webview4.send({ type: 'save', form: edit4, token: loaded4.token });

    assert.strictEqual(webview4.messages.length, 2);
    const saved4 = webview4.messages[1];
    assert.strictEqual(saved4.type, 'saved');
    if (saved4.type === 'saved') {
      assert.strictEqual(saved4.notes, undefined);
    }
    assert.strictEqual(target.config.roles.executor.model, 'claude-3-sonnet-custom');
  });

  describe('8. notifyExternalChange (T07)', () => {
    it('external edit with different bytes -> posts externalChange carrying the new token', async () => {
      const dir = newDir();
      const text = defaultConfigJson();
      writeConfigFile(dir, text);

      const webview = new RecordingWebview();
      const controller = new ConfigPanelController({
        webview,
        baitonDir: dir,
        agentIds: ['claude'],
        confirmReset: async () => false,
        log: () => {},
      });
      controller.start();
      await webview.send({ type: 'ready' });
      assert.strictEqual(webview.messages.length, 1);
      assert.strictEqual(webview.messages[0].type, 'loaded');

      const editedObj = {
        ...defaultConfig(),
        limits: { ...defaultConfig().limits, max_turns: 99 },
      };
      const editedText = `${JSON.stringify(editedObj, null, 2)}\n`;
      writeConfigFile(dir, editedText);

      await controller.notifyExternalChange();

      assert.strictEqual(webview.messages.length, 2);
      const msg = webview.messages[1];
      assert.strictEqual(msg.type, 'externalChange');
      if (msg.type === 'externalChange') {
        assert.strictEqual(msg.token, configToken(editedText));
      }
    });

    it('self-write is suppressed: save and accepted reset post no externalChange', async () => {
      // 1. Save
      const dir1 = newDir();
      writeConfigFile(dir1, defaultConfigJson());
      const webview1 = new RecordingWebview();
      const controller1 = new ConfigPanelController({
        webview: webview1,
        baitonDir: dir1,
        agentIds: ['claude'],
        confirmReset: async () => false,
        log: () => {},
      });
      controller1.start();
      await webview1.send({ type: 'load' });
      const loaded1 = webview1.messages[0];
      assert.strictEqual(loaded1.type, 'loaded');
      if (loaded1.type !== 'loaded') {
        return;
      }

      const edit1 = { ...loaded1.form };
      edit1.git = { remote: 'upstream', base: 'develop' };
      await webview1.send({ type: 'save', form: edit1, token: loaded1.token });
      assert.strictEqual(webview1.messages.length, 2);
      assert.strictEqual(webview1.messages[1].type, 'saved');

      // notifyExternalChange right after save should be suppressed
      await controller1.notifyExternalChange();
      assert.strictEqual(webview1.messages.length, 2);

      // 2. Reset (accepted)
      const dir2 = newDir();
      const nonDefaultObj = {
        ...defaultConfig(),
        limits: { ...defaultConfig().limits, max_turns: 42 },
      };
      writeConfigFile(dir2, `${JSON.stringify(nonDefaultObj, null, 2)}\n`);
      const webview2 = new RecordingWebview();
      const controller2 = new ConfigPanelController({
        webview: webview2,
        baitonDir: dir2,
        agentIds: ['claude'],
        confirmReset: async () => true,
        log: () => {},
      });
      controller2.start();
      await webview2.send({ type: 'load' });
      assert.strictEqual(webview2.messages.length, 1);

      await webview2.send({ type: 'reset' });
      // Reset posts 'loaded' on completion
      assert.strictEqual(webview2.messages.length, 2);
      assert.strictEqual(webview2.messages[1].type, 'loaded');

      // notifyExternalChange after reset should be suppressed
      await controller2.notifyExternalChange();
      assert.strictEqual(webview2.messages.length, 2);
    });

    it('identical rewrite is suppressed: no externalChange posted', async () => {
      const dir = newDir();
      const text = defaultConfigJson();
      writeConfigFile(dir, text);

      const webview = new RecordingWebview();
      const controller = new ConfigPanelController({
        webview,
        baitonDir: dir,
        agentIds: ['claude'],
        confirmReset: async () => false,
        log: () => {},
      });
      controller.start();
      await webview.send({ type: 'ready' });
      assert.strictEqual(webview.messages.length, 1);

      // Rewrite with byte-identical content
      writeConfigFile(dir, text);
      await controller.notifyExternalChange();
      assert.strictEqual(webview.messages.length, 1);
    });

    it('deletion posts ABSENT_TOKEN and following load yields loadFailed { kind: "absent", canReset: true }', async () => {
      const dir = newDir();
      writeConfigFile(dir, defaultConfigJson());

      const webview = new RecordingWebview();
      const controller = new ConfigPanelController({
        webview,
        baitonDir: dir,
        agentIds: ['claude'],
        confirmReset: async () => false,
        log: () => {},
      });
      controller.start();
      await webview.send({ type: 'ready' });
      assert.strictEqual(webview.messages.length, 1);

      // Delete the file
      fs.rmSync(configFilePath(dir));

      await controller.notifyExternalChange();
      assert.strictEqual(webview.messages.length, 2);
      const extMsg = webview.messages[1];
      assert.strictEqual(extMsg.type, 'externalChange');
      if (extMsg.type === 'externalChange') {
        assert.strictEqual(extMsg.token, ABSENT_TOKEN);
      }

      // Pristine form would now post load
      await webview.send({ type: 'load' });
      assert.strictEqual(webview.messages.length, 3);
      const loadMsg = webview.messages[2];
      assert.strictEqual(loadMsg.type, 'loadFailed');
      if (loadMsg.type === 'loadFailed') {
        assert.strictEqual(loadMsg.kind, 'absent');
        assert.strictEqual(loadMsg.canReset, true);
      }
    });

    it('the stale token still conflicts: Keep editing and save yields saveFailed { reason: "conflict" }', async () => {
      const dir = newDir();
      writeConfigFile(dir, defaultConfigJson());

      const webview = new RecordingWebview();
      const controller = new ConfigPanelController({
        webview,
        baitonDir: dir,
        agentIds: ['claude'],
        confirmReset: async () => false,
        log: () => {},
      });
      controller.start();
      await webview.send({ type: 'ready' });
      const loaded = webview.messages[0];
      assert.strictEqual(loaded.type, 'loaded');
      if (loaded.type !== 'loaded') {
        return;
      }

      // External edit occurs
      const externalObj = {
        ...defaultConfig(),
        custom_external_key: 'external_value',
      };
      const externalText = `${JSON.stringify(externalObj, null, 2)}\n`;
      writeConfigFile(dir, externalText);

      await controller.notifyExternalChange();
      assert.strictEqual(webview.messages.length, 2);
      assert.strictEqual(webview.messages[1].type, 'externalChange');

      // User kept editing, saving with the original stale token
      const form = { ...loaded.form };
      form.git = { remote: 'my-remote', base: 'main' };
      await webview.send({ type: 'save', form, token: loaded.token });

      assert.strictEqual(webview.messages.length, 3);
      const saveFailedMsg = webview.messages[2];
      assert.strictEqual(saveFailedMsg.type, 'saveFailed');
      if (saveFailedMsg.type === 'saveFailed') {
        assert.strictEqual(saveFailedMsg.reason, 'conflict');
      }

      // External edit remains intact on disk
      assert.strictEqual(fs.readFileSync(configFilePath(dir), 'utf8'), externalText);
    });

    it('after dispose() nothing is posted by notifyExternalChange or webview messages', async () => {
      const dir = newDir();
      writeConfigFile(dir, defaultConfigJson());

      const webview = new RecordingWebview();
      const controller = new ConfigPanelController({
        webview,
        baitonDir: dir,
        agentIds: ['claude'],
        confirmReset: async () => false,
        log: () => {},
      });
      controller.start();
      await webview.send({ type: 'ready' });
      assert.strictEqual(webview.messages.length, 1);

      // Modify the file
      writeConfigFile(dir, `${JSON.stringify({ ...defaultConfig(), limits: { ...defaultConfig().limits, max_turns: 123 } }, null, 2)}\n`);

      controller.dispose();
      await controller.notifyExternalChange();
      // Still 1 message: notifyExternalChange posted nothing
      assert.strictEqual(webview.messages.length, 1);

      // Webview message after dispose is also ignored
      await webview.send({ type: 'load' });
      assert.strictEqual(webview.messages.length, 1);
    });
  });
});
