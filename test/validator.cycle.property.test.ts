import * as assert from 'assert';
import * as fc from 'fast-check';
import { DocumentKind, parsePlan, validatePlan, PlanError } from '../src/model';

/**
 * Property tests for dependency-cycle detection in the document validator
 * (Requirement 4).
 *
 * Feature: baiton-first-pass, Property 4: Dependency-cycle detection matches
 * acyclicity
 *
 * For any generated phase dependency graph, the validator SHALL report a cycle
 * error if and only if the graph formed by `after` references is not acyclic,
 * and SHALL identify ids participating in a cycle when one exists
 * (Requirement 4.7).
 *
 * We generate random dependency graphs (phases with `after` edges among
 * themselves), compute acyclicity independently in the test via DFS/topological
 * ordering, and assert the validator's cycle reporting matches. Confounds are
 * excluded from the generated graph: no self-loops, no edges to missing
 * targets, no duplicate ids, all states/ids valid. Those are separate error
 * classes and would muddy the iff we are asserting here.
 * The rendered OVERVIEW/phases/T## documents are explicit legacy-plan fixtures.
 */

/** A distinct id per node index, using the document kind's prefix. */
function nodeId(index: number, kind: DocumentKind): string {
  // Pad to at least two digits and offset so ids stay distinct and valid.
  return (kind === 'plan' ? 'P' : 'T') + String(index).padStart(2, '0');
}

/**
 * A dependency graph: `n` nodes and a set of directed edges `from -> to`
 * expressed as node indices. Edges represent `after` references (the phase at
 * `from` depends on / comes after the phase at `to`). No self-loops are ever
 * generated.
 */
interface Graph {
  n: number;
  edges: Array<[number, number]>;
}

/**
 * Generates a random directed graph over `n` nodes with no self-loops and no
 * duplicate edges. Each ordered distinct pair (i, j) is independently included
 * as an edge with roughly even odds, so both acyclic and cyclic graphs arise
 * frequently across runs.
 */
const graphArb: fc.Arbitrary<Graph> = fc
  .integer({ min: 1, max: 7 })
  .chain((n) => {
    // All ordered off-diagonal pairs are candidate edges.
    const candidates: Array<[number, number]> = [];
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) {
        if (i !== j) {
          candidates.push([i, j]);
        }
      }
    }
    if (candidates.length === 0) {
      return fc.constant<Graph>({ n, edges: [] });
    }
    return fc
      .array(fc.boolean(), {
        minLength: candidates.length,
        maxLength: candidates.length,
      })
      .map<Graph>((mask) => {
        const edges = candidates.filter((_, idx) => mask[idx]);
        return { n, edges };
      });
  });

/**
 * Independent cycle detection: returns the set of node indices that participate
 * in at least one cycle. A node participates in a cycle iff it lies on a
 * non-trivial strongly connected component reachable in the directed graph. We
 * compute this with a straightforward reachability test: node `v` is on a cycle
 * iff `v` can reach itself through at least one edge.
 */
function nodesOnCycles(graph: Graph): Set<number> {
  const adj: number[][] = Array.from({ length: graph.n }, () => []);
  for (const [from, to] of graph.edges) {
    adj[from].push(to);
  }

  const onCycle = new Set<number>();
  for (let start = 0; start < graph.n; start++) {
    // DFS from `start`; if we ever reach `start` again, it is on a cycle.
    const stack = [...adj[start]];
    const visited = new Set<number>();
    let found = false;
    while (stack.length > 0) {
      const node = stack.pop() as number;
      if (node === start) {
        found = true;
        break;
      }
      if (visited.has(node)) {
        continue;
      }
      visited.add(node);
      for (const next of adj[node]) {
        stack.push(next);
      }
    }
    if (found) {
      onCycle.add(start);
    }
  }
  return onCycle;
}

/**
 * Renders a graph into a valid document. Every node becomes a distinct phase
 * with a valid state and id; its `after` group lists the ids it points to. No
 * self-loop or missing target is ever produced, so the ONLY structural issue
 * such a document can carry is a dependency cycle. The legacy branch explicitly
 * retains OVERVIEW/phases/T## as a legacy-plan fixture.
 */
