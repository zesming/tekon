# Tekon 第二十一轮复审收口执行方案

- **日期**：2026-09-04
- **对应 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **设计基线 Head**：`34a542f963b495673b4f7adc48c2c5a574fc7052`
- **当前产品版本**：`0.20.6`
- **本轮版本裁决**：保持 `0.20.6`
- **方案状态**：独立 reviewer 已放行，实施中

## 1. 目标与验收口径

本方案只收敛第二十一轮中已经具备明确合同、可用自动化验证且不需要架构迁移的事项：

1. 在现有 `CI` workflow 中新增独立 Node compatibility job，覆盖 `20.19.x`、`22.12.x`、`22.19.x`、`24.x`；
2. 用结构化 YAML 合同测试锁定矩阵、执行步骤和独立运行语义；
3. 恢复第二十一轮正式报告 HTML 审阅版，纠正 Markdown-only 违规表述；
4. 重建 `docs/reviews/current.md` 的 Head、CI、本地测试和历史证据链；
5. 同步 CHANGELOG 的 Unreleased 记录、Issue #24/#33 和 PR 描述；
6. 在同一 PR 提交，等待最终 Head 的全部检查通过。

验收成功不等于 Tekon 整体产品验收通过，也不等于分支保护已经启用。最终结论必须继续区分：

- Node 兼容性矩阵通过：Linux x64 上的 install/build/typecheck/Core unit/CLI unit 与 CLI smoke 有持续证据；
- 仓库强制合并门：本轮不配置，仍未成立；
- Windows、macOS、浏览器矩阵、DSH L3、Runtime/Session 架构：本轮不证明。

## 2. 已验证事实

### 2.1 当前基线

- 本地 `pnpm test`：144 files、1551 passed、1 skipped；
- 唯一 skip：无 `DSH_CLI_PATH` 时跳过合并后的真实 DSH L2 wrapper case；
- Core #426：run `33759049251`，`completed/success`；
- CI #335：run `33759049201`，`completed/success`；
- 当前 7 个远端 checks 全绿。

### 2.2 Node 下界实测

设计阶段已在 Linux x64 干净 checkout 中验证：

| Node | install | build/typecheck | Core unit | CLI unit/smoke | 结论 |
| --- | --- | --- | --- | --- | --- |
| 20.19.0 | 通过，`better-sqlite3` 从源码构建 | 通过 | 1076 passed、1 skipped | 64 passed，版本输出正确 | 可进入矩阵 |
| 22.12.0 | 通过 | 通过 | 1076 passed、1 skipped | 64 passed，版本输出正确 | 可进入矩阵 |

Node 20 使用 ABI 115，`better-sqlite3@12.10.0` 没有对应预编译包，会依赖 `ubuntu-latest` 的 Python、make 与 C++ 编译器。该事实决定矩阵必须保留真实 install 和会加载 SQLite native binding 的 Core unit，不能只做 `--version`。

实现期独立 reviewer 复现了另一条版本边界：Node 22.12.0 自带 Corepack 0.29.4，无法验证 pnpm 10.12.1 的新签名密钥，会在首次执行 pnpm 时确定性失败。矩阵因此在启用 shim 前固定安装兼容四腿的 `corepack@0.34.1`；不使用已提高 Node engines 下界的最新 Corepack。

## 3. 设计决策

### 3.1 一个 workflow 内的独立 job

在 `.github/workflows/ci.yml` 新增 `node-compat`，不新建 workflow 文件：

- 复用现有 `CI` 的触发器、权限和 concurrency；
- 不设置 `needs`，与 `audit` 一样独立运行，其他 job 失败不会压掉矩阵诊断；
- `strategy.fail-fast: false`，一个版本失败时其他版本继续提供证据；
- `timeout-minutes: 20`，覆盖 Node 20 native source build 的合理波动；
- 不修改 `.github/workflows/core.yml` 的主 Node 24 lane；
- 不修改 branch protection/ruleset。

