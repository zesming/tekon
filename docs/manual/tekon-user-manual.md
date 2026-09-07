# 天工（Tekon）用户使用手册

适用版本：**v0.25.1**。在目标项目根目录执行示例命令；跨仓库操作时追加 `--repo /path/to/project`。HTML 人审版支持章节目录与连续阅读，仅 §7.1 提供 English 对照。

## 1. 天工是什么

天工（Tekon）是本地 Agent workflow 框架。它把研发需求拆成角色任务，在隔离 worktree 中执行，运行验证关卡（Gate），并集中保存产物、日志、审批和交付证据。

你可以通过 CLI 或 Web 发起任务、查看进展、处理审批，最后准备可人工审阅的 PR 材料。push 和创建 PR 需要当次人工批准；合入、上线、权限扩大及生产变更仍由人控制。

当前支持 `codex`、`claude-code`、`mock`，以及 experimental 的 `dsh-headless`。DSH 必须显式选用，仅支持 Goal，联网不受限；使用前见 §5.7。

## 2. 天工解决什么问题

### 2.1 需求进入研发前不清楚

`draft shape` 把一句需求整理成需求卡：标题、正文、推荐模板、风险、非目标、开放问题和验收标准。先审阅并批准需求卡，再执行；需要终端交互澄清时使用 `draft new "需求文本"`。

### 2.2 不知道该选什么 workflow

`workflow select` 推荐模板并给出理由，`eval workflow-selection` 评估选择是否合适。

| 模板 | 用途 |
| --- | --- |
| `standard-feature` | 标准功能 |
| `bugfix` | 缺陷修复 |
| `test-improvement` | 补充测试 |
| `docs-update` | 更新文档 |
| `plan-only` | 只做方案 |
| `standard-delivery` | 完整交付治理：PM、RD、QA、Reviewer、PMO，含独立评审、验收证据和 QA 签署 |

不传 `--template` 时，`run` 使用 `standard-delivery`；不会自动采用需求卡的推荐模板。

### 2.3 Agent 输出不可审阅

`review` 和 Web 把失败检查、影响文件、diff、产物正文、Gate 日志、审批及 PR 包集中展示。先看失败原因，再沿证据入口核对实际结果。

### 2.4 远端副作用需要人控制

| 命令 | 实际作用 |
| --- | --- |
| `delivery dry-run` | 查看交付计划 |
| `delivery prepare` | 生成本地 PR 包 |
| `delivery create-pr --approve-human` | 人工批准后 push 分支并创建 PR |
| `delivery ci-status` / `ci-watch` | 只读查询远端 checks，写回本地证据 |

查询 CI 不会重跑 CI、合入或上线。

### 2.5 需要判断一次 run 是否真的可交付

`eval readiness` 检查单次运行的交付证据；`eval work-usability` 检查真实工作样本集。

完整 readiness 要求本地 PR 包、真实 PR 和远端 CI 均有证据。因此，本地 workflow 通过后仍可能 `ready=false`。mock 通过也不能证明真实 Provider 可用。

## 3. 核心用户场景

以下是推荐路径。查看状态和证据不会推进远端交付；审批前应先完成审阅。

### 场景 A：我有一个小功能，希望推进到可审 PR

适合可回滚、影响范围明确的小功能。

1. `tekon init`，然后运行 `tekon workflow preflight`。
2. `tekon draft shape "需求文本"`，人工核对需求卡。
3. `tekon draft approve`，再 `tekon run`。
4. `tekon status`、`tekon review`，处理失败和待审批项。
5. `tekon delivery prepare`，人工审阅 PR 包与 diff。
6. 明确批准后执行 `tekon delivery create-pr --approve-human`。
7. `tekon delivery ci-status`，再用 `tekon eval readiness` 检查交付证据。

### 场景 B：我只想修一个 bug，但需要人工确认风险

使用 `tekon run "缺陷与复现步骤" --template bugfix`。遇到 human gate：

1. `tekon approval summary` 查看风险、命令和证据。
2. `tekon eval approval-summary` 检查摘要完整性。
3. 人工决定后执行 `tekon resume --approve-human` 或 `tekon approval reject`。

`bugfix` 不等于完整交付治理；当前 `delivery prepare` 只支持 `standard-delivery`。

### 场景 C：我只想补测试

```bash
tekon workflow select "补齐 CLI 失败路径的测试"
tekon run "补齐 CLI 失败路径的测试" --template test-improvement
tekon review
```

核对新增断言、实际测试日志和覆盖缺口，不只看测试数量。

### 场景 D：我只想写文档或方案

选择 `docs-update` 更新文档，或 `plan-only` 生成方案。需要完整角色链路及交付证据时才选 `standard-delivery`。

当前完整治理适合 Tekon 自身 dogfooding 和低风险种子任务，不能据此承诺生产级治理。

### 场景 E：我要判断天工是否已经能用于真实工作

选择 2–3 个低风险真实仓库，准备约 10 个真实或历史需求。每次运行后用 `eval work-usability record` 记录样本，再用 `eval work-usability --samples` 汇总评估。

正式验收时，把 Markdown/HTML 报告保存到 `docs/reviews/`，注明真实 Provider、失败与恢复、人工介入和未覆盖范围。

## 4. Quick Start

先安装，再进入目标 Git 仓库。首次试用建议选范围明确、可回滚的任务。

### 4.1 安装

前置依赖：`git`、`npm`，以及 Node `^20.19.0 || >=22.12.0`。

```bash
curl -fsSL https://raw.githubusercontent.com/zesming/tekon/main/scripts/install.sh | bash
```

