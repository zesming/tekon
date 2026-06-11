# 天工（Tekon）用户使用手册

适用对象：希望把研发需求从“口头描述”推进到“可审阅证据、可验证结果、可准备 PR”的个人开发者、技术负责人、研发效能团队和内部工具团队。

名称说明：天工的英文名是 Tekon，取 Tech + Kong 的融合谐音，中文名取“天工”。

适用范围：当前本地 V2 能力。本文只描述用户怎么使用、会得到什么、如何判断结果、遇到问题怎么处理，以及当前不能做什么。

## 1. 天工是什么

天工（Tekon）是一个本地 Agent workflow 驾驶系统。它不是聊天机器人，也不是自动上线平台；它更像一个“受控研发工作台”：用户把一个低到中风险的研发需求交给天工，天工会按固定 workflow 拆成角色任务、在隔离 worktree 中执行、跑验证 gate、沉淀 artifact 和审计记录，最后整理出可审阅材料和 PR 准备包。

天工的核心目标是增强人类交付能力，而不是替人类做高风险决策。它可以帮助你把需求推进到“可以人工审阅、可以准备 PR、可以继续验证”的状态；合入、上线、权限扩大、生产变更仍然由人控制。

当前更准确的定位：

- 一个本地 CLI/Web 工具。
- 一个受控 workflow 执行器。
- 一个证据和审阅材料收集器。
- 一个 PR 准备助手。
- 一个研发工作样本评估器。
- 一个支持 mock、Claude Code 和 Codex provider 的本地执行入口。

当前不是：

- 生产级远程多租户平台。
- 自动 merge / 自动上线系统。
- 完整 DLP、安全审计或 OS 级沙箱。
- 能稳定处理所有真实 LLM 任务的生产系统。
- 飞书 IM 通知机器人；当前只有可复制审批摘要。

## 2. 天工解决什么问题

### 2.1 需求进入研发前不清楚

真实工作里，很多需求只有一句话：“帮我补个功能”“修一下这个问题”。直接交给 Agent 容易出现边界不清、验收标准不清、风险不清。天工提供 `demand shape`，先把需求塑形成需求卡，包含：

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
- `standard-delivery`：标准交付治理流程，包含 PM 内审、PM/RD/QA 外部需求评审、RD 技术评审、QA 测试方案评审、独立变更评审、QA final signoff、QA signoff review 和 PMO checkpoint；当前已具备独立评审、角色范围、AC evidence、QA signoff、节点级 PMO checkpoint 和流程完整性 gate 的本地强约束，但不替代真实人类业务决策。QA validation 不应仅因 PR 创建、delivery package 或下游 PMO/QA signoff 尚未运行而阻塞，最终交付闭环仍由 QA signoff、PMO 和 pre-PR readiness 继续校验。

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

### 场景 A：我有一个小功能，希望推进到可审 PR

适用例子：

- 给内部工具增加一个筛选条件。
- 为 CLI 补一个低风险命令。
- 给 Web dashboard 增加一个入口。

推荐流程：

1. `tekon init` 初始化目标仓库。
2. `demand shape` 把需求写成需求卡。
3. 人工审阅需求卡。
4. `demand approve` 批准需求卡。
5. `run` 发起 workflow。
6. `status` 和 `review` 查看结果。
7. `delivery prepare` 生成 PR 准备包。
8. 人工确认后 `delivery create-pr --approve-human` 创建远端 PR。
9. `delivery ci-status` 或 `ci-watch` 写回远端 CI 证据。
10. `eval readiness` 判断 PR/CI 证据是否完整。

### 场景 B：我只想修一个 bug，但需要人工确认风险

适用例子：

- 修改一个已有逻辑分支。
- 修复一个低风险接口问题。
- 调整一个内部工具的状态处理。

推荐流程：

1. 使用 `bugfix` 模板运行。
2. 如果触发 human gate，先执行 `approval summary`。
3. 用 `eval approval-summary` 检查审批摘要是否完整。
4. 人工判断后选择：
   - `resume --approve-human`：批准继续。
   - `approval reject`：拒绝并阻断 workflow。

### 场景 C：我只想补测试

适用例子：

- 为某个模块补单测。
- 为失败路径补回归测试。
- 为 CLI 或 Web API 增加覆盖。

推荐流程：

1. `workflow select` 确认是否推荐 `test-improvement`。
2. `run --template test-improvement` 执行。
3. 看 gate 是否通过。
4. 用 `review` 检查 artifact 和测试证据。

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

以下示例假设 `tekon` 已安装到 PATH，并且你正在目标项目根目录执行命令。没有全局安装时，可用 `node /path/to/tekon/packages/cli/dist/index.js` 替换 `tekon`；从其它目录操作目标仓库时，再显式追加 `--repo /path/to/project`。

### 4.1 安装和构建

```bash
npm exec --yes -- pnpm@10.12.1 install --frozen-lockfile
npm exec --yes -- pnpm@10.12.1 build
```

构建后 CLI 路径：

```bash
node packages/cli/dist/index.js
```

如果将 CLI 安装到 PATH，命令名是：

