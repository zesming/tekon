# Tekon 当前权威产品与架构评审

- **当前详细报告**：[2026-09-04 第二十二轮全面复审](2026-09-04-tekon-product-runtime-harness-twenty-second-review.md)
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **上一轮权威 Head**：`34a542f963b495673b4f7adc48c2c5a574fc7052`
- **用户本轮整改 Head**：`5fa791e7384cce931c254847879c665d3fff6f97`
- **Reviewer 代码修复 Head**：`2073a0f4a6ee9956f69398dee33d3c70d0c9e607`
- **当前版本**：`0.20.6`
- **Reviewer 代码自动化**：Core #431、CI #340 均为 `completed/success`；Root build/typecheck、production dependency audit、Node 20.19/22.12/22.19/24 compatibility、CLI build/unit/e2e、Web build/typecheck/unit 与 Chromium Playwright 全部成功
- **Tekon DSH tested pin**：`0.1.2-alpha.3`
- **已完成 Linux Wrapped L2 的 DSH 候选**：`0.1.2-rc.1`
- **DeepSeek Harness 当前最新发布**：`0.1.3-alpha.1`，tag `d347e703908d0406b7a7ef80e3a0e594d86b2215`
- **当前裁决**：本轮整改与 Reviewer 局部修复通过代码合并门；Tekon 仍未通过“面向普通人的稳定持续协作研发工作台”产品验收

## 第二十二轮确认的实质改进

- 独立 Node Compatibility Job 在 20.19、22.12、22.19、24 四个选定边界执行 Frozen Install、全包 Build/Typecheck、Core/CLI Unit 和 CLI Binary Smoke；
- Matrix `fail-fast: false`，没有 `exclude`、条件跳过或 `continue-on-error`；
- CommandGateway 已结算命令会移除 AbortSignal Listener，并补 Spawn 与 Listener 注册之间的 Abort Recheck；
- 默认/高级 Run 的既有 Fail-closed、Single-flight、重试和四视口 Layout Smoke 继续通过；
- DSH Metadata Probe 的隔离 Workspace、最小环境、Telemetry hard opt-out、Config/Help 顺序与 Cleanup 继续通过；
- Production Audit 保持独立 Fail-closed，并对 npm Security Endpoint 瞬态失败增加一次有界重试。

## 本轮 Reviewer 直接修复

用户整改 Head 的所有功能和 Node Matrix 均成功，但 CI #339 的 Production Audit 因 npm Security Endpoint 连续 `ERR_SOCKET_TIMEOUT` 失败，没有返回 Advisory 结果。

当前 Audit 合同：

```text
第一次 pnpm audit --prod
→ 失败后等待 15 秒
→ 第二次重试
→ 第二次失败仍红灯
```

Job 上限调整为 12 分钟，不使用 `continue-on-error`，不把 Endpoint 不可用或已知漏洞静默放行。Reviewer Head `2073a0f...` 的 CI #340 返回 `No known vulnerabilities found` 并全部成功。

## 本轮新增或更新的主要判断

### 1. Node Matrix 不等于完整支持范围

根 `engines.node` 为：

```text
^20.19.0 || >=22.12.0
```

它除四个已测边界外，还接纳 Node 23、25、26 和未来 Major。Node 20、23、25 截至 2026-09-04 已 EOL；22/24 为 LTS，26 为 Current。#24 已改为明确 Production-supported、Tested 与 Legacy Node 策略，而不是继续把开放上界视为自动支持。

### 2. DeepSeek Harness 最新已是 0.1.3-alpha.1

新版本包含：

