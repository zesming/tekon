# 天工（Tekon）用户使用手册

适用版本：**v0.36.0**（当前版本以根 `package.json` 为准）。固定入口：[文档总索引](../README.md) · [产品范围](../product/tekon-current-product-scope.md) · [运行时合同](../technical/tekon-runtime-contract.md) · [运行控制设计](../design/tekon-run-control-design.md)。在目标项目根目录执行示例命令；跨仓库操作时追加 `--repo /path/to/project`。HTML 人审版支持章节目录与连续阅读，仅 §7.1 提供 English 对照。

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
| `lightweight-delivery` | **运行缺省默认**。轻量 plan→实现→人工确认三步：PM 出需求卡、RD 实现、Reviewer 人工把关，驳回回到 RD 返工。适合大多数小改动，不内置 QA/PMO 全链路 |
| `standard-feature` | 标准功能 |
| `bugfix` | 缺陷修复 |
| `test-improvement` | 补充测试 |
| `docs-update` | 更新文档 |
| `plan-only` | 只做方案 |
| `standard-delivery` | 完整交付治理：PM、RD、QA、Reviewer、PMO，含独立评审、验收证据和 QA 签署。需要完整评审/QA 全链路时显式选择 |

不传 `--template` 时，`run` 使用轻量默认 `lightweight-delivery`；`standard-delivery` 改为在模板列表中显式选择。模板生效优先级为：显式 `--template` > 已塑形需求卡的 `recommendedTemplate` > 缺省默认 `lightweight-delivery`。注意 `workflow select` 只给出推荐与理由，本身不改变运行默认值。

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

`bugfix` 不等于完整交付治理：它在模板里声明的交付要求只含 build/lint/test、安全扫描与 QA 签署，不含独立评审等治理门禁。运行通过、证据满足自身声明后即可 `delivery prepare`；裁决依据是冻结计划中的模板声明，而不是模板名称。

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

CI 验证 Node `20.19.0`、`22.12.0`，并跟踪 `24.x`；此验证范围不代表其他或未来 major 已获生产验证。DSH 另有更高 Node 要求，见 §5.7。

### 4.1.1 更新

```bash
tekon update
```

拉取代码、安装依赖并重新构建；完成后显示版本结果。

### 4.2 初始化目标仓库

```bash
tekon init
```

生成 `.tekon/` 配置、仓库检查配置、运行目录和 Web 会话令牌。在 git 仓库里，`init` 会把 `.tekon/` 写入本仓库的 `.git/info/exclude`（已被忽略时不写），不改你的 `.gitignore`，避免误提交令牌和数据库。

`init` 把 PATH 里第一个找到的 Provider 写成默认值，按 `claude`、`codex` 的顺序；两个都没有时写 `claude-code`，并提示运行 `tekon doctor`。随后检查运行前提：

```bash
tekon doctor
```

它列出每个 Provider 是否安装、以什么方式认证，以及默认 workflow 的检查命令是否齐全，只报告不修改，详见 §6.1.1。

### 4.3 检查目标仓库命令画像

```bash
tekon workflow preflight
```

| 状态 | 含义 |
| --- | --- |
| `resolved` | 已解析检查命令且通过命令策略裁决，预检与运行期使用同一判定 |
| `rejected` | 命令已解析但被命令策略拒绝（如 shell 元字符、网络命令、危险删除），原因见 `rejection=` 字段 |
| `missing` | 命令执行型 Gate（build/test/lint/e2e-pass）缺少命令，需补充仓库配置；新运行受理时此状态会直接阻断并给出修改示例 |
| `not-applicable` | 已显式声明不适用 |
| `not-command-gate` | 语义 Gate（human/schema/independent-review 等），运行期不执行外部命令；即使携带 `commandRef` 或内联命令也按此状态显示，引用是惰性的，不会报 missing 或被命令策略拒绝 |

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

没有需求文本时读取最近一张需求卡；该卡未批准会报错，不会自动改用更早的卡片。默认模板为轻量 `lightweight-delivery`（plan→实现→人工确认）；若需求卡带 `recommendedTemplate` 则采用它，显式 `--template` 优先级最高，需要完整 QA/PMO 治理时显式 `--template standard-delivery`。Provider 优先取 `--agent`，其次是项目 `defaultAgent`，未配置时为 `claude-code`。

启动前会检查 Provider：命令不在 PATH 里时直接拒绝，不创建运行，并说明下一步；没检测到登录只在 stderr 提示，运行照常开始。stderr 还会写出认证方式和透传的环境变量名。只检查流程时可显式使用 mock：

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

能否 prepare 由**冻结计划快照里的模板交付声明**（`delivery:` 块）裁决，与模板名称解耦：

- 可交付模板（内置 5 个产代码模板）：`standard-delivery`、`standard-feature`、`bugfix`、`test-improvement`、`docs-update`。各模板按自身声明要求证据，例如 `bugfix` 只要求 build/lint/test 三道命令门禁（另有安全扫描与 QA 签署要求），`test-improvement` 的命令门禁额外包含 e2e，`docs-update` 的命令门禁只有 build/lint（同样另有安全扫描与 QA 签署要求）。
- 不可交付模板：`goal`、`plan-only`、`lightweight-delivery` 没有交付声明，即使运行完全通过也结构性不可交付，prepare 会被 `delivery-not-declared` 检查拦截；Web 的 Prepare 按钮同步禁用并显示原因。需要 PR 交付请换用可交付模板重新发起运行。
- 升级到声明式交付（v0.40.0）之前创建的旧运行没有带声明的冻结快照，同样按不可交付处理，需重新发起运行才能交付。

prepare 要求 workflow 通过、无待审批 Gate，且模板声明的命令门禁、治理门禁、安全扫描、验收证据与 QA 签署全部满足。不满足前置检查时不会生成 PR 包：Web Dry-Run 会逐项列出失败检查和中文原因，Prepare 按钮同步禁用；CLI 直接执行 prepare 被拦截时输出中文阻断原因与补救路径，也可在 `tekon run` 结束的交付指引中查看。

prepare 完成后，CLI 输出与 Web Run 详情的「交付落点与下一步」卡片都会给出交付分支、基线、worktree、diff 概览、PR 包/body 文件路径与下一步命令；其中本地 `git merge tekon-delivery/<runId>` 合入提示仅在 CLI 输出（且交付分支真实存在时给出），Web 卡片只展示 tekon 命令与落点路径。

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

有顺序和依赖关系的角色节点集合。常用模板见 §2.2；`tekon workflow list` 查看目录，`tekon workflow show <name>` 查看模板。运行缺省默认是 `lightweight-delivery`（plan→实现→人工确认三阶段，人工门禁驳回经 `reworkTargetNodeId` 回到 RD 节点返工）；`standard-delivery` 等重治理模板需显式选择。

