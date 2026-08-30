import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock React hooks
let currentDispatcher: any = null;

vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: any) => currentDispatcher.useState(initial),
    useRef: (initial: any) => currentDispatcher.useRef(initial),
    useCallback: (fn: any, deps: any[]) => currentDispatcher.useCallback(fn, deps),
    useEffect: (fn: any, deps?: any[]) => currentDispatcher.useEffect(fn, deps),
  };
});

// Mock dependencies
let mockToken: string | null = "tok-123";
vi.mock("../../src/client/hooks/use-session-token.js", () => ({
  useSessionToken: () => ({ token: mockToken, setToken: vi.fn() }),
}));

let mockStreamHandle = { close: vi.fn() };
let lastStreamOptions: any = null;
vi.mock("../../src/client/lib/session-stream.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/client/lib/session-stream.js")>();
  return {
    ...actual,
    openSessionStream: (opts: any) => {
      lastStreamOptions = opts;
      return mockStreamHandle;
    },
  };
});

let mockRpcCalls: any[] = [];
let mockRpcHandler: ((proc: string, args: any) => Promise<any>) | null = null;
vi.mock("../../src/client/lib/rpc-client.js", () => ({
  rpc: {
    call: vi.fn(async (proc: string, args: any) => {
      mockRpcCalls.push({ proc, args });
      if (mockRpcHandler) {
        return mockRpcHandler(proc, args);
      }
      return { events: [], hasMore: false, latestSeq: 0 };
    }),
  },
}));

import {
  useSessionStream,
  CLIENT_STREAM_WINDOW_SIZE,
  MAX_EARLIER,
} from "../../src/client/hooks/use-session-stream.js";
import type { StreamEvent } from "../../src/client/lib/session-stream.js";

function makeEvent(seq: number, type = "step/log"): StreamEvent {
  return {
    seq,
    type,
    timestamp: "2026-08-30T00:00:00.000Z",
    payload: { seq },
    visibility: "model",
    modelVisible: true,
    correlationId: null,
  };
}

function renderHook<TProps, TResult>(
  hook: (props: TProps) => TResult,
  initialProps: TProps,
) {
  let props = initialProps;
  let stateIndex = 0;
  let refIndex = 0;
  let callbackIndex = 0;
  let effectIndex = 0;

  const states: any[] = [];
  const setStates: Array<(val: any) => void> = [];
  const refs: any[] = [];
  const callbacks: Array<{ fn: any; deps: any[] }> = [];
  const effects: Array<{ fn: any; deps: any[] | undefined; cleanup?: () => void }> = [];
  let effectsToRun: Array<{ fn: any; slot: any; prevCleanup?: () => void }> = [];

  let result: TResult;

  function render() {
    stateIndex = 0;
    refIndex = 0;
    callbackIndex = 0;
    effectIndex = 0;
    effectsToRun = [];

    currentDispatcher = {
      useState(initial: any) {
        const idx = stateIndex++;
        if (states.length <= idx) {
          states[idx] = typeof initial === "function" ? initial() : initial;
        }
        setStates[idx] = (newVal: any) => {
          const resolved =
            typeof newVal === "function" ? newVal(states[idx]) : newVal;
          if (states[idx] !== resolved) {
            states[idx] = resolved;
            render();
          }
        };
        return [states[idx], setStates[idx]];
      },

      useRef(initial: any) {
        const idx = refIndex++;
        if (refs.length <= idx) {
          refs[idx] = { current: initial };
        }
        return refs[idx];
      },

      useCallback(fn: any, deps: any[]) {
        const idx = callbackIndex++;
        if (callbacks.length <= idx) {
          callbacks[idx] = { fn, deps };
        } else {
          const prev = callbacks[idx];
          const changed =
            !deps ||
            !prev.deps ||
            deps.some((d, i) => !Object.is(d, prev.deps?.[i]));
          if (changed) {
            callbacks[idx] = { fn, deps };
          }
        }
        return callbacks[idx].fn;
      },

      useEffect(fn: any, deps?: any[]) {
        const idx = effectIndex++;
        if (effects.length <= idx) {
          const slot = { fn, deps, cleanup: undefined };
          effects[idx] = slot;
          effectsToRun.push({ fn, slot, prevCleanup: undefined });
        } else {
          const prev = effects[idx];
          const changed =
            !deps ||
            !prev.deps ||
            deps.some((d, i) => !Object.is(d, prev.deps?.[i]));
          if (changed) {
            const prevCleanup = prev.cleanup;
            prev.fn = fn;
            prev.deps = deps;
            prev.cleanup = undefined;
            effectsToRun.push({ fn, slot: prev, prevCleanup });
          }
        }
      },
    };

    result = hook(props);

    for (const eff of effectsToRun) {
      if (eff.prevCleanup) {
        eff.prevCleanup();
      }
      const cleanup = eff.fn();
      eff.slot.cleanup = typeof cleanup === "function" ? cleanup : undefined;
    }
  }

  render();

  return {
    get current() {
      return result;
    },
    rerender(newProps: TProps) {
      props = newProps;
      render();
    },
    unmount() {
      for (const eff of effects) {
        if (eff.cleanup) {
          eff.cleanup();
        }
      }
    },
  };
}

