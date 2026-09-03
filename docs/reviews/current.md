# Tekon 当前权威产品与架构评审

- **当前报告**：[2026-09-03 Tekon 产品、UI/UX、Runtime 与 DeepSeek Harness 第二十轮全面复审（Markdown）](2026-09-03-tekon-product-runtime-harness-twentieth-review.md) / [HTML 审阅版](2026-09-03-tekon-product-runtime-harness-twentieth-review.html)
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **上一轮权威报告 Head**：`618de86a5e187f1398b8f66676ebc16af43ef1a6`
- **用户 v0.20.5 整改 Head**：`dddc0a53be717b276eed80bdb58fe4bcb7095fa2`
- **Reviewer 行为修复 Head**：`b2bfa45a099047b8eec778b217c598a0727106cb`
- **第二十轮报告发布**：`ae423dbc3700f84ef42d8503dbf04b37c956e96a`
- **当前权威远端基线 Head**：`6fd86ee1c500f55ff4d8a993812ae00823c3c46b`
- **当前版本**：`0.20.6`（补充整改工作树）
- **用户整改自动化**：Core #416、CI #325 为 `completed/success`
- **Reviewer 行为修复自动化**：Core #417、CI #326 为 `completed/success`
- **当前权威远端基线自动化**：Core #419、CI #328 为 `completed/success`
- **v0.20.6 本地自动化**：144 files / 1551 passed / 3 skipped；Core e2e 26、CLI e2e 8、Web Chromium 44；官方 rc.1 Wrapped L2 通过
- **Tekon DSH tested pin**：`0.1.2-alpha.3`
- **DeepSeek Harness 当前上游发布**：`0.1.2-rc.1`
- **当前裁决**：v0.20.6 本地门已通过，远端代码合并门需待提交并取得新 Head 的 Core/CI `completed/success` 后裁决；Tekon 仍未通过“面向普通人的稳定持续协作研发工作台”产品验收

## 第二十轮与 v0.20.6 补充整改裁决

v0.20.5 的以下整改真实成立：

- Advanced Run 的 token、plan、draft approval、digest、network acknowledgement 与 mutation pending 已进入统一纯状态选择器；
- Advanced Run 有同步 `useRef` single-flight，真实 Chromium 证明同 turn 不会双发 `project.run`；
- `shapePath` 草案必须同时满足需求批准与 plan approval 才能启动；
- 390px / 700px 下的选项、高级设置与操作区改为单列布局，技术标签缩短并保留完整说明；
- 正式 DSH Run 与 metadata probe 均固定 `DSH_TELEMETRY_DISABLED=1`；
- `project.clean` 的即时 fail-closed 与完整 lifecycle-safe purge 被拆为 #33/#18，没有用不完整修复冒充闭环；
- 用户整改 Head 的 Core、Root、Audit、CLI、Web unit 与 Chromium Playwright 全部成功。

## 本轮 reviewer 直接修复

1. **Metadata probe 最小环境与隔离 workspace**
   不再将整个 `process.env` 交给外部 `dsh`。内置 probe 共享一次性临时 `cwd`、`DSH_HOME` 与 `DSH_AGENTS_HOME`，切断 rc.1 已确认的调用方 cwd/DSH home `.env` 和 `.credentials.yaml` 自动 fallback；API key、云凭据、代理凭据、SSH agent、`NODE_OPTIONS`、npm 注入与 ambient permission mode 被排除。该边界不是 OS sandbox。

2. **Metadata first-use 顺序**  
   `--dump-default-config` 完成并通过组合校验后才执行 `--help`，避免同一 DSH_HOME 在首次自动初始化时并发写入。

3. **默认 Session Composer 同步单飞**  
   默认的人类主入口也加入同步 latch。测试在第一次请求未完成时强制第二次激活，最终只产生一个 `project.run`；首次失败后会释放 latch，第二次提交可成功。

4. **DeepSeek Harness 版本事实**  
   上游已在 2026-09-03 发布 `0.1.2-rc.1`。alpha.5→rc.1 的 tag diff 只有 package 版本号变化；master 虽同样标记 rc.1，但相对 release tag 已有 99 个提交/596 个文件变化。无凭据 Wrapped L2 已完成，带凭据 L3 仍缺，tested pin 继续保持 alpha.3。

5. **默认 Session 缺摘要重试**
   `workflow.plan` 返回但缺少 digest 时继续阻止启动，并提供原地重试；第二次计划请求恢复 digest 后提交按钮重新可用。

## 已关闭或基本关闭

