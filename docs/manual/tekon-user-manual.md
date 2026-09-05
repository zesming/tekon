# 天工（Tekon）用户使用手册

本文对应 v0.23.1。HTML 审阅版保留导航和语言切换；本轮更新内容提供中英对照，历史章节仍以中文为主。

名称说明：天工的英文名是 Tekon，取 Tech + Kong 的融合谐音，中文名取”天工”。

## 1. 天工是什么

天工（Tekon）是一个本地 Agent workflow 框架——一个”受控研发工作台”：用户把研发需求交给天工，天工会按固定 workflow 拆成角色任务、在隔离 worktree 中执行、跑验证 gate、沉淀 artifact 和审计记录，最后整理出可审阅材料和 PR 准备包。

天工的核心目标是增强人类交付能力。它帮助你把需求推进到”可以人工审阅、可以准备 PR、可以继续验证”的状态；合入、上线、权限扩大、生产变更仍然由人控制。

当前定位：

- 本地 CLI/Web 工具。
- 受控 workflow 执行器。
- 证据和审阅材料收集器。
- PR 准备助手。
- 研发工作样本评估器。
- 支持 mock、Claude Code 和 Codex provider 的本地执行入口；另含 experimental 的 dsh-headless（DeepSeek Harness）provider。
  - ⚠️ **dsh-headless 使用前必读**：默认关闭；agent 子进程**网络出口不受限**（弱于 codex，dsh 无法禁网）；**仅适用于 `--goal` 运行**（无法写产物目录，交付类 workflow 节点会失败）；需自行安装 `@deepseek-ai/dsh` 并配 `DEEPSEEK_API_KEY`。详见 §5.7。

## 2. 天工解决什么问题

### 2.1 需求进入研发前不清楚

真实工作里，很多需求只有一句话：“帮我补个功能”“修一下这个问题”。直接交给 Agent 容易出现边界不清、验收标准不清、风险不清。天工提供 `draft shape`，先把需求塑形成需求卡，包含：

- 需求标题和正文。
- 推荐 workflow 模板。
- 风险等级和风险标签。
- 非目标。
- 开放问题。
- 验收标准。

用户可以先审阅和批准需求卡，再发起执行。

### 2.2 不知道该选什么 workflow

不同工作不应该都套同一个流程。天工提供受控模板推荐：

- `standard-feature`：标准功能。
- `bugfix`：缺陷修复。
- `test-improvement`：测试补齐。
- `docs-update`：文档更新。
- `plan-only`：只做方案，不执行代码改动。
- `standard-delivery`：标准交付治理流程，包含 PM/RD/QA/Reviewer/PMO 完整角色链路、独立评审、AC evidence、QA signoff 和流程完整性 gate。

`workflow select` 会给出推荐模板和理由；`eval workflow-selection` 会检查人工选择是否合理。

### 2.3 Agent 输出不可审阅

很多 Agent 工具会把结果散落在对话、文件和日志里。天工要求 provider 输出结构化 artifact，并把 gate、日志、审计事件和 PR 包统一组织起来。用户可以通过 `review` 或 Web dashboard 看：

- readiness 失败项。
- 证据入口。
- Gate 失败诊断。
- 影响文件和 diff。
- Artifact 正文预览。
- Gate 日志。
- PR 准备包。
- 下一步命令建议。

### 2.4 远端副作用需要人控制

真实 push、创建 PR、等待远端 CI 都属于有副作用或外部依赖的动作。天工把这些动作拆开：

- `delivery dry-run`：只看交付计划。
- `delivery prepare`：只生成本地 PR 包。
- `delivery create-pr --approve-human`：人工明确批准后才 push 和创建 PR。
- `delivery ci-status` / `ci-watch`：只读查询 PR checks，不 rerun CI、不 merge、不上线。

### 2.5 需要判断一次 run 是否真的可交付

`eval readiness` 会评估单个 run 的交付证据是否完整。当前 `pr-prepared`、`pr-created` 和 `remote-ci-passed` 都是 required，因此在 PR 准备、真实 PR 创建或远端 CI 证据写回之前，`ready=false` 是预期状态。`eval work-usability` 会评估一组真实样本是否达到试用门槛，避免只靠 fixture 或 demo 宣称可用。

## 3. 核心用户场景

> 以下流程中标 `◇ 可选` 的步骤属于人类观察操作，不做也不影响流程推进，但建议在关键节点执行以便审阅。

### 场景 A：我有一个小功能，希望推进到可审 PR

适用例子：

- 给内部工具增加一个筛选条件。
- 为 CLI 补一个低风险命令。
- 给 Web dashboard 增加一个入口。

推荐流程（Human ↔ Tekon 交替时序）：

1. **Tekon**: `tekon init` 初始化目标仓库。
2. **Tekon**: `draft shape` 把需求写成需求卡。
3. **Human**: 人工审阅需求卡，确认边界和验收标准。
4. **Human**: `draft approve` 批准需求卡。
5. **Tekon**: `run` 发起 workflow。
6. **Human** ◇ 可选: `status` 和 `review` 查看结果和审阅面。
7. **Tekon**: `delivery prepare` 生成 PR 准备包。
8. **Human**: 人工确认后 `delivery create-pr --approve-human` 创建远端 PR。
9. **Tekon**: `delivery ci-status` 或 `ci-watch` 写回远端 CI 证据；`eval readiness` 判断完整性。

### 场景 B：我只想修一个 bug，但需要人工确认风险

适用例子：

- 修改一个已有逻辑分支。
- 修复一个低风险接口问题。
- 调整一个内部工具的状态处理。

推荐流程：

1. **Tekon**: 使用 `bugfix` 模板运行 workflow。
2. **Tekon**: 如果触发 human gate，先执行 `approval summary` 生成审批摘要。
3. **Tekon**: 用 `eval approval-summary` 检查审批摘要是否完整。
4. **Human**: 人工判断后选择：
   - `resume --approve-human`：批准继续。
   - `approval reject`：拒绝并阻断 workflow。

### 场景 C：我只想补测试

适用例子：

- 为某个模块补单测。
- 为失败路径补回归测试。
- 为 CLI 或 Web API 增加覆盖。

推荐流程：

1. **Tekon**: `workflow select` 确认是否推荐 `test-improvement`。
2. **Tekon**: `run --template test-improvement` 执行。
3. **Human** ◇ 可选: 查看 gate 是否通过。
4. **Human** ◇ 可选: 用 `review` 检查 artifact 和测试证据。

### 场景 D：我只想写文档或方案

适用例子：

- 更新用户手册。
- 整理验收报告。
- 写技术方案或产品方案。

推荐模板：

- `docs-update`：文档更新。
- `plan-only`：只做计划或方案，不推进代码改动。
- `standard-delivery`：需要验证完整角色链路时使用；当前适合 Tekon 自身 dogfooding 和低风险种子任务，不适合直接承诺生产级强治理。

### 场景 E：我要判断天工是否已经能用于真实工作

推荐流程：

1. 挑选 2 到 3 个真实但低风险的仓库。
2. 准备 10 个真实或历史需求。
3. 每次 run 后用 `eval work-usability record` 写入样本清单。
4. 用 `eval work-usability --samples` 评估样本集。
5. 把 Markdown/HTML 报告保存到 `docs/reviews/`。

## 4. Quick Start

以下示例假设已通过安装脚本将 `tekon` 配置到 PATH，并且你正在目标项目根目录执行命令。从其它目录操作目标仓库时，显式追加 `--repo /path/to/project`。

### 4.1 安装

一键安装（推荐）：

```bash
curl -fsSL https://raw.githubusercontent.com/zesming/tekon/main/scripts/install.sh | bash
```

安装脚本会自动完成克隆、安装依赖、构建，安装完成后输出 PATH 配置命令。按提示将 `tekon` 加入 PATH 并 `source` 对应 rc 文件即可。前置依赖：`git`、`node`（`^20.19.0` 或 `>=22.12.0`）、`npm`。CI 精确验证 `20.19.0`、`22.12.0`、`22.19.0`，并跟踪 `24.x` 最新补丁；该集合不等于对 Node 23/25/26 或未来 major 的生产支持承诺。

如需指定安装目录或分支：

