import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadRole } from '../../src/role/loader.js';
import {
  listAvailableRoles,
  materializeProjectRole,
  readRolePrompt,
  writeProjectRolePrompt,
} from '../../src/role/project-overrides.js';

interface Layout {
  root: string;
  repoPath: string;
  builtInRolesDir: string;
}

function createLayout(): Layout {
  const root = mkdtempSync(join(tmpdir(), 'tekon-role-overrides-'));
  const repoPath = join(root, 'repo');
  const builtInRolesDir = join(root, 'roles');
  mkdirSync(repoPath, { recursive: true });
  return { root, repoPath, builtInRolesDir };
}

function seedBuiltInRole(
  builtInRolesDir: string,
  id: string,
  systemPrompt = `built-in ${id} prompt`,
): void {
  const dir = join(builtInRolesDir, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'agent.yaml'), `role: ${id}\nname: ${id}\n`);
  writeFileSync(join(dir, 'system.md'), systemPrompt);
  writeFileSync(
    join(dir, 'tools.yaml'),
    'network: disabled\nallow: []\ndeny: []\n',
  );
  mkdirSync(join(dir, 'skills'), { recursive: true });
  writeFileSync(join(dir, 'skills', 'skill-a.md'), `# ${id} skill`);
}

describe('role project overrides', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      // 权限可能被用例收紧，先恢复再清理。
      try {
        chmodSync(dir, 0o700);
      } catch {
        // 目录已不存在时忽略。
      }
      rmSync(dir, { force: true, recursive: true });
    }
  });

  // ── listAvailableRoles ──────────────────────────────────────────────────

  it('lists built-in roles with source when the project has no role dir', () => {
    const layout = createLayout();
    tempDirs.push(layout.root);
    seedBuiltInRole(layout.builtInRolesDir, 'pm');
    seedBuiltInRole(layout.builtInRolesDir, 'rd');

    const roles = listAvailableRoles({
      repoPath: layout.repoPath,
      builtInRolesDir: layout.builtInRolesDir,
    });

    expect(roles).toEqual([
      { id: 'pm', source: 'built-in', hasSystemPrompt: true },
      { id: 'rd', source: 'built-in', hasSystemPrompt: true },
    ]);
  });

  it('marks a project role as project source and de-duplicates the union', () => {
    const layout = createLayout();
    tempDirs.push(layout.root);
    seedBuiltInRole(layout.builtInRolesDir, 'pm');
    seedBuiltInRole(layout.builtInRolesDir, 'rd');
    mkdirSync(join(layout.repoPath, '.tekon', 'roles', 'rd'), {
      recursive: true,
    });
    writeFileSync(
      join(layout.repoPath, '.tekon', 'roles', 'rd', 'agent.yaml'),
      'role: rd\nname: RD\n',
    );
    writeFileSync(
      join(layout.repoPath, '.tekon', 'roles', 'rd', 'system.md'),
      'project rd prompt',
    );

    const roles = listAvailableRoles({
      repoPath: layout.repoPath,
      builtInRolesDir: layout.builtInRolesDir,
    });

    expect(roles).toHaveLength(2);
    expect(roles.find((role) => role.id === 'rd')).toEqual({
      id: 'rd',
      source: 'project',
      hasSystemPrompt: true,
    });
    expect(roles.find((role) => role.id === 'pm')?.source).toBe('built-in');
  });

  it('ignores non-identifier entries and half-baked project dirs without agent.yaml', () => {
    const layout = createLayout();
    tempDirs.push(layout.root);
    seedBuiltInRole(layout.builtInRolesDir, 'pm');
    const rolesDir = join(layout.repoPath, '.tekon', 'roles');
    mkdirSync(join(rolesDir, '.DS_Store'), { recursive: true });
    mkdirSync(join(rolesDir, 'custom-no-agent'), { recursive: true });

    const roles = listAvailableRoles({
      repoPath: layout.repoPath,
      builtInRolesDir: layout.builtInRolesDir,
    });

    expect(roles.map((role) => role.id)).toEqual(['pm']);
  });

  // ── readRolePrompt ───────────────────────────────────────────────────────

  it('reads the effective prompt from built-in then project override', () => {
    const layout = createLayout();
    tempDirs.push(layout.root);
    seedBuiltInRole(layout.builtInRolesDir, 'pm', 'built-in pm words');

    const before = readRolePrompt({
      role: 'pm',
      repoPath: layout.repoPath,
      builtInRolesDir: layout.builtInRolesDir,
    });
    expect(before.source).toBe('built-in');
    expect(before.systemPrompt).toBe('built-in pm words');

    materializeProjectRole({
      role: 'pm',
      repoPath: layout.repoPath,
      builtInRolesDir: layout.builtInRolesDir,
    });
    writeProjectRolePrompt({
      role: 'pm',
      repoPath: layout.repoPath,
      systemPrompt: 'project pm words',
    });

    const after = readRolePrompt({
      role: 'pm',
      repoPath: layout.repoPath,
      builtInRolesDir: layout.builtInRolesDir,
    });
    expect(after.source).toBe('project');
    expect(after.systemPrompt).toBe('project pm words');
    // loadRole 合同在覆盖后仍然成立。
    expect(
      loadRole({
        role: 'pm',
        repoPath: layout.repoPath,
        builtInRolesDir: layout.builtInRolesDir,
      }).systemPrompt,
    ).toBe('project pm words');
  });

  // ── materializeProjectRole ───────────────────────────────────────────────

  it('copies the whole built-in role folder so loadRole stays readable', () => {
    const layout = createLayout();
    tempDirs.push(layout.root);
    seedBuiltInRole(layout.builtInRolesDir, 'rd');

    const result = materializeProjectRole({
      role: 'rd',
      repoPath: layout.repoPath,
      builtInRolesDir: layout.builtInRolesDir,
    });

    expect(result.outcome).toBe('copied');
    const target = join(layout.repoPath, '.tekon', 'roles', 'rd');
    expect(result.roleDir).toBe(realpathSync(target));
    expect(existsSync(join(target, 'agent.yaml'))).toBe(true);
    expect(existsSync(join(target, 'tools.yaml'))).toBe(true);
    expect(existsSync(join(target, 'skills', 'skill-a.md'))).toBe(true);
    expect(() =>
      loadRole({
        role: 'rd',
        repoPath: layout.repoPath,
        builtInRolesDir: layout.builtInRolesDir,
      }),
    ).not.toThrow();
  });

  it('scaffolds a minimal folder for a custom role id', () => {
    const layout = createLayout();
    tempDirs.push(layout.root);

    const result = materializeProjectRole({
      role: 'writer',
      repoPath: layout.repoPath,
      builtInRolesDir: layout.builtInRolesDir,
    });

    expect(result.outcome).toBe('scaffolded');
    const target = join(layout.repoPath, '.tekon', 'roles', 'writer');
    expect(readFileSync(join(target, 'agent.yaml'), 'utf8')).toContain(
      'role: writer',
    );
    expect(existsSync(join(target, 'system.md'))).toBe(true);
  });

  it('returns existed on repeat materialization without overwriting files', () => {
    const layout = createLayout();
    tempDirs.push(layout.root);
    seedBuiltInRole(layout.builtInRolesDir, 'pm');
    materializeProjectRole({
      role: 'pm',
      repoPath: layout.repoPath,
      builtInRolesDir: layout.builtInRolesDir,
    });
    writeProjectRolePrompt({
      role: 'pm',
      repoPath: layout.repoPath,
      systemPrompt: 'user edited prompt',
    });

    const repeat = materializeProjectRole({
      role: 'pm',
      repoPath: layout.repoPath,
      builtInRolesDir: layout.builtInRolesDir,
    });

    expect(repeat.outcome).toBe('existed');
    expect(
      readFileSync(
        join(layout.repoPath, '.tekon', 'roles', 'pm', 'system.md'),
        'utf8',
      ),
    ).toBe('user edited prompt');
  });

  it('rejects a target occupied by a regular file or dangling symlink', () => {
    const layout = createLayout();
    tempDirs.push(layout.root);
    const rolesDir = join(layout.repoPath, '.tekon', 'roles');
    mkdirSync(rolesDir, { recursive: true });
    writeFileSync(join(rolesDir, 'pm'), 'not a directory');
    symlinkSync('does-not-exist', join(rolesDir, 'rd'));

    expect(() =>
      materializeProjectRole({
        role: 'pm',
        repoPath: layout.repoPath,
        builtInRolesDir: layout.builtInRolesDir,
      }),
    ).toThrow(/ROLE_DIR_INVALID/);
    expect(() =>
      materializeProjectRole({
        role: 'rd',
        repoPath: layout.repoPath,
        builtInRolesDir: layout.builtInRolesDir,
      }),
    ).toThrow(/ROLE_DIR_INVALID/);
  });

  it('cleans up temp residue after a copy failure and allows retry', () => {
    const layout = createLayout();
    tempDirs.push(layout.root);
    seedBuiltInRole(layout.builtInRolesDir, 'pm');
    const sourceDir = join(layout.builtInRolesDir, 'pm');
    const rolesDir = join(layout.repoPath, '.tekon', 'roles');

    chmodSync(sourceDir, 0o000);
    // 必须抛可捕获的 JS 可读错误而非让进程崩溃：Node 24 上 cpSync 递归遇到
    // 无权限目录会因 native directory_iterator C++ 异常逃逸而 SIGABRT，
    // 产品代码在 cpSync 前用 access 预检把它收敛为 ROLE_DIR_INVALID。
    expect(() =>
      materializeProjectRole({
        role: 'pm',
        repoPath: layout.repoPath,
        builtInRolesDir: layout.builtInRolesDir,
      }),
    ).toThrow(/ROLE_DIR_INVALID/);
    chmodSync(sourceDir, 0o700);

    // 无目标、无临时目录残留。
    expect(existsSync(join(rolesDir, 'pm'))).toBe(false);
    const residue = readdirSync(rolesDir);
    expect(residue.filter((entry) => entry.startsWith('.pm.tmp-'))).toEqual([]);

    const retry = materializeProjectRole({
      role: 'pm',
      repoPath: layout.repoPath,
      builtInRolesDir: layout.builtInRolesDir,
    });
    expect(retry.outcome).toBe('copied');
  });

  it('fails closed on an unreadable nested subdirectory without crashing or residue', () => {
    const layout = createLayout();
    tempDirs.push(layout.root);
    seedBuiltInRole(layout.builtInRolesDir, 'pm');
    const roleRoot = join(layout.builtInRolesDir, 'pm');
    const nestedSkills = join(roleRoot, 'skills');
    const rolesDir = join(layout.repoPath, '.tekon', 'roles');

    // 角色根保持可读，仅撤销嵌套 skills 目录权限——根级 access 预检会放行，
    // 只有递归预扫描能拦住。Node 24 上若漏拦，cpSync 的 native 迭代器会
    // SIGABRT；这里必须收敛为可捕获的 ROLE_DIR_INVALID。
    chmodSync(nestedSkills, 0o000);
    try {
      expect(() =>
        materializeProjectRole({
          role: 'pm',
          repoPath: layout.repoPath,
          builtInRolesDir: layout.builtInRolesDir,
        }),
      ).toThrow(/ROLE_DIR_INVALID/);

      // 不产生目标目录，也不留下 .pm.tmp- 临时残留。
      expect(existsSync(join(rolesDir, 'pm'))).toBe(false);
      expect(
        readdirSync(rolesDir).some((entry) => entry.startsWith('.pm.tmp-')),
      ).toBe(false);
    } finally {
      // 必须先恢复嵌套目录权限，afterEach 的顶层 chmod 无法穿透 0o000 清理。
      chmodSync(nestedSkills, 0o700);
    }

    // 权限恢复后可正常物化，证明预检未造成一次性损坏。
    const retry = materializeProjectRole({
      role: 'pm',
      repoPath: layout.repoPath,
      builtInRolesDir: layout.builtInRolesDir,
    });
    expect(retry.outcome).toBe('copied');
  });

  // ── writeProjectRolePrompt ───────────────────────────────────────────────

  it('writes prompt only into a materialized project role', () => {
    const layout = createLayout();
    tempDirs.push(layout.root);
    seedBuiltInRole(layout.builtInRolesDir, 'qa');

    expect(() =>
      writeProjectRolePrompt({
        role: 'qa',
        repoPath: layout.repoPath,
        systemPrompt: 'new words',
      }),
    ).toThrow(/ROLE_NOT_MATERIALIZED/);

    materializeProjectRole({
      role: 'qa',
      repoPath: layout.repoPath,
      builtInRolesDir: layout.builtInRolesDir,
    });
    expect(() =>
      writeProjectRolePrompt({
        role: 'qa',
        repoPath: layout.repoPath,
        systemPrompt: 'new words',
      }),
    ).not.toThrow();
  });

  it('rejects blank and oversized prompts using utf8 byte length', () => {
    const layout = createLayout();
    tempDirs.push(layout.root);
    seedBuiltInRole(layout.builtInRolesDir, 'pm');
    materializeProjectRole({
      role: 'pm',
      repoPath: layout.repoPath,
      builtInRolesDir: layout.builtInRolesDir,
    });

    expect(() =>
      writeProjectRolePrompt({
        role: 'pm',
        repoPath: layout.repoPath,
        systemPrompt: '   \n\t',
      }),
    ).toThrow(/ROLE_PROMPT_INVALID/);

    const maxBytes = 64 * 1024;
    // 中文每字符 3 字节：用字符长度构造跨字节边界的超长输入。
    const oversized = '中'.repeat(Math.floor(maxBytes / 3) + 2);
    expect(Buffer.byteLength(oversized, 'utf8')).toBeGreaterThan(maxBytes);
    expect(() =>
      writeProjectRolePrompt({
        role: 'pm',
        repoPath: layout.repoPath,
        systemPrompt: oversized,
      }),
    ).toThrow(/ROLE_PROMPT_INVALID/);
  });

  it('rejects invalid role identifiers', () => {
    const layout = createLayout();
    tempDirs.push(layout.root);

    expect(() =>
      writeProjectRolePrompt({
        role: '../escape',
        repoPath: layout.repoPath,
        systemPrompt: 'x',
      }),
    ).toThrow(/ROLE_ID_INVALID/);
  });

  // ── 安全闸门（M1 对抗夹具） ──────────────────────────────────────────────

  it('rejects a roles dir that is itself a symlink', () => {
    const layout = createLayout();
    tempDirs.push(layout.root);
    seedBuiltInRole(layout.builtInRolesDir, 'pm');
    const outside = join(layout.root, 'outside');
    mkdirSync(outside, { recursive: true });
    mkdirSync(join(layout.repoPath, '.tekon'), { recursive: true });
    symlinkSync(outside, join(layout.repoPath, '.tekon', 'roles'));

    expect(() =>
      materializeProjectRole({
        role: 'pm',
        repoPath: layout.repoPath,
        builtInRolesDir: layout.builtInRolesDir,
      }),
    ).toThrow(/ROLE_PATH_ESCAPE/);
  });

  it('rejects when the .tekon parent is a symlink leading outside the repo', () => {
    const layout = createLayout();
    tempDirs.push(layout.root);
    seedBuiltInRole(layout.builtInRolesDir, 'pm');
    const outside = join(layout.root, 'outside');
    mkdirSync(join(outside, 'roles'), { recursive: true });
    // repo/.tekon -> outside（roles 实体在仓库外）。
    symlinkSync(outside, join(layout.repoPath, '.tekon'));

    expect(() =>
      materializeProjectRole({
        role: 'pm',
        repoPath: layout.repoPath,
        builtInRolesDir: layout.builtInRolesDir,
      }),
    ).toThrow(/ROLE_PATH_ESCAPE/);
    expect(existsSync(join(outside, 'roles', 'pm'))).toBe(false);
  });

  it('rejects a role dir symlink that escapes the roles root', () => {
    const layout = createLayout();
    tempDirs.push(layout.root);
    seedBuiltInRole(layout.builtInRolesDir, 'pm');
    const rolesDir = join(layout.repoPath, '.tekon', 'roles');
    mkdirSync(rolesDir, { recursive: true });
    const outside = join(layout.root, 'outside-pm');
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(rolesDir, 'pm'));

    expect(() =>
      materializeProjectRole({
        role: 'pm',
        repoPath: layout.repoPath,
        builtInRolesDir: layout.builtInRolesDir,
      }),
    ).toThrow(/ROLE_PATH_ESCAPE/);
  });

  it('rejects writing through a system.md symlink pointing outside', () => {
    const layout = createLayout();
    tempDirs.push(layout.root);
    seedBuiltInRole(layout.builtInRolesDir, 'pm');
    materializeProjectRole({
      role: 'pm',
      repoPath: layout.repoPath,
      builtInRolesDir: layout.builtInRolesDir,
    });
    const target = join(layout.repoPath, '.tekon', 'roles', 'pm');
    const outsideFile = join(layout.root, 'outside-system.md');
    writeFileSync(outsideFile, 'untouched');
    rmSync(join(target, 'system.md'), { force: true });
    symlinkSync(outsideFile, join(target, 'system.md'));

    expect(() =>
      writeProjectRolePrompt({
        role: 'pm',
        repoPath: layout.repoPath,
        systemPrompt: 'should not land outside',
      }),
    ).toThrow(/ROLE_PATH_ESCAPE/);
    expect(readFileSync(outsideFile, 'utf8')).toBe('untouched');
  });

  it('rejects a built-in source role dir that is itself an escaping symlink', () => {
    const layout = createLayout();
    tempDirs.push(layout.root);
    // 内置角色位放一个指向仓库外的软链（目标含 agent.yaml，能通过 existsSync）。
    const outsideRole = join(layout.root, 'outside-roles', 'pm');
    mkdirSync(outsideRole, { recursive: true });
    writeFileSync(join(outsideRole, 'agent.yaml'), 'role: pm\nname: pm\n');
    mkdirSync(layout.builtInRolesDir, { recursive: true });
    symlinkSync(outsideRole, join(layout.builtInRolesDir, 'pm'));

    expect(() =>
      materializeProjectRole({
        role: 'pm',
        repoPath: layout.repoPath,
        builtInRolesDir: layout.builtInRolesDir,
      }),
    ).toThrow(/ROLE_PATH_ESCAPE/);
    // 源侧逃逸同样不得在项目侧落任何角色目录。
    expect(existsSync(join(layout.repoPath, '.tekon', 'roles', 'pm'))).toBe(
      false,
    );
  });

  it('never modifies the built-in role folder when editing its prompt', () => {
    const layout = createLayout();
    tempDirs.push(layout.root);
    seedBuiltInRole(layout.builtInRolesDir, 'pm', 'original built-in');
    const builtInSystemMd = join(layout.builtInRolesDir, 'pm', 'system.md');

    materializeProjectRole({
      role: 'pm',
      repoPath: layout.repoPath,
      builtInRolesDir: layout.builtInRolesDir,
    });
    writeProjectRolePrompt({
      role: 'pm',
      repoPath: layout.repoPath,
      systemPrompt: 'edited in project only',
    });

    expect(readFileSync(builtInSystemMd, 'utf8')).toBe('original built-in');
    expect(lstatSync(builtInSystemMd).isSymbolicLink()).toBe(false);
  });
});
