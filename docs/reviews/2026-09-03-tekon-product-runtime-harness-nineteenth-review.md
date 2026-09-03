# Tekon 产品、UI/UX、Runtime 与 DeepSeek Harness 第十九轮全面复审

- **日期**：2026-09-03
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **上一轮权威 Head**：`62f7c6ba2a0c12e6ad6a0ce2be6dca026cf96840`
- **用户本轮整改 Head**：`b3167c52ee80f492c1d11ea9f5cd25a3193cc1c2`
- **Reviewer 行为修复快照**：`7acfbae438dbef46befe4d7bab46b844720b80ef`
- **第十九轮报告权威发布**：`618de86a5e187f1398b8f66676ebc16af43ef1a6`
- **主 Agent 收口快照**：`0ad721d4058e8155f646313d00779134f4da0aec`
- **收口版本**：`0.20.5`
- **产品版本**：`0.20.5`
- **Tekon DSH tested pin**：`0.1.2-alpha.3`
- **DeepSeek Harness 上游发布基线**：`0.1.2-alpha.5`
- **用户整改自动化**：Core #411、CI #320 均为 `completed/success`
- **Reviewer 修复自动化**：Core #412、CI #321 均为 `completed/success`
- **主 Agent 收口自动化**：Core run [33723748836](https://github.com/zesming/tekon/actions/runs/33723748836)、CI run [33723748858](https://github.com/zesming/tekon/actions/runs/33723748858) 均为 `completed/success`（7 checks 全 pass）
- **最终裁决**：当前增量通过代码合并门；Tekon 整体仍未通过“面向普通人的稳定持续协作研发工作台”产品验收

## 1. 执行摘要

用户本轮增量没有产品行为代码变化，只向第十八轮报告追加了评估批注，并把 DeepSeek Harness 上游基线更新到 alpha.5。该增量本身没有引入回归，当前 Head 的 Core、Root、production dependency audit、CLI、Web unit 和 Chromium Playwright 均成功。

批注对以下事实的判断基本准确：

- `SessionServiceStartRunInput.planDigest` 是公开但未接线的参数；
- CLI Provider preflight 通过外层 `activeAgent` 可变槽传递本次 Provider；
- 每 Run 一个 Project 与每物理仓库一个 Workspace 构成重复身份模型；
- DSH 默认配置硬编码网络 acknowledgement，而 Web/CLI 已知入口另有前置确认。

需要收窄的一点是：alpha.5 release tag 与当前 master 并不是同一个 commit。alpha.5 的 tag commit 是 `db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5`；`49a606bc5b5934603f22a26957a07dc799ab0291` 是随后同步到 master 的 merge commit。后续 L1/L2 fixture 应绑定 release tag，而不是把 master SHA 当作 tag identity。

重新从完整产品路径反向审查后，本轮确认并处理了四类问题：

1. **Advanced Run UI 仍把计划声明写成宿主隔离保证**：`网络受控隔离` 与实际合同不符，也与默认 Session Composer 已修正的文案矛盾；
2. **Advanced Run 提交门不完整**：无 token、计划仍在加载、workflow plan 缺 digest 时，按钮没有一致 fail-closed；
3. **mock Provider 在生产表单中像真实执行器**：它会生成合成结果和通过产物，却只显示为 `mock`；
4. **DSH 子进程没有明确关闭上游 telemetry**：exact env 会过滤大部分 ambient 配置，但此前既没有 hard opt-out，也没有测试固定该隐私边界。

上述四项的首轮修复方向已在 `7acfbae...` 中落地，并由 Core #412 / CI #321 首次执行全部通过；其中 Advanced Run 提交门经主 Agent 复核后仍有缺口，最终由 `0ad721d...` 补全，详见 §18.1。

同时新增或扩大了两个不能用局部补丁闭环的问题：

- **#32 DSH environment/evidence**：exact child env 不会阻止 DSH 从工作树 `.env` 解析凭据；`permissionProfile.tools` 也没有映射成 DSH 内部工具控制；
- **#18 Session lifecycle**：`project.clean` 可直接删除 Run 目录，但不检查 active Job、不写 Audit、不处理数据库中的 Artifact/path 引用。

因此，本轮结论不是“无问题通过”。当前 PR 的代码增量可以 squash merge；整体产品仍应定位为实验性受控交付执行与观察基础设施。

## 2. 评审范围与方法

本轮覆盖：

- PR #11 最新 Head、上一权威 Head 之后的 diff 和 Actions；
- README、用户手册、CHANGELOG、`docs/reviews/current.md` 与第十八轮报告最新批注；
- Web 默认 Session Composer、高级 StartRunForm、TopBar、Session list/detail/right rail、历史和审批；
- Core WorkflowEngine、SessionService、RunPlan、Provider Registry、AgentAdapter、Codex/Claude/DSH、JobRunner、dual-write、CommandGateway；
- CLI run/resume、Session composition root、Provider preflight；
- Run admission、Provider acknowledgement、Project/Workspace identity、清理与历史生命周期；
- #13–#32 的问题边界和重复/过度拆分风险；
- DeepSeek Harness alpha.5 release、alpha.4→alpha.5 diff、Headless、base composition、credential store、telemetry 和 Safety。

判断原则：

1. 绿色结论必须绑定具体 commit 的首次 `completed/success`，不能借用上一 Head；
2. capability declaration、实际 enforcement、compatibility、bypass、acknowledgement、credential source、snapshot 与 Audit 是不同事实；
3. 计划未请求能力不等于 Host 已实施隔离；
4. synthetic Provider 结果不能在 UI 中伪装成真实交付证据；
5. 删除文件目录不等于完成数据生命周期清理；
6. 公共参数、注释和 UI 承诺必须参与真实数据流；
7. 小而可逆的误导/隐私默认值可以直接修复；公共协议、迁移、恢复和事务语义必须拆独立 PR；
8. issue 数量、评审轮数和项目管理元数据不是产品成熟度。

本轮没有可访问的独立 Tekon 部署，也没有真实 alpha.5 二进制、API key、Firefox/WebKit 或屏幕阅读器环境。UI 结论来自源码、ARIA 结构和现有 Chromium Playwright；DSH L2/L3 仍未完成。

## 3. 自动化与代码门

### 3.1 用户整改 Head

`b3167c52ee80f492c1d11ea9f5cd25a3193cc1c2`：

- Core #411：success；
- CI #320：success；
- Root build/typecheck：success；
- production dependency audit：success；
- CLI build/unit/e2e：success；
- Web build/typecheck/unit：success；
- Chromium Playwright：success。

用户批注中写到的本地 `pnpm test` 数量，本轮没有在同一机器上独立复现；合并判断使用可验证的 Actions 结果。

### 3.2 Reviewer 修复 Head

`7acfbae438dbef46befe4d7bab46b844720b80ef`：

- Core #412：success；
- CI #321：success；
- 新增 DSH telemetry exact-env 测试通过；
- 修改后的 Advanced Run Chromium 用例通过；
- Root、Audit、CLI、Web unit/e2e 均成功。

因此，**本轮增量通过当前代码合并门**。

## 4. 对用户最新批注的裁决

| 项目 | 裁决 | 理由与边界 |
| --- | --- | --- |
| `planDigest` 死参数 | 通过 | 顶层字段确实未被 `SessionService.startRun()` 读取；主入口依靠未展开的 engine input 中第二份同类数据生效。 |
| CLI `activeAgent` mutable slot | 通过 | 单 CLI 命令通常串行，当前事故概率有限，但公共编排接口无法证明本次 preflight 对应本次 Provider。 |
| Project/Workspace 双重身份 | 通过 | Workflow 每 Run 新建 Project，Session 按物理 repo 复用 Workspace，领域身份重复。 |
| DSH 默认 network ack | “风险面收窄”判断通过 | Web/CLI 已知入口有前置确认；Core 与未来调用方、snapshot/resume 路径以及 `onPrepared` 非原子窗口的风险仍真实存在。 |
| alpha.5 已发布 | 通过 | 2026-09-02 已发布。 |
| alpha.5 `HEAD=49a606...` | 需修正 | `49a606...` 是 master release-sync merge；tag commit 为 `db6bdc...`。 |
| “合同锚点零漂移” | 部分通过 | alpha.4→alpha.5 的当前 Headless metadata 锚点未观察到漂移；alpha.3→alpha.5 仍包含默认 `web_fetch` 变化，且 L2/L3 未验证。 |

## 5. 本轮直接修复

### 5.1 Advanced Run 网络文案恢复真实性

原高级表单在 `requiresUnrestrictedNetwork=false` 时显示绿色：

```text
网络受控隔离
```

但该字段只表示 canonical plan 没有声明需要不受限网络，不能证明：

- Provider sandbox 已执行网络隔离；
- 通用解释器、自定义二进制不能联网；
- Host/container firewall 已生效；
- 当前工作负载没有其它 egress 路径。

这也与默认 Session Composer 的正确文案发生漂移。

现在改为：

```text
计划未请求不受限网络
```

并补充：

> 此处只表示计划未声明不受限网络；实际网络隔离仍取决于 Provider 与宿主环境。

Playwright 同时增加反向断言，确保 `网络受控隔离` 不再出现。

### 5.2 Advanced Run 提交状态 fail-closed

原 `isSubmitDisabled` 没有完整包含：

- `!token`；
- `planLoading`；
- workflow plan 已返回但缺少 digest。

这会让高级入口与默认 Composer 出现不同的启动语义：用户可以点击后才收到 token 警告，或在计划切换窗口中发送旧/不完整数据，最终依赖服务端 400 兜底。

现在：

```text
无 token
或计划加载中
或计划失败
或 workflow digest 缺失
或需要网络确认但未确认
→ 按钮禁用 + 可行动提示
```

`handleStart()` 仍保留防御式检查，避免程序化触发绕开 UI disabled 状态。以上是 `7acfbae...` 的首轮修复；主 Agent 后续在 `0ad721d...` 中补齐统一状态选择器、同步防重入 latch 和未批准草案门禁，详见 §18.1。

### 5.3 mock Provider 不再伪装成真实执行

`mock-agent-adapter.ts` 会生成确定性的合成产物，其中多项 Gate 状态为通过；它适合测试和离线演示，但不执行真实 Agent。

高级表单原来只显示：

```text
mock
```

普通用户可能把合成 Run、Artifact 或 Gate 结果误认为真实工作完成。

现在 option 和选中后的提示明确说明：

```text
仅测试/演示
生成合成结果与产物
不执行真实代理任务
不能作为交付完成证据
```

长期更好的产品形态是把它移动到显式 Simulation/Developer mode，而不是永久与生产 Provider 并列；本轮先关闭无提示误用。

### 5.4 DSH telemetry hard opt-out

DeepSeek Harness alpha.3 与 alpha.5 的 base composition 都挂载 session telemetry，默认是 feedback-gated；`DSH_TELEMETRY_MODE=FULL` 还可启用完整事件流。Tekon Headless 没有可见的 `/feedback` 交互，也没有 telemetry consent 产品模型。

原 exact env 不会转发大多数 `DSH_*` 变量，但也没有明确设置官方 hard opt-out。现在 child env 固定：

```text
DSH_TELEMETRY_DISABLED=1
```

并明确不继承 ambient：

```text
DSH_TELEMETRY_MODE
DSH_TELEMETRY_OTLP_URL
```

新增测试在外层故意设置 `FULL` 和自定义 endpoint，验证传给 DSH 的 exact env 仍只有 hard opt-out。

这项修复只关闭正式 Run 的 telemetry 默认值；它不解决 DSH 自身的凭据 fallback、网络能力或内部工具控制。metadata probe 阶段的残留缺口及后续补全见 §18.1。

## 6. 新发现：DSH 环境与能力证据仍不完整

### 6.1 exact env 不等于唯一凭据来源

官方 DSH 凭据优先级为：

```text
launch environment
→ $DSH_HOME/.credentials.yaml
→ invocation cwd/.env
→ $DSH_HOME/.env
```

Tekon 将 `cwd` 设为 worktree，将 `DSH_HOME` 设为每 run/node 的新目录。新的 Home 可以减少跨 Run profile/session 污染，但工作树根目录 `.env` 仍然是 DSH 的合法 fallback。

因此：

```text
child env 中没有 DEEPSEEK_API_KEY
```

不能推出：

```text
DSH 没有得到 API key
```

更不能推出凭据来自本次用户显式输入。当前 snapshot、Audit、health 与 UI 无法区分 process env、worktree `.env`、local credential store 或缺失凭据。

官方也明确说明 DSH 的本地 credential store 与 Agent 工具进程使用同一 OS 用户；owner-only 文件权限是谨慎隐藏，不是 Agent 与密钥之间的安全边界。

### 6.2 DSH tool allow/deny 尚未形成 enforcement

Tekon DSH 默认 permission profile 写入：

```text
allow: git, npm, pnpm
deny: rm, sudo, git push --force
```

但外层 CommandGateway 只看到并约束 `dsh --profile headless <task>` 这一启动命令。它不能直接审查 DSH 内部的 bash/filesystem/tool 调用；当前代码也没有把这组 allow/deny 转换成 DSH bundle/plugin 配置。

`assertAgentProviderCapabilities()` 因而主要验证“配置声明看起来有边界”，而不是证明每项边界由 Provider 或 OS 执行。其返回的 `ProviderCapabilityMapping` 目前也没有被调用方持久化为可验证证据。

结论：

- DSH 的 filesystem sandbox/approval 可以按官方机制描述；
- network 应继续描述为 enabled/unrestricted；
- 未映射的 tool allow/deny 不能进入“已执行控制”成熟度表述。

已创建 [#32](https://github.com/zesming/tekon/issues/32)，要求统一 credential provenance、telemetry policy 和 `declared / provider-enforced / os-enforced` capability evidence。

## 7. 新发现：`project.clean` 不是生命周期安全的清理

Web `project.clean` 当前完成 token、确认字符串、runId 格式与 scope 校验后，直接执行：

```text
rm -rf .tekon/runs/<runId>
```

它没有：

- 拒绝 non-terminal Run 或 active Job；
- 与 JobRunner/SubprocessRegistry 协调；
- 写入 Audit 或 durable tombstone；
- 删除/修正数据库中的 Artifact、Gate、Delivery、Session 路径引用；
- 在清理前提供完整导出；
- 对文件删除与数据库变更做事务/saga 或失败恢复。

可能后果：

1. Provider 仍在写目录时，API 把目录删除；
2. 数据库仍显示 Artifact/证据存在，但点击路径已经消失；
3. Audit UI 看起来完整，实际底层文件已经被破坏；
4. 重复 clean、部分删除或进程重启后的状态没有统一语义。

固定确认字面量只能减少误点，不能保证生命周期一致性。

入口防误删已拆为独立 [#33](https://github.com/zesming/tekon/issues/33)，完整导出、retention、compaction 与 lifecycle-safe purge 继续由 [#18](https://github.com/zesming/tekon/issues/18) 统一处理；范围说明见 §18.3。

## 8. 产品逻辑评审

### 8.1 Deliver 轨道具有实际价值

当前真正成立的产品链路仍是：

```text
需求输入
→ 服务端 RunPlan 与 digest
→ standard-delivery 角色链
→ 隔离 worktree
→ Gate / Artifact / Audit / Review
→ 人工审批
→ Delivery / PR 准备
```

成立的关键点：

- 默认入口明确为“启动受控交付”，不再伪装成普通聊天；
- plan/digest/token/必要确认缺失时主路径 fail-closed；
- dirty base、网络例外和远端副作用有明确提示；
- Goal 与 Workflow/Deliver 边界清楚；
- Session 列表、观察、审批和控制具有可用路径；
- 历史 cursor、replay/pending budget、heartbeat backpressure 与截断提示基本成立；
- Session right rail 可以用快照兜底 best-effort Event；
- 未知状态不会被虚构为 running。

因此 Tekon 已经不是只能由 Agent 自举的内部框架，而是一套工程用户可以监督使用的受控执行与证据工作台。

### 8.2 Collaborate 轨道仍不存在

用户仍不能在同一 Session 中完成：

```text
持续输入
→ Provider execution-time semantic updates
→ follow-up / steer
→ prompt-owned cancel
→ Runtime 重启后恢复
→ 原地升级为 Deliver
```

Legacy driver 仍等待 one-shot adapter 完整结束后再投影缓存事件；`followUp`、`steer`、`resume` 尚未实现。

所以当前 Session 的真实角色仍是：

- Run 观察面；
- 审批面；
- 治理证据面；
- 结果与历史投影面。

它不是稳定的多轮研发协作空间。

## 9. UI 与 UX 评审

### 9.1 本轮关闭或改善

- 默认 Composer 与 Advanced Run 的网络文案恢复一致；
- Advanced Run 的 token/plan/digest loading gate 更完整；
- mock 不再无提示进入真实执行器列表；
- DSH experimental、Goal-only 和不受限网络仍明确；
- 现有 TopBar accessible description、Dialog 焦点管理、Session snapshot fallback 继续成立。

### 9.2 仍未关闭

1. **两个启动入口仍容易再次漂移**  
   默认 Session Composer 和 Advanced StartRunForm 分别实现计划加载、网络语义、digest gate 与错误呈现。本轮的“网络受控隔离”回归正是重复 UI 状态机导致回归的证据。后续应共享 `RunPlanDisclosure` 和 `RunAdmissionState`，而不是继续复制条件。

2. **Credential health 仍等待可选 DSH probe**  
   普通连接状态仍与可选 Provider metadata 探测耦合；具体错误也只归并为 available/unavailable。

3. **完整历史没有直接出口**  
   截断后只能分页，不能一键导出完整 Session、子 Session、Artifact 与审批证据。

4. **Admission 失败的重试语义不清晰**  
   非原子启动可能留下部分 Run；用户无法判断“失败是否无痕”以及能否安全重试。

5. **工程概念仍较多**  
   Session、Run、Gate、Artifact、Profile、Provider、Token 仍进入普通路径；mock 更适合独立 Simulation mode。

6. **辅助技术验收仍不足**  
   只有 Chromium 和局部 ARIA 证据，没有 Firefox、WebKit、NVDA/JAWS/VoiceOver、200%/400% 缩放、forced-colors、reduced-motion 和真实弱网矩阵。

7. **视觉回归不足**  
   极长需求、多个 Gate、长 Artifact、多错误叠加、窄屏和历史截断组合主要依赖人工发现。

## 10. Runtime 与数据架构评审

### 10.1 P0：仍缺 repo 级 single-owner Runtime

CLI 与 Web 仍可分别持有：

- SQLite、WriteQueue、repositories；
- Session store、EventBus；
- JobRunner、SubprocessRegistry；
- Workflow/Automation executor；
- Git/worktree、Provider；
- shutdown 生命周期。

Job owner、lease、CAS 与进程内 generation token 只能保护部分 Job/Workflow 行，不能完整 fence 普通文件、Git promotion、Artifact、Gate、Audit、Delivery 和外部 SDK 副作用。

长期方向仍应是：

```text
repo-scoped daemon/service
→ physical repo lock
→ CLI/Web 客户端化
→ 单一 admission/execution/shutdown authority
```

### 10.2 P0：Shutdown 仍不能证明 quiescent

当前 stop 已有停止 poll、等待 active poll、settle window、AbortController、registered subprocess kill、hard deadline 与 DB closed fence。

但 hard deadline 返回时，不合作 executor 仍可能继续 JavaScript、普通文件、Git 或外部 SDK 副作用。完整闭环需要 process/worker isolation、真实 kill/join、generation fencing、checkpoint/flush 和 crash/restart/late-write 故障注入。

### 10.3 P0：Session Event 仍是 best-effort projection

当前依然是：

```text
领域表 / Audit 先成功
→ best-effort append session_event
→ 找不到 Session 或追加失败时允许跳过
```

它适合 UI projection，但不能独立承担 durable inbox、权威模型历史、prompt claim/processed、crash replay、fork/resume 或 restart recovery。

### 10.4 P1：Run admission 仍非原子

启动横跨：

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

没有统一事务、transactional outbox 或显式 admission saga。#31 仍是发布前的重要数据一致性问题。

### 10.5 P1：RunPlan 仍不是唯一执行事实

仍未完整绑定：

- Demand identity/version/body hash；
- mode；
- base revision；
- workspace physical identity；
- resolved Provider executable/config/capability evidence；
- permission/network acknowledgement；
- expected Artifacts；
- executable node plan。

顶层 `SessionService.planDigest` 静默失效；Project/Workspace identity 也未统一。#20 应与 #22/#29/#31 共同定义不可变 RunAdmission snapshot。

### 10.6 P1：Provider admission/command identity 仍分裂

- DSH/Codex 仍可受 executable basename 影响 preflight 或 argv framing；
- CLI preflight 仍依赖 `activeAgent` mutable slot；
- Credential health、Provider health、run admission 和 execution recheck 尚未统一；
- Codex/Claude 缺少与 DSH 同级的持久化前 capability probe。

## 11. DeepSeek Harness alpha.5 对齐结论

### 11.1 版本事实

截至 2026-09-03：

```text
Tekon tested pin = 0.1.2-alpha.3
upstream release = 0.1.2-alpha.5
alpha.5 tag = db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5
current master sync = 49a606bc5b5934603f22a26957a07dc799ab0291
```

继续精确 pin alpha.3 是合理的 fail-closed 选择；不能因为上游有新 prerelease 就自动升级。

### 11.2 alpha.4 → alpha.5 的主要变化

本次 release 主要修复从旧版本升级时：

- session projection cache 版本兼容；
- legacy storage document salvage；
- app 启动或 Session title 丢失问题。

当前 Headless one-shot、help anchor、五个 metadata row id 与 Node engines 没有观察到直接漂移。

但这只说明 L1 静态锚点；不代表：

- alpha.3→alpha.5 完全无变化；
- 真实安装 metadata 已通过；
- API 调用、timeout、cancel、redaction 已通过；
- 默认 `web_fetch`、credential fallback 或 telemetry 边界已完成验证。

### 11.3 Headless 仍应保持 Goal-only

官方 Headless 仍是：

```text
一次 invocation
→ 一个 positional task
→ fresh Agent
→ 等待 quiescence / flush Session
→ stdout 最终文本
→ 退出
```

没有 interactive follow-up，因此 Tekon 继续把它限制在 Goal/one-shot 场景是正确的。

### 11.4 ACP 仍是 Collaborate 的优先 vertical slice

持续协作应验证：

```text
owned ACP subprocess
→ session/new
→ prompt
→ execution-time semantic updates
→ prompt cancel
→ quiescent close
→ process restart + session/resume
```

不要把 persistent session 强行映射回 one-shot AgentAdapter。

### 11.5 Safety 边界

Harness 仍是快速迭代的 developer preview。其 sandbox、approval 和 permission controls 可以降低风险，但不能作为 Tekon 对不可信 workload 的唯一安全边界。

## 12. 代码实现与测试可信度

### 做得较好的部分

- Core/CLI/Web 分层和大量不变量测试已经形成较强回归网；
- package-manager、版本 lockstep、production audit、CLI e2e 与 Chromium gate 已稳定；
- SSE replay/backpressure、Session snapshot fallback、Job owner/CAS、CommandGateway no-progress 边界均有针对性测试；
- 本轮 UI 文案通过反向 Playwright 断言固定，不只修改字符串；
- DSH telemetry 修复在 ambient FULL/endpoint 条件下验证 exact env，而不是只断言默认情况。

### 仍需改进

- Actions 主要跑 Node 24，声明的 Node 20.19/22.12 支持范围没有持续矩阵；
- 没有真实 semantic lint，多个 `lint` 仍主要等价于 typecheck；
- DSH L2/L3、Codex/Claude provider smoke 仍不足；
- 当前测试大量依赖同进程 fake，不能证明 multi-process DB、crash/restart 和真实 subprocess quiescence；
- 浏览器矩阵只有 Chromium；
- `useQuery` 创建 AbortController，但 fetcher 不接收 signal，当前“取消”主要是结果 generation guard，而非真实网络中止；属于低优先级复杂度债务。

## 13. 过度实现与过度设计判断

当前结构性风险仍是：

> 横向框架、治理层、测试替身和评审资料的增长速度，持续快于纵向持续协作闭环。

项目已有：

```text
AgentAdapter / AgentDriver / LegacyAgentDriver
Provider Registry / capability declarations
Workflow / Role / Gate / Artifact / Audit
JobRunner / Session projection / SSE
Profile / Automation / Goal / Readiness / Delivery
CLI / Web 两套 composition root
默认 Composer + Advanced Run 两套 admission UI
大量计划、ADR、报告和 issue
```

而最小 Collaborate 链路仍未成立。

本轮出现的文案漂移说明 UI 也存在横向重复：两个启动入口分别实现同一计划/准入状态机。后续不应再为第三个入口复制一遍，而应提取共享 admission view-model。

`assertAgentProviderCapabilities()` 返回一份结构化 mapping，但实际调用方只利用“抛不抛错”；对于 DSH，tool allow/deny 还是未映射声明。这里不需要继续扩展更大的通用 capability DSL，优先把三种真实 Provider 的实际 evidence 落实为可验证证据。

在以下主链路完成前，应冻结新的 Profile、Automation job、Driver wrapper、展示 Event 和 Workflow DSL：

```text
single-owner Runtime
→ executor isolation/restart
→ request-scoped Provider admission
→ credential/capability evidence
→ atomic Run admission
→ canonical RunPlan authority
→ authoritative Session
→ persistent Provider stream
→ follow-up / cancel / resume
→ Collaborate → Deliver
→ export / compaction / lifecycle retention
```

## 14. 优先级与实施顺序

### P0 主链路

1. #16 single-owner Runtime + physical repo lock；
2. #15 executor isolation、kill/join 与 restart contract；
3. #31 atomic Run admission / saga；
4. #13 authoritative Session/outbox + durable inbox。

### P1 Provider 与执行事实

1. #29 request-scoped Provider capability/admission；
2. #28 command identity/framing；
3. #32 DSH credential/telemetry/capability evidence；
4. #22 exception acknowledgement/snapshot/Audit；
5. #20 RunPlan admission/execute/resume authority；
6. #17 alpha.5 L2/L3。

### P1 产品闭环

1. #14 ACP vertical slice；
2. #19 Collaborate → Deliver；
3. #18 export/compaction/retention/lifecycle-safe purge；
4. #21 a11y/browser/weak-network matrix。

### P2 工程治理

- #25 CommandGateway timeout state machine 拆分；
- #26 semantic lint 与 format debt；
- #24 required checks、SBOM、provenance、签名与 release channel。

## 15. 合并建议

当前 PR 已明显超过适合逐行审阅、可靠二分和低风险回滚的规模。最终建议：

- 使用 **squash merge**；
- 合并前确认 PR Head 未变化，Core/CI 仍为 success；
- 不在 PR #11 继续实现 daemon、Session truth、ACP、RunPlan schema 或 admission transaction；
- 后续 #13–#32 全部使用独立小 PR；
- `main` 未配置 required checks，仍需人工执行最终合并门。

本轮未执行 merge、release、deploy 或 ruleset 修改。

## 16. 最终裁决

**当前 PR 的本轮增量通过代码合并门。**

**Tekon 整体产品验收仍不通过。**

允许的成熟度表述：

> Tekon v0.20.5 已形成测试覆盖较强、执行计划与风险边界较透明、Session 在线观察具有基础资源上限、可选 DSH Headless Provider 具有 tested pin、Host Node fail-closed 预检和 telemetry hard opt-out 的实验性受控交付执行与观察基础设施；Deliver 轨道可在有人监督下使用，但持续协作、单一 Runtime 权威、权威 Session 事实链、原子 Run admission、Provider credential/capability evidence、可证明的 shutdown/restart、完整历史导出和模型上下文预算仍未闭环。

## 17. 关键依据

### Tekon

- [`packages/web/src/client/components/runs/StartRunForm.tsx`](../../packages/web/src/client/components/runs/StartRunForm.tsx)
- [`packages/web/src/client/components/runs/start-run-submit-state.ts`](../../packages/web/src/client/components/runs/start-run-submit-state.ts)
- [`packages/web/__tests__/client/start-run-submit-state.test.ts`](../../packages/web/__tests__/client/start-run-submit-state.test.ts)
- [`packages/web/__tests__/e2e/start-run-admission.e2e.test.ts`](../../packages/web/__tests__/e2e/start-run-admission.e2e.test.ts)
- [`packages/web/__tests__/e2e/start-run-form.test.ts`](../../packages/web/__tests__/e2e/start-run-form.test.ts)
- [`packages/core/src/runtime/dsh-headless-adapter.ts`](../../packages/core/src/runtime/dsh-headless-adapter.ts)
- [`packages/core/src/runtime/dsh-bridge-probe.ts`](../../packages/core/src/runtime/dsh-bridge-probe.ts)
- [`packages/core/__tests__/runtime/dsh-bridge-probe-telemetry-env.test.ts`](../../packages/core/__tests__/runtime/dsh-bridge-probe-telemetry-env.test.ts)
- [`packages/core/__tests__/runtime/dsh-headless-telemetry-env.test.ts`](../../packages/core/__tests__/runtime/dsh-headless-telemetry-env.test.ts)
- [`packages/core/src/runtime/agent-adapter.ts`](../../packages/core/src/runtime/agent-adapter.ts)
- [`packages/core/src/runtime/mock-agent-adapter.ts`](../../packages/core/src/runtime/mock-agent-adapter.ts)
- [`packages/core/src/session/session-service.ts`](../../packages/core/src/session/session-service.ts)
- [`packages/web/src/server/api/routers/project.ts`](../../packages/web/src/server/api/routers/project.ts)
- [`packages/core/src/workflow/run-plan.ts`](../../packages/core/src/workflow/run-plan.ts)
- [`docs/superpowers/plans/2026-09-03-nineteenth-review-remediation-plan.md`](../superpowers/plans/2026-09-03-nineteenth-review-remediation-plan.md)

### DeepSeek Harness alpha.5

- [alpha.5 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.5)
- [alpha.4 → alpha.5 compare](https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.1.2-alpha.4...dsh-v0.1.2-alpha.5)
- [CLI behavior reference](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.5/apps/cli/reference/README.md)
- [Base composition](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.5/packages/bundle/base/cordis.patch.yml)
- [Headless composition](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.5/packages/bundle/headless/cordis.patch.yml)
- [Local credential provider index (`packages/credentials/credentials-local/src/index.ts`)](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.5/packages/credentials/credentials-local/src/index.ts) 与 [文档说明](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.5/packages/credentials/credentials-local/README.md)（官方源码确立凭据解析分层：`process.env` > `$DSH_HOME/.credentials.yaml` > `<invocation cwd>/.env` > `$DSH_HOME/.env`）
- [App boot (`packages/boot/app-boot/src/index.ts`)](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.5/packages/boot/app-boot/src/index.ts)（共享 boot 基础设施与 Loader 驱动）
- [Profile boot (`packages/boot/app-boot/src/profile.ts`)](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.5/packages/boot/app-boot/src/profile.ts) 与 [CLI profile runner (`apps/cli/src/profile-boot.ts`)](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.5/apps/cli/src/profile-boot.ts)（`--profile headless --help` 触发 profile 与 plugin 完整引导）
- [Core tools (`packages/core/tools/src/index.ts`)](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.5/packages/core/tools/src/index.ts)（Cordis 内置工具服务定义与 schema，与 Tekon shell 声明的概念错位证据）
- [Web fetch capability seam note (`.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md`)](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.5/.agents/notes/implemented/architecture/2026-06-24-web-capability-seam.md) 与 [Tool web (`packages/web/tool-web/README.md`)](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.5/packages/web/tool-web/README.md)（`web_fetch` 无需逐次审批公网抓取机制）
- [ACP server (`packages/acp/acp/README.md`)](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.5/packages/acp/acp/README.md) 与 [ACP entry (`packages/acp/acp/src/index.ts`)](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.5/packages/acp/acp/src/index.ts)（持久 Session、流式更新与标准交互控制协议）
- [Safety](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.5/SAFETY.md)

## 18. 主 Agent 视角批注与收口裁决

本节记录主 Agent 在 `0ad721d` 收口后的最终复核；§1–§17 保留此前各快照的评审时点，若结论存在演进，以本节为准。

### 18.1 对 §5 四项直接修复的裁决与收口

- **网络文案（§5.1）**：Advanced Run 历史表述“网络受控隔离”与实际合同不符。按本轮验证，DSH 当前沙箱不能作为公网出站阻断证据，network 应继续标为 enabled/unrestricted，现有 sandbox 证据集中在文件写入约束。`7acfbae` 将文案修正为“计划未请求不受限网络”，明确实际隔离能力取决于底层 Provider 与宿主环境，并在 Playwright 中补充反向断言。主 Agent 裁决：**整改成立，予以通过**。
- **mock Provider 产品身份（§5.3）**：针对高级表单中 mock 与真实 Provider 缺乏醒目隔离的问题，`7acfbae` 增加了明确的中文警示 Note，标注 mock 仅用于测试/演示、生成合成结果与通过产物、不执行真实任务、不能作为交付依据。主 Agent 裁决：**整改成立，予以通过**。
- **DSH telemetry 边界（§5.4）**：`7acfbae` 在正式 Run 子进程（`envMode: exact` 白名单）中固定 `DSH_TELEMETRY_DISABLED=1`，确保不继承宿主 ambient telemetry 配置。复核发现，前置 metadata probe 原先仍直接继承宿主环境，因此无法证明 probe 阶段已关闭 DSH 内置 telemetry，并存在宿主默认值污染风险；没有证据表明该阶段已经发生遥测外传。`0ad721d` 随后在 `dsh-bridge-probe.ts` 统一删除 `DSH_TELEMETRY_MODE` 与 `DSH_TELEMETRY_OTLP_URL`、固定注入 `DSH_TELEMETRY_DISABLED=1`，并以真实子进程环境捕获测试固定边界。主 Agent 裁决：**正式 Run 与 metadata probe 在本轮范围内均已完成内置 telemetry hard opt-out，予以通过**。
- **Advanced Run 提交门与防重入（§5.2）**：`7acfbae` 提出的 fail-closed 准入拦截方向正确，但原补丁存在三处关键缺陷：
  1. 缺少针对准入优先级和阻断条件的可证伪单元测试，也缺少防重入 e2e；
  2. 仅依赖 React 异步状态 `isPending` 进行禁用，在同一事件循环 tick 内双击或并发触发时，存在重入窗口（即同一页面同时派发两个 `project.run` RPC 请求）；
  3. 表单状态机遗漏了对需求草案“已生成计划但尚未审批”（`hasPlan && !planApproved`）状态的拦截，导致未批准计划草案可绕过审批直接提交。
  主 Agent 在 `0ad721d` 中将准入逻辑抽取为纯函数 `startRunSubmitState()` 并补全 9 级优先级的独立单测，在 `StartRunForm` 中引入同步 `useRef` latch，关闭本轮确认的同一 tick 重入窗口（失败时重置以支持重试），并严格阻断未批准的草案计划。主 Agent 裁决：**准入状态机、防重入 latch 与草案审批门禁已在本轮范围内闭环，予以通过**。

### 18.2 DeepSeek Harness 上游事实与证据边界核定

- **alpha.5 tag 与 master 区分**：官方 release tag `dsh-v0.1.2-alpha.5` 的 tag commit 为 `db6bdc3576c2d4e7c965e8e3ed0c2a731eed87f5`，而 `49a606bc5b5934603f22a26957a07dc799ab0291` 是主干接收该版本的 release-sync merge commit。二者身份不可混淆，后续 L1/L2/L3 验证 fixture 必须严格绑定 release tag commit。
- **凭据解析分层（credential fallback）**：核对官方 `packages/credentials/credentials-local/src/index.ts` 源码，其凭据解析链条为：`process.env` > `$DSH_HOME/.credentials.yaml` > `<invocation cwd>/.env` > `$DSH_HOME/.env`。Tekon 启动子进程时将 invocation cwd 设为工作区 worktree，因此即使 child env 未显式传递 `DEEPSEEK_API_KEY`，DSH 仍会隐式回退到工作树 `.env` 读取凭据。这证明单纯清理环境变量不等于凭据隔离，该独立凭据风险成立。
- **概念错位（Cordis tool id vs Tekon shell 声明）**：DSH 内部采用 Cordis 插件微内核架构（`packages/core/tools`），其工具注册基于具体的 Cordis tool id；而 Tekon 当前在 `permissionProfile.tools.allow/deny` 中声明的规则，仅由外层 CommandGateway 对启动命令做 shell 级模式匹配，并未转换为 DSH 内部的工具级控制。外层声明不可伪装成 Provider 已生效的内部控制能力。
- **preflight 环境变量继承事实**：metadata probe 本轮虽然硬清除了遥测 key，但依然继承了宿主环境的 `PATH`、`DSH_HOME` 及其他环境配置；这只解决了遥测上报，绝不等于环境或凭据的完全沙箱隔离。
- **启动开销与 Profile boot 事实**：经源码确认，`dsh --version` 与 `dsh --dump-default-config` 为 boot-free 极速路径；但 `dsh --profile headless --help` 会执行完整的 profile discovery、bundle patch 合成以及 plugin loader 挂载（profile/plugin boot）。尽管没有证据表明此前 help 探测触发过外部请求，但由于其进入了完整的 plugin boot 链路，在 probe 阶段实行 telemetry hard opt-out 是必要的纵深防御。
- **DSH reasoning 流（stderr）**：DSH headless 在执行中会将 reasoning delta 实时写入 stderr，并将最终输出写入 stdout；但 Tekon 当前的 `dsh-headless-adapter.ts` 仅将输出收集为普通子进程日志，未向 Session 和前端 UI 投影实时推理流，导致用户在运行过程中无法感知代理的逐步思考过程。该持续交互能力继续由 #14 / #19 跟踪。
- **问题跟踪状态**：#32（DSH 环境凭据与能力证据）与 #17（DSH alpha.5 真实 L2/L3 验收）涉及深层跨进程与模型交互，**必须继续保持 open**，不得在缺少真实验证的情况下草率关闭。

### 18.3 `project.clean` 风险拆分（#33）与生命周期范围控制

- **§7 风险裁决成立**：当前 `project.clean` 接口直接调用物理删除移除 `.tekon/runs/<runId>` 目录，缺乏对 active Job 的互斥检查，不写入 Audit 审计记录，不修复数据库中存在的 Artifact 与 path 关联引用，亦无失败补偿机制。若在并发或未完成阶段触发，可能导致活跃任务崩溃与数据撕裂。
- **治理路径与 #33 拆分**：主 Agent 裁决不可在当前超大 PR 中重写整套生命周期。为第一时间消除误删隐患，已将“活动期误删入口防护”拆分为独立 issue [#33](https://github.com/zesming/tekon/issues/33)。首选方案是安全暂停所有物理删除动作并记录拒绝 Audit。
- **明确非 lifecycle-safe 声明**：必须清醒认识到，#33 仅属于入口阻断兜底，**绝不能宣称为 lifecycle-safe 的清理方案**。完整的 export 导出、模型 compaction、统一 retention、tombstone 标记与物理清理事务仍必须完整保留在 issue [#18](https://github.com/zesming/tekon/issues/18) 中进行系统化设计与推进。
- **PR #11 范围控制**：PR #11 生产代码中保持 `project.clean` 原样不动，不引入未经全面状态机验证的临时修改。

### 18.4 跨模块架构冻结项的处置边界

- 维持既定架构冻结裁决，不在 PR #11 内回填以下长期跨模块能力：
  - single-owner Runtime 与物理仓库互斥锁（#16）；
  - 执行器强隔离、kill/join 语义与重启保证（#15）；
  - 原子 Run admission 与 saga 补偿事务（#31）；
  - 权威 Session 事实源、durable outbox/inbox（#13）；
  - ACP 标准双向交互垂直切片（#14）；
  - Collaborate 与 Deliver 双轨交互闭环（#19）；
  - request-scoped Provider 准入与命令身份规范（#28, #29）。
- 上述架构项继续在 GitHub issues 跟踪，待 PR #11 合并后拆分为独立小 PR 循序渐进落地。

### 18.5 实施整改细节（commit `0ad721d`, v0.20.5）

- **Probe 环境变量快照（probe env）**：在 `packages/core/src/runtime/dsh-bridge-probe.ts` 中，`runDshPreflight()` 统一生成 inherited-minus-telemetry 快照，删除 `DSH_TELEMETRY_MODE` 与 `DSH_TELEMETRY_OTLP_URL`，固定 `DSH_TELEMETRY_DISABLED=1`；为单元测试暴露只读 seam `probeEnvSource`。
- **提交状态选择器与同步 Latch（submit selector+ref latch）**：新增纯函数 `startRunSubmitState()`（`packages/web/src/client/components/runs/start-run-submit-state.ts`），将 token、submitting、plan 状态、需求文本、草案审批、digest 与网络确认清晰解耦；`StartRunForm.tsx` 使用该函数确定禁用状态，并结合 `useRef` latch 实现同步防重入锁，在 mutation settlement 后安全释放。
- **草案审批门禁（draft gate）**：在提交准入校验中强化 `draft-not-ready` 状态：当需求草案已生成执行计划（`hasPlan=true`）但未经人类审批（`planApproved=false`）时，提交按钮强制保持 disabled 并展示需先审批计划的醒目提示。
- **移动与窄屏响应式（390/700/<=768单列与短标签）**：针对 390px 与 700px 视口，在 `reset.css` 中增加 `<=768px` 媒体查询，将表单模式、模板、Provider 与 Profile 四个选择器强制切换为单列垂直排布；缩短选择器闭合状态下的标签文本（短标签：如 `dsh-headless（experimental · 仅 Goal）`、`mock（仅测试/演示）`、`autonomous-delivery（自动准备）`），消除挤压换行，将完备的风险说明保留在相邻辅助文案中。
- **文档、方案与版本同步（manual/plan HTML、v0.20.5）**：同步更新用户使用手册（`docs/manual/tekon-user-manual.md`、`docs/manual/tekon-user-manual.html`）、`CHANGELOG.md`；生成整改方案 `docs/superpowers/plans/2026-09-03-nineteenth-review-remediation-plan.{md,html}`；根项目及 core/cli/web 四个 `package.json` lockstep 升级至 `v0.20.5`。

### 18.6 测试先行（TDD）RED 证据与 GREEN 验证

本轮所有改动均遵循“测试先行”工程原则，先建立确定失败的 RED 测试，再编写实现使其变绿。以下 RED 输出来自主 Agent 本轮运行记录；由于测试与实现最终落在同一提交，提交历史不能独立复现先后顺序，GREEN 结果可以从当前快照复现：

1. **DSH 探针 Telemetry 继承测试**：
   - RED 运行记录：在 `packages/core/__tests__/runtime/dsh-bridge-probe-telemetry-env.test.ts` 中构建 fake dsh 捕获子进程环境变量；宿主传入 `DSH_TELEMETRY_DISABLED=0` 时，probe 收到 `0`，测试断言失败；
   - GREEN 验证：在 `dsh-bridge-probe.ts` 引入过滤快照后，fake dsh 记录的变量固定为 `1`，且 telemetry mode/url 被剔除，测试通过。
2. **Advanced Run 准入纯函数单测**：
   - RED 运行记录：新增 `packages/web/__tests__/client/start-run-submit-state.test.ts` 时，目标模块尚未创建，测试因模块缺失报错；
   - GREEN 验证：实现纯函数后，18 组表驱动测试覆盖 9 个阻断优先级层级及成功路径，全部通过。
3. **并发单次提交防重入（Single-submit Latch）E2E**：
   - RED 运行记录：在 `packages/web/__tests__/e2e/start-run-admission.e2e.test.ts` 中模拟同一 tick 内连续触发两次提交；无 `useRef` latch 时，服务端捕获到 2 个并发 `project.run` RPC 请求，测试断言失败；
   - GREEN 验证：在表单 handler 中置入同步 latch 后，同一 tick 内的第二次触发被丢弃，服务端只收到 1 个请求，测试通过。
4. **未批准计划草案准入拦截 E2E**：
   - RED 运行记录：使用 `hasPlan=true, planApproved=false` 的草案加载表单；补齐校验前，计划生成后提交按钮仍为 enabled，允许用户直接运行；
   - GREEN 验证：补齐 `draft-not-ready` 状态校验后，提交按钮在计划生成完毕后保持 disabled，并展示“计划未批准”告警文案，测试通过。
5. **移动视口单列与标签文本 E2E**：
   - RED 运行记录：390px 视口下，首行两列选择器的 x 坐标差为 164px；700px 视口下差值为 319px；`autonomous-delivery` 长标签还导致闭合选择器换行和文本截断；
   - GREEN 验证：引入单列媒体查询并缩短标签后，390px 与 700px 视口下所有选择器 x 坐标差不超过 2px，且页面满足 `document.documentElement.scrollWidth <= window.innerWidth + 1`，测试通过。

### 18.7 本地全量验证数据与边界限制说明

- **自动化测试套件执行结果**：
  - 主 Agent 本地运行 `pnpm test`：**143 files / 1539 passed / 3 skipped / 0 failed**，耗时约 25 秒；
  - Core e2e：`pnpm --filter @tekon/core test:e2e` 共 8 个文件，**26 passed**；
  - CLI e2e：`pnpm --filter @tekon/cli test:e2e` 共 3 个文件，**8 passed**；
  - Web e2e：`pnpm --filter @tekon/web test:e2e` 共 20 个 Playwright 测试文件，**41 passed，0 retries**，总耗时 34.9 秒。
- **工程门禁检查（lint/typecheck/build/audit）**：
  - `pnpm run lint`：通过；当前 lint 脚本仍主要等价于 TypeScript `--noEmit` 检查，不代表已接入独立 ESLint 静态规则；
  - `pnpm run typecheck`：全部通过；
  - `pnpm run build`：三包构建均成功输出产物；
  - `pnpm audit --prod`：无任何已知生产依赖安全漏洞（0 vulnerabilities）。
- **视觉与多视口验证**：
  - Web 界面在 390px、700px、1440px 视口下完成组件排布与溢出核验；
  - 整改方案 HTML 与用户手册 HTML 在 320px、375px、1440px 视口下完成截图和页面级横向滚动检查；统一判定标准为 `document.documentElement.scrollWidth <= window.innerWidth + 1`。
- **客观边界与测试缺口说明**：
  - 3 个 skipped tests 属于未设置 `DSH_CLI_PATH` 时跳过的真实 DSH L2 metadata probe；它们只检查 `--version`、`--profile headless --help` 与 `--profile headless --dump-default-config`，不运行模型，也不需要 API key；
  - 浏览器端到端矩阵当前仅覆盖 Chromium，未运行 Firefox 与 WebKit 兼容矩阵；
  - DSH 测试包含基于 fake binary 的 L1 合同断言与进程环境变量捕获，未执行真实 DSH L2 metadata probe，也未执行带凭据的 L3 模型调用。

### 18.8 独立 Reviewer 协作循环与结论

在实施整改全周期中，严格执行子代理独立审阅机制：

- **设计与架构审查**：首轮指出了 #33 边界、React state 防重入缺陷、plan error 优先级缺失、用户手册与 e2e 命名不规范等 5 项必须修复项；经吸收并在整改方案中细化后，第二轮复审结论为 `hasMustFix=false`；
- **代码与测试审查**：对 `dsh-bridge-probe.ts` 快照过滤机制、`start-run-submit-state.ts` 纯函数及 Playwright 单发 latch 进行了全面审阅，确认无死分支、无假测试、无副作用泄漏，最终判定 `hasMustFix=false`；
- **文档与编辑审查**：技术 reviewer 勘误了 `--help` 探测会进入 profile/plugin boot 的底层事实，促成了 telemetry 表述收窄为“内置 session telemetry 硬关断”；文案与编辑 reviewer 复核后判定 `hasMustFix=false`；
- **视觉与可访问性审查**：针对 390px/700px 移动视口排布进行了真机尺寸核对，确认单列排布与 aria 标注合规无误，判定 `hasMustFix=false`。

### 18.9 Subagent TOML 运行时事实核对与澄清

- **本轮调用事实**：本轮主 Agent 在委派 subagent 时，直接指定 `agent_type` 为 `explorer`、`designer`、`worker`、`reviewer`、`doc_reviewer`。当前 runtime 的 `spawn_agent` 工具元数据所列角色描述、模型与思考等级，和 `~/.codex/agents/*.toml` 逐项一致；各次调用返回的 agent role 也与请求一致。这些证据可以证明角色映射生效，但不能直接内省并证明每条 `developer_instructions` 的加载细节；
- **历史回溯与事实澄清**：历史 session 日志显示，第十六轮曾有 4 个 `explorer` 角色在角色分配成功后统一报错 `400 User location is not supported for the API use`；后续第十七轮、第十八轮调用才显式回退为 `default`。因此，现有证据指向“角色 TOML 中当时指定的底座模型遭遇地域限制后，主 Agent 主动旁路”，而不是 runtime 静默忽略 TOML。当前 `explorer` / `worker` 已更新到新的模型配置并可正常运行；
- **边界声明**：以上记录为本轮在当前运行环境和工具调用层观察到的真实工程事实，旨在澄清内部协作链路，不作为 OpenAI 官方规范或产品声明。

### 18.10 最终收口裁决与合并建议

综合上述事实与验证结果，主 Agent 做出最终收口裁决：

1. **当前 PR #11 的本轮整改增量通过代码合并门**：DSH 内置 session telemetry 关断已覆盖至 metadata probe，Advanced Run 准入实现了单一源纯函数校验与同步并发防重入，移动窄屏布局收敛，全套自动化测试与工程门禁零错误通过；
2. **Tekon 整体产品仍未通过“面向普通人的稳定持续协作研发工作台”产品验收**：当前 Deliver 轨道在有人监督下基本可用，但持续协作、单权威 Runtime、权威 Session 事实链、原子准入与 DSH 凭据隔离等核心链路仍未成立；
3. **合并策略保持不变**：当前 PR 累积提交量已接近 150 个，涉及文件近 200 个，严禁继续追加新的架构实现代码；维持 **squash merge** 进入主干的建议，后续各项架构演进严格基于独立小 PR 推进。
