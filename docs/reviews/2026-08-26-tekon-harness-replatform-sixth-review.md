# Tekon Harness Replatform 第六轮全面复审

> 复审日期：2026-08-26
> 复审对象：PR #10 `review/deepseek-harness-migration-2026-08-20`
> 第五轮基线：`e6288f2`（v0.14.4，F5-P0-01 并发 resume 原子化）
> 本轮评审修复提交：`3d6836d`「fix: separate run execution from automation control」（经 CI 自动评审工作流应用）
> 复审维度：并发/恢复正确性、Session/Job 身份、run 执行与 automation 控制的边界、UI/UX 可访问性与文案、代码正确性、测试可信度。

> **说明（实施方补记）**：本报告的原始 `.md` 由第六轮 CI 自修改评审工作流（`[apply-sixth-review-fixes]` / `[sixth-review-visual-audit]` 标记）在流水线内生成，但**未随修复提交落库**（与第三轮同型的流程缺口）。修复本身已合入 `3d6836d`（并在同提交内删除了自修改脚手架 `scripts/apply_sixth_review_fixes.py` / `repair_sixth_review_fixes.py` 与 `apply-sixth-review-fixes.yml`）。本文由实施方依据「已应用 diff + 独立核验」重建，以补齐 `docs/reviews/` 序列断档并作为验收留档；批注见文末。

---

## 1. 最终结论

# **不通过（基础设施里程碑持续推进）**

第六轮延续前五轮定位：作为普通用户可用产品仍**不通过**（真流式 / Session follow-up-steer / Collaborate-Deliver 双轨仍未完成，属已披露里程碑）。本轮的实质是一组**并发/身份正确性收敛**，均已在 `3d6836d` 应用：

1. **run 执行与 automation 控制分离**：`findActiveByRunId` / `cancelStaleActiveJobs` / `enqueueIfNoActiveByRunId` 的 active-job 判定收窄到 `RUN_EXECUTION_JOB_KINDS`（`workflow-run` / `workflow-resume` / `goal-run`），使 automation/projection 类 job（`readiness-evaluate` / `delivery-auto-prepare`）不再被误当作 run 的活跃执行 job、不受 pause/cancel/resume-exclusion 控制。
2. **Session / Workspace 身份幂等**：`getOrCreateDefaultWorkspace` 与 `createSession` 改为 `BEGIN IMMEDIATE` 内的幂等 get-or-create，跨独立连接收敛到「一个 root 一 workspace、一个 run 一 canonical session」，补齐第五轮 F5-P0-01 遗留的「无 session 子案例可能建两 session」窗口。
3. **enqueue 绑定校验**：`enqueueIfNoActiveByRunId` 增加 session→run 绑定校验与 run-execution kind 白名单守卫。

## 2. 本轮修复项（均已在 `3d6836d` 应用）

### F6-01 run 执行与 automation 控制混用（Correctness）

**问题**：第五轮引入的 `findActiveByRunId`（及 `cancelStaleActiveJobs` / `enqueueIfNoActiveByRunId`）未按 job kind 过滤。automation job（readiness 只读评估、delivery-auto-prepare 在 run 终态后打包）会被误当作 run 的活跃执行 job：
- `requestPause` / `requestCancel` 的 job relay 可能落到 automation job 上；
- 一个仅有 automation job 在跑的 run，resume 会被 409 误拒；
- stale-reclaim 可能错误取消 automation job。

**修复**：引入 `RUN_EXECUTION_JOB_KINDS`，三处 active-job 查询统一加 `kind in (run-execution kinds)`。pause/cancel 的语义锚点本就在 workflow-instance 层（`requestPause` 先 `running→paused` CAS、`requestCancel` 先 `writeWorkflowTerminal`），job relay 仅为尽力信号——故排除 automation 是正确分离，非回归。automation job 由 `requeueStale`（基于 lease、kind 无关）回收，不泄漏。

