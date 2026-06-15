import { parseArgs } from 'node:util';

import {
  approveDemandShape,
  evaluateDemandShape,
  readDemandShapeFile,
  shapeDemand,
  writeDemandShapeFile,
  writeDemandShapeFiles,
} from '@tekon/core';

import type { CliIO } from '../lib/context.js';
import { ensureInitialized } from '../lib/context.js';
import {
  resolveDemandShapePath,
  resolveProjectRepoPath,
} from '../lib/path-utils.js';
import { readStdinLine, resolveAgentCommand } from '../lib/utils.js';

export async function commandDemand(
  argv: string[],
  io: CliIO,
) {
  const [subcommand, ...rest] = argv;

  if (subcommand === 'new') {
    const args = parseArgs({
      args: rest,
      options: {
        repo: { type: 'string' },
        'no-interactive': { type: 'boolean', default: false },
        json: { type: 'boolean', default: false },
      },
      allowPositionals: true,
    });
    const demandText = args.positionals.join(' ').trim();
    if (!demandText) {
      throw new Error(
        '请提供需求文本。示例: tekon draft new "新增用户认证系统，支持 OAuth2.0 和邮箱密码登录"',
      );
    }

    // Spinner while initial shaping
    process.stderr.write('正在分析需求');
    const spinnerChars = ['.', '..', '...'];
    let spinnerIdx = 0;
    const spinnerInterval = setInterval(() => {
      process.stderr.write(
        `\r正在分析需求${spinnerChars[spinnerIdx % spinnerChars.length]}`,
      );
      spinnerIdx++;
    }, 300);

    const initialShape = shapeDemand({ text: demandText });

    clearInterval(spinnerInterval);
    process.stderr.write('\r正在分析需求 完成\n');

    const repoPath = resolveProjectRepoPath(args.values.repo);
    await ensureInitialized(repoPath, io);

    // Interactive clarification (skip with --no-interactive or non-TTY)
    let shape = initialShape;
    if (!args.values['no-interactive']) {
      const { runInteractiveClarification } = await import(
        '../draft-interactive.js'
      );
      const agentCmd = resolveAgentCommand(repoPath);
      const agentConfig = agentCmd
        ? { agentCommand: agentCmd, repoPath }
        : undefined;
      const result = await runInteractiveClarification(
        shape,
        readStdinLine,
        io.stdout,
        agentConfig,
      );
      shape = result.draft;
      if (result.interrupted) {
        io.stdout.write('\n交互已取消，保留已填写的内容。\n');
      }
    }

    // Write files
    const paths = writeDemandShapeFiles({ repoPath, shape });

    // Human-readable output
    if (args.values.json) {
      io.stdout.write(
        `${JSON.stringify({ shape, ...paths }, null, 2)}\n`,
      );
      return;
    }

    const categoryMap: Record<string, string> = {
      feature: '功能',
      bugfix: '缺陷修复',
      test: '测试',
      docs: '文档',
      refactor: '重构',
      other: '其他',
    };
    const riskMap: Record<string, string> = {
      low: '低风险',
      medium: '中风险',
      high: '高风险',
    };

    const lines: string[] = [];
    lines.push('📄 需求草案已保存');
    lines.push(`   文件: ${paths.markdownPath}`);
    lines.push('');
    lines.push(`标题: ${shape.title}`);
    lines.push(
      `类别: ${categoryMap[shape.category] ?? shape.category}`,
    );
    lines.push(
      `风险: ${riskMap[shape.risk.level] ?? shape.risk.level}`,
    );
    lines.push(`模板: ${shape.recommendedTemplate}`);
    lines.push(`审批: ${shape.approved ? '已审批' : '未审批'}`);

    if (shape.acceptanceCriteria.length > 0) {
      lines.push('', '验收标准:');
      for (const ac of shape.acceptanceCriteria) {
        lines.push(`  ${ac.id}: ${ac.description}`);
      }
    }

    lines.push('', '后续操作:');
    lines.push('  tekon draft show        查看草案详情');
    lines.push('  tekon draft approve     批准后即可执行');
    lines.push(
      `  tekon run --draft-file ${paths.jsonPath}    发起运行`,
    );
    lines.push('');

    io.stdout.write(`${lines.join('\n')}\n`);
    return;
  }

  if (subcommand === 'shape') {
    const args = parseArgs({
      args: rest,
      options: {
        repo: { type: 'string' },
        write: { type: 'boolean', default: false },
        'no-write': { type: 'boolean', default: false },
        format: { type: 'string' },
      },
      allowPositionals: true,
    });
    const demandText = args.positionals.join(' ').trim();
    const shape = shapeDemand({ text: demandText });
    const repoPath = resolveProjectRepoPath(args.values.repo);
    const shouldWrite = !args.values['no-write'];
    if (shouldWrite) {
      await ensureInitialized(repoPath, io);
    }
    const paths = shouldWrite
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
        `draftId=${shape.id}`,
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
        repo: { type: 'string' },
        shape: { type: 'string' },
        actor: { type: 'string' },
      },
      allowPositionals: true,
    });
    const shapeArg = args.values.shape ?? args.positionals[0];
    const repoPath = resolveProjectRepoPath(args.values.repo);
    if (!shapeArg) {
      await ensureInitialized(repoPath, io);
    }
    const shapePath = resolveDemandShapePath(repoPath, shapeArg, {
      latestMustBeUnapproved: !shapeArg,
    });
    const approved = approveDemandShape(
      readDemandShapeFile(shapePath),
      {
        actor: args.values.actor ?? 'cli',
      },
    );
    writeDemandShapeFile(shapePath, approved);
    io.stdout.write(
      [
        `draftId=${approved.id}`,
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
        repo: { type: 'string' },
        shape: { type: 'string' },
        eval: { type: 'boolean', default: false },
      },
      allowPositionals: true,
    });
    const shapeArg = args.values.shape ?? args.positionals[0];
    const repoPath = resolveProjectRepoPath(args.values.repo);
    if (!shapeArg) {
      await ensureInitialized(repoPath, io);
    }
    const shapePath = resolveDemandShapePath(repoPath, shapeArg);
    const shape = readDemandShapeFile(shapePath);
    const evaluation = evaluateDemandShape(shape);
    io.stdout.write(
      [
        `draftId=${shape.id}`,
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

  throw new Error(
    `未知的 draft 子命令: ${subcommand ?? ''}。请使用 tekon help draft 查看可用子命令。`,
  );
}
