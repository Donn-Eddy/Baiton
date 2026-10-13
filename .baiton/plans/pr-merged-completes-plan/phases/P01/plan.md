# Plan P01

## Steps

1. Add PrState type and an OPTIONAL stateByUrl method on PrTool

   In src/engine/prTool.ts, after `PrToolError`, add:

   ```ts
   /** A request's lifecycle state as read from the provider; `unknown` when it cannot be established. */
   export type PrState = 'open' | 'merged' | 'closed' | 'unknown';
   ```

   Extend `interface PrTool` with a third member declared OPTIONAL:

   ```ts
   /**
    * The state of the request at `url`. Never rejects: an unparsable URL, a CLI
    * failure (missing executable, offline, non-zero exit) or unrecognised output
    * all resolve `'unknown'`. Optional so hand-written fakes need not implement
    * it; callers treat an absent method as `'unknown'`.
    */
   stateByUrl?(url: string): Promise<PrState>;
   ```

   It MUST be optional: test/submitPr.test.ts (`FakePrTool implements PrTool`), test/submitPr.multiRepo.test.ts, test/integration.sub-agent-chats.test.ts and test/integration.plan-execute-review.test.ts build PrTool objects with only findOpenByHead/create, and mocha runs through ts-node (type-checked), so a required member would break existing tests that this phase may not edit. Decision documented in the doc comment: the method never rejects — failures map to 'unknown' (do not reject with PrToolError). Also update the file header comment: 'The submit flow needs two operations ... so PrTool is that small' → mention the third, read-only state lookup used to derive plan completion.

   Files: `src/engine/prTool.ts`

2. Add the pure URL parser parsePrUrl

   Export from src/engine/prTool.ts:

   ```ts
   /** A recorded request URL split into what the CLIs' `--repo` flags and view commands need. */
   export interface ParsedPrUrl {
     kind: PrProviderKind;   // 'gh' for /pull/<n>, 'glab' for /-/merge_requests/<n>
     host: string;           // e.g. 'github.com'
     repoPath: string;       // 'owner/repo' or 'group/sub/project'
     number: number;         // PR number or MR iid
   }
   /** Parse `https://host/owner/repo/pull/12` or `https://host/group/sub/project/-/merge_requests/7`; `undefined` otherwise. */
   export function parsePrUrl(url: string): ParsedPrUrl | undefined
   ```

   Implementation: trim; use `new URL(trimmed)` inside try/catch (return undefined on throw); require protocol `http:`/`https:`; take `pathname`, strip a trailing '/', split on '/' filtering empty segments. GitLab: find the index of the segment pair `'-'`, `'merge_requests'`; require at least one segment before `'-'`, exactly one segment after `merge_requests` matching /^\d+$/; repoPath = segments before '-' joined with '/'; kind 'glab'. GitHub: require exactly 4 segments `[owner, repo, 'pull', /^\d+$/]`; kind 'gh'. Number via `Number(...)`, require > 0. host = `u.host` (keeps a port, e.g. self-hosted). Anything else (issues URLs, missing number, `/pull/abc`, empty string, non-URL) → undefined. Decode nothing; no I/O.

   Files: `src/engine/prTool.ts`

3. Add pure state-JSON parsers for each CLI

   Export from src/engine/prTool.ts:

   ```ts
   /** `gh pr view --json state` output → PrState: OPEN/MERGED/CLOSED (case-insensitive); anything else unknown. */
   export function parseGhPrState(stdout: string): PrState
   /** `glab mr view --output json` output → PrState: opened→open, merged, closed and locked→closed; anything else unknown. */
   export function parseGlabMrState(stdout: string): PrState
   ```

   Both: trim; empty → 'unknown'; JSON.parse in try/catch → 'unknown' on failure; require a non-null non-array object with a string `state` field, else 'unknown'; lower-case it and map. gh: 'open'→'open', 'merged'→'merged', 'closed'→'closed'. glab: 'opened'→'open', 'merged'→'merged', 'closed'→'closed', 'locked'→'closed'. Unknown strings → 'unknown'. Mirror the defensive style of `parsePrList`.

   Files: `src/engine/prTool.ts`

4. Implement stateByUrl in ghTool and glabTool

   Add a `stateByUrl` member to each object literal WITHOUT touching the existing findOpenByHead/create argument arrays.

   ghTool:
   ```ts
   async stateByUrl(url) {
     const parsed = parsePrUrl(url);
     if (parsed === undefined || parsed.kind !== 'gh') return 'unknown';
     try {
       const out = await cli(['pr', 'view', String(parsed.number), '--repo', `${parsed.host}/${parsed.repoPath}`, '--json', 'state']);
       return parseGhPrState(out);
     } catch {
       return 'unknown';
     }
   },
   ```
   glabTool:
   ```ts
   async stateByUrl(url) {
     const parsed = parsePrUrl(url);
     if (parsed === undefined || parsed.kind !== 'glab') return 'unknown';
     try {
       const out = await cli(['mr', 'view', String(parsed.number), '--repo', parsed.repoPath, '--output', 'json']);
       return parseGlabMrState(out);
     } catch {
       return 'unknown';
     }
   },
   ```
   An unparsable URL or one shaped for the other provider returns 'unknown' WITHOUT invoking the runner. Since the parsers never throw, the try/catch only guards the runner's rejection (PrToolError from execCli or anything else). Optionally factor a tiny `stateOrUnknown(read: () => Promise<PrState>)` helper if it reads cleaner; keep it private. No change to `createPrTool`, `execCli`, `CLI_TIMEOUT_MS`, `parsePrList`, `parseCreatedPr`.

   Files: `src/engine/prTool.ts`

5. Extend test/prTool.test.ts

   Add imports `createPrTool, parsePrUrl, parseGhPrState, parseGlabMrState` (and `type PrState` if useful) from '../src/engine/prTool'; leave the existing three tests unchanged. Add a new `describe('request state by URL', ...)` with:

   1. parsePrUrl: `https://github.com/o/r/pull/12` → `{ kind:'gh', host:'github.com', repoPath:'o/r', number:12 }`; trailing slash accepted; `https://gitlab.com/g/sub/p/-/merge_requests/7` → `{ kind:'glab', host:'gitlab.com', repoPath:'g/sub/p', number:7 }`; self-hosted with port `https://git.example:8443/g/p/-/merge_requests/3` keeps host 'git.example:8443'; undefined for '', 'not a url', `https://github.com/o/r/issues/1`, `https://github.com/o/r/pull/abc`, `https://github.com/o/r/pull/`, `https://gitlab.com/-/merge_requests/1`, `ssh://git@github.com/o/r/pull/1`.
   2. parseGhPrState: `{"state":"OPEN"}`→open, MERGED→merged, CLOSED→closed, `{"state":"DRAFT"}`→unknown, '' / 'garbage' / '[]' / '{}' / `{"state":1}` → unknown.
   3. parseGlabMrState: opened→open, merged→merged, closed→closed, locked→closed, `{"state":"weird"}`/''/'garbage' → unknown.
   4. gh argument shape: createPrTool({kind:'gh', executable:'/bin/gh', repoRoot:'/repo', run}) with a recording runner returning `{"state":"MERGED"}`; `await tool.stateByUrl!('https://github.com/o/r/pull/12')` === 'merged'; assert exe '/bin/gh', cwd '/repo', and `calls[0]` deepStrictEqual `['pr','view','12','--repo','github.com/o/r','--json','state']`.
   5. glab argument shape: runner returns `{"iid":7,"state":"opened"}`; stateByUrl('https://gitlab.com/g/sub/p/-/merge_requests/7') === 'open'; calls[0] deepStrictEqual `['mr','view','7','--repo','g/sub/p','--output','json']`.
   6. Failure → unknown: a runner that rejects with a PrToolError-shaped object (`{command:'gh pr view', exitCode:1, stderr:'offline'}`) → 'unknown' (no rejection); runner returning 'not json' → 'unknown'.
   7. No CLI call for bad URLs: runner that pushes calls; gh tool given 'nope' and a GitLab MR URL → 'unknown' each and calls.length === 0; glab tool given a GitHub /pull/ URL → 'unknown', calls.length === 0.
   8. Existing shapes untouched (optional, since submitPr.test.ts already pins them): one gh tool exercising findOpenByHead/create then stateByUrl and asserting the first two argument arrays are exactly the existing ones.
   Use `tool.stateByUrl!(...)` or a local `const state = tool.stateByUrl; assert.ok(state)` guard since the member is optional.

   Files: `test/prTool.test.ts`

