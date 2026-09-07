# Tekon 人类可用性与 Harness 架构第二轮全面复审

- **复审日期**：2026-08-28
- **复审对象**：`review/human-first-harness-2026-08-28@cad6190670c846ba03d0756bf9837e80c01eafb9`
- **本轮实现提交**：`6da5ee1801f61c8b633f92c42c6dfc12bc41f50c`
- **对应 PR**：#11
- **对照基线**：`main@300aea6b9ea5c805303e7e1d302dadabc5531548`
- **验证快照**：Core #273 `success`；CI #182 `success`（Root、CLI unit/e2e、Web unit/build/typecheck、Playwright）
- **覆盖维度**：产品逻辑、CLI/Web UI、UX、Session/Runtime 架构、代码实现、测试可信度、DeepSeek Harness 对齐、过度实现与过度设计
- **结论**：**本轮新增改动总体方向正确，但仍不能通过“面向普通人稳定可用”的产品验收；PR 作为实验性基础设施与低风险 UX 改进可进入代码审阅。**

> 本报告基于用户在首轮评审后推送的最新实现重新生成，取代“只看首次提交”的结论。它同时纠正首轮报告中过强或失效的表述，并区分“本 PR 可合并”与“Tekon 产品里程碑已通过”。

---

## 1. 执行摘要

最新改动真实改善了两件事：

1. CLI 无参数入口、帮助首屏和产品版本身份已经明显更适合人类使用；
2. Session 列表开始展示最近活动和“待审批 / 待输入 / 需处理”，不再只是静态创建时间列表。

但复核后确认，第二项在用户推送的版本中仍是**部分闭环**：

- 服务端虽然派生了 `needsAction`，列表却仍主要按最近事件排序，最新的普通运行可能压过待审批任务；
- `session.list.lastActivityAt` 使用最新事件，而 `session.get.lastActivityAt` 仅使用 `updatedAt`，同一字段存在两种语义；
- 列表聚合只看事件时间，状态变化的 `updated_at` 可能被忽略；当 best-effort Event projection 丢失时，行动状态不会可靠置顶；
- `LEFT JOIN + max(timestamp) + group by` 会随 Session 事件总量增长，每次打开列表都重新聚合完整事件历史；
- `unread / changedSinceSeen`、全局实时刷新和长 Session 规模化仍未实现。

本轮已顺手把前三项可低风险关闭的内容补齐，并把测试从任意 `setTimeout(20ms)` 改为确定性时间数据。事件聚合性能、未读语义和全局实时列表属于后续规模化工作，不能在报告中写成 P1-04 整体已完成。

整体产品判断没有改变：Tekon 当前是一个边界诚实、测试较强的**受控交付执行与观察工具**，还不是一个可持续追问、转向、恢复并逐步升级到交付的通用协作工作台。

---

## 2. 复审方法与范围

本轮重新检查了：

- 产品说明与边界：`README.md`、用户手册、当前范围基线、近期评审报告；
- CLI：无参数入口、帮助、版本、初始化、run、状态与交付命令；
- Web：Session 列表/详情、Composer、EventFeed、Token、RPC/SSE、审批与运行控制；
- Core：Session store、Job runner、SessionService、workflow executor、dual-write、AgentDriver、Provider/DSH bridge；
- 测试与发布：Core/CLI/Web 测试、Playwright、CI、版本与报告一致性；
- 外部基线：DeepSeek Harness 官方 Architecture、Agent Lifecycle、Persistence、Safety 和最新 prerelease。

这是“仓库级结构覆盖 + 关键产品/运行路径代码级深读”，不宣称逐行审阅每个辅助文件。本轮没有新的本地已部署实例可供全站像素级视觉巡检，因此 UI 判断以实现、契约、已有 Playwright 与用户已记录的截图验证为依据。

---

## 3. 对最新整改的逐项裁决

