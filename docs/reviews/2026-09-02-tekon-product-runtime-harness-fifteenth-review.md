# Tekon 产品、UI/UX、Runtime 与 DeepSeek Harness 第十五轮全面复审

- **日期**：2026-09-02
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **上一轮权威报告**：[第十四轮全面复审](2026-09-01-tekon-product-runtime-harness-fourteenth-review.md)
- **上一轮权威 Head**：`99e00655470f43273bbc0d25228924e838e51652`
- **用户本轮整改快照**：`13c27ebfdd473b7f2e866d6a1faf54c29c087801`
- **reviewer 代码修复快照**：`ebd040e44f66e26c69af449584eb29a699d52726`
- **产品版本**：`0.20.4`
- **Tekon DSH tested pin**：`0.1.2-alpha.3`
- **DeepSeek Harness 当前官方基线**：master / `dsh-v0.1.2-alpha.4`，commit `4e84901e6471b79ec0338099867ebb4606d12bb5`
- **用户整改自动化**：`13c27eb...` 的 Core #372 与 CI #281 均为首次执行 `completed/success`
- **reviewer 代码自动化**：`ebd040e...` 的 Core #392 与 CI #301 均为首次执行 `completed/success`；Core unit 84 文件 / 1061 passed / 3 skipped，Core e2e 8 文件 / 26 passed，CLI unit 9 文件 / 64 passed，CLI e2e 3 文件 / 8 passed，Root build/typecheck、生产依赖 audit、Web build/typecheck/unit 与 Chromium Playwright 全部成功
- **最终裁决**：本轮整改与 reviewer 局部修复通过当前代码合并门；Tekon 整体仍未通过“面向普通人的稳定持续协作研发工作台”产品验收

## 1. 执行摘要

用户本轮把上一轮登记的 DeepSeek Harness Host Node 断层落成了真实代码：

1. `runDshPreflight()` 在启动外部 `dsh` 之前检查宿主 Node；
2. CLI 文本和 JSON 输出包含宿主版本、兼容性和失败类别；
3. CLI/Web 的实际运行路径都接入该检查；
4. 提供 `TEKON_DSH_ALLOW_HOST_NODE=<精确版本>` 逃生口；
5. 增加 Core、CLI、Web 和文档覆盖。

方向正确，而且用户整改快照的 Core #372、CI #281 首次执行均成功。然而，代码级和产品语义复核发现，绿色测试仍掩盖了四类真实问题：

- **Node 范围实现不等价于 semver**：原正则只读取 major/minor，导致 `22.19.0-rc.1`、`24.0.0-rc.1` 和带垃圾后缀的字符串可能被当作满足稳定版本范围；npm semver 的普通范围默认不接纳 prerelease。
- **“兼容”与“被人工旁路后允许运行”混为一谈**：Host Node 或 DSH 版本通过逃生口后，结果会把 `compatible` 写成 true，并把原本不兼容的宿主重新标记为 compatible，用户和自动化无法区分“已验证”与“自行承担风险”。
- **测试注入泄漏为公开 CLI 参数**：`--host-node-version` 允许用户把并非当前进程的版本传给 preflight，进而为当前机器制造一个看似兼容的结果；该能力应只存在于程序化测试 seam。
- **Web 顶栏健康状态与真实启动合同不一致**：原 health 只验证 `dsh --version` 能运行和宿主 Node 范围；版本 pin、Headless help anchor 和默认组合治理 row 漂移时仍可能显示“可用”，而真正创建任务时被完整 preflight 拒绝。

本轮 reviewer 已直接修复这些问题，并补齐回归测试：

1. Host Node 解析改为完整、稳定版本判断；prerelease、partial、malformed 一律 fail-closed；
2. `hostNodeCompatible/hostNodeBypassed` 与 `versionCompatible/versionBypassed` 分离；
3. CLI 将逃生口结论显示为“已旁路（无合同保证）”，不再称为兼容；
4. 删除公开 `--host-node-version`，只保留程序化测试注入；
5. Web health 使用与真正运行相同的完整 preflight，并设置短的 metadata probe 预算；
6. 顶栏不可用提示指向可执行的 `tekon provider preflight dsh-headless` 诊断动作；
7. 保持现有 RPC schema 不扩张，避免为一个 tooltip 增加新的公共合同字段。

外部事实也已变化：DeepSeek Harness 已发布 `0.1.2-alpha.4`。Tekon 继续精确 pin alpha.3 是合理的 fail-closed 策略，但必须称为 **tested pin**，不能称为当前上游版本。alpha.4 包含默认 `web_fetch`、Session API 强类型/按需读取、跨 Agent 消息和长会话优化等变化；在更新 L1 fixture、真实 L2 metadata probe 与带凭据 L3 smoke 之前，不应自动升 pin。

产品与架构主结论没有改变：Deliver 受控交付轨道已具备较强治理与测试证据；Collaborate 持续协作、single-owner Runtime、权威 Session 事实链、可证明的 shutdown/restart、RunPlan execute/resume authority、完整历史导出和模型上下文预算仍未闭环。

## 2. 最终判断

### 2.1 当前代码增量

用户整改快照 `13c27ebfdd473b7f2e866d6a1faf54c29c087801`：

- Core #372：首次执行 `completed/success`；
- CI #281：首次执行 `completed/success`；
- Root、Audit、CLI、Web 与 Chromium Playwright 均成功。

