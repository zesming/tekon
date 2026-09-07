# 第 27 轮整改验收：排队恢复、Gate 关停与交付证据

2026-09-06 建档 · 2026-09-07 收尾 · v0.25.0 · [PR #11](https://github.com/zesming/tekon/pull/11) · [原报告及维护方批注](2026-09-06-tekon-product-runtime-harness-twenty-seventh-review.html)

本轮基于 `31680f9bfd9424dd6466734ac97a8d172debfa42` 补齐排队恢复竞争、运行控制反馈和真实交付中暴露的 Gate 关停恢复缺口。以下分别记录实现、测试、真实模型和人工查看的证明范围，不以 Run 通过代替远端交付就绪。

## 1. 已落地行为

| 场景 | 最终行为 | 验证入口 |
| --- | --- | --- |
| 恢复读到 queued 后，另一执行者按 paused 排空原 Job | 同一 SQLite 事务复核 Admission/Run/最新 Job/确认代次；仍 queued 复用，已排空新建恢复 Job，已认领返回 active-job | `queued-pause.test.ts`、`queued-resume.e2e.test.ts`；workflow/goal、终态竞争与独立 OS 进程 |
| 暂停、恢复和失败反馈 | 表达请求已记录或恢复已受理；错误保持可见，状态允许时可按提示重试；终态竞争显示真实 ended 结果，共用提交锁防重复 | `r27-control-feedback.e2e.test.ts`；四视口、键盘、去重、错误及三终态 |
| 首次 Gate 中正常关闭服务 | Run interrupted、Node awaiting-gate，保留原 lease、已完成 RoleRun 和 Artifact；恢复仅继续 Gate | `run-recovery.e2e.test.ts` 的 block/fail/autoFix 三配置；真实默认执行器/Git/子进程 |
| 迟到的 Gate 成功、失败、throw 或修复结果 | 先处理关停/取消，不再启动修复、耗尽重试或新的提交；已完成的 Git 写入按持久证据收尾，普通质量失败和 timeout 保持原合同 | `gate-shutdown.test.ts`；入口、结果、修复、异常、finalize 前后 |
| 自动修复完成后 Gate 被打断 | 校验持久修复链，恢复对应 worktree；活动原 lease 优先，缺失或歧义明确阻断，不能回退主仓库 | `lease-service.test.ts` 与真实进程 repair→Gate 关停→重启；cwd/lease/产物/RoleRun 身份断言 |
| 提交释放后节点完成前关停 | 只凭本次执行完整的 promoted→released 证据完成收尾；未落地的合法 repair intent 不遮蔽原节点身份 | 原 lease/repair lease 两类真实进程用例；连续两次关停、三个独立宿主 |

这里的“跨宿主”指同一 Linux 机器上的独立 Node 服务进程重新打开同一 SQLite 和 Git 仓库，不表示跨机器迁移。关停不同于主动取消：`cancelled` 保持不可恢复终态。修复 Agent 本身未完成时按实际状态处理，不保证跳过 Agent；无 worktree manager 的原兼容路径保留。

## 2. 设计、红灯与独立审阅

[初始方案固定快照](https://github.com/zesming/tekon/blob/a05925a33e4f82bd1c4d08416fd803cead5874b3/docs/superpowers/plans/2026-09-06-r27-delivery-plan.md)在实施前获独立 reviewer 放行。新增 Gate 关停问题由真实 Claude 任务发现，补充设计再经独立审查：在现有 Gate/Node 边界区分控制中断与质量失败，利用已有 Gate、Node、lease 和 Audit 恢复关联，不增加状态表或迁移。

测试先行保留了以下失败证据：queued 恢复的 workflow/goal drain 交错及过期确认；控制提示与错误常驻；首次 Gate 三配置关停；repair 后重启错用主仓库 cwd；错误/歧义 lease 关联；修复意图和 finalize 关停的组合。测试夹具未命中 finalize 窗口时，改为等待生产 executor 的 abort 信号建立确定性屏障，没有放宽运行状态断言。

代码与测试由实现者之外的 reviewer 循环审阅。审阅要求补齐 repair lease 持久关联、当前原 lease 优先、已提交释放的正常收尾、未落地 repair intent 的连续关停恢复，以及无 worktree manager 兼容边界；最终 6 文件 82 项定向通过，reviewer 明确无剩余必须修复项。最终全量结果见下节。

最后人工查看原始 320px 截图发现检查证据及长审计链接在卡片内部裁切，整页宽度检查曾漏报。补充设计和文字 Range 边界红测后，采用窄屏检查行分行、证据与链接换行；新增 769px 断点还复现侧栏将 Runs 撑出页面，主内容基础规则允许收缩。通知背景经浏览器计算样式确认本身不透明，透字来自入场动画中间态，因此只稳定截图并补回归，没有添加冗余背景样式。以上切片由另一 reviewer 独立复查。

第一次真实 Claude 交付失败的 Run 为 `run_e25f5865-658e-4255-bf6a-3733d3a69d84`：Agent passed、Job interrupted 且 managed-handles-closed，但 Run/Node blocked。该尝试是修复依据，不计为验收成功；[脱敏失败摘要](evidence/2026-09-06-r27/claude-delivery-first-failure.json)保留了 Run/Node/RoleRun/Gate/Job 记录。

最终逐项审阅还发现普通修复 Agent 异常后，已释放租约使剩余重试预算提前中止。补充方案先获放行，再以真实 Git 用例复现（4 fail/1 pass）：新建原节点工作树执行复查，覆盖直接通过、失败后第二次修复、预算耗尽、关停后新引擎沿原租约恢复，以及提交失败保留真实错误。随后补租约创建后关停窗口，红测证明会重复 Agent；仅对完成 Agent、合法原节点租约且其创建晚于最后修复失败与修复意图的 checkpoint 恢复 Gate，后续 repair intent 撤销该资格。相关 4 文件最终 76/76；新引擎用例与已有独立 OS 进程用例分别说明，不混为跨进程证明。

## 3. 最终本地验证

| 命令 | 最终结果 |
| --- | --- |
| `pnpm build` | 通过 |
| `pnpm test --run` | 191 文件；2176 passed，1 项既有 opt-in skipped |
| `pnpm typecheck` / `pnpm lint` | 均通过 |
| `pnpm --filter @tekon/core test:e2e` | 12 文件，65/65 |
| `pnpm --filter @tekon/cli test:e2e` | 内置构建通过；7 文件，25/25 |
| 完整 Chromium，`--retries=0` | 202/202，0 flaky、0 skipped |

各命令覆盖有交集，不将这些计数相加作为独立用例总数。最后仅修正两处源码注释的文档章节号，随后全仓测试再次通过；未改变执行逻辑。

验证命令由主代理顺序发起，Vitest 内部沿用仓库并发配置；Chromium 最终运行设置 `--retries=0`。首次全仓运行曾有一项 SCM 用例超过原 5 秒超时，其余 2128 项通过、1 项既有 opt-in 跳过；单独复核 SCM 18/18，随后最终全量结果以本表为准。未增加超时或重试，也未把孤立重跑当作全仓通过。

新增 lease 守卫后的第一轮全量还发现 4 项失败：rework 在审阅 Gate 前提前释放工作树，已改为所有 Gate 通过后统一释放并断言实际 cwd；3 项 Web 审批测试使用缺少 lease 的手写 checkpoint，已补真实活动 reviewer lease 与创建审计、完成的 RoleRun，保留最终 passed 断言，没有放宽生产守卫。这些失败与后续成功分开记录。另一次 clean 夹具审计数断言及 Delivery 页签严格定位失败分别修正精确预期和定位器；未删除审计、内容或导航断言。

最后顺序验证中的 Chromium 进程曾在 202 项中的 188 项已报告通过后以 143 终止，没有完整报告，也没有已确认的测试失败或终止原因；该次不计通过。确认无活动测试进程后，单独重跑完整 Chromium，最终以表中完整结果为准。

最终命令、时间、退出码、测试计数与日志摘要见[验证索引](evidence/2026-09-06-r27/verification.json)。生产代码摘要绑定到本次源码；未改安装脚本、依赖或数据库 schema，不另行执行安装 smoketest。

## 4. 真实 Claude 交付与恢复

实际使用 **2.1.263 (Claude Code)**，于 2026-09-07T03:00:20.418Z 至 2026-09-07T03:01:21.970Z 完成最终样本。Run `run_17ac4d83-7e8a-45a2-bf5a-2fc72f5822ef`，首次 Job `job_2366efae-820e-41ca-a042-eeefccd17a34`，恢复 Job `job_e2f7e690-1c05-4a74-9252-99fb0de0686c`；两个独立服务宿主 PID 为 `3810931` / `3816312`，最终 Git commit `f7ac4b79968e44eb44e906be010e5566fd8f8a10`。关停后重新读取并归档的 Run 为 interrupted、Node 为 awaiting-gate，最终 Run passed、Audit valid。源码摘要绑定本次实际执行的六个 Core 恢复文件；Web 验证由浏览器证据承担。

[真实交付 JSON](evidence/2026-09-06-r27/claude-delivery.json)记录两个宿主的 Run/Job、Gate、RoleRun、Artifact hash、lease、Git commit、Audit 和 eval。该样本使用单 RD 节点的自定义工作流，验证代码修改、产物、检查与恢复，不等于完整 standard-delivery 流程。模型只修改隔离项目的 `src/add.ts`，将减法修正为加法；保护文件 `build.cjs`、`test.cjs`、`package.json` 的 hash 未变，源代码 diff 只有该文件。

首次构建 Gate 用 marker 控制关停窗口，尚未开始 TypeScript 编译时正常关闭宿主；受管理 Gate 进程实际退出。恢复宿主不再调用模型，沿用同一 Run、RoleRun、Artifact 和 lease，实际执行 TypeScript 编译及 3 项算术断言，随后提交工作树并释放。控制等待不冒充长时间编译被中断，也不代表任意进程、平台和负载均已验证。

readiness 为 **false**：workflow、Audit、实际 validation gates、delivery-package、无待处理 human gate 共 5 项通过；PR 准备、PR 创建、远端 CI、验收标准证据、QA 签署、安全扫描共 6 项未通过。没有为了获得全绿而删除这些检查；样本不执行 push/PR。

## 5. Web 交互与截图查看

完整 Chromium 覆盖受理/原身份重试、计划刷新、凭据与 Provider 检查、Session 观察、暂停/恢复/取消、审批、交付和错误恢复。新增页面矩阵覆盖 320/390/768/1440px 下的 Sessions、Session、Runs、Run、Approvals、Delivery、Config、Eval，加测 600/601/769px 断点，共 56 张页面截图，另有 8 张本轮暂停/恢复反馈截图。

主代理实际查看七档页面缩放总览，并检查原始 320px Session、Run、暂停/恢复通知与 769px Runs 截图。检查证据完整换行，长链接保持在卡片内部，稳定通知不透出背景文字；侧栏恢复后页面宽度正常，操作仍可达。自动检查另外覆盖文字 Range 与卡片边界、hover/focus、通知透明度和实际证据导航，弥补只检查整页宽度的缺口。

键盘测试进一步发现语义证据锚点未被 Web 路由消费。沿用既有页面，将六类链接映射到实际产物、门禁日志、审计事件及 Delivery 的 PR 正文、包和差异章节，定位并展开目标；不存在、读取失败、筛选隐藏均给出明确反馈。相关回归断言实际内容、活动页签与焦点，不用 URL 相等代替导航完成。

[截图入口](evidence/2026-09-06-r27/pages/index.html)与几何数据随仓库保存。窄屏 Runs 表格保留既有局部横向滚动，测试先滚动到操作列再检查可达性；没有隐藏列来让检查通过。控制反馈截图通过受控 RPC 响应检查回执和状态控件；其中 readiness 卡片保留夹具结果，不作为后台真实推进或就绪度重算的证据。Session 夹具显式写入 awaiting-approval 状态，与暂停 Run 和审批事件一致。几何检查和截图查看只覆盖指定数据与视口，不是实际读屏、其他浏览器或其他 OS 验收。

## 6. 上游与长期边界

deepseek-harness 已同步并核对至 `d347e703908d0406b7a7ef80e3a0e594d86b2215`，独立评估与维护方达成一致：GitHub 已有 [0.1.3-alpha.1 Release](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.1)，截至 2026-09-06 对应 npm 查询 E404；源码、Release、可安装包分别判断。Tekon 保持已验证 CLI 固定版本 `0.1.2-alpha.3`，它的内部依赖范围不能锁定整棵安装树。

SDK 的 initialize/session-prompt/shutdown 不等于 ACP 的取消、Session 关闭和权限问答；两者均不能凭接口名称证明完整历史重放。上游 [Safety](https://github.com/deepseek-ai/deepseek-harness/blob/d347e703908d0406b7a7ef80e3a0e594d86b2215/SAFETY.md) 仍声明未经安全审计。DSH Node 要求与 Tekon DSH preflight 一致，不能套用 Tekon 自身更宽的 Node 范围。本轮未升级 DSH pin、未做新的 DSH L2/L3，也没有增加宿主代理变量透传。

[#17](https://github.com/zesming/tekon/issues/17) 继续负责实际完整依赖树/lock/integrity 与新版本兼容性；[#18](https://github.com/zesming/tekon/issues/18) 的完整只读导出、[#14](https://github.com/zesming/tekon/issues/14)/[#19](https://github.com/zesming/tekon/issues/19) 的持续协作，以及平台隔离、生产负载、逃逸进程与全部外部副作用，均未因本轮绿色回归标为完成。

## 7. 文档归并与清理

| 过程内容 | 现行维护入口 |
| --- | --- |
| 用户、场景、人工控制、当前能力及后续范围 | [产品范围](../product/tekon-current-product-scope.html) |
| RunPlan、Admission、Session/Job、owner fence、退出与恢复、Harness | [运行时合同](../technical/tekon-runtime-contract.html)、[ADR](../technical/adr-0001-runtime-authority-and-collaborate.html) |
| 页面责任、受理回执、运行控制、错误、刷新与可访问性 | [运行控制设计](../design/tekon-run-control-design.html) |
| 如何操作及判断结果 | [手册 §7.1 中英](../manual/tekon-user-manual.html)，同步 README 与 CHANGELOG 0.24.1/0.25.0 |
| 本轮方案、失败与最终验收依据 | 本报告、R27 追加批注与脱敏证据 |

删除归并后的 39 份旧过程文件及本轮方案 MD/HTML，共 41 份。旧技术大方案、Web 架构和 Cockpit 原型明确标为历史；正式历史 reviews 保留，旧计划引用改为归并前固定提交链接。产品版本升为 0.25.0，依据是新增用户手册章节；根 package.json 仍为唯一版本来源。

文档审阅分工与限制：doc_reviewer 实际审阅了运行控制设计和运行时合同；其扩大范围调用多次返回旧文件内容，没有视为整体放行。随后由另一独立审阅代理读取 README、产品范围与设计全文、CHANGELOG 0.25.0，以及手册本轮新增中英内容和相关操作章节。Advanced 刷新口径、英文源稿缺失、取消终态歧义已修正并复查通过。技术 reviewer 另核对 JobRunner.stop 与组合根 markClosed/close 的边界，关闭先前 P2。最后 doc_reviewer 又实际审阅运行时合同，提出拆分长段、说明术语等意见；其“巡检逐步退避”建议与游标分批扫描实现不符，改为准确解释扫描末尾回头。该角色复查返回空，没有据此声称全范围放行；另一独立代理实际复查 README、产品/设计全文、CHANGELOG 本轮条目、手册新增中英和相关操作段，并核对 runtime 全文及 HTML。手册旧文“先取消再恢复”的歧义已关闭。Markdown/HTML 正文一致性、章节、链接与占位检查不计为应用行为验收。

清理清单见[文档迁移索引](evidence/2026-09-06-r27/documentation-cleanup.json)。最终验证摘要、失败样本、Run/Job/lease 身份及截图已经迁入正式 evidence；已清理本轮 `.tekon/r27-work/`、浏览器 test-results、六个经任务内容确认归属的 Provider 临时仓库和本轮文档脚本，未删除用户运行数据。见[临时产物清理记录](evidence/2026-09-06-r27/execution-cleanup.json)。

## 8. 用户要求对应与交付门槛

| 要求 | 对应完成项 |
| --- | --- |
| 0 同步上游并循环评估 | §6 与原报告 §10.4；独立评估达成一致 |
| 1 追加有证据的批注 | 原报告 §10.1–10.6，保留原作者观察时间与证据范围 |
| 2–3 整体调整、先方案审阅 | 初始固定方案与 §1–2 补充设计；无新增控制平台或迁移 |
| 4 测试先行、e2e 与代码审查 | §2–3；独立代码/测试复查放行 |
| 5 全功能 e2e 与 UI | §3、§5，真实测试与截图范围分别说明 |
| 6 按报告逐项审阅 | 独立总 reviewer 已按 0–7 核对最终代码、文档、测试、真实 Provider、截图与清理证据，本地验收放行，无剩余必须修复项。远端步骤仍以下述 Head 检查为前置。 |
| 7 归并文档、清理、原 PR、合入 | §7；本地完成后的提交、PR Head CI 终态和合并结果必须独立回读 |

本报告记录本地验收，不提前宣称尚未发生的远端 CI 或合并成功。用户已授权提交 PR #11 并在检查通过后合入 main；提交后读取该 Head 的 Core/CI 及九个 CI Job 终态，全部成功才合并。该授权不改变 Tekon 产品内 push、创建 PR、合入、上线和高危动作的人工控制边界。
