# Tekon Harness Replatform 第十三轮权威全面复审

> 复审日期：2026-08-28  
> PR：#10 `review/deepseek-harness-migration-2026-08-20` → `main`  
> 第十二轮报告提交：`ef56dfa17e0feb97d0ac2545db9e9430525caa51`  
> 实施方第十二轮批注提交：`8e39c9c560aaddbd025e246f5caaec1cb9773638`  
> 实施方代码增量：**无**；仅修改第十二轮报告、CHANGELOG 和根版本号  
> 本轮新增范围基线：`docs/technical/tekon-replatform-current-scope.md`  
> 复审维度：产品逻辑、UI 实现、UX 交互、整体框架、并发与恢复、代码实现、测试可信度、范围治理、版本治理、过度实现与过度设计

---

## 1. 最终结论

# **第十二轮批注没有带来产品或 Runtime 实现；当前 PR 整体仍不通过**

实施方对第十二轮报告的部分事实判断是正确的：剩余问题确实包含重大架构选择，不适合在没有边界的情况下继续堆入一个超大 PR；Git CAS、Job 条件写、认证 bootstrap、移动端和 CI 改善也应继续保留。

但本轮增量只有：

```text
CHANGELOG.md
第十二轮报告批注
package.json 0.15.4 → 0.15.5
```

没有 Provider streaming、durable inbox、Session 持续输入、Runtime lock、persistent execution authority、Node CAS、shutdown quiescence、Narrative Feed、Final Result 或长会话实现。因此，批注可以解释“为什么未做”，不能把这些验收项转换为“已经通过”。

本轮按不同验收对象分别裁决：

| 验收对象 | 第十三轮结论 |
| --- | --- |
| 第十二轮实施方批注的事实核验 | **部分接受** |
| 当前范围状态的文档收敛 | **本轮已补基线，文档层通过** |
| 第十二轮之后的产品/Runtime 整改 | **没有代码增量，无法判为完成** |
| 生产认证 bootstrap、移动端抽屉、Git ref CAS | **继续通过** |
| 当前 PR 作为默认并发 Runtime 合入 `main` | **不通过** |
| 当前 PR 完成原始完整 Harness-inspired replatform | **不通过** |
| 普通用户持续协作产品 | **不通过** |
| 单进程、单用户、明确 experimental 的基础设施快照 | 仍需代码级 single-owner enforcement 后才能评估 |

---

## 2. 本轮审查方法与证据边界

本轮重新核验了：

- 第十二轮报告之后的全部 Git 增量；
- 报告内实施方批注与实际代码的一致性；
- 原始总体执行方案、阶段 2/3 详细设计与当前 README/PR 描述；
- Provider 调用链、Agent Event 产生时机与 AgentHandle 能力；
- Session Event dual-write、Job owner、Node transition、Git promotion 和 shutdown；
- Session List、Session Detail、Feed、Inspector、Token、SSE 和长会话客户端；
- 根版本、CLI 版本、`tekon update` 和 CHANGELOG 之间的发布语义；
- 最新正式 GitHub Actions 和 Playwright 日志。

UI/UX 审查基于当前 React/CSS/路由实现、组件测试和 Playwright journey。本运行环境没有可控制的产品浏览器用于新一轮截图采集，因此本报告**不声称完成新的截图级视觉验收**；颜色对比、最终视觉密度、超长真实内容和屏幕阅读器实际播报仍需后续浏览器审计。

---

## 3. 对实施方第十二轮批注的裁决

### 3.1 接受的部分

以下判断成立：

- 第十二轮之后没有新的产品或 Runtime 代码；
- single-owner daemon 与完整 multi-owner fencing 都是重大架构工作；
- 不应继续在当前超大 PR 中无边界扩展 Event、Profile 和 Automation；
- Session Event 当前确实是 best-effort projection，治理主表仍是事实源；
- 真实 streaming、follow-up/steer、durable inbox、双轨产品和长会话均未实现；
- Git `update-ref` expected-old OID、Job owner/status 条件写和现有 CI 改善应保留；
- 当前 README 对产品边界的描述比早期版本诚实。

### 3.2 不接受的部分

实施方把全部剩余项归类为“非 PR-local 必修、等待用户 ADR 决策”，这个分类过宽。

#### 文档状态错误本身就是 PR-local 问题

