import type {
  AgentDriver,
  AgentHandle,
  AgentOutcome,
  AgentResumeInput,
  AgentRuntimeEvent,
  AgentStartInput,
  PauseResult,
  UserMessage,
} from '../types/session-contract.js';
import type { SessionEventStore } from '../session/session-store.js';
import type { SessionEventBus } from '../session/event-bus.js';
import type { AgentAdapter, AgentRunInput } from './agent-adapter.js';
import type { Role } from '../types/domain.js';
import {
  runAgentWithStepEvents,
  type AgentEventSink,
} from './agent-step-events.js';

/**
 * NotSupportedYet marks a frozen-contract method whose implementation is
 * deferred to a later phase (design D2). Callers get an explicit, typed failure
 * rather than a silently-dropped message.
 */
export class NotSupportedYet extends Error {
  constructor(feature: string) {
    super(`${feature} is not supported yet (deferred to phase 2b).`);
    this.name = 'NotSupportedYet';
  }
}

export interface LegacyAgentDriverDeps {
  adapter: AgentAdapter;
  sessions: SessionEventStore;
  bus: SessionEventBus;
  /**
   * Build the single AgentRunInput for a session's turn. In phase 2a a driver
   * turn maps to exactly one legacy runAgent() call (one opaque step).
   */
  buildRunInput(input: {
    sessionId: string;
    message: UserMessage;
  }): Promise<{ input: AgentRunInput; runId: string; nodeId: string; role: Role }>;
}

/**
 * Legacy AgentDriver (phase 2 S5): the first concrete implementation of the
 * frozen AgentDriver/AgentHandle contract (session-contract.ts). It wraps the
 * existing one-shot adapter as a single step via the SHARED sequence owner
 * `runAgentWithStepEvents` (design D1) — the exact same event sequence
 * node-executor/rework produce, so there is one source of truth.
 *
 * `events()` needs `seq` (contract requires it), so the driver uses a
 * "collecting sink" that persists each event via `sessions.appendEvent` (which
 * assigns seq), best-effort publishes to the bus, and buffers the persisted
 * event for the async iterator. This is a driver-local endorsed second
 * persistence path — NOT a fabricated seq.
 */
export function createLegacyAgentDriver(
  deps: LegacyAgentDriverDeps,
): AgentDriver {
  function makeHandle(
    sessionId: string,
    runInput: { input: AgentRunInput; runId: string; nodeId: string; role: Role },
    controller: AbortController,
  ): AgentHandle {
    const signal = controller.signal;
    const buffered: AgentRuntimeEvent[] = [];
    let outcome: AgentOutcome | undefined;

    // Collecting sink: append (→ seq) + best-effort publish + buffer.
    const sink: AgentEventSink = {
      async recordFromRun(input) {
        const event = await deps.sessions.appendEvent({
          sessionId,
          type: input.type,
          payload: input.payload,
          modelVisible: input.modelVisible,
          correlationId: input.correlationId,
        });
        try {
          deps.bus.publish(event);
        } catch {
          // best-effort publish (C1).
        }
        buffered.push({ type: event.type, seq: event.seq, payload: event.payload });
      },
    };

    const done = (async (): Promise<AgentOutcome> => {
      try {
        const result = await runAgentWithStepEvents(
          deps.adapter,
          { ...runInput.input, signal },
          {
            runId: runInput.runId,
            nodeId: runInput.nodeId,
            role: runInput.role,
            promptSummary: runInput.input.prompt,
          },
          sink,
        );
        if (result.cancelled || signal.aborted) {
          outcome = { status: 'cancelled' };
        } else if (
          result.timedOut ||
          (result.exitCode != null && result.exitCode !== 0)
        ) {
          outcome = { status: 'failed', summary: `exit ${result.exitCode}` };
        } else {
          outcome = { status: 'done' };
        }
      } catch (error) {
        outcome = {
          status: 'failed',
          summary: error instanceof Error ? error.message : String(error),
        };
      }
      return outcome;
    })();

    return {
      id: `handle_${runInput.runId}`,
      async *events(): AsyncIterable<AgentRuntimeEvent> {
        await done; // one-shot: the whole sequence is known once the run settles.
        for (const event of buffered) {
          yield event;
        }
      },
      async followUp(): Promise<void> {
        throw new NotSupportedYet('AgentHandle.followUp');
      },
      async steer(): Promise<void> {
        throw new NotSupportedYet('AgentHandle.steer');
      },
      async pause(): Promise<PauseResult> {
        // The legacy adapter runs a subprocess to completion; it cannot be
        // paused mid-tool. Honest semantics: not interruptible here (design
        // §0.5). Real pause happens at node boundaries in the engine.
        return { paused: false, interruptible: false };
      },
      async cancel(): Promise<void> {
        // Cancellation flows through the AbortSignal passed into the run: abort
        // it so the adapter kills its subprocess (phase-1 cancel chain) and the
        // run settles cancelled.
        controller.abort();
      },
      whenIdle(): Promise<AgentOutcome> {
        return done;
      },
    };
  }

  return {
    async start(input: AgentStartInput): Promise<AgentHandle> {
      const controller = new AbortController();
      const runInput = await deps.buildRunInput({
        sessionId: input.sessionId,
        message: input.message,
      });
      return makeHandle(input.sessionId, runInput, controller);
    },
    async resume(_input: AgentResumeInput): Promise<AgentHandle> {
      throw new NotSupportedYet('AgentDriver.resume');
    },
  };
}
