# Tekon 产品、UI/UX、Runtime 与 DeepSeek Harness 第十二轮全面复审

- **日期**：2026-08-31
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **上一轮权威代码快照**：`19deedfe03d78553102faad355d8aef26d32dd6e`
- **用户 v0.20.3 整改快照**：`1a4700ec8d9e735bdb3fcf25fe0dc1652e2ee007`
- **本轮 reviewer 代码修复快照**：`5ff5b430fb839177125fba695198b6ab24c3f87c`
- **产品版本**：`0.20.3`
- **Tekon DSH tested pin**：`0.1.2-alpha.2`
- **DeepSeek Harness 官方取证基线**：master `0a53fb55bea101816fa226bb964ae2bed71c343b`，发布 `dsh-v0.1.2-alpha.2`
- **代码自动化状态**：`5ff5b430...` 的 Core #348 与 CI #257 均为 `completed/success`；Root build/typecheck、CLI unit/e2e、Web build/typecheck/unit 与 Chromium Playwright 全部成功
- **最终裁决**：v0.20.3 整改与本轮 reviewer 局部修复通过代码合并门；Tekon 整体仍未通过“面向普通人的稳定持续协作研发工作台”产品验收

## 1. 执行摘要

v0.20.3 的整改目标是合理的：统一 CLI e2e 文件命名与 lane 语义、减少 CI 工具链噪声、用 `pnpm.overrides` 收敛当前依赖树中的已知 advisory。实际复核后，三类结论必须分开：

1. **CLI e2e lane 调整真实有效**。三个真实子进程用例已经统一为 `*.e2e.test.ts`，unit lane 不再重复执行它们，最终 CI 中 unit 为 9 个文件 / 61 个测试，e2e 为 3 个文件 / 7 个测试。
2. **Corepack 迁移方向正确，但用户快照的实现会让 CI 失败**。CI #255 中外层 `corepack pnpm --filter @tekon/cli test:e2e` 能启动，package script 内部再次调用裸 `pnpm` 时却得到 `spawn ENOENT`，因为 runner 并未先安装/启用 `pnpm` shim。只把 workflow 命令前缀从 `npm exec` 改成 `corepack pnpm`，不能保证递归 package script 能找到 `pnpm`。
3. **依赖 override 可以视为当前 lockfile 的局部风险收敛，不能外推为持续供应链治理已经完成**。仓库没有把 audit、SBOM、provenance 或 dependency review 设为强制合并门；本轮也没有在独立网络环境重新执行 advisory 查询。因此本报告接受具体版本 pin 已进入根合同和 lockfile，但不复述“所有依赖风险已永久关闭”的表述。

本轮 reviewer 已直接修复两个 workflow：

- 所有 job 先执行 `corepack enable pnpm`，再统一调用根 `packageManager` 钉死版本对应的 `pnpm` shim；
- `.github/workflows/core.yml` 同步移除残留的 `npm exec --yes -- pnpm@10.12.1`；
- `actions/checkout` 与 `actions/setup-node` 升到当前 Node 24 runtime 的 v6 系列；
- CLI package script 内的递归 `pnpm` 调用恢复工作。

修复后 Core #348 与 CI #257 全绿。不过，“npm unknown env config warning 已全部清理”的说法仍不成立：CLI fixture 在 pnpm 启动的 Vitest 进程内再调用 `npm init` / `npm pkg set`，会继承 pnpm 注入的 `npm_config_verify_deps_before_run`、`npm_config_recursive` 和 `npm_config__jsr_registry`，npm 11 仍会打印弃用警告。该问题不再阻断执行，也不是产品功能问题，保留为测试卫生待办；不应通过降低 npm 日志级别把真实 warning 隐藏掉。

产品与架构主链路在 v0.20.3 中没有发生实质变化。受控交付 Deliver 轨道继续具备较强的计划预览、失败关闭、Gate、Artifact、Audit、worktree 与网络知情确认基础；持续协作 Collaborate、single-owner Runtime、权威 Session 事实链、可证明的 shutdown/restart、完整历史导出与模型上下文预算仍未闭环。

