# Tekon 产品、UI/UX、Runtime 与 DeepSeek Harness 第十轮全面复审

- **日期**：2026-08-31
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **上一轮权威快照**：`fafef36680eee9fc74e5ef75f058fdbe4528395d`
- **用户 v0.20.0 整改快照**：`1f3a1695c5dc61122a6faaba20ce2d12dce0aa11`
- **本轮 reviewer 代码快照**：`11eecfb6347c5fe690a8561c5e49a344a30de317`
- **产品版本**：`0.20.0`
- **Tekon 的 DSH tested pin**：`0.1.2-alpha.1`
- **DeepSeek Harness 当前官方基线**：master `0a53fb55bea101816fa226bb964ae2bed71c343b`，最新发布 `dsh-v0.1.2-alpha.2`
- **代码自动化状态**：`11eecfb...` 的 Core #331 与 CI #240 均为 `completed/success`；Root、CLI unit/e2e、Web build/typecheck/unit、Playwright 全部成功
- **裁决**：v0.20.0 整改与本轮低风险修复通过代码合并门；Tekon 整体仍未通过“面向普通人的稳定持续协作研发工作台”验收

## 1. 执行摘要

v0.20.0 对上一轮长 Session 和 DSH 合同问题做了实质整改，而不是只修改文档：

1. Session 历史读取从用 `sinceSeq` 模拟向前翻页，改为真正的 `beforeSeq` 反向游标，并增加 `nextBeforeSeq` continuation；
2. Session SSE 对慢客户端的 pending buffer 增加事件数和字节双上限；
3. `replay-truncated` 进入可见 UI 提示；
4. DSH tested pin 从 `0.1.1-rc.2` 升到 `0.1.2-alpha.1`，并更新 preflight fixture；
5. 对历史分页、截断、背压和 dsh preflight 增加自动化覆盖。

这些方向整体正确，长会话的 DB/API/SSE/client 边界明显比第九轮完整。但代码级复核仍发现三类真实缺陷，以及一项已经变化的外部事实：

- **SSE 重连预算被错误地当成整条连接的累计预算**：首次 reconnect backlog 已经追平后，后续正常的跨进程实时事件仍继续累计；健康长连接在累计超过 2000 个事件或 4MB 后会被误判为“重连历史过大”并截断。
- **历史提示的产品语义不准确**：无业务事件时，截断 banner 因早返回而不可见；页面最多只额外保留 2000 条更早事件，却使用了接近“完整历史/最早历史”的表述。
- **DSH config 合同可能假阳性**：fixture 使用了不存在于官方组合树的行 id `user-approval`；旧实现只做任意子串检查，包名 `@deepseek-ai/dsh-user-approval` 可以在实际 `id: approval` 被改坏时仍让合同测试通过。
- **外部基线已变化**：用户提交时将 `0.1.2-alpha.1` 称为当前官方版本，但 DeepSeek Harness 已于 2026-08-30 13:52 UTC 发布 `0.1.2-alpha.2`。Tekon 继续精确 pin alpha.1 可以成立，但必须称为“tested pin”，不能称为“官方当前版本”。

本轮已直接修复前三类代码问题，并补回归测试；外部版本差异在本报告和当前权威入口中纠正。没有把 single-owner daemon、Session 事实源、ACP 集成等架构级工作强行塞进当前 PR。

## 2. 最终判断

### 2.1 当前 PR 增量

`11eecfb6347c5fe690a8561c5e49a344a30de317`：

- Core #331：`completed/success`；
- CI #240：`completed/success`；
- Root build/typecheck、installer syntax、CLI unit/e2e、Web build/typecheck/unit、Playwright 均成功。

因此，**v0.20.0 用户整改与本轮 reviewer 低风险修复通过当前代码合并门**。

### 2.2 产品成熟度

当前最准确的产品表述是：

> Tekon v0.20.0 是测试覆盖较强、执行计划和风险边界较透明、长会话观察能力开始有界的实验性受控交付执行与观察基础设施；Deliver 轨道可在有人监督下试用，但持续协作、单一 Runtime 权威、权威 Session 事实链、可证明的 shutdown/restart 和模型上下文预算尚未闭环。

仍不应将其描述为：

