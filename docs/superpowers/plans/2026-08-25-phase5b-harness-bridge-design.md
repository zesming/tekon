# 阶段 5b 技术设计：Harness bridge（dsh 互操作）

- 日期：2026-08-25
- 状态：设计稿（只读调研 + 设计，未改任何生产代码）
- 上游对象：`@deepseek-ai/dsh@0.1.1-rc.2`（release-candidate，developer-preview）
- 前置约束：迁移评审报告 §7.2 / §10 阶段 5 / §11（只经稳定公开边界、pin 版本 + adapter contract test、绝不绑定私有 schema、developer-preview API 变化为首要风险）
- 范围声明：本设计只回答"bridge 怎么接、接多深、开关与护栏是什么"。旧模型退场（长 RPC 清理、Cockpit 降级等）是阶段 5 的独立工作流，不在本设计内。

---

## 1. 背景与目标

报告把 Harness 对 Tekon 的意义定为三层：参考架构、可选运行时 provider/bridge、未来经稳定公开边界接入的生态。阶段 0–4 已完成"参考架构"层（事件脊柱、会话化、goal plugin、profiles）。阶段 5b 要回答第二层：**以什么边界、什么形态、什么护栏，把 dsh 接成一个 Tekon 可选运行时**。

设计目标（按优先级）：

1. 找到 rc 版本下**最不易碎的稳定公开边界**，并给出实测证据；
2. 给出与该边界相称的最小 bridge 形态，默认关闭、零回归面；
3. 建立 pin + contract test + 显式失败的漂移检测机制；
4. 治理语义不退化（审批/沙箱 posture 不弱于现有 codex provider）；
5. 诚实标注边界能力天花板，不把"一次性 provider"包装成"session 级互操作"。

---

## 2. 实测事实（2026-08-25，对 `@deepseek-ai/dsh@0.1.1-rc.2` 实测）

> 以下均为事实（经 `corepack pnpm dlx` 临时执行与 `npm pack` 解包验证，未写入 workspace 依赖）。推断与建议在后续章节标注。

### 2.1 包形态

- `dsh` 是 **CLI-only 包**：`main`/`module`/`types`/`exports` 全为 null，只有 `bin: { dsh: "lib/bin.js" }`。无可 import 的库 API。（与既有摸底一致。）
- `dsh` fan-out 到 ~60 个 `@deepseek-ai/dsh-*` 子包 + `@deepseek-ai/cordis`。一次 `pnpm dlx` 解析 504 包、落盘 449 包。
- `dsh-base` 虽有库导出（`.`、`./invariant`、`./src/*`），但 `./src/*` 是私有实现细节，且整体是 developer-preview 内部构件。

### 2.2 launcher 语法（`dsh --help` 实测）

```
dsh [options] [command] [args...]
  --profile <name>        启动 $DSH_HOME/profiles 下的 profile
  --patch <path>          额外 patch 层（可重复）
  --dump-config           打印组合后的 profile 树并退出
  --dump-default-config   打印 bundle 层（不含用户层）并退出
  web                     --profile web 的别名
  plugin                  转发 pnpm 管理 profile 插件
```

launcher 只解析自己的 flag，其余原样交给被 boot 的 app。`--version` 输出干净：`0.1.1-rc.2`。

### 2.3 headless profile 的 I/O 契约（本设计的核心证据）

`dsh --profile headless --help`：

```
Usage: dsh --profile headless [options] [task...]
Answer one task, print the final assistant message, and exit.
  task        the task text; multiple words are joined by spaces
  -h, --help  show this help
```

解包 `@deepseek-ai/dsh-headless@0.1.1-rc.2` 源码（`lib/index.js`）核实的运行行为：

- **stdout**：恰好写一次 `outcome.text + "\n"`——本 turn 最后一条非空 assistant 文本。无进度、无日志、无事件流。
- **stderr**：成功时为空；失败时写 `dsh: <error.code>: <error.message>\n`；boot 失败走 launcher 的 `dsh: <message>\n` 前缀（实测无效 key 时输出 `dsh: AUTH: Authentication Fails, ...`）。
- **exit code**：`turn/end` reason 为 `completed` → 0，否则 → 1。
- **stdin**：不消费。无 follow-up 面（README "Known Limitations" 明示：one submitted task only, no interactive follow-up surface）。
- **端口**：不开监听端口（README 明示 mounts no Host, HTTP server, Web runtime, or browser plugin）。
- **session 持久化**：session 以 JSONL 写到 `$DSH_HOME/sessions`（`session-persistence-jsonl` 插件，root = `dshHomePath('sessions')`）。**这是 dsh 私有文件布局，不是公开契约。**
- **模型**：默认 `deepseek-official / deepseek-v4-flash`（`agent-default-model` 插件），凭证读 `DEEPSEEK_API_KEY`（实测无效 key 即 AUTH 失败）。

该契约被写在包 README 里（stdout/stderr/exit/无端口/一次性均有明文），是 rc 版本下**唯一有文档锚点的机器可消费边界**。

### 2.4 headless 的治理 posture（`--dump-default-config` 实测，333 行插件树）

- `sandbox-policy`：`mode = process.env.DSH_PERMISSION_MODE ?? 'workspace-write'`，workspaceRoot = cwd。
- `user-approval`：policy = `DSH_PERMISSION_MODE === 'danger-full-access' ? 'never' : 'ask'`。
- `permission-presets`：`read-only` → sandbox read-only + approval ask；`workspace-write` → sandbox workspace-write + approval ask；`danger-full-access` → sandbox danger-full-access + approval **never**。
- `dsh-user-approval` 源码：`ask` 策略下"without an available answerer, the request fails closed"。headless 不挂交互 answerer，故**提权请求 fail-closed**；但 `workspace-write` 沙箱内 agent 可不经审批改写工作区。
- 工具面：bash/pwsh sandbox（60s 超时）、fs-sandbox、web search、subagent（`tool-ralph`，maxRounds 64）、str-replace-editor 等。

### 2.5 web profile 的边界性质（`dsh web --help` 实测）

选项：`--host`、`--port`（可 0 随机）、`--no-open`、`--trusted-host`（/api browser-trust fence 的额外授权方）。即 web 端口的 `/api` 是**浏览器 UI 的内部 HTTP 面，带 browser-trust 围栏**，help 未承诺任何公开 API/SSE 契约。

### 2.6 Tekon 侧现状（代码核实）

