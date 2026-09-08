# Tekon v0.26.0 发布前综合审核

审核日期：2026-09-08。基线：`main@86a3d48fcf54ea663b1ce3bdf86595187a425d1e`，拉取后已是最新；提交分支：`codex/release-audit-20260908`。本记录覆盖该 PR 中的代码、测试、角色指令和文档调整。

## 发布判断

本地自动化回归与人工视觉复核的结果见下表。已修复审批并发、取消信号、Claude 权限与提示、工作区租约恢复及 CLI 退出码问题，并精简检查列表、完善操作反馈和窄屏布局。可提交 PR 供人工合并评审；不能据此宣称所有真实 Provider、远端交付或生产场景全部通过。真实 Claude CLI 标准交付的最终结果与恢复证据在下文单独登记，历史 R26/R27 证据不替代本轮运行。

补充评估：PR #35 已合并；问题的发布影响、人工处置条件及 v0.26.1 诊断补修见[发布影响评估与补修验收](2026-09-08-release-followup.md)。原始计数与真实运行证据保留本轮快照。

## 五项审核与变更

| 范围 | 发现、处理与保留边界 |
| --- | --- |
| 代码与测试 | 将 required artifact 类型推导集中到一个 helper，删除未使用的内部 Gate 提示格式化方法；合并重复纯函数断言，保留合法/非法转换、失败恢复和真实 SQLite 竞争测试。公共导出不因静态引用少而删除。 |
| 正确性 | 节点重试复用有效直接租约，CLI 按 Job/Run 共同判断结果；Claude 将 policy 与 profile 交集编译为有限精确验证命令、保留 deny/ask，阻止自定义 args 覆盖权限；草稿助手关闭模型工具并正确解包结果。HumanGate 审批/拒绝使用 pending 条件更新，竞争失败先返回，避免重复修改 Gate/Node/Run；Codex/Claude adapter 向 CommandGateway 传递 AbortSignal，覆盖启动前取消和运行中终止。 |
| 功能与交互 | Overview 只保留一份检查列表，失败项优先且保留完整证据/建议；终态刷新后操作回执继续可见并可关闭；审批备注有唯一显式 label，错误反馈有 alert 语义。小屏门禁诊断改为可换行布局，避免长路径和建议命令被卡片裁切。 |
| 指令 | 压缩 AGENTS 与六个角色 system，角色 system 从 8190 降至 5487 bytes（约 33%）；保留 owner、artifact、Gate、独立评审、权限与升级边界。澄清节点内 TDD 与外层 artifact protocol 的执行顺序，避免互相矛盾。 |
| 文档 | 统一到产品范围、运行控制设计、运行时合同、用户手册及文档总索引；删除 114 个已追踪的旧过程/技术文档（106 个 reviews、8 个 technical），保留不可替代的正式验收、截图和历史 Git 链接。CHANGELOG 保留近期版本，旧全文链接到不可变基线。所有当前正式文档同步 HTML。 |