| 整改项 | 裁决 | 理由与依据 |
| --- | --- | --- |
| CLI 无参数显示帮助并返回 0 | **通过** | `packages/cli/src/index.ts` 已把空命令交给 `commandHelp`，测试锁定与 `tekon help` 等价。首次探索不再被当作用法错误。 |
| 帮助页前置人类路径 | **通过** | `packages/cli/src/commands/help.ts` 首屏先给 `tekon ui`、直接 run 和高级帮助，完整命令树仍保留。 |
| CLI / updater 统一产品版本 | **通过（用户可见范围）** | `packages/cli/src/lib/utils.ts` 改读根 `package.json`；私有 workspace 包仍保留内部 `0.7.0`，但不再作为 CLI 产品版本展示。 |
| Session 最近活动排序 | **部分通过，本轮补强** | 用户版本按事件最新时间排序，但忽略 status-only `updated_at`；本轮将两者取最大值。 |
| `needsAction / actionKind` | **部分通过，本轮补强** | 用户版本只显示徽标，没有把需人处理的 Session 排到普通活动前；本轮新增稳定 attention ranking。 |
| `session.get.lastActivityAt` | **未通过，本轮修复** | 用户版本明确注释 list/get 语义不同；本轮读取事件尾部并与 `updatedAt` 取最新，统一字段合同。 |
| P1-04 整体关闭 | **不接受** | 行动排序当前范围可关闭，但 unread、changedSinceSeen、全局实时刷新和大规模查询仍缺失。 |
| 首轮报告 P0-01 表述 | **接受整改意见** | “现有受控交付合同不成立”过强。当前 Deliver 路径文案诚实、流程成立；真正缺失的是 Collaborate 产品轨道，而不是现有 Deliver 全部无效。 |
| 报告代码依据 | **需修正，已修正** | 原批注引用 `packages/core/src/workflow/goal-job-executor.ts`，该文件不存在。Goal 实际由 `workflows/goal.yaml`、Goal role 与 `workflow-job-executor.ts` 的 `goal-run` 分支驱动。 |

---

## 4. 产品逻辑与定位

### 4.1 已成立的产品合同

Tekon 当前对“受控交付”的描述基本诚实：

- 默认启动完整 `standard-delivery`；
- 需求、角色、Gate、Artifact、审批和 PR 创建均有明确边界；
- PR 创建仍要求显式人工批准；
- README 和 Composer 已写明它不是轻量对话，也没有同 Session 追问/转向。

因此，本轮不再使用“Session 产品合同完全不成立”这一过强结论。

### 4.2 仍未成立的更大产品目标

如果目标是“人类可自然进入并持续使用的研发工作台”，仍缺少最核心的纵向闭环：

```text
提出问题
→ 看到真实执行期输出
→ 继续补充 / 纠偏 / 转向
→ 刷新或重启后恢复
→ 明确升级为 Deliver
→ 进入现有治理和 PR 链路
```

当前 Composer 只创建新 run；`LegacyAgentDriver.followUp()`、`steer()`、`resume()` 仍抛 `NotSupportedYet`；`agent-step-events.ts` 仍在 `runAgent()` 完成后合成 step/tool/assistant 事件。这说明 Tekon 已经能“跑一次受控流程”，但还不能“和人持续协作”。

### 4.3 结论

- **Deliver 产品轨道**：实验性可用，合同基本成立；
- **Collaborate 产品轨道**：尚未实现；
- **面向普通人的稳定研发工作台**：不通过。

---

## 5. UI 与 UX 复审

### 做得更好的部分

- 无参数 CLI 入口从错误提示变成可发现首页；
- Session 列表增加行动徽标与相对时间，信息密度更接近任务中心；
- 受控交付、技术事件开关、状态徽标、移动端抽屉和基础可访问性方向正确；
- 旧 Cockpit 放入 `/advanced`，默认入口不再直接暴露所有治理内部结构。

### 仍存在的问题

#### P1-UX-01：列表不是全局实时任务中心