### 3.2 矩阵版本

固定四腿：

```yaml
node-version: ['20.19.x', '22.12.x', '22.19.x', '24.x']
```

- `20.19.x`：根 `engines` 的 Node 20 最低 minor；
- `22.12.x`：根 `engines` 的 Node 22 最低 minor；
- `22.19.x`：DSH engines 的 Node 22 最低 minor，验证 Tekon 在 DSH 声明支持的最低 Node 22 上可运行；
- `24.x`：主 lane 基线，使矩阵可独立比较。

版本必须加引号，避免 YAML 将版本误解析为数字。

### 3.3 每腿执行合同

每个版本依次执行：

```text
checkout
→ setup-node(matrix.node-version)
→ npm install --global corepack@0.34.1
→ corepack enable pnpm
→ pnpm install --frozen-lockfile
→ pnpm -r build
→ pnpm -r typecheck
→ pnpm --filter @tekon/core test:unit
→ pnpm --filter @tekon/cli test:unit
→ built CLI --version / --help smoke
```

不把 Web unit 或 Playwright 放进矩阵。全包 build 已覆盖 Vite 在声明下界的构建；浏览器 e2e 继续只在主 Node 24 lane 执行。

CLI smoke 必须校验实际输出与根 `package.json` 版本一致，并确认 `--help` 正常退出。CLI unit 保留，因为它能覆盖 child process、Git fixture 与 SQLite 等更容易出现 Node 差异的路径。

### 3.4 暂不启用缓存

首版不配置 pnpm store cache：

- 四腿并行，实测单腿约 2 至 4 分钟；
- Corepack shim 与 setup-node cache 的初始化顺序会增加额外合同；
- 当前 job 尚未进入 required checks，不需要先引入缓存 key 和失效策略。

若远端连续运行显示成本过高，再以独立变更加入缓存并验证 native build 缓存边界。

## 4. 测试先行方案

### 4.1 先写 RED 合同

新增 `packages/core/__tests__/ci/github-workflows.test.ts`，使用 `yaml` 包解析 workflow。第一步只新增测试，不修改 workflow，并运行 focused test，必须因为 `jobs.node-compat` 不存在而失败。

测试使用结构化断言，不使用整段 YAML 字符串匹配。至少锁定：

1. `node-compat` 存在，且无 `needs`；
2. `runs-on` 为 `ubuntu-latest`，`timeout-minutes` 为 20；
3. `strategy.fail-fast` 为 false；
4. matrix 精确包含四个字符串版本；
5. matrix 不允许 `exclude` 静默排除任何版本，job 与必需 steps 不允许用 `if` 条件跳过；
6. matrix 覆盖根 `engines.node` 的 20.19 与 22.12 下界；
7. matrix 包含主 `env.NODE_VERSION` 对应 major；
8. setup-node 使用 `${{ matrix.node-version }}`；
9. 固定 Corepack、install、全包 build/typecheck、Core unit、CLI unit 与二进制 smoke 命令存在且顺序正确；
10. 新 job 使用的 action 版本已在当前 workflow 中使用；
11. `core.yml` 的主 Node 版本与 `ci.yml` 的 `env.NODE_VERSION` 一致；
12. job 与所有 steps 均未启用 `continue-on-error`，失败版本不能被标成允许失败。

### 4.2 再写 GREEN 实现

在测试失败证据确认后新增 `node-compat` job，再运行同一 focused test，必须通过。随后运行 Core unit，确认新测试没有重复进入 e2e lane。

### 4.3 测试质量自检

- **正确性**：故意删除或 exclude 一个 matrix 版本、加入 `if`/`needs`、删除固定 Corepack 或命令时，测试应失败；
- **完整性**：覆盖版本集合、独立性、超时和所有命令，不只检查 job 名称；
- **无冗余**：按“job 结构”“版本来源”“命令顺序”分组，每个断言只承担一个合同；
- **不过拟合**：不锁定无语义影响的空行、注释、step display name 或 YAML 键顺序。

