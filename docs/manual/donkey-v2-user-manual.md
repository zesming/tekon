# Donkey V2 用户手册

生成日期：2026-06-05
适用分支：`rebuild-v2`
文档状态：Phase 3 Task 20 最终验收版

## 1. 当前定位

Donkey V2 是面向本地仓库的 Agent workflow 驾驶系统。当前已完成本地 CLI/Web 验收：`init`、模板运行、动态 workflow dry-run、状态查询、人工 gate、角色、workflow、约束、日志、清理命令、交付 dry-run、PR 准备包、工作就绪度评估、metrics 和本地 Web dashboard 可在受控 fixture 中使用。

本手册只描述当前可验证或按当前实现边界可操作的能力。真实远端 PR 创建、自动 merge、生产级真实 LLM workflow 稳定性和远程多租户 Web 服务不在本次可用范围内。

## 2. 安装与构建 install

推荐在 Donkey 仓库根目录执行：

```bash
npm exec --yes -- pnpm@10.12.1 install --frozen-lockfile
npm exec --yes -- pnpm@10.12.1 build
```

本地 CLI 入口在构建后位于：

```bash
node /path/to/donkey/packages/cli/dist/index.js
```

如果后续需要真实 PR 创建，本机还需要可用的 `git` 和 `gh`，并且 `gh auth status` 必须在目标远端仓库具备创建 PR 的权限。当前建议先使用交付 dry-run，不把 dry-run 视为真实 PR 已创建。

## 3. 初始化项目 init

在目标 Git 仓库中初始化 Donkey：

```bash
node /path/to/donkey/packages/cli/dist/index.js init --repo /path/to/project
```

初始化会创建 `.donkey/` 目录、`config.yaml`、`repo-profile.yaml`、SQLite 数据库、角色目录、workflow 目录和 worktree 目录。`.donkey/` 是运行态目录，默认不作为可提交验收结论保存；重要结果应同步写入 `docs/reviews/`。

`repo-profile.yaml` 会根据目标仓库 `package.json` 自动填充可识别的 `build`、`typecheck`、`lint`、`test`、`e2e` 命令，并保留 PR base branch 和风险路径配置。当前 PR 准备包会展示仓库画像命令并使用其中的 PR base branch；workflow gate 仍以模板内配置为准，尚未自动改写验证命令。

`init` 也会生成 `.donkey/web-session.json`。这个文件保存本地 Web 写操作 token，已被 `.gitignore` 排除，不应提交。

## 4. 发起运行 run

### 标准模板运行

```bash
node /path/to/donkey/packages/cli/dist/index.js run "给示例模块加批量重试" --template standard-feature --agent mock --repo /path/to/project
```

按 Phase 2 证据，`standard-feature` mock 路径可完成到 `passed` 并生成本地 artifacts。命令输出包含 `runId`、`status` 和 `humanGate` 状态。

当前 `--agent claude-code` 已接入 CLI 主执行链路，会使用 Donkey 的 Claude Code adapter 和角色 prompt 注入。使用前必须确认本机 `claude` CLI、认证状态、目标仓库权限和人工审批边界可用；该路径仍需在受控真实仓库中单独记录 smoke 证据，不应把一次本地接线视为生产级真实 LLM workflow 稳定。

默认情况下，模板运行会检查 Git 工作区并拒绝实际业务文件已有本地改动的 dirty base，`.donkey/` 运行态目录不计入阻断。若你确认要基于当前未提交改动执行，可显式追加：

```bash
node /path/to/donkey/packages/cli/dist/index.js run "给示例模块加批量重试" --template standard-feature --agent mock --allow-dirty-base --repo /path/to/project
```

`--allow-dirty-base` 应作为人工确认动作使用；它不等于把本地改动提交、审阅或发布。

### 动态 workflow dry-run

```bash
node /path/to/donkey/packages/cli/dist/index.js run --dynamic --dry-run "给支付模块加退款功能，属于高风险数据变更" --agent mock --repo /path/to/project
```

当前动态路径要求 `--dry-run`。它会生成 workflow preview 和 constraint mutation 摘要，不创建 worktree，不执行代码改动，不代表真实 LLM 已完成规划。高风险或数据相关需求会展示 human gate、rollback plan 等约束注入结果。

如需把动态预览保存为项目 workflow，可使用：

```bash
node /path/to/donkey/packages/cli/dist/index.js run --dynamic --dry-run "给支付模块加退款功能" --agent mock --save-as refund-flow --repo /path/to/project
```

保存路径限制在 `.donkey/workflows/` 内，名称需满足安全命名规则。

## 5. 查看状态 status

```bash
node /path/to/donkey/packages/cli/dist/index.js status --run-id <runId> --repo /path/to/project
```

