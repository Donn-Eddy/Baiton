# Execute T11

## Summary

Moved the misplaced Claude Code usage findings bullet out of the ask-relay section into the Usage view findings section (first, renamed 'claude (Claude Code) findings'), aligned it with the code (cli-command / provider-endpoint mechanisms, rateLimitTier fallback, API-key accounts unavailable, extra_usage window), and extended the section intro with the shared rules.

## Files changed

- `README.md`

## Commands run

- `grep -n 'findings\*\*' README.md`
- `python3 -I (scripted exact-string move/edit)`
- `npm run compile`
- `npm run lint`
- `npm test`

## Notes

- npm test: 2812 passing, 1 pending; compile and lint succeeded.
- Views bullet, Commands and Settings entries left untouched.
