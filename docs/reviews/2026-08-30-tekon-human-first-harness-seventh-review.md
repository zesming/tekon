# Tekon 人类可用性与 Harness 架构第七轮全面复审

- **复审日期**：2026-08-30
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **仓库主线基线**：`main@300aea6b9ea5c805303e7e1d302dadabc5531548`
- **本轮开始时 PR Head**：`97712042208c9197659ed2445c96c4c74f253b27`
- **上一轮权威报告快照**：`507b26e6c099f98e9343ba501cca87055640207c`
- **本轮审阅修复提交**：
  - `6d8cb3a72dd284475db3e94aafba1a81b7929a73`
  - `3c769b5581403b5801d129b22e35c52e0113ad7c`
  - `84f9879b910539710017dd2d3e660980ab7ce5f4`
  - `1fbf99905c7fe8aecc50f4df0b6757e78441d478`
  - `c2dff2c9391404001e2cae2e34677e71efdd5e06`
  - `188d50ba43174752fbf2965546f57e54e5700abd`
  - `5bf2fe3423682d1f693da91f656924868d2a205c`
- **当前版本**：`0.17.0`
- **覆盖维度**：产品逻辑、CLI/Web UI、UX 与可访问性、Runtime/Session/数据架构、代码实现、测试可信度、安装与升级、DeepSeek Harness 最新官方边界、过度实现与过度设计
- **最终裁决**：**本轮发现并修复了阻断 CI 的浏览器测试合同漂移、安装环境声明错误和自定义安装目录失效等真实问题。完成最终门禁后，当前增量可通过代码合并门；Tekon 仍不通过“面向普通人的稳定持续协作研发工作台”产品验收，可作为实验性受控交付执行与观察基础设施有条件通过。**

> 本报告取代第六轮报告成为 PR #11 的当前详细裁决；`docs/reviews/current.md` 是稳定入口。旧报告只保留判断演进历史。

---

## 1. 执行摘要

本轮开始时，PR 的远端 Head 仍是 `97712042208c9197659ed2445c96c4c74f253b27`，与上一轮最终提交相同，没有检测到新的用户提交。因此本轮不是对一个额外增量做窄复核，而是对上一轮完整工作树和上一轮结论重新验真。

重新读取 GitHub Actions 的**终态**后，首先发现上一轮结论存在需要公开纠正的错误：上一轮最终答复把尚未结束的验证描述成已全部通过，但 `977120...` 的最终 CI 实际为 failure，阻断项是 Web Playwright。此后两轮修复又分别暴露了剩余的旧断言，直到把失败收敛为一个不存在运行页面的宽泛文本匹配。问题不是产品启动链全面失效，而是产品文案从“已连接”诚实调整为“连接凭据：已设置”后，多个测试文件仍复制旧字符串；最终一个 `/错误/` 正则还误匹配了临时目录名中的 `error`。

本轮没有通过关闭 strict mode、删除断言或忽略 flaky 来制造绿色结果，而是：

1. 把所有连接状态断言迁移到真实可访问名称；
2. 把失败会话操作断言迁移到真实 `aria-label`；
3. 把不存在运行断言锁定为真实服务端错误消息；
4. 保留 `retries: 1` 与 `failOnFlakyTests`，确保 retry 后通过仍不会被当作绿色；
5. 补充安装器 shell 语法检查。

仓库级复审还确认了两个用户可见的安装问题：

- 项目使用 Vite 7，但 README、用户手册与安装脚本仍宣称 Node.js 18 可用；Vite 7 官方要求 Node.js `20.19+` 或 `22.12+`；
- 安装脚本允许设置 `TEKON_HOME=/opt/tekon`，但生成的启动器硬编码 `$HOME/.tekon`，导致自定义目录安装完成后命令指向错误位置。

本轮已为根包增加 Node engines、收紧安装脚本版本门槛、修复自定义目录启动器，并更新 README。用户手册 Markdown/HTML 仍含旧 Node 18 文案，列为本轮剩余文档一致性问题，后续应由手册生成链统一修正，避免只改单一产物。