### F6-02 Session / Workspace 身份未跨连接收敛（Correctness）

**问题**：`createSession` 无条件 insert；两个独立连接（CLI + Web）并发可为同一 runId 建两条 session 行（第五轮 F5-P0-01 审计已披露的「无 session 子案例」残留）。`getOrCreateDefaultWorkspace` 同理无跨连接收敛。

**修复**：两者改为 `BEGIN IMMEDIATE` 内 lookup+insert 的幂等 get-or-create（与 `appendEvent` 的 seq 分配同款跨进程临界区范式）。`createSession` 在 `input.runId` 非空且已存在时返回既存、不 insert；`runId=null` 时仍每次新建（语义不变）。

### F6-03 UI 文案 / 可访问性收敛（UX）

- Sidebar 主导航项 `会话 Sessions` → `受控交付`（与第五轮 CTA 改名一致，消除「轻量聊天」误导）；
- SessionsPage / TopBar「受控交付」heading、workspace「当前项目」展示；
- Event Feed 把 job/automation lifecycle 事件渲染为人类可读的 governance 行（`执行任务` / `准备度检查` / `交付材料准备`），不再暴露 `job/status` 等内部类型；
- README 表格 Prettier 规整 + 「开始会话」→「启动受控交付」文案同步。

## 3. 持续递延（已披露里程碑 / 架构决策）

- **PRODUCT-P0**：真流式 Provider、Session 内 follow-up/steer、Collaborate/Deliver 双轨——前五轮已在 README/manual 诚实披露。
- **单-vs-多 owner 架构决策**（第五轮 F5-P0-02~05 = 第四轮 F4-P0 递延项）：generation/CAS/唯一索引仅在正式支持多 owner 时才是硬需求；推荐单 owner daemon。交用户拍板。
- **PR 规模 / 抽象领先纵向闭环 / Workspace-Project 语义**：过程与架构建议。

## 4. 最终裁决

> **不通过（作为普通用户产品）；本轮并发/身份正确性收敛正确且应保留。**
> run/automation 分离修复了一个真实的控制面混用 bug；session/workspace 幂等补齐了第五轮遗留窗口。产品主闭环与单-vs-多 owner 架构方向仍待完成/决策。

---

## 附：实施方批注（2026-08-26，第六轮收敛）

> 本节由实施方在核验后追加。本轮特殊之处：修复由 **CI 自修改工作流用正则脚本自动应用**（未经人工/最高思考等级审查），且**原始报告 `.md` 从未提交**。为此我委派一个动态 workflow（3 个最高思考等级 subagent 分别核验 run/automation 分离、session 身份幂等、enqueue 绑定校验 + 1 个核验 web/README/e2e + 1 个首席综合），对这批机器生成改动补做审查，并以 mutation 反证测试真锁性。

### 核验结论：自动应用的核心改动正确、可保留（本轮补修 2 处）

- **run/automation 分离（F6-01）= 真实改进，非回归**（事实，已回代码 + 实跑确认）：`requestPause` 先对 workflow instance 做 `running→paused` CAS、`requestCancel` 先 `writeWorkflowTerminal` 落终态，**都在 job relay 之前**——run 状态无论是否找到 run-execution job 都会改变，不存在「pause/cancel 静默失效」。分离前未过滤的 `findActiveByRunId` 反而可能对 automation job 施加 workflow 控制、或 409 误拒 resume，那才是被修掉的真 bug。automation job 由 `requeueStale`（基于 lease、kind 无关）回收，不泄漏。
- **session/workspace 幂等（F6-02）正确**：三个 `createSession` 调用方均安全（startRun 用全新 runId 必 insert；resumeRun / gate.approve 均有 `if(!session)` 守卫，幂等分支不改变其行为）；`BEGIN IMMEDIATE` 与 `appendEvent` 同款。**session 收敛测试**（独立连接 + 独立 write queue + Promise.all，断言 `id` 相等且 `count==1`）对 pre-fix 无条件 insert 会失败——真锁；**workspace 收敛测试**因 pre-fix `getOrCreateDefaultWorkspace` 本已是 lookup-then-insert、better-sqlite3 同步 + WriteQueue FIFO 使先手 insert autocommit 早于后手 lookup，故在单进程 vitest 内对 pre-fix 亦通过，属**回归护栏而非 mutation-killer**（真正的跨进程竞态单进程无法复现，与 F5-P0-01 同款限制）。修复本身（BEGIN IMMEDIATE 收窄竞态窗口）仍正确。
- **enqueue 绑定 + kind 守卫（F6-03 内层）正确**：防御性，无合法调用点触发；mutation 中和守卫 → 精确 2 处失败（真锁）。

