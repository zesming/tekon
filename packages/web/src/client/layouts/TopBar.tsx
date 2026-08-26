import { useState, type RefObject } from 'react';
import { useLocation } from 'react-router';

import { useSessionToken } from '../hooks/use-session-token.js';

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
  const [masked, setMasked] = useState(true);

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
      <div className="topbar-token">
        <input
          className="input"
          type={masked ? 'password' : 'text'}
          aria-label="Session token"
          value={token ?? ''}
          onChange={(e) => setToken(e.target.value || null)}
          placeholder="Session token"
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
  );
}