## 2. 最终判断

### 2.1 当前代码增量

用户整改快照 `1a4700ec8d9e735bdb3fcf25fe0dc1652e2ee007` 的 CI #255 **不是通过状态**：

- Core #346 成功；
- Root、Web unit/build 与 Chromium Playwright 成功；
- CLI unit 成功后，CLI e2e 在 package script 内以 `pnpm: not found` / `spawn ENOENT` 失败。

本轮 reviewer 代码快照 `5ff5b430fb839177125fba695198b6ab24c3f87c`：

- Core #348：`completed/success`；
- CI #257：`completed/success`；
- Root build/typecheck 成功；
- CLI build、9 个 unit 文件 / 61 个测试、3 个 e2e 文件 / 7 个测试成功；
- Web typecheck、build、unit 成功；
- Chromium Playwright 成功。

因此，**v0.20.3 用户整改加上本轮 reviewer 修复通过当前代码合并门**。

### 2.2 产品成熟度

当前允许的成熟度表述是：

> Tekon v0.20.3 已形成测试覆盖较强、执行计划和风险边界较透明、长会话在线观察具有基础资源上限的实验性受控交付执行与观察基础设施；Deliver 轨道可在有人监督下试用，但持续协作、单一 Runtime 权威、权威 Session 事实链、可证明的 shutdown/restart、完整历史导出、模型上下文预算和统一发布身份尚未闭环。

仍不应描述为：

- 面向普通用户的稳定持续协作研发工作台；
- Web/CLI 多进程并发安全的 repo Runtime；
- 拥有 crash-safe durable inbox 和完整模型历史恢复的 Session 平台；
- 已完成任意规模长会话、生产级 shutdown、restart resume 与完整历史导出的服务；
- 已通过真实 DSH API smoke，或可把 DeepSeek Harness sandbox 当作唯一安全边界的系统；
- 已具备强制 CI、供应链和发布身份一致性的发布流程。

## 3. 评审范围与方法

本轮覆盖：

- `19deedfe...` 到用户整改快照 `1a4700e...` 的全部增量；
- 用户整改涉及的 CI workflow、CLI test lane、根 package/lockfile、CHANGELOG、AGENTS 与权威评审入口；
- 当前 PR 的 Core、Root、CLI、Web、Playwright 真实 Actions 日志；
- Core 的 RunPlan、LegacyAgentDriver、Session dual-write、JobRunner、DSH bridge；
- Web 的 Session Composer、project.run、Session/Workspace SSE、事件历史与连接恢复；
- CLI 的 run、provider preflight、unit/e2e fixture 与版本读取；
- Runtime authority ADR、用户手册、当前评审入口和旧报告；
- `main` 分支保护与 required status checks 状态；
- DeepSeek Harness 官方 Safety、Headless、ACP、Node engines 与 session-log export 资料；
- Node/Corepack、GitHub Actions 当前 Node 24 runtime 迁移资料。

判断原则：

1. 只有 `completed + success` 的具体 commit/run 才能作为自动化通过证据；
2. package manager 的外层启动成功不等于递归 package script 具备同一可执行入口；
3. 测试 lane、警告清理、依赖 pin、CI enforcement 是四个不同层级；
4. 绿色测试只能证明其覆盖合同，不能自动证明未覆盖的跨进程、真实 Provider、多浏览器或故障注入路径；
5. 产品 UI 中的诚实禁用优于“看起来支持”的空壳实现；
6. 架构级缺口不通过在这个超大 PR 中继续叠加 wrapper、fixture 或措辞制造关闭假象。

本轮没有可访问的独立部署实例，也没有可用的真实 `dsh` 二进制、API key、Firefox/WebKit、屏幕阅读器或弱网设备。因此 UI/UX、真实 Provider 与跨浏览器结论严格限定在代码结构、官方合同和已有自动化证据内。

## 4. v0.20.3 整改逐项裁决

