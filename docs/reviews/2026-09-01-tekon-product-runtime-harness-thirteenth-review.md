# Tekon 产品、UI/UX、Runtime 与 DeepSeek Harness 第十三轮全面复审

- **日期**：2026-09-01
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **上一轮权威报告**：[第十二轮全面复审](2026-08-31-tekon-product-runtime-harness-twelfth-review.md)
- **上一轮权威 Head**：`cf2ccf18d5947331487ca285e1fd5cffb2d68c82`
- **用户 v0.20.4 整改快照**：`1c285e03b017a4935603859f0e1fb1726d3f230e`
- **本轮 reviewer 代码快照**：`6917c06369d5cb0da5b681fc61d2bb25d600572d`
- **产品版本**：`0.20.4`
- **Tekon DSH tested pin**：`0.1.2-alpha.3`
- **DeepSeek Harness 官方取证基线**：master / `dsh-v0.1.2-alpha.3` `dd6322d604e00eec1ba5e0c8541159906a21094a`
- **代码自动化状态**：reviewer 代码快照的 Core #362 与 CI #271 均为 `completed/success`
- **最终裁决**：v0.20.4 整改与本轮 reviewer 修复通过当前代码合并门；Tekon 整体仍未通过“面向普通人的稳定持续协作研发工作台”产品验收

## 1. 执行摘要

v0.20.4 的整改整体有效：

1. `dsh` tested pin 已从 `0.1.2-alpha.2` 升至官方 `0.1.2-alpha.3`；Tekon 实际依赖的 headless README、headless 入口实现、Node engines、help/config 锚点没有发生兼容性变化。
2. 根产品版本与 `@tekon/core`、`@tekon/cli`、`@tekon/web` 已统一为 `0.20.4`，并有 smoke 断言防止再次漂移。
3. CLI fixture 不再派生 `npm init` / `npm pkg set`，此前 pnpm 环境变量导致的 npm unknown-config warning 已从 CLI unit/e2e lane 消失。
4. `pnpm audit --prod` 已进入 CI，生产依赖 advisory 不再只靠人工复审。
5. smoke 包目录过滤、dirty-base 测试与 audit job 拆分等收尾调整均已进入代码并通过自动化。

本轮在重新审查整个产品链路时又发现一项真实 UI/UX 缺陷：Session 详情页虽然从 `session.get` 获得当前 Session 状态与关联 run，但右栏完全依赖迁移期 best-effort Event projection。Event 尚未追上或发生双写缺失时，审批入口可能不可见，关联 run 可能没有控制入口，未知状态还会被默认解释为 `running`，短暂展示不合法的暂停/取消动作。

本轮已修复为：

```text
session.get point-in-time snapshot
  → 作为 runId / lifecycle / attention 的安全回退
  → live Event 到达后优先覆盖快照
  → gate.list 决定当前真实 pending decisions
  → 未知状态 fail-closed，不生成运行中控制
```

同时修复两项过程真实性问题：

- DSH L2 live probe 现在要求真实安装版本精确匹配 tested pin，不能再以“生产 gate 会拒绝版本漂移”为由让发布前 probe 假通过；
- production audit 仍是顶级失败 gate，但不再成为 CLI/Web 功能测试的前置依赖，避免 registry 故障或 advisory 变化压掉全部应用诊断。

这些修复提高了当前 Deliver/观察轨道的可靠性，但没有改变核心产品成熟度：Tekon 已具备较扎实的受控交付执行、治理、审阅与在线观察基础；持续协作 Collaborate、单一 Runtime 权威、权威 Session 事实链、真实 Provider execution-time stream、restart recovery、完整历史导出和模型上下文预算仍未闭环。

## 2. 评审范围与方法

本轮覆盖：

- `cf2ccf...` 到用户整改快照 `1c285e...` 的全部增量；
- 用户后续补充的第十二轮第 17/18 节、v0.20.4 CHANGELOG 和第十三轮整改方案；
- PR 当前全仓实现，包括 Core、CLI、Web、workflow、Session/Event/Job、Provider、Gate、Artifact、Delivery、Automation、Readiness 与 SSE；
- Web 默认 Composer、Session detail/feed/right rail、RunControls、审批查询与 query invalidation；
- RunPlan、LegacyAgentDriver、Session dual-write、JobRunner stop、CLI/Web composition root；
- DSH bridge probe、headless adapter、fixture contract 与 opt-in live probe；
- 当前 GitHub Actions、package scripts、测试选择、生产依赖 audit 与分支保护状态；
- DeepSeek Harness 官方 alpha.3 release、Headless、ACP、Safety、Session persistence 与 session-log export；
- README、用户手册、ADR、评审入口和变更日志的一致性。

