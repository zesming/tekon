import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadRole } from '../../src/role/loader.js';

// PD-10：角色 agent.yaml 可声明 driver/model/effort，不写时缺省、写了原样
// 保留给适配器翻译；字段不绑定具体厂商，取值用开放字符串。
describe('PD-10 role driver/model/effort schema', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function writeRole(agentYaml: string) {
    const root = mkdtempSync(join(tmpdir(), 'tekon-role-override-'));
    tempDirs.push(root);
    const builtInRolesDir = join(root, 'roles');
    const roleDir = join(builtInRolesDir, 'rd');
    mkdirSync(roleDir, { recursive: true });
    writeFileSync(join(roleDir, 'agent.yaml'), agentYaml, 'utf8');
    writeFileSync(join(roleDir, 'system.md'), 'system\n', 'utf8');
    return loadRole({
      role: 'rd',
      repoPath: join(root, 'repo'),
      userHome: join(root, 'home'),
      builtInRolesDir,
    });
  }

  it('leaves driver/model/effort undefined when omitted (zero behavior change)', () => {
    const loaded = writeRole(['role: rd', 'name: RD'].join('\n'));
    expect(loaded.agent.driver).toBeUndefined();
    expect(loaded.agent.model).toBeUndefined();
    expect(loaded.agent.effort).toBeUndefined();
  });

  it('parses driver/model/effort and preserves the exact declared values', () => {
    const loaded = writeRole(
      [
        'role: rd',
        'name: RD',
        'driver: claude-code',
        'model: claude-opts-5-5',
        'effort: high',
      ].join('\n'),
    );
    expect(loaded.agent.driver).toBe('claude-code');
    expect(loaded.agent.model).toBe('claude-opts-5-5');
    expect(loaded.agent.effort).toBe('high');
  });

  it('accepts vendor-neutral model/effort names without enum binding', () => {
    const loaded = writeRole(
      [
        'role: rd',
        'name: RD',
        'model: some-future-model-2027',
        'effort: xhigh',
      ].join('\n'),
    );
    expect(loaded.agent.model).toBe('some-future-model-2027');
    expect(loaded.agent.effort).toBe('xhigh');
  });

  it('rejects empty model/effort/driver strings', () => {
    expect(() => writeRole('role: rd\nname: RD\nmodel: ""\n')).toThrow();
    expect(() => writeRole('role: rd\nname: RD\neffort: ""\n')).toThrow();
    expect(() => writeRole('role: rd\nname: RD\ndriver: ""\n')).toThrow();
  });
});