指令调整依据 [OpenAI 官方模型与提示指南](https://developers.openai.com/api/docs/guides/latest-model?model=gpt-6-astra)：资料建议检查累积指令的冲突与冗余，明确自主执行和交流边界，按任务需要选择工具、验证及委派。对 Tekon 的推断是将通用开发流程与产品节点协议分开，减少重复约束，同时保留可以落实到状态、产物和 Gate 的合同；这不是模型迁移，本次未修改 Provider 默认模型或推理等级。

## 验证矩阵

环境：macOS、Node.js 22.23.2、pnpm 10.12.1、Chromium（Playwright 项目配置）；依赖按 lockfile 安装。下列 pnpm 命令实际通过 `npm exec --yes -- pnpm@10.12.1` 调用。

| 验证 | 结果与证明范围 |
| --- | --- |
| `pnpm test --run --maxWorkers=4` | 194 文件、2241 通过、1 条条件跳过（未配置 DSH_CLI_PATH 的真实 DSH probe）；包括 core/CLI/Web 单元、状态与真实进程测试，不等于所有外部 Provider 已连通。 |
| `pnpm --filter @tekon/cli test:e2e` | 9 文件、33 通过；该命令先构建 CLI，再验证 init → workflow → status/log/clean、审批、恢复等真实进程路径。 |
| `pnpm --filter @tekon/web exec playwright test --retries=0` | 最终完整 211 项全部通过，无自动重试，耗时约 5.6 分钟；包括初次完整 209 项之后根据人工视觉发现新增的两条诊断裁切回归。随后补齐 PMO/test-plan 的模型提示与 core/CLI 恢复边界，Web 界面与 API 路由源码未改，后续恢复行为由根测试及 CLI e2e 覆盖，沿用该浏览器证据，并重新执行根测试和 CLI e2e。 |
| `pnpm build` / `pnpm typecheck` / `pnpm lint` | 全部通过；权限与草稿助手修复后全部重新通过（本仓库 lint 亦为 tsc --noEmit），根测试再次完整通过。 |
| 生产依赖 audit | 当前 lockfile 的生产依赖审计通过，无已知生产依赖漏洞；不等于全面安全渗透测试。 |
| Claude CLI 只读 smoke | 1 项通过，验证 provider 调用及标记输出；CLI 2.1.250，耗时约 5.46 秒。不替代代码交付。 |
| 真实 Claude CLI standard-delivery | 新 Run 经两次普通恢复后 16 节点、44 Gate 全部通过；本地 PR 准备与 pre-PR readiness 通过。完整 readiness=0.82、ready=false，仅缺远端 PR/CI，详见下文。 |

## 失败、修复与复测

- 初次全量测试与浏览器并行导致资源压力，出现超时；macOS `/var` 与 `/private/var` 的同一物理目录还导致 10 条路径断言失败。临时根路径改为真实物理路径，再按单一 owner 顺序运行各套回归；没有放宽 home/worktree 隔离断言。
- 首轮浏览器 202 项中 201 通过，`create-pr-approval` 在 20 秒等待上超时；隔离后通过，相关 R27 + 创建 PR 用例 13 项无重试通过，随后全套 209 项无重试通过。该测试模拟远端服务，不声称创建过远端产品 PR。
- 新增回执状态暴露了旧测试依赖 useState 序号的问题；测试改为通过真实确认控件回调及状态 setter 验证恢复确认绑定，不改生产恢复语义，13 条专项回归通过。
- 草稿助手原以 `bypassPermissions` 调用 Claude，绕过工具审批。改为 default、空内置工具、拒绝 MCP 工具且只加载空 MCP 配置；两个入口复用同一调用，失败保留静态回退。真实子进程 argv 与结果测试先出现 4 条失败，再全部通过；同时修复外层 JSON 被直接返回、`result` 未被解包的问题。此测试证明调用合同，宿主 hook 与 OS 副作用不在该层证明范围内。
- 真实 PMO 将 41 条 Gate 的稳定 key 重构为 `schema:00` 等短标识，process-completeness 正确阻断。权威结果提示省略了 gateKey，只有节点定义中的拼接格式间接提供。PMO 结果改为可直接复制的 nodeId/gateType/gateKey/status JSON，缺 key 时登记 missingInformation；QA 保留 gateResultId 格式，严格 Gate 未放宽。扩充既有真实数据库提示测试，覆盖同类型不同 key、passed/skipped、失败排除及缺失 key：先 1 失败/10 通过，再 11 项全部通过。原始错配见 [PMO key 失败证据](evidence/2026-09-08-release/pmo-key-failure.json)。
- 阻塞节点重试的真实 Git RED 证明第二轮新建工作区、活动租约变成 2 且原修改不可见；修复后同路径、同租约、保留修改并能跨新引擎恢复。直接租约冷/热身份校验补齐重复、角色错配和最新事件错配；82 条恢复专项通过。旧 manager stub 按生产合同补齐租约持久化，再验证 ownership fencing。
- CLI 真实进程回归先核对持久化 Job=failed、Run=running，再判断退出码与日志指引。初始夹具缺少 build/lint 导致前置 Gate 正常阻塞，原 0/1 失败不能证明目标缺陷；补齐夹具后两条通过。随后临时恢复旧的 workflow-only 编译映射、保持相同前置断言，两条均在退出码 0/1 处失败，证实回归有判别力；compiled 文件随即恢复。cancelled Job 的补充边界先 1 失败/9 通过，再修实现，合法 paused/blocked 不误判失败。
- 真实 QA test-plan 把 10 条 testCases[].method 填成命令文本，原 schema 正确拒绝；节点提示未列出该可选字段的枚举。补齐 unit/integration/e2e/manual/static 及命令放 description 的说明，已有集成测试先 1 失败/10 通过，再 11 条通过；schema 未放宽；普通 resume 后该 QA 节点及其 Gate 已通过，见[字段失败证据](evidence/2026-09-08-release/claude-test-plan-method-failure.json)。
- Claude smoke 归档日期原本写死为 2026-06-05；改为使用本次执行日期，先验证失败再修复，2 条生成器测试通过。
- 人工视觉复核发现 320px 门禁诊断卡片内摘要与建议命令裁切。整页 scrollWidth 断言无法发现卡片内部 overflow；补充具体文本与卡片边界断言，两档有效 RED 均失败，修复后 6 条 Overview 专项通过；保留修复前截图说明测试缺口。

## UI 视觉与人类操作复核

按当前[运行控制设计](../design/tekon-run-control-design.md)检查受控交付入口、Session、运行列表与详情、审批、交付、配置、评估共 8 类页面，在 320/390/600/601/768/769/1440px 共 56 张全页截图中检查布局，并展开查看小屏运行详情与审批的文本、命令和按钮。检查项合并、暂停/恢复回执及新的诊断换行另外保留截图，共归档 72 张。当前 7 份固定 HTML 文档另经 320/390/1440px 共 21 次布局检查，修复 SHA-256 页脚长串导致的横向溢出后全部通过，结果见 [HTML 布局记录](evidence/2026-09-08-release/docs-layout.json)。

窄屏运行表、配置表和标签栏保留容器内横向滚动；测试将操作列滚入视口并验证按钮可达，不能将这类设计内滚动描述为页面裁切。长审批摘要允许纵向延展；主操作保持可见且能点击。修复后的截图和几何断言只能证明这些固定页面、状态与视口，未做全页面逐像素 golden 对比、系统读屏、WebKit/Firefox、触屏真机和生产负载验收。早期概念 mockup 作为历史视觉参考，当前页面职责与控制合同以固定设计文档为准。

证据入口：[证据摘要](evidence/2026-09-08-release/summary.json)、[截图目录](evidence/2026-09-08-release/pages/)、[验证日志](evidence/2026-09-08-release/logs/)、[修复前诊断裁切](evidence/2026-09-08-release/triage-before.png)。

## 真实运行与风险 Gate

Run：`run_41edcd7e-aa0b-44d9-8b82-39939485f459`，模板 `standard-delivery`，agent `claude-code`。任务是将独立无依赖 ESM 仓库 `sum` 的减号修复为加号，保持有限数 TypeError 校验，使用既有四条测试覆盖正数、负数、零和非法值。不涉及远端 push/PR/合并或生产权限。该最小 fixture 的 build/lint 均为 `node --check math.js`，安全检查使用 `tekon-builtin` 扫描器；其证据不扩展为复杂应用的质量或安全验收。

初次运行三个 PM 节点通过、8 个 schema/independent-review/role-scope Gate 通过；第四个 RD 接口评审的 Tekon adapter 返回 exitCode=1，因此 Run 正确进入 interrupted，Job 保留 managed-handles-closed 退出证据及最后 checkpoint。该子进程 stdout 报告 success，但原始工具 Write 中的 artifact 含未转义双引号，只读解析报 line 3 column 793，导入拒绝后 adapter 返回 1，见[首次产物失败证据](evidence/2026-09-08-release/claude-initial-artifact-failure.json)。stderr 的 `claude-code:unrecognized_model` 同时存在于已通过节点，不是本次失败归因；实际模型标识为 `deepseek-v4-flash`，因此本记录称其为真实 Claude CLI 调用，不将其冒称为 Anthropic Claude 模型验收。

第一次普通 resume 复用已通过节点并推进至 12 节点、32 Gate 通过；QA validation 在两次恢复中均达到本轮显式设置的单节点 180 秒总时限（exit 143、timedOut=true、timeoutReason=total）。排查原始工具记录发现两次记录中涉及 `npm test`、`npm run build`、`pnpm test`、`node --test` 与 `node --check` 的尝试均返回 “This command requires approval”；`acceptEdits` 不自动授予普通 Bash 命令。窄化证据见 [QA 命令审批阻塞](evidence/2026-09-08-release/claude-qa-permission-denials.json)，保留原始时间与会话标识，不包含完整对话或环境配置。

本次修复将结构化 command policy 与 Provider profile 取交集，仅新增有限精确验证命令的免审批规则，并保留 deny 与人工 ask；Claude 的内置只读规则和宿主授权仍独立生效。专项先出现 40 条 RED；审阅新增边界后曾有 65/66 通过，剩余原生 Agent deny 转换错误已修复，66/66 复跑通过，最终完整根回归另留日志。实现依据 [Claude headless](https://code.claude.com/docs/en/headless)与[权限规则](https://code.claude.com/docs/en/permissions)，没有采用绕过审批模式。普通恢复后的 QA validation 已通过，实际 `npm run build` 与修复态 `npm test`（4/4）成功，缺陷基线 `npm test` 复现 2 条预期失败；[命令级记录](evidence/2026-09-08-release/claude-qa-command-success.json)与节点产物相互印证。QA 及签署复核后累计 15 节点、41 Gate 通过，最后 PMO 在开始写报告时达到本轮显式 180 秒总时限，再次保留 checkpoint 并中断；这与此前 QA 命令审批根因分别登记。PMO 普通恢复后按时生成报告，但因 41 条 key 错配而被 Gate 阻断；已按上文修复提示输入，补齐输入后的报告已逐字保留全部 41 条前序 key（额外含本节点上次 schema，共 42 条），只读核对无缺失，见 [中断产物核对](evidence/2026-09-08-release/pmo-key-partial-fix.json)；但约第 166 秒才写出 14.5KB checkpoint，随后仍触及 180 秒总时限，Provider 未完成，不能将静态核对记为 Gate 通过。精简 PMO 正文后的恢复又暴露了两个实现问题：阻塞节点重跑创建重复活动租约，之后冷恢复因租约歧义被正确拒绝；失败 Job 留下 running Run 时 CLI 原先仍返回 0。已修复直接租约复用和 CLI 退出码，保留严格身份校验，未人工修改原数据库或清理冲突租约来冒充恢复成功。原 Run 保留为失败边界证据。原始临时数据库不提交，归档 run id、节点/Gate 状态、窄化错误证据与 eval 摘要。

新的完整预算运行 `run_6ba76d14-6f6d-4998-9cf5-4466b5ecb297` 从同一干净缺陷基线独立开始，单节点总时限 600 秒、无进展时限 300 秒。先后遇到 RD 产物非法 JSON 与 QA test-plan 的 method 枚举错配，分别保留[原始格式失败](evidence/2026-09-08-release/claude-final-artifact-failure.json)及[字段失败与恢复](evidence/2026-09-08-release/claude-test-plan-method-failure.json)；通过两次普通 `tekon resume` 继续原 Run，没有人工改产物、数据库、Provider 快照或校验结果。最终 **workflow=passed、16/16 节点通过、44/44 Gate 通过**，包括 build/lint/test/security-scan、AC 证据、QA 签署与独立复核、PMO process-completeness。PMO 按原样引用持久 Gate key，本轮完整性检查通过。

该 Run 只修改 `math.js`，交付提交为 `8ab2b6a43c2a8274151da01adfd8ca94e10b7784`。三份代码/测试/包配置与此前独立验证过的提交逐字一致，因而复用其 4/4 测试、build/lint 结果，并有新 Run 自己的质量 Gate 印证，见[代码身份核对](evidence/2026-09-08-release/fixture-code-identity.json)、[真实 Gate 输出](evidence/2026-09-08-release/live-quality-gates.json)和[QA/PMO 产物](evidence/2026-09-08-release/live-quality-artifacts.json)。

随后正常执行 `delivery prepare`，本地 PR package/body 生成成功，`requiresHumanApproval=true`；pre-PR readiness 的检查全部通过。完整 `eval readiness` 得分 `9/11 = 0.8182`（CLI 显示 0.82），`ready=false`，仅缺 `pr-created` 和 `remote-ci-passed`。测试仓库未配置远端，也未执行 push、创建 PR、合并或上线；这两个缺项不是已通过事项。详见[readiness 明细](evidence/2026-09-08-release/live-readiness.json)和对应 CLI 日志。该样本证明本地标准交付及可恢复路径，不能当作无人工介入、跨 Provider 或远端发布的完整验收。

## 未覆盖与人工发布边界

- 修复避免新重试继续制造重复租约，但不会自动选择、删除或重写已有冲突租约；旧 Run A 的 latest Job=failed、workflow=running 是需人工核查的历史状态，不能据此认为仍有 Agent 执行。
- 本机无可用 Codex 与 DSH CLI，因此未获得本版本对应的真实全链路证据；相关 adapter、桥接契约和中断行为由测试覆盖，历史报告仅证明历史快照。
- `roles/*/tools.yaml`、`permissionProfile` 与顶层 CommandGateway 并非 Provider 内部工具、网络或 OS 级强隔离；这是一项已知能力边界，已在固定产品/技术/手册中澄清，不能作为沙箱产品宣传。
- 产品自己的 push、创建 PR、合入、上线及权限扩大仍需人工控制。本次代码 PR 由用户明确要求，属于仓库开发交付，不修改该产品合同。
- 安装/更新脚本未变更，故没有重复执行脚本变更要求的干净安装专项；本轮实际完成依赖安装、构建及 CLI 版本检查。跨 OS、其他 Node 主版本、远端 CI 以 PR 检查结果为准。

## 文档与产物交付

代码、测试及最终报告已完成独立复核，必须修复项已清零；530 个源码哈希、验证计数和真实运行证据已交叉核对。README、CHANGELOG、用户手册及相关产品/设计/技术文档已随用户可见行为同步，版本统一为 v0.26.0。保留 R26/R27 与历史真实交付记录的原始时点，避免将旧证据回填为当前通过。仅此正式报告和可复用证据进入 docs/reviews；调试脚本、浏览器临时结果和测试仓库在归档后清理，重点移除本次创建的 `tmp/`。
