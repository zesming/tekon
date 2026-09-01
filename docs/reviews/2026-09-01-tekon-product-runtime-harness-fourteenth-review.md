# Tekon 产品、UI/UX、Runtime 与 DeepSeek Harness 第十四轮全面复审

- **日期**：2026-09-01
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **上一轮权威报告**：[第十三轮全面复审](2026-09-01-tekon-product-runtime-harness-thirteenth-review.md)
- **上一轮权威 Head**：`ccf72726176203b35cb1192c513921901e1e3551`
- **用户本轮整改快照**：`568e79b5750fc4d1441fc0a4cfe9ef1bef153ad3`
- **reviewer 代码修复快照**：`1e16835e9534b8834a6cc9f9106a0fd50f5deb99`
- **产品版本**：`0.20.4`
- **Tekon DSH tested pin**：`0.1.2-alpha.3`
- **DeepSeek Harness 官方取证基线**：master / `dsh-v0.1.2-alpha.3`，commit `dd6322d604e00eec1ba5e0c8541159906a21094a`
- **代码自动化状态**：reviewer 代码快照 Core #368 与 CI #277 均为首次执行 `completed/success`；Core unit 84 文件 / 1036 passed / 3 skipped，Core e2e 8 文件 / 26 passed；Root build/typecheck、production dependency audit、CLI unit/e2e、Web unit/build/typecheck 与 Chromium Playwright 全部成功
- **最终裁决**：本轮整改与 reviewer 局部修复通过当前代码合并门；Tekon 整体仍未通过“面向普通人的稳定持续协作研发工作台”产品验收

## 1. 执行摘要

用户本轮提交是以文档为主的第十三轮收尾，包含两项有效修正：

1. 将 DeepSeek Harness `alpha.2 → alpha.3` 从过强的“整个合同零差异”收敛为“Tekon 使用的 Headless 兼容锚点未变”；
2. 将 CHANGELOG 中已经过时的 `needs: [typecheck, audit]` 修正为当前真实的 `needs: typecheck`，避免版本说明与现有 workflow 相互矛盾。

同时，用户补充识别了 DSH Host Node 要求与 Tekon Node 主合同之间的断层：Tekon 允许 `^20.19.0 || >=22.12.0`，DSH 要求 `^22.19.0 || >=24.0.0`；当前 preflight 会显示 DSH 要求，但尚未在启动探测前直接比较宿主 Node 版本。

这些判断本身成立，但本轮远端 Head 仍不能直接判为“通过”：

- `current.md` 继续绑定上一轮 `ccf727...` 的成功快照，而不是本轮用户 Head；
- 第十三轮报告再次追加第 17 节，违反仓库自己已经写明的“基线变化时新建报告，不向旧报告继续叠 revision”规则；
- 用户 Head `568e79...` 的 Core #366 首次执行失败，失败用例是 `command-gateway` 将正常结束的安静任务错误标记为 `timedOut`；重跑成功只能证明时序不稳定，不能证明生产判定逻辑没有问题。

本轮在代码中修复了该边界竞态：no-progress 不再在第一次达到阈值时立即终止，而是记录当前 activity watermark；只有下一次采样仍观察到同一 watermark 且继续超时，才执行终止。任何 stdout、stderr 或输出目录变化都会改变 watermark 并撤销候选超时。

修复后的代码快照 `1e168...` 在独立的首次 Core #368 与 CI #277 中全部成功。新增边界测试明确覆盖“第一次 idle 观察后、第二次确认前产生文件活动”的情况，不再依赖重跑获得绿色结果。

产品与架构层面的主裁决没有改变：Tekon 的 Deliver 受控交付链路已经有较强的治理和测试证据，但 Collaborate 持续协作链路仍不存在；Runtime 仍是 multi-owner，Session Event 仍是 best-effort projection，RunPlan 仍不是执行与恢复的唯一事实，完整历史与模型上下文预算仍未闭环。

## 2. 评审范围与方法

本轮覆盖：

