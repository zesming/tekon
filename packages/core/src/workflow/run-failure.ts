import { redactSecrets } from '../security/secrets.js';
import type { AuditEvent } from '../types/domain.js';

export interface RunFailureReason {
  message: string;
  /** Diagnostic code, e.g. not-authenticated; absent for unclassified errors. */
  kind?: string;
  hint?: string;
}

const FAILURE_EVENT_TYPES = new Set(['node.interrupted', 'gate.execution.error']);

/**
 * The newest recorded failure since the run last resumed, so a reason that a
 * resume already addressed is not shown again.
 */
export function findLatestRunFailure(
  events: readonly Pick<AuditEvent, 'type' | 'payload'>[],
): RunFailureReason | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event.type === 'run.resumed') return undefined;
    if (!FAILURE_EVENT_TYPES.has(event.type)) continue;
    const diagnostic = event.payload.diagnostic as
      | { code?: unknown; message?: unknown; hint?: unknown }
      | undefined;
    if (diagnostic && typeof diagnostic.message === 'string') {
      return {
        message: diagnostic.message,
        ...(typeof diagnostic.code === 'string' ? { kind: diagnostic.code } : {}),
        ...(typeof diagnostic.hint === 'string' ? { hint: diagnostic.hint } : {}),
      };
    }
    if (typeof event.payload.error === 'string') {
      return { message: redactSecrets(event.payload.error).content };
    }
    return undefined;
  }
  return undefined;
}
