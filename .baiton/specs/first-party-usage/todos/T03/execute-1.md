# Execute T03

## Summary

Probed codex-cli 0.157.0 and implemented the host-free Codex usage reader (src/usage/codex.ts). Order: app-server account/rateLimits/read (verified live), newest rollout token_count, then trusted-only wham/usage fallback (verified HTTP 200). Added barrel export, 17 unit tests with fixtures, and a README probe-findings section.

## Files changed

- `src/usage/codex.ts`
- `src/usage/index.ts`
- `test/usage.codex.test.ts`
- `test/fixtures/usage/codex/app-server-result.json`
- `test/fixtures/usage/codex/rollout.jsonl`
- `test/fixtures/usage/codex/wham.json`
- `README.md`

## Commands run

- `codex --version`
- `codex --help`
- `codex app-server (JSONL initialize/initialized/account/rateLimits/read)`
- `rollout file inspection`
- `wham/usage GET (status and field names only)`
- `npm run compile`
- `npm run lint`
- `npm test`

## Notes

- The todo text was truncated after 'in this order:'; used the spec order CLI subcommand, app-server, files, stored-credential fallback.
- No usage subcommand exists in codex --help; recorded as unusable.
- Fixtures are synthetic or redacted; no real token or account id is in the diff.
- The later wiring todo should spawn codex app-server from a neutral cwd, not the workspace.
- Pre-existing lint warning in src/orchestrator/webviewProtocol.ts is unrelated.
- API-key login behaviour is marked unverified in the README.