#### 节点工作区模式（workspace）

每个节点可声明 `workspace`，决定它在哪里执行、能否改源码：

| 模式 | 执行位置 | 能否改源码 | Git 要求 |
| --- | --- | --- | --- |
| `worktree`（默认） | 独立 git worktree | 可以，改动经 commit/promote 进入交付分支 | 必须 Git 仓库 |
| `in-place` | 直接在仓库主工作区 | 可以，改动直接留在工作区 | 支持非 Git 目录 |
| `none` | worktree（Git）或主工作区（非 Git） | 禁止 | 两种目录均可 |

- 默认 `worktree` 与历史行为完全一致；旧模板和旧运行数据自动按此模式处理。内置 Goal 模板显式声明 `workspace: none`，保留其只读语义。
- `none` 节点若改了源码，finalize 会报可恢复错误（`RECOVERABLE_LEASE_FAILURE`，审计事件 `worktree.lease.finalize.failed` 带改动路径与恢复指引），运行进入 `interrupted` 而非终态失败。回滚改动（或从提示的工作树路径取回后回滚）再 `tekon resume`，系统直接重试 finalize，不会重跑 agent。
- 非 Git 目录下 `none` 节点用文件快照判定源码改动：递归记录相对路径、内容 sha256、文件大小与权限位（chmod 可检测），忽略 `.git`、`.tekon`、`node_modules`。检测边界：空目录的增删、文件时间戳（mtime）变化不计为修改；租约创建与 finalize 各做一次全量哈希，大仓库会有额外 IO 成本。
- `in-place` 运行不产生 `tekon-delivery/<runId>` 交付分支，不能创建 PR；PR 交付会以 `DELIVERY_WORKSPACE_UNSUPPORTED` 前置拦截，请改用 `worktree` 模式。非 Git 目录下 autoFix repair、QA 交付 ref 同样不可用，需要这些能力请在 Git 仓库用 `worktree` 节点（误用会得到 `WORKSPACE_GIT_REQUIRED` 可读错误而非原始 git 报错）。
- 并发限制：`in-place` 节点直接改主工作区，作业锁按 run 隔离而非按目录，不要对同一仓库并行运行多个含 `in-place` 节点的 run，否则会相互覆盖文件。

#### 交付声明（delivery 块）

模板作者通过顶层 `delivery:` 块声明该模板能否走向 PR 交付及所需证据；没有该块、或 `deliverable` 不为 `true` 的模板（含全部旧版自定义模板）结构性不可交付，需显式补声明后重新发起运行：

```yaml
delivery:
  deliverable: true
  requirements:
    # 可选子集：build / test / lint / e2e-pass，且每个门必须在节点 gates 中真实存在
    commandGates: [build, lint, test]
    # 可选子集：independent-review / role-scope / ac-evidence / qa-signoff / process-completeness
    governanceGates: [independent-review, role-scope]
    qaReleaseSignoff: true      # 可选
    securityScan: true          # 可选
    acceptanceEvidence: true    # 可选
```

约束：声明的门禁类型必须在模板节点中实际配置，`tekon workflow validate` 与运行时归一化两条路径都会拒绝不存在的门；数组内类型不可重复；`deliverable: false` 不允许携带 `requirements`。三个布尔标志同样做静态交叉校验：`qaReleaseSignoff: true` 要求节点存在 `qa-signoff` 门、`securityScan: true` 要求存在 `security-scan` 门、`acceptanceEvidence: true` 要求存在 `ac-evidence` 门，否则 validate 期即以 `INVALID_WORKFLOW_TEMPLATE` 拒绝（避免写出校验通过但 readiness 永红的不可满足声明）。裁决只读取运行受理时冻结的快照，改 YAML 不影响在途运行。内置模板的声明示例可参考 `workflows/` 下五个产代码模板。

**未来条目**：自动化的 git 回送命令（把交付分支改动送回主工作区，需覆盖脏工作区、in-place、非 Git 目录等场景）尚在 backlog，当前本地合入仅支持手动 `git merge tekon-delivery/<runId>`；任何指引都不会承诺尚不存在的命令。

### 5.5 Role

节点承担的角色，如 PM、RD、QA、Reviewer、PMO。角色规定任务提示、知识和工具策略。

角色目录 `.tekon/roles/<role>/` 的 `agent.yaml` 支持可选的 Provider 覆盖字段（PD-10），均为厂商中立的开放字符串，不写时沿用运行级 Provider 默认值、行为零变化：

| 字段 | 含义 | 生效方式 |
| --- | --- | --- |
| `model` | 该角色节点使用的模型名 | claude-code 翻译为 `--model`；codex 翻译为受控 `--model` |
| `effort` | 推理投入档位 | codex 翻译为受控 `model_reasoning_effort`；claude-code 无稳定对应边界，声明即报 `ROLE_OVERRIDE_UNSUPPORTED` |
| `driver` | 角色期望的 Provider | 与运行级 Provider 不符时节点启动前报 `ROLE_DRIVER_MISMATCH`；同一运行不能按节点切换 harness |

覆盖按节点在执行期读取角色文件（与 `system.md` 热更同语义，不进冻结计划），实际生效值写入审计事件 `role.provider-overrides` 可追溯。三个字段在进入任何子进程 argv 前都经同一字符白名单校验：只允许字母（含大小写）、数字、连字符、点和下划线且须以字母或数字开头，长度 ≤64，拒绝选项前缀、空白、路径分隔与 Shell 元字符，杜绝选项注入；校验不通过报 `ROLE_OVERRIDE_INVALID`。`mock` 适配器忽略所有覆盖。

角色目录的 `tools.yaml` 声明 `network`、`allow`、`deny`、`requiresHumanApproval` 工具策略（10a-2 起为运行时强制，不再只是提示文本）：

- 节点执行门禁命令时，角色策略与门禁授权合并裁决——`deny` 与 `requiresHumanApproval` 取并集且角色 `deny` 不可被门禁手写授权覆盖，`network` 取最严（`disabled`>`restricted`>`enabled`），工作目录约束取语义交集；危险删除、force push、Shell 元字符等固定拒绝规则始终最先生效。
- 适配器侧把合并后的策略逐节点送入 Provider 命令权限；`requiresHumanApproval` 在 claude-code 转原生 ask，网关层的人工审批拦截对三个 Provider 一致。
- 返工的门禁恒在「拥有该 gate 的节点」角色下裁决（即返工目标节点，不是评审节点）。
- `tools.yaml` 缺失时回落到安全默认（`network: disabled`、允许/拒绝/审批列表均空）；文件损坏或无法解析时节点 fail-closed，不会静默回退继续执行。每次生效写审计事件 `role.tool-policy.applied`（含角色来源与约束规模）。
- 边界：codex/dsh 没有会话内工具域/审批的原生强制（claude-code 经 ask 设置落地），但网关层的 deny、网络与人工审批拦截对三者一致；角色文件运行时读盘、不进冻结计划，恢复运行时的策略一致性依赖文件未被修改。

