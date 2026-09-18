/**
 * Host-free tree model for the Spec_Explorer (Requirements 2, 3, 4, 6.6).
 *
 * `buildSpecTree` turns the raw `spec.md` contents listed off disk — plus each
 * spec's approval fact supplied by the `SpecStore` — into the ordered
 * `SpecNode`s the tree provider renders. It reuses the `src/model/` cores
 * (`parseSpec`, `validateSpec`, `isBlocked`) and NEVER re-implements them
 * (Req 18.1): a valid spec yields todo children in file order with a derived
 * `blocked` flag; an invalid spec yields validation-error children (reason plus
 * 1-based line) and no todo children; a read/parse failure yields an invalid
 * spec node with a single error child describing the failure (Req 6.6). The
 * `approved` fact is taken from the input and never recomputed here, and the
 * `status` and the recorded PR URL are derived from the trimmed frontmatter
 * `status` and `pr` keys. Each spec root also carries its legal actions, from
 * the host-free `legalSpecActions`, exactly as each todo carries `legalActions`.
 *
 * This module carries no `vscode` import so it is directly unit- and
 * property-testable without a VS Code host. Property 3 lives here.
 */
import { parseSpec, Todo } from './parser';
import { validateSpec } from './validator';
import { isBlocked } from './hash';
import { TodoState } from './todoState';
import { legalActions, TodoAction } from './todoActions';
import { legalSpecActions, SpecAction } from './specActions';

/**
 * A spec's frontmatter `status`: either a present, non-empty (after trimming)
 * value, or an explicit unset indication when the key is absent or empty
 * (Req 2.2, 2.3).
 */
export type SpecStatus = { kind: 'set'; value: string } | { kind: 'unset' };

/** One todo child node under a valid spec's root (Req 4.1, 4.2, 4.3). */
export interface TodoNode {
  /** The slug of the todo's spec. */
  slug: string;
  /** The todo id (`T` followed by two or more digits). */
  id: string;
  /** The todo title. */
  title: string;
  /** The todo lifecycle state. */
  state: TodoState;
  /** Derived blocked flag; equals `isBlocked(todo, all)` (Req 4.3, 4.4, 4.5). */
  blocked: boolean;
  /** Whether the journal records a Session_Id for this todo (Req 4.4). */
  hasSession: boolean;
  /** Whether the todo's plan (`todos/<id>/plan.md`) is on file. */
  hasPlan: boolean;
  /**
   * The legal actions for this todo; equals
   * `legalActions(state, hasSession, hasPlan)` (Req 4.3, 4.4).
   */
  actions: TodoAction[];
}

/**
 * One error child node under an invalid or unreadable spec's root: a validation
 * error (Req 3.2, 3.3) or a read/parse failure (Req 6.6).
 */
export interface ErrorNode {
  /** The slug of the error's spec. */
  slug: string;
  /** Human-readable reason for the error. */
  reason: string;
  /** 1-based line number of the offending line. */
  line: number;
}

/** A spec root node with its derived status, approval, validity and children. */
export interface SpecNode {
  /** The spec's slug. */
  slug: string;
  /** The trimmed frontmatter `status`, or an unset indication (Req 2.2, 2.3). */
  status: SpecStatus;
  /** The approval fact from the `SpecStore`; never recomputed here (Req 2.4). */
  approved: boolean;
  /** True when the spec is invalid or could not be read/parsed (Req 3.1, 6.6). */
  invalid: boolean;
  /**
   * The trimmed frontmatter `pr` URL recorded by a completed Submit PR run;
   * undefined when the key is absent or empty.
   */
  prUrl?: string;
  /**
   * The legal actions for this spec root; equals `legalSpecActions({...})` over
   * the node's own derived facts, and `[]` for an invalid or unreadable spec.
   */
  actions: SpecAction[];
  /**
   * Either the validation/read-failure error children (invalid spec: no todo
   * children, Req 3.4) or the todo children in file order (valid spec, Req 4.1).
   */
  children:
    | { kind: 'errors'; errors: ErrorNode[] }
    | { kind: 'todos'; todos: TodoNode[] };
}

/**
 * Input for one spec: the raw `spec.md` text (or a read failure) from the
 * lister, plus the spec's approval fact from the `SpecStore`.
 */
