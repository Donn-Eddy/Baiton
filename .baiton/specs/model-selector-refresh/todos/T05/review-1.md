# Review T05

Verdict: **pass**

## Findings

- (none)

## Tests

- ran: true
- passed: true

```
  codexModelsFromAppServer (model-selector-refresh T05)
    ✔ parses the {models:[…]} shape with ids, labels, per-model efforts and defaults
    ✔ parses an {items:[…]} object and a bare array too
    ✔ trims ids, skips blank and unusable items (numbers, null, no-id objects)
    ✔ a duplicate id keeps the first entry (including its label)
    ✔ displayName/name become label ONLY when they differ from the id
    ✔ supports string and object elements of supportedReasoningEfforts, dropping blanks/dups and keeping order
    ✔ drops a defaultEffort absent from a non-empty efforts list; keeps it when efforts are empty/absent/membership-holding
    ✔ yields [] for unrecognised payloads: undefined, null, number, string, empty object, non-array models
    ✔ never writes an own undefined key on any entry
    ✔ never mutates the payload it parses (frozen and snapshot-checked)

  CodexAdapter.discoverModels (model-selector-refresh T05)
    ✔ happy path: resolves ids with per-model efforts, the union efforts, and the exact three-message handshake
    ✔ capabilitiesToCatalogFetch round-trips the ids and the union efforts
    ✔ models with no supportedReasoningEfforts fall the capability efforts back to CODEX_EFFORTS
    ✔ forwards ctx.cwd to the spawner
    ✔ reframes split chunks (one as a Buffer), blank lines, non-JSON lines, notifications and unknown-id requests
    ✔ an initialize JSON-RPC error resolves undefined, writes no model/list request, and kills the child
    ✔ a model/list JSON-RPC error resolves undefined, kills the child, and logs a non-empty reason
    ✔ a missing binary (ENOENT error) resolves undefined and logs that codex app-server was not found on PATH
    ✔ an early exit (and separately an early close) resolves undefined without rejecting
    ✔ a never-replying child times out (killed exactly once) and logs the timeout reason
    ✔ the timeout clamp: timeoutMs 0 still spawns and succeeds; timeoutMs 60_000 does not break an immediate reply
    ✔ an already-aborted signal spawns no process; a mid-flight abort resolves undefined and kills the child
    ✔ a synchronously-throwing spawner and a throwing stdin.write both resolve undefined
    ✔ an empty discovered list resolves undefined so agentCapabilities() keeps the curated CODEX_MODELS list
    ✔ the registry wires discoverModels for codex (not antigravity), and the no-arg constructor still works

  25 passing (51ms)
```
