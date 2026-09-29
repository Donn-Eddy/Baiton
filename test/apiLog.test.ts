import * as assert from 'assert';
import * as fc from 'fast-check';
import {
  API_FAILURE_KINDS,
  BODY_EXCERPT_MAX,
  createApiLog,
  excerpt,
  noopApiLog,
  redactSecrets,
} from '../src/orchestrator/apiLog';
import * as barrel from '../src/orchestrator';

const TS = '2026-01-01T00:00:00.000Z';

function recorder() {
  const lines: string[] = [];
  const log = createApiLog((l) => lines.push(l), () => TS);
  return { lines, log };
}

describe('apiLog redactSecrets', () => {
  it('redacts Authorization values in header and JSON forms', () => {
    const a = redactSecrets('Authorization: Bearer abc.def-123');
    assert.ok(a.includes('Authorization: [REDACTED]'));
    assert.ok(!a.includes('abc.def-123'));
    assert.ok(!redactSecrets('authorization: Basic Zm9vOmJhcg==').includes('Zm9vOmJhcg'));
    assert.ok(!redactSecrets('{"Authorization":"Bearer tok123"}').includes('tok123'));
  });

  it('redacts bare Bearer tokens', () => {
    assert.strictEqual(redactSecrets('got Bearer eyJhbGciOi.x.y here'), 'got Bearer [REDACTED] here');
  });

  it('redacts api-key variants', () => {
    const samples = [
      'x-api-key: sekret1',
      'api_key=sekret2',
      'API-KEY: sekret3',
      'apikey=sekret4',
      'https://h/v1?api_key=sekret5&x=1',
    ];
    samples.forEach((s, i) => assert.ok(!redactSecrets(s).includes(`sekret${i + 1}`), s));
    assert.ok(redactSecrets(samples[4]).includes('&x=1'));
  });

  it('redacts opaque tokens but keeps short words', () => {
    for (const s of ['sk-' + 'A'.repeat(40), 'sk-proj-abcdefghijklmnopqrstu', 'key-0123456789abcdefXYZ']) {
      assert.strictEqual(redactSecrets(s), '[REDACTED]');
    }
    for (const s of ['key-value', 'sk-1', 'connection refused', 'authorization failed']) {
      assert.strictEqual(redactSecrets(s), s);
    }
  });

  it('is idempotent on samples', () => {
    for (const s of [
      'Authorization: Bearer abc',
      'Bearer xyz',
      'x-api-key: k1 and api_key=k2',
      'sk-' + 'B'.repeat(30),
    ]) {
      assert.strictEqual(redactSecrets(redactSecrets(s)), redactSecrets(s));
    }
  });

  it('never leaks a Bearer/authorization value (property)', () => {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~+/'.split('');
    const token = fc.stringOf(fc.constantFrom(...chars), { minLength: 8, maxLength: 64 });
    const pfx = fc.constantFrom('', 'request failed ', 'HTTP 401 ', '\n');
    const sfx = fc.constantFrom('', ' trailing text', '\n');
    fc.assert(
      fc.property(
        token,
        fc.constantFrom('Bearer', 'bearer', 'BEARER'),
        fc.constantFrom('Authorization', 'authorization', 'AUTHORIZATION'),
        fc.constantFrom(': ', ':', '=', '": "'),
        pfx,
        sfx,
        (tok, scheme, header, sep, pre, suf) => {
          fc.pre(!(pre + suf + '[REDACTED]' + 'Bearer' + 'bearer' + 'BEARER').toLowerCase().includes(tok.toLowerCase()));
          for (const input of [`${pre}${scheme} ${tok}${suf}`, `${pre}${header}${sep}${scheme} ${tok}${suf}`]) {
            const out = redactSecrets(input);
            assert.ok(!out.includes(tok), out);
            assert.ok(!/bearer\s+(?!\[REDACTED\])[^\s"',;]/i.test(out), out);
            assert.ok(!/authorization"?\s*[:=]\s*"?(?!\[REDACTED\])[^\s"]/i.test(out), out);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('apiLog excerpt', () => {
  it('collapses newlines', () => {
    assert.strictEqual(excerpt('a\nb\r\n  c'), 'a b c');
  });

  it('bounds long bodies', () => {
    const e = excerpt('x'.repeat(10_000));
    assert.strictEqual(e.length, BODY_EXCERPT_MAX);
    assert.ok(e.endsWith('…'));
  });

  it('leaves exactly-max bodies unchanged', () => {
    const s = 'y'.repeat(BODY_EXCERPT_MAX);
    assert.strictEqual(excerpt(s), s);
  });

  it('is always bounded and single-line (property)', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 2000 }), (s) => {
        const e = excerpt(s);
        assert.ok(e.length <= BODY_EXCERPT_MAX);
        assert.ok(!/[\r\n]/.test(e));
      }),
    );
  });
});

describe('apiLog createApiLog', () => {
  it('formats a full entry', () => {
    const { lines, log } = recorder();
    log.failure({
      surface: 'openai',
      operation: 'completion',
      kind: 'http-status',
      status: 401,
      target: 'https://api.example.com/v1/chat/completions',
      message: 'endpoint returned HTTP 401',
      bodyExcerpt: '{"error":"bad key"}',
    });
    assert.deepStrictEqual(lines, [
      '[2026-01-01T00:00:00.000Z] openai completion http-status HTTP 401 https://api.example.com/v1/chat/completions — endpoint returned HTTP 401 | body: {"error":"bad key"}',
    ]);
  });

  it('formats a minimal entry', () => {
    const { lines, log } = recorder();
    log.failure({ surface: 'copilot', operation: 'completion', kind: 'refused', message: 'no permission' });
    assert.deepStrictEqual(lines, ['[2026-01-01T00:00:00.000Z] copilot completion refused — no permission']);
  });

  it('writes one redacted line for multi-line input', () => {
    const { lines, log } = recorder();
    log.failure({
      surface: 's',
      operation: 'o',
      kind: 'connection',
      target: 'https://h/x?api_key=abc',
      message: 'failed\nBearer secretmsg',
      bodyExcerpt: 'line1\nsk-' + 'Z'.repeat(30) + '\nBearer secretbody',
    });
    assert.strictEqual(lines.length, 1);
    const line = lines[0];
    assert.ok(!line.includes('\n'));
    for (const leak of ['abc', 'secretmsg', 'secretbody', 'ZZZZZZZZ']) {
      assert.ok(!line.includes(leak), leak);
    }
  });

  it('bounds the body segment', () => {
    const { lines, log } = recorder();
    log.failure({ surface: 's', operation: 'o', kind: 'timeout', message: 'm', bodyExcerpt: 'q'.repeat(5000) });
    const seg = lines[0].split(' | body: ')[1];
    assert.ok(seg.length <= BODY_EXCERPT_MAX);
  });

  it('formats each kind', () => {
    for (const kind of API_FAILURE_KINDS) {
      const { lines, log } = recorder();
      log.failure({ surface: 's', operation: 'o', kind, message: 'm' });
      assert.ok(lines[0].includes(` ${kind} `), kind);
    }
  });

  it('calls the sink once per failure and default now is ISO', () => {
    const lines: string[] = [];
    const log = createApiLog((l) => lines.push(l));
    assert.strictEqual(lines.length, 0);
    log.failure({ surface: 's', operation: 'o', kind: 'abort', message: 'm' });
    assert.strictEqual(lines.length, 1);
    assert.match(lines[0], /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\]/);
  });

  it('survives a throwing sink', () => {
    const log = createApiLog(() => {
      throw new Error('boom');
    });
    assert.doesNotThrow(() => log.failure({ surface: 's', operation: 'o', kind: 'abort', message: 'm' }));
  });
});

describe('apiLog noopApiLog', () => {
  it('is a silent no-op', () => {
    let result: unknown = 1;
    assert.doesNotThrow(() => {
      result = noopApiLog.failure({ surface: 's', operation: 'o', kind: 'abort', message: 'm' });
    });
    assert.strictEqual(result, undefined);
  });

  it('is exported from the barrel', () => {
    assert.strictEqual(barrel.createApiLog, createApiLog);
    assert.strictEqual(barrel.noopApiLog, noopApiLog);
    assert.strictEqual(barrel.redactSecrets, redactSecrets);
  });
});
