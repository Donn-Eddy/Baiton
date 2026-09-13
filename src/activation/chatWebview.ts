/**
 * The Chat_View {@link vscode.WebviewViewProvider} (task 12.1; design "Chat
 * WebviewView provider + ChatController"; Requirements 12, 16, 19.2).
 *
 * This is the thin `vscode` glue that owns the webview lifecycle and the
 * message channel to and from the browser context. Everything it renders is
 * driven by the {@link ChatController} through the host-free
 * {@link HostToWebview}/{@link WebviewToHost} protocol; the provider itself only:
 *
 *  - resolves the view, loading the static shell under `media/` with a fresh
 *    per-load nonce and a strict Content Security Policy that admits only
 *    scripts bearing that nonce (Req 16.1, 16.2);
 *  - limits `localResourceRoots` to the `media/` folder so the webview can load
 *    only the sibling scripts and styles it ships (Req 16.3);
 *  - enables `retainContextWhenHidden` so the input draft and rendered state
 *    survive the view being hidden (Req 16.4, 16.5);
 *  - plumbs messages both ways: it forwards {@link HostToWebview} messages from
 *    the controller to the webview and delivers {@link WebviewToHost} messages
 *    from the webview to the registered handler.
 *
 * The provider buffers host→webview messages posted before the view is
 * resolved (or while it is hidden and torn down) and flushes them on the next
 * resolve, so the controller can render an initial conversation without racing
 * the view's first load. On each fresh resolve the controller is re-started so
 * the just-loaded webview receives the current conversation (Req 8.8).
 */
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as crypto from 'crypto';
import type { ChatWebview } from './chatController';
import type { HostToWebview, WebviewToHost } from '../orchestrator';

/** The view id contributed in `package.json` (task 14.1) for the Chat_View. */
export const CHAT_VIEW_ID = 'baiton.chatView';

/** The `media/` file names the webview shell loads (task 11.1). */
const CHAT_HTML = 'chat.html';

/**
 * The Chat_View provider. Construct it with the extension URI, register it with
 * `vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, provider, { ... })`,
 * and pass it to the {@link ChatController} as its {@link ChatWebview} surface.
 * The provider re-invokes {@link onResolve} on every fresh resolve so the
 * controller can reload the conversation after a window reload (Req 8.8).
 */
