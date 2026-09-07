# Tekon 产品、UI/UX、Runtime 与 DeepSeek Harness 第十六轮全面复审

- **日期**：2026-09-02
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **上一轮权威代码快照**：`fc5418b410af78445f9fd184fd2352c375d4d580`
- **用户本轮整改快照**：`670c942acdacd53a9f5a1e0f4d70fd12d708a438`
- **reviewer 代码快照**：`ebd93d44fa0ab3562b653cda74695cfe60a83c36`
- **产品版本**：`0.20.4`
- **Tekon DSH tested pin**：`0.1.2-alpha.3`
- **DeepSeek Harness 当前官方版本**：`0.1.2-alpha.4`，release/master commit `4e84901e6471b79ec0338099867ebb4606d12bb5`
- **代码自动化状态**：reviewer 代码快照的 Core #402 与 CI #311 均为 `completed/success`；Root build/typecheck、production dependency audit、CLI build/unit/e2e、Web build/typecheck/unit 与 Chromium Playwright 全部成功
- **最终裁决**：本轮整改与 reviewer 局部修复通过当前代码合并门；Tekon 整体仍未通过“面向普通人的稳定持续协作研发工作台”产品验收

## 1. 执行摘要

本轮用户侧整改主要集中在四个方向：

1. DSH Host Node 判定改为完整稳定 semver，并将“事实兼容”与“人工旁路准入”拆开；
2. Web health 从只探测 `dsh --version` 收敛为与真实运行同源的完整 preflight；
3. 默认 Session Composer 不再把 RunPlan 的网络声明包装成宿主级隔离保证；
4. 将第十五轮冻结项拆为 #13–#27 的独立 issue，避免继续把架构主线塞进 PR #11。

上述方向总体正确，且用户整改快照的 Core/CI 已通过。本轮进一步发现并修复两个低风险、可独立验证的问题：

- `dsh-headless` Adapter 仍保留一套未使用的独立 version gate，以及 15 秒的本地 metadata probe；它与 Core 统一 preflight 的 5 秒默认预算并存，形成重复实现和超时合同漂移。现在 Adapter 只调用共享 `runDshPreflight()`，同时保留执行前二次校验这一 TOCTOU 防御。
- 顶栏视觉上显示“dsh-headless 不可用”，但连接按钮设置了 `aria-label`，根据 WAI-ARIA 名称计算规则会覆盖子内容，辅助技术只能得到“连接凭据：有效”。现在 Provider 故障通过 `aria-describedby` 成为按钮的可访问描述，并由 Playwright 锁定。

本轮也确认了三项不能被最新整改自动关闭的问题：

- DeepSeek Harness 已发布 alpha.4；该版本在 Headless/ACP/Python SDK 等共享组合中默认启用 `web_fetch`，并替换部分 Session 读取 API。Tekon 继续精确 pin alpha.3 是合理的 fail-closed 决策，但 alpha.4 的 L1/L2/L3 不能笼统写成“都被 API key 阻塞”。
- `project.health` 把“凭据是否有效”和“可选 dsh Provider 全量 metadata preflight”放在同一个请求里；在已安装但卡顿的 dsh 环境中，普通连接状态可能被可选 Provider 探测延迟。
- #27 tracking issue 的顺序与依赖只存在于 Markdown 表格；GitHub 原生 `sub_issues_summary` 和 `issue_dependencies_summary` 均为 0，且没有 milestone/assignee。它适合作为阅读索引，但还不是可执行的项目计划。

产品主裁决没有变化：Deliver 受控交付轨道已经具备实际价值；Collaborate、single-owner Runtime、权威 Session 事实链、可证明的 shutdown/restart、RunPlan 执行权威和完整历史/模型上下文预算仍未闭环。

## 2. 评审范围与方法

本轮覆盖：

- 上一轮权威 Head 到用户整改快照的完整增量；
- 根 README、用户手册、CHANGELOG、当前权威报告和第十五轮整改资料；
- Core 的 DSH bridge/adapter、CommandGateway、JobRunner、SessionService、dual-write、RunPlan；
- CLI 的 Provider preflight、运行 composition root、错误与 JSON 合同；
- Web 的 Composer、TopBar、project health/run、Session 右栏、SSE 与历史边界；
- 当前 Core、Root、Audit、CLI、Web unit 和 Chromium Playwright 自动化；
- #13–#27 的问题拆分、排序、依赖和仓库规则；
- DeepSeek Harness alpha.3 → alpha.4 的官方 release、Headless、base composition、ACP、Session API、Node engines 与 Safety 边界。

判断原则：

