# Review T11

Verdict: **pass**

## Findings

- (none)

## Tests

- ran: true
- passed: true

```
  conversation mode and run activity
    ✔ a fresh state starts in the default mode with no run in flight
    ✔ setMode sets every mode
    ✔ setMode replaces a previous mode
    ✔ setMode leaves the rest of the state alone
    ✔ setRunActive sets the flag both ways
    ✔ setRunActive does not change the mode and setMode does not change runActive
    ✔ setMode and setRunActive do not mutate the input state
    ✔ a webview setMode carries the chosen mode

  1951 passing (46s)
  1 pending
```