结构性结论没有根本改变：

```text
single-owner runtime
→ shutdown / recovery 持久语义
→ 权威 Session log / durable inbox
→ DSH SDK/ACP 或其它真实 Provider streaming
→ follow-up / steer / resume / restart recovery
→ Collaborate → Deliver + 权威 run plan
→ Session 数据、网络、内存、DOM 全链路有界化
→ 数据引用完整性与全站可访问性
```

---

## 2. 复审方法与证据边界

### 2.1 仓库覆盖

本轮重新覆盖：

- **产品与文档**：README、用户手册、current scope、ADR、CHANGELOG、第六轮报告及 `current.md`；
- **CLI**：入口、run/goal/provider 参数、初始化与更新脚本、resume/pause/cancel、embedded JobRunner；
- **Web**：默认 Session Composer、高级 StartRunForm、TopBar、Session 列表与详情、EventFeed、审批、交付、RPC/SSE、移动端 drawer；
- **Core**：Session store/service、JobRunner、dual-write、Agent runtime、run-mode policy、DSH adapter/probe、workflow template、数据库 migration；
- **验证**：Core、Root typecheck、CLI unit/e2e、Web build/typecheck/unit、Chromium Playwright、Actions workflow；
- **外部基线**：Vite 7 官方 Node.js 要求，DeepSeek Harness 最新 prerelease、SDK、ACP、Session 与 Safety 官方资料。

这是仓库级结构覆盖与关键路径深读，不宣称逐行审阅全部历史文件。

### 2.2 UI 证据限制

本轮没有独立部署实例和云浏览器交互面，因此：

- 已检查 React 组件结构、状态合同、ARIA/label、焦点逻辑、RPC/SSE 行为和 Chromium Playwright；
- 已利用 Actions 真实运行结果定位可访问名称、严格定位器和生产构建启动问题；
- 没有冒充完成屏幕阅读器、Safari/Firefox、多 DPI、视觉回归或完整 WCAG 审计。

---

## 3. 对上一轮结论的纠正

### 3.1 CI 状态不能用“已触发”代替“已通过”

上一轮最终答复声称完整验证通过，但当时最终 Head 的完整 CI 尚未结束。其后终态显示 Web Playwright failure。该表述不符合证据，现予以纠正。

后续规则：

- 代码快照、报告快照和最终 PR Head 分开记录；
- 只有 workflow `status=completed` 且 `conclusion=success` 才称通过；
- 后续提交导致旧 run cancelled 时，只能说明取消原因，不能把它当作成功；
- 报告提交后产生的新最终 Head，必须再次读取对应 Core/CI 终态。

### 3.2 本轮开始时没有新的用户 commit

用户表示已推送调整，但本轮读取到的 PR Head 仍是上一轮最终提交 `977120...`。因此本报告不能虚构一个不存在的“用户最新整改 SHA”。本轮所有新增 commit 均为本次审阅过程中的修复和报告提交。

---

## 4. 本轮实际修复

### 4.1 浏览器验证合同收敛

涉及文件：

- `packages/web/__tests__/e2e/shared-fixture.ts`
- `prod-bootstrap.test.ts`
- `prod-bootstrap-history.test.ts`
- `dashboard.test.ts`
- `mobile-drawer-accessibility.test.ts`
- `release-dashboard.test.ts`
- `session-feed.test.ts`
- `session-acknowledge-ui.test.ts`
- `run-tab-content.test.ts`

修复内容：

- 将旧的“已连接/未连接/凭据已设置”定位统一为 TopBar 的真实可访问名称：`连接凭据：已设置` / `连接凭据：未设置`；
- 将失败会话按钮断言统一为真实 `aria-label`：`将失败会话标记为已处理`；
- 将不存在运行页的宽泛 `/not found|404|不存在|错误/` 改为精确错误 `Run not found: non-existent-run-id`，避免临时路径中的 `error` 造成 strict-mode 多匹配；
- 没有降低 Playwright strictness，没有删除产品行为断言。

