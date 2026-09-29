# Review T02

Verdict: **pass**

## Findings

- (none)

## Tests

- ran: true
- passed: true

```
    refusals
      ✔ refuses busy while a spec stage runs, writing nothing
      ✔ refuses busy while its own run is in flight, and is running until the last stage settles
      ✔ refuses mode "spec"
      ✔ refuses mode "default"
      ✔ records composerMode "default" for a dispatch from Default
      ✔ refuses a detached HEAD and a base branch with no commits
      ✔ records a failed manifest when the worktree cannot be created
      ✔ fails the run when the role has an unknown agent, after bumping the counter
      ✔ fails the run when the adapter probe fails
      ✔ fails the run when a stage closes without a result
    cancel
      ✔ cancels the stage in flight and leaves the worktree in place
    the execute drift check
      ✔ halts the run when the worktree HEAD moved during execute
    change events
      ✔ emits started, a stage pair per stage, and completed with the terminal manifest
      ✔ stops delivering after unsubscribe and survives a throwing listener
    against a real temporary git repository
      ✔ creates a real worktree, commits the execute with a Run-Id trailer, and leaves main alone (171ms)

  runStore
    create
      ✔ writes a confirmed manifest that reads back identically
      ✔ refuses a duplicate without touching the existing file
      ✔ refuses a spec mode and a dotted id, writing nothing
      ✔ refuses a default mode, writing nothing
      ✔ writes a valid run.json for a dispatch from Default
      ✔ omits the worktree dir for an investigate run
    read
      ✔ classifies an unknown run as absent
      ✔ classifies a bad id as invalid-id
      ✔ classifies broken JSON as unparseable
      ✔ classifies a bad shape as invalid
      ✔ accepts composerMode default
      ✔ drops unknown keys
      ✔ serializes with a trailing newline

  64 passing (302ms)
```
