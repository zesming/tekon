import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createWebFixtureProject } from '../fixtures/project.js';
import { createApiCaller } from '../../src/server/api/root.js';
import { defaultBuiltInRolesDir } from '@tekon/core';

const cleanupTasks: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanupTasks.splice(0)) {
    cleanup();
  }
});

describe('role prompt RPC (PD-11)', () => {
  it('lists the built-in + project union with source and no prompt leakage', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const result = await api.role.list();

    expect(result.roles).toHaveLength(6);
    const byId = new Map(result.roles.map((role) => [role.id, role]));
    expect(byId.get('rd')).toMatchObject({ source: 'project' });
    expect(byId.get('pm')).toMatchObject({ source: 'built-in' });
    for (const role of result.roles) {
      expect(role).not.toHaveProperty('systemPrompt');
    }

    await api.close();
  });

  it('returns the effective prompt via role.get, scoped to the union', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    const pm = await api.role.get({ id: 'pm' });
    expect(pm.source).toBe('built-in');
    expect(pm.systemPrompt.length).toBeGreaterThan(0);
    expect(pm.hasProjectOverride).toBe(false);
    expect(pm.projectPath).toBe(
      join(realpathSync(fixture.projectRoot), '.tekon', 'roles', 'pm'),
    );

    const rd = await api.role.get({ id: 'rd' });
    expect(rd.source).toBe('project');
    expect(rd.systemPrompt).toBe('Implement scoped code changes.');
    expect(rd.hasProjectOverride).toBe(true);

    await api.close();
  });

  it('rejects invalid ids with 400 Chinese messages and unknown ids with 404', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    await expect(api.role.get({ id: '../escape' })).rejects.toMatchObject({
      code: 'BAD_REQUEST',
    });
    await expect(api.role.get({ id: '../escape' })).rejects.toThrow(/标识符/);

    await expect(api.role.get({ id: 'ghost-role' })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
    await expect(api.role.get({ id: 'ghost-role' })).rejects.toThrow(
      /未找到角色/,
    );

    await api.close();
  });

  it('does not expose user-level-only roles through role.get', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const fakeHome = mkdtempSync(join(tmpdir(), 'tekon-user-roles-'));
    cleanupTasks.push(() => rmSync(fakeHome, { force: true, recursive: true }));
    mkdirSync(join(fakeHome, '.tekon', 'roles', 'home-only'), {
      recursive: true,
    });
    writeFileSync(
      join(fakeHome, '.tekon', 'roles', 'home-only', 'agent.yaml'),
      'role: home-only\nname: Home Only\n',
    );
    writeFileSync(
      join(fakeHome, '.tekon', 'roles', 'home-only', 'system.md'),
      'user level prompt',
    );
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;
    try {
      const api = await createApiCaller({ projectRoot: fixture.projectRoot });
      const list = await api.role.list();
      expect(list.roles.map((role) => role.id)).not.toContain('home-only');
      await expect(api.role.get({ id: 'home-only' })).rejects.toMatchObject({
        code: 'NOT_FOUND',
      });
      await api.close();
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it('requires the session token for prompt updates', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    await expect(
      api.role.updatePrompt({
        id: 'pm',
        systemPrompt: 'new prompt',
        token: '',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });
    await expect(
      api.role.updatePrompt({
        id: 'pm',
        systemPrompt: 'new prompt',
        token: 'wrong-token',
      }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED' });

    await api.close();
  });

  it('materializes a project override on save without touching built-in files', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    const builtInSystemMd = join(defaultBuiltInRolesDir(), 'pm', 'system.md');
    const builtInSnapshot = readFileSync(builtInSystemMd, 'utf8');

    const result = await api.role.updatePrompt({
      id: 'pm',
      systemPrompt: '项目自定义 PM prompt',
      token: fixture.sessionToken,
    });

    expect(result.source).toBe('project');
    const projectRoleDir = join(fixture.projectRoot, '.tekon', 'roles', 'pm');
    // 整目录物化：agent.yaml 与 system.md 齐备，loadRole 可读。
    expect(existsSync(join(projectRoleDir, 'agent.yaml'))).toBe(true);
    expect(readFileSync(join(projectRoleDir, 'system.md'), 'utf8')).toBe(
      '项目自定义 PM prompt',
    );
    // 内置安装目录零改动。
    expect(readFileSync(builtInSystemMd, 'utf8')).toBe(builtInSnapshot);

    const after = await api.role.get({ id: 'pm' });
    expect(after.source).toBe('project');
    expect(after.hasProjectOverride).toBe(true);
    expect(after.systemPrompt).toBe('项目自定义 PM prompt');

    await api.close();
  });

  it('rejects blank and oversized prompts with Chinese 400 errors', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });

    await expect(
      api.role.updatePrompt({
        id: 'pm',
        systemPrompt: '   \n\t',
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    await expect(
      api.role.updatePrompt({
        id: 'pm',
        systemPrompt: '   \n\t',
        token: fixture.sessionToken,
      }),
    ).rejects.toThrow(/ROLE_PROMPT_INVALID/);

    const oversized = '中'.repeat((64 * 1024) / 3 + 2);
    await expect(
      api.role.updatePrompt({
        id: 'pm',
        systemPrompt: oversized,
        token: fixture.sessionToken,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });

    await api.close();
  });

  it('rejects invalid prompts before materialization, leaving no project role dir', async () => {
    const fixture = await createWebFixtureProject();
    cleanupTasks.push(fixture.cleanup);
    const api = await createApiCaller({ projectRoot: fixture.projectRoot });
    const projectRoleDir = join(fixture.projectRoot, '.tekon', 'roles', 'pm');

    for (const badPrompt of ['   \n\t', '中'.repeat((64 * 1024) / 3 + 2)]) {
      await expect(
        api.role.updatePrompt({
          id: 'pm',
          systemPrompt: badPrompt,
          token: fixture.sessionToken,
        }),
      ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    }

    // S-1：失败请求不得产生任何文件系统副作用——内置角色来源不被静默翻转。
    expect(existsSync(projectRoleDir)).toBe(false);
    const after = await api.role.get({ id: 'pm' });
    expect(after.source).toBe('built-in');
    expect(after.hasProjectOverride).toBe(false);

    await api.close();
  });
});