- 休眠契约 `AgentDriver`/`AgentHandle`/`AgentRuntimeEvent`（`packages/core/src/types/session-contract.ts`）+ 唯一实现 `legacy-agent-driver.ts`（阶段 2a）：**零生产消费者**（grep 确认 src 中仅 `index.ts` re-export 与 `agent-step-events.ts` 注释引用），有测试覆盖。
- 生产消费的 agent 接缝是 **`AgentAdapter` + `provider-registry`**（`mock`/`claude-code`/`codex`/`custom`）：引擎/node-executor 经 `runAgentWithStepEvents` 调 `adapter.runAgent()`，CLI 与 web 双栈都走这条路。
- 现有 provider 先例：codex/claude 适配器把 agent CLI 当 **PATH 上的外部二进制**（`config.command ?? 'codex'`），经 `CommandGateway` spawn，**不是 npm 依赖**。
- provider 枚举出现在三处：`types/config.ts`（`agentAdapterConfigSchema.provider`、`tekonConfigSchema.defaultAgent`）、`types/domain.ts`（`runProviderConfigSchema.provider`）。`agent-runtime.ts` 显式拒绝 custom provider 的 snapshot replay（"only mock, claude-code, and codex are supported"）。
- 事件词汇由共享序列器 `runAgentWithStepEvents` 统一合成：`step/start → tool/call → tool/result → assistant/message | agent/error → step/end`，任何 adapter 插上即得，无需各自翻译。

---

## 3. 稳定边界选型

### 3.1 结论

**采用候选 (a)：子进程/CLI 边界，具体锁定 `dsh --profile headless "<task>"` 的 argv → stdout/stderr/exit-code 契约。** 否决 (b) 绑定 `dsh-base` 库导出，否决 web 端口 HTTP 面。

### 3.2 论据

1. **唯一有文档锚点的机器可消费面**（§2.3）：headless README 明文承诺 stdout 内容、stderr 规则、exit code 语义、无端口、一次性。launcher 语法（`--profile`/`--dump-*`）同样文档化。rc 版本下"文档化的 CLI 契约"比"任何代码级导出"都更不可能随手破坏——CLI 帮助文本本身就是上游的对外承诺面。
2. **与 Tekon 现有接缝同构**：codex/claude 适配器已是"spawn 外部 CLI + 解析 stdout/exit"的成熟模式，有 `CommandGateway`（超时、进度心跳、SIGKILL 取消、子进程注册表）可直接复用。bridge 不是新架构，是 registry 里多一个 provider 定义。
3. **ACL 天然成立**：子进程边界上只有字符串（argv、stdout、stderr、exit code）。**dsh 的任何类型都不可能经此边界渗入 Tekon core 类型系统**——"不绑私有 schema"在结构上成立，不靠纪律保证。
4. **(b) 被否**：`dsh-base` 的 `./src/*` 导出是私有实现细节，版本 rc，绑定它直接违背报告 §7.2/§10.3，且 ~60 子包的依赖图进 Tekon 依赖树，供应链与升级面不可接受。
5. **web 端口被否**：`/api` 是浏览器 UI 内部面（browser-trust fence），无公开契约承诺；绑定它比绑定 CLI 更易碎，且要处理 trust fence 鉴权。

### 3.3 能力天花板（诚实标注，推断）

此边界下 bridge **只能是"一次性 agent provider"**：

- headless 不输出事件流，报告设想的"session 级事件互操作"（在 Tekon UI 里看 dsh 的 SessionEvent log）**在此边界上不可能实现**；
- 读 dsh 的 `$DSH_HOME/sessions` JSONL 来补事件流 = 绑定私有文件布局，违背硬约束，**不做**；
- 无 follow-up、无流式、无 pause（跑到 quiescence）；cancel 只能靠杀子进程（粗粒度，与现有 codex/claude 适配器同水平）。

session 级互操作要等 dsh GA 后出现稳定 API（或其 web HTTP 面公开化）再单独立项。本设计不为此预付架构。

---

## 4. Bridge 形态：一个新的 built-in AgentAdapter

### 4.1 挂靠点选择：AgentAdapter，不是休眠的 AgentDriver

**建议：bridge 实现为 `provider-registry` 中的新 built-in provider `dsh-headless`，实现 `AgentAdapter` 接口。不激活 `AgentDriver` 休眠契约。**

依据：

1. **边界形状匹配**：headless 是一次性请求/响应，与 `AgentAdapter.runAgent() → AgentRunResult` 同构；而 `AgentHandle` 承诺 `events()` 流式、`followUp`、`steer`、`pause`——headless 边界**兑现不了**这些承诺（无流、无 follow-up、不可 pause）。硬挂只会得到一个大半方法抛 NotSupportedYet 的 handle。
2. **消费者现成**：`AgentAdapter` 是 CLI+web 双栈实际消费的缝（引擎 → `runAgentWithStepEvents` → adapter）。插进去零新接线。`AgentDriver` 零生产消费者，激活它必须同时新建消费者接线，双倍表面，违背最小改动。
3. **事件词汇免费获得**：`runAgentWithStepEvents` 已为所有 adapter 统一合成 Tekon 事件序列（§2.6），bridge 不需要自己造事件。
4. **snapshot/resume 路径可通**：作为 built-in provider 注册 `snapshotVersion: 1`，`agent-runtime.ts` 的 restore 路径把它与 mock/codex/claude-code 同等对待（现有 custom 被拒是因为 custom 形状不可重建，dsh-headless 形状固定可重建）。

### 4.2 ACL 形状与翻译表

ACL 全部活在 `dsh-headless-adapter.ts` 一个文件内，对外只暴露 `AgentAdapter`。翻译表（子进程结果 → `AgentRunResult`）：

| dsh 边界事实 | Tekon 侧映射 |
| --- | --- |
| argv：`--profile headless <task>`（task 为位置参数，多词 join） | `buildDshHeadlessCommand(config, prompt)` 构造；prompt 经 arg-append 传入（与 codex 的 arg-append 模式同族） |
| exit 0 + stdout 文本 | `exitCode: 0`；stdout 文本进结果输出（经 `runAgentWithStepEvents` 合成 `assistant/message`） |
| exit 1 + stderr `dsh: <code>: <msg>` | `exitCode: 1`；stderr 进失败摘要（合成 `agent/error`） |
| 超时（gateway 超时杀进程） | `timedOut: true`（与 codex 适配器同构） |
| signal abort → SIGKILL | `cancelled: true`（复用 gateway 取消链） |
| `outputFiles`/`artifacts` | **首期为空数组**（见 §4.4 限制） |

反向（Tekon → dsh）只有 env 与 cwd：

