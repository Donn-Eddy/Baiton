/**
 * The Config_Panel WebviewPanel provider (spec "Config Panel", config-panel, todo T05).
 *
 * This is the thin `vscode` glue that owns the editor-area WebviewPanel lifecycle
 * and the message channel to and from the browser context. Everything it renders is
 * driven by the {@link ConfigPanelController} through the host-free
 * {@link ConfigPanelHostToWebview}/{@link ConfigPanelWebviewToHost} protocol; the
 * provider itself only:
 *
 *  - creates or reveals the panel singleton, loading the static shell under `media/`
 *    with a fresh per-load nonce and a strict Content Security Policy that admits
 *    only scripts bearing that nonce;
 *  - limits `localResourceRoots` to the `media/` folder so the webview can load
 *    only the sibling scripts and styles it ships;
 *  - enables `retainContextWhenHidden` so the input draft, rendered state, and DOM
 *    survive the panel tab being hidden or switched away from;
 *  - plumbs messages both ways: it forwards {@link ConfigPanelHostToWebview} messages
 *    from the controller to the webview and delivers {@link ConfigPanelWebviewToHost}
 *    messages from the webview to the registered handler.
 *
 * Unlike the ChatViewProvider (which resolves a view registered in the sidebar),
 * a WebviewPanel is created rather than resolved, so `retainContextWhenHidden` is a
 * creation option here rather than a registration-time option.
 *
 * No `WebviewPanelSerializer` is registered: nothing in the spec asks for the panel
 * to come back after a window reload, and registering one would need its own state contract.
 *
 * `makeNonce`, `renderHtml`, and `readShell` are duplicated from `chatWebview.ts`.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as crypto from 'crypto';
import type {
  ConfigPanelHostToWebview,
  ConfigPanelWebviewToHost,
} from '../config/configPanel';
import {
  ApplyConfig,
  ConfigPanelController,
  ConfigPanelWebview,
} from './configPanelController';

/** The WebviewPanel view type registered in VS Code. */
export const CONFIG_PANEL_VIEW_TYPE = 'baiton.configPanel';

/** Static HTML shell filename located under `media/`. */
const CONFIG_HTML = 'config.html';

/**
 * The Config Panel WebviewPanel provider. Implements {@link ConfigPanelWebview}
 * and manages the VS Code WebviewPanel lifecycle.
 */
export class ConfigPanelProvider implements ConfigPanelWebview, vscode.Disposable {
  private panel: vscode.WebviewPanel | undefined;
  private pending: ConfigPanelHostToWebview[] = [];
  private messageHandler: ((msg: ConfigPanelWebviewToHost) => void | Promise<void>) | undefined;
  private closeHandler: (() => void) | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly extensionUri: vscode.Uri) {}

  private get mediaUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.extensionUri, 'media');
  }

  // --- ConfigPanelWebview surface -----------------------------------------

  public post(msg: ConfigPanelHostToWebview): void {
    if (this.panel === undefined) {
      this.pending.push(msg);
      return;
    }
    void this.panel.webview.postMessage(msg);
  }

  public onMessage(handler: (msg: ConfigPanelWebviewToHost) => void | Promise<void>): void {
    this.messageHandler = handler;
  }

  public onClose(handler: () => void): void {
    this.closeHandler = handler;
  }

  // --- Panel lifecycle ----------------------------------------------------

  public createOrReveal(): void {
    if (this.panel !== undefined) {
      this.panel.reveal(this.panel.viewColumn ?? vscode.ViewColumn.Active, false);
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      CONFIG_PANEL_VIEW_TYPE,
      'Baiton Config',
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [this.mediaUri],
      },
    );
    this.panel = panel;

    panel.webview.html = this.renderHtml(panel.webview);

    panel.webview.onDidReceiveMessage(
      (msg: ConfigPanelWebviewToHost) => this.messageHandler?.(msg),
      undefined,
      this.disposables,
    );

    panel.onDidDispose(
      () => {
        this.panel = undefined;
        this.pending = [];
        this.closeHandler?.();
      },
      undefined,
      this.disposables,
    );

    this.flushPending();
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    if (this.panel !== undefined) {
      this.panel.dispose();
      this.panel = undefined;
    }
    this.closeHandler?.();
  }

  // --- HTML rendering -----------------------------------------------------

  private flushPending(): void {
    if (this.panel === undefined) {
      return;
    }
    const buffered = this.pending;
    this.pending = [];
    for (const msg of buffered) {
      void this.panel.webview.postMessage(msg);
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const baseUri = webview.asWebviewUri(this.mediaUri).toString();
    const template = this.readShell();
    return template
      .replace(/\$\{nonce\}/g, nonce)
      .replace(/\$\{cspSource\}/g, webview.cspSource)
      .replace(/\$\{baseUri\}/g, baseUri);
  }

  private readShell(): string {
    const htmlPath = vscode.Uri.joinPath(this.mediaUri, CONFIG_HTML).fsPath;
    return fs.readFileSync(htmlPath, 'utf8');
  }
}

/**
 * A fresh, unpredictable nonce for the per-load CSP.
 * Duplicated from chatWebview.ts:makeNonce().
 */
function makeNonce(): string {
  return crypto.randomBytes(16).toString('hex');
}

/** Dependencies for opening the Config Panel. */
export interface OpenConfigPanelDeps {
  extensionUri: vscode.Uri;
  baitonDir: string;
  agentIds: readonly string[];
  log(message: string): void;
  applyConfig?: ApplyConfig;
}

const activePanels = new Map<string, ConfigPanelProvider>();

/**
 * Open or reveal the Config Panel for a given Baiton directory.
 * Maintains a module-level singleton per baitonDir.
 */
export function openConfigPanel(deps: OpenConfigPanelDeps): ConfigPanelProvider {
  const existing = activePanels.get(deps.baitonDir);
  if (existing !== undefined) {
    existing.createOrReveal();
    return existing;
  }

  const provider = new ConfigPanelProvider(deps.extensionUri);
  const controller = new ConfigPanelController({
    webview: provider,
    baitonDir: deps.baitonDir,
    agentIds: deps.agentIds,
    confirmReset: async (message: string) => {
      const choice = await vscode.window.showWarningMessage(message, { modal: true }, 'Reset');
      return choice === 'Reset';
    },
    applyConfig: deps.applyConfig,
    log: deps.log,
  });
  controller.start();
  provider.createOrReveal();

  activePanels.set(deps.baitonDir, provider);
  provider.onClose(() => {
    activePanels.delete(deps.baitonDir);
  });

  return provider;
}
