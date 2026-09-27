# Review T15

Verdict: **pass**

## Findings

- (none)

## Tests

- ran: true
- passed: true

```
  model selector refresh (T15 end to end)
    model selector refresh: reload refresh
      ✔ a window reload refreshes every source and the config panel picks it up without a second loaded
      ✔ the persisted snapshots come back as cached on the next window, before any fetch
      ✔ refresh never blocks and never rejects (204ms)
    model selector refresh: discovery fallback
      ✔ every source failing keeps the curated builtin lists and marks them stale
      ✔ a failure after a success keeps the last good list
      ✔ a later success clears the stale mark
      ✔ one failing source never poisons the others
    model selector refresh: provider filtering
      ✔ availability lists only configured providers
      ✔ unconfigured providers are hidden, each with its reason
      ✔ legacy secret slots still enable their providers
      ✔ a hidden feed provider becomes usable once its key is stored
      ✔ an offline window falls back to the five builtin providers
    model selector refresh: provider-first selection
      ✔ half A: the host posts only configured providers, the stale mark and the preserved model
      ✔ half B: only configured providers reach the provider select
      ✔ half B: the model select shows only the chosen provider models
      ✔ half B: the stale badge follows the chosen provider
      ✔ half B: a custom (preserved) model stays selectable and postable
      ✔ half B: the Set API key affordance appears when nothing is usable
    model selector refresh: round-trip
      ✔ a configured model a refresh does not list stays listed and saveable
      ✔ an agent id no longer installed still round-trips
      ✔ a persisted ModelSelection whose provider left the feed survives a refresh
      ✔ a persisted selection whose provider is unconfigured comes back when its key returns

  22 passing (337ms)
```