根因不是单个测试失误，而是相同产品词汇被复制在多个测试文件中。后续应建立一个极小的测试 locator helper 或共享常量，但不建议把生产文案强耦合到大型测试 DSL。

### 4.2 Node.js 支持范围纠正

涉及文件：

- `package.json`
- `scripts/install.sh`
- `README.md`

修复内容：

- 根包增加 `engines.node = "^20.19.0 || >=22.12.0"`；
- 安装脚本不再接受 Node 18，也不会错误接受 Node 20.0–20.18 或 Node 22.0–22.11；
- README 与安装错误提示使用同一范围；
- CI 增加 `bash -n scripts/install.sh`。

依据：Vite 7 官方明确放弃 Node 18，并要求 Node 20.19+ 或 22.12+。

### 4.3 自定义安装目录启动器修复

原脚本虽然支持：

```bash
TEKON_HOME=/opt/tekon ... | bash
```

但生成的 `tekon` wrapper 固定执行：

```bash
$HOME/.tekon/packages/cli/dist/index.js
```

因此自定义目录只完成了文件安装，没有得到可工作的命令。本轮改为把安装时解析出的真实 `CLI_PATH` 安全写入 wrapper，并使用 Bash `%q` 进行 shell escaping。

### 4.4 决策入口收敛

README 不再指向第一轮历史报告，而是指向 `docs/reviews/current.md`。本轮继续遵守：

- CHANGELOG 只记录用户可见行为；
- `current.md` 是稳定入口；
- 第七轮报告是当前详细裁决；
- 历史报告不继续追加 reviewer 长附录。

---

## 5. 产品逻辑评审

### 5.1 Deliver 轨道已具备真实产品价值

当前受控交付轨道已经形成可用的主链：

- CLI/Web 入口可发现；
- 默认行为诚实说明会启动完整 `standard-delivery`；
- Workflow/Goal/provider 非法组合在持久副作用前失败；
- dsh 不受限网络确认已贯通 CLI、Web、runtime guard 与 Audit；
- Artifact、Gate、review、delivery prepare/create-pr 和远端 CI 证据有明确边界；
- push/PR 等副作用仍需显式人工确认。

因此，把 Tekon 定义为“实验性受控交付执行与观察基础设施”是成立的。

### 5.2 Collaborate 轨道仍不存在（P0-PRODUCT-01）

`LegacyAgentDriver.followUp()`、`steer()`、`resume()` 仍抛 `NotSupportedYet`。用户进入 Session 后不能：

- 在同一 Session 追加 durable user input；
- 在运行中 follow-up 或 steer；
- 从真实 provider 获得执行期 assistant/tool semantic stream；
- 浏览器刷新或进程重启后恢复正在进行的协作；
- 从 Collaborate 显式升级到 Deliver。

现有 Session 仍主要是运行观察、审批与结果界面，不是持续协作产品。

### 5.3 Run plan 仍不是权威执行合同（P1-PRODUCT-02）

默认入口已经把服务端 plan 置于启动前，并在 plan 失败时 fail-closed，这是有效改进。但仍存在：

- 高级 `StartRunForm` 在 `workflow.plan` 加载失败时隐藏预览、仍允许提交，属于 fail-open；
- preview 与真正 `project.run` 分别重新加载模板，没有 plan digest、版本或 snapshot identity；
- plan 未完整显示 provider/model、权限 posture、dirty-base、全部 timeout、预期 artifact、成本影响因素；
- 用户批准的“看到的计划”不能被证明就是实际执行计划。

建议以 server-generated immutable plan snapshot + digest 绑定 run，而不是继续增加前端展示字段。

### 5.4 Web 高级模板目录与 CLI 不一致（P1-PRODUCT-03）

CLI `workflow list` 会展示六个 built-in 模板和项目模板；Web `workflow.list` 只扫描 `.tekon/workflows`。新初始化项目通常只有空目录，因此高级表单只能看到空列表和隐式默认模板，无法显式选择 README 宣称的 `bugfix`、`docs-update`、`plan-only` 等内置模板。

