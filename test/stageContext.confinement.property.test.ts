import * as assert from 'assert';
import * as fc from 'fast-check';
import { buildStageContext } from '../src/engine/stageContext';
import { parseSpec, ParsedSpec } from '../src/model/parser';
import { TODO_STATES, TodoState } from '../src/model/todoState';

/**
 * Feature: baiton-first-pass, Property 15: Planner context is confined to
 * allowed content
 *
 * For any spec and any planned todo, the planner's brief SHALL contain only the
 * OVERVIEW, that todo's line, and the execution summaries of that todo's
 * `after` targets, and no content from any other todo.
 *
 * Validates: Requirements 18.3
 *
 * `buildStageContext` (src/engine/stageContext.ts) assembles this confined view
 * as a pure function. The plan-stage contract is deliberately narrower than the
 * planner context it replaced: an `after` target contributes what it DID (its
 * latest execution summary), never what it intended (its plan), so the planner
 * is briefed on the state of the code rather than on other todos' plans.
 *
 * This test generates a spec with several todos wired by `after` edges, gives
 * every todo a plan marker, an exec-summary marker, and a title/line marker
 * that are all unique, builds the plan context for a randomly chosen target,
 * and asserts:
 *
 *   (a) it CONTAINS the OVERVIEW marker, the target todo's line marker, and the
 *       exec-summary marker of every `after` target;
 *   (b) it does NOT contain the plan marker of ANY todo, including its `after`
 *       targets — the narrowed contract; and
 *   (c) it does NOT contain the exec-summary/line markers of any todo that is
 *       neither the target nor one of its `after` targets.
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

/**
 * Per-todo plan/exec-summary markers. The trailing `-END` matters: without it
 * the marker of `T18` would be a prefix of the marker of `T182237`, and a
 * "must not contain" assertion would fire on a legitimately included marker.
 */
function planMarker(id: string): string {
  return `PLANMARK-${id}-END`;
}
function execMarker(id: string): string {
  return `EXECMARK-${id}-END`;
}

/**
 * Execution summaries for every todo, each carrying a distinct marker. Plan
 * markers are deliberately never offered to the builder: the plan stage has no
 * input that could carry them, which is half of what makes the context narrow.
 */
function buildAfterExecutes(model: SpecModel): Record<string, string> {
  const execSummaries: Record<string, string> = {};
  for (const t of model.todos) {
    execSummaries[t.id] = `Exec summary for ${t.id}: ${execMarker(t.id)}`;
  }
  return execSummaries;
}

// --- Property --------------------------------------------------------------

describe('plan stage context confinement (property)', () => {
  // Feature: baiton-first-pass, Property 15: Planner context is confined to
  // allowed content
  it('contains only the OVERVIEW, the target line, and after-targets execution summaries', () => {
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

          const context = buildStageContext({
            stage: 'plan',
            spec,
            todoId: target.id,
            afterExecutes: buildAfterExecutes(model),
          });

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
                context.includes(execMarker(depId)),
                `context must contain exec summary of after target ${depId}`,
              );
            }
          }

          // (b) No plan of any todo, its `after` targets included: the planner
          // is briefed on what was done, never on another todo's plan.
          for (const other of model.todos) {
            assert.ok(
              !context.includes(planMarker(other.id)),
              `context must NOT contain the plan of ${other.id}`,
            );
          }

          // (c) No content from any non-target, non-after todo.
          for (const other of model.todos) {
            if (other.id === target.id || afterSet.has(other.id)) {
              continue;
            }
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
