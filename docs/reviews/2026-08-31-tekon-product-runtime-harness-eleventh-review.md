# Tekon 产品、UI/UX、Runtime 与 DeepSeek Harness 第十一轮全面复审

- **日期**：2026-08-31
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **上一轮权威快照**：`f9f373351d252ff2c9590941644c01234b15d70e`
- **用户 v0.20.1 / v0.20.2 整改快照**：`2752a0b5e99d5a860dd21a46debae3bb1d901164`
- **本轮 reviewer 代码快照**：`4bf88401e7c4ed1e881ff7ebd94b53028dbbf0eb`
- **产品版本**：`0.20.2`
- **Tekon DSH tested pin**：`0.1.2-alpha.2`
- **DeepSeek Harness 官方基线**：master `0a53fb55bea101816fa226bb964ae2bed71c343b`，最新发布 `dsh-v0.1.2-alpha.2`
- **代码自动化状态**：`4bf8840...` 的 Core #342 与 CI #251 均为 `completed/success`；Root、CLI unit/e2e、Web build/typecheck/unit、Chromium Playwright 全部成功
- **裁决**：v0.20.1/v0.20.2 整改与本轮 reviewer 修复通过代码合并门；Tekon 整体仍未通过“面向普通人的稳定持续协作研发工作台”产品验收

## 1. 执行摘要

v0.20.1 和 v0.20.2 延续了上一轮“局部收敛、架构主线冻结”的正确策略，实际完成了以下改进：

1. workspace summary SSE 增加慢客户端事件数/字节双上限；
2. DSH Node 前置条件进入 CLI 与手册；
3. CLI fake-dsh fixture 统一，生产 parser 删除 bare-line 兼容 seam；
4. DSH tested pin 升至当前官方 `0.1.2-alpha.2`；
5. Core e2e 文件选择规则补齐被漏跑用例；
6. react-router 更新，现有 Web build/unit/Chromium e2e 未出现回归；
7. 一处历史 HTML 标签错误得到修复。

这些整改方向成立，但全仓复核仍发现四类真实运行时/合同问题和两类文档可信度问题：

- **Session SSE 的分页追赶与 socket 背压组合会重复读取同一游标区间**。当 `response.write()` 返回 `false`、当前数据库页仍有 `hasMore=true` 时，cursor 要等 `drain()` 才能继续推进，而 catch-up 循环却会立即再次从旧 cursor 查询同一页。重连路径会重复计入同一批事件并误触发 replay truncation；fresh-connect 路径不受 reconnect budget 保护，存在持续自旋风险。
- **Session 与 workspace 两条 SSE 的 heartbeat 都忽略 `write(false)`**。心跳本身也可能让 socket 进入背压；若不记录该状态，随后业务帧会继续写入，绕过已实现的 pending cap 状态机。
- **DSH `installHint` 把可执行命令和本地化 Node 说明拼在同一字符串中**。文本展示尚可，但 `--json` 与自动化消费者拿到的已不是可直接执行的命令，破坏机器可读语义。
- **DSH help/config 合同失败时会丢失已经成功探测到的版本**。CLI 因此可能把“已安装但合同不兼容”显示成“未安装或不可执行”，诊断方向错误。
- **`docs/reviews/current.md` 已失去权威一致性**：版本写到 v0.20.2，但仍绑定 v0.20.0 的 reviewer 快照和旧 CI；同一文件同时写“DSH 已追平 alpha.2”与“仍落后一个 prerelease”，同时写“workspace SSE 已修”与“仍未闭环”。
- **上游差异描述过度压缩**：alpha.1 到 alpha.2 的官方 compare 是 234 个提交；Tekon 所依赖的 help anchor、required config row ids 和 Node engines 没有变化，可以说“相关兼容锚点稳定”，不能把整个 upstream release 表述为“零差异”或只含很少提交。

本轮已直接修复前四类代码问题并补组合路径回归测试；新报告和稳定入口纠正文档状态。single-owner daemon、权威 Session 事实源、ACP vertical slice 等架构项仍保持独立推进，不在这个已经非常庞大的 PR 中伪装关闭。

## 2. 最终判断

### 2.1 当前代码增量

`4bf88401e7c4ed1e881ff7ebd94b53028dbbf0eb`：

- Core #342：`completed/success`；
- CI #251：`completed/success`；
- Root build/typecheck 与 installer syntax 成功；
- CLI build、unit、e2e 成功；
- Web typecheck、build、unit 成功；
- Chromium Playwright 成功。

