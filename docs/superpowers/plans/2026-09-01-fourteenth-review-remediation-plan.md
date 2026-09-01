# 第十四轮复审整改执行方案（2026-09-01）

> 依据：第十四轮复审报告（`docs/reviews/2026-09-01-tekon-product-runtime-harness-fourteenth-review.md`）。
> 范围：本 PR（`review/human-first-harness-2026-08-28` → `main`，PR #11）内可安全落地的文档真实性与 `command-gateway` no-progress 边界修复；架构主线继续拆独立 PR。

## 1. 用户本轮已完成且通过复核的调整

| 项 | 落地内容 | 裁决 |
| --- | --- | --- |
| DSH 表述收敛 | CHANGELOG 将“alpha.2→alpha.3 整个合同零差异”改为“Tekon 使用的 Headless 兼容锚点未变” | 通过；与官方 alpha.3 事实一致 |
| CI wiring 文案 | 将过时的 `needs: [typecheck, audit]` 修正为当前 `needs: typecheck` | 通过；audit 仍是独立顶级失败 gate |
| DSH Host Node 断层 | 记录 Tekon Node 合同与 DSH `^22.19.0 || >=24.0.0` 的差异 | 问题成立，运行时直接版本比较仍未实现 |
| 评审资料补充 | 第十三轮报告追加交叉评估、同步 `current.md`、新增本方案 | 内容有价值，但继续向旧报告叠 revision 不符合既定维护规则 |

## 2. 本轮发现的阻断项

### 2.1 P1-RUNTIME-03：no-progress 首次边界采样可能误杀正常任务

用户整改快照 `568e79b5750fc4d1441fc0a4cfe9ef1bef153ad3` 的全栈 CI #275 成功，但 focused Core #366 首次执行失败：

```text
command gateway
→ treats output directory file changes as progress for quiet long-running commands
→ expected timedOut=false
→ received timedOut=true
→ exitCode=0
```

同一 workflow rerun 成功，只能证明问题依赖时序，不能把首次失败归类为无害噪声。`timedOut=true` 与 `exitCode=0` 同时出现，说明 gateway 在文件活动被下一次采样看见前已经触发了 no-progress 终止。

### 2.2 根因

原逻辑在第一次观察到：

```text
Date.now() - lastActivityAt >= noProgressTimeoutMs
```

时立即调用 `triggerTimeout('no-progress')`。文件写入 timer、close timer 和检测 interval 在同一事件循环附近到期时，一次采样可能落在合法文件活动之前，任务失去下一次纠错机会。

## 3. 已实施修复

### 3.1 两阶段 inactivity watermark

`packages/core/src/runtime/command-gateway.ts` 现采用连续确认：

1. 第一次达到 no-progress 阈值时，保存当前 `lastActivityAt` watermark；
2. 下一次检测重新采样 stdout、stderr 和输出目录；
3. watermark 变化则撤销候选超时；
4. watermark 未变化且仍超时，才执行 no-progress 终止。

该实现不改变总超时，真正静默任务最多多等待一个检测间隔；也不通过放大用户配置阈值掩盖问题。

### 3.2 针对性回归测试

新增：

```text
packages/core/__tests__/runtime/command-gateway-no-progress-boundary.test.ts
```

覆盖：第一次 idle 候选之后、第二次确认之前产生 artifact 文件活动；预期正常 `close(0)`，`timedOut=false`，且无 SIGTERM/SIGKILL。

### 3.3 代码快照

- 用户整改快照：`568e79b5750fc4d1441fc0a4cfe9ef1bef153ad3`
- reviewer 代码修复快照：`1e16835e9534b8834a6cc9f9106a0fd50f5deb99`

## 4. 实际验收结果

reviewer 代码快照的首次自动化结果：

| Gate | 结果 |
| --- | --- |
| Core #368 | `completed/success` |
| Core unit | 84 文件；1036 passed；3 skipped；0 failed |
| 新 no-progress 边界测试 | 1 passed |
| 原 command-gateway 单测 | 29 passed |
| Core e2e | 8 文件；26 passed |
| CI #277 | `completed/success` |
| Root build + typecheck | success |
| Production dependency audit | success |
| CLI build/unit/e2e | success |
| Web build/typecheck/unit | success |
| Chromium Playwright | success |

