# Tekon 当前权威产品与架构评审

- **当前报告**：[2026-09-03 Tekon 产品、UI/UX、Runtime 与 DeepSeek Harness 第二十一轮全面复审](2026-09-03-tekon-product-runtime-harness-twenty-first-review.md)
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **上一轮权威 Head**：`6fd86ee1c500f55ff4d8a993812ae00823c3c46b`
- **用户 v0.20.6 整改 Head**：`374387da794c96b3775d2814b98a3e38067a6b94`
- **Reviewer 代码修复 Head**：`8991fa5496492691799dc885633768cc2fd54b2e`
- **第二十一轮报告发布**：`031203866ee6a213943ebde498437433046382a5`
- **当前版本**：`0.20.6`
- **Reviewer 代码自动化**：Core #424、CI #333 均为 `completed/success`；Root build/typecheck、production dependency audit、CLI build/unit/e2e、Web build/typecheck/unit 与 Chromium Playwright 全部成功
- **Tekon DSH tested pin**：`0.1.2-alpha.3`
- **DeepSeek Harness 当前上游发布**：`0.1.2-rc.1`
- **当前裁决**：v0.20.6 整改与本轮局部修复通过代码合并门；Tekon 仍未通过“面向普通人的稳定持续协作研发工作台”产品验收

## 第二十一轮确认的实质改进

- DSH metadata default probe 使用一次性临时 cwd、`DSH_HOME` 和 `DSH_AGENTS_HOME`；
- metadata probe 采用最小环境并固定 telemetry hard opt-out；
- Config 与 Help 顺序执行，避免 clean home first-use 并发写；
- 成功、命令失败和合同失败均进入 finally cleanup；
- 默认 Session Composer 增加同步 single-flight、缺 digest 原地重试和失败后重试；
- Advanced Run 在 320/390/700/1440px 有常驻 overflow/layout smoke；
- 官方 rc.1 Linux Wrapped L2 已验证 metadata wrapper；
- 仓库常驻 opt-in L2 已改为调用生产 `runDshPreflight()`，不再直接在调用者 cwd/环境中执行真实 dsh；
- Reviewer 代码 Head `8991fa5...` 的 Core #424 / CI #333 全绿。

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
   根 `engines` 声明 Node 20.19、22.12+ 与 24+，主 CI 只运行 Node 24；缺少最低版本矩阵、required checks、SBOM、provenance、签名与明确 release channel。

3. **Responsive test 过度增长**  
   自定义 geometry scanner 是有价值的 overflow smoke，但已经承担文本测量、clipping ancestor 与 overlap 判断；不应继续扩展成自建视觉测试平台。

4. **Warning callback 语义未定义**  
   Host/version 精确旁路时 `onWarn` 抛错会改变准入结果，而 cleanup warning 已被保护。后续需明确它是纯观测 sink 还是可否决策略 hook。

5. **两套 Run UI 和报告镜像重复**  
   默认/高级入口仍复制 plan、submission、single-flight 与风险披露；第二十轮又维护 Markdown/HTML 两份权威报告。第二十一轮恢复 Markdown-only。

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
- **工程治理（#24/#25/#26）**：Node matrix、required checks、供应链发布证据、CommandGateway 拆分、semantic lint 与 format debt 仍缺；
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

- 本文件是唯一稳定入口；
- 第二十一轮 Markdown 报告是当前详细裁决；
- 第一至第二十轮只读归档，不再追加新裁决；
- 不再生成当前报告的重复 HTML 镜像；历史 HTML 保留为归档，不继续同步；
- 普通问题在独立 Issue/PR 中关闭，只有产品或架构基线显著变化时新增完整报告；
- CHANGELOG 只记录用户可见行为，不复制 reviewer 过程；
- 代码 snapshot 与 `completed/success` 的 Core/CI snapshot 必须成对更新；
- PR Head 若继续变化，必须重新绑定 CI 终态后才能复用“代码门通过”；
- PR #11 最终建议 squash merge；后续 #13–#33 不再回填该超大分支。
