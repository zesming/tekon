import { describe, expect, it } from 'vitest';

import {
  runAgentWithStepEvents,
  type AgentEventSink,
  type AgentAdapter,
  type AgentRunInput,
  type AgentRunResult,
} from '../../src/index.js';

// ── Helpers ────────────────────────────────────────────────────────────

interface Emitted {
  type: string;
  payload: Record<string, unknown>;
  modelVisible?: boolean;
}

function collectingSink(): { sink: AgentEventSink; events: Emitted[] } {
  const events: Emitted[] = [];
  return {
    events,
    sink: {
      async recordFromRun(input) {
        events.push({
          type: input.type,
          payload: input.payload ?? {},
          modelVisible: input.modelVisible,
        });
      },
    },
  };
}

function adapterReturning(result: Partial<AgentRunResult>): AgentAdapter {
  return {
    async runAgent(): Promise<AgentRunResult> {
      return {
        provider: 'mock',
        exitCode: 0,
        durationMs: 1,
        outputFiles: [],
        ...result,
      };
    },
  };
}

const INPUT = { prompt: 'do the thing' } as unknown as AgentRunInput;
const META = {
  runId: 'run_1',
  nodeId: 'node_1',
  role: 'rd' as const,
  promptSummary: 'do the thing',
};

// ── Tests ──────────────────────────────────────────────────────────────

describe('runAgentWithStepEvents (S3)', () => {
  it('success path emits step/start → tool/call → tool/result → assistant/message → step/end', async () => {
    const { sink, events } = collectingSink();
    const adapter = adapterReturning({
      exitCode: 0,
      outputFiles: ['out.md'],
      artifacts: [{ type: 'code-change', path: 'a.ts' } as never],
    });

    const result = await runAgentWithStepEvents(adapter, INPUT, META, sink);

    expect(result.exitCode).toBe(0);
    expect(events.map((e) => e.type)).toEqual([
      'step/start',
      'tool/call',
      'tool/result',
      'assistant/message',
      'step/end',
    ]);
    // assistant/message and tool/result must be modelVisible (M3).
    const assistant = events.find((e) => e.type === 'assistant/message')!;
    const toolResult = events.find((e) => e.type === 'tool/result')!;
    expect(assistant.modelVisible).toBe(true);
    expect(toolResult.modelVisible).toBe(true);
    // step/end status is passed.
    expect(events.at(-1)!.payload.status).toBe('passed');
    // all events share one correlationId (stepId groups the node's step).
    expect(assistant.payload.stepId).toBe(events[0].payload.stepId);
    expect(assistant.payload.synthetic).toBe(true);
    expect(events.find((e) => e.type === 'tool/call')?.payload.name).toBe(
      'mock',
    );
    expect(toolResult.payload.summary).toContain('1 artifact');
  });

  it('cancel path emits ONLY step/end{cancelled}, never agent/error (MF1)', async () => {
    const { sink, events } = collectingSink();
    // Cancelled adapter result: exitCode=null would trip the failure check if
    // ordering were wrong (M1).
    const adapter = adapterReturning({ cancelled: true, exitCode: null });

    await runAgentWithStepEvents(adapter, INPUT, META, sink);

    expect(events.map((e) => e.type)).toEqual(['step/start', 'step/end']);
    expect(events.some((e) => e.type === 'agent/error')).toBe(false);
    expect(events.at(-1)!.payload.status).toBe('cancelled');
  });

  it('failure path (exitCode≠0) emits agent/error + step/end{failed}', async () => {
    const { sink, events } = collectingSink();
    const adapter = adapterReturning({ exitCode: 1 });

    await runAgentWithStepEvents(adapter, INPUT, META, sink);

    expect(events.map((e) => e.type)).toEqual([
      'step/start',
      'agent/error',
      'step/end',
    ]);
    expect(events.at(-1)!.payload.status).toBe('failed');
  });

  it('failure path (timedOut) emits agent/error + step/end{failed}', async () => {
    const { sink, events } = collectingSink();
    const adapter = adapterReturning({ timedOut: true, exitCode: null });

    await runAgentWithStepEvents(adapter, INPUT, META, sink);

    expect(events.map((e) => e.type)).toEqual([
      'step/start',
      'agent/error',
      'step/end',
    ]);
  });

  it('adapter throw emits agent/error + step/end{failed} then rethrows', async () => {
    const { sink, events } = collectingSink();
    const adapter: AgentAdapter = {
      async runAgent() {
        throw new Error('subprocess crashed');
      },
    };

    await expect(
      runAgentWithStepEvents(adapter, INPUT, META, sink),
    ).rejects.toThrow('subprocess crashed');

    expect(events.map((e) => e.type)).toEqual([
      'step/start',
      'agent/error',
      'step/end',
    ]);
    expect(events.at(-1)!.payload.status).toBe('failed');
  });

  // C1: a throwing sink must NEVER break the agent run (governance zero-regression).
  it('C1: a sink that throws does not affect the returned result or throw', async () => {
    const throwingSink: AgentEventSink = {
      async recordFromRun() {
        throw new Error('event store is down');
      },
    };
    const adapter = adapterReturning({ exitCode: 0, outputFiles: ['x'] });

    const result = await runAgentWithStepEvents(
      adapter,
      INPUT,
      META,
      throwingSink,
    );
    expect(result.exitCode).toBe(0); // run succeeded despite sink failure
  });

  it('no sink → no events, result unchanged', async () => {
    const adapter = adapterReturning({ exitCode: 0 });
    const result = await runAgentWithStepEvents(
      adapter,
      INPUT,
      META,
      undefined,
    );
    expect(result.exitCode).toBe(0);
  });

  it('uses documented provider assistant text instead of a synthetic summary', async () => {
    const { sink, events } = collectingSink();
    const adapter = adapterReturning({
      assistantText: 'This is the provider final answer.',
    });

    await runAgentWithStepEvents(adapter, INPUT, META, sink);

    const assistant = events.find(
      (event) => event.type === 'assistant/message',
    )!;
    expect(assistant.payload.text).toBe('This is the provider final answer.');
    expect(assistant.payload.synthetic).toBe(false);
  });

  // F-08: durable step events must be redacted BEFORE they are written to the
  // session store — presentation-layer redaction is not a substitute.
  it('F-08: redacts secrets in the durable step/start prompt summary', async () => {
    const { sink, events } = collectingSink();
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';
    const meta = { ...META, promptSummary: `use key ${secret} to auth` };
    const adapter = adapterReturning({ exitCode: 0 });

    await runAgentWithStepEvents(adapter, INPUT, meta, sink);

    const start = events.find((event) => event.type === 'step/start')!;
    const summary = JSON.stringify(start.payload);
    expect(summary).not.toContain(secret);
    expect(summary).toContain('REDACTED');
  });

  it('F-08: redacts secrets in the durable agent/error message when the adapter throws', async () => {
    const { sink, events } = collectingSink();
    const secret = 'sk-abcdefghijklmnopqrstuvwxyz0123456789';
    const adapter: AgentAdapter = {
      async runAgent() {
        throw new Error(`provider rejected token ${secret}`);
      },
    };

    await expect(
      runAgentWithStepEvents(adapter, INPUT, META, sink),
    ).rejects.toThrow();

    const error = events.find((event) => event.type === 'agent/error')!;
    const serialized = JSON.stringify(error.payload);
    expect(serialized).not.toContain(secret);
    expect(serialized).toContain('REDACTED');
  });
});
