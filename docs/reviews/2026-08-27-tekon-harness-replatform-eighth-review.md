# Tekon Harness Replatform 第八轮全面复审

> 复审日期：2026-08-27  
> 复审对象：PR #10 `review/deepseek-harness-migration-2026-08-20`  
> 第七轮权威报告：`31e71525a7c9b1855be4200e107f969e9992f2cd`  
> 实施方第七轮整改：`998d2b30d52ec6fcb9852c72d3c00ed30e2a1b6e`、`f37070fd62f3de83fd851446185bc8039dcd87a6`、`5d4a42eb809ee614e30b8265403f3ddf9bc92d34`、`ba44ad018058205ba61ed8dc9e89308acbbe88f9`  
> 本轮评审直接修复：`0871ed792adb970b3b3e10bce63cc4e86f185efd`  
> 复审维度：产品逻辑、UI 实现、UX 交互、可访问性、整体 Runtime 架构、并发与恢复、代码质量、测试可信度、过度实现与过度设计。

---

## 1. 最终结论

# **第七轮整改项通过；整体产品与完整 Runtime 仍不通过**

本轮必须把“整改是否正确”与“整个 PR 是否已经完成”分开判断：

| 验收对象 | 第八轮结论 |
| --- | --- |
| 第七轮生产浏览器启动整改 | **通过** |
| 第七轮特定 shutdown 监听器 / auto-prepare 竞态整改 | **通过** |
| 本轮手工 Token 兜底与启动 URL 边界修复 | **通过** |
| 移动端布局与抽屉可访问性 | **继续通过** |
| 普通用户可直接使用的持续人机协作产品 | **不通过** |
| 完整 Harness-inspired Runtime | **不通过** |
| Web / CLI 多入口并发所有权安全 | **不通过** |
| 作为诚实标注边界的阶段性基础设施里程碑 | **可以冻结范围后评估合并，但不能宣称产品或 Runtime 完成** |

实施方这轮不是“只改文档”。生产 Web 的默认入口已经由首屏 401 变成可直接打开；Token 片段会被读取、持久化到当前标签页的 `sessionStorage`，并从地址栏清除。React Router history state、非 Token fragment、端口占用失败时的输出边界和关闭期间的 auto-prepare 竞态也得到补强。

但剩余 P0 并不是本轮整改制造的新回归，而是此前持续存在、且直接决定产品形态和 Runtime 正确性的主闭环：真实 Provider 增量流、Session 内 follow-up / steer / resume、durable inbox、Collaborate / Deliver 双轨、持久化 owner generation、Node / Git CAS 和完整 shutdown quiescence。它们尚未落地，因此不能直接给整个 PR “通过”。

---

## 2. 本轮范围、方法与证据边界

本轮重新核验了第七轮之后的全部增量，并复查了以下链路：

1. `tekon ui` → 子进程成功监听 → 终端启动 URL → 浏览器首屏；
2. URL fragment → `main.tsx` 同步 RPC seed → `AuthProvider` → query scope / SSE；
3. 手工 TopBar Token 兜底、同页 `hashchange`、刷新与 Router history；
4. Web server host / CSP / Origin / `Sec-Fetch-Site` / Token header 边界；
5. EventBus automation listener → readiness debounce → auto-prepare → `close()`；
6. Provider adapter → AgentDriver → Session Event → SSE → Event Feed；
7. Job claim / heartbeat / checkpoint / settle → Node transition → Git promotion；
8. Session Detail、Event Feed、Inspector、Composer、Final Result 与长会话增长；
9. 最新正式 Core / CI / Playwright 结果；
10. 当前 128 commits、197 changed files、约 3.1 万新增行的可审查性与抽象比例。

### 2.1 视觉证据限制