原始总体方案要求阶段 0–5 完整推进；阶段 2、阶段 3 的验收包含 streaming、inbox、follow-up/steer 和持续 Session。但后续详细设计一边递延这些能力，一边在文件头标记“已实施”“全部实现完成”。

修正这些状态不需要重写 Runtime，也不需要先选择 single-owner 或 multi-owner；这是当前 PR 可以直接完成的事实修复。

本轮已新增：

```text
docs/technical/tekon-replatform-current-scope.md
```

它具有状态覆盖优先级，明确当前真实范围是：

```text
Phase 0 + Phase 1
+ Phase 2a compatibility projection
+ partial Phase 3 observer/control UI
+ selected experimental Phase 4/5 pieces
```

而不是阶段 0–5 完成。

#### “需要决策”不等于“当前正确”

当前 Web 和 CLI 可以同时成为 JobRunner owner，这是现有部署事实。项目当然需要决定最终采用 single-owner 还是完整 multi-owner；但在决定和实现前，当前默认并发 Runtime 仍是不通过，而不是一个可以忽略的未来功能。

#### 报告批注不能替代代码级约束

文档写“仅单进程使用”不能阻止另一个 CLI/Web 进程启动。若把当前 PR 当作 experimental snapshot 合并，也至少需要项目级 Runtime lock 或第二 owner fail-fast，才能让部署约束成为可验证事实。

---

## 4. 本轮新发现

### P1-PROCESS-01：纯复审 PATCH 版本会触发真实更新流程

实施方把根版本从 `0.15.4` 提升为 `0.15.5`，明确理由是：报告批注与措辞订正，没有代码行为变化。

但根版本不是无副作用的文档标签。`tekon update` 会：

```text
读取本地根 package.json version
→ git fetch origin main
→ 读取远端根 package.json version
→ 版本不同则 checkout/pull
→ pnpm install --frozen-lockfile
→ pnpm build
```

因此，纯评审文档每次抬高根 PATCH 版本会让用户看到“有新版本”，并触发完整依赖安装和构建，即使 Runtime 没有变化。

同时，根版本当前为 `0.15.5`，而 `@tekon/cli`、`@tekon/core`、`@tekon/web` 的包版本仍显示为 `0.7.0`；CLI 帮助从 CLI 包自己的 `package.json` 读取版本，而 update 命令比较根版本。这形成两个可见的版本身份。

影响：

- 更新提示和用户获得的行为变化不匹配；
- 每轮复审都可能触发重型更新；
- CHANGELOG 被评审过程淹没，用户很难识别真正的功能和修复；
- 根版本与可执行包版本的含义不清。

本轮处置：

- 没有再为第十三轮报告提升版本；
- 新范围基线明确：纯报告、批注和验收状态调整不单独 bump 产品版本；
- 后续应把评审记录留在 `docs/reviews/`，发布日志只保留用户可见行为和兼容变化。

判定：**当前产品不因这一项单独阻断，但这是明确的过度实现和发布治理问题。**

### P1-PRODUCT-02：Session List 与 Detail 的状态可能长期陈旧或互相矛盾

`SessionsPage` 对 `session.list` 只执行普通 Query，更新入口主要是手工“刷新”。它没有订阅 Session lifecycle，也没有周期刷新。

`SessionDetailPage` 同时使用两套状态来源：

- Header 的 `StatusBadge` 来自首次 `session.get`；
- 右栏 RunControls 和 Final Result 从实时 Events 派生。

当 Run 在页面打开后从 running 进入 passed/failed/paused 时，右栏可能已经显示终态，Header 仍显示旧 `session.status`。返回列表后，列表也可能继续显示旧状态，直到用户手动刷新。

此外，`listSessions()` 按 `created_at desc` 排序，而不是按 `updated_at`、最后事件或“需要用户操作”排序。长程使用后，最近活跃或待审批的旧 Session 不会自动浮到前面。

建议：

```text
服务端稳定投影：lastActivityAt / currentPhase / needsAction / terminalSummary
→ Session Detail 收到 lifecycle Event 时更新同一 query cache
→ Session List 通过 workspace-level stream 或有界轮询更新
→ 默认排序 needsAction > active > updatedAt desc
```

判定：**P1 产品逻辑不通过。**

