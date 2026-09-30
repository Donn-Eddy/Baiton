# Execute T06

## Summary

Added the compaction transcript record (CompactionMarker, compactionTranscriptRecord), reader validation, toHistory support (covered records hidden, summary emitted once, later enclosing compaction supersedes) and compactionCut. Added the baiton.orchestrator.contextSummarizeAt setting (package.json, wired in commands.ts) and the controller summarise step: pure helpers (resolveContextSummarizeAt, summaryRequestMessages, constants), shouldSummarize and compact, triggered in onSend before runToolLoop with inline failure handling. Added reader, round-trip property and controller compaction tests.

## Files changed

- `src/orchestrator/chatTranscript.ts`
- `src/orchestrator/transcriptReader.ts`
- `src/activation/chatController.ts`
- `src/activation/commands.ts`
- `package.json`
- `test/transcriptReader.test.ts`
- `test/transcript.roundtrip.property.test.ts`
- `test/chatController.compaction.test.ts`

## Commands run

- `npm run compile`
- `npm run lint`
- `npm test`

## Notes

- npm test: 2417 passing, 1 pending, 0 failing. Lint: 0 errors, only the existing _legacy warning in webviewProtocol.ts.
- The plan's controller test case 1 asserted the summary request contains 'aaaa' and 'bbbb' with window 1000. The summary request budget is window/2 (500 tokens), so the oldest blocks are legitimately dropped. The test asserts 'dddd' and the '[earlier messages omitted]' marker instead.
- The real system prompt is about 1200 tokens, so at window 1000 the threshold is always exceeded. The below-threshold test therefore uses window 100000 rather than 1000 with small seed contents.
- The reload test allows a second compaction to run, as the plan permits. It asserts the final loop request carries exactly one summary and no u1 content.
- grep for from 'vscode' in src/orchestrator finds only the existing copilotClient.ts type import, nothing new.
- src/activation/commands.ts was edited (one line) to wire contextSummarizeAt, as the plan specified.
