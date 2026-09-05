# ADR-0001：Runtime 执行权威、事实源角色与 Collaborate 演进方向

- **状态**：Accepted（记录决策与递延，不含本轮代码实现）
- **日期**：2026-08-29
- **对应报告**：`docs/reviews/2026-08-29-tekon-human-first-harness-fifth-review.md`（第 7、8 节）
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **决策者**：Tekon 维护方 + 第五轮复审代理

本 ADR 汇总第五轮复审中判定属实、但本轮不承担实现的架构级问题，给出明确定性、边界与后续独立推进路径。目的：避免这些问题在后续轮次被反复重述为“新发现”，也避免用一次性小改动掩盖真实架构缺口。

## 1. 背景

Tekon 同时提供 CLI 与 Web 两个入口，二者各自创建并启动 `DurableJobRunner`，共享同一 SQLite 库、同一 Git 仓库与交付分支、worktree lease、`.tekon/runs` 文件、Provider 子进程与宿主资源。第五轮复审在此背景下提出四个架构级判断（P0-ARCH-01/02/03、P1-ARCH-04）与两个配套问题（P1-DATA-01、P1-DSH-01、P1-SEC-01）。

## 2. 决策

### 2.1 P0-ARCH-01 单一执行所有者（递延，方向已定）

**事实**：jobs owner/lease/CAS 能降低重复执行，但无法 fence Node 进程、Artifact、Gate、Audit、Delivery、Git 与文件系统的全部副作用。CLI 与 Web 事实上是 multi-owner。

**决策**：长期方向是 repo 级 single-owner daemon + lock，CLI/Web 作为客户端接入；仅在明确需要 active-active 时才为所有副作用设计 generation fencing。本轮不实现，因为它是破坏性架构重构，需独立 PR 与迁移窗口。

**本轮边界**：不新增会加深 multi-owner 假象的能力；`stop()` 的安全停机序列（见 2.2）先行落地，为未来 daemon 化打基础。

### 2.2 P0-ARCH-02 Quiescent Shutdown（本轮部分闭环）

**事实**：`TekonDatabase` 基于 better-sqlite3，所有写入同步，不存在异步 write-queue/flush/idle 接口。late-write 撞已关闭句柄的充要条件是：`db.close()` 之前仍有在途异步任务会触发同步写。原 `stop()` 使用固定上限等待，不是可证明的 quiescence。

**决策（本轮已实现于 `packages/core/src/session/job-runner.ts`）**：`stop()` 改为确定性终止序列——
1. `stopped = true` 进入 draining，阻止 claim 新 job；
2. 一次有界等待（默认 5s，`stopSettleTimeoutMs` 可注入），让能正常完成的 job 走原路径；
3. 超时后对仍在 `controllers` 中（在途权威标记）的 controller `abort()` 并对其 runId `registry.killAll(runId, 'SIGKILL')`，已完成 job 已从 `controllers` 删除故不误杀；
4. 再次 `await Promise.allSettled([...pending])` 作为确定性 drain 屏障，返回后调用方才 `db.close()`。

**递延**：完整的 owner/lock 释放顺序、checkpoint/flush 屏障与 kill/restart 故障注入全矩阵（P2-TEST-02）随 daemon 化一并推进；本轮仅落 late-write/quiescent 起点用例。

### 2.3 P0-ARCH-03 Session Event 事实源角色（递延，需选型拍板）

**事实**：当前先写旧仓储/Audit 成功后再 best-effort 追加 Session Event，找不到 Session 或写失败可跳过。因此 log 不能保证完整重建模型上下文，不适合作为 durable inbox，不能可靠 replay/fork/resume，UI 观察与真实领域状态可能不一致。这与 DeepSeek Harness“模型可见即必须写入 log、模型请求必须可从 log 重建”的不变式不同。

**决策**：Tekon 必须在两种角色中显式二选一——让 Session log 成为权威源，或长期定义为观察投影。本轮不改变事实源角色，保持“观察投影”定性并在文档中诚实声明，不再暗示两种角色并存。真正的权威事实链（先写 durable inbox 再投影）留待独立 PR，与 daemon 化协同设计。

### 2.4 P1-ARCH-04 Harness 集成边界重估（递延到独立 ADR/vertical slice）

**事实**：阶段 5b 选择 headless CLI 是在 dsh `0.1.1-rc.2` 上做出的合理判断；官方现已公开 SDK stdio JSON-RPC application profile、TS/Python SDK client、ACP stdio profile（含标准 Session 控制与恢复）、持久 Session log 与投影 flush 屏障。“headless 是唯一机器边界”的判断已过时。

**决策**：
- 保留 `dsh-headless` 作为 Goal one-shot provider（官方 headless 文档明确：一个 task、最终 answer、随后退出，不适合多轮 Session，故不得扩展回 Deliver/Collaborate）；
- 不把 SDK/ACP 硬塞进现有 `AgentAdapter`；
- 为 Collaborate 单独建 ADR，对比 SDK 与 ACP 在控制面、事件语义、恢复、取消、权限与生命周期上的差异；
- 先做一个真实 provider vertical slice，再决定长期接口。

### 2.5 P0-PRODUCT-01 Collaborate 轨道（递延，保持诚实禁用）

**事实**：对外承诺的“受控交付（standard-delivery）”合同完整成立并有测试真锁；缺失的是尚未宣称的轻量持续协作（Collaborate）能力，界面（`SessionComposer.tsx`）已诚实披露。

**决策**：本轮不实现 Collaborate；保持 UI 诚实禁用与文案披露，能力建设随 2.4 的 vertical slice 推进。不做“看起来支持”的假实现。

## 3. 配套递延项

- **P1-DATA-01（子表外键完整性）**：`session_events.session_id` / `jobs.session_id` / `projection_checkpoints.session_id` 无统一外键，`appendEvent` 不校验 Session 存在。合理修复需盘点孤儿行、定义策略、SQLite 整表重建 migration、新老库升级回滚测试、修正直接插孤儿的 fixture、决定 cascade/restrict 语义。只对新库加外键会造成新旧行为分裂，不接受。**作为独立数据迁移专项 PR**。
- **P1-DSH-01（provider preflight）**：硬编码 `TESTED_DSH_VERSION`（`0.1.1-rc.2`）与官方 `0.1.2-alpha.1` 存在断层。独立小 PR 增加 `tekon provider preflight dsh-headless`、Web 连接/版本状态、精确兼容安装命令、在产生持久副作用前 probe，并对 `0.1.2-alpha.1` 重跑 contract fixture 后再决定是否更新 pin。
- **P1-SEC-01（网络风险确认）**：本轮已在 run plan 预览侧闭环（预览展示网络状态 + 未知情确认硬拒绝 + 确认事实写入 provider snapshot/audit）。CLI 侧显式确认与 resume 不丢失该事实随后续统一。
- **P2-TEST-02（故障注入全矩阵）**：完整 kill/restart/late-write 矩阵递延；本轮仅落 T1 起点用例。

## 4. 影响与后续

本 ADR 不改变除 2.2 之外的运行时行为，是决策与边界记录。后续每个递延项落地时，应引用本 ADR 对应小节并更新其状态。若任一决策方向发生变化（例如决定采用 active-active 而非 single-owner daemon），需新建 ADR 或在此追加修订记录，不得静默改变。

## 5. 参考资料

- [DeepSeek Harness README](https://github.com/deepseek-ai/deepseek-harness)
- [Safety](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)
- [dsh-headless README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md)
- [SDK app](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/sdk-app/README.md)
- [SDK client](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md)
- [ACP app](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/acp-app/README.md)
- [Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
