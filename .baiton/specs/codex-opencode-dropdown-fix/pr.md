# pr result

```json
{
  "title": "Refresh agent model selectors from live catalogs",
  "body": "## What changed\n\n- Refresh Codex models through the app-server, including hidden models, pagination, and per-model reasoning efforts.\n- Prefer Claude's local CLI model catalog, OpenCode's `models --verbose` output, and Antigravity's `agy models` output, retaining safe fallback behavior when discovery fails.\n- Wire the live catalog into the config panel and carry labels, per-model efforts, defaults, and custom markers through to the webview.\n- Render model-aware effort dropdowns, default-effort labels, and editable `Other…` values while preserving the last known-good selector data when refreshes fail.\n- Expand discovery, persistence, controller, and webview coverage; update the README's discovery and selector documentation.\n\n## Why\n\nThe configuration UI was using stale curated model lists and discarded discovered per-model metadata. This left current Codex and Claude options unavailable, rendered OpenCode as free text, and prevented selectors from accurately reflecting each agent's supported reasoning levels.\n\n## Verification\n\n- `npm run compile`\n- `npm run lint` (0 errors; one pre-existing unused-variable warning)\n- `npm test` (2203 passing, 1 pending, 0 failing)\n- Targeted model-discovery and config-webview test runs\n- Manual Codex app-server probe against codex-cli 0.157.0"
}
```
