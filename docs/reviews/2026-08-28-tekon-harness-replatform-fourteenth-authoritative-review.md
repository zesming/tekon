# Tekon Harness Replatform 第十四轮权威全面复审

> 复审日期：2026-08-28
> PR：#10 `review/deepseek-harness-migration-2026-08-20` → `main`
> 第十三轮报告提交：`97ad2f5a7ac413a3adcca814c0a9727caf85cbb0`
> 实施方第十三轮后 HEAD：`d635e6035ade9624f52def8d5a885866ed6d1744`
> 本轮验证快照：`91e5896a4301430d819629ac1bdadd40a4ec2195`
> 维度：产品逻辑、UI、UX、整体架构、并发与恢复、代码实现、测试可信度、版本治理、过度实现与过度设计

---

## 1. 最终结论

# **第十三轮批注没有关闭核心实现缺口；当前 PR 整体仍不通过**

第十三轮之后的实施方增量为：

```text
18106e1 2026-08-28T13:23:08+08:00 docs: 第十三轮复审批注 + 版本治理修复(P1-PROCESS-01) + 阶段文档状态收敛
b9827b5 2026-08-28T13:41:21+08:00 test(review14): stage visual audit capture
b7f4fbb 2026-08-28T13:41:35+08:00 [review14-visual-audit] capture current Session UI
2ba9bee 2026-08-28T13:43:49+08:00 [review14-visual-audit] build web before capture
d72a262 2026-08-28T13:44:34+08:00 fix(web): render session statuses with truthful badge semantics
d80f981 2026-08-28T13:45:13+08:00 refactor(web): share derived live session state with the header
bca6846 2026-08-28T13:45:50+08:00 fix(web): keep the Session header aligned with live run state
d1cf306 2026-08-28T13:47:08+08:00 test(web): lock live Session header status
eda1785 2026-08-28T13:47:26+08:00 test(web): cover session and unknown status badge semantics
7a38e98 2026-08-28T13:49:40+08:00 [review14-visual-audit] force a fresh Session list document
d703e0e 2026-08-28T13:59:40+08:00 [review14-visual-audit] capture settled and closed mobile states
3ff5426 2026-08-28T14:02:48+08:00 docs: remove duplicate phase 3 title
6109eb3 2026-08-28T14:04:55+08:00 [review14-visual-audit] wait for responsive drawer transition
e26c9e1 2026-08-28T14:09:23+08:00 chore(review14): remove temporary visual capture test
6b26da9 2026-08-28T14:09:35+08:00 chore(review14): remove temporary visual capture workflow
659b050 2026-08-28T14:13:22+08:00 feat(web): default the Session feed to human-relevant progress
dc9be73 2026-08-28T14:14:00+08:00 style(web): distinguish narrative and technical Session events
96a4ec6 2026-08-28T14:14:58+08:00 feat(web): keep the Session inspector focused on current results
f3b81b6 2026-08-28T14:16:07+08:00 test(web): lock narrative feed and focused inspector defaults
4670002 2026-08-28T14:21:15+08:00 test(web): make Session density assertions deterministic
cb9aed6 2026-08-28T14:25:25+08:00 test(review14): stage post-fix visual verification
6e3fd65 2026-08-28T14:25:43+08:00 [review14-postfix] capture final Session UI
5dd9e48 2026-08-28T14:28:56+08:00 chore(review14): remove post-fix visual test
9ced29c 2026-08-28T14:29:08+08:00 chore(review14): remove post-fix visual workflow
d635e60 2026-08-28T14:34:01+08:00 docs: restore the approved phase 3 design text
```

增量文件：

```text
M	CHANGELOG.md
M	docs/reviews/2026-08-28-tekon-harness-replatform-thirteenth-authoritative-review.md
M	docs/superpowers/plans/2026-08-24-phase2-streaming-agent-loop-design.md
M	docs/superpowers/plans/2026-08-24-phase3-session-ui-design.md
A	packages/web/__tests__/client/status-badge.test.ts
M	packages/web/__tests__/e2e/session-feed.test.ts
M	packages/web/src/client/components/sessions/EventFeed.tsx
M	packages/web/src/client/components/sessions/SessionSidePanel.tsx
M	packages/web/src/client/components/ui/StatusBadge.tsx
M	packages/web/src/client/pages/SessionDetailPage.tsx
M	packages/web/src/client/styles/sessions.css
```

