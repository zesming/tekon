# Tekon 人类可用性与 Harness 架构第五轮全面复审

- **复审日期**：2026-08-29
- **用户最新整改提交**：`71930359165ec744228734086a1da3eac7e8e9d0`
- **本轮代码修复提交**：`706c89a847131e98d20d2b29b77aefe46a81beb8`
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **对照基线**：`main@300aea6b9ea5c805303e7e1d302dadabc5531548`
- **用户整改验证**：Core #281 `success`；CI #190 `success`
- **本轮代码验证**：Core #282 `success`；CI #191 `success`
- **覆盖维度**：产品逻辑、CLI/Web UI、UX 与可访问性、Session/Runtime 架构、数据完整性、代码实现、测试可信度、DeepSeek Harness 最新官方边界、过度实现与过度设计
- **最终结论**：**用户最新整改与本轮低风险修复通过代码合并门；Tekon 仍不通过“面向普通人的稳定研发工作台”产品验收，可作为实验性受控交付执行与观察基础设施有条件通过。**

> 本报告是 PR #11 当前代码与合并判断的权威入口。首轮至第四轮报告只保留判断演进历史；当前裁决由 `docs/reviews/current.md` 稳定指向本报告。

---

## 1. 执行摘要

用户针对第四轮报告完成了两项有效整改：

1. 新增高级 `StartRunForm` 的 Playwright 覆盖，验证 dsh-headless、Goal、Workflow、Template 和 Profile 的状态联动；
2. 修正 `getLatestEventTimestamp()` 注释，不再把“没有匹配事件行”错误表述成“Session 不存在”。

这两项整改均与实现事实一致，测试与 CI 通过，没有引入行为回归。第三轮关闭的 `P1-CODE-01` 仍保持关闭；第四轮的 run-mode policy 也继续成立。

本轮重新审查整个产品链路后，发现一个可以无争议闭环的真实 UI/UX 缺口：高级“新建运行”折叠标题原本是带 `onClick` 的 `<div>`，不能通过键盘获得焦点或操作，也没有 `aria-expanded` / `aria-controls`；表单多个可见 `<label>` 未通过 `htmlFor` 与控件关联，新增测试只能依赖 CSS 容器和文本结构定位，反而掩盖了可访问名称缺失。本轮已改为原生 disclosure button、补齐字段标签关系，并把 Playwright 改为 accessible locators，覆盖 Enter 和 Space。

与此同时，第四轮的结构性结论没有被本次增量改变：

- Web 与 CLI 仍分别启动 JobRunner，没有单一 Runtime authority；
- shutdown 仍是有界等待，不是可证明的 quiescent shutdown；
- `session_events` 仍是 best-effort projection，而非权威模型历史与 durable inbox；
- Collaborate 所需的真实流、follow-up、steer、resume 和重启恢复仍不存在。

此外，DeepSeek Harness 官方边界已经发生重要演进：官方仍把项目标为 developer preview，并明确说明安全能力不保证隔离；但除 one-shot headless 外，当前已公开 SDK stdio JSON-RPC 与 ACP profile。Tekon 仍钉死 `0.1.1-rc.2` headless，官方最新 GitHub prerelease 已为 `dsh-v0.1.2-alpha.1`。因此，现有 bridge 仍可作为严格版本门控的一次性实验 provider，但不应继续被描述为 Harness 唯一机器可消费边界，也不适合作为持续协作产品的长期接口。

---

## 2. 复审方法与证据边界

### 2.1 仓库覆盖

本轮重新覆盖：

- **产品与文档**：README、主用户手册、current-scope、CHANGELOG、四轮评审报告与 `docs/reviews/current.md`；
- **CLI**：入口、帮助、run/goal/provider 参数、resume/pause/cancel、composition root 和 embedded JobRunner；
- **Web**：Session 列表、主 Composer、高级 StartRunForm、EventFeed、右侧审阅栏、Token、审批、运行控制、路由与响应式样式；
- **Core**：Session store、Job runner、SessionService、dual-write、LegacyAgentDriver、AgentAdapter/provider registry、DSH bridge 和数据库 schema；
- **测试与发布**：Core/CLI/Web unit、integration、Playwright、GitHub Actions、版本身份和文档同步；
- **外部基线**：DeepSeek Harness 官方 README、Architecture、Session、headless、SDK、ACP、Safety 与最新 GitHub prerelease。

这是“仓库级结构覆盖 + 关键路径深读”，不宣称逐行审阅所有历史评审文件或每个辅助模块。

### 2.2 UI 证据限制

本轮没有独立部署实例，也没有完成屏幕阅读器、多浏览器和全站像素级实测。因此：

