import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';
import { HostToWebview, initialWebviewState, reduce, WebviewState } from '../src/orchestrator/webviewProtocol';
import { PROTOCOL_CASES } from './fixtures/protocolCases';

/**
 * Parity tests asserting that the browser mirror `media/protocol.js` and the
 * TypeScript core `src/orchestrator/webviewProtocol.ts` behave identically.
 *
 * NOTE: `assert.deepStrictEqual` over the whole `WebviewState` is intentional.
 * A missing key or a key whose value is `undefined` is distinct to deep-equal
 * checks, so any structural drift between the two reducers must be mirrored in
 * both files or this suite will fail — that is the sync guard working, not a
 * flake. Do not weaken the assertions to compare only part of the state.
 */

export interface ProtocolMirror {
  reduce(state: WebviewState, msg: HostToWebview): WebviewState;
  initialWebviewState(): WebviewState;
}

export function loadProtocolMirror(): ProtocolMirror {
  const sourcePath = path.join(__dirname, '..', 'media', 'protocol.js');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const sandbox: { window: { baitonProtocol?: ProtocolMirror } } = { window: {} };
  vm.runInNewContext(source, sandbox, { filename: 'media/protocol.js' });
  const raw = sandbox.window.baitonProtocol;
  assert.ok(raw, 'window.baitonProtocol was not exported by media/protocol.js');
  return raw;
}

/**
 * A deep clone into the host realm. Objects created inside the `vm` context
 * have a different `Object.prototype`, so mirror results must be re-built in
 * the host realm before `assert.deepStrictEqual` can compare them with
 * TypeScript results. Unlike `JSON.parse(JSON.stringify(...))`, this preserves
 * own keys whose value is `undefined` — a distinction `deepStrictEqual` and
 * this contract both care about.
 */
function hardClone<T>(value: T): T {
  if (Array.isArray(value)) {
    // Array.from builds the result in the host realm; `value.map` would
    // produce a vm-realm array and keep the prototype mismatch.
    return Array.from(value, (v) => hardClone(v)) as unknown as T;
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = hardClone(v);
    }
    return out as T;
  }
  return value;
}

describe('webview protocol browser mirror (chat-interventions-auto-mode T04)', () => {
  let mirror: ProtocolMirror;

  before(() => {
    mirror = loadProtocolMirror();
  });

  it('exports window.baitonProtocol with reduce and initialWebviewState as functions', () => {
    assert.ok(mirror);
    assert.strictEqual(typeof mirror.reduce, 'function');
    assert.strictEqual(typeof mirror.initialWebviewState, 'function');
  });

  it('mirrors the initial seed state exactly', () => {
    assert.deepStrictEqual(hardClone(mirror.initialWebviewState()), initialWebviewState());
  });

  describe('reduce parity over fixture cases', () => {
    for (const c of PROTOCOL_CASES) {
      it(c.name, () => {
        const start = c.state ?? initialWebviewState();
        const tsStart: WebviewState = JSON.parse(JSON.stringify(start));
        const jsStart: WebviewState = JSON.parse(JSON.stringify(start));

        let tsResult: WebviewState = tsStart;
        let jsResult: WebviewState = jsStart;
        for (const msg of c.messages) {
          tsResult = reduce(tsResult, msg);
          jsResult = mirror.reduce(jsResult, msg);
        }

        assert.deepStrictEqual(
          hardClone(jsResult),
          tsResult,
          `Mirror state does not match TypeScript state for "${c.name}"`,
        );

        if (c.sameReference === true) {
          assert.strictEqual(tsResult, tsStart, `TS reduce did not return the same state for "${c.name}"`);
          assert.strictEqual(jsResult, jsStart, `Mirror reduce did not return the same state for "${c.name}"`);
        }
      });
    }
  });

  it('neither reducer mutates the state it is given (purity check)', () => {
    const multi = PROTOCOL_CASES.find((c) => c.messages.length > 1);
    assert.ok(multi, 'Multi-message fixture case must exist');

    const tsInput: WebviewState = JSON.parse(JSON.stringify(multi.state ?? initialWebviewState()));
    const untouched: WebviewState = JSON.parse(JSON.stringify(tsInput));
    for (const msg of multi.messages) {
      reduce(tsInput, msg);
    }
    assert.deepStrictEqual(tsInput, untouched, 'TS reduce mutated its input state');

    const jsInput: WebviewState = JSON.parse(JSON.stringify(untouched));
    for (const msg of multi.messages) {
      mirror.reduce(jsInput, msg);
    }
    assert.deepStrictEqual(
      hardClone(jsInput),
      untouched,
      'Mirror reduce mutated its input state',
    );
  });
});
