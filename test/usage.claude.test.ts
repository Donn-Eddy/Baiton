import * as assert from 'assert';
import * as fs from 'fs';
import * as path from 'path';

import {
  CLAUDE_OAUTH_BETA_HEADER,
  CLAUDE_OAUTH_USAGE_URL,
  CLAUDE_USAGE_CLI_ARGS,
  type ClaudeUsageSeams,
  createClaudeUsageReader,
  extractClaudeCredential,
  parseClaudeCliUsage,
  parseClaudeOauthUsage,
} from '../src/usage/claude';
import type { UsageReading } from '../src/usage/model';
import type { UsageReadContext } from '../src/usage/usageService';
import { UsageService } from '../src/usage/usageService';

const fixture = (name: string): string =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'usage', 'claude', name), 'utf8');
const OAUTH: unknown = JSON.parse(fixture('oauth-usage.json'));
const CREDENTIALS = fixture('credentials.json');
const CLI_JSON = fixture('cli-usage.json');

const TOKEN = 'sk-ant-oat01-SECRETSECRETSECRET';
const NOW = Date.parse('2026-10-08T12:00:00Z');
const creds = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ claudeAiOauth: { accessToken: TOKEN, expiresAt: NOW + 3_600_000, subscriptionType: 'max', ...over } });

function ctx(over: Partial<UsageReadContext> = {}): UsageReadContext {
  return { signal: new AbortController().signal, trusted: true, now: () => NOW, timeoutMs: 1000, ...over };
}

interface Calls {
  cli: number;
  creds: number;
  fetch: Array<{ url: string; headers: Record<string, string> }>;
  logs: string[];
}

function seams(over: Partial<ClaudeUsageSeams> = {}): { s: ClaudeUsageSeams; calls: Calls } {
  const calls: Calls = { cli: 0, creds: 0, fetch: [], logs: [] };
  const s: ClaudeUsageSeams = {
    readCredentials: async () => (calls.creds++, creds()),
    fetchJson: async (url, init) => (calls.fetch.push({ url, headers: init.headers }), { status: 200, body: OAUTH }),
    log: (m) => calls.logs.push(m),
    ...over,
  };
  return { s, calls };
}

const cliOk = (calls?: Calls) => async () => {
  if (calls) calls.cli++;
  return { code: 0, stdout: CLI_JSON };
};

function assertUnavailable(r: UsageReading): string {
  assert.strictEqual(r.status, 'unavailable');
  assert.strictEqual(r.tool, 'claude');
  assert.ok(r.status === 'unavailable' && r.reason.length > 0);
  return r.status === 'unavailable' ? r.reason : '';
}