export class ChatWebviewProvider
  implements vscode.WebviewViewProvider, ChatWebview
{
  private view: vscode.WebviewView | undefined;

  /** The single webview→host handler the controller registers (Req plumbing). */
  private messageHandler: ((msg: WebviewToHost) => void) | undefined;

  /** Host→webview messages posted before the view was ready, flushed on resolve. */
  private pending: HostToWebview[] = [];

  /** Called after each fresh resolve so the controller can (re)start rendering. */
  private resolveHandler: (() => void) | undefined;

  private readonly disposables: vscode.Disposable[] = [];

  /**
   * @param extensionUri the extension root URI; `media/` under it holds the
   *   webview shell and scripts and is the only allowed local resource root.
   */
  constructor(private readonly extensionUri: vscode.Uri) {}

  /**
   * The registration options the caller passes as the third argument of
   * `vscode.window.registerWebviewViewProvider(CHAT_VIEW_ID, provider, ...)`.
   * `retainContextWhenHidden` keeps the webview's DOM and input draft alive
   * while the view is hidden (Req 16.4, 16.5); it is a registration-time
   * option, not a per-resolve one.
   */
  public static readonly registration: {
    readonly webviewOptions: { readonly retainContextWhenHidden: true };
  } = { webviewOptions: { retainContextWhenHidden: true } };

  /** The `media/` directory URI, the webview's sole local resource root (Req 16.3). */
  private get mediaUri(): vscode.Uri {
    return vscode.Uri.joinPath(this.extensionUri, 'media');
  }

  // --- ChatWebview surface -------------------------------------------------

  /** Forward one host→webview message, buffering it until the view is ready. */
  public post(msg: HostToWebview): void {
    if (this.view === undefined) {
      this.pending.push(msg);
      return;
    }
    void this.view.webview.postMessage(msg);
  }

  /** Register the webview→host handler (the controller's message dispatcher). */
  public onMessage(handler: (msg: WebviewToHost) => void): void {
    this.messageHandler = handler;
  }

  /**
   * Register a callback invoked after each fresh resolve, so the caller can
   * (re)start the controller against the newly loaded webview. Set this before
   * the view first resolves.
   */
  public onResolve(handler: () => void): void {
    this.resolveHandler = handler;
  }

  // --- WebviewViewProvider -------------------------------------------------

  /**
   * Resolve the view: lock down the webview options, load the nonce'd shell,
   * and wire the message channel. VS Code calls this on first reveal and again
   * after a window reload; each call rebuilds the HTML with a fresh nonce and
   * notifies the resolve handler so the conversation is reloaded (Req 16, 8.8).
   */
  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;

    webviewView.webview.options = {
      enableScripts: true,
      // Only the media/ folder is a permitted local resource root (Req 16.3).
      localResourceRoots: [this.mediaUri],
    };
    // `retainContextWhenHidden` is not set here: it is a registration-time
    // option on `registerWebviewViewProvider`'s `webviewOptions` (Req 16.4).
    // {@link ChatWebviewProvider.registration} carries it for the caller.

    webviewView.webview.html = this.renderHtml(webviewView.webview);

    // Deliver webview→host messages to the controller's handler.
    webviewView.webview.onDidReceiveMessage(
      (msg: WebviewToHost) => this.messageHandler?.(msg),
      undefined,
      this.disposables,
    );

    // Drop the reference when the view is disposed so a later post buffers again.
    webviewView.onDidDispose(
      () => {
        this.view = undefined;
      },
      undefined,
      this.disposables,
    );

    // Flush anything posted before the view existed, then let the controller
    // (re)render the current conversation into the fresh webview (Req 8.8).
    this.flushPending();
    this.resolveHandler?.();
  }

  /** Dispose the message/lifecycle listeners. */
  public dispose(): void {
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables.length = 0;
  }

  // --- html ----------------------------------------------------------------

  /** Post every buffered host→webview message in order, then clear the buffer. */
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

  /**
   * Build the webview HTML from the `media/` shell, substituting the per-load
   * nonce, the webview `cspSource`, and the `media/` base URI the shell's
   * script/style tags resolve against (Req 16.1, 16.2, 16.3).
   */
  private renderHtml(webview: vscode.Webview): string {
    const nonce = makeNonce();
    const baseUri = webview.asWebviewUri(this.mediaUri).toString();
    const template = this.readShell();
    return template
      .replace(/\$\{nonce\}/g, nonce)
      .replace(/\$\{cspSource\}/g, webview.cspSource)
      .replace(/\$\{baseUri\}/g, baseUri);
  }

  /**
   * Read the `media/chat.html` shell synchronously so the HTML is available the
   * moment the view resolves. The file ships with the extension under `media/`,
   * the sole local resource root.
   */
  private readShell(): string {
    // Read from the packaged extension directory. `fs` is used here (not the
    // webview fs) because the shell is host-side content the provider owns.
    const htmlPath = vscode.Uri.joinPath(this.mediaUri, CHAT_HTML).fsPath;
    return fs.readFileSync(htmlPath, 'utf8');
  }
}

/**
 * A fresh, unpredictable nonce for the per-load CSP (Req 16.1). Uses a
 * 128-bit random value rendered as base64, which is admitted by the shell's
 * `script-src 'nonce-...'` policy and by nothing else.
 */
function makeNonce(): string {
  // Hex keeps the nonce to the CSP-safe `[A-Za-z0-9]` set (no `+`/`/`/`=`).
  return crypto.randomBytes(16).toString('hex');
}
