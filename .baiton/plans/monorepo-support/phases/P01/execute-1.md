# Execute P01

## Summary

Implemented repo discovery, primary repo selection, per-repo git services, and per-repo activation config and recovery wiring.

## Files changed

- `src/activation/repoDiscovery.ts`
- `src/activation/index.ts`
- `src/activation/workspace.ts`
- `src/git/gitService.ts`
- `src/extension.ts`
- `test/activation.gating.test.ts`

## Commands run

- `npm run compile — passed`
- `npm run lint — passed with one warning in src/orchestrator/webviewProtocol.ts:678`
- `npx mocha --no-config --require ts-node/register --extension ts test/activation.gating.test.ts — 66 passing`
- `npm test — sandbox attempt hit EPERM on subprocess tests; host-permission rerun passed (2,894 passing, 1 pending)`
- `git diff --check — passed`
- `Reference sweep for WorkspaceFolder<, hasBaitonDir, multiple-baiton-roots, readWorkspaceFolders, and exactly one .baiton root — no matches`

## Notes

- Activation retains the one-folder initialization behavior and selects the first available Baiton repo in multi-root workspaces.
- Child config, recovery, and gitignore failures are isolated per repo.
- The initial sandbox test run was denied git subprocesses; the full suite passed when rerun with host permissions.