这证明用户整改没有引入当前自动化可见的构建或测试回归，但不证明测试覆盖外的兼容语义正确。

reviewer 代码快照 `ebd040e44f66e26c69af449584eb29a699d52726`：

- Core #392：首次执行 `completed/success`；
- Core unit：84 文件、1061 passed、3 skipped；
- Core e2e：8 文件、26 passed；
- CI #301：首次执行 `completed/success`；
- CLI unit：9 文件、64 passed；
- CLI e2e：3 文件、8 passed；
- Root build/typecheck、生产依赖 audit、Web build/typecheck/unit、Chromium Playwright 全部成功。

因此，**用户整改加上本轮 reviewer 修复通过当前代码合并门**。

### 2.2 产品成熟度

当前允许的成熟度表述是：

> Tekon v0.20.4 已形成测试覆盖较强、执行计划和风险边界较透明、Session 在线观察具有基础资源上限、可选 DSH Headless Provider 具备明确 tested-pin 与 Host Node fail-closed 预检的实验性受控交付执行与观察基础设施；Deliver 轨道可在有人监督下试用，但持续协作、单一 Runtime 权威、权威 Session 事实链、可证明的 shutdown/restart、完整历史导出与模型上下文预算尚未闭环。

仍不应描述为：

- 面向普通用户的稳定持续协作研发工作台；
- Web/CLI 多进程并发安全的 repo Runtime；
- 拥有 crash-safe durable inbox 和完整模型历史恢复的 Session 平台；
- 任意规模长会话、生产级 shutdown、restart resume 与完整历史导出已经闭环的服务；
- 已验证 DeepSeek Harness alpha.4，或完成真实模型调用 smoke 的 Provider；
- 可以把 DeepSeek Harness sandbox、approval 或 permission 当作唯一生产安全边界的系统。

## 3. 评审范围与方法

本轮覆盖：

- `99e006...` 到用户整改快照 `13c27eb...` 的完整增量；
- Core DSH bridge、Headless adapter、Host Node/version/capability preflight；
- CLI provider preflight、文本/JSON 合同、逃生口和真实子进程 e2e；
- Web API composition root、`project.health`、顶栏连接状态和 dsh-headless 实际启动路径；
- 用户手册、README、CHANGELOG、`current.md` 与上一轮报告；
- Session Composer、Session detail/right rail、审批与运行控制；
- Session dual-write、JobRunner shutdown、RunPlan、CLI/Web composition roots；
- 当前 PR 的 Core、Root、Audit、CLI、Web unit/build/typecheck 与 Chromium Playwright；
- DeepSeek Harness 官方 alpha.4 release、Headless、ACP、Safety、Session log export、Node engines 和组合配置。

判断原则：

1. CI 绿色只说明其覆盖合同成立，不等于未覆盖语义正确；
2. runtime admission、tested compatibility 和显式 risk bypass 必须分开；
3. 程序化测试 seam 不得泄漏成能伪造当前机器事实的公共 CLI 参数；
4. 健康状态必须与真正执行的 admission contract 同源，否则 UI 会制造错误承诺；
5. semver 范围必须正确处理完整版本、prerelease 和 malformed input；
6. 低风险兼容修复不能被描述成 Collaborate、Runtime 或 Session authority 已关闭；
7. tested pin 与 upstream latest 是两个独立事实；
8. 横向抽象新增必须证明服务于一个可用的纵向用户闭环。

本轮没有真实 `dsh` 二进制与 API key，没有独立部署实例，没有 Firefox/WebKit、屏幕阅读器或真实弱网设备。因此真实 Provider L2/L3、视觉回归、辅助技术和跨浏览器结论继续保持未验证。

## 4. 用户本轮整改逐项裁决

| 整改项 | 裁决 | 理由与边界 |
| --- | --- | --- |
| preflight 在 spawn 前检查 Host Node | 基本正确 | 关闭了 Node 20/22.12–22.18/23 用户先撞外部启动错误的问题；原版本判断不等价于 semver，本轮修复后成立。 |
| `DshHostNodeError` 与失败分类 | 通过 | 宿主不兼容与 dsh 不存在可区分；CLI 不再统一显示“未安装”。 |
| 精确 Host Node 逃生口 | 本轮修复后通过 | 只接受完整稳定版本的 exact acknowledgement；prerelease/malformed 不可旁路；结果保留 incompatible + bypassed 两个事实。 |
| 公开 `--host-node-version` | 不通过，已移除 | 它是测试注入而非真实诊断输入，可制造当前机器的假阳性。程序化 API 仍保留 seam。 |
| CLI 文本/JSON 输出 | 本轮修复后通过 | “已验证”“不兼容”“已旁路（无合同保证）”分开；结构化字段同时保留 admission 与 compatibility。 |
| Web 运行前 Host Node preflight | 通过 | `createEngine` 与实际任务启动路径使用完整 Core preflight。 |
| Web health Host Node 集成 | 不完整，已修复 | 原 health 只探版本和宿主，未探 pin/help/config；现与真实 admission 同源，并有 1 秒/metadata call 的短预算。 |
| 文档登记 | 部分完成 | Host Node 主事实已写入；`current.md` 仍绑定第十四轮，CHANGELOG 把 alpha.3 称为“官方当前基线”，而 upstream 已到 alpha.4。本报告和新的 current 负责纠正当前权威事实。 |