- Lifecycle-owned `SessionHandle`；
- 每 Session 跨实例/进程单写者锁；
- Session Format v2 与迁移；
- 出站请求遵循 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY` / `NO_PROXY`；
- 已知历史 Session 加载性能回退。

Headless 仍是一项任务一次 Invocation、最终输出后退出、无 Interactive Follow-up。Tekon 不应盲目追新升 Pin：近期 Headless 先完成 rc.1 Windows L2 与带凭据 L3；0.1.3 更适合作为 #14 ACP/SessionHandle Spike。

### 3. 显式 Trusted Proxy 是新产品边界

Tekon 正式 DSH Run 使用 Exact Env，当前不继承 Proxy。默认隐私合理，但企业代理环境不可用。#32 已要求显式代理配置、凭据脱敏、Provider Admission、Snapshot/Audit Evidence 和 Resume Recheck；禁止恢复整份 Ambient Env。

### 4. DSH Session Lock 不替代 Tekon Runtime Lock

上游 Lock 只保护一个 DSH Session 的持久写入，不保护 Tekon 的 Git、Worktree、Artifact、Gate、Audit、Delivery 和普通文件副作用。#16 的 Repo-level Single-owner Runtime 仍未关闭。

### 5. CommandGateway 局部修复不等于职责拆分

Abort Listener 泄漏和窄竞态已修；Timeout/Cancel State Machine、Activity Sampler、Process Termination Adapter 与 Log/Error Priority 仍由 #25 处理。

### 6. 测试与报告过度增长

四视口 Geometry Scanner 是有价值的 Overflow Smoke，但不应继续扩展成自建视觉引擎。第二十二轮只保留 Markdown 权威报告，不再生成新的 HTML/Closure Plan 镜像。

## 已关闭或基本关闭

- CLI Unit/E2E Lane、Corepack Shim、Fixture npm Warning 与四包版本 Lockstep；
- Production Dependency Audit 基础 Gate及一次有界 Endpoint 重试；
- Node 20.19/22.12/22.19/24 四个选定兼容边界；
- Session/Workspace Backward Cursor、Replay/Pending Budget、Heartbeat Backpressure 与 Truncation 提示；
- Session Right Rail Snapshot Fallback、审批事实层级与未知状态 Fail-closed；
- CommandGateway No-progress 边界误杀、Abort Listener 泄漏与 Spawn/Listener 窄窗口；
- DSH Host Node Fail-closed、Metadata Workspace、最小环境、Telemetry、Config/Help 顺序与 Cleanup；
- 默认/高级入口网络过强表述、Mock 身份、Admission Single-flight、重试与基础窄屏布局；
- 常驻 Opt-in DSH L2 绕过生产 Wrapper。

## 仍不能按“已关闭”表述的项目

- **#33 Clean Guard**：`project.clean` 仍可裸物理删除 Run Directory；
- **#29/#28 Provider Admission/Launcher**：Credential Health 混用、CLI Mutable Slot、Codex/Claude Preflight、Wrapper/Basename 与 Windows `.cmd` 未闭环；
- **#32/#17 DSH Evidence**：正式 Credential/Trusted Proxy/Internal Tool Evidence、Windows L2、Credentialed L3 与 Pin 裁决未完成；
- **#31/#22/#20 Run Contract**：原子/幂等 Admission、Exception Facts、Canonical RunPlan Authority 未完成；
- **#16/#15 Runtime**：Repo-level Single Owner、Process Isolation、Kill/Join、Restart Recovery 未完成；
- **#13/#14/#19 Collaboration**：Authoritative Session、Durable Inbox、ACP Persistent Stream、Follow-up/Cancel/Resume 与 Collaborate→Deliver 未完成；
- **#18 History/Lifecycle**：Complete Export、Model Compaction、Retention 与 Lifecycle-safe Purge 未完成；
- **#24 Governance**：Node Production Support Policy、Main Required Checks、SBOM/Provenance/Signing/Release Channel 未完成；
- **#21/#25/#26 Quality**：全站 A11y、多浏览器、真实设备、CommandGateway 拆分与 Semantic Lint 未完成；
- **PR 可审阅性**：当前 PR 已超过适合继续增长的规模，最终应 Squash Merge。

## 当前未闭环主链路

```text
暂停裸 project.clean
→ Request-scoped Provider Admission + Cross-platform Launcher
→ Credential/Capability/Proxy Evidence
→ Atomic/Idempotent Run Admission + Exception Facts
→ Canonical RunPlan Authority
→ Single-owner Runtime + Quiescent Restart
→ Authoritative Session / Durable Inbox
→ Persistent Provider Stream
→ Follow-up / Cancel / Resume
→ Collaborate → Deliver
→ Export / Compaction / Lifecycle-safe Retention
```

## 允许的成熟度表述

> Tekon v0.20.6 已形成测试覆盖较强、执行计划和风险边界较透明、Session 在线观察具有基础资源上限，并对四个选定 Node 边界保持持续兼容验证的实验性受控交付执行与观察基础设施。Deliver 轨道可在有人监督下使用，但持续协作、单一 Runtime 权威、权威 Session 事实链、原子且幂等的 Run Admission、跨平台 Provider Launcher、正式 Provider 凭据/代理/能力证据、可证明的 Shutdown/Restart、完整历史导出和模型上下文预算仍未闭环。

## 评审资料维护规则

- 本文件是唯一稳定入口；
- 第二十二轮 Markdown 是当前详细裁决；
- 第一至第二十一轮只读归档，不再追加新裁决；
- 不再生成当前报告的重复 HTML 或 Closure Plan 镜像；
- 普通问题在独立 Issue/PR 中关闭，只有产品或架构基线显著变化时新增完整报告；
- CHANGELOG 只记录用户可见行为，不复制 Reviewer 过程；
- 代码 Snapshot 与 `completed/success` 的 Core/CI Snapshot 必须成对更新；
- PR Head 若继续变化，必须重新绑定 CI 终态后才能复用“代码门通过”；
- PR #11 最终建议 Squash Merge；后续主线不再回填该超大分支。