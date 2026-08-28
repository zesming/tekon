# Tekon 人类可用性与 Harness 架构第三轮全面复审

- **复审日期**：2026-08-28
- **用户最新整改提交**：`27f809ddc496d88d51c37da84fbbb2ff06a2061d`
- **本轮修复提交**：`ae090345c28f2ed99e2201bfa4e876b34ce723e2`
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **对照基线**：`main@300aea6b9ea5c805303e7e1d302dadabc5531548`
- **验证快照**：Core #276 `success`；CI #185 `success`
- **覆盖维度**：产品逻辑、CLI/Web UI、UX、Session/Runtime 架构、代码实现、测试可信度、DeepSeek Harness 对齐、过度实现与过度设计
- **最终结论**：**用户最新增量及本轮低风险修复通过代码合并门；Tekon 仍不通过“面向普通人稳定研发工作台”的产品验收，可作为实验性受控交付基础设施有条件通过。**

> 本报告是 PR #11 的第三轮权威复审。首轮与第二轮报告保留判断演进历史；涉及当前代码与合并判断时，以本报告为准。

---

## 1. 执行摘要

用户基于第二轮评审新增了两项实现：

1. Session 列表从 `LEFT JOIN + max(timestamp) + group by` 改为按 `(session_id, seq)` 索引读取每个 Session 的尾事件；
2. Session 列表增加页面级 ticker，使“几分钟前 / 几小时前”能够自动推进，同时修正了首轮报告中的失效代码引用。

第三轮复核结论如下：

- **P1-PERF-01 查询优化通过**。相关子查询使用现有 `idx_session_events_session_seq(session_id, seq)`，按 `seq desc limit 1` 读取尾事件，避免每次列表请求聚合全部事件历史；以 `seq` 表示追加因果顺序也比单纯 `max(timestamp)` 更稳健。
- **引用修正通过**。Goal 的真实实现路径是 `workflows/goal.yaml`、Goal role 与 `workflow-job-executor.ts` 的 `goal-run` 分支，不存在的 `goal-job-executor.ts` 已从正式报告中移除。
- **ticker 方向正确，但用户提交仍有一个真实的小缺口**：报告把 `formatRelativeTime` 称为纯函数，实际实现却直接读取 `Date.now()`；`useTicker` 返回的是未使用的计数值，时间边界无法做确定性测试，列表时间也没有 `<time datetime>` 语义。本轮已修复并补测试。
- **最新增量没有关闭产品与 Runtime 的结构性问题**：Web/CLI 多 owner、非 quiescent shutdown、best-effort Event projection、缺少 Collaborate / streaming / durable inbox / follow-up / steer / resume，以及长 Session 有界化仍然成立。

因此，本轮不新增架构重写，也不继续横向扩展 Profile、Automation、Goal 或更多事件类型。当前最合理的边界是：**接受本 PR 的低风险 UX 和查询改进，但不能把合并解释为稳定产品验收通过。**

---

## 2. 复审方法与证据边界

### 2.1 仓库覆盖

本轮重新核对了：

- 产品与使用边界：`README.md`、主用户手册、current-scope、三轮评审报告与 CHANGELOG；
- CLI：入口、帮助、版本身份、run/resume/cancel 与 CLI composition root；
- Web：Session 列表、Composer、EventFeed、Token、RPC/SSE、审批、运行控制和响应式样式；
- Core：Session store、Job runner、SessionService、workflow executor、dual-write、AgentDriver、step event bridge、DSH bridge；
- 测试与发布：Core/CLI/Web unit、integration、Playwright、Actions、版本与文档同步；
- 外部基线：DeepSeek Harness 官方 Architecture、Persistence、Safety 与最新 prerelease。

这是“整个仓库结构覆盖 + 决定产品/架构结论的关键路径深读”，不宣称逐行审阅每个辅助文件。

### 2.2 UI 证据限制

本轮没有可访问的独立部署实例，也没有使用浏览器控制工具重新采集完整产品流程截图。因此：

- 已检查：组件结构、状态语义、交互闭环、ARIA、响应式 CSS、RPC/SSE 数据流、现有 Playwright 和用户记录的桌面/移动截图验证结论；
- 未声称完成：全站像素级视觉、真实键盘焦点顺序、屏幕阅读器实测、动效和不同浏览器渲染审计。

本报告中的 UI 判断属于实现与自动化证据审查，不冒充完整截图审计。