判断原则：

1. 自动化结论必须绑定具体 commit 与 `completed/success` 的 workflow run；
2. Event projection、领域表、Session snapshot、Gate 查询分别说明事实层级，不能互相偷换；
3. “命令存在”“fixture 通过”“真实二进制 probe”“真实带凭据 Provider smoke”分层表述；
4. UI 有界渲染不等于完整历史可导出，也不等于模型上下文有 compaction；
5. 一个顶级 gate 应让 workflow 失败，但不应无必要地压掉其它独立诊断；
6. 产品不存在的能力应诚实禁用，不用文案或 synthetic event 模拟完成；
7. 架构缺口不能通过继续在超大 PR 中增加 wrapper、状态映射或文档 revision 制造关闭假象。

本轮没有可访问的独立部署实例、真实 `dsh` 可执行文件、API key、Firefox/WebKit、屏幕阅读器或真实弱网设备。因此真实视觉、跨浏览器、辅助技术与 L2/L3 Provider 结论严格限定在代码和现有自动化证据内。

## 3. v0.20.4 用户整改逐项裁决

| 整改项 | 裁决 | 理由与边界 |
| --- | --- | --- |
| DSH pin `alpha.2 → alpha.3` | 对 Tekon 使用的锚点关闭 | 官方 alpha.3 的 headless README 与入口实现和 alpha.2 相同，根 Node engines 仍为 `^22.19.0 || >=24.0.0`；但 alpha.3 整个上游 release 包含 Session persistence、queued follow-up/image 与 UI 等更广变化，不能泛化为“整个上游合同零变化”。 |
| 内部 package 版本 lockstep | 关闭数字身份漂移 | 根与三个内部 package 均为 `0.20.4`；smoke 动态扫描 package 并断言等于根版本。release tag、provenance 与自动发布仍是另一层治理，不在此结论内。 |
| CLI fixture npm warning | 关闭目标 lane | 6 个 fixture 直接写 `package.json`，CLI unit/e2e 日志不再出现此前三类 npm unknown-config warning。安装/更新脚本使用 npm/pnpm 的其它警告属于不同路径。 |
| `pnpm audit --prod` | 关闭生产 advisory 无 gate | CI 已有独立 audit job，并在 reviewer 快照成功。它只覆盖生产依赖，不等于 dev dependency、SBOM、provenance 或供应链完整性已经闭环。 |
| smoke 扫描健壮性 | 关闭 | 过滤无 `package.json` 条目并有至少扫描一项的下界断言。 |
| dirty-base 测试格式耦合 | 关闭 | 测试通过 JSON parse/mutate/stringify 改 fixture，不再依赖输出空格格式。 |
| 权威文档 | 本报告后关闭本轮入口失真 | 原 `current.md` 仍指向第十二轮和旧 reviewer 快照；第十二轮又继续追加第 17/18 节，与自身“基线变化时新建报告”规则矛盾。本轮恢复新报告、旧报告只读。 |

## 4. 本轮 reviewer 直接修复

### 4.1 Session 右栏使用权威快照作为安全回退

#### 原问题

`SessionDetailPage` 同时拥有两类数据：

- `session.get`：当前 Session 的 `runId`、Session status、`needsAction/actionKind`；
- SSE Event：连续但明确为 best-effort 的 UI projection。

页面 header 已用 snapshot status 兜底，但 `SessionSidePanel` 只接受 `deriveSessionSidePanel(events)`。这形成了不一致：顶部可能已经显示终态或待审批，右栏仍可能处于空白或错误运行中状态。

具体风险：

1. `workflow/started` 事件缺失时，右栏拿不到 runId，控制与审批全部隐藏；
2. `approval/requested` 事件缺失时，不会读取 `gate.list`，即使 Session 已是 `awaiting-approval`；
3. `runStatus` 未知时，组件使用 `running` 作为默认值，产生 Pause/Cancel affordance；
4. Event 中的 pending decision id 被当成卡片存在依据，Event 过旧时可能与 Gate 当前状态不一致；
5. RunControls 的二次取消确认是本地状态，组件复用到另一 run 时可能残留。

