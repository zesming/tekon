# 第二十二轮复审批注与收口执行方案

- **日期**：2026-09-04
- **当前代码基线**：`e69b938`
- **方案编制时版本**：`0.20.6`
- **目标版本**：`0.21.0`
- **关联 PR**：[#11](https://github.com/zesming/tekon/pull/11)
- **权威输入**：[第二十二轮全面复审](../../reviews/2026-09-04-tekon-product-runtime-harness-twenty-second-review.md)

> 文档状态：§1–§7 为 `e69b938` 时点编制的实施方案；§8 为 `a843fc1` 收口完成后的执行记录回填。两处时点冲突时，以 §8 的实际结果为准。

## 1. 目标、约束与验收口径

### 1.1 目标

本轮只关闭第 22 轮报告与独立复核中已能用当前仓库确定性证明的合并缺口：

1. 生产依赖 Audit 只重试可识别的端点瞬态故障；Advisory 和未知错误均立即失败，不重试；
2. Node compatibility job 真正执行 `engines` 中三个已承诺 floor，而不是只执行对应 minor 的最新 patch；
3. 在 lifecycle-safe purge 完成前，同时关闭 Web 和 CLI 的裸物理删除入口；
4. 接通 `SessionServiceStartRunInput.planDigest` 的公开数据流；
5. 把 Web Session credential health 与可选 DSH provider probe 分离；
6. 补齐正式报告、方案和用户文档的 Markdown/HTML 同步，给出可复核的验证证据。

### 1.2 非目标

本轮不做：

- 不修改 `engines.node` 的公开范围，不在超大 PR 内决定移除 Node 20 或支持 Node 26；
- 不升级 `TESTED_DSH_VERSION`，不把 0.1.3 Alpha 当成 Headless 生产 pin；
- 不把 ambient proxy 加回 DSH exact env；trusted proxy 与凭据证据继续由 #32 设计；
- 不实现 repo daemon、worker/process isolation、authoritative Session、transactional outbox 或 ACP；
- 不修改 GitHub branch protection/ruleset，不执行 merge、release 或 deploy；
- 不扩张自定义 responsive geometry scanner。

### 1.3 完成标准

只有同时满足以下条件才可交付：

- 方案经最高思考等级 reviewer 复核且无必须修复项；
- 每项行为变更先出现能失败的测试，再实施最小代码；
- 改动相关 unit/integration/e2e 全部通过；
- `pnpm test`、全包 typecheck/build、CLI e2e、Web Playwright 全部通过；
- 320/390/700/1440px 主路径无横向溢出、错位、重叠或不可操作状态；
- 正式 Markdown 与 HTML 一致，且无任何占位标记；
- 代码 review 与报告完成度 review 均循环到无必须修复项；
- commit 前再次执行 `pnpm test`，版本 lockstep，并将结果推到 PR #11。

## 2. 产品与设计决策

### 2.1 清理入口：明确“暂不可用”，不制造伪安全

Web `project.clean` 和 CLI `tekon clean` 当前没有足够的 Job、Lease、Subprocess、Automation、Audit、Session 与文件引用协调能力。临时方案不是“只允许终态 Run 删除”，而是停止全部物理删除：

```text
Web：认证与目标范围校验
→ 写入 clean.suspended Audit
→ 返回稳定错误
→ 文件和除拒绝 Audit 外的领域事实不变

CLI：完成仓库初始化校验
→ 返回稳定错误
→ 不扫描、不删除、不重建 worktrees 目录
```

Web 只有在 token、confirm、runId 格式和 repo scope 全部通过后才允许给目标 Run 追加拒绝 Audit。未认证、非法参数和越权请求不得向任何 Run 写入审计，避免形成越权侧信道。Audit 写入失败时请求仍失败，且不得执行删除。

稳定错误合同：

- Web：`CONFLICT`，消息包含 `CLEAN_SUSPENDED` 和 `lifecycle-safe purge`；
- Web Audit 写入失败：`INTERNAL_ERROR`，消息固定为 `CLEAN_AUDIT_FAILED: unable to record suspended clean request`，不回显底层异常；
- CLI：固定 exit 1，仅 stderr 输出包含 `CLEAN_SUSPENDED` 的稳定消息并指向 #33/#18，stdout 为空；
- 不返回“已清理 0 个”等可能被误解为成功的文本。

### 2.2 健康状态：先回答凭据，再异步回答 Provider

`project.health` 只读取 Web Session token 并返回：

```text
credential + checkedAt + optional detail
```

新增受 token 保护的 `project.providerHealth`：

```text
input: token + provider('dsh-headless')
output: provider + status('available'|'unavailable') + checkedAt
```

本轮只移动现有 `available/unavailable` 产品语义，不向客户端返回 raw error、路径、代理或环境，也不在 Web 层猜测已经被 Core 折叠的错误原因。`not-installed`、Host Node、version、contract、timeout、proxy/environment 等结构化诊断继续由 #29 的统一 capability service 完成；CLI 的显式 preflight 仍是当前可行动诊断入口。

Provider cache 独立于 credential cache。每次请求必须先重新校验当前 token，再查 cache；cache key 绑定 repo/session scope、provider 和不可逆 token hash，TTL 固定 60 秒、最大 128 项、按最旧项淘汰，同 key 首次并发使用 single-flight。未认证请求不得读 cache 或 spawn；token 轮换后旧 scope 不可读取。成功和 unavailable 都只缓存 60 秒，避免损坏二进制造成 probe 风暴。

TopBar 在 credential 有效后再发起 provider query：连接徽标不得等待 DSH；DSH 不可用提示可稍后出现，且继续指向 `tekon provider preflight dsh-headless`。两项 query 独立 60 秒刷新；auth scope 改变时旧 provider 数据立即不可见。

此切片只关闭“credential health 被 DSH 拖慢”，#29 的 Codex/Claude admission、CLI mutable slot 和统一 capability snapshot 保持未关闭。

### 2.3 Node 支持证据：精确 floor 与滚动 LTS 分开

矩阵调整为：

```text
20.19.0  # 精确 legacy floor
22.12.0  # 精确公开 floor
22.19.0  # 精确 DSH-compatible floor
24.x     # 当前 LTS 最新 patch
```

[DSH 根包 engines](https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.3-alpha.1/package.json) 声明 `^22.19.0 || >=24.0.0`；资料内容是 DSH 自身的 Node 运行下限，对 Tekon 的判断依据是把 `22.19.0` 作为 DSH-compatible 的独立精确档，同时保留 Tekon 自身公开 floor `22.12.0`。

合同测试比较完整版本字符串，不再截断为 major.minor；同时继续验证 job 独立、`fail-fast: false`、无 `exclude`/`if`/`continue-on-error`，以及每腿完整 install/build/typecheck/Core/CLI/smoke 顺序。setup-node 之后增加 resolved-version 断言：三个精确版本必须满足 `process.versions.node === matrix.node-version`；24.x 输出实际 patch 供 CI 证据归档。

本轮不收窄 `^20.19.0 || >=22.12.0`。报告必须明确：上述四腿是已测集合，不等于 Node 23/25/26/future major 的生产支持承诺；开放上界决策继续由 #24 承担。

### 2.4 DSH：同步事实，不同步未经验证的 pin

官方仓库已同步到 `dsh-v0.1.3-alpha.1` / `d347e703...`。本轮只更新复核证据：

- Headless one-shot 外部协议仍可识别；
- 新的 SessionHandle、v2 格式、单写者 lease 只作为 #14 技术输入；
- 官方已披露历史加载性能回退；
- proxy 支持要求未来显式 trusted config，不能恢复 `process.env` 全量继承；
- Tekon tested pin 继续为 `0.1.2-alpha.3`。

## 3. 实现设计

### 3.1 Audit 分类重试

新增可独立运行、可导入测试的 `scripts/ci/audit-production.mjs`，CI workflow 只调用该脚本。

脚本执行 `pnpm audit --prod --json`，保存每次 stdout/stderr 与退出码，分类规则为：

1. 无论退出码为何，都先解析并校验 pnpm 10.12.1 的 audit JSON 结构；
2. 只有 `exit 0 + JSON 结构有效 + advisories 为空 + metadata.vulnerabilities` 的 `info/low/moderate/high/critical` 五个字段均为非负有限数且求和为 0 才成功；pnpm 10.12.1 的真实输出没有 `total` 字段，不能要求该字段；
3. 结构有效且包含任一 Advisory 或非零 vulnerability count 时，无论退出码为何都立即失败，不重试；
4. exit 0 但输出为空、JSON 截断、结构未知或“零退出 + Advisory”均立即 fail-closed；
5. 仅当没有有效 audit 结果、退出非零且错误明确属于 timeout、DNS/connect reset 或 HTTP 5xx 时重试一次；
6. Advisory 输出同时含 timeout 字样时仍按有效 Advisory 失败，不得被文本匹配降级为瞬态错误；
7. 未知/不可分类失败立即失败，第二次无论何种失败都失败；
8. 生产默认退避 15 秒；测试通过显式函数注入零延迟，不依赖隐藏环境开关。

测试覆盖：`zero vulnerabilities → success`、`Advisory → 不重试`、`exit 0 + malformed/empty JSON → fail`、`exit 0 + Advisory → fail`、`Advisory + timeout text → 不重试`、`timeout → 重试后成功`、`timeout → 重试仍 timeout → 失败`、`unknown → 不重试`、`5xx → success`，并验证退出码、尝试次数和诊断文本。Workflow 合同测试验证 audit job 调用脚本且没有 `continue-on-error`。

### 3.2 `planDigest` 数据流

在 `SessionService.startRun()` 构造 workflow/goal 的 `WorkflowEngineStartInput` 时，若调用方提供非空 `planDigest`，原样传入 `engine.prepareRun()`。SessionService 不重新计算，也不接管 canonicalization。

`WorkflowEngine.prepareRun()` 在创建 run directory、Demand、Project、Workflow、Audit 等任何副作用前先解析 template/canonical plan，并校验 `input.planDigest`、兼容保留的 `options.planDigest` 与 `canonicalPlan.digest`：所有存在的值必须相等且等于 canonical digest，否则抛出稳定 `PLAN_DIGEST_MISMATCH`。现有 Web/CLI 双来源暂为兼容保留，但不再允许静默择一；后续可在独立清理中移除 options 旧通道。

测试覆盖：

- workflow 与 goal 均能透传；
- 未传时不凭空增加字段；
- 使用真实 WorkflowEngine/SQLite 的集成断言证明提供值进入 `workflow_instances.plan_digest`；
- 任意双来源冲突都在目录、DB、Audit 产生前失败；
- Web/CLI 既有 digest mismatch 和主路径 e2e 不回归。

### 3.3 Web clean guard 与拒绝 Audit

保留现有验证顺序：

```text
assertSessionToken
→ confirm literal
→ runId syntax
→ assertRunInScope
→ load run / active job / unreleased worktree leases
→ context.audit.append(project.clean.suspended)
→ throw CONFLICT(CLEAN_SUSPENDED)
```

Audit payload 只包含：`reason`、`runStatus`、可用的 `activeJobId`、未释放 lease id 列表；不包含 token、路径内容、环境或凭据。重复调用会追加多条拒绝 Audit；除 Audit 外的领域对象与全部文件保持不变。若产品要求严格去重 Audit，留给带 schema/idempotency key 的 #18，不在本轮伪造跨进程幂等。

`context.audit.append()` 的任何错误都在路由边界转成固定、脱敏的 `ApiError('INTERNAL_ERROR', 'CLEAN_AUDIT_FAILED: unable to record suspended clean request')`；HTTP 必须返回 500。Audit 成功后的挂起错误固定为 `ApiError('CONFLICT', 'CLEAN_SUSPENDED: project.clean is suspended pending lifecycle-safe purge')`；HTTP 必须返回 409。

测试覆盖：

- in-scope 合法调用返回 RPC `CONFLICT`/HTTP 409、run/worktree/Artifact/Gate/Delivery/Session 路径引用不变且出现安全 Audit；
- wrong token、wrong confirm、非法 runId、out-of-scope 均无目标 Audit；
- 注入 Audit 失败返回 RPC `INTERNAL_ERROR`/HTTP 500、固定脱敏文案且仍不删除；
- active automation/job/lease 存在时行为相同；
- 并发两次请求都不删除。

### 3.4 CLI clean guard

`commandClean()` 保留 `--repo` 解析和无交互初始化状态校验，随后抛出带固定 `CLEAN_SUSPENDED` 文案的错误；顶层现有错误处理将其写入 stderr 并返回 exit 1。此处不能调用会询问是否初始化的 `ensureInitialized()`，否则失败路径会写 stdout 并可能创建状态。删除 `readdirSync/rmSync/mkdirSync` 路径，确保 stdout 为空。更新 help 文案为“清理暂不可用（等待生命周期安全清理）”。

新增/更新 `packages/cli/__tests__/e2e/*.e2e.test.ts`，通过真实构建后的 CLI 进程证明：命令失败、工作树目录和内容完全保留、状态/日志命令仍可使用。相同语义补 unit test，避免 e2e 只验证字符串。

### 3.5 Provider health 拆分

在 shared RPC contract 中保留 `project.health` 的 `dshHeadless?` 为兼容可选字段，但新实现不再填充；新增 `project.providerHealth` 输入/输出 schema，`status` 仅为 `available|unavailable`。Project router 将 credential cache 与 provider cache 分开；provider endpoint 每次先认证，再按 scope/provider/token hash 查询有界 cache 和 single-flight。任何 probe 异常只映射为 `unavailable`，不向客户端透传 raw error。

TopBar：

- credential query 与 provider query 使用不同 key；
- provider query 仅在 credential 为 `valid` 时启用；
- token 改变或失效时旧 provider 结果不可跨 auth scope 复用；
- provider query 错误不把“凭据有效”降级为“校验失败”；
- 现有键盘、焦点、ARIA 文案保持不变。

API 测试用可观测 fake DSH 证明 credential health 从不 spawn probe；provider health 才执行完整 Version/Config/Help。另覆盖 missing/wrong token 不读 cache、不 spawn，token 轮换、TTL/容量、失败缓存、同 key 并发 N 次只 probe 一次。Playwright 验证连接徽标先进入“凭据有效”，随后独立出现 DSH 不可用提示，并验证 auth scope 切换时旧状态不可见。

## 4. 测试先行执行顺序

严格按下列顺序推进，每步先看到新增测试在旧实现上按预期失败：

1. Audit classifier/runner 与 Workflow contract tests → 实现脚本和 CI 接线；
2. Node 精确版本合同 test → 修改 matrix；
3. Web/CLI clean guard unit/integration/e2e tests → 实现 fail-closed 与 Audit；
4. SessionService planDigest unit + SQLite integration tests → 实现透传；
5. project/provider health API + TopBar Playwright tests → 拆分 RPC、cache 和 UI query；
6. 更新版本与文档，再运行相关回归；
7. 最高思考等级独立 reviewer code review；若有 must-fix，修复并重新 review；
8. 全功能验证与视觉检查；
9. 最高思考等级独立 reviewer 按报告问题清单做完成度 review；若有 must-fix，修复并重新 review；
10. 清点并只删除本轮生成的 `test-results/`、`playwright-report/`、临时截图、临时 repo/workspace 等产物；需保留的视觉证据先归档为可提交资产或 CI artifact，再检查 tracked、untracked 与 ignored 状态。

测试不得只断言 mock 被调用；必须同时断言外部可观察结果、持久状态和负路径。新增 CLI 命令行为必须进入 `packages/cli/__tests__/e2e/*.e2e.test.ts` 的真实进程路径。

## 5. 版本、文档与兼容性

### 5.1 版本

本轮包含实际行为变化：关闭两个清理入口、拆分 health RPC、修复 planDigest 数据流。按仓库 0.x 规则使用 MINOR：`0.20.6 → 0.21.0`。根 `package.json` 与 `packages/core`、`packages/cli`、`packages/web` 全部 lockstep；安装锁文件如受 workspace manifest 影响则同步，并由既有动态版本 smoke 验证扫描结果非空且全部一致。

### 5.2 文档

必须同步：

- `README.md`：清理暂不可用、健康状态分层、Node 已测集合；
- `CHANGELOG.md`：只记录用户可见行为和兼容证据，不复制评审过程；
- `docs/manual/tekon-user-manual.md/.html`：CLI/Web clean 返回、Provider 状态时序、当前限制；
- `docs/technical/tekon-web-architecture.md/.html`：把 `project.clean` 裸物理删除现状更新为本轮挂起合同；
- `docs/technical/tekon-v2-technical-plan.md/.html`：保留目标态说明，但标注 `tekon clean` 当前不可作为缓解措施；
- 第 22 轮报告 `.md/.html`：批注、代码 snapshot、验证结论；
- 本方案 `.md/.html` 与 `docs/reviews/current.md`。

仓内文档绑定被验证的代码 snapshot 与其 CI；包含文档自身的最终 commit/checks 由 PR #11 外部状态证明，避免自引用死循环。

## 6. 风险、回滚与后续边界

| 风险                               | 控制                                                                                   | 处置与回滚边界                                                |
| ---------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Audit 分类漏掉新的瞬态错误         | 只对明确分类重试，未知 fail-closed；保留完整诊断                                       | 分类导致稳定端点故障无法重试时，仅扩充有证据的 transport code |
| 禁用 clean 影响已有自动化          | 错误稳定、文档提前说明、目录完全保留                                                   | 不回滚到裸物理删除；只能前向实现 #18 lifecycle-safe purge     |
| provider health 拆分导致状态不一致 | credential 先决、独立 query/cache、可行动文案                                          | 若 UI 回归，保留 API 分层并回退展示，不重新串联凭据请求       |
| 精确旧 Node patch 依赖生态不可安装 | frozen lock + 独立矩阵输出真实失败                                                     | 不能把失败隐藏；需调整公开 floor 或依赖后再重跑               |
| planDigest 双来源冲突              | Web/CLI 继续在 admission 前计算并校验；WorkflowEngine 在任何副作用前做多来源一致性校验 | 冲突时 fail-closed，不静默择一                                |

本轮完成后仍保持开放：

- **P0 架构与产品**：#13 authoritative Session、#14 ACP slice、#15 quiescent executor、#16 single-owner runtime、#19 Collaborate→Deliver；
- **P1 合同与生命周期**：#17 DSH L3/pin、#18 export/retention/purge、#20 完整 RunPlan authority、#22 exception facts、#28 launcher、#29 剩余 capability、#31 atomic admission、#32 credential/proxy、#33 完整 purge；
- **治理与质量**：#21 a11y、#24 release governance、#25 CommandGateway、#26 semantic lint。

本轮不得把局部切片描述为产品整体通过。Issue 编号和完整状态以第 22 轮报告 §13 为准。

## 7. 预期交付证据

最终报告应包含：

- 变更 commit 与 PR Head；
- `pnpm test` 通过数、skip 理由；
- typecheck/build、CLI unit/e2e、Web unit/Playwright 结果；
- Audit 完整分类分支测试结果；
- Node 四腿最终 GitHub Actions 运行版本与终态；
- 桌面/移动截图或 Playwright artifact 路径及人工检查结论；
- reviewer 每轮 findings、处置和最终 `hasMustFix=false`；
- 未完成项及其 Issue，不把后续计划写成完成。

## 8. 执行记录

- **被评审代码快照**：`a843fc100037adce6fd1a86f6d9097ce95dd32fd`
- **实现版本**：`0.21.0`，根包与 Core/CLI/Web lockstep。
- **六项结果**：Audit 分类重试、精确 Node matrix 合同、Web/CLI clean guard、公开 `planDigest` 透传与副作用前校验、Credential/Provider Health 分层、正式文档同步均已实现。
- **本地全量验证**：`pnpm test` 151 files、1614 passed/1 skipped；全包 typecheck/build 通过；CLI e2e 8/8；Chromium 51/51；真实 production audit 返回零漏洞。Workspace manifest 版本变化未改变 `pnpm-lock.yaml` 内容，因此锁文件无需同步。
- **UI 验收**：320/390/700/1440 四档截图均无横向溢出、错位、重叠、裁切或状态展示错误；不外推为多浏览器、真实设备或屏幕阅读器验收。
- **评审结果**：方案评审、测试质量复审最终均为 `hasMustFix=false`；代码/安全复审唯一 must-fix 是权威报告旧结论，已由第 22 轮报告 §18 和 `docs/reviews/current.md` 回填并再次送审。
- **远端边界**：精确 Node 四腿与最终文档提交的 GitHub Actions 终态只由 PR #11 外部 checks 证明，本方案不预先声称成功。
- **残余风险**：完整 #20 RunPlan authority、#18/#33 lifecycle-safe purge、#28/#29 provider admission，以及 server/client 双层 60 秒缓存导致 Provider UI 最坏接近 120 秒重探测，均继续开放。
