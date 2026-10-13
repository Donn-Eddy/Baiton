import * as assert from 'assert';
import * as fc from 'fast-check';
import { createHash } from 'crypto';
import { approvalHash, computeInputRev } from '../src/model/hash';
import { DocumentKind, parsePlan, ParsedPlan } from '../src/model/parser';
import { PHASE_STATES, PhaseState } from '../src/model/phaseState';

/**
 * Feature: baiton-first-pass, Property 7: Approval hash is invariant under
 * state-box changes and sensitive to content
 *
 * For any supported document, changing only the `[state]` boxes of one or more phase lines
 * SHALL leave the approval hash unchanged, while changing the preamble text,
 * any phase title, id, or hints SHALL change the approval hash.
 *
 * Validates: Requirements 5.1, 5.5
 *
 * The approval hash (src/model/hash.ts) covers the preamble section plus every
 * phase line with its state box blanked to `[]` (Req 5.1). Blanking makes the
 * hash stable across lifecycle state changes, which is exactly what Re-approve
 * relies on to leave phase states meaningful while re-tying approval to content
 * (Req 5.5). This test generates documents, renders it, and asserts (a) mutating
 * only the state boxes leaves the hash unchanged, and (b) mutating the OVERVIEW,
 * a phase title, id, or hints changes the hash.
 */

/** The model a generated document is rendered from and parsed back into. */
interface DocumentModel {
  kind: DocumentKind;
  preambleLines: string[];
  phases: PhaseModel[];
}

interface PhaseModel {
  id: string;
  state: PhaseState;
  title: string;
  after: string[];
  files: string[];
  repo?: string;
}

type ContentMutation = 'preamble' | 'title' | 'id' | 'after' | 'files' | 'repo-add' | 'repo-change' | 'repo-remove';

/** Renders a {@link DocumentModel} to canonical document text `parsePlan` consumes. */
function renderDocument(model: DocumentModel): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push('title: sample');
  lines.push('---');
  if (model.kind === 'legacy-spec') {
    lines.push('# OVERVIEW');
    lines.push(...model.preambleLines);
    lines.push('# TODOS');
  } else {
    lines.push('## Endstate');
    lines.push(...model.preambleLines);
    lines.push('## What needs changing');
    lines.push('Change behavior.');
    lines.push('## Limitations & constraints');
    lines.push('None.');
    lines.push('# PHASES');
  }
  for (const t of model.phases) {
    lines.push(renderPhaseLine(t));
  }
  return lines.join('\n');
}

/** Renders one phase line: `- [state] id title` with an optional hint group. */
function renderPhaseLine(t: PhaseModel): string {
  let line = `- [${t.state}] ${t.id} ${t.title}`;
  const groups: string[] = [];
  if (t.after.length > 0) {
    groups.push(`after ${t.after.join(',')}`);
  }
  if (t.files.length > 0) {
    groups.push(`files: ${t.files.join(',')}`);
  }
  if (t.repo !== undefined) groups.push(`repo: ${t.repo}`);
  if (groups.length > 0) {
    line += ` (${groups.join('; ')})`;
  }
  return line;
}

// --- Generators ------------------------------------------------------------

/** A phase id uses the document prefix (`P`, or legacy `T`) and two or more digits (Req 3.3). */
const idArb = (kind: DocumentKind): fc.Arbitrary<string> => fc
  .integer({ min: 0, max: 999999 })
  .map((n) => (kind === 'plan' ? 'P' : 'T') + String(n).padStart(2, '0'));

/**
 * A phase title free of the characters the hint/section grammar reserves, so it
 * never collides with a trailing hint group.
 */
const titleArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 40 })
  .map((s) => s.replace(/[()\n\r;]/g, ' ').trim())
  .filter((s) => s.length > 0);

/** A file path hint: non-empty, no comma/semicolon/paren/newline. */
const pathArb: fc.Arbitrary<string> = fc
  .string({ minLength: 1, maxLength: 20 })
  .map((s) => s.replace(/[(),;\n\r]/g, '').trim())
  .filter((s) => s.length > 0);

const repoSegmentArb = fc.stringMatching(/^[a-z0-9_-]{1,8}$/);
const repoArb: fc.Arbitrary<string> = fc.oneof(
  fc.constant('.'),
  fc.array(repoSegmentArb, { minLength: 1, maxLength: 3 }).map((parts) => parts.join('/')),
);

/**
 * A preamble prose line that cannot be mistaken for a section header or a
 * frontmatter fence.
 */
