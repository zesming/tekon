# 变更日志

## 未发布

### 新增

- 天工（Tekon）主用户使用手册：`docs/manual/tekon-user-manual.md`，覆盖 overview、quick start、核心用户场景、CLI/Web 使用、参数解释、结果判断和常见问题处理；后续每次迭代后都必须评估是否需要同步更新。
- Phase 1 `@tekon/core` 安全可恢复内核。
- GitHub Actions core validation workflow 和 native dependency build gate。
- actionlint workflow validation。
- README 和当前 MVP 边界手册。
- Phase 2 角色文件系统、内置 `pm/rd/qa/reviewer/pmo` 角色、workflow 模板、constraint validator、dynamic workflow dry-run 和 durable workflow engine。
- `@tekon/cli` 本地 CLI 包，支持 `init/run/status/pause/resume/cancel/role/workflow/constraints/log/clean` 的 mock 验证路径；`run --allow-dirty-base` 可显式允许基于本地 dirty base 执行。
- Phase 2 CLI evidence 和 review HTML 审阅文档。
- Phase 3 SCM delivery dry-run、delivery evidence、metrics/report、Web dashboard、Web human approval、audit hash/filter、release-flow e2e 和 coverage provider。
- Phase 3 V2 用户手册、dogfooding report、final acceptance report 及对应 HTML 审阅版。
- README 更新 Phase 3 本地验收边界，并链接 V2 manual、dogfooding report 和 final acceptance report。
- 工作可用化增量：`.tekon/repo-profile.yaml` 仓库画像、Engine 角色 prompt 注入、CLI `--agent claude-code` adapter 接线、`delivery prepare` PR 准备包、`eval readiness` 工作就绪度评估。
- 工作可用化闭环：真实 git worktree lease 进入 Engine 主路径，节点改动会提交并推进到 `tekon-delivery/<runId>`；内置模板加入 `security-scan` gate。
- 真实 provider 产物协议：Engine 在 prompt/env 中注入 `TEKON_OUTPUT_DIR` 和 `$TEKON_ARTIFACT_MANIFEST` manifest 路径，Claude Code adapter 会读取 manifest、校验 artifact schema 并写入 Artifact Store；缺少必需 artifact 时节点失败。
- 仓库画像驱动 gate：内置 workflow 使用 `commandRef` 引用 `.tekon/repo-profile.yaml`，CLI 新增 `workflow preflight` 展示 build/lint/test/security 等 gate 将运行的命令。
- 恢复一致性：run 创建时落库 provider/config 摘要，CLI/Web resume 按 run provider 快照恢复；Engine 对 stale `running` 节点增加 completed role-run marker 检查，避免未完成节点直接跳到 gate。
- 受控远端交付：CLI `delivery create-pr` 支持人工批准后 push 分支并调用 `gh pr create --body-file`，PR 状态和 URL 落库，失败阶段落库，PR 已存在时尝试 `gh pr view` 恢复 URL；执行前会拒绝主工作区除 `.tekon` 外的未提交改动。
- 语义证据：artifact schema 支持验收标准、criteria evidence 和 security findings；delivery evidence/readiness 汇总逐条验收证据和安全扫描结果。
- Web human approval 自动 resume：Web approve/reject 会更新决策、gate/node/workflow 和 audit，approve 后自动调用 Engine 继续运行。
- 审阅面聚合：core 新增 review surface，CLI 新增 `review --run-id`，Web 新增 Readiness、Diff、Artifact 正文、Gate Logs、PR 包和下一步命令区块；同一聚合器会读取 artifact 正文、gate 输出、PR body/package、delivery diff 和 readiness 失败项。
- 审阅证据导航：review surface 新增 evidence groups，把 readiness 失败项关联到 artifact、gate log、audit event、PR body、PR package 和 diff；CLI 输出 Evidence Navigation，Web 新增 Evidence Links 面板。
- Gate 失败诊断：review surface 新增 Gate Failure Triage，把失败 gate 的分类、日志锚点、重试建议和建议命令结构化输出；CLI `review` 和 Web dashboard 会展示同一诊断结果。
- 需求塑形入口：core 新增 demand shape/approve/evaluate 能力，CLI 新增 `demand shape`、`demand approve`、`demand show`、`run --demand-file` 和 `eval demand-shape`；Web dashboard 可用 session token 塑形、批准需求后再发起 run。
- 受控 Workflow 选择：新增 `test-improvement`、`docs-update`、`plan-only` 内置模板，需求塑形可推荐对应模板；CLI 新增 `workflow select` 和 `eval workflow-selection`，Web 模板选择器同步展示受控模板。
- Web 受控执行入口：dashboard 可用 session token 发起模板 run、执行 `delivery prepare`、触发受人工批准的 `delivery create-pr`，并提供 artifact/gate/audit 到审阅正文和 PR 包的基础锚点互跳。
- Web 多运行审阅流：dashboard 会列出当前项目内的 runs，可选择任意 run 加载 readiness、artifact 正文、gate log、audit 和 PR 包；PR 准备/创建也作用在当前选中的 run 上，而不是固定 latest run。
- 工作可用样本评估：core 新增 work usability evaluator，CLI 新增 `eval work-usability --samples`，可按样本清单检查 readiness、真实 provider、真实 PR、security scan、worktree 隔离和远端副作用审批证据。
- 工作可用样本沉淀：CLI 新增 `eval work-usability record`，可把已完成 run 写入样本清单；`eval work-usability` 支持 `--report-md/--report-html` 生成可提交的样本评估报告。
- 敏感信息治理：新增共享 secret scanner，内置 `security-scan`、Artifact Store 和 CommandGateway 复用同一规则；artifact 写入前拒绝明显密钥，命令 stdout/stderr 落盘前脱敏。
- 远端 CI 状态证据：core 新增 `ci-status` artifact、delivery CI 查询和 PR 包 Remote CI 区块；CLI 新增 `delivery ci-status`，可只读调用 `gh pr checks` 并把 PR checks 状态写入 evidence 和 audit。
- 远端 CI watch：core 新增 PR checks 轮询能力和 `delivery.ci.watch-completed` 审计事件；CLI 新增 `delivery ci-watch`，可按次数、间隔和退避等待 PR checks 进入 `passed/failed/skipped` 终态，同时保留每次只读查询证据。
- 审批摘要：core 新增 human approval summary 和 `eval approval-summary` 评估；CLI 新增 `approval summary` 可复制审批摘要和 `approval reject` 拒绝入口；Web 待审批区展示同一摘要，包含风险、命令、影响文件、证据入口和批准/拒绝入口。
- 仓库画像缺失命令修复引导：core 新增 repo profile command guidance，CLI `workflow preflight` 在 commandRef 缺失时输出 `hint/profilePath`，并基于 `package.json` 的 `compile/test:e2e/playwright` 等候选脚本给出 `suggestedCommand`。
- 仓库画像显式不适用语义：repo profile 命令支持 `notApplicable: true` 和 `reason`；普通 command gate 会记录 `skipped/not-applicable` 并进入 readiness 和 PR 包，`security-scan` 仍保留内置扫描兜底。
- CLI 默认上下文推断：常规命令会自动发现当前 repo、最近需求卡、最近 run 和最近 pending human decision；`--repo`、`--run-id`、`--shape`、`--demand-file`、`--decision-id` 保留给跨仓库、历史对象和消除歧义场景。
- Codex provider P0 接线：core 新增 `createCodexAdapter` 和共享 manifest ingestion，CLI/Web 支持 `--agent codex`、provider snapshot resume 和 Web run 下拉选项；`eval work-usability record` 可记录 `expectedProvider: codex` 与真实 PR 要求。
- Codex provider 使用文档：README、主用户手册和 `docs/manual/codex-provider-smoke.md/html` 说明本机 Codex CLI、`codex --profile internal ... exec`、artifact manifest、权限边界和自举 smoke 流程。
- Standard Delivery 标准模板：新增完整 `standard-delivery` 内置 workflow，覆盖 PM 内审、PM/RD/QA 外部需求评审、RD 技术评审、QA 测试方案评审、独立变更评审、QA final signoff、QA signoff review 和 PMO checkpoint。
- Standard Delivery 交付可信度：非 `code-changes` 节点在 worktree finalize 前会被源码变更 guard 拦截；QA validation 会记录 tested ref，QA signoff、pre-PR readiness、PR package 和 readiness 会校验所测对象与交付对象一致。
- PMO 过程观测：Engine 在每个节点通过后写入 `pmo.node-checkpoint` 审计事件，记录节点状态、必需 artifact、gate 类型和最新 gate 状态；末端 PMO checkpoint 仍负责交付包完整性。
- Standard Delivery 强治理 gate：新增 `demand-review`、`implementation-plan`、`test-plan`、`ac-evidence`、`qa-release-signoff`、`process-checkpoint` 等 artifact schema，以及 `independent-review`、`role-scope`、`ac-evidence`、`qa-signoff`、`process-completeness` gate。
- Standard Delivery 角色边界：PM、RD、QA、reviewer、PMO 的 system 描述补充评审范围、不越权边界、独立评审要求和升级条件。
- Standard Delivery P1-0 seed run 归档：记录 `run_04b37267-2686-42c6-a0a4-9b37410f65f7` 在 RD Codex 节点 300 秒超时中断的证据和后续拆分策略。
- 长程任务产物进展观测：CommandGateway 的 no-progress 判定除 stdout/stderr 外，会扫描受控 `outputDir` 中的 artifact/manifest 等文件变化，排除自身 stdout/stderr/progress 文件，并在 progress JSON 中记录 `lastOutputDirActivityAt`、`outputDirFileCount`、`outputDirBytes` 和 `outputDirLatestMtimeMs`。