`useSessionStream` 只在打开某个 Session detail 时订阅该 Session，并在特定事件到达时 invalidate `session.list`。用户停留在列表页时没有全局事件订阅，仍依赖手动刷新或其他查询失效。因此“行动任务自动置顶”是**下一次查询时正确**，不是任务中心级实时能力。

建议：后续由 daemon / workspace event stream 推送轻量 Session summary 变化，而不是为列表页打开每个 Session 的 SSE。

#### P1-UX-02：相对时间不会自行推进

`SessionsPage` 的“刚刚 / N 分钟前”只在 React 重新渲染时计算。长时间停留页面不会自动从“刚刚”更新为“5 分钟前”。这是低严重度体验问题，可用分钟级共享 ticker 解决，不应为每行创建 timer。

#### P1-UX-03：启动完整 Deliver 前缺少预览

`tekon run "需求"` 与 Web 主按钮会直接进入完整链路，用户点击前仍看不到：

- 角色、节点和关键 Gate；
- Provider、网络、超时和工作区边界；
- 是否会产生多次模型调用；
- 轻量替代路径；
- 潜在人工审批点。

建议在启动前提供简洁 run plan；不需要虚假精确的 token/价格估计，只需明确规模和成本影响因素。

#### P1-UX-04：Token 仍是产品表面的一等控件

URL fragment bootstrap 对本地工具合理，但普通用户长期看到 Token 字符串输入框仍暴露实现细节。自动应用虽有 350ms debounce，仍不等于显式确认。建议最终迁移到“已连接 / 连接失败 / 重新授权”的状态化 UI，手工替换放入高级安全设置。

#### P1-UX-05：产品术语仍偏工程内部

Session、Event、Job、Profile、Gate、Advanced 等术语仍直接出现在普通用户路径。建议产品层统一为“任务、过程、审批、结果、交付”，技术词只出现在诊断和高级页。

---

## 6. 整体框架与 Runtime 架构

### P0-ARCH-01：执行所有权仍未闭环

事实：

- Web composition root 会启动 JobRunner；
- CLI run/resume 也会创建并启动 JobRunner；
- 两者共享项目 SQLite、Git refs、worktree、运行目录和子进程世界；
- Job owner/status 条件写与 Git ref CAS 只能保护部分写入；
- Node、Artifact、Gate、Audit、Delivery、文件和子进程没有同一个持久 generation authority。

风险：进程停顿、租约过期和重新领取后，旧执行仍可能在下一次检查前写入共享副作用。

建议仍是 **single-owner daemon 优先**：一个 repo 一个 Runtime；CLI/Web/IDE 都是客户端。只有明确需要高可用多 owner 时，才承担完整 generation fencing 成本。

### P0-ARCH-02：Shutdown 仍非 quiescent

`job-runner.stop()` 最多等待固定时间后清理进程内 Map。清引用不等于 provider、subprocess、Git/文件写入和异步 listener 已全部停止。

通过条件：停止领取、持久取消/暂停、abort、kill、join、flush、最终状态写入、证明无 late write，然后才关闭 DB/进程。

### P0-ARCH-03：Session Event 仍是观察投影，不是 Harness 式事实源

`dual-write.ts` 明确采用“旧领域表先成功，Session Event best-effort 追加”。这对迁移期 observability 合理，但不能同时承担：

- 模型历史；
- durable inbox；
- follow-up/steer 消费记录；
- crash resume；
- fork / transcript；
- 完整 replay。

后续必须二选一：

1. 保留旧领域表为治理事实源，把 Session Event 明确限制为 UI projection；或
2. 让对话域采用 authoritative append-only log，并以事务/outbox 投影到治理域。

不要继续让同一 Event 名词同时暗示两种可靠性等级。

---

## 7. 代码实现与测试质量

### 7.1 本轮新增代码的优点

- `deriveSessionAction` 集中在服务端，客户端没有从零散事件重复推断；
- RPC schema 明确增加 `lastActivityAt / needsAction / actionKind`；
- E2E 覆盖了真实待审批徽标；
- Core/CI 在用户最新 Head 上均已通过，说明新增路径至少没有破坏现有构建门。

