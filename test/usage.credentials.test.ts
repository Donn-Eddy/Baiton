import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import {
  ANTIGRAVITY_USAGE_CLI_ARGS,
  CLAUDE_OAUTH_USAGE_URL,
  CLAUDE_USAGE_CLI_ARGS,
  CODEX_USAGE_APP_SERVER_SUBCOMMAND,
  CODEX_WHAM_USAGE_URL,
  OPENCODE_GO_USAGE_URL,
  USAGE_TOOL_IDS,
  UsageService,
  createUsageReaders,
  redactSecrets,
  type UsageFetchResponse,
  type UsageReadContext,
  type UsageReaderTableSeams,
  type UsageReading,
} from '../src/usage/index';

const SENTINEL = 'tok-SENTINEL-q7Zx';
const NOW = Date.parse('2026-10-09T12:00:00Z');

const CLAUDE_CRED = JSON.stringify({
  claudeAiOauth: { accessToken: SENTINEL, expiresAt: NOW + 3_600_000, subscriptionType: 'max' },
});
const CODEX_CRED = JSON.stringify({ tokens: { access_token: SENTINEL, account_id: 'acct-fixture' } });
const OPENCODE_CRED = JSON.stringify({ 'opencode-go': { type: 'api', key: SENTINEL } });

function fixture(...parts: string[]): string {
  return fs.readFileSync(path.join(__dirname, 'fixtures', 'usage', ...parts), 'utf8');
}
const BODIES: Record<string, unknown> = {
  [CLAUDE_OAUTH_USAGE_URL]: JSON.parse(fixture('claude', 'oauth-usage.json')),
  [CODEX_WHAM_USAGE_URL]: JSON.parse(fixture('codex', 'wham.json')),
  [OPENCODE_GO_USAGE_URL]: JSON.parse(fixture('opencode', 'endpoint-usage.json')),
};

type FetchMode = 'ok' | 'http401' | 'rejectBearer' | 'rejectJson' | 'oddShape' | 'throwSync';
const FETCH_MODES: FetchMode[] = ['ok', 'http401', 'rejectBearer', 'rejectJson', 'oddShape', 'throwSync'];
const CRED_TOOLS = ['claude', 'codex', 'opencode-go'] as const;

function ctx(over: Partial<UsageReadContext> = {}): UsageReadContext {
  return { signal: new AbortController().signal, trusted: true, now: () => NOW, timeoutMs: 5000, ...over };
}

interface Calls {
  resolve: string[];
  run: Array<{ exe: string; args: readonly string[] }>;
  spawn: Array<{ exe: string; args: readonly string[] }>;
  rollout: number;
  cred: { claude: number; codex: number; opencodeGo: number };
  fetch: Array<{ url: string; headers: Record<string, string> }>;
  logs: string[];
}

