/**
 * The per-mode Brief context assembler for spec-less runs (`bug`, `quick`,
 * `refactor`, `investigate`).
 *
 * A spec-less run has no OVERVIEW and no todo line, so the context is built
 * from the run manifest instead: the statement, the files the run starts from,
 * its branch, and the artifacts of the stages that came before. Which sections
 * a stage emits:
 *
 *   - plan        — `# Run`, then the mode framing.
 *   - execute     — `# Run`, the mode framing, `# Plan`, and — from the second
 *                   attempt on, or when resuming — `# Latest review`.
 *   - review      — `# Run`, the mode framing, `# Plan`, `# Execution`, and
 *                   `# Execute commit` so the reviewer inspects that commit
 *                   with git instead of reading the tree.
 *   - investigate — `# Run`, `# Question` and `# Files`. No plan, no execution,
 *                   no commit, no mode framing: the run is read-only and ends
 *                   in a finding.
 *
 * The mode framing is `# Defect` + `# Reproduction` for `bug`, a
 * `# Behaviour preservation` section naming the verify command for `refactor`,
 * and nothing for `quick` (its statement and files are already in `# Run`).
 *
 * This module never reads or names anything under `.baiton/specs/`: a spec-less
 * run has no spec to read.
 *
 * Pure: every artifact is passed in by the caller, so it performs no `fs` or
 * `vscode` access. Both imports are type-only and erased at compile time, which
 * is what keeps `runStore`'s `fs` imports out of this module — keep the
 * `import type` form.
 */
import type { RunMode } from '../model/mode';
import type { RunStage } from './runStore';

/**
 * Everything {@link buildRunContext} may draw on. Which fields are consulted is
 * decided by `stage` and `mode`; a field neither consults is ignored, which is
 * what keeps each stage's context minimal.
 */
export interface RunContextInput {
  /** The stage whose context is being assembled; selects the sections. */
  stage: RunStage;
  /** The run's mode; never 'spec'. Selects the mode framing sections. */
  mode: RunMode;
  /** The one-line statement of the work (for investigate: the question). */
  statement: string;
  /** The files the run starts from, repository-relative. */
  files?: readonly string[];
  /** Bug only: reproduction steps, when the user supplied them. */
  reproduction?: string;
  /** The run's own branch (`baiton/<mode>/<run-id>`); absent for investigate. */
  branch?: string;
  /** Refactor only: the configured `git.verify` command that must stay green. */
  verify?: string;
  /** The run's plan artifact text (`execute`, `review`). */
  plan?: string;
  /** `execute`: the latest review artifact text, included from attempt 2 on. */
  latestReview?: string;
  /** `review`: the latest execution-summary artifact text. */
  latestExecute?: string;
  /** `review`: the commit the execution landed in, when it is known. */
  executeCommit?: string;
  /** `execute`: the 1-based attempt index; attempt >= 2 carries the review. */
  attempt?: number;
  /** `execute`: true when the run resumes a prior executor session. */
  resume?: boolean;
}

/**
 * Assemble the Brief context for one spec-less run stage as Markdown. Pure; the
 * caller supplies every artifact. Sections are emitted in a fixed order per
 * stage and artifacts are embedded verbatim — they are the source of truth
 * downstream and are never parsed back.
 */
export function buildRunContext(input: RunContextInput): string {
  switch (input.stage) {
    case 'plan':
      return join(planSections(input));
    case 'execute':
      return join(executeSections(input));
    case 'review':
      return join(reviewSections(input));
    case 'investigate':
      return join(investigateSections(input));
    default:
      return assertNever(input.stage);
  }
}

/**
 * The `# Run` section every stage opens with: the mode, the statement, the
 * branch the work lands on (or, for a read-only investigate, a note that there
 * is none), and the files the run starts from.
 */
function runSection(input: RunContextInput): string {
  const lines = [`- Mode: ${input.mode}`, `- Statement: ${input.statement.trim()}`];

  const branch = input.branch?.trim();
  if (input.stage === 'investigate') {
    lines.push('- No branch: this run is read-only and makes no commits.');
  } else if (branch !== undefined && branch !== '') {
    lines.push(`- Target branch: \`${branch}\``);
  }

  const files = input.files ?? [];
  if (files.length === 0) {
    lines.push('- Files: none named.');
  } else {
    lines.push('- Files:');
    for (const file of files) {
      lines.push(`  - \`${file}\``);
    }
  }

  return `# Run\n\n${lines.join('\n')}`;
}

/**
 * The mode framing, placed directly after `# Run` for the `plan`, `execute` and
 * `review` stages. Investigate never gets it, and `quick` deliberately emits
 * nothing: its statement and files are already carried by `# Run`.
 */
