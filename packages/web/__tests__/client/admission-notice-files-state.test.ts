import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { describe, expect, it, vi } from 'vitest';
import { AdmissionNotice, AdmissionReadinessBanner } from '../../src/client/components/runs/AdmissionNotice.js';
import type { AdmissionView, RunAdmission } from '../../src/client/hooks/use-run-admission.js';

function renderNotice(filesState?: 'pending' | 'ready' | 'recovery_required', state: AdmissionView['state'] = 'recovery-required') {
  const admission: RunAdmission = {
    records: [{ state, filesState, scope: 'scope', fingerprint: 'fingerprint', requestId: 'request-files-state' }],
    scopeReady: true, error: null, outcome: null, planExpired: false, checkingId: null, isPending: false, newIntent: false,
    submit: vi.fn(async () => {}), lookup: vi.fn(async () => {}), beginNew: vi.fn(), refreshPlan: vi.fn(), retryScope: vi.fn(async () => {}),
  };
  return renderToStaticMarkup(React.createElement(MemoryRouter, null,
    React.createElement(AdmissionNotice, { admission, refetchPlan: vi.fn() })));
}

describe('admission directory state presentation', () => {
  for (const surface of ['notice', 'banner'] as const) {
    for (const filesState of ['pending', 'recovery_required', undefined] as const) {
      it(`${surface} distinguishes ${filesState ?? 'restored ledger'} without guessing a directory fault`, () => {
        const html = surface === 'notice' ? renderNotice(filesState)
          : renderToStaticMarkup(React.createElement(AdmissionReadinessBanner, { value: { admissionState: 'recovery-required', filesState } }));
        if (filesState === 'recovery_required') {
          expect(html).toContain('已受理，等待目录恢复');
          expect(html).toContain('修复目录');
          expect(html).toContain('重启');
        } else {
          expect(html).toContain(filesState === 'pending' ? '已受理，等待目录就绪' : '已受理，目录状态待确认');
          expect(html).toContain('查询');
          expect(html).not.toContain('修复目录');
          expect(html).not.toContain('重启');
          expect(html).not.toContain('准备失败');
        }
      });
    }
  }
  it('never converts an unknown request into accepted even if old directory metadata remains', () => {
    const html = renderNotice('pending', 'unknown');
    expect(html).toContain('>受理状态待确认</strong>');
    expect(html).not.toContain('>已受理');
    expect(html).not.toContain('修复目录');
  });
});