3 个 skipped 仍是未设置 `DSH_CLI_PATH` 时按预期跳过的真实 DSH L2 metadata probe；当前绿色自动化不等于完成了真实 DSH 二进制或带 API key 的 L3 Provider smoke。

## 5. 文档收敛

- 新建第十四轮权威报告，不再向第十三轮追加当前裁决；
- `docs/reviews/current.md` 改为指向第十四轮报告，并绑定用户整改、reviewer 代码修复与自动化快照；
- 第一至第十三轮报告转为只读历史；
- CHANGELOG 继续只记录版本变化，不作为架构验收权威。

## 6. 明确不在本轮关闭的项目

| 项 | 原因 |
| --- | --- |
| repo 级 single-owner Runtime | 破坏性架构重构，需 daemon/lock 与迁移窗口 |
| executor 隔离、真实 kill/join、restart recovery | 需 process/worker ownership、checkpoint 与故障注入 |
| authoritative Session / transactional outbox / durable inbox | 需先决定事实源角色与迁移方案 |
| Collaborate streaming/follow-up/cancel/resume | 应通过 ACP 或等价 persistent Provider vertical slice 验证 |
| RunPlan execute/resume authority | 需完整绑定 Demand、mode、base/workspace、Provider、权限、网络与 Artifacts |
| complete-history export / model compaction / retention | 独立产品与数据链路 |
| DSH Host Node 直接比较 | ~~P1 诊断改进；与真实 L2/L3 smoke 独立推进~~ **勘误（2026-09-01）：经 §14.3 决策移入本轮关闭，见 §8** |
| branch protection / required checks | 需仓库 Owner 配置 ruleset |
| Firefox/WebKit、screen reader、缩放、对比度 | 独立 a11y/兼容性专项 |
| static linter、format debt、SBOM/provenance | 独立工程治理 PR |

## 7. 版本号与合并建议

本轮修复改变了命令无进展判定的边界行为，但仍属于 v0.20.4 未发布快照内的 PATCH 收敛，不单独 bump。

PR 已超过百个提交、约 180 个变更文件，建议最终 squash merge。合并前必须确认最终 PR Head 的 Core 与 CI 都保持 `completed/success`；本方案不执行 merge、release、deploy 或 ruleset 修改。

## 8. 追加整改：DSH Host Node 版本直接 preflight（2026-09-01 主 Agent 决策，reviewer 第三轮后定稿）

第十四轮报告 §14.3 决策将"DSH Host Node 直接比较"从 §6 的"不在本轮关闭"移入本轮。reviewer 三轮共 24 项 must-fix 已全部纳入。核心设计：

### 8.1 设计决策