| Tekon 侧 | dsh 侧 |
| --- | --- |
| `worktreeLease.worktreePath` | 子进程 cwd（dsh 的 workspaceRoot） |
| `DEEPSEEK_API_KEY`（若环境存在） | 显式透传（gateway safe-default 模式下逐项点名，不继承全环境） |
| `DSH_HOME` | **钉到 Tekon 管理的隔离目录**（如 `<dataDir>/dsh-home`），不碰用户 `~/.dsh`，也不读其私有 session |
| `DSH_PERMISSION_MODE` | **显式钉死**（见 §7），不继承 ambient env |
| `TEKON_OUTPUT_DIR` / `TEKON_RUN_ID` / `TEKON_NODE_ID` | 照 codex 先例透传（供 prompt 约定引用） |

### 4.3 命令构造的安全护栏

镜像 codex 适配器的"受控参数"做法(`assertSafeCodexArgs` 对 sandbox/approval/config 类 flag 一律拒绝):

- `config.command` 默认 `dsh`；允许覆盖（企业内分发路径），但对真实 dsh 命令做**参数白名单校验**。
- **拒绝 `--patch`(评审 M3 订正)**:`--patch` 是额外 profile 层,可能覆盖 §7 钉死的 sandbox-policy/user-approval 插件(profile 组合优先级未实测,按"可绕过即治理失效"保守处理),故与 codex 拒绝 sandbox/approval flag 对称,**首期直接拒绝所有 launcher flag(含 `--patch`)**。"企业内分发路径需要 patch"是推测需求(YAGNI);若将来确需,必须先实测 patch 层与 env 钉死的优先级并给出证据,再单独放行。
- `--profile headless` 由适配器钉死，不接受用户改成 web/tui（那些不是一次性契约）。
- task 作为**单个位置参数**传入（prompt 整体作为一个 argv 元素），杜绝 prompt 注入成 launcher flag——launcher 语法上位置参数后一切都归 app，但 headless app 只 join 成 task 文本，无 flag 注入面；仍以单参数传递为纵深防御。

### 4.4 已知限制（首期明示）

- **无 artifact 产出 —— 真实机理是沙箱边界,非 agent 不知情**(评审 M2 订正):Tekon 的 `prompt-builder.ts:43` 对**所有 provider** 无条件注入 artifact 协议(`appendArtifactProtocol` 写入 `TEKON_OUTPUT_DIR` 路径、manifest 路径、artifact schema),故 dsh agent **确实收到**输出约定,不存在"不知道"。真正的阻塞是:`outputDir = <repoPath>/<dataDir>/runs/<runId>/<nodeId>`(`helpers.ts:183`)在 **worktree 之外**;codex 靠 `--add-dir outputDir`(`codex-adapter.ts:234`)显式把它加进沙箱可写集,而 dsh headless 的 workspace-write 沙箱 workspaceRoot=cwd=worktreePath,**不含 outputDir 且无 add-dir 类机制**(待探测)。结果:prompt 指示 agent 写一个沙箱必然拒绝的路径,提权请求 fail-closed → **每个带 outputs 的节点在 artifact gate 处确定性失败**。
- **实际可用范围 = goal / 无 outputs 节点,不是"受限"而是交付 workflow 下"零节点可用"**(评审 M2):统计内置 workflow 带 outputs(agent)节点数——standard-delivery **16 个**、standard-feature/bugfix/docs-update/plan-only/test-improvement 各 4–5 个、**goal.yaml 0 个**。故实体 adapter 在 standard-delivery 等交付 workflow 下**全部节点失败**,真实可用范围只有 goal workflow 与无 outputs 的自定义 workflow。
- **未来解法(非首期)**:扩展 dsh 沙箱可写路径(需探测 dsh 是否支持 add-dir 类机制),或让 agent 把 artifact 落 worktree 内再由 Tekon 摄取。原设计写的"task 文本前缀注入输出约定"是错误解法(约定早已注入,问题在沙箱),已废弃。
- **required-artifact 强制语义**(评审 S3):codex/claude adapter 内部用 `missingRequiredArtifactTypes` 把缺 artifact 转成失败。dsh adapter **镜像该强制**(缺 required artifact → 节点失败),与现有 provider 行为一致,不做"假成功后下游炸";§10 测试覆盖。
- **无流式**:用户看到的是"跑完出结果",与 codex 适配器现状一致。
- **每次 run 一个全新 dsh session**（random UUID），无 dsh 侧会话续接；Tekon 侧的 resume 是引擎级重放，不依赖 dsh session。

---

## 5. 版本 pin + capability probe + contract test

### 5.1 pin 的形态

- 适配器内常量 `TESTED_DSH_VERSION = '0.1.1-rc.2'`（唯一事实源）。
- **运行时版本 gate**：adapter 工厂创建时 spawn `dsh --version`，stdout trim 后与常量**精确比较**；不等 → 抛 `DshVersionGateError`，**显式失败**（错误信息含实测版本、已测版本、升级指引），绝不静默降级。
- **restore 路径同样过 gate(评审 S1)**:`provider-registry.ts` 的 `create()` 与 `restore()` 是两条路径。resume 旧 run 时若用户已升级 dsh,restore 也必须重跑版本 gate。此外 create 时把 gate 通过的 dsh 版本写入 `configSummary`,restore 时比对当前二进制版本,不一致即拒绝 replay(比纯运行时 gate 更严——防"snapshot 记旧版、当前是新版"的静默 replay)。
- escape hatch：env `TEKON_DSH_ALLOW_VERSION` 显式接受未测版本,此时打 warning 日志但放行。默认严格。（仅 env 通道;不做 config 键,YAGNI——避免 tekonConfigSchema 为一个 experimental provider 增字段。）

### 5.2 capability probe（契约探测，不跑模型）

对 dsh 二进制做三项无副作用探测（不需 API key）：

1. `dsh --version` → stdout 是单行版本字符串且等于 pin；
2. `dsh --profile headless --help` → exit 0 且输出含契约锚点句 "print the final assistant message"（stdout 契约的文档指纹）；
3. `dsh --profile headless --dump-default-config` → exit 0 且组合树含关键插件 id 集合：`headless-runner`、`sandbox-policy`、`user-approval`、`session-persistence-jsonl`、`agent-default-model`（capability 存在性；插件树漂移 = 上游改了 headless 构成，需人工复核）。

### 5.3 contract test 的三层结构

