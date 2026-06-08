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

type TextPreview = {
  path: string;
  exists: boolean;
  content: string;
  truncated: boolean;
  sizeBytes: number;
};

type ReadinessCheck = {
  id: string;
  severity: string;
  passed: boolean;
  evidence: string;
};

type ReviewSurface = {
  readiness: {
    ready: boolean;
    score: number;
    checks: ReadinessCheck[];
  };
  artifacts: Array<Artifact & { content: TextPreview }>;
  gates: Array<Gate & { output: TextPreview | null }>;
  delivery: {
    status: string;
    prUrl: string | null;
    package: TextPreview | null;
    prBody: TextPreview | null;
    diff: {
      available: boolean;
      branch: string;
      baseBranch: string;
      stat: string;
      changedFiles: string[];
      reason?: string;
    };
  };
  nextCommands: string[];
};

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
  const [review, setReview] = useState<ReviewSurface | null>(null);
  const [roles, setRoles] = useState<RoleInfo[]>([]);
  const [workflows, setWorkflows] = useState<WorkflowInfo[]>([]);
  const [token, setToken] = useState('');
  const [note, setNote] = useState('');
  const [demandText, setDemandText] = useState('');
  const [runTemplate, setRunTemplate] = useState('standard-feature');
  const [runAgent, setRunAgent] = useState('mock');
  const [allowDirtyBase, setAllowDirtyBase] = useState(false);
  const [auditNodeFilter, setAuditNodeFilter] = useState('');
  const [auditGateFilter, setAuditGateFilter] = useState('');
  const [auditRoleFilter, setAuditRoleFilter] = useState('');
  const [message, setMessage] = useState('');

  const runId = overview?.latestRun?.id;
  const pendingDecision = decisions[0];
  const workflowOptions = useMemo(() => {
    const options = new Map<string, string>([
      ['standard-feature', 'standard-feature'],
      ['bugfix', 'bugfix'],
    ]);
    for (const workflow of workflows) {
      options.set(workflow.id, workflow.id);
    }
    return [...options.values()];
  }, [workflows]);

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
      setReview(null);
      return;
    }

    const [artifactResult, gateResult, auditResult, reviewResult] =
      await Promise.all([
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
        rpc<ReviewSurface>('review.get', {
          runId: latestRunId,
          maxContentChars: 1_600,
        }),
      ]);
    setArtifacts(artifactResult.artifacts);
    setGates(gateResult.gates);
    setDecisions(gateResult.pendingDecisions);
    setAuditVerification(auditResult.verification);
    setAudit(auditResult.events);
    setReview(reviewResult);
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

  async function runAction(action: () => Promise<void>) {
    try {
      await action();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      await loadDashboard().catch(() => undefined);
    }
  }

  async function startRun() {
    const result = await rpc<{
      run: { id: string; status: string; currentNodeId: string | null };
    }>('project.run', {
      demandText,
      template: runTemplate,
      agent: runAgent,
      allowDirtyBase,
      token,
    });
    setMessage(`run started: ${result.run.id} ${result.run.status}`);
    setDemandText('');
    await loadDashboard();
  }

  async function prepareDelivery() {
    if (!runId) {
      return;
    }
    const result = await rpc<{
      branch: string;
      baseBranch: string;
      packagePath: string;
      prBodyPath: string;
    }>('delivery.prepare', { runId, token });
    setMessage(`PR prepared: ${result.branch} -> ${result.baseBranch}`);
    await loadDashboard();
  }

  async function createPr() {
    if (!runId) {
      return;
    }
    const result = await rpc<{
      deliveryStatus: string;
      prUrl: string | null;
      failureStage: string | null;
    }>('delivery.createPr', { runId, token, approveHuman: true });
    setMessage(
      `PR ${result.deliveryStatus}: ${
        result.prUrl ?? result.failureStage ?? 'no url'
      }`,
    );
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

      <section className="band">
        <h2>工作流操作</h2>
        <div className="operation-grid">
          <label>
            操作 token
            <input
              aria-label="Action token"
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
          <label>
            template
            <select
              aria-label="Run template"
              value={runTemplate}
              onChange={(event) => setRunTemplate(event.target.value)}
            >
              {workflowOptions.map((workflow) => (
                <option key={workflow} value={workflow}>
                  {workflow}
                </option>
              ))}
            </select>
          </label>
          <label>
            agent
            <select
              aria-label="Run agent"
              value={runAgent}
              onChange={(event) => setRunAgent(event.target.value)}
            >
              <option value="mock">mock</option>
              <option value="claude-code">claude-code</option>
            </select>
          </label>
          <label className="checkline">
            <input
              aria-label="Allow dirty base"
              type="checkbox"
              checked={allowDirtyBase}
              onChange={(event) => setAllowDirtyBase(event.target.checked)}
            />
            allow dirty base
          </label>
          <label className="wide">
            demand
            <textarea
              aria-label="Run demand"
              value={demandText}
              onChange={(event) => setDemandText(event.target.value)}
            />
          </label>
          <div className="actions wide">
            <button onClick={() => void runAction(startRun)}>发起运行</button>
            <button
              className="secondary"
              disabled={!runId}
              onClick={() => void runAction(prepareDelivery)}
            >
              准备 PR
            </button>
            <button
              className="secondary"
              disabled={!runId}
              onClick={() => void runAction(createPr)}
            >
              批准并创建 PR
            </button>
          </div>
        </div>
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
              <button onClick={() => void runAction(() => decide('approve'))}>
                批准
              </button>
              <button
                className="secondary"
                onClick={() => void runAction(() => decide('reject'))}
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
            <LinkedRow
              key={artifact.id}
              href={`#artifact-${artifact.id}`}
              primary={`${artifact.type} v${artifact.version}`}
              secondary={artifact.summary ?? artifact.path}
            />
          ))}
        </Panel>
        <Panel title="Gates">
          {gates.map((gate) => (
            <LinkedRow
              key={gate.id}
              href={`#gate-log-${gate.id}`}
              primary={`${gate.id} ${gate.status}`}
              secondary={`${gate.gateType} ${gate.nodeId}`}
            />
          ))}
        </Panel>
        <Panel title="Readiness">
          {review ? (
            <>
              <Row
                primary={review.readiness.ready ? 'ready' : 'not ready'}
                secondary={`score=${review.readiness.score.toFixed(2)} failed=${
                  review.readiness.checks
                    .filter((check) => !check.passed)
                    .map((check) => check.id)
                    .join(',') || 'none'
                }`}
              />
              {review.readiness.checks
                .filter((check) => !check.passed)
                .map((check) => (
                  <Row
                    key={check.id}
                    primary={`${check.id} ${check.severity}`}
                    secondary={check.evidence}
                  />
                ))}
            </>
          ) : (
            <Row primary="loading" secondary="readiness" />
          )}
        </Panel>
        <Panel title="Diff">
          {review ? (
            <>
              <Row
                primary={
                  review.delivery.diff.available
                    ? `${review.delivery.diff.branch}`
                    : 'diff unavailable'
                }
                secondary={
                  review.delivery.diff.available
                    ? `base=${review.delivery.diff.baseBranch}`
                    : (review.delivery.diff.reason ?? 'not recorded')
                }
              />
              {review.delivery.diff.changedFiles.map((file) => (
                <Row key={file} primary={file} secondary="changed file" />
              ))}
              {review.delivery.diff.stat ? (
                <PreviewBlock preview={review.delivery.diff.stat} />
              ) : null}
            </>
          ) : (
            <Row primary="loading" secondary="diff" />
          )}
        </Panel>
        <Panel title="Artifact 正文">
          {review?.artifacts.length ? (
            review.artifacts.map((artifact) => (
              <PreviewBlock
                key={artifact.id}
                id={`artifact-${artifact.id}`}
                title={`${artifact.type} v${artifact.version}`}
                preview={artifact.content.content || artifact.summary || ''}
                meta={`${artifact.content.path} truncated=${artifact.content.truncated}`}
              />
            ))
          ) : (
            <Row primary="none" secondary="artifact content" />
          )}
        </Panel>
        <Panel title="Gate Logs">
          {review?.gates.length ? (
            review.gates.map((gate) => (
              <PreviewBlock
                key={gate.id}
                id={`gate-log-${gate.id}`}
                title={`${gate.gateType} ${gate.status}`}
                preview={gate.output?.content || 'missing output'}
                meta={gate.output?.path ?? gate.id}
              />
            ))
          ) : (
            <Row primary="none" secondary="gate logs" />
          )}
        </Panel>
        <Panel title="PR 包">
          {review ? (
            <>
              <Row
                primary={review.delivery.status}
                secondary={review.delivery.prUrl ?? 'not created'}
              />
              {review.delivery.prBody ? (
                <PreviewBlock
                  id="pr-body"
                  title="PR Body"
                  preview={review.delivery.prBody.content}
                  meta={review.delivery.prBody.path}
                />
              ) : null}
              {review.delivery.package ? (
                <PreviewBlock
                  id="pr-package"
                  title="PR Package"
                  preview={review.delivery.package.content}
                  meta={review.delivery.package.path}
                />
              ) : null}
            </>
          ) : (
            <Row primary="loading" secondary="PR package" />
          )}
        </Panel>
        <Panel title="下一步">
          {review?.nextCommands.map((command) => (
            <Row key={command} primary={command} secondary="command" />
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
            <AuditRow key={event.id} event={event} />
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

function LinkedRow(props: {
  href: string;
  primary: string;
  secondary: string;
}) {
  return (
    <a className="row linked-row" href={props.href}>
      <strong>{props.primary}</strong>
      <span>{props.secondary}</span>
    </a>
  );
}

function AuditRow(props: { event: AuditEvent }) {
  const event = props.event;
  return (
    <div className="row">
      <strong>{`${event.type} ${event.nodeId ?? ''}`.trim()}</strong>
      <span>
        gate={event.gateId ?? 'none'} role={event.role ?? 'none'} hash=
        {event.hash.slice(0, 12)} {event.createdAt}
      </span>
      <div className="link-strip">
        {event.gateId ? (
          <a href={`#gate-log-${event.gateId}`}>gate log</a>
        ) : null}
        {event.type.startsWith('delivery.') ? (
          <a href="#pr-package">PR package</a>
        ) : null}
      </div>
    </div>
  );
}

function PreviewBlock(props: {
  id?: string;
  title?: string;
  meta?: string;
  preview: string;
}) {
  return (
    <div className="preview-block" id={props.id}>
      {props.title ? <strong>{props.title}</strong> : null}
      {props.meta ? <span>{props.meta}</span> : null}
      <pre>{props.preview}</pre>
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