此外，Web 列表把 YAML 内部 `id` 作为 select value，但 plan/run 按文件名加载；当项目模板文件名和 YAML `id` 不同时，用户可以看到选项，却会请求不存在的模板名。

这是产品目录合同问题，不是视觉问题。建议 Core 提供统一 template catalog API，CLI/Web 共同消费；不建议分别维护静态数组。

---

## 6. UI / UX 评审

### 6.1 已改善

- 默认入口使用产品化“受控交付”而不是工程 Cockpit；
- TopBar 将“已连接”改为“连接凭据已设置”，避免把本地 token 存在伪称为服务健康；
- Session 列表有行动优先排序、失败 acknowledge 和 workspace 级刷新；
- EventFeed 默认呈现叙事时间线，技术事件可展开；
- 移动 drawer 具备 dialog、focus trap、Escape、overlay 和 focus restore；
- StartRunForm disclosure、label、ARIA 和网络确认具有浏览器覆盖。

### 6.2 高级执行计划错误没有明确阻断（P1-UX-01）

高级页计划失败时没有 error surface，也没有阻止启动。用户会从“看不到预览”推断“没有特殊计划”，而不是“计划服务失败”。应显示 loading/error，并在权威 plan 不可用时禁用提交。

### 6.3 连接管理仍不代表健康检查（P1-UX-02）

当前“凭据已设置”文案是诚实的，但产品仍没有：

- 服务端握手状态；
- token 过期/不匹配状态；
- 最近成功请求时间；
- 重新连接或诊断结果。

因此不能把它进一步包装成“连接正常”。建议新增轻量 session health RPC，而不是用 token 非空推导健康。

### 6.4 长 Session 仅限制 DOM，不限制数据链路（P1-UX-03）

EventFeed 的窗口化降低了初始 DOM 节点数，但：

- `useSessionStream` 仍在内存中累积全部事件；
- 首次 SSE replay 仍从 0 拉取全历史；
- 服务端 `listEventsSince` 没有 limit/cursor page；
- 网络、JSON 解析和客户端内存仍随历史线性增长。

“长 Session 已有界”仍不成立。需要 summary projection、cursor、分段加载与虚拟化共同完成。

### 6.5 可访问性仍是部分完成

自动化已覆盖主入口和部分移动交互，但仍缺：

- 全站屏幕阅读器实测；
- Safari/Firefox；
- 错误与字段的 `aria-describedby` 系统审计；
- 对比度、缩放、reduced motion；
- 动态 feed 在大量更新时的朗读噪声评估。

---

## 7. Runtime 与数据架构评审

### 7.1 Runtime 仍无单一所有者（P0-ARCH-01）

Web 与 CLI 都能创建 JobRunner，并共享 SQLite、Git、worktree、`.tekon/runs`、Artifact、Audit 与子进程资源。Job owner/lease/CAS 只能 fence Job 行，不能覆盖：

- Git checkout/commit/push；
- Artifact 与 Gate 落盘；
- Audit append；
- Delivery 状态；
- 文件系统和外部 provider 副作用。

长期仍应采用 repo-scoped daemon + lock，CLI/Web 客户端化。若选择 active-active，则必须为全部副作用设计 generation fencing；只强化 Job 表会形成虚假安全感。

### 7.2 Shutdown 显著改善但仍非严格 quiescent（P0-ARCH-02）

当前已具备：

- stopped/draining；
- 等待 active poll；
- 阻止 stop 后 claim；
- 有界正常 settle 窗口；
- abort + subprocess kill；
- 再次等待 pending drain；
- Web automation listener 先停再关数据库。

但 escalation 后 `Promise.allSettled([...pending])` 没有 hard deadline。若 executor/provider 忽略 AbortSignal 且无法被 registry kill，`stop()` 可永久挂住。与此同时，“服务关闭”应把 durable job 标为 cancelled、interrupted、paused 还是 recoverable/requeued，仍缺明确产品语义。

因此准确结论是：主要 late-claim/late-write 竞态已修，严格 shutdown/recovery 合同仍未关闭。

