---
version: 1
name: first-party-usage
status: approved
mode: manual
base: main
base_commit: 5c95b9629bbbaced778fd067e40381b0237cfb1d
branch: baiton/first-party-usage
approved_rev: 24be8225f515841e329f8f0828ebcceedce756387ef0807a20d9deb61b25dcf8
---

# OVERVIEW

Add a collapsible **Usage** WebviewView (`baiton.usageView`) to the `baiton` activity-bar container, contributed directly before `baiton.configPanel` with `"visibility": "collapsed"`. It shows remaining usage for the four first-party agents in a fixed order: Claude Code, Codex, Antigravity, OpenCode Go. Spec Explorer, Runs and Configuration are not changed.

**Architecture.** This follows the repo's existing core/glue split.
- A new host-free module `src/usage/` holds everything that decides or parses, and imports nothing from `vscode`:
  - the reading model: windows, percent or the source's raw numbers, reset time, model/plan scope, account tier, the source mechanism with its provenance (provider-reported vs Baiton-derived) and read time, and the status `ok | stale | unavailable` with a non-empty reason;
  - one reader per tool, each with injected seams for every external surface (CLI spawn, `codex app-server` JSON-RPC, `opencode serve` HTTP, file reads, provider HTTP, stored-credential read, clock);
  - a `UsageService` that coalesces per-tool reads, timeboxes them, keeps the last good reading as stale with its age and the failure reason, and never throws;
  - a host-free webview protocol.
- A thin `vscode` layer (`src/activation/usageView*.ts`) only registers the provider, wires the seams to real `child_process`/`fs`/`fetch`, reads settings and trust, and passes messages along. It follows `configPanel.ts`/`configPanelController.ts`.
- The static shell `media/usage.html` + `media/usage.js` uses a per-load nonce, a strict CSP, `localResourceRoots` limited to `media/`, theme variables only, and no inline handlers or external resources.

**Sources.** Each tool uses whatever real mechanism it actually offers. Establishing which mechanism is real is part of each tool's todo.
- CLI-invoked routes come first: a CLI subcommand, the CLI's own server (Codex `app-server`, already spawned by `src/adapter/codex.ts`; `opencode serve`, already started by `src/adapter/opencode.ts`), or files the CLI writes itself.
- A credential the CLI already stored (e.g. under `~/.claude`, Codex `auth.json`, the opencode/antigravity auth stores) may be used only as a fallback against the provider's account endpoint.
- Such a token lives in memory for one read. It is never logged, written, cached, put in a reading, or sent to the webview.
- In Restricted Mode no credential is read at all, and the row explains why.
- A tool with no workable route reports `unavailable` with a reason. It never shows an invented, extrapolated or placeholder figure.
- Any Baiton-derived figure is labelled as such in both the row and the source line.
- A bar is drawn only when the source gives a percentage.

**Freshness.** Nothing is probed or spawned before the view is first expanded. The view reads all tools when it becomes visible and again on an interval (setting `baiton.usage.refreshIntervalSeconds`, sane default) while it is alive. A `baiton.usage.refresh` command, also in the view title, forces a re-read. Overlapping triggers share one in-flight read per tool. A read that overruns its budget settles as stale or unavailable instead of hanging. The timer is disposed with the view, so there is no background polling.

**Done when:** `npm run compile`, `npm run lint` and `npm test` pass, with unit tests for each tool's parser and for the unavailable, stale, coalescing, timeout, never-before-expand, restricted-mode and credential-redaction paths. README records the view and, per tool, the probe findings in the style of the existing per-adapter probe-findings section: the mechanism established as real, what it returned, and the mechanisms probed and found unusable. Nothing writes outside `.baiton/specs/**` at runtime.

# TODOS