| 层 | 内容 | 何时跑 | 依赖 |
| --- | --- | --- | --- |
| L1 fixture 契约测试 | 把 2026-08-25 实测的 `--version`/`--help`/`--dump-default-config` 输出存为 fixture，断言 ACL 解析器（版本比较、help 锚点、插件 id 提取、stdout/stderr/exit → AgentRunResult 映射）对 fixture 行为正确 | **每次 CI** | 无外部依赖 |
| L2 live probe | 同一套探测对 PATH 上真实 `dsh` 二进制执行；`DSH_CLI_PATH` 未设置时 `skip` 并打印提示 | 开发者机器 / 发布前手动；CI 默认 skip | 本机装了 dsh |
| L3 live run | 真实 headless 跑一个最小 task（需 `DEEPSEEK_API_KEY`），断言 exit 0、stdout 非空、事件序列含 step/start 与 assistant/message | 发布 checklist 手动 | API key + dsh |

**为什么不把 dsh 加进 devDependencies 让 L2 在 CI 常驻**（权衡，建议）：rc 包 +449 个传递依赖进 lockfile，即使 devDep 也会拖慢每次 CI install、把 rc 供应链引入所有开发机，而收益（上游漂移的自动化检测）与发布前手动一次 L2/L3 相称——bridge 默认关闭、非核心路径，手动闸门足够。L1 保证解析器自身永不回归。若后续 bridge 转正，再升级为 CI 常驻。

---

## 6. 可选开关

- **开关形态 = provider 选择本身**：`tekonConfigSchema.defaultAgent` 与 run 级 `--provider` 已存在；不新增 `TEKON_DSH_BRIDGE` 之类的并行开关（避免双开关语义混乱）。默认 `codex` 不变 = bridge 默认关闭。
- **零回归面论证**：adapter 只在被显式选为 provider 时实例化；不选时进程内不 spawn、不探测、不加载任何 dsh 相关代码路径（probe 模块仅被 dsh adapter 工厂 import）。现有 CLI/web/session 链路的代码路径零改动（除 registry 多一个定义项与枚举多一个值）。
- **枚举扩展的兼容性**：provider 枚举加 `'dsh-headless'` 是 merge-extensible 方向的扩展；既有持久化 snapshot 不含该值，restore 路径不受影响；未知 provider 的既有处理不变。

---

## 7. 治理默认

**治理 posture 三轴对比(评审 M1 订正:撤回笼统"等价",逐轴标定)**:

| 轴 | codex(`--sandbox workspace-write --ask-for-approval on-request`) | dsh headless(`DSH_PERMISSION_MODE=workspace-write`) | 结论 |
| --- | --- | --- | --- |
| 审批 | on-request,非交互下自动拒绝 | `ask` 但 headless 无 answerer → fail-closed(dsh-user-approval 源码证据) | **等价** |
| 文件系统 | worktree + `--add-dir outputDir` 可写 | workspaceRoot=cwd=worktree,不含 outputDir | **dsh 更受限**(非弱化;也是 §4.4 artifact 失败的根因) |
| 网络 | workspace-write 默认**禁网**;Tekon `permissionProfileSchema.network` 默认 `disabled`(`config.ts:39`) | **任何模式都无法禁网**(§18.1 四处官方 README 实证);沙箱 file-effects only | **dsh 更宽松,已实测确认(非疑似)** |

- **网络轴已闭合(决策 c,§17 决策 3 修订)**:§18.1 探针证实 dsh 无任何禁网手段,决策 1(禁网对齐 codex)不可实现。维护方知情后书面接受"dsh 网络轴宽松于 codex"。工程落地:adapter permission profile **诚实声明 `network: 'enabled'`**,并因 `assertAgentProviderCapabilities` 会拒绝该值,走**显式知情确认**构造路径(config 携带确认位才放行,否则照常抛错)——全局护栏对其它 provider 与误配 dsh 仍生效,弱化仅在显式确认下对 dsh 单一 provider 生效。**manual 第一屏红字**标注联网事实。**绝不谎报 restricted。**
- `DSH_PERMISSION_MODE` 由适配器**显式设置**,不继承 ambient env;拒绝 `danger-full-access`（该模式 approval=never,弱于任何现有 provider）;`DSH_HOME` 钉到 Tekon 隔离目录,不碰用户 `~/.dsh`,不读其私有 session。
- **subagent 面差异(评审 S6)**:dsh 工具面含 `tool-ralph`(maxRounds 64 subagent),codex exec 无 subagent 面。若 subagent 在同一沙箱内运行则不构成弱化,但自治面确有差异,此处记录,不含糊称"工具面等价"。
- Tekon 自身的治理链（workflow、gate、人工审批、PR 创建受控）在 bridge 之上**原样生效**：gate 包的是 run 结果与交付物，与 agent 内部动作的关系和 codex/claude 场景同构。
- 凭证：`DEEPSEEK_API_KEY` 只在显式配置/环境存在时透传，不写入任何 Tekon 持久化存储；snapshot 的 `configSummary` 不得含 key（沿用现有 summarize 脱敏约定，测试断言）。

---

## 8. `AgentDriver` / `legacy-agent-driver` 去留

**结论：维持休眠，本阶段不动。**

- bridge 不挂靠它（§4.1 依据），它继续零生产消费者。
- 它的退场（删除 + 测试一并移除）是阶段 5"旧模型退场"工作流的一部分，与 bridge 定位无关、可独立进行；报告批注也说 legacy 清理可独立先行。但**不在 5b 内顺手删**——删休眠契约是独立决策（它仍是冻结契约 v1 的参考实现，删它要先确认阶段 2b 流式 loop 不再需要这个挂靠点），混进 bridge PR 会模糊验收边界。
- 记录决定，移交阶段 5 退场工作流处理。

---

## 9. 依赖引入方式

**建议：完全不加 npm 依赖（生产/optional/dev 都不加），运行时探测 PATH 上的 `dsh`。**

| 方案 | 权衡 |
| --- | --- |
| 不加依赖，PATH 探测（建议） | 与 codex/claude 先例一致；lockfile/安装体积/供应链零影响；版本 gate 在运行时把关；缺点是用户要自行装 dsh（文档写明） |
| optionalDependencies | 默认仍会被 pnpm/npm 安装（~449 包），rc 传递依赖进 lockfile，默认关闭功能背上持续安装成本——否决 |
| devDependencies | L2 contract test 可 CI 常驻，但 rc 供应链进开发环境 + CI 变慢（§5.3 权衡）——首期不做，bridge 转正时再议 |