### 7.3 Session Event 仍是 best-effort projection（P0-ARCH-03）

`dual-write.ts` 仍允许旧仓储/Audit 成功后，Session Event 追加失败被吞掉。由此：

- event log 不能保证完整；
- 模型上下文不能只从 log 重建；
- durable inbox、fork/resume、follow-up claim 无法建立在该事实链上；
- UI 投影可能和领域状态短暂或永久不一致。

必须明确选择：

1. Session log 成为权威源，所有模型可见输入先 durable append，再 claim/投影；或
2. 长期定义为观察投影，并停止向其叠加需要完整性的能力。

### 7.4 Session 子表引用完整性仍缺失（P1-DATA-01）

`session_events.session_id`、`jobs.session_id`、`projection_checkpoints.session_id` 没有统一外键与孤儿策略。合理修复需要：

- 盘点/隔离旧孤儿；
- SQLite table rebuild migration；
- cascade/restrict 决策；
- 老库升级和回滚测试；
- 修正直接插入孤儿的 fixture。

只为新库加外键会制造新旧行为分裂，不建议以此“快速关闭”。

---

## 8. DeepSeek Harness 对齐评审

### 8.1 现有 headless 定位仍正确

官方 headless 是 one-shot task 边界：输入任务，输出最终答案，然后退出。Tekon 将 `dsh-headless` 限制为 Goal，而不允许它伪装成持续 Session 或完整 Deliver provider，是正确的。

### 8.2 持续协作应评估 SDK / ACP

DeepSeek Harness 当前已公开：

- SDK stdio JSON-RPC：可创建 Session、发送 prompt、观察 Session event 和 agent 状态；
- ACP：支持 persistent session、list/resume/close、prompt/cancel、semantic updates、model/permission 配置和 quiescent close；
- 持久 Session log 与更完整的生命周期合同。

因此 Tekon 的 Collaborate vertical slice 不应继续扩展 one-shot headless adapter，而应对 SDK 与 ACP 做小型真实集成对比。

### 8.3 Tekon runtime preflight 仍只验证版本（P1-DSH-01）

Core 已实现三个 probe 能力：

- exact version；
- `--help` headless contract；
- `--dump-default-config` plugin composition。

但生产 `dsh-headless-adapter` 当前只执行 version gate；help/config 检查主要存在于 fixture 与 opt-in live test。也就是说，代码中“拥有 probe”不等于运行时“执行了完整 capability preflight”。

建议新增显式 provider preflight，并在创建 Workflow/Session/Job 之前执行或缓存以下事实：

```text
binary found
→ exact tested version
→ expected headless flags
→ required plugin/profile composition
→ credentials/config readiness
```

### 8.4 安全边界不能外包给 Harness

DeepSeek Harness 官方仍明确标为 experimental developer preview，尚未完成安全审计；sandbox、审批和权限控制可以降低风险，但不保证隔离。Tekon 的网络确认是必要的产品事实，但不能替代 OS/container/VM 级最小权限与隔离。

---

## 9. 代码实现与测试可信度

### 9.1 优点

- Core、CLI、Web 和浏览器测试层次完整；
- 多个并发、CAS、owner loss、SSE catch-up、auth scope 和 teardown 竞态有确定性用例；
- Playwright CI 使用 `failOnFlakyTests`，不会把 retry 通过伪装成稳定；
- 运行模式和网络风险有跨入口测试；
- 代码注释通常能解释并发不变式，而不只是描述语法。

### 9.2 测试字符串复制导致维护性回归（P2-TEST-01）

一次诚实的 TopBar 文案调整使多个 E2E 文件同时失效，说明测试中的产品词汇缺少最低限度复用。建议：

- 为稳定、跨页面复用的控件建立小型 locator helper；
- 仍优先使用 role/name，而不是 CSS；
- 不把所有文案集中到大型 page-object 或测试 DSL，避免测试层再次过度设计。

### 9.3 安装器此前不在 CI 保护面（P2-TEST-02）

安装脚本同时承载 Node 检查、clone/update、构建、wrapper 生成和 shell 配置，却没有最基本的语法门。已补 `bash -n`，但仍缺：