#### 修复

- 新增 `mergeSessionSnapshotIntoSidePanel`；
- 明确映射 Session→RunControls 状态：

```text
active             → running
idle               → paused
awaiting-input      → blocked
awaiting-approval   → awaiting-approval
done               → passed
failed/cancelled    → 同名终态
未知                → null / fail-closed
```

- snapshot 仅在 live Event 没有对应事实时兜底；Event 一旦存在仍优先；
- `gate.list` 成为当前 pending decisions 的权威来源，Event/Session 只触发读取；
- 审批后失效 `session.detail`、`session.list`、gate 与 project overview；
- 未知状态传给 RunControls 为 `unknown`，不再虚构 `running`；
- RunControls 使用 `key={runId}`，run identity 变化时重置二次取消确认；
- 新增 `session-side-panel-snapshot.test.ts`，10 个测试覆盖 7 种状态、审批回退、live 优先与未知状态关闭。

#### 边界

这是迁移期安全修复，不是把 `session.get` 变成全新的执行事实源。领域 Workflow/Job 仍是旧执行事实，Session table 是当前 UI snapshot，Event 仍是 best-effort narrative projection。长期仍需 authoritative Session/outbox 决策。

### 4.2 DSH L2 live probe 必须精确匹配 tested pin

原测试在安装版本不等于 pin 时，只断言 `assertDshVersionAllowed()` 会拒绝，然后仍把 L2 probe 判为通过。它验证了生产 fail-closed，却没有验证发布环境真的安装了本次 tested version。

现在分层为：

- **L1 fixture**：根据官方源码交叉核对 version/help/config 解析；
- **L2 binary probe**：设置 `DSH_CLI_PATH` 后，真实二进制版本必须精确等于 pin，help/config 必须满足合同；无需 API key；
- **L3 provider smoke**：真实 API key、外部网络、模型 invocation、stderr/stdout、timeout/cancel、redaction 与 artifact 行为；仍未完成。

普通 CI 未设置 `DSH_CLI_PATH`，因此 L2 仍会跳过。绿色 CI 不能被描述为真实 DSH 兼容验证。

### 4.3 Production audit 保持 gate，但与功能测试解耦

用户实现已把 audit 拆成独立 job，却让 CLI/Web 同时依赖 `typecheck` 和 `audit`。当 audit 因 registry 故障或新 advisory 失败时，CLI、Web unit 和 Playwright 都会跳过。

现在：

- audit 是独立顶级 job，失败仍使整个 CI workflow 失败；
- CLI/Web 仅依赖 root build/typecheck，因此 audit 失败不会压掉应用诊断；
- audit install 使用 `--ignore-scripts`；
- audit 有 5 分钟上限；
- 当前快照的 production audit 成功。

### 4.4 CI 名称不再冒充真实 linter

此前 job 名是 `Root typecheck + lint`，但步骤只有 build 和 `pnpm -r typecheck`。各 package 的 `lint` 脚本本身也只是 `tsc --noEmit`，没有 ESLint、Biome 或 oxlint。

本轮把 job 改名为 `Root build + typecheck`。这没有增加 lint 覆盖，但消除了错误安全感。真实静态 lint 与 format gate应在独立代码卫生 PR 中评估。

## 5. 自动化证据

Reviewer 代码快照：`6917c06369d5cb0da5b681fc61d2bb25d600572d`。

- Core #362：`completed/success`；
- CI #271：`completed/success`；
- Root build + typecheck：成功；
- Audit production dependencies：成功；
- CLI build + unit + e2e：成功；
- Web build + typecheck + unit：成功；
- Web unit：36 文件、358 测试通过；新增 snapshot fallback 文件 10 项通过；
- Web Chromium Playwright：成功。

自动化证明当前覆盖合同没有被本轮修复击穿；不证明多进程 Git 冲突、真实 Provider、所有浏览器、屏幕阅读器、任意长会话或 crash/restart 故障矩阵。

## 6. 产品逻辑评审

### 6.1 Deliver 轨道仍是当前真实产品

当前默认 Web Composer 和 CLI `run` 的实际产品语义是：

```text
输入需求
→ 获取 canonical workflow plan 与 digest
→ 呈现角色链、Gate、网络和人工控制点
→ clean-base / network acknowledgement / plan approval
→ 启动 standard-delivery
→ 隔离 worktree 执行
→ Artifact / Gate / Audit / Review / Delivery
```