### P1-OBSERVABILITY-03：best-effort projection 失败没有可恢复的健康状态

当前 dual-write 会先完成旧领域表写入，再 best-effort 追加 Session Event；失败只调用 console error，不影响主流程。

这符合 projection-only 的治理原则，但 UI 没有：

- projection lag；
- missing-event / degraded 标记；
- backfill checkpoint；
- rebuild 操作；
- “当前 Feed 可能不完整”的提示。

而 Event append 失败时不会分配 seq，客户端也看不到序号缺口。因此用户可能看到一个正常 passed 的 Run，但 Feed 缺少 Assistant、Tool、Gate 或 Artifact 事件，且没有任何可见信号。

若继续采用 projection-only，应增加持久 projection health、可重建 backfill 和 UI 降级提示；若未来改为 authoritative log，则模型可见事实不能 best-effort 丢失。

判定：**P1 可观测性与恢复不通过。**

### P1-AUTH-04：复制深链或新标签页不是完整产品流程

默认 `tekon ui` 启动 URL 携带 `#token`，当前标签页会写入 `sessionStorage`，同标签页 refresh 已有测试。

但 fragment 被清理后，用户复制当前 `/sessions/:id` 或 `/advanced/...` 地址到新标签页时：

- 新标签页没有旧标签页的 `sessionStorage`；
- URL 已没有 Token fragment；
- 首个 RPC/SSE 将未认证。

共享业务 E2E 当前有意为每次 hard `page.goto` 添加生产形态的 `#token`，因此验证的是“每次深链都从带认证的启动 URL 进入”，不是“复制清理后的地址到新标签页仍能工作”。

这不推翻默认本地启动已可用的结论，但应明确产品边界。后续可以选择：

- 短时单次 bootstrap nonce + HttpOnly/SameSite cookie；
- 页面内“在新标签页打开”生成一次性启动链接；
- 明确的重新连接页面，而不是空 Token 输入框。

判定：**P1 UX，不是当前最高风险。**

---

## 5. 仍未关闭的产品 P0

### P0-PRODUCT-01：主流 Provider 仍是完成后投影，不是执行期增量

当前 `runAgentWithStepEvents()` 的顺序仍然是：

```text
step/start
→ await adapter.runAgent(input)
→ Provider 完整结束
→ 合成 node-level tool/call
→ 合成 tool/result
→ assistant/message
→ step/end
```

因此：

- Tool 事件不是 Provider 的真实工具调用；
- Codex/Claude 主流路径没有 Assistant delta；
- 用户不能在当前请求内 steer；
- UI 在 Provider 完成前看不到真实模型进展；
- 事件名称看起来像 Harness，但产生时机仍是 one-shot。

OpenAI Codex App Server 的 Item lifecycle 是 `item/started → optional item/*/delta → item/completed`，客户端可以在 Item 完成前开始渲染。DeepSeek Harness 的 Turn flow 也明确是 inbox claim、`llm/stream → assistant/chunk* → assistant/message` 和真实 Tool lifecycle。

判定：**不通过。**

### P0-PRODUCT-02：Session 内没有 durable follow-up / steer / resume

当前 `AgentHandle.followUp()`、`steer()` 和 Driver resume 仍未形成生产能力；Session Detail 没有当前 Session 的消息 Composer。

完整能力至少需要：

```text
message id + idempotency key
pending
claimed(owner + generation + lease)
processed / failed
retry / poison handling
turn / step causality
restart recovery
```

Claude Managed Agents 的事件模型会把用户事件先排队，持久事件的 `processed_at` 在处理完成前保持为空；`user.message` 可以继续 Session，`user.interrupt` 可以停止当前执行后用新消息重定向。Tekon 当前没有对应闭环。

判定：**不通过。**

### P0-PRODUCT-03：Collaborate / Deliver 仍未形成后端双轨

当前默认入口已诚实称为“受控交付”，这是正确改善；但轻量 Collaborate 仍不存在。

真正双轨需要在后端语义上不同：

| 维度 | Collaborate | Deliver |
| --- | --- | --- |
| 目标 | 持续讨论、理解、快速修改 | 受控研发交付 |
| 默认成本 | 低 | 高 |
| 编排 | 单 Agent / 小计划 | PM / RD / QA / Reviewer |
| Git | 只读或受限 Patch | Worktree + Delivery Branch |
| Gate | 按风险升级 | 默认完整 |
| 结果 | Answer / Patch / Summary | Evidence / Review / PR / CI |
| 恢复单元 | Session / Turn | Job / Workflow / Delivery |