export interface SpecInput {
  /** The spec's slug. */
  slug: string;
  /** The raw `spec.md` contents; undefined when the file could not be read. */
  raw?: string;
  /** Why the file could not be read/parsed, when applicable (Req 6.6). */
  readError?: string;
  /** The approval fact supplied by the `SpecStore` (Req 2.4). */
  approved: boolean;
  /** Todo ids with a recorded Session_Id, from the spec's journal (Req 4.4). */
  sessions: ReadonlySet<string>;
  /** Todo ids whose plan is on file at `todos/<id>/plan.md` in the spec folder. */
  plans: ReadonlySet<string>;
}

/**
 * Builds the ordered spec nodes from the listed inputs (Req 2, 3, 4, 6.6). The
 * returned nodes preserve the order of `inputs`; the lister is responsible for
 * ascending-slug ordering. Never throws.
 */
export function buildSpecTree(inputs: SpecInput[]): SpecNode[] {
  return inputs.map(buildSpecNode);
}

/** Builds a single spec node from its input. */
function buildSpecNode(input: SpecInput): SpecNode {
  // A read/parse failure yields an invalid node with a single error child
  // describing the failure and no todo children (Req 6.6).
  if (input.readError !== undefined || input.raw === undefined) {
    return {
      slug: input.slug,
      status: { kind: 'unset' },
      approved: input.approved,
      invalid: true,
      // An unreadable spec has no frontmatter to read a PR URL from and offers
      // no actions; its root keeps the error context value.
      actions: [],
      children: {
        kind: 'errors',
        errors: [
          {
            slug: input.slug,
            reason: input.readError ?? 'spec.md could not be read',
            line: 1,
          },
        ],
      },
    };
  }

  const parsed = parseSpec(input.raw);
  const status = deriveStatus(parsed.frontmatter.get('status'));
  const prUrl = derivePrUrl(parsed.frontmatter.get('pr'));
  const errors = validateSpec(parsed, input.raw);

  // An invalid spec yields error children (reason + 1-based line) in the order
  // the validator returns them, and no todo children (Req 3.1, 3.2, 3.3, 3.4).
  if (errors.length > 0) {
    return {
      slug: input.slug,
      status,
      approved: input.approved,
      invalid: true,
      prUrl,
      // An invalid spec offers no actions; its root keeps the error context
      // value (Req 3.1).
      actions: [],
      children: {
        kind: 'errors',
        errors: errors.map((e) => ({
          slug: input.slug,
          reason: e.reason,
          line: e.line,
        })),
      },
    };
  }

  // A valid spec yields todo children in file order, each carrying its derived
  // blocked flag (Req 4.1, 4.2, 4.3, 4.4, 4.5).
  const todos = parsed.todos.map((todo) =>
    buildTodoNode(input.slug, todo, parsed.todos, input.sessions, input.plans),
  );
  return {
    slug: input.slug,
    status,
    approved: input.approved,
    invalid: false,
    prUrl,
    actions: legalSpecActions({
      approved: input.approved,
      invalid: false,
      prUrl,
      todoStates: todos.map((t) => t.state),
    }),
    children: { kind: 'todos', todos },
  };
}

/** Builds a todo node, deriving its blocked flag and legal actions via the reused cores. */
function buildTodoNode(
  slug: string,
  todo: Todo,
  all: Todo[],
  sessions: ReadonlySet<string>,
  plans: ReadonlySet<string>,
): TodoNode {
  const hasSession = sessions.has(todo.id);
  const hasPlan = plans.has(todo.id);
  return {
    slug,
    id: todo.id,
    title: todo.title,
    state: todo.state,
    blocked: isBlocked(todo, all),
    hasSession,
    hasPlan,
    actions: legalActions(todo.state, hasSession, hasPlan),
  };
}

/**
 * Derives the `SpecStatus` from the frontmatter `status` value: a set status
 * when present and non-empty after trimming, otherwise unset (Req 2.2, 2.3).
 */
function deriveStatus(rawStatus: string | undefined): SpecStatus {
  if (rawStatus === undefined) {
    return { kind: 'unset' };
  }
  const trimmed = rawStatus.trim();
  return trimmed === '' ? { kind: 'unset' } : { kind: 'set', value: trimmed };
}

/**
 * Derives the recorded PR URL from the frontmatter `pr` value: the trimmed
 * value when present and non-empty, otherwise undefined — the same treatment
 * {@link deriveStatus} gives `status`.
 */
function derivePrUrl(rawPr: string | undefined): string | undefined {
  if (rawPr === undefined) {
    return undefined;
  }
  const trimmed = rawPr.trim();
  return trimmed === '' ? undefined : trimmed;
}
