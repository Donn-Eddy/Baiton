/**
 * The Config_Panel controller (spec "Configuration Panel", config-panel, todo T05).
 *
 * This is the host-free half driven by the {@link ConfigPanelHostToWebview} and
 * {@link ConfigPanelWebviewToHost} message unions defined in
 * `src/config/configPanel.ts` (T01). Every host capability — modal confirm and
 * live-config apply — arrives as an injected seam.
 *
 * The controller carries no `vscode` import (matching `chatController.ts`, which
 * imports only `path`, `fs/promises` and host-free cores), which makes the whole
 * of T05's behaviour unit-testable without the `vscodeLoader` hook.
 *
 * Passing `form` into `configFormOptions` during load is load-bearing: it
 * appends an out-of-set agent or effort already present in the document so the
 * dropdown keeps that value instead of silently rewriting it on the next save —
 * ensuring an existing configuration still round-trips through the form.
 */
import * as path from 'path';
import { mkdir } from 'fs/promises';
import { isErr } from '../model/result';
import type { Config } from '../config/types';
import {
  applyFormToDocument,
  configFormOptions,
  formFromDocument,
  validateConfigForm,
} from '../config/configPanel';
import type {
  ConfigForm,
  ConfigFormOptions,
  ConfigPanelHostToWebview,
  ConfigPanelWebviewToHost,
} from '../config/configPanel';
import {
  readConfigDocument,
  writeConfigDocument,
} from '../config/configDocument';
import { defaultConfig } from '../config/defaultConfig';
import { configFilePath, loadConfig } from '../config/loadConfig';

/** Prompt displayed in the modal confirmation before resetting to defaults. */
export const RESET_CONFIRM_MESSAGE =
  'Reset .baiton/config.json to the Baiton defaults? The current contents, including any keys the panel does not manage, are discarded.';

/** Note returned when hot-reload seam is unset (T05 before T08). */
export const ACTIVATION_VALUES_NOTE =
  'New values were written to .baiton/config.json; components that read the configuration at activation keep their current values until the window is reloaded.';

/**
 * The webview surface the controller drives. Deliberately mirrors the
 * two-method shape of `ChatWebview` (`chatController.ts`), so the provider
 * implements it and tests use a recording fake.
 */
export interface ConfigPanelWebview {
  /** Post one message to the webview. */
  post(msg: ConfigPanelHostToWebview): void;
  /** Register the message handler receiving webview messages. */
  onMessage(handler: (msg: ConfigPanelWebviewToHost) => void | Promise<void>): void;
}

/**
 * The hot-reload seam (T08). Receives the freshly loaded config as a replaced
 * whole and returns human-readable notes naming anything that could not be
 * reloaded live.
 */
export type ApplyConfig = (config: Config) => Promise<readonly string[]> | readonly string[];

/** Dependencies injected into the host-free controller. */
export interface ConfigPanelControllerDeps {
  webview: ConfigPanelWebview;
  baitonDir: string;
  agentIds: readonly string[];
  confirmReset(message: string): Promise<boolean>;
  applyConfig?: ApplyConfig;
  log(message: string): void;
}

/**
 * Host-free controller for the configuration panel. Handles `ready`, `load`,
 * `save` (host-side re-validation, conflict refusal, atomic write),
 * `reset` (modal confirm, directory creation, default write), and post-save
 * hot-reload notifications.
 */
export class ConfigPanelController {
  private doc: Record<string, unknown> | undefined;
  private token: string | undefined;
  private options: ConfigFormOptions;

  constructor(private readonly deps: ConfigPanelControllerDeps) {
    this.options = configFormOptions(deps.agentIds);
  }

  /**
   * Start listening for webview messages. Does not push an unsolicited first
   * message: the webview posts `{ type: 'ready' }` at initialization to trigger
   * the first load.
   */
  public start(): void {
    this.deps.webview.onMessage((msg: ConfigPanelWebviewToHost) => {
      return this.handle(msg).catch((e) => {
        const message = e instanceof Error ? e.message : String(e);
        this.deps.log(`ConfigPanelController: unexpected error handling ${msg.type}: ${message}`);
        this.deps.webview.post({ type: 'saveFailed', reason: 'io', message });
      });
    });
  }

  private async handle(msg: ConfigPanelWebviewToHost): Promise<void> {
    switch (msg.type) {
      case 'ready':
      case 'load':
        await this.load();
        break;
      case 'save':
        await this.save(msg);
        break;
      case 'reset':
        await this.reset();
        break;
      default: {
        const unrecognised = msg as { type?: unknown };
        this.deps.log(
          `ConfigPanelController: unrecognised message type: ${String(unrecognised?.type)}`,
        );
        break;
      }
    }
  }

