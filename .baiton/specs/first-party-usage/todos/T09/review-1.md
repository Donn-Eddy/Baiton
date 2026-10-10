# Review T09

Verdict: **pass**

## Findings

- (none)

## Tests

- ran: true
- passed: true

```
  usage.html shell
    ✔ has a strict CSP
    ✔ has exactly one nonce'd script, usage.js, and a nonce'd style
    ✔ has no inline handlers, style attributes, links or external URLs
    ✔ uses no hard-coded colors

  usage.js source
    ✔ uses no unsafe sinks or network access

  usage.js mirror
    ✔ mirrors model.ts constants
    ✔ formatAge
    ✔ formatReset
    ✔ formatRaw
    ✔ ok reading with a percent shows a remaining bar
    ✔ raw-only window has no bar and no invented percent
    ✔ stale keeps windows and shows the failure
    ✔ unavailable shows only the reason
    ✔ baiton-derived is labelled
    ✔ row without a reading is loading
    ✔ tolerates malformed input

  16 passing (20ms)

  2793 passing (1m)
  1 pending
```