## 5. 本轮 reviewer 直接修复

### 5.1 让 Host Node 判定符合稳定 semver 语义

用户实现按 major/minor 进行判断：

```text
major >= 24
或 major == 22 && minor >= 19
```

但没有验证完整版本尾部。这会让：

```text
22.19.0-rc.1
24.0.0-rc.1
24.0garbage
```

进入错误分支。普通 npm semver 范围不会自动接纳 prerelease，因此实现不能只截取数字前缀。

修复后：

- 只接受 `v?major.minor.patch`；
- 可接受标准 build metadata；
- prerelease、partial 和 malformed 一律 fail-closed；
- 所有数值必须是 safe integer；
- 测试覆盖 Node 18/20/22.18/23、prerelease、partial、malformed、22.19、24+ 和 build metadata。

### 5.2 把 compatibility 与 admission/bypass 分离

原结果在精确逃生口命中后直接把 `hostNodeCompatible` 设置为 true。这样会抹掉最重要的风险事实：当前宿主并不满足上游合同。

现在 Core 返回：

```text
hostNodeCompatible
hostNodeBypassed
versionCompatible
versionBypassed
```

语义是：

- compatible：实际满足已验证合同；
- bypassed：不满足合同，但用户用 exact-value acknowledgement 明确承担风险；
- admission：是否允许继续进入 Provider 探测/运行。

CLI 为兼容旧自动化继续保留 `compatible` 作为 admission 结果，但新增字段才是兼容性权威；文本结论在任意 bypass 存在时显示：

```text
已旁路（无合同保证）
```

而不是“兼容”。

### 5.3 移除能伪造机器事实的公开参数

原 CLI 支持：

```text
tekon provider preflight dsh-headless --host-node-version 24.0.0
```

这会让 Node 20 的当前进程对一个虚构 Node 24 做检查并输出成功，违反 preflight 的用户心智。

修复后：

- 公共 CLI 不再接受该参数；
- `hostNodeVersion` 只保留在程序化函数中，供确定性测试与嵌入调用；
- CLI unit/e2e 明确断言旧参数被拒绝；
- 真实 CLI 测试检查 `process.versions.node`；不兼容 CI 宿主只可通过环境变量 exact acknowledgement 进入 fixture，而输出仍标记 bypass。

### 5.4 统一 Web 健康状态与执行合同

原 health：

```text
宿主 Node 合法
→ dsh --version 退出 0
→ 顶栏显示 available
```

实际 run：

```text
Host Node
→ exact tested pin
→ Headless help anchor
→ default-config required row ids
→ 才允许执行
```

这会导致当前官方 alpha.4 安装在 PATH 时，顶栏显示可用，但 Tekon alpha.3 tested pin 在真正运行时拒绝。

修复后 health 直接调用完整 `runDshPreflight()`：

- alpha.4 在未显式 version bypass 时显示 unavailable；
- help/config 漂移显示 unavailable；
- exact escape hatch 语义与实际运行一致；
- 每个 metadata probe 使用 1 秒预算，避免顶栏健康刷新被异常二进制长时间拖住；
- 真实 run 继续使用 5 秒默认预算；
- health RPC schema 不扩张；
- 顶栏 tooltip 指向 `tekon provider preflight dsh-headless` 获取完整诊断。

### 5.5 更新外部版本事实，但不盲目升 pin

截至本报告，DeepSeek Harness 最新 release/master 为：

```text
dsh-v0.1.2-alpha.4
4e84901e6471b79ec0338099867ebb4606d12bb5
```

alpha.4 的主要变化包括：

- parent 与 continuable child 间的双向消息；
- 长会话导航、滚动和渲染优化；
- Python SDK、Headless、ACP 与自定义 profile 默认提供 `web_fetch`；
- Session events 接口迁移到按需读取和强类型 seq/offset；
- 其它模型、工具和 UI 修复。

Tekon 使用的 Headless one-shot 基本合同和 required config row 仍可从官方源码找到，但默认工具与底层 Session API 已有变化。只做静态 anchor 对比不足以升级 tested pin。因此本轮保持 alpha.3 fail-closed，要求后续先完成：

1. alpha.4 L1 fixture 更新；
2. 真实 alpha.4 `--version/--help/--dump-default-config` L2；
3. 带 API key 的 one-shot 成功/失败/timeout/cancel/redaction L3；
4. `web_fetch` 默认启用后的网络、凭据和知情确认复核。

## 6. 产品逻辑评审

### 6.1 当前真正成立的产品：受控 Deliver

Tekon 当前最完整的用户价值仍是：

```text
需求输入
→ 服务端 canonical plan 与 digest
→ standard-delivery 角色链
→ worktree 隔离执行
→ Gate / Artifact / Audit / Review
→ 人工审批
→ Delivery / PR 准备
```

成立点：

- 默认 Composer 明确写出会启动完整受控交付；
- 计划读取失败或 digest 缺失时 fail-closed；
- dirty base、网络不受限和远端副作用需要显式确认；
- Gate、Artifact、Audit、readiness 和 delivery 有较强测试；
- Session/right rail 对 best-effort Event 缺失已有 snapshot fallback；
- Provider 版本、能力和 Host Node 合同不再只靠安装提示。

这部分可以继续作为有人监督的实验性真实试用轨道。

