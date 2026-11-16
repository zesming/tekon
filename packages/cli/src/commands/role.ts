import { cpSync, existsSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { listRoleIds, loadRole, roleSchema } from '@tekon/core';

import type { CliIO } from '../lib/context.js';
import { ensureInitialized } from '../lib/context.js';
import { resolveProjectRepoPath } from '../lib/path-utils.js';
import {
  ensureSafeName,
  getBuiltInRolesDir,
} from '../lib/utils.js';

export async function commandRole(
  argv: string[],
  io: CliIO,
) {
  const [subcommand, roleId, ...rest] = argv;
  const args = parseArgs({
    args: rest,
    options: { repo: { type: 'string' } },
    allowPositionals: true,
  });
  const repoPath = resolveProjectRepoPath(args.values.repo);
  const builtInRolesDir = getBuiltInRolesDir();

  if (subcommand === 'list') {
    const roles = new Set([
      ...listRoleIds(builtInRolesDir),
      ...listRoleIds(join(repoPath, '.tekon', 'roles')),
    ]);
    io.stdout.write(`${[...roles].sort().join('\n')}\n`);
    return;
  }

  if (!roleId) {
    throw new Error(
      '角色 ID 不能为空。请使用 tekon role list 查看可用角色。',
    );
  }
  ensureSafeName(roleId);
  const roleParse = roleSchema.safeParse(roleId);
  if (!roleParse.success) {
    throw new Error(
      `无效的角色 ID: ${roleId}。角色 ID 必须是 kebab-case 标识符（小写字母开头，仅含小写字母、数字和短横线），例如 writer、code-reviewer。`,
    );
  }
  const role = roleParse.data;

  if (subcommand === 'show') {
    const loadedRole = loadRole({ role, repoPath, builtInRolesDir });
    io.stdout.write(
      [
        `role=${loadedRole.role}`,
        `name=${loadedRole.agent.name ?? loadedRole.role}`,
        `source=${loadedRole.source}`,
        `skills=${loadedRole.skills.map((skill) => skill.id).join(',')}`,
      ].join('\n') + '\n',
    );
    return;
  }

  if (subcommand === 'path') {
    const loadedRole = loadRole({ role, repoPath, builtInRolesDir });
    io.stdout.write(`${loadedRole.roleDir}\n`);
    return;
  }

  if (subcommand === 'create') {
    await ensureInitialized(repoPath, io);
    const source = join(builtInRolesDir, roleId);
    const target = join(repoPath, '.tekon', 'roles', roleId);
    if (existsSync(target)) {
      throw new Error(`角色已存在: ${roleId}（${target}）。`);
    }

    // 内置角色：整目录复制，保留 skills/knowledge/tools 等资产。
    if (existsSync(source)) {
      const resolvedBuiltInDir = realpathSync(builtInRolesDir);
      const resolvedSource = realpathSync(source);
      if (!resolvedSource.startsWith(resolvedBuiltInDir + '/')) {
        throw new Error(`角色 ID 试图逃逸内置角色目录: ${roleId}`);
      }
      const repoRolesDir = join(repoPath, '.tekon', 'roles');
      mkdirSync(repoRolesDir, { recursive: true });
      const resolvedRolesDir = realpathSync(repoRolesDir);
      const resolvedTarget = resolve(resolvedRolesDir, roleId);
      if (!resolvedTarget.startsWith(resolvedRolesDir + '/')) {
        throw new Error(`角色 ID 试图逃逸项目角色目录: ${roleId}`);
      }
      cpSync(resolvedSource, resolvedTarget, { recursive: true });
      io.stdout.write(`${resolvedTarget}\n`);
      return;
    }

    // PD-06：自定义角色名，生成最小脚手架，用户在 system.md 里写职责。
    const repoRolesDir = join(repoPath, '.tekon', 'roles');
    mkdirSync(target, { recursive: true });
    const resolvedRolesDir = realpathSync(repoRolesDir);
    const resolvedTarget = resolve(resolvedRolesDir, roleId);
    if (!resolvedTarget.startsWith(resolvedRolesDir + '/')) {
      throw new Error(`角色 ID 试图逃逸项目角色目录: ${roleId}`);
    }
    writeFileSync(
      join(resolvedTarget, 'agent.yaml'),
      [`role: ${role}`, `name: ${role}`, ''].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(resolvedTarget, 'system.md'),
      `# ${role}\n\n在此编写该角色的职责、边界和输出要求。Tekon 运行节点时会把本文件作为系统提示词。\n`,
      'utf8',
    );
    io.stdout.write(`${resolvedTarget}\n`);
    return;
  }

  throw new Error(
    `未知的 role 子命令: ${subcommand ?? ''}。请使用 tekon help role 查看可用子命令。`,
  );
}
