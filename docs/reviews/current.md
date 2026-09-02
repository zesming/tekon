# Tekon 当前权威产品与架构评审

- **当前报告**：[2026-09-02 Tekon 产品、UI/UX、Runtime 与 DeepSeek Harness 第十七轮全面复审](2026-09-02-tekon-product-runtime-harness-seventeenth-review.md)
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **上一轮权威 Head**：`28e010f19d513f8f21cf9e26bb31d5c5c8ed8316`
- **用户本轮整改 Head**：`d36812479fbf974b69bd24deda49efb008f709df`
- **本轮审查的产品代码快照**：`ebd93d44fa0ab3562b653cda74695cfe60a83c36`（用户本轮只修改评审批注）
- **第十七轮报告提交**：`57e5dde966d3ec46a91aed27d22940752068b161`
- **当前版本**：`0.20.4`
- **代码自动化状态**：用户整改 Head 的 Core #405 与 CI #314 均为 `completed/success`；Root build/typecheck、production dependency audit、CLI build/unit/e2e、Web build/typecheck/unit 与 Chromium Playwright 全部成功
- **Tekon DSH tested pin**：`0.1.2-alpha.3`
- **DeepSeek Harness 当前最新发布**：`0.1.2-alpha.4`
- **当前裁决**：本轮增量通过代码合并门；Tekon 仍未通过“面向普通人的稳定持续协作研发工作台”产品验收

## 第十七轮对最新整改的裁决

- 第十六轮新增的 DSH Adapter 统一 preflight 与 TopBar accessible description 继续成立；
- 用户新增 #28 的 DSH wrapper basename 问题真实存在，但同类问题也影响 Codex 的 safe args、Profile、sandbox 和 artifact framing；#28 已扩大为统一 Provider command identity 合同；
- 用户新增 #29 的 Web health 耦合问题真实存在，且默认 Codex/Claude 同样缺少可复用的持久化前 capability admission；#29 已提升为 credential health / Provider health / run admission 三层问题；
- 新发现 #31：`prepareRun → onPrepared → Session → opening Events → Job` 没有事务或 saga，任一中间失败可能留下部分持久化和幽灵运行；
- #30 原生 sub-issue/milestone/assignee 平台化当前属于流程过度设计，已按 `not_planned` 关闭；
- #27 已改为轻量 checklist，并明确所有后续主线必须独立 PR，不再回填 PR #11。

## 已关闭或基本关闭

- CLI unit/e2e lane、Corepack shim、fixture npm warning 与版本 lockstep；
- production dependency audit 基础 gate；
- Session/Workspace backward cursor、replay/pending budget、heartbeat backpressure 与 truncation 提示；
- Session right rail snapshot fallback、审批事实层级和未知状态 fail-closed；
- CommandGateway no-progress 第一次边界采样误杀；
- DSH Host Node fail-closed、稳定 semver、compatibility/bypass 分离和 Web health 主合同；
- 默认 Composer 的网络保证过强表述；
- Adapter 第二套 DSH probe/timeout/dead gate；
- 顶栏 DSH unavailable 只对视觉用户可见；
- 当前用户整改 Head 的 Core、Root、Audit、CLI、Web unit 与 Chromium Playwright 门禁。

## 仍不能按“已关闭”表述的项目

- **single-owner Runtime（#16）**：CLI/Web 仍分别持有 DB、JobRunner、Git/worktree、Provider、Automation、Delivery 与 shutdown 生命周期；
- **Shutdown/restart（#15）**：abort/kill/hard deadline/DB fence 不等于 executor、普通文件、Git 和外部 SDK 已 quiescent；
- **Session 事实源（#13）**：Event log 仍是 best-effort projection，不是 durable inbox 或权威模型历史；
- **Collaborate（#14/#19）**：真实 execution-time streaming、follow-up、steer、prompt cancel、restart resume 和 Collaborate→Deliver 仍缺；
- **原子 Run admission（#31）**：prepareRun、Session、opening Events 与 Job 缺事务/saga 和失败补偿；
- **RunPlan authority（#20）**：尚未成为 execute/resume 唯一事实，未完整绑定 Demand、mode、base/workspace、resolved Provider、权限、网络证据与 expected Artifacts；
- **Provider command identity（#28）**：DSH/Codex 仍以 basename 推断 preflight/command framing；
- **Provider health/admission（#29）**：token 健康仍等待可选 DSH，默认 Codex/Claude 缺持久化前 probe；
- **长 Session（#18）**：在线 replay/pending 已有边界，complete-history export、模型 compaction、统一 retention、真实规模与故障矩阵仍缺；
- **DSH alpha.4（#17）**：tested pin 仍为 alpha.3，alpha.4 默认 `web_fetch`、真实 L2/L3 尚未完成；
- **Provider exception Audit（#22）**：Host/version/network bypass 未写入 Provider snapshot/Audit；
- **CommandGateway（#25）**：同一模块仍承担 policy、env、spawn、redaction、filesystem sampler、timeout 与 settle；
- **发布、供应链、仓库治理**：provenance、SBOM、构建物签名、release channel 与 main required checks 仍不完整；
- **代码卫生与 a11y（#26/#21）**：无真实 semantic lint；缺全站 screen reader、Firefox/WebKit、缩放、对比度与真实弱网验收；
- **PR 可审阅性**：当前 PR 已超过 140 commits / 190 files，必须 squash，后续主线拆小 PR。

## 仍未关闭的主链路

```text
single-owner Runtime
→ executor isolation / restart
→ Provider health + explicit command identity
→ atomic Run admission
→ authoritative Session / durable inbox
→ persistent Provider stream
→ follow-up / cancel / resume
→ Collaborate → Deliver
→ RunPlan authority
→ export / compaction / retention
```

## 当前 Tracking

- [主线 checklist #27](https://github.com/zesming/tekon/issues/27)
- [Provider command contract #28](https://github.com/zesming/tekon/issues/28)
- [Provider health/admission #29](https://github.com/zesming/tekon/issues/29)
- [Atomic Run admission #31](https://github.com/zesming/tekon/issues/31)
- [DSH alpha.4 validation #17](https://github.com/zesming/tekon/issues/17)

#30 已按 `not_planned` 关闭。当前一个 checklist 足以表达顺序；原生 sub-issue、milestone 和 assignee 只有在多人并行、明确 release train 或实际状态漂移时才值得引入。

## 允许的成熟度表述

> Tekon v0.20.4 已形成测试覆盖较强、执行计划和风险边界较透明、Session 在线观察具有基础资源上限、可选 DSH Headless Provider 具有 tested-pin 与 Host Node fail-closed 预检的实验性受控交付执行与观察基础设施；Deliver 轨道可在有人监督下使用，但持续协作、单一 Runtime 权威、权威 Session 事实链、原子 Run admission、可证明的 shutdown/restart、完整历史导出与模型上下文预算尚未闭环。

## 维护规则

- 本文件与第十七轮报告是 PR #11 当前权威状态；
- 第一至第十六轮报告只读归档，不再追加当前裁决；
- 第十七轮作为 PR #11 最终整合评审，后续问题只在对应独立 PR/issue 中评审；
- CHANGELOG 只记录用户可见版本变化，不承担动态 upstream latest 或 reviewer 过程；
- tested pin、upstream latest、actual installed version、compatibility 与 bypass admission 必须分开；
- issue 登记不等于问题关闭；验证必须绑定具体 commit 和首次 `completed/success` 的 Core/CI；
- 合并前再次确认 PR Head 与自动化终态一致；最终建议 squash merge；
- 本轮未执行 merge、release、deploy 或 ruleset 修改。
