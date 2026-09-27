# Execute T16

## Summary

Implemented T16: added src/activation/runsExplorer.ts (the RunsExplorer TreeDataProvider over buildRunTree, a .baiton/runs/*/run.json FileSystemWatcher with a 500 ms debounce, an immediate repaint on every RunPipeline change event, plus the three fully injected command handlers runRunsCancel/runRunsViewDiff/runRunsMerge); wired the view, the RunsCommandDeps seams and the three baiton.runs.* command registrations into src/activation/commands.ts after the Spec Explorer block; contributed baiton.runsView (second, between specExplorer and configPanel), the three Baiton commands, their when:false commandPalette entries and the three view/item/context entries matching the model's \bcancel\b / \bviewDiff\b / \bmerge\b tokens with !baiton.restricted on cancel and merge only; updated the two contributed-views assertions in test/activation.gating.test.ts; added EventEmitter/TreeItem/TreeItemCollapsibleState/ThemeIcon and window.registerTreeDataProvider to the vscode fake (and its .d.mts); and added test/runsExplorer.test.ts covering contribution parity, watcher/pipeline lifecycle, tree mapping and icons, a throwing list(), and all three handlers.

## Files changed

- `src/activation/runsExplorer.ts`
- `src/activation/commands.ts`
- `package.json`
- `test/activation.gating.test.ts`
- `test/fixtures/vscodeFake.mjs`
- `test/fixtures/vscodeFake.d.mts`
- `test/runsExplorer.test.ts`

## Commands run

- `npx tsc -p . --noEmit`
- `npm run compile`
- `npx mocha`
- `npm run lint`
- `git status --porcelain`

## Notes

- Verification is clean: tsc and npm run compile emit nothing; npx mocha reports 2012 passing, 1 pending, 0 failing; npm run lint reports 0 errors and only the pre-existing '_legacy' unused-variable warning in src/orchestrator/webviewProtocol.ts.
- git status --porcelain lists exactly the seven files above (M package.json, M src/activation/commands.ts, M test/activation.gating.test.ts, M test/fixtures/vscodeFake.mjs, M test/fixtures/vscodeFake.d.mts, ?? src/activation/runsExplorer.ts, ?? test/runsExplorer.test.ts) with no .baiton/runs/ or .baiton/worktrees/ residue.
- Deviation from the plan (lint-forced): the plan's step-2 import list included a type-only `RunPipeline` used solely in a {@link} tag, which eslint flags as unused. The import was dropped and the two doc references now name `RunPipeline` in prose instead; RunsPipelineFacts is still the structural subset RunPipeline satisfies, which commands.ts proves at compile time by passing the real pipeline in.
- Deviation (tsc noUnusedParameters): commands.ts's showDiff seam takes `(_title, diff)` — the untitled `diff` document takes its name from the editor, so the title is carried by the seam but unused by this host implementation.
- The watcher-pattern assertion in the new test compares RelativePattern's base/pattern fields individually rather than deep-equalling an object literal, because the fake's RelativePattern is a class instance.
- No rule about which action is legal for which run state was duplicated: every label, description, tooltip and contextValue comes from buildRunTree/RunNode, and the merge handler's state re-check is defence in depth only.