1. “通过”必须绑定具体 commit 与 `completed/success` 的 Actions 终态；
2. Provider 的计划声明、CommandPolicy、Provider sandbox 与 Host enforcement 必须分层；
3. 旁路准入不等于兼容事实，版本最新也不等于已验证；
4. UI 中视觉可见的信息不能因显式 ARIA 名称而从辅助技术中消失；
5. 二次 preflight 可以是 TOCTOU 防御，但不得维护第二套解析和超时实现；
6. issue 表格中的文字依赖不等于仓库平台已经实施依赖和所有权；
7. 不以局部测试绿色外推真实 Provider、跨进程、跨浏览器或屏幕阅读器已通过。

本轮没有可访问的独立部署实例、真实 dsh alpha.3/alpha.4 二进制与 API key，也没有 Firefox/WebKit 或屏幕阅读器。因此 UI 结论来自源码、ARIA 结构、现有 Chromium Playwright 和响应式实现；不声称完成新的像素级视觉或全站辅助技术验收。

## 3. 最终判断

### 3.1 当前代码增量

reviewer 代码快照 `ebd93d44fa0ab3562b653cda74695cfe60a83c36`：

- Core #402：`completed/success`；
- CI #311：`completed/success`；
- Root build + typecheck：success；
- production dependency audit：success；
- CLI build + unit + e2e：success；
- Web build + typecheck + unit：success；
- Chromium Playwright：success。

因此，**本轮用户整改与 reviewer 两项局部修复通过当前代码合并门**。

### 3.2 产品成熟度

允许的成熟度表述是：

> Tekon v0.20.4 已形成测试覆盖较强、执行计划与风险边界较透明、Session 在线观察具有基础资源上限、可选 DSH Headless Provider 具有 tested-pin 和 Host Node fail-closed 预检的实验性受控交付执行与观察基础设施；Deliver 轨道可在有人监督下试用，但持续协作、单一 Runtime 权威、权威 Session 事实链、可证明的 shutdown/restart、完整历史导出与模型上下文预算尚未闭环。

仍不应表述为：

- 面向普通用户的稳定持续协作研发工作台；
- Web/CLI 多进程共享仓库时拥有完整副作用 fencing 的 Runtime；
- 能从 Session Event 完整恢复模型上下文的 durable Session 平台；
- 已验证 DeepSeek Harness alpha.4 或完成真实 API smoke；
- `network: disabled/restricted` 等同于宿主级断网；
- 已完成全站可访问性、多浏览器与真实弱网验收。

## 4. 用户本轮整改逐项裁决

| 整改项 | 裁决 | 理由与边界 |
| --- | --- | --- |
| Host Node 稳定 semver 判定 | 关闭直接缺陷 | 完整稳定 `major.minor.patch` 才可能兼容；partial、malformed、prerelease fail-closed，符合 DSH engines 的普通 range 语义。 |
| Host/version compatibility 与 bypass 分离 | 关闭直接缺陷 | `compatible` 表示最终 admission，独立字段保留实际兼容性与旁路事实，不再把风险接受改写成兼容。 |
| 移除公共 `--host-node-version` | 通过 | 用户不能通过 CLI 参数伪造当前宿主版本；程序化测试 seam 仍可注入。 |
| Web health 使用完整 preflight | 基本关闭 | 健康结果与真实 Host/version/help/config admission 同源；但它与凭据握手耦合，且 UI 仍只展示 available/unavailable。 |
| Composer 网络文案 | 通过 | “计划未请求不受限网络”与“实际隔离取决于 Provider/宿主”准确区分意图与强制。 |
| DSH unavailable 可行动提示 | 本轮修复后基本关闭 | 视觉和辅助技术都能得到不可用状态与 CLI preflight 入口；详细失败原因仍留给 preflight。 |
| #13–#27 独立 issue | 方向通过，执行治理部分完成 | 避免继续扩张超大 PR；但优先级、依赖、owner、milestone 仍只是文本或为空。 |
| 第十五轮报告/current 维护 | 通过 | 当前入口区分 tested pin 与 upstream latest，并将旧报告转为历史。 |

## 5. 本轮 reviewer 直接修复

### 5.1 P2-CODE-03：Adapter 重复维护 DSH preflight

整改前，`dsh-headless-adapter.ts` 同时存在：

```text
本地 defaultProbeVersion/help/config（15 秒）
+ 未调用的 versionGate / ensureVersionGate
+ Core runDshPreflight（默认 5 秒）
+ capabilityGate
```

问题：

- `ensureVersionGate()` 已经没有调用者，是死代码；
- Adapter 默认 probe 为 15 秒，CLI/Core 为 5 秒，Web health 为 1 秒；
- help/config/version 的进程边界存在两套实现；
- 后续新增 Host Node、版本旁路或 metadata 规则时容易再次只改其中一处；
- 代码注释仍声称先 version gate，再 capability gate，与真实执行路径不符。

