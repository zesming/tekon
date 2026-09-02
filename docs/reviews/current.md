# Tekon 当前权威产品与架构评审

- **当前报告**：[2026-09-02 Tekon 产品、UI/UX、Runtime 与 DeepSeek Harness 第十八轮全面复审](2026-09-02-tekon-product-runtime-harness-eighteenth-review.md)
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **上一轮权威 Head**：`1bc0cc5d5bfad72e617ff263e321df8bb5fc86b9`
- **用户本轮整改 Head**：`9daa912128a4d7407eb1eb95aecb4bf31f8b6a09`
- **本轮审查的产品行为快照**：`9daa912128a4d7407eb1eb95aecb4bf31f8b6a09`（只改评审批注和注释，无行为变化）
- **第十八轮报告提交**：`7460035a8b4bcf1aaa7926c3910bf730b0e971e0`
- **当前版本**：`0.20.4`
- **产品代码自动化状态**：`9daa912...` 的 Core #408 与 CI #317 均为 `completed/success`；Root build/typecheck、production dependency audit、CLI build/unit/e2e、Web build/typecheck/unit 与 Chromium Playwright 全部成功
- **Tekon DSH tested pin**：`0.1.2-alpha.3`
- **DeepSeek Harness 当前最新发布**：`0.1.2-alpha.4`
- **当前裁决**：本轮增量通过代码合并门；Tekon 仍未通过“面向普通人的稳定持续协作研发工作台”产品验收

## 第十八轮对最新整改的裁决

- 用户新增的两路评估批注和 DSH 注释修正准确，没有新增产品代码回归；
- #28 Provider command、#29 Provider health/admission、#31 原子 Run admission 继续成立；
- 新确认：`dshHeadlessProviderConfig()` 默认写入 `acknowledgeUnrestrictedNetwork: true`，Core 默认配置代替调用方产生了网络确认事实；
- 新确认：`SessionServiceStartRunInput.planDigest` 在 `startRun()` 中从未读取，当前主入口依靠 opaque engine input 的第二份 digest 才生效；
- 新确认：CLI DSH preflight 通过外层可变 `activeAgent` 传递本次 Provider，公共编排合同不是 request-scoped；
- 新确认：每 Run 一个 Project 与每 repo 一个 Workspace 构成重复身份模型，需在 RunPlan/Runtime identity 设计中统一；
- 上述问题分别并入 #22、#29 和 #20，没有继续制造重复 issue，也没有在超大 PR 中零散修改公共协议和迁移语义。

## 本轮直接收敛

1. **#22 Provider exception**  
   扩展为网络/Host/版本旁路的完整确认事实链：Provider 默认配置不得自行确认；RunPlan、Snapshot、Audit、resume 与旧 ack-only Run 必须有一致策略。

2. **#29 Provider health/admission**  
   增加 request-scoped preflight 要求，删除 CLI `activeAgent` mutable slot；Credential health、Provider health、Run admission 与 execution-time recheck 分层。

3. **#20 RunPlan authority**  
   增加失效顶层 `planDigest`、两套参数源、Project/Workspace identity、ExecutionPlan/Provider snapshot 同构和 resume 校验要求。

4. **评审过程收敛**  
   第十八轮为 PR #11 的最终权威整合评审。后续问题只在对应独立 PR/issue 中评审，不再向本 PR 回填架构代码或创建新的总报告。

## 已关闭或基本关闭

- CLI unit/e2e lane、Corepack shim、fixture npm warning 与数字版本 lockstep；
- production dependency audit 基础 gate；
- Session/Workspace backward cursor、replay/pending budget、heartbeat backpressure 与 truncation 提示；
- Session right rail snapshot fallback、审批事实层级和未知状态 fail-closed；
- CommandGateway no-progress 第一次边界采样误杀；
- DSH Host Node fail-closed、稳定 semver、compatibility/bypass 分离和 Web health 主合同；
- 默认 Composer 的网络隔离过强表述；
- DSH Adapter 第二套 probe/timeout/dead gate；
- 顶栏 DSH unavailable 只对视觉用户可见；
- 当前用户整改 Head 的 Core、Root、Audit、CLI、Web unit 与 Chromium Playwright 门禁。

## 仍不能按“已关闭”表述的项目

