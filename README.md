# Donkey

Donkey 是面向技术基建团队的 AI 自动交付系统。当前仓库已经包含产品方案、MVP 技术方案，以及一个 Phase 0/1 的本地可运行 MVP。

一句话定位：把“需求理解、目标阶段判断、测试验收、风险降级和证据归档”串成一个可运行的本地交付闭环，让技术基建团队先从可验证的自动化开始迭代。

## 当前 MVP

当前实现聚焦本地闭环，不做完整 Server、Console、PostgreSQL、CI Runner、Container Runner 或生产自动上线。

已实现能力：

- TypeScript CLI：`donkey init/run/status/show/eval`
- 文件态状态存储：`.donkey/runs/<runId>/state.json`
- Intent / Target Stage Gate：识别想法、需求、技术方案、PR/变更、高危需求
- Workflow 裁剪：按目标阶段跳过不必要前置阶段
- Agent Registry：内置角色 Agent Profile 与版本化 ID
- Tool Gateway：统一执行测试命令，带 allow/deny 风险拦截、日志和脱敏
- Local Runner：执行本地测试命令并归档 ToolRun
- Evidence：生成 Markdown 证据和 HTML 人审报告
- donkey-eval：内置历史样本 replay，输出 JSON 与 HTML 评测报告

当前边界：

- 不自动合入、上线或执行高危生产动作。
- 不包含正式 Server、Console、CI Runner、Container Runner 或真实外部 Coding Agent 调用。
- Intent/Gate 是规则化 MVP，需要继续用真实 B/D 类需求样本扩充评测集。

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
| 从输入目标创建一次运行 | `npm run donkey -- run --repo . --input "<需求或方案>" --json` |
| 使用指定测试命令验收 | `npm run donkey -- run --repo . --input "已有技术方案，请直接执行测试验收" --test-command "npm test" --json` |
| 查看运行状态 | `npm run donkey -- status <runId> --repo . --json` |
| 查看 HTML 证据包路径 | `npm run donkey -- show <runId> --repo .` |
| 运行内置评测集 | `npm run donkey -- eval --repo . --json` |

运行产物默认写入 `.donkey/`，该目录已被 `.gitignore` 忽略。需要长期归档的结论应写入 `docs/reviews/`。

## 验收状态

当前 MVP 已通过本地验收：

- `npm run build` 通过
- `npm test` 通过，21/21 pass
- Validation smoke：技术方案直接进入测试验收，生成 HTML 证据包
- Risk Gate smoke：`.env` 高危路径降级到 `risk_report`，未执行工具命令
- Eval smoke：5/5 pass，高危误放行 0
- Reviewer 复审：PASS，Must Fix / Should Fix 均无

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