```bash
TEKON_HOME=/opt/tekon TEKON_VERSION=main curl -fsSL https://raw.githubusercontent.com/zesming/tekon/main/scripts/install.sh | bash
```

### 4.1.1 更新

```bash
tekon update
```

自动拉取最新代码、安装依赖、重新构建，完成后输出版本变更。

### 4.2 初始化目标仓库

```bash
tekon init
```

初始化会在目标仓库生成 `.tekon/` 运行态目录，包含配置、数据库、工作区、workflow、角色和 Web session token。

### 4.3 检查目标仓库命令画像

```bash
tekon workflow preflight
```

重点看：

- `status=resolved`：该 gate 命令已解析。
- `status=missing`：目标仓库缺少对应命令，需要补 repo profile。
- `status=not-applicable`：用户显式声明不适用。
- `status=not-command-gate`：schema、role-scope、QA signoff 等语义 gate 不需要 repo profile 命令。
- `suggestedCommand`：天工从 `package.json` 中推断出的候选命令，需要人确认。

### 4.4 塑形需求

```bash
tekon draft shape "给 Web dashboard 增加审批摘要展示，要求 e2e 通过"
```

命令会输出 `shapePath` 和 `reviewPath`。先读 Markdown 审阅稿，确认需求边界后批准：

```bash
tekon draft approve
```

可选：评估需求卡质量。

```bash
tekon eval demand-shape
```

### 4.5 发起运行

```bash
tekon run
```

普通 workflow/Goal 启动前，CLI 向 stderr 打印 `Request ID: …`；保存它，超时或结果丢失后可加 `--request-id <原标识>` 按相同需求和参数重试。受理后输出 `runId`，同一请求的重试返回原运行身份。后续常规命令默认读取最近一次 run；查看历史 run 或避免歧义时传 `--run-id`。目录未就绪时显示“已受理，等待目录就绪”或“已受理，等待目录恢复”；任务尚未执行，处理方式见 §6.6。

明确长程任务可以在 run 级别显式放大外层预算，例如 2 小时总超时、20 分钟无输出进展超时、30 秒 heartbeat：

```bash
tekon run --timeout-ms 7200000 --no-progress-timeout-ms 1200000 --progress-heartbeat-ms 30000
```

未传 `--template` 时默认运行 `standard-delivery`；未传 `--agent` 时默认使用 Codex provider。离线回归或演示时，可显式切到 mock provider：

> **计划预览与实际执行绑定**：Web 的 workflow/Goal 预览绑定完整模板、执行模式、确认参数与实际使用的仓库检查配置；Goal 使用内置 goal 模板。在“检查配置与适用性”中展开详情，查看每项检查的来源及执行或跳过方式；刷新后核对变化，再点击提交。出现 `PLAN_DIGEST_MISMATCH` 时，点击“刷新执行计划”重新审阅，不自动接受新计划。预览不会展示原始工具、参数、环境变量或不适用理由。新运行保留受理时的检查命令、来源与适用性，执行、恢复和返工沿用原记录；这不冻结脚本正文或整个环境。历史绑定边界见 §6.7，完整确认步骤见 §7。

```bash
tekon run --template standard-delivery --agent mock
```

Codex provider 使用本机 `codex exec` 非交互模式，通过 `TEKON_OUTPUT_DIR` 和 `$TEKON_ARTIFACT_MANIFEST` 写回结构化 artifact。真实 provider 默认总超时 1 小时，无输出或产物进展超时 15 分钟，可用 `--timeout-ms`、`--no-progress-timeout-ms`、`--progress-heartbeat-ms` 覆盖。执行过程会写入 progress JSON 支持 resume，QA validation 会记录 tested ref 确保所测即所得。远端副作用仍由 `delivery create-pr --approve-human` 人工批准后执行。

### 4.6 查看结果

```bash
tekon status
tekon review
```

此时可以先看审阅面、gate、artifact、diff 和 PR 包建议。PR/CI 证据尚未写回前，`eval readiness` 通常会因为 `pr-prepared`、`pr-created` 或 `remote-ci-passed` 失败而保持 `ready=false`。

### 4.7 准备 PR 材料

```bash
tekon delivery prepare
```

这一步当前只支持 `standard-delivery` 治理 run，只生成本地 PR 包，不 push、不创建 PR。生成前会执行 pre-PR readiness：workflow 必须 passed、无 pending human gate、验证 gate 与安全扫描满足、AC evidence 完整、QA release signoff 必须通过且绑定 QA validation 记录的 tested ref。未满足时不会生成 PR 包。

### 4.8 创建远端 PR

确认 PR 包、diff、gate 和审阅面后，才执行：

```bash
tekon delivery create-pr --approve-human
```

这一步会产生真实远端副作用：push 分支并调用 GitHub CLI 创建 PR。执行前会重新生成并校验 PR 包，因此不会绕过 pre-PR readiness、QA signoff 和所测即所得校验。受控 `git/gh` 命令和 create-pr 前置只读 probe 默认 1 小时总超时、15 分钟无 stdout/stderr 或受控输出目录文件进展超时，并写入 progress JSON；delivery 分支名和 base branch 会拒绝 `--mirror`、`:branch`、空白、`..`、`@{` 等不安全 ref。

### 4.9 查询远端 CI

```bash
tekon delivery ci-status
```

如果希望等待 checks 到终态：

```bash
tekon delivery ci-watch --max-attempts 20 --interval-ms 15000
```

远端 CI 证据写回后，再执行：

```bash
tekon eval readiness
```

### 4.10 默认上下文规则

天工的常规 CLI 使用方式是“进入目标仓库根目录后执行短命令”。默认推断规则如下：

- Repo：优先使用 `--repo`；不传时从当前目录向上查找 `.tekon/config.yaml`，找不到时使用当前 Git 仓库根目录。
- Demand shape：`draft shape` 默认写入 `.tekon/demands/`；`draft approve` 默认批准最近需求卡，如果最近需求卡已经批准，历史未批准需求卡必须显式传 `--shape <path>`；`eval demand-shape` 默认评估最近一张需求卡。
- Run：`run` 没有需求文本且没有 `--demand-file` 时，默认读取最近需求卡，且该需求卡必须已批准；`status`、`review`、`eval readiness`、`delivery prepare` 等默认使用最近一次 run。
- Human decision：`approval summary`、`eval approval-summary`、`approval reject` 和 `resume --approve-human` 默认使用最近的 pending human decision；如果同一 run 同时存在多个 pending decision，必须显式传 `--decision-id`。

需要显式传参的情况通常只有三类：从其它目录操作目标仓库时传 `--repo`；查看或处理历史对象时传 `--run-id`、`--shape`、`--demand-file`、`--decision-id`；执行高风险动作时保留 `--approve-human` 或 `--allow-dirty-base` 作为明确人工确认。

如果你显式传了 `--repo`、`--run-id` 或 `--decision-id` 查看跨仓库或历史对象，`review` 和 `approval summary` 会输出带 id 和 repo 的精确后续命令，避免复制短命令后误操作到最新 run、最新待审批项或当前 shell 目录。

## 5. 核心概念

### 5.1 Repo

目标仓库，也就是你希望天工处理的项目。天工自身仓库和目标仓库可以相同，也可以不同。

### 5.2 `.tekon/`

天工在目标仓库中的运行态目录。它保存：

- 配置。
- SQLite 数据库。
- run artifact。
- gate 日志。
- worktree。
- draft shape 文件。
- Web session token。

通常不提交 `.tekon/`。重要结论应写入 `docs/reviews/` 或其它可提交文档。

### 5.3 Run

一次 workflow 执行。每个 run 有唯一 `runId`，例如 `run_xxx`。用户查看状态、审阅材料、准备 PR、查询 CI 都围绕 run id 进行。

### 5.4 Workflow

一组有顺序和依赖的角色节点。当前常用内置模板：

- `standard-feature`
- `bugfix`
- `test-improvement`
- `docs-update`
- `plan-only`
- `standard-delivery`

### 5.5 Role

执行节点的角色，例如 PM、RD、QA、Reviewer、PMO。角色决定 prompt、知识和工具策略。

### 5.6 Gate

验证关卡。常见 gate：