---

## 3. 外部基线复核

### 3.1 Harness 的核心仍是权威 Session log，而不是事件命名表

DeepSeek Harness 官方架构仍明确：

- durable Session events 负责跨重载存活的事实；
- live Agent events 负责运行中协调；
- Session log 是模型上下文、replay、fork、resume、transcript 与 persistence 的来源；
- 模型可见输入必须能从 log 重建；
- 输入通过一个 inbox 进入 Agent loop。

依据：

- [DeepSeek Harness Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)
- [Agent Turn And Step Lifecycle](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/agent-lifecycle.md)

对 Tekon 的判断：当前 `session_events` 仍是旧表和 Audit 写入后的 best-effort projection；它可以改善观察面，但不能承担完整模型历史、durable inbox、恢复和同 Session 继续输入。因此 Tekon 获得了 Harness 的部分 UI 价值，尚未获得其事实源与生命周期价值。

### 3.2 Persistence 的关键是 flush/quiescence 与可恢复事实链

Harness 官方 persistence 文档把 append-only SessionEvent log 定义为事实源，并要求 `session/flush` 排空至 quiescence；崩溃恢复会保留并平衡被中断的 turn，而不是只让 lease 过期等待未来重领。

依据：[DeepSeek Harness Session Persistence](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/persistence.md)

对 Tekon 的判断：`JobRunner.stop()` 最多等待 5 秒后清除 heartbeat/controller/token/flag，并未证明 provider、子进程、Git/文件写入与 listener 已停止。这与 Harness persistence 的 quiescent checkpoint 仍有本质差距。

### 3.3 DSH 机器接口不再只有 headless one-shot

当前官方架构列出 `web`、`headless`、`sdk`、`sdk-minimal` 和 `acp` profiles；SDK 走 JSON-RPC，ACP 用于自动化接入。2026-08-27 发布的 `dsh-v0.1.2-alpha.1` 进一步补齐 ACP 会话控制、模型设置、MCP、权限和取消，并增强消息排队、回合导航与 token 使用展示。

依据：

