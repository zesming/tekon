import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 测试夹具用：把 repo-profile 的六个命令引用全部解析为基线内的安全命令
 * （git 在固定 allow-list 且任何环境可用），使受理期的 missing-command
 * 阻断（PD-04）不干扰与命令绑定无关的引擎/会话测试。Test-only。
 */
export function writePermissiveRepoProfile(repoPath: string): void {
  const tekonDir = join(repoPath, '.tekon');
  mkdirSync(tekonDir, { recursive: true });
  const commands = Object.fromEntries(
    (['build', 'typecheck', 'lint', 'test', 'e2e', 'security'] as const).map(
      (ref) => [
        ref,
        { tool: 'git', args: ['--version'], description: `fixture ${ref}` },
      ],
    ),
  );
  writeFileSync(
    join(tekonDir, 'repo-profile.yaml'),
    JSON.stringify({ version: 1, commands }),
    'utf8',
  );
}