- 面向普通用户的稳定持续协作研发工作台；
- Web/CLI 多进程并发安全的本地 Agent Runtime；
- 拥有 crash-safe durable inbox 和完整模型历史恢复的 Session 平台；
- 已完成任意规模长会话、生产级 shutdown 和 restart resume 的服务；
- 可将 DeepSeek Harness sandbox 作为唯一生产安全边界的系统。

## 3. 评审范围与方法

本轮覆盖：

- 根目录 README、CHANGELOG、版本、安装和产品定位；
- Core 的 RunPlan、Workflow、Session、JobRunner、数据库、Provider、CommandGateway、DSH bridge；
- CLI 的 run、provider preflight、Session composition root、恢复和退出语义；
- Web 默认入口、高级入口、Session 历史、SSE、EventFeed、连接状态和配置 UI；
- v0.20.0 相对第九轮权威快照的全部新增文件；
- 仍未关闭的 P0/P1 主链路；
- PR 当前 GitHub Actions 终态；
- DeepSeek Harness 当前 master、alpha.2 release、Safety、Headless、SDK client、ACP server 和默认组合配置。

判断原则：

1. “已闭环”必须同时检查输入、持久化、执行、恢复和失败路径；
2. “有界”必须同时考虑数据库、API、传输、服务端缓冲、浏览器内存、DOM 和模型上下文；
3. fake fixture 必须模拟真实外部合同，而不是让生产解析器迁就错误 fixture；
4. 测试绿色不等于真实 Provider、跨进程、屏幕阅读器或生产故障注入已经完成；
5. 架构问题不通过局部 wrapper 或文档措辞制造关闭假象。

本轮没有可访问的独立部署实例，因此 UI 结论来自源码、响应式实现、ARIA/Playwright 合同和现有截图记录；不声称完成新的像素级、Firefox/WebKit 或屏幕阅读器实测。

## 4. 对 v0.20.0 整改的逐项裁决

| 整改项 | 裁决 | 理由与边界 |
| --- | --- | --- |
| 真正的 `beforeSeq` / `nextBeforeSeq` | 基本关闭 | 数据库按 seq 反向取页，API 对不可见事件继续扫描并返回 continuation；不再用 forward cursor 猜测更早历史。 |
| SSE pending event/byte cap | 基本关闭 | 慢客户端不再无界堆积；超限发送截断控制帧并关闭，让客户端重连到尾窗。workspace summary SSE 仍未共享同等级背压状态机。 |
| reconnect 事件/字节预算 | 本轮修复后关闭直接缺陷 | 预算现在只覆盖首次 reconnect backlog；追平后正常跨进程事件不再累计到重连预算。 |
| 截断提示 | 本轮修复后基本关闭 | banner 即使当前没有业务事件也可见；明确页面额外保留上限为 2000 条，不再暗示已到达会话起点。 |
| DSH alpha.1 pin | 部分完成 | 精确 tested pin 与 fail-closed 方向正确；当前官方最新已是 alpha.2，且仍缺带真实 API key 的 L2 smoke。 |
| DSH config fixture/contract | 本轮修复后基本关闭 | 使用官方组合树真实行 id `approval`；生产 YAML 通过完整 `id:` 行匹配，不再由包名子串假通过。测试层仍保留少量 bare-line 兼容 seam，后续应统一 fixture 后删除。 |

## 5. 本轮 reviewer 直接修复

### 5.1 修复连接生命周期内的假截断

原状态：

```text
连接携带 Last-Event-ID
→ 首次 backlog 计入 RECONNECT_MAX_*
→ backlog 已追平
→ 后续每轮 SQLite catch-up 仍继续计数
→ 累计超过预算后误发 replay-truncated
```

修复后：

```text
首次 reconnect-owned backlog 使用预算
→ backlog 追平
→ 预算关闭
→ 后续跨进程事件按 live traffic 处理
```

新增测试在首次 reconnect 只补 1 条历史后，再通过 SQLite catch-up 推入超过 `RECONNECT_MAX_EVENTS` 的正常事件，证明不会产生 `replay-truncated`。

### 5.2 让历史边界提示与实际保留策略一致

修复内容：

