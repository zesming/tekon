import {
  accessSync,
  constants,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { join, resolve, sep } from 'node:path';

import { roleSchema, type Role } from '../types/domain.js';
import { listRoleIds, loadRole, type RoleSource } from './loader.js';

/**
 * PD-11：项目级角色覆盖的读写原语，CLI `role create` 与 Web 角色编辑共用。
 *
 * 角色加载合同（loader.ts）是 built-in → user → project 三级候选取最后一个
 * 存在的整目录，且选中目录必须含 agent.yaml。因此编辑内置角色 prompt 不能
 * 只写一个 system.md，必须先把内置角色整目录物化到 .tekon/roles/<id>/，
 * 否则 loadRole 会因缺 agent.yaml 失败。
 *
 * 安全：所有写路径经 realpath 锚定 + lstat 拒软链，fail-closed。
 */

const MAX_PROMPT_BYTES = 64 * 1024;

let tempCounter = 0;

/**
 * prompt 合法性校验（非空、UTF-8 字节上限）。导出供 Web 写 RPC 在物化目录
 * 之前预检——非法请求必须在产生任何文件系统副作用之前被拒绝（S-1）。
 */
export function assertValidRolePrompt(systemPrompt: string): void {
  if (
    typeof systemPrompt !== 'string' ||
    systemPrompt.trim().length === 0 ||
    Buffer.byteLength(systemPrompt, 'utf8') > MAX_PROMPT_BYTES
  ) {
    throw new Error(
      `ROLE_PROMPT_INVALID: 角色 prompt 必须是非空文本且不超过 ${MAX_PROMPT_BYTES} 字节（UTF-8）。`,
    );
  }
}

export interface AvailableRole {
  id: Role;
  source: 'built-in' | 'project';
  hasSystemPrompt: boolean;
}

export interface ReadRolePromptResult {
  source: RoleSource;
  roleDir: string;
  systemPrompt: string;
}

export interface MaterializeRoleResult {
  roleDir: string;
  outcome: 'copied' | 'scaffolded' | 'existed';
}

/**
 * 列出内置与项目角色并集（与 CLI `role list` 同口径，不含 user 级）。
 * 项目目录必须含 agent.yaml 才算有效覆盖，半成品目录不顶替内置来源。
 */
export function listAvailableRoles(options: {
  repoPath: string;
  builtInRolesDir: string;
}): AvailableRole[] {
  const { repoPath, builtInRolesDir } = options;
  const merged = new Map<Role, AvailableRole>();

  for (const id of listRoleIds(builtInRolesDir)) {
    merged.set(id, {
      id,
      source: 'built-in',
      hasSystemPrompt: existsSync(join(builtInRolesDir, id, 'system.md')),
    });
  }

  const projectRolesDir = join(repoPath, '.tekon', 'roles');
  for (const id of listRoleIds(projectRolesDir)) {
    const roleDir = join(projectRolesDir, id);
    if (!existsSync(join(roleDir, 'agent.yaml'))) {
      continue;
    }
    merged.set(id, {
      id,
      source: 'project',
      hasSystemPrompt: existsSync(join(roleDir, 'system.md')),
    });
  }

  return [...merged.values()].sort((left, right) =>
    left.id.localeCompare(right.id),
  );
}

/** 读取当前生效候选（三级解析）的角色 prompt。 */
export function readRolePrompt(options: {
  role: Role;
  repoPath: string;
  builtInRolesDir: string;
  userHome?: string;
}): ReadRolePromptResult {
  const loaded = loadRole(options);
  return {
    source: loaded.source,
    roleDir: loaded.roleDir,
    systemPrompt: loaded.systemPrompt,
  };
}

/**
 * 递归预检源角色树的可读性（含 skills/knowledge 等嵌套子目录）。
 *
 * Node 24 的 fs.cpSync 走 native directory_iterator，遇到无读/执行权限的目录时
 * 底层 C++ filesystem_error 会逃逸 N-API 边界直接 SIGABRT，JS try/catch 无法
 * 捕获（Node 26 已修复为正常 EACCES）。本函数只用 libuv JS 系 API
 * （accessSync/readdirSync），它们在各 Node 版本都只抛可捕获的 JS 错误，
 * 因此能在进入 cpSync 前把坏目录收敛为 ROLE_DIR_INVALID。必须在创建临时目录
 * 之前调用，fail-closed 且不留残留。
 */
function assertSourceTreeReadable(dir: string): void {
  try {
    accessSync(dir, constants.R_OK | constants.X_OK);
  } catch {
    throw new Error(
      `ROLE_DIR_INVALID: 内置角色目录 ${dir} 不可读（权限被撤销），无法物化项目覆盖；请恢复目录读/执行权限后重试。`,
    );
  }
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    throw new Error(
      `ROLE_DIR_INVALID: 内置角色目录 ${dir} 无法遍历（${(error as Error).message}），无法物化项目覆盖；请恢复目录权限后重试。`,
    );
  }
  for (const entry of entries) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) {
      assertSourceTreeReadable(child);
    } else {
      try {
        accessSync(child, constants.R_OK);
      } catch {
        throw new Error(
          `ROLE_DIR_INVALID: 内置角色文件 ${child} 不可读（权限被撤销），无法物化项目覆盖；请恢复文件读权限后重试。`,
        );
      }
    }
  }
}