角色按 **内置 → 用户（`~/.tekon/roles`）→ 项目（`.tekon/roles`）** 三级解析，取最后一个存在的整目录生效（仅 skills 跨级合并），因此项目覆盖必须是含 `agent.yaml` 的完整角色目录，不能只放一个 `system.md`。两种物化方式：CLI 用 `tekon role create <id>`（内置角色整目录复制、自定义 id 生成最小脚手架）；Web 在「高级 → Config → Roles」打开角色面板编辑 prompt 并保存——内置角色会自动物化整目录覆盖，安装目录保持只读不被修改，项目角色则直接改写其 `system.md`。Web 角色列表展示内置与项目角色并集及来源，新项目不再误显示「No roles configured」；写入需会话令牌，路径经软链与 realpath 锚定闸门校验，非法角色 ID 与超长 prompt（>64 KiB）会被拒绝并给中文提示。新建/删除角色仍只走 CLI，Web 不承担角色创建。

### 5.6 Gate

验证关卡，包括 build、lint、test、schema、security-scan、human，以及独立评审、角色范围、验收证据、QA 签署和流程完整性检查。

Gate 通过说明该项检查满足规则；是否可交付还需结合其他证据。human gate 必须由人处理。

### 5.7 Provider

| Provider | 适用范围与前提 |
| --- | --- |
| `claude-code` | CLI 与 Web 在未配置 `defaultAgent` 时的默认后端（两者读取同一份 `.tekon/config.yaml`）；本机安装并登录 Claude Code |
| `codex` | 本机安装并登录 Codex CLI；需要 profile 时在仓库配置里写明 |
| `mock` | 确定性流程演示与回归；不能证明真实 Agent 能力 |
| `dsh-headless` | experimental；显式选用，仅支持 Goal，网络出口不受限 |

真实 workflow 节点通过 artifact manifest 交回声明的产物。Run 保存 Provider 配置快照，恢复沿用原快照，避免意外切换后端。

**Claude Code 的登录与环境**：Tekon 不做认证配置，Claude 节点沿用你在当前 shell 里的 Claude 登录。节点除 `PATH`、`HOME` 等基础变量外，还会收到登录用户（`USER`、`LOGNAME`）、代理变量、`NODE_EXTRA_CA_CERTS` 以及全部 `ANTHROPIC_*`、`CLAUDE_*` 变量；`GITHUB_TOKEN`、`OPENAI_API_KEY`、`AWS_*` 等其他变量默认不会传给 Claude，需要时写进下面的 `passthroughEnv`。

- **认证方式跟着变量走**：shell 里有 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN` 或 `CLAUDE_CODE_OAUTH_TOKEN` 时，Claude 优先用它们，不用订阅登录（见 [Claude 认证](https://code.claude.com/docs/en/authentication)）。工作和个人场景在同一台机器上时，请在各自的 shell 里分开设置。
- **哪些命令能读到 key**：Tekon 自己运行的 build、test 等检查命令拿不到这些变量。Claude 在节点里执行的命令（包括 Tekon 免审批放行的 `npm test`、`npm run build`）和 Claude 本身一样能读到。处理不信任的仓库时，不要在 shell 里放 key，并先看一下仓库里 `.tekon/config.yaml` 的 `passthroughEnv`：列在那里的变量都会传给 Provider；`codex.profile` 会让 Codex 使用你本机上同名的 profile。
- **Bedrock、Vertex**：它们需要的 `AWS_*`、`CLOUD_ML_REGION` 等变量默认不会传过去。可以把变量名写进 `passthroughEnv`，也可以写进 Claude 设置文件的 `env` 字段（见 [Claude 设置](https://code.claude.com/docs/en/settings)）。

**Codex 的登录与环境**：Codex 节点只收到固定的一组变量：`PATH`、`HOME`、临时目录、语言、`SHELL`、`USER`、`LOGNAME`、`OPENAI_API_KEY`、`OPENAI_BASE_URL`、`CODEX_HOME`、代理变量和 `NODE_EXTRA_CA_CERTS`，其他变量要写进 `passthroughEnv`。shell 里的 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`CODEX_HOME` 会原样传给 Codex，它们决定 Codex 用哪个账号或登录、请求发到哪里；`tekon doctor` 会显示 Codex 的认证方式。

**Provider 配置**：写在 `.tekon/config.yaml` 的 `providers` 下，字段都可选：

```yaml
defaultAgent: claude-code
providers:
  claude-code:
    passthroughEnv: [AWS_PROFILE, AWS_REGION]
  codex:
    profile: internal
    passthroughEnv: [AZURE_OPENAI_API_KEY]