因此，**v0.20.1/v0.20.2 用户整改与本轮 reviewer 低风险修复通过当前代码合并门**。

### 2.2 产品成熟度

当前允许的成熟度表述是：

> Tekon v0.20.2 已形成测试覆盖较强、执行计划与风险边界较透明、长会话在线观察具有基础资源上限的实验性受控交付执行与观察基础设施；Deliver 轨道可在有人监督下试用，但持续协作、单一 Runtime 权威、权威 Session 事实链、可证明的 shutdown/restart、完整历史导出和模型上下文预算尚未闭环。

仍不应描述为：

- 面向普通用户的稳定持续协作研发工作台；
- Web/CLI 多进程并发安全的 repo Runtime；
- 拥有 crash-safe durable inbox 和完整模型历史恢复的 Session 平台；
- 已完成任意规模长会话、生产级 shutdown 与 restart resume 的服务；
- 已通过真实 DSH API smoke 或可将 DeepSeek Harness sandbox 作为唯一安全边界的系统。

## 3. 评审范围与方法

本轮覆盖：

- v0.20.1/v0.20.2 相对上一轮权威快照的全部 25 个变更文件；
- 根 README、CHANGELOG、产品版本、Node 合同、安装与用户手册；
- Core 的 AgentDriver、RunPlan、Session dual-write、JobRunner、DSH bridge 与测试入口；
- Web 的 Session/Workspace SSE、Session Composer、EventFeed、连接恢复与浏览器测试；
- CLI 的 provider preflight 文本/JSON 合同和 fake-dsh fixture；
- `docs/reviews/current.md`、第十轮报告及追加批注；
- PR 当前 GitHub Actions 终态；
- DeepSeek Harness alpha.2 的 Safety、Headless、ACP、版本、Node engines 和默认组合配置。

判断原则：

1. “已关闭”必须同时检查正常路径、失败路径和组合路径；
2. `response.write(false)` 是状态转换，不只是一个可忽略返回值；
3. 文本 CLI 与 JSON/自动化合同必须分开设计；
4. tested pin、兼容锚点稳定和真实 Provider 验证是三个不同层级；
5. 测试绿色只能证明其覆盖合同，不自动证明未覆盖的跨进程、真实 Provider、多浏览器或故障注入路径；
6. 架构级缺口不通过新增 wrapper、fixture 或报告措辞制造关闭假象。

本轮没有可访问的独立部署实例，因此 UI/UX 结论来自代码结构、响应式/ARIA 实现和现有 Chromium Playwright 流程；不声称完成新的像素级评审、Firefox/WebKit、屏幕阅读器或真实弱网设备测试。

## 4. 对 v0.20.1 / v0.20.2 整改的逐项裁决

| 整改项 | 裁决 | 理由与边界 |
| --- | --- | --- |
| workspace summary SSE pending cap | 基本关闭 | 已检查 `write(false)`、有事件数/字节双上限、超限关闭后客户端自动重连；本轮又补 heartbeat 背压。它仍是摘要通知，不提供逐帧持久 replay。 |
| DSH Node 前置说明 | 本轮修复后基本关闭 | Node 要求现在是独立结构化字段；安装命令保持可复制执行。preflight 仍以真实 dsh 命令能否执行作为最终兼容信号，不改变 Tekon 主 Node 合同。 |
| fake-dsh fixture 统一 | 基本关闭 | CLI unit/e2e 共用 helper，生产 parser 不再接受裸 id 行；Core/Web 仍保留各自领域 fixture，但均使用真实 YAML row 语义。 |
| DSH alpha.2 pin | 版本断层已关闭 | tested pin 与 upstream latest 一致，相关 help/config/Node 锚点稳定；仍缺有真实 dsh 二进制、API key 和外部网络的 Provider smoke。 |
| Core e2e 文件选择 | 关闭 | 新规则补跑 `engine-rework.e2e.test.ts`，并保留命名反例；Core #342 成功。 |
| react-router 更新 | 当前回归门通过 | Web build/unit/Chromium e2e 成功；不能由单一 Chromium lane推导 Firefox/WebKit 或所有安全部署形态已验证。 |
| HTML 标签修复 | 关闭 | 目标文件 parse error 已修；全仓 format backlog 仍是独立过程问题。 |
| Session SSE 全链路 | 部分完成 | cursor、replay/pending cap、组合背压缺陷已修；完整导出、模型 compaction、真实规模和跨进程故障矩阵仍缺。 |

## 5. 本轮 reviewer 直接修复

