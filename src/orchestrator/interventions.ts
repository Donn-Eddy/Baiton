/**
 * Interventions and human-in-the-loop asks for the orchestrator.
 *
 * An intervention is a question, confirmation, or permission ask presented
 * to the user during an agent run or tool execution.
 *
 * - {@link InterventionRequest} and {@link Intervention} — the ask data models.
 * - {@link InterventionAnswer} — the user's response (option, text, approved, declined).
 * - {@link checkAnswer} — pure validator of an answer against its request kind.
 * - {@link PendingAskRegistry} — in-memory tracker for active asks and their settlement promises.
 * - {@link InterventionSeam} — the seam through which tools and orchestrator ask for user intervention.
 * - {@link confirmSeamFrom} — backwards-compatible adapter mapping an {@link InterventionSeam}
 *   to the legacy {@link ConfirmSeam}.
 */
import { Clock, IdGenerator, systemClock, type ConfirmSeam } from './seams';

export type InterventionKind = 'question' | 'confirm' | 'permission';

/** One selectable answer of an option question. */
export interface InterventionOption {
  /** Stable id the answer names; unique within one request. */
  id: string;
  /** The button/radio label shown to the user. */
  label: string;
  /** Optional secondary line under the label. */
  detail?: string;
}

/** The orchestrator (or a sub-agent) asks the user a question. */
export interface QuestionRequest {
  kind: 'question';
  /** The question text. */
  prompt: string;
  /** Offered choices; absent or empty means a free-text-only question. */
  options?: InterventionOption[];
  /** True when a typed answer is accepted in addition to any options. */
  allowFreeText?: boolean;
  /** Placeholder for the free-text input. */
  placeholder?: string;
}

/** A yes/no confirmation (what today's modal ConfirmSeam shows). */
export interface ConfirmRequest {
  kind: 'confirm';
  prompt: string;
  detail?: string;
  /** Defaults are applied by the view, not here. */
  confirmLabel?: string;
  declineLabel?: string;
}

/** A sub-agent harness permission ask relayed into the chat. */
export interface PermissionRequest {
  kind: 'permission';
  prompt: string;
  /** The agent/adapter id the ask came from (e.g. 'claude'). */
  agent: string;
  /** The tool the harness wants to run (e.g. 'Bash'). */
  tool: string;
  /** The tool arguments as JSON text, when the harness supplied them. */
  args?: string;
  /** Human-readable 'what you are approving' text. */
  detail?: string;
}

export type InterventionRequest = QuestionRequest | ConfirmRequest | PermissionRequest;

/** A created, pending or settled ask: a request plus its identity. */
export type Intervention = InterventionRequest & {
  /** Registry-assigned id; the key every resolve/reject names. */
  id: string;
  /** ISO-8601 creation time from the injected Clock. */
  createdAt: string;
  /** Conversation scope the card belongs to ('workspace' or a spec slug). */
  scopeId?: string;
};

/** The user's answer to one intervention. */
export type InterventionAnswer =
  | { kind: 'option'; optionId: string; label?: string }
  | { kind: 'text'; text: string }
  | { kind: 'approved' }
  | { kind: 'declined'; reason?: string };

export type AnswerCheck = { ok: true } | { ok: false; reason: string };