- `ccf727...` 到用户整改快照 `568e79...` 的完整增量；
- 用户新增的第十三轮报告第 17 节、`current.md`、CHANGELOG 修正及第十四轮整改方案；
- 用户 Head 的 Core #366、CI #275 与失败日志；
- reviewer 修复后的 Core #368、CI #277 与具体 job/test 终态；
- Core `command-gateway` 的命令策略、进程终止、总超时、无进展超时、输出目录活动监控、日志与进度证据；
- Web Composer、Session detail/right rail、审批与运行控制；
- CLI/Web composition root、JobRunner、Session dual-write、LegacyAgentDriver、RunPlan；
- DSH bridge preflight、Headless、ACP、Session export 与 Safety；
- branch protection、CI、audit、lint/format、测试层级与 PR 可审阅性。

判断原则：

1. 自动化必须绑定具体代码快照和 workflow 的首次/重跑语义；
2. flaky 测试不能仅通过 rerun 归类为“基础设施噪声”，必须判断其是否揭露生产竞态；
3. 本地全量测试记录不能替代当前 PR Head 的 GitHub Actions 终态；
4. Event projection、Session snapshot、领域表和 Gate 查询必须区分事实层级；
5. “UI 有界”“完整历史可读取”“模型上下文可持续”是三个不同命题；
6. 低风险局部修复不得被描述成架构主链路已关闭；
7. 文档维护规则本身也属于产品治理合同，不能只写不执行。

本轮没有真实 DSH 二进制与 API key，没有独立部署实例，没有 Firefox/WebKit、屏幕阅读器或真实弱网设备。因此 L2/L3 Provider、视觉回归、辅助技术和跨浏览器结论继续保持未验证。

## 3. 用户本轮整改逐项裁决

| 整改项 | 裁决 | 理由与边界 |
| --- | --- | --- |
| DSH `alpha.3` 表述收敛 | **通过** | 官方 `alpha.3` 相比 `alpha.2` 并非整个仓库零变化；准确结论是 Tekon 依赖的 Headless one-shot 入口、帮助锚点、配置 row ids 和 Node engines 保持兼容。 |
| CI `needs` 文案修正 | **通过** | 当前 `cli`/`web` 只依赖 root build/typecheck；audit 是独立顶级 gate。CHANGELOG 不应继续描述旧 wiring。 |
| DSH Host Node 断层登记 | **成立，未关闭** | `DSH_NODE_REQUIREMENT` 被输出，但 `runDshPreflight()` 未在 spawn 前验证 `process.versions.node`。Node 20/22.12–22.18 用户仍可能先得到外部命令启动错误，再看到泛化的不兼容说明。 |
| 第十三轮报告追加第 17 节 | **过程不通过** | 报告自身规则要求基线变化时新建报告；继续追加使“权威快照、历史批注、当前裁决”混在同一文件，增加误读和审阅成本。 |
| `current.md` 同步 | **事实不完整** | 它仍绑定旧 `ccf727...` 成功快照，没有记录本轮用户 Head 首次 Core 失败及后续修复。 |
| 第十四轮方案验收结论 | **不能直接复用** | 本地测试结果可作为证据，但用户 Head Core 首次红灯说明当前远端快照尚未稳定；必须先定位并修复竞态，再重新绑定自动化。 |

## 4. 本轮新发现：P1-RUNTIME-03 no-progress 边界竞态

### 4.1 现象

用户 Head `568e79...` 的 CI #275 成功，但 focused Core #366 首次失败：

```text
command gateway
→ treats output directory file changes as progress for quiet long-running commands
→ expected timedOut=false
→ received timedOut=true
→ exitCode=0
```

同一 run 重跑成功。这不是普通断言抖动：`exitCode=0` 与 `timedOut=true` 同时出现，说明 gateway 已经先把任务判为无进展并发出终止信号，随后测试子进程仍按正常路径 close(0)。

### 4.2 根因

原实现每个 no-progress interval 执行：

```text
扫描输出目录
→ 读取 lastActivityAt
→ idle >= threshold 时立即 triggerTimeout
```

在高负载 runner 上，文件写入 timer、进程 close timer 与 no-progress interval 可能在相近时间同时变为 runnable。单次采样恰好发生在文件写入被观察之前时，gateway 会立即终止；下一轮本可看到的合法活动已失去纠错机会。

输出目录活动本身还是轮询投影，不是操作系统提供的事务性事实，因此“第一次达到阈值”不应同时充当最终终止证据。

### 4.3 修复