```

- `passthroughEnv` 是额外传给 Provider 的环境变量名，只写名字，值从启动 Tekon 的环境里读。名字必须是大写变量名；`PATH`、`SHELL`、`NODE_*`、`LD_*`、`DYLD_*`、`GIT_*`、`TEKON_*`、`PYTHON*` 等会改变程序加载方式或由 Tekon 控制的变量不能透传。值为空的变量会跳过。
- 这些变量只给 Provider 进程，Tekon 自己运行的 build、test 等检查命令拿不到。Provider 在节点里执行的命令和 Provider 本身一样能读到。
- `codex.profile` 只在配置后才以 `--profile` 传给 Codex。之前的版本默认使用 `internal`；升级后需要它时，请写 `providers.codex.profile: internal`。升级前启动的运行恢复时仍按原来的 `internal` 执行。升级 Tekon 后请重启已经在运行的 `tekon ui`。退回旧版本后，新版本创建的运行不能恢复，需要重新发起。
- 运行启动时记录这些配置，恢复沿用记录，之后改配置不影响已有运行。启动和每次恢复都会在审计里写下透传的变量名和认证方式，不记录值。
- 配置文件不是合法 YAML、字段名拼错或字段值不对时，`run`、`doctor` 会直接报错，不再按默认值运行。

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
- **Goal 默认不接受源码改动**：内置 Goal 不声明 `code-changes`；节点完成时若发现仓库文件或 HEAD 改变，会拒绝提升结果。它不等于操作系统只读沙箱，不适合交付代码修改。需要在非隔离工作区直接产出文件时，可在自定义模板节点声明 `workspace: in-place`（见 §5.4 工作区模式）。
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

单次运行的交付证据完整性评估，覆盖 workflow、Gate、产物、本地 PR 包、真实 PR 与远端 CI。Pre-PR readiness 的裁决依据是运行受理时冻结的计划快照（`plan_snapshot`，带 sha256 摘要）中的模板交付声明，运行途中修改模板 YAML 不影响在途运行的裁决。

**声明式交付边界（v0.40.0 起）**：模板通过 `delivery:` 块声明是否可交付及证据要求。`goal`、`plan-only`、`lightweight-delivery` 没有该声明，readiness 直接短路为单一失败检查 `delivery-not-declared`、`ready=false`，不再逐项亮灯；快照缺失、旧版格式或摘要校验失败同样 fail-closed 归入该检查，不会让运行详情页报错或误判可交付。

可交付模板按声明逐项裁决（共 9 项检查），模板未要求的维度以「模板未要求」通过而非标红：

| 检查 id | 含义 |
| --- | --- |
| `delivery-declared` | 冻结计划中的模板已声明交付要求（历史 id `standard-delivery-template`，旧事件中仍可能出现） |
| `workflow-passed` | 工作流已成功完成 |
| `audit-valid` | 审计哈希链完整未被篡改 |
| `no-pending-human-gates` | 无待处理人工审批 |
| `validation-gates-passed` | 声明的 build/test/lint/e2e 命令门禁均通过（skipped 且分类为 not-applicable 视为满足） |
| `governance-gates-satisfied` | 声明的独立评审、角色范围、验收证据、QA 签署、流程完整性门禁满足（历史 id `standard-governance-gates-passed`） |
| `acceptance-criteria-evidenced` | 验收准则证据齐全（仅声明 `acceptanceEvidence` 的模板要求） |
| `qa-release-signoff-passed` | QA release signoff 通过且覆盖全部验收准则 |
| `security-scans-passed` | 安全扫描证据满足（仅声明 `securityScan` 的模板要求） |

因此 `lightweight-delivery` 等不可交付运行的 `ready` 恒为 `false`，`delivery prepare`/`create-pr` 会以前置检查拦截，**默认模板不会、也无法自动产出 PR 交付**。需要走到可审 PR 时，发起运行显式选择五个可交付模板之一（或在自定义模板中显式编写 `delivery:` 声明，见 §5.4）。升级前创建的旧运行需重新发起才能交付。这是产品边界而非缺陷：轻量模板定位是「快速实现 + 人工把关」，把是否升级为可交付运行留给人决定。

### 5.11 Work Usability

样本集评估，用真实任务、Provider 和交付结果判断是否达到受控试用门槛。

## 6. 命令详解

### 6.1 `init`

```bash
tekon init
tekon init --repo /path/to/project
```

创建 `.tekon/config.yaml`、`repo-profile.yaml`、`web-session.json` 和运行目录。默认 `worktree` 模式要求目标是 Git 仓库；非 Git 目录可运行只含 `workspace: in-place` 或 `workspace: none` 节点的工作流（不建工作树，见 §5.4），但 worktree 隔离、diff 与 PR 交付功能不可用。

在 git 仓库里会把 `.tekon/` 写入 `.git/info/exclude`（已被忽略或已有这一行时不写；写不进去时只打印警告）。已初始化过的旧项目可在仓库根目录执行 `echo '.tekon/' >> "$(git rev-parse --git-path info/exclude)"` 补上，也可以重新执行 `init`。

`config.yaml` 只在不存在时生成，内容是 `defaultAgent`：PATH 里先找 `claude`，再找 `codex`，都没有时写 `claude-code`。这里只看是否安装，不检查登录。已有的 `config.yaml` 保持不变，旧版本写入的 `project`、`storage` 字段会被忽略。

Web 令牌文件丢失时可重新初始化；不要将令牌提交到仓库。

### 6.1.1 `doctor`

```bash
tekon doctor
tekon doctor --workflow bugfix
```

运行前检查，只报告不修改：

- 配置：`.tekon/config.yaml` 能否读取，默认 agent 是哪个。
- Provider：`claude-code`、`codex` 是否安装、版本，以及认证方式（API key、auth token、OAuth token、订阅登录、已保存的登录、未检测到、无法确定）。Claude 通过 `claude auth status --json` 判断，只读取是否登录和认证方式，不显示账号信息；Codex 只看 `OPENAI_API_KEY` 和 `CODEX_HOME/auth.json` 是否存在，不读取文件内容。也会列出配置的透传变量名。
- 工作流：默认 `lightweight-delivery`（可用 `--workflow` 指定）的检查命令是否都能解析；缺少时提示运行 `workflow preflight`。

最后一行给出结论。默认 Provider 未安装或未登录、检查命令缺失或配置有误时退出码为 1。旧版本 `init` 写入的 `defaultAgent: codex` 在 Codex 未安装时会被指出，按提示修改配置或运行时加 `--agent`。DSH 的检查仍用 `tekon provider preflight dsh-headless`。

### 6.2 `workflow preflight`

```bash
tekon workflow preflight
tekon workflow preflight bugfix
```

模板名是位置参数，默认 `lightweight-delivery`。输出状态含义见 §4.3。`resolved` 仅说明命令已解析，仍需实际运行验证。

缺命令时确认候选并更新 `.tekon/repo-profile.yaml`。`notApplicable` 必须有实际理由；不能用它绕过 `security-scan`，无外部安全命令时仍可能执行内置扫描。

### 6.3 `workflow select`

```bash
tekon workflow select "补齐 CLI 单元测试"
```

返回推荐、候选和理由。可用 `--shape <path>` 指定需求卡、`--template <name>` 评估人工选择、`--json` 输出结构化结果。

推荐不会保存 workflow，也不会改变 `run` 的默认模板。

### 6.3.1 模板查看、校验与脚手架（PD-07）

```bash
tekon workflow list
tekon workflow show <name>
tekon workflow validate <name>
tekon workflow create <name> --minimal
```

- `list` 逐行输出 `id [builtin|project]`，每个模板严格占一行；解析失败的模板不被丢弃，而是附 `invalid: <原因>`（错误里的换行已折叠，完整诊断用 `validate` 查看），让写错的模板在浏览阶段就暴露，不必等到 `run`。`.tekon/workflows/` 下的符号链接模板同样被扫描，可用于共享同一份模板。**软链信任边界对所有命令一致**：链接目标必须位于该模板目录内，指向目录外或断开的链接会被拒绝读取（`list` 标记无效，`show`/`validate`/`run` 等显式命令直接报错），避免仓库外文件内容经错误信息外泄；目录内的合法软链正常可用。
- `show <name>` 展示完整结构：每个阶段下的节点、角色、工作区模式、内联提示词、产物类型与门禁（命令型门禁带 `commandRef`），无需读模板 YAML 源码就能学写法；模板结构非法时给中文原因（含字段路径），不输出裸校验器 JSON。
- `validate <name>` 独立校验模板，成功退出 0 并给阶段/节点数，失败退出 1 并给中文可读原因与修复指路（不输出裸校验器 JSON）；名称不存在时提示用 `workflow list` 查看可用名称，不回显工具安装路径。
- `create <name> --minimal` 生成单阶段、单实现节点加人工门禁的最小脚手架（默认不带 `--minimal` 仍按 `--from` 复制既有模板；同传 `--minimal` 与 `--from` 时后者被忽略并给出提示）。目标文件已存在时拒绝创建，需先手动删除或换名；`--from` 来源模板不存在时同样给 `workflow list` 指路且不产生空目录。结构非法时 `validate`/`show`/`run` 都会明确报错。

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

普通运行默认轻量 `lightweight-delivery`；无文本时读取最近需求卡，并要求它已批准。已塑形需求卡的 `recommendedTemplate` 会被采用（显式 `--template` 优先）。`--goal` 使用内置单节点模板，不进入交付链路，与 `--template` 互斥，也不支持 `autonomous-delivery`。内置 Goal 默认不允许仓库源码改动，见 §5.7。

Provider、超时和其他常用参数见 §10。`--allow-dirty-base` 表示明确接受基于未提交改动运行，不是安全证明。

**结果输出**：CLI 等运行停下后，第一行写明结果：已完成、已暂停（等待人工确认）、等待处理、中断、失败或已取消。中断和失败会接着写原因和下一步，原因按类别给出：

| 原因 | 下一步 |
| --- | --- |
| 找不到 Provider 命令 | 安装命令，或从能执行它的终端重新启动 Tekon，然后 `tekon resume` |
| 未登录或凭据无效 | 执行 `claude auth login`（或在 Claude 里输入 `/login`）、`codex login`，或配置 API key，然后 `tekon resume` |
| 配置无效或命令被策略拒绝 | 修改 `.tekon/config.yaml`、repo-profile 或 Provider 配置，然后 `tekon resume --rebind` 让本运行采用新绑定（`tekon resume` 默认沿用启动时的 Provider 配置）；要改模板结构才需 `tekon run` 新建运行 |
| 非零退出、Tekon 停止时中断 | 先 `tekon resume` 重试；仍失败时查看节点日志 |
| 超时、长时间没有进展 | 先 `tekon resume` 重试；任务确实需要更久时，用更大的 `--timeout-ms` 或 `--no-progress-timeout-ms` 重新 `tekon run`（恢复沿用启动时的超时设置） |
| 产物缺失或不合 schema | 查看节点目录里的产物与 manifest，修复后 `tekon resume` |
| 运行已收敛为终态 `failed`（门禁重试耗尽等） | 排除失败原因后 `tekon retry --run-id <runId>` 只重跑失败节点（见 §6.10.1）；需要改配置或模板结构时发起新运行 |

`failed` 是终态，裸 `tekon resume` 不恢复终态运行；排除失败原因后可用 §6.10.1 的 `tekon retry` 显式重试失败节点，配置或模板本身需要变更时则发起新运行。Claude 退出码为 0 但结果标记为错误（例如未登录）时，按这个错误归类，不只报产物缺失。原因只取自本次恢复之后的记录，已经恢复过的旧原因不再显示。

**同一次请求重试**：保存启动时打印的 Request ID，保持原需求、文件引用和执行参数，追加原 ID：

```bash
tekon run "给列表增加筛选" --agent mock --request-id delivery-20260907-01
```

相同 ID 与意图返回原 Run/Session/Job。`REQUEST_ID_CONFLICT` 表示 ID 已绑定其他意图；先核对参数，只有确定新建任务时才换 ID。受理后配置或 Provider 环境变化不会使原请求另建运行。

**受理身份与执行分层**：受理身份由 Request ID 加请求信封（需求文本/文件引用等）的哈希双键确定，信封在首次意图后保持不变；而生效模板（含需求卡的 `recommendedTemplate` 回落）是在执行启动时单独解析、经独立通道绑定，不写进受理信封、也不重建信封。因此同一 Request ID 重放时，即使需求卡已被删除或修改，也不会因哈希不一致报 `REQUEST_ID_CONFLICT`，而是沿用首次执行绑定的模板继续。判定冲突只看信封本身，模板选择不参与身份指纹。

| 返回状态 | 下一步 |
| --- | --- |
| 本次未创建 | 修正校验错误后重试；同 ID 可能还有在途请求，先查询确认 |
| 已受理 | 观察原 Run/Session，避免另建 |
| 已受理，等待目录就绪 | `filesState=pending`；任务尚未执行，继续观察 |
| 已受理，等待目录恢复 | `filesState=recovery_required`；修复目录类型、权限或链接问题后按原请求重试 |
| 受理状态待确认 | 保留原 ID，查询或原样重试 |

目录失败时 CLI 输出原 Run/Session ID 并非零退出。用 `status --run-id <runId>` 查看 `admission`、`filesState`；Web 可在修复目录后重启 UI 服务触发恢复。查询本身不修目录，恢复不会复活已取消或终态运行。

**执行检查绑定**：新受理计划为 v3，记录模板实际使用的命令、来源、缺失与不适用决定；执行、恢复、修复重试和返工沿用原记录。内联命令优先，无命令引用的模板不依赖仓库命令配置。

绑定不冻结 `package.json` 脚本正文、测试代码、PATH 二进制、依赖或宿主环境。希望让本运行采用新的 repo-profile 命令或 Provider 配置时，用 `tekon resume --rebind` 显式重绑定（见 §6.10）；要改变模板结构（节点、门禁、角色定义）则必须发起新任务。历史绑定含义见 §6.7。

**动态预览**：`--dynamic` 必须配 `--dry-run`，不受理 Run，也不支持 `--request-id`；可能初始化本地目录，`--save-as <name>` 会保存预览。普通 workflow/Goal 的 `--dry-run` 会在初始化前报 `DRY_RUN_UNSUPPORTED`。

### 6.7 `status`

```bash
tekon status
tekon status --run-id <runId>
```

查看整体 `status`、当前节点、产物与 Gate 数量、待人工决策，以及新运行的 `requestId`、`admission`、`filesState`。已有 Run ID 不代表任务已经执行。运行处于 `interrupted`、`blocked` 或 `failed` 时，下面再写原因和下一步，规则同 §6.6。

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

租约过期的已认领任务会转为 `interrupted`，不会自动重跑旧 Agent/Gate。已有活跃 Job 时等待原任务处理；`passed`、`cancelled` 终态不可恢复，`failed` 的裸 `resume` 同样按终态拒绝，只能经 §6.10.1 的显式 `tekon retry` 重试。

CLI 的 `run` / `resume` 按工作流终态返回退出码：`0` 为 passed；`1` 为 failed、interrupted 或 cancelled；`2` 为 blocked（节点被确定性问题卡住，需先修复配置或环境再恢复）；`3` 为 paused（等待人工确认）。后台 Job 失败、中断或取消时还会显示 Job ID 和日志指引；即使 Run 仍显示 running，也不能将其视为执行成功。脚本或 IM 集成必须把 `2`/`3` 当作“未完成”处理，不能再按成功上报。阻塞节点重跑会复用仍有效的原工作树，保留修改；租约冲突或身份不符时明确报错，先核查工作树与日志。

恢复 blocked 节点时，Tekon 先做确定性失败判定：最近一次门禁失败属于 `missing-command`（检查命令仍未配置）、`rejected`（命令仍被授权策略拒绝）或 `unsupported-gate`（门禁类型仍不受支持），且失败条件在当前配置下仍然成立时，不会重跑 Agent，直接保持 blocked 并在审计事件 `node.resume-skipped-deterministic` 与输出里给出原因和下一步——这类失败在配置修复前重跑结果不会改变。条件已经消失（例如补全了 repo-profile 命令）或失败分类不在白名单（如 `exit-code`、`invalid-artifact`、`timeout`）时照常重跑 Agent，且重跑提示词会注入最近一次门禁失败的类型与分类，便于 Agent 针对性修复。

如果已经手工修好工作树或环境、只想让门禁重新判定而不重跑 Agent，使用 `tekon resume --run-id <runId> --gates-only`。该选项只对已有完成 Agent 执行的节点生效；节点从未完成 Agent 时会被拒绝（`GATES_ONLY_NO_AGENT_RUN`），避免在没有产物的情况下空跑门禁。该选项同样适用于 Web 的 `project.resume` 入参 `gatesOnly`。

**配置变更与 `--rebind`（PD-05）**：运行默认按受理时冻结的绑定恢复——即使你修改了 `.tekon/repo-profile.yaml`、`package.json` 检测或 Provider 配置，裸 `tekon resume` 与 `tekon status` 仍按冻结计划执行，但会在 stderr 只读提示当前配置与冻结绑定的分项差异（agent、provider、repo-profile 命令），不改变任何绑定。确认要让本运行采用当前配置时，显式执行：

```bash
# 采用当前 repo-profile / package.json 命令绑定（agent 不变）
tekon resume --run-id <runId> --rebind
# 同时切换 Provider/agent
tekon resume --run-id <runId> --rebind --agent codex
```

`--rebind` 用冻结模板原字节与当前仓库事实重新捕获一份自洽的执行计划（新 digest），在一个事务内替换 `plan_snapshot`/`plan_digest` 与 Provider 快照，并重写尚未终态节点（含历史返工节点）的物化门禁；已通过节点的历史门禁结果与审计链保持不变。重绑定记录在审计事件 `run.rebound`（含新旧 digest 与脱敏分项差异）。它只重绑定 agent、Provider 与门禁命令，不改变模板结构（节点/门禁/角色定义）；结构变更仍需发起新运行。终态运行（`passed`/`failed`/`cancelled`）与存在活跃 Job 的运行拒绝重绑定。角色指令（`.tekon/roles/<role>/system.md` 等）不在冻结范围内，修改后普通 resume 即生效，无需 `--rebind`。

历史租约冲突不会因 `--confirm-stopped` 消失：该参数只确认旧执行退出，不裁决工作树身份。保留原 Run 的日志、工作树与未提交/未跟踪文件，核对租约创建事件、节点、角色和 baseHead；当前没有自动 reconcile 命令，不要直接改库或强制删除工作树。若决定放弃原 Run，先确认执行已退出并另行保全所需修改，再用 `tekon cancel --run-id <runId>` 终结；取消不会修复或清理租约，原 Run 随后不可恢复。

审批后若竞争导致恢复失败，会显示“审批已记录，运行尚未恢复”。保留审批事实，处理原运行恢复，不重复批准。Web 操作与正常关闭后的检查恢复见 §7.1。

### 6.10.1 `retry`：重试终态 failed 运行

运行收敛为终态 `failed`（典型场景：门禁重试耗尽且模板声明 `onExhausted: fail`）后，裸 `tekon resume` 仍按终态拒绝。确认失败原因已经排除时，用显式重试只重跑失败节点：

```bash
tekon retry --run-id <runId>
```

省略 `--run-id` 时作用于最近一次运行。重试在一个 CAS 事务里把运行与失败节点从 `failed` 置回 `running`，审计事件 `run.retried` 记录 `fromStatus`/`toStatus`；随后按受理时冻结的执行计划继续调度：已 `passed`/`skipped` 的节点直接复用、不重复调用 Agent，只有失败节点及其后继重新执行（新建角色执行记录；节点仍活动的工作树租约会被复用以保留现场，租约已不存在时才新建）。退出码与 `run`/`resume` 同一合同：重试后 `passed` 为 `0`，仍 `failed` 为 `1`。

边界与限制：

- 只接受 `failed` 运行。`passed`/`cancelled` 按终态拒绝；`blocked`/`interrupted`/`paused` 报错 `RETRY_NOT_FAILED`——这些状态各有恢复语义，应使用 `tekon resume`，不能用 retry 绕过。
- 运行存在执行中的 Job（running/paused/cancelling）时拒绝入队，等待其结束后再重试；CLI 入队后、认领前崩溃留下的 queued 作业会在下一次 retry 时自动交接复用，不形成死结。
- 重试沿用冻结计划与 Provider 快照，不重新读取 repo-profile 或 Provider 配置（重绑定 `--rebind` 同样拒绝终态运行）。若失败根因是命令或 Provider 配置本身，修正后需发起新的 `tekon run`；角色指令不在冻结范围内，但其变更只影响重新执行的失败节点。
- 重试不改变模板结构（节点、门禁、角色定义）；需要结构调整时发起新运行。

### 6.11 `approval reject`

```bash
tekon approval reject --note "证据不足，需要补充风险说明"
```

可用 `--run-id`、`--decision-id`、`--actor` 精确记录。决策变为 rejected，workflow 阻断，Gate 分类为 `human-rejected`。

驳回备注与门禁发起时的请求上下文分别存放在决策的 `note` 与 `requestNote`，决策备注不再覆盖审批摘要所需的命令/风险信息。当该 human gate 在模板里声明了 `reworkTargetNodeId`（内置 bugfix、plan-only 模板已声明）时，随后执行 `tekon resume` 不会盲目重跑被驳回的评审节点，而是按声明对上游目标节点发起返工：驳回备注作为反馈注入返工 Agent 的提示词，返工完成后自动重跑评审节点并产生一条新的 pending 决策等待再次确认；同一驳回决策只触发一次返工。未声明返工目标的 human gate 驳回后仍按常规 blocked 恢复处理。

每一次驳回都是一轮新的决策循环：再次驳回会生成新的门禁结果并再触发一次针对同一目标节点的返工，返工次数不受 human gate 的 `maxRetries` 限制（该参数只约束自动门禁重试）；是否继续返工由人工审批决定，批准或取消运行即可结束循环。返工过程中 Agent 或评审重跑失败会把运行收敛为 interrupted 并保留真实错误，修复后 `tekon resume` 可从断点恢复，不会留下 running 状态的孤儿记录。

终态 Run 拒绝此操作，不会被改回 blocked。

### 6.12 `review`

```bash
tekon review
```

运行未完成时，开头会先写明“运行未完成”：这时大多数未通过的检查只是因为后面的节点还没执行。`Nodes` 列出每个节点的状态，没执行到的显示“未执行”。

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

支持所有带 `delivery:` 声明的可交付模板（五个内置产代码模板，及显式声明的自定义模板）；满足 §4.7 前置检查后生成：

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

服务只响应以 `localhost`、`127.0.0.1`、`::1` 主机名访问的请求；通过局域网 IP、反向代理域名或云 IDE 端口转发访问会返回 403 `Host not allowed`，请在本机用上面的地址打开（SSH 等转发到本机 localhost 的方式不受影响）。

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

该澄清调用是独立 CLI 路径，使用 Claude 的 `default` 权限模式，显式关闭模型的内置工具和 MCP 工具，并禁止自动加载 MCP 配置；只向模型提供草稿与回答文本。失败时回退为静态澄清，不申请扩大权限。宿主 CLI 的启动 hook 和配置仍由本机管理，这不是 OS 沙箱。只需本地塑形时使用 `draft shape` 或 `draft new "需求文本" --no-interactive`。

Claude workflow 将 `commandPolicy` 与 Provider `permissionProfile.tools` 相交，Tekon 仅为双方允许的以下精确命令新增免审批规则：`npm test`、`npm run test/build/lint/typecheck`，对应的 pnpm 直接命令与 run 形式，以及 `git status/diff/log`。这里斜线表示分别列出的命令，不是通配授权；这些规则不自动涵盖额外参数。Claude 内置只读规则与宿主权限配置仍可能独立批准其他命令。显式 deny 继续拒绝，`requiresHumanApproval` 转为 Claude 原生 ask；当前没有将原生 ask 接到 Web 人工决定的桥，遇到未获准命令可能失败或等待至超时。自定义 args 不得覆盖权限模式、工具规则或额外目录。获准脚本仍能执行仓库代码；该配置不提供 OS、网络或子进程隔离。角色 `tools.yaml` 的 deny/审批/网络/工作目录约束自 10a-2 起为运行时强制（见 §5.5），与此处 Provider 免审批规则叠加生效：角色 deny 优先，免审批不覆盖角色拒绝。

资料事实：Claude 的 `acceptEdits` 不自动批准普通 shell 命令，headless 支持显式工具授权；内置工具与 MCP 分别配置。参见 [程序化执行](https://code.claude.com/docs/en/headless)、[权限规则](https://code.claude.com/docs/en/permissions)和 [CLI 参数](https://code.claude.com/docs/en/cli-reference)。上述有限候选交集是 Tekon 的实现选择，不是 Claude 提供的完整沙箱。

需求卡仍需人工批准；可选计划审批见 §6.5.1。

### 6.23 `clean`

```bash
tekon clean                              # 列出可以清理的运行，不做改动
tekon clean --yes                        # 清理列出的全部运行
tekon clean --run-id <runId>             # 清理指定的运行
tekon clean --run-id <runId> --dry-run   # 只预览
```

只处理已结束（passed、failed、cancelled）且没有未结束任务的运行：移除仍被占用的 worktree，删除运行租约记录的节点分支 `tekon/<runId>/…`；worktree 没能移除时，保留它检出的分支。保留 `tekon-delivery/<runId>` 交付分支、`.tekon/runs/<runId>/` 下的证据、审计记录，以及不属于任何运行租约的目录。运行结束时不会自动清理。

指定的运行未结束（包括 paused、interrupted）或还有未结束的任务时，报错退出且不做改动：暂停或中断的运行恢复时还要用这些 worktree。已经不存在的目录或分支记为“已不存在”，继续下一步。个别项目没清理掉时退出码为 1，运行状态不变，原因见 `tekon log --run-id <runId>` 里的 `run.cleanup`。只处理在当前仓库路径下创建的 worktree：仓库移动过的话，旧路径下的不会列出。

Web 的 `project.clean` 规则相同：传 `confirm: 'clean-terminal-runs'`，加 `dryRun: true` 只预览，返回移除的 worktree、删除的分支、已不存在和没清理掉的数量。

### 6.24 `help`

```bash
tekon help
tekon help draft
tekon help workflow
tekon --version
```

`tekon`、`tekon --help`、`tekon -h` 显示命令概览；`tekon help <command>` 显示该命令的摘要、用法或子命令列表，不保证列出全部参数。

`tekon --version` 或 `tekon -v` 输出版本号，本版为 `v0.36.0`。

## 7. Web Dashboard

`tekon ui` 启动本地界面，打开带 `#token=` 的完整 URL。令牌丢失时可从 `.tekon/web-session.json` 读取并填入顶栏连接面板；不要提交或共享令牌。