## 5. 文档与版本同步

### 5.1 正式报告

第二十一轮 Markdown 报告新增主 Agent 批注，并同步生成同名 HTML。统一表述：

- Markdown 是内容源；
- HTML 是 `AGENTS.md` 要求的正式人审呈现；
- 两者必须同步结论、版本、Head 和 CI 证据；
- 不再出现 Markdown-only 或 HTML 可省略的表述。

当前环境没有 `/frontend-design:frontend-design` skill，因此沿用第二十轮自包含 HTML 的排版语言，完成桌面与移动视口人工检查，并明确记录该环境限制。

### 5.2 权威快照

`docs/reviews/current.md` 恢复并更新：

- 设计基线 `34a542f...`、本轮实施证据 Head 及其 runs；
- Core #426 / CI #335，以及实施证据 Head 对应的 Core/CI runs；
- v0.20.6 本地 144 files、1551 passed、1 skipped；
- Chromium 48 项与 320/390/700/1440 四视口 4/4；
- 历史关键 runs `33747232853`、`33747232722`、`33753603954`、`33753603924`；
- 旧 `3 skipped` 到当前 `1 skipped` 的原因；
- Node matrix 的证明范围与 branch protection 未启用边界；
- Markdown/HTML 同步维护规则。

`current.md` 是导航索引和稳定入口，不是独立正式评审报告；它不复制完整报告，只保留当前结论、正式报告 MD/HTML 链接和可追踪证据，因此不另建 `current.html`。

### 5.3 版本号

产品版本保持 `0.20.6`。`docs/technical/tekon-replatform-current-scope.md` §6 与 `CHANGELOG.md` 的 Unreleased 策略明确：纯复审、批注、措辞订正与验收状态调整不单独抬高产品版本，避免 `tekon update` 因无产品行为变化而触发完整安装和构建。

本轮新增的是仓库 CI 兼容性检查，不改变用户命令、工作流模板、Provider、产品 Gate、运行时合同、安装产物或 `.tekon` 数据格式；因此不修改四个 `package.json`、lockfile 或用户手册中的产品版本。只在 `CHANGELOG.md` 的 Unreleased 复审记录中说明 Node matrix 与文档纠偏。

### 5.4 外部状态

- #24：修改正文，明确 Node matrix 经用户决定在 PR #11 落地；required checks、SBOM、provenance、签名继续 OPEN，并由后续独立 PR/仓库设置处理；
- #33：补 `bug` label，并补充 CLI `tekon clean` 也需纳入后续治理；
- PR #11：同步产品版本不变、最终 Head、报告 MD/HTML、测试结果、11 个 checks 和明确非目标；
- 不修改 branch protection/ruleset，不执行 merge、release 或 deploy。

## 6. 实施顺序

1. 完成本方案 MD/HTML；
2. 由最高思考等级 `reviewer` 审查技术正确性，由 `doc_reviewer` 审查可读性；
3. 修复必须项并重新审阅，直到无必须修复项；
4. 新增 YAML 合同测试并记录 RED；
5. 新增 `node-compat` job 并记录 GREEN；
6. 同步 CHANGELOG Unreleased、`current.md` 和正式报告 MD/HTML；
7. 运行 focused tests、`pnpm test`、lint/typecheck/build/audit/actionlint、Core/CLI/Web e2e；
8. 运行 Web 四视口与报告 HTML 多视口检查，清理临时截图；
9. 委派 `reviewer` 与 `doc_reviewer` 审查实现和文档；
10. 修复并复查到无必须修复项；
11. 提交并推送实施结果，等待该实施证据 Head 的 Core/CI 全部成功；
12. 把实施证据 Head 及其 run ids 回填报告与 `current.md`，提交并推送文档证据 Head，等待它的 11 个 checks 全部成功；
13. 只在 PR 与 Issue 这些外部状态中记录最终文档证据 Head 及其 runs，不再为回填自身检查产生新提交；
14. 最终 reviewer 按用户要求 0-7 逐项验收。