## Risks

- Making stateByUrl required on PrTool would break type-checked (ts-node) fakes in test/submitPr.test.ts, test/submitPr.multiRepo.test.ts and the two integration tests, which this phase may not edit; it must be optional and later phases must treat an absent method as 'unknown'.
- gh `--repo` accepts `HOST/OWNER/REPO`; for github.com this is equivalent to OWNER/REPO, but GitHub Enterprise requires the host prefix — keep the host in the argument.
- glab `--repo group/project` resolves the host from the repo's remote/config (cwd is repoRoot); a recorded URL on a different GitLab host than the configured one may read the wrong instance or fail — failure maps to 'unknown', which is the conservative outcome.
- glab's JSON for `mr view` reports `state` as `opened`/`merged`/`closed`/`locked`; if a glab version prints non-JSON despite `--output json`, the parser returns 'unknown' (fail soft, acceptable).
- Swallowing every rejection inside stateByUrl hides the error text from callers; the explorer's once-per-plan log (later phase) will only see 'unknown'. Acceptable per the fail-soft constraint, but documented in the doc comment.
- `new URL` normalises paths (e.g. percent-encoding, `..`); URLs recorded by the CLIs are canonical, so this is not expected to matter.

## Acceptance

- src/engine/prTool.ts exports `PrState`, `ParsedPrUrl`, `parsePrUrl`, `parseGhPrState`, `parseGlabMrState`, each with a doc comment, and `PrTool` has an optional `stateByUrl(url): Promise<PrState>` documented as never rejecting.
- gh stateByUrl invokes the runner exactly with `['pr','view','<n>','--repo','<host>/<owner>/<repo>','--json','state']`; glab with `['mr','view','<iid>','--repo','<group/.../project>','--output','json']`.
- Unparsable or wrong-provider URLs resolve 'unknown' without calling the runner; runner rejection or unrecognised output resolves 'unknown'.
- The existing findOpenByHead/create argument arrays, parsePrList, parseCreatedPr, createPrTool's signature and execCli are unchanged (git diff shows only additions in those regions).
- Only src/engine/prTool.ts and test/prTool.test.ts are modified.
- `npm run compile` and `npm run lint` pass; `npm test` passes, including all pre-existing tests unchanged (notably test/submitPr.test.ts and test/submitPr.multiRepo.test.ts with their PrTool fakes).