/**
 * 把角色物化为项目级目录：内置角色整目录复制（保留 agent.yaml/tools.yaml/
 * skills/knowledge），自定义 id 生成最小脚手架。已物化且完整时幂等返回
 * existed。临时目录复制 + 原子 rename，失败不留半成品。
 */
export function materializeProjectRole(options: {
  role: Role;
  repoPath: string;
  builtInRolesDir: string;
}): MaterializeRoleResult {
  const { role, repoPath, builtInRolesDir } = options;
  assertValidRoleId(role);
  const rolesReal = ensureAnchoredRolesDir(repoPath);
  const target = join(rolesReal, role);

  if (pathExists(target)) {
    assertUsableRoleDir(target, rolesReal);
    if (!existsSync(join(target, 'agent.yaml'))) {
      throw new Error(
        `ROLE_DIR_INVALID: 角色目录 ${target} 缺少 agent.yaml，无法作为项目覆盖；请修复或移除该目录后重试。`,
      );
    }
    return { roleDir: target, outcome: 'existed' };
  }

  const source = join(builtInRolesDir, role);
  const copyFromBuiltIn = existsSync(source);
  if (copyFromBuiltIn) {
    assertWithin(realpathSync(source), realpathSync(builtInRolesDir));
    // 整树递归预检（含嵌套 skills/knowledge），在 tempDir 创建之前拦截任何
    // 不可读项，规避 Node 24 cpSync 的 native SIGABRT（见函数注释）。
    assertSourceTreeReadable(source);
  }

  // 临时目录以点号开头：listRoleIds 的 kebab-case 标识符过滤会自动忽略它，
  // 硬崩溃残留也不会污染角色列表；pid+计数器保证同进程唯一，跨进程撞名
  // 概率可忽略。正常路径经 rename 原子转正，异常路径在 catch 中清理。
  const tempDir = join(
    rolesReal,
    `.${role}.tmp-${process.pid}-${tempCounter++}`,
  );
  try {
    if (copyFromBuiltIn) {
      cpSync(source, tempDir, { recursive: true });
    } else {
      mkdirSync(tempDir, { recursive: true });
      writeFileSync(
        join(tempDir, 'agent.yaml'),
        [`role: ${role}`, `name: ${role}`, ''].join('\n'),
        'utf8',
      );
      writeFileSync(
        join(tempDir, 'system.md'),
        `# ${role}\n\n在此编写该角色的职责、边界和输出要求。Tekon 运行节点时会把本文件作为系统提示词。\n`,
        'utf8',
      );
    }
    renameSync(tempDir, target);
  } catch (error) {
    rmSync(tempDir, { force: true, recursive: true });
    throw error;
  }

  return {
    roleDir: target,
    outcome: copyFromBuiltIn ? 'copied' : 'scaffolded',
  };
}

/**
 * 只写项目覆盖目录的 system.md；角色目录必须已物化且完整。
 * 写前对文件本体 lstat，拒绝符号链接逃逸。
 */
