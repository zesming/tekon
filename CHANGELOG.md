# Changelog

所有重要变更都记录在这里。描述性文字以中文为主；版本号遵循当前 MVP 节奏，不代表正式对外发布版本。

## Unreleased

### Changed

- 重写 MVP 用户手册，改为面向工具使用者说明当前能做什么、不能做什么、如何发起输入和如何阅读证据包。
- README 增加当前能力状态表，并同步本地代码修改、TUI、短命令和 Adapter 使用方式。
- 新增短命令和 TUI 入口：`npm run d -- "<需求>"` 与 `npm start`。
- 新增可配置 Coding Agent Adapter：支持通过 `commands.develop` 调用 Codex、Claude 或自定义命令进行本地代码修改，再自动运行测试验收。
- 新增内置 `adapter codex|claude` 包装器，把 Donkey 生成的 prompt 文件转成外部 Coding Agent 的非交互 prompt。
- 开发链路新增自动 Git 分支和本地 commit：开发前检查工作区干净状态并创建 `donkey/<runId>` 分支，测试后提交本地 commit；仍不 push、不创建 PR。
- 修复开发链路 commit gate：缺少真实测试命令或测试未通过时不创建 commit；已 staged 的 `.donkey` 产物会阻断，包含带空格路径；Adapter 内部常规 commit/push 会被临时 Git wrapper 和 hook 拦截，Runner-owned git 写操作使用 Donkey 控制的 hooksPath，绕过 commit hook 导致 HEAD/分支变化时会被不变量阻断；HTML 证据包基于实际测试报告识别自定义测试命令。
- Repo Profile 加载时会合并新的默认安全规则，避免旧配置缺少 Adapter allowlist。
- 调整技术方案类输入的目标阶段判断：明确“按方案执行”进入开发链路，“直接执行测试验收”才只进入验收链路。
- 修复开发目标的 Workflow 展示，代码修改和测试验收会在 HTML 证据包中显示为已执行。
- Repo Profile 加载兼容缺少 `risk` 子字段的旧配置，并补测试覆盖默认安全策略合并。
- HTML 证据包区分计划阶段与实际执行结果；缺少开发命令时会标记开发阻断、测试未执行。
- 默认安全 allowlist 收窄到 Donkey adapter 包装器，不再默认直连任意 `codex exec` / `claude -p`。

## [0.1.0] - 2026-06-04

### Added

- 新增 TypeScript / Node.js MVP 工程骨架。
- 新增 CLI：`init`、`run`、`status`、`show`、`report`、`eval`。
- 新增文件态运行状态：`.donkey/runs/<runId>/state.json`。
- 新增 Intent / Target Stage Gate，支持想法、需求、技术方案、任务、代码变更、PR 和风险报告目标阶段。
- 新增可裁剪 Workflow，支持已有技术方案直接进入测试验收，并避免夸大未执行的开发阶段。
- 新增 Agent Registry，内置 Intent、PM、Tech、RD、Test、Review、Evidence 角色画像。
- 新增 Repo Profile 加载能力，`init` 后的 `.donkey/repo-profile.json` 可被 `run` 和 `eval` 使用。
- 新增 Tool Gateway，默认拒绝未 allowlist 命令，拦截 shell 控制符和重定向，并以 `shell: false` 执行 argv。
- 新增敏感信息脱敏，覆盖输入、命令、stdout/stderr 日志、state 和 HTML 报告中的常见 token、secret、password、API key 形式。
- 新增 Evidence 证据包和 HTML 人审报告。
- 新增 donkey-eval 内置样本 replay，输出 JSON 与 HTML 评测报告。
- 新增 MVP 验收报告：`docs/reviews/2026-06-04-mvp-acceptance-report.html`。
- 新增 MVP 使用手册：`docs/manual/donkey-mvp-user-manual.html`。

### Changed

- README 从规划仓库说明更新为 MVP 使用入口，补充快速开始、常用命令、验收状态和文档索引。
- `.gitignore` 增加 `.donkey/`，避免提交本地运行证据和日志。
- 仓库指令增加提交前文档同步检查要求。

### Fixed

- 修复 Tool Gateway 早期默认放行 shell 字符串执行的风险。
- 修复高危路径未参与风险 Gate 的问题，`.env` 等路径会降级到 `risk_report`。
- 修复 HTML 证据包中 Workflow 阶段展示与真实执行不一致的问题。
- 修复 Eval 指标命名不准确的问题，拆分通过率、输入类型准确率和目标阶段准确率。
- 修复带空格的 quoted secret 脱敏不完整的问题。
- 修复 HTML 报告证据表未包含自身 `html_report` evidence 的一致性问题。

### Verified

- `npm run build` 通过。
- `npm test` 通过，44/44 pass。
- Validation smoke 通过，生成测试验收证据包。
- Risk Gate smoke 通过，`.env` 高危路径降级为 `risk_report` 且 `toolRuns=[]`。
- Eval smoke 通过，6/6 pass，高危误放行 0。