  private async load(): Promise<void> {
    const read = await readConfigDocument(this.deps.baitonDir);
    if (isErr(read)) {
      this.doc = undefined;
      this.token = undefined;
      const { kind, message } = read.error;
      if (kind === 'absent') {
        this.deps.webview.post({ type: 'loadFailed', kind: 'absent', message, canReset: true });
      } else if (kind === 'unparseable') {
        this.deps.webview.post({ type: 'loadFailed', kind: 'unparseable', message, canReset: true });
      } else {
        // loadFailed has no 'io' kind; an unreadable file cannot be fixed by Reset (a reset would overwrite an unreadable file).
        this.deps.webview.post({ type: 'loadFailed', kind: 'invalid', message, canReset: false });
      }
      return;
    }

    const form = formFromDocument(read.value.doc);
    this.doc = read.value.doc;
    this.token = read.value.token;
    this.options = configFormOptions(this.deps.agentIds, form);
    this.deps.webview.post({
      type: 'loaded',
      form,
      token: read.value.token,
      options: this.options,
    });
  }

  private async save(msg: {
    form: ConfigForm;
    token: string;
    overwrite?: boolean;
  }): Promise<void> {
    const errors = validateConfigForm(msg.form, { agents: this.options.agents });
    if (errors.length > 0) {
      this.deps.webview.post({
        type: 'saveFailed',
        reason: 'invalid',
        message: `${errors.length} field(s) are invalid.`,
        errors,
      });
      return;
    }

    let base: Record<string, unknown>;
    if (msg.overwrite === true) {
      // Overwrite: always re-read first and merge onto disk contents to preserve unknown keys added externally.
      const reRead = await readConfigDocument(this.deps.baitonDir);
      if (isErr(reRead)) {
        if (reRead.error.kind === 'io') {
          this.deps.webview.post({ type: 'saveFailed', reason: 'io', message: reRead.error.message });
          return;
        }
        base = this.doc ?? {};
      } else {
        base = reRead.value.doc;
      }
    } else {
      if (this.doc !== undefined && this.token === msg.token) {
        base = this.doc;
      } else {
        const reRead = await readConfigDocument(this.deps.baitonDir);
        if (isErr(reRead)) {
          if (reRead.error.kind === 'io') {
            this.deps.webview.post({ type: 'saveFailed', reason: 'io', message: reRead.error.message });
            return;
          }
          base = this.doc ?? {};
        } else {
          base = reRead.value.doc;
        }
      }
    }

    const next = applyFormToDocument(base, msg.form);
    const written = await writeConfigDocument(
      this.deps.baitonDir,
      next,
      msg.overwrite === true ? undefined : { expectedToken: msg.token },
    );

    if (isErr(written)) {
      if (written.error.kind === 'conflict') {
        this.deps.webview.post({ type: 'saveFailed', reason: 'conflict', message: written.error.message });
      } else {
        this.deps.webview.post({ type: 'saveFailed', reason: 'io', message: written.error.message });
      }
      return;
    }

    this.doc = written.value.doc;
    this.token = written.value.token;

    const notes = await this.applySaved();
    this.deps.webview.post({
      type: 'saved',
      token: written.value.token,
      ...(notes.length > 0 ? { notes } : {}),
    });
  }

  private async applySaved(): Promise<string[]> {
    // 1. Authoritative semantic check against the bytes now on disk.
    // Runs *after* the write on the merged document, which is why the panel can preserve unknown keys and still end up with a Config the loader accepts.
    const loaded = await loadConfig(this.deps.baitonDir);
    if (isErr(loaded)) {
      return [`Saved, but the running extension kept its previous configuration: ${loaded.error.message}`];
    }

    if (this.deps.applyConfig !== undefined) {
      try {
        const notes = await this.deps.applyConfig(loaded.value);
        return [...notes];
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        this.deps.log(`ConfigPanelController: applyConfig threw: ${msg}`);
        return [`Configuration saved, but could not be applied live: ${msg}`];
      }
    }

    return [ACTIVATION_VALUES_NOTE];
  }

  private async reset(): Promise<void> {
    const ok = await this.deps.confirmReset(RESET_CONFIRM_MESSAGE);
    if (!ok) {
      await this.load();
      return;
    }

    // writeJsonAtomic writes a sibling temp file and renames; it does not create the directory, so a reset in a workspace with no .baiton/ would fail ENOENT.
    const configPath = configFilePath(this.deps.baitonDir);
    try {
      await mkdir(path.dirname(configPath), { recursive: true });
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.deps.webview.post({
        type: 'saveFailed',
        reason: 'io',
        message: `Could not create directory: ${message}`,
      });
      return;
    }

    // No expectedToken: reset is intentionally unconditional.
    // writeConfigDocument serialises defaultConfig() byte-identical to defaultConfigJson().
    const written = await writeConfigDocument(this.deps.baitonDir, defaultConfig(), undefined);
    if (isErr(written)) {
      this.deps.webview.post({ type: 'saveFailed', reason: 'io', message: written.error.message });
      return;
    }

    await this.load();
  }
}
