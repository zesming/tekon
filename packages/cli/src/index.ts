#!/usr/bin/env node

import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { stringify as stringifyYaml } from 'yaml';

import {
  createAuditLogger,
  createCommandGateway,
  createGateEngine,
  createHumanGate,
  createMockAgentAdapter,
  createRepositories,
  createWorkflowEngine,
  generateDynamicWorkflow,
  listRoleIds,
  loadRole,
  loadWorkflowTemplate,
  migrateDatabase,
  openDonkeyDatabase,
  saveDynamicTemplate,
} from '@donkey/core';

export interface CliIO {
  stdout: { write(chunk: string): void };
  stderr: { write(chunk: string): void };
}

export async function runCli(
  argv: string[] = process.argv.slice(2),
  io: CliIO = process,
): Promise<number> {
  try {
    const [command, ...rest] = argv;
    if (!command) {
      io.stderr.write('usage: donkey <command>\n');
      return 1;
    }

    switch (command) {
      case 'init':
        await commandInit(rest, io);
        return 0;
      case 'run':
        await commandRun(rest, io);
        return 0;
      case 'status':
        await commandStatus(rest, io);
        return 0;
      case 'pause':
        await commandPause(rest, io);
        return 0;
      case 'resume':
        await commandResume(rest, io);
        return 0;
      case 'cancel':
        await commandCancel(rest, io);
        return 0;
      case 'role':
        await commandRole(rest, io);
        return 0;
      case 'workflow':
        await commandWorkflow(rest, io);
        return 0;
      case 'constraints':
        await commandConstraints(rest, io);
        return 0;
      case 'log':
        await commandLog(rest, io);
        return 0;
      case 'clean':
        await commandClean(rest, io);
        return 0;
      default:
        io.stderr.write(`unknown command: ${command}\n`);
        return 1;
    }
  } catch (error) {
    io.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const exitCode = await runCli();
  process.exitCode = exitCode;
}

async function commandInit(argv: string[], io: CliIO) {
  const args = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
    },
    allowPositionals: true,
  });
  const repoPath = resolve(args.values.repo ?? process.cwd());
  const donkeyDir = join(repoPath, '.donkey');
  mkdirSync(join(donkeyDir, 'runs'), { recursive: true });
  mkdirSync(join(donkeyDir, 'roles'), { recursive: true });
  mkdirSync(join(donkeyDir, 'workflows'), { recursive: true });
  mkdirSync(join(donkeyDir, 'worktrees'), { recursive: true });
  writeFileSync(
    join(donkeyDir, 'config.yaml'),
    stringifyYaml({
      project: { name: basenameForProject(repoPath), repoPath },
      storage: { dataDir: '.donkey' },
      defaultAgent: 'mock',
    }),
    'utf8',
  );
  const db = openProjectDb(repoPath);
  migrateDatabase(db);
  db.close();
  io.stdout.write(`initialized repo=${repoPath}\n`);
}

async function commandRun(argv: string[], io: CliIO) {
  const args = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      template: { type: 'string' },
      agent: { type: 'string' },
      dynamic: { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'save-as': { type: 'string' },
    },
    allowPositionals: true,
  });
  const demandText = args.positionals.join(' ').trim();
  if (!demandText) {
    throw new Error('run demand text is required');
  }
  const repoPath = resolve(args.values.repo ?? process.cwd());
  ensureInitialized(repoPath);

  if (args.values.dynamic) {
    if (!args.values['dry-run']) {
      throw new Error('dynamic workflow currently requires --dry-run');
    }
    const preview = await generateDynamicWorkflow({
      demandText,
      repoPath,
      adapter: createDynamicMockAdapter(demandText),
    });
    if (args.values['save-as']) {
      saveDynamicTemplate(preview.draft, args.values['save-as'], {
        workflowsDir: join(repoPath, '.donkey', 'workflows'),
      });
    }
    io.stdout.write(
      [
        'dryRun=true',
        `phases=${preview.workflow.phases.length}`,
        `mutations=${preview.constraints.mutations
          .map((mutation) => mutation.id)
          .join(',')}`,
      ].join(' ') + '\n',
    );
    return;
  }

  const db = openProjectDb(repoPath);
  migrateDatabase(db);
  const repositories = createRepositories(db);
  const audit = createAuditLogger({ repositories });
  const gateway = createCommandGateway({ repositories });
  const engine = createWorkflowEngine({
    repoPath,
    dataDir: '.donkey',
    repositories,
    audit,
    adapter: createMockAgentAdapter(),
    gateEngine: createGateEngine({ repositories, gateway }),
  });

  const result = await engine.startRun({
    demandText,
    mode: 'template',
    templateName: args.values.template ?? 'standard-feature',
  });
  const pendingHuman = (
    await repositories.listHumanDecisions(result.runId)
  ).filter((decision) => decision.status === 'pending');
  io.stdout.write(
    [
      `runId=${result.runId}`,
      `status=${result.workflow.status}`,
      pendingHuman.length > 0 ? 'humanGate=pending' : 'humanGate=none',
    ].join(' ') + '\n',
  );
  db.close();
}

