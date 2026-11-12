# Execute P07

## Summary

Updated README.md to document the local config overlay, configuration toolbar buttons, reset and conflict behavior, and related configuration wording.

## Files changed

- `README.md`

## Commands run

- `grep -n 'config\.json' README.md`
- `git diff --check`
- `git diff --name-only`
- `grep -nE 'more-settings|manage-api-keys' media/config.html media/config.js`

## Notes

- The toolbar button selectors are absent from media/config.html and media/config.js; the README documents the planned endstate as requested.
- git diff --check passed, and README.md is the only changed workspace file.
