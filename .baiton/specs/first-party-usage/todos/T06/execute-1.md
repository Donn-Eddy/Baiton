# Execute T06

## Summary

Probed opencode 1.18.30. CLI, `opencode serve` routes and local files expose no OpenCode Go usage; `opencode stats` is local spend and was rejected. Established route is the undocumented read-only GET https://opencode.ai/zen/go/v1/usage with the stored key (provider-endpoint, trusted only), returning provider percent plus resetsAt for rolling/weekly/monthly. Implemented src/usage/opencode.ts (reader, parser, credential extractor), barrel export, fixtures, tests and README findings. compile, lint (only a pre-existing warning) and the full mocha suite pass.

## Files changed

- `src/usage/opencode.ts`
- `src/usage/index.ts`
- `test/usage.opencode.test.ts`
- `test/fixtures/usage/opencode/endpoint-usage.json`
- `test/fixtures/usage/opencode/auth.json`
- `README.md`

## Commands run

- `opencode --version/--help and subcommand --help`
- `opencode providers list; opencode stats`
- `opencode serve + curl GETs of /doc and candidate routes`
- `curl GET opencode.ai/zen/go/v1/models and /zen/go/v1/usage (read-only, key in a shell variable)`
- `WebFetch opencode.ai/docs/go`
- `npm run compile`
- `npm run lint`
- `npx mocha`

## Notes

- The /zen/go/v1/usage path was found by guessing, not from docs; docs list no usage endpoint. It is a read-only GET with the user's own key.
- The server banner reported port 4096 despite --port 0 in this probe; no effect on the reader.
- sqlite3 is not installed, so opencode.db was not schema-inspected; `opencode db` rejected a dot-command. Local DB is session storage per `stats`.
- The `status` field of each limit is not read; exhausted-limit behaviour is unverified.
- No CLI/server seams were wired, as nothing usable was found there. Host wiring (readAuthFile/fetchJson) is a later todo.