### 5.1 修复分页 catch-up × 背压的重复读取和自旋

原状态：

```text
DB 返回 page(cursor=0, events=1..500, hasMore=true)
→ 写 seq=1 时 response.write() = false
→ cursor 只推进到 1，pending 保存 2..500
→ catch-up 循环仍看到 hasMore=true
→ 立即再次从 cursor=1 读取 2..501
→ 同一批事件重复读取 / 重复计入 reconnect budget
```

影响：

- reconnect 时，同一事件可被重复计数并错误触发 `replay-truncated`；
- fresh connect 没有 reconnect budget，若 socket 一直不 drain，循环可以持续读取重叠页；
- SQLite 与 CPU 开销与真实新增事件量脱钩；
- 现有“单页 write(false) 后 drain”测试无法覆盖该组合。

修复：

- catch-up 在进入或处于背压状态时不再读取数据库页；
- 当前页触发背压后立即退出分页循环；
- `drain()` 推进 pending 连续前缀后，下一次定时 catch-up 从新 cursor 继续；
- reconnect budget 只有在真实追平尾部或显式截断后关闭；
- 新增 1200 事件、500 条分页、首帧背压的组合测试，证明不会重复查询同一页或误截断，并在 drain 后完整追平。

### 5.2 将 heartbeat 纳入两条 SSE 的背压状态机

原状态：

```text
heartbeat response.write(': ping') = false
→ 返回值被忽略
→ isBackpressured 仍为 false
→ 后续 Session/Workspace 业务帧继续写
```

修复：

- Session heartbeat 与 workspace heartbeat 都检查 `write()` 返回值；
- `false` 时进入与业务帧相同的背压状态并注册一次 drain；
- Session 事件进入 seq pending Map；workspace summary 进入有界 frame queue；
- 新增两条回归测试，证明 heartbeat 阻塞期间业务帧不继续写，drain 后恢复。

### 5.3 恢复 DSH preflight 的机器可读合同

原状态：

```json
{
  "installHint": "npm install -g @deepseek-ai/dsh@0.1.2-alpha.2（注意：DSH 要求 Node ...）"
}
```

这不是可直接执行的命令，自动化消费者必须解析中文标点和说明文本。

修复后：

```json
{
  "nodeRequirement": "^22.19.0 || >=24.0.0",
  "installHint": "npm install -g @deepseek-ai/dsh@0.1.2-alpha.2"
}
```

文本 CLI 单独展示“DSH Node 要求”和“安装指引”；JSON 使用结构化字段。Core、CLI unit 和 CLI built e2e 均锁定该合同。

### 5.4 保留已检测到的 DSH actual version

版本探测成功、help/config 合同失败时，CLI 现在保留 `actualVersion`，不再显示成“未安装或不可执行”。这能区分：

- 二进制不存在/无法启动；
- 版本不匹配；
- 版本匹配但能力组合漂移。

### 5.5 重建权威文档入口

本轮新增独立第十一轮报告，不再继续向第十轮文件追加第 18、19 节。`current.md` 重新绑定：

- v0.20.2；
- 用户整改 head；
- reviewer 代码快照；
- 当前 Core/CI；
- DSH tested pin/latest；
- 当前已关闭、部分关闭和未关闭事项。

## 6. 产品逻辑评审

### 6.1 当前真正成立的产品价值

Tekon 当前最强的价值不是“AI 聊天”，而是受控交付：

```text
需求输入
→ 服务端执行计划预览与 digest
→ 固定 workflow / 角色链
→ 隔离 worktree
→ gate / artifact / audit
→ 人工审批
→ PR 准备与远端副作用控制
```

这个定位已经在 README、默认 Composer 和高级入口中相对诚实：默认入口明确说明会启动 `standard-delivery` 全链路；计划无法读取或 digest 缺失时 fail-closed；dsh-headless 的联网不受限、Goal-only 和 experimental 边界可见。

### 6.2 仍未形成的持续协作产品

普通用户仍不能在同一个 Session 中完成：

```text
继续输入
→ 观察真实 execution-time Provider 更新
→ follow-up / steer
→ prompt cancel
→ 刷新或 Runtime 重启后恢复
→ 从 Collaborate 显式升级为 Deliver
```

`SessionComposer` 当前只负责新建完整交付 run；`LegacyAgentDriver.events()` 要等待 one-shot adapter 完成后才遍历缓存；`followUp`、`steer` 与 `resume` 仍抛 `NotSupportedYet`。因此 Session 页面本质上是运行观察与治理面，不是多轮协作工作台。

