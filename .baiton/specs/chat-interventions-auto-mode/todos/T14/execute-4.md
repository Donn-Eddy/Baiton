# Execute T14

## Summary

T14 completed: probed opencode CLI v1.18.30 for a native ask-relay surface and emitted no wiring because nothing verified is inline-installable. Probes: no permission-hook/--permission*/--config flag exists in `opencode --help`/`run --help` (only forbidden `--auto`); inline OPENCODE_CONFIG_CONTENT accepts top-level `permission: {bash: ask}` (the run proceeds) and agent-level `bash: {"*":"ask"}` (verified auto-reject: `! permission requested: bash (echo probe-agent-ask); auto-rejecting`); a `plugin` array is accepted and a plugin registered as a `file://` entry loads and its `tool.execute.before` hook fires with the tool name and args, and throwing from it denies the call — but a plugin can only be installed from a file on disk (file path, file URL, npm spec, or `.opencode/plugin[s]/` auto-discovery; a `data:` URL carrying inline source was silently ignored), which conflicts with `launch()`'s purity, so no relay ships. src/adapter/opencode.ts documents the finding (doc point 3, `LaunchRequest.relay` deliberately ignored); test/adapter.opencode.test.ts gained the ask-relay describe block with the decisive byte-identical negative assertion; README.md gained the opencode findings block and the table row `config-driven fallback | probed 2026-09-20, version 1.18.30 — no inline-installable native relay`, plus unverified markers for the `permission.asked` client route and the static extension-plugin idea. Verified: npm run compile, opencode suite (66 passing), lint, full suite (1110 passing / 1 pending, no regression from T12's 1088), launch property suite and claude suite all pass. Working tree clean — the completed changes are in the tree via the extension's commit (677a570), touching only the three planned files.

## Files changed

- `src/adapter/opencode.ts`
- `test/adapter.opencode.test.ts`
- `README.md`

## Commands run

- `command -v opencode && opencode --version`
- `opencode --help; opencode run --help (captured help text)`
- `opencode models; OPENCODE_CONFIG_CONTENT probes with top-level permission ask, agent-level bash ask, plugin file:// and data: URL entries, plus plugin auto-discovery from .opencode/plugin[s]/ under /tmp/opencode/probe`
- `npm run compile`
- `npx mocha --no-config test/adapter.opencode.test.ts --require ts-node/register`
- `npm run lint`
- `npm test`
- `npx mocha --no-config test/adapter.launch.property.test.ts --require ts-node/register`
- `npx mocha --no-config test/adapter.claude.test.ts --require ts-node/register`
- `git status --short && git diff --stat`

## Notes

- Probe scratch work was done under /tmp/opencode/probe only; no probe files were left anywhere in the repo.
- The end-to-end relay-shape evidence (plugin tool.execute.before hook firing with {tool, sessionID, callID} in / {args: {command}} out, and a throwing hook blocking the call) came from the probe recorded in the README; my independent re-probe reproduced the loading/instantiation split (CJS module.exports never instantiates, ESM default-export does) and the data:-URL silent ignore, which corroborates the recorded findings.
- A permission.ask plugin hook never fired while a bash ask auto-rejected; the README marks the permission.asked client-reply leg unverified rather than claiming it.
- Full suite grew from T12's 1088 passing to 1110 passing following the tests added for T14; 1 pending unchanged; git status is clean so no scratch or unrelated files are present.