默认 **Session UI** 按会话展示用户消息、步骤、工具调用、产物、Gate 和审批。运行列表与历史 Run、diff、日志、PR 包和交付操作收在侧栏 **高级 Advanced**（`/advanced/runs`，旧仪表盘入口已重定向到这里）。

**发起任务**：首页 Composer 提供运行模式、工作流模板、执行代理三个下拉框。运行模式在「受控交付（Workflow）」与「一次性任务（Goal）」间切换；模板留空时由服务端回落轻量默认 `lightweight-delivery`，需要完整评审/QA 全链路时在下拉中显式选 `standard-delivery`；执行代理默认取 `.tekon/config.yaml` 的 `defaultAgent`（未配置时为 `claude-code`）。三个选择都参与执行计划查询，切换任一项都会按全量入参刷新「执行前计划」预览，缓存按入参区分、不会串用旧选择的计划。Goal 模式下模板下拉禁用且请求不带模板；`dsh-headless` 仅能在 Goal 下运行，选中后自动切到 Goal 并清空模板。高级 Advanced → 新建运行表单共用同一套代理常量与 Goal/DSH 互斥规则。Composer 用于新建运行，当前不能在原会话继续追问或中途转向。Goal 是一次性轻量任务，不进入交付链路；DSH 要求勾选联网不受限确认。

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

