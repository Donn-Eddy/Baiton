import * as assert from 'assert';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';

/**
 * Unit tests for Surface's silent 'API' output channel. Both channels are
 * injected fakes, so `vscode.window.createOutputChannel` is never touched.
 */

interface Notification {
  readonly kind: 'info' | 'warning' | 'error';
  readonly message: string;
}

/** Records everything Surface does to a channel. */
class FakeChannel {
  public readonly lines: string[] = [];
  public showCalls = 0;
  public hideCalls = 0;
  public disposed = false;
  constructor(public readonly name: string) {}
  public appendLine(line: string): void {
    this.lines.push(line);
  }
  public append(_value: string): void {}
  public show(): void {
    this.showCalls += 1;
  }
  public hide(): void {
    this.hideCalls += 1;
  }
  public clear(): void {}
  public replace(_value: string): void {}
  public dispose(): void {
    this.disposed = true;
  }
}

type OutputChannel = import('vscode').OutputChannel;
type SurfaceModule = typeof import('../src/activation/surface');

function asChannel(c: FakeChannel): OutputChannel {
  return c as unknown as OutputChannel;
}

describe('Surface API channel', () => {
  let mod: SurfaceModule;
  let notifications: Notification[];
  let main: FakeChannel;
  let api: FakeChannel;
  let surface: InstanceType<SurfaceModule['Surface']>;
  const g = globalThis as unknown as { __vscodeFake?: unknown };
  let previous: unknown;

  before(async () => {
    const root = process.cwd();
    register(
      pathToFileURL(join(root, 'test', 'fixtures', 'vscodeLoader.mjs')).href,
      pathToFileURL(join(root, '/')).href,
    );
    await import('./fixtures/vscodeLoader.mjs');
    mod = (await import('../src/activation/surface')) as SurfaceModule;
    previous = g.__vscodeFake;
  });

  after(() => {
    if (previous === undefined) {
      delete g.__vscodeFake;
    } else {
      g.__vscodeFake = previous;
    }
  });

  beforeEach(() => {
    notifications = [];
    const note = (kind: Notification['kind']) => (message: string) => {
      notifications.push({ kind, message });
      return Promise.resolve(undefined);
    };
    g.__vscodeFake = {
      window: {
        showInformationMessage: note('info'),
        showWarningMessage: note('warning'),
        showErrorMessage: note('error'),
        showInputBox: async () => undefined,
        showQuickPick: async () => undefined,
        registerWebviewViewProvider: () => ({ dispose() {} }),
        registerTreeDataProvider: () => ({ dispose() {} }),
      },
      commands: { executeCommand: async () => undefined },
    };
    main = new FakeChannel('Baiton');
    api = new FakeChannel('API');
    surface = new mod.Surface(asChannel(main), asChannel(api));
  });

  it('writes API failures to the separate API channel, not the Baiton channel', () => {
    surface.logApiFailure({
      surface: 'openai',
      operation: 'completion',
      kind: 'http-status',
      status: 500,
      target: 'https://api.example.com/v1/chat/completions',
      message: 'server error',
    });
    assert.strictEqual(api.lines.length, 1);
    assert.strictEqual(main.lines.length, 0);
    assert.match(
      api.lines[0],
      /^\[\d{4}-\d{2}-\d{2}T[^\]]+\] openai completion http-status HTTP 500 https:\/\/api\.example\.com\/v1\/chat\/completions — server error$/,
    );
  });

  it('apiLog.failure writes through the same channel', () => {
    surface.apiLog.failure({
      surface: 'openai',
      operation: 'completion',
      kind: 'timeout',
      message: 'timed out',
    });
    assert.strictEqual(api.lines.length, 1);
    assert.strictEqual(main.lines.length, 0);
  });

  it('is silent', () => {
    for (let i = 0; i < 3; i += 1) {
      surface.logApiFailure({
        surface: 'openai',
        operation: 'completion',
        kind: 'connection',
        message: 'refused',
      });
      surface.apiLog.failure({
        surface: 'openai',
        operation: 'model list',
        kind: 'abort',
        message: 'aborted',
      });
    }
    assert.strictEqual(api.showCalls, 0);
    assert.strictEqual(main.showCalls, 0);
    assert.deepStrictEqual(notifications, []);
  });

  it('redacts secrets on the way to the channel', () => {
    surface.logApiFailure({
      surface: 'openai',
      operation: 'completion',
      kind: 'http-status',
      status: 401,
      message: 'failed with Authorization: Bearer sk-abcdefghijklmnopqrstuvwx',
      bodyExcerpt: '{"error":"bad api_key=sk-zzzzzzzzzzzzzzzzzzzzzz"}',
    });
    const line = api.lines.join('\n');
    assert.ok(!line.includes('sk-abcdefghijklmnop'));
    assert.ok(!line.includes('sk-zzzzzzzz'));
    assert.ok(line.includes('[REDACTED]'));
  });

  it('exposes the API channel for disposal, distinct from the Baiton channel', () => {
    assert.strictEqual(surface.apiOutputChannel, asChannel(api));
    assert.strictEqual(surface.outputChannel, asChannel(main));
    assert.notStrictEqual(surface.apiOutputChannel, surface.outputChannel);
    surface.apiOutputChannel.dispose();
    assert.strictEqual(api.disposed, true);
    assert.strictEqual(main.disposed, false);
  });

  it('existing Baiton channel behaviour is unchanged', () => {
    surface.log('hello');
    assert.strictEqual(main.lines.length, 1);
    assert.ok(main.lines[0].endsWith('] hello'));
    assert.strictEqual(api.lines.length, 0);
    surface.warn('w');
    assert.strictEqual(notifications.length, 1);
    assert.strictEqual(notifications[0].kind, 'warning');
    assert.strictEqual(main.lines.length, 2);
    assert.ok(main.lines[1].endsWith('] WARN: w'));
    assert.strictEqual(api.lines.length, 0);
  });

  it('API_CHANNEL_NAME is API', () => {
    assert.strictEqual(mod.API_CHANNEL_NAME, 'API');
  });

  it('a throwing channel never breaks the caller', () => {
    api.appendLine = () => {
      throw new Error('boom');
    };
    assert.doesNotThrow(() =>
      surface.logApiFailure({
        surface: 'openai',
        operation: 'completion',
        kind: 'timeout',
        message: 'x',
      }),
    );
  });
});
