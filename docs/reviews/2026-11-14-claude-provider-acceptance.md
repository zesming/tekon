# 重构第 1 阶段人工验收：真实 Claude 合同（T-17、T-19）

2026-11-14 · v0.30.0 · [PR #37](https://github.com/zesming/tekon/pull/37) · 分支 `audit/2026-11-05`

本记录归档重构第 1 阶段两项不进 CI、依赖真实账号的人工验收：合同 3 的 opt-in 真实 Claude smoke（T-17）与合入前从 Web 用真实 Claude 跑通写节点（T-19）。验收在维护者本机执行，Claude Code CLI 2.1.323，认证方式 oauth_token（`claude auth status` 已登录）；Node 与 pnpm 沿用仓库锁定版本。所有临时仓库在验收后清理，证据中的 Run ID 可在对应临时库的审计流复核。

## 1. T-17：合同 3 真实 Claude smoke

### 1.1 验收方式

- 入口：`TEKON_CLAUDE_PROVIDER_SMOKE=1 pnpm --filter @tekon/core smoke:claude-provider`，对应 `packages/core/__manual__/claude-code-provider.smoke.test.ts`。未设置环境变量时 `describe.skip`，默认 `pnpm test --run` 不执行、不产生供应商费用。
- 本阶段 smoke 已从“直连适配器”改为经产品入口 `tekon run --goal --agent claude-code` 子进程跑单节点工作流，覆盖受理、引擎、provider 适配、产物落库的完整链路。

### 1.2 真实运行结果

| 项 | 结果 | 证据 |
| --- | --- | --- |
| `tekon run --goal` 全链路 | 通过，工作流 `status=passed` | Run ID `run_0a3347a2-dae4-4880-8dc7-9cf1e727fd09`，输出“✅ 运行已完成”，`tekon status` 复核 `status=passed` |
| doctor 识别 API key 认证 | 通过，输出“认证方式: API key（默认）” | 隔离 HOME（剥离宿主 oauth 登录与 `ANTHROPIC_AUTH_TOKEN`，仅注入假 `ANTHROPIC_API_KEY=sk-ant-tekon-smoke-fake-key`）下手动复现两次一致；`claude auth status --json` 在该环境返回 `authMethod: api_key`、`apiKeySource: ANTHROPIC_API_KEY` |
| 默认入口不运行 | 通过 | 无环境变量时 vitest 报告 1 skipped |

### 1.3 观察到的真实供应商不确定性（非产品缺陷）

验收过程中一体化 smoke 出现两类失败，均定位为真实环境/模型行为，产品侧表现为正确的 fail-closed：

1. **模型输出位置漂移（2 次）**：真实 Claude 在部分运行中自行把 `goal-execution-report.md` 写入 worktree 源目录而非 `TEKON_OUTPUT_DIR`，被 worktree 租约的源文件保护拦截（`worktree.lease.finalize.failed`：`node ... is not allowed to modify repository source files`），Run 转 interrupted。该文件名不出现在 Tekon 代码中，是模型自取名称；prompt 已明确要求“do not modify the repository working tree; write only node artifacts under TEKON_OUTPUT_DIR”，护栏行为符合设计。
2. **claude 冷启动竞态（1 次）**：全新隔离 HOME 下首次 `auth status` 探测结果不稳定。smoke 脚本已为 doctor 探测增加一次同环境重试，仅作用于 manual smoke，不改产品代码。

结论：合同 3 的产品链路已由一次完整 passed 的真实运行证明；opt-in smoke 对真实模型遵从性天然敏感，不作为 CI 门禁，人工执行者需结合日志区分模型漂移与产品回归。这一特性与 refactor-plan“真实层依赖账号和费用，不放默认入口”的定位一致。

## 2. T-19：Web 入口真实 Claude 写节点

### 2.1 验收方式

- 后台启动 `tekon ui --port 47913`（`TEKON_HOME` 指向工作树），经真实 HTTP `/api/rpc` 调用，带 `x-session-token` 头，不走进程内 ApiCaller。
- 临时 git 仓库内置项目级模板 `web-write`：单 RD 节点产出 `code-changes`，配 build/lint（npm 脚本）与 schema 门，无人工门禁，保证一次真实调用即可验证写链路。
- 先 `workflow.plan` 取 digest，再 `project.run`（mode=workflow，agent=claude-code，带 planDigest）发起。

### 2.2 结果

| 项 | 结果 | 证据 |
| --- | --- | --- |
| Web 受理与执行 | Run 从 running 到 **passed** | Run ID `run_67faf655-06c3-4f1d-86b3-20cb4eeb623a`，约 70 秒 |
| 写节点产物 | `code-changes` artifact 落库 | artifacts 表 1 行，节点 `rd-write` |
| 门禁 | build、lint、schema 全部 passed | gate_results 三行均 passed |
| 真实文件改动 | 交付分支含模型新增文件 | 分支 `tekon-delivery/run_67faf655-…` 相对 main 的 diff：`docs/t19-web-write.md | 1 +`，内容为需求指定的 “T19 web write acceptance” |
| 源文件保护 | 首轮错误配置（命令门用未在网关白名单的 node）被正确拒绝 | 首轮 Run `run_b5a2c1e5-…` 的 build 门 `failure_classification=rejected`，修正为白名单内 npm 后通过，反向印证网关策略生效 |

验收首次尝试还实测出命令网关的默认 allow-list 不含裸 `node`（仅 git/pnpm/npm/claude/codex/dsh），与既有 `default-agent-contract` e2e 的结论一致；真实写节点的权限参数（`acceptEdits`、`--disallowedTools`）由 `provider-argv-contract` 与 `provider-write-permission` e2e 在 fake 层锁定，本记录不重复。

## 3. 风险 Gate 与限制

- 两项验收均使用维护者本人的真实 Claude 订阅，产生少量真实调用费用；假 key 仅用于 doctor 分类验证，形态为明显测试桩，未写入任何入库证据或日志值。
- 真实供应商的行为漂移（输出位置、冷启动）无法被 fake 合同捕获，这正是保留 opt-in 人工 smoke 的理由；Codex 真实层按重构计划另排第 3 阶段，本 PR 只覆盖 fake 合同。
- 验收未覆盖网络受限环境与 DSH；DSH 继续沿用既有 opt-in 直播合同。
- 临时仓库与 ui 进程验收后已清理/停止；本文件不含令牌、密钥或机器绝对路径之外的敏感信息。

## 4. 验收结论

T-17（合同 3）与 T-19 的人工验收通过：真实 Claude 经 CLI 产品入口与 Web HTTP 入口均能跑通完整工作流，写节点的文件改动经交付分支落库，失败路径被既有护栏正确拦截。结合自动化证据（根 `pnpm test --run` 2557 passed、3 expected fail、1 skipped；Playwright 213 passed），重构第 1 阶段的测试验收线闭合。
