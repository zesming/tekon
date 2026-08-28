import { describe, expect, it } from 'vitest';

import {
  createLegacyAgentDriver,
  createSessionEventStore,
  createSessionEventBus,
  createWriteQueue,
  migrateDatabase,
  openTekonDatabase,
  NotSupportedYet,
  type AgentAdapter,
  type AgentRunInput,
  type AgentRunResult,
} from '../../src/index.js';

// ── Helpers ────────────────────────────────────────────────────────────

function makeStore() {
  const db = openTekonDatabase({ filename: ':memory:' });
  migrateDatabase(db);
  const writeQueue = createWriteQueue();
  const sessions = createSessionEventStore(db, writeQueue);
  const bus = createSessionEventBus();
  return { db, sessions, bus };
}

async function seedSession(sessions: ReturnType<typeof makeStore>['sessions']) {
  const workspace = await sessions.getOrCreateDefaultWorkspace('/repo');
  const session = await sessions.createSession({
    workspaceId: workspace.id,
    title: 'driver-test',
    profile: 'human-web',
    runId: 'run_driver_1',
  });
  return session.id;
}

const RUN_INPUT = { prompt: 'do it' } as unknown as AgentRunInput;

function driverDeps(
  store: ReturnType<typeof makeStore>,
  adapter: AgentAdapter,
) {
  return {
    adapter,
    sessions: store.sessions,
    bus: store.bus,
    async buildRunInput() {
      return {
        input: RUN_INPUT,
        runId: 'run_driver_1',
        nodeId: 'node_1',
        role: 'rd' as const,
      };
    },
  };
}

function okAdapter(): AgentAdapter {
  return {
    async runAgent(): Promise<AgentRunResult> {
      return {
        provider: 'mock',
        exitCode: 0,
        durationMs: 1,
        outputFiles: ['out.md'],
        artifacts: [{ type: 'code-change', path: 'a.ts' } as never],
      };
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

describe('legacy AgentDriver (S5)', () => {
  it('start → events → whenIdle yields the step sequence with monotonic seq', async () => {
    const store = makeStore();
    const sessionId = await seedSession(store.sessions);
    const driver = createLegacyAgentDriver(driverDeps(store, okAdapter()));

    const handle = await driver.start({
      sessionId: sessionId,
      message: { text: 'do it' },
    });

    const outcome = await handle.whenIdle();
    expect(outcome.status).toBe('done');

    const collected: Array<{ type: string; seq: number }> = [];
    for await (const event of handle.events()) {
      collected.push({ type: event.type, seq: event.seq });
    }
    expect(collected.map((e) => e.type)).toEqual([
      'step/start',
      'tool/call',
      'tool/result',
      'assistant/message',
      'step/end',
    ]);
    // seq is real (store-assigned) and strictly increasing.
    for (let i = 1; i < collected.length; i++) {
      expect(collected[i].seq).toBeGreaterThan(collected[i - 1].seq);
    }
  });

  it('pause() reports interruptible: false (honest legacy semantics)', async () => {
    const store = makeStore();
    const sessionId = await seedSession(store.sessions);
    const driver = createLegacyAgentDriver(driverDeps(store, okAdapter()));
    const handle = await driver.start({
      sessionId: sessionId,
      message: { text: 'do it' },
    });
    const result = await handle.pause();
    expect(result.interruptible).toBe(false);
    await handle.whenIdle();
  });

  it('cancel() aborts an in-flight run → outcome cancelled', async () => {
    const store = makeStore();
    const sessionId = await seedSession(store.sessions);
    // Latch adapter: blocks until released; returns cancelled if the signal fired.
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let entered: () => void = () => {};
    const enteredP = new Promise<void>((r) => {
      entered = r;
    });
    const latch: AgentAdapter = {
      async runAgent(input): Promise<AgentRunResult> {
        entered();
        await gate;
        return {
          provider: 'mock',
          exitCode: input.signal?.aborted ? null : 0,
          durationMs: 0,
          outputFiles: [],
          cancelled: input.signal?.aborted === true,
        };
      },
    };
    const driver = createLegacyAgentDriver(driverDeps(store, latch));
    const handle = await driver.start({
      sessionId: sessionId,
      message: { text: 'do it' },
    });
    await enteredP; // run is genuinely in flight
    await handle.cancel();
    release();
    const outcome = await handle.whenIdle();
    expect(outcome.status).toBe('cancelled');
  });

  it('followUp / steer throw NotSupportedYet (deferred to 2b)', async () => {
    const store = makeStore();
    const sessionId = await seedSession(store.sessions);
    const driver = createLegacyAgentDriver(driverDeps(store, okAdapter()));
    const handle = await driver.start({
      sessionId: sessionId,
      message: { text: 'do it' },
    });
    await expect(handle.followUp({ text: 'more' })).rejects.toThrow(NotSupportedYet);
    await expect(handle.steer({ text: 'steer' })).rejects.toThrow(NotSupportedYet);
    await handle.whenIdle();
  });

  it('resume() throws NotSupportedYet (deferred to 2b)', async () => {
    const store = makeStore();
    await seedSession(store.sessions);
    const driver = createLegacyAgentDriver(driverDeps(store, okAdapter()));
    await expect(
      driver.resume({ sessionId: 'x' }),
    ).rejects.toThrow(NotSupportedYet);
  });
});