- 已检查组件结构、原生控件语义、ARIA 状态、标签关系、数据流、响应式实现和 Chromium Playwright；
- 本轮代码测试真实覆盖键盘 Enter/Space、`aria-expanded`、`aria-controls` 和可访问名称；
- 未把这些自动化结果冒充为完整 WCAG 审计或视觉设计验收。

---

## 3. 对用户最新整改的裁决

| 整改项 | 裁决 | 理由与依据 |
| --- | --- | --- |
| Goal/dsh 状态联动 Playwright | **通过** | 覆盖 dsh→Goal、Goal→Workflow、Template/Profile enable/disable，未启动真实 provider，确定性高。 |
| `getLatestEventTimestamp()` 注释勘误 | **通过** | 当前数据库没有 Session 外键；“无匹配事件行返回 null”与真实 SQL 语义一致。 |
| 第四轮 run-mode policy | **继续通过** | Core、CLI、Web API 和 UI 状态机仍共享同一产品合同，非法组合在持久副作用前被拒绝。 |
| P1-CODE-01 | **保持关闭** | `session.get` 只投影尾事件 timestamp，不再解析完整 payload。 |
| P1-DATA-01 | **仍未关闭** | 子表无统一外键/孤儿策略；注释正确不等于引用完整性成立。 |
| P1-SEC-01 | **递延仍合理** | 单独增加一个 UI checkbox 会形成安全剧场；需 RPC/Core/CLI/snapshot/run-plan 的端到端确认合同。 |
| CHANGELOG 评审过程追加 | **不接受为长期模式** | 与 `current.md` 的单一裁决入口相冲突，继续增加决策噪声和维护成本。 |

用户提交对应 Core #281、CI #190 均为 success，因此本轮没有把文档意见误判为代码回归。

---

## 4. 本轮实际修复：高级运行表单可访问性

提交：`706c89a847131e98d20d2b29b77aefe46a81beb8`

### 4.1 原问题

`StartRunForm` 的折叠标题原为：

- `<div onClick>`，没有原生按钮语义；
- 不能 Tab 聚焦，Enter/Space 不能操作；
- 没有 `aria-expanded` 或 `aria-controls`；
- SVG 会参与可访问树；
- 需求、模式、模板、代理、Profile、超时等可见 label 没有 `htmlFor`；
- 用户新增的测试只能通过 `.form-group` + 文本找到 select，不能证明真实可访问名称存在。

这不是审美偏好，而是输入方式和辅助技术可用性的产品缺陷。

### 4.2 修复

- 折叠标题改为原生 `<button type="button">`；
- 增加 `aria-expanded` 与 `aria-controls="start-run-form-body"`；
- 装饰 SVG 增加 `aria-hidden` 与 `focusable="false"`；
- 为需求、运行模式、模板、代理、Profile、总超时和无进展超时建立 `id` / `htmlFor`；
- 移除未使用的 `useAuthScope`；
- Playwright 改用 `getByRole` / `getByLabel`，覆盖 Enter 展开和 Space 收起；
- 保留原有 Goal/dsh 状态联动断言。

### 4.3 验证

- Core #282：success；
- CI #191：success；
- Root build/typecheck、CLI unit/e2e、Web build/typecheck/unit 和 Web Playwright 全部通过；
- 没有发现本轮增量引入的阻断回归。

---

## 5. 产品逻辑评审

### 5.1 Deliver 产品合同基本成立

当前默认路径已经比较诚实：

- `tekon` 无参数提供可发现入口；
- `tekon ui` 被推荐给人类用户；
- 主 Session Composer 明确启动完整 `standard-delivery`，并说明轻量协作、追问和转向尚未开放；
- 远端 push、创建 PR 等副作用仍需明确人工批准；
- Goal 与 Workflow 已通过共享 policy 区分；
- dsh-headless 被限制在 Goal，避免伪装成可产出 Artifact/Gate 的交付 provider。

因此，现阶段不应再说“Deliver 合同完全不成立”。准确判断是：**受控交付入口和边界基本成立，但它只是 Tekon 产品的一条轨道，不等于完整的人类研发工作台。**

### 5.2 Collaborate 产品合同仍不存在（P0-PRODUCT-01）

用户进入 Session 后仍不能：

- 在同一 Session 追加新的 durable user input；
- 在 agent 执行中 follow-up 或 steer；
- 观察 provider 原始 execution-time assistant/tool stream；
- 刷新浏览器或重启进程后恢复正在运行的协作；
- 从轻量协作显式升级到受控交付。

`LegacyAgentDriver` 的 `followUp`、`steer`、`resume` 仍是未支持方法，多数 assistant 内容仍由完成后 artifact/结果投影生成。当前 UI 是“运行观察与治理界面”，不是持续协作界面。

### 5.3 启动成本与风险预览不足（P1-PRODUCT-02）

