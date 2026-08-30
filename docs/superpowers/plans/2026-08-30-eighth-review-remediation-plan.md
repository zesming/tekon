# 第八轮复审整改执行方案

- **日期**：2026-08-30
- **依据**：[第八轮复审报告](../../reviews/2026-08-30-tekon-human-first-harness-eighth-review.md) 第 13 节问题清单、第 14 节实施顺序、第 18 节维护者复核批注
- **分支**：`review/human-first-harness-2026-08-28`（PR [#11](https://github.com/zesming/tekon/pull/11)）
- **基线快照**：`c732d5d`
- **版本**：`0.18.0` → `0.19.0`（MINOR：新增 preflight 命令、RunPlan snapshot、行为有实际变化）

## 1. 整改范围

### 1.1 本轮闭环（P1）

| 工作流 | 对应问题 | 目标终态 |
| --- | --- | --- |
| A. canonical RunPlan | P1-PLAN-01 | digest 覆盖完整执行参数；workflow 模式强制校验（省略即拒绝）；Goal 模式计算并持久化 digest；Run 持久化 plan snapshot JSON 与 digest |
| B. DSH preflight 前移 | P1-DSH-01 | version/help/config probe 在任何持久副作用（Run/Session/Job/role-run/worktree）之前执行；新增 `tekon provider preflight dsh-headless` CLI 命令输出 tested/actual/contract 与安装指引 |
| C. 长 Session 全链路有界 | P1-SESSION-01 | RPC limit `.max(1000)`；SSE reconnect 总预算（事件数+字节）；`response.write()` drain 背压；服务端分页按"可见事件"口径继续翻页；客户端 `loadEarlier` 后立即裁剪窗口 |
| D. 连接健康产品化 | P1-HEALTH-01 | cache key 用 token SHA-256；TTL 清理 + 容量上限；provider 字段重命名为 `dshHeadless` 并保持探测语义诚实 |
| E. 数据引用完整性 | P1-DATA-01 | `session_events`/`jobs`/`projection_checkpoints` 补外键（SQLite table rebuild 迁移）；孤儿行扫描→quarantine 报告；新库直接带约束 |
| F. dialog 可访问性 | P1-A11Y-01、P2-UX-01 | Role/Workflow 详情：focus 移入、Escape 关闭、Tab focus trap、关闭后焦点恢复、背景 inert、`aria-labelledby` |

### 1.2 本轮增量、不宣称关闭（P0）

| 工作流 | 对应问题 | 本轮动作 | 不宣称的理由 |
| --- | --- | --- | --- |
| G. shutdown 栅栏 | P0-ARCH-02 | `stop()` 超时返回后设置 closed 栅栏，迟到的 repository/文件写入快速失败；故障注入测试证明 deadline 后无成功 late write | 进程内不合作 Promise 无法被真正终止，完整 quiescence 仍需 executor 进程隔离（架构后续） |

### 1.3 本轮不触碰（架构级，按报告第 14 节顺序推进）

- P0-ARCH-01 single-owner daemon + repo lock（需独立 ADR 与进程模型设计）；
- P0-ARCH-03 Session 事实源选型（需 ADR 在"Session log 权威 / 领域表权威 / transactional outbox"间选型）；
- P0-PRODUCT-01 Collaborate 主链路、follow-up/steer/resume、真实 streaming（依赖 ACP/SDK vertical slice）；
- DSH pin 升级到 `0.1.2-alpha.1`（需 contract fixture + 真实 smoke，preflight 命令先把兼容矩阵做透明）。

## 2. 产品细节调整

1. **计划确认成为真实合同**：用户在 Web 看到的执行计划摘要（角色链、Gate、联网确认、超时、Provider）与服务端实际执行的参数由同一 canonical snapshot 绑定；计划被篡改或客户端绕过确认时，Run 不会创建，错误明确为 `PLAN_DIGEST_MISMATCH`。
2. **DSH 环境问题在第一时间暴露**：使用 dsh-headless 的用户在点击"开始执行"后、任何 Run 记录产生前，就得到 tested 版本与实际版本的差异说明；CLI 用户可主动运行 `tekon provider preflight dsh-headless` 自检。
3. **连接状态说真话**：顶栏健康状态区分"凭据有效 / dsh-headless 可执行"，不再把 dsh 探测结果表述成泛化 Provider 状态；缓存不再保存原始 token。
4. **长历史不会骗用户**：当某段历史全是技术事件时，"加载更早"不会错误地告诉用户没有更早内容；超长会话的内存与网络占用有明确上限。
5. **键盘与屏幕阅读器可用**：配置详情弹窗支持 Esc 关闭、Tab 不跑出弹窗、关闭后焦点回到触发按钮。

## 3. 设计细节调整

1. RunPlan digest 的输入域扩展为：`roleChain`、`gates`、`phases`、`requiresUnrestrictedNetwork`、`agent`、`profile`、`allowDirtyBase`、`timeoutMs`、`noProgressTimeoutMs`、`progressHeartbeatMs`、`templateId`、`templateVersion`（若模板提供）。`canonicalJson` 保持现有确定性序列化。**端到端合同同步（评审 A1/A2）**：
   - `workflow.plan` 的输入合同（`workflowPlanInputSchema`、`WorkflowPlanInput`、workflow router、客户端 `StartRunForm` 的 plan 查询、`queryKeys.workflowPlan` 的 key 维度）同步扩展，使客户端展示的 digest 与服务端校验用的 digest 输入域完全一致；
   - agent 在投影前归一化为执行时解析后的值（缺省 `'codex'`），保证 digest 绑定真实执行身份，而不是 `undefined`；
   - 归一化规则放在 `projectRunPlan` 内部（`context.agent ?? 'codex'`），router 与客户端共用同一投影函数，不各自归一。
2. `workflow_instances` 增加 `plan_snapshot`（TEXT，canonical JSON）与 `plan_digest`（TEXT）列；`prepareRun` 在同一事务内写入。注意区分两种 plan（评审 B3）：`plan_snapshot` 是**审计绑定用途**的 canonical RunPlan（人类可读计划 + digest 输入域）；执行用的 node/phase plan 仍走现有 `templateToPlan`/`persistPlan`/`planFromRepository` 路径，`executePreparedRun`/resume 行为不变，不从模板实时投影的现状保持不变。
3. DSH preflight 作为 `SessionService.startRun` 的第一步（在 `createEngine` 之后、`prepareRun` 之前）执行；失败抛 `DshCapabilityError`，由 router 转 400。preflight 结果按 adapter 实例缓存（进程内 TTL 5 分钟），避免每次 run 重复探测。判定机制（评审 B4）：SessionService 是泛型 `TEngineInput`，不嗅探 `input.engine.agent`；改由 composition root（Web `root.ts`、CLI `session-context.ts`）在构造 SessionService 时注入 `preflight?: () => Promise<void>` hook，hook 内部按各自 engine input 的 agent 决定是否执行 DSH 探测。
4. SSE 有界化常量：`MAX_EVENTS_PAGE_LIMIT = 1000`；`RECONNECT_MAX_EVENTS = 2000`；`RECONNECT_MAX_BYTES = 4_000_000`；超过预算时重连降级为尾窗（与 fresh connect 相同）并在流中发送 `event: replay-truncated` 通知。
5. 服务端"加载更早"分页改为循环取 raw page 直到收集到 `limit` 条可见事件或无更多 raw 行（单次请求最多扫描 5 个 raw page，防止内部事件洪泛时无界）。
6. health cache：key = `sessionPath + ':' + sha256(token)`；`Map` 容量上限 128，超出时淘汰最旧条目；每次访问惰性清理过期条目。
7. 外键迁移采用 SQLite table rebuild（新表带 FK → 复制 → 旧表改名 quarantine → 新表改名）。迁移机制（评审 A3）：整个 `migrateDatabase` 跑在 `db.transaction()` 内，而 SQLite 规定 `PRAGMA foreign_keys` 在事务内是 no-op，因此**不使用** `foreign_keys=OFF`，改用事务内有效的 `PRAGMA defer_foreign_keys=ON` 包裹 rebuild；`foreign_keys=ON` 已在连接层（`connection.ts`）设置，不重复设置。迁移前后执行 `PRAGMA integrity_check`；孤儿行在复制时跳过并计数，写入 quarantine 表，迁移后输出 `orphan_rows_quarantined` 计数。迁移模型（评审 B2）：沿用现有幂等块模型（`create table if not exists`/`addColumnIfMissing`），bump `WORK_USABLE_SCHEMA_VERSION` 到 5，不新建版本分步 runner；现有模型本就无 rollback，quarantine 表作为人工恢复路径，方案不承诺自动 rollback。
8. dialog a11y 抽 `useDialogA11y` hook：打开时保存 `document.activeElement`、焦点移入第一个可聚焦元素、keydown 捕获 Tab/Escape、关闭时恢复焦点；背景容器加 `inert` 属性（React 19 原生支持）。
9. shutdown 栅栏（评审 A4）：栅栏下沉到 repositories/db 层，而不是 JobRunner 层——executor 直接持有 `repositories` 并自建 CommandGateway/engine/worktreeManager 写库写文件，JobRunner 层的 closed 检查挡不住。具体：在 `TekonDatabase`/write 路径包一层 closed 标志（`db.prepare().run()` 前检查），`jobRunner.stop()` 超时返回后、`db.close()` 之前关闭栅栏，使迟到的 repository 写入快速失败而非静默 late write。故障注入测试证明 deadline 后 executor 的写库调用被拒绝。

## 4. 实现细节（按工作流）

### A. canonical RunPlan

- `packages/core/src/workflow/run-plan.ts`：`RunPlan` 接口扩展字段；`projectRunPlan` 接收完整执行参数（agent/profile/allowDirtyBase/timeout 系列/templateId）；digest 输入域同步扩展。
- `packages/core/src/db/migrations.ts`：schema v5，`workflow_instances` 加 `plan_snapshot`、`plan_digest` 列（`addColumnIfMissing`，老库可直接补列）。
- `packages/core/src/workflow/engine.ts`：`prepareRun` 接收 canonical plan 与 digest 并持久化；`planFromRepository` 优先从 snapshot 重建。
- `packages/core/src/session/session-service.ts`：`startRun` 在 prepare 前计算 canonical plan（workflow 模式）；Goal 模式用 goal 模板计算并持久化 digest（不校验客户端）。
- `packages/web/src/shared/rpc-contract.ts`：`ProjectRunInput.planDigest` 对 workflow 模式改为 required（zod refine）。**强制边界（评审 B5）**："省略即拒绝"只针对 Web 不可信入口；CLI 是本地可信入口，由 CLI 自己计算 canonical digest 并随 `startRun` 持久化 snapshot，不经过 Web 路由的拒绝逻辑。snapshot/digest 持久化在 engine/session 层，CLI+Web 都覆盖。
- `packages/web/src/server/api/routers/project.ts`：workflow 模式无 digest → 400 `PLAN_DIGEST_REQUIRED`；digest 不匹配 → 400 `PLAN_DIGEST_MISMATCH`；校验用服务端 canonical 计算。
- `packages/web/src/client`：`SessionComposer` 与高级 Run 表单已发送 digest（第八轮已修），确认 digest 输入域与服务端一致；不匹配时展示可读错误。
- CLI run 路径：计算并提交 digest（CLI 是本地可信入口，digest 由 CLI 自己计算）。

### B. DSH preflight 前移

- `packages/core/src/runtime/dsh-bridge-probe.ts`：导出 `runDshPreflight(dshCommand)` 返回 `{ testedVersion, actualVersion, helpContractOk, configContractOk, installHint }`；保留现有 `ensureVersionGate` 等内部函数。
- `packages/core/src/runtime/dsh-headless-adapter.ts`：`ensureCapabilityGate` 复用 `runDshPreflight`，行为不变。
- `packages/core/src/session/session-service.ts`：`startRun` 开头，若 engine adapter 是 dsh-headless（通过 adapter 暴露的 `providerId` 或 engine 输入的 agent 判断），先 `await runDshPreflight()`。
- `packages/cli/src/commands/`：新增 `provider preflight dsh-headless` 子命令，人类可读输出 tested/actual/contract/安装命令；exit 0 兼容、1 不兼容。
- 手册新增"Provider 预检"小节。

### C. 长 Session 有界

- `packages/web/src/shared/rpc-contract.ts`：`sessionEventsInputSchema.limit` 加 `.max(1000)`。
- `packages/core/src/session/session-store.ts`：`listEventsPage` 内部 clamp limit 到 1000。
- `packages/web/src/server/sse.ts`：catch-up 循环累计事件数与字节数，超预算截断并发 `replay-truncated`；`writeFrame` 检查 `response.write()` 返回值，false 时暂停 enqueue 并等 `drain`。
- `packages/web/src/server/api/routers/session.ts`：`session.events` 改为按可见事件分页（循环取 raw page，上限 5 页扫描）。
- `packages/web/src/client/hooks/use-session-stream.ts`：`loadEarlier` 合并后立即按 `maxWindow` 裁剪；`retainFloor` 以 `MAX_EARLIER` 为帽。

### D. 连接健康

- `packages/web/src/server/api/routers/project.ts`：cache key 改 `sha256`；加容量上限与惰性清理；`provider` 字段重命名 `dshHeadless`（值不变）。
- `packages/web/src/client`：TopBar/query-key 消费 `dshHeadless` 字段；文案保持"dsh-headless 不可用"。同步点（评审 B1）：`projectHealthOutputSchema.provider`（rpc-contract）与 `context.ts` health 返回类型一并重命名，否则 typecheck/zod 校验失败。
- 报告 6.2 的"按具体 Provider 返回结构化 probe"本轮有意延后（当前只有 dsh 一个真实探测对象），不是遗漏；preflight CLI 命令（工作流 B）先把 dsh 的兼容矩阵做透明。

### E. 数据引用完整性

- `packages/core/src/db/migrations.ts`：schema v5（同一版本内），table rebuild 三张 Session 子表带 `references sessions(id) on delete cascade`；孤儿行 quarantine 到 `*_orphan_quarantine` 表；迁移计数写入 `schema_migrations` 备注或返回值。
- `packages/core/src/db/connection.ts`：连接建立后 `PRAGMA foreign_keys = ON`。
- 测试：新库约束测试、老库（v4 schema 直插孤儿行）迁移测试、quarantine 计数测试。

### F. dialog a11y

- 新增 `packages/web/src/client/hooks/use-dialog-a11y.ts`。
- `RoleDetailPanel.tsx`、`WorkflowDetailPanel.tsx` 接入；标题加 `id` 并 `aria-labelledby`。
- e2e：扩展或新增配置详情 a11y 测试（参考 `mobile-drawer-accessibility.test.ts` 模式），覆盖 Esc 关闭、Tab 循环、焦点恢复。

### G. shutdown 栅栏（db 层，评审 A4 第二轮修正）

- 栅栏下沉到 repositories/db 层：executor 直接持有 `repositories` 并自建 CommandGateway/engine/worktreeManager 写库，JobRunner 层的 closed 检查挡不住。在 `TekonDatabase` 的写路径（`db.prepare().run()` 及 writeQueue 提交前）包一层 closed 标志检查。
- `packages/core/src/db/connection.ts`（或 repositories 工厂）：新增 `markClosed()` 与写路径检查；`jobRunner.stop()` 超时返回后、`db.close()` 之前（Web `root.ts`、CLI `session-context.ts` 的关停序列）调用 `markClosed()`，使迟到的 repository/db 写入快速失败而非静默 late write。
- 测试：`job-runner-stop-race.test.ts` 新增故障注入用例——不合作 executor 在 deadline 后尝试**直接经 repository 写库**，断言被拒绝且无成功写入（断言目标是 repository 层，不是 JobRunner API）。
- 已知残留（与 §1.2"不宣称关闭"框定一致）：db 层栅栏不覆盖 command-gateway/worktree 的裸文件写，late 文件写仍可能落地；完整 quiescence 仍需 executor 进程隔离。

## 5. 测试与验证计划

1. **测试先行**：每个工作流先写/改测试，再实现。
2. **单元/集成**：core（run-plan、migrations、session-store、job-runner、dsh-bridge）、web api（project.run digest、session.events 分页、health）、web client hooks（use-session-stream、use-dialog-a11y）。
3. **e2e**：
   - 新增 `provider-preflight` CLI e2e（`packages/cli/__tests__/e2e/`）；
   - 新增/扩展 config detail dialog a11y e2e；
   - 扩展 session history e2e：整页技术事件时"加载更早"继续可用；
   - 扩展 start-run e2e：workflow 模式缺 digest 被拒绝、digest 篡改被拒绝。
4. **全量**：`pnpm test`、`pnpm typecheck`、`pnpm build`、`pnpm lint`、Playwright 全绿。
5. **UI 人工核查**：Playwright 截图核查配置详情、顶栏健康、Session 历史、Run 表单无错位/重叠/展示错误。
6. **installer smoketest**：本轮不改 `scripts/install.sh`/`update.sh`，无需 smoketest；版本 bump 后确认 installer 显示新版本。

## 6. 文档与版本同步

- `package.json`：`0.18.0` → `0.19.0`。
- `CHANGELOG.md`：用户可见变更（preflight 命令、计划确认强制化、健康状态语义、历史有界化、弹窗键盘操作）。
- `docs/manual/tekon-user-manual.md` + `.html`：Provider 预检小节、计划确认行为变化、弹窗键盘操作。
- `docs/reviews/current.md`：指向第八轮报告 + 本方案，更新整改快照。
- 第八轮报告第 18 节之后追加"整改结果"小节（完成后）。

## 7. reviewer 循环评审记录

| 轮次 | 评审对象 | 结论 | 必须修复项 | 状态 |
| --- | --- | --- | --- | --- |
| 1 | 本方案 | 4 项 blocker：A1 digest 端到端合同断裂、A2 agent 未归一化、A3 FK 迁移事务内失效、A4 shutdown 栅栏层级错误；5 项建议 | A1/A2/A3/A4 已修入方案，B1-B5 已吸收 | 已闭环 |
| 2 | 修订后方案 | 1 项 blocker：4-G 与 3.9 矛盾（栅栏仍写 JobRunner 层）；1 项应修复：schema v5/v6 冲突 | 4-G 改写为 db 层栅栏；版本统一到 5 | 已闭环 |
| 3 | 二次修订方案 | 未检出必须修复项，复查循环结束 | — | 通过 |
