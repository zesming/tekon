import { useState } from 'react';

import { useSessionToken } from '../hooks/use-session-token.js';

type TopBarProps = {
  title?: string;
  subtitle?: string;
};

export function TopBar(props: TopBarProps) {
  const { title = 'Tekon Cockpit', subtitle } = props;
  const { token, setToken } = useSessionToken();
  const [masked, setMasked] = useState(true);

  return (
    <div className="topbar">
      <div>
        <div className="topbar-title">{title}</div>
        {subtitle ? <div className="page-subtitle">{subtitle}</div> : null}
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
          onClick={() => setMasked((prev) => !prev)}
        >
          {masked ? '👁' : '🙈'}
        </button>
      </div>
    </div>
  );
}
