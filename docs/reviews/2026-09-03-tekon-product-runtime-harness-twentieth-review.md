# Tekon 产品、UI/UX、Runtime 与 DeepSeek Harness 第二十轮全面复审

- **日期**：2026-09-03
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **上一轮权威报告 Head**：`618de86a5e187f1398b8f66676ebc16af43ef1a6`
- **用户 v0.20.5 整改 Head**：`dddc0a53be717b276eed80bdb58fe4bcb7095fa2`
- **Reviewer 行为修复 Head**：`b2bfa45a099047b8eec778b217c598a0727106cb`
- **产品版本**：`0.20.5`
- **Tekon DSH tested pin**：`0.1.2-alpha.3`
- **DeepSeek Harness 当前上游发布**：`0.1.2-rc.1`
- **rc.1 release tag commit**：`a66e4702047846cdaa10c66c9d3df3951f5ea70d`
- **用户整改自动化**：Core #416、CI #325 均为 `completed/success`
- **Reviewer 行为修复自动化**：Core #417、CI #326 均为 `completed/success`
- **裁决**：当前增量通过代码合并门；Tekon 整体仍未通过“面向普通人的稳定持续协作研发工作台”产品验收

## 1. 执行摘要

v0.20.5 对上一轮发现做了实质整改，重点包括：

1. DSH metadata preflight 也加入 telemetry hard opt-out；
2. Advanced Run 的提交准入抽成纯状态选择器，并加入同步单飞锁；
3. 从需求草案启动时补上 plan approval 门；
4. 390px / 700px 下的高级表单改为单列布局并缩短技术标签；
5. 将危险的 `project.clean` 收敛为独立问题 #33，而不是用不完整 active-job 检查宣称生命周期安全。

这些改动整体方向正确，且有 Core、Web unit 和 Chromium 端到端覆盖。但全仓复核仍发现三项可独立修复的遗漏：

- **DSH metadata probe 仍复制整个宿主环境**：外部 PATH 中的 `dsh` 会收到与 metadata 无关的 API key、云凭据、代理凭据、SSH agent、`NODE_OPTIONS` 和 npm 注入配置；
- **两个 metadata 命令并发访问同一个 DSH_HOME**：`--dump-default-config` 与 `--help` 都可能触发 shipped profile 首次初始化，并发执行会制造不必要的 first-use 写竞态；
- **同步单飞只覆盖 Advanced Run**：默认、人类优先的 Session Composer 仍只依赖异步 React mutation 状态，两个入口的准入保护继续漂移。

上述三项已在 `b2bfa45...` 中修复：metadata probe 改为最小环境、config/help 顺序执行，默认 Session Composer 增加同步 latch，并增加真实子进程和 Chromium 回归测试。Core #417 与 CI #326 首次执行均成功。

重新审查外部基线时还确认：DeepSeek Harness 已于 2026-09-03 发布 `0.1.2-rc.1`。alpha.5→rc.1 的 release-tag diff 只有 package 版本号变化，没有行为源码变化；但 Tekon 从 alpha.3 到 rc.1 仍跨越默认 `web_fetch`、长会话、ACP、凭据、telemetry 和存储语义等大量变化，因此不能仅凭“RC 版本”自动升 pin。真实 L2/L3 仍由 #17 承担。

最终结论不是整体通过：Deliver 受控交付轨道继续可用，持续协作、Runtime authority、Session truth、原子 admission、Provider evidence、完整历史与恢复语义仍未闭环。

## 2. 评审范围与证据边界

本轮复核了：

