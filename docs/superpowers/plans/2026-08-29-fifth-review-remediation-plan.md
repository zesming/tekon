# 第五轮复审整改执行方案

- **日期**：2026-08-29
- **对应报告**：`docs/reviews/2026-08-29-tekon-human-first-harness-fifth-review.md`（含附录 A 审阅代理批注）
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **基线提交**：`3dd4330`
- **原则**：本轮不承担架构重构与破坏性数据迁移；闭环产品透明度、列表处理语义、连接与术语、列表实时性、长会话 DOM 边界、主路径可访问性、安全停机序列；递延项以 ADR/文档诚实定性。
- **版本**：本轮含多个新功能（run plan 预览、acknowledge、preflight 递延但有 provider 文档、shutdown 行为变化），按 SemVer MINOR bump `0.16.0 → 0.17.0`。

## 一、本轮纳入项与验收标准

### T1. P0-ARCH-02 安全停机序列（core）

**改动**：`packages/core/src/session/job-runner.ts` 的 `stop()`（现状 line 513-543）。

事实前提（经复审核对）：`TekonDatabase` 是 better-sqlite3，**所有写入同步**，不存在异步 write-queue / flush / idle 接口。因此 late-write 撞已关闭句柄的充要条件是：`db.close()` 之前，所有在途异步任务已终止或已 abort 到不再触发同步写。屏障必须是「确定性终止」，不能是「有界/概率等待」（后者正是报告 P0-ARCH-02 反对的手段）。

1. 新增 draining 语义：stop 开始即 `stopped = true`，阻止 claim 新 job。
2. 保留现有一次有界等待（`Promise.race([allSettled(pending), timeout(5s)])`），让能在 5s 内正常完成的 job 走原路径（完成时在 line 222 `controllers.delete`，行为不变）。
3. 超时后，对**仍在 `controllers` 中**的在途 controller 显式 `abort()`，并对其 runId `registry.killAll(runId, 'SIGKILL')`。判定「在途 vs 已完成」以 `controllers` 成员关系为权威标记（已正常完成的 job 已从 `controllers` 删除，因此不会被误 abort/kill；不误杀的依据是成员关系而非时间）。
4. **确定性 drain 屏障**：abort/kill 之后，`stop()` 再次 `await Promise.allSettled([...pending])`（无超时，或仅极短兜底防御真正挂死的子进程），确保被 abort 的 executor 把 catch/finally 的最后一次同步写走完并从 `pending` 出列，`stop()` 才返回。返回后调用方才 `db.close()`，此时不存在在途同步写。
5. 不改变正常路径（5s 内完成的 job 行为完全不变）。

**验收**（对齐 M1/M2/S3）：
- 新增 core 单测/e2e：注入一个「超时不结算」的 in-flight job（executor 挂在可控 barrier 上），断言 `stop()` resolve 后 `pending.size === 0` 且 `controllers` 为空、该 job 的 controller `signal.aborted === true`。
- kill 效果断言：用真实/伪子进程句柄断言收到信号，或断言 `registry.killAll` 返回 kill 计数 > 0（不只 spy 调用次数）。
- 不误杀断言：一个在 5s 边界附近刚好完成（已 `controllers.delete`、`pending` 尚未出列）的 job，`stop()` 不对其 abort/killAll。
- 现有 `close-teardown`、`subprocess-registry`、`engine-recovery` 测试不回归。

### T2. P1-PRODUCT-02 + P1-SEC-01 Run Plan 预览与网络确认（core + web）

**改动**：
1. `packages/web/src/server/api/routers/workflow.ts`：`list`/新增 `plan` 复用 core `loadWorkflowTemplate`/`parseWorkflowTemplate`，返回阶段、节点、角色链路、Gate（类型/是否需人工审批）、产物、gate 级 `timeoutMs`。**弃用正则 `extractYamlScalar` 作为唯一元数据来源**。
   - 字段来源区分（S1 校正）：角色链路/Gate/产物/超时来自 `parseWorkflowTemplate`（模板静态字段）；**网络不受限/沙箱状态不是模板字段**，来自 run 启动参数与 provider snapshot 的 `acknowledgeUnrestrictedNetwork`（运行时命令策略 `commandPolicy`，见 workflow-runtime.ts / dynamic.ts）。预览时把「模板结构」与「本 run 网络策略」合并展示，不得假装网络状态可从模板静态读出。
2. `packages/web/src/client/components/runs/StartRunForm.tsx`：新增「执行计划预览」区块（角色链路、Gate 审批点、网络状态告警、超时人类可读化、预期产物）；底层毫秒/profile 收进高级折叠。
3. 网络不受限时，预览显式告警 + 知情确认；确认写入 run provider snapshot/audit（core 侧 `acknowledgeUnrestrictedNetwork` 由「隐藏布尔」变为「预览确认事实」）。

**验收**：
- core：模板 → run plan 投影纯函数单测（阶段/角色/Gate/网络/超时正确映射）。
- web api：`workflow.plan`（或扩展 `list`）契约单测。
- web e2e：Playwright 断言预览渲染角色链路、Gate、网络告警；**网络不受限且未知情确认时，提交被禁用/拒绝**（去掉「若适用」逃生舱，硬断言），确认后方可提交，确认事实写入 provider snapshot/audit。

### T3. P1-UX-02 历史失败处理语义（core + web）