| 整改项 | 裁决 | 理由与边界 |
| --- | --- | --- |
| CLI e2e 文件命名/lane | 关闭 | unit 排除规则和 e2e 选择规则现在对同一 `*.e2e.test.ts` 约定；最终 CI 证明 9 个 unit 文件和 3 个 e2e 文件分层运行。 |
| CI 从 `npm exec` 转向 Corepack | 本轮修复后关闭主要阻断 | 用户实现没有启用 shim，递归 `pnpm` 失败；现每个 job 先 `corepack enable pnpm`，package script 可继续调用裸 `pnpm`。 |
| focused Core workflow 一致性 | 本轮修复后关闭 | Core workflow 不再残留旧 `npm exec` 路径，和全栈 CI 共用同一 package-manager 合同。 |
| Actions Node runtime | 本轮修复后当前通过 | checkout/setup-node 使用 v6，消除 Node 20 action runtime 迁移债务；不能由此推导所有第三方 Actions 风险均已关闭。 |
| npm unknown env warning | 部分完成 | workflow 启动层已清理；fixture 内子 `npm` 仍继承 pnpm 专用 env 并打印 warning。测试仍成功，后续应在 fixture child-process 边界显式净化 env，而不是压低日志级别。 |
| dependency overrides | 当前快照基本关闭 | 根合同和 lockfile 已 pin 指定版本；本轮未独立重跑联网 audit，且没有自动化 advisory/SBOM/provenance gate，不能表述为永久供应链闭环。 |
| 权威文档状态 | 本报告/`current.md` 更新后关闭本轮失真 | 旧入口把 v0.20.3、旧 reviewer snapshot、旧 CI 和“warning 已清理”混在一起；第十二轮独立成文，旧报告保持只读。 |
| 产品/UI 主链路 | 无实质变化 | Deliver 路径继续成立；Collaborate、真实流式与完整历史能力没有因为测试/依赖调整而前进。 |

## 5. 本轮 reviewer 直接修复

### 5.1 修复 Corepack shim 缺失导致的 CLI e2e 阻断

用户快照的调用链是：

```text
GitHub Actions
→ corepack pnpm --filter @tekon/cli test:e2e
→ package.json script
→ pnpm --filter @tekon/core build
→ /bin/sh: pnpm: not found
```

问题不在 CLI e2e 文件命名，也不在 pnpm 版本，而在于 `corepack pnpm` 只代理了当前命令，没有保证 `pnpm` shim 已在 PATH 中供后续 shell script 使用。

修复后的合同：

```text
setup-node
→ corepack enable pnpm
→ pnpm install --frozen-lockfile
→ 后续 workflow 和递归 package script 均使用 packageManager 钉死的 pnpm
```

这样既不重复硬编码 `10.12.1`，也不要求 package script 改写成 `corepack pnpm`，本地与 CI 的脚本语义保持一致。

### 5.2 同步 focused Core workflow

用户只修改了 `.github/workflows/ci.yml`，而 `.github/workflows/core.yml` 仍使用：

```text
npm exec --yes -- pnpm@10.12.1
```

这使两个所谓权威 gate 使用不同的 package-manager 入口，也使“npm exec warning 已清理”的文档结论不成立。本轮将两个 workflow 统一为：

- 当前 Node 24；
- `actions/checkout@v6`；
- `actions/setup-node@v6`；
- `corepack enable pnpm`；
- 由根 `packageManager` 解析的 `pnpm`。

### 5.3 保留 fixture warning 的真实边界

最终 CI 仍可观察到：

```text
npm warn Unknown env config "verify-deps-before-run"
npm warn Unknown env config "recursive"
npm warn Unknown env config "_jsr-registry"
```

它们出现在 Vitest fixture 调用 `npm init` / `npm pkg set` 时，而不是 workflow 启动 pnpm 时。后续合理修复是建立一个测试专用 child-process env helper，只删除 pnpm 私有 `npm_config_*` 键并保持 PATH、代理、证书等真实环境；不建议设置 `NPM_CONFIG_LOGLEVEL=error`，因为那会把其它有价值的 npm warning 一起隐藏。

本轮没有为三类 warning 修改数十处 fixture，以免在已接近 170 个变更文件的 PR 中继续扩大测试重构面。