- `618de86...` 到 `dddc0a5...` 的全部增量；
- README、用户手册、CHANGELOG、当前权威报告与 v0.20.5 收口文档；
- 默认 Session Composer 与 Advanced StartRunForm 两套启动入口；
- Workflow plan/digest、draft approval、Provider/mode policy 和 `project.run`；
- DSH metadata preflight、正式 Run 环境、版本/Host Node/help/config/telemetry 合同；
- Session list/detail/right rail、SSE、历史预算与审批；
- WorkflowEngine、SessionService、Run admission、RunPlan、dual-write、JobRunner、CommandGateway；
- `project.clean`、Artifact/path 引用和历史生命周期；
- #13–#33 的问题边界、依赖顺序和是否存在流程/架构过度设计；
- DeepSeek Harness `0.1.2-rc.1` release、tag diff、Headless、CLI、base composition、credentials、ACP 与 Safety。

判断原则：

1. 只有具体 commit 的首次 `completed/success` 可以作为代码门证据；
2. UI disabled 状态不能代替组件同步锁或服务端幂等；
3. metadata probe 不应继承与探测无关的秘密和进程注入变量；
4. 计划声明、配置声明、Provider enforcement、Host enforcement、用户确认和 Audit 是不同事实；
5. 浏览器历史窗口不等于权威历史或模型上下文预算；
6. issue 已登记不等于问题已关闭；
7. 小而可逆的安全/UX 缺陷可以直接修复，公共协议、迁移和恢复语义必须拆独立 PR。

本轮没有可访问的独立 Tekon 部署实例，也没有真实 `dsh@0.1.2-rc.1`、API key、Firefox/WebKit 或屏幕阅读器环境。UI 结论来自源码、ARIA 结构、响应式 CSS 和现有 Chromium Playwright；不声称完成新的像素级视觉审计、真实辅助技术走查或 DSH L2/L3。

## 3. 自动化与代码门

### 3.1 用户 v0.20.5 整改 Head

`dddc0a53be717b276eed80bdb58fe4bcb7095fa2`：

- Core #416：success；
- CI #325：success；
- Root build/typecheck：success；
- production dependency audit：success；
- CLI build/unit/e2e：success；
- Web build/typecheck/unit：success；
- Chromium Playwright：success。

### 3.2 Reviewer 行为修复 Head

`b2bfa45a099047b8eec778b217c598a0727106cb`：

- Core #417：success；
- CI #326：success；
- 新增 metadata probe 最小环境/顺序测试通过；
- 默认 Session Composer 同步单飞 Chromium 测试通过；
- Root、Audit、CLI、Web unit 与原有 Playwright 全部成功。

因此，**v0.20.5 整改与本轮 reviewer 局部修复通过当前代码合并门**。

## 4. 对 v0.20.5 整改的逐项裁决

| 整改项 | 裁决 | 理由与边界 |
| --- | --- | --- |
| Advanced Run 纯 submit-state | 基本关闭 | token、plan loading/error、draft approval、digest、network acknowledgement 和 mutation pending 由纯函数统一判定，测试覆盖优先级。服务端仍无 request idempotency。 |
| Advanced Run 同步单飞 | 关闭当前组件缺陷 | `useRef` 在 mutation state 更新前锁住第二次激活；真实 Chromium 证明同 turn 只发一个 `project.run`。 |
| Draft plan approval 门 | 基本关闭 | `shapePath` 存在时，草案、需求批准、plan 存在与 planApproved 均进入准入。权威 RunPlan/admission transaction 仍未闭环。 |
| 390/700px 高级表单 | 基本关闭 | 选项、高级设置和操作按钮改为单列/全宽，有 Chromium viewport 覆盖；无真实设备、视觉快照和屏幕阅读器证据。 |
| Probe telemetry hard opt-out | 本轮补全后关闭直接缺陷 | 正式 Run 与 metadata probe 均固定 `DSH_TELEMETRY_DISABLED=1`；官方 `--help` 本身不运行任务，因此这是统一隐私默认与纵深防御，不应写成“help 必然启动 telemetry”。 |
| `project.clean` 独立化 | 问题边界通过，行为未关闭 | #33 正确拒绝用局部 job 检查冒充 lifecycle-safe；当前 API 仍可裸删目录，需独立 PR fail-closed。 |
| 产品代码收口文档 | 部分完成 | 正确记录 v0.20.5；但上游版本在同日已进入 rc.1，任何“当前发布基线 alpha.5”已过时。 |

