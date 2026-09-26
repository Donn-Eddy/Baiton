# Review T14

Verdict: **pass**

## Findings

- (none)

## Tests

- ran: true
- passed: true

```
  chat view provider-first model selector (model-selector-refresh T14)
    ✔ seed paint: a disabled placeholder in each select, no Set API key, no stale badge
    ✔ setProviders lists the posted groups in host order and only the chosen provider models
    ✔ a selection drives both selects
    ✔ changing the provider repaints the models and posts nothing; picking a model posts once
    ✔ a disabled model row repaints rather than posting
    ✔ custom values stay visible, selected and postable
    ✔ the stale badge follows the chosen provider
    ✔ the Set API key affordance tracks unusable providers and posts triggerFix
    ✔ setBusy disables both selects while true and re-enables them after
    ✔ the empty state shows the provider label and model, falling back when unselected

  10 passing (22ms)

Full unit suite: 1603 passing, 1 pending, 1 failing (known pre-existing keytar native-module gating assertion in test/activation.gating.test.ts).
```