### 7.2 本轮发现并修复的实现问题

#### CODE-01：行动语义未参与排序

用户版本先按事件时间排序，再附加 `needsAction` 字段；这会让刚产生普通技术事件的 active Session 压过较早的待审批 Session。

本轮修复：服务端按以下 attention rank 排序：

```text
needsAction → active → idle → terminal history
```

同一组内继续按 `lastActivityAt` 降序。

#### CODE-02：`lastActivityAt` 双重语义

用户版本：

- list = `max(session_events.timestamp)`；
- get = `sessions.updated_at`。

本轮修复：list/get 均取“创建、状态更新时间、最新事件时间”的最大值。这样 status-only 改变和 best-effort event 缺失都不会让行动状态显得陈旧。

#### CODE-03：测试依赖 20ms sleep

新增 Core/API 测试用 `setTimeout(20ms)` 制造时间顺序，容易在高负载 CI 上形成偶发失败，也没有精确说明测试意图。

本轮 API 测试改为直接写入固定 ISO 时间，确定性证明：

- action session 即使活动时间更旧也排在 active session 前；
- `updated_at` 可覆盖旧事件；
- get/list 使用同一个最近活动合同。

Core 原测试中的 20ms 等待仍建议后续改成固定时钟或直接时间 fixture。

### 7.3 仍需保留的问题

#### P1-PERF-01：Session 列表查询随事件历史增长

当前 Core 查询：

```sql
left join session_events
+ max(e.timestamp)
+ group by session
```

现有索引是 `(session_id, seq)`，不是面向 `max(timestamp)` 的列表快照索引。随着长 Session 增长，每次列表请求会重新聚合历史事件，与“长 Session 有界化”目标冲突。

推荐方案：

- 在 Session summary / projection 表持久维护 `last_activity_at`；或
- 使用 `(session_id, seq desc)` 读取每个 Session 最后一条事件，并把 `updated_at` 作为可靠 fallback；
- 列表分页，不一次加载全部 Session。

不建议简单增加更多临时 JOIN 和客户端推断。

---

## 8. DeepSeek Harness 对齐复审

官方资料：

- Architecture：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md>
- Agent lifecycle：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/agent-lifecycle.md>
- Persistence：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/persistence.md>
- Safety：<https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md>
- `dsh-v0.1.2-alpha.1`：<https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.1>

官方当前架构的关键点：

- Session log 是模型上下文、replay、fork、resume 和 transcript 的来源；
- user/assistant/tool/turn/step 是 durable facts；
- inbox claim 与 live Agent events 分离；
- `web / headless / sdk / sdk-minimal / acp` 通过 Profile 启动；
- 最新 prerelease 已继续增强运行中消息排队、回合导航、token 用量与 ACP 会话控制；
- Safety 明确说明尚未安全审计，sandbox/approval 不能保证隔离。

Tekon 当前 `dsh-headless` 仍固定 `0.1.1-rc.2`、one-shot argv/stdout、仅 Goal 可用。精确版本 fail-closed 是优点，但桥接面已经落后于官方产品接口范围。

建议做一次小型 ADR，只选一种：

- **Provider adapter**：Tekon 保持 workflow authority，通过 SDK/ACP 获得 streaming、cancel/resume/inbox；或
- **Session authority**：采用 DSH Agent/Session lifecycle，Tekon 只叠加 Deliver/governance。

继续扩展“自建半套 Harness + headless one-shot”会加重重复抽象。

---

## 9. 过度实现与过度设计判断

### 应保留

- Workflow/Gate/Artifact/Audit/Delivery：这是 Tekon 与普通聊天式 Agent 的差异化资产；
- SessionService 集中 run/resume/cancel/pause orchestration；
- Provider snapshot、Git CAS、审批与远端副作用边界；
- 测试中的竞态和状态机故障注入。

### 应冻结扩展