1. **校验对象是宿主 Node，不是 dsh 运行时 Node**。`dsh` 是全局 npm CLI，其 shebang 解析到的 node 可能与 Tekon 进程不同；探测 dsh 自身 runtime 需额外 spawn，成本与收益不匹配。因此校验 `process.versions.node`（Tekon 宿主），并提供逃生口。宿主与 dsh 运行时 Node 不同的场景无实测证据，逃生口是唯一兜底，手册与错误消息必须说清。
2. **逃生口语义对齐 `TEKON_DSH_ALLOW_VERSION` 先例**：精确值匹配。`TEKON_DSH_ALLOW_HOST_NODE` 必须等于当前 `hostNodeVersion` 才放行（用户写出自己要放行的版本，如 `22.16.0`），不是布尔开关。`'0'`/`'false'`/空串/不匹配值均不放行。逃生口对"不可解析输入"同样放行（逃生口的意义就是"我知道我在做什么"），但生效时必须经 `onWarn` 打印警告。
3. **独立错误类型 `DshHostNodeError`**。携带 `readonly hostNodeVersion: string`。`DshCapabilityError` 的 `actualVersion` 语义是"版本探测已成功"，宿主 Node 不兼容不满足该前提。错误消息含：实际宿主版本、`DSH_NODE_REQUIREMENT`、Node 23 奇数版本线不在支持范围的说明、升级指引、逃生口用法（`TEKON_DSH_ALLOW_HOST_NODE=<实际版本>`）。设 `name = 'DshHostNodeError'` 作为跨包兜底判据。
4. **结构化结果字段与判别字段**。core `DshPreflightResult` 增加 `hostNodeVersion: string`、`hostNodeCompatible: boolean`、`hostNodeBypassed: boolean`（逃生口放行时为 true，与真兼容区分）。CLI 结果对象增加 `failureKind: 'host-node' | 'version' | 'contract' | 'not-installed'`，渲染与 `--json` 共用，不靠字符串匹配。
5. **CLI 类型派生**。CLI 包装层 `DshPreflightResult` 改为从 core 类型派生：`Omit<CoreDshPreflightResult, 'actualVersion'> & { actualVersion: string | null; compatible: boolean; error?: string; failureKind?: ... }`，把漂移交给编译器。
6. **测试注入通道**：
   - core `RunDshPreflightOptions` 增加 `hostNodeVersion?: string`（仅测试注入，生产默认 `process.versions.node`）；
   - `createDshHeadlessAdapter` 内联 options 增加 `hostNodeVersion?: string`，透传给 `runDshPreflight`；
   - CLI 包装层 `runDshPreflight` options 与 `commandProvider` 增加 `hostNodeVersion` 透传，CLI 子命令增加 `--host-node-version` flag（诊断用途，不进 `tekon help provider`，不写入手册主路径）；该 flag 生效且值 ≠ `process.versions.node` 时打印"诊断注入"警告到 stderr，它不是受支持的绕过手段；
   - Web `createWebRunEngineFactory` 增加可选 `preflight?: typeof runDshPreflight` 依赖注入参数（与 root.ts:70 request-scoped 设计一致），生产默认 `runDshPreflight`，测试注入 fake；
   - Web 集成测试中 `dsh-headless` 用例通过注入 fake preflight 或设置 `TEKON_DSH_ALLOW_HOST_NODE=<process.versions.node>` 放行。
7. **warn 通道全链路接通**：
   - CLI 包装层 `runDshPreflight` 调用 core 时传 `onWarn: (m) => io.stderr.write('[dsh bridge] ' + m + '\n')`；
   - Web `root.ts:82` 调用时传 `onWarn: (m) => console.warn('[dsh bridge]', m)`；
   - `session-context.ts:245` 的 CLI 运行路径传 `onWarn` 到 stderr，且 catch 分支识别 `DshHostNodeError` 时直接透传错误消息（不再包成 `DshCapabilityError` 抹掉类型区分）。
8. **fake 路径不进 preflight**：`createDshHeadlessAdapter` 的 `realDsh === false` 分支本就 `return` 跳过 gate，宿主 Node 检查只加在 `runDshPreflight` 入口。
9. **版本 bump**：v0.20.4 未发布（无 git tag），本轮新增用户可见失败行为并入 v0.20.4 发布说明，不单独 bump；CHANGELOG 在 v0.20.4 节追加条目。

### 8.2 实现细节（TDD）

文件：`packages/core/src/runtime/dsh-bridge-probe.ts`

1. 新增导出纯函数 `isHostNodeVersionCompatible(version: string): boolean`：
   - 解析 `major.minor.patch`，容忍预发布后缀（取数字主版本段；预发布只影响后缀解析，不放宽 major/minor 判定）；
   - 规则：`major >= 24` 或 `major === 22 && minor >= 19`（与 `DSH_NODE_REQUIREMENT` 正式版语义等价；`23.x` 两侧均不兼容）；
   - 不可解析输入（`''`、`'abc'`、`'22'`）返回 `false`。
2. 新增 `DshHostNodeError extends Error`（`name = 'DshHostNodeError'`，`readonly hostNodeVersion: string`），消息模板：
   `host Node.js '<v>' does not satisfy DSH requirement '<req>' (odd Node release lines such as 23.x are not supported). Upgrade Node.js or set TEKON_DSH_ALLOW_HOST_NODE='<v>' to bypass this check at your own risk.`