```bash
tekon
```

本文默认使用 `tekon` 示例，重点展示普通用户的最短路径。

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
tekon demand shape "给 Web dashboard 增加审批摘要展示，要求 e2e 通过"
```

命令会输出 `shapePath` 和 `reviewPath`。先读 Markdown 审阅稿，确认需求边界后批准：

```bash
tekon demand approve
```

可选：评估需求卡质量。

```bash
tekon eval demand-shape
```

### 4.5 发起运行

```bash
tekon run
```

输出里会有 `runId`。后续常规命令默认读取最近一次 run；只有查看历史 run 或避免歧义时才需要手动传 `--run-id`。

明确长程任务可以在 run 级别显式放大外层预算，例如 2 小时总超时、20 分钟无输出进展超时、30 秒 heartbeat：

```bash
tekon run --timeout-ms 7200000 --no-progress-timeout-ms 1200000 --progress-heartbeat-ms 30000
```

未传 `--template` 时默认运行 `standard-delivery`；未传 `--agent` 时默认使用 Codex provider。离线回归或演示时，可显式切到 mock provider：

```bash
tekon run --template standard-delivery --agent mock
```

Codex provider 使用本机 `codex exec` 非交互模式，并固定 `codex --profile internal --sandbox workspace-write --ask-for-approval on-request --add-dir <TEKON_OUTPUT_DIR> exec`。其中 `--add-dir` 由 Tekon 受控追加，只开放本节点 artifact 输出目录；节点通过 `TEKON_OUTPUT_DIR` 和 `$TEKON_ARTIFACT_MANIFEST` 写回 Tekon artifact，`TEKON_ARTIFACT_MANIFEST` 是 manifest 文件路径，不是字面文件名。非 `code-changes` 节点会被要求只写节点 artifact、不修改仓库工作区，Engine 会在 worktree finalize 前拦截这类节点的源码变更；所有需要 artifact 的节点先写 artifact/manifest，再立即退出，不在节点内启动嵌套 subagent 审阅，也不在节点内执行 `git add`、`git commit`、`git push` 或创建 PR。结构化 JSON artifact 必须包含非空 `title` 和 `body` 字段；`demand-card`/`prd` 应使用 `acceptanceCriteria[].id/description`，有效的 `acceptance_criteria[].criterion` 会被兼容归一化；`test-plan` 应使用 `testBasis` 和 `testCases`，有效的 `sourceArtifactsReviewed`/`testScenarios` 会被窄归一化；`test-report`/`ac-evidence`/`qa-release-signoff` 应使用 `criteriaEvidence[].criterionId/status/evidence`，其中 `evidence` 必须是非空字符串；需要 evidence anchor 的场景必须把 `outputPaths`、`gateResultIds` 或 `artifactIds` 放在对应 `criteriaEvidence` 条目内，不能只放在 artifact 顶层；`artifactIds` 只能使用 Artifacts 区展示的真实 `artifact_<uuid>`，不能使用 `nodeId:type` 标签，`status` 只能是 `passed`、`failed`、`blocked` 或 `unknown`，`test-report.summary` 如存在必须是字符串；若真实 provider 写出对象形式 `summary`、带字符串 `summary` 的 `criteriaEvidence[].evidence` 对象，或用 `id`、`evidenceSummary`、`coverage`、`passed_with_*`/`failed_with_*`/`blocked_with_*` 状态标签表达 QA evidence，Tekon 会窄归一化为 schema 字段；缺失状态、含糊状态、无 `summary` 的 evidence 对象、只有顶层 anchor，或只有 `criterion` 而无证据字段时仍会失败；`code-changes` 的 provider-style JSON 如果包含非空 `summary`，或包含有效 `changedFiles`/`verification` 条目，可被归一化为可审阅 artifact，但真实 provider 仍应优先按 Tekon schema 写完整字段。评审类 artifact 必须额外写入合法 `reviewScope`、`reviewProcess`、`decision` 和 `findings` 数组；如果有 finding，每项必须包含合法 `severity` 和 `message`，不能用 `reviewRole`、`reviewedArtifacts` 或数组/对象形式的 `reviewScope` 替代这些 schema 字段；无效 finding `ownerRole` 会被保留到 message，不会放宽核心 review 字段。真实 provider 默认总超时为 1 小时，无 stdout/stderr 或受控输出目录文件进展默认 15 分钟超时；CLI `run` 可用 `--timeout-ms`、`--no-progress-timeout-ms`、`--progress-heartbeat-ms` 显式覆盖，Web dashboard 也提供对应输入项，适合把明确长程任务拉到 2 小时或更长。最终配置会写入 provider snapshot 以支持 resume；命令执行会写入 `*.progress.json`，记录状态、最近输出时间、stdout/stderr 字节数、受控输出目录文件数量和字节数、最近输出目录活动时间、elapsed、总超时、无进展超时、timeoutReason 和 heartbeat 次数。CommandGateway 会排除自身 stdout/stderr/progress 文件，只把 artifact、manifest 等产物文件变化计入进展；diff 级续期和可恢复 job runner 仍是后续增强。若 Codex 超时或非零退出但已写完有效 manifest，adapter 会在必需 artifact 校验通过后把该节点视为完成并继续进入 gate；缺少 workflow 必需 artifact、artifact schema 不合法、path/symlink 边界失败，或非 timeout signal 终止时，该节点会失败。QA validation 会记录 tested ref，QA signoff、PR package 和 readiness 会校验所测对象与交付对象一致。Codex provider 不会自动创建 PR、merge 或上线，远端副作用仍由 `delivery create-pr --approve-human` 控制；该命令中的受控 `git/gh` 命令及前置只读 probe 也会写入 progress JSON，并使用同一 1 小时总超时和 15 分钟无 stdout/stderr 或受控输出目录文件进展超时。

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
- Demand shape：`demand shape` 默认写入 `.tekon/demands/`；`demand approve` 默认批准最近需求卡，如果最近需求卡已经批准，历史未批准需求卡必须显式传 `--shape <path>`；`eval demand-shape` 默认评估最近一张需求卡。
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
- demand shape 文件。
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

### 6.4 `demand shape`

用途：把原始需求转成可审阅需求卡。

```bash
tekon demand shape "需求文本"
```

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

### 6.5 `demand approve`

用途：人工批准需求卡进入执行阶段。

```bash
tekon demand approve
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

