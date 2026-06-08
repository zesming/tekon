import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createAuditLogger,
  createRepositories,
  migrateDatabase,
  openDonkeyDatabase,
  writeDefaultRepoProfile,
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
  seedGitRepo(projectRoot);
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
    join(donkeyDir, 'workflows', 'project-feature.yaml'),
    [
      'id: project-feature',
      'name: Project Feature',
      'version: 1',
      'phases:',
      '  - id: rd',
      '    nodes:',
      '      - id: rd',
      '        role: rd',
      '        outputs:',
      '          - code:code-changes',
      '        gates:',
      '          - type: build',
      '            commandRef: build',
      '          - type: lint',
      '            commandRef: lint',
      '  - id: review',
      '    dependsOn:',
      '      - rd',
      '    nodes:',
      '      - id: reviewer',
      '        role: reviewer',
      '        inputs:',
      '          - code:code-changes',
      '        outputs:',
      '          - review:review-report',
      '        gates:',
      '          - type: schema',
      '            artifactType: review-report',
      '',
    ].join('\n'),
  );

  const sessionToken = 'fixture-session-token';
  writeFileSync(
    join(donkeyDir, 'config.yaml'),
    [
      'project:',
      '  name: fixture-donkey',
      `  repoPath: ${projectRoot}`,
      'storage:',
      '  dataDir: .donkey',
      'defaultAgent: mock',
      '',
    ].join('\n'),
    'utf8',
  );
  writeDefaultRepoProfile(projectRoot);
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

function seedGitRepo(projectRoot: string): void {
  mkdirSync(projectRoot, { recursive: true });
  execFileSync('git', ['init', '-b', 'main'], { cwd: projectRoot });
  execFileSync('git', ['config', 'user.email', 'donkey@example.com'], {
    cwd: projectRoot,
  });
  execFileSync('git', ['config', 'user.name', 'Donkey Test'], {
    cwd: projectRoot,
  });
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify(
      {
        scripts: {
          build: 'node -e "process.exit(0)"',
          lint: 'node -e "process.exit(0)"',
          test: 'node -e "process.exit(0)"',
        },
      },
      null,
      2,
    ),
    'utf8',
  );
  writeFileSync(join(projectRoot, 'README.md'), 'fixture\n', 'utf8');
  execFileSync('git', ['add', 'package.json', 'README.md'], {
    cwd: projectRoot,
  });
  execFileSync('git', ['commit', '-m', 'init'], { cwd: projectRoot });
}

function mkFixtureRoot(): string {
  return join(
    tmpdir(),
    `donkey-web-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}`,
  );
}
