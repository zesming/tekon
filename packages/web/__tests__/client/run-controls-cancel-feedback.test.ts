import type { ReactElement, MouseEvent } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { call, flash } = vi.hoisted(() => ({ call: vi.fn(), flash: vi.fn() }));
// Exercise the actual component's confirmed-cancel handler. Hook ports are
// controlled; this checks response semantics, not DOM focus or rendering.
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState: () => ['cancel', vi.fn()],
  useEffect: () => {},
  useRef: () => ({ current: null }),
}));
vi.mock('../../src/client/hooks/index.js', () => ({
  useMutation: (mutation: (input: unknown) => Promise<unknown>) => ({ mutate: mutation, isPending: false }),
}));
vi.mock('../../src/client/hooks/use-session-token.js', () => ({ useSessionToken: () => ({ token: 'fixture-token' }) }));
vi.mock('../../src/client/context/flash-context.js', () => ({ useFlash: () => ({ addFlash: flash }) }));
vi.mock('../../src/client/lib/rpc-client.js', () => ({ rpc: { call } }));

import { RunControls } from '../../src/client/components/runs/RunControls.js';

async function confirmCancel() {
  const element = RunControls({ runId: 'run-test-123', status: 'running' });
  const children = element!.props.children as Array<ReactElement<{ 'aria-label'?: string; onClick: (event: MouseEvent) => Promise<void> }> | false>;
  const button = children.find(child => child && child.props['aria-label'] === '确认取消运行');
  if (!button) throw new Error('Confirmed cancellation control is missing');
  await button.props.onClick({ stopPropagation() {} } as MouseEvent);
}

beforeEach(() => { vi.clearAllMocks(); });

describe('cancel notification follows the returned run, not HTTP success alone', () => {
  it.each(['passed', 'failed'] as const)('does not announce cancelled when %s wins the terminal race', async status => {
    call.mockResolvedValue({ run: { id: 'run-test-123', status } });
    await confirmCancel();
    expect(call).toHaveBeenCalledWith('project.cancel', { runId: 'run-test-123', token: 'fixture-token' });
    expect(flash).toHaveBeenCalledWith('info', expect.stringContaining(status === 'passed' ? '已完成' : '已失败'));
    expect(flash.mock.calls[0][1]).toContain('未改为取消');
  });

  it('acknowledges cancellation without claiming that all background processes exited', async () => {
    call.mockResolvedValue({ run: { id: 'run-test-123', status: 'cancelled' } });
    await confirmCancel();
    expect(flash).toHaveBeenCalledWith('success', expect.stringContaining('已记录取消'));
    expect(flash.mock.calls[0][1]).toContain('不代表所有后台进程已退出');
  });

  it('does not fabricate a terminal state for an unexpected response status', async () => {
    call.mockResolvedValue({ run: { id: 'run-test-123', status: 'running' } });
    await confirmCancel();
    expect(flash).toHaveBeenCalledWith('info', expect.stringContaining('核对最新运行状态'));
  });

  it('preserves the existing RPC error path', async () => {
    call.mockRejectedValue(new Error('Cancellation unavailable'));
    await confirmCancel();
    expect(flash).toHaveBeenCalledWith('error', 'Cancellation unavailable');
  });
});
