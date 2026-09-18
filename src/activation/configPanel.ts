/**
 * The Config_Panel WebviewView provider (spec "Config Panel", config-panel, todo T11).
 *
 * This is the thin `vscode` glue that owns the sidebar WebviewView lifecycle
 * and the message channel to and from the browser context. Everything it renders is
 * driven by the {@link ConfigPanelController} through the host-free
 * {@link ConfigPanelHostToWebview}/{@link ConfigPanelWebviewToHost} protocol; the
 * provider itself only:
 *
 *  - resolves the view contributed to the Baiton container, loading the static shell
 *    under `media/` with a fresh per-load nonce and a strict Content Security Policy
 *    that admits only scripts bearing that nonce;
 *  - limits `localResourceRoots` to the `media/` folder so the webview can load
 *    only the sibling scripts and styles it ships;
 *  - exposes {@link ConfigPanelProvider.registration} carrying `retainContextWhenHidden`
 *    as a registration-time option on `registerWebviewViewProvider` so the input draft,
 *    rendered state, and DOM survive the view section being collapsed or hidden;
 *  - plumbs messages both ways: it forwards {@link ConfigPanelHostToWebview} messages
 *    from the controller to the webview and delivers {@link ConfigPanelWebviewToHost}
 *    messages from the webview to the registered handler.
 *
 * Unlike the earlier WebviewPanel implementation (T05), this is a contributed
 * `WebviewView` registered once at activation, whose section in the Baiton container
 * is managed by VS Code.
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
import type { Config } from '../config/types';
import type { AgentCapabilities } from '../adapter';
import {
  ConfigPanelController,
  ConfigPanelWebview,
} from './configPanelController';

/** The contributed WebviewView id registered in VS Code. */
export const CONFIG_VIEW_ID = 'baiton.configPanel';

/** Message shown when workspace resolution fails for the config view. */
export const CONFIG_PANEL_REQUIRE_WORKSPACE_MESSAGE =
  'Baiton: Open Config Panel requires exactly one workspace folder (or one multi-root folder with a .baiton/ directory).';

/** Static HTML shell filename located under `media/`. */
const CONFIG_HTML = 'config.html';

/** Coalesce watcher events on .baiton/config.json within this window (T07). */
export const EXTERNAL_CHANGE_DEBOUNCE_MS = 250;

/**
 * The Config Panel WebviewView provider. Implements {@link ConfigPanelWebview},
 * {@link vscode.WebviewViewProvider}, and {@link vscode.Disposable}.
 */