## 5. 本轮 reviewer 直接修复

### 5.1 Metadata probe 改为最小环境

原实现：

```text
probe env = {...process.env}
→ 删除两个 telemetry 变量
→ DSH_TELEMETRY_DISABLED=1
```

这意味着任何通过 PATH 解析到的外部 `dsh` 都能看到：

- `DEEPSEEK_API_KEY`、`OPENAI_API_KEY`、`GH_TOKEN`；
- AWS/GCP/Azure 等云凭据；
- 含账号密码的 `HTTP_PROXY` / `HTTPS_PROXY`；
- `SSH_AUTH_SOCK`；
- `NODE_OPTIONS`、`NODE_PATH`；
- npm/pnpm registry token 和任意 `npm_config_*`；
- 与 metadata 检查无关的业务环境变量。

版本、Help 和默认组合检查不需要这些秘密。现在 built-in probe 只保留：

```text
PATH / 平台命令启动值
HOME / USERPROFILE / APPDATA
临时目录与 locale
SHELL / TERM / NO_COLOR
显式 DSH_HOME / DSH_AGENTS_HOME
DSH_TELEMETRY_DISABLED=1
```

API key、云凭据、代理凭据、SSH agent、Node/npm 注入和 ambient permission mode 均不进入 metadata 进程。

新增真实可执行文件测试会记录三次 probe 的环境，验证安全值存在、秘密与注入变量缺失、telemetry hard opt-out 不可被外层覆盖。

边界：这也意味着依赖企业代理或特殊动态链接环境的 DSH 安装可能被判 unavailable。后续应通过显式 Provider 配置建模受信代理/运行时值，而不是重新继承整个宿主环境。

### 5.2 避免同一 DSH_HOME 的 first-use 并发写

官方 CLI 合同说明 shipped profile 会在首次使用时自动初始化，`--dump-default-config` 也会初始化缺失的 profile 文件。原 preflight 在版本检查后并发执行：

```text
--profile headless --help
--profile headless --dump-default-config
```

两者共享同一 `DSH_HOME`，因此 clean home 下可能同时触发 profile 创建或读取半完成状态。

现在顺序为：

```text
--version
→ --dump-default-config + contract validation
→ --help + stdout anchor validation
```

新增测试让 config probe 在异步边界后才完成；Help 若提前启动就失败，从而锁定顺序合同。

代价是 health 路径的最坏等待时间从并行预算变为三个 probe 依次累计。`project.health` 仍把可选 DSH 探测与 credential health 耦合，这进一步说明 #29 应优先拆分，而不是继续压缩单次 timeout。

### 5.3 默认 Session Composer 加入同步单飞

v0.20.5 只给 Advanced Run 加入 `startInFlightRef`，默认的人类主入口仍只依赖：

```text
startMutation.isPending
```

React state 更新并不是服务端幂等保证；在同一 event-loop turn 的重复激活、脚本触发或辅助技术重复事件中，第二次调用可能发生在重渲染禁用按钮之前。

默认 Composer 现同样使用同步 latch：

```text
第一次激活
→ 立即 startInFlightRef=true
→ 调用 project.run
→ success/failure 后 finally 解锁
```

Chromium 测试故意让第一请求保持 800ms，并在第一次点击后移除 DOM `disabled` 再触发第二次点击；最终只观察到一次 `project.run`。

该修复只关闭两个当前组件的同进程重复激活，不替代服务端 request idempotency、原子 Run admission 或安全重试语义。

## 6. 产品逻辑评审

### 6.1 Deliver 轨道已经具备真实价值

当前可成立的主路径是：