function harness(
  fetchMode: FetchMode | (() => FetchMode),
  over: Partial<UsageReaderTableSeams> = {},
): { seams: UsageReaderTableSeams; calls: Calls } {
  const calls: Calls = {
    resolve: [],
    run: [],
    spawn: [],
    rollout: 0,
    cred: { claude: 0, codex: 0, opencodeGo: 0 },
    fetch: [],
    logs: [],
  };
  const mode = (): FetchMode => (typeof fetchMode === 'function' ? fetchMode() : fetchMode);
  const seams: UsageReaderTableSeams = {
    resolveExecutable: (cli) => {
      calls.resolve.push(cli);
      return undefined;
    },
    runCommand: async () => {
      throw new Error('cli auth failed Bearer ' + SENTINEL);
    },
    spawnProcess: () => {
      throw new Error('spawn failed');
    },
    readCodexLatestRollout: async () => {
      calls.rollout++;
      return undefined;
    },
    credentials: {
      claude: async () => {
        calls.cred.claude++;
        return CLAUDE_CRED;
      },
      codex: async () => {
        calls.cred.codex++;
        return CODEX_CRED;
      },
      opencodeGo: async () => {
        calls.cred.opencodeGo++;
        return OPENCODE_CRED;
      },
    },
    fetchJson: async (url, init): Promise<UsageFetchResponse> => {
      calls.fetch.push({ url, headers: init.headers });
      switch (mode()) {
        case 'ok':
          return { status: 200, body: { ...(BODIES[url] as object), echo: SENTINEL, access_token: SENTINEL } };
        case 'http401':
          return { status: 401, body: { error: 'invalid token ' + SENTINEL } };
        case 'rejectBearer':
          throw new Error('request failed: Authorization: ' + init.headers.Authorization);
        case 'rejectJson':
          throw new Error(JSON.stringify({ access_token: SENTINEL }));
        case 'oddShape':
          return { status: 200, body: { data: SENTINEL, token: SENTINEL } };
        case 'throwSync':
          throw new Error('Bearer ' + SENTINEL);
      }
    },
    isTrusted: () => true,
    log: (m) => {
      calls.logs.push(m);
    },
    ...over,
  };
  // wrap runCommand/spawnProcess to record calls even when overridden
  const run = seams.runCommand;
  const spawn = seams.spawnProcess;
  const wrapped: UsageReaderTableSeams = {
    ...seams,
    runCommand: run
      ? (exe, args, signal, t) => {
          calls.run.push({ exe, args });
          return run(exe, args, signal, t);
        }
      : undefined,
    spawnProcess: spawn
      ? (exe, args) => {
          calls.spawn.push({ exe, args });
          return spawn(exe, args);
        }
      : undefined,
  };
  return { seams: wrapped, calls };
}

function assertNoSentinel(label: string, value: unknown): void {
  const text = typeof value === 'string' ? value : JSON.stringify(value ?? null);
  assert.ok(!text.includes(SENTINEL), label);
}

async function readAll(seams: UsageReaderTableSeams, c = ctx()): Promise<UsageReading[]> {
  const readers = createUsageReaders(seams);
  const out: UsageReading[] = [];
  for (const tool of USAGE_TOOL_IDS) out.push(await readers[tool](c));
  return out;
}

function byTool(readings: readonly UsageReading[], tool: string): UsageReading {
  const r = readings.find((x) => x.tool === tool);
  assert.ok(r, `no reading for ${tool}`);
  return r;
}

function mechanismOf(r: UsageReading): string | undefined {
  return r.status === 'unavailable' ? r.mechanism : r.source.mechanism;
}

function reasonOf(r: UsageReading): string {
  return (r as { reason?: string }).reason ?? '';
}

function assertAllZero(calls: Calls): void {
  assert.deepStrictEqual(calls.cred, { claude: 0, codex: 0, opencodeGo: 0 });
  assert.strictEqual(calls.fetch.length, 0);
}

function assertRestricted(readings: readonly UsageReading[]): void {
  for (const tool of CRED_TOOLS) {
    const r = byTool(readings, tool);
    assert.strictEqual(r.status, 'unavailable', `${tool} status`);
    assert.ok(reasonOf(r).includes('Restricted Mode'), `${tool} reason: ${reasonOf(r)}`);
  }
}