本轮增量集中在认证启动、关闭时序和测试，不改变页面布局。本次工作环境没有可控制的产品浏览器和新的截图产物，因此没有重新声称“完成一轮当前截图级视觉审计”。移动端布局与抽屉视觉结论沿用第六、七轮已捕获和验证的证据；本轮 UI/UX 判断来自当前代码、真实交互语义与正式 Playwright。

### 2.2 官方模式对照

- MDN URI fragment：<https://developer.mozilla.org/en-US/docs/Web/URI/Reference/Fragment>
- MDN `sessionStorage`：<https://developer.mozilla.org/en-US/docs/Web/API/Window/sessionStorage>
- OWASP HTML5 Security Cheat Sheet：<https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html>
- WAI-ARIA Modal Dialog Pattern：<https://www.w3.org/WAI/ARIA/apg/patterns/dialog-modal/>
- DeepSeek Harness Architecture：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md>
- DeepSeek Harness Session subsystem：<https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/subsystems/session.md>
- OpenAI Codex Harness / App Server：<https://openai.com/index/unlocking-the-codex-harness/>
- Claude Managed Agents events and streaming：<https://platform.claude.com/docs/en/managed-agents/events-and-streaming>
- Git `update-ref`：<https://git-scm.com/docs/git-update-ref.html>
- SQLite isolation：<https://www.sqlite.org/isolation.html>

---

## 3. 对第七轮报告与实施方批注的复核

## CLOSED-01：生产浏览器默认启动已经可用

实施方完成了以下有效闭环：

- Web server 成功监听后才输出带 `#token=` 的 URL；
- `main.tsx` 在首次 React render 前同步设置 RPC Token；
- `AuthProvider` 使用相同 Token 作为初始状态；
- Token 写入 `sessionStorage`，刷新仍可使用；
- 地址栏 fragment 通过 `history.replaceState` 清理；
- 清理时保留 React Router 当前 history state；
- 非 Token fragment 不被误删；
- 不使用共享 E2E fixture 的 fetch monkeypatch，真实验证首屏无 401；
- 端口绑定失败时不提前泄露可点击 Token URL。

这关闭了第七轮最直接的普通用户启动阻断。MDN 说明 fragment 是客户端处理部分，不随 HTTP 请求发送；正式 E2E 也验证 Token 不出现在 request URL 和 Referer。

### 保留的安全边界

当前实现仍把 `.tekon/web-session.json` 中的长期静态 Token 暴露在终端 URL，并把它放入 JavaScript 可读的 `sessionStorage`。这对 loopback 单机工具是可接受的最小可用闭环，但不是最终安全模型：

- Token 可能进入终端录屏、任务日志、剪贴板或浏览器扩展可见范围；
- `sessionStorage` 虽然是 tab-scoped，但仍受同源 XSS 影响；
- Token 不是短时、单次消费，也没有服务端 bootstrap exchange / rotation。

因此，一次性 nonce + same-origin exchange（或等价的短期凭证方案）继续作为 **P1 安全硬化** 保留，不再阻断默认入口可用性，但不能在文档中描述为“绝对安全”。

## CLOSED-02：Router history 与同页 Token fragment 已关闭

实施方补上了 `replaceState` 保留 `history.state`，并为同页 `hashchange` 读取新 Token。原先若用户把带 Token 的 URL 粘贴进已经打开的 Tekon 标签页，浏览器只触发 hash navigation，不会重载应用；现在会捕获新 Token并清除 fragment。

`ba44ad01` 的测试又把“模拟当前 history entry”与“故意创建一个 state=null 的新 hash entry”区分开，避免测试本身验证了错误场景。

## CLOSED-03：特定 shutdown automation 竞态已关闭

`root.ts` 现在：

1. 最先注销 readiness 与 auto-prepare 两个 EventBus listener；
2. 清理 readiness debounce timer；
3. 跟踪并等待已经启动的 auto-prepare 异步任务；
4. 再调用 `jobRunner.stop()`；
5. 最后关闭 SQLite。

