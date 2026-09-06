import type { ReactElement } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
const ports = vi.hoisted(() => ({ call: vi.fn(), flash: vi.fn(), invalidate: vi.fn(), refetch: vi.fn(), checked: false }));
vi.mock('react', async original => ({ ...await original<typeof import('react')>(), useState: (initial: unknown) => [initial, vi.fn()], useCallback: (fn: unknown) => fn, useMemo: (fn: () => unknown) => fn(), useRef: () => ({ current: null }) }));
const recovery = { runStatus: 'interrupted', cancelRecovery: null, resumeRecovery: { previousJobId: 'previous-job', requiresConfirmation: true } };
vi.mock('../../src/client/hooks/index.js', () => ({
  useAuthScope: () => 'scope', useSessionToken: () => ({ token: 'token' }),
  useQuery: (key: string) => ({ data: key?.startsWith('project.') ? { latestRun: { id: 'run_1', recovery } } : { pendingDecisions: [{ id: 'decision_1' }] }, refetch: ports.refetch }),
  useMutation: (mutate: unknown) => ({ mutate, isPending: false }),
}));
vi.mock('../../src/client/context/auth-context.js', () => ({ useAuth: () => ({ token: 'token' }) }));
vi.mock('../../src/client/context/flash-context.js', () => ({ useFlash: () => ({ addFlash: ports.flash }) }));
vi.mock('../../src/client/lib/rpc-client.js', () => ({ rpc: { call: ports.call } }));
vi.mock('../../src/client/lib/query-cache.js', () => ({ queryCache: { invalidate: ports.invalidate } }));
vi.mock('../../src/client/hooks/use-resume-confirmation.js', () => ({ useResumeConfirmation: () => ({ required: true, confirmed: ports.checked, setConfirmed: vi.fn(), input: ports.checked ? { confirmStopped: true, previousJobId: 'previous-job' } : {} }) }));
import { ApprovalsPage } from '../../src/client/pages/ApprovalsPage.js';
import { SessionSidePanel } from '../../src/client/components/sessions/SessionSidePanel.js';
import { DecisionCard } from '../../src/client/components/approvals/DecisionCard.js';
function decision(tree: unknown): ReactElement<{ onApprove: (id: string, note: string) => Promise<void> }> {
  if (Array.isArray(tree)) { for (const child of tree) { const found = find(child); if (found) return found; } }
  const result = find(tree); if (!result) throw new Error('decision missing'); return result;
}
function find(tree: unknown): ReturnType<typeof decision> | undefined {
  if (!tree || typeof tree !== 'object') return;
  if (Array.isArray(tree)) { for (const child of tree) { const found = find(child); if (found) return found; } return; }
  const node = tree as ReactElement<{ children?: unknown; onApprove?: (id: string, note: string) => Promise<void> }>;
  if (node.type === DecisionCard && typeof node.props.onApprove === 'function') return node as ReturnType<typeof decision>;
  return find(node.props?.children);
}
beforeEach(() => { vi.clearAllMocks(); ports.checked = false; });
for (const entry of ['page', 'session']) {
  const render = () => entry === 'page' ? ApprovalsPage() : SessionSidePanel({ state: { runId: 'run_1', runStatus: 'interrupted', hasPendingApproval: true, pendingDecisionIds: ['decision_1'], cards: [] }, recovery, runStatus: 'interrupted' });
  it(`R26 ${entry} prevents approval without old-job confirmation`, async () => {
    await decision(render()).props.onApprove('decision_1', 'note');
    expect(ports.call).not.toHaveBeenCalled();
  });
  it(`R26 ${entry} sends bound confirmation and reports recorded approval without claiming resumed`, async () => {
    ports.checked = true;
    ports.call.mockResolvedValue({ decision: { id: 'decision_1' }, resumeOutcome: 'not-enqueued', resumeMessage: '新一代执行已变化，请核对', recovery });
    await decision(render()).props.onApprove('decision_1', 'note');
    expect(ports.call).toHaveBeenCalledWith('gate.approve', expect.objectContaining({ runId: 'run_1', confirmStopped: true, previousJobId: 'previous-job' }));
    expect(ports.flash).toHaveBeenCalledWith('warning', expect.stringContaining('审批已记录，运行尚未恢复'));
    expect(ports.flash.mock.calls[0][1]).toContain('新一代执行已变化');
    expect(ports.invalidate).toHaveBeenCalledWith('session.detail.');
  });
}
