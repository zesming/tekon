import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

import {
  listRoleIds,
  loadRole,
  materializeProjectRole,
  roleSchema,
} from '@tekon/core';

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
    const target = join(repoPath, '.tekon', 'roles', roleId);
    if (existsSync(target)) {
      throw new Error(`角色已存在: ${roleId}（${target}）。`);
    }

    // 物化逻辑（内置整目录复制/自定义脚手架、realpath 锚定与软链闸门、
    // 临时目录原子替换）下沉 core，CLI 与 Web 共用同一实现。
    const result = materializeProjectRole({
      role,
      repoPath,
      builtInRolesDir,
    });
    io.stdout.write(`${result.roleDir}\n`);
    return;
  }

  throw new Error(
    `未知的 role 子命令: ${subcommand ?? ''}。请使用 tekon help role 查看可用子命令。`,
  );
}