```text
需求输入/草案
→ 需求与计划批准
→ 服务端 RunPlan + digest
→ standard-delivery 角色链
→ worktree 隔离
→ Gate / Artifact / Audit / Review
→ 人工审批
→ Delivery / PR 准备
```

正向评价：

- 默认入口明确叫“启动受控交付”，没有伪装成轻量聊天；
- Advanced Run 区分 Workflow、Goal、mock 和 dsh-headless；
- token、计划、digest、草案批准与网络确认均能 fail-closed；
- mock 被明确标记为合成执行，不能作为交付完成证据；
- dirty base、远端副作用与 dsh 不受限网络具有显式提示；
- README 对非真实 streaming、无 follow-up、best-effort Event 和单 Workspace 有诚实披露；
- Gate、Artifact、Audit、Readiness、Delivery 和 worktree 已形成可监督的工程工作流。

因此 Tekon 已经不再是只能由 Agent 自举的内部框架，而是一套工程用户可监督使用的受控执行与证据工作台。

### 6.2 Collaborate 仍未形成

普通用户仍不能在同一 Session 中完成：

```text
继续输入
→ Provider execution-time semantic updates
→ follow-up / steer
→ prompt-owned cancel
→ Runtime 重启后恢复
→ 在同一上下文升级为 Deliver
```

`LegacyAgentDriver.events()` 仍等待 one-shot Adapter 完成后再输出缓存；`followUp()`、`steer()`、`resume()` 仍未实现。当前 Session 的真实角色仍是：

- Run 观察面；
- 审批面；
- 治理证据面；
- 结果与历史投影面。

这与 README 的边界披露一致，但也意味着整体产品验收不能通过。

### 6.3 两个启动入口仍构成产品债务

默认 Session Composer 与 Advanced StartRunForm 仍分别维护：

- 计划查询和 digest；
- 提交准入；
- 同步单飞；
- 错误/加载状态；
- 风险披露；
- mutation 与跳转。

本轮已经出现“Advanced 有 latch、默认入口没有”的第二次漂移。后续应共享一个小而明确的：

```text
RunAdmissionState
+ useRunSubmission single-flight
+ RunPlanDisclosure
```

不建议构建大型通用表单框架；只抽取可证明已经重复、且具有安全语义的状态机。

## 7. UI 实现与 UX 评审

### 7.1 当前改善

- Advanced 表单在窄屏下单列排列；
- 长技术标签有短文本/完整 title；
- 草案批准与计划摘要的禁用原因可见；
- 默认与高级入口都在计划不可用时阻止启动；
- mock 和 dsh 风险边界清楚；
- Session 右栏有 snapshot fallback，未知状态 fail-closed；
- 历史具有 backward cursor、窗口、replay/pending budget 与截断提示；
- 配置 dialog 与顶栏 Provider 状态已有局部可访问性修复。

### 7.2 仍需改善

1. **凭据健康被可选 Provider 拖慢**  
   `project.health` 在 token 有效后依次等待 version/config/help。当前每项 health timeout 为 1 秒，最坏可接近 3 秒，普通“连接凭据是否有效”不应等待可选 Provider。

2. **Provider 诊断仍为二值**  
   服务端知道 Host、版本、Config、Help、进程和 timeout 差异，TopBar 仍只显示 available/unavailable。

3. **完整历史没有行动入口**  
   截断提示后只能分页，没有“导出完整 Session/证据包”。

4. **Admission 失败后的重试语义不清**  
   API 报错时用户无法知道是否已留下 Demand、Run、Plan、Audit、Session 或 Job 半成品。

5. **工程术语仍偏多**  
   Session、Run、Gate、Artifact、Profile、Provider、Token 等概念仍进入默认路径。

6. **辅助技术证据局部**  
   当前只有 Chromium 和少数 ARIA 断言，不能外推为 NVDA、JAWS、VoiceOver、Firefox、WebKit、200%/400% 缩放、forced-colors、reduced-motion 已通过。