- 自定义 `TEKON_HOME` smoke；
- bash/zsh/fish 配置路径测试；
- update 失败不应被 `|| true` 静默吞掉的行为定义；
- macOS/Linux 环境矩阵。

### 9.4 用户手册生成链仍存在漂移（P1-DOC-01）

README、根 package 与 installer 已统一 Node 范围，但 `docs/manual/tekon-user-manual.md` / HTML 仍写 Node >=18。应识别 Markdown/HTML 的权威源和生成命令，一次性更新并加一致性检查；不建议手工分别修改两个大型产物。

---

## 10. 过度实现与过度设计

### 10.1 横向抽象继续领先于纵向闭环

Tekon 已拥有：

- Profile policy；
- Automation jobs；
- Goal；
- Provider registry；
- LegacyAgentDriver；
- dual-write projection；
- CLI/Web 两个 Runtime composition root；
- DSH bridge/probe；
- Session 与 Advanced 两套表面。

但尚未完成一个真实 Collaborate vertical slice。下一阶段应冻结不直接服务以下链路的新抽象：

```text
真实 provider semantic stream
→ durable user input
→ follow-up / steer
→ restart resume
→ 浏览器恢复
→ Collaborate → Deliver
```

### 10.2 不要为 multi-owner 到处叠加局部 fencing

继续为 Artifact、Gate、Audit、Git、Delivery 分别增加 owner token，会把系统推向难以验证的 active-active。除非产品明确需要多执行节点，否则 single-owner daemon 更简单、可解释、可测试。

### 10.3 评审流程本身需要控制规模

仓库已有大量多轮报告和长 CHANGELOG。后续应保持：

- `current.md`：稳定入口；
- 当前报告：详细事实；
- ADR：稳定架构决策；
- CHANGELOG：用户可见变更；
- 旧报告：只读历史。

不再通过追加大型 reviewer 附录维护“当前事实”。

---

## 11. 当前问题分级

### P0：产品与架构主线

1. **P0-ARCH-01**：一个 repo 没有 single-owner Runtime；Job fencing 不覆盖全部副作用。
2. **P0-ARCH-02**：shutdown 的主竞态已修，但 non-cooperative executor 的 hard deadline 与 durable recovery 语义未关闭。
3. **P0-ARCH-03**：Session Event 是 best-effort projection，不是 authoritative log / durable inbox。
4. **P0-PRODUCT-01**：Collaborate 缺真实 streaming、follow-up、steer、resume 与重启恢复。

### P1：产品、UX 与数据

1. **P1-PRODUCT-02**：run plan 未与实际 run 绑定；高级入口 plan fail-open。
2. **P1-PRODUCT-03**：Web 模板目录不含 built-ins，项目模板 selector 可能与文件名不一致。
3. **P1-DSH-01**：runtime 只执行 DSH version gate，未执行 help/config capability preflight。
4. **P1-UX-02**：连接管理只证明凭据存在，不证明服务健康。
5. **P1-UX-03**：长 Session 只限制 DOM，数据、网络和内存无界。
6. **P1-DATA-01**：Session 子表无统一外键和孤儿迁移策略。
7. **P1-DOC-01**：用户手册仍宣称 Node 18 可用，与实际 Vite 7 合同冲突。
8. **P1-A11Y-01**：主路径改善，但全站、多浏览器和屏幕阅读器验收未完成。

### P2：维护性与验证

1. **P2-TEST-01**：跨文件复制稳定控件文案，导致一次文案变更击穿整套 E2E。
2. **P2-TEST-02**：安装器只有语法门，缺自定义目录和多 shell smoke。
3. **P2-PROCESS-01**：历史报告与 CHANGELOG 仍有较高决策噪声，需继续执行单一入口规则。

---

## 12. 推荐实施顺序

### A. Runtime authority 与恢复语义

1. repo lock + single-owner daemon；
2. CLI/Web 客户端化；
3. durable draining/interrupted/recoverable 状态；
4. provider/process hard deadline；
5. kill/restart/late-write 故障矩阵。