- build
- lint
- test
- schema
- security-scan
- human
- independent-review
- role-scope
- ac-evidence
- qa-signoff
- process-completeness

Gate 不通过时 workflow 不应被当成可交付。

### 5.7 Provider

Provider 是执行节点的 agent 后端。当前用户可见选项：

- `mock`：确定性本地 provider，适合 fixture、回归测试和流程验收。
- `claude-code`：本机 Claude Code adapter，需本机认证和单独 smoke 证据。
- `codex`：本机 Codex CLI adapter，使用 `codex --profile internal ... exec` 非交互执行，需本机 Codex CLI 已安装并认证 internal profile。
- `dsh-headless`（**experimental，默认关闭**）：本机 DeepSeek Harness（`dsh`）adapter，经 `dsh --profile headless "<task>"` 一次性子进程边界执行。**使用前必读的硬边界：**
  - ⚠️ **网络出口不受限，弱于 codex**：dsh 沙箱只管文件写效果，任何模式都无法关闭网络出口（4 处官方 README 实证）。codex 的 `workspace-write` 默认禁网，dsh 不能。选用 `dsh-headless` 即接受 agent 子进程可任意联网；要真正断网只能自行在 OS 层（网络命名空间/防火墙/容器）隔离。
  - ⚠️ **仅适用于 goal / 无产物节点**：dsh 只有单一工作区可写根（=运行目录），无 codex `--add-dir` 等价机制，无法写 worktree 之外的产物目录。因此 standard-delivery 等交付类 workflow 的每个产物节点都会确定性失败；实际可用范围只有 `--goal` 运行与无 outputs 的自定义 workflow。
  - 一次性、未向 Session/UI 投影执行期流、无 follow-up：跑完出结果，取消靠杀子进程。需自行安装 `@deepseek-ai/dsh`（Tekon 不捆绑），并配置 `DEEPSEEK_API_KEY`。Tekon 钉死该版本（当前 `0.1.2-alpha.3`），版本不符即显式报错退出（developer-preview，随时可能不兼容变更）。官方参考参见 [DeepSeek Harness alpha.3 CLI Reference](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.3/apps/cli/reference/README.md)（资料内容：DSH headless 会把 reasoning delta 流式写 stderr、最终文本写 stdout，并定义参数规范与内置会话遥测机制；对 Tekon 判断：当前 adapter 仅收集日志、未向 Session/UI 投影该 stream，且缺乏多工作区产物外写机制，仅可作为 experimental goal-only provider，且 preflight 与 Run 必须硬关断内置 session telemetry）。
  - ⚠️ **Node 版本要求与 Tekon 主合同不同**：DSH 要求 Node `^22.19.0 || >=24.0.0`，而 Tekon 主合同允许 Node `^20.19.0 || >=22.12.0`。preflight 会在探测 dsh 二进制之前硬拦截不兼容的宿主 Node（Node 20.x、22.12 及以上但低于 22.19、奇数版本线如 23.x），并给出升级指引。若确认 dsh 实际运行在更高版本 Node 上（如全局安装在 Node 24 下），可设置 `TEKON_DSH_ALLOW_HOST_NODE=<当前版本号>` 精确放行，preflight 会输出旁路警告。
  - ⚠️ **Metadata 预检采用最小环境和隔离临时 workspace**：Tekon 为内置 Version/Config/Help probe 创建一次临时 root，统一设置 `cwd=root`、`DSH_HOME=root/dsh-home`、`DSH_AGENTS_HOME=root/agents-home`，只透传命令启动、home/temp/locale 等白名单值，并固定 `DSH_TELEMETRY_DISABLED=1`。这会切断 DeepSeek Harness rc.1 已确认的 invocation cwd `.env`、DSH home `.env` 与 `.credentials.yaml` 自动 fallback；完成后临时 root 会清理。它**不是 OS sandbox**，不能阻止同 UID 恶意二进制主动读取宿主文件，也不修改用户宿主环境。正式 Run 仍使用独立的 `envMode: exact` 白名单，但 worktree `.env`、代理配置、凭据来源与内部工具执行证据仍是独立风险，不因 metadata 隔离而关闭。2026-09-03 的无凭据 Wrapped L2 已验证官方 [`0.1.2-rc.1`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-rc.1) 的 Version/Config/Help 合同；因 L3 真实模型调用尚未完成，Tekon tested pin 继续保持 `0.1.2-alpha.3`。

**Provider 环境预检**：使用 `dsh-headless` 前，可先运行预检命令确认本机环境与 Tekon 钉死版本兼容：

```bash
tekon provider preflight dsh-headless
```

它会检查实际安装的 `dsh` 版本、headless help 合同与默认配置插件组合，输出 tested 版本、actual 版本、合同校验结果与精确的兼容安装命令；兼容时退出码 0，不兼容时退出码 1。Web 与 CLI 在使用 `dsh-headless` 发起运行时，也会在任何运行记录产生之前自动执行同样的预检，不兼容时立即给出可读错误，不会带着残缺能力进入执行。

Web 顶栏将凭据和 Provider 分开显示。凭据校验不等待可选 DSH 探测；凭据有效后，独立检查 `dsh-headless`，显示“检查中 / 可用 / 不可用 / 检查失败”，并提供上次检查时间和重试按钮。页面按服务端返回的过期时间刷新结果；检查失败时保留的旧时间不代表本次检查成功。凭据有效只说明连接授权有效，不保证 Provider 可执行；需要诊断时运行上述 `tekon provider preflight dsh-headless`。

真实 provider 都必须提供 artifact manifest。Tekon 会把 provider 产物写入 Artifact Store，并把 provider/config 摘要落库到 run provider snapshot；resume 时按快照恢复，避免旧 run 意外换成其它 provider。

### 5.8 Artifact

结构化产物，例如需求卡、代码变更说明、测试报告、审阅报告、PR 包、CI 状态。Artifact 是人工审阅和自动评估的主要证据。

### 5.9 Review Surface

聚合审阅面。CLI 命令是 `review`，Web dashboard 也使用同一套数据。它把用户最需要看的东西放在一起。

### 5.10 Readiness

单次 run 的工作就绪度评估。它回答：“这次 run 的 workflow、gate、artifact、PR 准备、真实 PR 和远端 CI 证据是否已经完整？”

### 5.11 Work Usability

样本集级评估。它回答：“天工是否已经在足够多真实样本上表现稳定，可以作为受控工作工具试用？”

## 6. 命令详解

### 6.1 `init`

用途：初始化目标仓库。

```bash
tekon init
```

常用参数：

- `--repo <path>`：从其它目录初始化指定仓库时使用。不传时自动使用当前 Git 仓库根目录或当前目录。

结果：

- 创建 `.tekon/`。
- 创建 `.tekon/config.yaml`。
- 创建 `.tekon/repo-profile.yaml`。
- 创建 `.tekon/web-session.json`。
- 创建运行所需目录。

问题处理：

- 如果目标目录不是 Git 仓库，后续涉及 diff、worktree、delivery 的功能可能失败。
- 如果 `.tekon/web-session.json` 被删除，Web 写操作会缺 token；可重新执行 `init`。

### 6.2 `workflow preflight`

用途：在真正运行前检查 workflow 会用哪些命令。

```bash
tekon workflow preflight
```

常用参数：

- 第一个位置参数：模板名；不传时默认 `standard-delivery`。
- `--repo <path>`：只在跨仓库检查时使用。

如何判断结果：

- `resolved`：可执行。
- `missing`：缺命令，需要补 repo profile。
- `not-applicable`：用户已显式声明不适用。
- `not-command-gate`：语义 gate，不需要 repo profile 命令。

常见处理：

- 如果提示 `missing-command`，先看 `suggestedCommand`，确认语义后写入 `.tekon/repo-profile.yaml`。
- 不要为了通过 gate 随意配置 `notApplicable`；必须写清楚原因。
- `security-scan` 不应通过 `notApplicable` 绕过。

### 6.3 `workflow select`

用途：根据需求文本推荐受控模板。

```bash
tekon workflow select "补齐 CLI 单元测试"
```

结果：

- 推荐模板。
- 候选模板。
- 推荐理由。

注意：

