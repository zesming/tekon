# Tekon 当前权威产品与架构评审

- **当前详细报告**：[Markdown 源稿](2026-09-03-tekon-product-runtime-harness-twenty-first-review.md) / [HTML 审阅版](2026-09-03-tekon-product-runtime-harness-twenty-first-review.html)
- **当前收口方案**：[Markdown 源稿](../superpowers/plans/2026-09-04-twenty-first-review-closure-plan.md) / [HTML 审阅版](../superpowers/plans/2026-09-04-twenty-first-review-closure-plan.html)
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **上一轮权威 Head**：`6fd86ee1c500f55ff4d8a993812ae00823c3c46b`
- **用户 v0.20.6 整改 Head**：`374387da794c96b3775d2814b98a3e38067a6b94`
- **Reviewer 代码修复 Head**：`8991fa5496492691799dc885633768cc2fd54b2e`
- **第二十一轮报告发布**：`031203866ee6a213943ebde498437433046382a5`
- **第二十一轮权威基线 Head**：`34a542f963b495673b4f7adc48c2c5a574fc7052`
- **本轮收口实施证据 Head**：`0d8fa4c3eae12ab8ed022dc78d60b8f094cf7917`
- **当前版本**：`0.20.6`
- **当前已绑定自动化**：Core #426（run `33759049251`）、CI #335（run `33759049201`）在 `34a542f...` 上均为 attempt 1 `completed/success`，原 7 项 checks 全绿
- **收口实施自动化**：Core #427（run `33836232524`）、CI #336（run `33836232602`）在 `0d8fa4c...` 上均为 attempt 1 `completed/success`，原 7 项 checks 与四条 Node compatibility legs 共 11 项全绿
- **Tekon DSH tested pin**：`0.1.2-alpha.3`
- **DeepSeek Harness 当前上游发布**：`0.1.2-rc.1`
- **当前裁决**：v0.20.6 整改、本轮局部修复与 Node compatibility 收口均通过实施 Head 的代码合并门；Tekon 仍未通过“面向普通人的稳定持续协作研发工作台”产品验收

## 当前证据索引

- v0.20.6 本地基线：`pnpm test` 为 144 files、1551 passed、1 skipped；唯一 skip 是未设置 `DSH_CLI_PATH` 时的真实 DSH L2 wrapper；
- 本轮当前工作树：`pnpm test` 为 145 files、1554 passed、1 skipped；新增 1 个文件和 3 个通过用例均来自 Node workflow 结构合同；
- 本轮当前工作树的 build、typecheck、lint、production audit 与 actionlint 1.7.12 均通过；Core/CLI/Web e2e 分别为 26/8/48 passed；
- Chromium Playwright：48 passed；320/390/700/1440px 两个 Run 入口四视口 4/4 通过；
- v0.20.6 代码与文档快照：`611feb09eae5ff212cc0177273fb2cb11633c9b7`，Core #420（run `33747232853`）、CI #329（run `33747232722`）成功；
- v0.20.6 响应式验收快照：`777e353e9b0ff7ffbe02b046a08aadeefe2cac97`，Core #422（run `33753603954`）、CI #331（run `33753603924`）成功；
- 第二十一轮权威基线：`34a542f963b495673b4f7adc48c2c5a574fc7052`，Core #426（run `33759049251`）、CI #335（run `33759049201`）成功；
- 收口实施证据：`0d8fa4c3eae12ab8ed022dc78d60b8f094cf7917`，Core #427（run `33836232524`）、CI #336（run `33836232602`）attempt 1 成功，11 项 checks 全绿；
- L2 live cases 从 Version/Config/Help 三个独立 case 合并为一个生产 wrapper case，检查内容未缩水，因此无 DSH 环境的统计由 `3 skipped` 变为 `1 skipped`。

## 第二十一轮确认的实质改进

