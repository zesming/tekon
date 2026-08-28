# Tekon 人类可用性与 Harness 架构全面复审

- **复审日期**：2026-08-28
- **基线**：`main@300aea6b9ea5c805303e7e1d302dadabc5531548`
- **复审分支**：`review/human-first-harness-2026-08-28`
- **对应 PR**：#11
- **结论**：**不通过“面向普通人稳定可用”验收；可作为实验性基础设施里程碑有条件通过。**

> 本报告不是对第十四轮报告的简单重复。此前复审主要验证 replatform 切片是否自洽；本轮从用户为什么要用、如何第一次用、会不会持续用，以及 Harness 式复杂度是否换来了相称收益重新审查。

## 1. 执行摘要

Tekon 当前已经形成一套测试较强、边界说明较诚实、治理意识较好的本地交付框架，但产品主路径仍然是“一次性启动完整交付 workflow，然后观察结果”。它还不是一个人类可以自然进入、持续追问、随时纠偏、逐步升级到受控交付的研发工作台。

本轮最重要的判断有四个：

1. **产品合同与界面命名错位**：界面叫 Session，默认入口却启动 PM/RD/QA/Reviewer 完整链路；会话内没有 follow-up、steer、durable inbox 或真实 provider streaming。用户看到的是会话外观，实际得到的是一次性 run 观察器。
2. **架构复杂度与收益不对称**：项目已经承担 Session/Event/Job、Profile、Automation、Goal、DSH bridge、兼容驱动和双写投影的维护成本，但 Session log 不是事实源、AgentDriver 不能持续会话、后台执行也没有单一所有者。
3. **Runtime 安全边界仍不成立**：Web 与每个 CLI 进程都可启动 JobRunner 并竞争同一 SQLite/Git 工作区；停止过程最多等待 5 秒后清理进程内状态，缺少持久执行权、全副作用 fencing 与真正 quiescence。
4. **人类入口可以立刻改善**：无参数执行原本返回错误，帮助页先给命令清单，CLI 显示内部包版本而 updater 使用根版本。本 PR 已修复这三项低风险问题。

因此，本轮不建议继续横向增加 Profile、Automation、Goal、更多事件类型或新的兼容层。下一阶段应先完成一个最小但完整的“人类提出问题 → 看到真实流式过程 → 继续追问/转向 → 明确升级为 Deliver → 可恢复”的纵向闭环。

## 2. 复审范围与方法

### 2.1 范围

本轮对以下区域做了仓库级结构审查，并对关键路径做了代码级深读：

- 产品与使用说明：`README.md`、`docs/manual/`、`docs/technical/`、最近十四轮 `docs/reviews/`。
- CLI：入口、帮助、初始化、运行、UI 启动、版本读取、测试。
- Web：路由、Session 列表/详情、Composer、EventFeed、Token、RPC/SSE、运行入口。
- Core：Session store、Job runner、SessionService、dual-write、AgentDriver、Step event 投影、DSH adapter、Profile/Automation。
- 工程治理：CI、版本规则、测试组织、发布说明。
- 外部基线：DeepSeek Harness 官方架构、Agent lifecycle、Persistence、Safety、最新 prerelease；CLI Guidelines。

这不是“逐行看完每个文件”的声明，而是覆盖整个仓库结构、再对决定产品和架构结论的关键路径做深入核验。

### 2.2 UI 审查限制

本轮报告初稿撰写时没有可访问的已部署 Tekon 实例，也未采集浏览器截图，因此原始范围如下：

- 已审查：信息架构、状态语义、交互闭环、可访问性代码、响应式实现、错误文案和数据流。
- 未声称完成：基于当前浏览器截图的像素级视觉、动效、实际焦点顺序和跨尺寸渲染审计。

任何静态审查结论都限定为实现审查，不冒充截图实测。

> **补充（本轮落地后）**：针对本轮实际改动的 P1-04 Session 列表，已在本地用 Playwright 完成桌面 1440px 与移动 390px 的真实浏览器截图核验（见 §11）。该补充仅覆盖 P1-04 触及的列表 UI，不扩展为对全站的跨尺寸像素级审计。

## 3. 外部基线带来的关键判断

### 3.1 DeepSeek Harness 的核心不是“多一些事件名”，而是单一可回放事实链

官方架构明确区分：