describe('usage credential redaction', () => {
  it('sentinel is not masked by redactSecrets', () => {
    assert.strictEqual(redactSecrets(SENTINEL), SENTINEL);
  });

  for (const mode of FETCH_MODES) {
    it(`never leaks the token (${mode})`, async () => {
      const h = harness(mode);
      const readings = await readAll(h.seams);

      assert.deepStrictEqual(h.calls.cred, { claude: 1, codex: 1, opencodeGo: 1 });
      assert.strictEqual(h.calls.fetch.length, 3);
      for (const f of h.calls.fetch) {
        assert.strictEqual(f.headers.Authorization, 'Bearer ' + SENTINEL);
        assert.ok(!f.url.includes(SENTINEL));
      }
      for (const r of readings) {
        assertNoSentinel(`reading ${r.tool}`, r);
        if (r.status === 'unavailable' || r.status === 'stale') {
          assert.ok(reasonOf(r).length > 0, `${r.tool} reason empty`);
          assertNoSentinel(`reason ${r.tool}`, reasonOf(r));
        }
      }
      for (const l of h.calls.logs) assertNoSentinel('log', l);

      for (const tool of CRED_TOOLS) {
        const r = byTool(readings, tool);
        if (mode === 'ok') {
          assert.strictEqual(r.status, 'ok', `${tool} ok`);
        } else {
          assert.strictEqual(r.status, 'unavailable', `${tool} unavailable`);
        }
        assert.strictEqual(mechanismOf(r), 'provider-endpoint');
      }
      if (mode === 'ok') assert.ok(!JSON.stringify(readings).includes('"echo"'));
    });

    it(`never leaks the token through the service (${mode})`, async () => {
      const h = harness(mode);
      const snaps: string[] = [];
      const svcLogs: string[] = [];
      const svc = new UsageService({
        readers: createUsageReaders(h.seams),
        isTrusted: () => true,
        now: () => NOW,
        timeoutMs: 5000,
        log: (m) => svcLogs.push(m),
      });
      try {
        svc.onDidChange((r) => snaps.push(JSON.stringify({ type: 'usage/readings', readings: r })));
        await svc.refresh();
        assert.ok(snaps.length > 0);
        assert.strictEqual(h.calls.fetch.length, 3);
        assertNoSentinel('snapshot', JSON.stringify({ type: 'usage/readings', readings: svc.snapshot() }));
        for (const s of snaps) assertNoSentinel('snap', s);
        for (const l of svcLogs) assertNoSentinel('service log', l);
        for (const l of h.calls.logs) assertNoSentinel('reader log', l);
      } finally {
        svc.dispose();
      }
    });
  }

  it('stale rows keep the token out of reason and message', async () => {
    let mode: FetchMode = 'ok';
    const h = harness(() => mode);
    const svc = new UsageService({
      readers: createUsageReaders(h.seams),
      isTrusted: () => true,
      now: () => NOW,
      timeoutMs: 5000,
    });
    try {
      await svc.refresh();
      for (const tool of CRED_TOOLS) assert.strictEqual(byTool(svc.snapshot(), tool).status, 'ok');
      mode = 'rejectBearer';
      await svc.refresh();
      const snapshot = svc.snapshot();
      for (const tool of CRED_TOOLS) {
        const r = byTool(snapshot, tool);
        assert.strictEqual(r.status, 'stale', `${tool} stale`);
        assert.ok(reasonOf(r).length > 0);
        assertNoSentinel('stale reason', reasonOf(r));
      }
      assertNoSentinel('stale message', JSON.stringify({ type: 'usage/readings', readings: snapshot }));
      assert.ok(h.calls.fetch.length >= 6);
    } finally {
      svc.dispose();
    }
  });

  it('antigravity has no credential route', async () => {
    const h = harness('ok', { resolveExecutable: () => '/opt/bin/agy' });
    const readers = createUsageReaders(h.seams);
    const r = await readers.antigravity(ctx());
    assert.strictEqual(r.status, 'unavailable');
    assert.ok(reasonOf(r).length > 0);
    assertNoSentinel('antigravity', r);
    for (const l of h.calls.logs) assertNoSentinel('log', l);
    assertAllZero(h.calls);
  });
});

