# 第 26 轮整改验收：取消恢复与安全重启

2026-09-06 · v0.24.0 · [PR #11](https://github.com/zesming/tekon/pull/11) · [原报告及追加批注](2026-09-05-tekon-product-runtime-harness-twenty-sixth-review.html) · [执行方案](https://github.com/zesming/tekon/blob/31680f9bfd9424dd6466734ac97a8d172debfa42/docs/superpowers/plans/2026-09-05-twenty-sixth-review-remediation-plan.html)

本轮以 `8141c4b69fb59988ff7c7e6266f3d5639c386131` 为工作基线，补齐取消观察恢复、持久重试入口、过期租约的安全处置、退出证据与显式恢复。本地全仓测试、完整 Chromium 和真实 Claude 生命周期均通过，独立 reviewer 已按用户要求 0–6 逐项核对并放行，无必须修复项。第 7 项的提交、远端检查与清理按实际交付另行核对；本记录不复用历史 CI 结论。

## 1. 已落地行为

| 场景 | 现在的行为 | 证据 |
| --- | --- | --- |
| Run 已取消，但 Job 投递或观察写失败 | 同 Run 重试；后台有界补发；Session 与缺失取消事件同库事务协调 | `run-recovery.test.ts` 的故障、回滚、幂等及 105 项候选公平性测试；两个独立 OS 进程并发取消只提交一对事件 |
| 旧 owner 租约在快速重启后才过期 | 已认领 Job 转 interrupted，Agent/Gate 不自动重跑；在线 Session 收到持久 job/status 通知 | 真实 orphan Gate、快速重启及已连接 SSE/SQLite 回归 |
| 退出未确认 | 旧 stopped、历史空证据保持未知；人工确认绑定最新执行 Job，历史无 Job 必须显式 null/CLI none | 代次与事务竞争、同毫秒 +1ms、automation 排除、null 身份、CLI 真实进程回归 |
| 确认后继续原运行 | 保留原 Worktree 与完成的 Agent，恢复未完成 Node 或继续 Gate；无需二次恢复 | 生产 executor/Gateway 双进程 e2e 与真实 Claude 显式恢复 |
| 旧执行迟到写入 | WriteQueue 在实际写入事务中检查 Job/owner；独立事件订阅者不继承发布者租约 | 旧 executor 在下一次 poll 前写入被拒；延迟 readiness 正常入队 |
| 审批与取消竞争 | Run 终态 CAS 保留取消赢家；已记录的审批与尚未恢复分别反馈 | Core human-gate 三路径、CLI/API SQLite trigger 竞争及后续写失败回执 |
| 用户取消、重试与确认 | 取消需在 3 秒内二次点击，退出未确认时，恢复需显式勾选确认；错误与恢复说明持续可见，列表/详情/Session 使用同一服务端恢复快照 | Client 定向回归；四档视口的 Chromium 键盘、刷新、竞争、列表确认和部分成功场景 |

退出证据只覆盖 Tekon 管理的执行句柄。`managed-handles-closed` 需要生产执行器排空且本 Job 所有管理句柄收到 close；kill、注销句柄、租约失效和人工确认均不能单独证明物理退出。没有新增取消状态表、daemon 或全域 outbox。

## 2. 独立审阅关闭的问题

独立设计复评先核对原 R26 报告、SQLite 故障复现与孤儿 Gate 实进程诊断。最终选择现有轮询内有界协调、按 Job 的退出证据、未知退出显式确认及事务内复核代次；否决周期 requeue、第二张取消状态表和全域 outbox。设计放行后按方案测试先行实现；owner fencing、终态 CAS 等新增边界同步补充进方案，再由实现者之外的 reviewer 审查代码与测试。

初次审阅确认并修复了三类缺陷：CLI 审批无条件写 running 会覆盖取消；过期 Job 转为 interrupted 时缺少通知，页面也未随 job/status 事件刷新；已完成的取消仍反复更新时间。对应新增测试均先失败后通过。时间幂等修复避免历史取消显示“刚刚”，也避免不必要的列表刷新。

浏览器与审阅还发现并修复了长错误挤压标题、窄屏审批列和证据长词越界、桌面 Session 窄侧栏命令被三列挤压、Session 标题与权威状态不一致、运行列表复选框/键盘事件冒泡。修复列表交互时误伤“观察”按钮，复查再次检出并通过 pending/recovery_required 两种受理等待场景关闭。侧栏使用局部单列，独立宽审批页保留三列，几何回归先红后绿。独立 reviewer 最后确认代码及本记录没有必须修复项，并核对原报告、执行方案、最终测试及真实 Provider 证据后放行本轮实现与本地验收。

## 3. 本地验证

环境为 Linux、Node v22.16.0、pnpm 10.12.1。构建使用 Core build、CLI/Web build，最后的侧栏 UI 修复另重建 Web；所有构建均成功。根 `pnpm typecheck`、`pnpm lint` 成功。`pnpm test --run` 在最终产品代码上执行：188 文件，2115 passed、1 项既有 DSH opt-in skipped。

| 测试类别 | 文件 | 结果 |
| --- | --- | --- |
| Core unit | 100 | 1367 passed / 1 skipped |
| Core e2e | 11 | 49 passed |
| CLI unit | 10 | 71 passed |
| CLI e2e | 7 | 25 passed |
| Web Client/API unit | 60 | 603 passed |

根测试实际包含上述 Core/CLI e2e；新增 6 项真实 OS 进程测试使用生产 SessionService、JobRunner、workflow executor、Gateway 与 SQLite，受控 Agent/Gate 命令只作为确定性进程验证。它们不是模型调用证据。取消期间另一 Run 继续心跳；旧 owner 被 SIGKILL 后遗留的真实 Gate 不被重跑；人工停止旧进程并确认对应 Job 后从原 Gate 位置完成。

完整 Chromium 使用 `pnpm exec playwright test --project=chromium --retries=0`，**164/164 通过（4.8 分钟，零重试）**。首轮 8 个失败中，6 个来自常驻空 Live Region 使旧全局 alert 定位歧义；2 个来自 Session fixture 未同步权威 Run 状态、快照故障被新增自动刷新提前解除。修复只限定定位范围及建立明确的故障释放条件，保留错误可见、读取未就绪时无控制入口等断言；独立 reviewer 确认没有用弱化断言掩盖回归。

[验证摘要](evidence/2026-09-06-r26/verification.json)与[命令结果摘录](evidence/2026-09-06-r26/validation-summary.txt)保存测试计数、环境和证据边界。浏览器证据不扩大为读屏、Windows 或负载验收。

### 3.1 四视口视觉与交互

最后 Web 构建在 **320 / 390 / 768 / 1440px** 各检查 Sessions、Session、Runs、Run detail、Approvals、Delivery、Config、Eval 共 32 页；页面 scrollWidth 均不超过视口宽度。主代理实际查看四张总览及桌面 Session 原图，侧栏命令已使用完整卡片宽度，未再发现本轮场景的重叠、挤压或错误覆盖标题。窄屏表格/标签的局部横向滚动和列表标题省略保留原行为。

[32 页原始截图与几何索引](evidence/2026-09-06-r26/pages/index.html)保留固定 900px 高首屏；R26 Chromium 另覆盖取消/重试、恢复确认、审批部分成功、键盘和滚动后的操作。以下总览上排依次为 Sessions、Session、Runs、Run detail，下排为 Approvals、Delivery、Config、Eval；可在索引打开原尺寸查看细节。

| 视口 | 总览 | Session 审批卡原图 |
| --- | --- | --- |
| 320px | [总览](evidence/2026-09-06-r26/pages/overview-320.png) | [原图](evidence/2026-09-06-r26/pages/320-01-session.png) |
| 390px | [总览](evidence/2026-09-06-r26/pages/overview-390.png) | [原图](evidence/2026-09-06-r26/pages/390-01-session.png) |
| 768px | [总览](evidence/2026-09-06-r26/pages/overview-768.png) | [原图](evidence/2026-09-06-r26/pages/768-01-session.png) |
| 1440px | [总览](evidence/2026-09-06-r26/pages/overview-1440.png) | [原图](evidence/2026-09-06-r26/pages/1440-01-session.png) |

## 4. 真实 Claude 生命周期

[脱敏机器记录](evidence/2026-09-06-r26/claude-lifecycle.json)记录了 2026-09-06 00:43:21–00:43:44 UTC 的实际验证。此轮在同一 Node 宿主及数据库连接内重建 runner/registry。使用本机 Claude Code **2.1.261**，隔离 Git 仓库中的最小只读任务，直接调用生产组合根；没有使用 engineFactory、mock adapter 或伪 Claude 命令。

| 路径 | Run / Job / PID | 实际结果 |
| --- | --- | --- |
| 执行 → 取消 → close → 关闭 → 重启 | Run `run_b8dda95e-8f23-4bbc-89b2-b6844d18407b`；Job `job_9e971098-db1a-4eba-a3ab-e897810c9737`；PID 2791675 | 取消前确认真实 Claude PID 存活；取消后 PID 退出，Job 为 cancelled，记录 v1 managed-handles-closed；runner 重建后 Run 仍 cancelled，RoleRun 数量保持 1，无新管理句柄 |
| 执行 → 正常关闭 → interrupted → 显式恢复 | Run `run_96eec270-5453-4322-9c0e-99012a6fa706`；旧 Job `job_d1c5ff88-cc9e-4f3a-b045-7873e4e7c766`、PID 2793198；新 Job `job_103a9bf3-f708-4e8d-9ad8-7da511a06f20`、PID 2794688 | 正常关闭后旧 PID 退出，旧 Job interrupted 且有真实 close 证据；同 Run 显式恢复，新 Claude 执行完成，Run passed、Job done |

独立审阅指出上述记录不能证明宿主进程退出后的数据库重开。因此另在 **01:02:10–01:02:57 UTC** 完成[跨宿主补充验证](evidence/2026-09-06-r26/claude-host-restart.json)：四个顺序执行的独立 Node 进程各自打开并关闭同一磁盘 SQLite，下一阶段确认前一宿主已退出。

| 跨宿主路径 | 持久身份与实际结果 |
| --- | --- |
| 取消后退出宿主，再打开数据库 | Run `run_e83c8f49-0684-4423-8973-bd6d62df6aef`；Job `job_8b1aa07b-7a91-4b72-9c6f-efff9c970843`。宿主 2875795 取消真实 Claude PID 2875832 并获得 close 证据后退出；新宿主 2876052 重开数据库、运行 runner 1.8 秒，Run/Job 仍 cancelled，Job/RoleRun 数量各保持 1，无新管理句柄 |
| 正常关闭并退出宿主，再显式恢复 | Run `run_d46c486f-e21a-416c-bb9f-8d0ce4051306`；旧 Job `job_d4f1eee9-f144-445d-9b6b-df4ed1ca80a4`。宿主 2876105 正常关闭，Claude PID 2876130 已退出且 Job interrupted；新宿主 2876524 重开数据库并同 Run 显式恢复，新 Job `job_1aba2472-4956-4f04-8584-039d6fd43730`、Claude PID 2876615，最终 Run passed、Job done |

每个阶段停止管理执行后，间隔 1.2 秒比较隔离仓库文件的数量、总字节和内容树 SHA-256，四组前后均一致。记录覆盖工作树和运行输出，排除 `.git`、`node_modules`、`tekon.sqlite*`；这是有限观测窗口内的稳定性，不是对任意延迟外部写入或逃逸进程的保证。宿主 SIGKILL 后孤儿 Gate 的行为由独立的受控 OS 进程 e2e 证明，不把正常关闭的 Claude 实测称为强杀验收。

本次真实 Provider 场景无产品风险 Gate 和交付 eval：任务仅在隔离仓库读取 README，节点不包含 Gate，故这两项为不适用。没有真实 push/PR、合入或发布动作。完整回归中的 Gate/readiness 测试提供相关机制证据，但不替代生产交付评估。

这些结果证明本次 Linux/Claude 组合的受管理进程生命周期；不证明全部逃逸后代进程、所有模型、网络中断或机器故障都已覆盖。真实 DSH L2/L3 仍未通过本轮验证。

## 5. 上游与范围裁决

[上游观察记录](evidence/2026-09-06-r26/upstream.json)：deepseek-harness master/origin/master 已同步至 `d347e703908d0406b7a7ef80e3a0e594d86b2215`，工作区干净。GitHub 最新观察发布为 [dsh-v0.1.3-alpha.1](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.3-alpha.1)，无 release assets；从默认 registry 与显式 npmjs registry 获取此版本均返回 E404/ETARGET。npm dist-tags 为 latest/next=0.1.2-rc.1、alpha=0.1.2-alpha.5。源码同步不等于候选二进制兼容性通过，Tekon tested pin 保持 0.1.2-alpha.3；当前 Node 也低于 DSH 的 22.19 下界，未使用旁路冒充验收。

- 原报告 §6.3.1/2 的执行生命周期、取消观察与重试入口在本轮实现和验证。
- 完整只读导出仍由 [#18](https://github.com/zesming/tekon/issues/18) 的 archive/snapshot/manifest 合同独立推进；历史分页不冒充完整导出，clean 保持停用。
- ACP 持续协作及 Collaborate→Deliver 仍按 [#14](https://github.com/zesming/tekon/issues/14)、[#19](https://github.com/zesming/tekon/issues/19) 推进。Headless 仍一次性，不宣称完整多轮协作。
- DSH 兼容性按 [#17](https://github.com/zesming/tekon/issues/17) 保留独立验收边界，不使用 Claude 结果替代。

## 6. 交付对应关系

| 用户要求 | 交付对应 |
| --- | --- |
| 0：同步上游、整体循环评估 | 上游源码与 npm 观察已归档；原报告 §10 和方案 §1/5 记录独立评估与范围裁决 |
| 1：原报告追加批注 | 原报告 §10 保留缺陷复现、原因和证据；§11 链接实际整改验收，不改写历史结论 |
| 2–3：调整并先评审方案 | 正式执行方案 Markdown/HTML；独立设计复评后实现，新增边界同步进方案 |
| 4：测试先行、相关 e2e、code review | Core/CLI/Web 行为回归与实进程测试；独立 review 的必须项修复后复查 |
| 5：全功能和视觉 e2e | 本文 §3 完整测试、四视口页面及截图；§4 分列真实 Claude 与受控故障边界 |
| 6：逐项最终放行 | 本记录、原报告、方案、代码测试及证据由独立 reviewer 最后核对 |
| 7：同 PR 提交与清理 | 交付到 PR #11 原分支，普通 push；当前提交的远端检查由 PR 按 SHA 记录，完成后清理本轮临时目录及进程 |


README、CHANGELOG、主手册中英增量及 HTML 已同步 v0.24.0。产品增加恢复确认行为，使用 MINOR 升级；根与三个包版本一致。安装/更新脚本未改，不触发干净安装 smoketest；代理指令没有新增开发约定，不再修改 AGENTS/CLAUDE。清理仅覆盖本轮明确拥有的临时目录与进程，关键验收结果保存在本报告及脱敏记录中。
