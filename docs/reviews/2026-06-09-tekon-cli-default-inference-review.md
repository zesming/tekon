# 天工（Tekon）CLI 默认上下文推断审阅记录

日期：2026-06-09

审阅范围：

- CLI 常规命令默认上下文推断：当前 repo、最近需求卡、最近 run、最近 pending human decision。
- 需求塑形和批准链路：`demand shape`、`demand approve`、`demand show`、`eval demand-shape`、`run`。
- 审批和交付链路：`approval summary`、`approval reject`、`resume --approve-human`、`review`、`status`、`log`、`delivery prepare`、`delivery create-pr`、`delivery ci-status`、`delivery ci-watch`、`eval readiness`。
- 文档同步：`README.md`、`CHANGELOG.md`、`docs/manual/tekon-user-manual.md`、`docs/manual/tekon-user-manual.html`、`AGENTS.md`。

## 1. Reviewer 结论

本轮使用 subagent 进行两轮审阅。当前 runtime 没有独立“最高思考等级”开关可设置；reviewer 按最高可用审阅强度执行。

第一轮 reviewer 发现 5 个必须修复项：

- 默认短命令被用于显式或历史上下文，可能复制后误操作到最新 run 或最新 decision。
- 显式相对路径解析退化，部分 `--shape` / `--demand-file` 从子目录执行时不再优先按当前目录解析。
- CLI 测试断言与新默认行为不一致。
- 文档把 `run` 描述为自动读取“最近已批准”需求卡，但实现实际读取“最近需求卡并要求它已批准”。
- HTML 手册仍保留旧命令，和 Markdown 手册漂移。

第二轮 reviewer 复查后发现 1 个剩余必须修复项：

- `demand approve`、`demand show`、`eval demand-shape` 的显式 `--shape` 回退路径仍把当前目录误当作 repo root，应改为使用发现到的项目 repo root。

第三轮 reviewer 对当前未提交 diff 做只读复查，发现 4 个必须修复项：

- 裸 `tekon demand approve` 可能在最新需求卡已经批准时回头批准历史未批准需求卡。
- 同一 run 多个 pending human decision 时，`approval summary`、`approval reject` 和 `resume --approve-human` 会静默选择或批量批准，存在歧义操作风险。
- 显式 / 历史 review surface 的后续命令只带 `--run-id`，未带 `--repo`，跨仓库或 Web 复制命令可能落到当前 cwd。
- 测试缺少上述危险边界覆盖。

最终 reviewer 复查确认：上述必须修复项已逐项关闭；新增边界测试覆盖后，未发现新的必须修复项。

## 2. 修复摘要

- CLI 默认发现 repo：显式 `--repo` 优先；否则从当前目录向上查找 `.tekon/config.yaml`；找不到时使用 Git 根目录或当前目录作为初始化类 fallback。
- `demand shape` 默认写入 `.tekon/demands/`，保留 `--no-write` 用于只预览；旧 `--write` 仍兼容。
- `demand approve`、`demand show`、`eval demand-shape` 在不传 shape 时默认读取最近需求卡；批准命令只批准最近需求卡，如果最近需求卡已批准，历史未批准需求卡必须显式传 `--shape <path>`。
- `run` 在不传需求文本和 `--demand-file` 时读取最近需求卡，并要求该需求卡已经批准；不会静默跳过最新未批准需求卡去运行旧需求。
- `status`、`review`、`log`、`pause`、`cancel`、`delivery prepare`、`delivery dry-run`、`delivery create-pr`、`delivery ci-status`、`delivery ci-watch`、`eval readiness`、`eval work-usability record` 默认使用最近 run。
- `approval summary`、`approval reject`、`eval approval-summary`、`resume --approve-human` 默认使用最近 pending human decision；同一 run 有多个 pending human decision 时拒绝歧义，要求显式传 `--decision-id`。
- `resume --approve-human` 支持 `--decision-id`，显式指定时只批准这一条 decision，不再批量批准同一 run 的所有 pending decision。
- 默认上下文输出短命令，例如 `tekon review`、`tekon approval summary`、`tekon resume --approve-human`、`tekon approval reject`；显式或历史上下文仍输出带 `--run-id` / `--decision-id` / `--repo` 的精确命令。
- Web 审阅和审批摘要始终基于当前选中 run/decision，因此继续输出精确命令，避免 Web 多 run 场景误导用户。
- 显式路径解析恢复 cwd 优先、repo root fallback，兼容从子目录传入历史需求卡。
- README、CHANGELOG、主用户手册 Markdown 和 HTML 同步更新为精简命令；AGENTS 的主手册 HTML 检查路径同步为 `docs/manual/tekon-user-manual.html`。