用户文档：`docs/manual` 增加一节说明"experimental: dsh-headless provider 需自行安装 `@deepseek-ai/dsh`（`npm i -g` 或 `corepack pnpm dlx` 壳），Tekon 不捆绑"。

---

## 10. 测试策略

1. **ACL 单测**（`dsh-headless-adapter.test.ts`，全 mock gateway）：
   - argv 构造：`--profile headless` 钉死、task 单参数、command 覆盖路径；
   - env：`DSH_HOME` 隔离、`DSH_PERMISSION_MODE` 显式、`DEEPSEEK_API_KEY` 透传/缺失两路径、`danger-full-access` 被拒；
   - 结果映射：exit 0/exit 1/超时/cancelled 四终态；stderr 进失败摘要；
   - 版本 gate：mock probe 返回不匹配版本 → `DshVersionGateError`；allowVersion escape hatch 放行 + warning；
   - snapshot：`configSummary` 不含 key；restore 重建等价 adapter。
2. **L1 fixture 契约测试**（§5.3）：解析器对 2026-08-25 实测 fixture 的断言，CI 常驻。
3. **L2/L3**：opt-in/手动（§5.3）。
4. **回归锁定**：`provider-registry.test.ts` 更新为四个 built-in；既有全部测试不改断言全绿（bridge 关闭时零影响的硬证据）。
5. **e2e**：新 provider 不是新 CLI 命令，不触发"新命令必须 e2e"规则；`tekon run --provider dsh-headless` 的真跑 e2e 需 dsh + API key，CI 不可行，以 L3 手动验收 + 文档 checklist 兜底，诚实标注。

---

## 11. 范围收窄退路

若评审认为 rc 上游风险下实体 adapter 仍过于激进，**最小可交付**（独立成 PR、零生产风险）：

1. `dsh-bridge-probe.ts`：版本探测 + capability probe + `TESTED_DSH_VERSION` 常量 + `DshVersionGateError`；
2. L1 fixture 契约测试（解析器 + 映射逻辑对 fixture 全测）；
3. ACL 接口与映射函数（纯函数，不接 registry、不接 spawn）；
4. 文档：manual 增加"dsh 互操作现状：契约已探测、实体 bridge 待 dsh GA 后接入"章节。

此骨架是未来任何深度互操作（含 GA 后的 session 级互操作）的地基，且不引入任何运行时行为变化。实体 adapter（§4）作为骨架之上的可选第二步。

---

## 12. 风险与回归面

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| 上游 rc 破坏 headless 契约（文档/版本可见的变化） | 中 | pin 常量 + 运行时版本 gate 显式失败 + L1/L2 探测；默认关闭使爆炸半径为零 |
| 上游 **同版本静默行为漂移**（版本/help/config 不变,但 stdout 从一次写变多段、exit 语义变化）（评审 S4） | 中 | **pin+gate+L1/L2 抓不到此类漂移**——L1 是静态 fixture、L2 探测的是文档面;**只有手动 L3 live run 能抓**。此为 pin 方案的固有检测盲区,对默认关闭的 experimental provider 以 L3 手动兜底相称,但盲区在此显式记录,不给"已兜住"的错觉 |
| bridge 被误当稳定能力宣传 | 中 | 代码/文档/manual 全链路标 experimental；manual 写明能力天花板（一次性、无 artifact、无流式、**仅 goal/无 outputs 节点可用**） |
| 网络轴 posture 宽松于 codex（§7 M1 未决项） | 中 | 实现前必须闭合网络轴(§7 三选一);未闭合不得宣称等价 |
| agent 工作区写操作超出 Tekon 治理直觉 | 中 | 文件系统轴 dsh 更受限（§7）；拒绝 danger-full-access；DSH_HOME 隔离；文档明示 |
| 凭证泄露（API key 进 snapshot/日志） | 低 | configSummary 脱敏测试断言；不持久化 key |
| 枚举扩展引发旧代码未知分支 | 低 | 既有 unknown-provider 路径不变；snapshot restore 白名单化处理 |
| 回归面 | — | 默认关闭 + 不改既有断言；唯一共享改动是 registry/枚举，被既有 registry 测试覆盖 |

---

## 13. 被否方案

1. **绑定 `dsh-base` 库导出（候选 b）**：违背 §7.2/§10.3 硬约束，`./src/*` 是私有实现，rc 依赖图不可接受（§3.2）。
2. **接 web 端口 `/api` HTTP 面**：浏览器 UI 内部面 + trust fence，无公开契约，比 CLI 更易碎（§2.5/§3.2）。
3. **读 `$DSH_HOME/sessions` JSONL 补事件流**：绑定私有文件布局，直接违反"不绑私有 schema"。
4. **激活 `AgentDriver` 休眠契约做挂靠点**：边界兑现不了流式/followUp 承诺，且零消费者要双倍接线（§4.1）。
5. **把 dsh 加为 optionalDependency/devDependency**：~449 传递依赖的 rc 包进 lockfile，与默认关闭功能不相称（§9）。
6. **首期就做 session 级事件互操作**：边界上不存在事件流，预付架构违背 YAGNI（§3.3）。

---

## 14. target_files / 验收标准 / 未决问题

### 14.1 target_files（实现阶段才动；本设计任务未改）

新增：

- `packages/core/src/runtime/dsh-headless-adapter.ts` — adapter + 命令构造 + env 护栏
- `packages/core/src/runtime/dsh-bridge-probe.ts` — 版本 gate + capability probe + 常量
- `packages/core/__tests__/runtime/dsh-headless-adapter.test.ts`
- `packages/core/__tests__/runtime/dsh-bridge-probe.test.ts`（probe 纯函数单测）
- `packages/core/__tests__/runtime/dsh-bridge-contract.test.ts`（L1 fixture + L2 opt-in）
- `packages/core/__tests__/fixtures/dsh/` — 2026-08-25 实测输出 fixture

修改：