7. **没有新的视觉走查证据**  
   本轮无法访问独立部署并截图，因此 390/700px 结论是布局代码和 Chromium 行为合同，不是像素级/真实设备验收。

## 8. Runtime 与整体架构评审

### 8.1 P0：repo 级 single-owner Runtime 仍缺失

CLI 与 Web 仍可分别拥有：

```text
SQLite / WriteQueue / repositories
Session store / EventBus
JobRunner / SubprocessRegistry
Workflow / Automation executor
Git / worktree / Provider
shutdown 生命周期
```

Job owner、lease、CAS 和进程内 generation token 不能完整 fence 普通文件、Git promotion、Artifact、Gate、Audit、Delivery 与外部 SDK 副作用。

长期方向仍应是：

```text
repo-scoped daemon/service
→ physical repo lock
→ CLI/Web 客户端化
→ 单一 admission/execution/shutdown authority
```

### 8.2 P0：Shutdown 仍不能证明 quiescent

当前 stop 有 poll drain、settle window、AbortController、registered subprocess kill、hard deadline 与 DB fence。但 deadline 返回时，不合作 executor 仍可能继续：

- 执行 JavaScript；
- 写普通文件；
- 操作 Git；
- 停留在外部 SDK；
- 持有未登记子进程。

完整闭环需要 worker/process 隔离、真实 kill/join、generation fencing、checkpoint/flush 与 crash/restart/late-write 故障注入。

### 8.3 P0：Session Event 仍是 best-effort projection

当前事实关系仍是：

```text
领域表 / Audit 先成功
→ best-effort append session_event
→ 找不到 Session 或失败时允许跳过
```

它适合 UI projection，不能独立承担 durable inbox、权威模型历史、prompt claim/processed、crash replay、fork/resume 与 restart recovery。

必须明确选择：

```text
A. authoritative append-only Session log + projections
B. 领域事实 / transactional outbox 为权威，Session 是可重建投影
```

### 8.4 P1：Run admission 非原子且无幂等键

启动跨越：

```text
Demand
→ Project
→ Run
→ Provider snapshot
→ ExecutionPlan
→ Audit
→ Workspace
→ Session
→ opening Events
→ Job
```

没有统一事务、outbox 或 admission saga。组件 latch 只能防同一页面的即时重复，不能处理：

- 客户端超时重试；
- 浏览器刷新；
- 代理重放；
- 两个客户端同时发起；
- 中间持久化失败。

#31 仍是当前 Deliver 稳定性最重要的独立问题之一。

### 8.5 P1：RunPlan 仍不是 execute/resume 唯一事实

尚未完整绑定：

- Demand identity/version/body hash；
- mode；
- base revision；
- workspace physical identity；
- resolved Provider executable/config；
- credential/capability evidence；
- permission/network acknowledgement；
- expected Artifacts；
- executable node plan。

顶层 `SessionServiceStartRunInput.planDigest` 仍未接线，Project/Workspace identity 仍重复，执行/恢复仍从多个 snapshot 与表行重新拼装事实。

### 8.6 P1：`project.clean` 仍是危险的裸文件删除

当前 endpoint 在认证、确认字面量、runId 和 scope 检查后直接删除 `.tekon/runs/<runId>`，未协调 active Job、SubprocessRegistry、worktree lease、Automation、Audit/tombstone 和数据库 path 引用。

#33 选择“完整方案前先全部 fail-closed”是正确的短期方向；在其落地前，该 endpoint 不能称为 lifecycle-safe。

## 9. DeepSeek Harness 0.1.2-rc.1 对齐

### 9.1 当前版本事实

```text
Tekon tested pin = 0.1.2-alpha.3
upstream latest release = 0.1.2-rc.1
rc.1 tag commit = a66e4702047846cdaa10c66c9d3df3951f5ea70d
```