3. `runDshPreflight` 入口（任何 probe spawn 之前）执行判定规则：
   - `const hostNodeVersion = options?.hostNodeVersion ?? process.versions.node;`
   - `const hostNodeCompatible = isHostNodeVersionCompatible(hostNodeVersion);`
   - `const allowHostNode = process.env.TEKON_DSH_ALLOW_HOST_NODE;`
   - 若 `!hostNodeCompatible`：
     - `allowHostNode === hostNodeVersion` → `hostNodeBypassed = true`，`options?.onWarn?.('[dsh bridge] host Node check bypassed via TEKON_DSH_ALLOW_HOST_NODE')`；
     - 否则抛 `DshHostNodeError`。
   - 判定规则一句话：兼容或精确值逃生口放行（放行必 warn），否则 fail-closed。
4. `DshPreflightResult` 增加 `hostNodeVersion: string`、`hostNodeCompatible: boolean`、`hostNodeBypassed: boolean` 必填字段，成功路径返回。

文件：`packages/core/src/runtime/dsh-headless-adapter.ts`

5. `createDshHeadlessAdapter` 内联 options 增加 `hostNodeVersion?: string`，`ensureCapabilityGate` 透传给 `runDshPreflight`。

文件：`packages/cli/src/commands/provider.ts`

6. CLI `DshPreflightResult` 改为从 core 类型派生（见 8.1.5），增加 `failureKind?: 'host-node' | 'version' | 'contract' | 'not-installed'`；
7. `runDshPreflight` options 增加 `hostNodeVersion?: string`，透传给 core；调用 core 时传 `onWarn`；
8. catch 分支：`instanceof DshHostNodeError` 时 `failureKind: 'host-node'`，`hostNodeVersion` 从错误取，`actualVersion: null`；其他错误按现有逻辑（`'actualVersion' in error` 鸭子类型），`failureKind` 根据错误类型推断（`DshVersionGateError` → `'version'`，`DshCapabilityError` → `'contract'`，spawn 失败 → `'not-installed'`）；
9. 成功分支透传 `hostNodeVersion`/`hostNodeCompatible`/`hostNodeBypassed`；CLI 文本加一行 `宿主 Node: <version> (兼容/不兼容/已旁路)`；`--json` 含全部字段；
10. `commandProvider` 的 `parseArgs` 增加 `--host-node-version` flag，透传给 `runDshPreflight`；flag 生效且值 ≠ `process.versions.node` 时 stderr 打印诊断注入警告。

文件：`packages/cli/src/lib/session-context.ts`

11. `preflight` 回调（:245）调用 CLI 包装层 `runDshPreflight` 时传 `onWarn` 到 stderr；catch 分支识别 `DshHostNodeError` 时直接透传错误消息，不再包成 `DshCapabilityError`。

文件：`packages/web/src/server/api/root.ts`

12. `createWebRunEngineFactory` 增加可选 `preflight?: typeof runDshPreflight` 参数，默认 `runDshPreflight`；调用时传 `onWarn: (m) => console.warn('[dsh bridge]', m)`；
13. catch 分支识别 `DshHostNodeError` 时 `ApiError('BAD_REQUEST', ...)` 消息含"宿主 Node 不兼容"语义。

文件：`packages/web/src/server/api/routers/project.ts`

14. `probeProvider()`（:89）的 dsh health 判定增加 `isHostNodeVersionCompatible(process.versions.node)` 纯函数检查（无 spawn 成本），不兼容时 health 不显示可用，避免用户点下去才被拦。

### 8.3 测试

文件：`packages/core/__tests__/runtime/dsh-bridge-probe.test.ts`

- `isHostNodeVersionCompatible` 表驱动：
  - false：`20.19.0`、`22.14.0`、`22.18.0`、`18.20.0`、`23.0.0`、`22.18.0-rc`、`''`、`'abc'`、`'22'`；
  - true：`22.19.0`、`22.20.1`、`24.0.0`、`25.1.0`、`24.0.0-rc.1`、`22.19.0-rc`；