describe("useSessionStream (MUST-1 + MUST-2)", () => {
  beforeEach(() => {
    mockRpcCalls = [];
    mockRpcHandler = null;
    mockStreamHandle = { close: vi.fn() };
    lastStreamOptions = null;
  });

  it("exports CLIENT_STREAM_WINDOW_SIZE as 1000 and MAX_EARLIER as 2000", () => {
    expect(CLIENT_STREAM_WINDOW_SIZE).toBe(1000);
    expect(MAX_EARLIER).toBe(2000);
  });

  it("loadEarlier retains history across subsequent live events without dropping", async () => {
    const harness = renderHook((id: string | null) => useSessionStream(id), "sess_1" as string | null);

    expect(lastStreamOptions).toBeDefined();
    expect(lastStreamOptions.sessionId).toBe("sess_1");

    // Feed 1000 live events: seq 1001..2000
    for (let i = 1001; i <= 2000; i++) {
      lastStreamOptions.onEvent(makeEvent(i));
    }
    expect(harness.current.events).toHaveLength(1000);
    expect(harness.current.events[0].seq).toBe(1001);
    expect(harness.current.hasEarlier).toBe(true);

    // Mock RPC returning 500 earlier events: seq 501..1000
    mockRpcHandler = async (proc, args) => {
      expect(proc).toBe("session.events");
      expect(args.sessionId).toBe("sess_1");
      expect(args.sinceSeq).toBe(500); // 1001 - 500 - 1 = 500
      const earlierEvents = [];
      for (let i = 501; i <= 1000; i++) {
        earlierEvents.push(makeEvent(i));
      }
      return { events: earlierEvents, hasMore: true, latestSeq: 2000 };
    };

    await harness.current.loadEarlier();

    // After loading earlier, events count is 1500 (501..2000)
    expect(harness.current.events).toHaveLength(1500);
    expect(harness.current.events[0].seq).toBe(501);
    expect(harness.current.events[1499].seq).toBe(2000);

    // Now a new live event arrives (seq 2001).
    // Because retainFloor is 500, window limit is 1000 + 500 = 1500.
    // It should slice(-1500), so seq 501 is dropped and seq 502..2001 is retained (length 1500).
    // Crucially, loaded earlier history is NOT collapsed back to 1000!
    lastStreamOptions.onEvent(makeEvent(2001));
    expect(harness.current.events).toHaveLength(1500);
    expect(harness.current.events[0].seq).toBe(502);
    expect(harness.current.events[1499].seq).toBe(2001);
  });

  it("stops fetching when retainFloor reaches MAX_EARLIER (2000), sets reachedEarlierLimit", async () => {
    const harness = renderHook((id: string | null) => useSessionStream(id), "sess_1" as string | null);

    // Feed 1000 live events: seq 5001..6000
    for (let i = 5001; i <= 6000; i++) {
      lastStreamOptions.onEvent(makeEvent(i));
    }
    expect(harness.current.reachedEarlierLimit).toBe(false);

    // Set up mock returning 500 events on each page
    mockRpcHandler = async (proc, args) => {
      const sinceSeq = args.sinceSeq ?? 0;
      const count = 500;
      const events = [];
      for (let i = sinceSeq + 1; i <= sinceSeq + count; i++) {
        events.push(makeEvent(i));
      }
      return { events, hasMore: true, latestSeq: 6000 };
    };

    // 1st loadEarlier: +500 (retainFloor=500)
    await harness.current.loadEarlier();
    expect(harness.current.reachedEarlierLimit).toBe(false);

    // 2nd loadEarlier: +500 (retainFloor=1000)
    await harness.current.loadEarlier();
    expect(harness.current.reachedEarlierLimit).toBe(false);

    // 3rd loadEarlier: +500 (retainFloor=1500)
    await harness.current.loadEarlier();
    expect(harness.current.reachedEarlierLimit).toBe(false);

    // 4th loadEarlier: +500 (retainFloor=2000 >= MAX_EARLIER)
    await harness.current.loadEarlier();
    expect(harness.current.reachedEarlierLimit).toBe(true);
    expect(harness.current.hasEarlier).toBe(true);

    const callCountBefore = mockRpcCalls.length;
    expect(callCountBefore).toBe(4);

    // 5th call: hook side directly returns without firing new RPC
    await harness.current.loadEarlier();
    expect(mockRpcCalls.length).toBe(callCountBefore);
    expect(harness.current.reachedEarlierLimit).toBe(true);
  });

  it("resets retainFloor and reachedEarlierLimit when switching session", async () => {
    const harness = renderHook((id: string | null) => useSessionStream(id), "sess_1" as string | null);

    // Feed events and load earlier up to MAX_EARLIER
    for (let i = 5001; i <= 6000; i++) {
      lastStreamOptions.onEvent(makeEvent(i));
    }
    mockRpcHandler = async (proc, args) => {
      const sinceSeq = args.sinceSeq ?? 0;
      const events = [];
      for (let i = sinceSeq + 1; i <= sinceSeq + 2000; i++) {
        events.push(makeEvent(i));
      }
      return { events, hasMore: true, latestSeq: 6000 };
    };

    await harness.current.loadEarlier();
    expect(harness.current.reachedEarlierLimit).toBe(true);
    expect(mockStreamHandle.close).not.toHaveBeenCalled();

    // Switch session to sess_2
    harness.rerender("sess_2");

    expect(mockStreamHandle.close).toHaveBeenCalledTimes(1);
    expect(harness.current.events).toEqual([]);
    expect(harness.current.reachedEarlierLimit).toBe(false);
    expect(harness.current.hasEarlier).toBe(false);

    // New stream is for sess_2
    expect(lastStreamOptions.sessionId).toBe("sess_2");

    // Feed 1005 live events to sess_2
    for (let i = 1; i <= 1005; i++) {
      lastStreamOptions.onEvent(makeEvent(i));
    }
    // Window is now back to CLIENT_STREAM_WINDOW_SIZE (1000), not 3000!
    expect(harness.current.events).toHaveLength(1000);
    expect(harness.current.events[0].seq).toBe(6);
    expect(harness.current.events[999].seq).toBe(1005);
  });
  it("trims the events array in loadEarlier when merged events exceed maxWindow", async () => {
    const harness = renderHook((id: string | null) => useSessionStream(id), "sess_trim" as string | null);

    // Feed 1000 live events: seq 2001..3000
    for (let i = 2001; i <= 3000; i++) {
      lastStreamOptions.onEvent(makeEvent(i));
    }
    expect(harness.current.events).toHaveLength(1000);

    mockRpcHandler = async () => {
      const earlier = [];
      for (let i = 1001; i <= 2000; i++) {
        earlier.push(makeEvent(i));
      }
      return { events: earlier, hasMore: true, latestSeq: 3000 };
    };

    await harness.current.loadEarlier();

    expect(harness.current.events.length).toBeLessThanOrEqual(CLIENT_STREAM_WINDOW_SIZE + MAX_EARLIER);
    expect(harness.current.events).toHaveLength(2000);
    expect(harness.current.events[0].seq).toBe(1001);
  });

});
