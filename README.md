# Donkey

Donkey 是面向技术基建团队的 AI 自动交付系统。当前仓库已经包含产品方案、MVP 技术方案，以及一个本地可试用版本。

一句话定位：把“需求理解、目标阶段判断、代码执行、测试验收、风险降级和证据归档”串成一个可运行的本地交付闭环，让技术基建团队先从可验证的自动化开始迭代。

## 当前 MVP

当前实现聚焦本地闭环，不做完整 Server、Web Console、PostgreSQL、CI Runner、Container Runner 或生产自动上线。

已实现能力：

- TypeScript CLI：`donkey init/run/ask/tui/status/show/eval/adapter`
- 文件态状态存储：`.donkey/runs/<runId>/state.json`
- Intent / Target Stage Gate：识别想法、需求、技术方案、PR/变更、高危需求
- Workflow 裁剪：按目标阶段跳过不必要前置阶段
- Agent Registry：内置角色 Agent Profile 与版本化 ID
- Tool Gateway：统一执行测试命令，带 allow/deny 风险拦截、日志和脱敏
- Local Runner：执行本地开发命令和测试命令并归档 ToolRun
- Coding Agent Adapter：可配置 Codex / Claude / 自定义命令写代码，Donkey Runner 负责创建本地分支、测试验收后创建本地 commit
- TUI：`npm start` 进入交互式菜单
- Evidence：生成 Markdown 证据和 HTML 人审报告
- donkey-eval：内置历史样本 replay，输出 JSON 与 HTML 评测报告

当前边界：

- 不自动合入、上线或执行高危生产动作。
- 不包含正式 Server、Web Console、CI Runner、Container Runner 或自动 PR。
- 当前可以通过配置的本地 Coding Agent Adapter 进入代码修改；Donkey 会自动创建本地 `donkey/<runId>` 分支和 commit，但不 push、不创建 PR。
- Intent/Gate 是规则化 MVP，需要继续用真实 B/D 类需求样本扩充评测集。

## 当前能力状态

| 能力 | 状态 | 说明 |
| --- | --- | --- |
| 一句话识别输入类型和目标阶段 | 已实现 MVP | 能判断想法、需求、技术方案、代码变更、PR 和高危请求。 |
| 生成需求文档草案 | 已实现基础版 | 适合把模糊想法整理成初始需求和信息缺口。 |
| 生成技术方案草案 | 已实现基础版 | 适合把需求推进到最小技术方案草案。 |
| 本地测试验收 | 已实现 MVP | 能运行配置的测试命令并生成 HTML 证据包。 |
| 高危请求降级 | 已实现 MVP | 命中生产、secret、token、删除、`.env`、deploy、infra 等风险时停止执行。 |
| 自动开发代码 | 已实现 Adapter 版 | 通过 `commands.develop` 调用本地 Codex / Claude / 自定义命令修改工作区。 |
| 自动调用 Coding Agent | 已实现可配置版 | 内置 `adapter codex/claude` 包装器，会把 Donkey prompt 交给外部 CLI。 |
| 自动创建本地分支和 commit | 已实现 MVP | 开发前创建 `donkey/<runId>` 分支，测试后提交本地 commit。 |
| 自动创建 PR | 未完成 | 当前不会 push 分支或创建 PR。 |
| TUI | 已实现基础版 | `npm start` 可发起运行、查看最近运行、配置命令和跑 eval。 |
| 飞书入口 / Web Console | 未完成 | 当前主要通过 CLI/TUI 使用。 |

## 快速开始

安装依赖并构建：

```bash
npm install
npm run build
```

运行全部测试：

```bash
npm test
```

最短方式进入 TUI：

```bash
npm start
```

一句话运行：

```bash
npm run d -- "请开发一个本地搜索功能并补充测试"
```

如果你已经有技术方案，并希望直接进入开发链路：

```bash
npm run d -- "已有技术方案，请按方案执行"
```