常用参数：

- `--template <name>`：使用内置模板。
- `--demand-file <path>`：使用指定已批准需求卡；不传需求文本时默认读取最近需求卡并要求它已批准。
- `--agent mock`：使用 mock provider。
- `--agent claude-code`：使用 Claude Code adapter。
- `--agent codex`：使用本机 Codex CLI adapter；要求 `codex` 在 PATH 中且已完成本机认证。
- `--dynamic --dry-run`：只生成动态 workflow 预览。
- `--allow-dirty-base`：允许基于当前未提交业务改动运行。
- `--repo <path>`：只在跨仓库运行时使用。

如何判断结果：

- 输出 `runId` 后，用 `status` 和 `review` 继续检查。
- `status=passed` 不代表可以自动合入。
- 有 pending human gate 时，需要先处理审批。

### 6.7 `status`

用途：查看 run 当前状态。

```bash
tekon status
```

常见字段：

- `workflowStatus`：整体状态。
- `currentNodeId`：当前节点。
- `artifacts`：产物数量。
- `gates`：gate 数量。
- `pendingHumanDecisions`：待人工决策数量。

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

## 7. Web Dashboard

启动：

```bash
TEKON_PROJECT_ROOT=/path/to/project npm exec --yes -- pnpm@10.12.1 --filter @tekon/web dev
```

Web dashboard 适合：

- 查看项目 overview。
- 查看 run 列表。
- 选择历史 run。
- 查看 readiness、evidence、diff、artifact、gate log、PR 包。
- 处理 human approval。
- 发起受控模板 run。
- 选择 `mock`、`claude-code` 或 `codex` provider 发起 run。
- 触发 `delivery prepare`。
- 在人工批准下触发 `delivery create-pr`。

写操作需要 session token。token 在：

```text
/path/to/project/.tekon/web-session.json
```

注意：

- Web 是本地 dashboard，不是远程服务。
- token 不应提交。
- Web create-pr 和 CLI 一样，未批准时只落库等待审批，批准后才 push 和创建 PR。

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
| `--dynamic`                     | 使用动态 workflow 路径。                                                |
| `--dry-run`                     | 只预览，不执行。                                                        |
| `--save-as <name>`              | 保存动态 workflow 预览。                                                |
| `--timeout-ms <ms>`             | 覆盖真实 provider 外层总超时，明确长程任务可配置为 2 小时以上。         |
| `--no-progress-timeout-ms <ms>` | 覆盖无 stdout/stderr 或受控输出目录文件进展超时，用来判断任务是否卡死。 |
| `--progress-heartbeat-ms <ms>`  | 覆盖 progress JSON heartbeat 间隔。                                     |

### `demand shape` 参数

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

## 11. 当前边界和安全原则

必须明确：

- 天工不会自动 merge。
- 天工不会自动上线。
- 天工不会自动扩大权限。
- 天工不会把动态 workflow 非 dry-run 当成已完成能力。
- 天工当前不是生产级 OS 沙箱。
- 天工当前不是完整 DLP。
- 天工当前没有完整的远程多租户权限模型。
- 天工当前只把远端 CI 查询写回证据，不控制 CI。
- Codex provider 当前是本机 CLI 集成，不是生产级远程执行平台。
- 飞书 IM 通知尚未接入；当前是可复制审批摘要。

推荐使用范围：

- 内部工具。
- 研发效能工具。
- 测试补齐。
- 文档补齐。
- 低风险 bugfix。
- 可回滚、可人工审阅的中小需求。

不建议当前使用范围：

- 生产数据写入。
- 支付、权限、合规、隐私等高风险改动。
- 自动发布。
- 无人审阅的远端操作。
- 长时间真实 LLM 任务且缺恢复预案的场景。

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