describe('claude usage parsers', () => {
  it('maps the oauth buckets with ids, labels, scope, reset and verbatim percent', () => {
    const { windows } = parseClaudeOauthUsage(OAUTH);
    assert.deepStrictEqual(
      windows.map((w) => [w.id, w.label, w.usedPercent, w.resetsAt, w.scope?.model, w.provenance]),
      [
        ['five-hour', '5-hour', 13, Date.parse('2026-10-09T07:39:59.799934+00:00'), undefined, 'provider-reported'],
        ['weekly', 'Weekly (all models)', 2, Date.parse('2026-10-16T01:59:59.799954+00:00'), undefined, 'provider-reported'],
        ['weekly:opus', 'Weekly (Opus)', 41.5, Date.parse('2026-10-16T01:59:59.799954+00:00'), 'opus', 'provider-reported'],
        ['iguana_necktie', 'iguana necktie', 0, Date.parse('2026-11-05T07:59:00+00:00'), undefined, 'provider-reported'],
        ['extra-usage', 'Extra usage', 17.86, undefined, undefined, 'provider-reported'],
      ],
    );
    assert.deepStrictEqual(windows[4].raw, { used: 1250, limit: 7000, unit: 'credits' });
  });

  it('skips null buckets and non-numeric utilization without inventing zeros', () => {
    const r = parseClaudeOauthUsage({
      five_hour: null,
      seven_day: { utilization: 'x', resets_at: 'soon' },
      seven_day_sonnet: { resets_at: '2026-10-16T00:00:00Z' },
      other: { utilization: null },
    });
    assert.deepStrictEqual(r.windows, []);
  });

  it('gives an unknown bucket with utilization a generic window and keeps a missing reset absent', () => {
    const r = parseClaudeOauthUsage({ seven_day_cowork: { utilization: 9 } });
    assert.deepStrictEqual(r.windows, [
      { id: 'seven_day_cowork', label: 'seven day cowork', usedPercent: 9, provenance: 'provider-reported' },
    ]);
  });

  it('shows extra usage only when enabled and carrying numbers', () => {
    assert.deepStrictEqual(parseClaudeOauthUsage({ extra_usage: { is_enabled: false, utilization: 5 } }).windows, []);
    assert.deepStrictEqual(parseClaudeOauthUsage({ extra_usage: { is_enabled: true } }).windows, []);
    const r = parseClaudeOauthUsage({ extra_usage: { is_enabled: true, used_credits: 3, monthly_limit: 'x' } });
    assert.deepStrictEqual(r.windows[0].raw, { used: 3, unit: 'credits' });
    assert.strictEqual(r.windows[0].usedPercent, undefined);
  });

  it('is total on garbage', () => {
    for (const g of [undefined, null, [], 'x', 5, { five_hour: 'x' }, { extra_usage: 3 }]) {
      assert.deepStrictEqual(parseClaudeOauthUsage(g), { windows: [] });
    }
  });

  it('extracts the stored login, an api-key-only login, or nothing', () => {
    assert.deepStrictEqual(extractClaudeCredential(CREDENTIALS), {
      accessToken: 'sk-ant-oat01-FAKEFAKEFAKEFAKE',
      expiresAt: 4102444800000,
      tier: 'max',
    });
    assert.deepStrictEqual(extractClaudeCredential(JSON.stringify({ claudeAiOauth: { accessToken: 'a', rateLimitTier: 'default_claude_ai' } })), {
      accessToken: 'a',
      tier: 'default_claude_ai',
    });
    assert.deepStrictEqual(extractClaudeCredential('{"primaryApiKey":"sk-ant-api03-x"}'), { apiKeyOnly: true });
    for (const t of ['not json', '{}', '[]', '{"claudeAiOauth":{"accessToken":""}}', '']) {
      assert.strictEqual(extractClaudeCredential(t), undefined);
    }
  });

  it('parses /usage output: percent, zoned reset, per-model lines', () => {
    const r = parseClaudeCliUsage(CLI_JSON, NOW);
    assert.deepStrictEqual(
      r.windows.map((w) => [w.id, w.label, w.usedPercent, w.resetsAt, w.scope?.model]),
      [
        ['five-hour', '5-hour', 13, Date.parse('2026-10-09T07:39:00Z'), undefined],
        ['weekly', 'Weekly (all models)', 2, Date.parse('2026-10-16T02:00:00Z'), undefined],
        ['weekly:opus', 'Weekly (Opus)', 41, Date.parse('2026-10-16T01:59:00Z'), 'opus'],
      ],
    );
    assert.strictEqual(r.signedOut, undefined);
  });

  it('keeps the percent but no reset when the reset text is unreadable; accepts plain text', () => {
    const r = parseClaudeCliUsage('Current session: 7% used · resets someday (Mars/Base)\n', NOW);
    assert.deepStrictEqual(r.windows.map((w) => [w.usedPercent, w.resetsAt]), [[7, undefined]]);
    assert.strictEqual(parseClaudeCliUsage('Current week (all models): 4% used', NOW).windows[0].usedPercent, 4);
  });

  it('rolls a past date into next year and a bare time to the next occurrence', () => {
    const jan = parseClaudeCliUsage('Current session: 1% used · resets Jan 2, 1am (UTC)', Date.parse('2026-12-31T12:00:00Z'));
    assert.strictEqual(jan.windows[0].resetsAt, Date.parse('2027-01-02T01:00:00Z'));
    const bare = parseClaudeCliUsage('Current session: 1% used · resets 3pm (UTC)', Date.parse('2026-10-08T16:00:00Z'));
    assert.strictEqual(bare.windows[0].resetsAt, Date.parse('2026-10-09T15:00:00Z'));
  });

  it('flags signed-out output and is total on garbage', () => {
    assert.strictEqual(parseClaudeCliUsage('{"is_error":true,"result":"Not logged in · Please run /login"}').signedOut, true);
    assert.strictEqual(parseClaudeCliUsage('Please run /login').signedOut, true);
    for (const g of ['', 'hello', '{}', '[]', 'null']) {
      assert.deepStrictEqual(parseClaudeCliUsage(g).windows, []);
    }
    assert.deepStrictEqual(parseClaudeCliUsage(undefined as unknown as string), { windows: [] });
  });
});