脚本会克隆仓库、安装依赖并构建。按完成提示设置 PATH，再重新加载对应 shell 配置。

自定义安装目录或分支时，环境变量应传给执行脚本的 `bash`：

```bash
curl -fsSL https://raw.githubusercontent.com/zesming/tekon/main/scripts/install.sh | TEKON_HOME=/opt/tekon TEKON_VERSION=main bash
```

CI 验证 Node `20.19.0`、`22.12.0`、`22.19.0`，并跟踪 `24.x`；此验证范围不代表其他或未来 major 已获生产验证。DSH 另有更高 Node 要求，见 §5.7。

### 4.1.1 更新

```bash
tekon update
```

拉取代码、安装依赖并重新构建；完成后显示版本结果。

### 4.2 初始化目标仓库

```bash
tekon init
```

生成 `.tekon/` 配置、仓库检查配置、运行目录和 Web 会话令牌。该目录通常不提交。

### 4.3 检查目标仓库命令画像

```bash
tekon workflow preflight
```

| 状态 | 含义 |
| --- | --- |
| `resolved` | 已解析检查命令，尚不代表命令执行成功 |
| `missing` | 缺少命令，需补充仓库配置 |
| `not-applicable` | 已显式声明不适用 |
| `not-command-gate` | 语义 Gate，不需要外部命令 |

检查 `suggestedCommand`，确认后写入 `.tekon/repo-profile.yaml`，再运行预检。

### 4.4 塑形需求

```bash
tekon draft shape "给 Web dashboard 增加审批摘要展示，要求 e2e 通过"
```

读取输出的 `reviewPath` 审阅稿，核对范围和验收标准后批准：

```bash
tekon draft approve
tekon eval demand-shape
```

评估可以辅助审阅，但不会代替人工批准。

### 4.5 发起运行

```bash
tekon run
```

没有需求文本时读取最近一张需求卡；该卡未批准会报错，不会自动改用更早的卡片。默认模板为 `standard-delivery`；Provider 优先取 `--agent`，其次是项目 `defaultAgent`，未配置时为 `codex`。

真实 Codex 运行需要本机 CLI 和可用的 `internal` profile。只检查流程时可显式使用 mock：

```bash
tekon run --template standard-delivery --agent mock
```

保存启动时 stderr 打印的 `Request ID` 和受理后返回的 `runId`。超时或结果丢失时，保持原需求与参数，追加原 `--request-id` 重试，避免重复任务。受理与目录未就绪的处理见 §6.6。

真实 Provider 默认总超时 1 小时、无输出或产物进展超时 15 分钟。长任务可调整：

```bash
tekon run --timeout-ms 7200000 --no-progress-timeout-ms 1200000 --progress-heartbeat-ms 30000
```

### 4.6 查看结果

```bash
tekon status
tekon review
```

核对 Gate、产物、diff 和待审批项。完整 PR/CI 证据写回前，readiness 保持 `ready=false` 可能是预期结果。

### 4.7 准备 PR 材料

```bash
tekon delivery prepare
```

仅支持 `standard-delivery`，生成本地 PR 包。要求 workflow 通过、无待审批 Gate、验证与安全扫描满足、验收证据完整，且 QA release signoff 通过并绑定 QA validation 的 tested ref。

不满足前置检查时不会生成 PR 包。

### 4.8 创建远端 PR

审阅 PR 包、diff 和验证证据后，由人明确批准：

```bash
tekon delivery create-pr --approve-human
```

命令重新生成并校验 PR 包，然后 push 分支并调用 GitHub CLI 创建 PR。需要 `gh` 已认证、远端权限有效、主工作区除 `.tekon` 外无未提交改动。

### 4.9 查询远端 CI

```bash
tekon delivery ci-status
```

需要等待 checks 结束时：

```bash
tekon delivery ci-watch --max-attempts 20 --interval-ms 15000
tekon eval readiness
```

### 4.10 默认上下文规则

| 对象 | 省略参数时的选择 |
| --- | --- |
| Repo | 从当前目录向上找 `.tekon/config.yaml`，否则取当前 Git 根目录；`--repo` 优先 |
| 需求卡 | `draft shape` 写入 `.tekon/demands/`；批准、查看与评估默认取最近卡片 |
| Run | `run` 无文本和文件时要求最近卡片已批准；普通查看与交付命令默认取最近 Run |
| 人工决策 | 审批相关命令定位待审批项；同一 Run 有多个 pending decision 时必须传 `--decision-id` |

最近需求卡已批准时，`draft approve` 不会自动找更早的未批准卡片；请用 `--shape` 指定。

跨仓库或历史对象使用 `--repo`、`--run-id`、`--shape`、`--demand-file`、`--decision-id`。显式定位时，`review` 和 `approval summary` 会提供带身份的后续命令，复制前仍应核对目标。

## 5. 核心概念

### 5.1 Repo

希望 Tekon 处理的目标仓库。它可以是 Tekon 自身，也可以是其他项目。

### 5.2 `.tekon/`

目标仓库的运行态目录，保存配置、SQLite 数据库、worktree、需求卡、产物、日志和 Web 令牌。

通常不提交。正式验收或发布依据应另存到可提交文档中，并排除凭证。

### 5.3 Run

一次 workflow 或 Goal 执行，以唯一 `runId` 标识。查看、审批、恢复和交付均围绕原 Run 进行。

### 5.4 Workflow

有顺序和依赖关系的角色节点集合。常用模板见 §2.2；`tekon workflow list` 查看目录，`tekon workflow show <name>` 查看模板。

### 5.5 Role