const overviewLineArb: fc.Arbitrary<string> = fc
  .string({ maxLength: 40 })
  .map((s) => s.replace(/[\n\r]/g, ' '))
  .filter((s) => s.trim() !== '---' && !/^#+\s/.test(s));

/**
 * A document with at least one phase (so state-box and content mutations always have
 * a target). Ids are unique; `after` targets are drawn from the generated ids.
 */
const documentModelArb: fc.Arbitrary<DocumentModel> = fc
  .record({
    kind: fc.constantFrom<DocumentKind>('plan', 'legacy-spec'),
    preambleLines: fc.array(overviewLineArb, { maxLength: 6 }),
  })
  .chain(({ kind, preambleLines }) =>
    fc.uniqueArray(idArb(kind), { minLength: 1, maxLength: 6 }).chain((ids) => {
    const phaseArb = fc.tuple(
      ...ids.map((id) =>
        fc
          .record({
            state: fc.constantFrom<PhaseState>(...PHASE_STATES),
            title: titleArb,
            after: fc.subarray(ids),
            files: fc.array(pathArb, { maxLength: 4 }),
            repo: fc.option(repoArb, { nil: undefined }),
          })
          .map((r) => ({ id, ...r })),
      ),
    );
    return fc.record({
      kind: fc.constant(kind),
      preambleLines: fc.constant(preambleLines),
      phases: phaseArb,
    });
    }),
  );

/** A fresh state per phase, drawn independently so mutations can differ. */
const statesArb = (n: number): fc.Arbitrary<PhaseState[]> =>
  fc.array(fc.constantFrom<PhaseState>(...PHASE_STATES), {
    minLength: n,
    maxLength: n,
  });

// --- Property --------------------------------------------------------------

describe('approval hash (property)', () => {
  it('keeps hint-less documents byte-identical to the pre-change hash payload', () => {
    const hintlessModelArb = documentModelArb.map((model) => ({
      ...model,
      phases: model.phases.map((phase) => ({ ...phase, repo: undefined })),
    }));
    fc.assert(
      fc.property(hintlessModelArb, (model) => {
        const phaseLines = model.phases.map(renderPhaseLine);
        const parsed = parsePlan(renderDocument(model));
        const blankedLines = phaseLines.map((line) => line.replace(/^(- )\[[^\]]*\]/, '$1[]'));
        const expectedApprovalHash = createHash('sha256')
          .update([parsed.preamble, ...blankedLines].join('\n'), 'utf8')
          .digest('hex');
        assert.strictEqual(approvalHash(parsed), expectedApprovalHash);
        for (let i = 0; i < parsed.phases.length; i++) {
          const expectedInputRev = createHash('sha256')
            .update([parsed.preamble, blankedLines[i]].join('\n'), 'utf8')
            .digest('hex');
          assert.strictEqual(computeInputRev(parsed, parsed.phases[i].id), expectedInputRev);
          assert.strictEqual('repo' in parsed.phases[i], false);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('preserves the pre-change legacy hash payload exactly', () => {
    const raw = [
      '# OVERVIEW',
      'Legacy overview.',
      '',
      '# TODOS',
      '- [pending] T01 first',
      '- [done] T02 second (after T01)',
    ].join('\n');
    const blankedLegacyItemLines = [
      '- [] T01 first',
      '- [] T02 second (after T01)',
    ];
    const oldPayload = ['Legacy overview.\n', ...blankedLegacyItemLines].join('\n');
    const expected = createHash('sha256').update(oldPayload, 'utf8').digest('hex');
    assert.strictEqual(approvalHash(parsePlan(raw)), expected);
    const oldInputRevPayload = ['Legacy overview.\n', '- [] T01 first'].join('\n');
    const expectedInputRev = createHash('sha256').update(oldInputRevPayload, 'utf8').digest('hex');
    assert.strictEqual(computeInputRev(parsePlan(raw), 'T01'), expectedInputRev);
  });

  // Feature: baiton-first-pass, Property 7: Approval hash is invariant under
  // state-box changes and sensitive to content
  it('is invariant under state-box changes', () => {
    fc.assert(
      fc.property(
        documentModelArb.chain((model) =>
          fc.record({
            model: fc.constant(model),
            newStates: statesArb(model.phases.length),
          }),
        ),
        ({ model, newStates }) => {
          const original: ParsedPlan = parsePlan(renderDocument(model));
          const baseHash = approvalHash(original);

          // Mutate ONLY the state boxes; keep id/title/hints/overview intact.
          const mutated: DocumentModel = {
            kind: model.kind,
            preambleLines: model.preambleLines,
            phases: model.phases.map((t, i) => ({ ...t, state: newStates[i] })),
          };
          const mutatedHash = approvalHash(parsePlan(renderDocument(mutated)));

          assert.strictEqual(
            mutatedHash,
            baseHash,
            'state-box-only change must not alter the approval hash',
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  // Feature: baiton-first-pass, Property 7: Approval hash is invariant under
  // state-box changes and sensitive to content
  it('changes when the preamble, a title, an id, or hints change', () => {
    fc.assert(
      fc.property(
        documentModelArb.chain((fixedModel) => {
            const kinds: ContentMutation[] = ['preamble', 'title', 'id', 'after', 'files'];
            if (fixedModel.phases.some((phase) => phase.repo === undefined)) kinds.push('repo-add');
            if (fixedModel.phases.some((phase) => phase.repo !== undefined)) {
              kinds.push('repo-change', 'repo-remove');
            }
            return fc.constantFrom(...kinds).chain((kind) => {
              const validIndices = fixedModel.phases
                .map((phase, index) => ({ phase, index }))
                .filter(({ phase }) => kind === 'repo-add'
                  ? phase.repo === undefined
                  : kind === 'repo-change' || kind === 'repo-remove'
                    ? phase.repo !== undefined
                    : true)
                .map(({ index }) => index);
              const idxArb = kind.startsWith('repo-')
                ? fc.constantFrom(...validIndices)
                : fc.nat({ max: Math.max(0, fixedModel.phases.length - 1) });
              return idxArb.map((idx) => ({ model: fixedModel, kind, idx }));
            });
        }),
        ({ model, kind, idx }) => {
          const baseHash = approvalHash(parsePlan(renderDocument(model)));
          const mutated = mutateContent(model, kind, idx);
          const mutatedHash = approvalHash(parsePlan(renderDocument(mutated)));

          assert.notStrictEqual(
            mutatedHash,
            baseHash,
            `content change (${kind}) must alter the approval hash`,
          );
        },
      ),
      { numRuns: 200 },
    );
  });

  it('changes only the targeted phase input rev for repo hint mutations', () => {
    fc.assert(
      fc.property(
        documentModelArb.chain((model) => {
          const kinds: ContentMutation[] = [];
          if (model.phases.some((phase) => phase.repo === undefined)) kinds.push('repo-add');
          if (model.phases.some((phase) => phase.repo !== undefined)) kinds.push('repo-change', 'repo-remove');
          return fc.constantFrom(...kinds).chain((kind) => {
            const validIndices = model.phases
              .map((phase, index) => ({ phase, index }))
              .filter(({ phase }) => kind === 'repo-add' ? phase.repo === undefined : phase.repo !== undefined)
              .map(({ index }) => index);
            return fc.constantFrom(...validIndices).map((idx) => ({ model, kind, idx }));
          });
        }),
        ({ model, kind, idx }) => {
          const original = parsePlan(renderDocument(model));
          const mutatedModel = mutateContent(model, kind, idx);
          const mutated = parsePlan(renderDocument(mutatedModel));
          const targetId = model.phases[idx].id;
          assert.notStrictEqual(computeInputRev(mutated, targetId), computeInputRev(original, targetId));
          for (const phase of original.phases) {
            if (phase.id === targetId) continue;
            assert.strictEqual(computeInputRev(mutated, phase.id), computeInputRev(original, phase.id));
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

/**
 * Produces a copy of `model` with exactly one content change of the given kind,
 * guaranteed to differ from the original so the hash must change. State boxes
 * are never touched here.
 */
function mutateContent(
  model: DocumentModel,
  kind: ContentMutation,
  idx: number,
): DocumentModel {
  const phases = model.phases.map((t) => ({ ...t, after: [...t.after], files: [...t.files] }));
  const preambleLines = [...model.preambleLines];

  switch (kind) {
    case 'preamble':
      // Appending a distinct marker line always changes the preamble text.
      preambleLines.push('changed-overview-marker');
      break;
    case 'title':
      phases[idx].title = phases[idx].title + ' X';
      break;
    case 'id': {
      // Pick an id not already present so the set stays well-defined and the
      // mutated line differs from the original.
      const used = new Set(phases.map((t) => t.id));
      let n = 0;
      const prefix = model.kind === 'plan' ? 'P' : 'T';
      let candidate = prefix + String(n).padStart(2, '0');
      while (used.has(candidate)) {
        n++;
        candidate = prefix + String(n).padStart(2, '0');
      }
      phases[idx].id = candidate;
      break;
    }
    case 'after':
      // Append a fresh id to the hint group; this always alters the phase line.
      phases[idx].after = [...phases[idx].after, (model.kind === 'plan' ? 'P' : 'T') + '99'];
      break;
    case 'files':
      phases[idx].files = [...phases[idx].files, 'extra.ts'];
      break;
    case 'repo-add':
      phases[idx].repo = 'packages/zz';
      break;
    case 'repo-change':
      phases[idx].repo = `${phases[idx].repo}x`;
      break;
    case 'repo-remove':
      delete phases[idx].repo;
      break;
  }

  return { kind: model.kind, preambleLines, phases };
}
