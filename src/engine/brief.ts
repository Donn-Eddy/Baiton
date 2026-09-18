/**
 * The Brief writer (Requirement 11.2, 11.3).
 *
 * The Brief is a Markdown file at `.baiton/runs/<run-id>/brief.md` that a
 * Sub_Agent reads and follows. Its sections appear in a fixed order (Req 11.3):
 *
 *   1. Role instructions for the stage.
 *   2. The absolute path of the Result_File (in the same run directory).
 *   3. The stage's JSON schema.
 *   4. The write-and-stop instruction.
 *
 * The schema and the stop instruction appear last. {@link buildBrief} composes
 * this text as a pure function so it is directly testable; {@link writeBrief}
 * is the thin `fs` shell that persists it and returns the file path.
 */
import { writeFileSync } from 'fs';
import type { Stage } from '../model/stage';
import type { Role } from '../model/role';
import { schemaForStage } from '../schema';
import { roleInstructions } from './roleInstructions';

/** Everything {@link buildBrief} needs to compose a Brief. */
export interface BriefInput {
  /** The stage being run; selects the JSON schema section. */
  stage: Stage;
  /** The role being launched; selects the opening instruction section. */
  role: Role;
  /**
   * The absolute path of the Result_File, in the same `.baiton/runs/<run-id>/`
   * directory as the Brief (Req 11.3).
   */
  resultPath: string;
  /**
   * Optional stage context (markdown) placed right after the role
   * instructions: what the role should read and where it is. Omitted when
   * empty so the four required sections keep their order (Req 11.3).
   */
  context?: string;
}

/**
 * Compose the Brief Markdown text with sections in the required order — role
 * instructions, then the absolute Result_File path, then the stage JSON schema,
 * then the write-and-stop instruction, with the schema and stop instruction
 * last (Req 11.3).
 *
 * Pure: it neither reads nor writes the filesystem.
 */
export function buildBrief(input: BriefInput): string {
  const schemaJson = JSON.stringify(schemaForStage(input.stage), null, 2);

  const context =
    input.context !== undefined && input.context.trim().length > 0
      ? [`# Context\n\n${input.context.trim()}`]
      : [];
  const sections = [
    // 1. Role instructions (first).
    `# Role\n\n${roleInstructions(input.role)}`,
    // 1b. Optional stage context (what to read), right after the role.
    ...context,
    // 2. Absolute Result_File path.
    `# Result file\n\nWrite your result as JSON to this exact absolute path:\n\n\`${input.resultPath}\``,
    // 3. Stage JSON schema (second to last).
    `# Result schema\n\nThe result JSON must conform to this JSON Schema:\n\n\`\`\`json\n${schemaJson}\n\`\`\``,
    // 4. Write-and-stop instruction (last).
    `# When you are done\n\nYour work is not complete until the result file exists. Write it as JSON at the absolute path above — even if you have already described what you did in the terminal — then stop. Do not take any further action after writing the result file.`,
  ];

  return sections.join('\n\n') + '\n';
}

/**
 * Compose the Brief and write it to `briefPath` (an absolute filesystem path,
 * expected to be `.baiton/runs/<run-id>/brief.md`). Returns the composed text
 * so callers can log or assert on it. Throws on write failure — the launcher
 * catches this and halts the stage without launching (Req 11.5).
 */
export function writeBrief(briefPath: string, input: BriefInput): string {
  const contents = buildBrief(input);
  writeFileSync(briefPath, contents, 'utf8');
  return contents;
}
