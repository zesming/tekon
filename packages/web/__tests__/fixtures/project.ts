import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAuditLogger,
  createRepositories,
  migrateDatabase,
  openDonkeyDatabase,
} from '@donkey/core';

export interface WebFixtureProject {
  projectRoot: string;
  sessionToken: string;
  cleanup(): void;
}

export async function createWebFixtureProject(
  options: {
    includeOutOfScopeProject?: boolean;
    includeProviderSnapshot?: boolean;
  } = {},
): Promise<WebFixtureProject> {
  const projectRoot = mkFixtureRoot();
  const donkeyDir = join(projectRoot, '.donkey');
  mkdirSync(donkeyDir, { recursive: true });
  mkdirSync(join(donkeyDir, 'roles', 'rd'), { recursive: true });
  mkdirSync(join(donkeyDir, 'workflows'), { recursive: true });
  mkdirSync(join(donkeyDir, 'runs', 'run_1', 'artifacts', 'node_1'), {
    recursive: true,
  });
  mkdirSync(join(donkeyDir, 'runs', 'run_1', 'gates'), { recursive: true });
  mkdirSync(join(donkeyDir, 'runs', 'run_1', 'delivery'), {
    recursive: true,
  });

  writeFileSync(
    join(donkeyDir, 'roles', 'rd', 'agent.yaml'),
    'role: rd\nname: RD\n',
  );
  writeFileSync(
    join(donkeyDir, 'roles', 'rd', 'system.md'),
    'Implement scoped code changes.',
  );
  writeFileSync(
    join(donkeyDir, 'workflows', 'standard-feature.yaml'),
    [
      'id: standard-feature',
      'name: Standard Feature',
      'version: 1',
      'phases:',
      '  - id: implementation',
      '    nodes:',
      '      - id: rd',
      '        role: rd',
      '        outputs:',
      '          - type: code-changes',
      '',
    ].join('\n'),
  );

  const sessionToken = 'fixture-session-token';
  writeFileSync(
    join(donkeyDir, 'web-session.json'),
    JSON.stringify({ token: sessionToken }, null, 2),
  );
  writeFileSync(
    join(
      donkeyDir,
      'runs',
      'run_1',
      'artifacts',
      'node_1',
      'review-report.v1.md',
    ),
    'Review report body for dashboard.',
    'utf8',
  );
  writeFileSync(
    join(donkeyDir, 'runs', 'run_1', 'gates', 'human.txt'),
    'human approval is required',
    'utf8',
  );
  writeFileSync(
    join(donkeyDir, 'runs', 'run_1', 'delivery', 'pr-body.md'),
    '# Add dashboard\n\nReview dashboard evidence.',
    'utf8',
  );
  writeFileSync(
    join(donkeyDir, 'runs', 'run_1', 'delivery', 'pr-package.md'),
    '# PR Preparation\n\nReview dashboard evidence package.',
    'utf8',
  );

  const db = openDonkeyDatabase({
    filename: join(donkeyDir, 'donkey.sqlite'),
  });
  migrateDatabase(db);
  const repositories = createRepositories(db);

  await repositories.createDemand({
    id: 'demand_1',
    title: 'Add dashboard',
    body: 'Show Donkey run state and human approval.',
    createdAt: '2026-06-05T00:00:00.000Z',
  });
  await repositories.createProject({
    id: 'project_1',
    name: 'fixture-donkey',
    repoPath: projectRoot,
    createdAt: '2026-06-05T00:00:00.000Z',
  });
  await repositories.createWorkflowInstance({
    id: 'run_1',
    projectId: 'project_1',
    demandId: 'demand_1',
    status: 'paused',
    currentNodeId: 'node_1',
    createdAt: '2026-06-05T00:00:00.000Z',
    updatedAt: '2026-06-05T00:00:00.000Z',
  });
  if (options.includeProviderSnapshot !== false) {
    await repositories.recordRunProviderConfig({
      runId: 'run_1',
      provider: 'mock',
      configSummary: { provider: 'mock' },
      createdAt: '2026-06-05T00:00:00.000Z',
    });
  }
  await repositories.createPhase({
    id: 'phase_1',
    runId: 'run_1',
    name: 'Implementation',
    status: 'paused',
    order: 1,
    createdAt: '2026-06-05T00:00:00.000Z',
    updatedAt: '2026-06-05T00:00:00.000Z',
  });
  await repositories.createNode({
    id: 'node_1',
    runId: 'run_1',
    phaseId: 'phase_1',
    role: 'reviewer',
    status: 'paused',
    gates: [{ type: 'human', requiresHumanApproval: true, maxRetries: 0 }],
    dependencies: [],
    createdAt: '2026-06-05T00:00:00.000Z',
    updatedAt: '2026-06-05T00:00:00.000Z',
  });
  await repositories.recordGateResult({
    id: 'gate_1',
    runId: 'run_1',
    nodeId: 'node_1',
    gateType: 'human',
    status: 'blocked',
    outputPath: '.donkey/runs/run_1/gates/human.txt',
    durationMs: 0,
    retries: 0,
    createdAt: '2026-06-05T00:00:01.000Z',
  });
  await repositories.createHumanDecision({
    id: 'decision_1',
    runId: 'run_1',
    nodeId: 'node_1',
    gateResultId: 'gate_1',
    status: 'pending',
    note: [
      'request: Review human gate context before continuing.',
      'gate: gate_1 human blocked',
      'exactCommand: donkey run --template standard-feature --agent mock',
      'risk: high',
    ].join('\n'),
    createdAt: '2026-06-05T00:00:02.000Z',
  });
  await repositories.recordArtifact({
    id: 'artifact_1',
    runId: 'run_1',
    nodeId: 'node_1',
    type: 'review-report',
    version: 1,
    path: '.donkey/runs/run_1/artifacts/node_1/review-report.v1.md',
    sha256: createHash('sha256').update('review').digest('hex'),
    sizeBytes: 6,
    summary: 'Review report summary',
    createdAt: '2026-06-05T00:00:03.000Z',
  });
  await repositories.createRoleRun({
    id: 'role_run_1',
    runId: 'run_1',
    nodeId: 'node_1',
    role: 'reviewer',
    status: 'paused',
    startedAt: '2026-06-05T00:00:00.000Z',
  });

  const audit = createAuditLogger({ repositories });
  await audit.append({
    runId: 'run_1',
    type: 'human.decision.pending',
    payload: {
      decisionId: 'decision_1',
      gateResultId: 'gate_1',
      nodeId: 'node_1',
      role: 'reviewer',
    },
    createdAt: '2026-06-05T00:00:04.000Z',
  });

  if (options.includeOutOfScopeProject) {
    await repositories.createDemand({
      id: 'demand_escaped',
      title: 'Escaped project',
      body: 'This project row must not be exposed by explicit root context.',
      createdAt: '2026-06-05T00:00:00.000Z',
    });
    await repositories.createProject({
      id: 'project_escaped',
      name: 'escaped',
      repoPath: join(tmpdir(), 'outside-donkey-project'),
      createdAt: '2026-06-05T00:00:00.000Z',
    });
    await repositories.createWorkflowInstance({
      id: 'run_escaped',
      projectId: 'project_escaped',
      demandId: 'demand_escaped',
      status: 'running',
      createdAt: '2026-06-05T00:00:00.000Z',
      updatedAt: '2026-06-05T00:00:00.000Z',
    });
  }

  db.close();

  return {
    projectRoot,
    sessionToken,
    cleanup() {
      rmSync(projectRoot, { recursive: true, force: true });
    },
  };
}

function mkFixtureRoot(): string {
  return join(
    tmpdir(),
    `donkey-web-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`,
  );
}
