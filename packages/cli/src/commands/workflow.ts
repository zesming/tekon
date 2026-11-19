import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

import {
  commandBindingBehavior,
  effectiveGateForCommand,
  evaluateCommandPolicy,
  evaluateWorkflowSelection,
  gateCommandPolicy,
  inspectTemplateSymlink,
  listWorkflowCatalog,
  loadRepoProfile,
  mergeRoleAndGatePolicy,
  readDraftShapeFile,
  repoProfileCommandGuidance,
  requiresApproval,
  selectWorkflowTemplateForDraft,
  validateWorkflowTemplateFile,
  type CommandPolicy,
  type WorkflowTemplate,
  DEFAULT_WORKFLOW_TEMPLATE_ID,
} from '@tekon/core';

import type { CliIO } from '../lib/context.js';
import { ensureInitialized } from '../lib/context.js';
import {
  resolveDemandShapePath,
  resolveProjectRepoPath,
} from '../lib/path-utils.js';
import {
  ensureSafeName,
  getRepoRoot,
  getWorkflowFilePath,
  loadWorkflowByName,
  nodeRoleCommandPolicy,
} from '../lib/utils.js';

export async function commandWorkflow(argv: string[], io: CliIO) {
  const [subcommand] = argv;
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
    const repoPath = resolveProjectRepoPath(selectArgs.values.repo);
    const positionalDemandText = selectArgs.positionals.join(' ').trim();
    const shapePath = selectArgs.values.shape
      ? resolveDemandShapePath(repoPath, selectArgs.values.shape)
      : positionalDemandText
        ? null
        : resolveDemandShapePath(repoPath);
    const shape = shapePath ? readDraftShapeFile(shapePath) : null;
    const demandText = shape ? shape.rawText : positionalDemandText;
    const selection = selectWorkflowTemplateForDraft({
      text: demandText,
      ...(shape ? { category: shape.category } : {}),
    });
    const evaluation = evaluateWorkflowSelection({
      text: demandText,
      selectedTemplate:
        selectArgs.values.template ?? shape?.recommendedTemplate,
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

  // 从 subcommand 之后的完整 tail 解析选项；否则像 `list --repo R` 这种
  // 标志紧跟子命令的写法，--repo 会被位置解构吞掉，导致 repo 回落
  // 到 cwd（PD-07 排查发现的既有隐患）。
  const args = parseArgs({
    args: argv.slice(1),
    options: {
      repo: { type: 'string' },
      from: { type: 'string' },
      // PD-07：脚手架写最小单节点模板，而非复制重量级 standard-delivery。
      minimal: { type: 'boolean', default: false },
    },
    allowPositionals: true,
  });
  // 模板名只认位置参数：标志位（如 `show --repo R name`）在位置参数之前时，
  // 原始 argv 解构会把 '--repo' 误当名称。
  const templateName = args.positionals[0];
  const repoPath = resolveProjectRepoPath(args.values.repo);
  const projectWorkflowsDir = join(repoPath, '.tekon', 'workflows');

  if (subcommand === 'list') {
    // PD-07：附加非抛出的有效性探针，让用户在 list 阶段就能发现坏模板，
    // 而不必等到 run/show 才报错。
    const catalog = listWorkflowCatalog({
      projectWorkflowsDir,
      validate: true,
    });
    const lines = catalog.map((entry) => {
      const source = entry.builtin ? 'builtin' : 'project';
      if (entry.valid === false) {
        return `${entry.id} [${source}, invalid: ${singleLineError(entry.validationError ?? 'parse failed')}]`;
      }
      return `${entry.id} [${source}]`;
    });
    io.stdout.write(`${lines.join('\n')}\n`);
    return;
  }

  if (subcommand === 'preflight') {
    const preflightName = templateName ?? DEFAULT_WORKFLOW_TEMPLATE_ID;
    const template = loadWorkflowByName(preflightName, projectWorkflowsDir);
    const profile = loadRepoProfile(repoPath);
    for (const phase of template.phases) {
      for (const node of phase.nodes) {
        const rolePolicy = nodeRoleCommandPolicy(repoPath, node.role);
        for (const gate of node.gates) {
          const { guidance, commandText, status, rejection } =
            gateCommandStatus(repoPath, profile, gate, rolePolicy);
          const fields = [
            `node=${node.id}`,
            `gate=${gate.type}`,
            gate.commandRef
              ? `commandRef=${gate.commandRef}`
              : 'commandRef=none',
            `status=${status}`,
            commandText ? `command=${commandText}` : 'command=',
          ];
          if (rejection) {
            fields.push(`rejection=${rejection}`);
          }
          if (guidance?.status === 'not-applicable') {
            fields.push(`hint=${guidance.hint}`);
            fields.push(`profilePath=${guidance.profilePath}`);
            fields.push(`notApplicableReason=${guidance.reason ?? ''}`);
            if (gate.type === 'security-scan') {
              fields.push('notApplicableIgnoredFor=security-scan');
            }
          } else if (status === 'missing' && guidance) {
            // 修复提示只对真正缺命令的命令执行型 Gate 输出；语义门禁
            // （not-command-gate）的 commandRef 是惰性引用，附带补全提示会
            // 与状态自相矛盾。
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

  if (!templateName) {
    throw new Error(
      '工作流名称不能为空。请使用 tekon help workflow 查看用法。',
    );
  }

  if (subcommand === 'show') {
    // PD-07：展示完整结构（阶段→节点→角色/产物/门禁），不再只给
    // id/name/阶段数三行，让用户不必读模板源码就能学写法。
    const template = loadWorkflowByName(templateName, projectWorkflowsDir);
    const lines: string[] = [
      `id=${template.id}`,
      `name=${template.name}`,
      `phases=${template.phases.length}`,
    ];
    for (const phase of template.phases) {
      lines.push(`phase ${phase.id} (${phase.name})`);
      for (const node of phase.nodes) {
        lines.push(`  node ${node.id} role=${node.role}`);
        if (node.workspace !== undefined) {
          lines.push(`    workspace=${node.workspace}`);
        }
        if (node.prompt) lines.push(`    prompt=${node.prompt}`);
        const outputs = node.outputs.map((output) => output.type);
        if (outputs.length > 0) lines.push(`    outputs=${outputs.join(',')}`);
        if (node.gates.length > 0) {
          lines.push(
            `    gates=${node.gates
              .map((gate) =>
                gate.commandRef
                  ? `${gate.type}(${gate.commandRef})`
                  : gate.type,
              )
              .join(',')}`,
          );
        }
      }
    }
    io.stdout.write(`${lines.join('\n')}\n`);
    return;
  }

  if (subcommand === 'validate') {
    // PD-07/CD-20：独立校验入口。错误给可读指路而非裸 zod JSON，退出码
    // 表达成败以便脚本使用。
    const filePath = getWorkflowFilePath(templateName, projectWorkflowsDir);
    // 用 lstat 而非 existsSync 判断条目存在：断链软链经 existsSync（跟随
    // 链接）会被判为不存在，从而漏掉精确的「符号链接已断开」诊断。
    let entryPresent = true;
    try {
      lstatSync(filePath);
    } catch {
      entryPresent = false;
    }
    if (!entryPresent) {
      // 不回显拼接路径：未命中时它指向 CLI 内置目录，会泄漏安装位置。
      throw new Error(
        `模板 ${templateName} 不存在。用 tekon workflow list 查看可用模板名称。`,
      );
    }
    // 统一软链信任边界：显式 validate 与 list/show 同规则，断链/越界软链
    // 在读取前拒绝并给精确原因，外部文件内容不会经错误片段回显。
    const linkCheck = inspectTemplateSymlink(filePath, dirname(filePath));
    if (!linkCheck.ok) {
      throw new Error(
        `模板 ${templateName} 校验失败：${linkCheck.reason}。用 tekon workflow list 查看可用模板。`,
      );
    }
    const result = validateWorkflowTemplateFile(filePath);
    if (result.valid) {
      io.stdout.write(
        `template ${templateName}: valid (phases=${result.template.phases.length}, nodes=${result.template.phases.reduce(
          (sum, phase) => sum + phase.nodes.length,
          0,
        )})\n`,
      );
      return;
    }
    throw new Error(
      `模板 ${templateName} 校验失败：${result.error}。用 tekon workflow show <name> 对照结构，或编辑 ${filePath} 修复后重新 validate。`,
    );
  }

  if (subcommand === 'create') {
    ensureSafeName(templateName);
    await ensureInitialized(repoPath, io);
    const target = join(projectWorkflowsDir, `${templateName}.yaml`);
    // 显式拒绝覆盖：模板是运行合同的一部分，静默替换可能让已存在的
    // 自定义工作流在用户无察觉下丢失；需要重建请先手动删除或换名。
    if (existsSync(target)) {
      throw new Error(
        `模板文件已存在：${target}。如需重建，请先手动删除或换一个名称。`,
      );
    }
    if (args.values.minimal && args.values.from) {
      // 两个选项语义冲突：--minimal 生成脚手架，没有复制来源。
      io.stderr.write(
        '提示：同时指定 --minimal 与 --from，--from 将被忽略，仍生成最小脚手架。\n',
      );
    }
    if (args.values.minimal) {
      mkdirSync(projectWorkflowsDir, { recursive: true });
      // PD-07：最小脚手架——单阶段、单节点、人工门禁，用户按需扩展，
      // 避免一上来复制 326 行的完整交付模板。
      writeFileSync(target, minimalTemplateScaffold(templateName), 'utf8');
      io.stdout.write(`${target}\n`);
      return;
    }
    // PD-08：init 脚手架刻意保留 standard-delivery 作默认复制源——生成完整可裁剪的
    // 交付模板比复制轻量模板更合理；运行缺省默认已改为 lightweight-delivery。
    const fromName = args.values.from ?? 'standard-delivery';
    ensureSafeName(fromName);
    const source = getWorkflowFilePath(fromName, projectWorkflowsDir);
    // 先读源再建目录：源模板缺失时给中文指路、不留空目录副作用，
    // 也不回显指向 CLI 安装目录的拼接路径。
    if (!existsSync(source)) {
      throw new Error(
        `来源模板 ${fromName} 不存在。用 tekon workflow list 查看可用模板名称。`,
      );
    }
    const content = readFileSync(source, 'utf8').replace(
      /^id:\s*.+$/mu,
      `id: ${templateName}`,
    );
    mkdirSync(projectWorkflowsDir, { recursive: true });
    writeFileSync(target, content, 'utf8');
    io.stdout.write(`${target}\n`);
    return;
  }

  throw new Error(
    `未知的 workflow 子命令: ${subcommand ?? ''}。请使用 tekon help workflow 查看可用子命令。`,
  );
}

export async function commandConstraints(argv: string[], io: CliIO) {
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

/**
 * PD-07：list 的每行一个模板是可脚本解析的输出合同。校验错误（尤其
 * YAML 语法错误自带代码片段与换行）必须折叠为单行并截断，完整诊断
 * 交给不受单行约束的 `workflow validate`（stderr）。
 */
function singleLineError(text: string, maxLength = 160): string {
  const collapsed = text.replace(/\s+/gu, ' ').trim();
  return collapsed.length > maxLength
    ? `${collapsed.slice(0, maxLength)}…`
    : collapsed;
}

/**
 * PD-07：最小工作流脚手架（单阶段、单实现节点 + 人工确认）。结构满足
 * 模板 schema，用户可在此基础上加节点/门禁，而不必从重量级交付模板裁剪。
 */
function minimalTemplateScaffold(name: string): string {
  return `id: ${name}
name: ${name}
version: 1
phases:
  - id: dev
    name: Development
    dependsOn: []
    nodes:
      - id: impl
        role: rd
        inputs: []
        outputs:
          - id: code
            type: code-changes
        gates:
          - type: human
        dependsOn: []
`;
}

/**
 * Whether a gate's command can be resolved in this repository: shared by
 * `tekon workflow preflight` and `tekon doctor`.
 */
export function gateCommandStatus(
  repoPath: string,
  profile: ReturnType<typeof loadRepoProfile>,
  gate: WorkflowTemplate['phases'][number]['nodes'][number]['gates'][number],
  rolePolicy: CommandPolicy,
) {
  const guidance = gate.commandRef
    ? repoProfileCommandGuidance(repoPath, profile, gate.commandRef)
    : null;
  const command = gate.command ?? (guidance?.command ? guidance.command : null);
  const commandText = command
    ? [command.tool, ...command.args].join(' ')
    : gate.type === 'security-scan'
      ? 'tekon-builtin security scan'
      : '';
  const repoCommandNotApplicable =
    guidance?.status === 'not-applicable' && gate.type !== 'security-scan';
  let status: string;
  let rejection: string | null = null;
  if (repoCommandNotApplicable) {
    status = 'not-applicable';
  } else {
    // SF-1：分类与运行期 GateEngine、受理期 assertNoMissingRepoCommands 共用
    // 同一规则（commandBindingBehavior）。human/schema/independent-review 等
    // 语义门禁即使携带 commandRef 或内联命令也不会执行外部命令：缺失不报
    // missing、解析出的命令不做网关裁决，preflight/doctor 不得与受理结论分叉。
    const effectiveGate = command
      ? effectiveGateForCommand(gate, command)
      : gate;
    const behavior = commandBindingBehavior(effectiveGate);
    if (behavior === 'not-command-gate') {
      status = 'not-command-gate';
    } else if (behavior === 'missing-command') {
      status = 'missing';
    } else if (behavior === 'skip') {
      status = 'not-applicable';
    } else if (command) {
      // PD-04 + 10a-2：preflight 与运行期共用有效门禁解析、同一裁决函数，
      // 并合并节点角色策略（deny/审批/network/cwd 硬约束），预检须能预测
      // 运行期是否放行 / 是否需要人工审批。
      const effectivePolicy = mergeRoleAndGatePolicy(
        rolePolicy,
        gateCommandPolicy(repoPath, effectiveGate),
        repoPath,
      );
      rejection = evaluateCommandPolicy(command, effectivePolicy, repoPath);
      if (rejection) {
        status = 'rejected';
      } else if (requiresApproval(command, effectivePolicy)) {
        // evaluateCommandPolicy 不评估审批，单独产出审批待决状态，
        // 对齐运行期 gateway.run 的 blocked-for-approval。
        status = 'resolved-approval-required';
      } else {
        status = 'resolved';
      }
    } else {
      // builtin-security：security-scan 缺命令时有内置安全扫描兜底。
      status = 'resolved';
    }
  }
  return { guidance, commandText, status, rejection };
}
