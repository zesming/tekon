# Tekon 当前权威产品与架构评审

- **当前报告**：[2026-08-31 Tekon 产品、UI/UX、Runtime 与 DeepSeek Harness 第十轮全面复审](2026-08-31-tekon-human-first-harness-tenth-review.md)
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **用户 v0.20.0 整改快照**：`1f3a1695c5dc61122a6faaba20ce2d12dce0aa11`
- **reviewer 代码快照**：`11eecfb6347c5fe690a8561c5e49a344a30de317`
- **当前版本**：`0.20.2`
- **代码自动化状态**：`11eecfb...` 的 Core #331 与 CI #240 均为 `completed/success`；Root、CLI unit/e2e、Web build/typecheck/unit、Playwright 全部成功
- **Tekon DSH tested pin**：`0.1.2-alpha.2`
- **DeepSeek Harness 当前官方版本**：`0.1.2-alpha.2`
- **当前裁决**：v0.20.0 整改与 reviewer 低风险修复通过代码合并门；Tekon 仍未通过“面向普通人的稳定持续协作研发工作台”产品验收

## 第十轮确认的实质改进

- Session 历史读取使用真实 `beforeSeq` 反向游标和 `nextBeforeSeq` continuation；
- Session SSE pending buffer 具备事件数和字节双上限；
- truncation 已有用户可见提示，并明确页面最多额外保留 2000 条；
- reconnect replay budget 只覆盖首次重连 backlog，不再错误累计正常后续事件；
- DSH tested pin 升到 `0.1.2-alpha.2`，preflight 校验官方组合 YAML 的完整 row id；
- DSH fixture 不再把 package name 中的 `user-approval` 当作真实配置 row id；
- Core、CLI、Web unit 和 Playwright 在同一代码快照上完整成功。

## 本轮 reviewer 直接修复

1. **SSE 假截断**  
   初次 reconnect 已追平后，正常跨进程事件不再累计到重连预算。

2. **历史边界文案**  
   空事件时仍显示截断 banner；“达到页面保留上限”不再暗示已经到达会话起点。

3. **DSH config 合同**  
   required row 使用官方实际的 `approval`；正式 dump 必须匹配完整 YAML `id:` 行，包名子串不能假通过。

4. **外部版本事实**  
   Tekon tested pin 已升级到 `0.1.2-alpha.2`（与 upstream latest 一致）；headless 合同零差异，真实 smoke 仍待有 dsh 二进制的环境执行。

对应 reviewer 代码提交区间：`f106430a...` 至 `11eecfb...`。

## 仍不能按“已关闭”表述的项目

- **single-owner Runtime**：CLI/Web 仍各自持有 JobRunner、DB、Git/worktree、Provider 和 shutdown 生命周期；
- **Shutdown**：hard deadline + DB fence 不等于 executor、普通文件、Git 和外部 SDK 已 quiescent；
- **Session 事实源**：Event log 仍是 best-effort projection，不是 durable inbox 或权威模型历史；
- **Collaborate**：真实 streaming、follow-up、steer、prompt cancel、restart resume 和 Collaborate → Deliver 仍缺；
- **RunPlan**：校验与持久化一致，但尚未成为 execute/resume 的唯一权威输入；
- **长 Session**：workspace SSE、完整历史导出、模型 context compaction 和真实规模基准仍未闭环；
- **DSH**：tested pin 落后 upstream 一个 prerelease，缺带 API key 的真实 smoke；DSH 自身 Node 前置高于 Tekon 主体；
- **可访问性**：两个配置 dialog 已闭环，不能外推为全站 screen reader、多浏览器和对比度验收；
- **PR 可审阅性**：当前 PR 已超过 60 个提交、150 个文件和 2 万行新增，建议最终 squash，并将后续架构工作拆分。

## 仍未关闭的主链路

```text
repo 级 single-owner Runtime
→ executor 隔离、真实 join 与 restart recovery
→ authoritative Session log / durable inbox
→ DeepSeek ACP 或其它真实 Provider execution-time stream
→ follow-up / steer / prompt cancel / resume
→ Collaborate → Deliver
→ canonical RunPlan 成为 execute/resume 唯一输入
→ DB/API/SSE/client/DOM/export/model-context 全链路预算
```

## 允许的成熟度表述

> Tekon v0.20.0 已形成测试较强、计划和风险边界更透明、长会话观察开始有界的实验性受控交付执行与观察基础设施；Deliver 轨道可在有人监督下试用，但持续协作、单一 Runtime 权威、权威 Session 事实链、可证明的 shutdown/restart 和模型上下文预算尚未闭环。

## 评审资料维护规则

- 本文件是稳定入口；
- 第十轮报告是当前详细裁决；
- 第一至第九轮仅作为判断演进历史；
- CHANGELOG 只记录用户可见行为，不复制 reviewer 过程；
- 小整改更新当前报告 revision log，只有产品或架构基线显著变化时新增报告；
- 任何“验证通过”必须绑定具体 commit 和 `completed + success` 的 GitHub Actions 终态。