这关闭了第七轮日志中的具体错误链：事件在 shutdown 期间重新安装 timer 或启动 auto-prepare，最终在 `db.close()` 后迟到 enqueue。新增测试覆盖了 close 后 publish 和 close 过程中已进入 listener 的 in-flight 分支。

需要注意：这只关闭了**具体 automation listener 竞态**，不等于整个 Runtime 已经具备完整 shutdown quiescence，见 F8-P0-05。

## CLOSED-04：本轮手工 Token 兜底竞态已直接修复

继续审阅时发现：初次启动有 `main.tsx` 的同步 seed，但 TopBar 手工粘贴 Token 或同页 `hashchange` 更新 Token 时，原实现只先 `setTokenState`，RPC 全局 Token 仍要等 AuthProvider passive effect 才更新。

由于子组件 query effect 先于父 Provider effect，新的 token-scoped `session.list` 可能先用旧 Token / null 发出，首个请求 401，并把错误缓存到新 scope。

本轮提交 `0871ed79`：

- `setToken()` 在安排 React state 更新前，同步更新 RPC Token 和 `sessionStorage`；
- hashchange 也统一走 `setToken()`；
- 新增生产 E2E：从裸 URL 进入，手工填入 Token，断言新 scope 的第一个认证请求不出现 401。

## CLOSED-05：终端不再同时给出“正确 URL”和“误导裸 URL”

实施方已经把 Token URL 延迟到 server 成功监听后输出，但 server 随后还会打印第二个裸 `Tekon Web listening on http://127.0.0.1:...`。

终端通常会把最后一个 URL 自动识别为可点击链接；裸 URL 无 Token，而且 `localhost` 与 `127.0.0.1` 还是不同浏览器 origin，用户很容易点错并回到 401 / 手工 Token 流程。

`0871ed79` 保留唯一的认证启动 URL，把第二行改为无链接的 `Tekon Web ready`。

---

## 4. 仍然阻断整体通过的 P0

## F8-P0-01：主流 Provider 仍不是执行期增量流

当前 `agent-step-events.ts` 的顺序仍是：

```text
await adapter.runAgent(input)
→ 得到完整 AgentRunResult
→ 再生成 tool/call、tool/result、assistant/message
```

`LegacyAgentDriver.events()` 同样先 `await done`，然后才 yield 事件。

这意味着 UI 虽然通过 SSE 实时收到治理事件，但 Provider 的 Assistant / Tool “流”主要是在整个 node 完成之后合成，不具备真正的：

- assistant delta；
- tool started / progress / completed；
- 中途 interruption；
- steer / redirect；
- request boundary；
- 在同一 Turn 内继续输入。

Codex App Server、Claude Managed Agents 和 DeepSeek Harness 的共同模式不是“事件名字很多”，而是执行控制与执行期增量真的通过双向协议发生。Tekon 当前事件词汇已经足够，下一步应先让一个真实 Provider 纵向跑通，而不是继续扩 Event type。

### 通过条件

至少一个真实 Provider 完成：

```text
provider delta
→ durable session event
→ live SSE
→ tool lifecycle
→ interruption / cancellation
→ replay after restart
```

并用真实 Provider E2E 验证事件在任务结束前已经到达浏览器。

## F8-P0-02：Session 内 follow-up / steer / resume 与 durable inbox 仍未实现

`LegacyAgentDriver` 中：

- `followUp()` 抛出 `NotSupportedYet`；
- `steer()` 抛出 `NotSupportedYet`；
- `resume()` 抛出 `NotSupportedYet`。

Session UI 也没有持续输入 Composer；现有 `SessionComposer` 是“新建一项受控交付”，不是当前 Session 的下一条用户消息。

完整协作闭环至少需要：

```text
user message / steer
→ durable inbox row
→ pending / claimed / processed
→ active Agent 立即消费或进入下一 Step
→ 幂等提交
→ 页面刷新恢复
→ daemon 重启恢复
→ 同一 Session 开始下一 Turn
```