- truncation banner 移到空状态判断之外；
- 文案从“完整历史仍可加载”改为“可以按页加载更早记录，但本页最多额外保留 2000 条”；
- reached limit 按钮改为“已达本页历史上限”；
- tooltip 明确“达到上限不等于已加载最早历史”；
- 新增空事件截断和页面上限 SSR 测试。

### 5.3 修复 DSH 配置合同的 row-id 假阳性

DeepSeek Harness alpha.1/alpha.2 默认组合实际为：

```yaml
- id: approval
  name: '@deepseek-ai/dsh-user-approval'
```

用户 fixture 使用 `user-approval` 作为 id，生产校验又只做 `dumpOutput.includes(id)`；这会把 package name 当作 row id。修复后：

- required id 改为官方真实的 `approval`；
- 正式 dump 必须存在完整 YAML `id:` 行；
- fixture 与 CLI/Web fake dsh 均输出真实 YAML 行；
- 增加“package name 含 user-approval 但 id 缺失时必须失败”的测试；
- fixture 注明它是基于官方 source composition 的摘录，不冒充本机真实 dump。

### 5.4 保持 tested pin 与 latest upstream 两个概念分离

本轮没有把 Tekon pin 直接提升到 alpha.2。原因：精确 pin 的目的正是只声明实际验证过的版本；alpha.2 虽已发布，但未经 Tekon contract fixture 更新和真实 Provider smoke，不应因“最新”而自动放行。

正确状态是：

```text
Tekon tested pin = 0.1.2-alpha.1
upstream latest = 0.1.2-alpha.2
```

## 6. 产品逻辑与 UI/UX

### 6.1 已明显改善

- 默认 Session 入口诚实声明会启动完整受控交付，不伪装为轻量聊天；
- Workflow run 必须拿到服务端计划和 digest 才能启动；
- DSH Goal-only、联网不受限和 experimental 边界可见；
- Session 历史现在具备真实反向 cursor、服务端缓冲上限和截断提示；
- 失败会话、待审批和待输入具有可行动状态；
- 两个配置详情 dialog 已具备名称、焦点陷阱、Escape、焦点恢复和背景 inert；
- 连接健康不再把 dsh 可用性泛化成全部 Provider 健康。

### 6.2 仍未形成的人类主路径

普通用户仍无法在同一 Session 中完成：

```text
继续输入
→ 观察真实 Provider execution-time stream
→ follow-up / steer / prompt cancel
→ 刷新或进程重启后恢复
→ 显式升级为 Deliver
```

因此当前 Session UI 主要是运行观察、审批和治理界面，而不是持续协作界面。

### 6.3 仍需继续收敛的体验问题

- Token 仍是普通用户需要理解和管理的技术凭据；
- Session、Run、Profile、Gate、Artifact 等术语仍大量进入默认路径；
- replay truncation 现在可见，但没有提供导出完整历史或切换到离线审阅的直接动作；
- 页面历史上限是内存/DOM 策略，不是会话事实的永久删除，需要在帮助文案中长期保持这个区分；
- 全站审批弹窗、Drawer、动态播报、对比度、Firefox/WebKit 和屏幕阅读器仍未专项验收。

## 7. 整体框架与 Runtime 架构

### 7.1 P0：repo 级单一 Runtime owner 仍缺失

CLI 与 Web 仍分别构造 SQLite connection、WriteQueue、JobRunner、SubprocessRegistry、Workflow executor 和 shutdown 生命周期。Job owner/lease/CAS 能减少重复 claim，但无法完整 fence：

- Git/worktree 创建和 promotion；
- Artifact、Gate、Audit；
- Automation 与 Delivery；
- 普通文件写入；
- process-local Provider/子进程。

建议仍是：

```text
repo-scoped daemon/service
→ repo lock
→ Web/CLI 仅作为客户端
→ 统一 Job、Git、DB、Provider、Automation 和 shutdown 所有权
```

### 7.2 P0：shutdown 仍不是可证明的 quiescent shutdown

当前 stop 有 settle window、abort/kill、hard deadline 和 DB closed fence。它能防止无限等待，并让迟到数据库写快速失败，但 hard deadline 后不合作 executor 仍可能：