- DSH metadata default probe 使用一次性临时 cwd、`DSH_HOME` 和 `DSH_AGENTS_HOME`；
- metadata probe 采用最小环境并固定 telemetry hard opt-out；
- Config 与 Help 顺序执行，避免 clean home first-use 并发写；
- 成功、命令失败和合同失败均进入 finally cleanup；
- 默认 Session Composer 增加同步 single-flight、缺 digest 原地重试和失败后重试；
- Advanced Run 在 320/390/700/1440px 有常驻 overflow/layout smoke；
- 官方 rc.1 Linux Wrapped L2 已验证 metadata wrapper；
- 仓库常驻 opt-in L2 已改为调用生产 `runDshPreflight()`，不再直接在调用者 cwd/环境中执行真实 dsh；
- Reviewer 代码 Head `8991fa5...` 的 Core #424 / CI #333 全绿；
- 本轮新增独立 `node-compat` job，覆盖 Node 20.19.x、22.12.x、22.19.x、24.x 的 install/build/typecheck/Core unit/CLI unit/CLI smoke；矩阵先固定 `corepack@0.34.1`，避免 Node 22.12 自带旧 Corepack 无法验证 pnpm 10.12.1 签名。分支保护保持不变。

## 本轮直接修复

### 常驻 L2 复用生产隔离 wrapper

原 `dsh-bridge-contract.test.ts` 直接使用 `execFileSync` 执行 Version/Help/Config，绕过临时 state root、最小环境、telemetry hard opt-out、probe 顺序和 cleanup。

现在使用：

```text
DSH_CLI_PATH=<real binary>
DSH_EXPECTED_VERSION=<tested pin or candidate>
→ runDshPreflight()
→ isolated metadata contract
→ exact version / compatibility / bypass assertions
```

候选版本即使通过精确 `allowVersion` 进入，也仍标记 `versionCompatible=false`、`versionBypassed=true`，不会把旁路描述成正式兼容。

## 第二十一轮新增或扩大的问题

1. **Windows Provider launcher（#28）**  
   Node 官方明确 `.bat` / `.cmd` 不能直接由 `execFile()` 启动；npm-installed `dsh.cmd` 的 metadata、正式 Run、quoting、timeout/cancel 与 process-tree 合同尚未验证。basename 身份判断还会让 `dsh.cmd` 或 wrapper 跳过 execution-time preflight。

2. **Node 支持矩阵与发布证据（#24）**  
   根 `engines` 声明 Node 20.19、22.12+ 与 24+。本轮已按用户决定在 PR #11 增加独立最低版本矩阵；required checks、SBOM、provenance、签名与明确 release channel 仍未完成。

3. **Responsive test 过度增长**  
   自定义 geometry scanner 是有价值的 overflow smoke，但已经承担文本测量、clipping ancestor 与 overlap 判断；不应继续扩展成自建视觉测试平台。

4. **Warning callback 语义未定义**  
   Host/version 精确旁路时 `onWarn` 抛错会改变准入结果，而 cleanup warning 已被保护。后续需明确它是纯观测 sink 还是可否决策略 hook。

5. **两套 Run UI 和报告同步成本**
   默认/高级入口仍复制 plan、submission、single-flight 与风险披露；正式报告按规约保留 Markdown 内容源与同步 HTML 审阅版，必须避免形成两套裁决。

## 已关闭或基本关闭

- CLI unit/e2e lane、Corepack shim、fixture npm warning 与四包版本 lockstep；
- production dependency audit 基础 gate；
- Session/Workspace backward cursor、replay/pending budget、heartbeat backpressure 与 truncation 提示；
- Session right rail snapshot fallback、审批事实层级与未知状态 fail-closed；
- CommandGateway no-progress 第一次边界采样误杀；
- DSH Host Node fail-closed、稳定 semver、compatibility/bypass 分离；
- 默认/高级入口的网络保证过强表述；
- DSH Adapter 第二套 probe/dead gate；
- 正式 Run 与 metadata probe telemetry hard opt-out；
- metadata probe 的宿主秘密继承、调用仓库/ambient DSH home fallback 与 Config/Help first-use 竞态；
- mock Provider 在高级表单中无提示伪装成真实执行；
- Advanced Run 统一准入、同步 single-flight、草案 plan approval 与窄屏布局；
- 默认 Session Composer 同步 single-flight、缺摘要和失败重试；
- 常驻 opt-in DSH L2 绕过生产 wrapper。

## 仍不能按“已关闭”表述的项目

