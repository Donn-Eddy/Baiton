# Execute T05

## Summary

Probed agy 1.3.2: `agy -p /usage --output-format json` is a local command (num_turns 0) returning per-group weekly and 5-hour buckets with remaining_fraction and reset_time. Implemented the cli-command-only reader in src/usage/antigravity.ts, exported it from the barrel, added fixtures, tests, a README bullet and an adapter doc note. The provider-endpoint fallback is not coded: no readable credential file exists, so the endpoints could not be exercised. compile, lint and the full mocha suite pass (2712 passing).

## Files changed

- `src/usage/antigravity.ts`
- `src/usage/index.ts`
- `src/adapter/antigravity.ts`
- `test/usage.antigravity.test.ts`
- `test/fixtures/usage/antigravity/cli-usage.json`
- `test/fixtures/usage/antigravity/cli-usage.txt`
- `README.md`

## Commands run

- `agy --version`
- `agy --help`
- `agy help`
- `agy models --help`
- `agy remote-control --help`
- `agy models`
- `agy changelog (grep)`
- `agy -p /usage`
- `agy -p /usage --output-format json`
- `agy -p /quota`
- `ls ~/.gemini and ~/.config/Antigravity`
- `npm run compile`
- `npm run lint`
- `npx mocha`

## Notes

- Quota is per model group (Gemini; Claude and GPT), so windows are per bucket, not per model; no scope.model is set.
- The planned readStateFile/readCredentials/postJson seams, the tier parser and the credential extractor were not built: the probe found no state file, no readable credential file and no tier in the output.
- No fixtures for the fallback endpoints exist because they were never reached. The plan's restricted-mode and credential-redaction tests are reduced accordingly: restricted mode still reads the local CLI, and redaction is tested on a CLI error.
- Lint reports one pre-existing warning in src/orchestrator/webviewProtocol.ts, unrelated to this change.