## 6. 产品逻辑评审

### 6.1 当前真正成立的价值：受控交付，而非持续聊天

默认 Web Composer 的实际行为仍是：

```text
输入需求
→ 服务端读取 standard-delivery 计划
→ 展示角色链、Gate、人工确认数和网络状态
→ 缺 plan/digest 时 fail-closed
→ 启动新的受控交付 Run
```

这条路径在产品语义上基本诚实：按钮是“启动受控交付”，提示明确“轻量协作、会话内追问与转向尚未开放”。相比把一次性 workflow 包装成聊天，这种披露是正确的。

当前成熟部分包括：

- 计划预览与服务端 canonical digest；
- clean-base 与 dirty-base 显式确认；
- Provider/run-mode policy；
- dsh-headless 网络不受限知情确认；
- Gate、Artifact、Audit、worktree、delivery/readiness；
- 暂停、取消、审批与失败确认；
- Session/Workspace 在线观察和基础资源上限。

### 6.2 仍缺失的核心产品闭环

普通用户仍不能在同一个 Session 中完成：

```text
继续输入
→ 观察真实 execution-time Provider updates
→ follow-up / steer
→ prompt cancel
→ 刷新或 Runtime 重启后恢复
→ 从 Collaborate 升级为 Deliver
```

`LegacyAgentDriver.events()` 仍等待 one-shot adapter 完成后才返回缓冲事件；`followUp`、`steer` 和 `resume` 仍抛出 `NotSupportedYet`；其 cancel 注释也明确真实 provider adapter 尚未完整传播 signal。因此 Session 页面仍主要是 Run 的观察、审批和证据面，不是持续协作工作台。

### 6.3 产品范围继续存在“双重心智模型”

界面结构类似会话产品，但默认动作是完整 `standard-delivery`。诚实文案降低了误导，不过普通用户仍需要理解：

- Session 与 Run 的区别；
- Gate、Artifact、Profile、Provider；
- 连接 Token；
- 为什么一个输入会触发 PM / RD / QA / Reviewer 全链路；
- 为什么当前会话不能继续追问。

在 Collaborate vertical slice 成立前，不建议继续增加新的 Profile、Automation 类型、Driver wrapper 或 workflow DSL 能力；优先让一个最小多轮闭环真正可用。

## 7. UI 实现与 UX 交互评审

### 7.1 已成立的改进

- 默认 Composer 在计划读取失败、digest 缺失、无 token 或输入为空时禁止启动；
- 计划摘要把角色链、控制点和网络风险放在提交前；
- 长事件默认限高、历史按需加载、截断提示可见；
- 连接状态基于服务端握手，不再只看本地 token 是否非空；
- 已整改的两个配置 dialog 具备 Esc、焦点循环、焦点归还与背景 inert；
- Chromium Playwright 当前通过。

### 7.2 仍存在的 UX 缺口

1. **完整历史没有用户行动入口**  
   截断提示告诉用户在线窗口不完整，但没有“导出完整历史”“生成审阅包”或“下载 Session 证据”的直接动作。用户只能继续分页，且页面有额外保留 2000 条的 DOM/内存策略。

2. **UI 历史预算与模型上下文预算是两件事**  
   页面不再无界渲染，不等于 Provider prompt 已有 summary/compaction、token budget、fork/resume 语义和可审计 retention policy。

3. **连接凭据仍属于工程化设置**  
   Token 管理对开发者可接受，对普通用户仍是安装/部署细节。长期应由本地 daemon 或宿主应用承担连接与身份，不让默认任务入口暴露底层 session token 心智。

4. **可访问性证据仍是局部的**  
   当前不能从两个 dialog 和 Chromium lane 外推为全站键盘、屏幕阅读器、Firefox/WebKit、200% 缩放、对比度和 reduced-motion 已验收。

5. **弱网与重连体验只有协议测试，没有真实设备证据**  
   SSE backpressure 和 reconnect 代码合同已经改善，但尚无真实网络抖动、后台标签页、移动设备和代理缓冲环境的体验基准。

## 8. Runtime 与整体架构评审

