import { cpSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { listRoleIds, loadRole } from '@tekon/core';

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
  const validRoles = ['pm', 'rd', 'qa', 'reviewer', 'pmo'] as const;
  if (!validRoles.includes(roleId as (typeof validRoles)[number])) {
    throw new Error(
      `无效的角色 ID: ${roleId}。可选值为: ${validRoles.join(', ')}`,
    );
  }
  const role = roleId as (typeof validRoles)[number];

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

  throw new Error(
    `未知的 role 子命令: ${subcommand ?? ''}。请使用 tekon help role 查看可用子命令。`,
  );
}
