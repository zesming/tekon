import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  detectRepoProfile,
  loadRepoProfile,
  repoProfileCommand,
  repoProfileCommandGuidance,
  suggestRepoProfileCommandFixes,
  writeDefaultRepoProfile,
} from '../../src/index.js';

describe('repo profile', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { force: true, recursive: true });
    }
  });

  it('detects npm and pnpm validation commands from package scripts', () => {
    const npmRepo = mkdtempSync(join(tmpdir(), 'donkey-profile-npm-'));
    const pnpmRepo = mkdtempSync(join(tmpdir(), 'donkey-profile-pnpm-'));
    tempDirs.push(npmRepo, pnpmRepo);

    writeFileSync(
      join(npmRepo, 'package.json'),
      JSON.stringify({ scripts: { build: 'tsc', test: 'vitest' } }),
      'utf8',
    );
    writeFileSync(
      join(pnpmRepo, 'package.json'),
      JSON.stringify({
        packageManager: 'pnpm@10.12.1',
        scripts: {
          lint: 'eslint .',
          typecheck: 'tsc --noEmit',
          'security:scan': 'gitleaks detect',
        },
      }),
      'utf8',
    );

    expect(detectRepoProfile(npmRepo).commands).toMatchObject({
      build: { tool: 'npm', args: ['run', 'build'] },
      test: { tool: 'npm', args: ['run', 'test'] },
    });
    expect(detectRepoProfile(pnpmRepo).commands).toMatchObject({
      lint: { tool: 'pnpm', args: ['lint'] },
      typecheck: { tool: 'pnpm', args: ['typecheck'] },
      security: { tool: 'pnpm', args: ['security:scan'] },
    });
  });

  it('writes and reloads .donkey repo-profile.yaml', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'donkey-profile-write-'));
    tempDirs.push(repoPath);
    mkdirSync(join(repoPath, '.donkey'), { recursive: true });
    writeFileSync(
      join(repoPath, 'package.json'),
      JSON.stringify({ scripts: { e2e: 'playwright test' } }),
      'utf8',
    );

    const written = writeDefaultRepoProfile(repoPath);
    const loaded = loadRepoProfile(repoPath);

    expect(loaded).toEqual(written);
    expect(repoProfileCommand(loaded, 'e2e')).toEqual({
      tool: 'npm',
      args: ['run', 'e2e'],
    });
  });

  it('loads explicit notApplicable commands without treating them as missing', () => {
    const repoPath = mkdtempSync(join(tmpdir(), 'donkey-profile-na-'));
    tempDirs.push(repoPath);
    mkdirSync(join(repoPath, '.donkey'), { recursive: true });
    writeFileSync(
      join(repoPath, '.donkey', 'repo-profile.yaml'),
      [
        'version: 1',
        'commands:',
        '  e2e:',
        '    notApplicable: true',
        '    reason: "package has no browser surface"',
        'pr:',
        '  baseBranch: main',
        '  titlePrefix: ""',
        'risks:',
        '  highRiskPaths: []',
        '  requiresHumanApproval: []',
      ].join('\n'),
      'utf8',
    );

    const profile = loadRepoProfile(repoPath);
    const guidance = repoProfileCommandGuidance(repoPath, profile, 'e2e');

    expect(repoProfileCommand(profile, 'e2e')).toBeNull();
    expect(guidance).toMatchObject({
      status: 'not-applicable',
      hint: 'commands.e2e is explicitly marked notApplicable',
      reason: 'package has no browser surface',
      suggestions: [],
    });
  });

  it('suggests package script aliases for missing profile commands', () => {
    const npmRepo = mkdtempSync(join(tmpdir(), 'donkey-profile-hint-npm-'));
    const pnpmRepo = mkdtempSync(join(tmpdir(), 'donkey-profile-hint-pnpm-'));
    tempDirs.push(npmRepo, pnpmRepo);

    writeFileSync(
      join(npmRepo, 'package.json'),
      JSON.stringify({ scripts: { compile: 'tsc -p tsconfig.json' } }),
      'utf8',
    );
    writeFileSync(
      join(pnpmRepo, 'package.json'),
      JSON.stringify({
        packageManager: 'pnpm@10.12.1',
        scripts: { 'test:e2e': 'playwright test' },
      }),
      'utf8',
    );

    const npmProfile = detectRepoProfile(npmRepo);
    const npmGuidance = repoProfileCommandGuidance(
      npmRepo,
      npmProfile,
      'build',
    );
    expect(repoProfileCommand(npmProfile, 'build')).toBeNull();
    expect(npmGuidance).toMatchObject({
      status: 'missing',
      hint: 'add commands.build to .donkey/repo-profile.yaml',
      suggestions: [
        {
          scriptName: 'compile',
          command: { tool: 'npm', args: ['run', 'compile'] },
          commandText: 'npm run compile',
        },
      ],
    });
    expect(npmGuidance.suggestions[0]?.yamlSnippet).toContain('build:');
    expect(npmGuidance.suggestions[0]?.yamlSnippet).toContain('- compile');

    expect(suggestRepoProfileCommandFixes(pnpmRepo, 'e2e')).toMatchObject([
      {
        scriptName: 'test:e2e',
        command: { tool: 'pnpm', args: ['test:e2e'] },
        commandText: 'pnpm test:e2e',
      },
    ]);
  });
});