修复后：

```text
Web/CLI pre-persistence preflight
→ 持久化前 fail-closed

Adapter execution-time runDshPreflight（同一个实现）
→ 防 planning→execution 之间 binary/env 漂移
→ 每个 Adapter 实例缓存一次
```

保留执行时二次校验是合理的 TOCTOU 防御；删除的是重复解析、重复默认进程函数、死 gate 和 15 秒漂移，而不是删除安全检查。现有 adapter 测试继续覆盖版本漂移、旁路、help/config 失败、fake command 和“一次实例只 probe 一次”。

### 5.2 P2-A11Y-02：视觉 Provider 状态从可访问树中消失

顶栏按钮使用 `aria-label="连接凭据：有效"`。WAI-ARIA Authoring Practices 明确指出，按钮设置 `aria-label`/`aria-labelledby` 会隐藏后代内容的名称贡献。视觉子文本 `(dsh-headless不可用)` 因而不会成为按钮的可访问名称或描述。

修复：

- 保留短名称“连接凭据：有效”；
- 当 dsh 不可用时设置 `aria-describedby`；
- 通过同级 `.sr-only` 文本提供“dsh-headless 当前不可用；运行 tekon provider preflight dsh-headless 查看详情”；
- 视觉提示设 `aria-hidden=true`，避免重复朗读；
- Playwright 增加 `toHaveAccessibleDescription` 断言。

这种结构符合“名称描述控件目的，描述承载补充状态”的语义，也避免把较长的 Provider 诊断塞进按钮名称。

## 6. 产品逻辑评审

### 6.1 Deliver 轨道基本成立

当前默认 Web/CLI 路径实际表达的是：

```text
需求输入
→ 服务端 RunPlan/digest
→ standard-delivery 角色链
→ 隔离 worktree
→ Gate / Artifact / Audit / Review
→ 人工审批
→ Delivery / PR 准备
```

有效点：

- 默认按钮明确为“启动受控交付”；
- 计划加载失败或 digest 缺失时 fail-closed；
- dirty base、网络例外与外部副作用有显式确认；
- Goal 与 Workflow/Deliver 的能力边界较清楚；
- DSH Headless 仍限制为 Goal，不伪装成完整交付 Provider；
- README 已明确 Session feed、follow-up、Event projection 和 Workspace 的现状。

因此不应再把 Tekon 描述为“完全不能由人使用”。它已经是一套面向工程用户的受控任务执行与证据工作台。

### 6.2 Collaborate 轨道仍未成立

`LegacyAgentDriver.events()` 仍等待 one-shot run 完成后才遍历缓冲事件；`followUp()`、`steer()`、`resume()` 仍显式抛 `NotSupportedYet`。

普通用户仍不能在同一 Session 中完成：

```text
继续输入
→ Provider 执行中的真实语义更新
→ follow-up / steer
→ prompt-owned cancel
→ Runtime 重启后恢复
→ 在原上下文升级为 Deliver
```

因此当前 Session 仍主要是：运行观察、审批、治理证据和结果投影，而不是持续协作工作台。

### 6.3 产品范围仍有双重心智模型

页面采用 Session/Conversation 形态，但默认输入触发 PM/RD/QA/Reviewer 完整链路。当前文案已经诚实披露，不过用户仍需理解 Session、Run、Gate、Artifact、Profile、Provider、Token 等大量工程概念。

在 Collaborate vertical slice 完成前，后续不应继续增加新的 Profile、Automation 类型、Agent wrapper 或 Workflow DSL；优先让一个最小持续协作流程闭环。

## 7. UI 实现与 UX 交互评审

### 7.1 已经成立的改进

- 无 token、计划错误、digest 缺失、提交中等状态均阻止启动；
- 执行前展示角色链、控制点、人工确认与网络声明；
- Session 列表按 attention/active/idle/terminal 排序；
- Session 右栏可由 snapshot 兜底 runId/status/attention，Gate 查询决定真实 pending decision；
- 长历史有 backward cursor、页面窗口、截断 banner 和 SSE buffer 上限；
- 两个配置详情 dialog 具备焦点循环、Escape、焦点恢复与背景 inert；
- 本轮顶栏 Provider 故障对视觉和辅助技术保持一致；
- 当前 Chromium Playwright 主路径成功。

### 7.2 仍未关闭的 UX 问题

#### P1-UX-EXPORT：完整历史没有用户出口

在线窗口明确可能不完整，但用户仍没有：

- 导出完整 Session；
- 生成审阅/支持证据包；
- 下载 root/subsession/Artifact/审批 manifest；
- 获取稳定 snapshot/flush 边界。