- `packages/core/src/runtime/provider-registry.ts` — 注册 `dsh-headless`（snapshotVersion 1）+ 版本 escape hatch 接线（`dshVersionGateOptions` 读 `TEKON_DSH_ALLOW_VERSION`）
- `packages/core/src/runtime/index` 导出：`packages/core/src/index.ts` re-export 两个新模块
- `packages/core/src/workflow/workflow-runtime.ts` — `defaultCommandPolicy` allow 列表加 `{ tool: 'dsh' }`（评审 M1；否则 gateway 拒每次真实 dsh run）
- `packages/core/src/types/config.ts` — provider 枚举 ×2 加 `'dsh-headless'` + 新增 `acknowledgeUnrestrictedNetwork` 字段
- `packages/core/src/types/domain.ts` — `runProviderConfigSchema.provider` 加值
- `packages/core/src/eval/work-usability.ts` — `workUsabilitySampleSchema.expectedProvider` 枚举(:37)加值(实现自查补全:原 §14.1 遗漏的第 5 处 provider 枚举;`.strict()` 下 eval 样本若期望 dsh-headless run 会被拒,故必须同步)
- `packages/core/src/runtime/agent-runtime.ts`（评审 S2 补全）— (1) `SupportedAgent` 类型联合(:27)加 `'dsh-headless'`;(2) `createAgentRuntime` 错误信息(:64 "Supported agents: ...")更新;(3) `defaultProviderConfig` 未知 agent 抛错处(:147-150)加 dsh-headless 分支(委托 `dshHeadlessProviderConfig`);(4) restore 白名单纳入 `dsh-headless`;(5) `summarizeAgentConfig` 持久化 ack 位
- `packages/core/src/runtime/agent-adapter.ts`（评审 S2）— `AgentRunResult.provider` 联合类型(:48)加值 + 网络 ack 护栏 carve-out（仅 dsh-headless+ack 放行 `network:'enabled'`）
- `packages/web/src/client/components/runs/StartRunForm.tsx`（评审 S4）— AGENT_OPTIONS 加 `dsh-headless` + experimental 内联标签
- `packages/core/__tests__/runtime/provider-registry.test.ts` — 四 built-in 断言 + dsh snapshot 往返/ack 剥离 fail-closed
- `packages/core/__tests__/runtime/agent-runtime.test.ts` — 错误信息断言同步
- `packages/core/__tests__/workflow/engine-unit.test.ts`（评审 M1 回归锁）— 断言 `dsh ∈ defaultCommandPolicy`
- `docs/manual/tekon-user-manual.md` + `.html` — experimental provider 章节（§1 第一屏红字 + §5.7 + `--agent` flag）
- `README.md` / `CHANGELOG.md` / `package.json`（MINOR bump：新 provider）

### 14.2 验收标准

1. `pnpm test` 全绿，既有测试零断言改动；
2. 不配置 `dsh-headless` 时，全仓无任何 dsh 进程 spawn / 版本探测发生(回归锁定测试)。**断言机制(评审 S5)**:对一次 codex/mock run 用 gateway spy 断言 `gateway.run` 从未以 `dsh` 命令(argv[0]==='dsh' 或 config.command)被调用;辅以 import 图约定——probe 模块只被 dsh adapter 工厂静态 import,不被 registry 之外的生产路径引用。
3. 版本 gate：PATH 上 dsh 版本 ≠ pin 时，`tekon run --provider dsh-headless` 显式报错退出，错误信息含实测/已测版本；
4. `danger-full-access` 配置被工厂拒绝；
5. L1 fixture 契约测试常驻通过；L2 在装了 dsh 的机器上手动通过；L3 在有 API key 时手动通过并留证；
6. manual 章节写明：experimental、一次性边界、无 artifact、需自行安装 dsh、**治理 posture 网络轴弱于 codex(不受限)、审批轴等价、文件系统轴 dsh 更受限**(按 §7 M1 三轴订正,绝不宣称笼统"等价")。

### 14.3 未决问题（已全部拍板，见 §17）

1. `DSH_PERMISSION_MODE` 默认值 → **定为 `workspace-write`**（adapter 显式钉死,不继承 ambient;`read-only` 几乎做不了任何事,而 goal run 需要工作区可写）。
2. 实体 adapter 与骨架的取舍 → **定为骨架 + 完整实体 adapter**（用户知情决策 §17.1）。
3. L2/L3 是否写入发布 checklist 强制项 → **是**(§5.3 已列;发布前手动 L2,有 key 时 L3 留证)。
4. 是否允许 config 覆盖 dsh 默认模型 → **不暴露**（YAGNI,§16 S7)。

---

## 15. 价值/风险比结论（诚实评估）

- **价值：低（评审 M2 订正后下调）。** headless 边界决定 bridge 只是"又一个 coding provider";更关键,**实体 adapter 在解决沙箱写 outputDir 问题前,对 standard-delivery 等交付 workflow 零节点可用(每个 artifact 节点确定性失败),真实可用范围只有 goal workflow 与无 outputs 的自定义 workflow**(§4.4)。而 goal run 用现有 codex/claude 同样能跑——**实体 adapter 不解决任何只有 dsh 能解决的问题**。真实价值仅剩:DeepSeek 模型可达环境(如特定网络)下 goal run 的 provider 空白填补、ACL/探针模式验证、为 GA 后深度互操作预埋地基。报告设想的 session 级互操作在此边界**无法兑现**。
- **风险：低（默认关闭时近零）。** rc 上游变动由 pin + gate + 探测兜住(同版本静默漂移是盲区,L3 手动兜底,§12);治理 posture 审批/文件系统轴不退化,**网络轴须实现前闭合(§7 M1)**。
- **评审(opus,2026-08-25)独立建议**:与 rc 成熟度相称的正确交付是**只落骨架**(§11:probe + pin gate + fixture contract test + ACL 纯函数,零运行时行为变化)。依据:实体 adapter 交付 workflow 零节点可用,不解决任何 dsh 独有问题,却引入网络轴未闭合的外部 rc 进程。
- **建议(据评审调整)**:5b **骨架为必交付项**(零生产风险,GA 后互操作地基)。实体 adapter 是否落地由用户在知情前提下决定——若落地,须:(1) 先闭合 §7 网络轴;(2) 默认关闭、全链路 experimental;(3) 把"实体 adapter 当前实际可用范围 = goal / 无 outputs 节点"写进 §15 与 manual 第一屏,而非埋在 §4.4。**若当前无 DeepSeek 模型 goal-run 需求,只落骨架是与成熟度相称的诚实选择。**

---

## 16. 评审响应记录（design review，2026-08-25）

opus reviewer 对照代码库与迁移评审报告逐条核实,检出 3 must-fix + 7 should-fix,已全部据实修订:

- **M1（治理网络轴，§7 已改）**:原 §7 笼统称 dsh workspace-write 与 codex "等价"未验证网络轴。实测 dsh 工具面含 web search(疑有出口),codex workspace-write 默认禁网、Tekon `permissionProfileSchema.network` 默认 disabled。§7 改为三轴对比(审批=等价、文件系统=dsh 更受限、网络=未验证疑更宽松),并把网络轴闭合列为**实现前硬前置**(三选一:钉死禁网/降 read-only/维护方书面接受)。网络轴闭合前不得宣称等价。
- **M2（artifact 机理与范围，§4.4/§15 已改）**:原 §4.4 称"agent 不知道 TEKON_OUTPUT_DIR"——经核实 `prompt-builder.ts:43` 对所有 provider 无条件注入协议,agent 确实收到。真实阻塞是沙箱边界:outputDir(`helpers.ts:183`)在 worktree 外,codex 靠 `--add-dir`(`codex-adapter.ts:234`)获权,dsh workspace-write cwd 不含它 → 每个 artifact 节点确定性失败。实际可用范围:standard-delivery 16 个 output 节点全失败,仅 goal(0 output 节点)可用。§4.4/§15 已按真实机理与范围重写。
- **M3（`--patch` 治理绕过口，§4.3 已改）**:原设计放行 `--patch`(profile 层,可能覆盖钉死的 sandbox/approval 插件)。改为首期拒绝所有 launcher flag(与 codex `assertSafeCodexArgs` 对称),YAGNI。
- **S1（restore 路径 gate，§5.1 已补）**:create/restore 双路径都过版本 gate;configSummary 记录已 gate 版本,restore 时比对当前二进制,不一致拒绝 replay。
- **S2（target_files 补全，§14.1 已补）**:补 `agent-runtime.ts` 的 SupportedAgent 类型(:27)、错误信息(:64)、defaultProviderConfig 分支(:147-150),`agent-adapter.ts` 的 AgentRunResult.provider(:48)。
- **S3（required-artifact 强制，§4.4 已明确）**:dsh adapter 镜像 codex/claude 的 missingRequiredArtifactTypes 强制(缺 required → 失败,不假成功)。
- **S4（同版本静默漂移盲区，§12 已显式）**:pin+gate+L1/L2 抓不到"版本不变行为变",只有 L3 手动能抓;风险表已显式记录盲区,不给"已兜住"错觉。
- **S5（零 spawn 回归锁定机制，§14.2 已补）**:gateway spy 断言从未以 dsh 命令调用 + import 图约定。
- **S6（subagent 面差异，§7 已记）**:dsh tool-ralph subagent vs codex 无 subagent 面,记录不含糊称等价。
- **S7（模型覆盖，§14.3 Q4）**:采纳评审,直接定为"首期不暴露",不再列为未决。

**评审确认为对的关键判断**:边界选型(子进程 CLI,ACL 结构性成立)、能力天花板诚实度(§3.3 全文最诚实,拒读私有 session JSONL)、AgentAdapter 挂靠点(AgentDriver 零消费者已核实)、不加 npm 依赖、骨架零运行时变化、§2.6 代码事实主张(三处枚举位置/custom 拒绝/PATH 先例)全部准确。

**评审对交付形态的独立专业判断**:与 rc 成熟度相称的正确交付是**只落骨架**——实体 adapter 交付 workflow 零节点可用,不解决 dsh 独有问题。已并入 §15。

**未决问题终态**:Q1(DSH_PERMISSION_MODE 默认)绑定 M1 网络轴闭合结果;Q2(骨架 vs 实体)+ 版本 bump 级别交用户知情决策;Q3(L2/L3 入发布 checklist)采纳=是;Q4(模型覆盖)定为不暴露。

---

## 17. 用户决策（2026-08-25，知情后拍板）

维护方在知悉评审结论(实体 adapter 交付 workflow 零节点可用、opus 建议只落骨架)后,明确决策:

1. **交付形态 = 骨架 + 完整实体 adapter**。理由(维护方原话):"不等 GA 了,每出一个新版本我们都 follow 一下进行适配就好了,GA 不知道啥时候才能用上,所以实现完整的能力。" → 接受 rc churn 的 follow-each-release 维护模型,落地完整 dsh-headless provider(默认关闭、experimental),不止步于骨架。
2. **版本 = MINOR 0.14.0**(含 5a 清理 + 5b)。
3. **dsh 网络 posture —— 知情后修订为"接受不受限网络出口"**。初始决策 3 是"与 codex 保持一致（禁网）",但 §18.1 探针证实 **dsh 任何沙箱模式都无法限制网络出口,该决策事实上不可实现**。维护方在获知此结论后明确改判(原话):"好吧,那网络出口这块就不严格对标了,落地完整的 adapter,接受网络出口吧。" → **最终决策:落地完整 adapter,接受 dsh 网络出口不受限**。工程落地必须诚实:
   - adapter 的 permission profile **诚实声明 `network: 'enabled'`**（绝不谎报 `restricted`）;
   - 由于 `assertAgentProviderCapabilities` 会拒绝 `network ∉ {disabled,restricted}` 的 provider,dsh adapter 必须走一条**显式确认**的构造路径——只有当 config 显式携带"我已知情接受 dsh 不受限网络"的确认位时才放行,否则照常抛错。这保证:(a) 全局能力护栏对其它 provider 与"误配 dsh"仍然生效(不静默弱化);(b) 弱化仅在显式知情确认下、仅对 dsh 一个 provider 生效——符合"人工控制、显式授权"的治理线;
   - manual **第一屏红字**标注 dsh-headless 联网、网络轴弱于 codex、仅适用于可接受出口的场景;
   - **网络轴闭合方式 = (c) 维护方书面接受"dsh 网络轴宽松于 codex"**（§7 三选一中的 c),本记录即书面依据。

## 18. 实现前实测结论（explorer 探针，2026-08-25，4 处官方 README + tarball 源码核实）

> 探针经 `npm pack` 解包 dsh + 16 个子包只读核实（GitHub 域名被本机网络策略拦截，但 tarball 是发布产物本身，证据强度等同官方源码）。仓库 `github.com/deepseek-ai/deepseek-harness`。

### 18.1 网络禁用手段 —— **不存在（决策性发现）**