### 6.3 产品边界中的主要摩擦

- 默认路径仍要求用户理解 Token/连接凭据；
- Session、Run、Profile、Gate、Artifact 等内部概念进入普通路径；
- 历史截断现在可见，但缺少“一键导出完整历史/进入离线审阅”的行动入口；
- `MAX_EARLIER=2000` 是页面内存保留策略，不是持久历史删除或模型上下文策略；
- failed/approval/input 状态已可行动，但跨进程重启恢复与 durable user inbox 仍不存在。

## 7. UI 实现与 UX 交互

### 7.1 正面评价

- 默认 Composer 使用明确的“启动受控交付”而非伪装成发送聊天消息；
- 执行前展示角色链、控制点、人工审批数量和网络边界；
- plan 错误、缺 digest 和缺 token 均阻止提交；
- Session feed 默认隐藏技术噪音，同时允许显式展开；
- 长文本、DOM 窗口、历史反向分页和截断提示已有基础资源/认知边界；
- Session/Workspace 两条流均有重连；
- 两个配置详情 dialog 已有名称、focus trap、Escape、焦点恢复和背景 inert。

### 7.2 仍需改进

1. **历史边界缺少下一步动作**  
   用户知道“已切换到最近记录”或“本页历史上限”，但不能直接导出、下载或打开完整离线审阅。

2. **连接状态仍偏工程化**  
   Token 管理、Provider 预检和具体 Node range 对工程师合理，但普通用户需要更高层的“可用/需要升级 Node/需要认证/配置漂移”诊断卡片。

3. **摘要与真实模型文本的区分依赖标签**  
   当前大部分 `assistant/message` 仍是 artifact 元数据合成摘要。虽然 UI 标“摘要”，但产品主路径仍缺真实增量回答。

4. **可访问性覆盖不能外推**  
   现有 dialog 与 Chromium 测试有效，但全站动态更新、approval card、drawer、对比度、缩放、屏幕阅读器以及 Firefox/WebKit 未专项验收。

## 8. 整体框架与 Runtime 架构

### 8.1 P0：repo 级 single-owner Runtime 仍缺失

CLI 与 Web 仍分别创建并持有 SQLite connection、WriteQueue、JobRunner、SubprocessRegistry、Workflow executor、Provider 和 shutdown 生命周期。Job owner/lease/CAS 能 fence job row，不能完整 fence：

- Git/worktree 创建与 promotion；
- Artifact、Gate、Audit；
- Delivery/Automation；
- 普通文件写；
- process-local Provider/SDK/subprocess。

长期方向仍应是：

```text
repo-scoped daemon/service
→ repo lock
→ CLI/Web 客户端化
→ 统一 Job、Git、DB、Provider、Automation、Delivery 与 shutdown 所有权
```

### 8.2 P0：shutdown 仍不是可证明的 quiescent shutdown

`JobRunner.stop()` 已有 settle window、abort、registry kill、hard deadline 和 DB closed fence，这比固定等待明显更安全。但 hard deadline 到达后仍会返回并清空 process-local tracking；不合作 executor 仍可能继续：

- 执行 JavaScript；
- 写普通文件；
- 操作 Git；
- 持有未登记子进程；
- 在外部 SDK 内工作。

完整闭环需要 executor worker/process 隔离、真实 kill/join、checkpoint、generation fencing 和 restart fault-injection。

### 8.3 P0：Session Event 仍是观察投影

`dual-write` 的顺序仍是旧仓储/Audit 成功后 best-effort 追加 Session Event；找不到 Session、append 失败或事件不在映射表时都可能缺失。因此它不能独立承担：

- 权威模型历史；
- durable inbox；
- prompt claim/processed；
- crash replay；
- fork/resume；
- restart recovery。

ADR 对它的“观察投影”定性仍正确。下一步必须选择 authoritative log + transactional outbox，或长期承认领域表权威、Session 只负责展示，不能同时宣称两者。

### 8.4 P1：RunPlan 仍是审计快照，不是执行权威

当前 `RunPlan` 包含角色链、Gate、阶段、Agent、Profile、超时和 template identity，但仍未完整绑定：

- Demand version/hash；
- base revision；
- workspace physical identity；
- 网络确认事实；
- resolved Provider config；
- expected artifacts；
- executable node plan。

execute/resume 也未完全从 canonical RunPlan 重建并验证全部运行条件。

### 8.5 P1：长 Session 只关闭了在线观察的直接资源缺陷

已完成：