describe('usage Restricted Mode', () => {
  it('blocks credential reads when the table is untrusted', async () => {
    const h = harness('ok', { isTrusted: () => false });
    const readings = await readAll(h.seams);
    assertAllZero(h.calls);
    assertRestricted(readings);
  });

  it('blocks credential reads when only the service is untrusted', async () => {
    const h = harness('ok');
    const svc = new UsageService({
      readers: createUsageReaders({ ...h.seams, isTrusted: () => true }),
      isTrusted: () => false,
      now: () => NOW,
    });
    try {
      await svc.refresh();
      assertAllZero(h.calls);
      assertRestricted(svc.snapshot());
    } finally {
      svc.dispose();
    }
  });

  it('fails closed when isTrusted is omitted', async () => {
    const h = harness('ok');
    const rest: UsageReaderTableSeams = { ...h.seams, isTrusted: undefined };
    const readings = await readAll(rest);
    assertAllZero(h.calls);
    assertRestricted(readings);
  });

  it('treats a throwing isTrusted as untrusted', async () => {
    const h = harness('ok', {
      isTrusted: () => {
        throw new Error('trust unavailable');
      },
    });
    const readings = await readAll(h.seams);
    assertAllZero(h.calls);
    assertRestricted(readings);
  });

  it('still allows the CLI route when untrusted', async () => {
    const stdout = fixture('claude', 'cli-usage.json');
    const h = harness('ok', {
      isTrusted: () => false,
      resolveExecutable: (cli) => (cli === 'claude' ? '/opt/bin/claude' : undefined),
      runCommand: async () => ({ code: 0, stdout }),
    });
    const readers = createUsageReaders(h.seams);
    const r = await readers.claude(ctx());
    assert.strictEqual(r.status, 'ok');
    assert.strictEqual(mechanismOf(r), 'cli-command');
    assertAllZero(h.calls);
  });
});

describe('usage reader table', () => {
  it('has the fixed order and is frozen', () => {
    const table = createUsageReaders({});
    assert.deepStrictEqual(Object.keys(table), [...USAGE_TOOL_IDS]);
    assert.ok(Object.isFrozen(table));
  });

  it('construction is inert', () => {
    const h = harness('ok');
    const readers = createUsageReaders(h.seams);
    new UsageService({ readers });
    const c = h.calls;
    assert.deepStrictEqual(c.resolve, []);
    assert.deepStrictEqual(c.run, []);
    assert.deepStrictEqual(c.spawn, []);
    assert.strictEqual(c.rollout, 0);
    assertAllZero(c);
  });

  it('empty seams give unavailable readings with a reason', async () => {
    const readers = createUsageReaders({});
    for (const tool of USAGE_TOOL_IDS) {
      const r = await readers[tool](ctx());
      assert.strictEqual(r.tool, tool);
      assert.strictEqual(r.status, 'unavailable');
      assert.ok(reasonOf(r).length > 0, `${tool} reason`);
    }
  });

  it('resolves at read time and uses the resolved path', async () => {
    const h = harness('ok', { resolveExecutable: (cli) => '/opt/bin/' + cli });
    h.calls.resolve.length = 0;
    const readers = createUsageReaders(h.seams);
    await readers.claude(ctx({ trusted: false }));
    await readers.antigravity(ctx());
    await readers.codex(ctx({ trusted: false }));
    assert.deepStrictEqual(
      h.calls.run.map((c) => c.exe),
      ['/opt/bin/claude', '/opt/bin/agy'],
    );
    assert.deepStrictEqual(h.calls.run[0].args, CLAUDE_USAGE_CLI_ARGS);
    assert.deepStrictEqual(h.calls.run[1].args, ANTIGRAVITY_USAGE_CLI_ARGS);
    assert.deepStrictEqual(h.calls.spawn, [{ exe: '/opt/bin/codex', args: [CODEX_USAGE_APP_SERVER_SUBCOMMAND] }]);
  });

  it('reports an unresolved executable without spawning', async () => {
    const h = harness('ok', { isTrusted: () => false });
    const readings = await readAll(h.seams);
    assert.deepStrictEqual(h.calls.run, []);
    assert.deepStrictEqual(h.calls.spawn, []);
    for (const tool of ['claude', 'codex', 'antigravity']) {
      assert.ok(reasonOf(byTool(readings, tool)).includes('not found on PATH'), tool);
    }
  });

  it('stays host-free', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'usage', 'index.ts'), 'utf8');
    const imports = src.split('\n').filter((l) => /^\s*(import|export)\b.*\bfrom\b|require\(/.test(l));
    assert.ok(imports.length > 0);
    for (const line of imports) {
      assert.ok(/from '\.\/[a-zA-Z]+'/.test(line), `unexpected import: ${line}`);
      assert.ok(!/vscode|\bfs\b|child_process|\.\.\//.test(line), `host import: ${line}`);
    }
  });
});