- 这不是动态规划。
- 不会自动保存 workflow。
- 人可以覆盖推荐，但建议用 `eval workflow-selection` 检查。

### 6.4 `draft shape`

用途：把原始需求转成可审阅需求卡。

```bash
tekon draft shape "需求文本"
```

> **交互式替代**：`tekon draft new` 提供 Agent 驱动的交互式需求澄清流程（见 6.22），可根据需求内容生成针对性问题并自动精炼草案。推荐在需求不明确时优先使用。

常用参数：

- `--no-write`：只预览，不写入 `.tekon/demands/`。
- `--repo <path>`：只在跨仓库塑形时使用。
- `--format json`：输出 JSON。

结果：

- JSON 源文件。
- Markdown 审阅稿。
- 推荐模板。
- 风险和验收信息。

问题处理：

- 如果 `openQuestions` 不为空，建议先补充需求；也可以在明确接受风险后批准。
- 如果推荐模板不符合预期，先用 `workflow select` 和 `eval workflow-selection` 核对原因。

### 6.5 `draft approve`

用途：人工批准需求卡进入执行阶段。

```bash
tekon draft approve
```

常用参数：

- 位置参数或 `--shape <path>`：指定需求卡 JSON 路径；不传时默认批准最近需求卡。如果最近需求卡已经批准，历史未批准需求卡必须显式指定。
- `--actor <name>`：记录批准操作者；建议使用真实账号或姓名。

结果：

- 需求卡标记为 approved。
- 写入批准时间和批准人。

注意：

- 批准需求卡不等于批准 PR 创建。
- 批准需求卡不绕过后续 gate。

### 6.5.1 `draft plan` / `draft plan-approve`（可选计划审批）

用途：在需求批准之外，为需求卡显式生成一份「计划产物」并单独审批。计划审批与需求审批相互独立——需求审批确认「要不要做」，计划审批确认「按这个计划做」。这一步是可选的：不生成计划的需求卡（含所有旧需求卡）不受计划审批点约束。

生成计划：

```bash
tekon draft plan
```

- 位置参数或 `--shape <path>`：指定需求卡 JSON 路径；不传时默认取最近需求卡。
- 结果：需求卡标记 `hasPlan=true`、`planApproved=false`。计划内容是该需求卡的验收标准、推荐模板与 Non-goals 的结构化快照。
- 重新生成计划会使之前的计划审批失效（`planApproved` 重置为 false）。

审批计划：

```bash
tekon draft plan-approve
```

- 位置参数或 `--shape <path>`：指定需求卡 JSON 路径；不传时默认取最近需求卡。
- `--actor <name>`：记录计划审批操作者。
- 前置：必须先 `draft plan` 生成计划，否则报错。
- 结果：需求卡标记 `planApproved=true`，写入审批人与时间。

对运行的影响：

- **已生成计划的需求卡**：必须先 `draft plan-approve`，否则 `tekon run`（及 Web 发起运行）拒绝执行。
- **未生成计划的需求卡**：不受影响，`approve` 后即可运行（向后兼容）。
- 计划审批同样不等于批准 PR 创建，也不绕过后续 gate。

### 6.6 `run`

用途：发起一次 workflow。

模板运行：

```bash
tekon run "需求文本" --template standard-delivery --agent mock
```

需求卡运行：

```bash
tekon run
```

动态 dry-run：

```bash
tekon run --dynamic --dry-run "需求文本" --agent mock
```

轻量目标运行（goal 模式）：

```bash
tekon run "做一个一次性小任务" --goal --agent mock
```

`--goal` 使用内置单节点 goal 模板执行一次轻量 Agent 目标，不套用完整交付工作流（不产出 code-changes、不进入交付流程）；与 `--template` 互斥。

常用参数：

- `--template <name>`：使用内置模板。
- `--goal`：轻量目标运行（内置单节点 goal 模板，不接交付）；不能与 `--template` 同时使用。
- `--demand-file <path>`：使用指定已批准需求卡；不传需求文本时默认读取最近需求卡并要求它已批准。
- `--agent mock`：使用 mock provider。
- `--agent claude-code`：使用 Claude Code adapter。
- `--agent codex`：使用本机 Codex CLI adapter；要求 `codex` 在 PATH 中且已完成本机认证。
- `--agent dsh-headless`（experimental，默认关闭）：使用本机 DeepSeek Harness adapter；要求 `dsh` 在 PATH 中、版本与 Tekon 钉死版本一致、已配置 `DEEPSEEK_API_KEY`。**网络出口不受限、仅适用于 `--goal` 运行**（详见 §5.7 provider 列表的硬边界）。
- `--dynamic --dry-run`：只生成动态 workflow 预览。
- `--request-id <id>`：复用一次提交意图的标识；8–128 个 ASCII 字母、数字、下划线或连字符，省略时自动生成。
- `--allow-dirty-base`：允许基于当前未提交业务改动运行。
- `--repo <path>`：只在跨仓库运行时使用。

如何判断结果：

- 输出 `runId` 后，用 `status` 和 `review` 继续检查。
- `status=passed` 不代表可以自动合入。
- 有 pending human gate 时，需要先处理审批。

**重试同一次提交**：普通 workflow/Goal 在启动前向 stderr 打印 Request ID。超时、断连或未收到结果时，保留原需求、文件引用和所有执行参数，追加原标识重试：

```bash
tekon run "给列表增加筛选" --agent mock --request-id delivery-20260905-01
```

相同 requestId 与相同意图返回原 Run/Session/Job；已受理后，不会因为当前需求卡、模板或 Provider 环境变化而另建运行。`REQUEST_ID_CONFLICT` 表示该标识已绑定其他意图：先核对是否误改参数；如果确定要另建任务，换一个新标识。不要为一次尚待确认的原请求盲目换号。

| 看到的状态 | 如何判断与处理 |
| --- | --- |
| 本次未创建 | 本次校验失败或事务回滚。修正输入；同内容重试继续用原标识。它不证明同标识的其他在途调用永远不会受理。 |
| 已受理 | 已有持久运行身份。观察原 Run/Session；重试不创建第二份。 |
| 已受理，等待目录就绪 | `filesState=pending`，请求已受理，目录尚未准备完成，任务尚未执行。保留原身份继续观察。 |
| 已受理，等待目录恢复 | `filesState=recovery_required`，请求已受理，任务尚未执行。修复目录的类型、权限或链接问题后，按原请求重试。 |
| 受理状态待确认 | 网络或数据库问题使结果无法确定。保留原标识，查询或原样重试；不要据此新建另一运行。 |

CLI 目录失败会打印 Run/Session ID 并以非零状态退出。用 `tekon status --run-id <runId>` 检查 `admission` 和 `filesState`；Web 可在修复目录后重启 UI 服务触发恢复，查询按钮本身不会修复目录。恢复保留原始 Job，不复活已取消或终态运行。

**本次运行使用哪些检查**：普通 CLI 在启动请求时捕获模板实际使用的仓库命令及来源、不适用和缺失决定，没有逐项交互预览。新受理计划为 v3；后续执行、恢复、修复重试及返工沿用原记录，修改或删除当前配置不会替换它。无命令引用的模板不依赖仓库命令配置，模板内联命令优先。绑定只覆盖 Tekon 解析出的命令描述符与适用性，不冻结 `package.json` scripts 正文、测试代码、PATH 二进制、依赖或宿主环境。需要采用新配置时，应明确发起另一个任务。

**dry-run 的当前限制**：`--dry-run` 仅支持 `--dynamic`；普通 workflow 和 `--goal` 搭配 `--dry-run` 会在项目初始化前返回 `DRY_RUN_UNSUPPORTED`。动态预览不受理 Run，不支持 `--request-id`；它仍可能初始化本地目录，`--save-as` 会保存预览，不应当作“完全不写本地文件”的命令。

### 6.7 `status`

用途：查看 run 当前状态。

```bash
tekon status
```

常见字段：

- `status`：整体状态。
- `currentNode`：当前节点。
- `artifacts`：产物数量。
- `gates`：gate 数量。
- `pendingHumanDecisions`：待人工决策数量。
- `admission` / `filesState` / `requestId`：新运行的受理、目录就绪状态和原请求标识。`admission=recovery-required` 表示请求已受理、目录未就绪；`filesState` 区分等待就绪的 `pending` 和等待恢复的 `recovery_required`。不要仅看 `status` 或已有 Run ID 判断执行进度。
- `executionBinding`：仓库检查绑定状态，含义如下；Web Run 详情和关联 Run 的 Session 详情也显示相应提示。

