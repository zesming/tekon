# Tekon 当前权威产品与架构评审

- **当前报告**：[2026-09-02 Tekon 产品、UI/UX、Runtime 与 DeepSeek Harness 第十六轮全面复审](2026-09-02-tekon-product-runtime-harness-sixteenth-review.md)
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **上一轮权威代码快照**：`fc5418b410af78445f9fd184fd2352c375d4d580`
- **用户本轮整改快照**：`670c942acdacd53a9f5a1e0f4d70fd12d708a438`
- **reviewer 代码快照**：`ebd93d44fa0ab3562b653cda74695cfe60a83c36`
- **当前版本**：`0.20.4`
- **代码自动化状态**：reviewer 代码快照的 Core #402 与 CI #311 均为 `completed/success`；Root build/typecheck、production dependency audit、CLI build/unit/e2e、Web build/typecheck/unit 与 Chromium Playwright 全部成功
- **Tekon DSH tested pin**：`0.1.2-alpha.3`
- **DeepSeek Harness 当前官方版本**：`0.1.2-alpha.4`，release/master commit `4e84901e6471b79ec0338099867ebb4606d12bb5`
- **当前裁决**：本轮整改与 reviewer 局部修复通过当前代码合并门；Tekon 仍未通过“面向普通人的稳定持续协作研发工作台”产品验收

## 第十六轮确认的用户侧改进

- Host Node 只接受满足 DSH engines 的完整稳定 semver；partial、malformed、prerelease fail-closed；
- Host/version 的实际兼容性与 escape-hatch admission 分离，旁路不再被写成正式兼容；
- 公共 `--host-node-version` 测试注入已移除；
- Web health 使用完整 Host/version/help/config preflight，而不是只看二进制存在；
- 默认 Session Composer 不再把计划网络声明包装成宿主级隔离保证；
- #13–#27 将主要架构和产品主线拆成独立 issue，停止继续扩张 PR #11；
- 用户整改快照 Core/CI 通过，上一轮 Session、SSE、RunPlan 和 DSH 防线继续通过回归。

## 本轮 reviewer 直接修复

1. **统一 DSH Adapter preflight**  
   删除 Adapter 内重复的 15 秒 version/help/config probe、未调用的 version gate 和失真注释。Web/CLI 在持久化前 fail-closed；Adapter 在执行前继续调用同一个 Core `runDshPreflight()`，作为 binary/env TOCTOU 防御。

2. **顶栏 Provider 状态的可访问描述**  
   视觉上的 `(dsh-headless不可用)` 以前因连接按钮的 `aria-label` 不会被辅助技术读出。当前以 `aria-describedby` 关联同级隐藏描述，保留短凭据名称并补充 Provider 故障和 CLI preflight 行动入口；Chromium Playwright 已锁定 accessible description。

3. **alpha.4 外部基线复核**  
   alpha.4 默认在 Headless/ACP/Python SDK/custom profile 组合中启用 `web_fetch`，并调整 Session 按需读取 API 与 seq/offset 类型。Tekon 继续精确 pin alpha.3；alpha.4 必须完成独立 L1/L2/L3 后再决定升 pin。

## 已关闭或基本关闭

- CLI unit/e2e lane、Corepack shim 与 fixture npm warning；
- 根与内部 package 数字版本 lockstep；
- production dependency audit 基础 gate；
- Session/Workspace backward cursor、replay/pending budget、heartbeat backpressure 与 truncation 提示；
- Session detail right rail 的 snapshot fallback、审批事实层级和未知状态 fail-closed；
- CommandGateway no-progress 第一次边界采样误杀；
- DSH Host Node 启动前硬拦截、稳定 semver 判定和旁路事实分离；
- Web health 与真实 DSH admission 的主要合同差异；
- 默认 Composer 的网络保证过强表述；
- Adapter 第二套 DSH probe/timeout/dead gate；
- 顶栏 DSH unavailable 只对视觉用户可见；
- reviewer 代码快照的 Core、Root、Audit、CLI、Web unit 与 Chromium Playwright 回归门。

## 仍不能按“已关闭”表述的项目