export class ConfigPanelProvider
  implements vscode.WebviewViewProvider, ConfigPanelWebview, vscode.Disposable
{
  private view: vscode.WebviewView | undefined;
  private pending: ConfigPanelHostToWebview[] = [];
  private messageHandler: ((msg: ConfigPanelWebviewToHost) => void | Promise<void>) | undefined;
  private resolveHandler: (() => void) | undefined;
  private readonly closeHandlers: (() => void)[] = [];
  private closed = false;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly extensionUri: vscode.Uri) {}

  /**
   * The registration options the caller passes as the third argument of
   * `vscode.window.registerWebviewViewProvider(CONFIG_VIEW_ID, provider, ...)`.
   * `retainContextWhenHidden` keeps the webview's DOM and input draft alive
   * while the view is collapsed or hidden; it is a registration-time option,
   * not a per-resolve one.
   */
  public static readonly registration: {
    readonly webviewOptions: { readonly retainContextWhenHidden: true };
  } = { webviewOptions: { retainContextWhenHidden: true } };

  private get mediaUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.extensionUri, 'media');
  }

  // --- ConfigPanelWebview surface -----------------------------------------

  public post(msg: ConfigPanelHostToWebview): void {
    if (this.view === undefined) {
      this.pending.push(msg);
      return;
    }
    void this.view.webview.postMessage(msg);
  }

  public onMessage(handler: (msg: ConfigPanelWebviewToHost) => void | Promise<void>): void {
    this.messageHandler = handler;
  }

  public onResolve(handler: () => void): void {
    this.resolveHandler = handler;
  }

  public onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }

  private notifyClose(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    for (const h of [...this.closeHandlers]) {
      h();
    }
  }

  // --- WebviewViewProvider lifecycle --------------------------------------

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.mediaUri],
    };

    webviewView.webview.html = this.renderHtml(webviewView.webview);

    webviewView.webview.onDidReceiveMessage(
      (msg: ConfigPanelWebviewToHost) => {
        const res = this.messageHandler?.(msg);
        if (res && typeof (res as Promise<void>).catch === 'function') {
          (res as Promise<void>).catch(() => {});
        }
      },
      undefined,
      this.disposables,
    );

    webviewView.onDidDispose(
      () => {
        this.view = undefined;
      },
      undefined,
      this.disposables,
    );

    this.flushPending();
    this.resolveHandler?.();
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.view = undefined;
    this.notifyClose();
  }

  // --- HTML rendering -----------------------------------------------------

  private flushPending(): void {
    if (this.view === undefined) {
      return;
    }
    const buffered = this.pending;
    this.pending = [];
    for (const msg of buffered) {
      void this.view.webview.postMessage(msg);
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

/** Dependencies for registering the Config Panel. */
export interface RegisterConfigPanelDeps {
  extensionUri: vscode.Uri;
  resolveBaitonDir(): string | undefined;
  agentIds: readonly string[];
  capabilities?: Readonly<Record<string, AgentCapabilities>>;
  log(message: string): void;
  applyConfig?(
    baitonDir: string,
    config: Config,
  ): Promise<readonly string[]> | readonly string[];
}

/**
 * Register the Config Panel WebviewView provider with VS Code.
 * Owns the provider, controller, and file watcher across resolves.
 */
export function registerConfigPanel(deps: RegisterConfigPanelDeps): vscode.Disposable {
  const provider = new ConfigPanelProvider(deps.extensionUri);

  let controller: ConfigPanelController | undefined;
  let watcher: vscode.FileSystemWatcher | undefined;
  const watcherSubs: vscode.Disposable[] = [];
  let debounceTimer: NodeJS.Timeout | undefined;

  const teardown = () => {
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
      debounceTimer = undefined;
    }
    for (const sub of watcherSubs) {
      sub.dispose();
    }
    watcherSubs.length = 0;
    if (watcher !== undefined) {
      watcher.dispose();
      watcher = undefined;
    }
    if (controller !== undefined) {
      controller.dispose();
      controller = undefined;
    }
  };

  const ensureController = () => {
    if (controller !== undefined) {
      controller.start();
      return;
    }

    const baitonDir = deps.resolveBaitonDir();
    if (baitonDir === undefined) {
      provider.post({
        type: 'loadFailed',
        kind: 'invalid',
        message: CONFIG_PANEL_REQUIRE_WORKSPACE_MESSAGE,
        canReset: false,
      });
      return;
    }

    controller = new ConfigPanelController({
      webview: provider,
      baitonDir,
      agentIds: deps.agentIds,
      capabilities: deps.capabilities,
      confirmReset: async (message: string) => {
        const choice = await vscode.window.showWarningMessage(message, { modal: true }, 'Reset');
        return choice === 'Reset';
      },
      applyConfig:
        deps.applyConfig !== undefined
          ? (cfg) => deps.applyConfig!(baitonDir, cfg)
          : undefined,
      log: deps.log,
    });

    const pattern = new vscode.RelativePattern(baitonDir, 'config.json');
    watcher = vscode.workspace.createFileSystemWatcher(pattern);

    const schedule = () => {
      if (debounceTimer !== undefined) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        void controller?.notifyExternalChange();
      }, EXTERNAL_CHANGE_DEBOUNCE_MS);
    };

    watcherSubs.push(
      watcher.onDidCreate(schedule),
      watcher.onDidChange(schedule),
      watcher.onDidDelete(schedule),
    );

    controller.start();
  };

  provider.onResolve(() => ensureController());
  provider.onClose(() => teardown());

  return vscode.Disposable.from(
    vscode.window.registerWebviewViewProvider(
      CONFIG_VIEW_ID,
      provider,
      ConfigPanelProvider.registration,
    ),
    provider,
    { dispose: () => teardown() },
  );
}