在此之前，产品本质上仍是“一次性 Workflow 启动器 + 运行观察器”，不是持续 Agent Session。

## F8-P0-03：Collaborate / Deliver 双轨仍未形成

默认入口改名为“受控交付”是诚实的；但轻量 Collaborate 轨道依然不存在。当前 Profile 主要区分人工推进、自动推进和自动准备交付，没有后端语义真正不同的协作模式。

建议最终明确：

| 维度 | Collaborate | Deliver |
| --- | --- | --- |
| 用户心智 | 持续对话、理解与快速修改 | 受控软件交付 |
| 默认成本 | 低 | 高 |
| 角色 | 单 Agent / 小计划 | PM / RD / QA / Reviewer |
| Gate | 按风险升级 | 默认完整 |
| Git | 只读或小范围 Patch | Worktree + Delivery Branch |
| 结果 | 回答 / Patch / Summary | Evidence + Review + PR |

不能只增加一个下拉选项；权限、成本、事件、Git、副作用和 Final Result 都必须不同。

## F8-P0-04：事实上的 multi-owner 仍缺持久化 fencing 与统一 CAS

当前 Web 和 CLI 都可能启动 JobRunner，并访问同一个 SQLite 与 Git 工作区。Job claim 已有 `owner`，但仍缺持久化 `claim_generation`；heartbeat / checkpoint / settle 主要按 `jobId + owner` 条件更新。

当 lease 过期、另一进程 reclaim、旧 executor 又恢复运行时，旧 owner 缺少不可伪造的 generation，仍可能继续触发：

- Node 状态写入；
- Artifact / Audit 写入；
- Git commit / promotion；
- terminal settle。

同时 Node transition 没有统一 expected-from / revision CAS，Git promotion 也没有在所有路径使用 expected-old OID。Git 官方 `update-ref` 支持以旧 OID 作为 compare-and-swap 前提，这应成为 branch promotion 的统一原语。

### 建议的架构决策

二选一，并立即落 ADR：

1. **推荐当前阶段：single-owner daemon**。Web、CLI、IDE 只作为客户端；所有 Job、Provider、Git 与 projector 副作用由 daemon 执行。
2. 正式支持 multi-owner：持久化 generation、所有写入 owner-conditioned、Node revision CAS、Git expected-old OID CAS、subprocess fencing 与 shutdown quiescence 全部落地。

在这项决策前，不应继续扩展 Profile、Automation kind 或 Projector。

## F8-P0-05：完整 shutdown quiescence 仍未完成

本轮已经修掉 automation listener 的迟到 enqueue，但 `JobRunner.stop()` 仍采用：

```text
等待 in-flight jobs
或 5 秒超时
然后返回
```

超时返回后，底层 Agent Promise、子进程、Gate 命令或 Git 操作没有统一的 abort / kill / join 证明。上层随后关闭 DB，仍可能出现：

- 任务继续产生持久化写入；
- 子进程继续修改 worktree；
- Git side effect 在 owner 已失效后完成；
- 进程被强制退出，checkpoint 不完整。

完整关闭顺序应当是：

```text
停止 claim 新 Job
→ 对所有 executor 发 shutdown abort
→ kill 已登记子进程
→ 等待 executor / child / Git side effect quiesce
→ 持久化可恢复状态
→ 最后关闭 SQLite 和 HTTP server
```

---

## 5. UI / UX / 信息架构与规模问题

## F8-P1-01：Token 控件已从必需流程变成长期占位，但仍常驻顶栏

自动 bootstrap 后，绝大多数用户不再需要看到或编辑 Token。当前顶栏仍常驻完整密码输入框和显示/隐藏按钮，并在每次输入字符时切换认证 scope。

这会：

- 暴露内部实现细节；
- 挤占移动端 TopBar；
- 鼓励用户手工管理长期 secret；
- 手工逐字输入时触发多次错误认证和数据刷新。