### 8.1 P0：repo 级 single-owner Runtime 仍未实现

Web 与 CLI 仍可各自创建并持有：

- SQLite connection / repositories；
- JobRunner；
- Git/worktree；
- Provider 子进程；
- Automation / Delivery；
- shutdown 生命周期。

job owner、lease、CAS 和 process-local token 能保护 job row，却不能完整 fence Git promotion、普通文件、Artifact、Gate、Audit 与外部 SDK 副作用。`main` 上既有 ADR 已正确确定长期方向：repo-scoped daemon + repo lock，CLI/Web 客户端化。

### 8.2 P0：Shutdown 仍不能证明真正 quiescent

当前已有 settle window、abort、registered subprocess kill、hard deadline 与 DB closed fence。它们能显著降低 late-write 风险，但 hard deadline 后不合作 executor 仍可能继续运行 JavaScript、写普通文件、执行 Git 或停留在外部 SDK 内。

完整闭环需要：

- executor worker/process 隔离；
- 真实 kill/join；
- generation fencing；
- checkpoint；
- crash/restart/late-write 故障注入；
- daemon lock 与资源释放顺序。

### 8.3 P0：Session Event 仍是 best-effort projection

`dual-write.ts` 明确采用：

```text
原领域/Audit 写成功
→ best-effort append session_event
→ 失败只记录或静默跳过
```

找不到 Session、append 失败或没有映射时均可能缺失。它适合作为 UI 观察投影，不足以独立承担：

- 权威模型历史；
- durable inbox；
- prompt claim/processed；
- crash replay；
- fork/resume；
- restart recovery。

后续必须显式选择：让 Session log 成为权威事实源，或长期定义为观察投影；不能同时暗示两者都已具备。

### 8.4 P1：RunPlan 尚未成为 execute/resume 的唯一权威输入

当前 RunPlan 已包含角色链、Gate、阶段、Agent、Profile、超时、模板身份与 digest，但仍未完整绑定：

- demand version/hash；
- base revision；
- workspace physical identity；
- 网络确认事实；
- resolved Provider config；
- expected artifacts；
- executable node plan。

另外，`RunPlanContext` 接受 `mode: workflow | goal`，但 `projectRunPlan()` 并未把 mode 写入 plan 或 digest。由于当前 goal 使用独立 `goal` 模板，这还不是现成绕过；它仍说明“调用上下文”与“被摘要的执行事实”尚未完全同构。后续 RunPlan authority 专项应一次性解决，而不是在本 PR 中只补一个字段后宣称关闭。

### 8.5 P1：发布版本身份仍分裂

根产品版本已经是 `0.20.3`，`@tekon/core`、`@tekon/cli`、`@tekon/web` 仍是 `0.7.0`。CLI 源码模式的 `getVersion()` 读取仓库根 package，但 Core 同时导出自身 package version；不同诊断面可能继续出现两个版本空间。

这些 package 当前是 private，分裂暂不等同于 npm 发布事故，但仍会影响：

- bug report 与日志中的版本识别；
- updater/安装器与内部 package 的兼容判断；
- release tag、migration 和 snapshot 归属；
- 将来解除 private 或拆包发布时的语义。

建议建立单一产品版本 manifest，并明确内部 package 是 lockstep 还是独立 semver；不要继续靠人工同时修改多份 package.json。

## 9. 长 Session、历史与资源预算

### 9.1 已基本关闭的在线观察问题

- 真正的 `beforeSeq` / `nextBeforeSeq` 反向游标；
- reconnect replay event/byte budget；
- Session pending event/byte cap；
- workspace pending frame/byte cap；
- Session/Workspace heartbeat 背压；
- 页面历史窗口裁剪与用户可见 truncation 提示。

### 9.2 仍未闭环

- complete-history export；
- server-side snapshot/flush boundary；
- 模型 summary/compaction；
- UI、导出、模型 prompt 的统一 retention policy；
- Session/子 Session/Artifact 的证据包；
- 大规模、长时连接和跨进程故障矩阵；
- 资源指标、告警和容量基准。