- backward cursor / continuation；
- Session replay budget；
- Session pending event/byte cap；
- workspace pending frame/byte cap；
- heartbeat backpressure；
- 页面窗口与截断提示。

仍缺：

- complete-history export；
- 模型 context summary/compaction；
- Session 历史与模型 prompt retention 的统一政策；
- 真实高密度、长时连接和跨进程故障基准；
- 资源预算指标、报警与运营可见性。

## 9. DeepSeek Harness 最新对齐

### 9.1 版本与合同

Tekon tested pin 与 upstream latest 现均为 `0.1.2-alpha.2`，版本断层已关闭。独立核对结果：

- `dsh --profile headless --help` 依赖的 final-assistant anchor 未变；
- required config row ids 未变；
- Node engines 仍为 `^22.19.0 || >=24.0.0`；
- alpha.1 → alpha.2 的整个仓库 compare 是 234 个提交。

因此准确表述应是“Tekon 使用的兼容锚点稳定”，而不是“整个 release 零差异”。

### 9.2 Headless 继续保持 Goal-only

官方 headless 仍明确：

- 一次 invocation 一个 task；
- 最终回答后退出；
- 无 interactive follow-up；
- reasoning 进入 stderr；
- 首 token 前无 heartbeat。

继续把它限制在 Goal/无产物 one-shot 是正确方向，不应扩展来模拟 Collaborate。

### 9.3 ACP 更匹配下一阶段纵向切片

官方 ACP 当前提供：

- persistent session；
- list/resume/close；
- prompt/cancel；
- semantic execution updates；
- permissions；
- quiescent close；
- 跨进程持久恢复。

建议下一步独立验证：

```text
persistent session
→ one prompt
→ execution-time updates
→ prompt cancel
→ close
→ process restart + resume
```

在该 vertical slice 成立前，不继续扩展 one-shot `LegacyAgentDriver` 或增加新的 Driver wrapper。

### 9.4 安全边界

DeepSeek Harness 官方仍明确是未经安全审计的 developer preview。sandbox、approval 和 permission controls 能降低风险，但不保证隔离，也不能作为不可信 workload 的唯一安全控制。Tekon 必须继续依赖：

- 最小权限；
- disposable container/VM；
- credential scrub；
- workspace scope；
- 人工远端副作用 gate；
- 备份与审计。

## 10. 代码实现与测试质量

### 10.1 正面评价

- DSH preflight 使用完整 YAML row id，避免 package-name 假阳性；
- fake-dsh fixture 开始收敛为共享 helper；
- CLI 文本和 JSON 合同现在分离；
- CommandGateway 使用 argv，不依赖 shell 拼接；
- Session/Workspace SSE 均有有界 pending；
- cursor、reconnect、backpressure、heartbeat 和控制帧均有自动化；
- 当前同一代码快照的 Core、Root、CLI、Web unit 与 Playwright 全绿。

### 10.2 本轮暴露的测试盲点

原测试分别覆盖：

- 分页 catch-up；
- reconnect budget；
- 单页 write(false) + drain；
- pending overflow；
- workspace pending cap。

但没有覆盖：

```text
分页 hasMore
× 首帧 write(false)
× cursor 由 drain 推进
× reconnect/fresh-connect 两种预算语义
```

这说明高覆盖率仍需状态机组合测试，而不是只按单一功能点增加用例。本轮新增的独立 regression 文件把这类组合路径集中起来。

### 10.3 SSE 实现复杂度继续上升

`packages/web/src/server/sse.ts` 同时承担：

- Session replay/cursor；
- contiguous pending；
- reconnect budget；
- backpressure truncation；
- heartbeat；
- cross-process polling；
- workspace summary queue。

目前不建议在本 PR 中再抽象，因为语义刚稳定且错误主要来自状态组合。后续可在独立 PR 中先冻结状态机测试，再提取通用 backpressure writer；不要先抽象、后补语义。

### 10.4 CI 噪音与测试 lane 语义

CLI CI 中持续出现 npm 对 `verify-deps-before-run`、`recursive`、`_jsr-registry` 等未知 env config 的未来弃用警告。它当前不阻断，但会降低真实错误信噪比，并可能在下一 npm major 变成行为变化。

另外，`packages/cli/__tests__/e2e/provider-preflight.test.ts` 因文件名不是 `*.e2e.test.ts`，实际会进入 CLI unit lane；目录语义与选择规则不一致。它仍提供有效覆盖，但后续应统一命名/分区，避免“e2e 目录中的用例由 unit gate 执行”的隐性合同。

