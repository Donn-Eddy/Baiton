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
 * ensuring an existing configuration still round-trips through the form. The
 * same applies to {@link ConfigPanelController.refreshOptions}, which rebuilds
 * the options from the live capability table plus the last form read from disk:
 * a model or effort that is configured but missing from a refreshed list is
 * appended again, exactly as on load (model-selector-refresh T08). That same
 * round-trip pass is what marks a configured-but-unlisted model `custom: true`
 * in `modelEntries`, so the webview can render it as an editable "Other…" entry
 * instead of an ordinary option (codex-opencode-dropdown-fix T06).
 */
import * as path from 'path';
import { mkdir } from 'fs/promises';
import { isErr } from '../model/result';
import type { Config } from '../config/types';
import { agentCapabilities } from '../adapter';
import type { AgentCapabilities } from '../adapter';
import {
  agentStaleness,
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
  readConfigToken,
  writeConfigDocument,
} from '../config/configDocument';
import { defaultConfig } from '../config/defaultConfig';
import { configFilePath, loadConfig } from '../config/loadConfig';

/** Prompt displayed in the modal confirmation before resetting to defaults. */
export const RESET_CONFIRM_MESSAGE =
  'Reset .baiton/config.json to the Baiton defaults? The current contents, including any keys the panel does not manage, are discarded.';

/**
 * Note returned when the hot-reload seam is unset (e.g. in unit tests or callers
 * that opt out of live reload; kept as a fallback branch).
 */
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
  /**
   * A static capability table. Kept for callers that have no live source; the
   * precedence is `getCapabilities()` → `capabilities` → `agentCapabilities()`.
   */
  capabilities?: Readonly<Record<string, AgentCapabilities>>;
  /**
   * The live capability table (model-selector-refresh T08). Read on EVERY use —
   * never hoisted into a field — so a refreshed catalog reaches the next `load()`
   * or `refreshOptions()`.
   */
  getCapabilities?(): Readonly<Record<string, AgentCapabilities>>;
  /** Fires when the discovery service lands a new catalog; drives `refreshOptions()`. */
  onDidChangeCapabilities?(listener: () => void): { dispose(): void };
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
  /** The last form parsed from disk; the round-trip input for `refreshOptions()`. */
  private form: ConfigForm | undefined;
  private capabilitySub: { dispose(): void } | undefined;
  private disposed = false;
  private writing = false;

  constructor(private readonly deps: ConfigPanelControllerDeps) {
    // Seed the options so a `save` arriving before any `load` still validates.
    this.options = configFormOptions(deps.agentIds, this.currentCapabilities());
  }

  /**
   * The capability table to build options from, resolved on every use:
   * `getCapabilities()` → `capabilities` → `agentCapabilities()`.
   */
  private currentCapabilities(): Readonly<Record<string, AgentCapabilities>> {
    return this.deps.getCapabilities?.() ?? this.deps.capabilities ?? agentCapabilities();
  }

  /**
   * Dispose the controller. After disposal, late-arriving watcher events,
   * capability changes or webview messages are silently ignored.
   */
  public dispose(): void {
    this.disposed = true;
    this.capabilitySub?.dispose();
    this.capabilitySub = undefined;
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

    // Guarded: registerConfigPanel's ensureController() calls start() again on every
    // re-resolve of the view, and a second subscription would post duplicate messages.
    if (this.capabilitySub === undefined && this.deps.onDidChangeCapabilities !== undefined) {
      this.capabilitySub = this.deps.onDidChangeCapabilities(() => {
        try {
          this.refreshOptions();
        } catch (e) {
          const message = e instanceof Error ? e.message : String(e);
          this.deps.log(
            `ConfigPanelController: unexpected error handling optionsChanged: ${message}`,
          );
        }
      });
    }
  }

  /**
   * Re-post the dropdown option sets after a model catalog refresh (T08).
   *
   * Deliberately does NOT re-post `loaded` and does not read the file, so an
   * open panel's in-progress edits are never overwritten. The options are
   * rebuilt from the live capability table plus the last form read from disk,
   * which is what keeps a configured-but-no-longer-listed agent, model or
   * effort listed after a refresh dropped it.
   */
  public refreshOptions(): void {
    if (this.disposed) {
      return;
    }
    this.options = configFormOptions(this.deps.agentIds, this.currentCapabilities(), this.form);
    const stale = agentStaleness(this.options.byAgent);
    this.deps.webview.post({ type: 'optionsChanged', options: this.options, stale });
    const staleAgents = Object.keys(stale).filter((agent) => stale[agent].stale);
    this.deps.log(
      `ConfigPanelController: model options refreshed (${this.options.agents.length} agent(s)` +
        `${staleAgents.length > 0 ? `, stale: ${staleAgents.join(', ')}` : ''})`,
    );
  }

  /**
   * Called when an external event suggests `.baiton/config.json` may have
   * changed on disk (T07).
   *
   * Suppresses the controller's own writes: while a write is in-flight
   * (`this.writing`), or when the token on disk equals `this.token`, nothing is
   * posted. Also swallows byte-identical rewrites and transient read errors.
   *
   * When the file was genuinely modified externally, posts `externalChange`
   * carrying the new token. Note that `this.token` is deliberately NOT updated
   * here: the webview decides whether to auto-reload (if pristine) or show a
   * conflict banner (if dirty). If the user keeps editing, the controller
   * retains its previous token so the next save takes the conflict path.
   */
  public async notifyExternalChange(): Promise<void> {
    if (this.disposed || this.writing) {
      return;
    }
    const current = await readConfigToken(this.deps.baitonDir);
    if (this.disposed || this.writing) {
      return;
    }
    if (isErr(current)) {
      this.deps.log(`ConfigPanelController: error reading config token: ${current.error.message}`);
      return;
    }
    if (current.value === this.token) {
      return;
    }
    this.deps.webview.post({ type: 'externalChange', token: current.value });
  }

  private async handle(msg: ConfigPanelWebviewToHost): Promise<void> {
    if (this.disposed) {
      return;
    }
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
    this.form = form;
    this.options = configFormOptions(this.deps.agentIds, this.currentCapabilities(), form);
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
    this.writing = true;
    try {
      const errors = validateConfigForm(msg.form, this.options);
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
    } finally {
      this.writing = false;
    }
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
    this.writing = true;
    try {
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
    } finally {
      this.writing = false;
    }
  }
}