## 7. 完整验证矩阵

### 7.1 本地代码与合同

```bash
pnpm exec vitest --run packages/core/__tests__/ci/github-workflows.test.ts
pnpm test
pnpm lint
pnpm typecheck
pnpm build
pnpm audit --prod
pnpm lint:actions
pnpm --filter @tekon/core test:e2e
pnpm --filter @tekon/cli test:e2e
pnpm --filter @tekon/web test:e2e
```

`pnpm test` 是每次 commit 前的强制门。其他命令按最终工作树执行；失败必须修复或给出可复现的外部原因，不能静默略过。

### 7.2 UI 与 HTML

- Playwright 48 项全部通过；
- 320、390、700、1440px 下两个 Run 入口无横溢、重叠或文本裁切；
- 第二十一轮报告 HTML 与方案 HTML 在移动和桌面视口可读，无横向滚动和内容遮挡；
- HTML 标题、产品版本、Head、run ids、裁决与 Markdown 一致；
- 临时截图与 server 日志验后删除。

### 7.3 远端

实施证据 Head 与最后的文档证据 Head 均预期 11 个 checks：原 7 个加四个 Node compatibility legs。每组证据内部必须绑定同一 Head、attempt 1、`completed/success`；被后续提交自动取消的旧 run 不作为证据。仓库内文档记录实施证据 Head 及其 runs，最终文档证据 Head 及其 runs 只回填到 PR/Issue 外部状态，避免提交自引用。

## 8. 风险、回滚与非目标

### 8.1 风险与缓解

| 风险 | 影响 | 缓解 |
| --- | --- | --- |
| Node 20 native source build 波动 | install 变慢或工具链失败 | 20 分钟上限、保留真实 Core unit、先观察再决定缓存 |
| 四腿增加 CI 成本 | PR 反馈稍慢 | 四腿并行，Web unit/Playwright 不进入矩阵 |
| YAML 合同测试过度锁死 | 正常重排也失败 | 解析结构，只锁行为字段与命令集合/顺序 |
| MD/HTML 漂移 | 人审结论冲突 | Markdown 单一内容源，关键事实机械比对并由 doc reviewer 复核 |
| 检查被误写成强制门 | 治理成熟度夸大 | 明确 branch protection 本轮不变，#24 保持 OPEN |

若矩阵引入不可接受的远端不稳定，回滚只删除 `node-compat` job 及对应合同测试，不改 `engines`；在 #24 记录失败证据后重新设计。不得为了让 CI 变绿而跳过最低版本或把失败版本标成允许失败。

### 8.2 非目标

- 不修改 branch protection/ruleset；
- 不修 Windows `.cmd` launcher 或 Provider identity；
- 不做 DSH L3 或升 tested pin；
- 不改 Provider health/admission、Runtime、Session、RunPlan、shutdown/restart；
- 不改 `project.clean`/`tekon clean` 行为；
- 不定义或修改 `onWarn` 公共语义；
- 不新增 SBOM、provenance、签名或 release pipeline；
- 不清理全仓格式债务；
- 不 merge、release 或 deploy。

## 9. 放行标准

只有以下条件全部满足，才可判定本轮完成：

1. 方案与实现均经最高思考等级 reviewer 放行；
2. YAML 合同测试有明确 RED→GREEN 证据；
3. 最终工作树 `pnpm test` 全绿且只有 1 个有解释的 L2 skip；
4. 完整本地验证与 UI/HTML 多视口检查通过；
5. 正式报告 MD/HTML、`current.md`、CHANGELOG、Issue 与 PR 无事实漂移；
6. 实施证据 Head 与最终 PR 文档证据 Head 的 11 个 checks 分别全部 `completed/success`；
7. 工作树干净，无临时产物；
8. 最终 reviewer 按用户 0-7 要求确认无必须修复项。
