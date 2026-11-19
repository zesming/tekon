import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveAgentCommand } from '../src/lib/utils.js';

// Stage-1 refactor changed resolveAgentCommand from a silent read with a
// codex fallback to the strict repo config plus the core default. A malformed
// .tekon/config.yaml must surface as TekonConfigError instead of being hidden
// behind the interactive-draft path (衔接审查 core/cli 组 finding 2).
describe('resolveAgentCommand repo-config handling', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function repoWithConfig(contents: string | null): string {
    const repoPath = mkdtempSync(join(tmpdir(), 'tekon-draft-agent-'));
    tempDirs.push(repoPath);
    if (contents !== null) {
      mkdirSync(join(repoPath, '.tekon'), { recursive: true });
      writeFileSync(join(repoPath, '.tekon', 'config.yaml'), contents, 'utf8');
    }
    return repoPath;
  }

  it('maps the fallback claude-code default to the claude command without a config', () => {
    expect(resolveAgentCommand(repoWithConfig(null))).toBe('claude');
  });

  it('returns undefined for a configured non-interactive agent', () => {
    expect(resolveAgentCommand(repoWithConfig('defaultAgent: codex\n'))).toBeUndefined();
  });

  it('throws on a malformed config instead of silently falling back', () => {
    const repoPath = repoWithConfig('defaultAgent: [unclosed\n');
    expect(() => resolveAgentCommand(repoPath)).toThrow(/config\.yaml/);
  });

  it('throws on an unsupported defaultAgent enum value', () => {
    const repoPath = repoWithConfig('defaultAgent: not-a-real-agent\n');
    expect(() => resolveAgentCommand(repoPath)).toThrow(/config\.yaml/);
  });
});