### 6.2 Collaborate 仍未形成产品闭环

普通用户仍不能在同一个 Session 中完成：

```text
继续输入
→ Provider 执行中的真实 semantic updates
→ follow-up / steer
→ 当前 prompt cancel
→ Runtime 重启后恢复
→ 在同一上下文中升级为 Deliver
```

`LegacyAgentDriver.events()` 仍等待 one-shot 完成后才遍历缓冲；`followUp()`、`steer()` 和 `resume()` 仍抛 `NotSupportedYet`。因此当前 Session 主要是：

- Run 观察面；
- 审批面；
- 治理证据面；
- 结果与历史投影面。

它还不是持续协作研发工作台。

### 6.3 产品信息架构仍存在双重心智

界面像会话产品，默认操作却是完整交付 workflow。文案已经诚实，但用户仍需要理解：

- Session 与 Run；
- Provider 与 Profile；
- Gate、Artifact、Readiness；
- 为什么一次输入会触发 PM/RD/QA/Reviewer；
- 为什么当前会话不能继续追问；
- 为什么顶栏凭据有效但某个 Provider 仍不可用。

在 Collaborate vertical slice 成立前，不应继续扩张 Profile、Automation 类型、Driver wrapper 或 workflow DSL；应优先缩短“输入 → 实时更新 → 取消/追问 → 恢复”的价值链。

## 7. UI 实现与 UX 交互评审

### 7.1 本轮改善

- dsh-headless 顶栏状态不再把“二进制存在”当作“真正可运行”；
- 当前安装 alpha.4、help/config 漂移或 Host Node 不满足时，都会显示 unavailable；
- 不可用提示提供可执行诊断命令；
- health 使用短预算，不让 60 秒周期刷新长期占住服务端调用；
- 没有为诊断 tooltip 扩张 RPC schema；
- 公共 CLI 不再暴露可伪造机器事实的测试参数；
- 文本与 JSON 都区分已验证和已旁路。

### 7.2 仍存在的 UX 缺口

1. **Provider 不可用的详情仍需转到 CLI**  
   顶栏给出行动入口，但 Web 内没有展示版本、Host Node、help/config 分项结果。这是避免扩张当前 RPC 的保守选择；长期可建立正式 Provider Diagnostics 页面，而不是向 health tooltip 零散加字段。

2. **完整历史没有行动入口**  
   截断提示之后仍没有“导出完整 Session”“生成审阅包”或“下载证据”的直接动作。

3. **UI 历史预算不等于模型上下文预算**  
   DOM 窗口、SSE replay 和 pending cap 已有边界，但模型 prompt 仍无 summary/compaction、token budget 和可审计 retention policy。

4. **连接凭据仍暴露底层部署心智**  
   Session token 对工程师可接受，但不是普通用户理想的默认身份体验。single-owner daemon/宿主应用最终应承担连接和身份生命周期。

5. **审批弱网加载仍不够明确**  
   snapshot 已知 awaiting-approval、Gate 详情仍在加载时，缺少专门的“正在读取审批上下文”状态。

6. **语言一致性仍有欠账**  
   一部分错误、flash 和空状态仍混合中文与英文领域词。

7. **可访问性证据仍是局部的**  
   Chromium 与少数组件测试不能外推为 Firefox/WebKit、屏幕阅读器、200% 缩放、对比度、reduced-motion 和真实弱网验收。

8. **缺少视觉回归**  
   极长标题、多审批卡、长 Artifact、错误堆叠、窄屏与系统字体变化仍主要依赖人工发现。

## 8. Runtime 与整体架构评审

### 8.1 P0：repo 级 single-owner Runtime 仍未实现

CLI 与 Web 仍分别创建并持有：

- SQLite connection / repositories / write queue；
- Session store / EventBus；
- JobRunner；
- SubprocessRegistry；
- Workflow/Automation executor；
- Git/worktree、Provider 与 shutdown 生命周期。

job owner、lease、CAS 和 process-local registry 只能保护部分 job row 和本进程子进程，不能完整 fence：

- 普通文件写；
- Git promotion；
- Artifact；
- Gate；
- Audit；
- Delivery；
- 外部 SDK 副作用。

长期正确方向仍是：

```text
repo-scoped daemon/service
→ repo lock
→ CLI/Web 客户端化
→ 统一 Job、Git、DB、Provider、Automation、Delivery 与 shutdown authority
```

### 8.2 P0：Shutdown 仍不能证明真正 quiescent

JobRunner 当前有：

- 停止轮询；
- 等待 active poll；
- settle window；
- abort controller；
- registry kill；
- hard deadline；
- DB closed fence。

这些机制能降低风险，但 hard deadline 后，不合作 executor 仍可能继续：

- 执行 JavaScript；
- 写普通文件；
- 运行 Git；
- 使用未注册子进程；
- 停留在外部 SDK 内。

完整闭环需要 executor worker/process 隔离、真实 kill/join、generation fencing、checkpoint/flush 和 crash/restart 故障注入。

### 8.3 P0：Session Event 仍是 best-effort projection

当前语义仍是：

```text
领域表 / Audit 先写成功
→ best-effort append session_event
→ 失败记录或静默跳过
```

找不到 Session、append 失败或没有映射时均可缺失。它适合 UI observation projection，不足以独立承担：

- durable inbox；
- 权威模型历史；
- prompt claim/processed/retry；
- crash replay；
- fork/resume；
- restart recovery。