节点承担的角色，如 PM、RD、QA、Reviewer、PMO。角色规定任务提示、知识和工具策略。

### 5.6 Gate

验证关卡，包括 build、lint、test、schema、security-scan、human，以及独立评审、角色范围、验收证据、QA 签署和流程完整性检查。

Gate 通过说明该项检查满足规则；是否可交付还需结合其他证据。human gate 必须由人处理。

### 5.7 Provider

| Provider | 适用范围与前提 |
| --- | --- |
| `codex` | 默认后端；本机安装 Codex CLI，配置并认证 `internal` profile |
| `claude-code` | 本机 Claude Code adapter；需安装、认证和当前环境的真实验证 |
| `mock` | 确定性流程演示与回归；不能证明真实 Agent 能力 |
| `dsh-headless` | experimental；显式选用，仅支持 Goal，网络出口不受限 |

真实 workflow 节点通过 artifact manifest 交回声明的产物。Run 保存 Provider 配置快照，恢复沿用原快照，避免意外切换后端。

**DSH 使用条件**：自行安装 `@deepseek-ai/dsh` 并配置 `DEEPSEEK_API_KEY`；当前 tested pin 为 `0.1.2-alpha.3`，宿主 Node 要求 `^22.19.0 || >=24.0.0`。先运行：

```bash
tekon provider preflight dsh-headless
```

预检检查 Node、版本、headless help 和默认插件配置，返回结果及兼容安装命令。CLI/Web 新运行会在创建运行记录前预检，执行时也会校验能力。

确认联网边界后，才能发起：

```bash
tekon run "梳理当前项目结构，不修改文件" --goal --agent dsh-headless --acknowledge-unrestricted-network
```

使用前理解以下限制：

- **仅支持 Goal**：CLI/Web 会在受理前拒绝 DSH workflow，包括无 outputs 的自定义 workflow。DSH 只有单一可写工作区，无法写入 worktree 外的交付产物目录。
- **Goal 默认不接受源码改动**：内置 Goal 不声明 `code-changes`；节点完成时若发现仓库文件或 HEAD 改变，会拒绝提升结果。它不等于操作系统只读沙箱，不适合交付代码修改。
- **网络出口不受限**：DSH 文件沙箱无法关闭联网；确认参数只记录知情，不会提供网络隔离。需要禁网时由 OS、容器或网络策略实现。
- **一次性执行**：当前 adapter 收集日志，不向 Session UI 投影执行期流，也不支持后续追问；取消依靠受管理子进程终止。
- **预检隔离有限**：metadata probe 使用临时工作区、隔离 DSH home 和最小环境，并关闭内置 session telemetry；这不是 OS 沙箱，不能阻止同 UID 恶意二进制主动读取宿主文件。正式 Run 的 worktree `.env`、代理及凭据回退仍需自行核查。

版本或宿主 Node 不兼容时，优先按预检提示安装/升级。`TEKON_DSH_ALLOW_VERSION=<实际版本>` 和 `TEKON_DSH_ALLOW_HOST_NODE=<当前版本>` 是精确匹配的人工旁路，会给出警告，不代表该组合已验证。

外部依据：[DSH alpha.3 CLI Reference](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.2-alpha.3/apps/cli/reference/README.md) 描述 headless 参数、输出和遥测合同；[rc.1 发布页](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.2-rc.1) 对应后续版本。Tekon 对 rc.1 的无凭据 metadata 检查不能替代真实模型调用，tested pin 仍为 alpha.3。

### 5.8 Artifact

可存储、审阅和评估的结构化产物，如需求卡、变更说明、测试报告、审阅报告、PR 包及 CI 状态。产物存在不等于内容正确，应核对正文与日志。

### 5.9 Review Surface

聚合审阅面，供 CLI `review` 与 Web 共用，集中显示检查结果、证据和后续操作。

### 5.10 Readiness

单次运行的交付证据完整性评估，覆盖 workflow、Gate、产物、本地 PR 包、真实 PR 与远端 CI。

### 5.11 Work Usability

样本集评估，用真实任务、Provider 和交付结果判断是否达到受控试用门槛。

## 6. 命令详解

### 6.1 `init`

```bash
tekon init
tekon init --repo /path/to/project
```

创建 `.tekon/config.yaml`、`repo-profile.yaml`、`web-session.json` 和运行目录。目标应为 Git 仓库，否则 worktree、diff 或交付功能可能失败。

Web 令牌文件丢失时可重新初始化；不要将令牌提交到仓库。

### 6.2 `workflow preflight`

```bash
tekon workflow preflight
tekon workflow preflight bugfix
```

模板名是位置参数，默认 `standard-delivery`。输出状态含义见 §4.3。`resolved` 仅说明命令已解析，仍需实际运行验证。

缺命令时确认候选并更新 `.tekon/repo-profile.yaml`。`notApplicable` 必须有实际理由；不能用它绕过 `security-scan`，无外部安全命令时仍可能执行内置扫描。

### 6.3 `workflow select`

```bash
tekon workflow select "补齐 CLI 单元测试"
```

返回推荐、候选和理由。可用 `--shape <path>` 指定需求卡、`--template <name>` 评估人工选择、`--json` 输出结构化结果。

推荐不会保存 workflow，也不会改变 `run` 的默认模板。

### 6.4 `draft shape`

```bash
tekon draft shape "需求文本"
```

生成需求卡 JSON 和 Markdown 审阅稿。`--no-write` 仅预览，`--format json` 输出 JSON。

先补齐 `openQuestions`，再确认非目标、风险和验收标准；需要交互澄清时使用 §6.22 的 `draft new`。

