# Tekon 当前权威产品与架构评审

- **当前报告**：[2026-09-03 Tekon 产品、UI/UX、Runtime 与 DeepSeek Harness 第十九轮全面复审（Markdown）](2026-09-03-tekon-product-runtime-harness-nineteenth-review.md) · [（HTML 审阅版）](2026-09-03-tekon-product-runtime-harness-nineteenth-review.html)
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **上一轮权威 Head**：`62f7c6ba2a0c12e6ad6a0ce2be6dca026cf96840`
- **用户本轮整改 Head**：`b3167c52ee80f492c1d11ea9f5cd25a3193cc1c2`
- **Reviewer 行为修复快照**：`7acfbae438dbef46befe4d7bab46b844720b80ef`
- **第十九轮报告权威发布**：`618de86a5e187f1398b8f66676ebc16af43ef1a6`
- **主 Agent 收口快照**：`0ad721d4058e8155f646313d00779134f4da0aec`
- **当前版本**：`0.20.5`
- **用户整改自动化**：Core #411、CI #320 为 `completed/success`
- **Reviewer 修复自动化**：Core #412、CI #321 为 `completed/success`
- **主 Agent 收口自动化**：Core run [33723748836](https://github.com/zesming/tekon/actions/runs/33723748836)、CI run [33723748858](https://github.com/zesming/tekon/actions/runs/33723748858) 均为 `completed/success`（7 checks 全 pass）
- **Tekon DSH tested pin**：`0.1.2-alpha.3`
- **DeepSeek Harness 当前发布基线**：`0.1.2-alpha.5`
- **当前裁决**：本轮增量通过代码合并门；Tekon 仍未通过“面向普通人的稳定持续协作研发工作台”产品验收

## 第十九轮对最新整改的裁决与主 Agent 收口

- 用户对 `planDigest` 死参数、CLI `activeAgent`、Project/Workspace 双重身份和 DSH 默认 network ack 风险面的判断基本准确；
- alpha.5 确已发布，但 release tag commit 是 `db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5`，`49a606bc5b5934603f22a26957a07dc799ab0291` 是 master release-sync merge；
- “合同锚点零漂移”只能限定为 alpha.4→alpha.5 对当前 Headless metadata 锚点未观察到直接变化；alpha.3→alpha.5 仍包含默认 `web_fetch` 变化，且 L2/L3 未完成；
- 用户整改 Head 没有行为代码变化，Core/CI 全绿；
- Reviewer 行为修复快照 `7acfbae` 对 Advanced Run 的网络表述、提交门、mock 身份及 DSH Run telemetry 实施直接修复并通过 Core #412 / CI #321；
- 主 Agent 收口快照 `0ad721d` 进一步消除残留风险：将 telemetry opt-out 扩大至 metadata probe；将 Advanced Run 准入提取为单一源纯函数 `startRunSubmitState()` 并引入同步 `useRef` latch 关闭同一 tick 双发漏洞，补齐未批准草案计划门禁；优化 390px/700px 视口单列布局与短标签；将 `project.clean` 误删入口防护拆为 issue #33 且不宣称 lifecycle-safe；本地测试为 143 文件/1539 passed/3 skipped，Actions run 33723748836/33723748858 全绿。

## 本轮直接关闭或改善

1. **Advanced Run 网络语义**
   `网络受控隔离` 已改为 `计划未请求不受限网络`，并明确实际隔离取决于 Provider 与宿主环境；Playwright 增加反向断言。

2. **Advanced Run fail-closed 与单一阻断源**
   重构为纯状态函数 `startRunSubmitState()`，严格按 9 级优先级阻断（token 缺失、submitting、计划加载中、计划错误、无计划、无需求、草案未审批、缺失 planDigest、网络未确认），覆盖需求草案 `hasPlan && !planApproved` 门禁。

3. **同一页面并发防重入（Single-submit Latch）**
   引入同步 `useRef` latch，关闭 React `isPending` 生效前的同一 tick 双发漏洞，并在请求失败后安全释放以支持重试。

4. **移动与窄屏布局收敛**
   针对 390px/700px/<=768px 视口将选择器改为单列布局，闭合选项使用简短标签（dsh/mock/autonomous），消除文本截断与换行撕裂，完整风险说明下沉至相邻帮助区。

5. **mock Provider 产品身份**
   Web 高级表单明确标注 mock 只用于测试/演示、生成合成结果、不执行真实任务、不能作为交付证据。

6. **DSH telemetry 全面 hard opt-out**
   正式 Run（`envMode: exact` 白名单）固定 `DSH_TELEMETRY_DISABLED=1`；metadata preflight 探针子进程中删去宿主环境 `DSH_TELEMETRY_MODE` 与 `DSH_TELEMETRY_OTLP_URL`，固定 `DSH_TELEMETRY_DISABLED=1`，基于 `--profile headless --help` 会进入 profile/plugin boot 实施纵深防御；补充真实子进程环境变量回归测试。

7. **文档、方案与版本同步**
   更新用户手册（Markdown/HTML）、CHANGELOG、发布整改方案（Markdown/HTML），四包版本 lockstep 升级至 `v0.20.5`。

这些修复不会关闭 Provider admission、acknowledgement、credential provenance 或 Host enforcement 的架构问题。

## 第十九轮新增或扩大的问题

### #32 DSH 凭据来源与实际能力证据

DSH 官方仍可从以下来源解析凭据：

```text
launch environment
→ $DSH_HOME/.credentials.yaml
→ invocation cwd/.env
→ $DSH_HOME/.env
```

Tekon 的 invocation cwd 是 worktree。因此 child env 中没有 `DEEPSEEK_API_KEY`，不代表 DSH 没有从工作树 `.env` 获得凭据。

同时，Tekon DSH `permissionProfile.tools.allow/deny` 尚未映射成 DSH 内部工具控制；外层 CommandGateway 只能约束启动 `dsh` 的命令。未映射的声明不得描述为 Provider 已执行的控制。

已创建 [#32](https://github.com/zesming/tekon/issues/32)，要求 credential source、telemetry、sandbox/approval/filesystem/network/tool evidence 分开建模。

### #33 `project.clean` 误删入口防护与暂停物理删除

`project.clean` 当前可直接删除 `.tekon/runs/<runId>`，但没有 non-terminal/active Job guard、Audit/tombstone、数据库路径修复、导出前置或失败恢复。

为避免在超大 PR 中重构完整生命周期，已将“活动期误删入口防护”拆分为独立 issue [#33](https://github.com/zesming/tekon/issues/33)。首选方案是暂停物理删除、写 Audit 并返回拒绝。**该 issue 明确不宣称 lifecycle-safe**；完整 export、compaction、retention 与 lifecycle-safe purge 继续由 #18 统筹推进。PR #11 保持生产清理代码不变。

### #18 Run/Session 生命周期完整治理

与 #33 的入口防护正交，[#18](https://github.com/zesming/tekon/issues/18) 统筹负责 complete export、compaction、retention、tombstone 标记与生命周期安全的物理清理机制。

### #17 alpha.5 验证

[#17](https://github.com/zesming/tekon/issues/17) 现区分：

- release tag 与 master；
- L1 静态源码/fixture；
- L2 真实二进制 metadata，不需要 API key；
- L3 带凭据模型调用；
- 默认 `web_fetch`、telemetry hard opt-out 与 credential provenance。

## 已关闭或基本关闭

- CLI unit/e2e lane、Corepack shim、fixture npm warning 与数字版本 lockstep；
- production dependency audit 基础 gate；
- Session/Workspace backward cursor、replay/pending budget、heartbeat backpressure 与 truncation 提示；
- Session right rail snapshot fallback、审批事实层级和未知状态 fail-closed；
- CommandGateway no-progress 第一次边界采样误杀；
- DSH Host Node fail-closed、稳定 semver、compatibility/bypass 分离和 Web health 主合同；
- 默认 Composer 与 Advanced Run 的网络保证过强表述；
- DSH Adapter 第二套 probe/timeout/dead gate；
- DSH metadata probe 与正式 Run child telemetry hard opt-out；
- 顶栏 DSH unavailable 的 accessible description；
- mock Provider 在高级 Web 表单中无提示伪装成真实执行；
- Advanced Run 单一准入源、同一 tick `useRef` latch 并发防重入与草案未审批计划门禁；
- 390px/700px 移动视口单列布局与选项短标签；
- 主 Agent 收口快照 `0ad721d` 的 Core run 33723748836 与 CI run 33723748858 门禁（7 checks 全 pass）。

## 本地全量验证与客观限制

### 本地测试数据

- 主 Agent 本地执行 `pnpm test`：143 个测试文件，**1539 passed，3 skipped**，耗时约 25 秒；
- Core e2e：`pnpm --filter @tekon/core test:e2e` 共 8 个文件，**26 passed**；
- CLI e2e：`pnpm --filter @tekon/cli test:e2e` 共 3 个文件，**8 passed**；
- Web e2e：`pnpm --filter @tekon/web test:e2e` 共 20 个 Playwright 文件，**41 passed**（0 retries）；
- 工程门禁：`lint`、`typecheck`、`build` 与 `audit --prod`（零安全漏洞）全绿；
- 视觉排布：桌面（1440px）与移动（390px、700px）视口无组件溢出，整改方案与手册 HTML 在 320px、375px、1440px 视口下满足 `document.documentElement.scrollWidth <= window.innerWidth + 1`，无页级横溢。

### 客观限制与缺口

- 3 项测试跳过（3 skipped）属于未设置 `DSH_CLI_PATH` 时跳过的真实 DSH L2 metadata probe；它们不运行模型，也不需要 API key；
- 浏览器矩阵仅覆盖 Chromium，未运行 Firefox 与 WebKit 矩阵；
- 未执行真实 DSH L2 metadata probe，也未执行带凭据的 L3 模型调用。

## 仍不能按“已关闭”表述的项目

- **single-owner Runtime（#16）**：CLI/Web 仍分别持有 DB、JobRunner、Git/worktree、Provider、Automation、Delivery 与 shutdown 生命周期；
- **Shutdown/restart（#15）**：abort/kill/hard deadline/DB fence 不等于 executor、普通文件、Git 和外部 SDK 已 quiescent；
- **Session 事实源（#13）**：Event log 仍是 best-effort projection，不是 durable inbox 或权威模型历史；
- **Collaborate（#14/#19）**：真实 execution-time streaming、follow-up、steer、prompt cancel、restart resume 和 Collaborate→Deliver 仍缺；
- **原子 Run admission（#31）**：prepareRun、Audit、Session、opening Events 与 Job 缺事务/saga 和失败补偿；
- **Provider exception（#22）**：默认 DSH config 自行 ack；network/Host/version 确认尚未与 RunPlan、Snapshot、Audit 和 resume 原子绑定；
- **RunPlan authority（#20）**：顶层 `planDigest` 静默失效；未完整绑定 Demand、mode、base/workspace、Provider、权限、网络证据、Artifacts 与 executable plan；
- **Provider command identity（#28）**：DSH/Codex 仍可由 basename 改变 preflight 或 command framing；
- **Provider health/admission（#29）**：token 健康仍等待可选 DSH；CLI 使用 `activeAgent` 可变槽；Codex/Claude 缺持久化前 probe；
- **DSH environment/evidence（#32）**：工作树 `.env` 凭据来源与未映射 tool allow/deny 尚未治理；
- **长 Session 与生命周期清理（#18/#33）**：完整导出、模型 compaction、统一 retention、lifecycle-safe purge、即时防误删与故障矩阵仍缺；
- **DSH alpha.5（#17）**：L1 仅完成源码复核，真实 L2/L3 尚未完成；
- **CommandGateway（#25）**：同一模块仍承担 policy、env、spawn、redaction、filesystem sampler、timeout 与 settle；
- **发布、供应链、仓库治理**：provenance、SBOM、构建物签名、release channel 与 main required checks 仍不完整；
- **代码卫生与 a11y（#26/#21）**：无真实 semantic lint；缺全站 screen reader、Firefox/WebKit、缩放、对比度与真实弱网验收；
- **PR 可审阅性**：当前 PR 接近 150 commits / 200 files，必须 squash，后续主线拆小 PR。

## 产品主裁决

### Deliver

当前基本成立：

```text
需求
→ canonical plan/digest
→ 角色与 Gate
→ worktree 隔离执行
→ Artifact/Audit/Review
→ 人工审批
→ Delivery/PR 准备
```

可继续有人监督的工程试用。

### Collaborate

仍未成立：

```text
同一 Session 继续输入
→ Provider execution-time updates
→ follow-up/steer
→ prompt cancel
→ restart resume
→ Collaborate → Deliver
```

当前 Session 仍主要是 Run 观察、审批和证据投影面。

## 当前未闭环主链路

```text
single-owner Runtime
→ executor isolation / restart
→ request-scoped Provider admission + command identity
→ credential/capability evidence
→ atomic Run admission + exception facts
→ canonical RunPlan authority
→ authoritative Session / durable inbox
→ persistent Provider stream
→ follow-up / cancel / resume
→ Collaborate → Deliver
→ export / compaction / lifecycle-safe retention
```

## 当前 Tracking

- [主线 checklist #27](https://github.com/zesming/tekon/issues/27)
- [DSH alpha.5 validation #17](https://github.com/zesming/tekon/issues/17)
- [Session export/context/lifecycle #18](https://github.com/zesming/tekon/issues/18)
- [RunPlan authority #20](https://github.com/zesming/tekon/issues/20)
- [Provider exception facts #22](https://github.com/zesming/tekon/issues/22)
- [Provider command contract #28](https://github.com/zesming/tekon/issues/28)
- [Provider health/admission #29](https://github.com/zesming/tekon/issues/29)
- [Atomic Run admission #31](https://github.com/zesming/tekon/issues/31)
- [DSH environment/evidence #32](https://github.com/zesming/tekon/issues/32)
- [project.clean guard #33](https://github.com/zesming/tekon/issues/33)

## 允许的成熟度表述

> Tekon v0.20.5 已形成测试覆盖较强、执行计划与风险边界较透明、Session 在线观察具有基础资源上限、可选 DSH Headless Provider 具有 tested pin、Host Node fail-closed 预检和 telemetry hard opt-out 的实验性受控交付执行与观察基础设施；Deliver 轨道可在有人监督下使用，但持续协作、单一 Runtime 权威、权威 Session 事实链、原子 Run admission、Provider credential/capability evidence、可证明的 shutdown/restart、完整历史导出和模型上下文预算仍未闭环。

## 维护规则

- 本文件与第十九轮报告是 PR #11 当前权威状态；
- 第一至第十八轮报告只读归档，不再追加当前裁决；
- CHANGELOG 只记录用户可见版本变化，不承担动态 upstream latest 或 reviewer 过程；
- tested pin、release tag、master、actual installed version、compatibility、bypass、acknowledgement 与 credential source 必须分开；
- issue 登记不等于问题关闭；验证必须绑定具体 commit 和 `completed/success` 的 Core/CI；
- 后续主线只在独立小 PR 中实现，不继续向 PR #11 塞入跨模块架构代码；
- 合并前再次确认 PR Head（当前快照 `0ad721d`）与自动化终态一致；最终建议 squash merge；
- 本轮未执行 merge、release、deploy 或 ruleset 修改。