当前 Profile 主要控制自动推进和 Delivery 行为，并没有形成上述产品差异。

判定：**不通过。**

---

## 6. 仍未关闭的 Runtime P0

### P0-RUNTIME-01：事实 multi-owner 缺 persistent per-claim authority

Jobs 表仍没有 `claim_generation` 或等价的持久 claim token。当前 process-local execution token 能隔离同一进程的旧 Promise，但不能代表另一个进程 reclaim 后的执行代际。

典型风险：

```text
A claim
→ A 停顿，lease 过期
→ B reclaim
→ A 在下一次 heartbeat 发现失权前恢复
→ A 继续 Node / Artifact / Audit / Git 副作用
```

Job heartbeat/checkpoint/settle 已有 owner/status 条件写，这是有效进展；但 execution authority 没有贯穿整个业务副作用链。

判定：**不通过。**

### P0-RUNTIME-02：Node 与领域副作用没有统一 CAS/fencing

Node transition 仍缺 expected-from、revision、owner/generation 和 `changes === 1` 的统一原子语义。

Git promotion 的 expected-old OID CAS 已正确落地，但以下对象没有统一 authority：

- Node status；
- Artifact；
- Audit；
- Gate；
- Delivery；
- subprocess；
- Git commit 到 promotion 之间的整个 side-effect window。

旧 executor 即使最终无法 settle Job，也可能已经产生领域写入或工作区副作用。

判定：**不通过。**

### P0-RUNTIME-03：shutdown 仍不保证 quiescence

`JobRunner.stop()` 的公开语义仍是等待 in-flight job，最多 5 秒，然后返回。超时不等于以下对象已经停止：

- Agent Promise；
- Provider 子进程；
- Gate 命令；
- Git commit / promotion；
- 迟到领域写入。

正确关闭链应为：

```text
停止 claim
→ 停止接收 automation
→ shutdown reason abort 全部 executor
→ kill subprocess registry
→ join Agent / Gate / Git side effect
→ 持久化可恢复状态
→ 最后关闭 DB / HTTP
```

判定：**不通过。**

### P0-ARCH-04：Session Event 的 authority 角色尚未落实到代码边界

本轮新增范围基线已经明确：当前 PR 的 Session Event 是 projection-only。

这关闭了文档歧义，但没有实现未来 authoritative log。只要 Event append 仍允许 best-effort 丢失，就不能宣称：

- 模型上下文从 Event Log 唯一派生；
- durable inbox 由普通 user/message Event 自动获得；
- resume 可以完全从 Event Log 恢复；
- Feed 是完整 interaction history。

判定：**当前 projection 模式本身可接受；作为完整 Harness Runtime 仍不通过。**

---

## 7. UI / UX 复审

### 7.1 已通过并应保留

- 默认入口明确为“受控交付”，不再伪装轻量聊天；
- Session-first 路由；
- legacy Cockpit 降到 `/advanced`；
- 390px 布局不再页面级横向溢出；
- 移动 Drawer 具有 modal、focus trap、Escape、focus restore 和 background inert；
- 单一 Main landmark；
- Feed 使用 `role="log"`；
- 连接状态使用 polite live region；
- 人工 Gate 和 PR 创建保持显式确认；
- 生产 Token fragment 会被清理，RPC/SSE 不把 Token 放在请求 URL。

### 7.2 Feed 仍是底层事件墙

Feed 仍逐条映射：

```text
step/start
step/end
workflow/node-started
workflow/node-ended
gate/result
job/status
artifact/created
unknown event
```

默认用户更需要：

```text
理解需求
形成计划
实施变更
运行验证
请求审批
完成交付
```

底层 Event 应进入 Advanced/Audit，主 Feed 应聚合成任务叙事。

判定：**P1 不通过。**

### 7.3 Inspector 仍复制历史

右栏再次扫描完整 `events[]`，提取 Tool、Artifact 和 Error cards；主 Feed 已展示同一历史。

Inspector 应显示当前状态：