初始化本地 Donkey 配置：

```bash
npm run donkey -- init --repo . --json
```

运行一次已有技术方案的本地测试验收：

```bash
npm run donkey -- run \
  --repo . \
  --input "已有技术方案，请直接执行测试验收" \
  --test-command "npm test" \
  --json
```

配置开发命令：

```bash
npm start
# 选择「3. 配置测试和开发命令」
```

也可以手动编辑 `.donkey/repo-profile.json`：

```json
{
  "commands": {
    "develop": "node /path/to/donkey/dist/src/cli.js adapter codex {prompt}",
    "test": "npm test"
  }
}
```

查看运行状态：

```bash
npm run donkey -- status <runId> --repo . --json
```

查看 HTML 证据包路径：

```bash
npm run donkey -- show <runId> --repo .
```

运行内置评测集：

```bash
npm run donkey -- eval --repo . --json
```

## 常用命令

| 场景 | 命令 |
| --- | --- |
| 初始化 Repo Profile 和 Agent Profiles | `npm run donkey -- init --repo . --json` |
| 打开 TUI | `npm start` |
| 一句话运行 | `npm run d -- "<需求或方案>"`，也可用 `npm run donkey -- go "<需求或方案>"` |
| 从输入目标创建一次运行 | `npm run donkey -- run --repo . --input "<需求或方案>" --json` |
| 使用指定测试命令验收 | `npm run donkey -- run --repo . --input "已有技术方案，请直接执行测试验收" --test-command "npm test" --json` |
| 查看运行状态 | `npm run donkey -- status <runId> --repo . --json` |
| 查看 HTML 证据包路径 | `npm run donkey -- show <runId> --repo .` |
| 运行内置评测集 | `npm run donkey -- eval --repo . --json` |

运行产物默认写入 `.donkey/`，该目录已被 `.gitignore` 忽略。需要长期归档的结论应写入 `docs/reviews/`。

## 验收状态

当前 MVP 已通过本地验收：

- `npm run build` 通过
- `npm test` 通过，44/44 pass
- Development Adapter smoke：配置开发命令后能实际改工作区文件，再运行测试并生成代码变更报告
- Git branch/commit smoke：开发链路会创建 `donkey/<runId>` 分支并生成本地 commit；脏工作区、已 staged 的 `.donkey` 产物会阻断；Adapter 内部常规 git commit/push 有执行期 guardrail
- Validation smoke：技术方案直接进入测试验收，生成 HTML 证据包
- Risk Gate smoke：`.env` 高危路径降级到 `risk_report`，未执行工具命令
- Eval smoke：6/6 pass，高危误放行 0

验收报告见：`docs/reviews/2026-06-04-mvp-acceptance-report.html`

## 文档

- 产品方案：`docs/product/donkey-product-plan.md`
- 产品方案 HTML：`docs/product/donkey-product-plan.html`
- 技术调研：`docs/research/mvp-technical-research.md`
- 技术调研 HTML：`docs/research/mvp-technical-research.html`
- MVP 技术方案：`docs/technical/mvp-technical-plan.md`
- MVP 技术方案 HTML：`docs/technical/mvp-technical-plan.html`
- 使用手册：`docs/manual/donkey-mvp-user-manual.html`
- 实施计划：`docs/superpowers/plans/2026-06-04-donkey-mvp-implementation.md`
- 验收与审阅记录：`docs/reviews/`
- 更新记录：`CHANGELOG.md`

## 文档维护

提交代码或行为变更前，必须检查是否需要同步更新：

- `README.md`
- `CHANGELOG.md`
- `docs/manual/donkey-mvp-user-manual.html`
- 相关产品、技术、验收或审阅 HTML 文档
- `AGENTS.md` 中的仓库级协作指令

## 飞书文档

产品方案飞书文档：

https://bytedance.larkoffice.com/docx/ANrCdZCv4oH81sx756HcAUKCnkc
