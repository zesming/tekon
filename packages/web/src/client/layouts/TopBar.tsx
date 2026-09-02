import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type RefObject,
} from 'react';
import { useLocation } from 'react-router';

import { useSessionToken } from '../hooks/use-session-token.js';
import { useQuery } from '../hooks/use-query.js';
import { authScope, queryKeys } from '../lib/query-keys.js';
import { rpc } from '../lib/rpc-client.js';
import type { RpcProcedureMap } from '../../shared/rpc-contract.js';

type TopBarProps = {
  title?: string;
  subtitle?: string;
  navOpen?: boolean;
  onToggleNav?: () => void;
  toggleRef?: RefObject<HTMLButtonElement | null>;
};

export function TopBar(props: TopBarProps) {
  const { pathname } = useLocation();
  const defaultTitle = pathname.startsWith('/advanced')
    ? 'Tekon Cockpit'
    : 'Tekon Workspace';
  const { title = defaultTitle, subtitle, navOpen, onToggleNav, toggleRef } =
    props;
  const { token, setToken } = useSessionToken();
  const scope = authScope(token);
  const [panelOpen, setPanelOpen] = useState(false);
  const [masked, setMasked] = useState(true);
  const [draftToken, setDraftToken] = useState(token ?? '');

  const panelContainerRef = useRef<HTMLDivElement | null>(null);
  const toggleBtnRef = useRef<HTMLButtonElement | null>(null);
  const tokenInputRef = useRef<HTMLInputElement | null>(null);

  // External bootstrap/hash changes stay reflected while the editor is closed.
  // Typing is deliberately draft-only: credentials become active only after
  // the explicit Apply action, so partial tokens cannot churn auth/cache/SSE.
  useEffect(() => {
    if (!panelOpen) {
      setDraftToken(token ?? '');
    }
  }, [panelOpen, token]);

  useEffect(() => {
    if (!panelOpen) return;
    const frame = window.requestAnimationFrame(() => {
      tokenInputRef.current?.focus();
    });
    return () => window.cancelAnimationFrame(frame);
  }, [panelOpen]);

  // Close panel on outside click or Escape key.
  useEffect(() => {
    if (!panelOpen) return;

    function handleClickOutside(event: MouseEvent) {
      if (
        panelContainerRef.current &&
        !panelContainerRef.current.contains(event.target as Node)
      ) {
        setPanelOpen(false);
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setPanelOpen(false);
        toggleBtnRef.current?.focus();
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [panelOpen]);

  // P1-UX-02: consume project.health to show truthful credential status. The
  // cache key uses the auth scope instead of embedding the raw credential.
  const {
    data: healthData,
    error: healthError,
    refetch: refetchHealth,
  } = useQuery<RpcProcedureMap['project.health']['output']>(
    token ? queryKeys.projectHealth(scope) : null,
    () => rpc.call('project.health', { token: token ?? undefined }),
  );

  // Health is operational state, not a one-time bootstrap fact. Refresh it so
  // an expired/rotated server credential or provider installation is reflected
  // without requiring a page reload.
  useEffect(() => {
    if (!token) return;
    const timer = window.setInterval(refetchHealth, 60_000);
    return () => window.clearInterval(timer);
  }, [refetchHealth, token]);

  const credentialStatus:
    | 'not-configured'
    | 'checking'
    | 'valid'
    | 'invalid'
    | 'unavailable' = !token
    ? 'not-configured'
    : healthError
      ? 'unavailable'
      : healthData?.credential ?? 'checking';

  const statusLabel =
    credentialStatus === 'valid'
      ? '凭据有效'
      : credentialStatus === 'invalid'
        ? '凭据无效'
        : credentialStatus === 'unavailable'
          ? '校验失败'
          : credentialStatus === 'checking'
            ? '校验中'
            : '未配置凭据';

  const statusAccessibleName =
    credentialStatus === 'valid'
      ? '连接凭据：有效'
      : credentialStatus === 'invalid'
        ? '连接凭据：无效'
        : credentialStatus === 'unavailable'
          ? '连接凭据：校验失败'
          : credentialStatus === 'checking'
            ? '连接凭据：校验中'
            : '连接凭据：未配置';

  const openPanel = () => {
    setDraftToken(token ?? '');
    setMasked(true);
    setPanelOpen(true);
  };

  const closePanel = (restoreFocus = false) => {
    setPanelOpen(false);
    if (restoreFocus) {
      window.requestAnimationFrame(() => toggleBtnRef.current?.focus());
    }
  };

  const handleApply = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!draftToken) return;
    setToken(draftToken);
    closePanel(true);
  };

  const handleDisconnect = () => {
    setDraftToken('');
    setToken(null);
    window.requestAnimationFrame(() => tokenInputRef.current?.focus());
  };

  return (
    <div className="topbar">
      <div className="topbar-lead">
        {onToggleNav ? (
          <button
            ref={toggleRef}
            type="button"
            className="nav-toggle"
            aria-expanded={navOpen ?? false}
            aria-controls="app-sidebar"
            aria-label={navOpen ? '关闭导航' : '打开导航'}
            onClick={onToggleNav}
          >
            <span aria-hidden="true">☰</span>
          </button>
        ) : null}
        <div>
          <div className="topbar-title">{title}</div>
          {subtitle ? <div className="page-subtitle">{subtitle}</div> : null}
        </div>
      </div>

      <div className="topbar-connection" ref={panelContainerRef}>
        <button
          ref={toggleBtnRef}
          type="button"
          className={`connection-status-btn ${
            credentialStatus === 'valid'
              ? 'connected'
              : credentialStatus === 'invalid'
                ? 'disconnected invalid'
                : credentialStatus === 'checking'
                  ? 'disconnected checking'
                  : credentialStatus === 'unavailable'
                    ? 'disconnected unavailable'
                    : 'disconnected'
          }`}
          aria-expanded={panelOpen}
          aria-controls="topbar-connection-panel"
          aria-label={statusAccessibleName}
          title={
            credentialStatus === 'unavailable'
              ? (healthError?.message ?? '无法完成连接校验')
              : undefined
          }
          onClick={() => {
            if (panelOpen) closePanel(false);
            else openPanel();
          }}
        >
          <span
            className={`status-dot ${
              credentialStatus === 'valid'
                ? 'status-dot-connected'
                : credentialStatus === 'checking'
                  ? 'status-dot-checking'
                  : 'status-dot-disconnected'
            }`}
            aria-hidden="true"
          />
          <span className="connection-status-label">{statusLabel}</span>
          {healthData?.dshHeadless === 'unavailable' &&
          credentialStatus === 'valid' ? (
            <span
              className="text-muted text-xs ml-1"
              title={
                healthData.dshHeadlessDetail ?? 'dsh-headless 当前不可用'
              }
            >
              (dsh-headless不可用)
            </span>
          ) : null}
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            aria-hidden="true"
            style={{
              transform: panelOpen ? 'rotate(180deg)' : 'none',
              transition: 'transform 0.15s ease',
            }}
          >
            <path d="M3 4.5l3 3 3-3" />
          </svg>
        </button>

        {panelOpen && (
          <form
            id="topbar-connection-panel"
            className="connection-panel"
            role="dialog"
            aria-label="连接管理"
            onSubmit={handleApply}
          >
            <div className="connection-panel-header">
              <span className="connection-panel-title">连接凭据管理</span>
              <button
                type="button"
                className="connection-panel-close"
                aria-label="关闭连接管理面板"
                onClick={() => closePanel(true)}
              >
                ×
              </button>
            </div>
            <div className="connection-panel-body">
              <label
                className="form-label"
                htmlFor="session-token-input"
                style={{ fontSize: '11px', color: 'var(--text-s)' }}
              >
                会话令牌 (Session token)
              </label>
              <div className="topbar-token">
                <input
                  ref={tokenInputRef}
                  id="session-token-input"
                  className="input"
                  type={masked ? 'password' : 'text'}
                  value={draftToken}
                  onChange={(e) => setDraftToken(e.target.value)}
                  placeholder="输入 Session token"
                  autoComplete="off"
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="btn btn-ghost btn-sm"
                  title={masked ? '显示会话令牌' : '隐藏会话令牌'}
                  aria-label={masked ? '显示会话令牌' : '隐藏会话令牌'}
                  aria-pressed={!masked}
                  onClick={() => setMasked((prev) => !prev)}
                >
                  {masked ? '👁' : '🙈'}
                </button>
              </div>
              <p className="text-muted" style={{ fontSize: 11, marginTop: 6 }}>
                编辑内容只保存在当前面板；点击“应用连接”后才会切换活动凭据。
              </p>
            </div>
            <div className="connection-panel-footer">
              {token ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  onClick={handleDisconnect}
                >
                  清除凭据
                </button>
              ) : null}
              <button
                type="submit"
                className="btn btn-primary btn-xs"
                disabled={!draftToken}
              >
                应用连接
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