### 本轮补修（CI 自修改工作流遗漏，实施方本轮修复）

1. **e2e 断言漂移（必修）**：`packages/web/__tests__/e2e/session-routing.test.ts:33` 仍断言 `getByRole('link',{name:'会话 Sessions'})`，但 Sidebar 该导航项已改名 `受控交付`（`Sidebar.tsx:27`）——真实浏览器里必然超时失败。**已改为** `受控交付`（已核实该 accessible-name 唯一命中 nav link，与 SessionsPage 的 `受控交付` heading / `启动受控交付` button 不冲突）。已用 `git stash` 对比证明：committed 状态该 e2e **确实失败**，修复后通过。根因：`pnpm test`（vitest）`exclude: __tests__/e2e/**`，Playwright 漂移逃过 CI 自修改工作流的 `pnpm test` gate。
2. **测试覆盖缺口（本轮顺带补齐）**：`event-feed.test.ts` 只断言 `job/status` 的默认分支 `执行任务`，未覆盖两条 automation 子分支。**已补** `readiness-evaluate→准备度检查`、`delivery-auto-prepare→交付材料准备` 两条断言（mutation 反证为真锁）。
3. **手册文案漂移（顺带修）**：`docs/manual/tekon-user-manual.md` 与其 `.html` 的「当前边界」提示仍写「从会话输入框『开始会话』发起」，但该 Composer CTA 第五轮已改名 `启动受控交付`（`SessionComposer.tsx:83`，README 已同步）。已把手册 md + html 两份同步为「启动受控交付」，避免文档漂移。

### 流程建议（记录交用户决策）

- CI 自修改评审工作流反复引入同型脚手架（第三轮我曾删除、本轮又被引入后在 `3d6836d` 删除），且评审报告未随修复落库、e2e 未纳入 CI 必过 gate——这三点共同导致本轮 e2e 漂移逃过绿灯。建议：把「评审报告落 `docs/reviews/` 并随修复同 PR 提交」与「`test:e2e`（Playwright）纳入 CI 必过 gate」固化为硬约束，或彻底移除自修改工作流改由受控 subagent 驱动。

### 递延边界（勿当缺口）

- `sessions.run_id` / `workspaces.root` 无 DB UNIQUE 约束，「一 run 一 session」幂等靠应用层 writer-lock + `BEGIN IMMEDIATE` 保证（当前所有写入都走此路径，race 已测覆盖）——未言明不变量，非本轮缺口。
- 单-vs-多 owner 架构决策、PRODUCT-P0 产品主闭环、PR 拆分：延续前五轮，交用户。

### 本轮裁决（实施方）

> 自动应用的 run/automation 分离 + session 身份幂等 + enqueue 绑定校验经独立 workflow + mutation 反证确认正确、真锁，予以保留；**补修 1 处 e2e 断言漂移（必修，已证 committed 状态失败）+ 1 处测试覆盖缺口**。全量 `pnpm test` 全绿、Playwright 全绿。版本 bump PATCH。报告对本 PR「不通过（产品）+ 基础设施里程碑推进」的定位与前五轮一致。