| 模块 | 当前成本 | 尚未兑现的核心收益 | 建议 |
| --- | --- | --- | --- |
| `LegacyAgentDriver` | 冻结接口、buffer、NotSupported 分支 | 无生产持续会话调用方 | 下一 Collaborate slice 真正使用，否则删除 |
| Profile / Automation | 策略矩阵、listener、额外 job kind | 轻量协作尚不存在 | 暂停新增 profile 和 automation 类型 |
| Goal mode | 模板、角色、特殊治理边界 | 仍不是持续轻量会话 | 不继续扩展，优先 Collaborate |
| dual-write | 两套事实词汇与失败语义 | 不能恢复/重建 | 限定为投影，或迁移到 outbox |
| Web/CLI composition root | 重复装配且均能启动 runner | 无单一 owner | 收敛到 daemon composition root |
| dsh-headless ACL | 版本 probe、环境隔离、one-shot 解析 | 无 streaming，仅 Goal | SDK/ACP ADR 后替换或删除 |

结论：代码局部质量不差，问题是**系统级抽象顺序领先于用户闭环**。下一阶段不应继续横向平台化。

---

## 10. 本轮直接修改

1. **Session attention sorting**：待审批、待输入、失败任务优先于普通 active/历史任务；同组按最近活动排序。
2. **统一 `lastActivityAt`**：list/get 同时考虑 `createdAt`、`updatedAt` 和事件尾部，消除字段双重语义。
3. **确定性 API 测试**：移除 20ms 等待，固定时间数据验证行动优先、状态 fallback 和 get/list 一致性。
4. **类型与本地化收敛**：行动标签使用 `SessionActionKind` 闭集，超过 7 天的日期固定使用 `zh-CN`。
5. **重新生成本报告**：纠正 P0-01 过强措辞、P1-04 过度关闭和不存在的 `goal-job-executor.ts` 引用。

本轮未修改 P0 Runtime/Session authority，因为这些不是可以在一次复审补丁中安全完成的局部修复，需要独立 ADR 与纵向 PR。

---

## 11. 推荐实施顺序

### A. Runtime authority

1. repo single-owner daemon / lock；
2. CLI、Web、IDE 客户端化；
3. quiescent shutdown；
4. 故障注入验证停顿、kill、restart、late write。

### B. Collaborate vertical slice

1. 一个真实 Provider execution-time streaming；
2. durable inbox + claim/idempotency；
3. follow-up、steer、cancel、resume；
4. 刷新和进程重启恢复；
5. 一条真实 Provider E2E。

### C. Collaborate → Deliver

1. 明确模式升级；
2. 展示 run plan、角色、Gate、权限和成本影响因素；
3. 接入现有 Artifact/Gate/Delivery；
4. 用可靠 link/outbox 连接对话域与治理域。

### D. Scale and polish

1. Session summary projection 与分页；
2. turn 导航、虚拟化、摘要和上下文压力；
3. 未读/已读与全局实时任务列表；
4. 产品词汇和状态化连接 UI。

---

## 12. 验证与验收结论

### PR / 代码合并门

- CLI UX 改进：**通过**；
- 版本身份改进：**通过**；
- Session action projection：**本轮补强后通过当前小范围验收**；
- Root build/typecheck：**通过**；
- CLI unit/e2e：**通过**；
- Web build/typecheck/unit：**通过**；
- Web Playwright e2e：**通过**；
- Core workflow：**通过**；
- 最新整改是否引入明显回归：**未发现**。

### 产品验收门

仍有以下未关闭条件：

- [ ] 当前 Session 可继续输入、转向并在重启后恢复；
- [ ] Provider 输出为执行期真实流；
- [ ] Collaborate 与 Deliver 是行为不同的明确轨道；
- [ ] 一个 repo 有单一 Runtime owner，或全副作用持久 fencing；
- [ ] shutdown 可证明无在途执行和 late write；
- [ ] 对话事实有权威 log / durable inbox；
- [ ] 长 Session 数据和 DOM 有界；
- [ ] DSH 接口选择重新对齐 SDK/ACP 与官方 Safety；
- [ ] 产品验收 gate 与 CI/merge gate 分离。