## 11. 是否存在过度实现或过度设计

当前横向能力已经包括：

- AgentAdapter / AgentDriver / LegacyAgentDriver；
- Provider registry；
- JobRunner；
- Session dual-write/projection；
- Profile；
- Automation；
- Goal；
- Readiness；
- Delivery；
- CLI/Web 两套 composition root；
- 多轮 remediation plan、批注和评审报告。

这些机制多数有局部价值，但仍领先于最小持续协作纵向闭环：

```text
同一 Session 继续输入
→ Agent 执行中真实事件
→ 用户取消或转向
→ Runtime 重启后恢复
→ 升级为 Deliver
```

冻结原则继续成立：除非直接服务 single-owner Runtime、authoritative Session、真实 Provider streaming、follow-up/cancel/resume、Collaborate → Deliver、RunPlan authority 或模型上下文预算，否则暂停新增 Profile、Automation job、Driver wrapper、展示事件和 Workflow 语法。

评审过程本身也出现过度累积：第十轮报告已经追加多轮批注，`current.md` 只局部改字段后产生自相矛盾。以后应遵循：

- `current.md` 只做短稳定入口；
- 每次产品/架构基线变化新建一份报告；
- 旧报告只读归档，不继续追加新裁决；
- CHANGELOG 只写用户可见变化；
- 代码 snapshot 与 CI snapshot 必须成对更新。

## 12. 问题清单

| ID | 严重度 | 状态 | 问题 |
| --- | --- | --- | --- |
| P0-ARCH-01 | P0 | 未关闭 | CLI/Web 缺 repo 级 single-owner Runtime authority。 |
| P0-ARCH-02 | P0 | 部分完成 | stop 有 abort/kill/hard deadline/DB fence，但不保证 executor/Git/files/SDK 已 quiescent。 |
| P0-DATA-01 | P0 | 未关闭 | Session Event 仍是 best-effort projection，不是 durable inbox/权威模型历史。 |
| P0-PRODUCT-01 | P0 | 未关闭 | Collaborate、真实 streaming、follow-up、steer、prompt cancel、restart resume 未闭环。 |
| P1-PLAN-01 | P1 | 部分完成 | canonical RunPlan 尚未成为 execute/resume 唯一事实。 |
| P1-SESSION-01 | P1 | 部分完成 | 在线 replay/pending/heartbeat 已有界；export、模型 compaction、真实规模与故障矩阵仍缺。 |
| P1-DSH-01 | P1 | 部分完成 | pin 已追平 alpha.2、Node/合同清晰；真实 binary + API key Provider smoke 仍缺。 |
| P1-A11Y-01 | P1 | 未关闭 | 两个 dialog 已闭环，不能外推为全站 screen reader、多浏览器和对比度验收。 |
| P1-PROCESS-01 | P1 | 未关闭 | PR 体量巨大，审阅、二分、迁移与回滚风险高。 |
| P1-SSE-02 | P1 | 本轮修复 | 分页 catch-up 在背压时重复读取旧 cursor，可能误截断或自旋。 |
| P2-SSE-02 | P2 | 本轮修复 | Session/Workspace heartbeat 忽略 write(false)，绕过背压状态。 |
| P2-DSH-02 | P2 | 本轮修复 | installHint 混入本地化说明，破坏 JSON/自动化命令语义。 |
| P2-DSH-03 | P2 | 本轮修复 | help/config 失败丢失 actualVersion，误导为未安装。 |
| P2-DOC-01 | P2 | 本轮修复 | current.md 快照、CI、DSH 和 workspace SSE 状态互相矛盾。 |
| P2-TEST-02 | P2 | 待收敛 | CLI e2e 文件命名与实际 unit lane 不一致；npm env warning 噪音未清理。 |

## 13. 建议实施顺序

1. **single-owner daemon + repo lock**  
   统一 Job、Git、worktree、subprocess、DB、Automation、Delivery 和 shutdown 所有权。

2. **executor 隔离 + quiescent shutdown/restart contract**  
   worker/process、真实 kill/join、checkpoint、generation fencing 和 late-write 故障注入。

3. **authoritative Session log / transactional outbox + durable inbox**  
   明确事实源、claim、processed、retry、模型历史和迁移。

4. **DeepSeek ACP real-provider vertical slice**  
   persistent session、execution-time updates、prompt cancel、close、restart resume。

5. **Collaborate → Deliver**  
   同一 Session follow-up/steer、计划升级和人工审批点。

