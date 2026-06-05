# Donkey MVP 用户手册

生成日期：2026-06-05
适用分支：`rebuild-v2`
适用范围：阶段一安全可恢复内核后的仓库状态

## 1. 当前定位

Donkey 目前不是可供普通用户直接发起需求、等待自动 PR 的完整产品。当前仓库只提供 `packages/core` 内核 API，以及围绕该内核的测试、构建和阶段性文档。

当前可用能力面向研发和评审人员：

- 查看阶段一内核的领域模型、运行时配置、持久化、产物、审计、命令网关、worktree、Agent adapter 和 Gate API。
- 执行 `packages/core` 的单元测试、E2E 测试、构建和类型检查。
- 审阅阶段计划、阶段一评估报告和发布就绪加固后的边界说明。

## 2. 用户怎么发起

当前没有普通用户入口，因此不能通过 `donkey run`、Web 页面或聊天入口发起 Donkey 任务。

研发或评审人员可以在仓库根目录执行验证命令来检查内核状态：

```bash
npm exec --yes -- pnpm@10.12.1 install --frozen-lockfile
npm exec --yes -- pnpm@10.12.1 ignored-builds
npm exec --yes -- pnpm@10.12.1 test -- --run
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:unit
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core test:e2e
npm exec --yes -- pnpm@10.12.1 --filter @donkey/core build
npm exec --yes -- pnpm@10.12.1 build
npm exec --yes -- pnpm@10.12.1 typecheck
```

这些命令验证的是内核包和 monorepo 工程状态，不代表已经存在产品级 CLI 或 Web 工作流。

## 3. 用户会得到什么

运行验证命令后，用户会得到测试、构建或类型检查结果。结果可用于判断阶段一内核是否仍保持可构建、可测试和可审阅。

当前不会得到：

- 需求分析报告。
- 产品方案自动生成结果。
- 代码变更 PR。
- Web 驾驶舱页面。
- 自动合入或上线结果。

## 4. 如何判断结果

可以按以下标准判断当前仓库状态：

- `packages/core` 相关测试通过，说明阶段一内核 API 的既有行为仍满足测试约束。
- `build` 通过，说明 TypeScript 输出仍可生成。
- `typecheck` 通过，说明类型层面没有被当前改动破坏。
- 文档中的能力边界与仓库实际文件一致，说明没有把后续阶段能力提前描述成已交付能力。

若命令失败，应先把失败视为当前内核或工程配置的真实风险，而不是用户操作错误。

## 5. 当前不能做什么

当前版本不能做以下事情：

- 不能通过 CLI 创建 Donkey run。
- 不能通过 Web 查看项目、产物、Gate 或审计。
- 不能自动创建、推送、合入 PR。
- 不能替代人类完成上线审批或高风险动作。
- 不能承诺真实 LLM provider 在生产工作流中稳定执行。
- 不能把 `CommandPolicy.network` 理解为 OS 级网络隔离。
- 不能作为普通用户安装后直接使用的完整产品。

## 6. 配置与工具链说明

根 `test` 脚本保持为 `vitest`。Vitest 已迁移到根 `vitest.config.ts` 的 `test.projects`，不再使用旧 workspace 配置文件。

`packages/core` 仍是当前唯一代码包。后续 CLI、Web、交付和产品化入口需要在后续阶段单独实现、测试和审阅。