因此最终结论是：

# **不通过稳定产品验收；实验性受控交付基础设施与本 PR 的低风险改进可继续合并审阅。**

本 PR 的合并不能被解释为上述 P0/P1 已自动关闭。

---

## 13. 复审视角批注（second-perspective annotation）

### 13.1 代码实现与引用核验证实

| 编号 | 处置标注 | 核验证据（文件:行） | 理由与说明 |
| --- | --- | --- | --- |
| **CODE-01** | **已实现且正确** | `packages/web/src/server/api/routers/session.ts:44-64, 105`<br>`packages/web/__tests__/api/session-read-api.test.ts:193-198` | **核验证实**：作者在提交 `6da5ee1` 已实现服务端 `attentionRank` 排序（`needsAction`=0 → `active`=1 → `idle`=2 → `terminal`=3，同组按 `lastActivityAt` 降序），并在 `session-read-api.test.ts` 中通过多状态 session 列表测试锁定。 |
| **CODE-02** | **已实现且正确** | `packages/web/src/server/api/routers/session.ts:25-37, 96-100, 141-145`<br>`packages/web/__tests__/api/session-read-api.test.ts:200-209, 255-263` | **核验证实**：作者在 `6da5ee1` 统一了 `session.list` 与 `session.get` 的 `lastActivityAt` 契约，通过 `latestActivityTimestamp` 取 `createdAt`、`updatedAt` 与最新事件时间的最大值，消除 list/get 双重语义，并在测试中验证一致性。 |
| **CODE-03** | **已实现且正确** | `packages/web/__tests__/api/session-read-api.test.ts:168-187` | **核验证实**：作者在 `6da5ee1` 移除了 API 测试中的 `setTimeout(20ms)` 竞态依赖，改为写入固定 ISO 时间戳证明行动优先、`updated_at` fallback 以及 get/list 契约一致性，消除高负载 CI 偶发不稳定。 |
| **CITATION** | **已修正** | `docs/reviews/2026-08-28-tekon-human-first-harness-architecture-review.md:485`<br>`docs/reviews/2026-08-28-tekon-human-first-harness-architecture-review.html:983-992`<br>`workflows/goal.yaml:1-16`<br>`packages/core/src/session/workflow-job-executor.ts:165-166`<br>`packages/core/src/workflow/engine.ts:71`<br>`packages/core/src/session/profile-policy.ts:10-35` | **已在首轮报告修正**：确认首轮报告 §13.2 P1-02 引用的 `packages/core/src/workflow/goal-job-executor.ts` 文件不存在。Goal 模式实际由 `workflows/goal.yaml` 定义模板、`workflow-job-executor.ts` 分发 `goal-run` 以及 `engine.ts` 的 `kind: 'goal'` 承接。已在本轮将首轮 md 与 html 的引用替换为真实准确路径。 |

### 13.2 本轮轻量修复项

| 编号 | 处置标注 | 核验证据（文件:行） | 理由与说明 |
| --- | --- | --- | --- |
| **P1-PERF-01** | **本轮修** | `packages/core/src/session/session-store.ts:322-338`<br>`packages/core/__tests__/session/session-store.test.ts` | **已完成优化**：`listSessions` 由全量 `LEFT JOIN session_events + group by s.id` 改为相关子查询 `(select e.timestamp from session_events e where e.session_id = s.id order by e.seq desc limit 1)` 反向扫描取尾。<br>**正确性依据**：`appendEvent` 在同一 `BEGIN IMMEDIATE` 事务内 `seq=max(seq)+1` 与 `timestamp=now()` 同序分配，故 `max(seq)` 事件恒为最新 timestamp；毫秒 tie 时 seq-desc 比 max(timestamp) 更精确。消除历史事件全聚合 O(N) 开销，语义与返回结构保持不变。 |
| **P1-UX-02** | **本轮修** | `packages/web/src/client/hooks/use-ticker.ts:1-12`<br>`packages/web/src/client/hooks/index.ts`<br>`packages/web/src/client/pages/SessionsPage.tsx:47` | **已引入共享 ticker**：新增页面级 `useTicker(60_000)` 定时驱动重渲染，单定时器且卸载时清理，避免为每行创建 timer。<br>**测试范围诚实说明**：本仓库 web vitest 环境为 `node`（无 jsdom / `@testing-library`），既有 effect 类 hook 惯例为只测纯逻辑，effect / DOM 交付 Playwright e2e 验证；useTicker 为薄胶水，遵循惯例不引入 jsdom / 不加 renderHook 单测；`formatRelativeTime` 纯函数保持不变。 |

