import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  codexHomeDir,
  createNodeUsageSeams,
  nodeReadCodexLatestRollout,
  nodeRunCommand,
  opencodeDataDir,
  readTextIfExists,
} from '../src/activation/usageViewSeams';
import { UsageService, createUsageReaders } from '../src/usage';

/** Temp-dir tests of the real Node seams (spec first-party-usage, todo T10). */

const noAbort = () => new AbortController().signal;

function tree(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      out.push(p + ':' + (e.isDirectory() ? 'd' : fs.statSync(p).mtimeMs + ':' + fs.readFileSync(p, 'utf8')));
      if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  return out.sort();
}

describe('Usage view Node seams (first-party-usage T10)', () => {
  const dirs: string[] = [];
  const tmp = (): string => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-usage-'));
    dirs.push(d);
    return d;
  };
  after(() => {
    for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  });

  it('resolves the codex and opencode data dirs from env, else the home', () => {
    assert.strictEqual(codexHomeDir({ CODEX_HOME: '/x/c' }, '/h'), '/x/c');
    assert.strictEqual(codexHomeDir({}, '/h'), path.join('/h', '.codex'));
    assert.strictEqual(opencodeDataDir({ XDG_DATA_HOME: '/x/d' }, '/h'), path.join('/x/d', 'opencode'));
    assert.strictEqual(opencodeDataDir({}, '/h'), path.join('/h', '.local', 'share', 'opencode'));
  });

  it('reads the newest rollout of the latest date directory', async () => {
    const root = tmp();
    const mk = (rel: string, text: string, mtime?: number) => {
      const f = path.join(root, rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, text);
      if (mtime) fs.utimesSync(f, mtime, mtime);
    };
    mk('2025/12/31/rollout-old.jsonl', 'old');
    mk('2026/01/09/rollout-a.jsonl', 'older', 1000);
    mk('2026/01/09/rollout-b.jsonl', 'newest', 2000);
    mk('2026/01/09/notes.txt', 'ignore');
    mk('misc/12/31/rollout-z.jsonl', 'ignore');
    assert.strictEqual(await nodeReadCodexLatestRollout(noAbort(), root), 'newest');
    assert.strictEqual(await nodeReadCodexLatestRollout(noAbort(), path.join(root, 'nope')), undefined);
    const c = new AbortController();
    c.abort();
    assert.strictEqual(await nodeReadCodexLatestRollout(c.signal, root), undefined);
  });

  it('readTextIfExists returns undefined for a missing file and text otherwise', async () => {
    const d = tmp();
    assert.strictEqual(await readTextIfExists(path.join(d, 'missing')), undefined);
    fs.writeFileSync(path.join(d, 'f'), 'hello');
    assert.strictEqual(await readTextIfExists(path.join(d, 'f')), 'hello');
  });

  it('credential seams read auth.json under the injected env and never write', async () => {
    const home = tmp();
    const codex = tmp();
    const xdg = tmp();
    fs.mkdirSync(path.join(xdg, 'opencode'));
    fs.writeFileSync(path.join(codex, 'auth.json'), 'codex-auth');
    fs.writeFileSync(path.join(xdg, 'opencode', 'auth.json'), 'oc-auth');
    const seams = createNodeUsageSeams({
      resolveExecutable: () => undefined,
      isTrusted: () => true,
      log: () => {},
      env: { CODEX_HOME: codex, XDG_DATA_HOME: xdg },
      home,
    });
    const before = [tree(home), tree(codex), tree(xdg)];
    assert.strictEqual(await seams.credentials?.codex?.(), 'codex-auth');
    assert.strictEqual(await seams.credentials?.opencodeGo?.(), 'oc-auth');
    assert.deepStrictEqual([tree(home), tree(codex), tree(xdg)], before);
  });

  it('nodeRunCommand runs without a shell from the temp dir, and kills on abort', async () => {
    assert.deepStrictEqual(
      await nodeRunCommand(process.execPath, ['-e', 'process.stdout.write("hi")'], noAbort(), 10_000),
      { code: 0, stdout: 'hi' },
    );
    const cwd = await nodeRunCommand(process.execPath, ['-e', 'process.stdout.write(process.cwd())'], noAbort(), 10_000);
    assert.strictEqual(fs.realpathSync(cwd.stdout), fs.realpathSync(os.tmpdir()));

    const c = new AbortController();
    const p = nodeRunCommand(process.execPath, ['-e', 'setTimeout(()=>{},10000)'], c.signal, 20_000);
    setTimeout(() => c.abort(), 100);
    const r = await p;
    assert.notStrictEqual(r.code, 0);

    await assert.rejects(
      nodeRunCommand('/nonexistent/baiton-usage-cli', [], noAbort(), 1000),
      (e: NodeJS.ErrnoException) => e.code === 'ENOENT',
    );
  });

  it('never leaks a stored token into logs or readings', async () => {
    const home = tmp();
    const token = 'sk-ant-oat01-XXXXXXXXXXXXXXXX';
    const logs: string[] = [];
    const seams = {
      ...createNodeUsageSeams({
        resolveExecutable: () => undefined,
        isTrusted: () => true,
        log: (m) => logs.push(m),
        env: {},
        home,
      }),
      credentials: { claude: async () => JSON.stringify({ claudeAiOauth: { accessToken: token } }) },
      fetchJson: async (_url: string, init: { headers: Record<string, string> }) => {
        logs.push('headers seen: ' + Object.keys(init.headers).join(','));
        return { status: 401, body: undefined };
      },
    };
    const service = new UsageService({ readers: createUsageReaders(seams), isTrusted: () => true, log: (m) => logs.push(m) });
    await service.refresh(['claude']);
    assert.ok(!logs.join('\n').includes(token));
    assert.ok(!JSON.stringify(service.snapshot()).includes(token));
    service.dispose();
  });
});