这不仅是审计功能，也直接影响恢复上下文、问题上报和用户信任。

#### P2-UX-HEALTH：凭据状态与可选 Provider 探测耦合

`project.health` 在确认 token 有效后，同步执行完整 DSH metadata preflight，再返回 credential 与 provider 状态。已安装但卡顿的 dsh 最多可让普通“凭据有效”状态额外等待约两个 probe 阶段。

建议拆成：

```text
credential health（快速）
+ provider health（独立 query/cache/展开详情）
```

或先返回凭据状态，再异步刷新 Provider 状态。当前 60 秒缓存缓解了重复成本，但没有消除首次握手耦合。

#### P1-A11Y：局部改进不能外推全站通过

尚无以下验收：

- NVDA/JAWS/VoiceOver；
- Firefox/WebKit；
- 200%/400% 缩放；
- 对比度、forced-colors、reduced-motion；
- 动态审批、错误与 SSE 状态播报；
- 真实弱网和后台标签页。

#### 视觉评审证据边界

本轮没有可访问的部署实例或可控浏览器会话，因此没有生成新的当前界面截图。已有 UI 结论来自源码、ARIA 关系、响应式 CSS 和现有 Playwright；不能替代像素级视觉、真实焦点顺序和屏幕阅读器走查。

## 8. Runtime 与整体架构评审

### 8.1 P0-ARCH-01：缺少 repo 级 single-owner Runtime

Web 与 CLI 仍分别构造并拥有：

- SQLite connection / WriteQueue / repositories；
- Session store / EventBus；
- JobRunner；
- SubprocessRegistry；
- Workflow/Automation executor；
- Git/worktree/Provider；
- shutdown 生命周期。

job owner、lease、CAS 与 process-local generation token 能保护部分 Job 行，却不能完整 fence 普通文件、Git promotion、Artifact、Gate、Audit、Delivery 和外部 SDK 副作用。

正确方向仍是：

```text
repo-scoped daemon/service
→ physical repo lock
→ CLI/Web 客户端化
→ 统一执行、资源和 shutdown authority
```

### 8.2 P0-ARCH-02：Shutdown 仍非可证明的 quiescent shutdown

JobRunner 已具备：停止 poll、等待 active poll、settle window、AbortController、registered subprocess kill、hard deadline 和 DB closed fence。

但 hard deadline 后，不合作 executor 仍可能继续：

- 执行 JavaScript；
- 写普通文件；
- 操作 Git；
- 持有未登记子进程；
- 停留在外部 SDK 内。

完整闭环需要 executor process/worker 隔离、真实 kill/join、generation fencing、checkpoint/flush 与 crash/restart/late-write 故障注入。

### 8.3 P0-DATA-01：Session Event 仍是 best-effort projection

`dual-write.ts` 明确采用：

```text
领域表/Audit 先成功
→ best-effort append session_event
→ 找不到 Session 或 append 失败时跳过
```

这种合同适合 UI 观察投影，不能独立承担：

- durable user inbox；
- 权威模型历史；
- prompt claim/processed；
- crash replay；
- fork/resume；
- restart recovery。

必须在以下方向中明确选择：

1. authoritative append-only Session log，领域表为 projection；
2. 领域事实 + transactional outbox 为权威，Session 明确为可重建 projection。

### 8.4 P1-PLAN-01：RunPlan 尚未成为 execute/resume 唯一事实

当前 RunPlan 已覆盖角色、Gate、阶段、Agent、Profile、超时、dirty-base 与模板身份，但仍没有完整绑定：

- Demand identity/version/hash；
- `mode`（`RunPlanContext` 接收，但 plan/digest 未保存）；
- base revision；
- workspace physical identity；
- resolved Provider config；
- permission/network acknowledgement 与 enforcement evidence；
- expected Artifacts；
- executable node plan。

execute/resume 仍从旧表、模板和 Provider snapshot 重新拼装事实。当前 digest 是更强的预览/审计绑定，但还不是执行权威。

## 9. 代码实现评审

### 9.1 正面判断

- DSH preflight 已形成 Core 单一解析/错误合同；
- Host Node、版本、help/config 和旁路事实有结构化结果；
- Adapter 保留执行时二次校验，但不再维护第二套 probe；
- CommandGateway 使用 argv 执行，不通过 shell 拼接；
- RunPlan canonical JSON/digest 与 Web fail-closed 方向正确；
- Session/Workspace SSE 已处理 replay、cursor、`write(false)` 和有界 pending；
- JobRunner 对 ownership loss、cancel/pause relay、conditional settle 和 stop 有较强防御；
- 顶栏状态的视觉与辅助技术语义已对齐。

### 9.2 仍需收敛的代码热点

#### CommandGateway 职责过密