- **single-owner Runtime（#16）**：CLI/Web 仍分别持有 DB、JobRunner、Git/worktree、Provider、Automation、Delivery 与 shutdown 生命周期；
- **Shutdown/restart（#15）**：abort/kill/hard deadline/DB fence 不等于 executor、普通文件、Git 和外部 SDK 已 quiescent；
- **Session 事实源（#13）**：Event log 仍是 best-effort projection，不是 durable inbox 或权威模型历史；
- **Collaborate（#14/#19）**：真实 execution-time streaming、follow-up、steer、prompt cancel、restart resume 和 Collaborate→Deliver 仍缺；
- **原子 Run admission（#31）**：prepareRun、Audit、Session、opening Events 与 Job 缺事务/saga 和失败补偿；
- **Provider exception（#22）**：默认 DSH config 自行 ack；网络/Host/版本确认尚未与 RunPlan、Snapshot、Audit 和 resume 原子绑定；
- **RunPlan authority（#20）**：顶层 `planDigest` 静默失效；未完整绑定 Demand、mode、base/workspace、Provider、权限、网络证据、Artifacts 与 executable plan；
- **Provider command identity（#28）**：DSH/Codex 仍以 basename 推断 preflight 或 command framing；
- **Provider health/admission（#29）**：token 健康仍等待可选 DSH；CLI 使用 `activeAgent` 可变槽；Codex/Claude 缺持久化前 probe；
- **长 Session（#18）**：在线 replay/pending 已有边界，complete-history export、模型 compaction、统一 retention、真实规模与故障矩阵仍缺；
- **DSH alpha.4（#17）**：tested pin 仍为 alpha.3；alpha.4 默认 `web_fetch`、真实 L2/L3 尚未完成；
- **CommandGateway（#25）**：同一模块仍承担 policy、env、spawn、redaction、filesystem sampler、timeout 与 settle；
- **发布、供应链、仓库治理**：provenance、SBOM、构建物签名、release channel 与 main required checks 仍不完整；
- **代码卫生与 a11y（#26/#21）**：无真实 semantic lint；缺全站 screen reader、Firefox/WebKit、缩放、对比度与真实弱网验收；
- **PR 可审阅性**：当前 PR 超过 140 commits / 190 files，必须 squash，后续主线拆小 PR。

## 仍未关闭的主链路

```text
single-owner Runtime
→ executor isolation / restart
→ Provider health + explicit command identity
→ atomic Run admission + exception facts
→ canonical RunPlan authority
→ authoritative Session / durable inbox
→ persistent Provider stream
→ follow-up / cancel / resume
→ Collaborate → Deliver
→ export / compaction / retention
```

## 当前 Tracking

- [主线 checklist #27](https://github.com/zesming/tekon/issues/27)
- [Provider exception facts #22](https://github.com/zesming/tekon/issues/22)
- [RunPlan authority #20](https://github.com/zesming/tekon/issues/20)
- [Provider command contract #28](https://github.com/zesming/tekon/issues/28)
- [Provider health/admission #29](https://github.com/zesming/tekon/issues/29)
- [Atomic Run admission #31](https://github.com/zesming/tekon/issues/31)
- [DSH alpha.4 validation #17](https://github.com/zesming/tekon/issues/17)

#30 已按 `not_planned` 关闭。当前一个 checklist 足以表达顺序；项目管理元数据不是产品正确性或 Runtime 安全的前置条件。

## 允许的成熟度表述

> Tekon v0.20.4 已形成测试覆盖较强、执行计划和风险边界较透明、Session 在线观察具有基础资源上限、可选 DSH Headless Provider 具有 tested-pin 与 Host Node fail-closed 预检的实验性受控交付执行与观察基础设施；Deliver 轨道可在有人监督下使用，但持续协作、单一 Runtime 权威、权威 Session 事实链、原子 Run admission、Provider 确认事实链、可证明的 shutdown/restart、完整历史导出与模型上下文预算尚未闭环。

## 维护规则

- 本文件与第十八轮报告是 PR #11 当前权威状态；
- 第一至第十七轮报告只读归档，不再追加当前裁决；
- 第十八轮作为 PR #11 最终整合评审，后续问题只在对应独立 PR/issue 中评审；
- CHANGELOG 只记录用户可见版本变化，不承担动态 upstream latest 或 reviewer 过程；
- tested pin、upstream latest、actual installed version、compatibility、bypass 与 acknowledgement 必须分开；
- issue 登记不等于问题关闭；验证必须绑定具体 commit 和 `completed/success` 的 Core/CI；
- 合并前再次确认 PR Head 与自动化终态一致；最终建议 squash merge；
- 本轮未执行 merge、release、deploy 或 ruleset 修改。
