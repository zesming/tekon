import { resolve } from 'node:path';

import { isCwdAllowed } from '../runtime/command-gateway.js';
import type { CommandPolicy } from '../types/config.js';

type NetworkMode = CommandPolicy['network'];

/** 网络权限严格度偏序：disabled 最严、enabled 最宽。 */
const NETWORK_RANK: Record<NetworkMode, number> = {
  disabled: 0,
  restricted: 1,
  enabled: 2,
};

function strictestNetwork(a: NetworkMode, b: NetworkMode): NetworkMode {
  return NETWORK_RANK[a] <= NETWORK_RANK[b] ? a : b;
}

/**
 * 10a-2：cwdScope 的语义 containment 交集。
 *
 * 角色 cwdScope 恒为主仓库、gate cwdScope 恒为执行目录（worktree 或主仓），
 * 朴素字符串数组交集必为空，会让所有 worktree 门禁 fail-closed 宕机。这里在
 * 「能 containment 住执行 cwd 的 scope」中取唯一最窄者（resolve 后路径最长）：
 * 同一 cwd 的祖先目录在 containment 下构成全序链，故最窄者唯一，且必然同时
 * 被角色与 gate 两组覆盖。没有任何 scope 容纳 cwd 时显式抛错（fail-closed），
 * 不回退到更宽 scope。
 */
export function mergeCwdScope(
  roleScopes: string[],
  gateScopes: string[],
  cwd: string,
): string[] {
  const candidates = [...roleScopes, ...gateScopes].map((scope) =>
    resolve(scope),
  );
  const containing = candidates.filter((scope) => isCwdAllowed(cwd, [scope]));
  if (containing.length === 0) {
    throw new Error(
      `cwd ${resolve(cwd)} 在角色与门禁的命令工作目录范围之外，已拒绝执行`,
    );
  }
  const narrowest = containing.reduce((acc, scope) =>
    scope.length > acc.length ? scope : acc,
  );
  return [narrowest];
}

/**
 * 10a-2 候选 A 合并语义（设计评审通过）：deny / requiresHumanApproval /
 * allow 取并集，network 取最严，cwdScope 走语义 containment 交集。
 *
 * - deny 并集使角色拒绝不可被门禁授权覆盖（裁决层固定先查 deny）。
 * - allow 并集保留 PD-04 手写仓库命令授权；角色 allow 在网关通道不是硬白名单，
 *   其硬约束是 deny/审批/network/cwd。
 * - 纯函数、无 IO。不在末尾重过 commandPolicySchema：角色策略在
 *   compileRoleToolPolicy 编译点已过 schema，而 gate 策略的 PD-04 手写命令
 *   天然可能不满足 assertSafeCommand（如 rm -rf），其安全由 Gateway 裁决层
 *   固定规则（危险删除/force push/shell 元字符，最先生效）兜底；merge 只做
 *   数组合并不引入新构造，重过 schema 会误杀 PD-04 授权。
 */
export function mergeRoleAndGatePolicy(
  role: CommandPolicy,
  gate: CommandPolicy,
  cwd: string,
): CommandPolicy {
  return {
    allow: [...role.allow, ...gate.allow],
    deny: [...role.deny, ...gate.deny],
    requiresHumanApproval: [
      ...role.requiresHumanApproval,
      ...gate.requiresHumanApproval,
    ],
    cwdScope: mergeCwdScope(role.cwdScope, gate.cwdScope, cwd),
    network: strictestNetwork(role.network, gate.network),
  };
}