同一模块承担 policy、env、spawn、process group、redaction、progress、filesystem sampler、total/no-progress timeout、kill 与 stream settle。后续应先抽取纯 timeout state machine、可注入 clock、activity sampler 和 termination adapter，不要继续增加 timer 特判。

#### DSH command override 的 preflight 判定依赖 basename

Adapter 仅在 `basename(command) === 'dsh'` 时运行 execution-time preflight；测试 fake binary 借此跳过 gate。它也意味着显式配置为 `dsh.cmd`、`dsh.exe` 或企业 wrapper 名称时可跳过执行时二次校验。

当前默认 Web/CLI run 仍使用 `dsh`，因此不是现有主路径阻断。长期应把“是否跳过 preflight”改为显式的仅测试 seam，而不是根据文件名猜测生产/测试身份。

#### health schema 信息不足

服务端已经知道 Host/version/help/config 的具体失败层级，但 `project.health` 只返回 `available/unavailable`。本轮选择只给出 CLI preflight 入口，避免继续扩张 TopBar；如果未来增加 Provider 设置页，应复用结构化失败原因，而不是再实现一套探测。

## 10. 测试、CI 与仓库治理

### 10.1 当前门禁

当前代码快照通过：

- actionlint/Core build/unit/e2e；
- Root build/typecheck；
- production dependency audit；
- CLI build/unit/e2e；
- Web build/typecheck/unit；
- Chromium Playwright。

这是当前增量可以进入合并审阅的依据，不是跨进程、真实 Provider或全浏览器证明。

### 10.2 main 仍未保护

GitHub `main` 当前 `protected=false`，required status checks enforcement 为 off。红色 CI 仍不能从仓库规则层阻止合并，问题 #24 仅记录“暂缓”。

### 10.3 Tracking issue 仍是阅读索引，不是执行系统

#27 的 Markdown 表格列出 #13–#26 和顺序，但 GitHub 返回：

```text
sub_issues_summary.total = 0
issue_dependencies_summary.total_* = 0
milestone = null
assignees = []
```

风险：

- 依赖变化不会自动反映；
- 无法按 milestone 看真实进度；
- “阻塞”与“待启动”完全依赖手工更新；
- #17 被整体写成需要 dsh/key 才能推进，但 L1 source diff 不需要任何本地二进制，L2 metadata 只需要 binary，只有 L3 需要 API key/网络。

建议把 14 个 issue 收敛为四个 milestone/workstream，而不是并行启动 14 个项目：

1. Runtime authority & recovery：#16 → #15；
2. Session truth & collaboration：#13 → #14 → #19；
3. Execution contract & history：#20 → #18；
4. Provider/quality/release：#17/#22/#21/#24/#25/#26。

P1-PROCESS-01 应作为每个后续 PR 的验收约束，而不是独立排队到最后。

### 10.4 静态检查仍主要是 typecheck

根 `lint` 委托 package lint，而 Core/Web 等 package 的 lint 仍是 `tsc --noEmit`。仓库有 actionlint 与 Prettier check 脚本，但没有强制的 JS/TS semantic linter gate；#26 已正确跟踪。

## 11. DeepSeek Harness alpha.4 对齐结论

### 11.1 当前版本事实

截至 2026-09-02：

- Tekon tested pin：`0.1.2-alpha.3`；
- upstream latest：`0.1.2-alpha.4`；
- alpha.4 release/master：`4e84901e6471b79ec0338099867ebb4606d12bb5`；
- Node engines 仍为 `^22.19.0 || >=24.0.0`。

继续精确 pin alpha.3 是正确的 fail-closed 选择；“最新”不应自动进入可运行集合。

### 11.2 alpha.4 与 Tekon 最相关的变化

1. **Headless/ACP/Python SDK/custom profile 默认启用 `web_fetch`**  
   alpha.3 base config 的 `tool-web.config.fetch` 为 `false`；alpha.4 为 `true`。Tekon 已把 DSH 描述为网络不受限并要求知情确认，因此这不是绕过现有 network acknowledgement，但它扩大了开箱即用网络工具面，必须进入 alpha.4 L1/L2/L3 和旁路审计评估。

2. **Session 读取 API 变化**  
   release notes 明确以 `seq`、`eventAt()`、`snapshotEvents()` 取代直接 `Session.events`，并区分 `SessionSeq` / `SessionLogOffset` 强类型。它对未来 ACP/SDK vertical slice 和历史导出适配有影响，但不改变当前 Headless stdout/stderr/exit-code bridge。

3. **持续子 Agent follow-up 改进**  
   parent 与 continuable child 可通过 `send_message` 双向传递后续消息。这说明上游持续协作能力继续快速演进，更支持 Tekon 通过 ACP/SDK 独立 vertical slice 学习，而不是继续扩张 one-shot LegacyAgentDriver。

