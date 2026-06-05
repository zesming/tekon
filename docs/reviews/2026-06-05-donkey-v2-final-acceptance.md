# Donkey V2 Final Acceptance

日期：2026-06-05
范围：Phase 3 Task 21，release packaging 与最终验收
结论：本地 V2 Phase 3 验收通过；发布范围限定为本地 CLI/Web/dashboard、SCM dry-run、metrics 和 evidence package。真实 PR 创建、自动 merge、生产级真实 LLM workflow 不在本次通过范围内。

## 1. Acceptance Flow

已验证的 fixture flow：

`init -> run --dynamic --dry-run -> run --template standard-feature --agent mock -> bugfix human gate -> resume --approve-human -> delivery dry-run -> dashboard review`

对应证据：

| 项                        | 结果                                                        |
| ------------------------- | ----------------------------------------------------------- |
| CLI release e2e           | `packages/cli/__tests__/e2e/release-flow.test.ts` 通过      |
| Web release e2e           | `packages/web/__tests__/e2e/release-dashboard.test.ts` 通过 |
| dogfooding delivery run   | `run_7a795092-5927-4560-851b-77e102671f86`                  |
| dogfooding human gate run | `run_40091657-33de-4b53-b745-ea622a1004e0`                  |
| SCM mode                  | `dry_run`                                                   |
| PR URL                    | `not_created`                                               |

## 2. Verification Commands

| 命令                                                                                       | 结果                                                          |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------- |
| `npm exec --yes -- pnpm@10.12.1 install --frozen-lockfile`                                 | 通过；lockfile up to date                                     |
| `npm exec --yes -- pnpm@10.12.1 build`                                                     | 通过；core/cli/web 均构建成功，Web 产物在 `packages/web/dist` |
| `npm exec --yes -- pnpm@10.12.1 typecheck`                                                 | 通过                                                          |
| `npm exec --yes -- pnpm@10.12.1 test -- --run`                                             | 通过；46 test files / 133 tests。该命令不启用 coverage        |
| `npm exec --yes -- pnpm@10.12.1 exec vitest --exclude "**/__manual__/**" --run --coverage` | 通过；46 test files / 133 tests，覆盖率见下节                 |
| `npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:e2e`                            | 通过；6 test files / 7 tests                                  |
| `npm exec --yes -- pnpm@10.12.1 --filter @donkey/cli test:e2e`                             | 通过；2 test files / 2 tests                                  |
| `npm exec --yes -- pnpm@10.12.1 --filter @donkey/web test:e2e`                             | 通过；2 Chromium tests                                        |

说明：计划原文中的 `pnpm test -- --run --coverage` 在当前 pnpm/vitest 组合下会把 `--coverage` 传到 Vitest 的 positional 区域，实际不输出 coverage 表。因此本报告用 Vitest 直接参数形式记录真实 coverage。

## 3. Coverage Summary

| 范围                             | 目标         | 实际         |
| -------------------------------- | ------------ | ------------ |
| All files                        | 无全局硬阈值 | 90.97% lines |
| `packages/core/src`              | >= 80% lines | 91.17% lines |
| `packages/cli/src`               | >= 70% lines | 90.92% lines |
| `packages/web/src/server` 与 API | >= 70% lines | 87.11% lines |

Web React 浏览器端由 Playwright e2e 验证，不计入 Vitest v8 source coverage；coverage 配置排除了构建产物、配置文件和浏览器端 bundle，避免把不可由 Vitest 直接执行的文件错误计入分母。

## 4. Gate Summary

| Gate                   | 结果                                                                           |
| ---------------------- | ------------------------------------------------------------------------------ |
| Build                  | 通过；`pnpm -r build` 覆盖 core、cli、web                                      |
| Typecheck              | 通过；`pnpm -r typecheck` 覆盖 core、cli、web                                  |
| Unit/integration tests | 通过；coverage 命令 46 files / 132 tests                                       |
| Core e2e               | 覆盖 worktree、kernel、workflow recovery、gate repair、dynamic constraint      |
| CLI e2e                | `cli-flow` 与 `release-flow` 均通过                                            |
| Web e2e                | dashboard 与 release-dashboard 均通过                                          |
| Human gate             | CLI bugfix run 可 pending 后 approve；Web dashboard 可用 session token approve |
| Audit hash             | Dogfooding delivery run 与 human gate run 均 `audit.valid=true`                |
| SCM                    | dry-run 通过；真实 push/PR 需要人工批准，未执行远端 side effect                |

## 5. Release Decision

决策：允许进入本地 V2 重构阶段收口和 PR 准备；不声明生产发布。

允许声明的能力：

- 本地 CLI 可初始化项目、运行 mock template、执行 dynamic dry-run、处理 human gate、查看状态和日志、清理 worktree。
- Core 支持 SCM delivery dry-run、delivery evidence package、metrics extraction 和 Markdown/HTML report 生成。
- Web dashboard 可显式绑定项目根，展示 overview/artifacts/gates/audit/roles/workflows/settings，并通过 `donkey init` 生成的 `.donkey/web-session.json` token 执行 human approval。
- 最终验收 e2e、coverage 和 dogfooding 报告已生成。

不能声明的能力：

- 未创建真实 GitHub PR。
- 未启用自动 merge。
- 未证明生产级真实 LLM workflow 稳定性。
- 未提供远程多租户 Web 服务。

## 6. Known Limitations

- CLI gate 子进程依赖可找到 `pnpm`；直接 `node packages/cli/dist/index.js run ...` 在缺少 `pnpm` PATH 的环境中会阻断 build gate。
- Web 当前是本地 Node HTTP + Vite React dashboard，不是 Next.js 生产服务。
- Web 写操作只覆盖 human approval、pause/resume/cancel/clean 的本地 token gate；高危远端动作仍应继续由 CLI/SCM human approval gate 控制。
- Coverage 对 Web 浏览器端采用 e2e 验证，不以 Vitest source coverage 表示。
