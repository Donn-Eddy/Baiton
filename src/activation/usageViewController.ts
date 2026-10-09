/**
 * The Usage view controller (spec first-party-usage, todo T08).
 *
 * This is the host-free half of baiton.usageView. Every host capability —
 * the webview, trust, the refresh-interval setting, the clock and logging —
 * arrives as a seam, so the whole controller is unit-testable without the
 * `vscodeLoader` hook. Nothing reads, spawns or starts a timer before the view
 * is first shown: construction and start() are inert.
 */
import {
  USAGE_TOOL_IDS,
  normaliseRefreshIntervalSeconds,
  readingsMessage,
  stateMessage,
} from '../usage';
import type { UsageHostToWebview, UsageReading, UsageToolId } from '../usage';
import { parseUsageWebviewMessage } from '../usage/protocol';

/** The webview surface the controller drives (same two-method shape as ConfigPanelWebview). */
export interface UsageViewWebview {
  /** Post one message to the webview. */
  post(msg: UsageHostToWebview): void;
  /** Register the raw message handler; the controller validates what arrives. */
  onMessage(handler: (msg: unknown) => void | Promise<void>): void;
}

/** The subset of UsageService the controller drives (a real UsageService satisfies it; tests may fake it). */
export interface UsageViewService {
  refresh(tools?: readonly UsageToolId[]): Promise<readonly UsageReading[]>;
  snapshot(): readonly UsageReading[];
  onDidChange(l: (r: readonly UsageReading[]) => void): { dispose(): void };
  startPolling(intervalSeconds: unknown): void;
  stopPolling(): void;
  dispose(): void;
}

export interface UsageViewControllerDeps {
  webview: UsageViewWebview;
  service: UsageViewService;
  /** read on every use (setting baiton.usage.refreshIntervalSeconds) */
  getRefreshIntervalSeconds(): unknown;
  isTrusted(): boolean;
  now?(): number;
  log(message: string): void;
}

function describe(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export class UsageViewController {
  private disposed = false;
  private started = false;
  private visible = false;
  private hasRead = false;
  private activeRefreshes = 0;
  private serviceSub: { dispose(): void } | undefined;

  /** Stores the deps only; calls no seam. */
  constructor(private readonly deps: UsageViewControllerDeps) {}

  /** Registers the message handler and the service subscription; does not read or poll. */
  start(): void {
    if (this.disposed) return;
    if (!this.started) {
      this.started = true;
      this.deps.webview.onMessage((raw) =>
        this.handle(raw).catch((e) =>
          this.deps.log('UsageViewController: unexpected error handling message: ' + describe(e)),
        ),
      );
    }
    if (this.serviceSub === undefined) {
      this.serviceSub = this.deps.service.onDidChange(() => this.postReadings());
    }
  }

  private async handle(raw: unknown): Promise<void> {
    if (this.disposed) return;
    const msg = parseUsageWebviewMessage(raw);
    if (msg === undefined) {
      let what: string;
      try {
        what = JSON.stringify((raw as { type?: unknown } | null | undefined)?.type) ?? String(raw);
      } catch {
        what = 'unknown';
      }
      this.deps.log('UsageViewController: unrecognised message type: ' + what);
      return;
    }
    if (msg.type === 'ready') {
      this.postState();
      this.postReadings();
      if (this.visible && !this.hasRead) await this.refresh();
      return;
    }
    await this.refresh();
  }

  /** Called from onDidChangeVisibility and once at resolve. Polls only while visible. */
  setVisible(visible: boolean): void {
    if (this.disposed || visible === this.visible) return;
    this.visible = visible;
    if (visible) {
      this.startPolling();
      void this.refresh();
    } else {
      try {
        this.deps.service.stopPolling();
      } catch (e) {
        this.deps.log('UsageViewController: stopping the poll failed: ' + describe(e));
      }
    }
  }

  /** Reads every tool; used by the webview button and the baiton.usage.refresh command. Never throws. */
  async refresh(): Promise<void> {
    if (this.disposed) return;
    this.hasRead = true;
    this.activeRefreshes++;
    if (this.activeRefreshes === 1) this.postState();
    try {
      await this.deps.service.refresh();
    } catch (e) {
      this.deps.log('UsageViewController: refresh failed: ' + describe(e));
    } finally {
      this.activeRefreshes--;
      if (!this.disposed) {
        this.postState();
        this.postReadings();
      }
    }
  }

  /** The refresh-interval setting changed. */
  notifyIntervalChanged(): void {
    if (this.disposed) return;
    if (this.visible) this.startPolling();
    this.postState();
  }

  /** Workspace trust changed; re-read with credentials allowed when visible. */
  notifyTrustChanged(): void {
    if (this.disposed) return;
    this.postState();
    if (this.visible) void this.refresh();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    try {
      this.serviceSub?.dispose();
    } catch (e) {
      this.deps.log('UsageViewController: disposing the subscription failed: ' + describe(e));
    }
    this.serviceSub = undefined;
    try {
      this.deps.service.stopPolling();
    } catch (e) {
      this.deps.log('UsageViewController: stopping the poll failed: ' + describe(e));
    }
    try {
      this.deps.service.dispose();
    } catch (e) {
      this.deps.log('UsageViewController: disposing the service failed: ' + describe(e));
    }
  }

  private startPolling(): void {
    try {
      this.deps.service.startPolling(this.deps.getRefreshIntervalSeconds());
    } catch (e) {
      this.deps.log('UsageViewController: starting the poll failed: ' + describe(e));
    }
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private safeTrusted(): boolean {
    try {
      return this.deps.isTrusted() === true;
    } catch {
      return false;
    }
  }

  private postState(): void {
    if (this.disposed) return;
    let interval: number;
    try {
      interval = normaliseRefreshIntervalSeconds(this.deps.getRefreshIntervalSeconds());
    } catch {
      interval = normaliseRefreshIntervalSeconds(undefined);
    }
    this.post(
      stateMessage({
        refreshing: this.activeRefreshes > 0,
        trusted: this.safeTrusted(),
        refreshIntervalSeconds: interval,
        now: this.now(),
      }),
    );
  }

  private postReadings(): void {
    if (this.disposed) return;
    const inFlight: ReadonlySet<UsageToolId> =
      this.activeRefreshes > 0 ? new Set(USAGE_TOOL_IDS) : new Set();
    this.post(readingsMessage(this.deps.service.snapshot(), inFlight, this.now()));
  }

  private post(msg: UsageHostToWebview): void {
    try {
      this.deps.webview.post(msg);
    } catch (e) {
      this.deps.log('UsageViewController: posting to the webview failed: ' + describe(e));
    }
  }
}