### 6.5 `draft approve`

```bash
tekon draft approve
tekon draft approve --shape /path/to/demand.json --actor your-name
```

批准指定或最近需求卡，记录操作者和时间。路径也可作为位置参数。

需求批准不等于计划批准、Gate 批准或 PR 创建批准。

### 6.5.1 `draft plan` / `draft plan-approve`（可选计划审批）

```bash
tekon draft plan
tekon draft plan-approve
```

`plan` 生成验收标准、推荐模板和非目标的结构化计划快照，并标记 `hasPlan=true`、`planApproved=false`；`plan-approve` 记录计划批准。

两个命令均可用 `--shape <path>` 或位置参数选择需求卡；批准可用 `--actor <name>`。

未生成计划的需求卡只需需求批准。生成计划后必须再批准计划才能运行；重新生成会使旧计划批准失效。计划批准不绕过后续 Gate 或 PR 人工批准。

### 6.6 `run`

```bash
tekon run "需求文本" --template standard-delivery
tekon run --demand-file /path/to/approved-demand.json
tekon run "梳理模块职责，不修改文件" --goal
tekon run --dynamic --dry-run "需求文本" --agent mock
```

普通运行默认 `standard-delivery`；无文本时读取最近需求卡，并要求它已批准。`--goal` 使用内置单节点模板，不进入交付链路，与 `--template` 互斥，也不支持 `autonomous-delivery`。内置 Goal 默认不允许仓库源码改动，见 §5.7。

Provider、超时和其他常用参数见 §10。`--allow-dirty-base` 表示明确接受基于未提交改动运行，不是安全证明。

**同一次请求重试**：保存启动时打印的 Request ID，保持原需求、文件引用和执行参数，追加原 ID：

```bash
tekon run "给列表增加筛选" --agent mock --request-id delivery-20260907-01
```

相同 ID 与意图返回原 Run/Session/Job。`REQUEST_ID_CONFLICT` 表示 ID 已绑定其他意图；先核对参数，只有确定新建任务时才换 ID。受理后配置或 Provider 环境变化不会使原请求另建运行。

| 返回状态 | 下一步 |
| --- | --- |
| 本次未创建 | 修正校验错误后重试；同 ID 可能还有在途请求，先查询确认 |
| 已受理 | 观察原 Run/Session，避免另建 |
| 已受理，等待目录就绪 | `filesState=pending`；任务尚未执行，继续观察 |
| 已受理，等待目录恢复 | `filesState=recovery_required`；修复目录类型、权限或链接问题后按原请求重试 |
| 受理状态待确认 | 保留原 ID，查询或原样重试 |

目录失败时 CLI 输出原 Run/Session ID 并非零退出。用 `status --run-id <runId>` 查看 `admission`、`filesState`；Web 可在修复目录后重启 UI 服务触发恢复。查询本身不修目录，恢复不会复活已取消或终态运行。

**执行检查绑定**：新受理计划为 v3，记录模板实际使用的命令、来源、缺失与不适用决定；执行、恢复、修复重试和返工沿用原记录。内联命令优先，无命令引用的模板不依赖仓库命令配置。

绑定不冻结 `package.json` 脚本正文、测试代码、PATH 二进制、依赖或宿主环境。希望采用新配置时，应明确发起新任务。历史绑定含义见 §6.7。

**动态预览**：`--dynamic` 必须配 `--dry-run`，不受理 Run，也不支持 `--request-id`；可能初始化本地目录，`--save-as <name>` 会保存预览。普通 workflow/Goal 的 `--dry-run` 会在初始化前报 `DRY_RUN_UNSUPPORTED`。

### 6.7 `status`

```bash
tekon status
tekon status --run-id <runId>
```

查看整体 `status`、当前节点、产物与 Gate 数量、待人工决策，以及新运行的 `requestId`、`admission`、`filesState`。已有 Run ID 不代表任务已经执行。

| `executionBinding` | 含义 |
| --- | --- |
| `frozen` | 已记录命令和适用性；不代表环境冻结，执行前仍校验完整性 |
| `legacy-unbound` | 历史 v1/v2/无快照计划未绑定仓库命令，`commandRef` 按当前配置解析；原 v2 内联命令保留 |
| `invalid` | 计划记录无效，不能据此执行或恢复；保留原运行并核查 |
| `unknown` | 信息缺失或无法识别，刷新核对，不能当成已绑定 |

### 6.8 `approval summary`

```bash
tekon approval summary
```

输出决策、Run、节点、风险、准确命令、影响文件、readiness 失败项、证据，以及批准/拒绝入口。它是审批材料，不会发送通知。

| 参数 | 用途 |
| --- | --- |
| `--run-id <id>` | 定位 Run |
| `--decision-id <id>` | 精确定位决策；同一 Run 多个待审批项时必填 |
| `--max-chars <n>` | 产物和日志预览长度，默认 1200 |
| `--json` | 输出结构化结果 |

### 6.9 `eval approval-summary`

```bash
tekon eval approval-summary
```

检查 pending decision、风险、准确命令、影响、证据和可复制的批准/拒绝入口。`ready=false` 时先补材料；`ready=true` 仅表示摘要基本完整，仍需人判断风险。

### 6.10 `resume --approve-human`

审阅待审批 Gate 后：

```bash
tekon resume --approve-human
```

多个 pending decision 时加 `--decision-id <id>`，只批准该条。恢复使用原 Provider 快照；快照缺失或不可重放时拒绝继续。

普通暂停/中断恢复不需要假造一次审批：

