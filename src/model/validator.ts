/** Pure validator for plan.md and the legacy spec.md document format. */
import {
  DocumentKind,
  ParsedPlan,
  Phase,
  phaseIdPattern,
  phaseIdPrefix,
  trailingHintIdsOfOtherKind,
} from './parser';
import { PHASE_STATES, isPhaseState } from './phaseState';

/** One located validation problem. */
export interface PlanError {
  line: number;
  text: string;
  reason: string;
}

const PHASE_PREFIX = /^- \[([^\]]*)\]\s+(.*)$/;
const CONFLICT_MARKERS = ['<<<<<<<', '=======', '>>>>>>>'];

/** Validate a parsed plan against its raw text. Never mutates and never throws. */
export function validatePlan(plan: ParsedPlan, raw: string): PlanError[] {
  const rawLines = raw.split('\n');
  const errors: PlanError[] = [];
  errors.push(...findConflictMarkers(rawLines));
  errors.push(...findGrammarErrors(plan, rawLines));
  errors.push(...findDuplicateIds(plan.phases));
  errors.push(...findDependencyErrors(plan.phases, plan.kind));
  errors.push(...findForeignHintErrors(plan));
  errors.push(...findCycleErrors(plan.phases));
  return errors;
}

function findConflictMarkers(rawLines: string[]): PlanError[] {
  const errors: PlanError[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const marker = CONFLICT_MARKERS.find((m) => rawLines[i].startsWith(m));
    if (marker) errors.push({ line: i + 1, text: rawLines[i], reason: 'merge-conflict marker "' + marker + '" found' });
  }
  return errors;
}

function findGrammarErrors(plan: ParsedPlan, rawLines: string[]): PlanError[] {
  const parsedLines = new Set(plan.phases.map((phase) => phase.lineIndex));
  const phasesStart = findPhasesStart(rawLines, plan.kind);
  if (phasesStart === -1) return [];
  const errors: PlanError[] = [];
  for (let i = phasesStart; i < rawLines.length; i++) {
    const line = rawLines[i];
    if (!line.startsWith('- [') || parsedLines.has(i)) continue;
    errors.push({ line: i + 1, text: line, reason: grammarFailureReason(line, plan.kind) });
  }
  return errors;
}

function grammarFailureReason(line: string, kind: DocumentKind): string {
  const noun = itemNoun(kind);
  const m = PHASE_PREFIX.exec(line);
  const generic = 'malformed ' + noun + ' line: expected "- [<state>] <id> <title>"';
  if (!m) return generic;
  const stateText = m[1].trim();
  if (!isPhaseState(stateText)) {
    return 'unknown state "' + stateText + '"; expected one of ' + PHASE_STATES.join(', ');
  }
  const rest = m[2];
  const spaceIdx = rest.search(/\s/);
  const id = spaceIdx === -1 ? rest : rest.slice(0, spaceIdx);
  if (!phaseIdPattern(kind).test(id)) {
    const wrongKind = /^[PT]\d{2,}$/.test(id)
      ? ' (' + (kind === 'plan' ? 'T## ids belong to legacy spec documents' : 'P## ids belong to plan documents') + ')'
      : '';
    return 'malformed id "' + id + '"; expected "' + phaseIdPrefix(kind) + '" followed by two or more digits' + wrongKind;
  }
  return generic;
}

function findDuplicateIds(phases: Phase[]): PlanError[] {
  const errors: PlanError[] = [];
  const seen = new Set<string>();
  for (const phase of phases) {
    if (seen.has(phase.id)) {
      errors.push({ line: phase.lineIndex + 1, text: renderPhaseRef(phase), reason: 'duplicate id "' + phase.id + '"' });
    } else {
      seen.add(phase.id);
    }
  }
  return errors;
}