function createDynamicMockAdapter(demandText: string) {
  return {
    async runAgent(input: { outputDir: string }): Promise<{
      provider: 'mock';
      exitCode: number;
      durationMs: number;
      outputFiles: string[];
      timedOut: false;
    }> {
      const outputPath = join(input.outputDir, 'workflow-spec.json');
      const highRisk = /高风险|high-risk|risk/u.test(demandText);
      const dataRisk = /数据|退款|data|migration/u.test(demandText);
      writeFileSync(
        outputPath,
        JSON.stringify({
          demandSummary: demandText.slice(0, 80),
          phases: [
            {
              id: 'rd',
              name: 'RD',
              nodes: [
                {
                  id: 'rd-dynamic-implementation',
                  role: 'rd',
                  artifactOutputs: ['code-changes'],
                  gates: [{ type: 'build' }, { type: 'lint' }],
                },
              ],
            },
            {
              id: 'validation',
              name: 'Validation',
              dependsOn: ['rd'],
              nodes: [
                {
                  id: 'qa-dynamic-validation',
                  role: 'qa',
                  dependsOn: ['rd-dynamic-implementation'],
                  artifactOutputs: ['test-report'],
                  gates: [{ type: 'test' }],
                },
              ],
            },
            {
              id: 'reviewer',
              name: 'Independent Review',
              dependsOn: ['validation'],
              nodes: [
                {
                  id: 'reviewer-dynamic-review',
                  role: 'reviewer',
                  dependsOn: ['qa-dynamic-validation'],
                  artifactOutputs: ['review-report'],
                  gates: [{ type: 'human' }],
                },
              ],
            },
          ],
          riskTags: [
            ...(highRisk ? ['high-risk'] : []),
            ...(dataRisk ? ['data'] : []),
          ],
          ...(highRisk ? { riskLevel: 'high' } : {}),
          assumptions: ['mock dynamic workflow preview'],
          openQuestions: [],
        }),
        'utf8',
      );
      return {
        provider: 'mock',
        exitCode: 0,
        durationMs: 1,
        outputFiles: [outputPath],
        timedOut: false,
      };
    },
  };
}

async function commandPause(argv: string[], io: CliIO) {
  const { repositories, db, runId } = openCommandContext(argv);
  const workflow = await repositories.getWorkflowInstance(runId);
  if (!workflow) {
    db.close();
    throw new Error(`run not found: ${runId}`);
  }
  if (workflow.currentNodeId) {
    await repositories.transitionNode(workflow.currentNodeId, 'paused');
  }
  const paused = await repositories.updateWorkflowInstanceStatus(
    runId,
    'paused',
    workflow.currentNodeId,
  );
  io.stdout.write(`runId=${runId} status=${paused?.status ?? 'paused'}\n`);
  db.close();
}

