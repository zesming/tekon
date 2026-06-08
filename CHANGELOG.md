# 变更日志

## 未发布

### 新增

- Phase 1 `@donkey/core` 安全可恢复内核。
- GitHub Actions core validation workflow 和 native dependency build gate。
- actionlint workflow validation。
- README 和当前 MVP 边界手册。
- Phase 2 角色文件系统、内置 `pm/rd/qa/reviewer/pmo` 角色、workflow 模板、constraint validator、dynamic workflow dry-run 和 durable workflow engine。
- `@donkey/cli` 本地 CLI 包，支持 `init/run/status/pause/resume/cancel/role/workflow/constraints/log/clean` 的 mock 验证路径；`run --allow-dirty-base` 可显式允许基于本地 dirty base 执行。
- Phase 2 CLI evidence 和 review HTML 审阅文档。
- Phase 3 SCM delivery dry-run、delivery evidence、metrics/report、Web dashboard、Web human approval、audit hash/filter、release-flow e2e 和 coverage provider。
- Phase 3 V2 用户手册、dogfooding report、final acceptance report 及对应 HTML 审阅版。
- README 更新 Phase 3 本地验收边界，并链接 V2 manual、dogfooding report 和 final acceptance report。
- 工作可用化增量：`.donkey/repo-profile.yaml` 仓库画像、Engine 角色 prompt 注入、CLI `--agent claude-code` adapter 接线、`delivery prepare` PR 准备包、`eval readiness` 工作就绪度评估。
- 工作可用化闭环：真实 git worktree lease 进入 Engine 主路径，节点改动会提交并推进到 `donkey-delivery/<runId>`；内置模板加入 `security-scan` gate。
- 真实 provider 产物协议：Engine 在 prompt/env 中注入 `DONKEY_OUTPUT_DIR` 和 `DONKEY_ARTIFACT_MANIFEST`，Claude Code adapter 会读取 manifest、校验 artifact schema 并写入 Artifact Store；缺少必需 artifact 时节点失败。
- 仓库画像驱动 gate：内置 workflow 使用 `commandRef` 引用 `.donkey/repo-profile.yaml`，CLI 新增 `workflow preflight` 展示 build/lint/test/security 等 gate 将运行的命令。
- 恢复一致性：run 创建时落库 provider/config 摘要，CLI/Web resume 按 run provider 快照恢复；Engine 对 stale `running` 节点增加 completed role-run marker 检查，避免未完成节点直接跳到 gate。
- 受控远端交付：CLI `delivery create-pr` 支持人工批准后 push 分支并调用 `gh pr create --body-file`，PR 状态和 URL 落库，失败阶段落库，PR 已存在时尝试 `gh pr view` 恢复 URL；执行前会拒绝主工作区除 `.donkey` 外的未提交改动。
- 语义证据：artifact schema 支持验收标准、criteria evidence 和 security findings；delivery evidence/readiness 汇总逐条验收证据和安全扫描结果。
- Web human approval 自动 resume：Web approve/reject 会更新决策、gate/node/workflow 和 audit，approve 后自动调用 Engine 继续运行。
- 审阅面聚合：core 新增 review surface，CLI 新增 `review --run-id`，Web 新增 Readiness、Diff、Artifact 正文、Gate Logs、PR 包和下一步命令区块；同一聚合器会读取 artifact 正文、gate 输出、PR body/package、delivery diff 和 readiness 失败项。
- Web 受控执行入口：dashboard 可用 session token 发起模板 run、执行 `delivery prepare`、触发受人工批准的 `delivery create-pr`，并提供 artifact/gate/audit 到审阅正文和 PR 包的基础锚点互跳。
- Web 多运行审阅流：dashboard 会列出当前项目内的 runs，可选择任意 run 加载 readiness、artifact 正文、gate log、audit 和 PR 包；PR 准备/创建也作用在当前选中的 run 上，而不是固定 latest run。
- 工作可用样本评估：core 新增 work usability evaluator，CLI 新增 `eval work-usability --samples`，可按样本清单检查 readiness、真实 provider、真实 PR、security scan、worktree 隔离和远端副作用审批证据。
- 敏感信息治理：新增共享 secret scanner，内置 `security-scan`、Artifact Store 和 CommandGateway 复用同一规则；artifact 写入前拒绝明显密钥，命令 stdout/stderr 落盘前脱敏。
- 远端 CI 状态证据：core 新增 `ci-status` artifact、delivery CI 查询和 PR 包 Remote CI 区块；CLI 新增 `delivery ci-status`，可只读调用 `gh pr checks` 并把 PR checks 状态写入 evidence 和 audit。
- 仓库画像缺失命令修复引导：core 新增 repo profile command guidance，CLI `workflow preflight` 在 commandRef 缺失时输出 `hint/profilePath`，并基于 `package.json` 的 `compile/test:e2e/playwright` 等候选脚本给出 `suggestedCommand`。
- 仓库画像显式不适用语义：repo profile 命令支持 `notApplicable: true` 和 `reason`；普通 command gate 会记录 `skipped/not-applicable` 并进入 readiness 和 PR 包，`security-scan` 仍保留内置扫描兜底。