DeepSeek Harness 官方 `session-log-export` 提供了值得借鉴的边界：先做 HEAD/preflight，再由服务端流式生成浏览器下载；避免在浏览器或 Node 内存中整体缓冲；实时 Session 先 flush；一个 Session 同时只允许一个 export；输出包含 manifest、root/subsession 与 attachments。Tekon 不需要照搬其存储格式，但应复用这些资源和一致性原则。

## 10. DeepSeek Harness 对齐结论

### 10.1 dsh-headless 继续保持 Goal-only 是正确的

官方 Headless 合同仍是：一次 invocation 处理一个 task，输出最终 assistant answer 后退出，没有 interactive follow-up。它适合脚本、CI 和 one-shot job，不适合作为 Tekon 持续 Session 的伪实现。

因此：

- 保留 `dsh-headless` 作为 experimental Goal provider；
- 不把它扩展回 standard-delivery 或 Collaborate；
- 不把最终 stdout 包装成“实时流式协作”。

### 10.2 Collaborate 应优先走独立 ACP vertical slice

官方 ACP 已提供：

- persistent session new/list/resume/close；
- prompt/cancel；
- semantic execution updates；
- permission request；
- per-session ownership；
- quiescent close 与 persistence flush。

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

该切片成立后，再决定如何映射 Tekon Session、RunPlan、permission、Artifact 和 Collaborate → Deliver；不要先继续扩张现有 one-shot `AgentAdapter`。

### 10.3 Harness 不能成为唯一安全边界

官方 Safety 仍明确说明 DeepSeek Harness 是未经安全审计的 developer preview；sandbox、approval 和 permission controls 只能降低风险，不能保证隔离，也不能作为不可信 workload 的唯一控制。

Tekon 必须继续保留：

- least privilege；
- OS/container/VM 隔离选项；
- host-side network policy；
- credential minimization；
- command/artifact/audit evidence；
- human approval；
- 明确的 experimental 披露。

### 10.4 真实 Provider smoke 仍缺

版本 pin、help anchor、default-config row 与 fake-dsh fixture 只能证明 L1/L2 合同。仍需要在装有真实 `dsh@0.1.2-alpha.2`、Node `^22.19.0 || >=24.0.0`、API key 和外部网络的隔离环境执行：

- preflight；
- one-shot success/failure；
- stderr/stdout 边界；
- timeout/cancel；
- artifact/no-artifact 行为；
- credential/redaction；
- host-side isolation。

## 11. 代码实现评审

### 11.1 正向判断

- CI/测试命名在本轮后更容易理解和维护；
- RunPlan canonical JSON/digest、Web fail-closed 验证与持久 snapshot 方向正确；
- Session/Workspace SSE 对 `write(false)`、pending cap 和 reconnect 的处理明显强于早期版本；
- JobRunner 已具备 ownership loss、heartbeat、cancel/pause relay、conditional settle 与 hard-stop 起点；
- DSH bridge 使用版本 pin + help/config contract，而不是绑定上游私有文件布局；
- UI 对未实现 Collaborate 保持诚实禁用。

### 11.2 仍需避免的代码方向

1. 不要继续新增与 vertical slice 无关的 driver/adapter wrapper；
2. 不要让更多业务路径依赖 best-effort Session event 后再宣称可恢复；
3. 不要通过增加更多 hard timeout 代替 process isolation/join；
4. 不要在 RunPlan 未成为执行唯一输入前继续增加 preview-only 字段；
5. 不要用全局日志降级隐藏测试 fixture warning；
6. 不要把依赖 override 当作长期依赖更新机制；
7. 不要在同一 PR 中同时做 daemon、authoritative log、ACP、compaction 和全站 a11y。

## 12. 是否存在过度实现或过度设计

当前横向能力已经包括：

```text
AgentAdapter / AgentDriver / LegacyAgentDriver
Provider Registry
JobRunner
Session dual-write / projection
Profile
Automation
Goal
Readiness
Delivery
CLI / Web 两套 composition root
多轮计划、ADR、评审和整改文档
```