这一轨道的优点：

- 默认不是 Agent 自由规划所有副作用；
- workflow plan 与服务端执行摘要同源并校验 digest；
- 模板加载在验证到执行间使用同一对象，降低 TOCTOU；
- dirty base、网络不受限和远端动作有显式确认；
- Gate、Artifact、Audit、worktree 和 PR prepare 形成可审阅证据；
- UI 对计划失败和凭据缺失保持 fail-closed；
- 文案明确“启动受控交付”，没有把 one-shot workflow 伪装成持续聊天。

因此，**Deliver 可继续有人监督的实验性真实试用**。

### 6.2 Collaborate 仍没有形成产品闭环

普通用户仍不能在同一 Session 中完成：

```text
继续输入
→ Provider 执行中的真实更新
→ follow-up / steer
→ 当前 prompt cancel
→ 持久化会话关闭
→ Runtime 重启后 resume
→ 在同一上下文中升级为 Deliver
```

`LegacyAgentDriver.events()` 仍等待 one-shot adapter 完成后统一返回缓存事件；`followUp`、`steer` 和 `resume` 仍明确 `NotSupportedYet`。现有 cancel 链比早期更完整，但 adapter/SDK 和进程隔离边界仍不能支撑“持续协作运行时”承诺。

### 6.3 默认完整交付仍偏重

当前默认动作是 `standard-delivery` 全角色链。对正式交付合理，对“先讨论一下”“定位一个问题”“做小改动”偏重。产品通过诚实文案降低了误导，但没有提供真正轻量且可继续追问的 Collaborate 入口。

因此不建议再增加新的 Profile、Automation 类型或 Workflow DSL 来绕开问题；优先让最小 Collaborate vertical slice 成立。

## 7. UI 实现与 UX 评审

### 7.1 当前成立的 UI 能力

- 默认 Composer 提交前显示计划、角色链、Gate 与网络风险；
- 计划/digest 不可用时禁止执行；
- Session header、feed、right rail、inline approval 和 RunControls 已形成基本信息架构；
- EventFeed 默认展示叙事时间线，技术事件显式展开；
- 长文本、事件 DOM、历史分页、SSE replay 与 pending buffer 有基础上限；
- 截断会显示原因，不再静默丢失；
- 两步取消降低误触；
- 两个配置 dialog 已有 Esc、焦点循环、焦点归还和背景 inert；
- 本轮修复后，Event 延迟/缺失不再让右栏虚构 running 控制或隐藏 snapshot 已知的审批读取入口。

### 7.2 仍存在的 UX 缺口

1. **完整历史没有产品入口**  
   UI 可以分页并提示页面最多额外保留 2000 条，但没有“导出完整 Session”“生成审阅证据包”的直接动作。达到页面上限不代表到达历史起点。

2. **模型上下文预算没有对应产品语义**  
   DOM/SSE 有界只解决浏览器和连接资源，不等于 Provider prompt 已有 summary、compaction、token budget、fork 或可审计 retention。

3. **Token/Provider/Profile 仍暴露底层心智**  
   对开发者本地工具可以接受，对普通用户仍像部署控制台。长期应由 single-owner daemon/宿主应用接管身份和连接，不让默认任务入口要求理解 session token。

4. **审批回退暂无专门 loading 状态**  
   Session snapshot 可以触发 gate 查询，但 gate 数据到达前审批卡为空。没有错误控制，但弱网下可增加“正在读取审批上下文”的轻量提示。

5. **可访问性证据仍局部**  
   Chromium Playwright 与局部组件不能替代 Firefox/WebKit、屏幕阅读器、200% 缩放、对比度、reduced-motion 与动态 `role=log` 批量历史加载验收。

6. **没有真实视觉回归证据**  
   本轮没有部署实例或截图基准，不能确认所有页面在真实数据、窄屏和异常长文本下无布局问题。

## 8. Runtime 与整体架构评审

### 8.1 P0：repo 级 single-owner Runtime 仍未实现

CLI 和 Web 仍分别组装：

- SQLite connection / serialized write queue / repositories；
- Session store / Job store / Event bus；
- Subprocess registry / JobRunner / executor；
- Git/worktree；
- Provider；
- Automation / Delivery；
- shutdown 生命周期。

