/**
 * Host-free tree model for the Plan Explorer.
 *
 * It parses and validates plan.md and legacy spec.md documents with the shared
 * model cores, then groups plans as Active, Pending, or Completed and creates
 * phase or validation-error children in file order.
 */
import { DocumentKind, parsePlan, Phase } from './parser';
import { validatePlan } from './validator';
import { isBlocked } from './hash';
import { PhaseState } from './phaseState';
import { legalActions, PhaseAction } from './phaseActions';
import { legalPlanActions, PlanAction } from './planActions';

export type PlanStatus = { kind: 'set'; value: string } | { kind: 'unset' };

export type PlanGroupKind = 'active' | 'pending' | 'completed';
export const PLAN_GROUP_KINDS: readonly PlanGroupKind[] = ['active', 'pending', 'completed'] as const;

export interface PlanGroupNode {
  kind: PlanGroupKind;
  label: string;
  contextValue: string;
  plans: PlanNode[];
}

export interface PlanGroupFacts {
  status: PlanStatus;
  approved: boolean;
  phaseStates: readonly PhaseState[];
}

/** Completed when status is `done`; otherwise active when approved or any phase is past `pending`. */
export function planGroupKind(facts: PlanGroupFacts): PlanGroupKind {
  if (facts.status.kind === 'set' && facts.status.value === 'done') return 'completed';
  if (facts.approved || facts.phaseStates.some((state) => state !== 'pending')) return 'active';
  return 'pending';
}

export interface PhaseNode {
  slug: string;
  id: string;
  title: string;
  state: PhaseState;
  blocked: boolean;
  hasSession: boolean;
  hasPlan: boolean;
  actions: PhaseAction[];
}

export interface ErrorNode {
  slug: string;
  reason: string;
  line: number;
}

export interface PlanNode {
  slug: string;
  kind: DocumentKind;
  status: PlanStatus;
  approved: boolean;
  /** Which top-level group the plan lands in; equals planGroupKind over this node's facts. */
  group: PlanGroupKind;
  /** The states of every parsed phase line in file order; present even when invalid, empty when unreadable. */
  phaseStates: PhaseState[];
  invalid: boolean;
  prUrl?: string;
  actions: PlanAction[];
  children:
    | { kind: 'errors'; errors: ErrorNode[] }
    | { kind: 'phases'; phases: PhaseNode[] };
}

/** Input for one plan document and the facts supplied by its store and journal. */
export interface PlanInput {
  slug: string;
  raw?: string;
  readError?: string;
  approved: boolean;
  /** Phase ids with a recorded Session_Id, from the document's journal. */
  sessions: ReadonlySet<string>;
  /** Phase ids with `phases/<id>/plan.md` on file (legacy `todos/<id>/plan.md`). */
  plans: ReadonlySet<string>;
  kind?: DocumentKind;
}

/** Build ordered Plan Explorer nodes from listed inputs. */
export function buildPlanTree(inputs: PlanInput[]): PlanNode[] {
  return inputs.map(buildPlanNode);
}

const PLAN_GROUP_LABELS: Record<PlanGroupKind, string> = {
  active: 'Active',
  pending: 'Pending',
  completed: 'Completed',
};

/** Split plan nodes into exactly three groups, Active, Pending, Completed, all always present; input order is kept inside each group. */
export function buildPlanGroups(nodes: readonly PlanNode[]): PlanGroupNode[] {
  return PLAN_GROUP_KINDS.map((kind) => ({
    kind,
    label: PLAN_GROUP_LABELS[kind],
    contextValue: `baiton.planGroup.${kind}`,
    plans: nodes.filter((node) => node.group === kind),
  }));
}

function buildPlanNode(input: PlanInput): PlanNode {
  if (input.readError !== undefined || input.raw === undefined) {
    const kind = input.kind ?? 'plan';
    return {
      slug: input.slug,
      kind,
      status: { kind: 'unset' },
      approved: input.approved,
      group: planGroupKind({ status: { kind: 'unset' }, approved: input.approved, phaseStates: [] }),
      phaseStates: [],
      invalid: true,
      actions: [],
      children: {
        kind: 'errors',
        errors: [{
          slug: input.slug,
          reason: input.readError ?? (kind === 'legacy-spec' ? 'spec.md could not be read' : 'plan.md could not be read'),
          line: 1,
        }],
      },
    };
  }

  const parsed = parsePlan(input.raw, input.kind);
  const status = deriveStatus(parsed.frontmatter.get('status'));
  const phaseStates = parsed.phases.map((phase) => phase.state);
  const prUrl = derivePrUrl(parsed.frontmatter.get('pr'));
  const errors = validatePlan(parsed, input.raw);
  if (errors.length > 0) {
    return {
      slug: input.slug,
      kind: parsed.kind,
      status,
      approved: input.approved,
      group: planGroupKind({ status, approved: input.approved, phaseStates }),
      phaseStates,
      invalid: true,
      prUrl,
      actions: [],
      children: {
        kind: 'errors',
        errors: errors.map((error) => ({
          slug: input.slug,
          reason: error.reason,
          line: error.line,
        })),
      },
    };
  }

  const phases = parsed.phases.map((phase) =>
    buildPhaseNode(input.slug, phase, parsed.phases, input.sessions, input.plans),
  );
  return {
    slug: input.slug,
    kind: parsed.kind,
    status,
    approved: input.approved,
    group: planGroupKind({ status, approved: input.approved, phaseStates }),
    phaseStates,
    invalid: false,
    prUrl,
    actions: legalPlanActions({
      approved: input.approved,
      invalid: false,
      prUrl,
      phaseStates,
    }),
    children: { kind: 'phases', phases },
  };
}

function buildPhaseNode(
  slug: string,
  phase: Phase,
  all: Phase[],
  sessions: ReadonlySet<string>,
  plans: ReadonlySet<string>,
): PhaseNode {
  const hasSession = sessions.has(phase.id);
  const hasPlan = plans.has(phase.id);
  return {
    slug,
    id: phase.id,
    title: phase.title,
    state: phase.state,
    blocked: isBlocked(phase, all),
    hasSession,
    hasPlan,
    actions: legalActions(phase.state, hasSession, hasPlan),
  };
}

function deriveStatus(rawStatus: string | undefined): PlanStatus {
  if (rawStatus === undefined) return { kind: 'unset' };
  const trimmed = rawStatus.trim();
  return trimmed === '' ? { kind: 'unset' } : { kind: 'set', value: trimmed };
}

function derivePrUrl(rawPr: string | undefined): string | undefined {
  if (rawPr === undefined) return undefined;
  const trimmed = rawPr.trim();
  return trimmed === '' ? undefined : trimmed;
}