必须明确选择：

```text
A. authoritative append-only Session log + projections
```

或：

```text
B. 领域事实/transactional outbox 永久权威，Session 明确定义为可重建投影
```

不能继续让同一个 best-effort log 同时承担未来权威历史的暗示。

### 8.4 P1：RunPlan 仍不是 execute/resume 唯一事实

RunPlan 已包含角色链、Gate、阶段、Agent、Profile、超时、模板身份和 digest，但尚未完整绑定：

- Demand identity/version/hash；
- mode；
- base revision；
- workspace physical identity；
- resolved Provider config；
- permission/network acknowledgement；
- expected Artifacts；
- executable node plan。

`RunPlanContext` 接受 mode，但 projection/digest 没有保存 mode。执行与恢复仍从模板、SQLite 和 Provider snapshot 重新拼装事实。因此 digest 可以保护部分 preview→start 漂移，但不是完整执行权威。

### 8.5 P1：完整历史与模型上下文预算仍缺

在线观察已具备：

- backward cursor；
- replay event/byte budget；
- Session pending event/byte cap；
- workspace pending frame/byte cap；
- heartbeat backpressure；
- 页面窗口与 truncation 提示。

仍缺：

- server-streamed complete-history export；
- live flush/snapshot 一致性边界；
- Session/subsession/Artifact manifest；
- 模型 summary/compaction；
- UI、导出和模型 prompt 的统一 retention policy；
- 真实大规模与故障矩阵；
- 容量指标与告警。

## 9. DeepSeek Harness 最新对齐

### 9.1 版本事实

- Tekon tested pin：`0.1.2-alpha.3`；
- upstream latest：`0.1.2-alpha.4`；
- upstream master/release commit：`4e84901e6471b79ec0338099867ebb4606d12bb5`。

因此正确状态是：

```text
Tekon tested pin = alpha.3
DeepSeek Harness latest = alpha.4
```

精确 pin 落后一个 prerelease 并非错误；把 tested pin 写成 upstream current 才是错误。

### 9.2 Headless 继续保持 Goal-only

官方 Headless 仍是：

- 一次 invocation 处理一个 task；
- reasoning delta 写 stderr；
- final assistant message 写 stdout；
- 任务完成后退出；
- 没有 interactive follow-up；
- 首 token 前没有 heartbeat。

因此继续将 `dsh-headless` 限制在 experimental Goal/one-shot 场景是正确的，不应把 stdout 最终文本包装成持续协作流。

### 9.3 alpha.4 不应盲目放行

alpha.4 虽然保留 Headless one-shot 基本入口，但包含行为和底层合同变化：

- Headless/ACP 等 profile 默认 `web_fetch`；
- Session event API 强类型化并转向按需读取；
- 跨 Agent follow-up/message 能力增强；
- 长会话和连接行为变化。

这些变化影响 Tekon 的网络披露、安全审计、L1 fixture 和未来 ACP 集成。正确流程是先验证，再改 tested pin；本轮 Web health 对 alpha.4 显示 unavailable 正是 fail-closed 的预期行为。

### 9.4 ACP 仍是持续协作的优先 vertical slice

官方 ACP 已提供：

- persistent `session/new/list/resume/close`；
- one prompt at a time；
- prompt-owned cancel；
- semantic execution updates；
- permission request；
- model/reasoning configuration；
- ordered update drain；
- quiescent close 与 persistence flush。

建议独立验证：

```text
owned ACP subprocess
→ initialize
→ session/new
→ prompt
→ semantic updates
→ prompt cancel
→ quiescent close
→ process restart + session/resume
```

不要把 ACP 强塞进现有 one-shot `AgentAdapter`，也不要先设计一个覆盖所有 Provider 的通用持续会话框架。

### 9.5 Session export 可直接借鉴

官方 session-log-export 的可借鉴边界：

- `HEAD` preflight；
- Host 流式生成 ZIP，不在浏览器/Node 内存整体缓冲；
- live Session 先 flush；
- 单 Session 同时一个 active export；
- root/subsession/attachment 边界；
- pre-stream 与 post-stream 失败分开。

Tekon 可先交付只读导出，不必等 authoritative log、ACP 和 compaction 全部完成。

### 9.6 Harness 不能成为唯一安全边界

官方 Safety 仍明确：DeepSeek Harness 是未经安全审计的 developer preview。sandbox、approval 和 permission controls 只能降低风险，不能保证隔离，也不能作为不可信 workload 的唯一安全控制。

Tekon 必须继续保留：

- least privilege；
- OS/container/VM 隔离；
- host-side network policy；
- credential minimization/redaction；
- workspace scope；
- command/artifact/audit evidence；
- human approval；
- 明确 experimental 披露。

## 10. 代码实现与测试质量

### 10.1 正向判断

- Host Node、DSH version、help/config contract 和 run admission 现为一条清晰 fail-closed 链；
- 公共 CLI 与程序化测试 seam 已分离；
- 文本/JSON 都能表达 tested/bypassed；
- Web health 与实际 run 使用同一 Core preflight；
- health 与 run 使用不同、合理的 metadata timeout budget；
- RPC schema 未因临时 tooltip 需求扩张；
- Core/CLI/Web 都有针对性回归；
- 当前最终代码快照的所有现有自动化门成功。

### 10.2 仍需收敛的实现热点