这些机制多数有局部合理性，但仍领先于最小持续协作纵向闭环：

```text
同一 Session 继续输入
→ Provider 执行中的真实更新
→ 用户取消或转向
→ Runtime 重启后恢复
→ 升级为 Deliver
```

因此当前主要过度风险不是某一个类“写得太抽象”，而是**横向能力和评审过程持续增长，纵向用户价值闭环仍缺**。冻结原则应继续执行：除非直接服务 single-owner、authoritative Session、真实 Provider stream、follow-up/cancel/resume、Collaborate → Deliver、RunPlan authority 或完整历史/模型预算，否则暂停新增 Profile、Automation job、Driver wrapper、展示事件和 Workflow 语法。

PR #11 已超过适合逐行审阅、可靠二分和低风险回滚的规模。最终仍建议 squash merge；后续主链路必须拆成独立、可验证的小 PR。

## 13. 问题清单

| ID | 严重度 | 状态 | 问题 |
| --- | --- | --- | --- |
| P0-ARCH-01 | P0 | 未关闭 | CLI/Web 缺 repo 级 single-owner Runtime authority。 |
| P0-ARCH-02 | P0 | 部分完成 | abort/kill/hard deadline/DB fence 不保证 executor、Git、普通文件和 SDK 已 quiescent。 |
| P0-DATA-01 | P0 | 未关闭 | Session Event 是 best-effort projection，不是 durable inbox/权威模型历史。 |
| P0-PRODUCT-01 | P0 | 未关闭 | 真实 streaming、follow-up、steer、prompt cancel、restart resume 与 Collaborate → Deliver 未闭环。 |
| P1-PLAN-01 | P1 | 部分完成 | canonical RunPlan 尚未成为 execute/resume 唯一事实；mode 也未进入 plan/digest。 |
| P1-SESSION-01 | P1 | 部分完成 | 在线 replay/pending 已有边界；完整导出、compaction、retention、规模与故障矩阵仍缺。 |
| P1-GOV-01 | P1 | 未关闭 | `main` 未保护，required status checks enforcement 为 off，红色 CI 不能从仓库规则层阻止合并。 |
| P1-RELEASE-01 | P1 | 未关闭 | 根产品版本 `0.20.3` 与内部 package `0.7.0` 并存，缺单一发布版本权威。 |
| P1-DSH-01 | P1 | 部分完成 | alpha.2 pin/合同成立，缺真实二进制 + API key smoke。 |
| P1-A11Y-01 | P1 | 未关闭 | 局部 dialog 和 Chromium lane 不能替代全站 screen reader、多浏览器、缩放与对比度验收。 |
| P1-PROCESS-01 | P1 | 未关闭 | PR 体量过大，审阅、二分、迁移和回滚风险高。 |
| P2-CI-01 | P2 | 本轮修复 | `corepack pnpm` 外层成功但 package script 裸 `pnpm` 无 shim，导致 CI #255 CLI e2e ENOENT。 |
| P2-CI-02 | P2 | 本轮修复 | focused Core workflow 残留 `npm exec`，与全栈 CI 工具链不一致。 |
| P2-CI-03 | P2 | 待收敛 | fixture 子 `npm` 仍继承 pnpm 专用 `npm_config_*` 并打印 unknown-config warning。 |
| P2-DOC-01 | P2 | 本轮修复 | v0.20.3 入口在红色 CI/残留 warning 下提前宣称通过和清理完成。 |
| P2-DEPS-01 | P2 | 部分完成 | 当前 override 进入 lockfile，但无强制 advisory/SBOM/provenance gate。 |

## 14. 建议实施顺序

1. **仓库治理小改动**  
   为 `main` 启用 branch protection/ruleset，至少要求 Core 与 CI 成功后才能合并；这属于仓库设置，不在本轮代码提交中擅自修改。

2. **single-owner daemon + repo lock**  
   统一 Job、Git、worktree、subprocess、DB、Automation、Delivery 和 shutdown 所有权。

3. **executor process/worker 隔离 + restart contract**  
   真实 kill/join、checkpoint、generation fencing、late-write 与 crash fault injection。