- CLI unit/e2e lane、Corepack shim、fixture npm warning 与四包版本 lockstep；
- production dependency audit 基础 gate；
- Session/Workspace backward cursor、replay/pending budget、heartbeat backpressure 与 truncation 提示；
- Session right rail snapshot fallback、审批事实层级与未知状态 fail-closed；
- CommandGateway no-progress 第一次边界采样误杀；
- DSH Host Node fail-closed、稳定 semver、compatibility/bypass 分离与 Web health 主合同；
- 默认/高级入口的网络保证过强表述；
- DSH Adapter 第二套 probe/dead gate；
- 正式 Run 与 metadata probe 的 telemetry hard opt-out；
- metadata probe 直接继承宿主秘密、已确认的 cwd/DSH home fallback 与 config/help 单调用 first-use 并发竞态；
- mock Provider 在高级表单中无提示伪装成真实执行；
- Advanced Run 统一准入、同步单飞、草案 plan approval 与窄屏布局；
- 默认 Session Composer 同步单飞；
- Reviewer 行为修复 Head 的 Core #417 / CI #326。

## 仍不能按“已关闭”表述的项目

- **single-owner Runtime（#16）**：CLI/Web 仍分别持有 DB、JobRunner、Git/worktree、Provider、Automation、Delivery 与 shutdown 生命周期；
- **Shutdown/restart（#15）**：abort/kill/hard deadline/DB fence 不等于 executor、普通文件、Git 与外部 SDK 已 quiescent；
- **Session 事实源（#13）**：Event log 仍是 best-effort projection，不是 durable inbox 或权威模型历史；
- **Collaborate（#14/#19）**：真实 execution-time streaming、follow-up、steer、prompt cancel、restart resume 与 Collaborate→Deliver 仍缺；
- **原子 Run admission（#31）**：prepareRun、Audit、Session、opening Events 与 Job 缺事务/saga、request idempotency 和失败补偿；
- **Provider exception（#22）**：默认 DSH config 自行 ack，确认尚未与 RunPlan、Snapshot、Audit 与 resume 原子绑定；
- **RunPlan authority（#20）**：顶层 `planDigest` 静默失效，Demand/mode/base/workspace/Provider/权限/网络/Artifacts/executable plan 未完整绑定；
- **Provider command identity（#28）**：DSH/Codex 仍可由 executable basename 改变 preflight 或 command framing；
- **Provider health/admission（#29）**：token 健康仍等待可选 DSH，CLI 仍使用 `activeAgent` 可变槽，Codex/Claude 缺持久化前 probe；
- **DSH environment/evidence（#32）**：metadata probe 的最小环境、隔离 home、telemetry 与单调用顺序已修；正式 Run 的工作树 `.env`、凭据来源、代理配置与内部 tool enforcement 仍未治理；
- **历史与生命周期（#18/#33）**：完整导出、模型 compaction、retention、lifecycle-safe purge 与短期 clean fail-closed 尚未落地；
- **DSH rc.1（#17）**：L1 与官方 npm 包的无凭据 Wrapped L2 已完成；带凭据 L3 尚未完成；
- **a11y / 多浏览器（#21）**：缺全站 screen reader、Firefox/WebKit、缩放、forced-colors 与真实弱网验收；
- **工程治理（#24/#25/#26）**：required checks、SBOM/provenance/签名/release channel、CommandGateway 拆分、semantic lint 与 format debt 仍缺；
- **两套 Run UI**：当前均已 fail-closed/单飞，但计划披露和 submission 状态仍重复，已两次发生语义漂移；
- **PR 可审阅性**：当前 PR 规模过大，最终应 squash merge，后续主问题拆独立小 PR。

## 当前未闭环主链路

```text
single-owner Runtime
→ quiescent executor/restart
→ request-scoped Provider admission + explicit command identity
→ request-scoped credential/capability evidence
→ atomic/idempotent Run admission + exception facts
→ canonical RunPlan authority
→ authoritative Session / durable inbox
→ persistent Provider stream
→ follow-up / cancel / resume
→ Collaborate → Deliver
→ export / compaction / lifecycle-safe retention
```

## 允许的成熟度表述

> Tekon v0.20.6 已形成测试覆盖较强、执行计划和风险边界较透明、Session 在线观察具有基础资源上限、DSH Headless 具有 tested pin、Host Node fail-closed、隔离 metadata probe workspace 与 telemetry hard opt-out 的实验性受控交付执行与观察基础设施。Deliver 轨道可在有人监督下使用，但持续协作、单一 Runtime 权威、权威 Session 事实链、原子 Run admission、Provider credential/capability evidence、可证明的 shutdown/restart、完整历史导出与模型上下文预算仍未闭环。

## 评审资料维护规则

- 本文件是唯一稳定入口；
- 第二十轮报告是当前详细裁决；
- 第一至第十九轮只读归档，不再追加新裁决；
- 当前正式报告同时维护 Markdown 源稿与同名 HTML 审阅版，两者修改时必须同步；
- 产品或架构基线变化时才新建报告，普通问题在独立 PR/issue 中关闭；
- CHANGELOG 只记录用户可见行为，不复制 reviewer 过程；
- 代码 snapshot 与 `completed/success` 的 Core/CI snapshot 必须成对更新；
- PR Head 若继续变化，必须重新绑定 CI 终态后才能复用“代码门通过”；
- PR #11 最终建议 squash merge，后续 #13–#33 不再回填该超大分支。