`command-gateway.ts` 现采用两阶段确认：

```text
第一次观察 idle >= threshold
→ 保存 observed lastActivityAt 作为候选 watermark
→ 下一次采样重新扫描 stdout/stderr/outputDir
→ watermark 已变化：撤销候选
→ watermark 未变化且仍超时：triggerTimeout
```

性质：

- 总超时 `timeoutMs` 不变；
- no-progress 最多增加一个采样间隔的确认宽限；
- 真正静默卡死的任务仍会被终止；
- 边界文件活动不再被一次采样误杀；
- progress JSON 仍记录用户配置的原始 no-progress threshold，不通过篡改配置掩盖问题。

### 4.4 回归证据

新增 `command-gateway-no-progress-boundary.test.ts`：

- no-progress threshold 为 80ms；
- 第一次 idle 候选之后写入 artifact；
- 第二次确认应看到 activity watermark 变化；
- 子进程正常 close(0)；
- 断言没有 SIGTERM/SIGKILL，`timedOut=false`。

reviewer 快照的 Core 首次执行结果：

- unit：84 文件、1036 passed、3 skipped；
- 新边界测试通过；
- 原 29 个 command-gateway 测试通过；
- e2e：8 文件、26 passed；
- actionlint、build、native dependency verification 均成功。

### 4.5 仍需保留的边界

本修复关闭的是“单次边界采样误杀”，不是所有命令生命周期问题：

- 输出目录扫描仍是递归 `readdir/lstat`，大量 artifact 时成本随文件数增长；
- `command-gateway.ts` 同时负责 policy、env、spawn、process group、redaction、progress、filesystem activity、timeout 和 stream settle，已成为维护热点；
- no-progress 的长期正确形态应抽成可注入时钟与纯状态机，再由 I/O sampler 驱动，而不是继续增加 timer 特判；
- 外部 SDK 或不经过 gateway 的同步子进程仍不受该状态机管辖。

因此后续重构建议是“先抽 timeout state machine，再优化 sampler”，而不是立即加入更多 watcher、worker 或通用调度框架。

## 5. 产品逻辑评审

### 5.1 Deliver 轨道：成立

当前实际可用的产品是受控交付：

```text
用户需求
→ 服务端计划预览与 digest
→ standard-delivery 角色链
→ worktree 隔离执行
→ Gate / Artifact / Audit / Review
→ 人工审批
→ Delivery / PR 准备
```

默认 Composer 会在计划加载失败、digest 缺失或凭据缺失时阻止启动，并明确告知用户将运行完整的 PM/RD/QA/Reviewer 全链路。这比把复杂治理隐藏在一个普通“发送”按钮后更诚实。

### 5.2 Collaborate 轨道：仍未实现

Composer 仍明确写出“轻量协作、会话内追问与转向尚未开放”。LegacyAgentDriver 的 `events()` 会等待整个 one-shot 完成后才遍历缓冲事件，`followUp()`、`steer()` 和 `resume()` 均抛出 `NotSupportedYet`。

因此当前 Session 的真实角色是：

- 运行观察面；
- 审批面；
- 治理证据面；
- 结果与历史投影面。

它还不是：

- 多轮研发对话；
- 执行中 steer；
- prompt-owned cancel；
- 重启后继续同一 Provider Session；
- Collaborate 原地升级 Deliver。

产品文案对此保持诚实，属于优点；但不能据此把缺失能力判为产品完成。

### 5.3 下一条产品主线

不建议继续增加 Profile、Automation kind、展示事件或 Workflow DSL。下一条垂直主线应固定为：

```text
真实 persistent provider session
→ execution-time semantic updates
→ follow-up
→ prompt cancel
→ restart resume
→ Collaborate → Deliver handoff
```

若这条链路不先成立，横向能力越多，普通用户越难理解 Tekon 是“对话工作台”还是“受控流水线编排器”。

## 6. UI 实现与 UX 交互评审

### 6.1 当前有效改进

上一轮完成的 Session snapshot fallback 仍成立：Event projection 尚未追上时，`session.get` 可兜底 runId、生命周期和 attention；Gate 当前查询决定真实 pending decision；未知状态不会虚构为 running。

本轮没有 UI 代码增量，因此该链路主要通过既有 Web unit、API 与 Chromium Playwright 回归确认。