生产代码增量共 **5** 个文件。本轮确有产品/Runtime 代码，需要逐项按下文验收。

因此，批注可以说明为何某些工作需要 ADR 或独立 PR，但不能将尚未实现的验收项改写成“已经通过”。

### 分层裁决

| 验收对象 | 第十四轮结论 |
| --- | --- |
| 第十三轮实施方批注事实核验 | **部分接受** |
| 范围与阶段状态文档 | **本轮进一步收敛，通过** |
| 纯复审文档的版本治理 | **本轮已纠正，通过** |
| 第十三轮后的产品/Runtime 整改 | **存在代码增量，见逐项结果** |
| 默认并发 Web/CLI Runtime | **不通过** |
| 普通用户持续协作产品 | **不通过** |
| Experimental / partial infrastructure 快照 | 可继续研究；合并仍需代码级 Runtime ownership 边界 |

---

## 2. 对实施方批注的裁决

### 接受

- 当前剩余的 single-owner daemon 或完整 multi-owner fencing 是重大架构工作，不应继续无边界堆入超大 PR；
- Session Event 当前是 best-effort projection-only，而不是 Harness 式 authoritative interaction log；
- 真实 streaming、durable inbox、follow-up/steer、Collaborate、长 Session 均尚未实现；
- Git expected-old OID CAS、Job owner/status 条件写、认证 bootstrap、移动端和现有 CI 改善应保留；
- 当前 PR 应被描述为 partial / experimental infrastructure。

### 不接受

- “需要用户 ADR 决策”不等于当前实现已经安全，也不等于默认 Runtime 可合入；
- “已披露的未来里程碑”不能覆盖当前产品实际允许 Web/CLI 双 owner、但缺持久 authority 的事实；
- 报告批注没有运行时行为变化，不应单独提升产品 PATCH 版本并触发 `tekon update`；
- 阶段 2/3 详细设计头部仍写“已实施/全部完成”时，即便另有基线文档，仍会给后续维护者和 Agent 制造错误完成感。

---

## 3. 逐项验收：理由与依据

### 1. P0：Provider execution-time streaming 与可转向 AgentHandle — **未通过**

**理由**：事件类型或 AsyncIterable 契约只有在 Provider 尚未结束时持续产生 delta，并且 follow-up/steer/resume 真正进入生产调用链时，才构成真实 Agent Session。

**依据**：

- `packages/core/src/runtime/agent-step-events.ts:99` `result = await adapter.runAgent(input);`
- `packages/core/src/runtime/legacy-agent-driver.ts:21` `* NotSupportedYet marks a frozen-contract method whose implementation is`
- `packages/core/src/runtime/legacy-agent-driver.ts:25` `export class NotSupportedYet extends Error {`
- `packages/core/src/runtime/legacy-agent-driver.ts:27` `super(`${feature} is not supported yet (deferred to phase 2b).`);`
- 生产 assistant/chunk producer：0 处

### 2. P0：Durable inbox、唯一 claim、幂等消费与重启恢复 — **未通过**

**理由**：append-only user/message 只能证明消息被记录；可靠消费还需要 pending→claimed→processed/failed、幂等键、lease、retry 与 restart recovery。

**依据**：

- `packages/core/src/db/migrations.ts:211`
- 独立 inbox/message 状态表：无
- claimed/processed/idempotency authority：无

### 3. P0：Collaborate / Deliver 后端双轨 — **未通过**

**理由**：双轨必须在权限、成本、角色、Git 副作用、Gate、结果与恢复单元上具有可验证的后端差异，而不只是 Profile、模板名或文案。

**依据**：

- 生产 Collaborate 语义命中：0 处
- 默认入口仍以 standard-delivery / 受控交付为主要纵向链路

### 4. P0：Persistent per-claim execution authority — **未通过**

**理由**：Web 与 CLI 可成为不同 owner；进程内 Symbol 不能让跨进程 reclaim 后的旧执行权永久失效。

**依据**：

- `packages/core/src/db/migrations.ts:211`
- claim_generation / claim_token：未形成
- `packages/core/src/session/job-runner.ts:127`