| `executionBinding` | 如何判断 |
| --- | --- |
| `frozen` | 检查命令与适用性已记录，执行和恢复沿用它；不代表整个环境冻结，也不替代执行前的完整性校验。 |
| `legacy-unbound` | 历史 v1/v2/无快照计划未记录仓库命令绑定；使用 `commandRef` 时会按当前配置解析。v2 已记录的内联命令仍在原模板中，历史运行不会自动升级。 |
| `invalid` | 计划记录无效，无法按此记录执行或恢复。保留原运行，请仓库维护者核查。 |
| `unknown` | 当前无法识别或未取得绑定信息；刷新查看，不能据此认定检查已绑定，执行前仍须通过服务端校验。 |

### 6.8 `approval summary`

用途：生成可复制审批摘要。

```bash
tekon approval summary
```

常用参数：

- `--run-id <runId>`：查看指定历史 run 的审批项时使用；不传时默认最近的 pending human decision。同一 run 有多个 pending decision 时必须传 `--decision-id`。
- `--decision-id <decisionId>`：同一 run 有多个 pending decision 或需要指定历史决策时使用。
- `--max-chars <n>`：限制 artifact 和日志预览长度，默认 1200。
- `--json`：输出结构化 JSON，便于接入其它工具。

摘要包含：

- decision id。
- run id。
- node id。
- 需求标题。
- 风险。
- exact command。
- 影响文件状态。
- readiness 失败项。
- 证据入口。
- 批准命令。
- 拒绝命令。
- Web 处理入口。

注意：

- 摘要是审批材料，不是通知机器人。
- 默认拒绝命令不携带操作者示例，避免复制错误审计信息。

### 6.9 `eval approval-summary`

用途：检查审批摘要是否完整。

```bash
tekon eval approval-summary
```

判断方式：

- `ready=true`：摘要具备基本审批材料。
- `ready=false`：不建议拿给 reviewer 决策，应先补证据。

当前会检查：

- pending decision 是否存在。
- 风险信息是否存在。
- exact command 是否存在。
- 影响信息是否存在。
- 批准入口是否可复制。
- 拒绝入口是否可复制。
- 证据上下文是否存在。
- 正文是否包含关键命令。

### 6.10 `resume --approve-human`

用途：批准 pending human gate 并继续运行。

```bash
tekon resume --approve-human
```

注意：

- 只在你已经审阅风险和证据后使用。
- 会按 run 创建时落库的 provider 快照恢复。
- 同一 run 有多个 pending decision 时必须传 `--decision-id <decisionId>`；显式指定后只批准这一条 decision。
- 旧 run 缺 provider 快照时会拒绝继续，避免从真实 provider 意外切到 mock。
- run 已处于终态(`passed`/`failed`/`cancelled`)时，`resume` 会拒绝并以非 0 退出、打印中文提示("运行已处于终态 …，无法恢复"),不会把已结束的运行重新拉起。

### 6.11 `approval reject`

用途：拒绝 pending human decision 并阻断 workflow。

```bash
tekon approval reject
```

常用参数：

- `--run-id <runId>`：拒绝指定 run 的 pending decision 时使用。
- `--decision-id <decisionId>`：同一 run 有多个 pending decision 或要精确拒绝某个 decision 时使用。
- `--actor <name>`：记录拒绝操作者；建议使用真实账号或姓名。
- `--note <text>`：记录拒绝原因。
- `--repo <path>`：只在跨仓库操作时使用。

结果：

- human decision 变为 rejected。
- workflow 阻断。
- human gate 分类为 `human-rejected`。
- `review` 会显示人工拒绝语义，不会误判成命令策略拒绝。
- run 已处于终态时,`approval reject` 会拒绝并以非 0 退出、打印中文提示,不会把终态运行改写为 blocked(避免"终态→拒绝→阻断→恢复"复活链)。

### 6.12 `review`

用途：看完整审阅材料。

```bash
tekon review
```

重点章节：

- `Readiness Failed Checks`
- `Evidence Navigation`
- `Gate Failure Triage`
- `Delivery`
- `Changed Files`
- `Artifacts`
- `Gate Logs`
- `PR Body`
- `PR Package`
- `Next Commands`

如何使用：

- 先看 readiness 失败项。
- 再看 Evidence Navigation 指向的证据。
- Gate 失败时先看 triage 分类和建议命令。
- 准备 PR 前看 Changed Files 和 PR Body。

### 6.13 `delivery dry-run`

用途：只看交付计划，不产生远端副作用。

```bash
tekon delivery dry-run
```

适合：

- 第一次接入仓库。
- 不确定 PR 命令是否正确。
- 只想审阅 evidence 和命令计划。

### 6.14 `delivery prepare`

用途：生成本地 PR 准备包。

```bash
tekon delivery prepare
```

结果：

- `.tekon/runs/<runId>/delivery/pr-package.md`
- `.tekon/runs/<runId>/delivery/pr-body.md`
- `delivery-package` artifact。
- `delivery.pr-prepared` 审计事件。

> ⚠️ **当前边界（审批记录未绑定内容指纹）**：`create-pr` 本身**每次都要求当次 `--approve-human` 人工批准**（安全边界不变）。但当一次交付失败后自动/手动重新准备时，会**保留上一次的 `approvedBy/approvedAt` 记录**；若此时分支 HEAD、PR body 或证据包已变化，审批记录可能与当前内容不再一致（审计可信度问题，非绕过人工批准）。绑定内容哈希使旧审批自动失效的能力留待交付治理里程碑。

### 6.15 `delivery create-pr`

用途：人工批准后创建远端 PR。

```bash
tekon delivery create-pr --approve-human
```

必要条件：

- 已安装并认证 `gh`。
- 目标远端有创建 PR 权限。
- 主工作区除 `.tekon` 外没有未提交改动。
- 用户明确传入 `--approve-human`。
- workflow 已 passed，AC evidence、安全扫描和 QA release signoff 已满足，且 QA signoff 绑定 QA validation tested ref。
- 长程 push、`gh pr create` 或 create-pr 前置只读 probe 会写入 command progress JSON；默认 1 小时总超时、15 分钟无 stdout/stderr 或受控输出目录文件进展超时。

常见失败：

- `gh auth status` 不通过。
- 工作区 dirty。
- pre-PR readiness 不满足，例如缺 QA signoff、QA signoff 未绑定 tested ref、AC evidence 不完整或安全扫描失败。
- delivery 分支名或 base branch 不安全。
- 远端已有同分支 PR。
- 网络或 GitHub 权限失败。

处理方式：

- 先修认证和 dirty worktree。
- 如果 PR 已存在，天工会尝试恢复 PR URL。
- 失败后看 `review` 和 delivery log，不要直接重跑高风险命令。

### 6.16 `delivery ci-status`

用途：只读查询 PR checks 并写回证据。

```bash
tekon delivery ci-status
```

可选：

```bash
tekon delivery ci-status --selector <prUrl|branch>
```

结果：

- 写入 `ci-status` artifact。
- 记录 `delivery.ci.checked` 审计事件。
- 后续 PR 包和 readiness 可看到远端 CI 证据。

### 6.17 `delivery ci-watch`

用途：轮询 PR checks，直到终态或达到次数上限。

```bash
tekon delivery ci-watch --max-attempts 20 --interval-ms 15000
```

常用参数：

- `--max-attempts <n>`：最大查询次数。
- `--interval-ms <ms>`：初始等待间隔。
- `--backoff <n>`：退避倍率。
- `--selector <prUrl|branch>`：指定查询对象。

注意：

- 不 rerun CI。
- 不 merge。
- 不上线。

### 6.18 `eval readiness`

用途：判断单次 run 的交付证据是否完整。

```bash
tekon eval readiness
```

常见失败项：

