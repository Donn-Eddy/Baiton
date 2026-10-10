/**
 * The Usage WebviewView provider and its registration (spec first-party-usage, todo T10).
 *
 * Thin `vscode` glue mirroring `configPanel.ts`: it resolves the contributed
 * `baiton.usageView`, loads `media/usage.html` with a fresh nonce, and wires
 * the host-free {@link UsageViewController} and {@link UsageService} to it.
 * Nothing — seams, readers, service, timer — is constructed before the view is
 * first resolved, and everything is torn down when the view is disposed, so
 * there is no background polling without the view.
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as crypto from 'crypto';
import { UsageViewController } from './usageViewController';
import type { UsageViewWebview } from './usageViewController';
import { createNodeUsageSeams } from './usageViewSeams';
import type { NodeUsageSeamOptions } from './usageViewSeams';
import { UsageService, createUsageReaders } from '../usage';
import type {
  UsageCliName,
  UsageHostToWebview,
  UsageReader,
  UsageReaderTableSeams,
  UsageTimer,
  UsageToolId,
} from '../usage';

/** The contributed WebviewView id. */
export const USAGE_VIEW_ID = 'baiton.usageView';
/** Focusing an unexpanded view resolves it. */
export const USAGE_VIEW_FOCUS_COMMAND = USAGE_VIEW_ID + '.focus';
export const USAGE_REFRESH_COMMAND = 'baiton.usage.refresh';
export const USAGE_SETTINGS_SECTION = 'baiton';
export const USAGE_REFRESH_INTERVAL_KEY = 'usage.refreshIntervalSeconds';

const USAGE_HTML = 'usage.html';

export class UsageViewProvider implements vscode.WebviewViewProvider, UsageViewWebview, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private pending: UsageHostToWebview[] = [];
  private messageHandler: ((msg: unknown) => void | Promise<void>) | undefined;
  private resolveHandler: ((view: vscode.WebviewView) => void) | undefined;
  private visibilityHandler: ((visible: boolean) => void) | undefined;
  private viewDisposedHandler: (() => void) | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(private readonly extensionUri: vscode.Uri) {}

  /** Registration-time options for `registerWebviewViewProvider`. */
  public static readonly registration: {
    readonly webviewOptions: { readonly retainContextWhenHidden: true };
  } = { webviewOptions: { retainContextWhenHidden: true } };

  private get mediaUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.extensionUri, 'media');
  }

  // --- UsageViewWebview surface -------------------------------------------

  public post(msg: UsageHostToWebview): void {
    if (this.view === undefined) {
      this.pending.push(msg);
      return;
    }
    void this.view.webview.postMessage(msg);
  }

  public onMessage(handler: (msg: unknown) => void | Promise<void>): void {
    this.messageHandler = handler;
  }

  public onResolve(handler: (view: vscode.WebviewView) => void): void {
    this.resolveHandler = handler;
  }

  public onVisibilityChange(handler: (visible: boolean) => void): void {
    this.visibilityHandler = handler;
  }

  public onViewDisposed(handler: () => void): void {
    this.viewDisposedHandler = handler;
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
      (msg: unknown) => {
        const res = this.messageHandler?.(msg);
        if (res && typeof (res as Promise<void>).catch === 'function') {
          (res as Promise<void>).catch(() => {});
        }
      },
      undefined,
      this.disposables,
    );
    webviewView.onDidChangeVisibility(
      () => this.visibilityHandler?.(webviewView.visible),
      undefined,
      this.disposables,
    );
    webviewView.onDidDispose(
      () => {
        this.view = undefined;
        this.pending = [];
        this.viewDisposedHandler?.();
      },
      undefined,
      this.disposables,
    );

    this.flushPending();
    this.resolveHandler?.(webviewView);
  }

  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
    this.view = undefined;
  }

  private flushPending(): void {
    if (this.view === undefined) return;
    const buffered = this.pending;
    this.pending = [];
    for (const msg of buffered) {
      void this.view.webview.postMessage(msg);
    }
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = crypto.randomBytes(16).toString('hex');
    const baseUri = webview.asWebviewUri(this.mediaUri).toString();
    const htmlPath = vscode.Uri.joinPath(this.mediaUri, USAGE_HTML).fsPath;
    return fs
      .readFileSync(htmlPath, 'utf8')
      .replace(/\$\{nonce\}/g, nonce)
      .replace(/\$\{cspSource\}/g, webview.cspSource)
      .replace(/\$\{baseUri\}/g, baseUri);
  }
}

/** Dependencies of {@link registerUsageView}; the optional ones are test seams. */
export interface RegisterUsageViewDeps {
  extensionUri: vscode.Uri;
  log(message: string): void;
  resolveExecutable(cli: UsageCliName): string | undefined;
  createReaders?: (seams: UsageReaderTableSeams) => Readonly<Record<UsageToolId, UsageReader>>;
  createSeams?: (opts: NodeUsageSeamOptions) => UsageReaderTableSeams;
  now?(): number;
  timer?: UsageTimer;
}

/** Registers the Usage view, its refresh command and the trust/setting listeners. */
export function registerUsageView(deps: RegisterUsageViewDeps): vscode.Disposable {
  const provider = new UsageViewProvider(deps.extensionUri);
  const createReaders = deps.createReaders ?? createUsageReaders;
  const createSeams = deps.createSeams ?? createNodeUsageSeams;

  const isTrusted = (): boolean => {
    try {
      return vscode.workspace.isTrusted === true;
    } catch {
      return false;
    }
  };
  const getInterval = (): unknown =>
    vscode.workspace.getConfiguration(USAGE_SETTINGS_SECTION).get<unknown>(USAGE_REFRESH_INTERVAL_KEY);

  let controller: UsageViewController | undefined;

  const ensureController = (view: vscode.WebviewView): void => {
    if (controller !== undefined) return;
    const seams = createSeams({
      resolveExecutable: deps.resolveExecutable,
      isTrusted,
      log: deps.log,
    });
    const readers = createReaders(seams);
    const service = new UsageService({
      readers,
      isTrusted,
      log: deps.log,
      now: deps.now,
      timer: deps.timer,
    });
    controller = new UsageViewController({
      webview: provider,
      service,
      getRefreshIntervalSeconds: getInterval,
      isTrusted,
      now: deps.now,
      log: deps.log,
    });
    controller.start();
    controller.setVisible(view.visible);
  };

  provider.onResolve(ensureController);
  provider.onVisibilityChange((visible) => controller?.setVisible(visible));
  provider.onViewDisposed(() => {
    controller?.dispose();
    controller = undefined;
  });

  const subscriptions: vscode.Disposable[] = [
    vscode.workspace.onDidGrantWorkspaceTrust(() => controller?.notifyTrustChanged()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${USAGE_SETTINGS_SECTION}.${USAGE_REFRESH_INTERVAL_KEY}`)) {
        controller?.notifyIntervalChanged();
      }
    }),
    vscode.commands.registerCommand(USAGE_REFRESH_COMMAND, async () => {
      if (controller !== undefined) {
        await controller.refresh();
        return;
      }
      try {
        await vscode.commands.executeCommand(USAGE_VIEW_FOCUS_COMMAND);
      } catch {
        deps.log('Baiton: the Usage view is not available.');
      }
    }),
  ];

  return vscode.Disposable.from(
    vscode.window.registerWebviewViewProvider(USAGE_VIEW_ID, provider, UsageViewProvider.registration),
    provider,
    ...subscriptions,
    {
      dispose: () => {
        controller?.dispose();
        controller = undefined;
      },
    },
  );
}