1. **`command-gateway.ts` 仍过重**  
   同一文件承担 policy、env、spawn、process group、redaction、progress、filesystem sampler、timeout 和 stream settle。下一步应先抽纯 timeout state machine 与可注入 clock，不要继续增加 timer 特判。

2. **DSH bridge 仍依赖字符串锚点**  
   对开发预览 CLI 来说合理，但 help 文案和 config row 只能证明 metadata surface；不能替代真实模型执行。

3. **escape hatch 的环境变量是进程级全局状态**  
   Web/CLI 一旦设置，会影响同进程所有任务。长期应把 acknowledged compatibility exception 记录进 Provider configuration snapshot 和 Audit，而不是只依赖环境变量。

4. **health cache key 不包含 Provider 环境指纹**  
   60 秒 TTL 内 PATH、escape hatch 或安装版本变化不会立即反映。当前 TTL 尚可接受；正式 Provider Diagnostics 应支持显式刷新并展示 checked snapshot。

5. **测试仍有大量 Git default-branch hint 噪声**  
   不影响正确性，但降低 CI 日志信噪比。可在 fixture 中显式 `git init -b main`，不要通过全局隐藏 stderr 解决。

6. **没有真实 static lint**  
   当前所谓 lint 仍等价于 TypeScript typecheck；format 历史欠账也较大。

## 11. 是否存在过度实现或过度设计

当前横向能力已经包括：

```text
AgentAdapter / AgentDriver / LegacyAgentDriver
Provider Registry / DSH bridge / preflight
Workflow / Role / Gate / Artifact / Audit
JobRunner / Session projection / SSE
Profile / Automation / Goal / Readiness / Delivery
CLI / Web 两套 composition root
大量阶段计划、ADR、评审报告和整改方案
```

这些机制多数有局部合理性，但仍领先于最小持续协作纵向闭环：

```text
同一 Session 继续输入
→ Provider 执行中的真实更新
→ 用户取消或转向
→ Runtime 重启后恢复
→ 升级为 Deliver
```

当前主要过度风险不是某个类“写得太抽象”，而是：

> 横向机制、兼容矩阵和评审文档持续增加，纵向用户价值链仍缺。

冻结原则应继续执行。除非直接服务以下主线，否则暂停新增 Profile、Automation job、Driver wrapper、展示事件和 Workflow DSL：

```text
single-owner Runtime
→ executor 隔离
→ authoritative Session / durable inbox
→ persistent Provider stream
→ follow-up / prompt cancel / resume
→ Collaborate → Deliver
→ RunPlan authority
→ export / compaction / retention
```

评审资料也应保持一轮一报告；不得继续向旧报告叠加当前裁决。`current.md` 是唯一稳定入口，CHANGELOG 只记录版本变化。

## 12. 问题清单

| ID | 严重度 | 状态 | 问题 |
| --- | --- | --- | --- |
| P0-ARCH-01 | P0 | 未关闭 | CLI/Web 缺 repo 级 single-owner Runtime authority。 |
| P0-ARCH-02 | P0 | 部分完成 | abort/kill/hard deadline/DB fence 不保证 executor、Git、普通文件和 SDK 已 quiescent。 |
| P0-DATA-01 | P0 | 未关闭 | Session Event 是 best-effort projection，不是 durable inbox/权威模型历史。 |
| P0-PRODUCT-01 | P0 | 未关闭 | 真实 streaming、follow-up、steer、prompt cancel、restart resume 与 Collaborate→Deliver 未闭环。 |
| P1-PLAN-01 | P1 | 部分完成 | canonical RunPlan 尚未成为 execute/resume 唯一事实，mode/Demand/base/workspace/Provider/权限/网络/Artifacts 未完整绑定。 |
| P1-SESSION-01 | P1 | 部分完成 | 在线 replay/pending 有边界；完整导出、compaction、retention、规模和故障矩阵仍缺。 |
| P1-DSH-01 | P1 | 部分完成 | tested pin alpha.3，upstream latest alpha.4；缺真实 alpha.3/alpha.4 L2/L3 smoke。 |
| P1-DSH-02 | P1 | 部分完成 | 逃生口可审计性不足；环境变量未进入 Provider snapshot/Audit。 |
| P1-GOV-01 | P1 | 未关闭 | `main` 未保护，required status checks enforcement 关闭。 |
| P1-A11Y-01 | P1 | 未关闭 | 缺全站 screen reader、Firefox/WebKit、缩放、对比度与真实弱网验收。 |
| P1-PROCESS-01 | P1 | 未关闭 | PR 体量过大，审阅、二分、迁移和回滚风险高。 |
| P2-DSH-01 | P2 | 本轮修复 | Host Node 判断接受 prerelease/partial/malformed，未等价实现稳定 semver。 |
| P2-DSH-02 | P2 | 本轮修复 | Host Node escape 抹掉真实 incompatible 状态。 |
| P2-DSH-03 | P2 | 本轮修复 | version escape 被显示成正式兼容，而非 unsupported admission。 |
| P2-CLI-01 | P2 | 本轮修复 | 公开 `--host-node-version` 泄漏测试 seam，可伪造当前机器兼容结果。 |
| P2-UX-01 | P2 | 本轮修复 | Web health 只探 `--version`，与真实 pin/help/config admission 不一致。 |
| P2-UX-02 | P2 | 本轮修复 | dsh unavailable 缺可执行诊断入口；现指向 provider preflight。 |
| P2-DOC-01 | P2 | 本报告/current 修复 | 第十四轮入口未反映本轮代码和 upstream alpha.4。 |
| P2-DOC-02 | P2 | 待后续清理 | CHANGELOG 将 alpha.3 写成“官方当前基线”；历史版本记录不应承担动态 upstream latest 事实。 |
| P2-CODE-01 | P2 | 未关闭 | 没有真实 JS/TS static lint gate，format debt 较大。 |
| P2-CODE-02 | P2 | 未关闭 | `command-gateway` 职责过重，timeout state machine 未独立。 |
| P2-CI-01 | P2 | 未关闭 | Git fixture default-branch hint 造成日志噪声。 |

