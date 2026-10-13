# Plan P02

## Steps

1. Import PrState and parsePrsValue into transitions.ts

   In src/engine/transitions.ts, below the existing imports (line 32-33), add:
     import { parsePrsValue, type PrState } from './prTool';
   (or two lines: `import type { PrState } from './prTool';` and `import { parsePrsValue } from './prTool';` — match the repo's lint config; if `import { x, type Y }` style is not used elsewhere, use two separate statements). prTool.ts does not import transitions.ts, so there is no cycle; submitPr.ts already imports both. P01 already exported `PrState = 'open' | 'merged' | 'closed' | 'unknown'` and `parsePrsValue(raw: string | undefined): Map<string, string>` from src/engine/prTool.ts — do not redefine them. Also extend the module doc comment's last paragraph (lines 28-30) with one sentence: the helpers also derive whether every recorded request has been merged, which is a derived plan fact used for grouping, never persisted.

   Files: `src/engine/transitions.ts`

2. Add recordedPrUrls helper (recorded-URL set)

   Append after isPartialPrStatus in src/engine/transitions.ts:

   /**
    * The plan's recorded request URLs: the `pr:` value followed by every `prs:`
    * value in key order, trimmed, with empties and duplicates dropped. The
    * explorer and the submit readiness check both derive the set here so they
    * agree on what "every recorded request" means.
    */
   export function recordedPrUrls(pr: string | undefined, prs: string | undefined): string[] {
     const urls: string[] = [];
     const add = (raw: string | undefined): void => {
       const url = raw?.trim();
       if (url && !urls.includes(url)) urls.push(url);
     };
     add(pr);
     for (const url of parsePrsValue(prs).values()) add(url);
     return urls;
   }

   Inputs are the raw frontmatter strings (as the callers read them; undefined when absent). Malformed `prs` JSON yields only the `pr` value (parsePrsValue already returns an empty map). Pure, no I/O.

   Files: `src/engine/transitions.ts`

3. Add planPrsMerged pure rule

   Append in src/engine/transitions.ts (beside the helper above):

   /**
    * Whether a plan's PRs are all merged: true only when at least one URL is
    * recorded and every recorded URL is observed `merged`. A missing
    * observation, or `open` / `closed` / `unknown`, counts as not merged.
    */
   export function planPrsMerged(recorded: readonly string[], observed: ReadonlyMap<string, PrState>): boolean {
     return recorded.length > 0 && recorded.every((url) => observed.get(url) === 'merged');
   }

   Do not trim/normalise inside planPrsMerged — callers pass URLs from recordedPrUrls and key the map by the same strings. Do not touch planPrStatus, reposToSubmit, isPartialPrStatus, RepoPrState or PlanPrStatus. Both new exports are re-exported automatically via `export * from './transitions'` in src/engine/index.ts; confirm no name clash with prTool exports (none named recordedPrUrls/planPrsMerged exist).

   Files: `src/engine/transitions.ts`

4. src/engine/prTool.ts: no functional change

   The phase lists prTool.ts only because PrState and parsePrsValue live there (added/existing from P01). Leave it unchanged unless compile shows PrState is not exported; do not alter findOpenByHead/create argument arrays, parsePrList, parseCreatedPr, or the stateByUrl implementation.

   Files: `src/engine/prTool.ts`

5. Extend test/transitions.prStatus.test.ts

   Change the import to `import { isPartialPrStatus, planPrStatus, planPrsMerged, recordedPrUrls, reposToSubmit } from '../src/engine/transitions';` and add `import type { PrState } from '../src/engine/prTool';`. Keep the two existing `it` blocks byte-identical. Add inside the same describe (or a new describe 'recorded PR merge rule'):

   1. recordedPrUrls examples:
      - (undefined, undefined) → []
      - (' https://h/o/r/pull/1 ', undefined) → ['https://h/o/r/pull/1']
      - ('', '') → []
      - ('https://h/o/r/pull/1', '{"a":"https://h/o/a/pull/2","b":"https://h/o/r/pull/1"}') → ['https://h/o/r/pull/1','https://h/o/a/pull/2'] (dedup, pr first, prs key order)
      - (undefined, '{"a":"u1","b":"u2"}') → ['u1','u2']
      - (undefined, 'not json') → []; (undefined, '{"a":3,"b":"u"}') → ['u'] (non-string ignored)
   2. planPrsMerged examples:
      - ([], new Map()) → false
      - (['u'], new Map([['u','merged']])) → true
      - (['u','v'], map with u merged, v open) → false; v 'closed' → false; v 'unknown' → false; v missing → false
      - (['u','v'], both merged) → true; extra unrelated observed entries don't matter.
   3. Property (fast-check, numRuns ~300): generate a uniqueArray of URL ids (fc.uniqueArray(fc.integer({min:0,max:1000}), {maxLength: 8})) mapped to `https://h/o/r/pull/${id}`, and for each a `fc.option(fc.constantFrom<PrState>('open','merged','closed','unknown'), {nil: undefined})` observation; build the Map omitting undefined; assert planPrsMerged(urls, observed) === (urls.length > 0 && urls.every(u => observed.get(u) === 'merged')) — express the expectation via the generated observation array (non-empty and all entries === 'merged') rather than re-calling the same expression on the map.
   4. Property for recordedPrUrls: for an arbitrary list of url strings split into a pr value and a prs object (fc.dictionary of key→url), the result has no duplicates, contains no empty/whitespace strings, every element is trimmed, and its set equals the set of trimmed non-empty inputs.

   Files: `test/transitions.prStatus.test.ts`

6. Verify

   Run `npm run compile`, `npm run lint`, and `npm test` (the full suite; P01 noted the sandbox may need process permissions for spawnSync). Run `git diff --check`. Confirm only src/engine/transitions.ts and test/transitions.prStatus.test.ts changed (prTool.ts untouched unless strictly necessary).

   Files: (none)

## Risks

- transitions.ts now value-imports './prTool', which imports child_process/fs/os/path. All importers of transitions (submitPr, runQueue, model/phaseActions, activation/*) run in the Node extension host and no browser bundle imports them, so this is safe; if a lint rule forbids engine->prTool value imports, inline a call-site-equivalent JSON parse is NOT preferred — instead keep the import (submitPr.ts already does the same).
- Mixed `import { x, type Y }` syntax may be rejected by the TS/eslint config; use separate `import type` and value imports if so.
- Name collision via `export *` in src/engine/index.ts: ensure recordedPrUrls/planPrsMerged are not already exported by another engine module (grep before adding).
- Ordering contract: later phases (explorer memo key, submitPr refusal message) rely on the stable `pr`-first then `prs`-key-order output; changing it later would alter memo keys but not correctness.

## Acceptance

- src/engine/transitions.ts exports `recordedPrUrls(pr: string | undefined, prs: string | undefined): string[]` returning trimmed, non-empty, deduplicated URLs with `pr` first then `prs` values in key order, reusing parsePrsValue.
- src/engine/transitions.ts exports `planPrsMerged(recorded: readonly string[], observed: ReadonlyMap<string, PrState>): boolean` that is true iff recorded is non-empty and every recorded URL maps to 'merged'.
- Both new functions have doc comments and perform no I/O; planPrStatus, reposToSubmit, isPartialPrStatus are unchanged.
- test/transitions.prStatus.test.ts keeps its existing tests unchanged and adds example tests plus fast-check properties for both new functions.
- `npm run compile`, `npm run lint` (no new errors) and `npm test` all pass; `git diff --check` is clean.