6. **canonical RunPlan 成为 execute/resume 权威**  
   绑定需求、base/workspace、Provider、权限、网络、Artifacts 和 executable plan。

7. **完整历史与模型上下文预算**  
   export、DB/API/SSE/client/DOM/compaction/retention 一体化。

8. **可访问性、跨浏览器与测试基础设施专项**  
   screen reader、Firefox/WebKit、对比度、fixture/lane 规范和 CI warning 清理。

## 14. 合并与发布边界

代码门通过只能证明：

- 当前增量在 Node 24 Linux CI 上可构建、类型正确并通过现有自动化；
- Session/Workspace SSE 的已知 backpressure 组合问题有回归保护；
- DSH alpha.2 的 version/help/config L1/L2-preflight 合同在 fixture 层成立；
- react-router 更新未击穿现有 Chromium 产品路径。

它不能证明：

- Web/CLI 两个 Runtime 并发无 Git/文件副作用冲突；
- 服务关闭后所有 executor、文件、Git 和 SDK 活动都已终止；
- Session log 可完整恢复模型上下文；
- 任意规模会话都有稳定资源预算；
- DSH 已完成真实 API smoke；
- Firefox/WebKit、屏幕阅读器和真实弱网设备已通过；
- 普通用户持续协作产品已经完成。

当前 PR 已远超适合逐行审阅的规模。最终建议 squash merge，并将后续 daemon、Session 事实源、ACP vertical slice、RunPlan authority、历史/模型预算和 a11y 分成独立 PR。本轮未执行 merge、release 或 deploy。

## 15. 参考资料

### Tekon

- [当前权威入口](current.md)
- [Runtime authority ADR](../technical/adr-0001-runtime-authority-and-collaborate.md)
- [第十轮报告](2026-08-31-tekon-human-first-harness-tenth-review.md)
- [`SessionComposer`](../../packages/web/src/client/components/sessions/SessionComposer.tsx)
- [`LegacyAgentDriver`](../../packages/core/src/runtime/legacy-agent-driver.ts)
- [`Session dual-write`](../../packages/core/src/session/dual-write.ts)
- [`JobRunner`](../../packages/core/src/session/job-runner.ts)
- [`RunPlan`](../../packages/core/src/workflow/run-plan.ts)
- [`Session/Workspace SSE`](../../packages/web/src/server/sse.ts)

### DeepSeek Harness 官方