- 继续执行 JS；
- 写普通文件；
- 运行 Git；
- 持有未注册子进程；
- 在外部 SDK 内继续工作。

真正闭环仍需要 executor process/worker 隔离、真实 kill/join、checkpoint 和 restart recovery。

### 7.3 P0：Session Event 仍不是权威事实源

Dual-write 仍允许找不到 Session 时跳过，append 失败时只报告错误，未知或未映射领域事件不进入 Session log。因此它适合 UI projection，但不能独立承担：

- 模型完整历史；
- durable user inbox；
- prompt claim / processed；
- crash replay；
- fork/resume；
- restart recovery。

下一步必须在 authoritative Session log、transactional outbox 或“领域表权威、Session 仅展示投影”之间做明确 ADR。

### 7.4 P0：Collaborate vertical slice 仍不存在

`LegacyAgentDriver.events()` 仍等待 one-shot run 完成后才遍历缓存；`followUp`、`steer`、`resume` 仍抛 `NotSupportedYet`。横向的 Profile、Automation、Goal、Driver 和 Provider registry 不能替代这条纵向链路。

## 8. RunPlan、数据与长会话

### 8.1 RunPlan 仍是审计快照，不是执行/恢复唯一输入

当前 Web 校验与持久化已经使用同一份 canonical plan，但 snapshot 尚未完整绑定：

- Demand version/hash；
- base revision；
- workspace physical identity；
- 网络确认事实；
- resolved Provider config；
- expected artifacts；
- 实际 executable plan。

`executePreparedRun` / resume 仍主要读取旧 execution plan 和 provider snapshot，而不是从 canonical RunPlan 重新建立并验证所有执行条件。

### 8.2 长 Session 仍有后续预算工作

v0.20.0 关闭了最直接的 cursor 和缓冲问题，但还未覆盖：

- workspace summary SSE 的 backpressure/slow-client 边界；
- 模型上下文 summary/compaction；
- complete-history export 或离线审阅路径；
- 长会话历史与 Agent prompt context 的统一 retention policy；
- 全链路字节预算和可观测指标；
- 高密度长会话的真实浏览器/真实数据库基准。

页面额外保留 2000 条是合理的 UI 内存边界，但不能被解释为模型上下文或持久历史已经有界。

### 8.3 数据完整性

Session 子表 cascade FK、table rebuild 和 orphan quarantine 基本关闭上一轮数据问题。后续仍建议加入：

- migration 后 `foreign_key_check`；
- quarantine 表 schema/version 标记和清理说明；
- 大库迁移耗时、磁盘空间和回滚测试；
- sessions.run_id 与 workflow_instances 的正式引用策略。

## 9. DeepSeek Harness 最新对齐

### 9.1 当前版本事实

- Tekon tested pin：`0.1.2-alpha.1`；
- DeepSeek Harness 最新正式 prerelease：`0.1.2-alpha.2`；
- alpha.2 包含连接失败重试、长历史/密集实时消息性能、焦点恢复和 `SessionEvent.ignorable` 恢复等变化。

因此 alpha.1 可以继续作为精确兼容版本，但文档不得再把它称为最新官方版本。

### 9.2 Node 合同存在可用性断层

Tekon 根合同允许 Node `^20.19.0 || >=22.12.0`，而 DeepSeek Harness alpha.1/alpha.2 根合同要求 `^22.19.0 || >=24.0.0`。这意味着：

- Tekon 主体可以在 Node 20 运行；
- 可选的 dsh-headless provider 在同一环境中可能无法安装或启动；
- `tekon provider preflight dsh-headless` 的安装指引还应明确 DSH 自己的 Node 前置条件。

该问题不需要提高 Tekon 全局最低 Node 版本，但需要 Provider-specific preflight/文档说明。

### 9.3 Headless 继续保持 Goal-only 是正确方向

官方 headless 合同仍是一项任务、输出最终回答、随后退出；没有 interactive follow-up，中间 reasoning 进入 stderr，首 token 前没有 heartbeat。因此不应继续扩展 one-shot adapter 来模拟持续协作。

### 9.4 ACP 更匹配下一阶段纵向切片