Job owner、lease 和 CAS 只能保护 job 记录，无法完整 fence：

- Git branch/worktree/promotion；
- 普通文件；
- Artifact/Gate/Audit；
- 外部 SDK 或远端副作用。

已接受 ADR 的方向仍正确：repo-scoped daemon + repo lock，CLI/Web 客户端化。

### 8.2 P0：Shutdown 仍不能证明 quiescent

JobRunner 已有：

- stop intake；
- settle window；
- abort；
- registered child kill；
- hard deadline；
- DB closed fence。

这些能降低迟到写入，但 hard deadline 后 process-local executor 仍可能继续 JavaScript、普通文件、Git 或外部 SDK。完整闭环需要 process/worker 隔离、真实 kill/join、generation fencing、checkpoint 和 crash/restart/late-write 故障注入。

### 8.3 P0：Session Event 仍是 best-effort projection

当前 dual-write 顺序仍是：

```text
原领域表/Audit 成功
→ best-effort append Session Event
→ 找不到 Session 或 append 失败时跳过/记录
```

本轮 UI snapshot fallback 正是对此现实边界的防御。它证明 fallback 有必要，也说明 Event 还不能承担：

- durable inbox；
- 权威模型历史；
- claim/processed/retry；
- crash replay；
- fork/resume；
- restart recovery。

后续必须明确：Session log 成为权威事实，或长期只做观察投影。不能继续让不同页面隐式猜测哪个更真。

### 8.4 P1：RunPlan 尚未成为 execute/resume 唯一权威输入

当前 canonical plan 已包含角色、阶段、Gate、Agent、Profile、超时和模板身份，并有 digest/snapshot。仍未完整绑定：

- Demand version/hash；
- mode（`RunPlanContext` 接受 mode，但 plan/digest 不包含）；
- base revision；
- workspace physical identity；
- resolved Provider config；
- 权限与网络确认事实；
- expected Artifacts；
- executable node plan。

由于 Goal 当前使用独立模板，mode 缺失暂未形成直接绕过，但说明“调用上下文”和“被摘要执行事实”仍非同构。

### 8.5 发布数字身份已统一，发布治理仍未统一

根与内部 package 已 lockstep 到 `0.20.4`，此前 CLI/root 与 Core package 版本不一致的问题关闭。但仍应明确：

- release tag 如何生成；
- package version bump 是否自动；
- migration/snapshot 与产品版本如何绑定；
- provenance、构建物和 installer/update channel 如何验证。

这些属于后续 release engineering，不应继续把“版本数字一致”写成完整发布治理完成。

## 9. 长 Session、资源预算与历史

### 9.1 在线观察已经取得的实质进展

- `beforeSeq` / `nextBeforeSeq` 真正向历史起点推进；
- reconnect replay 有事件数与字节预算；
- Session pending event/byte cap；
- workspace pending frame/byte cap；
- heartbeat 尊重 `write(false)`；
- 客户端事件窗口与历史保留上限；
- 超预算有可见提示。

### 9.2 仍未闭环

- complete-history export；
- server-side snapshot/flush boundary；
- Session root/subsession/attachment/artifact manifest；
- model summary/compaction；
- UI、导出与 model context 的统一 retention policy；
- 大规模长期运行、慢客户端、代理缓冲和跨进程故障矩阵；
- 资源指标、容量基准与告警。

DeepSeek Harness 官方 `session-log-export` 的边界值得复用：HEAD/preflight、服务端流式生成、浏览器直接下载、实时 Session 先 flush、同一 Session 只允许一个 export、输出包含 manifest、root/subsession 与 attachments。Tekon 不需要复制其存储格式，但应复用一致性和资源原则。

## 10. DeepSeek Harness 对齐结论

### 10.1 alpha.3 升级的准确表述

官方 `dsh-v0.1.2-alpha.3` 与 master 均指向 `dd6322d...`。相较 alpha.2：

- Headless README 相同；
- Headless `src/index.ts` 相同；
- Headless package 主要是版本号变化；
- 根 Node engines 仍是 `^22.19.0 || >=24.0.0`；
- JSONL Session persistence 仍存在，并成为官方保留方向；
- 整个上游 release 仍包含 Session、queued follow-up/image、导航/内存/UI 等更广变化。

所以应写：

