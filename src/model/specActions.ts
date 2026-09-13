/**
 * Legal actions for a spec root, derived from the facts the tree model already
 * carries (Requirement 4: only legal actions are shown).
 *
 * `legalSpecActions` is the single host-free function the Spec_Explorer tree
 * consults for a spec root's buttons, so the tree and the `view/item/context`
 * `when` clauses cannot disagree about which of Approve / Submit PR / Show PR a
 * root offers. It mirrors `legalActions` for todos: the rules live here once and
 * are never re-implemented in the `vscode` glue.
 *
 * The Submit PR rule mirrors the engine's `checkReady` gate in
 * `src/engine/submitPr.ts` (approved, at least one todo, every todo `done`) so
 * the button is absent precisely when a click would only produce a refusal; the
 * gate itself stays in the engine and is not duplicated here beyond this
 * visibility decision.
 *
 * This module carries no `vscode` import so it is directly unit- and
 * property-testable without a VS Code host.
 */
import { TodoState } from './todoState';

/**
 * A user-facing action for a spec root: `approve` runs the approve/re-approve
 * control tool, `submitPr` opens the pull request, and `showPr` opens the URL
 * already recorded in the spec's frontmatter `pr` key.
 */
export type SpecAction = 'approve' | 'submitPr' | 'showPr';

/** The derived facts a spec root's legal actions are computed from. */
export interface SpecActionInput {
  /** The approval fact from the `SpecStore`; a stale approval reads as false. */
  approved: boolean;
  /** True when the spec is invalid or could not be read/parsed. */
  invalid: boolean;
  /** The trimmed frontmatter `pr` URL; undefined when the key is absent or empty. */
  prUrl: string | undefined;
  /** The lifecycle state of each todo, in file order. */
  todoStates: readonly TodoState[];
}

/**
 * The legal actions for a spec root. Rules, in order:
 *
 *   - an invalid or unreadable spec offers nothing (its root keeps the
 *     `baiton.specError` context value);
 *   - once a PR has been recorded (`prUrl` set, which `submitPr` writes together
 *     with `status: pr`), the root offers only `showPr`, regardless of later
 *     edits to the approval or the todo states;
 *   - otherwise `approve` is legal while the spec is not (currently) approved,
 *     and `submitPr` is legal when it is approved, has at least one todo, and
 *     every todo is `done`.
 *
 * Order is deterministic: approve, submitPr, showPr.
 */
export function legalSpecActions(input: SpecActionInput): SpecAction[] {
  if (input.invalid) {
    return [];
  }
  if (input.prUrl !== undefined) {
    return ['showPr'];
  }
  const actions: SpecAction[] = [];
  if (!input.approved) {
    actions.push('approve');
  }
  if (
    input.approved &&
    input.todoStates.length > 0 &&
    input.todoStates.every((state) => state === 'done')
  ) {
    actions.push('submitPr');
  }
  return actions;
}

/**
 * Builds the tree item `contextValue` for a spec root: `baiton.spec` followed by
 * one space-separated token per legal action, e.g. `baiton.spec approve`. The
 * `view/item/context` `when` clauses in `package.json` match on these tokens via
 * `\b<action>\b` regexes, exactly as they do for todos.
 */
export function specContextValue(actions: SpecAction[]): string {
  return 'baiton.spec' + actions.map((a) => ' ' + a).join('');
}