function findDependencyErrors(phases: Phase[], kind: DocumentKind): PlanError[] {
  const errors: PlanError[] = [];
  const knownIds = new Set(phases.map((phase) => phase.id));
  const noun = itemNoun(kind);
  for (const phase of phases) {
    for (const dep of phase.after) {
      if (dep === phase.id) {
        errors.push({
          line: phase.lineIndex + 1,
          text: renderPhaseRef(phase),
          reason: noun + ' "' + phase.id + '" lists itself in its "after" dependencies',
        });
      } else if (!knownIds.has(dep)) {
        errors.push({
          line: phase.lineIndex + 1,
          text: renderPhaseRef(phase),
          reason: noun + ' "' + phase.id + '" depends on unknown id "' + dep + '"',
        });
      }
    }
  }
  return errors;
}

function findCycleErrors(phases: Phase[]): PlanError[] {
  const byId = new Map<string, Phase>();
  for (const phase of phases) if (!byId.has(phase.id)) byId.set(phase.id, phase);
  const adjacency = new Map<string, string[]>();
  for (const phase of byId.values()) {
    adjacency.set(phase.id, phase.after.filter((dep) => dep !== phase.id && byId.has(dep)));
  }
  return findCycles(adjacency).map((cycle) => {
    const start = byId.get(cycle[0]);
    return {
      line: start ? start.lineIndex + 1 : 1,
      text: start ? renderPhaseRef(start) : cycle.join(' -> '),
      reason: 'dependency cycle: ' + cycle.join(' -> '),
    };
  });
}

function findForeignHintErrors(plan: ParsedPlan): PlanError[] {
  const errors: PlanError[] = [];
  for (const phase of plan.phases) {
    const ids = trailingHintIdsOfOtherKind(phase.title, plan.kind);
    if (ids) {
      errors.push({
        line: phase.lineIndex + 1,
        text: renderPhaseRef(phase),
        reason: 'after hint uses ids of the wrong kind (' + ids.join(', ') + '); expected "' + phaseIdPrefix(plan.kind) + '" ids',
      });
    }
  }
  return errors;
}

function findCycles(adjacency: Map<string, string[]>): string[][] {
  const cycles: string[][] = [];
  const reported = new Set<string>();
  const WHITE = 0;
  const GRAY = 1;
  const BLACK = 2;
  const color = new Map<string, number>();
  for (const id of adjacency.keys()) color.set(id, WHITE);
  const stack: string[] = [];
  const visit = (node: string): void => {
    color.set(node, GRAY);
    stack.push(node);
    for (const next of adjacency.get(node) ?? []) {
      const nextColor = color.get(next) ?? WHITE;
      if (nextColor === GRAY) {
        const idx = stack.indexOf(next);
        if (idx !== -1) {
          const cycle = stack.slice(idx);
          const key = [...cycle].sort().join('\u0000');
          if (!reported.has(key)) {
            reported.add(key);
            cycles.push(cycle);
          }
        }
      } else if (nextColor === WHITE) visit(next);
    }
    stack.pop();
    color.set(node, BLACK);
  };
  for (const id of adjacency.keys()) if ((color.get(id) ?? WHITE) === WHITE) visit(id);
  return cycles;
}

function findPhasesStart(rawLines: string[], kind: DocumentKind): number {
  // Legacy spec.md format keeps the item section named TODOS.
  const header = kind === 'plan' ? 'PHASES' : 'TODOS';
  for (let i = 0; i < rawLines.length; i++) {
    const m = /^#+\s+(.*)$/.exec(rawLines[i]);
    if (m && m[1].trim() === header) return i + 1;
  }
  return -1;
}

function renderPhaseRef(phase: Phase): string {
  return ('- [' + phase.state + '] ' + phase.id + ' ' + phase.title).trimEnd();
}

function itemNoun(kind: DocumentKind): 'phase' | 'todo' {
  // Legacy spec.md format keeps the user-facing "todo" wording byte-identical.
  return kind === 'plan' ? 'phase' : 'todo';
}