> Tekon 依赖的 alpha.3 headless 兼容锚点相对 alpha.2 未变，升级风险低。

不应写：

> alpha.3 整个 DeepSeek Harness 合同零差异。

### 10.2 dsh-headless 继续 Goal-only 是正确的

官方 Headless 仍是一次 invocation 处理一个 task，最终 assistant answer 写 stdout，reasoning 写 stderr，完成后退出，不提供 interactive follow-up。它适合脚本、CI、one-shot Goal，不适合伪装持续 Session。

### 10.3 Collaborate 应优先做 ACP vertical slice

官方 ACP 已提供：

- persistent session new/list/resume/close；
- prompt/cancel；
- semantic execution updates；
- permission request；
- per-session ownership；
- quiescent close；
- persistence flush 与进程重启后的 resume。

Tekon 下一阶段应先验证：

```text
owned ACP subprocess
→ session/new
→ one prompt
→ execution-time updates
→ prompt cancel
→ quiescent close
→ process restart + session/resume
```

切片成立后再映射 Tekon Session、RunPlan、permission、Artifact 和 Collaborate→Deliver。

### 10.4 Harness 不能成为唯一安全边界

官方 Safety 仍明确：项目是未经安全审计的 developer preview，不适合生产；sandbox、approval 和 permission controls 只能降低风险，不保证隔离。

Tekon 必须继续保留 least privilege、host-side network policy、credential minimization、OS/container/VM 隔离选项、审计证据与人工 gate。

### 10.5 真实 Provider smoke 仍缺

L1 fixture 与可选 L2 metadata probe 都不执行模型。仍需要隔离环境中的 L3：

- 真实 `dsh@0.1.2-alpha.3`；
- 兼容 Node；
- API key 与外部网络；
- one-shot success/failure；
- stdout/stderr 边界；
- timeout/cancel；
- artifact/no-artifact；
- credential redaction；
- host-side isolation。

## 11. 代码实现评审

### 11.1 正向判断

- TypeScript domain/API/UI 分层总体清晰；
- workflow plan digest 与同对象执行降低预览/执行漂移；
- write authorization、redaction、scope/path 校验和人工审批有广泛测试；
- SSE backpressure、分页与 replay 比早期实现明显扎实；
- JobRunner 有 ownership loss、heartbeat、pause/cancel 与 shutdown 基础；
- DSH probe 基于公开 help/config/version 锚点，不绑定私有路径；
- L1/L2/L3 证据层级在本轮后更诚实；
- UI 对未实现 Collaborate 保持禁用；
- 本轮 snapshot fallback 把“best-effort projection”的架构边界落实成 fail-closed UI 行为。

### 11.2 仍需改进的代码治理

1. **没有真实 static linter gate**  
   `lint` 等价于 TypeScript typecheck。后续评估 oxlint/ESLint/Biome，并只对新增/变更代码先建立不扩大欠账的 gate。

2. **format debt 仍大**  
   全仓 format check 仍有大量历史不合规文件。不要在本 PR 一次性格式化；独立提交并设置增量 gate。

3. **Session status 与 Workflow status 双词汇容易漂移**  
   本轮显式映射并测试是必要的迁移措施，长期最好由共享 domain projection 或服务端 API 返回可操作状态，避免每个 UI surface 重复映射。

4. **fixture helper 重复**  
   CLI 多个测试仍有相似 `createFixtureRepo`。可后续抽 shared helper，但必须保留各 fixture 的 repo-profile 差异，不能为去重改变测试语义。

5. **生产依赖 audit 不是完整供应链验证**  
   仍缺 dev/build tool advisory 策略、lockfile review、dependency review、SBOM、provenance 与构建物签名。

6. **大文件与超大 PR 降低局部正确性可见性**  
   PR 已接近百个提交、约 180 个变更文件。组合回归更依赖自动化，人工逐行审查、二分和回滚成本显著上升。

## 12. 是否存在过度实现或过度设计

当前横向机制包括：

```text
AgentAdapter / AgentDriver / LegacyAgentDriver
Provider Registry / DSH bridge
Workflow / Role / Gate / Artifact / Audit
JobRunner / Session projection / SSE
Profile / Automation / Goal / Readiness / Delivery
CLI / Web 两套 composition root
大量阶段计划、ADR、复审和整改文档
```

这些部件多数有局部理由，但仍领先于最小纵向用户闭环：