状态输出会显示 run、repo、workflow status、current node、gate 数量、artifact 数量和 pending human decisions 数量。判断方式：

- `status=passed`：本地 workflow 已跑完。
- `status=paused`：运行被人工暂停或命中 pending human gate。
- `pendingHumanDecisions` 大于 0：需要人工确认后才能继续。
- `artifacts` 大于 0：已有可审阅产物路径写入 artifact store。

## 6. 人工确认 human gate

`bugfix` 模板和高风险动态 workflow 可能触发 human gate。CLI 确认命令：

```bash
node /path/to/donkey/packages/cli/dist/index.js resume --run-id <runId> --approve-human --repo /path/to/project
```

按当前实现边界，`resume --approve-human` 会批准 pending human decisions，并把对应 human gate 记录为 passed。高风险操作、真实 push、真实 PR 创建和上线动作仍不应自动放行；最终合入、发布、权限扩大和生产变更必须由人类控制。

手动暂停和取消：

```bash
node /path/to/donkey/packages/cli/dist/index.js pause --run-id <runId> --repo /path/to/project
node /path/to/donkey/packages/cli/dist/index.js cancel --run-id <runId> --repo /path/to/project
```

## 7. 交付 dry-run delivery dry-run

Phase 3 交付命令按当前实现边界提供 dry-run 路径：

```bash
node /path/to/donkey/packages/cli/dist/index.js delivery dry-run --run-id <runId> --repo /path/to/project
```

预期输出字段包括：

- `runId`：被打包的运行 ID。
- `workflowStatus`：该 run 的 workflow 状态。
- `artifacts`：delivery evidence 包含的 artifact 数量。
- `prDryRun=true`：只生成 PR 命令计划。
- `requiresHumanApproval=true`：真实 push 或 PR 创建需要人工批准。

dry-run 只证明命令规划和审批边界，不证明远端分支已 push，也不证明 PR URL 已生成。真实 PR fixture 或真实 PR 创建必须单独记录认证状态、远端仓库、命令输出和失败恢复行为。

## 8. PR 准备包 delivery prepare

生成本地 PR 准备包：

```bash
node /path/to/donkey/packages/cli/dist/index.js delivery prepare --run-id <runId> --repo /path/to/project
```

预期输出字段包括：

- `branch`：建议使用的本地交付分支名。
- `baseBranch`：来自仓库画像的目标 base branch。
- `packagePath`：本地 PR 准备包路径。
- `prBodyPath`：可复制或交给 `gh pr create` 使用的 PR body。
- `requiresHumanApproval=true`：远端 push 和 PR 创建仍需要人工确认。

`delivery prepare` 会记录 `delivery.pr-prepared` 审计事件，并追加一个 `delivery-package` artifact。它不执行 `git push`，也不创建远端 PR。

## 9. 工作就绪度 eval readiness

检查某次 run 是否已经具备人工审阅和提交的最低证据面：

```bash
node /path/to/donkey/packages/cli/dist/index.js eval readiness --run-id <runId> --repo /path/to/project
```

当前评估项包括 workflow 是否 passed、audit hash 是否有效、验证 gate 是否全部通过、delivery package 是否存在、PR 准备事件是否存在、是否仍有 pending human gate。`ready=true` 代表这次 run 可以进入人工审阅 / PR 提交流程；不代表可以自动 merge 或上线。

## 10. Web dashboard

Web dashboard 属于 Phase 3 产品面。当前实现为本地 Node HTTP + Vite React dashboard，可审阅 project overview、artifacts、gates、audit、roles、workflows、settings 和 human approvals。

启动前必须显式传入项目根；Web 不会静默把当前目录当作 Donkey 项目：

```bash
DONKEY_PROJECT_ROOT=/path/to/project npm exec --yes -- pnpm@10.12.1 --filter @donkey/web dev
```

Web 写操作依赖 `init` 生成的 `.donkey/web-session.json` session token。没有 token 或 token 错误时，approve/reject、pause/resume/cancel/clean 会被拒绝。

Pending human gate 会展示 request context、gate context、exact command 和 risk label；audit 视图会展示 hash chain 校验状态，并支持按 node、gate、role 过滤。

Web 审阅至少需要记录：

- 本地启动命令和 `DONKEY_PROJECT_ROOT` 或等价项目根配置。
- pending human gate 的 approve 或 reject 操作结果，以及 command/gate/request/risk 上下文是否符合预期。
- Artifact、audit hash、audit filter、roles、workflows 页面是否可读。
- 桌面和移动宽度截图或 Playwright e2e 输出。

## 11. 角色 roles

查看内置和项目角色：

