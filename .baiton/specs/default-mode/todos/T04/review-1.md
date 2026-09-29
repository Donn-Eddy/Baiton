# Review T04

Verdict: **pass**

## Findings

- (none)

## Tests

- ran: true
- passed: true

```
ChatController conversation mode (dispatch-modes T14)
    ✔ seeds the mode from memory and paints run activity
    ✔ falls back to Default for an absent or off-union stored mode
    ✔ a fresh workspace opens in Default
    ✔ a stored concrete mode wins over Default
    ✔ Default maps to the run phase, run tools and the Default prompt
    ✔ a spec conversation stays pinned to Spec from a Default workspace
    ✔ echoes and persists a mode picked in the composer
    ✔ echoes but does not re-persist a repeated mode
    ✔ refuses an off-union mode, echoing the unchanged one
    ✔ pins a spec conversation to Spec and repaints the remembered mode on return
    ✔ refuses a mode change while the chat is busy
    ✔ refuses a mode change while a run is in flight
    ✔ derives the phase, tool surface and prompt from the mode
    ✔ ignores a non-spec mode on a spec conversation
    ✔ mirrors run activity without duplicate posts
    ✔ appends a completion note, and logs a failed run
    ✔ promotes a finding into a Bug run through the run confirm card
    ✔ dispatches nothing on dismiss, on a decline, and notes a busy outcome (47ms)
    ✔ posts the promote card once per run id, and never without the dispatch seam
    ✔ notes, and does not offer, a finding in Restricted Mode
    ✔ unsubscribes on dispose and keeps exactly one subscription across starts

  21 passing (348ms)
```