- workflow 未 passed。
- audit hash 无效。
- gate 失败。
- delivery package 缺失。
- pending human gate 未处理。
- 验收标准没有 evidence。
- security scan 失败。
- PR 准备包不存在。
- 真实 PR 未创建。
- 远端 CI 未通过或未写回。

说明：`pr-prepared`、`pr-created` 和 `remote-ci-passed` 是 required。PR 准备、真实 PR 创建或远端 CI 证据写回之前，`ready=false` 是预期状态；这不代表本地 workflow 或治理 gate 一定失败。

### 6.19 `eval work-usability`

用途：评估样本集是否达到真实试用门槛。

```bash
tekon eval work-usability --samples /path/to/work-usability-samples.yaml
```

记录样本：

```bash
tekon eval work-usability record --samples /path/to/work-usability-samples.yaml
```

生成报告：

```bash
tekon eval work-usability --samples /path/to/work-usability-samples.yaml --report-md docs/reviews/work-usability.md --report-html docs/reviews/work-usability.html
```

记录 Codex 自举样本时，应把 provider 和 PR 要求写入样本：

```bash
tekon eval work-usability record --id tekon-codex-self-bootstrap --expected-provider codex --require-real-provider --require-pr --samples docs/reviews/tekon-codex-samples.yaml
```

### 6.20 `ui`

用途：一键启动本地 Web Dashboard。

```bash
tekon ui
```

常用参数：

- `--repo <path>`：跨仓库或从其它目录启动时指定目标仓库。
- `--port <port>`：指定端口，默认 3000。

启动后终端输出形如 `http://127.0.0.1:3000/#token=<会话令牌>` 的完整 URL——令牌放在 URL 片段（`#` 之后），不会随请求发往服务端。在浏览器中打开该 URL 即可直接使用：前端会读取片段中的令牌、写入 sessionStorage（当前标签页刷新后仍保持登录）、并把令牌从地址栏清除。按 `Ctrl+C` 停止服务。

注意：

- 目标仓库必须先执行过 `tekon init`（需要 `.tekon/web-session.json`）。
- Web 是本地 dashboard，不是远程服务。
- Web Dashboard 的写操作和 CLI 一样遵循受控审批规则。

**Web 使用要点（v0.23.1）**：

- **连接状态**：顶栏分开显示凭据与 Provider；连接面板可重填、应用或断开会话令牌，Provider 可单独重试并查看检查时间。凭据校验不等待 Provider，通过 `#token=` URL 打开时自动校验。
- **执行计划预览**：默认入口和高级表单展示“检查配置与适用性”，可展开查看逐项来源和实际执行方式；刷新后核对差异，再显式提交。毫秒级超时、profile 等参数收在“高级”折叠区。详见 §7。
- **提交结果可找回**：两个发起入口共享待确认请求账本；网络错误后先查询原 Request ID，或保持原内容重试。目录未就绪时明确显示已受理、等待目录就绪或恢复。详见 §7。
- **联网不受限确认**：选择 `dsh-headless` 等会带来不受限网络出口的 agent 时，预览会显式告警并要求勾选“我已知悉本次运行联网不受限”；未勾选无法提交，确认会写入运行审计。
- **失败任务处理**：受控交付列表中失败的会话可点“确认/归档”，确认后下沉到历史区、不再占据待处理置顶位；未处理的失败仍会置顶提醒。
- **实时刷新与长会话**：Session 列表在事件流首次连接、重连及会话状态变化后读取最新状态（保留短轮询兜底）；其他入口的审批决定或新增审批会更新详情卡片。会话事件流默认只渲染最近若干条，更早内容点“加载更早历史”按需加载。
- **历史截断提示**：当网络恢复或客户端较慢导致在线回放的历史量超过预算时，会话顶部会出现一条非阻断提示，说明已切换到最近记录、完整历史仍可按页读取；该提示可手动关闭，不影响事件流继续上屏。

### 6.21 `update`

用途：更新 Tekon 到最新版本。

```bash
tekon update
```

拉取最新代码 → 安装依赖 → 重新构建。已是最新版本时直接退出。更新完成后输出旧版本 → 新版本。

### 6.22 `draft`

用途：创建和管理需求草案。

**交互式创建（推荐）**：

```bash
tekon draft new
```

`draft new` 会启动交互式需求澄清流程：

1. 输入需求描述后，如果本机已安装 Claude Code，天工会调用 Agent 根据需求内容生成 3-5 个针对性澄清问题。
2. 用户在终端中逐一回答这些问题。
3. Agent 根据回答精炼需求草案，补充验收标准、风险标签和边界条件。
4. 如果 Agent 不可用（未安装 Claude Code 或调用失败），自动回退到静态问题生成和本地更新。

**快速塑形**：

```bash
tekon draft shape "需求文本"
```

等同于 `draft shape`，直接将需求文本转为需求卡。

**批准草案**：

```bash
tekon draft approve
```

等同于 `draft approve`，批准最近的需求草案。

**查看草案**：

```bash
tekon draft show
```

显示最近需求草案的详细信息。

常用参数：

- `--repo <path>`：跨仓库操作时指定目标仓库。
- `--agent claude-code`：显式指定 Agent（`draft new` 默认使用配置中的默认 Agent）。
- `--no-write`（`draft shape`）：只预览，不写入文件。

### 6.23 `clean`（当前暂停）

用途：历史版本中用于递归清理 worktree；当前在生命周期安全清理完成前 fail-closed。

```bash
tekon clean
```

命令固定以 exit code 1 退出，并在 stderr 输出 `CLEAN_SUSPENDED`；不会扫描、删除或重建 `.tekon/worktrees/`。Web 的 `project.clean` 同样不会删除 `.tekon/runs/<runId>`。这是数据保护措施，不表示已经完成导出、retention 或可审计 purge。

### 6.24 `help`

用途：查看命令帮助。

```bash
tekon help
```

输出所有命令的分组概览，包含 6 个分组：项目管理、运行控制、工作流与角色、交付、审阅与评估、工具。

**查看子命令**：

```bash
tekon help draft
tekon help workflow
```

显示指定命令的子命令列表和描述。

**等效写法**：

```bash
tekon --help        # 等同于 tekon help
tekon -h            # 等同于 tekon help
```

**查看版本**：

```bash
tekon --version     # 输出 v0.23.1
tekon -v            # 同上
```

## 7. Web Dashboard

启动：

```bash
tekon ui
```

可指定端口：

```bash
tekon ui --port 3001
```

跨仓库使用时显式传目标仓库：

```bash
tekon ui --repo /path/to/project
```

启动后终端会输出形如 `http://127.0.0.1:3000/#token=<会话令牌>` 的完整 URL（令牌在 URL 片段中，不发往服务端），在浏览器中打开即可直接使用——前端自动读取令牌、写入 sessionStorage（刷新保持）并从地址栏清除。按 `Ctrl+C` 停止。

打开后默认进入 **Session UI（会话视图）**：以"会话"为主轴，把一次运行的用户消息、Agent 步骤、工具调用、产物、门禁和审批组织成一条**连续、可实时刷新的叙事**。旧的 run-centric Dashboard（overview / run 列表 / run 详情各页签）完整保留在侧栏"高级 Advanced"入口下（`/advanced`），功能不变。

> ⚠️ **当前边界**：从会话输入框「启动受控交付」发起的运行，默认走 `standard-delivery` **受控交付全链路**（PM/RD/QA/Reviewer + 门禁 + 审批），而不是轻量对话。发起后不能在会话内继续追问或中途转向（follow-up/steer 未开放），Composer 仅用于发起新运行；轻量协作会话为后续方向。

Session UI 适合：

- 在左侧会话列表选择或用输入框发起一个新会话（运行）。
- 在会话详情中间栏**实时**查看事件流：用户消息、步骤开始/结束、工具调用与结果、Agent 消息（当前为产物元数据合成的**摘要**，非模型原文）、错误。断线会自动重连并续播已持久化的事件，仍受下方事件日志边界约束。
- 在右侧就地处理 human approval（inline 审批卡片，展示风险、命令、就绪度与证据），并暂停/取消/恢复运行。

旧 Dashboard（`/advanced`）适合：

