import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

import { loadWorkflowTemplate } from '@tekon/core';

export function getVersion(): string {
  try {
    const pkgPath = join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      '..',
      'package.json',
    );
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

export function silentExec(
  cmd: string,
  args: string[],
  opts: { cwd: string },
) {
  try {
    return execFileSync(cmd, args, {
      ...opts,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch (error) {
    const stderr =
      error instanceof Error && 'stderr' in error
        ? String((error as { stderr?: unknown }).stderr ?? '')
        : '';
    throw new Error(
      `命令执行失败: ${cmd} ${args.join(' ')}。错误信息: ${stderr || (error instanceof Error ? error.message : String(error))}`,
    );
  }
}

export function readStdinLine(): Promise<string> {
  return new Promise((resolve) => {
    const { stdin } = process;
    if (!stdin.isTTY) {
      resolve('');
      return;
    }
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.once('data', (data) => {
      stdin.pause();
      resolve(String(data).trim());
    });
    stdin.once('close', () => {
      resolve('');
    });
  });
}

export function basenameForProject(repoPath: string) {
  return repoPath.split(/[\\/]/u).filter(Boolean).at(-1) ?? 'tekon';
}

export function getRepoRoot() {
  return resolve(
    dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
    '..',
    '..',
  );
}

export function getBuiltInRolesDir() {
  return join(getRepoRoot(), 'roles');
}

export function getBuiltInWorkflowsDir() {
  return join(getRepoRoot(), 'workflows');
}

export function listWorkflowNames(workflowsDir: string) {
  if (!existsSync(workflowsDir)) {
    return [];
  }
  return readdirSync(workflowsDir)
    .filter((entry) => entry.endsWith('.yaml'))
    .map((entry) => entry.slice(0, -'.yaml'.length));
}

export function loadWorkflowByName(
  name: string,
  projectWorkflowsDir: string,
) {
  ensureSafeName(name);
  const workflowsDir = existsSync(
    join(projectWorkflowsDir, `${name}.yaml`),
  )
    ? projectWorkflowsDir
    : getBuiltInWorkflowsDir();
  return loadWorkflowTemplate({ name, workflowsDir });
}

export function getWorkflowFilePath(
  name: string,
  projectWorkflowsDir: string,
) {
  ensureSafeName(name);
  const projectPath = join(projectWorkflowsDir, `${name}.yaml`);
  if (existsSync(projectPath)) {
    return projectPath;
  }
  return join(getBuiltInWorkflowsDir(), `${name}.yaml`);
}

export function ensureSafeName(name: string) {
  if (!/^[a-zA-Z0-9_-]+$/u.test(name)) {
    throw new Error(
      `名称无效: ${name}。名称只能包含字母、数字、下划线和短横线。`,
    );
  }
}

export function assertCleanBase(
  repoPath: string,
  allowDirtyBase: boolean,
): void {
  const status = execFileSync('git', ['status', '--porcelain'], {
    cwd: repoPath,
    encoding: 'utf8',
  });
  const meaningfulDirtyLines = status
    .split(/\r?\n/u)
    .filter((line) => line.trim().length > 0)
    .filter((line) => !line.startsWith('?? .tekon/'));

  if (meaningfulDirtyLines.length > 0 && !allowDirtyBase) {
    throw new Error(
      '工作树存在未跟踪变更，请使用 --allow-dirty-base 确认后再运行 tekon run',
    );
  }
}

export function readConfigDefaultAgent(
  repoPath: string,
): string | undefined {
  try {
    const configPath = join(repoPath, '.tekon', 'config.yaml');
    if (!existsSync(configPath)) return undefined;
    const raw = readFileSync(configPath, 'utf8');
    const config = parseYaml(raw) as { defaultAgent?: string } | null;
    return config?.defaultAgent ?? undefined;
  } catch {
    return undefined;
  }
}

export function resolveAgentCommand(
  repoPath: string,
): string | undefined {
  const agent = readConfigDefaultAgent(repoPath) ?? 'codex';
  // Currently only claude-code supports interactive AI clarification
  // (codex uses different CLI flags not compatible with draft-agent.ts)
  switch (agent) {
    case 'claude-code':
      return 'claude';
    default:
      return undefined;
  }
}

export function resolveTekonRoot(): string {
  if (process.env.TEKON_HOME) {
    return resolve(process.env.TEKON_HOME);
  }
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '';
  const defaultPath = join(home, '.tekon');
  if (existsSync(defaultPath)) {
    return defaultPath;
  }
  throw new Error(
    '未找到 Tekon 安装目录。请设置 TEKON_HOME 环境变量，或运行安装脚本: curl -fsSL https://raw.githubusercontent.com/zesming/tekon/main/scripts/install.sh | bash',
  );
}