- [Safety](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/SAFETY.md)
- [Headless](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/bundle/headless/README.md)
- [ACP](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/acp/acp/README.md)
- [Root Node engines](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/package.json)
- [Base composition](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/bundle/base/cordis.patch.yml)
- [dsh v0.1.2-alpha.2 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.2)
- [alpha.1 → alpha.2 compare](https://github.com/deepseek-ai/deepseek-harness/compare/dsh-v0.1.2-alpha.1...dsh-v0.1.2-alpha.2)

---

## 16. 主 Agent 交叉评估批注（2026-08-31，基于 HEAD `19deedf`）

> 本节为应要求追加的独立评审视角，不改动上文第 1–15 节的原始裁决。方法：同步 deepseek-harness 至 `origin/master`（最新 tag `dsh-v0.1.2-alpha.2`，与 Tekon tested pin 一致），委派 4 个 subagent 分别从「修复落地核对」「架构进展对比」「代码健康度/安全」「测试与文档一致性」四个角度独立评估，再由主 Agent 对相互矛盾的结论逐条回源核对。

### 16.1 四路评估一致确认的结论

四个评估方对第 5 节列出的 5 项 reviewer 直接修复给出一致判定：**全部真实落地、测试断言有效、无假通过、无新引入问题**。主 Agent 逐条回源复核无误：

- **P1-SSE-02**：`catchUp` 入口与分页循环内部均检查 `isBackpressured`/`backpressureTruncated`，当前页 `enqueue` 触发 `write()===false` 后立即退出循环，cursor 由 `drain()` 推进后才由下一次定时 catch-up 续拉。回归测试构造 1200 事件 / 500 分页 / 首帧背压，断言背压期 `pageCalls===1` 且无 `replay-truncated`，drain 后完整追平。
- **P2-SSE-02**：Session 流与 Workspace 流的 heartbeat 均检查 `write(': ping\n\n')` 返回值，`false` 时进入与业务帧相同的背压状态并注册一次性 drain。
- **P2-DSH-02**：`dshInstallHint()` 返回纯命令，`DSH_NODE_REQUIREMENT` 为独立结构化字段，`--json` 与文本输出解耦。
- **P2-DSH-03**：`DshCapabilityError` 携带 `actualVersion`，help/config 漂移时 CLI 区分「未安装 / 版本不匹配 / 版本匹配但合同漂移」三态。
- **P2-DOC-01**：`current.md` 重新绑定 v0.20.2、reviewer 快照、Core/CI 状态与 DSH pin，第 1–10 轮报告确立为只读归档。

全量自动化在 HEAD `19deedf` 复跑：138 个测试文件 1476 通过 / 3 skip / 0 失败；Web 21 套件 211 通过；`pnpm audit --prod` 0 漏洞；无硬编码密钥、无 shell 拼接注入面、Web 默认绑 `127.0.0.1` 且具备 CSRF/CSP。

### 16.2 对一路评估「缺失」结论的纠正（附证据）

其中一路评估（Euclid）基于第十轮快照 `f9f3733` 给出若干「缺失」判定，与当前 HEAD `19deedf` 不符。主 Agent 逐条回源，确认以下三项不成立，不应纳入后续整改依据：

1. **「workspace SSE 无背压控制」——不成立**。`handleWorkspaceSummarySse`（`packages/web/src/server/sse.ts:426-519`）具备完整的 `isBackpressured` 状态、`writeFrame` 返回值检查、`drainPending` 续写、`MAX_PENDING_WORKSPACE_EVENTS=100` / `MAX_PENDING_WORKSPACE_BYTES=256KB` 双上限与超限断开。
2. **「手册未说明 DSH Node 要求」——不成立**。`docs/manual/tekon-user-manual.md:373` 与 `docs/manual/tekon-user-manual.html:484` 均明确写出 DSH 要求 `^22.19.0 || >=24.0.0`，并标注与 Tekon 主合同 `^20.19.0 || >=22.12.0` 的差异。
3. **「`bareProbeId` seam 仍在、`installHint` 仍是 alpha.1」——不成立**。生产 parser 已删除 bare-line 兼容分支，改用完整 YAML `id:` 行正则；`installHint` 与 tested pin 均为 `0.1.2-alpha.2`。

该路评估中仍有价值的部分是 P2-TEST-02 的根因分析与「可局部收敛 / 季度级重构」的范围划分，已并入下文。

### 16.3 主 Agent 独立判定的本轮可收敛项

以下三项证据充分、改动可控、有明确验收信号，建议在本 PR 内收敛（不触碰冻结的架构主线）：

- **P2-TEST-02（测试 lane 语义）**：`packages/cli/__tests__/e2e/` 下三个文件命名为 `*.test.ts` 而非 `*.e2e.test.ts`，匹配不上 `--exclude "**/*.e2e.test.ts"`，导致这些真实子进程 e2e 用例同时进入 unit lane 与 e2e lane 各跑一遍。应统一命名为 `*.e2e.test.ts`，恢复「快速 unit gate / 慢速 e2e gate」的分层语义。报告第 10.4 节与第 451 行已自认此项。
- **CI npm env warning 噪音**：CI 中 `npm exec --yes -- pnpm@10.12.1 ...` 透传 `npm_config_*` 触发未知 env config 弃用警告，不阻断但降低真实错误信噪比。可在 CI step 中收敛（如显式 `env:` 清理或改用 corepack/直接 pnpm）。
- **devDependencies 漏洞治理**：全量 `pnpm audit` 检出 12 项（9 High），全部来自 devDependencies（`brace-expansion` 经 `@vitest/coverage-v8`、`postcss`/`nanoid` 经 `vite`、`esbuild` 经 `tsx`/`vite`）。不暴露于生产运行时，但建议在根 `package.json` 用 `pnpm.overrides` 锁定修复版本。

### 16.4 维持冻结、不在本 PR 伪装关闭的架构项

P0-ARCH-01（single-owner Runtime）、P0-ARCH-02（quiescent shutdown）、P0-DATA-01（权威 Session 事实源）、P0-PRODUCT-01（持续协作闭环）、P1-PLAN-01（canonical RunPlan）、P1-SESSION-01 的模型 compaction/历史导出、P1-A11Y-01（全站无障碍）——这些与报告第 11、13 节的冻结判断一致，应分独立 PR 推进，不在本已庞大的 PR #11 中通过新增 wrapper/fixture/措辞制造关闭假象。

### 16.5 结论

第十一轮修复质量扎实、可合并，无阻塞项。本轮建议仅收敛第 16.3 节三项低风险过程/卫生项；架构主线按报告第 13 节顺序另立 PR。