- 查看项目 overview。
- 查看 run 列表。
- 选择历史 run。
- 查看 readiness、evidence、diff、artifact、gate log、PR 包。
- 处理 human approval。
- 发起受控模板 run。
- 选择 `mock`、`claude-code` 或 `codex` provider 发起 run。
- 触发 `delivery prepare`。
- 在人工批准下触发 `delivery create-pr`。

写操作需要 session token。用 `tekon ui` 输出的完整 URL（含 `#token=`）打开时，令牌已自动载入，可直接发起运行、批准/拒绝审批。若你手动访问了不带片段的地址（令牌丢失），token 保存在：

```text
/path/to/project/.tekon/web-session.json
```

可在页面顶栏的连接管理面板粘贴该 token 作为兜底；会话列表和事件流在配置令牌后加载。面板将凭据与 Provider 状态分列，显示检查时间并提供 Provider 重试；“凭据有效”不代表 Provider 可用。

**发起前核对检查**：默认输入框和高级表单都提供“检查配置与适用性”。先看汇总，再展开“查看逐项检查配置”，确认来源是模板定义、仓库检查配置还是项目脚本自动识别，并按实际方式判断结果：“将执行已绑定命令”“将跳过此检查”“缺少命令，检查将失败”等。配置标记不适用不一定会跳过安全检查；`security-scan` 没有外部命令时仍执行内置安全扫描，以逐项说明为准。预览不显示原始工具、参数、环境变量或不适用理由；需要核对命令正文时，在本地检查模板、`.tekon/repo-profile.yaml` 或 `package.json`。

点击“刷新检查配置”后，页面会标明相较上一份预览新增、移除或变化的检查；若只见“模板或运行设置已变化”，也需重新审阅。确认后再次点击提交，刷新本身不会受理新计划。出现 `PLAN_DIGEST_MISMATCH` 时按“刷新执行计划”重新确认；出现 `PLAN_CONFIG_INVALID` 时先修正提示中的配置文件或读取权限，再刷新，不要仅反复提交。

逐项比较只适用于同一服务实例和发起上下文。服务重启会使比较范围失效；切换凭据、仓库、模板等上下文会清除旧基线。看到“暂无逐项变化信息”只表示无法比较，不能解读成检查未变化；没有旧预览时也不会推断差异。已受理运行保留原绑定，`status` 和详情提示的历史与完整性边界见 §6.7。

**提交后没有确定结果时**：默认输入框和高级表单都会保留 Request ID。“受理状态待确认”时点“查询受理结果”，或保持原内容重新提交；“尚未查到”只表示查询时还没有记录，原请求仍可能在处理中，必须保留原身份。查到已受理后进入原 Session 观察；“已受理，等待目录恢复”时先修复目录，再用原内容重试或重启 UI 服务，查询本身不负责恢复。“已受理，等待目录就绪”表示目录还在准备，任务尚未执行。已经确认受理后，即使后续查询失败，原身份和已受理事实仍保留；另行提示当前状态不可用。明确选择“明确新建另一个任务”才使用新身份，旧待确认请求仍可查询。

账本按物理仓库及凭据作用域隔离，保存在当前标签页的 sessionStorage 中；同仓库、同凭据刷新后仍能找回待确认请求。账本只存作用域指纹、意图指纹、requestId 和受理状态，不存需求正文或 token；登录令牌另由认证功能保存到 sessionStorage。刷新后可以直接查旧请求，但若要重新提交内容，需要自己恢复原输入。会话存储不可用或账本损坏时，会在发出 Run 请求前阻止提交；不要清除尚待确认的记录来绕过提示。

**已受理但浏览器后续操作失败时**：若提示“浏览器请求记录更新或页面跳转未完成”，服务端已经确认原请求，请点“观察原会话”或“观察原运行”，不要重复新建。当前页面会保留该身份，等待目录恢复的请求仍可用原内容重试；重读账本、查询暂未找到或重试断网不会推翻已经收到的确认。默认入口跳转失败时保留输入；跳转等待期间后来编辑的内容也不会被旧回调清空。这里不保证修复损坏的存储或把全部内存提示保存到刷新后的页面。刷新后，若原请求仍在待确认列表，点“查询受理结果”；若记录已移除，到受控交付列表打开已有会话。重新提交前需自行恢复原输入，不要为找回会话另建任务。

使用 symlink 路径启动同一个物理仓库时，新旧 Run/Session 仍可查看；历史 alias Workspace 的列表和事件订阅也保持可见，原 ID 不变。它不提供跨仓库 Workspace 切换；指向其他物理仓库的记录不在当前访问范围。

注意：

- Web 是本地 dashboard，不是远程服务。
- token 不应提交。
- Web create-pr 和 CLI 一样，未批准时只落库等待审批，批准后才 push 和创建 PR。
- **发起运行时可选 Profile**：新建运行表单的 `Profile` 下拉默认 `human-web`（人工驱动，不自动推进人工点）。选 `autonomous-delivery` 后，运行**通过（passed）时会自动准备交付**（打包证据、生成 PR 准备包、进入待审批状态）；**但绝不自动创建 PR**——创建远端 PR 始终需要人工在交付面板显式批准。此边界是硬约束，不因 Profile 放宽。自动准备只在长驻的 Web/服务模式下触发；CLI `tekon run` 跑完即退出，交付仍走显式 `tekon delivery prepare`。
- **发起运行、批准 human gate、恢复运行采用“返回结果、后台推进”**：发起运行先完成校验和受理；只有目录 ready 的 Job 才能在后台执行，已受理不等于已经开始执行。
  - **Session UI（默认）会通过事件流实时反映进展**：列表在首次连接或断线重连后自动读取最新状态，无需等下一次变更；中间栏追加已持久化事件，右侧审批卡片随新增审批或其他入口的决定更新。读取期间收到新变化时，会重新读取，旧成功响应或错误不会覆盖新状态。审批通过后运行继续按 gate 规则推进。
  - 旧 Dashboard（`/advanced`）页面**不会自动刷新状态**，需刷新页面或重新进入 run 列表/详情查看最新进展（run 状态会从 `running` 走向 `passed`/`blocked`/`failed`）。
  - 需要中止时点“取消”，然后确认运行状态是否已变为 `cancelled`。
  - 同一个运行同一时刻只允许一个后台任务：若已有任务在跑，重复的恢复/批准会被拒绝（提示"已有活跃任务"），等它结束或先取消即可。

> 事件流：Web 暴露 `GET /api/sessions/:sessionId/events`(Server-Sent Events)，用 `x-session-token` 头鉴权，可按 `sinceSeq`/`Last-Event-ID` 回放历史事件并接收实时事件。事件流包含每个执行步骤的 agent 事件（`step/start`、`tool/call`、`tool/result`、`assistant/message`、`step/end`）与治理事件（门禁、产物、审批）。**Session UI 客户端已消费该事件流实现页面内实时刷新**；该端点同时可供外部集成使用。真正的逐块流式（`assistant/chunk` 模型原文增量）为后续阶段规划。
>
> **事件日志定位（迁移期）**：新 Session 的 `session/created`、`workflow/started`、`user/message` 三个开场事件，与 Run、必需治理 Audit 和初始 Job 一起原子受理；重试不会重复这三个事件。后续 `session_events` 仍可能因 best-effort 投影缺失，运行状态仍需结合 `workflow_instances` / `jobs` 等持久记录判断。它不是可完整重建所有运行的权威事件日志，全域事务化 outbox 仍为后续范围。

## 8. 如何判断结果是否可信

不要只看“命令退出 0”。建议按顺序看：

1. `status`：workflow 是否 passed。
2. `review`：失败项和证据是否能解释。
3. Changed Files：影响文件是否符合预期。
4. Artifacts：需求、变更、测试、审阅证据是否完整。
5. Gate Logs：build/lint/test/security 是否真的跑过。
6. PR Package：PR body 是否能让 reviewer 看懂。
7. CI Status：远端 checks 是否已记录。
8. `eval readiness`：PR/CI 证据是否完整。

如果其中任何一步说不清楚，不要继续创建 PR 或批准高风险动作。

## 9. 常见问题处理

### 9.1 `workflow preflight` 显示 missing command

原因：目标仓库没有配置对应命令。

处理：

1. 看 `suggestedCommand` 是否合理。
2. 把确认后的命令写入 `.tekon/repo-profile.yaml`。
3. 再跑 `workflow preflight`。

