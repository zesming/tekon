# 第十三轮复审整改执行方案（2026-09-01）

> 依据：第十二轮复审报告第 17.2 节（四路评估一致锁定的四项收敛）与第 18 节（第二轮四路交叉评估批注）。
> 范围：本 PR（`review/human-first-harness-2026-08-28` → `main`，PR #11）内可安全落地的调整；架构冻结项（第 17.4/18.4 节）不在本方案范围。

## 1. 已完成项（第 17.2 节四项，提交 `bd16c72`）

| 项                  | 落地内容                                                               | 证据                                               |
| ------------------- | ---------------------------------------------------------------------- | -------------------------------------------------- |
| DSH pin 升级        | `TESTED_DSH_VERSION` → `0.1.2-alpha.3`，fixture、手册、current.md 同步 | `packages/core/src/runtime/dsh-bridge-probe.ts:21` |
| 版本身份统一        | 根 + 三个内部 package 统一 `0.20.4`，smoke 断言 lockstep               | 四个 `package.json`、`smoke.test.ts:27`            |
| fixture npm warning | 6 个 CLI 测试文件 `writeFileSync` 替代 `npm init`/`npm pkg set`        | `packages/cli/__tests__/` 6 文件                   |
| CI 供应链 gate      | `typecheck` job 加 `pnpm audit --prod`                                 | `.github/workflows/ci.yml:50`                      |

验收：`pnpm test` 138 文件 1477 passed；CLI e2e 3 文件 7 通过且 0 npm warn；`pnpm audit --prod` 0 漏洞。

## 2. 本轮新增调整（第 18 节批注后的收尾）

### 2.1 smoke 断言包目录过滤（第 18.2 节第 6 项）

- **问题**：`smoke.test.ts` 用 `readdirSync(packages)` 直接拼接 `package.json`，`.DS_Store`、无 `package.json` 的残留目录或断链 symlink 会触发 `MODULE_NOT_FOUND` 而非语义化断言。
- **实现**：用 `existsSync(join(packageDir, name, 'package.json'))` 过滤，只扫描含 `package.json` 的包目录。
- **验收**：`vitest run smoke.test.ts` 4 通过。

### 2.2 CI audit gate 步骤顺序（第 18.2 节第 1 项的保守处置）

- **问题**：`pnpm audit --prod` 位于 `typecheck` job 的 install 之后、build/typecheck 之前。registry 抖动或新 advisory 会让 build/typecheck 诊断完全不产出，且下游 `cli`/`web`/`web-e2e` 全部跳过。
- **决策**：保留 audit 在 `typecheck` job 内（尊重第 17.2 节四路一致方案，保持 gate 语义），但将步骤顺序移到 `Build all packages` 与 `Typecheck all packages` 之后。这样 audit 失败时 build/typecheck 诊断已产出，故障定位不依赖 audit 可用性。
- **未解决的半问题**：audit 失败时下游 `cli`/`web`/`web-e2e` 依然全部跳过（`needs: typecheck` 语义），功能回归诊断仍不可得。本方案不解决这一半，交用户决策。
- **替代方案对比**：拆独立 audit job 并把下游改为 `needs: [typecheck, audit]` 可保留阻断语义（纯 YAML 改动，不依赖 branch protection），且 audit 与 build/typecheck 并行、互不阻塞诊断。本轮不采纳的理由：拆独立 job 改变了第 17.2 节四路一致确认的 gate 位置，属于供应链 gate 严格度的设计取舍，应由用户决策；本轮只做不改变 gate 语义的最小步骤重排。
- **验收**：CI YAML 语法正确；`pnpm audit --prod` 本地退出码 0。

### 2.3 文档同步

- 第十二轮报告追加第 18 节批注（第二轮四路交叉评估）。
- `CHANGELOG.md` 补记 smoke 目录过滤与 audit 步骤顺序调整。
- `docs/reviews/current.md` 同步第 18 节结论。

## 3. 明确不做的项（维持冻结或交用户决策）

| 项                                                                                             | 理由                                                                                                                                  |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| P0-ARCH-01/02、P0-DATA-01、P0-PRODUCT-01、P1-PLAN-01、P1-SESSION-01、P1-A11Y-01、P1-PROCESS-01 | 架构冻结项，第 18.1 节四路评估逐项核对代码证据后确认冻结裁决成立，按报告第 14 节顺序分独立 PR 推进                                    |
| P1-GOV-01 main 分支保护                                                                        | 需仓库 Owner 在 GitHub Settings 操作，非代码可解决                                                                                    |
| audit 拆独立 job                                                                               | 改变第 17.2 节四路一致确认的 gate 位置，属供应链 gate 严格度的设计取舍，交用户决策                                                    |
| 全仓 prettier 格式化（253 文件）                                                               | 独立提交，不混入本 PR                                                                                                                 |
| 引入 ESLint/Biome                                                                              | 独立评估，不在本 PR                                                                                                                   |
| `createFixtureRepo` 抽共享 helper                                                              | 6 文件重复但行为有细微差异（approval-terminal 仅 test script、run-mode-policy 保留 npm 默认 test），抽共享 helper 需仔细对齐，另立 PR |
| dev 依赖树 2 处 low-severity（esbuild Windows）                                                | `--prod` 不覆盖，不影响生产运行时，记录                                                                                               |

## 4. 验收标准

1. `pnpm test` 全量通过（138+ 文件，0 失败）。
2. `pnpm --filter @tekon/cli test:e2e` 通过且 0 npm warn。
3. `pnpm audit --prod` 退出码 0。
4. `.github/workflows/ci.yml` YAML 语法正确，audit 步骤位于 build/typecheck 之后。
5. 第十二轮报告第 18 节、CHANGELOG、current.md 内容一致，无占位符。
6. reviewer 循环评审本方案与实施代码，直到未检出必须修复项。
7. 全功能 e2e（CLI + Web Playwright）通过。
8. UI 人工目视检查：主路径页面无错位/重叠/展示错误，交互符合预期（现有 e2e 无视觉断言，此项为人工检查项，由主 agent 在全功能 e2e 阶段执行并记录结果）。

## 5. 版本号评估

本轮改动为测试健壮性（smoke 目录过滤）、CI 步骤顺序（不改变 gate 语义）、文档（报告第 18 节、CHANGELOG、current.md、方案文档），均属 PATCH 范畴。v0.20.4 尚未推送发布（无 git tag），本轮改动吸收进 v0.20.4，不单独 bump。
