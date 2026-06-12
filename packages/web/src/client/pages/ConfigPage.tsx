import { NavLink, Outlet } from 'react-router';

export function ConfigPage() {
  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Config</h1>
          <p className="page-subtitle">系统配置</p>
        </div>
      </header>

      <div className="tabs">
        <NavLink
          to="roles"
          className={({ isActive }) => `tab${isActive ? ' active' : ''}`}
        >
          Roles
        </NavLink>
        <NavLink
          to="workflows"
          className={({ isActive }) => `tab${isActive ? ' active' : ''}`}
        >
          Workflows
        </NavLink>
        <NavLink
          to="constraints"
          className={({ isActive }) => `tab${isActive ? ' active' : ''}`}
        >
          Constraints
        </NavLink>
      </div>

      <Outlet />
    </>
  );
}
