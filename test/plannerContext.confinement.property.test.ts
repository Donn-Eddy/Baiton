import * as assert from 'assert';
import * as fc from 'fast-check';
import { buildPlannerContext, PlannerArtifacts } from '../src/engine/plannerContext';
import { parseSpec, ParsedSpec } from '../src/model/parser';
import { TODO_STATES, TodoState } from '../src/model/todoState';

/**
 * Feature: baiton-first-pass, Property 15: Planner context is confined to
 * allowed content
 *
 * For any spec and any planned todo, the planner's brief SHALL contain only the
 * OVERVIEW, that todo's line, and the plans and execution summaries of that
 * todo's `after` targets, and no content from any other todo.
 *
 * Validates: Requirements 18.3
 *
 * `buildPlannerContext` (src/engine/plannerContext.ts) assembles this confined
 * view as a pure function: given a parsed spec, a target todo id, and per-todo
 * plan/exec-summary artifacts, it returns the OVERVIEW, the target todo's line,
 * and — only for the target's `after` targets — those targets' plan and exec
 * summaries. This test generates a spec with several todos wired by `after`
 * edges, gives every todo a plan marker, an exec-summary marker, and a
 * title/line marker that are all unique, builds the context for a randomly
 * chosen target, and asserts:
 *
 *   (a) it CONTAINS the OVERVIEW marker, the target todo's line marker, and the
 *       plan and exec-summary markers of every `after` target; and
 *   (b) it does NOT contain the plan/exec-summary/line markers of any todo that
 *       is neither the target nor one of its `after` targets.
 */

/** The model a generated spec is rendered from and parsed back into. */
interface SpecModel {
  overviewMarker: string;
  todos: TodoModel[];
}

interface TodoModel {
  id: string;
  state: TodoState;
  /** A unique marker embedded in this todo's title (and thus its line). */
  titleMarker: string;
  after: string[];
}

/** Renders a {@link SpecModel} to canonical spec text `parseSpec` consumes. */
function renderSpec(model: SpecModel): string {
  const lines: string[] = [];
  lines.push('---');
  lines.push('title: sample');
  lines.push('---');
  lines.push('# OVERVIEW');
  lines.push('');
  lines.push(`Overview prose ${model.overviewMarker}.`);
  lines.push('');
  lines.push('# TODOS');
  for (const t of model.todos) {
    lines.push(renderTodoLine(t));
  }
  return lines.join('\n');
}

/** Renders one todo line: `- [state] id title` with an optional after group. */
function renderTodoLine(t: TodoModel): string {
  let line = `- [${t.state}] ${t.id} title ${t.titleMarker}`;
  if (t.after.length > 0) {
    line += ` (after ${t.after.join(',')})`;
  }
  return line;
}

// --- Generators ------------------------------------------------------------

/** A todo id: `T` followed by two or more decimal digits (Req 3.3). */
const idArb: fc.Arbitrary<string> = fc
  .integer({ min: 0, max: 999999 })
  .map((n) => 'T' + String(n).padStart(2, '0'));

/**
 * A spec with at least two todos so a target can have both `after` targets and
 * non-`after` todos. Ids are unique; each todo's `after` list is drawn from the
 * other ids in the set (self-edges excluded so the target's own line is not
 * double-counted as an `after` target).
 */
const specModelArb: fc.Arbitrary<SpecModel> = fc
  .uniqueArray(idArb, { minLength: 2, maxLength: 7 })
  .chain((ids) => {
    const todosArb = fc.tuple(
      ...ids.map((id, index) =>
        fc
          .record({
            state: fc.constantFrom<TodoState>(...TODO_STATES),
            after: fc.subarray(ids.filter((other) => other !== id)),
          })
          .map(
            ({ state, after }): TodoModel => ({
              id,
              state,
              // A per-todo unique marker keyed by index; also unique across the
              // overview/plan/exec markers below.
              titleMarker: `LINEMARK-${index}-${id}`,
              after,
            }),
          ),
      ),
    );
    return fc.record({
      overviewMarker: fc.constant('OVERVIEWMARK'),
      todos: todosArb,
    });
  });

/** Per-todo plan/exec-summary markers, guaranteed unique across todos. */
function planMarker(id: string): string {
  return `PLANMARK-${id}`;
}
function execMarker(id: string): string {
  return `EXECMARK-${id}`;
}

/** Build artifacts giving every todo a distinct plan and exec-summary marker. */
function buildArtifacts(model: SpecModel): PlannerArtifacts {
  const plans: Record<string, string> = {};
  const execSummaries: Record<string, string> = {};
  for (const t of model.todos) {
    plans[t.id] = `Plan for ${t.id}: ${planMarker(t.id)}`;
    execSummaries[t.id] = `Exec summary for ${t.id}: ${execMarker(t.id)}`;
  }
  return { plans, execSummaries };
}

// --- Property --------------------------------------------------------------

describe('planner context confinement (property)', () => {
  // Feature: baiton-first-pass, Property 15: Planner context is confined to
  // allowed content
  it('contains only the OVERVIEW, the target line, and after-targets artifacts', () => {
    fc.assert(
      fc.property(
        specModelArb.chain((model) =>
          fc.record({
            model: fc.constant(model),
            targetIdx: fc.nat({ max: model.todos.length - 1 }),
          }),
        ),
        ({ model, targetIdx }) => {
          const spec: ParsedSpec = parseSpec(renderSpec(model));
          const target = model.todos[targetIdx];
          const artifacts = buildArtifacts(model);

          const context = buildPlannerContext(spec, target.id, artifacts);

          const afterSet = new Set(target.after);

          // (a) Allowed content is present.
          assert.ok(
            context.includes(model.overviewMarker),
            'context must contain the OVERVIEW',
          );
          assert.ok(
            context.includes(target.titleMarker),
            `context must contain the target todo line marker ${target.titleMarker}`,
          );
          for (const depId of target.after) {
            // An `after` target may be a dangling id (not in the set); only
            // assert presence for targets that actually have artifacts.
            if (model.todos.some((t) => t.id === depId)) {
              assert.ok(
                context.includes(planMarker(depId)),
                `context must contain plan of after target ${depId}`,
              );
              assert.ok(
                context.includes(execMarker(depId)),
                `context must contain exec summary of after target ${depId}`,
              );
            }
          }

          // (b) No content from any non-target, non-after todo.
          for (const other of model.todos) {
            if (other.id === target.id || afterSet.has(other.id)) {
              continue;
            }
            assert.ok(
              !context.includes(planMarker(other.id)),
              `context must NOT contain plan of unrelated todo ${other.id}`,
            );
            assert.ok(
              !context.includes(execMarker(other.id)),
              `context must NOT contain exec summary of unrelated todo ${other.id}`,
            );
            assert.ok(
              !context.includes(other.titleMarker),
              `context must NOT contain line marker of unrelated todo ${other.id}`,
            );
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});