运行概览中的“检查结果”卡把原先分开的失败检查和全部检查合并展示，每项只列一次。失败项排在前面，已通过项排在后面；卡片保留失败摘要、通过计数，以及检查证据和建议入口。先处理失败摘要，再按证据入口核对完整结果。

Agent 消息通常是产物元数据合成摘要；DSH 展示最终 assistant 文本，均不提供模型原文逐块流。后续事件可能因 best-effort 投影缺失，不能仅凭 feed 重建运行或推断进程退出。新 Session 的三个开场事件与 Run、必需审计和初始 Job 原子受理，重试不重复创建。

证据链接定位产物、Gate 日志、审计或交付章节；不存在、读取失败或被筛选隐藏时按页面说明核对原运行。链接打开不等于证据通过。失败会话可“确认/归档”移至历史区，此操作不改变失败结果。

**Profile 与交付**：默认 `human-web` 由人推进人工点。`autonomous-delivery` 仅在常驻 Web/服务模式下于运行 passed 后自动准备证据和 PR 包，仍停在人工批准前；CLI 需显式 `delivery prepare`。任何 Profile 都不会自动批准 human gate、push、创建 PR、合入或上线。Goal 不支持 `autonomous-delivery`。

发起、恢复和批准前都会检查 Provider：命令不在服务进程的 PATH 里时返回 `PROVIDER_NOT_INSTALLED` 和下一步，不创建运行；批准时先检查再记录，检查不通过时决定保持待处理。服务进程的 PATH 来自启动 `tekon ui` 的终端或服务，可能与你的 shell 不同。中断的会话在事件流里显示“运行中断”、原因和下一步。仓库配置了 `passthroughEnv` 时，事件流在“受控交付已开始”和“受控交付已恢复”这一行列出透传给 Provider 的变量名。

