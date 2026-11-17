import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  assertValidRolePrompt,
  defaultBuiltInRolesDir,
  listAvailableRoles,
  materializeProjectRole,
  readRolePrompt,
  roleSchema,
  writeProjectRolePrompt,
} from '@tekon/core';

import type { ServerContext } from '../context.js';
import { assertSessionToken } from '../common.js';
import { ApiError } from '../errors.js';

export function createRoleRouter(context: ServerContext) {
  const repoPath = context.projectContext.projectRoot;
  const builtInRolesDir = defaultBuiltInRolesDir();

  function availableRoleIds(): Set<string> {
    return new Set(
      listAvailableRoles({ repoPath, builtInRolesDir }).map((role) => role.id),
    );
  }

  // RPC input schema 故意用宽 z.string()，语义校验在 handler 内完成以
  // 返回中文错误（dispatch 前置 parse 只会给英文模板）。
  function parseRoleId(raw: string): string {
    const parsed = roleSchema.safeParse(raw);
    if (!parsed.success) {
      throw new ApiError(
        'BAD_REQUEST',
        `无效的角色 ID: ${raw}。角色 ID 必须是 kebab-case 标识符（小写字母开头，仅含小写字母、数字和短横线）。`,
      );
    }
    return parsed.data;
  }

  function assertKnownRole(id: string): void {
    if (!availableRoleIds().has(id)) {
      throw new ApiError(
        'NOT_FOUND',
        `未找到角色: ${id}。新建角色请使用 CLI：tekon role create ${id}。`,
      );
    }
  }

  function toBadRequest(action: string, id: string, error: unknown): never {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ApiError('BAD_REQUEST', `${action}角色 ${id} 失败：${detail}`);
  }

  return {
    async list() {
      const roles = listAvailableRoles({ repoPath, builtInRolesDir }).map(
        (role) => ({ ...role, name: role.id.toUpperCase() }),
      );
      return { roles };
    },

    async get(input: { id: string }) {
      const id = parseRoleId(input.id);
      assertKnownRole(id);
      try {
        const prompt = readRolePrompt({
          role: id,
          repoPath,
          builtInRolesDir,
        });
        const projectPath = join(repoPath, '.tekon', 'roles', id);
        return {
          id,
          name: id.toUpperCase(),
          source: prompt.source,
          systemPrompt: prompt.systemPrompt,
          hasProjectOverride: existsSync(join(projectPath, 'agent.yaml')),
          projectPath,
        };
      } catch (error) {
        if (error instanceof ApiError) {
          throw error;
        }
        toBadRequest('读取', id, error);
      }
    },

    async updatePrompt(input: {
      id: string;
      systemPrompt: string;
      token: string;
    }) {
      assertSessionToken(context.projectContext, input.token);
      const id = parseRoleId(input.id);
      assertKnownRole(id);
      try {
        // S-1：prompt 校验必须先于物化，非法请求不得产生任何目录副作用。
        assertValidRolePrompt(input.systemPrompt);
        materializeProjectRole({ role: id, repoPath, builtInRolesDir });
        const result = writeProjectRolePrompt({
          role: id,
          repoPath,
          systemPrompt: input.systemPrompt,
        });
        return { id, source: 'project' as const, roleDir: result.roleDir };
      } catch (error) {
        if (error instanceof ApiError) {
          throw error;
        }
        toBadRequest('保存', id, error);
      }
    },
  };
}