## 13. 建议实施顺序

1. **仓库治理小改动**  
   为 `main` 启用 ruleset/branch protection，至少要求 Core 与 CI 成功后才能合并。

2. **single-owner daemon + repo lock**  
   统一 Job、Git、worktree、subprocess、DB、Automation、Delivery 和 shutdown authority。

3. **executor process/worker 隔离 + restart contract**  
   真实 kill/join、checkpoint、generation fencing、late-write 与 crash fault injection。

4. **authoritative Session / transactional outbox + durable inbox**  
   决定事实源、claim/processed/retry、模型历史、迁移和投影。

5. **DeepSeek ACP real-provider vertical slice**  
   persistent session、semantic updates、prompt cancel、quiescent close、restart resume。

6. **Collaborate → Deliver**  
   同一 Session follow-up/steer，计划升级和人工审批点。

7. **canonical RunPlan 成为 execute/resume authority**  
   绑定 Demand、mode、base/workspace、Provider、权限、网络、Artifacts 和 executable plan。

8. **完整历史导出 + 模型上下文预算**  
   Host streaming export、flush/snapshot、manifest、subsession/artifacts、summary/compaction 和 retention。

9. **DSH alpha.4 验证与 Provider exception audit**  
   L1/L2/L3、默认 `web_fetch` 网络边界、escape acknowledgement snapshot/Audit。

10. **a11y、lint/format 与 release engineering**  
    多浏览器/辅助技术、真实 linter、SBOM/provenance、构建物签名和统一发布流程。

## 14. 合并、发布与证据边界

当前代码合并门通过只能证明：

- `ebd040e...` 在现有自动化合同下可构建、类型正确并通过测试；
- Host Node/version/capability preflight 的已覆盖语义成立；
- CLI 不再公开 host-version 测试注入；
- Web health 与 run admission 使用同一完整合同；
- tested compatibility 与 bypass admission 已在文本/JSON 中区分；
- v0.20.4 既有 Deliver、Session/SSE 和治理回归没有被本轮修改击穿。

它不能证明：

- Web/CLI 两个 Runtime 并发无 Git/文件副作用冲突；
- 服务关闭后所有 executor、文件、Git 和 SDK 活动均已终止；
- Session log 可完整恢复模型上下文；
- 任意规模会话都有稳定资源预算；
- DSH alpha.4 已通过 Tekon 验证；
- DSH alpha.3 已完成真实 API smoke；
- Firefox/WebKit、屏幕阅读器和真实弱网设备已通过；
- 普通用户持续协作产品已经完成。

PR #11 已超过适合逐行审阅和低风险回滚的规模。最终建议 squash merge；后续架构主链路必须拆成独立小 PR。本轮未执行 merge、release、deploy 或仓库 ruleset 修改。

## 15. 参考资料

### Tekon

- [当前权威入口](current.md)
- [Runtime authority ADR](../technical/adr-0001-runtime-authority-and-collaborate.md)
- [第十四轮报告](2026-09-01-tekon-product-runtime-harness-fourteenth-review.md)
- [`SessionComposer`](../../packages/web/src/client/components/sessions/SessionComposer.tsx)
- [`LegacyAgentDriver`](../../packages/core/src/runtime/legacy-agent-driver.ts)
- [`Session dual-write`](../../packages/core/src/session/dual-write.ts)
- [`JobRunner`](../../packages/core/src/session/job-runner.ts)
- [`RunPlan`](../../packages/core/src/workflow/run-plan.ts)
- [`DSH bridge`](../../packages/core/src/runtime/dsh-bridge-probe.ts)
- [`DSH Headless adapter`](../../packages/core/src/runtime/dsh-headless-adapter.ts)
- [`CLI provider preflight`](../../packages/cli/src/commands/provider.ts)
- [`Web project health/run`](../../packages/web/src/server/api/routers/project.ts)
- [`TopBar`](../../packages/web/src/client/layouts/TopBar.tsx)

### DeepSeek Harness 官方