function assertNever(value: never): never {
  throw new Error(`unhandled value: ${JSON.stringify(value)}`);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Pure validator used by the registry and reusable by the controller.
 */
export function checkAnswer(req: InterventionRequest, answer: InterventionAnswer): AnswerCheck {
  if (answer.kind === 'declined') {
    return { ok: true };
  }

  switch (req.kind) {
    case 'question': {
      if (answer.kind === 'option') {
        const found = req.options?.some((opt) => opt.id === answer.optionId);
        if (found) {
          return { ok: true };
        }
        return { ok: false, reason: `unknown option "${answer.optionId}"` };
      }
      if (answer.kind === 'text') {
        if (req.allowFreeText === true || !req.options || req.options.length === 0) {
          return { ok: true };
        }
        return { ok: false, reason: 'this question does not accept a typed answer' };
      }
      if (answer.kind === 'approved') {
        return { ok: false, reason: 'a question cannot be answered with an approval' };
      }
      return assertNever(answer);
    }
    case 'confirm':
    case 'permission': {
      if (answer.kind === 'approved') {
        return { ok: true };
      }
      if (answer.kind === 'option' || answer.kind === 'text') {
        return { ok: false, reason: `a ${req.kind} is answered by approving or declining` };
      }
      return assertNever(answer);
    }
    default:
      return assertNever(req);
  }
}

export type ResolveOutcome =
  | { kind: 'resolved' }
  | { kind: 'unknown' }
  | { kind: 'invalid'; reason: string };

export interface PendingAskRegistryDeps {
  ids: IdGenerator;
  clock?: Clock; // defaults to systemClock
}

interface PendingEntry {
  intervention: Intervention;
  settle: (a: InterventionAnswer) => void;
}

export class PendingAskRegistry {
  private readonly ids: IdGenerator;
  private readonly clock: Clock;
  private readonly entries = new Map<string, PendingEntry>();

  constructor(deps: PendingAskRegistryDeps) {
    this.ids = deps.ids;
    this.clock = deps.clock ?? systemClock;
  }

  /** Register a new ask; returns the stamped Intervention and the promise that settles with the user's answer. */
  create(request: InterventionRequest): { intervention: Intervention; answer: Promise<InterventionAnswer> } {
    const id = this.ids.next();
    const createdAt = this.clock.now();
    const intervention: Intervention = {
      ...request,
      id,
      createdAt,
    };
    let settle!: (a: InterventionAnswer) => void;
    const answer = new Promise<InterventionAnswer>((resolve) => {
      settle = resolve;
    });
    this.entries.set(id, { intervention, settle });
    return { intervention, answer };
  }

  /** Settle the ask with the user's answer. */
  resolve(id: string, answer: InterventionAnswer): ResolveOutcome {
    const entry = this.entries.get(id);
    if (!entry) {
      return { kind: 'unknown' };
    }
    const check = checkAnswer(entry.intervention, answer);
    if (!check.ok) {
      return { kind: 'invalid', reason: check.reason };
    }
    this.entries.delete(id);
    entry.settle(answer);
    return { kind: 'resolved' };
  }

  /** Settle the ask as declined (Stop, a card's Decline, or a failed presentation). */
  reject(id: string, reason: string = 'declined'): ResolveOutcome {
    return this.resolve(id, { kind: 'declined', reason: reason ?? 'declined' });
  }

  /** Decline every pending ask; returns how many were settled. */
  rejectAll(reason: string = 'the run was stopped'): number {
    const effectiveReason = reason ?? 'the run was stopped';
    const keys = Array.from(this.entries.keys());
    let count = 0;
    for (const key of keys) {
      const outcome = this.reject(key, effectiveReason);
      if (outcome.kind === 'resolved') {
        count++;
      }
    }
    return count;
  }

  /** The pending asks in creation order (a fresh array; entries are copies-by-reference of the stored Intervention). */
  pending(): Intervention[] {
    return Array.from(this.entries.values(), (e) => e.intervention);
  }

  has(id: string): boolean {
    return this.entries.has(id);
  }

  get size(): number {
    return this.entries.size;
  }
}

/** The seam every human-in-the-loop ask goes through. Resolves with the user's answer. */
export interface InterventionSeam {
  ask(request: InterventionRequest): Promise<InterventionAnswer>;
}

/** Shows a pending card to the user; the host implements it (chat post / webview message). */
export type PresentIntervention = (intervention: Intervention) => void | Promise<void>;

export function createInterventionSeam(
  registry: PendingAskRegistry,
  present: PresentIntervention,
): InterventionSeam {
  return {
    async ask(request: InterventionRequest): Promise<InterventionAnswer> {
      const { intervention, answer } = registry.create(request);
      try {
        await present(intervention);
      } catch (err) {
        registry.reject(intervention.id, `the ask could not be shown: ${message(err)}`);
      }
      return answer;
    },
  };
}

/** Adapt an InterventionSeam to the legacy yes/no ConfirmSeam. */
export function confirmSeamFrom(seam: InterventionSeam): ConfirmSeam {
  return {
    async confirm(msg: string): Promise<boolean> {
      const answer = await seam.ask({ kind: 'confirm', prompt: msg });
      return answer.kind === 'approved';
    },
  };
}
