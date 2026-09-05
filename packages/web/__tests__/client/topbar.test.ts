import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

let mockLocation = { pathname: '/runs' };
let mockToken: string | null = null;
let mockHealthData:
  | { credential: 'valid' | 'invalid' | 'not-configured' }
  | undefined = undefined;
let mockProviderHealthData:
  | { provider: 'dsh-headless'; status: 'available' | 'unavailable' }
  | undefined = undefined;
let mockProviderLoading = false;
let mockProviderError: Error | null = null;

vi.mock('react-router', () => ({
  useLocation: () => mockLocation,
}));

vi.mock('../../src/client/hooks/use-session-token.js', () => ({
  useSessionToken: () => ({
    token: mockToken,
    setToken: vi.fn(),
  }),
}));

vi.mock('../../src/client/hooks/use-query.js', () => ({
  useQuery: (key: string | null) => ({
    data: key?.includes('project.providerHealth')
      ? mockProviderHealthData
      : mockHealthData,
    isLoading: key?.includes('project.providerHealth')
      ? mockProviderLoading
      : false,
    error: key?.includes('project.providerHealth') ? mockProviderError : null,
    refetch: vi.fn(),
  }),
}));

import { TopBar } from '../../src/client/layouts/TopBar.js';

describe('TopBar credential status (SUG-2 / P1-HEALTH-01)', () => {
  it('renders not-configured state when token is null', () => {
    mockToken = null;
    mockHealthData = undefined;
    mockProviderHealthData = undefined;

    const html = renderToStaticMarkup(React.createElement(TopBar, {}));
    expect(html).toContain('aria-label="连接凭据：未配置"');
    expect(html).toContain('未配置凭据');
  });

  it('renders checking state when token is present but health has not resolved yet', () => {
    mockToken = 'session-tok-123';
    mockHealthData = undefined;
    mockProviderHealthData = undefined;

    const html = renderToStaticMarkup(React.createElement(TopBar, {}));
    expect(html).toContain('aria-label="连接凭据：校验中"');
    expect(html).toContain('校验中');
    expect(html).toContain('status-dot-checking');
  });

  it('renders valid state when healthData.credential is valid', () => {
    mockToken = 'session-tok-123';
    mockHealthData = { credential: 'valid' };
    mockProviderHealthData = undefined;

    const html = renderToStaticMarkup(React.createElement(TopBar, {}));
    expect(html).toContain('aria-label="连接凭据：有效"');
    expect(html).toContain('凭据有效');
    expect(html).toContain('status-dot-connected');
  });

  it('renders invalid state when healthData.credential is invalid', () => {
    mockToken = 'session-tok-123';
    mockHealthData = { credential: 'invalid' };
    mockProviderHealthData = undefined;

    const html = renderToStaticMarkup(React.createElement(TopBar, {}));
    expect(html).toContain('aria-label="连接凭据：无效"');
    expect(html).toContain('凭据无效');
    expect(html).toContain('status-dot-disconnected');
  });

  it('renders dsh-headless不可用 badge from separate provider health when credentials are valid', () => {
    mockToken = 'session-tok-123';
    mockHealthData = { credential: 'valid' };
    mockProviderHealthData = {
      provider: 'dsh-headless',
      status: 'unavailable',
    };

    const html = renderToStaticMarkup(React.createElement(TopBar, {}));
    expect(html).toContain('dsh-headless不可用');
  });

  it('does not expose stale provider health when credentials are invalid', () => {
    mockToken = 'rotated-session-token';
    mockHealthData = { credential: 'invalid' };
    mockProviderHealthData = {
      provider: 'dsh-headless',
      status: 'unavailable',
    };

    const html = renderToStaticMarkup(React.createElement(TopBar, {}));
    expect(html).not.toContain('dsh-headless不可用');
  });

  it('does not show a previous unavailable result while rechecking or after a check failure', () => {
    mockToken = 'session-valid-token';
    mockHealthData = { credential: 'valid' };
    mockProviderHealthData = {
      provider: 'dsh-headless',
      status: 'unavailable',
    };
    mockProviderLoading = true;
    const checking = renderToStaticMarkup(React.createElement(TopBar, {}));
    expect(checking).toContain('aria-label="连接凭据：有效"');
    expect(checking).not.toContain('dsh-headless不可用');
    mockProviderLoading = false;
    mockProviderError = new Error('secret provider path');
    const failed = renderToStaticMarkup(React.createElement(TopBar, {}));
    expect(failed).toContain('aria-label="连接凭据：有效"');
    expect(failed).not.toContain('dsh-headless不可用');
    expect(failed).not.toContain('secret provider path');
    mockProviderError = null;
  });
});