发起、恢复和批准返回受理结果后由后台推进，只有目录 ready 的 Job 才能执行。同一 Run 同时只允许一个运行执行 Job；重复恢复或批准提示已有活跃任务时，继续观察原任务。独立 readiness/delivery Job 不参与此限制。

CLI 进程只执行它自己发起或恢复的任务，Web 服务不执行 CLI 发起的任务。CLI 受理后就退出、还没执行的运行，可以再用 `tekon resume` 或在 Web 上恢复，由恢复的一方执行。升级到 0.29.0 后请重启已在运行的 `tekon ui`：旧版本的服务仍会接手 CLI 的任务。

执行中的进程被挂起（电脑休眠、调试器暂停）后恢复，会先续租自己的任务，不会把它判为中断。同一仓库还有另一个 Tekon 进程在运行时，它分不清挂起和退出，会在租约过期（默认 30 秒）后把任务标为中断，这时按 §7.1 恢复。系统时钟往回调会推迟这类回收。

节点和命令的输出脱敏后按行实时写入 `.tekon/runs/<runId>/` 下的 stdout/stderr 日志，运行中就能用 `tail -f` 查看；换行、`\r\n` 和单独的 `\r`（进度条）都算一行结束，单行超过 1MB 时分段写入。进度文件 `progress.json` 在持续输出时最多每秒更新一次。