### 变更

- README 从阶段验收与增量清单改为项目级介绍，聚焦定位、工作流、核心能力、边界、快速开始、运行产物、仓库结构和文档入口。
- 项目品牌迁移为天工（Tekon）/tekon，CLI、包名、运行态目录、环境变量前缀、交付分支前缀、文档文件名和用户文档引用同步更新。
- Vitest 配置从旧 workspace 文件迁移到 `vitest.config.ts` 的 `test.projects`。
- 建立 `.prettierrc.json`，让全仓 `prettier --check .` 成为可执行的发布 gate。
- `@tekon/core test:e2e` 覆盖 workflow engine、recovery、gate repair 和 dynamic constraint e2e。
- 发布说明从 Phase 2 本地 mock CLI 基线更新为 Phase 3 本地验收通过，不把真实 PR、自动 merge 或生产级真实 LLM workflow 写成已完成能力。
- Web 技术基线从计划中的 Next/tRPC 降级为本地 Node HTTP + Vite React dashboard，验收产物为 `packages/web/dist`；保留后续升级到远程多路由 Web 的空间。
- `init` 会根据目标仓库 `package.json` 自动生成仓库画像；正式远端 PR 仍需人工确认，当前新增的是本地 PR 准备包和工作就绪度判断。
- `eval readiness` 从“PR 准备可审阅”升级为“验收标准有证据、安全扫描通过、无 pending human gate、PR 已创建且远端 CI 通过”的工作就绪判断；PR 创建和远端 CI 通过已从推荐项升为必需项，merge/上线仍不自动化。
- `eval work-usability` 把 P0-2/P0-6/P0-7 的真实样本要求固化为阈值评估；默认阈值面向正式 dogfooding 样本集，可在受控 fixture 中通过 sample file 降低阈值做回归测试。
- 内置安全扫描从 gate 私有规则调整为共享规则集；当前覆盖 private key、OpenAI-style key、AWS access key 和常见 token/secret assignment。
- `delivery create-pr` 默认不执行远端副作用；只有显式 `--approve-human` 才 push 和创建 PR，并且不会提交主工作区未提交改动或 `.tekon` 运行态目录。
- `delivery prepare` 和 `delivery create-pr` 统一执行 pre-PR readiness：workflow passed、无 pending human gate、验证 gate 与安全扫描满足、AC evidence 完整、QA release signoff 通过且绑定 QA validation tested ref；不满足时不会生成 PR 包或创建远端 PR。
- Mock agent 从“每个节点写全量内置 artifact”调整为优先写 workflow 要求的 artifact 类型，更贴近真实 provider manifest 协议。
- Codex adapter 默认固定 `codex --profile internal --sandbox workspace-write --ask-for-approval on-request --add-dir <TEKON_OUTPUT_DIR> exec`，并拒绝 provider args 覆盖 profile、sandbox、approval、文件系统、配置或危险 bypass 参数；`--add-dir` 只由 Tekon 受控追加到本节点 artifact 输出目录，安全边界参数会放在 `exec` 之前，匹配本机 Codex CLI 语法。
- 真实 provider 默认总超时从 300 秒调整为 1 小时，并写入 provider snapshot，降低长程 Codex/Claude Code 节点被短超时误杀的概率；CLI `run` 新增 `--timeout-ms`、`--no-progress-timeout-ms`、`--progress-heartbeat-ms`，Web dashboard 新增对应运行参数输入，允许对明确长程任务显式配置 2 小时以上外层预算；CommandGateway 同步写入 `*.progress.json`，记录命令状态、最近输出时间、stdout/stderr 字节数、受控输出目录文件数量和字节数、elapsed、总超时、无进展超时、timeoutReason 和 heartbeat 次数；默认无 stdout/stderr 或受控输出目录文件进展 15 分钟会触发 `no-progress` timeout，`delivery create-pr --approve-human` 的受控 `git/gh` 命令及前置只读 probe 也复用该超时和进展策略；diff 级续期和可恢复 job runner 仍待后续补强。
- Gate result 新增 `gateKey`，workflow 会为同一节点下的重复同类型 gate 生成稳定身份，例如多个 `schema` gate 会按 artifact/commandRef 区分；PMO `process-checkpoint` 也会带上 gateKey 证据，避免重复 gate 被误认为已经通过；human gate 审批会更新原始 gate result 并保留 gateKey，不再创建无 key 的 resume gate。
- CommandGateway 人工审批 note 复用命令参数脱敏逻辑，避免 `--token`、`--password` 或环境变量形式的敏感值进入 human decision 审阅面。
- SCM 远端交付对 delivery branch/base branch 做安全 ref 校验，并把实际生成的 `git branch`、`git push`、`gh pr create/view` 写命令加入 exact allow，避免 broad prefix allow 放大远端副作用边界。
- `workflow preflight` 对 schema、QA signoff、role-scope 等非命令 gate 显示 `status=not-command-gate`，与 repo profile 显式 `notApplicable` 的 `status=not-applicable` 区分开，避免把无需命令的语义 gate 误报成 command missing。
- Codex adapter 在 provider timeout 或非零退出后会尝试读取并校验 `$TEKON_ARTIFACT_MANIFEST` 指向的 manifest 文件；只要 workflow 必需 artifact 已完整入库，就按 artifact 完成继续进入 gate。manifest 缺失、schema 非法、必需 artifact 不齐或非 timeout signal 仍按失败处理。若真实 Codex 误写出字面文件名 `TEKON_ARTIFACT_MANIFEST`，adapter 会在受控 `TEKON_OUTPUT_DIR` 内按同一 schema 兼容读取。
- 真实 provider artifact 协议增加节点职责边界和收尾约束：非 `code-changes` 节点只写 `TEKON_OUTPUT_DIR` 下的节点 artifact，不修改仓库工作区；所有需要 artifact 的节点先写 artifact 与 `$TEKON_ARTIFACT_MANIFEST` 指向的 manifest 文件，再立即退出，且不在节点内启动嵌套 subagent 审阅或执行 `git add`、`git commit`、`git push`、PR 创建，避免 PM/QA 等节点继续执行下游实现、格式化、额外审阅或远端交付工作。
- 真实 provider artifact 协议明确结构化 JSON artifact 必须包含非空 `title` 和 `body`，并在 prompt 中要求 `demand-card`/`prd` 使用 `acceptanceCriteria[].id/description`；`code-changes` 的 provider-style JSON 在包含非空 `summary` 或有效 `changedFiles`/`verification` 条目时会被归一化为 Tekon 可审阅 artifact，`demand-card`/`prd` 的有效 `acceptance_criteria[].criterion` 也会被归一化为 `acceptanceCriteria[].description`，降低真实 Codex run 因字段命名漂移中断的概率。
- 真实 provider artifact 协议对评审类 artifact 增加严格 role-scoped review JSON 指引：prompt 会给出 `reviewScope`、`reviewProcess`、`decision`、`findings[].severity/message` 的合法字段和值，并写入目标节点和目标角色，避免真实 Codex 用 `reviewRole`、`reviewedArtifacts` 或数组/对象形式 `reviewScope` 产出无法过 schema/role-scope gate 的评审产物。
- 真实 provider 评审类 artifact 对 `findings[].ownerRole` 做窄归一化：若 provider 写出非角色枚举的 ownerRole，会把该值保留到 finding message 并移除无效 ownerRole；`reviewScope`、`reviewProcess.reviewerRole`、`targetRole` 和 `decision` 仍保持严格 schema 校验。
- 真实 provider `test-plan` artifact 协议明确要求 `testBasis` 和 `testCases` 字段；若 Codex 写出 provider-style `sourceArtifactsReviewed` 与 `testScenarios`，Tekon 会窄归一化为 schema 所需的测试依据和测试用例，避免 QA 测试方案因字段命名漂移中断。
- 真实 provider `test-report`/`ac-evidence`/`qa-release-signoff` artifact 协议明确要求 `criteriaEvidence[].criterionId/status/evidence`，其中 `evidence` 必须是字符串；需要 evidence anchor 的场景必须把 `outputPaths`、`gateResultIds` 或 `artifactIds` 放在对应 `criteriaEvidence` 条目内，不能只放在 artifact 顶层；`artifactIds` 只能使用 Artifacts 区展示的真实 `artifact_<uuid>`，不能使用 `nodeId:type` 标签。若 Codex 写出对象形式 `summary`、带字符串 `summary` 的 evidence 对象、`criteriaEvidence[].id/evidenceSummary/coverage` 或 `passed_with_*`/`failed_with_*`/`blocked_with_*` 状态标签，Tekon 会窄归一化为 schema 所需字段，缺失状态、含糊状态、无 `summary` 的 evidence 对象、只有顶层 anchor 或只有 `criterion` 而无证据字段仍失败，避免 QA validation 已产出有效证据但因字段命名漂移中断。
- 真实 provider `ac-evidence`/`qa-release-signoff` prompt 明确：当前 QA validation 节点不应仅因 PR 创建、delivery package 或下游 PMO/QA signoff 节点尚未运行而阻塞；这些交付闭环由后续节点、pre-PR readiness 和受控 PR 创建继续校验。
- Web dashboard 从只展示 artifact/gate 路径和计数，升级为可直接审阅关键正文、日志、diff 和 PR 包的本地审阅面，并能在同一页面完成 run 发起、PR 准备和受控 PR 创建入口。
- `demand shape` 默认写入 `.tekon/demands/`，`demand approve`、`run`、`status`、`review`、`approval summary`、`resume --approve-human`、`delivery prepare` 和 `eval readiness` 等常规命令默认读取最近合适的上下文；历史需求卡和历史 run/decision 仍通过显式参数兼容。
- 审批摘要和 review surface 的建议命令在默认上下文中改为短命令，例如 `tekon resume --approve-human`、`tekon approval reject`、`tekon review`；显式查看历史 run/decision 时仍输出带 id 和 repo 的精确命令，避免复制后操作到最新上下文。
- 默认审批命令遇到同一 run 多个 pending human decision 时会拒绝歧义并要求 `--decision-id`；`resume --approve-human --decision-id <id>` 只批准指定 decision。