普通用户输入一句需求即可启动完整 PM/RD/QA/Reviewer 链路，但执行前仍没有清晰预览：

- 将运行哪些角色与 Gate；
- Provider、模型和权限 profile；
- 是否允许网络；
- timeout / no-progress timeout；
- 预期产物和人工审批点；
- 成本影响因素。

高级页暴露毫秒和 Profile 等工程参数，主路径则几乎不展示计划。合理方向不是把更多底层输入框搬到主界面，而是先提供人类可读的 run plan，再把高级参数折叠到专家模式。

---

## 6. UI / UX 评审

### 6.1 已改善

- CLI 首屏和 Web 主入口更可发现；
- Session 列表按人工行动优先，并展示相对活动时间；
- EventFeed 默认隐藏技术噪声，保留显式展开；
- Session 右栏限制 supporting cards，结果与错误保持可见；
- Goal/Workflow 与 dsh provider 联动有浏览器测试；
- 本轮关闭高级 StartRunForm 的键盘 disclosure 和字段标签问题。

### 6.2 Session 列表仍不是实时任务中心（P1-UX-01）

页面 ticker 只更新时间文字，不拉取或订阅 workspace 级 summary。用户停留列表页时，另一进程产生的新审批、失败或完成状态不会可靠自动出现。应建立 workspace summary stream，而不是继续叠加局部定时器。

### 6.3 历史失败没有处理语义（P1-UX-02）

`failed` 会持续派生 `needsAction` 并优先排序，但没有：

- acknowledge；
- archive；
- unread / changedSinceSeen；
- “已查看但暂不处理”的状态。

因此旧失败可能长期占据列表顶部。不能简单移除 failed badge；需要持久的人类处理状态。

### 6.4 Token 与术语仍偏内部实现（P1-UX-03 / P1-UX-04）

顶栏直接暴露会话 Token 字符串，主信息架构仍混用 Session、Run、Profile、Gate、Artifact、Workflow 等内部词汇。高级页允许保留技术词，但普通路径应使用“任务、执行计划、需要确认、结果、交付材料”等一致产品词汇，并把 Token 改成连接状态与重新连接动作。

### 6.5 长 Session 无界（P1-UX-05）

Session 详情仍可能一次加载和渲染完整事件历史。当前缺少：

- cursor / page window；
- turn 导航与虚拟化；
- 摘要和 context pressure 指示；
- 大 payload spill / lazy detail；
- 明确性能预算。

现有技术事件 toggle 只改变可见性，不改变数据读取、内存和 DOM 的上界。

---

## 7. Runtime 与数据架构评审

### 7.1 Runtime 无单一执行所有者（P0-ARCH-01）

CLI composition root 与 Web composition root 都会创建并启动 DurableJobRunner。它们共享：

- SQLite 数据库；
- Git 仓库和交付分支；
- worktree lease；
- `.tekon/runs` 文件；
- Provider 子进程和宿主资源。

jobs owner/lease/CAS 能降低部分重复执行，但不能 fence Node、Artifact、Gate、Audit、Delivery、Git 和文件系统的全部副作用。优先方案仍应是 repo 级 single-owner daemon + lock，CLI/Web 作为客户端；只有明确需要 active-active owner 时，才值得为所有副作用设计 generation fencing。

### 7.2 Shutdown 仍非 quiescent（P0-ARCH-02）

当前 runner stop 会请求取消并等待一个固定上限，随后清理进程内 controller、heartbeat、token 等状态。它没有形成可证明的顺序：

```text
停止接收新工作
→ durable 标记 draining
→ 请求取消
→ provider / subprocess join
→ listener/outbox drain
→ Git/文件写入完成
→ checkpoint/flush
→ 释放 owner/lock
→ 关闭数据库
```

固定等待不是 quiescence。需要 kill/restart/late-write 故障注入证明不存在停机后的写入。

### 7.3 Session Event 仍是 best-effort projection（P0-ARCH-03）

当前旧仓储或 Audit 写入成功后，再 best-effort 追加 Session Event；找不到 Session 或 Event 写入失败时可以跳过。结果是：

- log 不能保证完整重建模型上下文；
- 不适合作为 durable inbox；
- 不能可靠提供 replay/fork/resume；
- UI 观察事件与真实领域状态可能短暂或永久不一致。

这与 DeepSeek Harness 官方“模型可见即必须写入 log，模型请求必须可从 log 重建”的不变式不同。Tekon 应明确选择：让 Session log 成为权威源，或继续把它定义成观察投影；不能长期同时暗示两种角色。

### 7.4 子表引用完整性仍缺失（P1-DATA-01）

`session_events.session_id`、`jobs.session_id` 和 `projection_checkpoints.session_id` 没有统一外键；`appendEvent` 不验证 Session 存在。用户本轮修正了注释，但数据库事实未改变。