建议把 Token 移到“连接 / 高级设置”，默认只显示“已连接 / 认证失败”；手工兜底使用本地 draft + 显式 Apply，而不是每个字符立即改认证状态。

## F8-P1-02：Event Feed 仍是底层事件墙

`EventFeed` 直接 `events.map` 渲染全部事件，仍包含大量：

- lifecycle / checkpoint / raw ID；
- tool call / result；
- Artifact UUID；
- Gate 与 Automation 细节；
- 重复的 summary。

默认 Feed 应围绕“理解、计划、修改、验证、审批、结果”形成 Narrative；raw event、seq、correlation ID 和 checkpoint 应进入 Advanced Debug / Audit。

`role="log"` + `aria-live="polite"` 对少量事件合理，但在高频 tool / lifecycle 事件下会形成屏幕阅读器噪音，需要按人类语义聚合后再 announce。

## F8-P1-03：Inspector 仍复制历史，不是当前状态投影

`SessionSidePanel` 从同一事件数组再次提取 Tool / Artifact，并逐条渲染，和主 Feed 形成重复历史。

Inspector 应改成：

- 当前 Plan；
- Changed Files；
- 最新 Checks / Gates；
- Pending Approval；
- Final Result；
- Delivery / PR；
- 失败时的恢复动作。

历史明细只在 Audit 中展开。

## F8-P1-04：Final Result 仍不足以完成验收

当前结果主要依赖终态事件和简要统计，没有稳定回答：

- 改了哪些文件；
- build / lint / unit / e2e 是否通过；
- Gate 和 Independent Review 结论；
- 风险与未完成项；
- 分支、PR、CI 状态；
- 用户下一步动作。

需要服务端生成结构化 DeliveryResult / SessionResult 投影，UI 只渲染该投影，而不是从 Event Feed 临时拼装。

## F8-P1-05：长 Session 仍为无界 replay、无界内存和无界 DOM

当前链路仍是：

```text
SSE 首连从 seq=0 replay 全部事件
→ React 累积完整 events[]
→ 每次 merge 构建 Map、排序
→ Feed 和 Inspector 各自遍历 / 渲染
```

缺少：

- cursor pagination；
- bounded initial replay；
- gap recovery；
- append-fast path；
- Turn / Step collapse；
- virtualization；
- search / filter；
- large payload spill reference；
- 用户向上阅读时停止自动滚动。

长任务会逐渐形成 O(n log n) 重排、重复派生和无界 DOM / 内存增长。

---

## 6. 代码实现与测试可信度

## 6.1 本轮直接修改记录

`0871ed792adb970b3b3e10bce63cc4e86f185efd`：

- Token 变更同步更新 RPC credential 与 `sessionStorage`，避免新 scope 首请求使用旧 Token；
- hashchange 与手工 TopBar 兜底统一走同一原子 setter；
- 新增手工 Token 恢复真实 401 反证 E2E；
- server 成功监听后只输出一个带 Token 的启动 URL；
- 移除容易误点的第二个裸 URL。

## 6.2 正式验证结果

代码 Head `0871ed792adb970b3b3e10bce63cc4e86f185efd` 的 GitHub Actions：

- Core workflow：通过；
- Root build + typecheck：通过；
- CLI build + unit + e2e：通过；
- Web build + typecheck + unit：通过；
- Web Playwright：**31 passed，一次运行完成，无 retry / flaky 标记**；
- 新增的“手工 Token 首请求不 401”测试通过；
- 第七轮曾出现的 `[readiness] enqueue failed: database connection is not open` 未再出现。

这说明本轮整改本身具备较好的回归锁定。但一次稳定运行不能替代持续稳定性预算，建议 CI 后续把 retry 视为单独失败指标并做趋势统计。

## 6.3 仍缺的关键测试

