import { createBrowserRouter, useRouteError, useNavigate } from 'react-router';

import { AppLayout } from './layouts/AppLayout.js';

import { DashboardPage } from './pages/DashboardPage.js';
import { RunsPage } from './pages/RunsPage.js';
import { RunDetailPage } from './pages/RunDetailPage.js';
import { OverviewTab } from './pages/run-detail/OverviewTab.js';
import { ArtifactsTab } from './pages/run-detail/ArtifactsTab.js';
import { GatesTab } from './pages/run-detail/GatesTab.js';
import { AuditTab } from './pages/run-detail/AuditTab.js';
import { DeliveryTab } from './pages/run-detail/DeliveryTab.js';
import { ProgressTab } from './pages/run-detail/ProgressTab.js';
import { ApprovalsPage } from './pages/ApprovalsPage.js';
import { DeliveryPage } from './pages/DeliveryPage.js';
import { DemandPage } from './pages/DemandPage.js';
import { ConfigPage } from './pages/ConfigPage.js';
import { RolesTab } from './pages/config/RolesTab.js';
import { WorkflowsTab } from './pages/config/WorkflowsTab.js';
import { ConstraintsTab } from './pages/config/ConstraintsTab.js';
import { EvaluationsPage } from './pages/EvaluationsPage.js';
import { ReadinessTab } from './pages/evaluations/ReadinessTab.js';
import { DemandShapeTab } from './pages/evaluations/DemandShapeTab.js';
import { ApprovalSummaryTab } from './pages/evaluations/ApprovalSummaryTab.js';
import { WorkflowSelectionTab } from './pages/evaluations/WorkflowSelectionTab.js';
import { NotFoundPage } from './pages/NotFoundPage.js';

function RouteError({ scope }: { scope: string }) {
  const error = useRouteError();
  const navigate = useNavigate();
  return (
    <div className="error-page">
      <h2>Something went wrong</h2>
      <p>{error instanceof Error ? error.message : 'Unknown error'}</p>
      <button onClick={() => navigate('/')}>返回 Dashboard</button>
    </div>
  );
}

export const router = createBrowserRouter([
  {
    element: <AppLayout />,
    errorElement: <RouteError scope="app" />,
    children: [
      { index: true, element: <DashboardPage /> },
      { path: 'runs', element: <RunsPage /> },
      {
        path: 'runs/:runId',
        element: <RunDetailPage />,
        errorElement: <RouteError scope="run-detail" />,
        children: [
          { index: true, element: <OverviewTab /> },
          { path: 'review', element: <OverviewTab /> },
          { path: 'artifacts', element: <ArtifactsTab /> },
          { path: 'gates', element: <GatesTab /> },
          { path: 'audit', element: <AuditTab /> },
          { path: 'delivery', element: <DeliveryTab /> },
          { path: 'progress', element: <ProgressTab /> },
        ],
      },
      { path: 'approvals', element: <ApprovalsPage /> },
      { path: 'delivery', element: <DeliveryPage /> },
      { path: 'demand', element: <DemandPage /> },
      {
        path: 'config',
        element: <ConfigPage />,
        children: [
          { index: true, element: <RolesTab /> },
          { path: 'roles', element: <RolesTab /> },
          { path: 'workflows', element: <WorkflowsTab /> },
          { path: 'constraints', element: <ConstraintsTab /> },
        ],
      },
      {
        path: 'eval',
        element: <EvaluationsPage />,
        children: [
          { index: true, element: <ReadinessTab /> },
          { path: 'readiness', element: <ReadinessTab /> },
          { path: 'demand-shape', element: <DemandShapeTab /> },
          { path: 'approval-summary', element: <ApprovalSummaryTab /> },
          { path: 'workflow-selection', element: <WorkflowSelectionTab /> },
        ],
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
]);