### 6.2 仍存在的 UX 缺口

1. **没有完整历史出口**：截断 banner 只能分页加载有限历史，没有“一键导出完整 Session / 证据包”。
2. **UI 窗口不等于模型预算**：DOM 只保留有限事件，不代表模型请求已经有 summary/compaction。
3. **审批加载状态不够明确**：Session snapshot 可触发 Gate 查询，但弱网下“已知待审批、上下文仍加载中”缺少独立 skeleton/状态说明。
4. **工程概念仍较多**：Profile、Provider、Gate、Artifact、Token 等词仍容易进入普通用户主路径。
5. **语言一致性不足**：部分 flash、错误和空状态仍混用中英文。
6. **跨浏览器与辅助技术未验收**：当前 Playwright 只有 Chromium；没有 Firefox/WebKit、screen reader、200% 缩放、对比度与 reduced-motion 矩阵。
7. **视觉回归不足**：没有截图基线或结构化视觉断言，长标题、极长 artifact、多个审批卡与窄屏组合仍依赖人工发现。

### 6.3 UX 优先级

在 Collaborate vertical slice 之前，最值得独立落地的 UX 是完整历史导出，因为它同时服务：

- 用户找回完整上下文；
- 审批与复盘；
- bug report；
- 支持与审计；
- 长会话页面保持有界。

## 7. 整体框架与架构评审

### 7.1 P0：Runtime 仍是 multi-owner

CLI 和 Web 分别创建：

- database/write queue/repositories；
- Session store/EventBus；
- JobRunner；
- subprocess registry；
- workflow/automation executor；
- Provider、Git/worktree 与 shutdown 生命周期。

job owner、lease 与 CAS 能降低重复 job 执行，但不能统一 fence 普通文件、Git promotion、Artifact、Gate、Audit、Delivery 和外部 SDK 副作用。

长期正确方向仍是 repo 级 single-owner Runtime/daemon + lock，CLI/Web 客户端化。除非明确选择 active-active，否则不应继续在两个 composition root 中复制新的长期资源所有权。

### 7.2 P0：Shutdown 仍不能证明 quiescent

JobRunner 会停止轮询、等待 active poll、给任务 settle window、abort controller、kill registry 子进程，再等待 hard deadline。但 hard deadline 到达后会清空内存状态并返回；不合作 JavaScript executor、普通文件写入、未注册 Git/SDK 活动仍可能继续。

需要的闭环仍是：

- executor process/worker 隔离；
- 可证明的 kill/join；
- generation fencing；
- checkpoint/flush；
- crash/restart 故障注入。

### 7.3 P0：Session Event 仍是观察投影

`dual-write` 明确采用：

```text
领域写入/Audit 成功
→ best-effort append session_event
→ 失败记录但不抛出
```

这适合 UI projection，不适合 durable inbox、模型权威历史、fork/resume 或 crash replay。本轮 UI fallback 和 no-progress 修复都是防御措施，不是事实源迁移。

长期需要在下列方向中做真正选型：

- authoritative append-only Session log + projections；或
- transactional outbox/领域事实为权威、Session 明确定义为可重建投影。

不能继续让同一 Event log 同时被描述为“可丢的 UI 事件”和“未来模型历史”。

### 7.4 P1：RunPlan 尚未成为执行唯一事实

`RunPlanContext` 接受 `mode`，但 `RunPlan` 与 digest projection 没有写入 mode；同时还缺：

- Demand identity/version/hash；
- base revision；
- workspace physical identity；
- resolved Provider config；
- permission/network acknowledgement；
- expected Artifacts；
- executable node plan。

执行/恢复仍会从 SQLite、模板和 Provider snapshot 重新拼装事实。当前 digest 能防止部分 Web 预览与启动漂移，但不是完整的 execute/resume authority。

### 7.5 P1：完整历史与模型上下文仍未统一

现有 SSE 已有 backward cursor、replay budget、pending event/byte cap 和 heartbeat backpressure；但仍缺：

- server-streamed complete-history export；
- live flush/snapshot 一致性边界；
- subsession/artifact manifest；
- 模型 summary/compaction；
- UI、导出、模型 prompt 的统一 retention policy；
- 大规模长连接和故障矩阵。