export function writeProjectRolePrompt(options: {
  role: Role;
  repoPath: string;
  systemPrompt: string;
}): { roleDir: string } {
  const { role, repoPath, systemPrompt } = options;
  assertValidRoleId(role);
  assertValidRolePrompt(systemPrompt);

  const rolesReal = ensureAnchoredRolesDir(repoPath);
  const target = join(rolesReal, role);
  if (!pathExists(target) || !existsSync(join(target, 'agent.yaml'))) {
    throw new Error(
      `ROLE_NOT_MATERIALIZED: 角色 ${role} 尚未在项目 .tekon/roles/ 物化，无法写入 prompt；请先物化角色目录。`,
    );
  }
  assertUsableRoleDir(target, rolesReal);

  const promptFile = join(target, 'system.md');
  if (pathExists(promptFile) && lstatSync(promptFile).isSymbolicLink()) {
    throw new Error(
      `ROLE_PATH_ESCAPE: system.md 是符号链接，已拒绝写入：${promptFile}`,
    );
  }
  writeFileSync(promptFile, systemPrompt, 'utf8');
  return { roleDir: target };
}

// ── 内部闸门 ───────────────────────────────────────────────────────────────

function assertValidRoleId(role: string): asserts role is Role {
  if (!roleSchema.safeParse(role).success) {
    throw new Error(
      `ROLE_ID_INVALID: 无效的角色 ID: ${role}。角色 ID 必须是 kebab-case 标识符（小写字母开头，仅含小写字母、数字和短横线）。`,
    );
  }
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function assertWithin(realPath: string, realBase: string): void {
  if (realPath !== realBase && !realPath.startsWith(realBase + sep)) {
    throw new Error(
      `ROLE_PATH_ESCAPE: 路径 ${realPath} 解析到允许目录 ${realBase} 之外，已拒绝。`,
    );
  }
}

/**
 * 锚定 .tekon/roles：目录自身与 .tekon 父目录都不得是符号链接，
 * realpath 必须严格等于 <realpath(repoPath)>/.tekon/roles。
 */
function ensureAnchoredRolesDir(repoPath: string): string {
  const realRepo = realpathSync(repoPath);
  const expected = resolve(realRepo, '.tekon', 'roles');
  const tekonDir = join(repoPath, '.tekon');
  const rolesDir = join(tekonDir, 'roles');

  if (pathExists(tekonDir) && lstatSync(tekonDir).isSymbolicLink()) {
    throw new Error(
      `ROLE_PATH_ESCAPE: .tekon 是符号链接，已拒绝写入：${tekonDir}`,
    );
  }

  if (pathExists(rolesDir)) {
    if (lstatSync(rolesDir).isSymbolicLink()) {
      throw new Error(
        `ROLE_PATH_ESCAPE: 角色目录是符号链接，已拒绝写入：${rolesDir}`,
      );
    }
    const realRolesDir = realpathSync(rolesDir);
    if (realRolesDir !== expected) {
      throw new Error(
        `ROLE_PATH_ESCAPE: 角色目录解析到仓库外（${realRolesDir}），期望 ${expected}，已拒绝。`,
      );
    }
    return realRolesDir;
  }

  mkdirSync(rolesDir, { recursive: true });
  const realRolesDir = realpathSync(rolesDir);
  if (realRolesDir !== expected) {
    throw new Error(
      `ROLE_PATH_ESCAPE: 角色目录创建后解析到仓库外（${realRolesDir}），期望 ${expected}，已拒绝。`,
    );
  }
  return realRolesDir;
}

/**
 * 目标角色目录闸门：有效符号链接视为逃逸，断链与非目录视为无效占位；
 * 真实目录必须位于 rolesReal 之内。
 */
function assertUsableRoleDir(target: string, rolesReal: string): void {
  const stat = lstatSync(target);
  if (stat.isSymbolicLink()) {
    if (existsSync(target)) {
      throw new Error(
        `ROLE_PATH_ESCAPE: 角色目录是指向外部的符号链接，已拒绝：${target}`,
      );
    }
    throw new Error(
      `ROLE_DIR_INVALID: 角色路径被断开的符号链接占用：${target}`,
    );
  }
  if (!stat.isDirectory()) {
    throw new Error(`ROLE_DIR_INVALID: 角色路径被非目录文件占用：${target}`);
  }
  assertWithin(realpathSync(target), rolesReal);
}
