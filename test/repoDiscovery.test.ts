import * as assert from 'assert';
import * as path from 'path';
import { repoTopologyFor, type RepoSet } from '../src/activation/repoDiscovery';

describe('repoTopologyFor', () => {
  it('maps discovered repo names, roots and parents with the selected owner', () => {
    const set: RepoSet = {
      repos: [
        { name: 'app', folderName: 'app', relPath: '', root: path.resolve('/ws/app'), hasGit: true, children: ['app/api'] },
        { name: 'app/api', folderName: 'app', relPath: 'api', root: path.resolve('/ws/app/api'), hasGit: true, parent: 'app', children: [] },
      ],
      folderRoots: [],
      truncated: false,
    };
    assert.deepStrictEqual(repoTopologyFor(set, 'app'), {
      owner: 'app',
      repos: [
        { name: 'app', root: path.resolve('/ws/app') },
        { name: 'app/api', root: path.resolve('/ws/app/api'), parent: 'app' },
      ],
    });
  });
});