官方 ACP 已公开 persistent session、list/resume/close、semantic updates、prompt cancel、permission request 和 quiescent close。SDK 适合 TypeScript owned subprocess 和事件采集，但当前官方仍明确没有 mid-turn cancel。

建议优先做一个独立 ACP vertical slice：

```text
persistent session
→ one prompt
→ execution-time updates
→ prompt cancel
→ close
→ process restart + resume
```

在该切片验证前，不继续扩大 `LegacyAgentDriver` 或 one-shot adapter 抽象。

### 9.5 安全边界

DeepSeek Harness 官方仍明确属于未经安全审计的 developer preview；sandbox、approval 和 permission controls 只能降低风险，不能保证隔离。Tekon 必须继续使用最小权限、容器/VM、credential scrub、workspace scope、人工副作用 gate、备份和审计，不能把 Harness 当作唯一安全控制。

## 10. 代码实现与测试质量

### 10.1 正面评价

- cursor、digest、FK、provider preflight 和 connection cache 均有较强测试；
- CommandGateway 继续使用 argv 执行，不依赖 shell；
- secret redaction、artifact manifest 和 progress evidence 有回归保护；
- SSE replay/live race 使用 seq 连续前缀处理；
- 本轮新增测试证明正常后续事件不会被重连预算误截断；
- 最终 Core/CI/Playwright 在相同 code snapshot 上完整成功。

### 10.2 仍需收敛的测试结构

fake dsh 目前分散在 Core、CLI unit、CLI e2e 和 Web API 测试中，曾产生 JSON/YAML、`approval`/`user-approval` 和裸行/组合树多套形状。生产解析器本轮保留了有限的 bare-line probe compatibility 以兼容旧 adapter unit seam。

后续应建立一个共享的 `fake-dsh-contract` fixture：

- 唯一版本字符串；
- 唯一 help anchor；
- 唯一 composed YAML dump；
- 可参数化缺失 row、版本漂移和进程错误；
- 完成迁移后移除生产 parser 的 bare-line 测试兼容分支。

### 10.3 PR 可审阅性已经成为独立风险

当前 PR 已超过 60 个提交、150 个变更文件和 2 万行新增。即使每一轮 CI 都绿色，这个体量仍会降低：

- 人工逐行审阅质量；
- 二分定位和回滚能力；
- schema migration 与产品改动的独立验证；
- 合并冲突和发布风险可控性。

由于本轮明确要求继续使用同一 PR，没有另起 PR；但合并时建议使用 squash，并在后续工作中严格按 daemon、Session 事实源、ACP vertical slice、历史预算拆分独立 PR。

## 11. 过度实现与过度设计判断

当前横向抽象已经包括：

- AgentAdapter / AgentDriver / LegacyAgentDriver；
- Provider Registry；
- JobRunner；
- Session projection / dual-write；
- Profile；
- Automation；
- Goal；
- Readiness；
- Delivery；
- CLI/Web 两套 composition root；
- 多轮 remediation plan 与评审报告。

这些机制不少本身合理，但仍领先于最小持续协作用户闭环：

```text
同一 Session 继续输入
→ Agent 执行中产生真实事件
→ 用户取消或转向
→ Runtime 重启后恢复
→ 升级到 Deliver
```

冻结原则：除非直接服务 single-owner、authoritative Session、真实 Provider streaming、follow-up/cancel/resume、Collaborate → Deliver 或模型上下文预算，否则暂停新增 Profile、Automation job、Driver wrapper、展示事件和 Workflow 语法。

评审过程也应继续收敛：`current.md` 为稳定入口，第十轮报告为当前详细裁决，旧报告只读归档，CHANGELOG 只记录用户可见行为；本轮没有继续把 reviewer 过程追加到 CHANGELOG。

## 12. 问题清单