```text
同一 Session 继续输入
→ Provider 真实执行更新
→ cancel / follow-up / steer
→ restart resume
→ Collaborate 升级 Deliver
```

因此主要过度风险不是某个 interface，而是：

- 横向能力数量持续增长；
- 评审与整改过程持续增长；
- 核心用户闭环尚未成立；
- 两套 Runtime composition root 继续放大状态同步和所有权问题。

冻结原则继续成立：除非直接服务 single-owner、executor isolation、authoritative Session、真实 Provider stream、follow-up/cancel/resume、Collaborate→Deliver、RunPlan authority 或历史/模型预算，否则暂停增加新的 Profile、Automation job、Driver wrapper、展示事件和 Workflow 语法。

## 13. 问题清单

| ID | 严重度 | 状态 | 问题 |
| --- | --- | --- | --- |
| P0-ARCH-01 | P0 | 未关闭 | CLI/Web 缺 repo 级 single-owner Runtime authority。 |
| P0-ARCH-02 | P0 | 部分完成 | abort/kill/hard deadline/DB fence 不能证明 executor、Git、普通文件和 SDK 已 quiescent。 |
| P0-DATA-01 | P0 | 未关闭 | Session Event 是 best-effort projection，不是 durable inbox/权威模型历史。 |
| P0-PRODUCT-01 | P0 | 未关闭 | 真实 streaming、follow-up、steer、prompt cancel、restart resume 与 Collaborate→Deliver 未闭环。 |
| P1-PLAN-01 | P1 | 部分完成 | RunPlan 尚未成为 execute/resume 唯一事实；mode、Demand、base/workspace、Provider、权限和 Artifacts 未完整绑定。 |
| P1-SESSION-01 | P1 | 部分完成 | 在线历史有边界；完整导出、compaction、retention、规模和故障矩阵仍缺。 |
| P1-DSH-01 | P1 | 部分完成 | alpha.3 L1 合同成立，L2/L3 真实二进制和带凭据 smoke 未执行。 |
| P1-GOV-01 | P1 | 未关闭 | `main` 未保护，required status checks enforcement 关闭。 |
| P1-A11Y-01 | P1 | 未关闭 | 只有 Chromium 与局部组件证据，缺全站辅助技术/多浏览器验收。 |
| P1-PROCESS-01 | P1 | 未关闭 | PR 体量过大，审阅、二分与回滚风险高。 |
| P2-UX-01 | P2 | 本轮修复 | Session 右栏过度依赖 best-effort Event，可能隐藏审批或展示错误控制。 |
| P2-DSH-01 | P2 | 本轮修复 | L2 live probe 在版本漂移时可假通过。 |
| P2-CI-01 | P2 | 本轮修复 | audit 失败会压掉 CLI/Web 功能诊断；audit lane 还会执行 lifecycle scripts。 |
| P2-CI-02 | P2 | 本轮修复 | `Root typecheck + lint` 名称与实际执行不符。 |
| P2-RELEASE-01 | P2 | 已关闭数字漂移 | 根与内部 package 已 lockstep；完整发布治理仍是后续项。 |
| P2-DOC-01 | P2 | 本报告关闭权威入口 | 第十二轮继续追加 revision、current 绑定旧快照；现转为第十三轮。 |
| P2-DOC-02 | P2 | 待清理 | v0.20.4 CHANGELOG 仍保留“整个 headless 合同零差异”和 `needs: [typecheck, audit]` 的整改时点表述；不作为当前权威事实。 |
| P2-CODE-01 | P2 | 未关闭 | JS/TS `lint` 只是 typecheck，缺真实 static lint gate。 |
| P2-CODE-02 | P2 | 未关闭 | Session/Workflow status 双词汇需长期统一投影，避免 UI 重复映射。 |

## 14. 建议实施顺序

1. **仓库 ruleset**：要求 PR、Core 与 CI 成功；这是 Owner 设置项。
2. **single-owner daemon + repo lock**：统一 DB、Job、Git、worktree、Provider、Automation、Delivery 与 shutdown 所有权。
3. **executor process/worker 隔离**：kill/join、checkpoint、generation fencing、restart/fault injection。
4. **authoritative Session log / transactional outbox + durable inbox**：明确事实源与迁移。
5. **DeepSeek ACP real-provider vertical slice**：persistent session、真实 update、prompt cancel、quiescent close、restart resume。
6. **Collaborate→Deliver**：同一 Session follow-up/steer、计划升级、人工控制点。
7. **RunPlan authority**：绑定 Demand、mode、base/workspace、Provider、权限、网络、Artifacts 和 executable plan。
8. **完整历史导出 + 模型预算**：server-streamed export、flush/snapshot、manifest、compaction 与 retention。
9. **a11y、多浏览器、static lint、format 与 release engineering**：分别独立 PR 收敛。