- [done] T01 Define the host-free usage reading model in src/usage/model.ts. Tool ids in the fixed display order (claude, codex, antigravity, opencode-go). A reading type that carries:
- one or more windows, each with a label, an optional percent remaining, optional raw used/limit numbers with units, an optional reset time, and the model/plan scope it applies to;
- an optional account tier;
- a source { mechanism, provenance: 'provider' | 'baiton-derived', readAt };
- a status of ok | stale (with age and failure reason) | unavailable (with a non-empty reason).
Add constructors that enforce the invariants: a reason is never empty, a bar is allowed only when a percent was given, and a Baiton-derived source must be labelled. Add pure formatters for the row text (e.g. '5h window · 62% left · resets 14:30') and the source/age line. Unit-test it in test/usage.model.test.ts. (files: src/usage/model.ts, test/usage.model.test.ts)
- [done] T02 Implement the host-free UsageService in src/usage/usageService.ts. It takes an injected reader per tool, an injected clock and timer, and a per-read timeout. Behaviour:
- refreshAll()/refresh(tool) coalesce, so a second trigger while a read is in flight joins that promise instead of starting a new probe;
- each read is timeboxed;
- a reader that throws, rejects or overruns settles as unavailable with a reason, or as stale if there is a last good reading, which is kept with its age and the failure reason rather than blanked;
- it never throws;
- it emits a change event with the four readings in fixed order;
- it does nothing until the first refresh call.
Unit-test the coalescing, timeout, stale-retention, throw-to-unavailable and no-read-before-first-refresh paths in test/usage.service.test.ts. (after T01; files: src/usage/usageService.ts, src/usage/model.ts, test/usage.service.test.ts)
- [done] T03 Establish and implement the Codex usage reader in src/usage/codex.ts. Probe the installed codex CLI for a real route, in this order:
1. the `codex app-server` stdio JSON-RPC that src/adapter/codex.ts already drives (e.g. an account/rate-limits method returning primary/secondary windows with used percent, window length, reset and plan type);
2. rate-limit snapshots codex writes into its own session rollout files;
3. only as a fallback, the provider usage endpoint called with the token from codex's auth.json, held in memory only.
Reuse the existing app-server spawner seam and the executable override. Parse every window and plan the source reports, and record the source mechanism and provenance. Return unavailable with a reason when the CLI is absent, signed out, or the method or endpoint is missing. Write the probe findings (CLI version, the exact calls tried, what each returned, which were unusable) into the module header. Test the parsers and fallback order with faked seams in test/usage.codex.test.ts. (after T01; files: src/usage/codex.ts, src/adapter/codex.ts, test/usage.codex.test.ts)
- [done] T04 Establish and implement the Claude Code usage reader in src/usage/claude.ts. First probe the installed claude CLI for a CLI route: a usage/status subcommand or non-interactive output, or usage and rate-limit data in the session files it writes under its config directory. Only if no CLI route yields a number, fall back to the provider account-usage endpoint called with the OAuth token claude already stored under its config directory (or the platform keychain), held in memory for that read only and never logged or returned. Parse every reported window and per-model bucket (for example a 5h window and weekly all-model/per-model windows) with its reset, percent and plan tier. Return unavailable with a reason when the CLI is absent, signed out, the token is unreadable, or the response shape is unknown. Write the probe findings into the module header. Test the parsers and route precedence with faked seams in test/usage.claude.test.ts. (after T01; files: src/usage/claude.ts, src/adapter/claude.ts, test/usage.claude.test.ts)
- [executing] T05 Establish and implement the Antigravity usage reader in src/usage/antigravity.ts. Probe the installed agy CLI for a real route:
- a CLI subcommand or flag;
- a locally served surface;
- quota or state files it writes under its config directory;
- only as a fallback, the provider's quota or available-models endpoint called with the credential agy already stored, held in memory only.
Parse per-model quota buckets (remaining fraction or percent, plus reset) when they exist. If no workable route exists, the reader must return unavailable with a precise reason and must never return a placeholder or extrapolated figure. Write the probe findings, including the mechanisms found unusable, into the module header. Test with faked seams in test/usage.antigravity.test.ts. (after T01; files: src/usage/antigravity.ts, src/adapter/antigravity.ts, test/usage.antigravity.test.ts)
- [pending] T06 Establish and implement the OpenCode Go usage reader in src/usage/opencode.ts. Probe:
- the installed opencode CLI for a usage/stats subcommand;
- the `opencode serve` HTTP surface that src/adapter/opencode.ts already starts, for any usage, limit or account route;
- files opencode writes itself;
- only as a fallback, the OpenCode Go provider's usage endpoint (see the opencode-go entry and the shared baiton.orchestrator.key.opencode slot in src/orchestrator/providers.ts, and opencode's own stored auth), with the credential held in memory only.
If the only figure available is a local token tally (e.g. opencode's own stats), label it as such and never present it as quota. If no provider-reported quota is reachable, return unavailable with a reason. Write the probe findings into the module header. Test with faked seams in test/usage.opencode.test.ts. (after T01; files: src/usage/opencode.ts, src/adapter/opencode.ts, src/orchestrator/providers.ts, test/usage.opencode.test.ts)
- [pending] T07 Compose the four readers in src/usage/index.ts: build the per-tool reader table in fixed order from injected seams (executable resolution, spawners, fs, http, credential readers, a trusted flag). When the workspace is untrusted, the credential-fallback seams are never invoked and the row's reason says Restricted Mode blocked credential reads. Add a cross-cutting test, test/usage.credentials.test.ts, that feeds a sentinel token through every reader's credential fallback and asserts it never appears in any reading, error reason, log callback argument or serialized protocol message. It also asserts that no credential seam is called when untrusted. (after T02, T03, T04, T05, T06; files: src/usage/index.ts, test/usage.credentials.test.ts)
- [pending] T08 Add the host-free usage webview protocol (src/usage/protocol.ts: host→webview readings/state, webview→host ready/refresh) and the controller src/activation/usageViewController.ts, in the style of configPanelController.ts.
- On the first visible/expanded event it calls UsageService.refreshAll.
- Each re-expand refreshes again.
- It starts an interval timer (period read from an injected setting getter) only after the first expand, and disposes the timer with the view.
- A manual refresh is routed through the same coalesced service.
- It posts readings to the webview.
Unit-test the never-before-expand, re-expand-refresh, interval-tick, overlap and disposal paths with a fake webview and fake timers in test/usageView.controller.test.ts. (after T02, T07; files: src/usage/protocol.ts, src/activation/usageViewController.ts, src/activation/configPanelController.ts, test/usageView.controller.test.ts)
- [pending] T09 Create the static webview shell media/usage.html and media/usage.js, following config.html/config.js. Use a nonce placeholder, a strict CSP, VS Code theme variables only, no inline handlers and no external resources. Render one card per tool in fixed order with:
- each window line, plus model/plan scope and tier;
- the source's raw numbers;
- a progress bar only when a percent is present;
- the source line with its read time;
- a stale badge with age and reason;
- a non-empty reason for unavailable rows;
- a visible 'Baiton-derived, not provider quota' label where provenance says so.
Add a test (test/usageView.view.test.ts) in the style of configPanel.view.test.ts covering the CSP/nonce shell and the rendering rules. (after T08; files: media/usage.html, media/usage.js, media/config.html, media/config.js, test/usageView.view.test.ts)
- [pending] T10 Wire the glue and contributions.
- src/activation/usageView.ts: a WebviewViewProvider for `baiton.usageView` with a per-load nonce, localResourceRoots limited to media/, and visibility-change forwarding to the controller, holding no logic of its own.
- Register it from src/extension.ts alongside registerConfigPanel. Bind the real seams (child_process, fs, fetch, executable resolution from the baiton.agents.*.path overrides, vscode.workspace.isTrusted), log only mechanism and reason via Surface, and run no probe at activation.
- package.json:
  - add the view in the `baiton` container immediately before `baiton.configPanel` with "visibility": "collapsed";
  - add the `baiton.usage.refresh` command, with a view/title menu entry;
  - add the `baiton.usage.refreshIntervalSeconds` setting with a sane default and minimum.
Confirm the Spec Explorer, Runs and Configuration entries are unchanged, and that `npm run compile`, `npm run lint` and `npm test` pass. (after T08, T09; files: src/activation/usageView.ts, src/activation/configPanel.ts, src/activation/surface.ts, src/activation/executable.ts, src/activation/index.ts, src/extension.ts, package.json)
- [pending] T11 Document the Usage view in README.md:
- what each row shows;
- the refresh setting and command;
- the credential policy (CLI routes first, stored-credential fallback only, never logged or persisted, none read in Restricted Mode).
Add a 'Usage view (per-tool probe findings)' section in the style of the existing per-adapter probe-findings section. For each of Claude Code, Codex, Antigravity and OpenCode Go, record the CLI version probed, the mechanism established as real, what it actually returned, and the mechanisms probed and found unusable, taken from each reader module's header. (after T03, T04, T05, T06, T10; files: README.md, src/usage/claude.ts, src/usage/codex.ts, src/usage/antigravity.ts, src/usage/opencode.ts)
