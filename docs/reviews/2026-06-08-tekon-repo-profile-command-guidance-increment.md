# Tekon 仓库画像缺失命令修复引导增量报告

日期：2026-06-08

范围：补齐 P0-3 “仓库画像驱动 Gate”中缺失命令的第一版修复引导。本文覆盖 preflight 提示和 repo profile 写入建议；后续同日增量已补齐“显式不适用”的 gate 语义。

## 1. 背景判断

Tekon 已经把内置 workflow 从硬编码 `pnpm build/lint/test` 推进到 `commandRef` 读取 `.tekon/repo-profile.yaml`。这解决了“模板写死 pnpm”的主要问题，但真实工作中仍会遇到另一类失败：目标仓库没有标准 `build`、`e2e` 等脚本名，而是使用 `compile`、`test:e2e`、`playwright` 等等价脚本。

如果 Tekon 只输出 `missing-command`，用户仍要自己判断该改哪里、用哪个脚本替代。作为真实工作工具，即使不追求全面自动化，也需要在运行前把缺失命令和可疑替代脚本直接暴露出来，减少首次接入仓库的定位成本。

## 2. 已完成能力

| 能力               | 实现位置                                                                                 | 说明                                                                                                                                                        |
| ------------------ | ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 结构化修复引导     | `packages/core/src/repo/profile.ts`                                                      | 新增 `repoProfileCommandGuidance` 和 `suggestRepoProfileCommandFixes`，对缺失 `build/typecheck/lint/test/e2e/security` 输出 profile 路径、hint 和候选建议。 |
| 候选脚本识别       | `packages/core/src/repo/profile.ts`                                                      | 目前识别 `compile`、`bundle`、`tsc`、`check-types`、`eslint`、`unit`、`test:unit`、`test:e2e`、`playwright`、`security:scan`、`audit` 等常见脚本名。        |
| npm/pnpm 命令格式  | `packages/core/src/repo/profile.ts`                                                      | 根据 `packageManager: pnpm@...` 生成 `pnpm <script>`，否则生成 `npm run <script>`，并生成可写入 `.tekon/repo-profile.yaml` 的 YAML snippet。                |
| CLI preflight 展示 | `packages/cli/src/index.ts`                                                              | `workflow preflight` 在普通命令缺失时输出 `status=missing`、`hint`、`profilePath`；命中候选脚本时追加 `suggestedScript` 和 `suggestedCommand`。             |
| 回归测试           | `packages/core/__tests__/repo/profile.test.ts`、`packages/cli/__tests__/run-cli.test.ts` | 覆盖 npm 仓库从 `compile` 建议 `npm run compile`、pnpm 仓库从 `test:e2e` 建议 `pnpm test:e2e`，以及 CLI preflight 输出修复引导。                            |

## 3. 当前边界

- Tekon 不会自动写入 `.tekon/repo-profile.yaml`，因为候选脚本需要用户确认语义是否等价。
- Tekon 不会把缺失命令静默视为通过；普通命令缺失时 workflow gate 仍会以 `missing-command` 失败。后续增量已支持用户显式配置 `notApplicable: true` 和 `reason`。
- `security-scan` 没有外部命令时仍使用 Tekon 内置扫描；候选外部安全脚本只是 repo profile 的可选增强。
- 显式“不适用”不是缺失命令兜底；只有用户在 repo profile 中配置后才会记录为 `skipped/not-applicable`。

## 4. 验证记录

已通过的阶段性验证：

```bash
npm exec --yes -- pnpm@10.12.1 --filter @tekon/core test:unit -- --run packages/core/__tests__/repo/profile.test.ts
npm exec --yes -- pnpm@10.12.1 --filter @tekon/core build
npm exec --yes -- pnpm@10.12.1 --filter @tekon/cli build
npm exec --yes -- pnpm@10.12.1 --filter @tekon/cli test:unit -- --run packages/cli/__tests__/run-cli.test.ts
```

本轮最终收口验证：

```bash
npm exec --yes -- pnpm@10.12.1 build
npm exec --yes -- pnpm@10.12.1 typecheck
npm exec --yes -- pnpm@10.12.1 test -- --run
npm exec --yes -- pnpm@10.12.1 --filter @tekon/web test:e2e
git diff --check
npm exec --yes -- prettier --check README.md CHANGELOG.md docs/manual/tekon-v2-user-manual.md docs/manual/tekon-v2-user-manual.html docs/reviews/2026-06-08-tekon-work-usability-gap-analysis.md docs/reviews/2026-06-08-tekon-work-usability-gap-analysis.html docs/reviews/2026-06-08-tekon-work-usable-increment.md docs/reviews/2026-06-08-tekon-work-usable-increment.html docs/reviews/2026-06-08-tekon-repo-profile-command-guidance-increment.md docs/reviews/2026-06-08-tekon-repo-profile-command-guidance-increment.html packages/core/src/repo/profile.ts packages/core/__tests__/repo/profile.test.ts packages/cli/src/index.ts packages/cli/__tests__/run-cli.test.ts
```

覆盖点：

- `repo/profile.test.ts` 覆盖缺失 `commands.build` 但存在 `compile` 脚本时，core 输出 `suggestedCommand=npm run compile` 和 YAML snippet。
- `repo/profile.test.ts` 覆盖 pnpm 仓库缺失 `commands.e2e` 但存在 `test:e2e` 脚本时，core 输出 `suggestedCommand=pnpm test:e2e`。
- `run-cli.test.ts` 覆盖 `workflow preflight standard-feature` 对缺失 build 命令输出 `status=missing`、`hint`、`profilePath`、`suggestedScript=compile` 和 `suggestedCommand=npm run compile`。

## 5. 后续仍需

1. 用 1-2 个真实非 pnpm 仓库或脚本名不同的内部仓库验证 preflight 输出是否足够直观。
2. 在真实仓库样本中验证 `notApplicable` 是否足够表达文档仓库、纯库仓库、无浏览器表面的服务仓库等差异，而不是让用户删除命令来绕过 gate。
3. 根据真实仓库样本补充更多候选脚本名，例如 `check`、`verify`、`ci:test` 等，但应避免把猜测升级为自动执行。

## 6. Reviewer 结论

最高思考 reviewer 结论：APPROVED。必须修复项：无。

复查确认：本轮 `repoProfileCommandGuidance` / `suggestRepoProfileCommandFixes` 只读取 `package.json` 并生成建议，不写 `.tekon/repo-profile.yaml`，不自动执行候选脚本，也不改变 Engine 缺失普通命令时的 `missing-command` 失败语义。CLI `workflow preflight` 只是展示 `hint/profilePath/suggestedScript/suggestedCommand`；`security-scan` 缺外部命令时仍显示内置扫描，符合当前边界。

测试覆盖核心路径：npm `compile -> npm run compile`、pnpm `test:e2e -> pnpm test:e2e`、CLI preflight 缺失 build 的提示字段。当时文档和 HTML 对能力边界表述一致，没有把尚未实现的 `notApplicable`、真实非 pnpm 仓库验证或自动修复/自动跳过写成已完成；后续同日增量已补齐显式 `notApplicable` 语义。