合理修复需要：

1. 盘点和导出孤儿行；
2. 定义删除、隔离或补建策略；
3. SQLite 表重建 migration；
4. 老库升级与回滚测试；
5. 更新直接插入孤儿数据的 fixture；
6. 决定 Session 删除的 cascade/restrict 语义。

只对新库添加外键会制造新旧行为分裂，不接受。

---

## 8. DeepSeek Harness 最新官方边界复核

### 8.1 上游状态

截至 2026-08-29，官方仓库仍明确标记为 **developer preview**，并提示会发生兼容性破坏。官方 Safety 进一步说明项目未经过安全审计，sandbox、审批和权限控制不能保证隔离，也不应成为不可信工作负载的唯一安全控制。

依据：

- [DeepSeek Harness README](https://github.com/deepseek-ai/deepseek-harness)
- [Safety](https://github.com/deepseek-ai/deepseek-harness/blob/master/SAFETY.md)
- [dsh-v0.1.2-alpha.1 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.1)

Tekon 当前把 dsh 标为 experimental、声明网络不受限并 fail-closed 版本漂移，方向正确；但这不等于生产安全边界成立。

### 8.2 headless 仍只适合一次性 Goal

官方 headless 文档明确：一个 task、最终 answer、随后退出，没有 interactive follow-up。它适合脚本、CI 和 one-off job，而不是多轮 Session。

依据：

- [dsh-headless README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md)

因此 Tekon 把 dsh-headless 限制在 Goal 是正确产品收敛，不能为了“看起来支持 Harness”再把它扩展回 Deliver 或 Collaborate。

### 8.3 “唯一机器边界”判断已过时（P1-ARCH-04）

Tekon 的阶段 5b 设计与 `dsh-bridge-probe.ts` 注释是在 `0.1.1-rc.2` 上做出的，当时选择 headless CLI 很合理。但当前官方已经公开：

- SDK stdio JSON-RPC application profile；
- TypeScript/Python SDK client；
- ACP stdio profile，支持标准 Session 控制和恢复边界；
- 持久 Session log 与投影 flush 屏障。

依据：

- [SDK app](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/sdk-app/README.md)
- [SDK client](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/sdk/client/README.md)
- [ACP app](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/acp-app/README.md)
- [Architecture](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/architecture.md)

结论：

- 保留 headless 作为 Goal one-shot provider；
- 不把 SDK/ACP 硬塞进现有 AgentAdapter；
- 为 Collaborate 建独立 ADR，对比 SDK 与 ACP 的控制面、事件语义、恢复、取消、权限和生命周期；
- 先做一个真实 provider vertical slice，再决定长期接口。

### 8.4 版本与安装体验存在断层（P1-DSH-01）

Tekon 当前硬编码 `TESTED_DSH_VERSION = '0.1.1-rc.2'`，官方最新 GitHub prerelease 已是 `0.1.2-alpha.1`。严格版本门是正确的 fail-closed 设计，但当前体验仍有问题：

- 用户手册只说“自行安装 `@deepseek-ai/dsh`”，没有给出可复制的精确兼容版本安装命令；
- 版本检查在 provider 真正执行时才发生，可能已经创建 Workflow、Session 和 Job；
- Web 没有 provider compatibility/preflight 状态；
- escape hatch 属专家能力，不能作为普通用户修复路径。

建议独立小 PR 增加：

1. `tekon provider preflight dsh-headless`；
2. Web 连接状态与版本检查；
3. 精确兼容安装命令；
4. 在产生持久运行副作用前完成 probe；
5. 对 `0.1.2-alpha.1` 重新执行 contract fixture 后再决定是否更新 pin。

### 8.5 网络风险确认仍未闭环（P1-SEC-01）

当前代码内部持久化 `acknowledgeUnrestrictedNetwork: true`，但这代表实现配置，不代表人类在本次运行前做出知情确认。真正闭环需要：

- run plan 展示网络状态；
- Web 与 CLI 都有显式确认；
- 确认写入 run provider snapshot/audit；
- resume 不丢失该事实；
- 不允许调用者只靠隐藏布尔值绕过。

纯前端 checkbox 不具备这些属性，因此用户本轮选择递延是合理的。

---

## 9. 代码实现评审

### 9.1 做得较好的部分

- run-mode policy 是小型纯函数，CLI/Web 共用，避免规则分叉；
- `getLatestEventTimestamp` 使用现有索引，只投影需要字段；
- API、Core 和 Playwright 覆盖主要合同；
- Provider snapshot 阻止 resume 静默换 provider；
- dsh args 和环境变量采用 allowlist/pin/fail-closed；
- Session list 查询避免全事件聚合；
- 相对时间显式注入 clock，可确定测试；
- 本轮表单测试从结构定位升级为语义定位。

### 9.2 仍需控制的代码问题

- `SessionService`、旧 repositories、dual-write 和 Event UI 共同表示同一运行事实，边界仍复杂；
- `LegacyAgentDriver` 暴露持续协作形状，却没有生产级实现和消费者；
- Web/CLI composition root 重复持有 Runtime 生命周期；
- Session 列表仍全量读取并在 router 内存排序，无 cursor/summary；
- 大量 phase/轮次注释已经超过代码理解所需，容易把历史过程固化为架构。

建议新代码优先表达稳定产品合同和不变式，历史评审轮次留在报告，不继续进入生产注释。

---

## 10. 过度实现与过度设计判断

### 10.1 横向平台能力仍领先于纵向闭环

当前已有 Profile policy、Automation、Goal、Provider registry、LegacyAgentDriver、dual-write projection、DSH ACL/probe、Web/CLI 两套 Runtime composition。与此同时，最基本的持续协作纵向闭环仍缺：

```text
真实流
→ durable user inbox
→ follow-up / steer
→ refresh/restart resume
→ Collaborate → Deliver
```

这不是“抽象写得差”，而是实现顺序过度平台化。下一阶段应冻结不能直接服务上述 vertical slice 的新横向能力。

### 10.2 不应现在实现全域 generation fencing

在尚未决定单 owner 还是 active-active 前，为每个 Artifact/Gate/Git/文件副作用增加 generation token 会显著扩大复杂度。对本地单仓库产品，single-owner daemon + repo lock 更符合当前需求；只有明确需要多 owner 时再升级。

### 10.3 评审与 CHANGELOG 已过程化过度设计（P2-PROCESS-01）

`CHANGELOG.md` 已超过十万字符，并继续包含“第几轮评审、对抗 reviewer、批注、验证计数”等过程信息。最新提交再次追加第四轮评审过程，和 `docs/reviews/current.md` 已声明的单一裁决入口相冲突。

建议：

- `CHANGELOG` 只保留用户可见行为；
- `current.md` 指向一份当前报告；
- 历史报告只读归档；
- 后续整改只写简短 revision log，不再把评审过程复制进 CHANGELOG、HTML、旧报告和 PR body 四处。

本轮没有直接重写整个 CHANGELOG，因为需要保留历史发布记录并避免在评审提交中制造超大文档 diff；但从第五轮起不再向其中追加复审过程。

---

## 11. 未关闭问题清单

### P0：产品与执行正确性

1. **P0-ARCH-01**：Web/CLI multi-owner，缺单一 Runtime authority 或全副作用 generation fencing。
2. **P0-ARCH-02**：shutdown 不是可证明的 quiescent shutdown。
3. **P0-ARCH-03**：Session Event 是 best-effort projection，不是权威模型历史/durable inbox。
4. **P0-PRODUCT-01**：无真实 streaming、follow-up、steer、resume 和重启恢复的 Collaborate 轨道。

### P1：重要产品、架构与数据问题

1. **P1-PRODUCT-02**：Deliver 启动前缺人类可读 run plan、权限和成本影响因素预览。
2. **P1-UX-01**：Session 列表无 workspace 级实时 summary stream。
3. **P1-UX-02**：历史失败无 acknowledge/archive/unread/changedSinceSeen。
4. **P1-UX-03**：Token 仍是普通用户可见字符串控件。
5. **P1-UX-04**：主路径术语与中英文案仍偏工程内部。
6. **P1-UX-05**：长 Session 数据、内存和 DOM 无界。
7. **P1-DATA-01**：Session 子表缺外键、孤儿策略和升级 migration。
8. **P1-ARCH-04**：持续协作接口尚未对齐官方 SDK/ACP。
9. **P1-DSH-01**：dsh 版本 pin、安装和副作用前 preflight 未形成可用路径。
10. **P1-SEC-01**：dsh unrestricted network 没有端到端人类确认事实。

### P2：维护性与验证

1. **P2-PROCESS-01**：超长 CHANGELOG 与多轮重复报告造成决策噪声。
2. **P2-TEST-02**：缺真实 Provider/SDK/ACP、长事件历史、跨进程和 late-write 故障注入矩阵。
3. **P2-A11Y-02**：本轮只关闭 StartRunForm；仍需全站键盘、焦点顺序、名称/角色/值和屏幕阅读器专项审计。

### 本轮关闭

- **P1-UX-06**：StartRunForm 折叠标题键盘与 ARIA 语义——已关闭；
- **P2-TEST-01**：Goal/dsh 状态联动浏览器断言——用户已关闭并由本轮增强；
- **P1-CODE-01**：`session.get` 尾事件完整 payload 读取——保持关闭。

---

## 12. 推荐实施顺序

### A. Runtime authority 与安全停机

1. repo single-owner daemon + lock；
2. CLI/Web 客户端化；
3. durable draining 状态；
4. provider/subprocess join + listener/outbox drain；
5. kill/restart/late-write 故障注入。

### B. 权威 Session 事实链

1. 明确 authoritative log contract；
2. durable inbox、claim、idempotency；
3. 模型可见输入全部由 log 重建；
4. dual-write 迁移/校验/下线策略；
5. 子表引用完整性和孤儿迁移。

### C. 一个真实 Collaborate vertical slice

1. 对 DSH SDK 与 ACP 做 ADR；
2. 选择一个官方公开接口；
3. execution-time assistant/tool stream；
4. follow-up、steer、cancel、resume；
5. 浏览器刷新和进程重启恢复；
6. 一条真实 Provider E2E。

### D. Collaborate → Deliver

1. 明确模式升级；
2. run plan、角色、Gate、权限、网络和成本预览；
3. 接入既有 Artifact/Gate/Delivery；
4. 用可靠 link/outbox 连接协作域与治理域。

### E. Scale、UX 与流程收敛

1. Session summary projection、cursor 和 workspace stream；
2. ack/unread/changedSinceSeen；
3. turn 导航、虚拟化、摘要和 context pressure；
4. Token 连接 UI 与产品词汇表；
5. 全站可访问性专项；
6. CHANGELOG/报告单一事实入口清理。

---

## 13. 验收结论

### PR / 代码合并门

- 用户最新 P2-TEST-01：**通过**；
- 用户最新 P1-DATA-01 注释勘误：**通过**；
- 本轮 StartRunForm 可访问性修复：**通过**；
- 用户整改快照 Core #281 / CI #190：**success**；
- 本轮代码快照 Core #282 / CI #191：**success**；
- 最新增量是否引入阻断回归：**未发现**。

### 产品验收门

- [x] CLI/Web 入口可发现，并诚实说明当前受控交付边界；
- [x] Workflow/Goal/provider 不兼容组合在持久副作用前失败；
- [x] Session 列表可按人工行动优先级组织；
- [x] 高级运行表单具备原生键盘 disclosure 和字段可访问名称；
- [ ] 当前 Session 可继续输入、转向并在重启后恢复；
- [ ] Provider 输出为执行期真实流；
- [ ] Collaborate 与 Deliver 是行为不同且可升级的明确轨道；
- [ ] 一个 repo 有单一 Runtime owner，或所有副作用均有持久 fencing；
- [ ] shutdown 可证明没有在途执行和 late write；
- [ ] 对话事实具有权威 log / durable inbox；
- [ ] 长 Session 数据和 DOM 有界；
- [ ] DSH 接口、版本、preflight 与安全确认形成稳定公开合同；
- [ ] 产品验收 gate 与 CI/merge gate 在流程上真正分离。

# 最终裁决

**本 PR 的用户最新整改、本轮代码修复和自动化验证可以继续合并审阅；Tekon 仍不通过面向普通人的稳定研发工作台验收。**

允许的成熟度表述：

> Tekon 已形成测试较强、边界逐步诚实的实验性受控交付执行与观察基础设施；它尚未完成持续协作产品、单一 Runtime 权威、quiescent shutdown 和权威 Session 事实链。

本 PR 的合并不得被解释为上述 P0/P1 已自动关闭。
---

# 附录 A：审阅代理第五轮复核批注（2026-08-29）

> 本附录由审阅代理在收到用户第五轮报告后追加。目的是对报告结论逐项标注「同意 / 补充 / 分歧」，附代码证据与本轮落地判断依据，作为本轮整改的范围划分依据。所有代码行号基于提交 `3dd4330` 的工作树。

## A.1 对 P0 项的复核

### P0-ARCH-01（Runtime 无单一执行所有者）：同意，本轮递延

- **证据核实通过**：Web 端在 [root.ts](../../packages/web/src/server/api/root.ts) `createApiCaller` 内 `new DurableJobRunner(...).start()`；CLI 端在 [session-context.ts](../../packages/cli/src/lib/session-context.ts) 与 [run.ts](../../packages/cli/src/commands/run.ts) 独立构建并 `start()`。两个 composition root 确实各自持有 runner 生命周期，共享同一 SQLite / Git / worktree / `.tekon/runs` / 子进程资源。
- **补充事实**：`jobs` 表的 owner/lease/CAS 只 fence 了 job 领域状态，未覆盖 Artifact 落盘、Audit 哈希链 append、Git 提交与文件写入。报告判断准确。
- **本轮判断**：single-owner daemon + repo lock 属侵入性架构重构（5-8 人天，高回归风险），不适合与本轮 UX/产品收敛混在同一 PR。**本轮以 ADR 诚实记录 multi-owner 边界与非全副作用 fencing 限制**，代码递延。

### P0-ARCH-02（Shutdown 非 quiescent）：同意，且本轮可低风险闭环核心序列

- **证据核实通过**：[job-runner.ts](../../packages/core/src/session/job-runner.ts) `stop()` 在 `Promise.race([allSettled, timeout(5s)])` 超时分支下，**既不对在途 controller 调用 `abort()`，也不 `registry.killAll()`**，仅 `clearHeartbeat` + 清空 `controllers/executionTokens/pauseFlags`。随后 CLI/Web 调用方立即 `db.close()`。若在途异步写入超过 5s，late-write 会撞上已关闭的 SQLite 句柄。
- **与报告的细化分歧（非否定）**：报告称 stop 完全不 abort，需澄清——poll 循环内对 ownership-lost 与 cancel 路径**是**有 abort 的；缺失的是 **stop() 关停路径**在超时后没有主动 abort/kill 在途 job。这一区分不改变结论，但决定了修复点精确落在 `stop()`。
- **本轮判断**：**本轮做**。在 `stop()` 增加 draining 标记 → 显式 abort 在途 controller → kill 关联子进程 → 等待 write-queue drain → 提供关停后 late-write 屏障，并补故障注入测试。风险低、收益高，是本轮唯一纳入的 P0 代码闭环。

### P0-ARCH-03（Session Event 是 best-effort projection）：同意，本轮以文档定性递延

- **证据核实通过**：[dual-write.ts](../../packages/core/src/session/dual-write.ts) `recordFromRun` 明确注释「无 session 静默跳过；任何失败仅记录、不抛错」。它确实是观察投影，不是权威事实源 / durable inbox。
- **本轮判断**：改为 event-sourcing 权威日志是 6-10 人天的数据链路重写，会推翻现有 Audit 哈希链契约，**本轮递延**。本轮在技术文档中把 `session_events` 明确定性为「可观测投影」而非权威历史，消除「同时暗示两种角色」的歧义（报告 7.3 的核心诉求）。

### P0-PRODUCT-01（Collaborate 轨道缺失）：同意，本轮保持诚实禁用 + ADR

- **证据核实通过**：[legacy-agent-driver.ts](../../packages/core/src/runtime/legacy-agent-driver.ts) 的 `followUp/steer/resume` 抛 `NotSupportedYet`；SessionDetailPage 无追加输入框。
- **本轮判断**：真实 streaming + follow-up/steer/resume 是独立产品特性（6-8 人天，强依赖 Provider 协议选型），**本轮递延**。前端保持已有的诚实禁用提示，并产出 DSH SDK/ACP 选型 ADR（同时关闭 P1-ARCH-04 的文档诉求）。

## A.2 对 P1/P2 项的本轮取舍

**本轮纳入（代码 + 测试闭环）：**

- **P1-PRODUCT-02 + P1-SEC-01（合并交付）**：新增人类可读 run plan 预览（角色链路、Gate、网络/沙箱、超时、产物、审批点），并在预览中显式呈现「网络不受限」告警与知情确认，确认事实写入 run 快照/审计。合并交付避免形成孤立的安全剧场 checkbox（报告 8.5 的明确要求）。
- **P1-UX-02**：`sessions` 增加 `acknowledged_at`，新增 acknowledge RPC 与 UI，已确认的历史失败不再永久置顶。证据：[session.ts](../../packages/web/src/server/api/routers/session.ts) 目前把所有 `failed` 恒定派生为 `needsAction`。
- **P1-UX-03 / P1-UX-04**：顶栏 Token 输入框改为连接状态徽标 + 连接管理面板；主路径术语统一为产品化中文词汇，工程术语收敛到高级模式。
- **P1-UX-01（部分）**：workspace 级轻量 summary 刷新（SSE 通知 + 服务端 catch-up 轮询兜底），不引入重型 durable inbox。
- **P1-UX-05（部分）**：EventFeed 初始渲染窗口 + 超长输出按需展开，限制 DOM 上界；后端 cursor 分页与虚拟化递延。
- **P2-A11Y-02（部分）**：闭环主路径核心交互（审批表单、连接面板、run plan 预览）的键盘/ARIA/label，全站深度扫描递延。
- **P2-PROCESS-01**：停止向 CHANGELOG 追加评审过程，历史评审噪声归档，`current.md` 保持单一入口。
- **P0-ARCH-02**：如 A.1 所述。

**本轮递延（附诚实记录方式）：**

- **P1-DATA-01**：SQLite 不支持 `ALTER TABLE ADD CONSTRAINT`，外键需 4 张表整表重建 + 孤儿数据策略 + 老库升级/回滚 + 全仓 fixture 重构（3-4 人天，高破坏性）。**递延为独立数据迁移专项 PR**，本轮在 ADR/文档记录跟踪。
- **P1-DSH-01**：`tekon provider preflight` 与精确安装命令解耦于核心引擎，**递延为独立小 PR**（与报告 8.4 建议一致）。
- **P1-ARCH-04**：以 ADR 落地（并入 P0-PRODUCT-01 的选型 ADR）。
- **P2-TEST-02**：完整故障注入矩阵依赖 single-owner 重构成型后才有稳定验收面；**本轮仅落地 P0-ARCH-02 相关的 late-write / quiescent 注入用例**作为起点，全矩阵递延。

## A.3 分歧与保留意见

1. 对 P0-ARCH-02，我方将修复精确定位到 `stop()` 关停路径而非「全局无 abort」，以免误改已经正确工作的 poll 循环 abort 逻辑。
2. 本附录及后续整改**不再复制进 CHANGELOG**，遵循 P2-PROCESS-01 的单一入口原则。本轮报告的整改结论以本附录 + 后续「本轮整改回填」小节为准。

## A.4 本轮范围一句话结论

> 本轮在不承担架构重构与破坏性数据迁移的前提下，闭环「启动透明度、历史失败处理、连接与术语、列表实时性、长会话 DOM 边界、主路径可访问性、安全停机序列」，并对递延项以 ADR/文档诚实定性，避免安全剧场与「哪份才权威」的流程债。

---

# 附录 B：本轮整改回填（2026-08-29，v0.17.0）

本节回填第五轮报告实际落地情况，作为整改证据入口。全量测试 `pnpm test` 通过：125 test files / 1358 passed / 3 skipped；web e2e `pnpm --filter @tekon/web test:e2e` 32 passed。版本 `0.16.0 → 0.17.0`。

## B.1 已闭环项（代码 + 测试）

- **P0-ARCH-02 安全停机（T1）**：`packages/core/src/session/job-runner.ts` 的 `stop()` 重写为确定性终止序列——draining（阻止 claim 新 job）→ 有界等待正常完成 → 对仍在 `controllers` 的在途者 `abort()` + `registry.killAll(runId,'SIGKILL')` → 再次 `await Promise.allSettled([...pending])` 确定性 drain 后返回，调用方之后才 `db.close()`。不误杀依据 `controllers` 成员关系（在途权威标记）。测试：`packages/core/__tests__/session/job-runner.test.ts` 新增 abort+kill 效果、边界完成不误杀（killSpy 未调用）用例。
- **P1-PRODUCT-02 + P1-SEC-01 run plan 预览 + 网络确认（T2）**：core `packages/core/src/workflow/run-plan.ts` 纯函数投影（角色链/阶段/Gate/超时/网络）；web `workflow.plan`；`project.run` 在 `requiresUnrestrictedNetwork`（agent=`dsh-headless`）且未知情确认时硬拒绝并落审计；`StartRunForm` 预览 + 知情确认勾选 + 未确认禁用提交（无逃生舱）。
- **P1-UX-02 失败处理语义（T3）**：`migrations.ts` 幂等 `addColumnIfMissing(sessions, acknowledged_at)`；`session-store` `acknowledgeSession`；`session` router 已确认 failed 不置顶、legacy NULL 视为未确认仍置顶；`SessionsPage` 确认/归档动作。
- **P1-UX-03 / P1-UX-04 连接状态与术语（T4）**：`TopBar` Token 输入框改为「已连接/未连接」状态徽标 + 连接管理面板；主路径术语产品化。
- **P1-UX-01（部分）实时刷新（T5）**：workspace summary SSE（`GET /api/workspaces/:id/summary/events`）+ 客户端 invalidate；跨进程漏发由服务端 SSE catch-up 轮询兜底（客户端不做定时重取）。
- **P1-UX-05（部分）长会话 DOM 边界（T6）**：`EventFeed` 默认窗口（250）+「展开更早」+ 超长正文限高按需展开。
- **P2-A11Y-02（部分）主路径可访问性（T7）**：预览、连接面板、确认动作键盘/ARIA/role/焦点。
- **P2-PROCESS-01 流程降噪（T8）**：CHANGELOG 停止追加评审过程，仅记录用户可见行为；评审结论留在本报告。

## B.2 递延项（见 ADR-0001）

`docs/technical/adr-0001-runtime-authority-and-collaborate.md` 记录：P0-ARCH-01（single-owner daemon 方向）、P0-ARCH-03（Session Event 事实源角色二选一）、P0-PRODUCT-01（Collaborate 保持诚实禁用）、P1-ARCH-04（Harness SDK/ACP 选型 vertical slice）、P1-DATA-01（外键独立 PR）、P1-DSH-01（provider preflight 独立 PR）、P2-TEST-02（故障注入全矩阵）。