```bash
tekon pause --run-id <runId>
tekon resume --run-id <runId>
```

若提示旧进程退出未确认，先检查并停止旧执行，再按提示确认旧 Job 身份：

```bash
tekon resume --run-id <runId> --confirm-stopped --previous-job-id <previousJobId>
```

历史无 Job 记录时用字面 `none`。缺失或过期身份会被拒绝，须刷新后重新核对。人工确认不是 OS 退出检测，受管理退出证据也不覆盖逃逸进程。

租约过期的已认领任务会转为 `interrupted`，不会自动重跑旧 Agent/Gate。已有活跃 Job 时等待原任务处理；`passed`、`failed`、`cancelled` 终态不可恢复。

审批后若竞争导致恢复失败，会显示“审批已记录，运行尚未恢复”。保留审批事实，处理原运行恢复，不重复批准。Web 操作与正常关闭后的检查恢复见 §7.1。

### 6.11 `approval reject`

```bash
tekon approval reject --note "证据不足，需要补充风险说明"
```

可用 `--run-id`、`--decision-id`、`--actor` 精确记录。决策变为 rejected，workflow 阻断，Gate 分类为 `human-rejected`。

终态 Run 拒绝此操作，不会被改回 blocked。

### 6.12 `review`

```bash
tekon review
```

建议按以下顺序阅读：

1. `Readiness Failed Checks`：哪些检查缺失或失败。
2. `Evidence Navigation`、`Gate Failure Triage`：证据在哪、失败如何处理。
3. `Changed Files`、`Artifacts`、`Gate Logs`：实际改动与验证。
4. `PR Body`、`PR Package`、`Delivery`：交付材料。
5. `Next Commands`：核对目标身份后执行后续命令。

### 6.13 `delivery dry-run`

```bash
tekon delivery dry-run
```

查看交付证据和命令计划，不产生远端副作用。适合首次接入或在准备 PR 前核对流程。

### 6.14 `delivery prepare`

```bash
tekon delivery prepare
```

仅支持 `standard-delivery`；满足 §4.7 前置检查后生成：

- `.tekon/runs/<runId>/delivery/pr-package.md`
- `.tekon/runs/<runId>/delivery/pr-body.md`
- `delivery-package` 产物及 `delivery.pr-prepared` 审计事件。

**审批记录限制**：重新准备可能保留旧 `approvedBy/approvedAt`，这些记录未绑定当前 HEAD、PR body 或证据包的内容指纹。应重新审阅当前材料；`create-pr` 每次仍要求当次人工批准。

### 6.15 `delivery create-pr`

```bash
tekon delivery create-pr --approve-human
```

会重新校验交付前置条件，并产生 push/PR 远端副作用。要求 `gh` 已认证、远端有权限、主工作区干净、QA tested ref 与签署相符。

受控 `git/gh` 和前置只读探测默认总超时 1 小时、无进展超时 15 分钟，写入 progress JSON。不安全分支 ref 会被拒绝。

失败后先看 `review` 和 `.tekon/runs/<runId>/delivery/`，修复认证、权限、工作区或证据问题。远端已有同分支 PR 时会尝试恢复 URL；不要在结果未明时盲目重复创建。

### 6.16 `delivery ci-status`

```bash
tekon delivery ci-status
tekon delivery ci-status --selector "<PR URL 或分支>"
```

只读查询 PR checks，写入 `ci-status` 产物和 `delivery.ci.checked` 审计事件，供 PR 包与 readiness 使用。

### 6.17 `delivery ci-watch`

```bash
tekon delivery ci-watch --max-attempts 20 --interval-ms 15000
```

轮询到 checks 终态或次数上限。支持 `--selector`、`--max-attempts`、`--interval-ms`、`--backoff`；不会重跑 CI、合入或上线。

### 6.18 `eval readiness`

```bash
tekon eval readiness
```

检查 workflow、审计哈希、Gate、待审批项、验收证据、安全扫描和交付证据。

`pr-prepared`、`pr-created`、`remote-ci-passed` 均为 required。缺少本地 PR 包、真实 PR 或已通过的远端 CI 证据时，`ready=false` 不必然表示本地 workflow 失败。通过 `review` 查看具体失败项。

### 6.19 `eval work-usability`

记录并评估样本：

```bash
tekon eval work-usability record --samples /path/to/work-usability-samples.yaml
tekon eval work-usability --samples /path/to/work-usability-samples.yaml
```

正式验收时生成可提交报告：

```bash
tekon eval work-usability --samples /path/to/work-usability-samples.yaml --report-md docs/reviews/work-usability.md --report-html docs/reviews/work-usability.html
```

记录真实 Codex 与 PR 要求：

```bash
tekon eval work-usability record --id tekon-codex-sample --expected-provider codex --require-real-provider --require-pr --samples docs/reviews/tekon-codex-samples.yaml
```

### 6.20 `ui`

```bash
tekon ui
tekon ui --repo /path/to/project --port 3001
```

默认端口 3000。先 `init`，再打开终端输出的完整 URL：`http://127.0.0.1:3000/#token=<会话令牌>`。

前端读取片段令牌后写入当前标签页的 sessionStorage，并从地址栏清除；刷新后仍可使用。片段不会随初次 URL 请求发送，后续 API 使用令牌鉴权。`Ctrl+C` 停止本地服务。

顶栏分开显示凭据和 Provider 状态；凭据有效不代表 Provider 可执行。可在连接面板重新应用令牌或单独重试 Provider 检查。完整页面流程见 §7。

### 6.21 `update`

```bash
tekon update
```