- **single-owner Runtime（#16）**：CLI/Web 仍分别持有 DB、JobRunner、Git/worktree、Provider、Automation、Delivery 与 shutdown 生命周期；
- **Shutdown/restart（#15）**：abort/kill/hard deadline/DB fence 不等于 executor、普通文件、Git 与外部 SDK 已 quiescent；
- **Session 事实源（#13）**：Event log 仍是 best-effort projection，不是 durable inbox 或权威模型历史；
- **Collaborate（#14/#19）**：真实 execution-time streaming、follow-up、steer、prompt cancel、restart resume 与 Collaborate→Deliver 仍缺；
- **原子/幂等 Run admission（#31）**：prepareRun、Audit、Session、opening Events 与 Job 缺事务/saga、request idempotency 和失败补偿；
- **Provider exception（#22）**：网络/Host/版本确认尚未与 RunPlan、Snapshot、Audit 与 resume 原子绑定；
- **RunPlan authority（#20）**：顶层 `planDigest` 静默失效，Demand/mode/base/workspace/Provider/权限/网络/Artifacts/executable plan 未完整绑定；
- **Provider command identity（#28）**：wrapper/basename 与 Windows `.cmd` 可改变 preflight 或 launcher 语义；
- **Provider health/admission（#29）**：token health 仍等待可选 DSH，CLI 仍使用 `activeAgent` mutable slot，Codex/Claude 缺持久化前 probe；
- **DSH environment/evidence（#32）**：metadata probe 已隔离；正式 Run 的工作树 `.env`、凭据来源、代理与内部 tool enforcement 仍未治理；
- **历史与生命周期（#18/#33）**：完整导出、模型 compaction、retention、lifecycle-safe purge 与短期 clean fail-closed 尚未落地；
- **DSH rc.1（#17）**：Linux L1/L2 成立；Windows L2、带凭据 L3 和升 pin 裁决尚未完成；
- **a11y / 多浏览器（#21）**：缺全站 screen reader、Firefox/WebKit、缩放、forced-colors 与真实弱网验收；
- **工程治理（#24/#25/#26）**：Node matrix 已在本轮实现；required checks、供应链发布证据、CommandGateway 拆分、semantic lint 与 format debt 仍缺；
- **两套 Run UI**：当前均已 fail-closed/单飞，但业务状态与披露仍重复；
- **PR 可审阅性**：PR 规模已经不适合继续增长，最终应 squash merge。

## 当前未闭环主链路

```text
立即暂停裸 project.clean
→ request-scoped Provider admission + explicit cross-platform launcher
→ credential/capability evidence
→ atomic/idempotent Run admission + exception facts
→ canonical RunPlan authority
→ single-owner Runtime + quiescent restart
→ authoritative Session / durable inbox
→ persistent Provider stream
→ follow-up / cancel / resume
→ Collaborate → Deliver
→ export / compaction / lifecycle-safe retention
```

## 允许的成熟度表述

> Tekon v0.20.6 已形成测试覆盖较强、执行计划和风险边界较透明、Session 在线观察具有基础资源上限、DSH Headless 具有 tested pin、Host Node fail-closed、隔离 metadata workspace、最小 probe 环境与 telemetry hard opt-out 的实验性受控交付执行与观察基础设施。Deliver 轨道可在有人监督下使用，但持续协作、单一 Runtime 权威、权威 Session 事实链、原子且幂等的 Run admission、跨平台 Provider launcher、可证明的 shutdown/restart、完整历史导出与模型上下文预算仍未闭环。

## 评审资料维护规则

- 本文件是导航索引和唯一稳定入口，不是独立正式评审报告；
- 第二十一轮 Markdown 是当前详细裁决的内容源，同名 HTML 是同步的人审呈现；
- 第一至第二十轮只读归档，不再追加新裁决；
- 正式报告修改时必须同步 HTML；不得在两份文件中形成不同裁决；
- 普通问题在独立 Issue/PR 中关闭，只有产品或架构基线显著变化时新增完整报告；
- CHANGELOG 的 Unreleased 段只记录本轮工程与评审收敛，不为纯复审抬高产品版本；
- 仓库内记录实施证据 Head 与对应 runs；最终文档证据 Head 与 runs 只写 PR/Issue 外部状态，避免提交自引用；
- PR Head 若继续变化，必须重新绑定同一 Head 的 CI 终态后才能复用“代码门通过”；
- PR #11 最终建议 squash merge；后续 #13–#33 不再回填该超大分支。
