# Tekon Replatform 当前范围与验收基线

> 日期：2026-08-28  
> 适用对象：PR #10 `review/deepseek-harness-migration-2026-08-20`  
> 状态：**当前实现事实基线；覆盖旧计划文档中的完成状态标签，但不改变长期产品目标**

## 1. 为什么需要这份基线

原始总体执行方案把阶段 0–5 作为同一条完整迁移计划，并把以下能力纳入阶段 2/3 的验收：

- Provider 执行期增量输出；
- `followUp` / `steer` / `resume`；
- durable inbox；
- 同一 Session 的多 Turn 持续协作；
- Diff、结构化 Final Result 与人类可读叙事；
- 浏览器端运行中纠偏 journey。

后续阶段 2、阶段 3 详细设计把其中一部分能力递延到了 2b 或后续阶段，但文件头仍使用“已实施”“全部实现完成”。这会把“一个兼容切片完成”误读为“原始阶段验收已经完成”。

本文件只修正当前事实和验收口径：长期目标不变，当前 PR 不再被描述为完整迁移完成。

## 2. 当前实际完成范围

### 已完成或基本完成

- 阶段 0：契约、CI、若干旧 UI/状态问题和测试基线；
- 阶段 1：Session/Event 数据骨架、后台 Job、SSE、取消传播、恢复与基础治理投影；
- 阶段 2a：Provider registry、Provider snapshot contract、一次 legacy `runAgent()` 对应一个 Step 的兼容投影；
- 阶段 3 观察/控制切片：Session list/detail、SSE replay、运行控制、inline approval、移动端布局和基础可访问性；
- 部分后续实验：Profile、Automation、Goal、DSH headless bridge、Delivery/Readiness 事件。

### 尚未完成

- 真正的 Provider execution-time streaming；
- 真实 Tool lifecycle，而不是 Node 完成后的合成 Tool 事件；
- `followUp` / `steer` / `resume` 的生产实现；
- durable inbox、唯一 claim、幂等 processed、失败重试与 daemon 重启恢复；
- Collaborate / Deliver 后端双轨；
- Narrative Feed、Current-state Inspector、结构化 Final Result；
- 长 Session 的分页、有界 replay、虚拟化和性能预算；
- 默认 Runtime 的所有权与完整 shutdown 正确性。

因此，当前最准确的阶段描述是：

```text
Phase 0 + Phase 1
+ Phase 2a compatibility projection
+ partial Phase 3 observer/control UI
+ selected experimental Phase 4/5 pieces
```

而不是“阶段 0–5 全部完成”。

## 3. Session Event 在当前 PR 中的角色

当前实现明确采用：

```text
Workflow / Job / Gate / Audit / Delivery 等旧领域表 = 事实源
session_events = best-effort UI / observability projection
```

`session_events` 写入失败不能拖垮治理主路径，这对迁移期投影是合理的。但它意味着当前 Event Log **不能同时被当作**以下能力的权威事实源：

- 模型历史；
- durable inbox；
- follow-up / steer 的唯一消费记录；
- crash/restart resume；
- 完整可重放交互历史。

未来若选择 Harness 式 authoritative Session Log，需要单独 ADR 和迁移：模型可见事实不得 best-effort 丢失，并通过事务、outbox 或 commit barrier 建立可靠提交语义。

在该 ADR 完成前，文档与 UI 必须把 Session Event 描述为投影，而不是完整交互真相。

## 4. Runtime ownership 的当前事实

Web 与 CLI 均可创建和启动自己的 JobRunner，并访问同一个项目的 SQLite、Git 工作区和进程世界。因此当前部署形态事实上允许 multi-owner。

已有 owner/status 条件写和 Git expected-old OID CAS 是有效改善，但尚未形成贯穿以下副作用的持久 execution authority：

- Job heartbeat / checkpoint / settle；
- Node transition；
- Artifact / Audit / Gate / Delivery；
- Git commit / promotion；
- subprocess 生命周期；
- shutdown quiescence。

当前推荐的目标架构仍是 **single-owner daemon**：一个 Runtime 独占 JobRunner、Agent、Worktree 和 Subprocess，Web/CLI/IDE 作为客户端。但在代码级 Runtime lock、daemon/client 协议和关闭链落地前，当前 PR 不能按默认并发 Runtime 验收通过。

若项目选择完整 multi-owner，则必须增加 persistent per-claim authority、Node CAS、全副作用 fencing 和两进程确定性交错测试。

## 5. 合并和发布边界

当前 PR 可以继续作为实验性基础设施快照接受评估，但不能宣称：

- 完整 Harness-inspired replatform 已完成；
- 普通用户持续协作产品已可发布；
- 默认 Web/CLI 并发使用已经安全；
- Event Log 已是模型和恢复的 single source of truth。

把它合入 `main` 前，至少需要代码级 single-owner enforcement，或完整 multi-owner authority；只写“请勿并发”不足以成为正确性保证。

## 6. 版本与变更日志策略

根 `package.json` 的版本不仅是文档标签：`tekon update` 会比较本地和远端根版本，并在不同版本时执行拉取、依赖安装和完整构建。因此：

- 用户可见运行时功能、兼容行为或 bug fix 可以触发版本更新；
- 纯复审报告、批注、措辞修正和验收状态调整**不应单独抬高产品版本**；
- 此类内容记录到 `docs/reviews/`，必要时放入 `Unreleased` 说明；
- 不再为每一轮复审创建一个新的产品 PATCH 版本；
- 根版本与各可执行包版本需要在正式发布前统一定义单一发布身份。

本基线本身不修改产品版本。

## 7. 后续拆分建议

当前超大 PR 应冻结横向扩展，后续按独立小 PR 推进：

1. Runtime owner/lock + shutdown quiescence；
2. 一个真实 Provider 的 streaming vertical slice；
3. durable inbox + follow-up / steer / resume；
4. Collaborate track 与 Deliver 升级路径；
5. Narrative Feed + Current-state Inspector + Final Result；
6. long-session pagination / virtualization / performance budget。

每个 PR 必须具备可运行的纵向验收，不再以新增 Event type、Profile 或接口壳代替用户闭环。
