# Review T11

Verdict: **pass**

## Findings

- (none)

## Tests

- ran: true
- passed: true

```
ProviderRouter catalog
    ✔ snapshot models win over the stale builtin list
    ✔ a feed-only provider becomes selectable once its key exists
    ✔ legacy google/mistral/opencode/openai keys still enable those providers with a feed present
    ✔ offline: a snapshot-only provider is still enumerated, with the synthesised label
    ✔ a stale snapshot propagates stale/staleReason/fetchedAt onto snapshot-backed entries only
    ✔ a selected model absent from the refreshed list stays selectable, at the END, as customModels
    ✔ a legacy selection is preserved, not written over, and returns on the next refresh
    ✔ an orphaned ACTIVE selection returns once its provider is configured again
    ✔ a provider that has vanished from the catalog is never dropped
    ✔ the catalog is re-read per call, so a landed refresh changes availability and refresh()

  41 passing (23ms)
```