```text
当前 Plan
Changed Files
最新 Checks / Gates
Pending Approval
Risks / Limitations
Final Result
Delivery / PR / CI
Recovery Action
```

判定：**P1 不通过。**

### 7.4 Final Result 仍不足以完成用户验收

当前最终卡片主要是：

```text
运行结束 · status
产物 N · 错误 M
```

需要稳定服务端投影：

- summary；
- changed files / diff；
- build / lint / test；
- gates；
- independent review；
- risks / limitations；
- artifacts；
- branch / PR / CI；
- recommended next action。

判定：**P1 不通过。**

### 7.5 长 Session 仍无界

服务端 `listEventsSince(sessionId, sinceSeq)` 没有 limit；客户端永久积累 `events[]`；Feed 与 SidePanel 分别扫描全量历史；DOM 没有 virtualization。

Append fast path 只优化正常追加，不限制：

- 首次网络 replay；
- 内存；
- 派生成本；
- DOM 数量；
- 大 payload；
- 10k+ Event 使用体验。

判定：**P1 不通过。**

---

## 8. 过度实现与过度设计

### 8.1 应保留的差异化能力

以下不是过度设计：

```text
Workflow
Gate
Artifact
Worktree
Audit
Delivery
Human Approval
Independent Review
```

它们是 Tekon 能成为受控软件交付系统，而不是普通聊天式 Coding Agent 的核心资产。

### 8.2 当前过度设计的位置

横向能力增长明显领先于纵向用户闭环：

```text
Event vocabulary
Profile
Automation Job
Projection checkpoint
AgentDriver / AgentHandle 契约
DSH bridge
multi-owner recovery 部件
```

但一个真实 Provider 尚未完成：

```text
execution-time streaming
→ real tool lifecycle
→ durable follow-up / steer
→ restart recovery
→ same Session replay
→ human-readable final result
```

此外，PR 已超过 170 个提交、200 个 changed files 和 3.5 万行新增；CHANGELOG 也开始记录每轮评审代理的内部工作过程。继续在同一 PR 中增加抽象、报告和版本，只会降低：

- 评审可信度；
- 回滚能力；
- 故障定位；
- 发布信号质量；
- 用户对“版本发生了什么”的理解。

### 8.3 简化建议

立即冻结横向扩展，后续按独立 PR：

1. Runtime lock / single-owner daemon + shutdown；
2. 一个真实 Provider 的 streaming vertical slice；
3. durable inbox + follow-up / steer / resume；
4. Collaborate track；
5. Narrative Feed + Final Result；
6. long-session pagination / virtualization。

---

## 9. 本轮直接修改

本轮没有伪造一个表面代码修复来隐藏架构缺口，只提交了能够确定正确的范围治理改进：

### 9.1 新增当前范围基线

文件：

```text
docs/technical/tekon-replatform-current-scope.md
```

它明确：

- 当前真实完成范围；
- 原始阶段 2/3 尚未整体完成；
- Event Log 当前是 projection-only；
- Runtime ownership 仍未落实；
- 合并和发布边界；
- review-only 文档不再单独抬高产品版本；
- 后续必须拆小 PR。

### 9.2 本轮不 bump 版本

本轮只增加审查和范围状态文档，没有用户可见 Runtime 行为，因此没有再次更新根产品版本。

### 9.3 没有修改核心并发或 Provider 代码

原因：

- single-owner 与完整 multi-owner 是不同架构方向；
- 在没有完整设计、迁移、两进程测试和关闭验证时，零散条件判断会制造虚假安全；
- streaming/inbox 需要完整纵向切片，不能由更多合成 Event 类型代替。

---

## 10. 官方架构对照

### OpenAI Codex App Server

官方把 Agent 交互建模为带生命周期的 typed Item：

```text
item/started
→ optional item/*/delta
→ item/completed
```

Thread 是持久 Session 容器，包含多个 Turn，客户端可以重连并恢复一致时间线。

### DeepSeek Harness

官方架构区分：

- durable Session facts；
- live Agent control；
- inbox claim；
- `llm/stream → assistant/chunk* → assistant/message`；
- real Tool lifecycle；
- 从 Session Log 派生模型历史。

这说明“存在类似 Event 名称”与“实现 Harness Agent Loop”不是同一件事。

### Claude Managed Agents

官方事件流支持：