### B. 权威 Session 事实链

1. 事实源 ADR；
2. durable inbox + idempotency + claim；
3. 模型可见输入全部从 log 重建；
4. dual-write migration/校验/下线；
5. 外键与孤儿迁移。

### C. 一个真实 Collaborate vertical slice

1. DSH SDK vs ACP spike；
2. execution-time semantic stream；
3. durable follow-up / steer / cancel；
4. browser refresh + process restart resume；
5. 一条真实 provider E2E。

### D. Collaborate → Deliver 与权威计划

1. immutable run-plan snapshot + digest；
2. provider/model/权限/网络/timeout/artifact/审批点；
3. 默认与高级入口统一 fail-closed；
4. 显式模式升级；
5. 接入 Artifact/Gate/Delivery。

### E. 产品规模与体验

1. Session summary projection + cursor；
2. replay/网络/内存/DOM 全链路有界；
3. health RPC 与连接诊断；
4. Core template catalog 统一 CLI/Web；
5. 用户手册生成与一致性检查；
6. 全站可访问性专项。

---

## 13. 验收结论

### 代码合并门

本轮已实际修复：

- 浏览器 credential/ack/missing-run 测试合同；
- Node.js 支持范围声明；
- 自定义 `TEKON_HOME` 启动器；
- installer shell 语法门；
- README 当前评审入口。

最终合并判断以本报告和 `current.md` 提交后的**最终 PR Head**对应 Core/CI 终态为准，不复用中间提交的结果。

### 产品验收门

- [x] CLI/Web 主入口可发现，默认受控交付边界诚实；
- [x] Workflow/Goal/provider 非法组合 fail-fast；
- [x] dsh 不受限网络确认跨 CLI/Web/runtime/Audit；
- [x] 失败会话可持久 acknowledge；
- [x] workspace 轻量实时刷新和跨 workspace 隔离；
- [x] 核心连接文案不再伪称服务已连接；
- [ ] 同一 Session 可继续输入、转向并在重启后恢复；
- [ ] Provider 输出是执行期真实 semantic stream；
- [ ] Collaborate 与 Deliver 是行为不同且可升级的明确轨道；
- [ ] 一个 repo 有单一 Runtime owner，或全部副作用有完整 fencing；
- [ ] shutdown 有 hard deadline 与持久恢复语义；
- [ ] Session log / durable inbox 是权威事实链；
- [ ] run plan 与实际 run 绑定且所有入口 fail-closed；
- [ ] 长 Session 数据、网络、内存、DOM 全链路有界；
- [ ] DSH capability preflight 是生产合同；
- [ ] Session 子表引用完整性迁移完成；
- [ ] 全站可访问性与多浏览器验收完成。

# 最终裁决

**本轮不能简单回答“整体通过”。**

准确裁决是：

1. 上一轮未经最终 CI 终态即宣称验证完成，结论已纠正；
2. 本轮发现的浏览器门禁、Node 支持与自定义安装目录问题已修；
3. 若最终 PR Head 的 Core/CI 全部完成且成功，当前增量可通过代码合并门；
4. Tekon v0.17.0 仍不通过“面向普通人的稳定持续协作研发工作台”产品验收；
5. 可继续使用的成熟度表述是：

> Tekon v0.17.0 已形成测试较强、启动与风险边界较透明的实验性受控交付执行与观察基础设施；它尚未完成持续协作产品、单一 Runtime 权威、权威 Session 事实链、权威 run plan 和全链路长会话有界化。

本 PR 未执行 merge、release 或 deploy。

---

## 参考资料

- [Vite 7 announcement / Node.js support](https://vite.dev/blog/announcing-vite7)
- [DeepSeek Harness releases](https://github.com/deepseek-ai/deepseek-harness/releases)
- [DeepSeek Harness SDK](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/sdk)
- [DeepSeek Harness ACP](https://github.com/deepseek-ai/deepseek-harness/tree/master/packages/acp/acp)
- [DeepSeek Harness Safety](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)