4. **长会话性能继续改进**  
   alpha.4 优化流式回复、布局和导航预览的渲染成本。Tekon 可以参考其按需读取与分页思路，但不能把上游实现存在等同于自身 UI/DB/模型上下文预算已经完成。

### 11.3 Headless 仍只能是 Goal/one-shot

官方 Headless 仍明确：每次 invocation 运行一个 task，输出最终 assistant answer 后退出，没有 interactive follow-up。Tekon 继续限制为 Goal 是正确的，不应将最终 stdout 包装成持续协作 streaming。

### 11.4 Collaborate 应优先做 ACP vertical slice

官方 ACP 提供 persistent session、new/list/resume/close、prompt/cancel、semantic updates、permission request 与 quiescent teardown。建议最小验证：

```text
owned ACP subprocess
→ session/new
→ prompt
→ execution-time updates
→ prompt cancel
→ quiescent close
→ process restart + session/resume
```

该切片成立后，再设计 Tekon Session、RunPlan、permissions、Artifact 和 Collaborate→Deliver 的映射。

### 11.5 安全边界

DeepSeek Harness 仍是未经完整安全审计的 developer preview。Sandbox、approval、permission 和 public-URL validation 都只能降低风险，不能替代：

- OS/container/VM 隔离；
- host-side network policy；
- credential minimization；
- command/artifact/audit evidence；
- human approval；
- 备份与恢复。

## 12. 是否存在过度实现或过度设计

### 12.1 横向框架仍领先于纵向产品价值

当前已有：

```text
AgentAdapter / AgentDriver / LegacyAgentDriver
Provider Registry
Workflow / Role / Gate / Artifact / Audit
JobRunner / Session projection / SSE
Profile / Automation / Goal / Readiness / Delivery
CLI / Web 两套 composition root
大量计划、ADR、评审报告与 issue
```

而最小持续协作链路仍缺：

```text
同一 Session 继续输入
→ 真实 Provider execution-time stream
→ cancel / steer / follow-up
→ Runtime restart resume
→ Collaborate → Deliver
```

冻结原则继续成立：除非直接服务 single-owner Runtime、authoritative Session、真实 Provider stream、follow-up/cancel/resume、RunPlan authority 或 export/compaction，否则暂停新增 Profile、Automation job、Driver wrapper、展示事件和 Workflow DSL。

### 12.2 本轮识别并删除了一处局部过度实现

Adapter 的第二套 metadata probe/timeout/dead version gate 就是典型局部过度实现：安全目标可以由共享 preflight + 执行时二次调用完成，无需第二套实现。

### 12.3 评审与 backlog 本身也需节制

第十六轮之后不应继续因每个小修新增完整长报告。后续规则：

- `current.md` 为唯一稳定入口；
- 只有产品/架构/外部基线实质变化时新增完整报告；
- 小修通过 current revision log 或对应 issue/PR 记录；
- #27 只做路线图索引，真实进度由 milestone、owner、依赖与独立 PR 体现；
- PR #11 最终 squash，后续问题不再回填本 PR。

## 13. 问题清单

| ID | 严重度 | 状态 | 问题 |
| --- | --- | --- | --- |
| P0-ARCH-01 | P0 | 未关闭 / #16 | CLI/Web 缺 repo 级 single-owner Runtime authority。 |
| P0-ARCH-02 | P0 | 部分完成 / #15 | hard deadline/DB fence 不保证 executor、Git、普通文件和 SDK 已 quiescent。 |
| P0-DATA-01 | P0 | 未关闭 / #13 | Session Event 是 best-effort projection，不是 durable inbox/权威模型历史。 |
| P0-PRODUCT-01 | P0 | 未关闭 / #14/#19 | 真实 streaming、follow-up/steer/cancel/resume 与 Collaborate→Deliver 未闭环。 |
| P1-PLAN-01 | P1 | 部分完成 / #20 | RunPlan 尚未成为 execute/resume 唯一事实，mode 等执行事实未完整进入 digest。 |
| P1-SESSION-01 | P1 | 部分完成 / #18 | 在线观察已有边界；完整导出、模型 compaction 与统一 retention 缺失。 |
| P1-DSH-01 | P1 | 部分完成 / #17 | tested alpha.3，latest alpha.4；L1/L2/L3 和默认 web_fetch 复核待完成。 |
| P1-DSH-02 | P1 | 未关闭 / #22 | Host/version bypass 未持久化到 Provider snapshot/Audit。 |
| P1-A11Y-01 | P1 | 未关闭 / #21 | 局部 Chromium/ARIA 证据不能替代全站、多浏览器和屏幕阅读器验收。 |
| P1-GOV-01 | P1 | 未关闭 / #24 | main 未保护，required checks enforcement 关闭。 |
| P1-PROCESS-01 | P1 | 未关闭 / #23 | PR #11 体量过大；后续必须使用独立小 PR。 |
| P2-CODE-01 | P2 | 未关闭 / #25 | CommandGateway 职责过密，timeout state machine 未独立。 |
| P2-CODE-02 | P2 | 未关闭 / #26 | 无真实 JS/TS static lint gate，format debt 较大。 |
| P2-CODE-03 | P2 | 本轮关闭 | DSH Adapter 重复 probe、15 秒超时漂移与死 version gate。 |
| P2-A11Y-02 | P2 | 本轮关闭 | 顶栏 dsh unavailable 视觉状态没有可访问描述。 |
| P2-UX-HEALTH | P2 | 未关闭 | 凭据握手同步等待可选 DSH 全量 preflight。 |
| P2-DSH-CMD | P2 | 未关闭 | execution-time preflight 通过 basename 推断 fake/real，命名不同的生产 wrapper 可跳过。 |
| P2-PROCESS-02 | P2 | 未关闭 | #27 的依赖、subissue、milestone、owner 尚未平台化，且 #17 blocker 粒度过粗。 |