## 15. 合并与发布边界

当前代码快照通过说明：

- v0.20.4 用户整改没有击穿现有 Core/CLI/Web 主合同；
- 本轮 Session fallback、gate authority、RunControls fail-closed 和 query invalidation 可构建并通过测试；
- 新增 10 个 snapshot fallback 测试通过；
- production audit 成功；
- CLI unit/e2e、Web unit/build 和 Chromium Playwright 成功。

它不能证明：

- CLI/Web 两个 Runtime 并发无副作用冲突；
- shutdown 后所有 executor/文件/Git/SDK 已终止；
- Event 可完整重建模型上下文；
- 真实 DSH 二进制和 API invocation 已验证；
- 任意规模长 Session 有稳定资源预算；
- Firefox/WebKit、屏幕阅读器和真实弱网设备已通过；
- 普通用户持续协作产品已经完成。

当前 `main` 未启用 required checks，因此“代码合并门通过”仍是评审和人工流程结论，不是仓库规则强制结论。PR Head 若继续变化，必须重新绑定自动化终态。

建议 squash merge。本轮未执行 merge、release、deploy 或 branch-protection/ruleset 修改。

## 16. 参考资料

### Tekon

- [当前权威入口](current.md)
- [Runtime authority / Collaborate ADR](../technical/adr-0001-runtime-authority-and-collaborate.md)
- [`SessionComposer`](../../packages/web/src/client/components/sessions/SessionComposer.tsx)
- [`SessionDetailPage`](../../packages/web/src/client/pages/SessionDetailPage.tsx)
- [`SessionSidePanel`](../../packages/web/src/client/components/sessions/SessionSidePanel.tsx)
- [`session-side-panel` projection](../../packages/web/src/client/lib/session-side-panel.ts)
- [`EventFeed`](../../packages/web/src/client/components/sessions/EventFeed.tsx)
- [`RunControls`](../../packages/web/src/client/components/runs/RunControls.tsx)
- [`session.get/events`](../../packages/web/src/server/api/routers/session.ts)
- [`project.run`](../../packages/web/src/server/api/routers/project.ts)
- [`LegacyAgentDriver`](../../packages/core/src/runtime/legacy-agent-driver.ts)
- [`Session dual-write`](../../packages/core/src/session/dual-write.ts)
- [`JobRunner`](../../packages/core/src/session/job-runner.ts)
- [`RunPlan`](../../packages/core/src/workflow/run-plan.ts)
- [`DSH bridge contract`](../../packages/core/__tests__/runtime/dsh-bridge-contract.test.ts)
- [Full-stack CI](../../.github/workflows/ci.yml)
- [第十三轮整改方案](../superpowers/plans/2026-09-01-thirteenth-review-remediation-plan.md)

### DeepSeek Harness 官方

- [alpha.3 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.3)
- [Headless](https://github.com/deepseek-ai/deepseek-harness/blob/dd6322d604e00eec1ba5e0c8541159906a21094a/packages/bundle/headless/README.md)
- [Headless entry](https://github.com/deepseek-ai/deepseek-harness/blob/dd6322d604e00eec1ba5e0c8541159906a21094a/packages/bundle/headless/src/index.ts)
- [ACP](https://github.com/deepseek-ai/deepseek-harness/blob/dd6322d604e00eec1ba5e0c8541159906a21094a/packages/acp/acp/README.md)
- [Safety](https://github.com/deepseek-ai/deepseek-harness/blob/dd6322d604e00eec1ba5e0c8541159906a21094a/SAFETY.md)
- [Session log export](https://github.com/deepseek-ai/deepseek-harness/blob/dd6322d604e00eec1ba5e0c8541159906a21094a/packages/session-query/session-log-export/README.md)
- [Session package / JSONL persistence](https://github.com/deepseek-ai/deepseek-harness/blob/dd6322d604e00eec1ba5e0c8541159906a21094a/packages/session/README.md)
