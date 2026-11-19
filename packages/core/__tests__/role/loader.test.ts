import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { listRoleIds, loadRole } from '../../src/role/loader.js';

describe('role loader', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('resolves project roles before user roles before built-in roles and treats agent folders as whole-folder overrides', () => {
    const root = mkdtempSync(join(tmpdir(), 'tekon-role-loader-'));
    tempDirs.push(root);
    const repoPath = join(root, 'repo');
    const userHome = join(root, 'home');
    const builtInRolesDir = join(root, 'roles');

    writeRole(builtInRolesDir, 'rd', {
      agent:
        'role: rd\nname: built-in rd\nknowledgeFiles:\n  - knowledge/base.md\n',
      system: 'built-in system',
      knowledge: { 'base.md': 'built-in knowledge' },
      skills: {
        'implement.md':
          '---\nid: implement\npriority: 10\ninjectMode: append\n---\nbuilt-in implement skill',
      },
    });
    writeRole(join(userHome, '.tekon', 'roles'), 'rd', {
      agent: 'role: rd\nname: user rd\n',
      system: 'user system',
      skills: {
        'implement.md':
          '---\nid: implement\npriority: 50\ninjectMode: append\n---\nuser implement skill',
      },
    });
    writeRole(join(repoPath, '.tekon', 'roles'), 'rd', {
      agent:
        'role: rd\nname: project rd\nmaxSkills: 1\nknowledgeFiles:\n  - knowledge/project.md\n',
      system: 'project system',
      knowledge: { 'project.md': 'project knowledge' },
      skills: {
        'review.md':
          '---\nid: review\npriority: 60\ninjectMode: append\n---\nproject review skill',
      },
    });

    const loaded = loadRole({
      role: 'rd',
      repoPath,
      userHome,
      builtInRolesDir,
    });

    expect(loaded.source).toBe('project');
    expect(loaded.agent.name).toBe('project rd');
    expect(loaded.systemPrompt).toBe('project system');
    expect(loaded.knowledge).toEqual([
      { path: 'knowledge/project.md', content: 'project knowledge' },
    ]);
    expect(loaded.skills).toEqual([
      expect.objectContaining({
        id: 'review',
        priority: 60,
        content: 'project review skill',
      }),
    ]);
  });

  it('merges skills by id from lower-priority role folders with higher-priority skill overrides', () => {
    const root = mkdtempSync(join(tmpdir(), 'tekon-role-skills-'));
    tempDirs.push(root);
    const repoPath = join(root, 'repo');
    const userHome = join(root, 'home');
    const builtInRolesDir = join(root, 'roles');

    writeRole(builtInRolesDir, 'qa', {
      agent: 'role: qa\nname: built-in qa\nmaxSkills: 3\n',
      system: 'built-in qa system',
      skills: {
        'test.md': '---\nid: test\npriority: 10\n---\nbuilt-in test skill',
        'report.md':
          '---\nid: report\npriority: 30\n---\nbuilt-in report skill',
      },
    });
    writeRole(join(userHome, '.tekon', 'roles'), 'qa', {
      agent: 'role: qa\nname: user qa\nmaxSkills: 3\n',
      system: 'user qa system',
      skills: {
        'test.md': '---\nid: test\npriority: 40\n---\nuser test skill',
      },
    });

    const loaded = loadRole({
      role: 'qa',
      repoPath,
      userHome,
      builtInRolesDir,
    });

    expect(loaded.source).toBe('user');
    expect(loaded.skills.map((skill) => [skill.id, skill.content])).toEqual([
      ['test', 'user test skill'],
      ['report', 'built-in report skill'],
    ]);
  });
  // PD-06 子项 3：角色名开放，自定义目录角色可见、可加载。
  it('lists and loads custom role ids instead of filtering to the built-in enum', () => {
    const root = mkdtempSync(join(tmpdir(), 'tekon-role-open-naming-'));
    tempDirs.push(root);
    const repoPath = join(root, 'repo');
    const builtInRolesDir = join(root, 'roles');

    writeRole(builtInRolesDir, 'rd', {
      agent: 'role: rd\nname: built-in rd\n',
      system: 'built-in system',
    });
    writeRole(join(repoPath, '.tekon', 'roles'), 'writer', {
      agent: 'role: writer\nname: Project Writer\n',
      system: 'writer system',
    });
    // 非标识符目录（含点号，如 macOS 元数据）应被忽略，而不是报错。
    mkdirSync(join(repoPath, '.tekon', 'roles', '.DS_Store'), {
      recursive: true,
    });

    const projectRoles = listRoleIds(join(repoPath, '.tekon', 'roles'));
    expect(projectRoles).toEqual(['writer']);

    const loaded = loadRole({
      role: 'writer',
      repoPath,
      builtInRolesDir,
    });
    expect(loaded.role).toBe('writer');
    expect(loaded.source).toBe('project');
    expect(loaded.agent.name).toBe('Project Writer');
    expect(loaded.systemPrompt).toBe('writer system');
  });

  it('rejects role ids that are not kebab-case identifiers when loading config', () => {
    const root = mkdtempSync(join(tmpdir(), 'tekon-role-bad-id-'));
    tempDirs.push(root);
    const rolesDir = join(root, 'roles');
    writeRole(rolesDir, 'Bad Role', {
      agent: 'role: Bad Role\nname: Bad\n',
      system: 'bad',
    });

    expect(() =>
      loadRole({ role: 'Bad Role', repoPath: root, builtInRolesDir: rolesDir }),
    ).toThrow();
    expect(listRoleIds(rolesDir)).toEqual([]);
  });
});

function writeRole(
  rolesRoot: string,
  role: string,
  input: {
    agent: string;
    system: string;
    skills?: Record<string, string>;
    knowledge?: Record<string, string>;
    tools?: string;
  },
) {
  const roleDir = join(rolesRoot, role);
  mkdirSync(join(roleDir, 'skills'), { recursive: true });
  mkdirSync(join(roleDir, 'knowledge'), { recursive: true });
  writeFileSync(join(roleDir, 'agent.yaml'), input.agent, 'utf8');
  writeFileSync(join(roleDir, 'system.md'), input.system, 'utf8');
  if (input.tools) {
    writeFileSync(join(roleDir, 'tools.yaml'), input.tools, 'utf8');
  }
  for (const [filename, content] of Object.entries(input.skills ?? {})) {
    writeFileSync(join(roleDir, 'skills', filename), content, 'utf8');
  }
  for (const [filename, content] of Object.entries(input.knowledge ?? {})) {
    writeFileSync(join(roleDir, 'knowledge', filename), content, 'utf8');
  }
}