describe('claude usage reader', () => {
  it('construction calls no seam', () => {
    const { s, calls } = seams({ runCli: async () => assert.fail('runCli') });
    createClaudeUsageReader(s);
    assert.deepStrictEqual([calls.creds, calls.fetch.length, calls.logs.length], [0, 0, 0]);
  });

  it('prefers the CLI route and never touches the credentials', async () => {
    const { s, calls } = seams();
    const r = await createClaudeUsageReader({ ...s, runCli: cliOk(calls) })(ctx());
    assert.strictEqual(r.status, 'ok');
    assert.ok(r.status === 'ok' && r.source.mechanism === 'cli-command' && r.windows.length === 3);
    assert.deepStrictEqual([calls.cli, calls.creds, calls.fetch.length], [1, 0, 0]);
  });

  it('passes the fixed args to the CLI', async () => {
    let seen: readonly string[] = [];
    const { s } = seams();
    await createClaudeUsageReader({
      ...s,
      runCli: async (args) => ((seen = args), { code: 0, stdout: CLI_JSON }),
    })(ctx());
    assert.deepStrictEqual(seen, CLAUDE_USAGE_CLI_ARGS);
  });

  it('falls back to the endpoint when the CLI yields no number', async () => {
    const { s, calls } = seams();
    const r = await createClaudeUsageReader({ ...s, runCli: async () => ({ code: 0, stdout: 'nothing here' }) })(ctx());
    assert.ok(r.status === 'ok' && r.source.mechanism === 'provider-endpoint');
    assert.strictEqual(calls.fetch.length, 1);
  });

  it('happy path via the endpoint', async () => {
    const { s, calls } = seams();
    const r = await createClaudeUsageReader(s)(ctx());
    assert.ok(r.status === 'ok');
    if (r.status !== 'ok') return;
    assert.strictEqual(r.source.mechanism, 'provider-endpoint');
    assert.strictEqual(r.source.provenance, 'provider-reported');
    assert.strictEqual(r.tier, 'max');
    assert.strictEqual(calls.fetch.length, 1);
    assert.strictEqual(calls.fetch[0].url, CLAUDE_OAUTH_USAGE_URL);
    assert.strictEqual(calls.fetch[0].headers.Authorization, `Bearer ${TOKEN}`);
    assert.strictEqual(calls.fetch[0].headers['anthropic-beta'], CLAUDE_OAUTH_BETA_HEADER);
    assert.ok(!JSON.stringify(r).includes(TOKEN));
  });

  it('with no CLI seam only the endpoint route is attempted and the reason names the CLI', async () => {
    const { s } = seams({ readCredentials: undefined });
    const reason = assertUnavailable(await createClaudeUsageReader(s)(ctx()));
    assert.ok(/claude CLI is not wired/.test(reason) && /endpoint is not wired/.test(reason), reason);
  });

  it('lists every mechanism in the reason when all fail', async () => {
    const { s } = seams({ fetchJson: async () => ({ status: 500, body: {} }) });
    const reason = assertUnavailable(
      await createClaudeUsageReader({ ...s, runCli: async () => ({ code: 1, stdout: '' }) })(ctx()),
    );
    assert.ok(reason.includes('exited with code 1') && reason.includes('HTTP 500'), reason);
  });

  it('reports each unavailable cause', async () => {
    const run = async (over: Partial<ClaudeUsageSeams>, c: UsageReadContext = ctx()): Promise<string> =>
      assertUnavailable(await createClaudeUsageReader({ ...seams().s, ...over })(c));
    const noEndpoint = { readCredentials: undefined, fetchJson: undefined };
    const enoent = Object.assign(new Error('spawn claude ENOENT'), { code: 'ENOENT' });
    assert.ok((await run({ ...noEndpoint, runCli: async () => { throw enoent; } })).includes('claude was not found on PATH'));
    assert.ok((await run({ ...noEndpoint, runCli: async () => ({ code: 0, stdout: '{"is_error":true,"result":"Not logged in"}' }) })).includes('signed out'));
    assert.ok((await run({ readCredentials: async () => undefined })).includes('signed out?'));
    assert.ok((await run({ readCredentials: async () => { throw new Error('EACCES'); } })).includes('EACCES'));
    assert.ok((await run({ readCredentials: async () => '{"primaryApiKey":"sk-ant-api03-abcdefgh"}' })).includes('API key'));
    assert.ok((await run({ fetchJson: async () => ({ status: 401, body: {} }) })).includes('HTTP 401 (sign in again'));
    assert.ok((await run({ fetchJson: async () => ({ status: 200, body: { foo: 1 } }) })).includes('unknown response shape'));
  });

  it('does not call the endpoint with an expired login', async () => {
    const { s, calls } = seams({ readCredentials: async () => creds({ expiresAt: NOW }) });
    const reason = assertUnavailable(await createClaudeUsageReader(s)(ctx()));
    assert.ok(reason.includes('expired'));
    assert.strictEqual(calls.fetch.length, 0);
  });

  it('Restricted Mode skips the stored login but still allows the CLI', async () => {
    const { s, calls } = seams();
    const reason = assertUnavailable(await createClaudeUsageReader(s)(ctx({ trusted: false })));
    assert.ok(reason.includes('Restricted Mode'));
    assert.deepStrictEqual([calls.creds, calls.fetch.length], [0, 0]);
    const ok = await createClaudeUsageReader({ ...s, runCli: cliOk() })(ctx({ trusted: false }));
    assert.strictEqual(ok.status, 'ok');
    assert.deepStrictEqual([calls.creds, calls.fetch.length], [0, 0]);
  });

  it('never leaks the token into a reading or a log line', async () => {
    const cases: Array<Partial<ClaudeUsageSeams>> = [
      { fetchJson: async () => { throw new Error(`boom Bearer ${TOKEN}`); } },
      { fetchJson: async () => ({ status: 401, body: { error: `bad ${TOKEN}` } }) },
      { fetchJson: async () => ({ status: 200, body: { echo: TOKEN } }) },
      {},
    ];
    for (const over of cases) {
      const { s, calls } = seams({ readCredentials: async () => creds(), ...over });
      const r = await createClaudeUsageReader(s)(ctx());
      assert.ok(!JSON.stringify(r).includes(TOKEN), JSON.stringify(r));
      assert.ok(calls.logs.every((l) => !l.includes(TOKEN)));
    }
    const { s, calls } = seams({ runCli: async () => { throw new Error(`x ${TOKEN}`); }, fetchJson: undefined });
    const r = await createClaudeUsageReader(s)(ctx());
    assert.ok(!JSON.stringify(r).includes(TOKEN) && calls.logs.every((l) => !l.includes(TOKEN)));
  });

  it('a pre-aborted signal reads nothing', async () => {
    const ac = new AbortController();
    ac.abort();
    const { s, calls } = seams({ runCli: async () => assert.fail('runCli') });
    assertUnavailable(await createClaudeUsageReader(s)(ctx({ signal: ac.signal })));
    assert.deepStrictEqual([calls.creds, calls.fetch.length], [0, 0]);
  });
});

describe('claude usage module shape', () => {
  it('is host-free and fits the UsageService contract', async () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'usage', 'claude.ts'), 'utf8');
    const imports = src.split('\n').filter((l) => /^\s*(import\b|\} from )/.test(l) && /from '/.test(l));
    assert.ok(imports.length > 0);
    for (const line of imports) assert.ok(/from '\.\/(model|usageService)';/.test(line), line);
    for (const banned of ['vscode', 'child_process', "'fs'", "'os'", "'path'"]) {
      assert.ok(!src.includes(banned), banned);
    }
    const { s } = seams();
    const service = new UsageService({
      readers: { claude: createClaudeUsageReader(s) },
      isTrusted: () => true,
      now: () => NOW,
    });
    try {
      await service.refresh();
      const reading = service.snapshot().find((r) => r.tool === 'claude');
      assert.strictEqual(reading?.status, 'ok');
    } finally {
      service.dispose();
    }
  });
});