## 14. 建议实施顺序

1. **关闭并 squash PR #11**  
   不再将后续主线回填到本 PR；合并前确认最终 Head 的 Core/CI 仍成功。

2. **Runtime authority：#16 → #15**  
   repo daemon/lock，再做 executor isolation、kill/join 和 restart contract。

3. **Session truth：#13**  
   authoritative log 或 transactional outbox + durable inbox，先确定事实源。

4. **真实 Collaborate：#17 与 #14 协同，再到 #19**  
   alpha.4 L1/L2 可先推进；ACP vertical slice；最后做 Collaborate→Deliver。

5. **执行与历史：#20 → #18**  
   RunPlan authority，再做完整导出、snapshot/flush、summary/compaction。

6. **体验和治理**  
   Provider health 解耦、bypass Audit、a11y、多浏览器、branch ruleset、static lint 与 release engineering。

## 15. 合并与发布边界

当前代码门通过只能证明：

- `ebd93d4...` 在现有自动化合同下可构建、类型正确并通过测试；
- Adapter preflight 收敛没有引入已知回归；
- 顶栏 DSH unavailable 状态具有可访问描述；
- 用户本轮 Host Node、网络文案与 issue 拆分没有击穿现有主路径。

它不能证明：

- Web/CLI 同时运行时没有 Git/文件/外部副作用冲突；
- shutdown 返回后所有 executor/SDK 已终止；
- Session Event 可以完整恢复模型上下文；
- alpha.4 已被 Tekon 兼容；
-任意规模会话具有稳定模型和资源预算；
- Firefox/WebKit/屏幕阅读器/真实弱网已通过；
- tracking issue 中的文字依赖会自动得到执行。

本轮未执行 merge、release、deploy、ruleset 或真实 DSH L2/L3。

## 16. 参考资料

### Tekon

