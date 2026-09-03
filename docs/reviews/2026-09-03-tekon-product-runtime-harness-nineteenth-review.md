# Tekon 产品、UI/UX、Runtime 与 DeepSeek Harness 第十九轮全面复审

- **日期**：2026-09-03
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **上一轮权威 Head**：`62f7c6ba2a0c12e6ad6a0ce2be6dca026cf96840`
- **用户本轮整改 Head**：`b3167c52ee80f492c1d11ea9f5cd25a3193cc1c2`
- **Reviewer 行为修复快照**：`7acfbae438dbef46befe4d7bab46b844720b80ef`
- **产品版本**：`0.20.4`
- **Tekon DSH tested pin**：`0.1.2-alpha.3`
- **DeepSeek Harness 上游发布基线**：`0.1.2-alpha.5`
- **用户整改自动化**：Core #411、CI #320 均为 `completed/success`
- **Reviewer 修复自动化**：Core #412、CI #321 均为 `completed/success`
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

上述四项已在 `7acfbae...` 中做最小、可独立验证的修复，并由 Core #412 / CI #321 首次执行全部通过。

同时新增或扩大了两个不能用局部补丁闭环的问题：

- **#32 DSH environment/evidence**：exact child env 不会阻止 DSH 从工作树 `.env` 解析凭据；`permissionProfile.tools` 也没有映射成 DSH 内部工具控制；
- **#18 Session lifecycle**：`project.clean` 可直接删除 Run 目录，但不检查 active Job、不写 Audit、不处理数据库中的 Artifact/path 引用。

因此，本轮结论不是“无问题通过”。当前 PR 的代码增量可以 squash merge；整体产品仍应按实验性受控交付执行与观察基础设施定位。

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
| `planDigest` 死参数 | 通过 | 顶层字段确实未被 `SessionService.startRun()` 读取；主入口依靠 opaque engine input 中的第二份数据生效。 |
| CLI `activeAgent` mutable slot | 通过 | 单 CLI 命令通常串行，当前事故概率有限，但公共编排接口无法证明本次 preflight 对应本次 Provider。 |
| Project/Workspace 双重身份 | 通过 | Workflow 每 Run 新建 Project，Session 按物理 repo 复用 Workspace，领域身份重复。 |
| DSH 默认 network ack | “风险面收窄”判断通过 | Web/CLI 已知入口有前置确认；Core/future caller、snapshot/resume 与非原子 onPrepared 事实链仍真实存在。 |
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

`handleStart()` 仍保留防御式检查，避免程序化触发绕开 UI disabled 状态。

### 5.3 mock Provider 不再伪装成真实执行

`mock-agent-adapter.ts` 会生成确定性的合成产物，其中多项状态为通过；它适合测试和离线演示，但不执行真实 Agent。

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

这项修复只关闭 telemetry 默认值；它不解决 DSH 自身的凭据 fallback、网络能力或内部工具控制。

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

该问题已并入扩展后的 [#18](https://github.com/zesming/tekon/issues/18)：完整导出、retention、compaction 与 lifecycle-safe purge 必须作为同一个数据生命周期设计处理。

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
   默认 Session Composer 和 Advanced StartRunForm 分别实现计划加载、网络语义、digest gate 与错误呈现。本轮的“网络受控隔离”回归正是重复 UI 状态机造成的证据。后续应共享 `RunPlanDisclosure` 和 `RunAdmissionState`，而不是继续复制条件。

2. **Credential health 仍等待可选 DSH probe**  
   普通连接状态仍与可选 Provider metadata 探测耦合；具体错误也只压成 available/unavailable。

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

不要把 persistent session 强塞回 one-shot AgentAdapter。

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

`assertAgentProviderCapabilities()` 返回一份结构化 mapping，但实际调用方只利用“抛不抛错”；对于 DSH，tool allow/deny 还是未映射声明。这里不需要继续扩展更大的通用 capability DSL，优先把三种真实 Provider 的实际 evidence 做实。

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

> Tekon v0.20.4 已形成测试覆盖较强、执行计划与风险边界较透明、Session 在线观察具有基础资源上限、可选 DSH Headless Provider 具有 tested pin、Host Node fail-closed 预检和 telemetry hard opt-out 的实验性受控交付执行与观察基础设施；Deliver 轨道可在有人监督下使用，但持续协作、单一 Runtime 权威、权威 Session 事实链、原子 Run admission、Provider credential/capability evidence、可证明的 shutdown/restart、完整历史导出和模型上下文预算仍未闭环。

## 17. 关键依据

### Tekon

- [`packages/web/src/client/components/runs/StartRunForm.tsx`](../../packages/web/src/client/components/runs/StartRunForm.tsx)
- [`packages/web/__tests__/e2e/start-run-form.test.ts`](../../packages/web/__tests__/e2e/start-run-form.test.ts)
- [`packages/core/src/runtime/dsh-headless-adapter.ts`](../../packages/core/src/runtime/dsh-headless-adapter.ts)
- [`packages/core/__tests__/runtime/dsh-headless-telemetry-env.test.ts`](../../packages/core/__tests__/runtime/dsh-headless-telemetry-env.test.ts)
- [`packages/core/src/runtime/agent-adapter.ts`](../../packages/core/src/runtime/agent-adapter.ts)
- [`packages/core/src/runtime/mock-agent-adapter.ts`](../../packages/core/src/runtime/mock-agent-adapter.ts)
- [`packages/core/src/session/session-service.ts`](../../packages/core/src/session/session-service.ts)
- [`packages/web/src/server/api/routers/project.ts`](../../packages/web/src/server/api/routers/project.ts)
- [`packages/core/src/workflow/run-plan.ts`](../../packages/core/src/workflow/run-plan.ts)

### DeepSeek Harness alpha.5

- [alpha.5 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.5)
- [alpha.4 → alpha.5 compare](https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.1.2-alpha.4...dsh-v0.1.2-alpha.5)
- [CLI behavior reference](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.5/apps/cli/reference/README.md)
- [Base composition](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.5/packages/bundle/base/cordis.patch.yml)
- [Headless composition](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.5/packages/bundle/headless/cordis.patch.yml)
- [Local credential provider](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.5/packages/credentials/credentials-local/README.md)
- [Safety](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.5/SAFETY.md)