## 8. 代码实现与测试评审

### 8.1 当前代码门

reviewer 快照 `1e168...`：

- Core #368：首次成功；
- CI #277：首次成功；
- production dependency audit 成功；
- CLI unit/e2e 成功；
- Web typecheck/build/unit 成功；
- Chromium Playwright 成功。

这关闭了本轮代码增量的合并阻断。

### 8.2 仍未关闭的工程治理

- `main` 仍未保护，required checks enforcement 关闭；
- `lint` 仍等价于 `tsc --noEmit`，没有真实 JS/TS static linter；
- format 历史欠账仍大；
- production audit 不覆盖 dev/build tool、SBOM、provenance、dependency review 与签名；
- DSH L2 默认跳过，L3 带 API key smoke 不存在；
- installer/update/release/tag/build artifact 尚未形成单一发布流水线。

### 8.3 测试策略建议

1. timer/timeout 类逻辑优先抽纯状态机，减少依赖真实毫秒调度的测试；
2. 保留至少一个真实 timer 集成测试验证 Node event-loop 行为；
3. flaky 首次失败与 rerun 成功都应纳入评审证据，不能只展示最终绿色状态；
4. 对真实 DSH 分三层：L1 fixture、L2 binary metadata、L3 credentialed model smoke；
5. UI 后续增加 Firefox/WebKit 与少量高价值视觉场景，不建议先铺全量截图测试。

## 9. 是否过度实现 / 过度设计

### 9.1 当前主要过度风险

不是某个抽象类单独过度，而是横向机制与评审过程增长快于纵向用户闭环：

```text
AgentAdapter / AgentDriver / Provider Registry
Workflow / Role / Gate / Artifact / Audit
JobRunner / Session projection / SSE
Profile / Automation / Goal / Readiness / Delivery
CLI / Web 两套 composition root
大量阶段计划、ADR、权威报告与交叉评估附录
```

与此同时，持续协作最小链路仍没有完成。

### 9.2 文档过程也出现过度叠加

将每轮 subagent 交叉评估继续追加到旧权威报告，会造成：

- 快照身份模糊；
- 原裁决与后续批注互相覆盖；
- 同一问题在多节重复；
- PR diff 与 review 负担继续增长；
- “报告规则”与实际维护方式矛盾。

本轮恢复一轮一报告。后续不应再向第一至第十三轮报告追加新 revision。

### 9.3 应冻结的横向扩展

在以下链路完成前，冻结新的 Profile、Automation 类型、Driver wrapper、展示事件和 Workflow DSL：

```text
single-owner Runtime
→ authoritative Session
→ persistent Provider stream
→ follow-up / cancel / resume
→ Collaborate → Deliver
→ RunPlan authority
→ export / compaction / retention
```

## 10. DeepSeek Harness 官方对齐

截至本轮取证，DeepSeek Harness master 与最新 release 仍为 `dsh-v0.1.2-alpha.3` / `dd6322d...`，没有新的上游版本需要追 pin。

### 10.1 Headless

官方 Headless 明确：

- 一次 invocation 一个 task；
- 输出最终回答后退出；
- 没有 interactive follow-up；
- 更适合脚本、CI 和 one-off job。

因此 Tekon 继续把 `dsh-headless` 限制为 Goal/one-shot 是正确的，不应把它扩展成 Collaborate 或完整 Deliver runtime。

### 10.2 ACP

官方 ACP 已提供：

- persistent session new/list/resume/close；
- prompt 与 prompt-owned cancel；
- semantic execution updates；
- model/reasoning config；
- permission request；
- quiescent close、update drain 与 persistence flush。

它仍缺 transcript replay、fork、additional directories 和 DSH 私有 UI，但已经更接近 Tekon 持续协作所需的控制面。建议下一阶段做独立 vertical slice，而不是把 ACP 强塞进现有 one-shot `AgentAdapter`。

### 10.3 Session export

官方 session-log-export 的可借鉴点：

- `HEAD` preflight；
- Host 端流式 ZIP，不在浏览器 JS 缓冲整个文件；
- live Session flush 后读取；
- 单 Session 单 active download；
- session/subsession/attachment 边界；
- pre-stream 与 post-stream 失败语义区分。

### 10.4 Safety