- [当前权威入口](current.md)
- [第十五轮报告](2026-09-02-tekon-product-runtime-harness-fifteenth-review.md)
- [Runtime authority ADR](../technical/adr-0001-runtime-authority-and-collaborate.md)
- [`dsh-bridge-probe.ts`](../../packages/core/src/runtime/dsh-bridge-probe.ts)
- [`dsh-headless-adapter.ts`](../../packages/core/src/runtime/dsh-headless-adapter.ts)
- [`legacy-agent-driver.ts`](../../packages/core/src/runtime/legacy-agent-driver.ts)
- [`dual-write.ts`](../../packages/core/src/session/dual-write.ts)
- [`job-runner.ts`](../../packages/core/src/session/job-runner.ts)
- [`run-plan.ts`](../../packages/core/src/workflow/run-plan.ts)
- [`SessionComposer.tsx`](../../packages/web/src/client/components/sessions/SessionComposer.tsx)
- [`TopBar.tsx`](../../packages/web/src/client/layouts/TopBar.tsx)
- [Tracking issue #27](https://github.com/zesming/tekon/issues/27)

### DeepSeek Harness 官方

- [alpha.4 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.4)
- [Headless README](https://github.com/deepseek-ai/deepseek-harness/blob/4e84901e6471b79ec0338099867ebb4606d12bb5/packages/bundle/headless/README.md)
- [Headless composition](https://github.com/deepseek-ai/deepseek-harness/blob/4e84901e6471b79ec0338099867ebb4606d12bb5/packages/bundle/headless/cordis.patch.yml)
- [Base composition](https://github.com/deepseek-ai/deepseek-harness/blob/4e84901e6471b79ec0338099867ebb4606d12bb5/packages/bundle/base/cordis.patch.yml)
- [ACP README](https://github.com/deepseek-ai/deepseek-harness/blob/4e84901e6471b79ec0338099867ebb4606d12bb5/packages/acp/acp/README.md)
- [Safety](https://github.com/deepseek-ai/deepseek-harness/blob/4e84901e6471b79ec0338099867ebb4606d12bb5/SAFETY.md)
- [Root Node engines](https://github.com/deepseek-ai/deepseek-harness/blob/4e84901e6471b79ec0338099867ebb4606d12bb5/package.json)

### W3C

- [Providing Accessible Names and Descriptions](https://www.w3.org/WAI/ARIA/apg/practices/names-and-descriptions/)
- [ARIA1: Using aria-describedby](https://www.w3.org/WAI/WCAG21/Techniques/aria/ARIA1.html)

## 17. 批注（2026-09-02 主代理四路评估）

### 17.1 四路评估结论（一致）

| 评估路 | 结论 | 关键证据 |
| --- | --- | --- |
| reviewer 修复落地核查 | **2 项修复全部成立** | P2-CODE-03：`dsh-headless-adapter.ts` 已删除 `ensureVersionGate` 死代码与 15 秒默认 probe 漂移，`ensureCapabilityGate` 复用共享 `runDshPreflight` 且每实例缓存一次，TOCTOU 二次校验保留；P2-A11Y-02：`TopBar.tsx` 按钮保留短 `aria-label`，dsh 不可用时设 `aria-describedby="topbar-dsh-status-description"`，同级 `.sr-only` 文本提供诊断，视觉提示 `aria-hidden=true`，Playwright `toHaveAccessibleDescription` 断言存在且通过（CI 36 passed） |
| 新增 P2 项真实性 | **3 项全部真实存在** | P2-DSH-CMD：`isRealDshCommand` 用 `basename(command) === 'dsh'` 推断（`dsh-headless-adapter.ts:73`），命名不同的生产 wrapper 会跳过 execution-time preflight；P2-UX-HEALTH：Web health 与凭据握手耦合，UI 只展示 available/unavailable；P2-PROCESS-02：#27 依赖/milestone/owner 未平台化 |
| DSH alpha.4 对齐复核 | **报告 §11 结论准确，锚点零漂移** | upstream HEAD = `dsh-v0.1.2-alpha.4`；`tool-web.config.fetch` alpha.3 `false` → alpha.4 `true`（默认启用 web_fetch，不经 approval）；Tekon 依赖的 4 个合同锚点（Headless one-shot、help anchor `print the final assistant message`、5 个 plugin row ids、Node engines `^22.19.0 \|\| >=24.0.0`）在 alpha.3→alpha.4 间均无变化；alpha.4 有 ACP 包（`packages/acp/`），报告"Collaborate 应优先做 ACP vertical slice"有 upstream 依据 |
| 测试与 CI 健康 | **全绿，报告 §10 判断准确** | 本地 `pnpm test`：140 文件 / 1518 passed / 3 skipped（L2 DSH probe 无 `DSH_CLI_PATH`）；PR #11 CI 7 项全绿；`main` 确认未保护（`gh api` 返回 404 Branch not protected）；无真实 JS/TS static lint gate（三个子包 `lint` 脚本均为 `tsc --noEmit` 别名，全仓无 eslint/biome/oxlint 依赖） |

四路对本报告的裁决无异议：reviewer 的 2 项 P2 修复方向正确、落地完整；3 个新增 P2 项真实存在但不适合在 PR #11 内修复；alpha.3 tested pin 维持 fail-closed 合理。

### 17.2 本轮决策

1. **P2-DSH-CMD 留独立 issue**：`isRealDshCommand` 的 basename 推断被 adapter 测试大量依赖（fake command 路径），修复需重构测试注入结构（如显式 `skipPreflight` 选项或环境变量标记），不适合在已超百提交的 PR #11 内进行。
2. **P2-UX-HEALTH 留独立 issue**：Web health 与凭据握手解耦涉及前后端契约变更，需独立设计。
3. **P2-PROCESS-02 留独立 issue**：#27 平台化（subissue/milestone/owner）是 GitHub 治理操作，不阻塞代码合并。
4. **PR #11 合并建议**：同意报告 §14 建议，本轮批注追加后即可 squash merge；合并后按 §14 顺序从 #16（single-owner daemon）开始推进独立 PR。

### 17.3 验证承诺

本轮批注为纯文档追加，不改变代码行为。批注追加后将重新执行 `pnpm test` 确认无回归，并推送到 PR #11。