### 13.3 架构与 UX 演进 ADR 递延项

| 编号 | 处置标注 | 核验证据（文件:行） | 理由与说明 |
| --- | --- | --- | --- |
| **P0-ARCH-01** | **ADR递延（阶段A）** | `packages/web/src/server/api/root.ts:170-178`<br>`packages/cli/src/lib/session-context.ts:50-78`<br>`packages/core/src/db/repositories.ts:569-588`<br>`packages/core/src/session/session-store.ts:25-45` | 事实 multi-owner 成立：Web 与 CLI 均可启动 `JobRunner` 竞争 SQLite 与 Git。闭环需引入 single-owner daemon（推荐）或全副作用持久 generation authority + fencing，属重大架构决策，归入 §11 阶段 A。与首轮 P0-02 同类。 |
| **P0-ARCH-02** | **ADR递延（阶段A）** | `packages/core/src/session/job-runner.ts:514-544` | 事实成立：`job-runner.stop()` 最多等待固定时间后仅清理进程内引用，无跨进程/全副作用的 quiescent join 证明。随 single-owner daemon 在 §11 阶段 A 建立明确 shutdown 契约。与首轮 P0-03 同类。 |
| **P0-ARCH-03** | **ADR递延（阶段C）** | `packages/core/src/session/dual-write.ts:14-25, 227-249`<br>`docs/technical/tekon-replatform-current-scope.md:§3` | 事实成立：`session_events` 当前为旧领域写入后的 best-effort projection，旧表仍是交付事实源。当前 projection-only 已在范围基线明文化并被接受；升级为权威 log + transactional outbox 归入 §11 阶段 C。与首轮 P0-04 同类。 |
| **P1-UX-01** | **ADR递延（阶段D）** | `packages/web/src/client/lib/session-stream.ts:80-120`<br>`packages/web/src/client/pages/SessionsPage.tsx` | 列表页目前未开启全局 SSE 订阅，依赖手动刷新或查询失效。后续由 workspace event stream / daemon 推送 Session summary 变化，归入 §11 阶段 D。与首轮 P1-06 同类。 |
| **P1-UX-03** | **ADR递延（阶段C）** | `packages/cli/src/commands/run.ts:54-92`<br>`packages/web/src/client/components/sessions/SessionComposer.tsx:29-85` | 默认启动完整交付缺少启动前 run plan 预览（角色、Gate、成本、边界）。随 §11 阶段 C 的需求确认与 Deliver 升级一同落地。与首轮 P1-03 同类。 |
| **P1-UX-04** | **ADR递延（阶段D/token ADR）** | `packages/web/src/client/layouts/TopBar.tsx:14-42`<br>`docs/technical/tekon-web-architecture.md` | URL fragment bootstrap 适合本地轻量认证，长期应迁移到状态化连接 UI；避免破坏现有 E2E 测试，随 §11 阶段 D 及 token ADR 统一重构。与首轮 P1-05 同类。 |
| **P1-UX-05** | **ADR递延（阶段D）** | `packages/web/src/client/pages/SessionsPage.tsx`<br>`packages/web/src/client/pages/SessionDetailPage.tsx` | 产品层词汇标准化应在后续里程碑统一建立词汇表与文案测试，避免零散替换引发词汇漂移与断言失败，归入 §11 阶段 D。与首轮 P1-07 同类。 |