- `runDshPreflight` 注入 `hostNodeVersion: '20.19.0'` 时在任何 probe 调用前抛 `DshHostNodeError`（probe spy 断言零调用）；
- 注入 `hostNodeVersion: '22.19.0'` 时走完全部既有合同检查，结果含 `hostNodeVersion`/`hostNodeCompatible: true`/`hostNodeBypassed: false`；
- 逃生口：注入 `hostNodeVersion: '20.19.0'` + `TEKON_DSH_ALLOW_HOST_NODE='20.19.0'` → 放行、`hostNodeBypassed: true`、`onWarn` 被调用；`TEKON_DSH_ALLOW_HOST_NODE='1'` → 不放行（精确值匹配）；
- 不可解析 + 逃生口：`hostNodeVersion: 'abc'` + `TEKON_DSH_ALLOW_HOST_NODE='abc'` → 放行且 warn；
- 既有 4 个 `runDshPreflight` 用例统一注入 `hostNodeVersion: '22.19.0'`；**`succeeds when version and contracts match` 用例的 `expect(result).toEqual({...})` 全等断言必须同步扩展三个新字段**，不得降级为 `toMatchObject`。

文件：`packages/core/__tests__/runtime/dsh-headless-adapter.test.ts`

- `command: 'dsh'` 的用例（`:424/447/473/564/590/619`）经 adapter options 注入 `hostNodeVersion: '22.19.0'`。

文件：`packages/cli/__tests__/provider-preflight.test.ts` 与 `packages/cli/__tests__/e2e/provider-preflight.e2e.test.ts`

- 既有兼容/不兼容/未安装用例：通过 `--host-node-version 22.19.0` flag 注入兼容值（e2e 跨进程用 flag，不用 env）；
- 新增用例：`--host-node-version 20.19.0` 时 CLI 输出含"宿主 Node 不兼容"（`failureKind: 'host-node'`），exit 1，`--json` 含 `hostNodeCompatible: false`/`failureKind: 'host-node'`；
- 新增用例：`--host-node-version 20.19.0` + `TEKON_DSH_ALLOW_HOST_NODE=20.19.0` → 放行、`hostNodeBypassed: true`、stderr 含逃生口警告。

文件：`packages/web/__tests__/api/project-run-unrestricted-network.test.ts`

- `dsh-headless` 用例（:73）通过 `createWebRunEngineFactory` 的 `preflight` 注入 fake（直接 resolve），或设置 `TEKON_DSH_ALLOW_HOST_NODE=<process.versions.node>`；
- 新增用例：注入一个 reject `DshHostNodeError` 的 fake preflight，断言 `ApiError('BAD_REQUEST', ...)` 消息含"宿主 Node 不兼容"。

文件：`packages/web/__tests__/api/project-health`（如存在）

- `probeProvider` 宿主 Node 不兼容时 health 不显示可用。

### 8.4 文档同步

- `docs/manual/tekon-user-manual.md` §5.7 与 `tekon-user-manual.html`：整段重写 Node 版本边界——旧行为"preflight 只提示差异"→ 新行为"硬拦截 + 精确值逃生口"，含逃生口用法示例；纠正"installHint 含 Node 差异"的旧表述（`installHint` 实际不含 Node）；
- `README.md:144` preflight 命令行说明补充 Node 硬拦截；
- `CHANGELOG.md` v0.20.4 节追加条目；
- 报告 §3 裁决表 DSH Host Node 行、§11 P1 第 4 项、`current.md` "仍不能按已关闭表述"中的 DSH Host Node 行：代码落地后同步改写为已关闭。

### 8.5 验收

- **本机 Node v22.16.0 下**跑 `pnpm test`（全仓）全绿；
- **硬约束**：除 Web 那一处动态 env 外，所有触达 preflight 的测试必须显式注入 `hostNodeVersion` 或 env，禁止依赖真实 `process.versions.node`（本机 22.16 不兼容、CI Node 24 兼容，未注入用例会在一侧过一侧红）；
- `pnpm -r typecheck` 通过；
- CLI e2e、Web Playwright、UI 截图回归；
- reviewer 循环评审至无 must-fix。
