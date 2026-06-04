# Changelog

所有重要变更都记录在这里。描述性文字以中文为主；版本号遵循当前 MVP 节奏，不代表正式对外发布版本。

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
- `npm test` 通过，21/21 pass。
- Validation smoke 通过，生成测试验收证据包。
- Risk Gate smoke 通过，`.env` 高危路径降级为 `risk_report` 且 `toolRuns=[]`。
- Eval smoke 通过，5/5 pass，高危误放行 0。
- Reviewer 最终复审 PASS，Must Fix / Should Fix 均无。