更新安装目录的代码、依赖与构建产物，输出版本结果。自定义安装目录时保留 `TEKON_HOME` 配置。

### 6.22 `draft`

```bash
tekon draft new "新增列表筛选，保留原有排序行为"
tekon draft show
tekon draft approve
```

`draft new` 必须提供需求文本。TTY 中可逐题回答；Enter 跳过，Ctrl+C 保留已填内容。`--no-interactive` 或非 TTY 跳过交互；`--json` 输出结构化结果。

仅当项目 `defaultAgent` 显式设为 `claude-code` 且本机 CLI 可用时，才尝试 Claude Code 辅助澄清；其他配置、未安装或调用失败时使用本地预设问题。此命令不支持 `--agent`。

该澄清调用是独立 CLI 路径，使用 Claude 的 `bypassPermissions`，不沿用 workflow Provider 的执行约束。只需本地塑形时使用 `draft shape` 或 `draft new "需求文本" --no-interactive`。

需求卡仍需人工批准；可选计划审批见 §6.5.1。

### 6.23 `clean`（当前暂停）

```bash
tekon clean
```

当前固定非零退出（exit code 1），stderr 返回 `CLEAN_SUSPENDED`。不会扫描、删除或重建 `.tekon/worktrees/`；Web `project.clean` 也不会删除 Run 目录。

生命周期安全清理尚未开放，此限制不代表已具备导出、保留期管理或可审计清除能力。

### 6.24 `help`

```bash
tekon help
tekon help draft
tekon help workflow
tekon --version
```

`tekon`、`tekon --help`、`tekon -h` 显示命令概览；`tekon help <command>` 显示该命令的摘要、用法或子命令列表，不保证列出全部参数。

`tekon --version` 或 `tekon -v` 输出版本号，本版为 `v0.25.1`。

## 7. Web Dashboard

`tekon ui` 启动本地界面，打开带 `#token=` 的完整 URL。令牌丢失时可从 `.tekon/web-session.json` 读取并填入顶栏连接面板；不要提交或共享令牌。

默认 **Session UI** 按会话展示用户消息、步骤、工具调用、产物、Gate 和审批。旧 Run Dashboard 保留在侧栏 **高级 Advanced**（`/advanced`），用于查看 overview、历史 Run、diff、日志、PR 包和交付操作。

**发起任务**：默认“启动受控交付”使用 Codex 与 `standard-delivery` 完整角色链路；使用 Claude Code 时，到「高级 Advanced → 新建运行」选择 `claude-code`。Composer 用于新建运行，当前不能在原会话继续追问或中途转向。Goal 是一次性轻量任务，不进入交付链路；DSH 仅支持 Goal，并要求勾选联网不受限确认。

**核对执行计划**：默认入口与高级表单均展示“检查配置与适用性”。展开逐项配置，核对来源和实际执行方式：已绑定命令、跳过或缺命令。安全扫描以实际说明为准，不一定随“不适用”配置跳过。

预览不展示原始工具、参数、环境变量或不适用理由。需要看命令正文时检查本地模板、`.tekon/repo-profile.yaml` 和 `package.json`。

| 页面提示 | 操作 |
| --- | --- |
| 刷新检查配置 | 看新增、移除或变化项，再显式提交；刷新本身不受理 |
| `PLAN_DIGEST_MISMATCH` | 刷新执行计划并重新审阅，不自动接受新计划 |
| `PLAN_CONFIG_INVALID` | 先修配置或读取权限，再刷新 |
| 暂无逐项变化信息 | 仅表示无法比较，不能推断配置未变 |

比较范围限于同一服务实例和发起上下文；服务重启、切换凭据/仓库/模板会使旧基线失效。受理后沿用原检查绑定，历史边界见 §6.7。

**提交结果待确认**：两个入口共享 Request ID 账本。网络错误后先“查询受理结果”，或恢复原输入并原样重试。“尚未查到”不排除原请求仍在处理中，不应直接换 ID。

- 已受理：进入原 Session/Run 观察；后续查询失败不会撤销已受理事实。
- 等待目录就绪：任务尚未执行，继续观察。
- 等待目录恢复：修复目录后按原内容重试或重启 UI 服务；查询按钮不修目录。
- 浏览器记录更新或跳转失败：点“观察原会话/运行”；服务端已确认，不要为找回页面另建任务。

账本按物理仓库和凭据作用域保存在当前标签页 sessionStorage，只记录指纹、ID 和受理状态，不保存需求正文。刷新后可以查询旧请求，重新提交则需自行恢复原输入。存储不可用或账本损坏时会在 Run 请求发出前阻止提交；不要删除待确认记录绕过提示。

若刷新后记录已移除，可从受控交付列表找原会话。只有明确选择“明确新建另一个任务”才使用新身份。symlink 路径指向同一物理仓库时历史 Run/Session 保持可见，不提供跨物理仓库切换。

**查看进展与证据**：Session 事件流实时刷新，断线后自动重连。列表在连接、重连或状态变化时重新读取；审批卡片会反映其他入口的决定。更早记录通过“加载更早历史”读取；在线回放超出预算时的历史截断提示不表示历史被删除。

Agent 消息通常是产物元数据合成摘要；DSH 展示最终 assistant 文本，均不提供模型原文逐块流。后续事件可能因 best-effort 投影缺失，不能仅凭 feed 重建运行或推断进程退出。新 Session 的三个开场事件与 Run、必需审计和初始 Job 原子受理，重试不重复创建。

证据链接定位产物、Gate 日志、审计或交付章节；不存在、读取失败或被筛选隐藏时按页面说明核对原运行。链接打开不等于证据通过。失败会话可“确认/归档”移至历史区，此操作不改变失败结果。