- `user.message` 启动或继续 Session；
- `user.interrupt` 执行中停止并重定向；
- 持久用户 Event 在处理前 `processed_at = null`；
- live delta 是预览，完成后的 buffered message 是 authoritative record。

这为 Tekon 的 durable inbox 和“预览增量 vs 权威完成事件”提供了直接参考。

### Semantic Versioning

SemVer 把 PATCH 定义为向后兼容的 bug fix。纯复审批注没有修复运行时错误，不应自动被当作一个用户产品 PATCH release，尤其当该版本会触发真实 updater 行为时。

官方资料：

- <https://openai.com/index/unlocking-the-codex-harness/>
- <https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md>
- <https://platform.claude.com/docs/en/managed-agents/events-and-streaming>
- <https://semver.org/>
- <https://git-scm.com/docs/git-update-ref>
- <https://www.sqlite.org/lang_transaction.html>

外部资料用于校准模式和验收标准；最终裁决仍以当前仓库的生产调用链、持久化语义、UI 实现和正式 CI 为准。

---

## 11. 正式验证

实施方批注 Head：

```text
8e39c9c560aaddbd025e246f5caaec1cb9773638
```

正式 GitHub Actions：

```text
Core workflow                     33140441499  success
CI workflow                       33140441564  success
Root typecheck + lint                         success
CLI build + unit + e2e                       success
Web build + typecheck + unit                 success
Web Playwright job               98750077360  success
```

Playwright：

```text
Running 28 tests using 1 worker
28 passed (34.0s)
```

日志中没有 `retry #1`，所以该快照是 28 项首轮通过、0 flaky。

验证边界：

- CI 证明已有断言通过；
- CI 不证明尚未实现的 streaming、inbox、generation、Node/side-effect fencing 或 shutdown；
- 当前测试没有覆盖复制清理后深链到新标签页的认证体验；
- 当前 CI 没有 10k+ Event 性能门槛；
- 本轮没有新的截图级视觉审计。

---

## 12. 合并建议

### 当前不建议作为默认 Runtime 合入 `main`

最低合并门槛仍是以下二选一：

#### 路径 A：代码级 single-owner

- 项目级 Runtime lock；
- 第二 owner fail-fast；
- Web/CLI 通过 daemon/client 协议复用同一 Runtime；
- shutdown abort/kill/join；
- 双进程 E2E。

#### 路径 B：完整 multi-owner

- persistent per-claim authority；
- owner + generation 条件写；
- Node expected-from/revision CAS；
- Artifact/Audit/Gate/Delivery/Git/subprocess fencing；
- stale executor 确定性交错测试；
- shutdown quiescence。

只靠文档声明“单进程使用”不足以把现有部署形态变成安全单 owner。

### 产品发布门槛

- 真实 Provider execution-time streaming；
- durable inbox；
- follow-up / steer / resume；
- Collaborate / Deliver 双轨；
- Narrative Feed / Current-state Inspector / Final Result；
- long-session 有界化；
- 截图、键盘、屏幕阅读器和超长内容验收。

---

## 13. 最终裁决

> **第十三轮仍不通过。**
>
> 第十二轮实施方批注正确承认了大量剩余工作和架构决策，但没有提交任何产品或 Runtime 代码，不能关闭第十二轮核心问题。本轮已经把最容易直接修正的范围状态问题收敛为具有优先级的当前范围基线，并明确 Event Log 的 projection-only 角色与版本策略。
>
> 新确认的问题包括：纯复审版本 bump 会触发真实 `tekon update` 重型流程；Session List/Detail 状态可能陈旧和互相矛盾；best-effort projection 缺少持久健康状态；复制清理后的深链到新标签页没有完整认证闭环。
>
> 真正阻断合并和发布的仍是事实 multi-owner 没有代码级 execution authority、Node/领域副作用 fencing 和 shutdown quiescence，以及 one-shot Provider、缺 durable inbox/follow-up/steer、没有 Collaborate 双轨、Feed/Inspector/Final Result 与长 Session 未产品化。
>
> 推荐现在停止继续扩充本 PR：先以独立小 PR 落实 single-owner daemon，再完成一个真实 Provider 的 streaming → durable inbox → follow-up/steer → recovery 纵向闭环。

本轮未执行 merge、release 或 deploy。
