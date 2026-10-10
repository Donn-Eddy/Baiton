import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  listDocumentSlugs,
  locationFor,
  phaseArtifactDir,
  resolveDocument,
} from '../src/storage/documentLocation';

describe('document location resolver', () => {
  let root: string;
  let baitonDir: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'baiton-doc-location-'));
    baitonDir = path.join(root, '.baiton');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  const write = (file: string): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, 'document\n');
  };

  it('resolves plans-only and legacy-only documents with their layouts', () => {
    write(path.join(baitonDir, 'plans', 'new', 'plan.md'));
    write(path.join(baitonDir, 'specs', 'old', 'spec.md'));
    const plan = resolveDocument(baitonDir, 'new');
    const legacy = resolveDocument(baitonDir, 'old');
    assert.strictEqual(plan.kind, 'plan');
    assert.strictEqual(plan.pathspec, '.baiton/plans/new');
    assert.strictEqual(plan.artifactsDir, path.join(baitonDir, 'plans', 'new', 'phases'));
    assert.strictEqual(phaseArtifactDir(plan, 'P01'), path.join(baitonDir, 'plans', 'new', 'phases', 'P01'));
    assert.strictEqual(legacy.kind, 'legacy-spec');
    assert.strictEqual(legacy.pathspec, '.baiton/specs/old');
    assert.strictEqual(legacy.artifactsDir, path.join(baitonDir, 'specs', 'old', 'todos'));
    assert.strictEqual(phaseArtifactDir(legacy, 'T01'), path.join(baitonDir, 'specs', 'old', 'todos', 'T01'));
  });

  it('prefers plans when the same slug has both documents', () => {
    write(path.join(baitonDir, 'plans', 'same', 'plan.md'));
    write(path.join(baitonDir, 'specs', 'same', 'spec.md'));
    assert.strictEqual(resolveDocument(baitonDir, 'same').kind, 'plan');
  });

  it('uses directory-only fallbacks, including a legacy draft before spec.md', () => {
    fs.mkdirSync(path.join(baitonDir, 'plans', 'draft'), { recursive: true });
    fs.mkdirSync(path.join(baitonDir, 'specs', 'legacy-draft'), { recursive: true });
    assert.strictEqual(resolveDocument(baitonDir, 'draft').kind, 'plan');
    assert.strictEqual(resolveDocument(baitonDir, 'legacy-draft').kind, 'legacy-spec');
  });

  it('defaults a missing slug to plans and locationFor is pure path arithmetic', () => {
    const location = resolveDocument(baitonDir, 'fresh');
    assert.strictEqual(location.kind, 'plan');
    assert.strictEqual(location.documentPath, path.join(baitonDir, 'plans', 'fresh', 'plan.md'));
    assert.deepStrictEqual(locationFor(baitonDir, 'fresh', 'legacy-spec'), {
      slug: 'fresh',
      kind: 'legacy-spec',
      dir: path.join(baitonDir, 'specs', 'fresh'),
      documentPath: path.join(baitonDir, 'specs', 'fresh', 'spec.md'),
      artifactsDir: path.join(baitonDir, 'specs', 'fresh', 'todos'),
      pathspec: '.baiton/specs/fresh',
    });
  });

  it('lists the sorted union of slugs and tolerates missing roots', () => {
    fs.mkdirSync(path.join(baitonDir, 'plans', 'z-plan'), { recursive: true });
    fs.mkdirSync(path.join(baitonDir, 'plans', 'same'), { recursive: true });
    fs.mkdirSync(path.join(baitonDir, 'specs', 'a-legacy'), { recursive: true });
    fs.mkdirSync(path.join(baitonDir, 'specs', 'same'), { recursive: true });
    assert.deepStrictEqual(listDocumentSlugs(baitonDir), ['a-legacy', 'same', 'z-plan']);
    assert.deepStrictEqual(listDocumentSlugs(path.join(root, 'missing')), []);
  });
});
