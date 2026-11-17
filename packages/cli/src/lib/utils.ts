import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';


import {
  compileRoleCommandPolicy,
  inspectTemplateSymlink,
  listWorkflowCatalog,
  loadRole,
  loadWorkflowTemplateFile,
  readableWorkflowTemplateError,
  readTekonConfig,
  resolveDefaultAgent,
  type CommandPolicy,
} from '@tekon/core';

export function getVersion(): string {
  try {
    const pkgPath = join(getRepoRoot(), 'package.json');
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

/**
 * 10a-2：编译节点角色的命令策略（preflight/doctor 与运行期共用同一
 * loadRole 层级解析，保证项目/用户层角色覆盖在预检与运行期裁决到同一份）。
 * repoPath 取主仓；角色文件加载失败时抛错，由调用方 fail-closed。
 */
export function nodeRoleCommandPolicy(
  repoPath: string,
  role: string,
): CommandPolicy {
  const loadedRole = loadRole({
    role,
    repoPath,
    builtInRolesDir: getBuiltInRolesDir(),
  });
  return compileRoleCommandPolicy({
    repoPath,
    role,
    tools: loadedRole.tools,
  });
}

export function getBuiltInWorkflowsDir() {
  const catalog = listWorkflowCatalog();
  const firstBuiltin = catalog.find((entry) => entry.builtin && entry.path);
  if (firstBuiltin?.path) {
    return dirname(firstBuiltin.path);
  }
  return join(getRepoRoot(), 'workflows');
}

export function listWorkflowNames(workflowsDir?: string) {
  return listWorkflowCatalog(
    workflowsDir ? { projectWorkflowsDir: workflowsDir } : undefined,
  ).map((entry) => entry.id);
}

export function loadWorkflowByName(
  name: string,
  projectWorkflowsDir: string,
) {
  ensureSafeName(name);
  const catalog = listWorkflowCatalog({ projectWorkflowsDir });
  const entry = catalog.find((item) => item.id === name);
  // catalog 与旧 fallback 扫描同样的内置/项目目录与 .yaml/.yml 后缀，
  // 未命中即模板不存在：直接给中文指路，不再让 ENOENT 暴露 CLI 安装目录。
  if (!entry?.path) {
    throw new Error(
      `模板 ${name} 不存在。用 tekon workflow list 查看可用模板名称。`,
    );
  }
  // 统一软链信任边界：catalog 条目位于其来源根目录的第一层，dirname 即
  // 该内置/项目根；越界/断链软链在读取前拒绝（与 list 探针、core 按名加载同规则）。
  const linkCheck = inspectTemplateSymlink(entry.path, dirname(entry.path));
  if (!linkCheck.ok) {
    throw new Error(`模板 ${name} 无法解析：${linkCheck.reason}`);
  }
  try {
    // CD-20：show/preflight/run/doctor 共用此入口，统一把校验器/语法
    // 异常翻译为可读中文，裸 ZodError 不再能到达顶层错误打印。
    return loadWorkflowTemplateFile(entry.path);
  } catch (error) {
    throw new Error(
      `模板 ${name} 无法解析：${readableWorkflowTemplateError(error)}`,
    );
  }
}

export function getWorkflowFilePath(
  name: string,
  projectWorkflowsDir: string,
) {
  ensureSafeName(name);
  const catalog = listWorkflowCatalog({ projectWorkflowsDir });
  const entry = catalog.find((item) => item.id === name);
  if (entry?.path) {
    return entry.path;
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

export function resolveAgentCommand(
  repoPath: string,
): string | undefined {
  const agent = resolveDefaultAgent(readTekonConfig(repoPath));
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