官方仍明确标记为未经安全审计的 developer preview，sandbox、approval 和 permission control 只能降低风险，不能保证隔离。Tekon 必须保留自身的 worktree、权限、审批、凭据、网络确认和外部隔离边界，不能把 DSH 当作唯一安全控制。

## 11. 建议推进顺序

### P0

1. repo 级 single-owner Runtime/daemon 与锁；
2. executor process/worker 隔离、真实 kill/join 与 restart recovery；
3. authoritative Session log / transactional outbox / durable inbox 选型；
4. ACP 或等价 persistent Provider vertical slice：stream、follow-up、prompt cancel、resume；
5. Collaborate → Deliver handoff。

### P1

1. canonical RunPlan 成为 execute/resume 唯一输入；
2. complete-history export；
3. model summary/compaction 与统一 retention；
4. DSH Host Node 版本直接 preflight；
5. branch protection/required checks；
6. Firefox/WebKit 与全站 a11y 专项。

### P2

1. 从 `command-gateway` 抽 timeout state machine；
2. 大 artifact 输出目录监控的资源预算；
3. 真实 static linter 与 format debt；
4. CLI/Web 文案语言一致性；
5. release provenance、SBOM 与签名。

## 12. 最终裁决

### 本轮代码增量

**通过当前合并门。**

理由：no-progress 边界竞态已修复，有针对性回归测试；reviewer 代码快照 Core #368 与 CI #277 均首次执行成功，未依赖 rerun 才获得最终绿色。

### Tekon 整体产品

**不通过稳定持续协作产品验收。**

允许的成熟度表述：

> Tekon v0.20.4 已形成测试覆盖较强、执行计划和风险边界较透明、Session 在线观察具有基础资源上限的实验性受控交付执行与观察基础设施；Deliver 轨道可在有人监督下试用，但持续协作、单一 Runtime 权威、权威 Session 事实链、可证明的 shutdown/restart、完整历史导出和模型上下文预算尚未闭环。

### 合并建议

- 当前 PR 已超过百个提交、约 180 个文件，建议 squash merge；
- 合并前确认最终 PR Head 的 Core/CI 仍为 `completed/success`；
- `main` 未保护，当前仍依赖人工遵守合并门；
- 后续架构主线必须拆独立 PR；
- 本轮不执行 merge、release、deploy 或 ruleset 修改。

## 13. 参考资料

### Tekon

- [当前权威入口](current.md)
- [第十三轮报告](2026-09-01-tekon-product-runtime-harness-thirteenth-review.md)
- [第十四轮整改方案](../superpowers/plans/2026-09-01-fourteenth-review-remediation-plan.md)
- [`command-gateway`](../../packages/core/src/runtime/command-gateway.ts)
- [`command-gateway` no-progress 边界测试](../../packages/core/__tests__/runtime/command-gateway-no-progress-boundary.test.ts)
- [`SessionComposer`](../../packages/web/src/client/components/sessions/SessionComposer.tsx)
- [`LegacyAgentDriver`](../../packages/core/src/runtime/legacy-agent-driver.ts)
- [`Session dual-write`](../../packages/core/src/session/dual-write.ts)
- [`JobRunner`](../../packages/core/src/session/job-runner.ts)
- [`RunPlan`](../../packages/core/src/workflow/run-plan.ts)
- [CLI composition root](../../packages/cli/src/lib/session-context.ts)
- [Web composition root](../../packages/web/src/server/api/root.ts)

### DeepSeek Harness 官方

- [Release `dsh-v0.1.2-alpha.3`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.3)
- [Headless](https://github.com/deepseek-ai/deepseek-harness/blob/dd6322d604e00eec1ba5e0c8541159906a21094a/packages/bundle/headless/README.md)
- [ACP](https://github.com/deepseek-ai/deepseek-harness/blob/dd6322d604e00eec1ba5e0c8541159906a21094a/packages/acp/acp/README.md)
- [Session log export](https://github.com/deepseek-ai/deepseek-harness/blob/dd6322d604e00eec1ba5e0c8541159906a21094a/packages/session-query/session-log-export/README.md)
- [Safety](https://github.com/deepseek-ai/deepseek-harness/blob/dd6322d604e00eec1ba5e0c8541159906a21094a/SAFETY.md)
