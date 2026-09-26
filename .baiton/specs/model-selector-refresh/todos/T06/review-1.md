# Review T06

Verdict: **pass**

## Findings

- (none)

## Tests

- ran: true
- passed: true

```
  opencodeModelsFromApi (model-selector-refresh T06)
    ✔ reads a bare array of strings
    ✔ reads a bare array of objects with id/name
    ✔ reads a providers array of buckets and prefixes the provider id
    ✔ reads a `models` array and an `items` array
    ✔ reads a provider-keyed map under `providers`, with models as an array
    ✔ reads a provider-keyed map whose models are themselves a map keyed by model id
    ✔ reads a provider-keyed map at the top level (no providers wrapper)
    ✔ never double-prefixes an id that already contains a slash
    ✔ omits a label equal to the emitted id
    ✔ collapses duplicates first-wins and skips blank/idless items
    ✔ returns [] for every unrecognised payload
    ✔ never emits efforts or defaultEffort (opencode effort is free-text --variant)
    ✔ is pure: the input is untouched

  opencodeModelsFromCliOutput (model-selector-refresh T06)
    ✔ reads a realistic multi-line listing in order
    ✔ sets provider from the id half before the slash
    ✔ drops tokens that are not provider/model
    ✔ collapses duplicates and returns [] for empty output

  mergeOpencodeModelSources (model-selector-refresh T06)
    ✔ keeps the API order first and appends only CLI-only ids
    ✔ falls back to the CLI verbatim with no API entries
    ✔ keeps the API verbatim with no CLI entries
    ✔ mutates neither input

  parseOpencodeServerUrl (model-selector-refresh T06)
    ✔ extracts the ephemeral URL from a realistic serve banner
    ✔ strips a trailing slash
    ✔ returns undefined when no URL appeared

  OpencodeAdapter.discoverModels (model-selector-refresh T06)
    ✔ GETs exactly <baseUrl>/api/model and returns the merged list with empty efforts
    ✔ stamps no provenance and no modelLink (CatalogStore/overlayCapabilities own those)
    ✔ disposes the started server exactly once on success
    ✔ disposes the started server exactly once on fetch failure and on abort
    ✔ never spawns when serverBaseUrl is given, and never kills that server
    ✔ never spawns when OPENCODE_SERVER holds an http URL
    ✔ ignores a non-http OPENCODE_SERVER value and starts a server instead
    ✔ falls back to the CLI list when the starter resolves undefined
    ✔ falls back to the CLI list when fetch rejects
    ✔ falls back to the CLI list when the server answers HTTP 500
    ✔ falls back to the CLI list when text() rejects
    ✔ falls back to the CLI list when the body is not JSON
    ✔ falls back to the CLI list when the body parses to an unrecognised shape
    ✔ runs the CLI as a validation source even when the API succeeded
    ✔ resolves undefined (never the curated list) when both sources are empty
    ✔ makes no call at all when ctx.signal is already aborted
    ✔ resolves undefined when the abort lands while the fetch is in flight
    ✔ resolves undefined rather than rejecting when the starter throws synchronously
    ✔ resolves undefined rather than rejecting when the CLI runner rejects
    ✔ clamps a budget larger than the default and replaces a non-positive one
    ✔ round-trips through capabilitiesToCatalogFetch with no efforts key
    ✔ leaves launch() byte-identical whether or not discovery options were passed
    ✔ still resolves session ids through the positional listSessions parameter

  47 passing (21ms)

Full unit suite: 1506 passing, 1 pending, 1 failing (pre-existing keytar native module assertion in test/activation.gating.test.ts).
```