alpha.5→rc.1 的 tag diff 只有 package 版本号变化，因此当前 Headless one-shot、Help、Config row、Node engine、默认 web_fetch、credentials 与 telemetry 行为延续 alpha.5。

但 alpha.3→rc.1 横跨大量上游变化，不能用 alpha.5→rc.1 的小 diff证明 Tekon 已兼容 rc.1。#17 已更新为 rc.1 L1/L2/L3。

### 9.2 Headless 继续保持 Goal-only

官方 rc.1 Headless 仍明确：

```text
one task per invocation
→ reasoning deltas to stderr
→ wait for quiescence and flush
→ final assistant text to stdout
→ exit
```

没有 interactive follow-up。因此 Tekon 继续将 `dsh-headless` 限制在 Goal/one-shot 是正确的，不能把最终 stdout 包装成持续协作。

### 9.3 默认网络与凭据边界

0.1.2 系列默认向 Headless 提供 public `web_fetch`，且不逐次 approval；凭据仍可来自 launch env、DSH credential store、worktree `.env` 和 DSH home `.env`。

本轮最小 probe env 修复只防 metadata 命令拿到无关秘密；正式 Run 的 credential provenance、代理配置、worktree `.env` 和内部 tool enforcement 仍由 #32 处理。

### 9.4 ACP 仍是 Collaborate 首选验证面

rc.1 汇总的 ACP 能力包括标准 Session 控制、模型设置、MCP、权限和取消。建议仍是独立 vertical slice：

```text
owned ACP subprocess
→ session/new
→ prompt
→ execution-time updates
→ prompt cancel
→ quiescent close
→ process restart + session/resume
```

不要把 ACP 强塞进 one-shot `AgentAdapter`；先证明生命周期、事件、权限和恢复，再设计 Tekon 映射。

### 9.5 Safety

官方 rc.1 仍明确更新安全说明：Harness 未完成安全审计，sandbox、approval 与 permission controls 不能保证隔离。Tekon 仍需要 host/container boundary、least privilege、credential minimization、网络策略、人工 gate 和审计，不能把上游配置行当作唯一安全控制。

## 10. 代码实现与测试质量

### 正向评价

- v0.20.5 将 Advanced submit state 抽成纯函数，适合穷举优先级；
- 两个启动组件现在都有同步单飞保护；
- metadata probe 有真实子进程环境断言，而不是只测试 helper 返回对象；
- Core、CLI、Web unit 和 Chromium 均绑定同一行为快照成功；
- DSH 版本、Host Node、Help、Config 与 telemetry 边界已有分层测试；
- SSE cursor/backpressure、Session fallback、Gate/Artifact/Audit 等关键路径已有较多回归覆盖。

### 仍需收敛

1. 默认与 Advanced 的启动状态机仍重复；
2. `project.health` 同时承担 credential 和 Provider capability；
3. `CommandGateway` 仍聚合 policy、spawn、redaction、filesystem activity、timeout、signal 与 settlement；
4. Provider capability mapping 仍偏声明，调用方主要只用“是否抛错”；
5. DSH fake fixture、metadata、L2/L3 仍未形成统一真实安装测试；
6. 当前 CI 只有 Chromium，Node support matrix 与 Windows/macOS Provider 行为证据有限；
7. 根 README 的开发命令仍使用 `npx pnpm`，与 CI 的 Corepack/pinned-pnpm 合同存在轻微文档漂移，建议后续工程治理 PR 一并修正，而不是继续增加本 PR 提交。

## 11. 是否存在过度实现或过度设计

存在，主要体现为**横向机制和评审过程增长快于纵向用户闭环**，而不是某一个抽象本身完全没有价值。

当前已有：

```text
AgentAdapter / AgentDriver / LegacyAgentDriver
Provider Registry / capability declaration
Workflow / Role / Gate / Artifact / Audit
JobRunner / Session projection / SSE
Profile / Automation / Goal / Readiness / Delivery
CLI / Web 两套 composition root
默认 Composer + Advanced Run 两套 admission UI
大量阶段计划、ADR、报告和 issue
```

