# Review T02

Verdict: **pass**

## Findings

- (none)

## Tests

- ran: true
- passed: true

```
    writeTodoState
      ✔ rewrites only the target todo state box, leaving every other byte identical
      ✔ preserves the id, title and hints on the edited line
      ✔ aborts with todo-not-found when the id is absent
      ✔ refuses to change a done todo and reports done-protected
      ✔ leaves a done todo unchanged even when the requested state is done
    writeFrontmatterKey
      ✔ writes a managed key value, leaving every other byte identical
      ✔ overwrites an existing managed value in place
      ✔ does not touch a non-managed key that shares a value shape
      ✔ aborts with key-not-found when the managed key is absent
      ✔ aborts with key-not-found when there is no frontmatter block


  2263 passing (49s)
  1 pending
```