- [DeepSeek Harness Architecture / Profiles](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md#profiles-and-bundles)
- [dsh v0.1.2-alpha.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.1)

对 Tekon 的判断：精确 pin `0.1.1-rc.2` 并 fail-closed 是正确安全策略；过时的是“headless argv/stdout 是唯一机器接口”的边界说明。下一步应以 ADR 比较 SDK/ACP，而不是继续扩展 goal-only one-shot ACL。

### 3.4 Harness 不能替代安全隔离

官方 Safety 仍说明 Harness 是未经过安全审计的 developer preview；sandbox、approval 与 permission 不能保证隔离。

依据：[DeepSeek Harness Safety](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)

对 Tekon 的判断：dsh-headless 网络出口不受限必须继续作为产品级警告；即使未来迁移到 SDK/ACP，也不能降低最小权限、凭证隔离、容器/VM 和人工副作用审批要求。

---

## 4. 对用户最新整改的逐项裁决

| 整改项 | 裁决 | 理由与依据 |
| --- | --- | --- |
| Session 尾事件查询优化 | **通过** | `listSessions()` 通过相关子查询按 `e.seq desc limit 1` 取尾事件，复用 `(session_id, seq)` 索引，避免原查询对全部事件做 join/group 聚合。无 migration、无 RPC 契约变化。 |
| 以 `seq` 而非 `max(timestamp)` 表示最新事件 | **通过** | `appendEvent()` 在同一 `BEGIN IMMEDIATE` 临界区内分配单调 seq；即使墙钟回拨，最高 seq 仍表示追加顺序上的最近事件。 |
| 相对时间自动推进 | **部分通过，本轮补修** | 页面级单 timer 比每行 timer 正确；但原 `useTicker` 只返回未使用计数，formatter 直接读取全局时钟，无法确定性测试，也缺 `<time datetime>`。本轮已统一时钟、抽纯函数、补边界测试和可访问语义。 |
| 首轮虚构文件引用修正 | **通过** | 正式报告已改为 `workflows/goal.yaml`、`workflow-job-executor.ts` 与 engine 路径，和真实实现一致。 |
| “Session 列表性能问题已关闭” | **仅接受当前规模的小闭环** | 全事件聚合已关闭，但 Session 本身仍无分页；服务端还会读取全部 Session 并在内存排序。规模化仍需 summary projection/cursor。 |
| “相对时间 UX 已完整关闭” | **本轮修复后通过当前范围** | 时间会自动变化且具有确定性测试与 `<time>` 语义；但它不等于 Session 数据实时刷新，列表仍没有 workspace 级 live stream。 |

---

## 5. 产品逻辑评审

### 5.1 当前 Deliver 合同基本成立

应继续保留的事实：

- Web 明确命名为“受控交付”；
- Composer 直接说明会启动 `standard-delivery` 的 PM/RD/QA/Reviewer 全链路；
- PR 创建和远端副作用需要明确人工批准；
- README/手册诚实说明真实 streaming、follow-up/steer 和 Collaborate 尚未开放。

因此，不能再笼统表述为“现有产品合同完全不成立”。准确说法是：**Deliver 合同成立，但它不是完整的人类研发工作台。**

### 5.2 Collaborate 仍是最重要的缺口（P0-PRODUCT-01）

代码事实：

- `LegacyAgentDriver.events()` 等待整个 one-shot run 完成后才吐出缓冲事件；
- `followUp()`、`steer()`、`resume()` 明确抛 `NotSupportedYet`；
- `runAgentWithStepEvents()` 在 `adapter.runAgent()` 完成后才合成 `tool/*` 和 `assistant/message`；
- 除 DSH 最终 stdout 外，多数 assistant 文本仍来自 artifact 元数据合成。

影响：

- 用户无法在当前 Session 内继续澄清或纠偏；
- 刷新/重启无法恢复同一协作上下文；
- Tekon 仍依赖外部 Agent 产品完成需求探索，只接管后半段治理；
- Profile/Automation/Goal 等平台能力无法替代最基本的第二次输入。

建议：冻结横向平台扩展，先完成一个真实 Provider 的 Collaborate vertical slice，再设计升级到 Deliver。

### 5.3 完整 Deliver 缺少启动前预览（P1-PRODUCT-02）

`tekon run "需求"` 和 Web 主按钮默认进入完整治理链路，但启动前仍看不到：

- 模板、角色数量和关键 Gate；
- Provider、权限、网络与凭证边界；
- timeout/no-progress 配置；
- 可能产生的模型调用与工作树；
- 轻量替代路径。

建议：在真正启动前给出简洁 run plan；成本只展示影响因素或范围，不制造虚假精确数字。

---

## 6. UI / UX 评审

### 6.1 Session 任务中心已明显改善

当前优点：

- `needsAction → active → idle → terminal` 的 attention 排序符合人工任务中心的优先级；
- 待审批、待输入、失败有明确行动徽标；
- 同组按最近活动排序；
- 相对时间会自动更新；
- 本轮使用 `<time datetime>`，辅助技术能够识别时间语义；
- 窄屏下标题可截断、行动徽标保持可见。

这一部分可通过当前 PR 的小范围 UX 验收。

### 6.2 ticker 不是实时 Session 列表（P1-UX-01）

`useTicker` 只触发本地文本重渲染，不会获取新的 Session、状态或行动投影。用户停留在列表页时：

- 另一个进程创建的新 Session 不会出现；
- 当前 Session 进入待审批/失败不会自动置顶；
- CLI 驱动的状态变化需要手动刷新；
- 只有进入某个 Session 的 SSE hook 才会触发部分 query invalidation。

建议：后续增加 workspace/session-summary stream，或先用有界低频 refetch 作为临时方案；不要把时间 ticker 描述为实时任务中心。

### 6.3 失败任务会永久占据最高优先级（P1-UX-02）

`deriveSessionAction('failed')` 永远返回 `needsAction=true`。系统没有：

- 已查看 / 已确认；
- 已归档 / 忽略；
- 已创建后续修复任务；
- changedSinceSeen/unread 状态。

影响：历史失败会长期排在 active 工作之前，任务中心随时间累积后会失去“现在需要我做什么”的含义。

建议：先定义 `attentionState` 或 `acknowledgedAt`，再决定失败是否继续置顶；不要仅靠终态字符串永久推断行动需求。

### 6.4 Token 仍暴露实现细节（P1-UX-03）

TopBar 长期展示 `Session token` 输入框，并在用户停顿 350ms 后自动切换认证 scope。虽然 debounce 避免了逐键 refetch，但普通用户仍需直接管理凭证字符串。

建议：启动 fragment 导入后显示“已连接到本地项目”；token 移入连接/安全设置，替换凭证使用显式 Apply；新标签页或深链提供可行动恢复说明。

### 6.5 产品术语仍偏工程内部（P1-UX-04）

“Session / Event / Job / Profile / Gate / Cockpit”仍直接进入主信息架构，个别空状态中英文并列，如“等待事件… Waiting for session events.”。

建议：普通路径统一为任务、过程、审批、结果、交付；技术词只在高级诊断展示，并建立词汇表与文案测试，避免零散替换。

### 6.6 长 Session 仍无端到端有界化（P1-UX-05）

- SSE 初始 replay 可读取整个历史；
- hook 在内存中持续累积全部事件；
- `EventFeed` 对全部 events 做 turn 分组并渲染全部可见行；
- 没有 cursor/beforeSeq、虚拟列表、turn 摘要、token/context pressure 或大结果外置合同。

建议：数据合同先于 UI：cursor 分页、只订阅尾部、turn 摘要、技术事件懒加载、大 tool result 外置、虚拟化和稳定锚点。

---

## 7. Runtime 与框架架构评审

### P0-ARCH-01：Runtime 仍是事实 multi-owner

代码事实：

- Web composition root 创建并 `start()` 一个 JobRunner；
- 每次 CLI run/resume 也创建自己的 JobRunner；
- CLI 注释明确承认它可能领取 Web 遗留的 automation job；
- 两者共享 SQLite、Git refs、worktree、artifact 目录和子进程；
- owner/status 条件写只覆盖 jobs 表，不能覆盖所有 Node、Gate、Artifact、Audit、Delivery、Git/文件副作用。

结论：当前是“部分 DB fencing 的 multi-owner”，不是单 owner，也不是完整 generation fencing。

建议优先选择简单方案：repo single-owner daemon，CLI/Web 变客户端，第二 owner fail-fast。只有明确需要抢占或多 owner 后，再设计 generation lease 与全副作用 fencing。

### P0-ARCH-02：Shutdown 仍非 quiescent

`JobRunner.stop()`：

1. 停止 poll；
2. 最多等待 5 秒；
3. 清 heartbeat、controller、execution token 与 pause flag；
4. 让 lease 未来过期，由下次启动恢复。

它没有证明在途 provider、子进程、Git/文件写入、listener 和数据库写入已停止。清除引用不是 join。

建议定义严格 shutdown contract：停止领取、持久 cancel/pause、abort + kill、等待 executor/subprocess/listener/write queue 排空；超时必须保持不安全状态可见，不能伪装正常退出。

### P0-ARCH-03：Session Event 仍不是权威事实链

`dual-write.ts` 明确规定：旧 audit/仓储写入先成功，Session Event 追加失败不抛错，查不到 Session 也可静默跳过。

这在迁移阶段保护了治理路径，但意味着 Event log 不能作为：

- 模型历史；
- durable inbox；
- 完整 replay；
- fork/resume；
- 可靠的 UI/自动化事实源。

建议做清晰 ADR，只选其一：

- **Projection-only**：缩小事件承诺，把对话域另建权威 log；
- **Authoritative log**：写入与业务变更使用同事务/outbox，提供 replay/repair/health contract。

### P1-ARCH-04：DSH bridge 选错了长期接口层级

当前 bridge 的 fail-closed pin、隔离 HOME、参数白名单等局部实现是稳健的；但 one-shot headless 只提供最终消息，无法直接解决 streaming、inbox、resume 和标准会话控制。

建议 ADR 比较：

- DSH SDK/ACP 仅作为 Provider/Agent runtime，Tekon 保留 workflow authority；
- 或 DSH Session/Agent 成为对话 authority，Tekon 只叠加 Deliver/governance。

不要继续维护“Tekon 自建半套 Harness + DSH headless one-shot”的长期中间态。

---

## 8. 代码实现与性能审查

### 8.1 做得好的部分

- Session 尾事件查询改动范围小、无 migration、复用现有索引；
- attention 排序与 lastActivityAt 契约已有确定性 API 测试；
- CLI、Web、Core 分层测试和 Playwright 持续全绿；
- 关键竞态、CAS、dirty base、人工副作用和安全边界有清晰注释；
- 未为本轮评审重复 bump 版本，继续保持 `0.16.0`。

### 8.2 `session.get` 为取时间而读取完整尾事件（P1-CODE-01）

当前 `session.get` 先取 `latestSeq()`，再调用 `listEventsSince(latestSeq - 1)`，随后把尾事件完整映射、解析 JSON payload，最后只使用 `timestamp`。

风险：如果尾事件是大型 tool result 或 artifact metadata，详情元数据请求会承担无意义的反序列化和内存开销。

建议：在 SessionEventStore 增加轻量 `getLatestEventTimestamp()` 或 summary snapshot，直接读取 `timestamp`；与 list query 共用同一尾事件语义。

本轮未顺手修改，因为这会扩展核心接口并影响多处测试/fixture，适合独立小 PR，而不是在评审提交中继续扩大范围。

### 8.3 Session 列表仍是无分页全量读取（P1-CODE-02）

相关子查询消除了“按全部事件聚合”，但仍会：

- 读取 workspace 下全部 Session；
- 为每个 Session 做一次索引尾查；
- 在 Web router 内存中做 attention sort；
- 一次返回全部行。

当前本地规模可接受，但不能据此宣称长周期规模问题关闭。后续应持久化 summary projection，并提供 cursor/limit。

### 8.4 相对时间实现已在本轮收敛

用户提交中的问题：

- formatter 隐式读取 `Date.now()`；
- ticker 返回未使用计数；
- 同一 render 的各行理论上可读到不同毫秒；
- 缺分钟/小时/天边界测试；
- 使用普通 `<span>`。

本轮修复：

- `useTicker()` 返回共享 `nowMs`；
- `formatRelativeTime(iso, nowMs)` 成为可确定测试的纯函数；
- 覆盖 1 分钟、1 小时、1 天、7 天、未来时间和非法输入；
- 使用 `<time dateTime>` 并增加“最近活动”辅助文本。

---

## 9. 过度实现与过度设计判断

### 9.1 横向平台能力仍领先于纵向价值

当前已有：

- Profile policy；
- Automation/readiness listener；
- Goal mode；
- LegacyAgentDriver/AgentHandle 契约；
- Dual-write Session projection；
- DSH headless ACL/probe；
- Web/CLI 两套 composition root。

但最基本的纵向闭环仍没有：真实流、第二次输入、durable inbox、steer、恢复、Collaborate→Deliver 升级。

结论：局部代码质量不差，问题是**实现顺序过度平台化**。下一里程碑应冻结不能直接服务 Collaborate vertical slice 的横向能力。

### 9.2 评审与 CHANGELOG 已出现过程性过度设计（P2-PROCESS-01）

PR #11 及其前置 replatform 已积累多轮“权威报告 + 实施方批注 + 报告再批注 + 大段 CHANGELOG”。这有审计价值，但也带来：

- 当前裁决入口不唯一；
- 旧报告中的过期代码引用需要反复修订；
- CHANGELOG 混入大量评审过程而非用户可见变更；
- 文档变更本身不断触发全栈 CI 和新的验证回填。

建议：本报告作为 PR #11 最终权威入口；后续只维护一份 current decision record 和简短 revision log。CHANGELOG 聚焦用户可见行为，完整评审历史留在 `docs/reviews/`。

---

## 10. 本轮实际修改

提交：`ae090345c28f2ed99e2201bfa4e876b34ce723e2`

| 文件 | 修改 |
| --- | --- |
| `packages/web/src/client/hooks/use-ticker.ts` | ticker 从计数器改为共享当前时间戳，卸载清理不变。 |
| `packages/web/src/client/lib/relative-time.ts` | 新增显式注入时钟的纯格式化函数。 |
| `packages/web/src/client/pages/SessionsPage.tsx` | 同一 render 共享 `nowMs`；使用语义化 `<time datetime>` 与辅助标签。 |
| `packages/web/__tests__/client/relative-time.test.ts` | 增加确定性边界、未来时间和非法输入测试。 |

文档同步判断：

- PR 描述将把“最新权威报告”链接更新到本报告；
- 本轮不再扩写已经过长的 CHANGELOG，也不重复 bump `0.16.0`；完整复审证据归档在 `docs/reviews/`；
- 主用户手册不描述 ticker 内部机制或旧错误行为，本轮无需修改；
- AGENTS/技术方案无规则或架构合同变化，无需修改。

---

## 11. 未关闭问题清单

### P0：产品/运行正确性

1. **P0-ARCH-01**：Web/CLI multi-owner，缺单一 Runtime authority 或全副作用 generation fencing。
2. **P0-ARCH-02**：shutdown 不是可证明的 quiescent shutdown。
3. **P0-ARCH-03**：Session Event 为 best-effort projection，不能作为权威对话事实与 durable inbox。
4. **P0-PRODUCT-01**：无真实 execution-time streaming、follow-up、steer、resume 和重启恢复的 Collaborate 轨道。

### P1：重要演进

1. **P1-PRODUCT-02**：Deliver 启动前缺 run plan、角色/Gate/权限/成本影响因素预览。
2. **P1-UX-01**：Session 列表无 workspace 级实时数据流。
3. **P1-UX-02**：失败任务无 acknowledge/archive，可能永久占据最高优先级。
4. **P1-UX-03**：Token 作为普通用户常驻字符串控件。
5. **P1-UX-04**：中英混杂和工程术语进入主信息架构。
6. **P1-UX-05**：长 Session replay、内存和 DOM 无界。
7. **P1-CODE-01**：`session.get` 为取时间反序列化完整尾事件 payload。
8. **P1-CODE-02**：Session 列表仍无 cursor/limit/summary projection。
9. **P1-ARCH-04**：DSH 长期接口仍停留在旧 headless one-shot 边界。

### P2：流程与维护性

1. **P2-PROCESS-01**：多轮权威报告和超长 CHANGELOG 造成决策入口与维护成本膨胀。
2. **P2-TEST-02**：当前没有真实多进程、长事件历史和真实 Provider 的规模/故障注入验收矩阵。

---

## 12. 推荐实施顺序

### A. Runtime authority

1. repo single-owner daemon + lock；
2. CLI/Web 客户端化；
3. quiescent shutdown；
4. kill/restart/late-write 故障注入；
5. 只有确需多 owner 时再引入 generation fencing。

### B. Collaborate vertical slice

1. 一个真实 Provider 的 execution-time `assistant/chunk` / tool lifecycle；
2. durable inbox + claim/idempotency；
3. follow-up、steer、cancel、resume；
4. 浏览器刷新和进程重启恢复；
5. 一条真实 Provider E2E。

### C. Collaborate → Deliver

1. 明确模式升级；
2. run plan、角色、Gate、权限、网络和成本影响因素预览；
3. 接入既有 Artifact/Gate/Delivery；
4. 用可靠 link/outbox 连接对话域与治理域。

### D. Scale and polish

1. Session summary projection、cursor 与 workspace stream；
2. acknowledge/unread/changedSinceSeen；
3. turn 导航、分页、虚拟化、摘要和 context pressure；
4. Token 连接 UI 与中文产品词汇表；
5. DSH SDK/ACP ADR 与实现。

---

## 13. 验收结论

### PR / 代码合并门

- 用户最新 SQL 尾事件优化：**通过**；
- 用户最新报告引用修正：**通过**；
- 用户 ticker 实现：**方向通过，缺口已在本轮修复**；
- 本轮相对时间测试与可访问性修复：**通过**；
- Core #276：**success**；
- CI #185：**success**，覆盖 Root、CLI unit/e2e、Web unit/build/typecheck、Playwright；
- 最新增量是否引入阻断回归：**未发现**。

### 产品验收门

- [x] 默认 CLI/Web 入口可发现，并诚实说明当前是受控交付；
- [x] Session 列表可按人工行动优先级组织，并展示可更新的活动时间；
- [ ] 当前 Session 可继续输入、转向并在重启后恢复；
- [ ] Provider 输出为执行期真实流；
- [ ] Collaborate 与 Deliver 是行为不同的明确轨道；
- [ ] 一个 repo 有单一 Runtime owner，或所有副作用有持久 generation fencing；
- [ ] shutdown 可证明无在途执行和 late write；
- [ ] 对话事实有权威 log / durable inbox；
- [ ] 长 Session 数据和 DOM 有界；
- [ ] DSH 接口重新对齐 SDK/ACP 与官方 Safety；
- [ ] 产品验收 gate 与 CI/merge gate 在流程上真正分离。

# 最终裁决

**本 PR 的最新低风险代码与文档可以继续合并审阅；Tekon 仍不通过面向普通人的稳定研发工作台验收。**

允许的成熟度表述是：

> Tekon 已形成测试较强、边界较诚实的实验性受控交付执行与观察基础设施；它尚未完成持续协作产品、单一 Runtime 权威、quiescent shutdown 和权威 Session 事实链。

本 PR 的合并不得被解释为上述 P0/P1 已自动关闭。
