/**
 * The orchestrator tool registry (design "Orchestrator: tool registry and
 * guard").
 *
 * Assembles every read, spec-writing and control tool from a single
 * {@link ToolServices} bundle, wraps each with {@link guardTool} so the guard's
 * idempotency, path-containment and Restricted-Mode rules apply uniformly
 * (Req 8.3–8.5, 22.1, 22.2), and exposes a name → guarded-run map plus a
 * convenience {@link ToolRegistry.call} dispatcher.
 *
 * The registry owns one per-repository {@link IdempotencyStore} so a mutating
 * tool-call id already seen replays the stored first result across the whole
 * registry, regardless of which tool it targeted (Req 8.5). The registry
 * imports no `vscode` API; the activation layer builds the services and passes
 * a {@link GuardContext} per call.
 *
 * Every tool also declares the orchestrator phases it belongs to (Req 11.1).
 * The phase is enforced twice: {@link ToolRegistry.definitionsFor} and
 * {@link ToolRegistry.assembleFor} advertise only the current phase's tools,
 * and {@link ToolRegistry.call} refuses an out-of-phase tool before its `run`
 * is reached, so a tool the model should not have cannot act even if it is
 * named anyway.
 */
import {
  GuardContext,
  IdempotencyStore,
  OrchestratorPhase,
  Tool,
  ToolContext,
  ToolResult,
  guardTool,
} from './guard';
import { createControlTools } from './controlTools';
import { createReadTools } from './readTools';
import { createSpecWriteTools } from './specWriteTools';
import { ToolServices } from './toolServices';
import { ToolSpec } from './modelClient';
import { Result, err, ok } from '../model/result';

/**
 * The minimum length, after trimming, a tool `description` must have to be sent
 * to the model (Req 10.2, 10.5). A shorter or empty description fails assembly.
 */
export const MIN_TOOL_DESCRIPTION_LENGTH = 10;

/**
 * Why {@link assembleToolSpecs} rejected: `tool` names the offending tool and
 * `reason` explains why its description is not valid (Req 10.5). When assembly
 * is rejected no definitions are sent to the model.
 */
export interface ToolDescriptionError {
  tool: string;
  reason: string;
}

/** A tool paired with its guard-wrapped run function. */
interface RegisteredTool {
  tool: Tool;
  guardedRun: (args: unknown, tc: ToolContext) => Promise<ToolResult>;
}

/**
 * The assembled, guard-wrapped tool surface for one repository. Construct it
 * once per workspace; call {@link call} for each model tool invocation with the
 * call's idempotency key and a {@link GuardContext} for the current trust and
 * path state.
 */
export class ToolRegistry {
  private readonly registered = new Map<string, RegisteredTool>();
  private readonly store = new IdempotencyStore();

  constructor(services: ToolServices) {
    const tools = [
      ...createReadTools(services),
      ...createSpecWriteTools(services),
      ...createControlTools(services),
    ];
    for (const tool of tools) {
      this.registered.set(tool.name, {
        tool,
        guardedRun: guardTool(tool, this.store),
      });
    }
  }

  /** Whether a tool with `name` is registered. */
  public has(name: string): boolean {
    return this.registered.has(name);
  }

  /** Every registered tool name, sorted, for diagnostics and the model spec. */
  public names(): string[] {
    return [...this.registered.keys()].sort();
  }

  /**
   * The raw {@link Tool} definitions (name, description, mutating/dispatch
   * flags, argument schema) so the activation layer can advertise them to the
   * model. Each definition carries the tool's `description` (Req 10.3); use
   * {@link assembleToolSpecs} to validate the descriptions and build the
   * `ToolSpec[]` actually sent to the model.
   */
  public definitions(): Tool[] {
    return [...this.registered.values()].map((r) => r.tool);
  }

  /**
   * The raw {@link Tool} definitions advertised in `phase` (Req 11.1): the
   * subset of {@link definitions} whose `phases` include it.
   */
  public definitionsFor(phase: OrchestratorPhase): Tool[] {
    return this.definitions().filter((t) => t.phases.includes(phase));
  }

  /**
   * The validated {@link ToolSpec}s to send to the model, or a rejection naming
   * the first tool whose description is invalid (Req 10.3–10.5). Delegates to
   * the free {@link assembleToolSpecs} over this registry's definitions.
   */
  public assemble(): Result<ToolSpec[], ToolDescriptionError> {
    return assembleToolSpecs(this.definitions());
  }

  /**
   * The validated {@link ToolSpec}s to advertise while in `phase` (Req 11.1),
   * validating only that phase's descriptions (Req 10.3–10.5).
   */
  public assembleFor(phase: OrchestratorPhase): Result<ToolSpec[], ToolDescriptionError> {
    return assembleToolSpecs(this.definitionsFor(phase));
  }

  /**
   * Invoke a tool by name through the guard. `callId` is the model's tool-call
   * id, used as the idempotency key for mutating tools (Req 8.3). An unknown
   * tool name returns an error result rather than throwing.
   *
   * `phase` is the orchestrator phase the conversation is in (Req 11.1). A tool
   * that does not belong to that phase is refused here, before the guard and
   * before the tool's own `run`, so an out-of-phase call reads nothing and
   * writes nothing.
   */
  public async call(
    name: string,
    args: unknown,
    callId: string | undefined,
    ctx: GuardContext,
    phase: OrchestratorPhase,
  ): Promise<ToolResult> {
    const entry = this.registered.get(name);
    if (entry === undefined) {
      return { ok: false, error: `unknown tool: ${name}` };
    }
    if (!entry.tool.phases.includes(phase)) {
      return {
        ok: false,
        error: `tool "${name}" is not available while ${phase}`,
      };
    }
    return entry.guardedRun(args, { callId, ctx });
  }
}

/** Build a {@link ToolRegistry} from a services bundle. */
export function createToolRegistry(services: ToolServices): ToolRegistry {
  return new ToolRegistry(services);
}

/**
 * Assemble the {@link ToolSpec}s advertised to the model from a list of
 * {@link Tool} definitions, validating each tool's `description` first
 * (Req 10.3–10.5).
 *
 * A tool's description is valid when, after trimming leading and trailing
 * whitespace, it is non-empty, at least {@link MIN_TOOL_DESCRIPTION_LENGTH}
 * characters long, and not equal to the tool's `name` (Req 10.2). If any tool
 * fails, assembly is rejected with a {@link ToolDescriptionError} naming that
 * tool and its reason, and **no** definitions are produced (Req 10.5) — the
 * caller must send nothing to the model. On success each spec's `description`
 * is set from its tool's field (Req 10.3) and never from its `name` (Req 10.4).
 */
export function assembleToolSpecs(
  tools: Tool[],
): Result<ToolSpec[], ToolDescriptionError> {
  const specs: ToolSpec[] = [];
  for (const tool of tools) {
    const trimmed = tool.description.trim();
    if (trimmed === '') {
      return err({ tool: tool.name, reason: 'description is empty' });
    }
    if (trimmed.length < MIN_TOOL_DESCRIPTION_LENGTH) {
      return err({
        tool: tool.name,
        reason:
          `description is shorter than ${MIN_TOOL_DESCRIPTION_LENGTH} characters after trimming`,
      });
    }
    if (trimmed === tool.name) {
      return err({
        tool: tool.name,
        reason: 'description must not equal the tool name',
      });
    }
    specs.push({
      name: tool.name,
      description: tool.description,
      parameters: tool.schema,
    });
  }
  return ok(specs);
}
