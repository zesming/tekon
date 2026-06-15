import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import {
  evaluateWorkflowSelection,
  loadRepoProfile,
  readDemandShapeFile,
  repoProfileCommandGuidance,
  selectWorkflowTemplateForDemand,
} from '@tekon/core';

import type { CliIO } from '../lib/context.js';
import { ensureInitialized } from '../lib/context.js';
import {
  resolveDemandShapePath,
  resolveProjectRepoPath,
} from '../lib/path-utils.js';
import {
  ensureSafeName,
  getBuiltInWorkflowsDir,
  getRepoRoot,
  getWorkflowFilePath,
  listWorkflowNames,
  loadWorkflowByName,
} from '../lib/utils.js';

export async function commandWorkflow(
  argv: string[],
  io: CliIO,
) {
  const [subcommand, name, ...rest] = argv;
  if (subcommand === 'select') {
    const selectArgs = parseArgs({
      args: argv.slice(1),
      options: {
        repo: { type: 'string' },
        shape: { type: 'string' },
        template: { type: 'string' },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: true,
    });
    const repoPath = resolveProjectRepoPath(
      selectArgs.values.repo,
    );
    const positionalDemandText = selectArgs.positionals
      .join(' ')
      .trim();
    const shapePath = selectArgs.values.shape
      ? resolveDemandShapePath(
          repoPath,
          selectArgs.values.shape,
        )
      : positionalDemandText
        ? null
        : resolveDemandShapePath(repoPath);
    const shape = shapePath
      ? readDemandShapeFile(shapePath)
      : null;
    const demandText = shape
      ? shape.rawText
      : positionalDemandText;
    const selection = selectWorkflowTemplateForDemand({
      text: demandText,
      ...(shape ? { category: shape.category } : {}),
    });
    const evaluation = evaluateWorkflowSelection({
      text: demandText,
      selectedTemplate:
        selectArgs.values.template ??
        shape?.recommendedTemplate,
      ...(shape ? { category: shape.category } : {}),
    });
    if (selectArgs.values.json) {
      io.stdout.write(
        `${JSON.stringify({ selection, evaluation }, null, 2)}\n`,
      );
      return;
    }
    io.stdout.write(
      [
        `recommendedTemplate=${selection.recommendedTemplate}`,
        `category=${selection.category}`,
        `ready=${evaluation.ready}`,
        `score=${evaluation.score.toFixed(2)}`,
        `alternatives=${selection.alternatives.join(',')}`,
        `reasons=${selection.reasons.join('|')}`,
      ].join(' ') + '\n',
    );
    return;
  }

  const args = parseArgs({
    args: rest,
    options: {
      repo: { type: 'string' },
      from: { type: 'string' },
    },
    allowPositionals: true,
  });
  const repoPath = resolveProjectRepoPath(args.values.repo);
  const builtInWorkflowsDir = getBuiltInWorkflowsDir();
  const projectWorkflowsDir = join(
    repoPath,
    '.tekon',
    'workflows',
  );

  if (subcommand === 'list') {
    const names = new Set([
      ...listWorkflowNames(builtInWorkflowsDir),
      ...listWorkflowNames(projectWorkflowsDir),
    ]);
    io.stdout.write(`${[...names].sort().join('\n')}\n`);
    return;
  }

  if (subcommand === 'preflight') {
    const templateName = name ?? 'standard-delivery';
    const template = loadWorkflowByName(
      templateName,
      projectWorkflowsDir,
    );
    const profile = loadRepoProfile(repoPath);
    for (const phase of template.phases) {
      for (const node of phase.nodes) {
        for (const gate of node.gates) {
          const guidance = gate.commandRef
            ? repoProfileCommandGuidance(
                repoPath,
                profile,
                gate.commandRef,
              )
            : null;
          const command =
            gate.command ??
            (guidance?.command ? guidance.command : null);
          const isCommandBackedGate = Boolean(
            gate.commandRef ||
              gate.command ||
              gate.type === 'security-scan',
          );
          const commandText = command
            ? [command.tool, ...command.args].join(' ')
            : gate.type === 'security-scan'
              ? 'tekon-builtin security scan'
              : '';
          const repoCommandNotApplicable =
            guidance?.status === 'not-applicable' &&
            gate.type !== 'security-scan';
          const status = !isCommandBackedGate
            ? 'not-command-gate'
            : repoCommandNotApplicable
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
            commandText
              ? `command=${commandText}`
              : 'command=',
          ];
          if (guidance?.status === 'not-applicable') {
            fields.push(`hint=${guidance.hint}`);
            fields.push(
              `profilePath=${guidance.profilePath}`,
            );
            fields.push(
              `notApplicableReason=${guidance.reason ?? ''}`,
            );
            if (gate.type === 'security-scan') {
              fields.push(
                'notApplicableIgnoredFor=security-scan',
              );
            }
          } else if (!commandText && guidance) {
            fields.push(`hint=${guidance.hint}`);
            fields.push(
              `profilePath=${guidance.profilePath}`,
            );
            const suggestion = guidance.suggestions[0];
            if (suggestion) {
              fields.push(
                `suggestedScript=${suggestion.scriptName}`,
              );
              fields.push(
                `suggestedCommand=${suggestion.commandText}`,
              );
            }
          }
          io.stdout.write(fields.join(' ') + '\n');
        }
      }
    }
    return;
  }

  if (!name) {
    throw new Error(
      '工作流名称不能为空。请使用 tekon help workflow 查看用法。',
    );
  }

  if (subcommand === 'show') {
    const template = loadWorkflowByName(
      name,
      projectWorkflowsDir,
    );
    io.stdout.write(
      `id=${template.id}\nname=${template.name}\nphases=${template.phases.length}\n`,
    );
    return;
  }

  if (subcommand === 'create') {
    ensureSafeName(name);
    await ensureInitialized(repoPath, io);
    const fromName = args.values.from ?? 'standard-delivery';
    ensureSafeName(fromName);
    const source = getWorkflowFilePath(
      fromName,
      projectWorkflowsDir,
    );
    const target = join(
      projectWorkflowsDir,
      `${name}.yaml`,
    );
    mkdirSync(projectWorkflowsDir, { recursive: true });
    const content = readFileSync(source, 'utf8').replace(
      /^id:\s*.+$/mu,
      `id: ${name}`,
    );
    writeFileSync(target, content, 'utf8');
    io.stdout.write(`${target}\n`);
    return;
  }

  throw new Error(
    `未知的 workflow 子命令: ${subcommand ?? ''}。请使用 tekon help workflow 查看可用子命令。`,
  );
}

export async function commandConstraints(
  argv: string[],
  io: CliIO,
) {
  const [subcommand] = argv;
  if (subcommand !== 'show') {
    throw new Error(
      `未知的 constraints 子命令: ${subcommand ?? ''}。请使用 tekon help constraints 查看可用子命令。`,
    );
  }
  io.stdout.write(
    readFileSync(join(getRepoRoot(), 'constraints.yaml'), 'utf8'),
  );
}
