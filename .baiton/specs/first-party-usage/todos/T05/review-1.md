# Review T05

Verdict: **pass**

## Findings

- (none)

## Tests

- ran: true
- passed: true

```
  antigravity usage parsers
    ✔ maps each bucket of the /usage JSON to a window with (1 - fraction) * 100
    ✔ parses the plain tab-separated text with the rounded percent
    ✔ falls back to the JSON response text when the structured groups are missing
    ✔ gives no window to a bucket without a fraction (never invents 0 or 100)
    ✔ de-duplicates by id
    ✔ is total on garbage

  antigravity usage reader
    ✔ reads the CLI route: ok, cli-command, provider-reported, fixed argv
    ✔ clamps a fraction outside 0..1 after okReading
    ✔ caps the CLI budget at 15s
    ✔ ENOENT reports that agy was not found on PATH
    ✔ empty stdout with exit 0 is unavailable with a specific reason
    ✔ unavailable with no seams wired
    ✔ keeps the same binary name as the adapter and a stable argv
    ✔ an already-aborted signal is unavailable and calls no seam
    ✔ restricted mode still reads the local CLI command (no credentials are involved)
    ✔ redacts a token embedded in a CLI error, in the reason and in logs
    ✔ construction is inert: no seam runs until the reader is invoked

  antigravity usage through UsageService
    ✔ refresh yields ok, a failing second read keeps it stale with the reason
    ✔ coalesces two concurrent refreshes into one CLI call
    ✔ a never-resolving CLI settles as unavailable "timed out" under a fake timer

  20 passing (14ms)

  2712 passing (1m)
  1 pending
```