### 变更

- Vitest 配置从旧 workspace 文件迁移到 `vitest.config.ts` 的 `test.projects`。
- 建立 `.prettierrc.json`，让全仓 `prettier --check .` 成为可执行的发布 gate。
- `@donkey/core test:e2e` 覆盖 workflow engine、recovery、gate repair 和 dynamic constraint e2e。
- 发布说明从 Phase 2 本地 mock CLI 基线更新为 Phase 3 本地验收通过，不把真实 PR、自动 merge 或生产级真实 LLM workflow 写成已完成能力。
- Web 技术基线从计划中的 Next/tRPC 降级为本地 Node HTTP + Vite React dashboard，验收产物为 `packages/web/dist`；保留后续升级到远程多路由 Web 的空间。
- `init` 会根据目标仓库 `package.json` 自动生成仓库画像；正式远端 PR 仍需人工确认，当前新增的是本地 PR 准备包和工作就绪度判断。
- `eval readiness` 从“PR 准备可审阅”升级为“验收标准有证据、安全扫描通过、无 pending human gate、PR 创建状态和远端 CI 状态可见”的工作就绪判断；PR 创建和远端 CI 通过为推荐项，merge/上线仍不自动化。
- `eval work-usability` 把 P0-2/P0-6/P0-7 的真实样本要求固化为阈值评估；默认阈值面向正式 dogfooding 样本集，可在受控 fixture 中通过 sample file 降低阈值做回归测试。
- 内置安全扫描从 gate 私有规则调整为共享规则集；当前覆盖 private key、OpenAI-style key、AWS access key 和常见 token/secret assignment。
- `delivery create-pr` 默认不执行远端副作用；只有显式 `--approve-human` 才 push 和创建 PR，并且不会提交主工作区未提交改动或 `.donkey` 运行态目录。
- Mock agent 从“每个节点写全量内置 artifact”调整为优先写 workflow 要求的 artifact 类型，更贴近真实 provider manifest 协议。
- Web dashboard 从只展示 artifact/gate 路径和计数，升级为可直接审阅关键正文、日志、diff 和 PR 包的本地审阅面，并能在同一页面完成 run 发起、PR 准备和受控 PR 创建入口。

### 修复

- CommandGateway 不再在无 stdin 时写入空 chunk；显式 stdin 写失败、子进程异步 `error` 事件、命令日志写入失败和忽略 `SIGTERM` 的 timeout 场景会返回受控结果，降低快速退出命令触发 `EPIPE`、promise 悬挂或丢失执行证据的风险。
- Web server 关闭时会主动关闭 idle/all connections，避免 dashboard e2e 或本地开发停止时被 keep-alive 连接挂住。

### 说明

- Donkey 已有本地 mock CLI 入口、本地 Web dashboard 和受人工批准的 PR 创建 fixture 覆盖，但仍未发布自动 merge、自动上线或生产级真实 LLM workflow。
- 交付 dry-run、prepare、create-pr、metrics、dogfooding 和 final acceptance 已记录本地验收结果；真实生产仓库使用仍需受控 fixture、明确人工批准和单独记录失败恢复证据。
- 当前 CLI/Web 主要用于本地验收和研发 dogfooding。

### 已验证

- 发布就绪加固本地 gate 已通过。
- 代码完成提交的远端 Core workflow 已通过。
- Claude provider 手动 smoke 已在认证本地环境通过。
- Phase 2 本地 gate 已通过：`pnpm build`、`pnpm typecheck`、`pnpm test -- --run`、`@donkey/core test:e2e`、`@donkey/cli test:e2e`、`prettier --check .`。
- Phase 3 本地 gate 已通过：`install --frozen-lockfile`、`build`、`typecheck`、Vitest coverage、CLI release e2e、Web dashboard e2e。

### 后续发布范围外

- 自动 merge。
- 生产级真实 LLM workflow 稳定性。
- 远程多租户 Web 服务。
