#!/usr/bin/env node

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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

import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';

import {
  createAuditLogger,
  createClaudeCodeAdapter,
  createCommandGateway,
  createDeliveryEvidencePackage,
  createGateEngine,
  createHumanGate,
  createMockAgentAdapter,
  createPullRequestPreparation,
  queryPullRequestCiStatus,
  createWorkReviewSurface,
  createRepositories,
  createScmDelivery,
  createWorktreeManager,
  createWorkflowEngine,
  evaluateWorkReadiness,
  evaluateWorkUsability,
  approveDemandShape,
  evaluateDemandShape,
  readDemandShapeFile,
  watchPullRequestCiStatus,
  renderDemandShapeForRun,
  renderWorkUsabilityEvaluationReport,
  shapeDemand,
  writeDemandShapeFile,
  writeDemandShapeFiles,
  loadRepoProfile,
  writeDefaultRepoProfile,
  generateDynamicWorkflow,
  listRoleIds,
  loadRole,
  loadWorkflowTemplate,
  migrateDatabase,
  openDonkeyDatabase,
  saveDynamicTemplate,
  repoProfileCommandGuidance,
  workUsabilitySampleSetSchema,
  upsertWorkUsabilitySample,
  type AgentAdapter,
  type AgentAdapterConfig,
  agentAdapterConfigSchema,
  type CommandGateway,
  type RunProviderConfig,
  type WorkUsabilitySample,
  type WorkUsabilitySampleSet,
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
      case 'demand':
        await commandDemand(rest, io);
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
      case 'delivery':
        await commandDelivery(rest, io);
        return 0;
      case 'eval':
        await commandEval(rest, io);
        return 0;
      case 'review':
        await commandReview(rest, io);
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
  mkdirSync(join(donkeyDir, 'eval'), { recursive: true });
  const webSessionPath = join(donkeyDir, 'web-session.json');
  if (!existsSync(webSessionPath)) {
    writeFileSync(
      webSessionPath,
      JSON.stringify({ token: randomBytes(32).toString('hex') }, null, 2),
      'utf8',
    );
  }
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
  const profilePath = join(donkeyDir, 'repo-profile.yaml');
  if (!existsSync(profilePath)) {
    writeDefaultRepoProfile(repoPath);
  }
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
      'allow-dirty-base': { type: 'boolean', default: false },
      'save-as': { type: 'string' },
      'demand-file': { type: 'string' },
    },
    allowPositionals: true,
  });
  const shapedDemand = args.values['demand-file']
    ? readDemandShapeFile(resolve(args.values['demand-file']))
    : null;
  if (shapedDemand && !shapedDemand.approved) {
    throw new Error(
      `demand file must be approved before run: ${args.values['demand-file']}`,
    );
  }
  const demandText = shapedDemand
    ? renderDemandShapeForRun(shapedDemand)
    : args.positionals.join(' ').trim();
  if (!demandText) {
    throw new Error('run demand text is required');
  }
  const repoPath = resolve(args.values.repo ?? process.cwd());
  ensureInitialized(repoPath);
  const allowDirtyBase = Boolean(args.values['allow-dirty-base']);

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

  assertCleanBase(repoPath, allowDirtyBase);

  const db = openProjectDb(repoPath);
  migrateDatabase(db);
  const repositories = createRepositories(db);
  const audit = createAuditLogger({ repositories });
  const gateway = createCommandGateway({ repositories });
  const agentRuntime = createAgentAdapter({
    agent: args.values.agent ?? 'mock',
    repoPath,
    gateway,
  });
  const engine = createWorkflowEngine({
    repoPath,
    dataDir: '.donkey',
    repositories,
    audit,
    adapter: agentRuntime.adapter,
    agentProvider: agentRuntime.provider,
    agentConfigSummary: agentRuntime.configSummary,
    gateEngine: createGateEngine({ repositories, gateway }),
    worktreeManager: createWorktreeManager({ repositories, gateway }),
    allowDirtyBase,
    builtInRolesDir: getBuiltInRolesDir(),
  });

  const result = await engine.startRun({
    demandText,
    mode: 'template',
    templateName:
      args.values.template ??
      shapedDemand?.recommendedTemplate ??
      'standard-feature',
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

async function commandDemand(argv: string[], io: CliIO) {
  const [subcommand, ...rest] = argv;
  if (subcommand === 'shape') {
    const args = parseArgs({
      args: rest,
      options: {
        repo: { type: 'string' },
        write: { type: 'boolean', default: false },
        format: { type: 'string' },
      },
      allowPositionals: true,
    });
    const demandText = args.positionals.join(' ').trim();
    const shape = shapeDemand({ text: demandText });
    const repoPath = resolve(args.values.repo ?? process.cwd());
    if (args.values.write) {
      ensureInitialized(repoPath);
    }
    const paths = args.values.write
      ? writeDemandShapeFiles({ repoPath, shape })
      : null;
    if (args.values.format === 'json') {
      io.stdout.write(
        `${JSON.stringify({ shape, ...(paths ?? {}) }, null, 2)}\n`,
      );
      return;
    }
    io.stdout.write(
      [
        `demandShapeId=${shape.id}`,
        `readyForRun=${shape.readyForRun}`,
        `approved=${shape.approved}`,
        `category=${shape.category}`,
        `risk=${shape.risk.level}`,
        `recommendedTemplate=${shape.recommendedTemplate}`,
        `openQuestions=${shape.openQuestions.length}`,
        paths ? `shapePath=${paths.jsonPath}` : '',
        paths ? `reviewPath=${paths.markdownPath}` : '',
      ]
        .filter(Boolean)
        .join(' ') + '\n',
    );
    return;
  }

  if (subcommand === 'approve') {
    const args = parseArgs({
      args: rest,
      options: {
        shape: { type: 'string' },
        actor: { type: 'string' },
      },
      allowPositionals: true,
    });
    const shapeArg = args.values.shape ?? args.positionals[0];
    if (!shapeArg) {
      throw new Error('demand shape path is required');
    }
    const shapePath = resolve(shapeArg);
    const approved = approveDemandShape(readDemandShapeFile(shapePath), {
      actor: args.values.actor ?? 'cli',
    });
    writeDemandShapeFile(shapePath, approved);
    io.stdout.write(
      [
        `demandShapeId=${approved.id}`,
        `approved=${approved.approved}`,
        `approvedBy=${approved.approvedBy ?? ''}`,
        `approvedAt=${approved.approvedAt ?? ''}`,
        `shapePath=${shapePath}`,
      ].join(' ') + '\n',
    );
    return;
  }

  if (subcommand === 'show') {
    const args = parseArgs({
      args: rest,
      options: {
        shape: { type: 'string' },
        eval: { type: 'boolean', default: false },
      },
      allowPositionals: true,
    });
    const shapeArg = args.values.shape ?? args.positionals[0];
    if (!shapeArg) {
      throw new Error('demand shape path is required');
    }
    const shapePath = resolve(shapeArg);
    const shape = readDemandShapeFile(shapePath);
    const evaluation = evaluateDemandShape(shape);
    io.stdout.write(
      [
        `demandShapeId=${shape.id}`,
        `title=${shape.title}`,
        `category=${shape.category}`,
        `risk=${shape.risk.level}`,
        `readyForRun=${shape.readyForRun}`,
        `approved=${shape.approved}`,
        `recommendedTemplate=${shape.recommendedTemplate}`,
        `acceptanceCriteria=${shape.acceptanceCriteria.length}`,
        `openQuestions=${shape.openQuestions.length}`,
        args.values.eval
          ? `evalReady=${evaluation.ready} evalScore=${evaluation.score.toFixed(2)}`
          : '',
      ]
        .filter(Boolean)
        .join('\n') + '\n',
    );
    return;
  }

  throw new Error(`unknown demand command: ${subcommand ?? ''}`);
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
  const gateway = createCommandGateway({ repositories });
  const runProvider = await repositories.getRunProviderConfig(runId);
  if (!runProvider) {
    db.close();
    throw new Error(
      `run ${runId} has no provider snapshot; cannot resume safely`,
    );
  }
  const agentRuntime = createAgentAdapterFromSnapshot({
    snapshot: runProvider,
    repoPath,
    gateway,
  });

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
      await repositories.transitionNode(decision.nodeId, 'awaiting-gate');
      await audit.append({
        runId,
        type: 'human.gate.approved',
        payload: { decisionId: decision.id, nodeId: decision.nodeId },
      });
    }
  }

  const engine = createWorkflowEngine({
    repoPath,
    dataDir: '.donkey',
    repositories,
    audit,
    adapter: agentRuntime.adapter,
    agentProvider: agentRuntime.provider,
    agentConfigSummary: agentRuntime.configSummary,
    gateEngine: createGateEngine({ repositories, gateway }),
    worktreeManager: createWorktreeManager({ repositories, gateway }),
    builtInRolesDir: getBuiltInRolesDir(),
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

  if (subcommand === 'preflight') {
    const templateName = name ?? 'standard-feature';
    const template = loadWorkflowByName(templateName, projectWorkflowsDir);
    const profile = loadRepoProfile(repoPath);
    for (const phase of template.phases) {
      for (const node of phase.nodes) {
        for (const gate of node.gates) {
          const guidance = gate.commandRef
            ? repoProfileCommandGuidance(repoPath, profile, gate.commandRef)
            : null;
          const command =
            gate.command ?? (guidance?.command ? guidance.command : null);
          const commandText = command
            ? [command.tool, ...command.args].join(' ')
            : gate.type === 'security-scan'
              ? 'donkey-builtin security scan'
              : '';
          const status =
            guidance?.status === 'not-applicable' &&
            gate.type !== 'security-scan'
              ? 'not-applicable'
              : commandText
                ? 'resolved'
                : 'missing';
          const fields = [
            `node=${node.id}`,
            `gate=${gate.type}`,
            gate.commandRef
              ? `commandRef=${gate.commandRef}`
              : 'commandRef=none',
            `status=${status}`,
            commandText ? `command=${commandText}` : 'command=',
          ];
          if (guidance?.status === 'not-applicable') {
            fields.push(`hint=${guidance.hint}`);
            fields.push(`profilePath=${guidance.profilePath}`);
            fields.push(`notApplicableReason=${guidance.reason ?? ''}`);
            if (gate.type === 'security-scan') {
              fields.push('notApplicableIgnoredFor=security-scan');
            }
          } else if (!commandText && guidance) {
            fields.push(`hint=${guidance.hint}`);
            fields.push(`profilePath=${guidance.profilePath}`);
            const suggestion = guidance.suggestions[0];
            if (suggestion) {
              fields.push(`suggestedScript=${suggestion.scriptName}`);
              fields.push(`suggestedCommand=${suggestion.commandText}`);
            }
          }
          io.stdout.write(fields.join(' ') + '\n');
        }
      }
    }
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

async function commandDelivery(argv: string[], io: CliIO) {
  const [subcommand, ...rest] = argv;
  if (subcommand === 'prepare') {
    const { repositories, db, repoPath, runId } = openCommandContext(rest);
    const audit = createAuditLogger({ repositories });
    const preparation = await createPullRequestPreparation({
      repoPath,
      repositories,
      audit,
      runId,
    });
    io.stdout.write(
      [
        `runId=${runId}`,
        `branch=${preparation.branch}`,
        `baseBranch=${preparation.baseBranch}`,
        `packagePath=${preparation.packagePath}`,
        `prBodyPath=${preparation.prBodyPath}`,
        `requiresHumanApproval=${preparation.requiresHumanApproval}`,
      ].join(' ') + '\n',
    );
    db.close();
    return;
  }

  if (subcommand === 'create-pr') {
    const args = parseArgs({
      args: rest,
      options: {
        repo: { type: 'string' },
        'run-id': { type: 'string' },
        'approve-human': { type: 'boolean', default: false },
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
    const repositories = createRepositories(db);
    const audit = createAuditLogger({ repositories });
    const preparation = await createPullRequestPreparation({
      repoPath,
      repositories,
      audit,
      runId,
    });
    const body = readFileSync(preparation.prBodyPath, 'utf8');
    const result = await createScmDelivery({
      repoPath,
      repositories,
      audit,
      outputDir: join(repoPath, '.donkey', 'runs', runId, 'delivery', 'scm'),
    }).createPr({
      runId,
      title: preparation.title,
      body,
      bodyPath: preparation.prBodyPath,
      branch: preparation.branch,
      baseBranch: preparation.baseBranch,
      dryRun: false,
      humanApproved: Boolean(args.values['approve-human']),
      approvedBy: 'cli',
    });
    const delivery = await repositories.getDeliveryPullRequest(runId);
    io.stdout.write(
      [
        `runId=${runId}`,
        `deliveryStatus=${delivery?.status ?? 'unknown'}`,
        `requiresHumanApproval=${result.requiresHumanApproval}`,
        `prUrl=${result.prUrl ?? delivery?.prUrl ?? ''}`,
        `failureStage=${delivery?.failureStage ?? ''}`,
      ].join(' ') + '\n',
    );
    db.close();
    return;
  }

  if (subcommand === 'ci-status') {
    const args = parseArgs({
      args: rest,
      options: {
        repo: { type: 'string' },
        'run-id': { type: 'string' },
        selector: { type: 'string' },
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
    try {
      migrateDatabase(db);
      const repositories = createRepositories(db);
      const audit = createAuditLogger({ repositories });
      const report = await queryPullRequestCiStatus({
        repoPath,
        repositories,
        audit,
        runId,
        selector: args.values.selector,
      });
      io.stdout.write(
        [
          `runId=${runId}`,
          `ciStatus=${report.status}`,
          `checks=${report.checks.length}`,
          `artifactId=${report.artifact.id}`,
          `selector=${report.selector}`,
        ].join(' ') + '\n',
      );
    } finally {
      db.close();
    }
    return;
  }

  if (subcommand === 'ci-watch') {
    const args = parseArgs({
      args: rest,
      options: {
        repo: { type: 'string' },
        'run-id': { type: 'string' },
        selector: { type: 'string' },
        'max-attempts': { type: 'string' },
        'interval-ms': { type: 'string' },
        backoff: { type: 'string' },
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
    try {
      migrateDatabase(db);
      const repositories = createRepositories(db);
      const audit = createAuditLogger({ repositories });
      const result = await watchPullRequestCiStatus({
        repoPath,
        repositories,
        audit,
        runId,
        selector: args.values.selector,
        maxAttempts: args.values['max-attempts']
          ? Number(args.values['max-attempts'])
          : undefined,
        intervalMs: args.values['interval-ms']
          ? Number(args.values['interval-ms'])
          : undefined,
        backoffMultiplier: args.values.backoff
          ? Number(args.values.backoff)
          : undefined,
      });
      io.stdout.write(
        [
          `runId=${runId}`,
          `ciStatus=${result.finalStatus}`,
          `terminal=${result.terminal}`,
          `attempts=${result.attempts}`,
          `maxAttempts=${result.maxAttempts}`,
          `checks=${result.finalReport.checks.length}`,
          `artifactId=${result.finalReport.artifact.id}`,
          `selector=${result.selector}`,
        ].join(' ') + '\n',
      );
    } finally {
      db.close();
    }
    return;
  }

  if (subcommand !== 'dry-run') {
    throw new Error(`unknown delivery command: ${subcommand ?? ''}`);
  }
  const { repositories, db, repoPath, runId } = openCommandContext(rest);
  const audit = createAuditLogger({ repositories });
  const evidence = await createDeliveryEvidencePackage({
    repositories,
    audit,
    runId,
    riskGates: ['human'],
  });
  const pr = await createScmDelivery({ repoPath }).createPr({
    title: `Donkey delivery ${runId}`,
    body: `Run ${runId} status=${evidence.workflowStatus}`,
    branch: `donkey-delivery/${runId}`,
    dryRun: true,
  });
  io.stdout.write(
    [
      `runId=${runId}`,
      `workflowStatus=${evidence.workflowStatus}`,
      `artifacts=${evidence.artifacts.length}`,
      `prDryRun=${pr.dryRun}`,
      `requiresHumanApproval=${pr.requiresHumanApproval}`,
    ].join(' ') + '\n',
  );
  db.close();
}

function createAgentAdapter(input: {
  agent: string;
  repoPath: string;
  gateway: CommandGateway;
}): {
  adapter: AgentAdapter;
  provider: RunProviderConfig['provider'];
  configSummary: Record<string, unknown>;
} {
  if (input.agent === 'mock') {
    return {
      adapter: createMockAgentAdapter(),
      provider: 'mock',
      configSummary: { provider: 'mock' },
    };
  }

  if (input.agent === 'claude-code') {
    const config = defaultClaudeCodeConfig(input.repoPath);
    return {
      adapter: createClaudeCodeAdapter(config, input.gateway),
      provider: 'claude-code',
      configSummary: summarizeAgentConfig(config),
    };
  }

  throw new Error(`unsupported agent: ${input.agent}`);
}

function createAgentAdapterFromSnapshot(input: {
  snapshot: RunProviderConfig;
  repoPath: string;
  gateway: CommandGateway;
}): {
  adapter: AgentAdapter;
  provider: RunProviderConfig['provider'];
  configSummary: Record<string, unknown>;
} {
  if (input.snapshot.provider === 'mock') {
    return {
      adapter: createMockAgentAdapter(),
      provider: 'mock',
      configSummary: input.snapshot.configSummary,
    };
  }

  if (input.snapshot.provider === 'claude-code') {
    const parsed = agentAdapterConfigSchema.safeParse(
      input.snapshot.configSummary,
    );
    if (!parsed.success || parsed.data.provider !== 'claude-code') {
      throw new Error(
        `run ${input.snapshot.runId} has a non-replayable claude-code provider snapshot`,
      );
    }
    return {
      adapter: createClaudeCodeAdapter(parsed.data, input.gateway),
      provider: 'claude-code',
      configSummary: parsed.data,
    };
  }

  throw new Error('custom agent provider snapshots cannot be resumed safely');
}

function summarizeAgentConfig(
  config: AgentAdapterConfig,
): Record<string, unknown> {
  return {
    provider: config.provider,
    command: config.command,
    args: config.args,
    promptMode: config.promptMode,
    outputFormat: config.outputFormat,
    timeoutMs: config.timeoutMs,
    permissionProfile: {
      sandbox: config.permissionProfile.sandbox,
      approval: config.permissionProfile.approval,
      filesystemScope: config.permissionProfile.filesystemScope,
      network: config.permissionProfile.network,
      tools: config.permissionProfile.tools,
    },
  };
}

function defaultClaudeCodeConfig(repoPath: string): AgentAdapterConfig {
  return {
    provider: 'claude-code',
    command: 'claude',
    args: ['-p'],
    promptMode: 'stdin',
    outputFormat: 'json',
    timeoutMs: 300_000,
    permissionProfile: {
      sandbox: 'workspace-write',
      approval: 'on-request',
      filesystemScope: [repoPath],
      network: 'restricted',
      tools: {
        allow: ['git', 'npm', 'pnpm'],
        deny: ['rm', 'sudo', 'git push --force'],
      },
    },
  };
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

async function commandEval(argv: string[], io: CliIO) {
  const [subcommand, ...rest] = argv;
  if (subcommand === 'demand-shape') {
    const args = parseArgs({
      args: rest,
      options: {
        shape: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: true,
    });
    const shapeArg = args.values.shape ?? args.positionals[0];
    if (!shapeArg) {
      throw new Error('demand shape path is required');
    }
    const shape = readDemandShapeFile(resolve(shapeArg));
    const evaluation = evaluateDemandShape(shape);
    io.stdout.write(
      args.values.json
        ? `${JSON.stringify(evaluation, null, 2)}\n`
        : [
            `demandShapeId=${shape.id}`,
            `ready=${evaluation.ready}`,
            `score=${evaluation.score.toFixed(2)}`,
            `failed=${evaluation.checks
              .filter((check) => !check.passed)
              .map((check) => check.id)
              .join(',')}`,
          ].join(' ') + '\n',
    );
    return;
  }

  if (subcommand === 'work-usability') {
    if (rest[0] === 'record') {
      await commandWorkUsabilityRecord(rest.slice(1), io);
      return;
    }
    const args = parseArgs({
      args: rest,
      options: {
        repo: { type: 'string' },
        samples: { type: 'string' },
        json: { type: 'boolean', default: false },
        'report-md': { type: 'string' },
        'report-html': { type: 'string' },
        title: { type: 'string' },
      },
      allowPositionals: true,
    });
    const repoPath = resolve(args.values.repo ?? process.cwd());
    ensureInitialized(repoPath);
    const samplePath = resolve(
      repoPath,
      args.values.samples ??
        join('.donkey', 'eval', 'work-usability-samples.yaml'),
    );
    if (!existsSync(samplePath)) {
      throw new Error(`work usability sample file not found: ${samplePath}`);
    }
    const sampleSet = workUsabilitySampleSetSchema.parse(
      parseYaml(readFileSync(samplePath, 'utf8')),
    );
    const db = openProjectDb(repoPath);
    migrateDatabase(db);
    try {
      const repositories = createRepositories(db);
      const audit = createAuditLogger({ repositories });
      const evaluation = await evaluateWorkUsability({
        repoPath,
        repositories,
        audit,
        sampleSet,
      });
      const reportMarkdownPath = args.values['report-md']
        ? resolve(repoPath, args.values['report-md'])
        : null;
      const reportHtmlPath = args.values['report-html']
        ? resolve(repoPath, args.values['report-html'])
        : null;
      if (reportMarkdownPath || reportHtmlPath) {
        const report = renderWorkUsabilityEvaluationReport({
          title: args.values.title ?? 'Donkey Work Usability Evaluation',
          generatedAt: new Date().toISOString(),
          samplePath,
          evaluation,
        });
        if (reportMarkdownPath) {
          mkdirSync(dirname(reportMarkdownPath), { recursive: true });
          writeFileSync(reportMarkdownPath, report.markdown, 'utf8');
        }
        if (reportHtmlPath) {
          mkdirSync(dirname(reportHtmlPath), { recursive: true });
          writeFileSync(reportHtmlPath, report.html, 'utf8');
        }
      }
      io.stdout.write(
        args.values.json
          ? `${JSON.stringify(evaluation, null, 2)}\n`
          : formatWorkUsabilityEvaluation(evaluation, {
              reportMarkdownPath,
              reportHtmlPath,
            }),
      );
    } finally {
      db.close();
    }
    return;
  }

  if (subcommand !== 'readiness') {
    throw new Error(`unknown eval command: ${subcommand ?? ''}`);
  }
  const { repositories, db, repoPath, runId } = openCommandContext(rest);
  const audit = createAuditLogger({ repositories });
  const evaluation = await evaluateWorkReadiness({
    repositories,
    audit,
    runId,
    repoPath,
  });
  const deliveryPr = await repositories.getDeliveryPullRequest(runId);
  io.stdout.write(
    [
      `runId=${runId}`,
      `ready=${evaluation.ready}`,
      `score=${evaluation.score.toFixed(2)}`,
      `prCreated=${deliveryPr?.status === 'created' && Boolean(deliveryPr.prUrl)}`,
      `prUrl=${deliveryPr?.prUrl ?? ''}`,
      `failed=${evaluation.checks
        .filter((check) => !check.passed)
        .map((check) => check.id)
        .join(',')}`,
    ].join(' ') + '\n',
  );
  db.close();
}

async function commandWorkUsabilityRecord(argv: string[], io: CliIO) {
  const args = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      samples: { type: 'string' },
      'run-id': { type: 'string' },
      id: { type: 'string' },
      'demand-type': { type: 'string' },
      'expected-provider': { type: 'string' },
      'expected-pr-url': { type: 'string' },
      'require-real-provider': { type: 'boolean', default: false },
      'require-pr': { type: 'boolean', default: false },
      notes: { type: 'string' },
    },
    allowPositionals: true,
  });
  const repoPath = resolve(args.values.repo ?? process.cwd());
  ensureInitialized(repoPath);
  const runId = args.values['run-id'] ?? args.positionals[0];
  if (!runId) {
    throw new Error('--run-id is required');
  }
  const samplePath = resolve(
    repoPath,
    args.values.samples ??
      join('.donkey', 'eval', 'work-usability-samples.yaml'),
  );
  const sampleSet: WorkUsabilitySampleSet = existsSync(samplePath)
    ? workUsabilitySampleSetSchema.parse(
        parseYaml(readFileSync(samplePath, 'utf8')),
      )
    : { thresholds: {}, samples: [] };
  const db = openProjectDb(repoPath);
  migrateDatabase(db);
  try {
    const repositories = createRepositories(db);
    const workflow = await repositories.getWorkflowInstance(runId);
    if (!workflow) {
      throw new Error(`run not found: ${runId}`);
    }
    const [providerConfig, deliveryPr] = await Promise.all([
      repositories.getRunProviderConfig(runId),
      repositories.getDeliveryPullRequest(runId),
    ]);
    const provider =
      args.values['expected-provider'] ?? providerConfig?.provider;
    const expectedPrUrl =
      args.values['expected-pr-url'] ?? deliveryPr?.prUrl ?? undefined;
    const requireRealProvider =
      args.values['require-real-provider'] ||
      Boolean(provider && provider !== 'mock');
    const requirePr = args.values['require-pr'] || Boolean(expectedPrUrl);
    const sample: WorkUsabilitySample = {
      id: args.values.id ?? runId,
      runId,
      ...(args.values['demand-type']
        ? {
            demandType: args.values[
              'demand-type'
            ] as WorkUsabilitySample['demandType'],
          }
        : {}),
      ...(provider
        ? {
            expectedProvider:
              provider as WorkUsabilitySample['expectedProvider'],
          }
        : {}),
      requireRealProvider,
      requirePr,
      ...(expectedPrUrl ? { expectedPrUrl } : {}),
      ...(args.values.notes ? { notes: args.values.notes } : {}),
    };
    const result = upsertWorkUsabilitySample(sampleSet, sample);
    mkdirSync(dirname(samplePath), { recursive: true });
    writeFileSync(samplePath, stringifyYaml(result.sampleSet), 'utf8');
    io.stdout.write(
      [
        `sampleRecorded=true`,
        `created=${result.created}`,
        `samplePath=${samplePath}`,
        `id=${sample.id}`,
        `runId=${runId}`,
        `expectedProvider=${sample.expectedProvider ?? ''}`,
        `requireRealProvider=${sample.requireRealProvider}`,
        `requirePr=${sample.requirePr}`,
        `expectedPrUrl=${sample.expectedPrUrl ?? ''}`,
      ].join(' ') + '\n',
    );
  } finally {
    db.close();
  }
}

function formatWorkUsabilityEvaluation(
  evaluation: Awaited<ReturnType<typeof evaluateWorkUsability>>,
  reports: {
    reportMarkdownPath?: string | null;
    reportHtmlPath?: string | null;
  } = {},
): string {
  const failedThresholds = evaluation.thresholdChecks.filter(
    (check) => !check.passed,
  );
  const failedSampleChecks = evaluation.samples.flatMap((sample) =>
    sample.checks
      .filter((check) => !check.passed)
      .map((check) => `${sample.id}:${check.id}`),
  );
  return (
    [
      `usable=${evaluation.usable}`,
      `score=${evaluation.score.toFixed(2)}`,
      `samples=${evaluation.counts.samples}`,
      `readyRuns=${evaluation.counts.readyRuns}`,
      `realProviderRuns=${evaluation.counts.realProviderRuns}`,
      `createdPrs=${evaluation.counts.createdPrs}`,
      `securityScanPassed=${evaluation.counts.securityScanPassed}`,
      `isolationPassed=${evaluation.counts.isolationPassed}`,
      `failedThresholds=${failedThresholds.map((check) => check.id).join(',')}`,
      `failedSamples=${failedSampleChecks.join(',')}`,
      reports.reportMarkdownPath
        ? `reportMd=${reports.reportMarkdownPath}`
        : '',
      reports.reportHtmlPath ? `reportHtml=${reports.reportHtmlPath}` : '',
      '',
      '## Threshold Checks',
      ...evaluation.thresholdChecks.map(
        (check) => `- ${check.id}: ${check.passed} ${check.evidence}`,
      ),
      '',
      '## Samples',
      ...evaluation.samples.map((sample) =>
        [
          `- ${sample.id}: runId=${sample.runId} readiness=${sample.readiness?.ready ?? false} provider=${sample.provider ?? 'missing'} prCreated=${sample.prCreated} isolation=${sample.isolationPassed}`,
          ...sample.checks
            .filter((check) => !check.passed)
            .map((check) => `  - failed ${check.id}: ${check.evidence}`),
        ].join('\n'),
      ),
      '',
    ].join('\n') + '\n'
  );
}

async function commandReview(argv: string[], io: CliIO) {
  const args = parseArgs({
    args: argv,
    options: {
      repo: { type: 'string' },
      'run-id': { type: 'string' },
      json: { type: 'boolean', default: false },
      'max-chars': { type: 'string' },
    },
    allowPositionals: true,
  });
  const repoPath = resolve(args.values.repo ?? process.cwd());
  ensureInitialized(repoPath);
  const runId = args.values['run-id'] ?? args.positionals[0];
  if (!runId) {
    throw new Error('--run-id is required');
  }
  const maxContentChars = args.values['max-chars']
    ? Number(args.values['max-chars'])
    : 1_200;
  if (!Number.isFinite(maxContentChars) || maxContentChars <= 0) {
    throw new Error('--max-chars must be a positive number');
  }
  const db = openProjectDb(repoPath);
  migrateDatabase(db);
  const repositories = createRepositories(db);
  const audit = createAuditLogger({ repositories });
  const surface = await createWorkReviewSurface({
    repoPath,
    repositories,
    audit,
    runId,
    maxContentChars,
  });

  if (args.values.json) {
    io.stdout.write(`${JSON.stringify(surface, null, 2)}\n`);
    db.close();
    return;
  }

  io.stdout.write(formatReviewSurface(surface));
  db.close();
}

function formatReviewSurface(
  surface: Awaited<ReturnType<typeof createWorkReviewSurface>>,
): string {
  const failedChecks = surface.readiness.checks.filter(
    (check) => !check.passed,
  );
  const lines = [
    `runId=${surface.runId}`,
    `workflowStatus=${surface.workflowStatus}`,
    `ready=${surface.readiness.ready}`,
    `score=${surface.readiness.score.toFixed(2)}`,
    `deliveryStatus=${surface.delivery.status}`,
    `prUrl=${surface.delivery.prUrl ?? ''}`,
    '',
    '## Readiness Failed Checks',
    ...(failedChecks.length === 0
      ? ['- none']
      : failedChecks.map(
          (check) => `- ${check.id} (${check.severity}): ${check.evidence}`,
        )),
    '',
    '## Evidence Navigation',
    ...(surface.evidenceGroups.length === 0
      ? ['- none']
      : surface.evidenceGroups.map((group) =>
          [
            `### ${group.title} ${group.status}`,
            `summary=${group.summary}`,
            ...group.links.map(
              (link) =>
                `- ${link.kind} ${link.label} -> ${link.href} (${link.summary})`,
            ),
          ].join('\n'),
        )),
    '',
    '## Gate Failure Triage',
    ...(surface.gateFailureTriage.length === 0
      ? ['- none']
      : surface.gateFailureTriage.map((item) =>
          [
            `### ${item.gateType} ${item.gateId} ${item.status}`,
            `classification=${item.classification} retry=${item.retry} log=${item.logHref}`,
            `summary=${item.summary}`,
            `suggestedCommand=${item.suggestedCommand}`,
          ].join('\n'),
        )),
    '',
    '## Delivery',
    `- packagePath: ${surface.delivery.package?.path ?? 'missing'}`,
    `- prBodyPath: ${surface.delivery.prBody?.path ?? 'missing'}`,
    `- diffAvailable: ${surface.delivery.diff.available}`,
    `- diffBranch: ${surface.delivery.diff.branch}`,
    `- diffBase: ${surface.delivery.diff.baseBranch}`,
    ...(surface.delivery.diff.reason
      ? [`- diffReason: ${surface.delivery.diff.reason}`]
      : []),
    '',
    '## Changed Files',
    ...(surface.delivery.diff.changedFiles.length === 0
      ? ['- none']
      : surface.delivery.diff.changedFiles.map((file) => `- ${file}`)),
    '',
    '## Artifacts',
    ...(surface.artifacts.length === 0
      ? ['- none']
      : surface.artifacts.map((artifact) =>
          [
            `### ${artifact.type} ${artifact.id}`,
            `path=${artifact.path} summary=${artifact.summary ?? ''}`,
            formatPreview(artifact.content),
          ].join('\n'),
        )),
    '',
    '## Gate Logs',
    ...(surface.gates.length === 0
      ? ['- none']
      : surface.gates.map((gate) =>
          [
            `### ${gate.gateType} ${gate.id} ${gate.status}`,
            `node=${gate.nodeId} failure=${gate.failureClassification ?? ''}`,
            gate.output ? formatPreview(gate.output) : 'output=missing',
          ].join('\n'),
        )),
    '',
    '## PR Body',
    surface.delivery.prBody
      ? formatPreview(surface.delivery.prBody)
      : 'missing',
    '',
    '## PR Package',
    surface.delivery.package
      ? formatPreview(surface.delivery.package)
      : 'missing',
    '',
    '## Next Commands',
    ...surface.nextCommands.map((command) => `- ${command}`),
    '',
  ];
  return `${lines.join('\n')}\n`;
}

function formatPreview(preview: {
  path: string;
  exists: boolean;
  content: string;
  truncated: boolean;
  sizeBytes: number;
}): string {
  if (!preview.exists) {
    return `path=${preview.path} exists=false`;
  }
  return [
    `path=${preview.path} sizeBytes=${preview.sizeBytes} truncated=${preview.truncated}`,
    '```',
    preview.content,
    '```',
  ].join('\n');
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

function assertCleanBase(repoPath: string, allowDirtyBase: boolean): void {
  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd: repoPath,
    encoding: 'utf8',
  });
  const meaningfulDirtyLines = status
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .filter((line) => !line.startsWith('?? .donkey/'));

  if (meaningfulDirtyLines.length > 0 && !allowDirtyBase) {
    throw new Error(
      'dirty base worktree requires --allow-dirty-base before donkey run',
    );
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
