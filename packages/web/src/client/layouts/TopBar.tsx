import { useEffect, useRef, useState, type RefObject } from 'react';
import { useLocation } from 'react-router';

import { useSessionToken } from '../hooks/use-session-token.js';

type TopBarProps = {
  title?: string;
  subtitle?: string;
  navOpen?: boolean;
  onToggleNav?: () => void;
  toggleRef?: RefObject<HTMLButtonElement | null>;
};

const TOKEN_APPLY_DELAY_MS = 350;

export function TopBar(props: TopBarProps) {
  const { pathname } = useLocation();
  const defaultTitle = pathname.startsWith('/advanced')
    ? 'Tekon Cockpit'
    : 'Tekon Workspace';
  const { title = defaultTitle, subtitle, navOpen, onToggleNav, toggleRef } =
    props;
  const { token, setToken } = useSessionToken();
  const [panelOpen, setPanelOpen] = useState(false);
  const [masked, setMasked] = useState(true);
  const [draftToken, setDraftToken] = useState(token ?? '');

  const panelContainerRef = useRef<HTMLDivElement | null>(null);
  const toggleBtnRef = useRef<HTMLButtonElement | null>(null);
  const isTypingRef = useRef(false);

  // Bootstrap/hash/manual changes outside this input stay reflected here.
  useEffect(() => {
    if (!isTypingRef.current) {
      setDraftToken(token ?? '');
    }
  }, [token]);

  // Debounced token application on user keystroke pause
  useEffect(() => {
    if (!isTypingRef.current) return;
    const timer = window.setTimeout(() => {
      setToken(draftToken || null);
      isTypingRef.current = false;
    }, TOKEN_APPLY_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [draftToken, setToken]);

  // Close panel on outside click or Escape key
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

  const isConnected = Boolean(token);

  const handleInputChange = (value: string) => {
    isTypingRef.current = true;
    setDraftToken(value);
  };

  const handleApply = () => {
    isTypingRef.current = false;
    setToken(draftToken || null);
    setPanelOpen(false);
  };

  const handleDisconnect = () => {
    isTypingRef.current = false;
    setDraftToken('');
    setToken(null);
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

      {/* T4: Connection state presentation & management panel */}
      <div className="topbar-connection" ref={panelContainerRef}>
        <button
          ref={toggleBtnRef}
          type="button"
          className={`connection-status-btn ${
            isConnected ? 'connected' : 'disconnected'
          }`}
          aria-expanded={panelOpen}
          aria-controls="topbar-connection-panel"
          aria-label={isConnected ? '连接状态：已连接' : '连接状态：未连接'}
          onClick={() => setPanelOpen((prev) => !prev)}
        >
          <span
            className={`status-dot ${
              isConnected ? 'status-dot-connected' : 'status-dot-disconnected'
            }`}
            aria-hidden="true"
          />
          <span className="connection-status-label">
            {isConnected ? '已连接' : '未连接'}
          </span>
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
          <div
            id="topbar-connection-panel"
            className="connection-panel"
            role="dialog"
            aria-label="连接管理"
          >
            <div className="connection-panel-header">
              <span className="connection-panel-title">会话连接管理</span>
              <button
                type="button"
                className="connection-panel-close"
                aria-label="关闭连接管理面板"
                onClick={() => setPanelOpen(false)}
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
                  id="session-token-input"
                  className="input"
                  type={masked ? 'password' : 'text'}
                  aria-label="Session token"
                  value={draftToken}
                  onChange={(e) => handleInputChange(e.target.value)}
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
            </div>
            <div className="connection-panel-footer">
              {token ? (
                <button
                  type="button"
                  className="btn btn-ghost btn-xs"
                  onClick={handleDisconnect}
                >
                  断开连接
                </button>
              ) : null}
              <button
                type="button"
                className="btn btn-primary btn-xs"
                onClick={handleApply}
              >
                应用连接
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
