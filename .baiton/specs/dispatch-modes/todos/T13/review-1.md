# Review T13

Verdict: **pass**

## Findings

- (none)

## Tests

- ran: true
- passed: true

```
  runTreeModel
    buildRunTree
      ✔ returns exactly two groups, Active then Complete, both present when empty
      ✔ splits every run state exactly as isRunComplete predicts
      ✔ preserves input order inside each group
      ✔ does not throw for degenerate manifests
    descriptions and labels
      ✔ carries the manifest facts verbatim
      ✔ one-lines and truncates the label but leaves the statement whole
      ✔ describes an active run by its live stage
      ✔ falls back to the state when no stage is live
      ✔ reports a live investigate stage for a run still in state confirmed
      ✔ puts outcomeLabel on complete nodes only, and uses it in the description
      ✔ builds a tooltip from the run facts, omitting the lines that do not apply
    runOutcomeLabel
      ✔ names each ending
      ✔ one-lines and truncates a long failure message
    legalRunActions and contextValue
      ✔ offers cancel only for an active run with a stage in flight
      ✔ offers viewDiff and merge per the completion rules
      ✔ produces space-separated tokens the when clauses can match
      ✔ keeps every node contextValue equal to runContextValue over its own facts
    runStageFor
      ✔ returns the live stage only for the matching, still-active run

  18 passing (19ms)
  1977 passing (46s)
  1 pending
```