### 5. P0：Node 与领域副作用 CAS / fencing — **未通过**

**理由**：旧 owner 在下一次 heartbeat 前恢复时，仍可能先写 Node 或其他领域副作用；最终 Git CAS 只能保护 ref，不能回滚前序写入。

**依据**：

- `packages/core/src/db/repositories.ts:566`
- transitionNode expected-from/revision CAS：无
- Git expected-old OID CAS 已存在，但不能替代 Node/Artifact/Audit/Gate/Delivery authority

### 6. P0：Shutdown abort / kill / join / quiescence — **未通过**

**理由**：停止领取新任务后还必须 abort executor、kill 子进程、join Agent/Gate/Git 副作用并持久化可恢复状态；固定等待并清 Map 不等于 quiescence。

**依据**：

- `packages/core/src/session/job-runner.ts:514`
- stop 同时具备 abort/kill/join：否
- `packages/core/src/session/job-runner.ts:105`

### 7. P1：Projection health、lag、backfill 与 UI degraded 提示 — **未通过**

**理由**：projection-only 可以接受，但必须让运维和用户知道 Feed 是否完整，并提供持久 cursor、lag、重建和降级提示。

**依据**：

- `packages/core/src/session/dual-write.ts:11`
- 持久 projection health/backfill：无
- append 失败不会分配 seq，客户端无法从序号缺口识别丢失

### 8. P1：Session List / Detail / Inspector 单一稳定投影 — **通过**

**理由**：Header 读取一次性 session.get，而右栏读取实时 Events 时，运行中可能出现 running/passed/active 相互矛盾；列表也应按 needsAction/lastActivity 排序。

**依据**：

- `packages/web/src/client/pages/SessionDetailPage.tsx:39`
- `packages/core/src/session/session-store.ts:320`
- Header 从实时 Events 派生状态：是

### 9. P1：认证状态化与手工 Token 兜底 — **未通过**

**理由**：自动 bootstrap 成立后，顶栏应以连接状态为主；手工 Token 应本地编辑后显式应用，避免输入停顿即切换 auth scope。

**依据**：

- `packages/web/src/client/layouts/TopBar.tsx:14`
- 显式 Apply：无
- 默认 bootstrap + 同标签页 refresh 已有正式 E2E

### 10. P1：长 Session 有界 replay、内存与 DOM — **未通过**

**理由**：append fast path 只降低正常合并 CPU；没有分页、有界 replay、客户端上限和虚拟化时，网络、内存与 DOM 仍无界。

**依据**：

- `packages/core/src/session/session-store.ts:391`
- 服务端 bounded replay：有
- 客户端 virtualization：无


---

## 4. 产品逻辑与 UI/UX 综合判断

### 已经健康并应保留

- Session-first 默认入口与 `/advanced` 治理 Cockpit 分层；
- “启动受控交付”的诚实命名；
- 生产 `#token` bootstrap、同标签页 refresh、URL/Referer 不泄漏；
- 移动端 Drawer 的 modal、focus trap、Escape、focus restore 与 background inert；
- inline approval、PR 创建确认、Git ref CAS；
- SSE replay、跨进程 catch-up 与现有测试可信度改进。

### 仍不适合普通用户长期使用

1. **Session 仍是观察器，不是持续协作面板。** 当前页面没有当前 Session 的消息 Composer，也没有 queued/claimed/processed 输入状态。
2. **Feed 仍偏底层事件墙。** 默认叙事应聚合“理解→计划→修改→验证→审批→结果”，raw seq/checkpoint/correlation 应进入 Advanced/Audit。
3. **Inspector 仍复制历史。** 应改成当前 Plan、Changed Files、Checks/Gates、Pending Approval、Risks、Final Result、PR/CI 与 Recovery Action。
4. **Final Result 过浅。** 需要结构化 Changed Files、Diff、Build/Lint/Test、Gate、Independent Review、风险、分支/PR/CI 和下一步。
5. **复制清理后的深链到新标签页仍缺认证闭环。** 当前 `sessionStorage` 只属于当前标签页；需要一次性 nonce、同源安全 cookie 或页面内生成的新标签页链接。
6. **Projection-only 缺健康提示。** UI 无法判断 Event Feed 是否完整，也没有 durable lag/backfill/rebuild 状态。