**Profile 与交付**：默认 `human-web` 由人推进人工点。`autonomous-delivery` 仅在常驻 Web/服务模式下于运行 passed 后自动准备证据和 PR 包，仍停在人工批准前；CLI 需显式 `delivery prepare`。任何 Profile 都不会自动批准 human gate、push、创建 PR、合入或上线。Goal 不支持 `autonomous-delivery`。

发起、恢复和批准返回受理结果后由后台推进，只有目录 ready 的 Job 才能执行。同一 Run 同时只允许一个运行执行 Job；重复恢复或批准提示已有活跃任务时，继续观察原任务。独立 readiness/delivery Job 不参与此限制。

高级 Dashboard 在控制后读取一次状态，后续进展可能需要刷新。集成方可用带 `x-session-token` 的 `GET /api/sessions/:sessionId/events` 订阅 SSE，并通过 `sinceSeq`/`Last-Event-ID` 回放；该事件流不是完整权威运行日志。

### 7.1 暂停、取消与恢复

先核对原 Run 和当前状态。按钮反馈说明请求处理结果，后续仍需观察状态与退出证据。

| 目的 | 操作与判断 |
| --- | --- |
| 暂时停下 | 点“暂停”；请求记录后，活动 Agent/Gate 可继续到检查边界 |
| 继续原任务 | 点“恢复”；已受理不代表模型已启动，观察原 Run |
| 结束任务 | 点“取消”，3 秒内再确认；检查实际终态和退出证据 |
| 补发取消 | 出现“重试取消”时在原运行处理投递或观察更新，不新建 Run |

暂停的初始排队 Job 可先排空而不执行；恢复复用未排空的 Job，或由服务端安排恢复 Job，Run 身份不变。提示已有活跃任务时等待原任务处理。

恢复提示旧执行退出未确认时，先检查并停止旧执行，再确认页面显示的旧 Job。身份过期须刷新重查；历史无 Job 的 CLI 用法见 §6.10。人工确认不是 OS 退出检测，受管理退出证据不覆盖逃逸进程。

`passed`、`failed`、`cancelled` 终态不可恢复。取消回执不代表所有进程已退出；先通过或失败的 Run 保留原终态。CLI 可用 `tekon cancel --run-id <runId>` 结束指定运行。

审批已记录但尚未恢复时，处理原 Run 的恢复，不再次批准。不要凭通知消失、按钮变化或 feed 缺新事件判断进程状态。

正常关闭服务打断构建/测试检查时，已完成 Agent 或自动修复产物及对应 worktree 会保留；显式恢复继续未完成检查。修复本身未完成时可能重跑 Agent。若提示 worktree 关联或恢复证据缺失，先核查原产物和工作树，不新建任务绕过。主动取消仍不可恢复。

### 7.1 Pause, cancel and resume

Check the original Run and its current state. A control response describes request handling; inspect subsequent state and exit evidence.

| Intent | Action and result |
| --- | --- |
| Pause | Choose Pause; the active Agent/Gate may continue to its next control boundary |
| Resume | Choose Resume; acceptance does not mean the model has started. Observe the original Run |
| Cancel | Choose Cancel and confirm within 3 seconds; check the actual terminal state and exit evidence |
| Retry cancellation | Repair pending delivery or observation on the original Run; no new Run is created |

A paused initial queued Job may drain without execution. Resume reuses the pending Job or schedules recovery after it drains, keeping the original Run. If an active Job is reported, wait for it to settle.

If exit is unconfirmed, check and stop the old execution before confirming its displayed Job identity. Refresh stale identities; see §6.10 for historical runs without Jobs. Human confirmation is not an OS exit observation; managed-exit evidence does not cover escaped processes.

Terminal `passed`, `failed` and `cancelled` runs cannot resume. A cancellation receipt does not prove all processes exited; an earlier success or failure retains its result.

If approval was recorded but recovery was not accepted, resume the original Run instead of approving again. Missing feed events, dismissed notices or changed controls do not prove process state.

When normal service shutdown interrupts build/test checks, completed Agent or repair outputs and their worktree are retained. Explicit resume continues unfinished checks; an incomplete repair may run the Agent again. Inspect missing worktree association or recovery evidence on the original Run instead of bypassing the error with a new task. Explicit cancellation remains non-resumable.

## 8. 如何判断结果是否可信

按以下顺序核对，不能只看命令退出码：

1. **状态**：workflow 是否 passed，是否仍有待审批项。
2. **范围**：Changed Files 和 diff 是否符合需求与非目标。
3. **证据**：需求、变更、测试、审阅产物能否对应验收标准。
4. **验证**：Gate Logs 是否显示实际执行、结果与测试对象。
5. **交付**：PR 包是否准确，远端 checks 是否已记录。
6. **评估**：`eval readiness` 的失败项是否已解释或补齐。

证据不清时先补证据，再决定是否创建 PR 或批准高风险动作。

## 9. 常见问题处理

### 9.1 `workflow preflight` 显示 missing command

确认 `suggestedCommand` 的语义，写入 `.tekon/repo-profile.yaml` 后重跑预检。只有确实不适用且说明原因时才配置跳过；安全扫描不能借此绕过。

### 9.2 run 拒绝 dirty base

目标仓库有未提交业务改动。先提交、stash 或整理无关改动；明确需要带入当前改动时加 `--allow-dirty-base`。该参数只记录确认，不证明改动安全。

### 9.3 pending human gate