4. **authoritative Session log / transactional outbox + durable inbox**  
   明确事实源、claim/processed/retry、模型历史、迁移与投影。

5. **DeepSeek ACP real-provider vertical slice**  
   persistent session、execution-time updates、prompt cancel、quiescent close、restart resume。

6. **Collaborate → Deliver**  
   同一 Session follow-up/steer，计划升级和人工审批点。

7. **canonical RunPlan 成为 execute/resume 权威**  
   绑定 demand、mode、base/workspace、Provider、权限、网络、Artifacts 和 executable plan。

8. **完整历史导出 + 模型上下文预算**  
   server-streamed export、snapshot/flush、manifest、subsession/artifacts、summary/compaction 和 retention。

9. **统一发布身份、测试 fixture 与 a11y**  
   version manifest、child-process env helper、screen reader、多浏览器、缩放和对比度。

## 15. 合并、发布与证据边界

当前代码合并门通过只能证明：

- `5ff5b430...` 在现有自动化合同下可构建、类型正确并通过测试；
- CLI unit/e2e lane 已按命名约定分层；
- Corepack shim 修复解决了本轮 CI 阻断；
- Web 当前 Chromium 主路径未被 v0.20.3 过程改动击穿；
- 既有 Session/Workspace SSE 和 DSH fixture 合同仍通过回归。

它不能证明：

- Web/CLI 两个 Runtime 并发无 Git/文件副作用冲突；
- 服务关闭后所有 executor、文件、Git 和 SDK 活动都已终止；
- Session log 可完整恢复模型上下文；
- 任意规模会话都有稳定资源预算；
- DSH 已完成真实 API smoke；
- dependency override 之后供应链风险会自动持续受控；
- Firefox/WebKit、屏幕阅读器和真实弱网设备已通过；
- 普通用户持续协作产品已经完成。

当前 `main` 未启用 required checks，因此“代码门通过”仍是评审结论和人工流程，不是 GitHub 仓库强制规则。合并前应确认 PR Head 未被继续推进；若 Head 变化，必须重新绑定 CI 终态。

本轮未执行 merge、release、deploy 或仓库 branch-protection 设置修改。

## 16. 参考资料

### Tekon

- [当前权威入口](current.md)
- [Runtime authority ADR](../technical/adr-0001-runtime-authority-and-collaborate.md)
- [第十一轮报告](2026-08-31-tekon-product-runtime-harness-eleventh-review.md)
- [`SessionComposer`](../../packages/web/src/client/components/sessions/SessionComposer.tsx)
- [`project.run`](../../packages/web/src/server/api/routers/project.ts)
- [`CLI run`](../../packages/cli/src/commands/run.ts)
- [`LegacyAgentDriver`](../../packages/core/src/runtime/legacy-agent-driver.ts)
- [`Session dual-write`](../../packages/core/src/session/dual-write.ts)
- [`JobRunner`](../../packages/core/src/session/job-runner.ts)
- [`RunPlan`](../../packages/core/src/workflow/run-plan.ts)
- [`Session/Workspace SSE`](../../packages/web/src/server/sse.ts)
- [Full-stack CI](../../.github/workflows/ci.yml)
- [Focused Core CI](../../.github/workflows/core.yml)

### Node / GitHub Actions 官方

- [Corepack](https://github.com/nodejs/corepack)
- [actions/checkout](https://github.com/actions/checkout)
- [actions/setup-node](https://github.com/actions/setup-node)
- [GitHub Actions Node 20 deprecation](https://github.blog/changelog/2025-09-19-deprecation-of-node-20-on-github-actions-runners/)

### DeepSeek Harness 官方

- [Safety](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/SAFETY.md)
- [Headless](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/bundle/headless/README.md)
- [ACP](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/acp/acp/README.md)
- [Session log export](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/packages/session-query/session-log-export/README.md)
- [Root Node engines](https://github.com/deepseek-ai/deepseek-harness/blob/0a53fb55bea101816fa226bb964ae2bed71c343b/package.json)
- [dsh v0.1.2-alpha.2](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-alpha.2)