function renderDocument(graph: Graph, kind: DocumentKind): string {
  const lines: string[] = kind === 'plan'
    ? ['## Endstate', '', 'Generated graph.', '', '## What needs changing', 'Change dependencies.', '', '## Limitations & constraints', 'None.', '# PHASES', '']
    : ['# OVERVIEW', '', 'Generated graph.', '', '# TODOS', ''];
  const outgoing: number[][] = Array.from({ length: graph.n }, () => []);
  for (const [from, to] of graph.edges) {
    outgoing[from].push(to);
  }
  for (let i = 0; i < graph.n; i++) {
    const deps = outgoing[i];
    const hint =
      deps.length > 0
        ? ` (after ${deps.map((d) => nodeId(d, kind)).join(', ')})`
        : '';
    lines.push(`- [pending] ${nodeId(i, kind)} node ${i}${hint}`);
  }
  return lines.join('\n');
}

/** Cycle errors are the located errors whose reason names a dependency cycle. */
function cycleErrors(errors: PlanError[]): PlanError[] {
  return errors.filter((e) => e.reason.startsWith('dependency cycle:'));
}

describe('validator dependency-cycle detection (property harness)', () => {
  // Feature: baiton-first-pass, Property 4: Dependency-cycle detection matches
  // acyclicity
  it('reports a cycle error iff the after-graph is cyclic and names participating ids', () => {
    fc.assert(
      fc.property(fc.constantFrom<DocumentKind>('plan', 'legacy-spec'), graphArb, (kind, graph) => {
        const raw = renderDocument(graph, kind);
        const plan = parsePlan(raw);
        assert.strictEqual(plan.kind, kind);

        // Sanity: the generated document carries no confounding errors. Every node
        // parsed into a phase, and there are no missing/self/duplicate/grammar
        // problems, so any error present must be a dependency cycle.
        assert.strictEqual(
          plan.phases.length,
          graph.n,
          `expected ${graph.n} parsed phases for document:\n${raw}`,
        );

        const errors = validatePlan(plan, raw);
        const cycles = cycleErrors(errors);

        // Every non-cycle error would be a confound; there should be none.
        const nonCycle = errors.filter(
          (e) => !e.reason.startsWith('dependency cycle:'),
        );
        assert.deepStrictEqual(
          nonCycle,
          [],
          `unexpected non-cycle errors for document:\n${raw}\n${JSON.stringify(nonCycle)}`,
        );

        const expectedOnCycle = nodesOnCycles(graph);
        const isCyclic = expectedOnCycle.size > 0;

        // iff: a cycle error appears exactly when the graph is cyclic.
        assert.strictEqual(
          cycles.length > 0,
          isCyclic,
          `cycle reporting mismatch (reported ${cycles.length}, cyclic=${isCyclic}) for document:\n${raw}`,
        );

        if (isCyclic) {
          // Collect every id named across all reported cycle reasons.
          const reportedIds = new Set<string>();
          for (const e of cycles) {
            const named = e.reason
              .slice('dependency cycle:'.length)
              .split('->')
              .map((s) => s.trim())
              .filter((s) => s !== '');
            for (const id of named) {
              reportedIds.add(id);
            }
          }

          const expectedIds = new Set(
            [...expectedOnCycle].map((i) => nodeId(i, kind)),
          );

          // Every reported id must genuinely lie on a cycle (no false naming).
          for (const id of reportedIds) {
            assert.ok(
              expectedIds.has(id),
              `validator named ${id} in a cycle but it is not on any cycle for document:\n${raw}`,
            );
          }

          // At least one genuine cycle participant must be named (Req 4.7:
          // display the ids forming the cycle).
          assert.ok(
            reportedIds.size > 0,
            `cyclic graph produced no named cycle ids for document:\n${raw}`,
          );
        }
      }),
      { numRuns: 300 },
    );
  });
});