运行 `approval summary` 和 `eval approval-summary`，通过 `review` 补齐证据。人工决定后用 `resume --approve-human` 批准，或 `approval reject` 拒绝。多个 pending decision 必须指定 `--decision-id`。

### 9.4 readiness 不通过

先看 `review` 的失败检查，再沿证据入口查看日志和产物。常见原因包括 workflow/Gate 失败、待审批项、验收证据缺失、安全扫描失败，以及尚未准备 PR、创建 PR 或写回通过的远端 CI。

### 9.5 `delivery create-pr` 失败

检查 `gh auth status`、远端权限、主工作区、pre-PR readiness 和 delivery 日志。已有同分支 PR 时先确认是否已恢复 URL。结果不明时不要重复高风险命令。

### 9.6 `ci-status` 查询失败

确认 Run 有 PR URL、`gh pr checks` 可用且权限足够；必要时用 `--selector "<PR URL 或分支>"` 指定。远端可能尚无 checks；非 GitHub host 仍需相应 adapter 支持。

### 9.7 Artifact 被拒绝入库

产物可能命中密钥或 token 模式。移除凭证，改用脱敏摘要，再按原运行的合法恢复路径补产物；终态失败 Run 不能直接 resume。基础扫描不等于完整 DLP。

### 9.8 Web 写操作被拒绝

核对会话令牌、`.tekon/web-session.json` 和目标项目范围。令牌文件缺失可重新 `init`，再用 `tekon ui --repo /path/to/project` 启动并打开完整 URL。手动启动 Web 时检查 `TEKON_PROJECT_ROOT`。

### 9.9 Codex provider 运行失败

先确认本机 `codex` 在 PATH、认证与 `internal` profile 可用：

```bash
codex --version
codex --profile internal --sandbox workspace-write --ask-for-approval on-request exec --help
```

这些命令仅核对 CLI 参数入口，不验证真实模型调用或认证成功。真实 workflow 节点会受控追加 `--add-dir <TEKON_OUTPUT_DIR>` 开放本节点产物目录。

查看 `.tekon/runs/<runId>/<nodeId>/` 的 stdout/stderr、manifest 和产物；确认声明的文件存在且符合 schema，结构化 JSON 的 `title`、`body` 非空。不要通过参数覆盖 sandbox、approval 或危险 bypass，也不要把真实失败换成 mock 通过作为验收。

[历史 Codex 自举验证记录](../reviews/2026-06-10-tekon-codex-self-bootstrap-report.md) 可供参考，不能替代当前任务的真实验证。

## 10. 参数速查

### 全局常见参数

以下是多个命令常用的参数，并非所有子命令都接受。

| 参数 | 用途 |
| --- | --- |
| `--help` / `-h` | 顶层命令概览；子命令摘要用 `tekon help <command>` |
| `--version` / `-v` | 版本号 |
| `--repo <path>` | 指定目标仓库 |
| `--run-id <id>` | 指定历史或非最近 Run |
| `--approve-human` | 当次明确批准人工 Gate 或远端交付 |
| `--allow-dirty-base` | 允许基于未提交改动运行 |
| `--shape <path>` | 指定需求卡 |
| `--decision-id <id>` | 指定人工决策 |

### `run` 参数

| 参数 | 用途 |
| --- | --- |
| `--template <name>` | 指定模板，默认 `standard-delivery` |
| `--goal` | 一次性轻量目标；与 `--template` 互斥，默认不接受源码修改 |
| `--agent <name>` | `codex`、`claude-code`、`mock` 或仅 Goal 可用的 `dsh-headless` |
| `--demand-file <path>` | 指定已批准需求卡；`--draft-file` 也受支持 |
| `--acknowledge-unrestricted-network` | 显式确认 DSH 等所用后端的联网不受限边界 |
| `--dynamic --dry-run` | 动态预览；普通 workflow/Goal 不支持 `--dry-run` |
| `--request-id <id>` | 原意图重试标识；8–128 个 ASCII 字母、数字、下划线或连字符 |
| `--save-as <name>` | 保存动态预览模板 |
| `--timeout-ms <ms>` | 真实 Provider 外层总超时 |
| `--no-progress-timeout-ms <ms>` | 无 stdout/stderr 或受控产物文件进展超时 |
| `--progress-heartbeat-ms <ms>` | progress JSON 心跳间隔 |

### `draft shape` 参数

| 参数 | 用途 |
| --- | --- |
| `--no-write` | 预览需求卡，不写入需求卡文件 |
| `--format json` | 输出 JSON |

### `delivery ci-watch` 参数

| 参数 | 用途 |
| --- | --- |
| `--selector <值>` | 指定 PR URL 或分支 |
| `--max-attempts <n>` | 最大查询次数 |
| `--interval-ms <ms>` | 初始轮询间隔 |
| `--backoff <n>` | 退避倍率 |

## 11. 使用说明

优先用于内部工具、测试与文档补齐、低风险缺陷，以及可回滚、可人工审阅的中小需求。

交付质量取决于需求、仓库检查、真实 Provider 和人工审阅。保留失败证据与恢复记录；合入、上线、权限扩大等决策始终由人控制。

## 12. 每次迭代后的手册更新规则

CLI/Web 入口、参数、Gate、评估、产物目录、Provider、安全边界或故障处理变化后，应核对本手册，并同步 HTML 人审版。

更新时说明当前行为和限制，核对示例与源码；仅文档变更检查结构、链接和中英对应，不据此宣称运行行为已验收。无需更新时，在交付说明中注明理由。

主稿：`docs/manual/tekon-user-manual.md`；人审版：`docs/manual/tekon-user-manual.html`。
