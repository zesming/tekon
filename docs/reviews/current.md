# Tekon 当前权威产品与架构评审

- **当前报告**：[2026-08-31 Tekon 产品、UI/UX、Runtime 与 DeepSeek Harness 第十一轮全面复审](2026-08-31-tekon-product-runtime-harness-eleventh-review.md)
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **用户 v0.20.1 / v0.20.2 整改快照**：`2752a0b5e99d5a860dd21a46debae3bb1d901164`
- **reviewer 代码快照**：`4bf88401e7c4ed1e881ff7ebd94b53028dbbf0eb`
- **当前版本**：`0.20.3`
- **代码自动化状态**：`4bf8840...` 的 Core #342 与 CI #251 均为 `completed/success`；Root、CLI unit/e2e、Web build/typecheck/unit、Chromium Playwright 全部成功
- **Tekon DSH tested pin**：`0.1.2-alpha.2`
- **DeepSeek Harness 当前官方版本**：`0.1.2-alpha.2`
- **当前裁决**：v0.20.1/v0.20.2 整改与 reviewer 修复通过代码合并门；Tekon 仍未通过“面向普通人的稳定持续协作研发工作台”产品验收

## 第十一轮确认的实质改进

- workspace summary SSE 有 100 帧 / 256KB 的慢客户端 pending 上限，超限关闭并由客户端重连恢复最新摘要；
- Session SSE 的 backward cursor、replay/pending budget 和页面截断提示继续成立；
- DSH tested pin 已追平官方 `0.1.2-alpha.2`；
- DSH Node 前置条件、完整 YAML row-id 合同和共享 fake-dsh fixture 已收敛；
- Core e2e 文件选择补齐漏跑用例；
- react-router 更新后 Web build/unit/Chromium e2e 成功；
- 本轮 reviewer 修复了 Session SSE 分页追赶与 socket 背压组合下的重复读取/自旋，以及两条 SSE heartbeat 忽略 `write(false)` 的问题；
- DSH preflight 的 JSON 现在把 `nodeRequirement` 与可执行 `installHint` 分开，help/config 失败也会保留已探测到的 actual version。

## v0.20.3 批注整改（第十一轮第 16.3 节）

- CLI e2e 文件重命名为 `*.e2e.test.ts`，`test:e2e` 选择器对齐 core 包，消除 unit/e2e 双跑；
- CI 17 处 `npm exec --yes -- pnpm@10.12.1` 替换为 `corepack pnpm`，消除 npm env config 弃用警告；
- 根 `package.json` 新增 `pnpm.overrides` 锁定 brace-expansion/postcss/nanoid，`pnpm audit` High/Moderate 降为 0（仅剩 2 项 esbuild Low，vite semver 不兼容故保留）；
- 详见 `docs/superpowers/plans/2026-08-31-eleventh-review-remediation-plan.md`。

## 本轮 reviewer 直接修复

1. **Session SSE 分页 × 背压组合缺陷**  
   当前数据库页触发 `write(false)` 后立即停止继续分页，等待 drain 推进 cursor；不再从旧 cursor 重复读取、重复计入 reconnect budget 或在 fresh connect 下自旋。

2. **Heartbeat 背压**  
   Session 与 workspace heartbeat 都检查 `response.write()` 返回值；心跳阻塞期间，后续业务帧进入各自有界 pending 状态，drain 后恢复。

3. **DSH 机器可读输出**  
   `installHint` 恢复为可直接执行的纯命令；Node 要求成为独立结构化字段，文本和 JSON 均有回归锁。

4. **DSH 诊断真实性**  
   版本探测成功但 help/config 漂移时保留 actual version，不再误导为未安装。

5. **权威文档一致性**  
   清除旧 snapshot/CI、v0.20.0 成熟度、DSH prerelease 和 workspace SSE 状态的互相矛盾表述；第十轮及更早报告转为只读历史。

## 已关闭或基本关闭

- 真正的 `beforeSeq` / `nextBeforeSeq` 历史反向游标；
- Session replay budget、Session pending event/byte cap 与 truncation 用户提示；
- workspace summary pending frame/byte cap；
- Session/Workspace heartbeat 背压；
- DSH row-id 假阳性与 bare-line parser seam；
- DSH tested pin 与 upstream latest 的版本断层；
- DSH Node 前置条件的结构化展示；
- 当前代码快照的 Core、Root、CLI、Web unit 和 Chromium Playwright 回归门。

## 仍不能按“已关闭”表述的项目

- **single-owner Runtime**：CLI/Web 仍各自持有 JobRunner、DB、Git/worktree、Provider 和 shutdown 生命周期；
- **Shutdown**：hard deadline + DB fence 不等于 executor、普通文件、Git 和外部 SDK 已 quiescent；
- **Session 事实源**：Event log 仍是 best-effort projection，不是 durable inbox 或权威模型历史；
- **Collaborate**：真实 streaming、follow-up、steer、prompt cancel、restart resume 和 Collaborate → Deliver 仍缺；
- **RunPlan**：校验与持久化一致，但尚未成为 execute/resume 的唯一权威输入，也未绑定 Demand/base/workspace/resolved Provider/expected Artifacts；
- **长 Session**：在线 replay/pending 已有基础上限，完整历史导出、模型 context compaction、统一 retention policy、真实规模和故障矩阵仍未闭环；
- **DSH**：pin/合同已追平 alpha.2，但带真实 dsh 二进制与 API key 的 Provider smoke 仍缺；
- **可访问性**：两个配置 dialog 已闭环，不能外推为全站 screen reader、Firefox/WebKit 和对比度验收；
- **测试与过程**：CLI e2e 文件命名与 lane 语义已对齐（`*.e2e.test.ts` + `.e2e.test` 选择器），CI npm env warning 已通过 corepack 替换清理；devDependencies 漏洞已 override 到 High/Moderate 为 0。当前 PR 体量仍过大，建议 squash merge 后架构主链路拆独立 PR。

## 仍未关闭的主链路

```text
repo 级 single-owner Runtime
→ executor 隔离、真实 join 与 restart recovery
→ authoritative Session log / durable inbox
→ DeepSeek ACP 或其它真实 Provider execution-time stream
→ follow-up / steer / prompt cancel / resume
→ Collaborate → Deliver
→ canonical RunPlan 成为 execute/resume 唯一输入
→ complete-history export / model compaction / 全链路 retention budget
```

## 允许的成熟度表述

> Tekon v0.20.3 已形成测试覆盖较强、计划与风险边界较透明、长会话在线观察具有基础资源上限的实验性受控交付执行与观察基础设施；Deliver 轨道可在有人监督下试用，但持续协作、单一 Runtime 权威、权威 Session 事实链、可证明的 shutdown/restart、完整历史导出和模型上下文预算尚未闭环。

## 评审资料维护规则

- 本文件是唯一稳定入口；
- 第十一轮报告是当前详细裁决；
- 第一至第十轮只读归档，不再追加新批注或新裁决；
- 产品/架构基线变化时新建报告，不在旧报告尾部继续叠加 revision；
- CHANGELOG 只记录用户可见行为，不复制 reviewer 过程；
- 代码 snapshot 与 `completed + success` 的 Core/CI snapshot 必须成对更新；
- 最终建议 squash merge，后续架构主链路拆分为独立 PR。
