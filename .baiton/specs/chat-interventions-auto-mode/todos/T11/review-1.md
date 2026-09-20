# Review T11

Verdict: **pass**

## Findings

- (none)

## Tests

- ran: true
- passed: true

```
ChatController auto mode
    ✔ echoes and persists the Auto toggle
    ✔ restores the persisted Auto state on start
    ✔ does not gate a permission ask while Auto mode is off
    ✔ settles a gate-approved ask with no card ever pending (allow-list stage)
    ✔ names the model stage in a model-approved ask
    ✔ renders and audits an escalated ask
    ✔ never gates a confirm ask, even with Auto mode on
    ✔ leaves a card presented before the toggle untouched
    ✔ escalates when the gate throws
    ✔ lets a stop win over a slow gate

  1053 passing (37s)
  1 pending

```