## 3. 用户侧命令变化

常规需求流从：

```bash
node packages/cli/dist/index.js demand shape \
  "给 Web dashboard 增加审批摘要展示，要求 e2e 通过" \
  --write --repo /path/to/project
node packages/cli/dist/index.js demand approve \
  /path/to/project/.tekon/demands/<shapeId>.json
node packages/cli/dist/index.js run --demand-file /path/to/project/.tekon/demands/<shapeId>.json --repo /path/to/project
node packages/cli/dist/index.js review --run-id <runId>
```

简化为：

```bash
cd /path/to/project
tekon demand shape "给 Web dashboard 增加审批摘要展示，要求 e2e 通过"
tekon demand approve
tekon run
tekon review
```

仍保留显式参数，但只面向特殊场景：

- 跨仓库或从其它目录操作：`--repo <path>`。
- 复现历史需求卡：`--shape <path>`、`--demand-file <path>`。
- 查看历史 run 或消除歧义：`--run-id <runId>`。
- 指定多个 pending decision 中的某一个：`--decision-id <decisionId>`。
- 明确人工确认高风险动作：`--approve-human`、`--allow-dirty-base`。

## 4. 验证摘要

已通过的本地验证：

| 验证项        | 命令                                           | 结果                        |
| ------------- | ---------------------------------------------- | --------------------------- |
| 类型检查      | `npm exec --yes -- pnpm@10.12.1 typecheck`     | 退出 0                      |
| 构建          | `npm exec --yes -- pnpm@10.12.1 build`         | 退出 0                      |
| 全仓测试      | `npm exec --yes -- pnpm@10.12.1 test -- --run` | 57 files / 212 tests passed |
| 格式检查      | `npm exec --yes -- pnpm@10.12.1 format:check`  | 退出 0                      |
| Action lint   | `npm run lint:actions`                         | 退出 0                      |
| diff 空白检查 | `git diff --check`                             | 退出 0                      |
| 占位符扫描    | 主文档和本轮核心源码扫描                       | 无命中                      |

新增或调整的关键测试覆盖：

- 从目标 repo 子目录执行时，自动发现当前 repo、最近需求卡、最近 run 和最近 pending decision。
- `demand shape` 默认写入，`demand approve` 默认批准最近需求卡，`run` 默认读取最近需求卡并要求它已批准。
- 最新需求卡已批准、历史需求卡未批准时，裸 `demand approve` 不会回批历史需求卡。
- 同一 run 多个 pending human decision 时，短审批命令会拒绝歧义；显式 `--decision-id` 可以查看指定 decision，`resume --approve-human --decision-id <id>` 只批准指定 decision。
- 显式 `--repo` 跨仓库上下文会输出带 `--run-id` 和 `--repo` 的后续命令，避免复制后落到当前 cwd。
- `status`、`review`、`delivery`、`eval`、`approval`、`resume` 常规短命令可在默认上下文工作。
- 显式 `--shape` 路径 cwd 优先，找不到时回退到 repo root。
- 从子目录传入 cwd-relative `--demand-file` 保持兼容。
- approval summary 和 review surface 在默认上下文输出短命令，在显式上下文输出带 `--repo` 的精确命令。

## 5. 后续关注

- 如果后续引入多项目 workspace 或多个同时 pending decision，需要在默认推断失败时输出更强的歧义提示，而不是猜测。
- `pause` 和 `cancel` 已具备最近 run 推断，但用户手册不主推短命令；后续如开放给普通用户高频使用，应补充更明确的风险提示。
- 每次 CLI/Web 行为、参数、错误提示或默认推断规则变化后，都必须重新评估是否更新 `docs/manual/tekon-user-manual.md` 和 `docs/manual/tekon-user-manual.html`。
