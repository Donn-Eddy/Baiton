# Execute T04

## Summary

Probed claude 2.1.295: `claude -p /usage --output-format json` is a local command (num_turns 0, cost 0, no writes) that prints real percents and resets, so it is the primary route (cli-command). The stored-login OAuth endpoint (api.anthropic.com/api/oauth/usage, utilization 0..100, HTTP 200 live, 401 on bad token) is the trusted-only fallback. Implemented src/usage/claude.ts with parsers (oauth, credential, /usage text incl. zoned reset conversion), reader with route precedence, redaction and Restricted Mode; exported claudeConfigDir/claudeCredentialsPath from the adapter; added fixtures, tests and README findings. compile, lint (only the known _legacy warning) and full npm test (2692 passing) pass.

## Files changed

- `src/usage/claude.ts`
- `src/usage/index.ts`
- `src/adapter/claude.ts`
- `test/usage.claude.test.ts`
- `test/fixtures/usage/claude/oauth-usage.json`
- `test/fixtures/usage/claude/credentials.json`
- `test/fixtures/usage/claude/cli-usage.json`
- `README.md`

## Commands run

- `claude --version; claude --help; claude doctor`
- `claude -p '/usage' --output-format json (and plain text)`
- `jq key-only inspection of ~/.claude/.credentials.json and ~/.claude.json`
- `curl oauth/usage with stored token (token held in shell var only) and with a bad token`
- `npx mocha test/usage.claude.test.ts`
- `npm run compile`
- `npm run lint`
- `npm test`

## Notes

- No session-file route exists (logs hold only token counts), so readLatestSessionLog/claudeProjectsDir were intentionally omitted; ~/.claude.json cachedUsageUtilization was noted but deliberately not read (internal cache).
- /usage reset text has no year and uses an IANA zone name; converted with Intl, rolling past dates to next year; an unparseable reset leaves the percent without a reset. The CLI route reports no plan tier.
- The live endpoint also returns experimental obfuscated buckets (e.g. iguana_necktie); per the plan they appear as generic windows when they carry a numeric utilization.
- Unverified: API-key credential field names, signed-out /usage wording (matched by wording only), per-model /usage lines, macOS keychain (not wired), other CLI versions.
- The probe ran /usage twice-plus and one live oauth/usage request; nothing was written under ~/.claude and the token was never printed.