```bash
node /path/to/donkey/packages/cli/dist/index.js role list --repo /path/to/project
node /path/to/donkey/packages/cli/dist/index.js role show rd --repo /path/to/project
node /path/to/donkey/packages/cli/dist/index.js role path rd --repo /path/to/project
```

创建项目级角色副本：

```bash
node /path/to/donkey/packages/cli/dist/index.js role create rd --repo /path/to/project
```

角色解析遵循内置角色、项目角色和用户角色的加载规则；项目级 whole-folder override 会覆盖对应角色目录。当前 Engine 会把角色 system prompt、skills、knowledge、tools policy 摘要和项目上下文注入 Agent prompt。修改角色后应通过本地 mock workflow、真实 provider smoke 和审阅记录验证，不应直接假设 prompt 或 tools policy 修改已经安全。

## 12. Workflows

查看模板：

```bash
node /path/to/donkey/packages/cli/dist/index.js workflow list --repo /path/to/project
node /path/to/donkey/packages/cli/dist/index.js workflow show standard-feature --repo /path/to/project
```

从现有模板创建项目 workflow：

```bash
node /path/to/donkey/packages/cli/dist/index.js workflow create release-check --from standard-feature --repo /path/to/project
```

当前内置模板包括 `standard-feature` 和 `bugfix`。`standard-feature` 适合本地 mock happy path 验证；`bugfix` 保留 reviewer human gate，通常需要人工确认后继续。

## 13. Logs 与审计

查看 audit log：

```bash
node /path/to/donkey/packages/cli/dist/index.js log --run-id <runId> --repo /path/to/project
```

日志会输出 audit event 时间、事件类型和 payload。常见事件包括 `run.started`、`human.gate.pending`、`human.gate.approved` 和 gate repair 相关事件。最终报告应引用关键事件，而不是只引用 CLI 终端最后一行。

## 14. Cleanup

清理 worktree 目录：

```bash
node /path/to/donkey/packages/cli/dist/index.js clean --repo /path/to/project
```

当前 `clean` 只重建 `.donkey/worktrees`，不会删除 SQLite、run artifacts 或 audit evidence。需要保留正式验收结论时，应把摘要写入 `docs/reviews/`，不要只依赖 `.donkey/` 运行态文件。

## 15. current limitations（当前限制）

- Phase 2 已验证的是本地 mock CLI 产品环，不是公开发布产品。
- 动态 workflow 当前是 deterministic mock preview，不等于真实 PM LLM 规划。
- `delivery dry-run` 不创建真实 PR，不 push 远端分支；`delivery prepare` 只生成本地 PR 准备包。
- Web dashboard 是本地 dashboard，不是远程服务。
- Coverage 使用 `npm exec --yes -- pnpm@10.12.1 exec vitest --exclude "**/__manual__/**" --run --coverage` 记录；`pnpm test -- --run --coverage` 在当前工具组合下不会输出 coverage 表。
- 真实 LLM workflow、真实 SCM 权限、远端 PR 和生产级恢复能力必须在受控 fixture 或明确人工批准下验证。
- `CommandPolicy.network` 不能被理解为操作系统级网络隔离。
- Donkey 默认增强人类交付，不替代人类完成合入、上线、权限扩大或高危审批。

## 16. 最终验收检查

最终验收至少执行：

```bash
npm exec --yes -- pnpm@10.12.1 install --frozen-lockfile
npm exec --yes -- pnpm@10.12.1 build
npm exec --yes -- pnpm@10.12.1 typecheck
npm exec --yes -- pnpm@10.12.1 exec vitest --exclude "**/__manual__/**" --run --coverage
npm exec --yes -- pnpm@10.12.1 --filter @donkey/cli test:e2e
npm exec --yes -- pnpm@10.12.1 --filter @donkey/web test:e2e
```

并完成一条 fixture flow：

```bash
node /path/to/donkey/packages/cli/dist/index.js init --repo /path/to/fixture
node /path/to/donkey/packages/cli/dist/index.js run --dynamic --dry-run "高风险数据变更" --agent mock --repo /path/to/fixture
node /path/to/donkey/packages/cli/dist/index.js run "给示例模块加批量重试" --template standard-feature --agent mock --repo /path/to/fixture
node /path/to/donkey/packages/cli/dist/index.js delivery dry-run --run-id <runId> --repo /path/to/fixture
node /path/to/donkey/packages/cli/dist/index.js delivery prepare --run-id <runId> --repo /path/to/fixture
node /path/to/donkey/packages/cli/dist/index.js eval readiness --run-id <runId> --repo /path/to/fixture
```

若使用会暂停的模板，还需要记录 `resume --approve-human` 的命令和结果。