- dsh 沙箱是 **"file effects only"**：`DSH_PERMISSION_MODE` 的三档（read-only/workspace-write/danger-full-access）**只管文件写效果,不管网络**。四处官方 README 明文：`dsh-bash-sandbox/README.md:22` "Network stays unrestricted"；同 README:85、`dsh-sandbox-policy/README.md:68`、`dsh-sandbox/README.md` 均重申"network restriction absent / outside vocabulary"。
- 无任何 flag / `DSH_*` env / config 可关网络出口。bash 工具可 curl 任意地址；web_search 走服务端 DeepSeek 检索（`fetch:false` 仅禁了 agent 直接 fetch，未禁 bash 联网）。
- 沙箱是 same-world confinement（bwrap/Landlock/Seatbelt），**明确不支持 container/microVM**。要断网只能 Tekon 在 **OS 层**（netns/防火墙/容器）自行隔离——而 Tekon 对 codex 并不这么做（codex 靠自身 `--sandbox` 声明式断网）。
- **与决策 3 的冲突**：决策 3（网络对齐 codex 禁网）在事实上**不可实现**——dsh 无手段,Tekon 能力护栏 `assertAgentProviderCapabilities`(agent-adapter.ts:117-123)又会拒绝一个网络无法证明受控的 provider（`network ∉ {disabled,restricted}` 即抛错）。诚实声明 `enabled` 会被护栏挡下,声明 `restricted` 是谎报。→ 见 §17 决策 3 的**知情后修订**。

### 18.2 outputDir 可写手段（add-dir 等价物）—— **不存在**

- `dsh-sandbox-policy/README.md:68`："One primary workspace root per session ... extra writable roots are **not** part of `SandboxExecutionPolicy`"。workspaceRoot = session cwd（不可变）。
- 无 codex `--add-dir` 等价机制。→ 证实设计 §4.4 判断：worktree 外的 `outputDir` 不可写,**实体 adapter 对交付类 workflow 零节点可用,仅 goal / 无 outputs 节点可用**。

### 18.3 其它护栏事实（供 adapter 实现钉死）

- **沙箱**：`DSH_PERMISSION_MODE` env 控制（非 flag),默认 `workspace-write`；adapter 必须**显式设 `workspace-write`**（不继承 ambient),拒绝 `danger-full-access`（=去沙箱+approval never）。
- **审批**：headless **无 answerer,`ask` 策略 fail-closed 自动拒绝**升级请求（`dsh-user-approval/README.md:268`）→ 与 codex on-request 非交互自动拒绝**等价**（§7 审批轴结论不变）。
- **逃逸面在 env/config 不在 flag**：无 `--yolo`,但 `DSH_PERMISSION_MODE=danger-full-access` 一行即解除沙箱+审批;`--patch` 可注入任意配置覆盖;`DSH_TOOLS_MODE` Code Mode。adapter 对策：显式钉 `DSH_PERMISSION_MODE=workspace-write`、拒绝所有 launcher flag（含 `--patch`,§4.3 M3）、gateway safe-default env 不继承用户 env。
- **DSH_HOME**：优先级 显式 > `$DSH_HOME` > `~/.dsh`;adapter 钉到 **worktree 之外**的 per-run 隔离目录(`<repoPath>/<dataDir>/runs/<runId>/<nodeId>-dsh-home`,见 §19 S2)。
- **遥测**：默认 `DISABLED`（`dsh-base/cordis.patch.yml:148`);gateway `envMode='exact'` 下 ambient `DSH_TELEMETRY_MODE` 也不会透传。
- **模型/凭证**：默认 `deepseek-v4-flash`;`DEEPSEEK_API_KEY`（env > `$DSH_HOME/.credentials.yaml` > `.env`）。
- **版本**：`--version` 输出 `0.1.1-rc.2`（pin 锚点确认）。

## 19. 实现后修订（code review 修复，2026-08-25）

reviewer(最高思考)对实现逐条核实,检出 1 must-fix + 6 should-fix,已全部据实修复:

- **M1(defaultCommandPolicy 缺 dsh)**:`workflow-runtime.ts` 的 `defaultCommandPolicy` allow 列表原只有 git/pnpm/npm/claude/codex,漏了 `dsh` → gateway 对每次真实 dsh run 报 "command does not match allow policy",实体 adapter 100% 失败(测试因注入自定义 policy 掩盖了断点)。已补 `{ tool: 'dsh', args: [] }`(与 codex 接入时对称),并加真实 defaultCommandPolicy + 名为 dsh 的 fake 二进制回归测试锁死。
- **S1(escape hatch 未接线,§5.1)**:registry create/restore 现读 `process.env.TEKON_DSH_ALLOW_VERSION` 透传给 adapter options,并接 `onWarn → console.warn`。错误信息指引的 env 通道现真实可用。
- **S2(DSH_HOME 位置,§4.2)**:原实现把 DSH_HOME 钉在 worktree 内(`<worktree>/.tekon/dsh-home`),agent 沙箱工具可写 dsh profile → 跨 run 提权风险(§18.3 逃逸面同理)。**复查发现首次修复无效**——用 `runContext.repoPath` 构造,而 workflow run 里 `runContext.repoPath === lease.worktreePath`(helpers.ts:229),DSH_HOME 仍在沙箱根内。**二次修复**:改用 `lease.repoPath`(主 repo,恒在 worktree 外)构造 `<mainRepo>/<dataDir>/runs/<runId>/<nodeId>-dsh-home`;测试用 main≠worktree 的 lease 断言 DSH_HOME 真的不以 worktreePath 开头(非平凡断言)。
- **S3(改名二进制丢契约,§4.3)**:原 `buildDshHeadlessCommand` 对非 `dsh` basename 走 fake 分支,丢 `--profile headless`/白名单/prompt。改为**对任何 command 都构造 `[--profile headless, ...safeArgs, prompt]` 且都过 `assertSafeDshArgs`**;仅版本探测保留 real-binary(basename==='dsh')判断。
- **S4(web 无法选 dsh,§6)**:`StartRunForm` AGENT_OPTIONS 加 `dsh-headless`(带 experimental·联网·仅 goal 内联标签)。
- **S5(manual 第一屏,§17 决策3)**:manual §1(md + html)provider 入口补 dsh-headless + 红字联网/仅 goal 警示,不再只在 §5.7。
- **S6(版本 gate 接线测试)**:补 4 用例——drift 版本 spawn 前 reject、allowVersion 放行 + warning、探测缓存一次、fake command 不探测。
- **N1/N3/N4**:CHANGELOG "safe-default" 措辞订正为 `exact`;`assertSafeDshArgs` 增拒 `--version`;artifact ingestion 注释订正(只读 outputDir,不摄取 worktree 内文件)。N2(exit1 映射)补测试。

修复后:5b 触及的四个测试文件 57 passed(3 skip);全量根聚合 1275 passed(3 skip)。残留风险(设计已记录、修复项无法消除):同版本静默行为漂移只有手动 L3 能抓(§12 S4 盲区);dsh profile 同名覆盖语义未实测(S2 依据,已用 worktree 外隔离规避);L3 live run 从未在本环境执行(无 dsh/无 key),生产正确性依赖 fixture + 手动验收。