- 两个真实进程同时 claim / reclaim 同一 Job；
- lease 失效后的旧 executor 尝试 heartbeat / checkpoint / settle；
- stale owner 尝试 Node transition 和 Git promotion；
- stop 超时后的真实子进程与 Git side effect；
- 真实 Provider 在任务结束前产生 delta；
- follow-up / steer 在进程重启后恢复；
- 1 万、10 万事件下的 replay、内存、渲染和交互预算。

---

## 7. 是否存在过度实现 / 过度设计

### 应保留的差异化资产

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

它们直接服务于可控交付和审计，是 Tekon 与普通聊天式 Agent 的差异化价值。

### 仍然存在的过度设计倾向

问题集中在 replatform 横向层：

- Event vocabulary；
- Profile；
- Automation Job；
- Projection checkpoint；
- AgentDriver / AgentHandle；
- DSH bridge；
- recovery 与 multi-owner 语义。

这些抽象增长速度仍快于一个真实 Provider 的纵向闭环：

```text
实时输出
→ tool lifecycle
→ follow-up / steer
→ durable inbox
→ restart recovery
→ 同一 UI replay
```

同时，代码实际上已经承担 multi-owner 部分复杂度，却没有得到完整安全语义，也没有明确产品收益。这是当前最典型的“复杂度先到、能力后到”。

### PR 规模治理

当前 PR 已达到：

- 128 commits；
- 197 changed files；
- 31,298 additions / 1,673 deletions。

后续不应继续把 Provider、daemon、双轨产品和长会话规模化全部压入本 PR。建议：

1. 冻结当前基础设施范围；
2. 第八轮报告后停止自修改评审 workflow；
3. 后续业务修改用独立、可审查 PR；
4. 每个 PR 只承担一个可运行纵向切片。

---

## 8. 推荐下一阶段顺序

### Phase A：先收敛 Runtime ownership

1. 落 single-owner daemon ADR；
2. Web / CLI / IDE 改成客户端；
3. shutdown abort / child registry / quiescence；
4. Node revision CAS 与 Git expected-old OID CAS；
5. 若坚持 multi-owner，再补 persistent claim generation 和所有 owner-conditioned write。

### Phase B：一个真实 Provider 的纵向闭环

1. 执行期 delta；
2. tool started / progress / result；
3. cancellation / interruption；
4. durable inbox；
5. follow-up / steer / resume；
6. restart recovery；
7. 同一 Session UI replay。

### Phase C：产品双轨与人类化结果

1. Collaborate 默认入口；
2. Deliver 显式入口；
3. Narrative Feed；
4. Current-state Inspector；
5. 结构化 Final Result；
6. Token 控件移入连接设置。

### Phase D：长任务规模能力

cursor pagination、bounded replay、append-fast path、virtualization、collapse/search、large payload spill 与 performance budgets。

---

## 9. 最终裁决

> **第八轮对“第七轮整改代码”的结论是通过。**生产浏览器默认入口、Router history、同页 Token、手工 Token 首请求、启动 URL 和特定 automation shutdown 竞态已经闭环，最新正式 CI 全绿且 31 条 Playwright 一次通过。
>
> **但对“普通用户产品 / 完整 Harness-inspired Runtime”的结论仍是不通过。**真实 Provider 仍为 one-shot 后合成事件，follow-up / steer / resume 与 durable inbox 未实现，Collaborate / Deliver 双轨未形成；Web / CLI 事实 multi-owner 仍缺 persistent generation、统一 Node / Git CAS 与完整 shutdown quiescence；长 Session 与 Final Result 也未达到长期使用门槛。
>
> 当前 PR 可以作为诚实标注边界的基础设施里程碑冻结并评估合并，不能被描述为“完整迁移已完成”或“普通用户产品已可发布”。下一阶段应停止扩横向抽象，优先完成 **single-owner daemon + 一个真实 Provider 的 streaming / follow-up / resume 纵向切片**。