function modeSections(input: RunContextInput): string[] {
  if (input.stage === 'investigate') {
    return [];
  }
  switch (input.mode) {
    case 'bug':
      return [defectSection(input), reproductionSection(input)];
    case 'refactor':
      return [behaviourPreservationSection(input)];
    default:
      // 'quick', 'investigate', 'spec' — and any mode added later, which emits
      // no framing rather than breaking the build here.
      return [];
  }
}

/** Bug: the reported defect, and the instruction to fix the root cause. */
function defectSection(input: RunContextInput): string {
  return (
    '# Defect\n\n' +
    `The reported defect is: ${input.statement.trim()}\n\n` +
    'Find and fix the root cause, not the symptom.'
  );
}

/** Bug: the reproduction steps the user supplied, or how to establish them. */
function reproductionSection(input: RunContextInput): string {
  const reproduction = input.reproduction?.trim();
  return reproduction !== undefined && reproduction !== ''
    ? `# Reproduction\n\n${reproduction}`
    : '# Reproduction\n\nNo reproduction steps were supplied. Establish how to ' +
        'reproduce the defect from the statement and the files above before ' +
        'changing anything.';
}

/** Refactor: the behaviour must not change, and the checks must stay green. */
function behaviourPreservationSection(input: RunContextInput): string {
  const verify = input.verify?.trim();
  const check =
    verify !== undefined && verify !== ''
      ? `Run \`${verify}\` and keep it green.`
      : 'No verify command is configured; run the repository\'s own tests and ' +
        'checks and keep them green.';
  return (
    '# Behaviour preservation\n\n' +
    'The observable behaviour of this code must not change: no behaviour, API ' +
    'or output differences, only a better internal shape.\n\n' +
    check
  );
}

/** The run's plan, delimited so the role can see exactly where it ends. */
function planSection(input: RunContextInput): string {
  const plan = input.plan?.trim();
  return plan !== undefined && plan !== ''
    ? `# Plan\n\n${plan}`
    : '# Plan\n\nNo plan is on file for this run.';
}

/** Plan: the run framing and the mode framing; there is nothing else yet. */
function planSections(input: RunContextInput): string[] {
  return [runSection(input), ...modeSections(input)];
}

/**
 * Execute: the run framing, the mode framing and the plan. A retry
 * (attempt >= 2) or a resumed session also carries the latest review so the
 * executor knows what it has to fix.
 */
function executeSections(input: RunContextInput): string[] {
  const sections = [runSection(input), ...modeSections(input), planSection(input)];
  const retry = (input.attempt ?? 1) >= 2 || input.resume === true;
  if (retry && input.latestReview !== undefined && input.latestReview.trim() !== '') {
    sections.push(`# Latest review\n\n${input.latestReview.trim()}`);
  }
  return sections;
}

/**
 * Review: the run framing, the mode framing, the plan, the execution summary,
 * and the commit the execution landed in so the reviewer reads that commit
 * rather than the tree.
 */
function reviewSections(input: RunContextInput): string[] {
  const sections = [runSection(input), ...modeSections(input), planSection(input)];
  sections.push(
    input.latestExecute !== undefined && input.latestExecute.trim() !== ''
      ? `# Execution\n\n${input.latestExecute.trim()}`
      : '# Execution\n\nNo execution summary is on file for this run.',
  );
  const commit = input.executeCommit?.trim();
  sections.push(
    commit !== undefined && commit !== ''
      ? `# Execute commit\n\nThe execution landed in commit \`${commit}\`. Inspect it with \`git show ${commit}\`.`
      : '# Execute commit\n\nThe execute commit is unknown; fall back to the files named in the execution summary.',
  );
  return sections;
}

/**
 * Investigate: the run framing, the question, and the files to start from.
 * Read-only, so there is no plan, no execution, no commit and no mode framing.
 */
function investigateSections(input: RunContextInput): string[] {
  const files = input.files ?? [];
  const filesBody =
    files.length === 0
      ? 'No files were named; start from the question.'
      : files.map((file) => `- \`${file}\``).join('\n');
  return [
    runSection(input),
    `# Question\n\n${input.statement.trim()}`,
    `# Files\n\n${filesBody}`,
  ];
}

/** Join sections with a blank line and a trailing newline. */
function join(sections: string[]): string {
  return sections.join('\n\n') + '\n';
}

/** Exhaustiveness guard for the stage switch. */
function assertNever(value: never): never {
  throw new Error(`unhandled run context stage: ${String(value)}`);
}
