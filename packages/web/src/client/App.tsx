import { createBrowserRouter, useRouteError, useNavigate, Navigate } from 'react-router';
import { WorkbenchPage } from './pages/WorkbenchPage.js';

function RouteError() {
  const error = useRouteError();
  const navigate = useNavigate();
  return (
    <div style={{ padding: 32, fontFamily: 'var(--font-sans)' }}>
      <h2 style={{ marginBottom: 8 }}>页面加载异常</h2>
      <p style={{ color: 'var(--text-s)', marginBottom: 16 }}>
        {error instanceof Error ? error.message : '未知错误'}
      </p>
      <button type="button" className="wb-btn wb-btn-primary" onClick={() => navigate('/')}>
        返回工作台
      </button>
    </div>
  );
}

export const router = createBrowserRouter([
  {
    path: '/',
    element: <WorkbenchPage />,
    errorElement: <RouteError />,
  },
  {
    path: '/tasks/:runId',
    element: <WorkbenchPage />,
    errorElement: <RouteError />,
  },
  {
    path: '/settings',
    element: <Navigate to="/settings/workflows" replace />,
  },
  {
    path: '/settings/:tab',
    element: <WorkbenchPage />,
    errorElement: <RouteError />,
  },
  // Legacy routes redirect cleanly to the unified workbench
  {
    path: '/sessions/*',
    element: <Navigate to="/" replace />,
  },
  {
    path: '/advanced/*',
    element: <Navigate to="/" replace />,
  },
  {
    path: '/advanced',
    element: <Navigate to="/" replace />,
  },
  {
    path: '*',
    element: <Navigate to="/" replace />,
  },
]);
