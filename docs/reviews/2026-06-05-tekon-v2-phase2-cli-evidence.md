# Tekon V2 Phase 2 CLI Evidence

日期：2026-06-05
分支：`rebuild-v2`
提交范围：Phase 2 role/workflow/constraint/engine/dynamic/CLI 本地 mock 产品环

## 1. 结论

Phase 2 本地验收通过。`standard-feature` mock 模板可完成到 `passed` 并生成本地 artifacts；`dynamic --dry-run` 可展示 constraint mutation preview；`pause/resume/cancel/status/log/clean` 可针对 SQLite 持久化状态工作。

本阶段仍不包含 Web dashboard、真实 PR 创建、自动 merge 或生产级真实 LLM workflow。

## 2. TDD 证据

本阶段按红绿流程推进，关键 RED 证据包括：

- 角色系统测试首次运行失败于缺失 `src/role/loader.js`、`tool-policy.js`、`prompt-builder.js`。
- workflow 模板和状态机测试首次运行失败于缺失 `loadWorkflowTemplate`、状态机别名 API 和 schema 覆盖缺口。
- workflow engine e2e 首次运行失败于缺失 `createWorkflowEngine`。
- CLI e2e 首次运行失败于 `not implemented: init`。
- Phase 2 exit gate 补充测试首次失败于 `standard-feature` 被 human gate 暂停、CLI 不支持 `--dynamic --dry-run`、多 run 复用 phase/node ID 导致 SQLite unique constraint。

对应 GREEN 证据见本报告第 4 节。

## 3. 覆盖能力

- Role File System：项目/用户/内置角色解析优先级、whole-folder override、skills 按 ID 合并、YAML frontmatter、knowledge、tools policy 和 prompt builder。
- Workflow Templates：`standard-feature`、`bugfix`，模板 parser、artifact refs、gates、retry policy、非法模板拒绝和状态机。
- Constraints：hard constraints、conditional mutation、soft suggestions、`constraints.yaml`。
- Engine：SQLite run creation before execution、phase/node persistence、artifact dependency、gate repair、recovery、audit hash verification。
- Dynamic Workflow：PM JSON draft validation、malformed JSON rejection、constraint preview、high-risk human gate injection、save-as path traversal rejection。
- CLI：`init/run/status/pause/resume/cancel/role/workflow/constraints/log/clean`。

## 4. 验证命令

以下命令已在本地通过：

```bash
npm exec --yes -- pnpm@10.12.1 install --frozen-lockfile
npm exec --yes -- pnpm@10.12.1 build
npm exec --yes -- pnpm@10.12.1 typecheck
npm exec --yes -- pnpm@10.12.1 test -- --run
npm exec --yes -- pnpm@10.12.1 --filter @tekon/core test:unit
npm exec --yes -- pnpm@10.12.1 --filter @tekon/core test:e2e
npm exec --yes -- pnpm@10.12.1 --filter @tekon/cli test:e2e
npm exec --yes -- prettier --check .
```

验证摘要：

- 根测试：36 个 test files，118 个 tests，通过。
- Core unit：29 个 test files，110 个 tests，通过。
- Core e2e：6 个 test files，7 个 tests，通过。
- CLI e2e：1 个 test file，1 个端到端 flow，通过。
- Build/typecheck/prettier：通过。

## 5. 已知限制

- `bugfix` 模板保留 reviewer human gate，默认会暂停；需要 `resume --approve-human` 后继续。
- `dynamic --dry-run` 当前 CLI 使用 deterministic mock PM draft，不调用真实 LLM。
- `clean` 当前只重建 `.tekon/worktrees`，保留 run artifacts 和 audit evidence。
- 真实 push、PR 创建、Web human approval UI、dogfooding metrics 属于 Phase 3。
