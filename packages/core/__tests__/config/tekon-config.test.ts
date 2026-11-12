import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { readTekonConfig, resolveDefaultAgent } from '../../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repoWithConfig(yaml?: string): string {
  const repo = mkdtempSync(join(tmpdir(), 'tekon-config-'));
  dirs.push(repo);
  if (yaml !== undefined) {
    mkdirSync(join(repo, '.tekon'));
    writeFileSync(join(repo, '.tekon', 'config.yaml'), yaml);
  }
  return repo;
}

describe('readTekonConfig', () => {
  it('returns an empty config when the file is missing', () => {
    expect(readTekonConfig(repoWithConfig())).toEqual({});
  });

  it('accepts legacy project and storage fields', () => {
    const config = readTekonConfig(
      repoWithConfig('project:\n  name: x\n  repoPath: /x\nstorage:\n  dataDir: .tekon\ndefaultAgent: codex\n'),
    );
    expect(config.defaultAgent).toBe('codex');
  });

  it('reports a YAML syntax error instead of falling back', () => {
    expect(() => readTekonConfig(repoWithConfig('defaultAgent: [codex\n'))).toThrow(
      /config\.yaml/,
    );
  });

  it.each([
    ['defaultagent: codex\n', 'defaultagent'],
    ['default_agent: codex\n', 'default_agent'],
    ['provider:\n  codex:\n    profile: internal\n', 'provider'],
  ])('rejects a misspelled top-level field (%s)', (yaml, field) => {
    expect(() => readTekonConfig(repoWithConfig(yaml))).toThrow(new RegExp(field));
  });

  it('treats empty provider sections as unset', () => {
    expect(readTekonConfig(repoWithConfig('providers:\n  codex:\n'))).toEqual({
      providers: {},
    });
    expect(readTekonConfig(repoWithConfig('providers:\n'))).toEqual({});
  });

  it('reports a config path that cannot be read', () => {
    const repo = repoWithConfig();
    mkdirSync(join(repo, '.tekon', 'config.yaml'), { recursive: true });
    expect(() => readTekonConfig(repo)).toThrow(/cannot be read/);
  });

  it.each(['-x', '--dangerously-bypass-approvals-and-sandbox', '.hidden'])(
    'rejects codex profile %s',
    (profile) => {
      expect(() =>
        readTekonConfig(repoWithConfig(`providers:\n  codex:\n    profile: "${profile}"\n`)),
      ).toThrow(/profile/);
    },
  );

  it('does not echo a value written into a passthrough name', () => {
    let message = '';
    try {
      readTekonConfig(
        repoWithConfig('providers:\n  claude-code:\n    passthroughEnv: ["API_TOKEN=s3cr3t-value"]\n'),
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/API_TOKEN/);
    expect(message).not.toContain('s3cr3t-value');
  });

  it('rejects an unknown defaultAgent', () => {
    expect(() => readTekonConfig(repoWithConfig('defaultAgent: gpt\n'))).toThrow(/defaultAgent/);
  });

  it('reads provider passthrough names and the codex profile', () => {
    const config = readTekonConfig(
      repoWithConfig(
        [
          'providers:',
          '  claude-code:',
          '    passthroughEnv: [AWS_PROFILE, CLAUDE_CODE_USE_BEDROCK]',
          '  codex:',
          '    profile: internal',
          '    passthroughEnv: [AZURE_OPENAI_API_KEY]',
          '',
        ].join('\n'),
      ),
    );
    expect(config.providers).toEqual({
      'claude-code': { passthroughEnv: ['AWS_PROFILE', 'CLAUDE_CODE_USE_BEDROCK'] },
      codex: { profile: 'internal', passthroughEnv: ['AZURE_OPENAI_API_KEY'] },
    });
  });

  it.each([
    'lower_case',
    '1STARTS_WITH_DIGIT',
    'PATH',
    'SHELL',
    'ENV',
    'BASH_ENV',
    'BASHOPTS',
    'SHELLOPTS',
    'PS4',
    'ZDOTDIR',
    'PROMPT_COMMAND',
    'XDG_CONFIG_HOME',
    '_JAVA_OPTIONS',
    'JDK_JAVA_OPTIONS',
    'PERL5OPT',
    'PERL5LIB',
    'PERLLIB',
    'RUBYOPT',
    'RUBYLIB',
    'JAVA_TOOL_OPTIONS',
    'NODE_OPTIONS',
    'LD_PRELOAD',
    'DYLD_INSERT_LIBRARIES',
    'GIT_SSH_COMMAND',
    'TEKON_OUTPUT_DIR',
    'NPM_CONFIG_USERCONFIG',
    'PYTHONSTARTUP',
  ])('rejects passthrough name %s', (name) => {
    expect(() =>
      readTekonConfig(repoWithConfig(`providers:\n  claude-code:\n    passthroughEnv: [${name}]\n`)),
    ).toThrow(new RegExp(name));
  });
});

describe('resolveDefaultAgent', () => {
  it('falls back to claude-code', () => {
    expect(resolveDefaultAgent({})).toBe('claude-code');
  });

  it('uses the configured agent', () => {
    expect(resolveDefaultAgent({ defaultAgent: 'codex' })).toBe('codex');
  });
});