但最小持续协作链路仍未完成。

需要冻结的方向：

- 新 Profile；
- 新 Automation job；
- 新 Driver wrapper；
- 新展示 Event；
- 新 Workflow DSL；
- 继续为 PR #11 追加无关治理文档。

只有直接服务以下链路的工作才应优先：

```text
single-owner Runtime
→ quiescent executor/restart
→ request-scoped Provider admission
→ credential/capability evidence
→ atomic Run admission
→ canonical RunPlan authority
→ authoritative Session/durable inbox
→ persistent Provider stream
→ follow-up/cancel/resume
→ Collaborate → Deliver
→ export/compaction/lifecycle retention
```

局部抽取也应保持克制：本轮建议共享一个小型 Run submission hook，而不是建立新的通用表单/工作流状态框架。

## 12. 当前问题清单

| ID | 严重度 | 状态 | 问题 |
| --- | --- | --- | --- |
| #16 | P0 | 未关闭 | repo 级 single-owner Runtime / physical lock。 |
| #15 | P0 | 部分完成 | abort/kill/deadline/DB fence 不等于 quiescent executor 与 restart。 |
| #13 | P0 | 未关闭 | authoritative Session / outbox / durable inbox。 |
| #14/#19 | P0 | 未关闭 | 真实 streaming、follow-up/steer/cancel/resume 与 Collaborate→Deliver。 |
| #31 | P1 | 未关闭 | Run admission 原子性、幂等与失败补偿。 |
| #22 | P1 | 未关闭 | Provider exception acknowledgement、Snapshot 与 Audit。 |
| #20 | P1 | 部分完成 | RunPlan 尚未成为 admission/execute/resume authority。 |
| #28 | P1 | 未关闭 | Provider command identity、framing 与 preflight。 |
| #29 | P1 | 未关闭 | Credential health、Provider health 与 request-scoped admission 解耦。 |
| #32 | P1 | 部分完成 | probe secret/telemetry/竞态已修；credential provenance、probe home 与 enforcement evidence 仍缺。 |
| #18/#33 | P1 | 未关闭 | complete export、compaction、retention 与 lifecycle-safe purge；短期 clean fail-closed。 |
| #17 | P1 | 部分完成 | rc.1 L1 已复核；真实 L2/L3 未完成。 |
| #21 | P1 | 未关闭 | 全站 a11y、多浏览器、缩放和弱网验收。 |
| #25/#26 | P2 | 未关闭 | CommandGateway 拆分、真实 semantic lint 与 format debt。 |
| #24 | P1 | 未关闭 | required checks、SBOM/provenance、签名和 release channel。 |
| Run UI duplication | P2 | 部分完成 | 两个入口均已 fail-closed/单飞，但状态和披露实现仍重复。 |
| PR scale | P1 | 未关闭 | 超大 PR 降低人工审阅、二分、迁移和回滚质量。 |

## 13. 建议实施顺序

1. **合并 PR #11 后停止继续回填**  
   使用 squash merge；以 #27 作为轻量索引。

2. **#33：立即关闭裸 `project.clean`**  
   完整生命周期前先全量 fail-closed，避免活动期和证据目录误删。

3. **#16 + #15：single-owner Runtime 与 executor 隔离**  
   repo lock、daemon、process/worker、kill/join、checkpoint、restart。

4. **#29 + #28 + #32：Provider admission/evidence**  
   快速 credential health、结构化 Provider health、command identity、最小环境、probe home、凭据来源和 enforcement evidence。

5. **#31 + #22 + #20：原子 admission 与 canonical RunPlan**  
   request idempotency、transaction/outbox 或 saga、确认事实、snapshot 与 execute/resume 同构。