---

## 5. 架构与过度设计判断

以下能力不是过度设计，应继续保留：Workflow、Gate、Artifact、Worktree、Audit、Delivery、Human Approval、Independent Review。它们是 Tekon 的核心差异化。

过度设计仍集中在横向 replatform 层：Event vocabulary、Profile、Automation、Projection checkpoint、AgentDriver/AgentHandle 契约、DSH bridge 和多 owner 恢复语义，增长速度领先于一个真实 Provider 的纵向闭环。

当前 PR 规模：`fatal: ambiguous argument 'main..HEAD': unknown revision or path not in the working tree.
Use '--' to separate paths from revisions, like this:
'git <command> [<revision>...] -- [<file>...]'` 个分支提交；`fatal: ambiguous argument 'main...HEAD': unknown revision or path not in the working tree.
Use '--' to separate paths from revisions, like this:
'git <command> [<revision>...] -- [<file>...]'`。继续在同一 PR 中加入 daemon、Provider、Inbox、Collaborate 与长 Session，会进一步降低可评审性、可回滚性和故障定位能力。

建议冻结当前 PR，后续按以下顺序拆分：

1. Runtime ownership ADR + single-owner daemon / project lock；
2. shutdown abort/kill/join 与两进程竞争测试；
3. 一个真实 Provider 的 execution-time streaming；
4. durable inbox + follow-up/steer/resume + restart recovery；
5. Collaborate 纵向产品切片；
6. Narrative/Final Result 与长 Session bounded architecture。

---

## 6. 本轮直接修改

1. 将根版本从 docs-only 的 `0.15.5` 恢复为最后一个含运行时改动的 `0.15.4`；
2. 将 CHANGELOG 顶部改为“复审记录（非产品发布）”，避免 `tekon update` 将报告批注误报为产品更新；
3. 在总体执行方案顶部加入当前范围基线提示；
4. 将阶段 2 状态改为“2a compatibility projection 已完成，阶段整体未完成”；
5. 将阶段 3 状态改为“observer/control UI slice 已完成，阶段整体未完成”；
6. 新增本第十四轮权威报告。

没有用更多合成事件伪装真实 streaming，也没有用零散 `signal.aborted` 判断伪装完整 Runtime fencing。

---

## 7. 官方架构对照

- DeepSeek Harness：durable Session Events 是模型历史和恢复的事实源；“model-visible means logged”，Turn/Step 内真实产生 assistant chunk、tool lifecycle 与 inbox claim。
  https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md
- OpenAI Codex Harness/App Server：长驻双向协议在 item 执行期间产生 UI-ready lifecycle/delta，而不是等待完整结果后投影。
  https://openai.com/index/unlocking-the-codex-harness/
- Semantic Versioning：PATCH 表达向后兼容的 bug fix；纯复审批注不应制造产品更新信号。
  https://semver.org/

Tekon 继续采用 anti-corruption adapter、而不绑定 Harness preview 内部 schema，是合理选择；但“借鉴模式”不能只复制类型名和事件词汇，必须完成实际执行语义。

---

## 8. 验证

| 命令 | Exit code |
| --- | ---: |
| `root-build` | `0` |
| `root-typecheck` | `0` |
| `root-lint` | `0` |
| `core-unit` | `0` |
| `core-e2e` | `0` |
| `cli-unit` | `0` |
| `cli-e2e` | `0` |
| `web-unit` | `0` |
| `web-e2e` | `0` |

Playwright：**28 passed (32.3s)，retry 标记 0**。

只有退出码为 0 的命令才被视为通过；报告不会将 retry 后绿色描述成首轮稳定通过。

---

## 9. 最终裁决

> **第十四轮整体仍不通过。**
>
> 当前 CI 可以全绿，但真实 streaming、durable inbox/持续 Session、Collaborate 双轨、持久 execution authority、Node/领域副作用 fencing 与 shutdown quiescence 仍未同时闭环。
>
> 当前 PR 可以继续作为诚实标注边界的 experimental infrastructure 研究快照；在 Runtime ownership 没有代码级保证之前，不建议作为默认 Web/CLI Runtime 合入 `main`。

未执行 merge、release 或 deploy。