**改动**：
1. `packages/core/src/db/migrations.ts`：`addColumnIfMissing(db, 'sessions', 'acknowledged_at', 'text')`（幂等、无整表重建）。
2. session-store 读写 `acknowledgedAt`；`session.list` 投影带该字段。
3. `packages/web/src/server/api/routers/session.ts`：`deriveSessionAction`/`attentionRank` 对已确认的 `failed` 不再派生 `needsAction`、不再置顶；新增 `session.acknowledge` mutation。
4. UI：失败会话行提供「已确认/归档」动作，确认后下沉到历史区。

**验收**：
- core：migration 单测（新库 + 老库 addColumn 幂等）；**老库既有 `failed` 行加列后 `acknowledgedAt` 读出为 `null` 且被当作「未确认」仍置顶，确认后才下沉**（防止 NULL 在派生逻辑处被误判）。
- web api：acknowledge 前后排序与 needsAction 变化单测。
- web e2e：点击确认后失败会话下沉断言。

### T4. P1-UX-03 / P1-UX-04 连接状态与术语（web）

**改动**：
1. `packages/web/src/client/layouts/TopBar.tsx`：Token 密码框改为「已连接/未连接」状态徽标 + 连接管理面板（查看/重填 Token/重连）。
2. 主路径术语统一产品化中文词汇（任务/执行计划/阶段审批/交付产物/运行结果）；工程术语保留在高级模式。
3. 同步更新 `shared-fixture.ts` 与依赖 `getByLabel('Session token')` 的 e2e 定位器。

**验收**：
- web client：连接状态组件单测。
- web e2e：bootstrap token 注入后显示「已连接」，面板可重连；术语文案断言。
- 同步：manual 若有 Token 输入框旧描述/截图，改为「连接状态徽标」，避免手册漂移（S5）。

### T5. P1-UX-01（部分）workspace 级实时刷新（web）

**改动**：
1. server 新增 workspace 级 summary SSE（或复用现有 SSE 基建做轻量广播）。
2. `SessionsPage` 订阅并在状态翻转时 invalidate `session.list`；保留短轮询兜底。

**验收**：web api SSE 单测；e2e 断言跨会话状态变化能自动上屏（在 fixture 可控范围内）。

### T6. P1-UX-05（部分）长会话 DOM 边界（web）

**改动**：EventFeed 初始渲染窗口（默认最近 N 条）+「展开更早」；超长 payload 限高按需展开。后端 cursor 分页与虚拟化递延。

**验收**：web client 单测断言窗口化与展开；e2e 不回归现有 feed 断言。

### T7. P2-A11Y-02（部分）主路径可访问性（web）

**改动**：闭环 run plan 预览、连接面板、审批表单的键盘/ARIA/label/焦点。

**验收**：e2e 用 `getByRole`/`getByLabel` 覆盖上述交互键盘可达。

### T8. P2-PROCESS-01 流程降噪（docs）

**改动**：停止向 CHANGELOG 追加评审过程；本轮只写用户可见行为；评审结论留在报告 + `current.md`。历史噪声按需归档（保守：不删历史，仅停止追加过程，必要时归档到 `docs/history/`）。

## 二、本轮递延项（附诚实记录）

- **P0-ARCH-01 / P0-ARCH-03 / P0-PRODUCT-01 / P1-ARCH-04**：合并到一份 ADR `docs/technical/adr-0001-runtime-authority-and-collaborate.md`，记录 multi-owner 边界、投影非权威定性、Collaborate 缺口与 DSH SDK/ACP 选型方向。
- **P1-DATA-01**：外键整表重建为独立数据迁移专项 PR；本轮 ADR/报告记录跟踪。
- **P1-DSH-01**：`tekon provider preflight` 独立小 PR。
- **P2-TEST-02**：完整故障注入矩阵递延；本轮仅落 T1 的 late-write/quiescent 起点用例。

## 三、执行顺序与依赖

1. 先 core（T1 + T3 migration/store + T2 core 投影）→ 保证 core 测试绿。
2. 再 web api（T2 plan、T3 acknowledge、T5 SSE）。
3. 再 web client（T2/T4/T6/T7 UI + T3/T5 联动）。
4. ADR + docs（递延项 + T8）。
5. 每个包改动后跑对应 unit + e2e；全部完成跑全量 `pnpm test` + web e2e + UI 目视。

## 四、文档同步清单

- `package.json` version bump `0.17.0`。
- `CHANGELOG.md`：仅追加用户可见行为（run plan 预览、失败确认、连接状态、术语、安全停机）。
- `docs/manual/tekon-user-manual.md` + `.html`：run plan 预览、失败确认、连接状态使用说明。
- `README.md`：如入口/版本相关有变化则同步。
- 第五轮报告：回填「本轮整改」小节。
- ADR 新增。

## 五、方案评审修订记录

- **R1（2026-08-29，reviewer 第一轮）**：
  - M1 已修复：T1 屏障重定义为「abort/kill 后再次 `await Promise.allSettled(pending)` 的确定性终止」，移除不存在的 flush/idle 接口与概率等待；验收改为 stop 后 `pending.size===0` 且 controllers 清空。
  - M2 已修复：不误杀依据从「5s 内完成」改为「`controllers` 成员关系是完成/在途权威标记」，补边界完成不被 abort 的验收断言。
  - S1 已吸收：网络/沙箱状态非模板字段，来自 run 参数与 provider snapshot，与模板结构合并展示。
  - S2 已吸收：去掉网络确认「若适用」逃生舱，未确认不受限网络时提交被拒 + 硬断言。
  - S3 已吸收：kill 断言验证效果（计数>0/信号）而非仅 spy 调用。
  - S4 已吸收：补老库 NULL `acknowledgedAt` 语义验收。
  - S5 已吸收：manual Token 描述漂移同步。