Tekon 进程被强制结束后，它启动的 agent 等子进程可能还在运行。另一个 Tekon 进程在租约过期后把这个任务标为中断时，会核对这些进程组的首进程启动时间，一致才先发 SIGTERM，5 秒宽限期结束、发 SIGKILL 前再核对一次启动时间，确认进程组没有被系统回收复用后才发 SIGKILL；结果写入运行审计 `job.process-group`（`signalled`、`killed`、`escalation-skipped`、`start-time-mismatch` 或 `leader-gone`）。限制：进程启动后不到一个心跳（默认 10 秒）Tekon 就被结束的，来不及记录；首进程已经退出的进程组不处理；没有 `ps` 命令的平台（如 Windows）无法核对启动时间，遗留进程不会被自动结束。这几种情况下请手动结束剩下的进程。

高级 Dashboard 在控制后读取一次状态，后续进展可能需要刷新。集成方可用带 `x-session-token` 的 `GET /api/sessions/:sessionId/events` 订阅 SSE，并通过 `sinceSeq`/`Last-Event-ID` 回放；该事件流不是完整权威运行日志。

**角色与模板配置（Config）**：侧栏「高级 Advanced → Config」分 Roles 与 Workflows 两个页签。Roles 列出内置与项目角色并集并标注来源；点开角色可查看当前生效的系统提示词，点「编辑 prompt」保存即写入项目级覆盖（内置角色先整目录物化到 `.tekon/roles/<id>/`，不改安装文件），保存需要会话令牌，无令牌时按钮提示先设置令牌。Workflows 页签浏览内置与项目工作流模板。旧版的 Constraints 页签已移除——它展示的是与真实配置不一致的静态参考内容。

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

`passed`、`cancelled` 终态不可恢复；`failed` 仅可经 §6.10.1 的 `tekon retry` 显式重试，裸恢复仍拒绝。取消回执不代表所有进程已退出；先通过或失败的 Run 保留原终态。CLI 可用 `tekon cancel --run-id <runId>` 结束指定运行。

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

先查看 `tekon log --run-id <runId>` 中的节点失败原因和本次产物目录。常见原因是 manifest 缺失、声明文件不存在、JSON 未正确转义、schema 字段/类型不符或缺少必需产物；子进程退出 0 也不代表产物已通过导入。使用 JSON 序列化生成结构化内容，不把命令字符串填入枚举字段；按诊断修正生成方式，再通过原 Run 的合法恢复路径重试，不能跳过 schema 或把失败标记改成通过。

产物也可能命中密钥或 token 模式。移除凭证，改用脱敏摘要；终态失败 Run 不能直接 resume。基础扫描不等于完整 DLP，诊断摘要也不能替代对原文件的本地检查。

### 9.8 Web 写操作被拒绝

核对会话令牌、`.tekon/web-session.json` 和目标项目范围。令牌文件缺失可重新 `init`，再用 `tekon ui --repo /path/to/project` 启动并打开完整 URL。手动启动 Web 时检查 `TEKON_PROJECT_ROOT`。

### 9.9 Provider 运行失败

先看 `run`、`status` 输出的原因和下一步（§6.6），再运行 `tekon doctor` 核对安装和认证方式。Codex 配置了 profile 时，可核对 profile 是否存在：

```bash
codex --version
codex --profile <profile> --sandbox workspace-write --ask-for-approval on-request exec --help
```

这些命令仅核对 CLI 参数入口，不验证真实模型调用或认证成功。认证方式“未检测到”只是提示，凭据也可能来自 Tekon 看不到的位置；以实际运行结果为准。真实 workflow 节点会受控追加 `--add-dir <TEKON_OUTPUT_DIR>` 开放本节点产物目录。

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
| `--template <name>` | 指定模板，默认 `lightweight-delivery`（已塑形需求卡的推荐模板优先于缺省默认） |
| `--goal` | 一次性轻量目标；与 `--template` 互斥，默认不接受源码修改 |
| `--agent <name>` | `claude-code`、`codex`、`mock` 或仅 Goal 可用的 `dsh-headless`；默认取 `defaultAgent`，未配置时为 `claude-code` |
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
