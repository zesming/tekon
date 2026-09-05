import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
let mockSurface: {
  workflowStatus: string;
  provider: string;
  demand: { id: string; title: string; body: string };
  gates: never[];
  admissionState?: 'accepted' | 'recovery-required';
  filesState?: 'pending' | 'ready' | 'recovery_required';
} = {
  workflowStatus: 'passed',
  provider: 'mock',
  demand: { id: 'demand', title: '需恢复的详情', body: '' },
  gates: [],
};
vi.mock('../../src/client/hooks/index.js', () => ({
  useQuery: () => ({
    data: mockSurface,
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  }),
  useAuthScope: () => 'auth-test',
}));
vi.mock('react-router', () => ({
  useNavigate: () => vi.fn(),
  useParams: () => ({ runId: 'run-unready' }),
  Outlet: () => React.createElement('div', null, 'executed-run-overview'),
  NavLink: ({ children }: { children: React.ReactNode }) =>
    React.createElement('a', null, children),
  Link: ({ children }: { children: React.ReactNode }) =>
    React.createElement('a', null, children),
}));
vi.mock('../../src/client/components/runs/RunControls.js', () => ({
  RunControls: () => React.createElement('span', null, 'active-run-controls'),
}));
import {
  RunTable,
  type ApiWorkflow,
} from '../../src/client/components/runs/RunTable.js';
import { AdmissionReadinessBanner } from '../../src/client/components/runs/AdmissionNotice.js';
import { RunDetailPage } from '../../src/client/pages/RunDetailPage.js';

const run: ApiWorkflow = {
  id: 'run-unready',
  projectId: 'project',
  demandId: 'demand',
  demandTitle: '尚未执行的任务',
  provider: 'mock',
  status: 'running',
  currentNodeId: null,
  createdAt: '2026-09-05T00:00:00Z',
  updatedAt: '2026-09-05T00:00:00Z',
};
describe('admission readiness presentation', () => {
  for (const filesState of ['pending', 'recovery_required'] as const) {
    it(`Run detail ${filesState} hides execution controls and success views until directories are ready`, () => {
      mockSurface = {
        ...mockSurface,
        admissionState: 'recovery-required',
        filesState,
      };
      const html = renderToStaticMarkup(React.createElement(RunDetailPage));
      expect(html).toContain(
        filesState === 'pending' ? '等待目录就绪' : '创建失败需恢复',
      );
      expect(html).toContain('任务尚未执行');
      expect(html).not.toContain('active-run-controls');
      expect(html).not.toContain('executed-run-overview');
      expect(html).not.toContain('badge-passed');
    });
  }
  it('Run detail resumes its normal controls and content when ready', () => {
    mockSurface = {
      ...mockSurface,
      admissionState: 'accepted',
      filesState: 'ready',
    };
    const html = renderToStaticMarkup(React.createElement(RunDetailPage));
    expect(html).toContain('active-run-controls');
    expect(html).toContain('executed-run-overview');
    expect(html).not.toContain('任务尚未执行');
  });
  for (const filesState of ['pending', 'recovery_required'] as const) {
    it(`${filesState} never appears as an executing run or offers active controls`, () => {
      const html = renderToStaticMarkup(
        React.createElement(RunTable, {
          runs: [{ ...run, admissionState: 'recovery-required', filesState }],
        }),
      );
      expect(html).toContain(
        filesState === 'pending' ? '等待目录就绪' : '创建失败需恢复',
      );
      expect(html).not.toContain('active-run-controls');
      expect(html).not.toContain('badge-running');
      expect(html).toContain('观察');
    });
  }
  it('preserves normal and historical status presentation', () => {
    const html = renderToStaticMarkup(
      React.createElement(RunTable, { runs: [run] }),
    );
    expect(html).toContain('badge-running');
    expect(html).toContain('active-run-controls');
  });
  it('tells users an unready admission is accepted but has not executed', () => {
    const html = renderToStaticMarkup(
      React.createElement(AdmissionReadinessBanner, {
        value: { filesState: 'recovery_required' },
      }),
    );
    expect(html).toContain('请求已受理');
    expect(html).toContain('任务尚未执行');
    expect(html).toContain('原请求重试');
  });
});