- **single-owner Runtime**：CLI/Web 仍分别持有 DB、JobRunner、Git/worktree、Provider、Automation、Delivery 与 shutdown 生命周期；
- **Shutdown**：abort/kill/hard deadline/DB fence 不等于 executor、普通文件、Git 和外部 SDK 已 quiescent；
- **Session 事实源**：Event log 仍是 best-effort projection，不是 durable inbox 或权威模型历史；
- **Collaborate**：真实 execution-time streaming、follow-up、steer、prompt cancel、restart resume 和 Collaborate→Deliver 仍缺；
- **RunPlan**：尚未成为 execute/resume 唯一事实，未完整绑定 Demand、mode、base/workspace、resolved Provider、权限、网络证据与 expected Artifacts；
- **长 Session**：在线 replay/pending 已有边界；complete-history export、模型 compaction、统一 retention、真实规模与故障矩阵仍缺；
- **DSH alpha.4**：tested pin 仍是 alpha.3；alpha.4 默认 `web_fetch`、Session API 变化、真实二进制 L2 和带 API key 的 L3 尚未完成；
- **Provider exception 审计**：Host/version bypass 未写入 Provider snapshot 和 Audit；
- **Provider health UX**：凭据握手同步等待可选 DSH 全量 preflight，失败原因只以 available/unavailable 呈现；
- **DSH command override**：execution-time preflight 仍以 `basename(command) === 'dsh'` 区分真实与 fake，非标准生产 wrapper 可跳过；
- **CommandGateway 维护性**：同一模块仍承担 policy、env、spawn、进程组、redaction、filesystem sampler、timeout 与 stream settle；
- **Tracking 执行性**：#27 的顺序和依赖仅存在于 Markdown；GitHub 原生 subissue/dependency 均为 0，且无 milestone/assignee；
- **发布与供应链治理**：tag、migration、provenance、构建物、installer/update channel、dev/build audit、SBOM、dependency review 与签名仍不完整；
- **仓库治理**：`main` 未保护，required status checks enforcement 关闭；
- **代码卫生**：没有真实 JS/TS semantic lint gate，format 历史欠账仍大；
- **可访问性**：局部 ARIA/Chromium 证据不能外推全站 screen reader、Firefox/WebKit、缩放、对比度与真实弱网验收；
- **PR 可审阅性**：当前 PR 超过百个提交、约 190 个变更文件，建议 squash merge，并停止回填后续架构工作。

## 仍未关闭的主链路

```text
repo 级 single-owner Runtime
→ executor process/worker 隔离、真实 join 与 restart recovery
→ authoritative Session log / transactional outbox / durable inbox
→ DeepSeek ACP 或其它真实 Provider execution-time stream
→ follow-up / steer / prompt cancel / resume
→ Collaborate → Deliver
→ canonical RunPlan 成为 execute/resume 唯一输入
→ complete-history export / model compaction / 全链路 retention budget
```

## 推荐推进分组

```text
Runtime authority & recovery: #16 → #15
Session truth & collaboration: #13 → #14 → #19
Execution contract & history: #20 → #18
Provider / quality / release: #17, #22, #21, #24, #25, #26
```

#27 当前只作为阅读索引。P1-PROCESS-01 应成为每个后续 PR 的验收约束，而不是继续累积到同一超大 PR。

## 允许的成熟度表述

> Tekon v0.20.4 已形成测试覆盖较强、执行计划与风险边界较透明、Session 在线观察具有基础资源上限、可选 DSH Headless Provider 具有 tested-pin 和 Host Node fail-closed 预检的实验性受控交付执行与观察基础设施；Deliver 轨道可在有人监督下试用，但持续协作、单一 Runtime 权威、权威 Session 事实链、可证明的 shutdown/restart、完整历史导出与模型上下文预算尚未闭环。

## 文档说明

- 本文件与第十六轮报告是当前权威状态；
- 第一至第十五轮报告只读归档，不再追加当前裁决；
- 只有产品、架构、外部基线或代码门结论实质变化时新增完整报告；小修进入当前 issue/PR revision；
- CHANGELOG 只记录版本变化，不承担动态 upstream latest 事实；
- tested pin、upstream latest、actual installed version、compatibility 与 bypass admission 必须分开；
- 本地结果不能替代 PR Head 的 GitHub Actions 终态；
- PR Head 若继续变化，必须重新绑定自动化终态；
- 最终建议 squash merge。本轮未执行 merge、release、deploy 或 ruleset 修改。
