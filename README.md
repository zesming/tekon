# Donkey

Donkey 是面向技术基建团队的 AI 自动交付系统。当前仓库已经包含产品方案、MVP 技术方案，以及一个 Phase 0/1 的本地可运行 MVP。

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

## 快速开始

安装依赖并构建：

```bash
npm install
npm run build
```

运行测试：

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

## 文档

- 产品方案：`docs/product/donkey-product-plan.md`
- 产品方案 HTML：`docs/product/donkey-product-plan.html`
- 技术调研：`docs/research/mvp-technical-research.md`
- 技术调研 HTML：`docs/research/mvp-technical-research.html`
- MVP 技术方案：`docs/technical/mvp-technical-plan.md`
- MVP 技术方案 HTML：`docs/technical/mvp-technical-plan.html`
- 实施计划：`docs/superpowers/plans/2026-06-04-donkey-mvp-implementation.md`
- 验收与审阅记录：`docs/reviews/`

## 飞书文档

产品方案飞书文档：

https://bytedance.larkoffice.com/docx/ANrCdZCv4oH81sx756HcAUKCnkc
