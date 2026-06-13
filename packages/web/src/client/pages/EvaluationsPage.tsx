import { NavLink, Outlet } from 'react-router';

export function EvaluationsPage() {
  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">Evaluations</h1>
          <p className="page-subtitle">评估报告</p>
        </div>
      </header>

      <div className="tabs">
        <NavLink
          to="readiness"
          className={({ isActive }) => `tab${isActive ? ' active' : ''}`}
        >
          Readiness
        </NavLink>
        <NavLink
          to="demand-shape"
          className={({ isActive }) => `tab${isActive ? ' active' : ''}`}
        >
          Demand Shape
        </NavLink>
        <NavLink
          to="approval-summary"
          className={({ isActive }) => `tab${isActive ? ' active' : ''}`}
        >
          Approval Summary
        </NavLink>
        <NavLink
          to="workflow-selection"
          className={({ isActive }) => `tab${isActive ? ' active' : ''}`}
        >
          Workflow Selection
        </NavLink>
      </div>

      <Outlet />
    </>
  );
}
