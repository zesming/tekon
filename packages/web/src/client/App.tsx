import { useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { createRoot } from 'react-dom/client';

import './styles.css';

type Overview = {
  project: { id: string; name: string; repoPath: string };
  latestRun: {
    id: string;
    status: string;
    currentNodeId: string | null;
  } | null;
  counts: {
    artifacts: number;
    gates: number;
    audit: number;
    pendingApprovals: number;
    roles: number;
    workflows: number;
  };
};

type Artifact = {
  id: string;
  type: string;
  version: number;
  path: string;
  summary: string | null;
};

type Gate = {
  id: string;
  gateType: string;
  status: string;
  nodeId: string;
};

type Decision = {
  id: string;
  runId: string;
  nodeId: string;
  gateResultId: string | null;
  status: string;
  note: string | null;
  actor: string | null;
  context: {
    request: string;
    exactCommand: string;
    riskLabel: string;
    nodeRole: string | null;
    gate: {
      id: string;
      type: string;
      status: string;
      nodeId: string;
      outputPath: string | null;
      failureClassification: string | null;
    } | null;
  };
};

type AuditEvent = {
  id: string;
  type: string;
  createdAt: string;
  nodeId: string | null;
  gateId: string | null;
  role: string | null;
  hash: string;
};

type AuditVerification =
  | { valid: true }
  | { valid: false; brokenEventId: string };

type RoleInfo = {
  id: string;
  name: string;
};

type WorkflowInfo = {
  id: string;
  name: string;
};

function App() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  const [gates, setGates] = useState<Gate[]>([]);
  const [decisions, setDecisions] = useState<Decision[]>([]);
  const [audit, setAudit] = useState<AuditEvent[]>([]);
  const [auditVerification, setAuditVerification] =
    useState<AuditVerification | null>(null);
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([]);
  const [token, setToken] = useState('');
  const [note, setNote] = useState('');
  const [auditNodeFilter, setAuditNodeFilter] = useState('');
  const [auditGateFilter, setAuditGateFilter] = useState('');
  const [auditRoleFilter, setAuditRoleFilter] = useState('');
  const [message, setMessage] = useState('');

  const runId = overview?.latestRun?.id;
  const pendingDecision = decisions[0];

  const stats = useMemo(
    () => [
      ['Runs', overview?.latestRun ? 1 : 0],
      ['Artifacts', overview?.counts.artifacts ?? 0],
      ['Gates', overview?.counts.gates ?? 0],
      ['Audit', overview?.counts.audit ?? 0],
      ['Pending', overview?.counts.pendingApprovals ?? 0],
    ],
    [overview],
  );

  async function loadDashboard() {
    const overviewResult = await rpc<Overview>('project.overview');
    setOverview(overviewResult);
    const latestRunId = overviewResult.latestRun?.id;
    const [roleResult, workflowResult] = await Promise.all([
      rpc<{ roles: RoleInfo[] }>('role.list'),
      rpc<{ workflows: WorkflowInfo[] }>('workflow.list'),
    ]);
    setRoles(roleResult.roles);
    setWorkflows(workflowResult.workflows);

    if (!latestRunId) {
      setArtifacts([]);
      setGates([]);
      setDecisions([]);
      setAudit([]);
      setAuditVerification(null);
      return;
    }

    const [artifactResult, gateResult, auditResult] = await Promise.all([
      rpc<{ artifacts: Artifact[] }>('artifact.list', { runId: latestRunId }),
      rpc<{ gates: Gate[]; pendingDecisions: Decision[] }>('gate.list', {
        runId: latestRunId,
      }),
      rpc<{ verification: AuditVerification; events: AuditEvent[] }>(
        'audit.list',
        {
          runId: latestRunId,
          nodeId: auditNodeFilter || undefined,
          gateId: auditGateFilter || undefined,
          role: auditRoleFilter || undefined,
        },
      ),
    ]);
    setArtifacts(artifactResult.artifacts);
    setGates(gateResult.gates);
    setDecisions(gateResult.pendingDecisions);
    setAuditVerification(auditResult.verification);
    setAudit(auditResult.events);
  }

  useEffect(() => {
    void loadDashboard().catch((error: unknown) => {
      setMessage(error instanceof Error ? error.message : String(error));
    });
  }, []);

  async function decide(action: 'approve' | 'reject') {
    if (!runId || !pendingDecision) {
      return;
    }

    const result = await rpc<{ decision: Decision }>(`gate.${action}`, {
      runId,
      decisionId: pendingDecision.id,
      actor: 'web',
      note,
      token,
    });
    setMessage(result.decision.status);
    setNote('');
    await loadDashboard();
  }

  return (
    <main className="shell">
      <header className="topbar">
        <div>
          <h1>Donkey Cockpit</h1>
          <p>{overview?.project.repoPath ?? 'Loading project context'}</p>
        </div>
        <div className="run-pill">
          {overview?.latestRun?.status ?? 'loading'}
        </div>
      </header>

      <section className="band">
        <h2>概览</h2>
        <div className="stat-grid">
          {stats.map(([label, value]) => (
            <div className="stat" key={label}>
              <span>{label}</span>
              <strong>{value}</strong>
            </div>
          ))}
        </div>
        <p className="mono">{runId ?? 'no run'}</p>
      </section>

      <section className="band approval">
        <h2>待人工审批</h2>
        {pendingDecision ? (
          <div className="approval-grid">
            <div>
              <p className="mono">{pendingDecision.id}</p>
              <p className="risk-label">
                risk: {pendingDecision.context.riskLabel}
              </p>
              <dl className="context-list">
                <dt>exact command</dt>
                <dd className="mono">{pendingDecision.context.exactCommand}</dd>
                <dt>gate context</dt>
                <dd>
                  {pendingDecision.context.gate
                    ? `${pendingDecision.context.gate.id} ${pendingDecision.context.gate.type} ${pendingDecision.context.gate.status}`
                    : 'not linked'}
                </dd>
                <dt>request context</dt>
                <dd>{pendingDecision.context.request}</dd>
                <dt>role</dt>
                <dd>{pendingDecision.context.nodeRole ?? 'unknown'}</dd>
              </dl>
            </div>
            <label>
              Session token
              <input
                aria-label="Session token"
                value={token}
                onChange={(event) => setToken(event.target.value)}
              />
            </label>
            <label>
              审批备注
              <textarea
                aria-label="审批备注"
                value={note}
                onChange={(event) => setNote(event.target.value)}
              />
            </label>
            <div className="actions">
              <button onClick={() => void decide('approve')}>批准</button>
              <button
                className="secondary"
                onClick={() => void decide('reject')}
              >
                拒绝
              </button>
            </div>
          </div>
        ) : (
          <p>没有待处理人工审批</p>
        )}
        {message ? <p className="status-line">{message}</p> : null}
      </section>

      <section className="dashboard-grid">
        <Panel title="产物">
          {artifacts.map((artifact) => (
            <Row
              key={artifact.id}
              primary={`${artifact.type} v${artifact.version}`}
              secondary={artifact.summary ?? artifact.path}
            />
          ))}
        </Panel>
        <Panel title="Gates">
          {gates.map((gate) => (
            <Row
              key={gate.id}
              primary={`${gate.id} ${gate.status}`}
              secondary={`${gate.gateType} ${gate.nodeId}`}
            />
          ))}
        </Panel>
        <Panel title="审计">
          <div className="audit-filter">
            <label>
              node
              <input
                aria-label="Audit node filter"
                value={auditNodeFilter}
                onChange={(event) => setAuditNodeFilter(event.target.value)}
              />
            </label>
            <label>
              gate
              <input
                aria-label="Audit gate filter"
                value={auditGateFilter}
                onChange={(event) => setAuditGateFilter(event.target.value)}
              />
            </label>
            <label>
              role
              <input
                aria-label="Audit role filter"
                value={auditRoleFilter}
                onChange={(event) => setAuditRoleFilter(event.target.value)}
              />
            </label>
            <button onClick={() => void loadDashboard()}>筛选审计</button>
          </div>
          <p className="status-line">
            Hash chain:{' '}
            {auditVerification
              ? auditVerification.valid
                ? 'valid'
                : `broken at ${auditVerification.brokenEventId}`
              : 'loading'}
          </p>
          {audit.map((event) => (
            <Row
              key={event.id}
              primary={`${event.type} ${event.nodeId ?? ''}`.trim()}
              secondary={`gate=${event.gateId ?? 'none'} role=${event.role ?? 'none'} hash=${event.hash.slice(0, 12)} ${event.createdAt}`}
            />
          ))}
        </Panel>
        <Panel title="角色">
          {roles.map((role) => (
            <Row key={role.id} primary={role.id} secondary={role.name} />
          ))}
        </Panel>
        <Panel title="工作流">
          {workflows.map((workflow) => (
            <Row
              key={workflow.id}
              primary={workflow.id}
              secondary={workflow.name}
            />
          ))}
        </Panel>
        <Panel title="设置">
          <Row
            primary="project"
            secondary={overview?.project.name ?? 'loading'}
          />
          <Row primary="write gate" secondary=".donkey/web-session.json" />
        </Panel>
      </section>
    </main>
  );
}

function Panel(props: { title: string; children: ReactNode }) {
  return (
    <section className="panel">
      <h2>{props.title}</h2>
      <div className="rows">{props.children}</div>
    </section>
  );
}

function Row(props: { primary: string; secondary: string }) {
  return (
    <div className="row">
      <strong>{props.primary}</strong>
      <span>{props.secondary}</span>
    </div>
  );
}

async function rpc<T>(path: string, input?: unknown): Promise<T> {
  const response = await fetch('/api/rpc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, input }),
  });
  const body = (await response.json()) as {
    result?: T;
    error?: { message: string };
  };
  if (!response.ok) {
    throw new Error(body.error?.message ?? `RPC failed: ${path}`);
  }
  return body.result as T;
}

createRoot(document.getElementById('root')!).render(<App />);
