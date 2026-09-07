import { createElement, type ReactElement, type MouseEvent } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const ports = vi.hoisted(() => ({ call: vi.fn(), flash: vi.fn(), invalidate: vi.fn(), navigate: vi.fn(), states: [] as unknown[], index: 0 }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(),
  useState: (initial: unknown) => [ports.states[ports.index++] ?? initial, vi.fn()],
  useEffect: () => {}, useRef: () => ({ current: null }),
}));
vi.mock('react-router', () => ({ useNavigate: () => ports.navigate }));
vi.mock('../../src/client/hooks/index.js', () => ({ useMutation: (mutate: unknown) => ({ mutate, isPending: false }) }));
vi.mock('../../src/client/hooks/use-session-token.js', () => ({ useSessionToken: () => ({ token: 'token' }) }));
vi.mock('../../src/client/context/flash-context.js', () => ({ useFlash: () => ({ addFlash: ports.flash, messages: [], removeFlash: vi.fn() }) }));
vi.mock('../../src/client/lib/rpc-client.js', () => ({ rpc: { call: ports.call } }));
vi.mock('../../src/client/lib/query-cache.js', () => ({ queryCache: { invalidate: ports.invalidate } }));
import { RunControls, type RunControlsProps } from '../../src/client/components/runs/RunControls.js';
import { RunTable, type ApiWorkflow } from '../../src/client/components/runs/RunTable.js';
import { FlashMessages } from '../../src/client/components/ui/FlashMessages.js';
const recovery = { runStatus: 'cancelled', cancelRecovery: { needsControlRetry: true, needsObservationRepair: true, jobId: 'job-original', exitStatus: 'unconfirmed' as const }, resumeRecovery: null };
function render(props: Partial<RunControlsProps> = {}) {
  ports.index = 0;
  return RunControls({ runId: 'original-run', status: 'cancelled', ...props });
}
function button(tree: ReactElement | null, label: string): ReactElement<{ onClick: (e: MouseEvent) => Promise<void>; disabled: boolean }> {
  const found = (tree?.props as {children: ReactElement[]}).children.find(child => child && child.props && (child.props as Record<string, unknown>)['aria-label'] === label);
  if (!found) throw new Error(`missing button ${label}`);
  return found as ReturnType<typeof button>;
}
beforeEach(() => { vi.clearAllMocks(); ports.states = []; ports.index = 0; });
describe('R26 persistent recovery controls', () => {
  it('offers same-run cancellation retry on a freshly mounted cancelled snapshot', async () => {
    ports.call.mockResolvedValue({ run: { status: 'cancelled' } });
    await button(render({ recovery }), '重试取消运行').props.onClick({ stopPropagation() {} } as MouseEvent);
    expect(ports.call).toHaveBeenCalledWith('project.cancel', { runId: 'original-run', token: 'token' });
    const html = renderToStaticMarkup(render({ recovery })!);
    expect(html).toContain('退出未确认');
    expect(html).toContain('取消控制待重试');
  });
  it('refreshes observation after failed delivery and keeps a persistent error', async () => {
    ports.call.mockRejectedValue(new Error('control unavailable'));
    await button(render({ recovery }), '重试取消运行').props.onClick({ stopPropagation() {} } as MouseEvent);
    for (const key of ['review.', 'session.detail.', 'session.list.', 'project.overview']) expect(ports.invalidate).toHaveBeenCalledWith(key);
    ports.states = [null, 'control unavailable'];
    expect(renderToStaticMarkup(render({ recovery })!)).toContain('control unavailable');
  });
  it.each(['passed', 'failed'])('never retries cancellation for a %s winner', status => {
    expect(renderToStaticMarkup(render({ status, recovery })!)).not.toContain('重试取消运行');
  });
  it('treats missing recovery as unknown, not confirmed exit', () => {
    expect(renderToStaticMarkup(render()!)).toContain('恢复信息未知');
    expect(renderToStaticMarkup(render()!)).not.toContain('已确认退出');
  });
  it.each(['old-job', null])('requires explicit confirmation bound to previous job %s', async previousJobId => {
    const props = { status: 'interrupted', recovery: { runStatus: 'interrupted', cancelRecovery: null, resumeRecovery: { previousJobId, requiresConfirmation: true } } };
    expect(button(render(props), '恢复运行').props.disabled).toBe(true);
    ports.states = [null, null, { runId: 'original-run', previousJobId }];
    ports.call.mockResolvedValue({ run: { status: 'running' } });
    await button(render(props), '恢复运行').props.onClick({ stopPropagation() {} } as MouseEvent);
    expect(ports.call).toHaveBeenCalledWith('project.resume', { runId: 'original-run', token: 'token', confirmStopped: true, previousJobId });
  });
  it('does not reuse confirmation after job generation changes', () => {
    ports.states = [null, null, { runId: 'original-run', previousJobId: 'old-job' }];
    expect(button(render({ status: 'interrupted', recovery: { runStatus: 'interrupted', cancelRecovery: null, resumeRecovery: { previousJobId: 'new-job', requiresConfirmation: true } } }), '恢复运行').props.disabled).toBe(true);
  });
  it('mounts separate empty notification regions before messages exist', () => {
    const html = renderToStaticMarkup(createElement(FlashMessages));
    expect(html).toContain('role="status"');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('aria-live');
  });
});

it.each(['cancelled', null])('R26 table uses authoritative recovery status %s instead of stale running', runStatus => {
  const run: ApiWorkflow = { id: 'original-run', status: 'running', projectId: 'project', demandId: 'demand', demandTitle: '需求', provider: null, currentNodeId: null, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', recovery: { ...recovery, runStatus } };
  const html = renderToStaticMarkup(createElement(RunTable, { runs: [run] }));
  expect(html).not.toContain('暂停运行');
  expect(html).toContain(runStatus ?? 'unknown');
  if (runStatus) expect(html).toContain('重试取消运行');
});

it.each(['pending', 'recovery_required'] as const)('R26 observes the original run when admission files are %s', filesState => {
  const run: ApiWorkflow = { id: 'original-run', status: 'running', projectId: 'project', demandId: 'demand', demandTitle: '需求', provider: null, currentNodeId: null, createdAt: '2026-09-01T00:00:00Z', updatedAt: '2026-09-01T00:00:00Z', admissionState: 'recovery-required', filesState };
  type Node = ReactElement<{ children?: unknown; onClick?: (event: MouseEvent) => void }>;
  const findObserve = (tree: unknown): Node | undefined => {
    if (Array.isArray(tree)) return tree.map(findObserve).find(Boolean);
    if (!tree || typeof tree !== 'object') return;
    const node = tree as Node;
    if (node.type === 'button' && node.props.children === '观察') return node;
    return findObserve(node.props?.children);
  };
  const observe = findObserve(RunTable({ runs: [run] }));
  expect(observe).toBeDefined();
  // 最小 Element 端口复现点击 button 时 closest 命中自身的浏览器行为。
  class ButtonElement { closest() { return this; } }
  vi.stubGlobal('Element', ButtonElement);
  const stopPropagation = vi.fn();
  try {
    observe!.props.onClick!({ target: new ButtonElement(), stopPropagation } as unknown as MouseEvent);
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(ports.navigate).toHaveBeenCalledExactlyOnceWith('/advanced/runs/original-run');
  } finally { vi.unstubAllGlobals(); }
});
