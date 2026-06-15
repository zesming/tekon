import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadRole } from '../../src/role/loader.js';

describe('extended agent.yaml schema', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses old-format agent.yaml without new fields (backward compatibility)', () => {
    const root = mkdtempSync(join(tmpdir(), 'tekon-agent-old-'));
    tempDirs.push(root);
    const builtInRolesDir = join(root, 'roles');

    writeRole(builtInRolesDir, 'rd', {
      agent: [
        'role: rd',
        'name: Legacy RD',
        'description: Old format agent config',
        'injectMode: append',
        'priority: 10',
      ].join('\n'),
      system: 'legacy system prompt',
    });

    const loaded = loadRole({
      role: 'rd',
      repoPath: join(root, 'repo'),
      userHome: join(root, 'home'),
      builtInRolesDir,
    });

    expect(loaded.agent.name).toBe('Legacy RD');
    expect(loaded.agent.role).toBe('rd');
    expect(loaded.agent.injectMode).toBe('append');
    expect(loaded.agent.priority).toBe(10);
    // New fields should be undefined when not specified
    expect(loaded.agent.autonomy).toBeUndefined();
    expect(loaded.agent.requiresHumanApprovalFor).toBeUndefined();
    expect(loaded.agent.defaultTimeoutMs).toBeUndefined();
    expect(loaded.agent.allowedGateTags).toBeUndefined();
  });

  it('parses new autonomy, requiresHumanApprovalFor, defaultTimeoutMs, and allowedGateTags', () => {
    const root = mkdtempSync(join(tmpdir(), 'tekon-agent-new-'));
    tempDirs.push(root);
    const builtInRolesDir = join(root, 'roles');

    writeRole(builtInRolesDir, 'rd', {
      agent: [
        'role: rd',
        'name: Extended RD',
        'autonomy:',
        '  level: auto-pr',
        '  riskTolerance: high',
        'requiresHumanApprovalFor:',
        "  - filePatterns: ['*.env', '**/secrets/**']",
        "  - toolPatterns: ['git push --force']",
        '  - actionTypes: [deploy, production-access]',
        'defaultTimeoutMs: 600000',
        "allowedGateTags: ['build', 'test', 'lint']",
      ].join('\n'),
      system: 'extended system prompt',
    });

    const loaded = loadRole({
      role: 'rd',
      repoPath: join(root, 'repo'),
      userHome: join(root, 'home'),
      builtInRolesDir,
    });

    expect(loaded.agent.autonomy).toEqual({
      level: 'auto-pr',
      riskTolerance: 'high',
    });
    expect(loaded.agent.requiresHumanApprovalFor).toEqual([
      { filePatterns: ['*.env', '**/secrets/**'] },
      { toolPatterns: ['git push --force'] },
      { actionTypes: ['deploy', 'production-access'] },
    ]);
    expect(loaded.agent.defaultTimeoutMs).toBe(600000);
    expect(loaded.agent.allowedGateTags).toEqual(['build', 'test', 'lint']);
  });

  it('parses partial autonomy config (only level, no riskTolerance)', () => {
    const root = mkdtempSync(join(tmpdir(), 'tekon-agent-partial-'));
    tempDirs.push(root);
    const builtInRolesDir = join(root, 'roles');

    writeRole(builtInRolesDir, 'qa', {
      agent: [
        'role: qa',
        'name: Partial QA',
        'autonomy:',
        '  level: restricted',
      ].join('\n'),
      system: 'partial system prompt',
    });

    const loaded = loadRole({
      role: 'qa',
      repoPath: join(root, 'repo'),
      userHome: join(root, 'home'),
      builtInRolesDir,
    });

    expect(loaded.agent.autonomy).toEqual({
      level: 'restricted',
      riskTolerance: undefined,
    });
  });

  it('rejects invalid autonomy level', () => {
    const root = mkdtempSync(join(tmpdir(), 'tekon-agent-invalid-'));
    tempDirs.push(root);
    const builtInRolesDir = join(root, 'roles');

    writeRole(builtInRolesDir, 'rd', {
      agent: [
        'role: rd',
        'name: Invalid RD',
        'autonomy:',
        '  level: full-autonomy',
      ].join('\n'),
      system: 'invalid system prompt',
    });

    expect(() =>
      loadRole({
        role: 'rd',
        repoPath: join(root, 'repo'),
        userHome: join(root, 'home'),
        builtInRolesDir,
      }),
    ).toThrow();
  });

  it('rejects invalid riskTolerance', () => {
    const root = mkdtempSync(join(tmpdir(), 'tekon-agent-bad-risk-'));
    tempDirs.push(root);
    const builtInRolesDir = join(root, 'roles');

    writeRole(builtInRolesDir, 'rd', {
      agent: [
        'role: rd',
        'name: Bad Risk RD',
        'autonomy:',
        '  riskTolerance: extreme',
      ].join('\n'),
      system: 'bad risk system prompt',
    });

    expect(() =>
      loadRole({
        role: 'rd',
        repoPath: join(root, 'repo'),
        userHome: join(root, 'home'),
        builtInRolesDir,
      }),
    ).toThrow();
  });

  it('rejects non-positive defaultTimeoutMs', () => {
    const root = mkdtempSync(join(tmpdir(), 'tekon-agent-bad-timeout-'));
    tempDirs.push(root);
    const builtInRolesDir = join(root, 'roles');

    writeRole(builtInRolesDir, 'rd', {
      agent: [
        'role: rd',
        'name: Bad Timeout RD',
        'defaultTimeoutMs: -1',
      ].join('\n'),
      system: 'bad timeout system prompt',
    });

    expect(() =>
      loadRole({
        role: 'rd',
        repoPath: join(root, 'repo'),
        userHome: join(root, 'home'),
        builtInRolesDir,
      }),
    ).toThrow();
  });

  it('rejects zero defaultTimeoutMs', () => {
    const root = mkdtempSync(join(tmpdir(), 'tekon-agent-zero-timeout-'));
    tempDirs.push(root);
    const builtInRolesDir = join(root, 'roles');

    writeRole(builtInRolesDir, 'rd', {
      agent: [
        'role: rd',
        'name: Zero Timeout RD',
        'defaultTimeoutMs: 0',
      ].join('\n'),
      system: 'zero timeout system prompt',
    });

    expect(() =>
      loadRole({
        role: 'rd',
        repoPath: join(root, 'repo'),
        userHome: join(root, 'home'),
        builtInRolesDir,
      }),
    ).toThrow();
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
  },
) {
  const roleDir = join(rolesRoot, role);
  mkdirSync(join(roleDir, 'skills'), { recursive: true });
  mkdirSync(join(roleDir, 'knowledge'), { recursive: true });
  writeFileSync(join(roleDir, 'agent.yaml'), input.agent, 'utf8');
  writeFileSync(join(roleDir, 'system.md'), input.system, 'utf8');
  for (const [filename, content] of Object.entries(input.skills ?? {})) {
    writeFileSync(join(roleDir, 'skills', filename), content, 'utf8');
  }
  for (const [filename, content] of Object.entries(input.knowledge ?? {})) {
    writeFileSync(join(roleDir, 'knowledge', filename), content, 'utf8');
  }
}