async function commandResume(argv: string[], io: CliIO) {
  const args = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      'run-id': { type: 'string' },
      'approve-human': { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
  const repoPath = resolve(args.values.repo ?? process.cwd());
  const runId = args.values['run-id'] ?? args.positionals[0];
  if (!runId) {
    throw new Error('--run-id is required');
  }
  ensureInitialized(repoPath);
  const db = openProjectDb(repoPath);
  migrateDatabase(db);
  const repositories = createRepositories(db);
  const audit = createAuditLogger({ repositories });
  const workflow = await repositories.getWorkflowInstance(runId);
  if (!workflow) {
    db.close();
    throw new Error(`run not found: ${runId}`);
  }

  const pendingHuman = (await repositories.listHumanDecisions(runId)).filter(
    (decision) => decision.status === 'pending',
  );
  if (args.values['approve-human']) {
    const humanGate = createHumanGate({ repositories });
    for (const decision of pendingHuman) {
      await humanGate.approveHumanGate(decision.id, 'cli', 'approved by CLI');
      await repositories.recordGateResult({
        id: `gate_resume_${decision.id}`,
        runId,
        nodeId: decision.nodeId,
        gateType: 'human',
        status: 'passed',
        durationMs: 0,
        retries: 0,
        createdAt: new Date().toISOString(),
      });
      await repositories.transitionNode(decision.nodeId, 'passed');
      await audit.append({
        runId,
        type: 'human.gate.approved',
        payload: { decisionId: decision.id, nodeId: decision.nodeId },
      });
    }
  }

  const gateway = createCommandGateway({ repositories });
  const engine = createWorkflowEngine({
    repoPath,
    dataDir: '.donkey',
    repositories,
    audit,
    adapter: createMockAgentAdapter(),
    gateEngine: createGateEngine({ repositories, gateway }),
  });
  const result = await engine.resumeRun(runId);
  io.stdout.write(`runId=${runId} status=${result.workflow.status}\n`);
  db.close();
}

async function commandCancel(argv: string[], io: CliIO) {
  const { repositories, db, runId } = openCommandContext(argv);
  const workflow = await repositories.getWorkflowInstance(runId);
  if (!workflow) {
    db.close();
    throw new Error(`run not found: ${runId}`);
  }
  if (workflow.currentNodeId) {
    await repositories.transitionNode(workflow.currentNodeId, 'interrupted');
  }
  const cancelled = await repositories.updateWorkflowInstanceStatus(
    runId,
    'cancelled',
    workflow.currentNodeId,
  );
  io.stdout.write(
    `runId=${runId} status=${cancelled?.status ?? 'cancelled'}\n`,
  );
  db.close();
}

async function commandRole(argv: string[], io: CliIO) {
  const [subcommand, roleId, ...rest] = argv;
  const args = parseArgs({
    args: rest,
    options: { repo: { type: 'string' } },
    allowPositionals: true,
  });
  const repoPath = resolve(args.values.repo ?? process.cwd());
  const builtInRolesDir = getBuiltInRolesDir();

  if (subcommand === 'list') {
    const roles = new Set([
      ...listRoleIds(builtInRolesDir),
      ...listRoleIds(join(repoPath, '.donkey', 'roles')),
    ]);
    io.stdout.write(`${[...roles].sort().join('\n')}\n`);
    return;
  }

  if (!roleId) {
    throw new Error('role id is required');
  }

  if (subcommand === 'show') {
    const role = loadRole({ role: roleId as never, repoPath, builtInRolesDir });
    io.stdout.write(
      [
        `role=${role.role}`,
        `name=${role.agent.name ?? role.role}`,
        `source=${role.source}`,
        `skills=${role.skills.map((skill) => skill.id).join(',')}`,
      ].join('\n') + '\n',
    );
    return;
  }

  if (subcommand === 'path') {
    const role = loadRole({ role: roleId as never, repoPath, builtInRolesDir });
    io.stdout.write(`${role.roleDir}\n`);
    return;
  }

  if (subcommand === 'create') {
    ensureInitialized(repoPath);
    const source = join(builtInRolesDir, roleId);
    const target = join(repoPath, '.donkey', 'roles', roleId);
    cpSync(source, target, { recursive: true });
    io.stdout.write(`${target}\n`);
    return;
  }

  throw new Error(`unknown role command: ${subcommand ?? ''}`);
}

async function commandWorkflow(argv: string[], io: CliIO) {
  const [subcommand, name, ...rest] = argv;
  const args = parseArgs({
    args: rest,
    options: {
      repo: { type: 'string' },
      from: { type: 'string' },
    },
    allowPositionals: true,
  });
  const repoPath = resolve(args.values.repo ?? process.cwd());
  const builtInWorkflowsDir = getBuiltInWorkflowsDir();
  const projectWorkflowsDir = join(repoPath, '.donkey', 'workflows');

  if (subcommand === 'list') {
    const names = new Set([
      ...listWorkflowNames(builtInWorkflowsDir),
      ...listWorkflowNames(projectWorkflowsDir),
    ]);
    io.stdout.write(`${[...names].sort().join('\n')}\n`);
    return;
  }

  if (!name) {
    throw new Error('workflow name is required');
  }

  if (subcommand === 'show') {
    const template = loadWorkflowByName(name, projectWorkflowsDir);
    io.stdout.write(
      `id=${template.id}\nname=${template.name}\nphases=${template.phases.length}\n`,
    );
    return;
  }

  if (subcommand === 'create') {
    ensureSafeName(name);
    ensureInitialized(repoPath);
    const fromName = args.values.from ?? 'standard-feature';
    ensureSafeName(fromName);
    const source = getWorkflowFilePath(fromName, projectWorkflowsDir);
    const target = join(projectWorkflowsDir, `${name}.yaml`);
    mkdirSync(projectWorkflowsDir, { recursive: true });
    const content = readFileSync(source, 'utf8').replace(
      /^id:\s*.+$/mu,
      `id: ${name}`,
    );
    writeFileSync(target, content, 'utf8');
    io.stdout.write(`${target}\n`);
    return;
  }

  throw new Error(`unknown workflow command: ${subcommand ?? ''}`);
}

async function commandConstraints(argv: string[], io: CliIO) {
  const [subcommand] = argv;
  if (subcommand !== 'show') {
    throw new Error(`unknown constraints command: ${subcommand ?? ''}`);
  }
  io.stdout.write(
    readFileSync(join(getRepoRoot(), 'constraints.yaml'), 'utf8'),
  );
}

async function commandStatus(argv: string[], io: CliIO) {
  const { repositories, db, repoPath, runId } = openCommandContext(argv);
  const workflow = await repositories.getWorkflowInstance(runId);
  if (!workflow) {
    db.close();
    throw new Error(`run not found: ${runId}`);
  }
  const gates = await repositories.listGateResults(runId);
  const artifacts = await repositories.listArtifacts(runId);
  const pendingHuman = (await repositories.listHumanDecisions(runId)).filter(
    (decision) => decision.status === 'pending',
  );
  io.stdout.write(
    [
      `runId=${runId}`,
      `repo=${repoPath}`,
      `status=${workflow.status}`,
      `currentNode=${workflow.currentNodeId ?? 'none'}`,
      `gates=${gates.length}`,
      `artifacts=${artifacts.length}`,
      `pendingHumanDecisions=${pendingHuman.length}`,
    ].join(' ') + '\n',
  );
  db.close();
}

async function commandLog(argv: string[], io: CliIO) {
  const { repositories, db, runId } = openCommandContext(argv);
  const events = await repositories.listAuditEvents(runId);
  for (const event of events) {
    io.stdout.write(
      `${event.createdAt} ${event.type} ${JSON.stringify(event.payload)}\n`,
    );
  }
  db.close();
}

async function commandClean(argv: string[], io: CliIO) {
  const args = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
    },
    allowPositionals: true,
  });
  const repoPath = resolve(args.values.repo ?? process.cwd());
  ensureInitialized(repoPath);
  const worktreesDir = join(repoPath, '.donkey', 'worktrees');
  let cleaned = 0;
  if (existsSync(worktreesDir)) {
    rmSync(worktreesDir, { force: true, recursive: true });
    cleaned = 0;
  }
  mkdirSync(worktreesDir, { recursive: true });
  io.stdout.write(`cleaned worktrees=${cleaned}\n`);
}