6. **#13：authoritative Session / durable inbox**  
   先明确事实源，再叠加持续协作。

7. **#17 + #14：真实 rc.1 与 ACP vertical slice**  
   L2/L3 Headless，随后 ACP persistent session/cancel/resume。

8. **#19：Collaborate → Deliver**  
   同一 Session 的 follow-up/steer、计划升级和人工控制点。

9. **#18：完整导出、模型 compaction 和生命周期**  
   streaming archive、flush/snapshot、manifest、retention、purge/tombstone。

10. **#21/#24/#25/#26：质量与发布工程**  
    a11y/multibrowser、required checks、供应链、lint/format、CommandGateway 拆分。

## 14. 合并与发布边界

本轮代码门通过可以证明：

- v0.20.5 的 Advanced admission、draft approval 与移动布局在现有测试合同下成立；
- metadata probe 不再把常见秘密和进程注入值交给外部二进制；
- metadata config/help 不再并发初始化同一 DSH_HOME；
- 默认与 Advanced 当前入口都具有同步单飞保护；
- 当前代码可构建、类型正确，并通过 Core、CLI、Web unit 与 Chromium。

它不能证明：

- 两个客户端或网络重试不会创建重复/半成品 Run；
- Web/CLI multi-owner 不会产生 Git/文件副作用冲突；
- shutdown 后所有 executor/SDK/Git 活动都已终止；
- Session Event 可完整恢复模型历史；
- DSH rc.1 已通过真实安装和模型调用；
- worktree `.env` 不会提供额外凭据；
- DSH 内部工具 obey Tekon allow/deny 声明；
- 完整历史、模型 compaction 和安全 purge 已完成；
- Firefox/WebKit/屏幕阅读器/真实设备已经验收。

PR #11 已远超适合继续增长的规模。最终建议 squash merge，后续所有主问题使用独立小 PR，不再创建下一轮“大一统整改”回填该分支。

本轮未执行 merge、release、deploy 或仓库 ruleset 修改。

## 15. 参考资料

### Tekon

- [当前权威入口](current.md)
- [第十九轮报告](2026-09-03-tekon-product-runtime-harness-nineteenth-review.md)
- [Runtime authority ADR](../technical/adr-0001-runtime-authority-and-collaborate.md)
- [README](../../README.md)
- [DSH metadata preflight](../../packages/core/src/runtime/dsh-bridge-probe.ts)
- [DSH Headless Adapter](../../packages/core/src/runtime/dsh-headless-adapter.ts)
- [默认 Session Composer](../../packages/web/src/client/components/sessions/SessionComposer.tsx)
- [Advanced StartRunForm](../../packages/web/src/client/components/runs/StartRunForm.tsx)
- [Advanced submit state](../../packages/web/src/client/components/runs/start-run-submit-state.ts)
- [Project Router](../../packages/web/src/server/api/routers/project.ts)
- [SessionService](../../packages/core/src/session/session-service.ts)
- [WorkflowEngine](../../packages/core/src/workflow/engine.ts)
- [RunPlan](../../packages/core/src/workflow/run-plan.ts)
- [主线 Tracking #27](https://github.com/zesming/tekon/issues/27)
- [DSH rc.1 验证 #17](https://github.com/zesming/tekon/issues/17)
- [DSH environment/evidence #32](https://github.com/zesming/tekon/issues/32)
- [Clean guard #33](https://github.com/zesming/tekon/issues/33)

### DeepSeek Harness 官方

- [dsh v0.1.2-rc.1 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-rc.1)
- [rc.1 Headless](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/bundle/headless/README.md)
- [rc.1 CLI behavior](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/apps/cli/reference/README.md)
- [rc.1 Node engines](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/package.json)
- [rc.1 ACP](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/acp/acp/README.md)
- [rc.1 Safety](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/SAFETY.md)
- [rc.1 credentials-local](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-rc.1/packages/credentials/credentials-local/README.md)
