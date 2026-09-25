# Review T04

Verdict: **pass**

## Findings

- (none)

## Tests

- ran: true
- passed: true

```
  claudeModelsFromFeed (model-selector-refresh T04)
    ✔ yields the fixture claude ids in feed order, including claude-opus-5-5 (absent from the curated list)
    ✔ carries provider: anthropic and the fixture names as labels on every fixture entry
    ✔ an entry whose name equals its id carries NO label own key
    ✔ drops non-claude- ids of the anthropic provider and Claude-looking ids of other providers
    ✔ a feed with no anthropic provider, and an anthropic provider with no models, both yield []
    ✔ a duplicated id in an array-shaped provider block is emitted once (first occurrence wins)
    ✔ provider id matching is case/whitespace tolerant
    ✔ trims blank model ids and keeps the CLAUDE_MODEL_ID_PREFIX contract

  ClaudeAdapter.discoverModels (model-selector-refresh T04)
    ✔ with ctx.feed resolves the fixture models with no network call and no provenance keys
    ✔ capabilitiesToCatalogFetch round-trips the resolved capabilities into the CatalogFetch shape
    ✔ without ctx.feed the injected fetcher is called exactly once with the clamped timeoutMs
    ✔ a failed fetch resolves undefined and the error message reaches the log sink
    ✔ a throwing fetcher, and one returning a rejected promise, both resolve undefined (never throw)
    ✔ a feed without anthropic, and an anthropic block of only non-claude- ids, resolve undefined
    ✔ an already-aborted signal resolves undefined and never calls the fetcher
    ✔ a never-settling fetch plus a mid-flight abort resolves undefined promptly
    ✔ a feed omitting claude-sonnet-5 still ends with CLAUDE_REQUIRED_MODEL, exactly once and equal to CLAUDE_MODELS[0]
    ✔ a fetcher that aborts the ctx signal synchronously and never settles resolves undefined promptly
    ✔ the registry wires discoverModels for claude only, and the old constructor forms still compile

  19 passing (12ms)
```
