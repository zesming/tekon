import { describe, expect, it } from 'vitest';

import {
  createSubprocessRegistry,
  type SubprocessHandle,
} from '../../src/index.js';

function fakeHandle(killSignals: NodeJS.Signals[]): SubprocessHandle {
  return {
    pid: 1234,
    kill(signal) {
      killSignals.push(signal);
    },
  };
}

describe('subprocess registry', () => {
  it('kills every handle registered under a key and returns the killed count', () => {
    const registry = createSubprocessRegistry();
    const killSignals: NodeJS.Signals[] = [];
    const first = fakeHandle(killSignals);
    const second = fakeHandle(killSignals);
    registry.register('run-1', first);
    registry.register('run-1', second);

    expect(registry.killAll('run-1', 'SIGKILL')).toBe(2);
    expect(killSignals).toEqual(['SIGKILL', 'SIGKILL']);
  });

  it('does not kill handles after they are unregistered', () => {
    const registry = createSubprocessRegistry();
    const killSignals: NodeJS.Signals[] = [];
    const first = fakeHandle(killSignals);
    const second = fakeHandle(killSignals);
    registry.register('run-1', first);
    registry.register('run-1', second);
    registry.unregister('run-1', first);

    expect(registry.killAll('run-1', 'SIGTERM')).toBe(1);
    expect(killSignals).toEqual(['SIGTERM']);
    expect(registry.list('run-1')).toEqual([second]);
  });

  it('returns 0 for keys that have no registered handles', () => {
    const registry = createSubprocessRegistry();

    expect(registry.killAll('missing', 'SIGKILL')).toBe(0);
    expect(registry.list('missing')).toEqual([]);
  });

  it('isolates handles by key so killAll only touches the requested run', () => {
    const registry = createSubprocessRegistry();
    const killSignalsA: NodeJS.Signals[] = [];
    const killSignalsB: NodeJS.Signals[] = [];
    registry.register('run-a', fakeHandle(killSignalsA));
    registry.register('run-b', fakeHandle(killSignalsB));

    expect(registry.killAll('run-a', 'SIGKILL')).toBe(1);
    expect(killSignalsA).toEqual(['SIGKILL']);
    expect(killSignalsB).toEqual([]);
    expect(registry.list('run-b')).toHaveLength(1);
  });

  it('keeps handles registered after killAll so a later kill reaches them again', () => {
    const registry = createSubprocessRegistry();
    const killSignals: NodeJS.Signals[] = [];
    const handle = fakeHandle(killSignals);
    registry.register('run-1', handle);

    expect(registry.killAll('run-1', 'SIGTERM')).toBe(1);
    expect(registry.list('run-1')).toEqual([handle]);
    expect(registry.killAll('run-1', 'SIGKILL')).toBe(1);
    expect(killSignals).toEqual(['SIGTERM', 'SIGKILL']);
  });
});
