import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  configFilePath,
  localConfigFilePath,
  loadConfig,
  mergeConfigLayers,
  migrateAndPersist,
} from '../src/config/loadConfig';
import { defaultConfig, defaultConfigJson } from '../src/config/defaultConfig';
import { isErr, isOk } from '../src/model/result';

describe('config local overlay', () => {
  const dirs: string[] = [];

  function newDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-config-overlay-'));
    dirs.push(dir);
    return dir;
  }

  function writeBaseline(dir: string, text: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(configFilePath(dir), text, 'utf8');
  }

  function writeLocal(dir: string, text: string): void {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(localConfigFilePath(dir), text, 'utf8');
  }

  afterEach(() => {
    while (dirs.length > 0) {
      fs.rmSync(dirs.pop()!, { recursive: true, force: true });
    }
  });

  it('resolves the local filename and accepts a Uri-like directory', () => {
    const dir = '/example/.baiton';
    assert.strictEqual(localConfigFilePath(dir), path.join(dir, 'config.local.json'));
    assert.strictEqual(
      localConfigFilePath({ fsPath: dir }),
      path.join(dir, 'config.local.json'),
    );
    assert.strictEqual(configFilePath({ fsPath: dir }), path.join(dir, 'config.json'));
  });

  it('lets local scalar values win while retaining other baseline values', async () => {
    const dir = newDir();
    const baseline = JSON.parse(defaultConfigJson()) as Record<string, unknown>;
    const limits = baseline.limits as Record<string, unknown>;
    const git = baseline.git as Record<string, unknown>;
    baseline.limits = { ...limits, exec_attempts: 3 };
    baseline.git = { ...git, remote: 'origin' };
    const baselineText = `${JSON.stringify(baseline, null, 2)}\n`;
    const localText = '{"version":1,"limits":{"exec_attempts":7}}';
    writeBaseline(dir, baselineText);
    writeLocal(dir, localText);

    const result = await loadConfig(dir);

    assert.ok(isOk(result));
    if (isOk(result)) {
      assert.strictEqual(result.value.limits.exec_attempts, 7);
      assert.strictEqual(result.value.limits.plan_review_rounds, defaultConfig().limits.plan_review_rounds);
      assert.strictEqual(result.value.limits.stall_notice_minutes, defaultConfig().limits.stall_notice_minutes);
      assert.strictEqual(result.value.git.remote, 'origin');
    }
    assert.strictEqual(fs.readFileSync(configFilePath(dir), 'utf8'), baselineText);
    assert.strictEqual(fs.readFileSync(localConfigFilePath(dir), 'utf8'), localText);
  });

  it('merges role objects recursively so unspecified baseline keys survive', async () => {
    const dir = newDir();
    const baseline = JSON.parse(defaultConfigJson()) as Record<string, unknown>;
    const roles = baseline.roles as Record<string, unknown>;
    const planner = roles.planner as Record<string, unknown>;
    planner.model = 'baseline-model';
    const baselineText = `${JSON.stringify(baseline, null, 2)}\n`;
    writeBaseline(dir, baselineText);
    writeLocal(dir, '{"roles":{"planner":{"model":"local-model"}}}');

    const result = await loadConfig(dir);

    assert.ok(isOk(result));
    if (isOk(result)) {
      assert.strictEqual(result.value.roles.planner.model, 'local-model');
      assert.strictEqual(result.value.roles.planner.agent, defaultConfig().roles.planner.agent);
      assert.deepStrictEqual(result.value.roles.executor, defaultConfig().roles.executor);
    }
  });

  it('replaces arrays and preserves keys without mutating either merge input', () => {
    const baseline = { a: [1, 2, 3], keep: 'b', nested: { x: 1 }, toArray: { x: 1 }, toObject: [1] };
    const local = { a: [9], extra: true, nested: { y: 2 }, toArray: [2], toObject: { y: 2 } };
    const baselineBefore = structuredClone(baseline);
    const localBefore = structuredClone(local);

    const merged = mergeConfigLayers(baseline, local);

    assert.deepStrictEqual(merged, {
      a: [9],
      keep: 'b',
      extra: true,
      nested: { x: 1, y: 2 },
      toArray: [2],
      toObject: { y: 2 },
    });
    assert.deepStrictEqual(baseline, baselineBefore);
    assert.deepStrictEqual(local, localBefore);

    const protoKeyLocal = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    const safe = mergeConfigLayers({}, protoKeyLocal);
    assert.strictEqual(Object.prototype.hasOwnProperty.call(safe, '__proto__'), false);
    assert.strictEqual(({} as { polluted?: boolean }).polluted, undefined);
  });

  it('loads a baseline-only config without creating a local file', async () => {
    const dir = newDir();
    writeBaseline(dir, defaultConfigJson());

    const result = await loadConfig(dir);

    assert.ok(isOk(result));
    assert.strictEqual(fs.existsSync(localConfigFilePath(dir)), false);
  });

  it('loads a local-only config without creating a baseline file', async () => {
    const dir = newDir();
    writeLocal(dir, defaultConfigJson());
    const localBefore = fs.readFileSync(localConfigFilePath(dir), 'utf8');

    const result = await loadConfig(dir);

    assert.ok(isOk(result));
    assert.strictEqual(fs.existsSync(configFilePath(dir)), false);
    assert.strictEqual(fs.readFileSync(localConfigFilePath(dir), 'utf8'), localBefore);
  });

  it('reports absent only when neither layer exists, naming the local path', async () => {
    const dir = newDir();

    const result = await loadConfig(dir);

    assert.ok(isErr(result));
    if (isErr(result)) {
      assert.strictEqual(result.error.kind, 'absent');
      if (result.error.kind === 'absent') {
        assert.strictEqual(result.error.path, localConfigFilePath(dir));
        assert.ok(result.error.message.includes('Initialize'));
        assert.ok(result.error.message.includes('config.json'));
        assert.ok(result.error.message.includes('config.local.json'));
      }
    }
  });

  it('names a corrupt local file and leaves valid baseline bytes unchanged', async () => {
    const dir = newDir();
    const baselineText = defaultConfigJson();
    writeBaseline(dir, baselineText);
    writeLocal(dir, '{ invalid');

    const result = await loadConfig(dir);

    assert.ok(isErr(result));
    if (isErr(result)) {
      assert.strictEqual(result.error.kind, 'unparseable');
      assert.strictEqual(result.error.path, localConfigFilePath(dir));
      assert.ok(result.error.message.includes('config.local.json'));
    }
    assert.strictEqual(fs.readFileSync(configFilePath(dir), 'utf8'), baselineText);
  });

  it('reports a corrupt baseline before consulting the valid local file', async () => {
    const dir = newDir();
    writeBaseline(dir, '{ invalid');
    writeLocal(dir, defaultConfigJson());

    const result = await loadConfig(dir);

    assert.ok(isErr(result));
    if (isErr(result)) {
      assert.strictEqual(result.error.kind, 'unparseable');
      assert.strictEqual(result.error.path, configFilePath(dir));
      assert.ok(result.error.message.includes('config.json'));
    }
  });

  it('rejects local arrays and null with a root missing-section error', async () => {
    for (const text of ['[]', 'null']) {
      const dir = newDir();
      writeLocal(dir, text);

      const result = await loadConfig(dir);

      assert.ok(isErr(result));
      if (isErr(result)) {
        assert.strictEqual(result.error.kind, 'missing-section');
        if (result.error.kind === 'missing-section') {
          assert.strictEqual(result.error.section, 'root');
          assert.ok(result.error.message.includes('config.local.json'));
        }
      }
    }
  });

  it('validates the merged document and rejects invalid local overrides', async () => {
    const limitsDir = newDir();
    writeBaseline(limitsDir, defaultConfigJson());
    writeLocal(limitsDir, '{"limits":{"exec_attempts":99}}');

    const limitsResult = await loadConfig(limitsDir);

    assert.ok(isErr(limitsResult));
    if (isErr(limitsResult)) {
      assert.strictEqual(limitsResult.error.kind, 'missing-section');
      if (limitsResult.error.kind === 'missing-section') {
        assert.strictEqual(limitsResult.error.section, 'limits.exec_attempts');
      }
    }

    const versionDir = newDir();
    writeBaseline(versionDir, defaultConfigJson());
    writeLocal(versionDir, '{"version":2}');

    const versionResult = await loadConfig(versionDir);

    assert.ok(isErr(versionResult));
    if (isErr(versionResult)) {
      assert.strictEqual(versionResult.error.kind, 'version-too-new');
    }
  });

  it('does not modify either file after a successful two-layer load', async () => {
    const dir = newDir();
    const baselineText = defaultConfigJson();
    const localText = '{"git":{"remote":"local-remote"}}';
    writeBaseline(dir, baselineText);
    writeLocal(dir, localText);

    const baselineBefore = fs.readFileSync(configFilePath(dir), 'utf8');
    const localBefore = fs.readFileSync(localConfigFilePath(dir), 'utf8');
    const result = await loadConfig(dir);

    assert.ok(isOk(result));
    assert.strictEqual(fs.readFileSync(configFilePath(dir), 'utf8'), baselineBefore);
    assert.strictEqual(fs.readFileSync(localConfigFilePath(dir), 'utf8'), localBefore);
  });

  it('migrates into a newly created local target and leaves baseline absent', async () => {
    const root = newDir();
    const sub = path.join(root, '.baiton');
    assert.strictEqual(fs.existsSync(sub), false);
    const doc = { ...defaultConfig(), version: 0, extra: 'x' };
    const expected = { ...doc, version: 1 };

    const result = await migrateAndPersist(localConfigFilePath(sub), doc, 0, {
      0: (current) => ({ ...current, version: 1 }),
    });

    assert.ok(isOk(result));
    assert.strictEqual(fs.existsSync(sub), true);
    assert.strictEqual(fs.readFileSync(localConfigFilePath(sub), 'utf8'), `${JSON.stringify(expected, null, 2)}\n`);
    assert.strictEqual(fs.existsSync(configFilePath(sub)), false);
  });

  it('migrates into the local target without changing baseline bytes', async () => {
    const root = newDir();
    const sub = path.join(root, '.baiton');
    fs.mkdirSync(sub, { recursive: true });
    const baselineText = '{"team":"baseline"}\n';
    fs.writeFileSync(configFilePath(sub), baselineText, 'utf8');
    const doc = { ...defaultConfig(), version: 0, extra: 'x' };
    const expected = { ...doc, version: 1 };

    const result = await migrateAndPersist(localConfigFilePath(sub), doc, 0, {
      0: (current) => ({ ...current, version: 1 }),
    });

    assert.ok(isOk(result));
    assert.strictEqual(fs.readFileSync(localConfigFilePath(sub), 'utf8'), `${JSON.stringify(expected, null, 2)}\n`);
    assert.strictEqual(fs.readFileSync(configFilePath(sub), 'utf8'), baselineText);
  });

  it('does not write a local file when a migration step throws or is missing', async () => {
    const throwingRoot = newDir();
    const throwingTarget = localConfigFilePath(path.join(throwingRoot, '.baiton'));
    const doc = { ...defaultConfig(), version: 0 };
    const throwing = await migrateAndPersist(throwingTarget, doc, 0, {
      0: () => {
        throw new Error('migration boom');
      },
    });
    assert.ok(isErr(throwing));
    if (isErr(throwing)) assert.strictEqual(throwing.error.kind, 'migration-failed');
    assert.strictEqual(fs.existsSync(throwingTarget), false);

    const missingRoot = newDir();
    const missingTarget = localConfigFilePath(path.join(missingRoot, '.baiton'));
    const missing = await migrateAndPersist(missingTarget, doc, 0, {});
    assert.ok(isErr(missing));
    if (isErr(missing)) assert.strictEqual(missing.error.kind, 'migration-failed');
    assert.strictEqual(fs.existsSync(missingTarget), false);
  });
});
