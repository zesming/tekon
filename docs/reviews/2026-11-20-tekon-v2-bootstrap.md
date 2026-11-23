# Tekon v0.41.0 多 Agent 工作台自举验证与回归归档

验证日期：2026-11-20 · 分支：`feat/tekon-v2-workbench` · 适用版本：`v0.41.0`

## 1. 验收结论与适用范围

本次对 **Tekon v0.41.0 多 Agent 工作台** 完成了端到端自动化验证（Core 单元与多 Provider 运行时集成、Web 42 个会话鉴权 RPC、Chromium Playwright 全功能与 9 组合响应式零溢出验证）及**真实本机 Claude Code CLI 自举验证**。

- **真实 Provider 自举结论**：真实拉起本机 `claude-code` `2.1.327 (Claude Code)`（OAuth token），完成 `self-bootstrap-audit` 双节点工作流中节点 1（`explore-v2`）的完整执行、9,833 字节固化报告与 1,577 字节交接摘要落盘、权限白名单拦截 4 条未授权 Bash 命令、stdout 敏感凭据脱敏、人工确认点（`confirm_checkpoint`）暂停，并在人工审批后成功推进启动节点 2（`review-v2`，上下文隔离模式）。
- **自举过程捕获并修复的真实缺陷**：首次真实自举直接暴露了 `workbench-runtime.ts` 向 `CommandGateway` 传入空 `commandPolicy.allow` 的问题（stub 测试未走真实 `CommandGateway` 校验）；现已收口复用 `defaultCommandPolicy(repoPath)` 并补齐回归测试。
- **诚实披露未覆盖边界**：
  1. 节点 2（`review-v2`）因本机外部模型网关 `ark/seed-evolving[1M]` 单轮响应约 4–5 分钟，在自举脚本 300 秒等待上限处超时中断，未等待节点 2 自然结束；
  2. 本机 `codex` CLI 未安装（`agent.list` 实测返回 `not_installed`），本次真实自举仅实测 `claude-code`，`codex` 路径通过真实 `buildCodexCommand` 4 段目录契约测试与多 Provider stub 覆盖，未做实机 Codex 端到端调用；
  3. 真实自举在隔离临时工作区执行 `workspace: none` 只读梳理，未涉及远端 Git push / PR 创建（此类动作按设计始终保留人工控制）。

## 2. 真实 Provider 自举证据摘要

| 维度 | 实测记录 |
| --- | --- |
| 运行 ID | `run_2195c05b-218` |
| 工作流模板 | `self-bootstrap-audit`（v2 线性双节点：`explore-v2` `confirmAfter: true` → `review-v2` `contextMode: isolated`） |
| 本机探测结果 | `claude-code`: `ready` (`2.1.327 (Claude Code)`, `oauth-token`, 4 models)；`codex`: `not_installed` |
| 节点 1（`explore-v2`）执行结果 | `status = passed`，耗时 `248,135 ms`，真实 `session_id = 62e3c27a-7c13-42a3-b6c2-94ac42b621f7` |
| 真实 Token 与缓存遥测 | `input_tokens = 27,532`，`cache_read_input_tokens = 251,352`，`output_tokens = 10,371` |
| 产出固化文档与交接 | `bootstrap-report.md`（9,833 B）+ `handoff.json`（1,577 B），均由通用输出协议安全校验并入库 |
| 权限与安全拦截实测 | `--allowedTools` / `--disallowedTools` 拒绝 4 条未授权 Bash 探测命令（`permission_denials: 4`）；日志脱敏替换敏感模式为 `[REDACTED_SECRET]` |
| 人工确认与下游推进 | 节点 1 完成后准确停在 `status = paused, pause_reason = confirm_checkpoint`；调用 `approveCheckpoint` 后成功拉起节点 2（`run_2195c05b-218_review-v2-g1`） |

## 3. 自动化与浏览器 E2E 验证摘要

| 套件 | 范围 | 结果 |
| --- | --- | --- |
| 全仓构建与类型检查 | `pnpm build && pnpm typecheck`（`@tekon/core`, `@tekon/cli`, `@tekon/web`） | 通过（0 错误） |
| 全仓 Vitest（Core / CLI / Web） | 281 测试文件，含 Schema v8 迁移、本机探测 5s 超时上限、软链拦截、Codex 4 段路径契约、42 个 RPC 全量 401 鉴权遍历、CLI 真实进程 E2E | 全部通过 |
| Web Playwright E2E（Chromium） | 9 用例：生产 `#token=` 引导与零 CSP/Console 报错、刷新保持、零 URL/Referer 泄露、旧路由重定向、4 节点深度研究+返工 v2 Diff+置顶+压缩与归档挂载+顶部/右侧进度轨切换+追问、动态编排失败回退+编辑+另存模板、单节点换模型重试+暂停/约束/恢复/二次确认终止、设置级联选择器+草稿保护+深色持久化+9 组合零横向溢出+窄屏抽屉互斥 | 9/9 通过（0 retry） |
| 独立代码审查 | Core 组（7 项 Must Fix 清零）+ Web & UI 组（5 项 Must Fix 清零） | Must Fix: 0 |
