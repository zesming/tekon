# Tekon 第二十三轮复审：以远端实现和可复现证据重做

日期：2026-09-05。对应 [PR #11](https://github.com/zesming/tekon/pull/11)。产品版本：**0.21.0**。

| 快照 | 本轮实际核验结果 |
| --- | --- |
| 用户远端基线 | `34f1794b27709be84a741cced0d028c7e2cb6da8` |
| 本轮代码修复 | `0e36f4d03f70c31e18fa4e0f2e2299800dfdc33c`，已非强制推送到原 PR 分支 |
| 修复提交的 Core | [#435](https://github.com/zesming/tekon/actions/runs/33933885693)，completed / success |
| 修复提交的 CI | [#344](https://github.com/zesming/tekon/actions/runs/33933885742)，completed / success；9 个 Job 均成功 |
| 文档提交 | 本报告绑定上面的代码快照；包含报告自身的最终 Head 与 Checks 由 PR 展示，不制造自引用 |
| DSH tested pin | `0.1.2-alpha.3`，本轮没有升级 |

**结论：不能给出“整仓无问题通过”。本轮确认并修复三个具体缺陷，修复提交的自动化门禁全部成功；RunPlan 的执行字段绑定、原子且幂等的启动仍有重要缺口。** Deliver 可以按明确限制进行工程试用，但不能由测试全绿推导为稳定持续协作产品验收通过。

此前对话中“第二十三轮已推送”、不存在的下载文件、错误的 v0.20.6 定位及所谓 `onWarn` 已修复，均不作为证据。本报告替代那次未交付结论；本轮实际修改不包含 `onWarn`。

## 1. 范围、方法与证据边界

本次是全仓结构与关键用户/执行链的风险评审，不声称逐行证明所有文件正确。重点复核最新增量，并沿调用链检查 CLI/Web 发起、计划、Provider、Session/Job、文件清理、观察界面和 CI。依据是指定 SHA 的代码、内部说明和官方资料；每项区分事实、影响判断和建议。

| 维度 | 主要依据 | 本轮结论 |
| --- | --- | --- |
| 产品逻辑 | README、当前评审入口、用户手册、CLI run、SessionService | Deliver 定位诚实；轻量协作是明确缺项，不是每次补丁都必须实现的前提 |
| UI 实现 / UX | TopBar、两个发起入口、useQuery、QueryCache、RPC 合同、现有 e2e | Credential/Provider 已拆分；错误可见性和请求生命周期仍需收敛 |
| 框架 / 数据 | WorkflowEngine、RunPlan、ExecutionPlan、SessionService、Web/CLI 组合根、JobRunner | 摘要与可执行事实没有完全同构；启动不是原子事务 |
| Provider / DSH | dsh-headless-adapter、dsh-bridge-probe、包依赖、上游发布和 CLI reference | 当前是可选外部 Headless 桥接，不是 DSH 接管 Tekon 内核 |
| 工程质量 | 四档 Node CI、audit-production、新增回归测试、安装/启动路径 | 选定边界有持续验证；审计依赖集合与实际运行集合不完全重合 |
| 过度设计 | 两套发起状态、重复缓存/事实来源、评审文档规则 | 优先删除重复事实和失效机制；不以“缺少某种框架”或文件行数判定缺陷 |

本地没有可安装全仓依赖的网络环境，不能运行完整 `pnpm test`、React 页面或真实 DSH。本轮没有新的 Tekon 截图式视觉审计、真实屏幕阅读器、Windows、模型调用、崩溃/断电或负载测试。没有独立 subagent，采用第二遍保守自检；不把自检称为独立评审。

本地定向验证直接转译已核对 Git blob SHA 的源码，在缺失依赖的导入边界使用替身；文件轮换使用真实文件系统，请求交替使用真实 Promise。它只证明所测分支，不替代集成验证。随后实际远端 CI 完成了构建、类型检查、Core、CLI unit/e2e、Web unit、Chromium、依赖审计和四档 Node 验证。

## 2. 本轮用户整改：应当关闭的旧结论

1. **物理清理已停用。** Web `project.clean` 完成认证、确认参数和 scope 校验后记录 `project.clean.suspended`，再返回 409；审计失败返回固定 500。CLI `tekon clean` 不再删除 worktree。短期误删入口已关闭，完整 export/retention/purge 留在 #18。不能继续写“仍在裸删除”。依据：[项目路由][S2]、[CLI clean][S16]。
2. **顶层 planDigest 已接线。** SessionService 将非空值传入 prepareRun，Engine 在目录、数据库和 Audit 写入前检查 input/options/canonical digest 一致性。旧的“死参数”结论关闭；独立 snapshot 与执行计划的完整绑定仍未关闭。依据：[SessionService][S7]、[Engine][S6]。
3. **凭据检查不再等待 DSH。** `project.health` 与受认证的 `project.providerHealth` 分开，后者有 60 秒 TTL、128 个已完成结果的缓存上限和同 key single-flight。TopBar 异步获取 Provider 状态；这是实际 UX 改善，不应回退为“仍耦合”。依据：[项目路由][S2]、[Provider health][S17]、[TopBar][S11]。
4. **Node floor 已精确化。** `20.19.0 / 22.12.0 / 22.19.0 / 24.x` 与解析版本断言一致。通过这些 runner 只证明这个集合，不证明开放 engines 上界中的全部版本。依据：[CI][S14]。
5. **Audit 不再无差别重试。** 有效 advisory 优先失败，零漏洞但非零退出也失败；无有效结果的部分传输错误才有一次重试。应保持小而可解释的规则，不再扩展成通用错误分类平台。依据：[Audit 脚本][S18]。

这些关闭项是基线 v0.21.0 已有实现，不计为本轮 Reviewer 修复。

## 3. 本轮已修复的三个缺陷

### R23-01 · P1：普通/Goal `--dry-run` 被静默忽略

**事实与复现。** CLI 解析器接受 `--dry-run`，只有 `--dynamic` 分支读取它。执行 `tekon run "仅预览" --dry-run --agent mock` 或再加 `--goal`，原实现仍会经过初始化并进入真实 Run 路径。用户表达“不要执行”却可能触发持久化与 Provider，是命令语义错误，不是功能建议。依据：[基线 run.ts][B1]。

**修复。** 在仓库路径解析、ensureInitialized 和 Provider 构造前，拒绝非 dynamic 的 dry-run，返回 `DRY_RUN_UNSUPPORTED`；不临时设计第二套 preview。既有 `--dynamic --dry-run` 继续使用原来的动态预览。这里不承诺动态预览完全不写文件：它仍可能生成预览产物或处理 `--save-as`。

**回归。** 新增 [CLI 真进程 e2e][T1]，分别验证 Workflow/Goal 返回 exit 1、stdout 为空、错误码准确且空目录没有初始化产物。现有动态预览 e2e 保留。远端 CLI Job 已成功。

### R23-02 · P2：凭据轮换后健康状态复用陈旧结果

**事实与复现。** 原凭据缓存以 session 文件路径和请求 token 为 key，在读取当前文件前返回。先缓存 A=有效、B=无效，再把服务端 token 改成 B，同一缓存窗口内仍报告 A=有效、B=无效；文件删除或损坏也可能保留“有效”。其他受认证 RPC 会重新校验，所以这是状态一致性/可用性缺陷，不声称形成认证绕过。依据：[基线项目路由][B2]。

**修复。** 删除这层便宜本地文件校验的缓存，每次 health 读取当前配置；保留独立且昂贵的 Provider 探测缓存。比再加文件 watcher、mtime key 或全局失效总线更简单。前端仍按自己的刷新节奏请求，不能将本次修复描述为配置一变页面立即推送更新。

**回归。** 新增 [凭据轮换测试][T2]：正负缓存轮换、文件删除、JSON 损坏、缺失 token，并验证 credential health 不调用 Provider。远端 Web unit 已成功。

### R23-03 · P2：旧请求结算可误删新请求的 single-flight 登记

**事实与复现。** A 在 key K 上运行，清除登记后启动 B；A 的 finally 无条件 `delete(K)`，会删除 B 的登记，随后请求不能再加入 B，产生重复请求和竞争窗口。成功和失败两条结算路径都存在。依据：[基线 QueryCache][B3]。

**修复。** 只有 `inFlight.get(key) === promise` 时才清理。并把 `clearAllInFlight` 的说明改正为“清除登记”，它不是 Abort，也不是迟到写入的隔离屏障。

**回归。** 新增 [请求归属测试][T3]，覆盖 A resolve/reject × 全局/scope 清理，以及正常完成不影响另一 scope。远端 Web unit 已成功。

**未扩大承诺。** `useQuery` 仍可能在组件 generation 检查前写共享缓存；AbortController 也没有传给 fetcher。本次只修复登记的归属，不宣称整个认证切换和请求取消链已闭环。依据：[useQuery][S4]。React 官方也将异步结果的过期清理作为 Effect 数据请求的独立问题，而不是只清一个 Map：[React useEffect][E4]。

## 4. 本轮重要未修复项：计划确认没有覆盖实际执行

### R23-04 · P1：改变 gate.commandRef，digest 不变（已复现）

**代码事实。** RunPlanGate 只投影 nodeId、role、type、requiresHumanApproval 和 timeoutMs；没有 commandRef。RunPlanContext 接受 mode，但最终摘要对象没有 mode。执行计划则从 template 独立生成，保留 gates、输入、输出和依赖。依据：[RunPlan][S5]、[ExecutionPlan][S19]。

本地用 blob `16ad978dabd637b2da53aabc17d00d57726d7f9f` 的真实 `projectRunPlan`，构造两个其余字段相同的模板，仅将 gate.commandRef 从 build 改成 test。结果：

```text
commandBefore = build
commandAfter  = test
digestBefore  = f56efe0d0fc9361c32ad30741974b6ad7c5180dd1489ed6a2bc4ceaf18b3d117
digestAfter   = f56efe0d0fc9361c32ad30741974b6ad7c5180dd1489ed6a2bc4ceaf18b3d117
commandChangeInvisible = true
modeChangeInvisible    = true
```

这不是 SHA-256 碰撞，而是被哈希的投影遗漏字段。本轮复现的是摘要不可辨识性，没有启动真实修改命令或宣称已成功攻击。

**影响判断。** 预览后、自定义模板提交前，保持模板 id/version 不变地修改被遗漏字段，现有 digest 无法据此要求用户重新确认。“一次加载模板”已关闭提交内部的文件读取竞态，但不能补上预览与提交之间的摘要覆盖缺口。持久化的 ExecutionPlan 与用户确认的摘要也不能据此证明相同。

**相关缺口。** prepareRun 仍独立接受 planSnapshot，没有校验它与 canonicalPlan 对应；直接 Core 调用可提供自洽摘要与另一份模板。这与已修复的 digest 参数透传不是同一问题。依据：[Engine][S6]。

**建议和验收。** 在 #20 下先做一个小切片：将规范化后的可执行模板内容纳入版本化 digest，校验 snapshot 来源；覆盖 commandRef、输入输出、依赖、mode 与模板内容变化的反向用例，预览过期必须拒绝并提示重试。后续再逐步绑定 demand/base/provider/approval，不要求一次构建庞大 RunAdmission 框架。旧 Run 的版本/摘要处理须明确，不能改 hash 算法后让历史静默失效。本轮未直接变更此合同，因此仍保留 P1，不给整体无条件通过。

### R23-05 · P1：启动持久化与重试仍不原子、不幂等

Engine 写入目录、Demand、Project、Run、Provider snapshot、执行节点和 Audit；SessionService 随后调用 onPrepared，再写 Workspace、Session、opening events 和 Job。任何中段失败可能留下半成品，超时后的重复提交可能创建另一 Run。代码存在顺序写入是事实；本轮未做逐阶段 SQLite 崩溃注入，具体故障发生率未知。依据：[Engine][S6]、[SessionService][S7]。

建议 #31 优先增加 requestId/幂等记录及数据库内的原子 admission；文件产物使用暂存与可恢复状态。SQLite 事务提供的是事务内数据库修改原子性，不会自动涵盖 Git、普通文件或外部命令。[SQLite 官方原子提交说明][E3] 支持该边界。不要把前端 latch 或每个 repository 各自排队误当成整个启动事务。

用户应获得稳定的“未创建 / 已受理且可继续观察 / 创建失败需恢复”状态和可定位 runId，避免只给一个可盲目重试的错误。

## 5. 产品逻辑、UI 与 UX：按真实旅程评估

**旅程 1：启动并连接。** `tekon ui`、令牌引导和连接面板已可供工程用户使用；Credential 不再受 DSH 延迟影响。剩余问题是 Provider 初始化与认证仍依赖外部 CLI，默认用户缺少“可用 Provider / 失败原因 / 下一步”的集中指引。可做小型就绪面板，不必先建设完整设置平台。依据：[README][S15]、[CLI Web 启动][S12]、[TopBar][S11]。

**旅程 2：输入并确认计划。** 默认“启动受控交付”的名称正确披露全链路成本；高级表单区分 Goal、mock、网络风险和额外设置。但两个入口复制了计划、摘要、准入、single-flight 与错误逻辑，过去多次漂移是提取共享逻辑的具体理由。共享提交 hook 与风险数据即可，保留简单/高级两种视觉层级；不要合成一个巨型表单。计划可信度优先于进一步扩展模板选择。

**旅程 3：观察、批准和完成。** Session 作为 Run 的观察与治理界面成立。应继续区分 Job 已结束、Workflow 等待审批、Run 已通过与交付已经创建，不能把一次模型回复或 mock 产物当作真实交付。现有局部 ARIA/e2e 证据值得保留；本轮没有新截图，不对对比度、像素布局、触控、真实读屏作通过裁决。

**旅程 4：失败、重试、历史。** 启动原子性决定能否安全重试；历史分页上限不等于完整证据导出，也不等于模型上下文预算。先提供只读导出及明确截断提示，再讨论压缩和删除。清理暂不可用应继续保留，不能为释放磁盘重新开放无协调删除。

**TopBar 的具体残余问题。** Provider RPC 的 loading/error 没有单独呈现：待检查、检查失败、可用可能都表现为没有附加警告。Provider 500 不应把有效凭据改成无效，这是正确的；但详情区应显示“检查失败 / 上次检查时间 / 重试”，不能让用户以为 Provider 已验证可用。服务端 60 秒完成后 TTL 与客户端固定 60 秒周期还可能让状态接近 120 秒才重新探测。它影响诊断，不替代真正的 Run admission。依据：[TopBar][S11]、[Provider health][S17]。

## 6. 框架架构：纠正“必须先大重构”的倾向

**当前不是 DSH 内核托管架构。** Core 依赖 SQLite、YAML、Zod，执行、Gate、Artifact、Audit、Session、Job 仍由 Tekon 自己编排；dsh-headless 是外部子进程 Adapter。可以说借鉴 Harness 思路并接入其 Provider，不能说上游已替 Tekon 提供持久会话、统一 Runtime 或恢复保证。依据：[Core 包][S20]、[DSH Adapter][S8]、[Web 组合根][S9]。

**单一执行所有者是需求，daemon 只是方案之一。** CLI/Web 独立组合根和任务 lease 需要验证跨进程行为；数据库 owner/CAS 不自动覆盖 Git 和普通文件。先加仓库级 owner guard、冲突提示及故障测试，必要时再把两端变成 daemon 客户端。没有 daemon 本身不是 P0，未经约束的并发副作用才是风险。

**权威事实只能有明确的一套。** 当前领域表为事实、Session events 为 best-effort UI 投影是可成立的过渡设计。不要既要求完整事件溯源，又要求独立领域表同等权威。持续协作前明确选择“领域事务 + outbox”或“权威日志 + 投影”；缺失的事件不能再承担恢复依据。依据：[SessionService][S7]、[Web 组合根][S9]。

**停止请求不等于已静止。** JobRunner 已有 lease、owner fencing、Abort 和有限等待，这些有效；要证明不合作执行器停止，还须验证实际子进程退出、未登记后代、文件写入和恢复的边界。先隔离真实长任务及确认 exit/join，再考虑更广的 worker 框架。Node 官方明确区分发送终止信号与进程实际终止：[child_process][E2]。本轮没有新跨进程故障注入，不将风险假说写成已观察的数据损坏。

**Project/Workspace 模型需澄清而非立即重建。** 每个 Run 新建 Project、物理仓库复用 Workspace，会增加项目查询与汇总的理解成本。先明确 Project 是稳定项目还是一次运行快照；只有验证重复身份确实影响查询/迁移后再合并。不要仅为了名称一致进行大规模 schema 重写。

## 7. DeepSeek Harness 官方对照与实施边界

本轮通过发布列表及 Tag ref 核验，最新发布为 **0.1.3-alpha.1**，发布时间 **2026-09-04 11:34:32 UTC**，Tag commit **d347e703908d0406b7a7ef80e3a0e594d86b2215**。[发布说明][E1] 引入生命周期 SessionHandle、每 Session 单写者锁、Session format v2 和代理环境支持，同时披露部分历史 Session 加载性能回退。它们是技术输入，不是立即升 pin 的理由。

[官方 CLI reference][E5] 规定 Headless 一次 invocation 处理一个 task，等待 quiescence/flush 后输出最终文本，reasoning 走 stderr。它仍不等于持久交互界面。参考还明确 workspace-write 不约束所有读取和网络，凭据有环境、credential 文件和 .env 的回退来源；非空 DSH_TELEMETRY_DISABLED 是硬关闭。Tekon 的 exact env、隔离 metadata workspace、正式子进程 telemetry opt-out 是合理措施，但不能称为 OS 级秘密隔离或完整网络限制。

| 对照项 | Tekon 现状与判断 | 最小后续动作 |
| --- | --- | --- |
| Headless 版本 | pin 仍为 alpha.3；本轮无真实模型调用 | 按 #17 分离源码/真实 metadata/带凭据验证，不追 prerelease 自动放行 |
| Launcher | basename=dsh 才执行运行时预检；改名 Wrapper/Windows shim 边界未闭环 | #28 显式区分 Provider 身份和启动方式；不要直接启用通用 shell |
| 凭据与代理 | 正式运行 exact env 不继承全部代理，worktree .env 回退仍可能生效 | #32 明确可信配置来源和脱敏证据，不恢复整份 process.env |
| 能力证据 | 外层命令白名单不等于 DSH 内部工具已经逐次受同一策略限制 | 区分声明、Provider 实施与宿主隔离，按真实 Provider 验证 |
| 持续协作 | Legacy one-shot 不能支持真正的同 Session 交互 | #14 做一次能力协商、prompt/update/cancel、结束确认、再次 prompt 的 ACP 切片 |

ACP 的取消是协议交互，不是收到 UI 点击就可判定完成；应验证 prompt 的终止响应和能力协商，不把提案中的 API 当成当前已实现合同。[ACP Prompt Turn][E6] 是协议依据。DSH Session storage 锁只覆盖其自身会话状态，不能替代 Tekon 对 Git/交付证据的并发约束。

## 8. 代码质量、供应链与过度实现

**实际启动依赖与审计集合不完全一致。** `tekon ui` 运行 Web 的 `node_modules/.bin/tsx src/server/index.ts`；tsx 和 Vite 在 Web devDependencies，而门禁只有 `pnpm audit --prod`。所以审计成功只说明其检查的生产依赖集合，不证明当前实际启动链全部经过审计。本轮没有发现或声称这些包存在新漏洞。建议编译/打包服务端，或明确把实际运行的开发依赖纳入审计；无需再增加复杂的重试基础设施。依据：[CLI Web 启动][S12]、[Web 包][S13]、[CI][S14]。

**值得保留的机制。** 精确版本 pin、fail-closed 风险确认、独立 Audit gate、真实 CLI e2e、关键响应式 smoke、Job fencing 和显式 HTML 人审交付均有用途。不能只凭文件长或文档多就删除。

**应当削减的重复。** 两份发起状态、独立输入摘要与 snapshot、多套事实再拼接、只为便宜本地读取加的全局缓存，是已经导致缺陷的复杂度。本轮删除 Credential verdict 缓存即为减法。响应式 Geometry Scanner 只保留不横溢、关键控件可达等高价值不变量；不要在测试里再实现浏览器布局引擎。核心判断是维护成本与缺陷收益，不是任意行数阈值。

**评审资料也应受控。** 本次只保留一个 Markdown 内容源、对应 HTML 人审版及 current 索引，不继续复制平行裁决。基线 PR 已有 173 commits/233 files；本轮必要修复按用户要求仍提交原 PR，但不要让新的平台化主线持续堆入同一分支。Squash 只能压缩提交历史，不能消除大差异的审阅风险。

## 9. 验证、交付与下一步

| 验证层 | 本轮实际结果 | 不可外推的内容 |
| --- | --- | --- |
| 原始源码身份 | 三份修复前源码的 Git blob SHA 与远端一致 | 不表示全仓已在本地克隆 |
| 本地定向回归 | 修改前 3 通过 / 10 失败；修改后 13/13 通过 | 导入边界替身，非全仓集成测试 |
| 本地 TypeScript | 六份修改/新增文件转译语法检查通过 | 不等于语义 typecheck |
| RunPlan 复现 | commandRef 与 mode 改变对摘要不可见 | 未启动真实执行，不是漏洞利用验证 |
| 远端代码提交 | Core #435、CI #344 均 completed/success | 绑定 0e36f4d，不预先声明后续文档 Head 状态 |
| CI #344 分项 | Root build/typecheck、Audit、四档 Node、CLI unit/e2e、Web unit/build/typecheck、Chromium 均成功 | 不替代 Windows、真实 DSH L3、读屏、负载/恢复测试 |

代码修改保持未合并的 v0.21.0，没有发行新版本。README/用户手册已有“动态 workflow dry-run”范围，本次恢复该合同，并在本报告记录 `DRY_RUN_UNSUPPORTED`；未重写这些手册、安装脚本、AGENTS 或历史 CHANGELOG。凭据与缓存修复不增加用户配置项。旧评审正文保留为历史快照，current 和 PR 描述改为本报告。

建议后续只推进三个可验收工作包：**先补 RunPlan 可执行字段与 snapshot 校验；再做原子/幂等启动和明确重试结果；最后选一个 Provider 完成最小持久协作纵向链路。** Runtime 隔离、导出与支持平台按这些链路的真实需求补齐，不把所有架构愿望都前置为一个巨型重构。

最终状态：三处缺陷已修复且代码 CI 全绿；R23-04/R23-05 保留 P1；整体评审仍有问题，不作无条件通过。未执行 merge、release、deploy 或仓库规则变更。

## 依据索引

下列源码链接固定到评审基线或修复快照；外部资料于 2026-09-05 读取。资料提供机制依据，具体对 Tekon 的取舍为本报告判断。

[S1]: https://github.com/zesming/tekon/blob/0e36f4d03f70c31e18fa4e0f2e2299800dfdc33c/packages/cli/src/commands/run.ts
[S2]: https://github.com/zesming/tekon/blob/0e36f4d03f70c31e18fa4e0f2e2299800dfdc33c/packages/web/src/server/api/routers/project.ts
[S4]: https://github.com/zesming/tekon/blob/0e36f4d03f70c31e18fa4e0f2e2299800dfdc33c/packages/web/src/client/hooks/use-query.ts
[S5]: https://github.com/zesming/tekon/blob/0e36f4d03f70c31e18fa4e0f2e2299800dfdc33c/packages/core/src/workflow/run-plan.ts
[S6]: https://github.com/zesming/tekon/blob/0e36f4d03f70c31e18fa4e0f2e2299800dfdc33c/packages/core/src/workflow/engine.ts
[S7]: https://github.com/zesming/tekon/blob/0e36f4d03f70c31e18fa4e0f2e2299800dfdc33c/packages/core/src/session/session-service.ts
[S8]: https://github.com/zesming/tekon/blob/0e36f4d03f70c31e18fa4e0f2e2299800dfdc33c/packages/core/src/runtime/dsh-headless-adapter.ts
[S9]: https://github.com/zesming/tekon/blob/0e36f4d03f70c31e18fa4e0f2e2299800dfdc33c/packages/web/src/server/api/root.ts
[S11]: https://github.com/zesming/tekon/blob/0e36f4d03f70c31e18fa4e0f2e2299800dfdc33c/packages/web/src/client/layouts/TopBar.tsx
[S12]: https://github.com/zesming/tekon/blob/0e36f4d03f70c31e18fa4e0f2e2299800dfdc33c/packages/cli/src/commands/ui.ts
[S13]: https://github.com/zesming/tekon/blob/0e36f4d03f70c31e18fa4e0f2e2299800dfdc33c/packages/web/package.json
[S14]: https://github.com/zesming/tekon/blob/0e36f4d03f70c31e18fa4e0f2e2299800dfdc33c/.github/workflows/ci.yml
[S15]: https://github.com/zesming/tekon/blob/0e36f4d03f70c31e18fa4e0f2e2299800dfdc33c/README.md
[S16]: https://github.com/zesming/tekon/blob/0e36f4d03f70c31e18fa4e0f2e2299800dfdc33c/packages/cli/src/commands/status.ts
[S17]: https://github.com/zesming/tekon/blob/0e36f4d03f70c31e18fa4e0f2e2299800dfdc33c/packages/web/src/server/api/provider-health.ts
[S18]: https://github.com/zesming/tekon/blob/0e36f4d03f70c31e18fa4e0f2e2299800dfdc33c/scripts/ci/audit-production.mjs
[S19]: https://github.com/zesming/tekon/blob/0e36f4d03f70c31e18fa4e0f2e2299800dfdc33c/packages/core/src/workflow/execution-plan.ts
[S20]: https://github.com/zesming/tekon/blob/0e36f4d03f70c31e18fa4e0f2e2299800dfdc33c/packages/core/package.json
[B1]: https://github.com/zesming/tekon/blob/34f1794b27709be84a741cced0d028c7e2cb6da8/packages/cli/src/commands/run.ts
[B2]: https://github.com/zesming/tekon/blob/34f1794b27709be84a741cced0d028c7e2cb6da8/packages/web/src/server/api/routers/project.ts
[B3]: https://github.com/zesming/tekon/blob/34f1794b27709be84a741cced0d028c7e2cb6da8/packages/web/src/client/lib/query-cache.ts
[T1]: https://github.com/zesming/tekon/blob/0e36f4d03f70c31e18fa4e0f2e2299800dfdc33c/packages/cli/__tests__/e2e/run-dry-run.e2e.test.ts
[T2]: https://github.com/zesming/tekon/blob/0e36f4d03f70c31e18fa4e0f2e2299800dfdc33c/packages/web/__tests__/api/project-health-rotation.test.ts
[T3]: https://github.com/zesming/tekon/blob/0e36f4d03f70c31e18fa4e0f2e2299800dfdc33c/packages/web/__tests__/client/query-cache-flight.test.ts
[E1]: https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.1
[E2]: https://nodejs.org/api/child_process.html
[E3]: https://www.sqlite.org/atomiccommit.html
[E4]: https://react.dev/reference/react/useEffect
[E5]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.1/apps/cli/reference/README.md
[E6]: https://agentclientprotocol.com/protocol/v1/prompt-turn