### 修复

- CommandGateway 不再在无 stdin 时写入空 chunk；显式 stdin 写失败、子进程异步 `error` 事件、命令日志写入失败和忽略 `SIGTERM` 的 timeout 场景会返回受控结果，降低快速退出命令触发 `EPIPE`、promise 悬挂或丢失执行证据的风险。
- Web server 关闭时会主动关闭 idle/all connections，避免 dashboard e2e 或本地开发停止时被 keep-alive 连接挂住。
- Worktree finalize 提交节点变更时不再 broad `git add .`，改为只 stage `git status --porcelain` 中的非 `.tekon` 真实改动，避免真实 provider 运行态目录被 `.gitignore` 忽略时阻断节点 promote。

### 说明

- Tekon 已有本地 mock CLI 入口、本地 Web dashboard 和受人工批准的 PR 创建 fixture 覆盖，但仍未发布自动 merge、自动上线或生产级真实 LLM workflow。
- 交付 dry-run、prepare、create-pr、metrics、dogfooding 和 final acceptance 已记录本地验收结果；真实生产仓库使用仍需受控 fixture、明确人工批准和单独记录失败恢复证据。
- 当前 CLI/Web 主要用于本地验收和研发 dogfooding。

### 已验证

- 发布就绪加固本地 gate 已通过。
- 代码完成提交的远端 Core workflow 已通过。
- Claude provider 手动 smoke 已在认证本地环境通过。
- Phase 2 本地 gate 已通过：`pnpm build`、`pnpm typecheck`、`pnpm test -- --run`、`@tekon/core test:e2e`、`@tekon/cli test:e2e`、`prettier --check .`。
- Phase 3 本地 gate 已通过：`install --frozen-lockfile`、`build`、`typecheck`、Vitest coverage、CLI release e2e、Web dashboard e2e。

### 后续发布范围外

- 自动 merge。
- 生产级真实 LLM workflow 稳定性。
- 远程多租户 Web 服务。
