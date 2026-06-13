import type { ReactNode } from 'react';
import { NavLink } from 'react-router';

import { routes } from '../lib/route-paths.js';

type NavItem = {
  to: string;
  label: string;
  badge?: number;
  icon: ReactNode;
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

const navGroups: NavGroup[] = [
  {
    label: '',
    items: [
      {
        to: routes.home,
        label: 'Dashboard',
        icon: (
          <svg
            className="nav-icon"
            viewBox="0 0 18 18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <rect x="1" y="1" width="6" height="6" rx="1" />
            <rect x="11" y="1" width="6" height="6" rx="1" />
            <rect x="1" y="11" width="6" height="6" rx="1" />
            <rect x="11" y="11" width="6" height="6" rx="1" />
          </svg>
        ),
      },
    ],
  },
  {
    label: '运行管理 Runs',
    items: [
      {
        to: routes.runs,
        label: '运行列表',
        icon: (
          <svg
            className="nav-icon"
            viewBox="0 0 18 18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M2 4h14M2 9h10M2 14h7" />
            <circle cx="15" cy="14" r="2" />
          </svg>
        ),
      },
      {
        to: routes.approvals,
        label: '审批队列',
        icon: (
          <svg
            className="nav-icon"
            viewBox="0 0 18 18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M9 1l2.5 5 5.5.8-4 3.9.9 5.3L9 13.5 4.1 16l.9-5.3-4-3.9L6.5 6z" />
          </svg>
        ),
      },
    ],
  },
  {
    label: '交付 Delivery',
    items: [
      {
        to: routes.delivery,
        label: '交付管道',
        icon: (
          <svg
            className="nav-icon"
            viewBox="0 0 18 18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M2 9l5 5L16 4" />
          </svg>
        ),
      },
      {
        to: routes.demand,
        label: '需求澄清',
        icon: (
          <svg
            className="nav-icon"
            viewBox="0 0 18 18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M3 2h12a1 1 0 011 1v12a1 1 0 01-1 1H3a1 1 0 01-1-1V3a1 1 0 011-1z" />
            <path d="M6 6h6M6 9h4M6 12h5" />
          </svg>
        ),
      },
    ],
  },
  {
    label: '配置 Config',
    items: [
      {
        to: routes.config,
        label: '角色 & 模板',
        icon: (
          <svg
            className="nav-icon"
            viewBox="0 0 18 18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <circle cx="9" cy="9" r="3" />
            <path d="M9 1v2M9 15v2M1 9h2M15 9h2M3.3 3.3l1.4 1.4M13.3 13.3l1.4 1.4M3.3 14.7l1.4-1.4M13.3 4.7l1.4-1.4" />
          </svg>
        ),
      },
      {
        to: routes.eval,
        label: '评估报告',
        icon: (
          <svg
            className="nav-icon"
            viewBox="0 0 18 18"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            <path d="M2 14l4-8 4 5 3-3 3 6" />
          </svg>
        ),
      },
    ],
  },
];

export function Sidebar() {
  return (
    <aside className="sidebar">
      <div className="sidebar-brand">
        <div className="brand-mark">T</div>
        <div>
          <div className="brand-name">Tekon</div>
          <div className="brand-tag">Cockpit</div>
        </div>
      </div>

      <nav className="sidebar-nav">
        {navGroups.map((group) => (
          <div className="nav-group" key={group.label || 'root'}>
            {group.label ? <div className="nav-label">{group.label}</div> : null}
            {group.items.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.to === routes.home}
                className={({ isActive }) =>
                  `nav-item${isActive ? ' active' : ''}`
                }
              >
                {item.icon}
                {item.label}
                {item.badge !== undefined ? (
                  <span className="nav-badge">{item.badge}</span>
                ) : null}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>

      <div className="sidebar-footer">
        <div className="project-name">tekon</div>
        <div className="project-path">~/Projects/tekon</div>
      </div>
    </aside>
  );
}
