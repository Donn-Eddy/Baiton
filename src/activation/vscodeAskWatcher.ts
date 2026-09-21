/** VS Code-backed routing of one launched run's file-relayed harness asks. */
import * as path from 'path';
import * as vscode from 'vscode';
import {
  askFilePath,
  askIdFromFileName,
  describeAskRelayError,
  listPendingAskIds,
  nodeAskRelayIo,
  parseAsk,
  responseFromAnswer,
  toInterventionRequest,
  writeResponse,
} from '../engine';
import type { AskRelayIo, AskWatcher, AskWatcherFactory, RelayAsk } from '../engine';
import { PendingAskRegistry } from '../orchestrator';
import type { Intervention, InterventionAnswer } from '../orchestrator';

/** The reason a still-pending relayed ask is declined with when its run settles. */
export const RUN_SETTLED_DECLINE_REASON = 'the run ended before this ask was answered';

/** The seams the ask watcher routes through; all host-free so routing is unit-testable. */
export interface AskRoute {
  registry: PendingAskRegistry;
  present(ask: Intervention): void | Promise<void>;
  decline(id: string, reason: string): void | Promise<void>;
  log(message: string): void;
  now?(): string;
  io?: AskRelayIo;
}

interface AskWatcherInput {
  slug: string;
  todoId: string;
  runId: string;
  agent: string;
  asksDir: string;
}

class VscodeAskWatcher implements AskWatcher {
  private readonly fileWatcher: vscode.FileSystemWatcher;
  private readonly seen = new Set<string>();
  private readonly inFlight = new Map<string, RelayAsk>();
  private readonly io: AskRelayIo;
  private readonly now: () => string;
  private disposed = false;

  constructor(private readonly input: AskWatcherInput, private readonly route: AskRoute) {
    this.io = route.io ?? nodeAskRelayIo;
    this.now = route.now ?? (() => new Date().toISOString());
    // An explicit Uri-based RelativePattern remains correct when VS Code opened
    // a symlinked spelling of the workspace while Baiton uses its canonical path.
    const pattern = new vscode.RelativePattern(vscode.Uri.file(input.asksDir), '*.json');
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(pattern);
    this.fileWatcher.onDidCreate((uri) => void this.onFile(path.basename(uri.fsPath)));
    this.fileWatcher.onDidChange((uri) => void this.onFile(path.basename(uri.fsPath)));
    try {
      for (const id of listPendingAskIds(input.asksDir, this.io)) {
        void this.onAsk(id);
      }
    } catch (err) {
      route.log(`Baiton ask relay: could not list asks: ${describe(err)}`);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.fileWatcher.dispose();
    for (const id of [...this.inFlight.keys()]) {
      void this.route.decline(id, RUN_SETTLED_DECLINE_REASON);
    }
  }

  private onFile(fileName: string): void {
    const askId = askIdFromFileName(fileName);
    if (askId !== undefined) void this.onAsk(askId);
  }

  private async onAsk(askId: string): Promise<void> {
    if (this.disposed || this.seen.has(askId)) return;
    this.seen.add(askId);
    const fileName = `${askId}.json`;
    let raw: string;
    try {
      raw = this.io.readFile(askFilePath(this.input.asksDir, askId));
    } catch {
      this.seen.delete(askId);
      return;
    }
    const parsed = parseAsk(raw);
    if (!parsed.ok) {
      this.route.log(`Baiton ask relay: ignoring ${fileName}: ${describeAskRelayError(parsed.error)}`);
      return;
    }
    const ask = parsed.value;
    if (ask.runId !== this.input.runId) {
      this.route.log(`Baiton ask relay: ignoring ${fileName}: run id does not match`);
      return;
    }
    if (ask.id !== askId) {
      this.route.log(`Baiton ask relay: ignoring ${fileName}: ask id does not match file name`);
      return;
    }
    const { intervention, answer } = this.route.registry.create(toInterventionRequest(ask));
    const card: Intervention = { ...intervention, scopeId: this.input.slug };
    this.inFlight.set(intervention.id, ask);
    try {
      await this.route.present(card);
    } catch (err) {
      this.route.registry.reject(intervention.id, `the ask could not be shown: ${describe(err)}`);
    }
    const given = await answer;
    this.inFlight.delete(intervention.id);
    this.respond(ask, given);
  }

  private respond(ask: RelayAsk, answer: InterventionAnswer): void {
    try {
      writeResponse(this.input.asksDir, responseFromAnswer(ask, answer, this.now()), this.io);
    } catch (err) {
      this.route.log(`Baiton ask relay: could not write response for ${ask.id}.json: ${describe(err)}`);
    }
  }
}

/** Build a factory that creates VS Code-backed ask watchers. */
export function createVscodeAskWatcherFactory(route: AskRoute): AskWatcherFactory {
  return { create: (input) => new VscodeAskWatcher(input, route) };
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