function openCommandContext(argv: string[]) {
  const args = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      'run-id': { type: 'string' },
    },
    allowPositionals: true,
  });
  const repoPath = resolve(args.values.repo ?? process.cwd());
  ensureInitialized(repoPath);
  const runId = args.values['run-id'] ?? args.positionals[0];
  if (!runId) {
    throw new Error('--run-id is required');
  }
  const db = openProjectDb(repoPath);
  migrateDatabase(db);
  return {
    repoPath,
    runId,
    db,
    repositories: createRepositories(db),
  };
}

function openProjectDb(repoPath: string) {
  mkdirSync(join(repoPath, '.donkey'), { recursive: true });
  return openDonkeyDatabase({
    filename: join(repoPath, '.donkey', 'donkey.sqlite'),
  });
}

function ensureInitialized(repoPath: string) {
  if (!existsSync(join(repoPath, '.donkey', 'config.yaml'))) {
    throw new Error(`not initialized: ${repoPath}`);
  }
}

function basenameForProject(repoPath: string) {
  return repoPath.split(/[\\/]/u).filter(Boolean).at(-1) ?? 'donkey';
}

function getRepoRoot() {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

function getBuiltInRolesDir() {
  return join(getRepoRoot(), 'roles');
}

function getBuiltInWorkflowsDir() {
  return join(getRepoRoot(), 'workflows');
}

function listWorkflowNames(workflowsDir: string) {
  if (!existsSync(workflowsDir)) {
    return [];
  }
  return readdirSync(workflowsDir)
    .filter((entry) => entry.endsWith('.yaml'))
    .map((entry) => entry.slice(0, -'.yaml'.length));
}

function loadWorkflowByName(name: string, projectWorkflowsDir: string) {
  ensureSafeName(name);
  const workflowsDir = existsSync(join(projectWorkflowsDir, `${name}.yaml`))
    ? projectWorkflowsDir
    : getBuiltInWorkflowsDir();
  return loadWorkflowTemplate({ name, workflowsDir });
}

function getWorkflowFilePath(name: string, projectWorkflowsDir: string) {
  ensureSafeName(name);
  const projectPath = join(projectWorkflowsDir, `${name}.yaml`);
  if (existsSync(projectPath)) {
    return projectPath;
  }
  return join(getBuiltInWorkflowsDir(), `${name}.yaml`);
}

function ensureSafeName(name: string) {
  if (!/^[a-zA-Z0-9_-]+$/u.test(name)) {
    throw new Error(`invalid name: ${name}`);
  }
}