- Session events：需要跨重载存活的 durable facts。
- Agent events：运行中的协调与控制。
- Session log：模型上下文、回放、fork、resume、transcript 与 persistence 的来源。
- 模型可见内容必须可由 log 重建。

参考：

- [DeepSeek Harness Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [Agent Turn And Step Lifecycle](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/agent-lifecycle.md)
- [Session Persistence](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/persistence.md)

对 Tekon 的判断依据：当前 `session_events` 是旧领域写入之后的 best-effort projection，旧表仍是事实源，因此只获得了“统一观察表面”的一部分价值，没有获得 Harness 的上下文重建、可靠 replay、持续 inbox、fork/resume 和一致持久化收益。

### 3.2 Harness 现在不只有 headless CLI

官方架构当前列出 `web`、`headless`、`sdk`、`sdk-minimal` 和 `acp` profiles；SDK 使用 JSON-RPC，ACP 也已补齐会话控制、权限和取消等能力。2026-08-27 发布的 `dsh-v0.1.2-alpha.1` 还继续增强了会话草稿排队、回合导航、token 用量和会话恢复体验。

参考：

- [DeepSeek Harness Architecture / Profiles](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md#profiles-and-bundles)
- [dsh v0.1.2-alpha.1 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.1)

对 Tekon 的判断依据：`packages/core/src/runtime/dsh-bridge-probe.ts` 仍把 headless argv/stdout 描述为 rc 包唯一文档化的机器接口，并固定 `0.1.1-rc.2`。精确版本 fail-closed 本身是正确的，但其边界说明已过时，下一步应重新评估 SDK/ACP，而不是继续扩展一套 goal-only、one-shot 的 headless ACL。

### 3.3 Harness 不能成为安全隔离的替代品

官方 Safety 明确说明项目尚未经过安全审计，sandbox、approval 和 permission 不能保证隔离。

参考：[DeepSeek Harness Safety](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)

对 Tekon 的判断依据：当前 dsh-headless adapter 已诚实承认网络出口不受限；这项边界必须继续作为产品级警告，不能因接入官方 Harness 而降低 Tekon 自己的最小权限、容器化和凭证隔离要求。

### 3.4 CLI 应把人类路径放在命令清单之前

[Command Line Interface Guidelines](https://clig.dev/) 强调 human-first、可发现性、示例和可行动错误；无参数通常应显示简洁帮助，而不是把第一次探索当成错误。

对 Tekon 的判断依据：原实现 `runCli([])` 返回 1 且只写两行 stderr，帮助页先展示二十多个命令分组。对一个复杂产品，这会把框架内部结构直接暴露给新用户。

## 4. 做得好的部分

这些部分应保留，不建议为了“重构得更像 Harness”而推倒重来：

1. **测试与 CI 基础扎实**：Core、CLI、Web unit/build/typecheck 和 Playwright 都有独立门；最近 replatform PR 的既有 CI 全绿。
2. **边界文档诚实**：README 和 current-scope 已明确写出非真实 streaming、无 follow-up/steer、projection-only、multi-owner 等限制，避免了虚假成熟度。
3. **高风险副作用仍受控**：PR 创建需要显式人工批准，dirty base、token/origin、scope 和多处 CAS 有明确保护。
4. **Web 已从纯 cockpit 向 Session-first 迈进**：默认路由、叙事事件过滤、侧栏收敛、移动端和基础可访问性改进方向正确。
5. **代码注释和状态边界总体清楚**：复杂兼容逻辑大多说明了为什么存在，便于后续拆除。

这些优点说明 Tekon 不是“需要重写的失败项目”，而是“基础设施已经超过产品闭环，下一步必须反向收敛”的项目。

## 5. 必须解决的问题

### P0-01：Session 产品合同不成立

**事实**

- `packages/web/src/client/pages/SessionsPage.tsx` 的主要动作是启动“受控交付”。
- `SessionComposer.tsx` 只创建新 run，不在当前 session 中发送 follow-up。
- `legacy-agent-driver.ts` 的 `followUp`、`steer`、`resume` 均抛 `NotSupportedYet`。
- `agent-step-events.ts` 在 `runAgent()` 完成后才合成 step/tool/assistant 事件，不是 provider 执行期流式事件。
- 默认模板是 `standard-delivery`，不是轻量协作。

**为什么是问题**

“Session”通常向用户承诺可持续上下文、连续输入和可恢复互动。当前产品只能启动并观察一次性交付，界面语义高于真实能力，会造成期望落差。

**影响**

- 人类仍需回到外部 Agent 工具完成澄清和迭代，Tekon 只承担后半段治理。
- 首次小任务也被迫理解角色、workflow、gate、delivery 等内部概念。
- 产品无法证明“增强人类”的核心价值，只能证明“自动跑一次流程”。

**建议**

建立两个显式轨道：

- **Collaborate**：轻量、连续、默认无 PR 副作用；支持真实 streaming、durable inbox、follow-up、steer、取消、恢复。
- **Deliver**：从 Collaborate 或结构化需求卡显式升级，进入角色、gate、artifact、PR 准备链路。

在 Collaborate 未实现前，Web 主导航建议把“Session”降级为“Runs/运行记录”，避免过度承诺。

### P0-02：Runtime 没有单一执行所有者

**事实**

- `packages/web/src/server/api/root.ts` 启动一个 JobRunner。
- `packages/cli/src/lib/session-context.ts` 每次 CLI run/resume 也创建 JobRunner。
- CLI 注释明确承认它可能领取 Web 留下的 automation job。
- 多进程共享 SQLite、Git worktree 和运行目录。
- 当前没有 repo/runtime lock、持久 `claim_generation` 或覆盖所有副作用的 fencing token。

**为什么是问题**

数据库层抢到 job 不代表某一进程对 Git 分支、worktree、文件产物、子进程和终态写入拥有持续权威。进程停顿、恢复或网络/磁盘延迟后，旧 owner 仍可能继续写。

**影响**

- 同一 run 可能被不同进程交错推进。
- 已取消或被新 owner 接管的旧执行仍可能写 artifact、Git、状态或审计。
- “单机本地”不能消除并发；Web + CLI 已经构成真实多 owner。

**建议**

优先选择最简单的方案：**single-owner daemon**。

- 一个 repo 只有一个持久 runtime owner。
- Web 和 CLI 都通过本地 RPC/Unix socket 调用它。
- 第二 owner fail-fast，并给出 owner PID、启动时间和恢复命令。
- 只有在明确需要多 owner 后，才引入 generation lease、全副作用 fencing、失效检测和抢占协议。

### P0-03：Shutdown 不是 quiescent shutdown

**事实**

`packages/core/src/session/job-runner.ts` 的 stop 最多等待约 5 秒，随后清除 controller、token 和 flag；它没有证明执行器、子进程、Git/文件写入和异步 listener 都已停止。Web composition root 虽跟踪部分 automation task，但无法替代完整执行器 join。

**为什么是问题**

清空进程内引用不等于工作停止。数据库关闭或新 owner 启动后，旧异步路径可能继续写，形成 late write 和错误终态。

**建议**

定义并测试明确的 shutdown contract：

1. 停止领取新 job。
2. 持久标记当前 job 为 cancelling/paused。
3. abort provider，并终止所有注册子进程。
4. 等待 executor、事件持久化、审计 hash、artifact/Git 写入全部 settle。
5. 超时则保持 owner lease，不允许新 owner 无条件接管；或以 generation 失效使旧写入全部被拒绝。
6. 最后关闭 DB 和事件总线。

### P0-04：事实源分裂，dual-write 不是事件架构

**事实**

- `packages/core/src/session/dual-write.ts` 先写旧表，再 best-effort 投影 session event。
- 投影失败被记录但不回滚主写入。
- `workflow_instances`、`jobs`、gate、artifact、audit 等旧领域表仍决定业务状态。
- `session_events` 不能可靠重建 run，也不是模型上下文的来源。

**为什么是问题**

系统同时维护两套词汇和时序，却没有明确一致性协议。它既不是经典 event sourcing，也不是可靠 transactional outbox，而是可丢失的 UI projection。

**建议**

短期不要宣称“event log 架构完成”。采用明确分层：

- Workflow/Governance 表继续作为交付事实源。
- Session log 只作为对话、inbox、真实 provider/tool 流的权威事实源。
- 两者通过同一 SQLite 事务中的 outbox/link event 关联，异步投影可重放。
- 未做 ADR 前，不再新增“看似 authoritative、实际 best-effort”的跨域事件。

## 6. 重要但可分阶段处理的问题

### P1-01：DSH bridge 已漂移，收益不足以覆盖维护成本

**事实**

- `dsh-headless-adapter.ts` 是较大的 one-shot 适配器，只取最终 stdout。
- 仅 goal 可用，不能可靠写 Tekon 交付 artifact。
- 网络不受限。
- `dsh-bridge-probe.ts` 精确固定 `0.1.1-rc.2`，而官方最新 prerelease 已是 `0.1.2-alpha.1`。
- 官方现在有 SDK/JSON-RPC 与 ACP profile。

**判断**

版本精确 pin 和 capability probe 是稳健做法；问题不是“应该放宽版本”，而是当前桥接面已经不是最有价值的官方接口。

**建议**

做一份小 ADR，只选一种方向：

- **Provider 方向**：Tekon 保持 workflow authority，通过 DSH SDK/ACP 获得真实流式、inbox、cancel/resume；不复制 DSH 的 Session/Agent 抽象。
- **Session 方向**：采用 DSH session log/agent lifecycle 作为会话 authority，Tekon 只叠加 Deliver/governance；删除重复 Driver/Event 兼容层。

不要继续维持“自建半套 Harness + headless one-shot”的中间态。

### P1-02：过度实现顺序反了

当前已经有：

- 三种 profile policy。
- automation/readiness listener。
- Goal mode。
- DSH bridge/probe。
- LegacyAgentDriver/Step 契约。
- 双写 Session projection。
- Web/CLI 两套 composition root。

但最基本的人类纵向闭环仍缺失：真实消息流、第二次输入、持久 inbox、恢复、轻量任务。

**建议**

冻结横向平台能力。下一里程碑只允许为 Collaborate vertical slice 服务的改动；不能直接服务该闭环的 Profile、Automation、Goal 扩展一律延后。

### P1-03：默认完整交付链路缺少成本与范围预览

当前 `tekon run "需求"` 和 Web 主按钮默认进入完整 `standard-delivery`。用户在点击前看不到：

- 将使用哪些角色和 gate。
- 预计会创建多少 worktree/agent step。
- 是否可能需要额外模型调用。
- 当前 dirty base、provider、timeout、网络与副作用边界。
- 轻量替代路径。

**建议**

在启动前给出一张简洁的 run plan：

- 模式：Collaborate / Deliver。
- Provider、模板、角色数、关键 gate。
- 工作区/网络/凭证边界。
- 预计成本仅给范围与影响因素，不制造虚假精确数字。
- 高级参数折叠，不让它们占据首屏。

### P1-04：Session 列表排序与行动语义不足

`session-store.ts` 主要按创建时间列出 session。对人类而言更重要的是：

- 最近活动。
- 正在运行。
- 等待我审批。
- 失败且需要处理。
- 草稿未发送。

**建议**

服务端提供稳定的 `lastActivityAt`、`needsAction`、`actionKind` 和 `unread/changedSinceSeen` 投影；UI 不应从零散事件临时推断。

### P1-05：Token 交互暴露实现细节

当前 TopBar 长期显示 token 输入，并在编辑后自动应用。URL fragment 启动与同 tab 恢复是合理的本地认证机制，但普通用户不应持续管理 token 字符串。

**建议**

- 默认隐藏在“连接/安全”设置。
- 首次 fragment 导入后显示“已连接到本地项目”，不回显 token。
- 手动替换必须显式 Apply，避免输入到一半就触发请求。
- 新标签页/深链给出可行动恢复说明。

### P1-06：长 Session 仍无有界化策略

EventFeed 会持续累积和渲染事件；当前没有明确分页、虚拟化、摘要、上下文压缩状态、token 使用或 turn 导航合同。

**建议**

先定义数据合同，再做 UI：

- `beforeSeq`/cursor 分页与有界 replay。
- 只实时订阅尾部。
- turn 级摘要和技术事件懒加载。
- 大 tool result 折叠/外置。
- token/context pressure 可视化。
- 虚拟列表和稳定锚点。

### P1-07：中英混杂和技术术语仍偏多

Web 的空状态、错误边界和事件标签仍有中英混杂；“Session/Event/Job/Profile/Gate”直接成为普通用户信息架构。

**建议**

产品层统一为任务、过程、审批、结果、交付；技术词只在高级诊断中出现。当前不建议做零散逐字符串替换，应先建立中文词汇表与文案测试。

### P1-08：复审门没有真正约束合并

PR #10 自带的最终权威报告结论仍为“不通过完整验收”，但大改仍整体合入 main。CI 全绿只能证明当前切片没有回归，不能把递延 P0 自动变成通过。

**建议**

将“实验性基础设施可合并”和“产品里程碑通过”拆成两个显式 gate：

- Merge gate：代码/迁移/测试安全。
- Product acceptance gate：用户闭环与架构 ADR。
- PR 标题、release note 和 UI badge 必须使用同一成熟度。

## 7. 代码实现与维护性审查

### 7.1 应保留

- `SessionService` 集中 run/resume/cancel/pause orchestration 的方向。
- Job 状态 CAS、session event seq 分配、write queue 与 audit hash 的串行化。
- Provider snapshot 与 fail-closed DSH probe。
- Web token/origin/scope 防护。
- 现有测试对竞态和状态机边界的覆盖。

### 7.2 应收敛或删除

| 区域 | 当前成本 | 未兑现收益 | 处置 |
| --- | --- | --- | --- |
| `LegacyAgentDriver` | 冻结接口、缓冲事件、多个 NotSupported 分支 | 无生产持续会话调用方 | 下一 vertical slice 使用，否则删除 |
| dual-write bridge | 两套事件词汇、反向查找、失败补偿 | 不能 replay/重建 | 改 transactional outbox 或缩小为对话域 |
| CLI/Web composition root | 重复装配且都启动 JobRunner | 没有一致 owner | 抽单一 daemon composition root |
| Profile/Automation | listener、job kind、策略矩阵 | Collaborate 尚不存在 | 冻结新增，先完成主路径 |
| dsh-headless ACL | 版本 probe、临时 HOME、one-shot 解析 | 无真实 streaming、仅 goal | ADR 后转 SDK/ACP 或移除 |

### 7.3 代码质量结论

代码质量本身不是本轮主要失败原因。多数模块有清楚注释、类型边界和测试，局部复杂度也能解释。问题是**系统级组合复杂度超过当前产品价值**。继续“把每个局部写得更稳”不会自动解决产品合同，必须先删减或重排能力顺序。

## 8. 本 PR 已顺手修复的事项

### FIX-01：无参数成为人类入口

原行为：

- `tekon` 写 stderr。
- 返回码 1。
- 只提示再执行 `tekon help`。

新行为：

- `tekon` 与 `tekon help` 输出一致。
- 返回码 0。
- 首屏直接给出 Web、直接运行、命令帮助三条路径。

### FIX-02：帮助页先讲“怎么开始”，再列框架内部命令

新增“推荐开始方式”，把 `tekon ui` 放在第一条；完整命令表仍保留，兼顾新用户和高级用户。

### FIX-03：统一 CLI 与 updater 的产品版本

原行为：

- CLI 从 `packages/cli/package.json` 读取 `0.7.0`。
- updater/installer 从根 `package.json` 读取 `0.15.4`。

新行为：

- CLI 使用 `getRepoRoot()/package.json`。
- 测试精确断言 `--version` 与根版本一致。
- 本次实际行为改进按仓库规则提升到 `0.16.0`。

### FIX-04：Session 列表按最近活动排序并补齐行动投影（P1-04）

原行为：

- `packages/core/src/session/session-store.ts` 的 `listSessions` 仅按 `created_at desc, rowid desc` 静态排序；产生新事件推进或进入人工审批的旧会话被沉在列表后方。
- RPC `apiSessionSchema` 与 `SessionListEntry` 缺少最近活动时间与待处理标识，列表卡片无法感知哪些会话正在等待人类决策。

新行为：

- `packages/core/src/session/session-store.ts:49-52, 322-338`：`listSessions` 改用 `LEFT JOIN session_events`，以 `coalesce(max(e.timestamp), s.created_at)` 派生 `lastActivityAt`，并按 `last_activity_at desc, s.rowid desc` 排序；会话随事件更新自动置顶。
- `packages/web/src/shared/rpc-contract.ts:648-671`：`apiSessionSchema` 扩充 `lastActivityAt`、`needsAction` 与 `actionKind`（`approval` | `input` | `failed` | `null`）。
- `packages/web/src/server/api/routers/session.ts:9-24, 36-60, 62-86`：实现 `deriveSessionAction` 并在服务端 `session.list` / `session.get` 按会话状态集中派生行动语义，不破坏 core 冻结的 `sessionSchema`。
- `packages/web/src/client/pages/SessionsPage.tsx:15-42, 113-132`：渲染中文相对活动时间（如“12分钟前”/“2小时前”），并在需用户介入时展示“待审批 / 待输入 / 需处理”徽标。

## 9. 推荐的下一阶段实施顺序

### 阶段 A：运行权威与安全停机

1. repo single-owner daemon + lock。
2. CLI/Web 全部变为客户端。
3. quiescent shutdown 契约与故障注入测试。
4. 若仍需要抢占，再做 generation fencing。

### 阶段 B：最小 Collaborate vertical slice

1. Provider execution-time `assistant/chunk` 和真实 tool lifecycle。
2. durable inbox。
3. follow-up、steer、cancel、resume。
4. 刷新/重启后恢复同一 session。
5. 一条真实 Codex/Claude/DSH provider E2E。

### 阶段 C：明确升级到 Deliver

1. Collaborate → 需求卡/计划确认。
2. 选择 Deliver 模板与 run plan。
3. 进入现有 role/gate/artifact/PR 治理。
4. Session 与 workflow 通过稳定 link/outbox 关联。

### 阶段 D：再恢复平台化扩展

只有阶段 A-C 达到验收后，才继续扩 Profile、Automation、Goal、多 workspace、subagent 等横向能力。

## 10. 通过条件

Tekon 要获得“面向普通人稳定可用”通过，至少需要同时满足：

- [x] Web/CLI 有一个普通人可理解的默认入口，不要求先理解 role/workflow/gate。（本轮 CLI 侧已达成：`tekon` 无参数即给出人类优先帮助，`tekon ui`/`tekon run` 前置——FIX-01/02；Web 侧信息架构中英混杂与技术术语仍待 P1-07 统一。）
- [ ] 当前 session 可继续输入、转向、取消并在重启后恢复。
- [ ] Provider 消息和工具事件是执行期真实流，而非完成后合成。
- [ ] Collaborate 与 Deliver 是明确、可切换、行为不同的产品轨道。
- [ ] 一个 repo 同时只有一个执行 owner，或所有副作用都有持久 generation fencing。
- [ ] shutdown 能证明所有执行与写入已停止。
- [ ] Session 对话事实有权威 log；跨域投影可重放且健康可观测。
- [ ] 长 session 的分页、虚拟化、摘要和上下文压力有明确合同。
- [ ] DSH 接口选择与当前官方 SDK/ACP/安全边界重新对齐。
- [ ] 产品验收 gate 与 merge/CI gate 分离且真正生效。

## 11. 验证状态

- 代码测试均先行更新：FIX-01/02/03 已随首个 CLI 提交 `5b903ee` 进入分支；FIX-04（P1-04）的实现与测试随本轮批注一起以同一提交进入分支。
- 本轮已在本地执行全量测试并通过：`corepack pnpm test` = **1317 passed / 3 skipped（114 个测试文件）**，覆盖 Core、Web、CLI 全量单测与集成测试；Web Playwright e2e = **28 passed**（含移动端 390px 无横向溢出、内联审批闭环、新增 P1-04 “待审批”行动徽标断言）。
- GitHub Actions：`5b903ee`（FIX-01/02/03，CLI 人类入口 + 版本身份）对应 Core #268 = success、CI #177 = success；**FIX-04 与本轮批注属于新提交，其 CI 结果以该提交推送后的 Actions run 为准**（上述 #268/#177 不覆盖 FIX-04）。本地全量测试已如上通过。
- README 已同步人类入口和版本身份；主用户手册 Markdown/HTML 已检查但未修改，因为其中没有描述无参数错误或内部包版本，现有 `tekon help` / `tekon ui` 说明仍然成立。
- P1-04 UI 已做真实浏览器截图核验（桌面 1440px + 移动 390px）：Session 列表的行动徽标、状态徽标、交付运行标签与相对活动时间在同一行正确排布，无错位、无重叠、无横向溢出；窄屏下标题按预期省略截断、行动指示保持可见。截图为一次性验证产物，未随仓库归档，结论记于本节。

## 12. 最终结论

**本轮不通过稳定产品验收。**

允许的表述是：

> Tekon 已完成一个测试较强、边界明确的实验性 Session/Event/Job 与受控交付基础设施切片；它尚未完成面向人类的持续协作产品、单一运行权威和权威 Session log。

最优下一步不是继续堆框架，而是用最少的新抽象完成一个真实的 Collaborate → Deliver 纵向闭环，并删除无法服务该闭环的兼容层。

## 13. 复审视角批注（second-perspective annotation）

本节由实施方独立回溯代码、契约与测试后，对报告中 11 项 finding 及 4 项修复进行逐条核验与处置标注。处置标注分为三类：
- **已修**：已在本 PR 前期提交中闭环并由自动化测试锁定；
- **本轮修**：已在本 PR 本轮实现中闭环（FIX-04）；
- **ADR递延**：代码事实成立，属于需用户/架构拍板的跨阶段里程碑（对应 §9 阶段 A–D），在当前切片诚实披露边界，不做未经拍板的超范围重写。

### 13.1 P0 级架构问题批注

| 编号 | 处置标注 | 核验证据（文件:行） | 理由与说明 |
| --- | --- | --- | --- |
| **P0-01** | **ADR递延（阶段B/C）** | `packages/web/src/client/components/sessions/SessionComposer.tsx:11-15, 74`<br>`packages/core/src/runtime/legacy-agent-driver.ts:137-142, 175-177`<br>`packages/core/src/runtime/agent-step-events.ts:99-115` | **措辞订正**：原报告称“Session 产品合同不成立”偏强。对外宣称的“受控交付（standard-delivery）”合同完整成立并有测试真锁；缺失的是未宣称的轻量持续协作（Collaborate）能力。界面已在 `SessionComposer.tsx:74` 诚实披露（“当前入口会启动 standard-delivery 受控交付全链路；轻量协作、会话内追问与转向尚未开放”）。verdict 仍为 **real**，归入 §9 阶段 B（真实流式/durable inbox）与阶段 C（Collaborate→Deliver 升级）。 |
| **P0-02** | **ADR递延（阶段A）** | `packages/web/src/server/api/root.ts:170-178`<br>`packages/cli/src/lib/session-context.ts:50-78`<br>`packages/core/src/db/repositories.ts:569-588`<br>`packages/core/src/session/session-store.ts:25-45` | 事实 multi-owner 成立：Web 与 CLI 均可启动 `JobRunner` 竞争 SQLite 与 Git。闭环需引入 single-owner daemon（推荐）或全副作用 fencing + Node expected-from CAS，属重大架构决策，归入 §9 阶段 A。 |
| **P0-03** | **ADR递延（阶段A）** | `packages/core/src/session/job-runner.ts:514-544` | 事实成立：`stop()` 等待 5 秒后清理进程内引用，保障单进程退出，但无跨进程/全副作用的 quiescent join 证明。随 single-owner daemon 在 §9 阶段 A 建立明确 shutdown 契约。 |
| **P0-04** | **ADR递延（阶段C）** | `packages/core/src/session/dual-write.ts:14-25, 227-249`<br>`docs/technical/tekon-replatform-current-scope.md:§3` | 事实成立：`session_events` 当前为旧领域写入后的 best-effort projection，旧表仍是交付事实源。当前 projection-only 已在范围基线明文化并被接受，不造成治理数据破坏；升级为权威 log + transactional outbox 归入 §9 阶段 C。 |

### 13.2 P1 级演进问题批注

| 编号 | 处置标注 | 核验证据（文件:行） | 理由与说明 |
| --- | --- | --- | --- |
| **P1-01** | **ADR递延（阶段B/D）** | `packages/core/src/runtime/dsh-bridge-probe.ts:15-35`<br>`packages/core/src/runtime/dsh-headless-adapter.ts:23-50` | 精确 pin `0.1.1-rc.2` 是安全 fail-closed 做法。官方 Harness 发布 `0.1.2-alpha.1` 引入 SDK/ACP 后，桥接面需重新评估（Provider vs Session 方向），随 Provider ADR 在阶段 B/D 处理。 |
| **P1-02** | **ADR递延（阶段B）** | `packages/core/src/session/profile-policy.ts:10-35`<br>`workflows/goal.yaml:1-16`<br>`packages/core/src/session/workflow-job-executor.ts:165-166`<br>`packages/core/src/workflow/engine.ts:71` | 认可应先做 Collaborate 纵向闭环再做横向平台扩展。下一里程碑冻结 Profile/Automation/Goal 等横向扩展，聚焦阶段 B。 |
| **P1-03** | **ADR递延（阶段C）** | `packages/cli/src/commands/run.ts:54-92`<br>`packages/web/src/client/components/sessions/SessionComposer.tsx:29-85` | 默认启动完整交付缺少启动前预览属实。在启动前给出 run plan（角色、gate、成本、边界）属高价值增益，随阶段 C 的需求确认与 Deliver 升级一同落地。 |
| **P1-04** | **本轮修（FIX-04）** | `packages/core/src/session/session-store.ts:49-52, 322-338`<br>`packages/web/src/shared/rpc-contract.ts:648-671`<br>`packages/web/src/server/api/routers/session.ts:9-24, 36-60, 62-86`<br>`packages/web/src/client/pages/SessionsPage.tsx:15-42, 113-132` | **已在本轮完成修复**：`listSessions` 改为 LEFT JOIN session_events 按最近活动排序；`apiSessionSchema` 扩充 `lastActivityAt`、`needsAction` 与 `actionKind` 投影；SessionsPage 展示中文相对时间与待处理徽标。 |
| **P1-05** | **ADR递延（阶段C/token ADR）** | `packages/web/src/client/layouts/TopBar.tsx:14-42`<br>`docs/technical/tekon-web-architecture.md` | token 常驻输入是本地轻量认证的明文设计（报告 §7.1 自列“应保留”），350ms 防抖是刻意防止输入过程中每按键触发请求的设计。直接改为连接设置弹窗会破坏多条现有 E2E 测试，随 Collaborate 里程碑及安全 token ADR 统一重构。 |
| **P1-06** | **ADR递延（阶段D）** | `packages/web/src/client/components/sessions/EventFeed.tsx:40-95`<br>`packages/web/src/client/lib/session-stream.ts:80-120` | 长会话分页、游标订阅、虚拟列表与上下文压力可视化属于规模化阶段需求，归入 §9 阶段 D。 |
| **P1-07** | **ADR递延（阶段C/D）** | `packages/web/src/client/pages/SessionsPage.tsx`<br>`packages/web/src/client/pages/SessionDetailPage.tsx` | 零散逐字符串替换易造成词汇漂移与测试断言失败；应在阶段 C 统一建立产品中文词汇表与文案测试。 |
| **P1-08** | **已采纳（过程治理）** | `docs/reviews/2026-08-28-tekon-human-first-harness-architecture-review.md:318-329` | 明确区分 Merge gate（代码/单测/CI 安全）与 Product acceptance gate（产品闭环与架构通过），PR 标题、Release Note 和 UI 徽标保持一致成熟度。 |

### 13.3 修复项批注

| 编号 | 处置标注 | 核验证据（文件:行） | 理由与说明 |
| --- | --- | --- | --- |
| **FIX-01** | **已修** | `packages/cli/src/index.ts:111-114`<br>`packages/cli/__tests__/help.test.ts:179-192` | 无参数调用 `tekon` 退出码为 0，友好输出 Web/直接运行/命令帮助三条推荐路径。 |
| **FIX-02** | **已修** | `packages/cli/src/commands/help.ts:53-57` | 帮助页首屏前置展示 `tekon ui` 与 `tekon run "你的需求"` 推荐开始方式，避免将内部框架命令直接倾倒给用户。 |
| **FIX-03** | **已修** | `packages/cli/src/lib/utils.ts:10-18`<br>`packages/cli/__tests__/help.test.ts:124-140` | CLI 与 updater 统一读取根 `package.json` 版本（`0.16.0`），消除内部包版本 `0.7.0` 与根版本 `0.15.x` 的双重身份错位。 |
| **FIX-04** | **本轮修** | `packages/core/src/session/session-store.ts:49-52, 322-338`<br>`packages/web/src/shared/rpc-contract.ts:648-671`<br>`packages/web/src/server/api/routers/session.ts:9-24, 36-60, 62-86`<br>`packages/web/src/client/pages/SessionsPage.tsx:15-42, 113-132` | Session 列表按最近活动排序，补齐 `needsAction`/`actionKind` 投影与相对时间展示（详见 §8 FIX-04）。 |