不要直接跳过 gate，除非该命令确实不适用且你能写出原因。

### 9.2 run 拒绝 dirty base

原因：目标仓库有未提交业务改动。

处理：

- 先提交、stash 或清理无关改动。
- 如果你明确要基于当前改动运行，追加 `--allow-dirty-base`。

注意：`--allow-dirty-base` 是人工确认，不是安全证明。

### 9.3 pending human gate

处理：

1. 执行 `approval summary`。
2. 执行 `eval approval-summary`。
3. 如果摘要不完整，先看 `review` 补证据。
4. 如果批准，执行 `resume --approve-human`。
5. 如果拒绝，执行 `approval reject`。

### 9.4 readiness 不通过

常见原因：

- workflow 还没 passed。
- 还有 pending human gate。
- 验证 gate 失败。
- PR 准备包不存在。
- security scan 失败。
- artifact 缺验收标准 evidence。

处理：

- 先看 `review` 的 failed checks。
- 看 Evidence Navigation 指向哪里。
- 按 Gate Failure Triage 的建议处理。

### 9.5 `delivery create-pr` 失败

常见原因：

- 没有 `gh`。
- `gh auth status` 失败。
- 目标远端没有权限。
- 主工作区 dirty。
- PR 已存在。

处理：

- 先修认证和工作区状态。
- 若 PR 已存在，看命令是否恢复了 PR URL。
- 不要直接重复执行高风险命令，先看 `.tekon/runs/<runId>/delivery/` 和 `review`。

### 9.6 `ci-status` 查询失败

常见原因：

- run 没有 PR URL。
- selector 不对。
- `gh pr checks` 不支持目标。
- 远端无 checks。
- 权限不足。

处理：

- 用 `--selector <prUrl|branch>` 明确指定。
- 先手动确认 `gh pr checks` 是否可用。
- 对非 GitHub host，当前需要后续 adapter 支持。

### 9.7 Artifact 被拒绝入库

原因：产物命中了明显密钥或 token 模式。

处理：

- 删除密钥内容。
- 使用安全摘要或脱敏示例。
- 重新运行相关节点或 provider。

注意：这只是基础扫描，不等于完整 DLP。

### 9.8 Web 写操作被拒绝

常见原因：

- session token 错误。
- `.tekon/web-session.json` 不存在。
- 当前项目 root 不在允许范围。

处理：

- 重新执行 `init` 生成 token。
- 确认 Web 启动时的 `TEKON_PROJECT_ROOT` 正确。
- 不要提交 token。

### 9.9 Codex provider 运行失败

常见原因：

- 本机未安装 `codex`，或 `codex` 不在 `PATH` 中。
- 本机 Codex CLI 未完成认证。
- provider 没有按 Tekon artifact manifest 协议写入必需 artifact。
- 用户传入的 Codex args 试图覆盖 profile、sandbox、approval、文件系统、配置或危险 bypass 参数。
- Codex 在当前仓库需要人工批准，但 Tekon 节点执行没有拿到可恢复的 artifact 证据。

处理：

- 先执行 `codex --version` 和一个最小 `codex --profile internal --sandbox workspace-write --ask-for-approval on-request exec --help` smoke，确认本机 CLI 与 internal profile 可用。
- 该 `exec --help` smoke 只验证 CLI 与 internal profile；真实 Tekon run 会在 `exec` 前受控追加 `--add-dir <TEKON_OUTPUT_DIR>`，只开放本节点 artifact 输出目录。
- 查看 `.tekon/runs/<runId>/<nodeId>/` 下 stdout/stderr、`artifact-manifest.json`、字面 `TEKON_ARTIFACT_MANIFEST` 和 artifact 内容。
- 确认 artifact JSON/YAML/Markdown 满足 Tekon schema；结构化 JSON 必须有非空 `title` 和 `body`。
- 不要把失败降级成 mock 通过；真实 provider 的失败应写入审阅报告或样本评估。
- 参考 `docs/manual/codex-provider-smoke.md` 的自举 smoke 流程。

## 10. 参数速查

### 全局常见参数

| 参数                  | 用途                                                                        |
| --------------------- | --------------------------------------------------------------------------- |
| `--help`, `-h`        | 查看命令帮助；`tekon --help` 显示命令概览，`tekon help <cmd>` 查看子命令。  |
| `--version`, `-v`     | 输出版本号。                                                                |
| `--repo <path>`       | 跨仓库或从其它目录操作时指定目标仓库；常规用法自动发现。                    |
| `--run-id <runId>`    | 指定历史或非最近 workflow run；常规审阅默认使用最近 run。                   |
| `--agent mock`        | 使用 mock provider，适合本地验收和 fixture。                                |
| `--agent claude-code` | 使用 Claude Code adapter，需本机认证和额外真实 smoke 证据。                 |
| `--agent codex`       | 使用本机 Codex CLI adapter，需本机安装、认证和真实 smoke 证据。             |
| `--approve-human`     | 明确批准人工 gate 或远端副作用。                                            |
| `--allow-dirty-base`  | 允许基于当前未提交业务改动运行。                                            |
| `--shape <path>`      | 指定需求卡；常规批准/查看默认使用最近需求卡。                               |
| `--decision-id <id>`  | 指定人工决策；同一 run 有多个 pending decision 或处理历史 decision 时使用。 |

### `run` 参数

| 参数                            | 用途                                                                    |
| ------------------------------- | ----------------------------------------------------------------------- |
| `--template <name>`             | 使用内置模板。                                                          |
| `--demand-file <path>`          | 指定历史或非最近需求卡；常规运行默认读取最近需求卡且要求它已批准。      |
| `--dynamic`                     | 动态 workflow 预览，必须搭配 `--dry-run`，不开放实际执行。                |
| `--dry-run`                     | 仅支持 `--dynamic`；普通 workflow/Goal 会在初始化前拒绝。                 |
| `--request-id <id>`             | 普通 workflow/Goal 的原意图重试标识；8–128 个字母、数字、下划线或连字符。 |
| `--save-as <name>`              | 保存动态 workflow 预览。                                                |
| `--timeout-ms <ms>`             | 覆盖真实 provider 外层总超时，明确长程任务可配置为 2 小时以上。         |
| `--no-progress-timeout-ms <ms>` | 覆盖无 stdout/stderr 或受控输出目录文件进展超时，用来判断任务是否卡死。 |
| `--progress-heartbeat-ms <ms>`  | 覆盖 progress JSON heartbeat 间隔。                                     |

### `draft shape` 参数

| 参数            | 用途                                           |
| --------------- | ---------------------------------------------- |
| `--no-write`    | 只预览需求塑形结果，不写入 `.tekon/demands/`。 |
| `--format json` | 输出 JSON，便于其它工具消费。                  |

### `delivery ci-watch` 参数

| 参数                         | 用途             |
| ---------------------------- | ---------------- |
| `--selector <prUrl或branch>` | 指定 PR 或分支。 |
| `--max-attempts <n>`         | 最大轮询次数。   |
| `--interval-ms <ms>`         | 每次轮询间隔。   |
| `--backoff <n>`              | 轮询退避倍率。   |

## 11. 使用说明

天工的核心设计理念是增强人类交付，合入、上线、权限扩大等关键决策始终由人控制。

适用场景：

- 内部工具和研发效能工具。
- 测试补齐和文档补齐。
- 低风险 bugfix。
- 可回滚、可人工审阅的中小需求。

## 12. 每次迭代后的手册更新规则

后续每次功能、行为、CLI/Web 入口、参数、错误处理、边界或用户流程发生变化后，都必须评估是否需要更新本手册。

需要更新本手册的典型情况：

- 新增或删除 CLI 命令。
- 参数语义变化。
- Web dashboard 新增写操作。
- Gate、readiness、work-usability 规则变化。
- 运行目录、artifact、PR 包或审计结构变化。
- 新增真实 provider 支持。
- 安全边界、人工审批边界或远端副作用规则变化。
- 用户常见故障处理方式变化。

如果一次迭代判断不需要更新本手册，应在最终回复或提交说明中说明理由。

当前主手册路径：

```text
docs/manual/tekon-user-manual.md
```