- [alpha.4 release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.4)
- [alpha.4 root Node engines](https://github.com/deepseek-ai/deepseek-harness/blob/4e84901e6471b79ec0338099867ebb4606d12bb5/package.json)
- [Headless](https://github.com/deepseek-ai/deepseek-harness/blob/4e84901e6471b79ec0338099867ebb4606d12bb5/packages/bundle/headless/README.md)
- [Headless composition](https://github.com/deepseek-ai/deepseek-harness/blob/4e84901e6471b79ec0338099867ebb4606d12bb5/packages/bundle/headless/cordis.patch.yml)
- [Base composition](https://github.com/deepseek-ai/deepseek-harness/blob/4e84901e6471b79ec0338099867ebb4606d12bb5/packages/bundle/base/cordis.patch.yml)
- [ACP](https://github.com/deepseek-ai/deepseek-harness/blob/4e84901e6471b79ec0338099867ebb4606d12bb5/packages/acp/acp/README.md)
- [Session log export](https://github.com/deepseek-ai/deepseek-harness/blob/4e84901e6471b79ec0338099867ebb4606d12bb5/packages/session-query/session-log-export/README.md)
- [Safety](https://github.com/deepseek-ai/deepseek-harness/blob/4e84901e6471b79ec0338099867ebb4606d12bb5/SAFETY.md)

### Semver

- [npm/node-semver README](https://github.com/npm/node-semver#prerelease-tags)

## 16. 主 Agent 四路循环评估批注（2026-09-02，基于 HEAD `1283024`）

本节是主 Agent 收到本报告后，按既定循环（同步上游 → 四路独立评估 → 达成一致 → 批注 → 整改）产出的交叉评估记录。评估基线：`1283024`（含 reviewer 修复 `ebd040e` 及后续提交），DSH 上游 `4e84901e6`（alpha.4，pull 后确认）。

### 16.1 四路评估结论（一致）

| 评估路 | 结论 | 关键证据 |
| --- | --- | --- |
| reviewer 修复落地核查 | **6 项 P2 修复全部成立，但发现 1 项阻断** | semver 严格解析（`parseStableNodeVersion` + safe integer）、compatible/bypass 四字段分离、`--host-node-version` 已移除且有拒绝断言、Web health 调用完整 `runDshPreflight` 且有 1s 预算、顶栏诊断入口指向 `tekon provider preflight`。**阻断项**：`75ac0c5` 提交的 `dsh-bridge-host-node.test.ts` 引用不存在的导出（`isDshNodeVersionSupported`、`DshNodeVersionGateError`、`nodeVersion` 参数），12 个测试全部失败，Core #397 首次执行 `failure` |
| DSH 官方对齐复核 | **alpha.4 发布事实成立，合同锚点零漂移** | 上游 `git tag --points-at HEAD` = `dsh-v0.1.2-alpha.4`；Tekon 依赖的 4 个锚点（Headless one-shot、help anchor、5 个 plugin row ids、Node engines）在 alpha.3→alpha.4 间均无变化；alpha.4 默认启用 `web_fetch`（`tool-web.config.fetch: true`），不经 approval 审批，对 Tekon `acknowledgeUnrestrictedNetwork` 知情确认语义有加重影响 |
| 测试与 CI 健康 | **Core #397 失败，CI #306 成功但不含 Core unit** | `13c27eb` Core #372/CI #281 首次成功；`ebd040e` Core #392/CI #301 首次成功；`1283024` Core #397 **failure**（`dsh-bridge-host-node.test.ts` 12 项失败），CI #306 success（不含 Core unit）。本地 core 93 文件/1087 passed/12 failed/3 skipped，CLI 64 passed，Web 359 passed |
| 事项清单与冻结项 | **本轮可关闭 5 项，架构冻结项维持** | P2-DOC-02（CHANGELOG "官方当前基线"）、P2-CI-01（13 处 git init hint）、current.md 快照绑定、手册 HTML 同步、TopBar 注释恢复；P1-DSH-01（alpha.4 升 pin）、P1-DSH-02（逃生口审计）留独立 PR |

四路对本报告的裁决无异议：reviewer 的 6 项 P2 修复方向正确、落地完整；alpha.3 tested pin 维持 fail-closed 是合理的；架构冻结项（§13）不在本轮扩张。

### 16.2 本轮决策与整改

1. **删除失效测试文件**（阻断项）：`dsh-bridge-host-node.test.ts` 与 `dsh-bridge-probe.test.ts` 中的测试完全重复，且引用了不存在的导出。直接删除，不保留冗余。
2. **P2-DOC-02**：CHANGELOG 3 处"官方当前基线"改为"（tested pin）"，历史版本记录不承担动态 upstream latest 事实。
3. **P2-CI-01**：13 处 `git init` 加 `-b main`，消除 default-branch hint 噪声。
4. **文档同步**：CHANGELOG 补登记第 15 轮 reviewer 修复；手册 HTML 补全 tested pin 版本号；TopBar 恢复误删的 5 段注释。
5. **current.md 快照绑定**：整改完成后更新为最新 HEAD。

不纳入本轮的事项（维持报告判定）：

- **P1-DSH-01（alpha.4 升 pin）**：需完成 L1 fixture 更新 → L2 metadata probe → L3 credentialed smoke → `web_fetch` 网络复核，当前环境无 `dsh` 二进制与 API key，留独立 PR；
- **P1-DSH-02（逃生口审计）**：涉及 Provider snapshot schema 扩展与 Audit 事件写入，跨模块状态变更，留独立 PR；
- **P0 架构主线**：按 §13 顺序拆独立 PR；
- **`main` 分支保护**：人工 GitHub 配置，用户已决策暂缓。

### 16.3 验证承诺

本轮整改完成后，将重新执行：core 全量测试（含删除失效文件后的回归）、CLI e2e、Web Playwright、UI 截图核对，并由 reviewer 循环审查至放行；最终提交到本 PR 并清理临时产物。