| ID | 严重度 | 状态 | 问题 |
| --- | --- | --- | --- |
| P0-ARCH-01 | P0 | 未关闭 | CLI/Web 缺 repo 级单一 Runtime authority。 |
| P0-ARCH-02 | P0 | 部分完成 | stop 有 hard deadline 和 DB fence，但不保证 executor/Git/files/SDK 已 quiescent。 |
| P0-DATA-01 | P0 | 未关闭 | Session Event 仍是 best-effort projection，不是 durable inbox/权威模型历史。 |
| P0-PRODUCT-01 | P0 | 未关闭 | Collaborate、真实 streaming、follow-up、steer、prompt cancel、restart resume 未闭环。 |
| P1-PLAN-01 | P1 | 部分完成 | canonical RunPlan 尚未成为 execute/resume 唯一事实。 |
| P1-SESSION-01 | P1 | 部分完成 | cursor/缓冲直接问题已修；workspace SSE、模型 compaction、完整历史导出和真实规模基准仍缺。 |
| P1-DSH-01 | P1 | 部分完成 | tested pin 为 alpha.1，upstream 已 alpha.2；缺真实 smoke，且 DSH Node 前置与 Tekon 主合同不同。 |
| P1-A11Y-01 | P1 | 未关闭 | 两个 dialog 已闭环，不能外推为全站 screen reader、多浏览器和对比度验收。 |
| P1-PROCESS-01 | P1 | 未关闭 | PR 体量过大，审阅、二分和回滚风险高。 |
| P2-SSE-01 | P2 | 本轮修复 | reconnect budget 错误累计正常 live catch-up。 |
| P2-UX-01 | P2 | 本轮修复 | 空事件隐藏 truncation banner，页面上限文案暗示完整历史。 |
| P2-DSH-01 | P2 | 本轮修复 | DSH config row id 与官方组合不一致，substring 校验可假通过。 |
| P2-TEST-01 | P2 | 待收敛 | fake dsh fixture 分散，生产 parser 暂保留 bare-line test seam。 |

## 13. 建议实施顺序

1. **single-owner daemon + repo lock**  
   统一 Job、Git、worktree、subprocess、DB、Automation 和 shutdown 所有权。

2. **executor 隔离 + quiescent shutdown/restart contract**  
   worker/process、真实 kill/join、checkpoint、late-write 故障注入。

3. **authoritative Session log / transactional outbox + durable inbox**  
   明确事实源、claim、processed、retry、模型历史和迁移。

4. **DeepSeek ACP real-provider vertical slice**  
   persistent session、execution-time updates、prompt cancel、close、restart resume。

5. **Collaborate → Deliver**  
   同一 Session follow-up/steer，计划升级和人工审批点。

6. **canonical RunPlan 成为 execute/resume 权威**  
   绑定需求、base/workspace、Provider、权限、网络、Artifacts 和 executable plan。

7. **全链路历史和模型上下文预算**  
   DB/API/SSE/workspace summary/client/DOM/export/compaction 一体化。

8. **测试 fixture、数据与可访问性专项**  
   统一 fake dsh、迁移检查、全站 screen reader、多浏览器和对比度。

## 14. 合并与发布边界

本轮代码门通过只能证明：

- 当前增量在现有测试合同下可构建、类型正确并通过自动化；
- v0.20.0 的历史 cursor、缓冲上限和 DSH preflight 方向有效；
- reviewer 修复没有引入新的已知阻断回归。

它不能证明：

- Web/CLI 两个 Runtime 并发无副作用冲突；
- 服务关闭后所有文件/Git/SDK 工作都已终止；
- Session log 可完整恢复模型上下文；
- 任意规模会话都有稳定资源预算；
- DSH alpha.2 已被 Tekon 兼容；
- 普通用户持续协作产品和全站可访问性已经完成。

在当前 PR 体量下，建议最终采用 squash merge，并将后续架构主链路拆成独立 PR。本轮未执行 merge、release 或 deploy。

## 15. 参考资料

### Tekon

- [当前权威入口](current.md)
- [Runtime authority ADR](../technical/adr-0001-runtime-authority-and-collaborate.md)
- [第九轮报告](2026-08-30-tekon-human-first-harness-ninth-review.md)

### DeepSeek Harness 官方

- [Safety](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/SAFETY.md)
- [Headless](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/bundle/headless/README.md)
- [SDK client](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/sdk/client/README.md)
- [ACP server](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/acp/acp/README.md)
- [Base composition](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/bundle/base/cordis.patch.yml)
- [Default-config dump contract note](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/.agents/notes/archived/feature/2026-07-30-dsh-dump-config.md)
- [dsh v0.1.2-alpha.2 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.2)
