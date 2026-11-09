# Tekon 全面审查报告

- 日期：2026-11-06（审查始于 2026-11-05）
- 审查版本：main@0580282（v0.26.1）
- PR/MR：https://github.com/zesming/tekon/pull/37
- 审查维度与范围：产品逻辑、UI 与交互、代码实现、测试；全量。`docs/reviews` 的历史证据只统计规模，不逐篇审
- 审查手段：静态阅读；安装依赖、构建、运行全量测试与覆盖率；Playwright 全量；用合成数据实际操作 Web 并截图；用本机 Claude Code 在临时仓库真实跑一次 bugfix；变异验证；探针复现
- 内部评审：2 轮质证，驳回 0 条，经用户答复定案 15 问（含交付 4 问），仍需决策 0 条（其中未充分质证 0 条）

## 修复约定

本 PR/MR（分支 `audit/2026-11-05`）只承载本报告和重构第 1 阶段的修复。第 2 阶段起的条目已标“另排（重构第 N 阶段）”，各阶段另开 PR；阶段划分见第三节。
- 每个修复提交在 message 中引用问题编号，如 `fix(CD-03): …`。
- 修完一条：把本报告中该条状态改为"已修复"，并在 PR/MR 描述中勾选对应条目。
- 条目只修完一部分时，状态写“部分修复”并写明余下去向，不勾选。
- 修复中发现某条判断有误，把该条状态改为"误判"并写明原因；决定不在本 PR 修的，改为"另排"并写明去向（issue / 后续 PR）。不直接删除条目。
- S0 经用户确认单独走 hotfix PR（CD-01、CD-46，尚未创建），创建后在此注明去向。
- 基线分支有更新时用 merge 同步，不 rebase、不 force push。
- 第 1 阶段中属于本 PR 的条目（见第三节）全部处理后，把 PR/MR 转为 ready for review。部分条目只有一部分属于本阶段，以条目的修复建议为准。
- 安全类条目（CD-40、42、43、44）的细节不公开，走单独小 PR，先于本 PR 其他修复合入，提交信息不描述弱点。修复者向维护者索取细节；拿不到时不要处理并注明。

## 一、结论摘要

当前实现测试全绿（2248 个用例 0 失败），但按用户的目标“用不起来”。默认的 Codex 依赖本地前提，未满足时首跑失败；Claude 在 macOS Keychain 登录下 1 秒内中断（已实测，其他认证方式未测）；失败原因还被丢弃。工作流绑死在研发流程，角色和产物是封闭枚举，默认 16 个节点。运行中看不到输出，也插不上手。

文档和实现基本一致，所以这主要是产品方向和架构形状的偏差，不是零散缺陷。适配器“一次性调用、结束才返回”的形状，同时堵住了实时输出、对话、续接和用量。

经用户确认，方向是转为驱动现有 harness 的通用 workflow 框架，在现仓库分阶段替换。第一步先修两条 S0，让现有版本能跑、能走完。

| 严重度 | 产品 | UI/交互 | 代码 | 测试 | 合计 |
|---|---|---|---|---|---|
| S0 | 0 | 0 | 2 | 0 | 2 |
| S1 | 23 | 4 | 11 | 3 | 41 |
| S2 | 3 | 10 | 19 | 13 | 45 |
| S3 | 0 | 1 | 3 | 3 | 7 |


**建议优先处理**：
1. [CD-01] Claude 环境白名单丢 USER —— macOS Keychain 登录下跑不起来，改动小，已确认单开 hotfix。修复时不要把凭据并进公共白名单。
2. [CD-46] 返工成功后卡死在 pmo-checkpoint —— 默认流程评审一旦起作用就走不完，已确认单开 hotfix。
3. [CD-02]、[PD-02] 失败原因透出和前置检查 —— 让所有后续问题可诊断。
4. [CD-45]、[CD-29] 运行被自己或其他进程杀掉 —— 重构前先堵住，否则真实运行不可靠。
5. [TS-01]、[TS-02]、[TS-08] 补合同测试 —— 这是后续重构的验收线。

## 二、项目画像

- **定位**：README 写的是“把研发需求推进到可审阅交付的本地 Agent workflow 框架”，目标用户是仓库维护者。
- **本次目标基准（用户提出）**：① 按任务描述动态或指定 workflow，不限研发；② 透明度高、简单可交互，能在 HTML 上圈选评论；③ 角色可配模型、effort、提示词和工具；④ 精简，快速定义马上跑；⑤ 驱动现有 harness；⑥ 插件化，如接 IM。
- **核心路径**：首次使用；定义工作流和角色；发起并观察；运行中介入；配置角色；审阅交付；扩展。
- **技术栈**：TypeScript pnpm monorepo，SQLite，zod，Vite/React，vitest，Playwright。
- **模块**：`packages/core` 约 29,919 行（workflow 6,215、runtime 5,479、session 3,492、gate 2,949、db 2,351、delivery 2,166）；`packages/cli` 约 5,208 行；`packages/web` 约 21,402 行（client 14,745、server 5,362、shared 1,295）；测试约 68,507 行。
- **Provider**：codex（默认）、claude-code、mock、dsh-headless（实验）。7 个内置模板，standard-delivery 326 行、16 个节点。

## 三、精简建议汇总

精简后的核心路径：`tekon init` → `tekon run "任务"`（轻量模板）→ 任务详情里看进展和产物、回复或批准 → 结果落到分支。研发治理只在选择 `standard-delivery` 时出现。

- **直接删除**：Gate registry 这套 1,444 行（`gate/runners.ts` 除外）和 6 个生产不可达模块 664 行（CD-16）；19 个无生产使用的导出（CD-25）；假 `parallel`（CD-24）；Constraints tab 和 Coming Soon 页（PD-11、PD-26）；重复路由和 Advanced Dashboard（PD-25、UI-03）；状态机不可达状态（CD-15）。
- **重构后删除**：dual-write 387 行现在是生产路径，事件表上线后再删（CD-31）。
- **搬出默认路径**：delivery、语义 Gate，以及 review、approval 的治理评分部分搬进可选的 `delivery` 包（CD-11、PD-06）。用户保留了 standard-delivery，所以这部分是移出内核，不是删除。审批摘要和结果查看的通用部分留在内核，默认流程要用。eval 随包搬走，默认不加载；constraint 随动态编排重做删除；draft 见 CD-36；归一化在放宽 schema 或加上 agent 重试后分批删（CD-21）。
- **合并**：组合根 2 份、脱敏 2 套，环境白名单只合并公共基础键（CD-26）；审批 3 条路径（CD-32）；Session 和 Run 双入口（PD-25）；用户层概念压成 6 个、状态压成 5 个（PD-15）。
- **文档**：过程性文档和产物整合精简，并入固定文档；手册拆成上手页和参考页（PD-27）。

可从内核移除的量（估算）：

- 已决定 4,800 行（16.0%）：delivery 2,166 + Gate registry 1,444 + 语义 Gate 约 740 + legacy driver 179 + scheduler 16 + automation-job-executor 197 + profile-policy 58。
- 待定 3,303 行：eval 1,073、draft 783、constraint 822、归一化 625。
- 合计 8,103 行（27.1%）。admission 和计划 1,580 行默认保留，第 5 阶段后再看；都移除时是 9,683 行（32.4%）。
- 测试受影响约占 29.4%–37.1%（校准估算，未实际删除校准，TS-12）。

### 重构阶段与条目去向

经用户确认，在现仓库分阶段替换。S0、S1 的去向如下；S2、S3 除“1 可诊断和可靠”这一行点名的之外，随所在模块处理或另排，不阻塞本 PR 转 ready。

| 阶段 | 内容 | 条目 | 载体 |
|---|---|---|---|
| 0 止血 | 环境白名单、返工后卡死 | CD-01、CD-46 | hotfix PR |
| 1 可诊断和可靠 | 失败原因、前置检查、运行被杀、清理、输出落盘、Web 小修、合同测试 | CD-02、CD-12、CD-18、CD-29、CD-45、PD-02、PD-13、PD-17（第 1 步）、PD-22（审批队列）、PD-24、UI-02、UI-03、UI-05、TS-01（常规层和 Claude 真实层）、TS-02、TS-08，以及 S2 的 TS-11、TS-12（前两项） | 本 PR |
| 1 安全 | 安全类条目 | CD-40、CD-42、CD-43、CD-44 | 单独小 PR |
| 2 放开工作流 | 在现有 YAML 上放开枚举和门禁、轻量默认模板、驳回返工、角色配模型 | CD-09、CD-14、CD-20、PD-04、PD-05、PD-06、PD-07、PD-08、PD-10、PD-11、PD-18、PD-21、PD-31，以及 PD-17（第 2、3 步） | 另开 PR |
| 3 事件和 Driver | 事件流、Claude 纵向打通，再接 Codex 和通用模型 | CD-11、PD-12、PD-16，以及 TS-01（Codex 真实层） | 另开 PR |
| 4 控制台 | 任务列表和详情、合并入口 | PD-14、PD-15、PD-25、UI-04，以及 PD-22（交付页） | 另开 PR |
| 5 新格式和治理搬迁 | 新 YAML、`delivery` 包、plan 节点 | PD-01、PD-09 | 另开 PR |
| 6 HTML 评论 | 产物渲染和圈选 | PD-19 | 另开 PR |
| 7 插件和 IM | 公开 Channel 接口和插件加载，第一个 IM（Driver 接口随 CD-11 在第 3 阶段） | CD-17 | 另开 PR |

第 2 阶段结束是第一个决策点，够用就按需再做后面的阶段。

## 四、问题清单

### 4.1 产品逻辑

### [PD-01] 产品定位是研发交付流水线，用户要的是通用任务编排
- 维度：产品 | 严重度：S1 | 工作量：L | 置信度：高 | 状态：已确认，另排（重构第 5 阶段）
- 位置：README.md:3-5，docs/product/tekon-current-product-scope.md:7、30-36，packages/web/src/client/components/sessions/SessionComposer.tsx:85、160
- 现象：README 写“把研发需求推进到可审阅的交付”。产品范围写“面向需要把研发需求推进到可审阅交付材料的仓库维护者”。持续协作、follow-up、steer、增量流列在“尚未开放”。
- 依据：产品方向偏差：文档已声明，与目标基准冲突。逐项对照目标基准：① 不限研发，文档限定研发，模板和 prompt 也只服务研发（PD-06、PD-09）；② 透明可交互，只有任务列表和状态部分满足，圈选评论和对话没有（PD-12、PD-16、PD-19）；③ 角色可配，文档未提（PD-10）；④ 快速定义马上跑，默认 16 节点（PD-07、PD-08）；⑤ 直接驱动 harness，实现是自建 runtime（CD-11）；⑥ 插件和 IM，文档未提（CD-17）。推断：文档与实现基本一致，落差不是文档写错，而是产品目标与用户要的不是同一件事。经用户确认（2026-11-06）：转为通用 workflow 框架，研发交付退为一个模板。
- 影响：只修局部体验解决不了“用不起来”。用户的核心诉求在文档里属于范围外。
- 修复建议：转为通用 workflow 框架，README、范围文档、默认入口一起改，研发交付退为一个内置模板。取舍是现有治理链路不再是默认路径。

### [PD-02] 默认 provider 写死 Codex，依赖本地前提且没有前置检查
- 维度：产品、代码 | 严重度：S1 | 工作量：M | 置信度：高（真实 Codex 未验证，internal profile 缺失时的行为未验证） | 状态：已确认（合并 CD-03）
- 位置：packages/cli/src/lib/context.ts:129-136，packages/core/src/runtime/codex-adapter.ts:27-33、100-105、239-242，packages/core/src/runtime/agent-runtime.ts:19-27、102-147，packages/cli/src/commands/provider.ts:128-133，README.md:17、25、27，docs/manual/tekon-user-manual.md:282、821
- 现象：`init` 无条件写 `defaultAgent: codex`，不探测本机环境。本机未安装 Codex 时 run 立刻 interrupted。适配器固定传 `--profile internal --sandbox workspace-write --ask-for-approval on-request`（探针抓到的实际参数相同），OPENAI_API_KEY、CODEX_HOME、USER 被环境过滤丢掉（stub 复现）。`tekon provider preflight codex` 输出“暂不支持对 Provider 'codex' 进行预检，当前仅支持 dsh-headless”。首页绿灯“凭据有效（dsh-headless不可用）”只反映 token 和一个默认关闭的实验 provider。`--agent claude-code` 1 秒内 interrupted，阻断根因见 CD-01。
- 依据：产品方向偏差：文档已声明，与目标基准冲突（README:17、手册:282、821 写明 internal profile 和 Codex 前提）。实现缺陷有两点：没有 profile 配置入口（`agent-runtime.ts:19-27` 的 overrides 里没有），没有预检。README:27 写明默认 Codex“尚缺本轮真实全链路证据”，默认项恰是验证最少的一项。未验证：Codex 只在未安装的环境测过，已安装且配好 profile 时能否跑通没有结论。
- 影响：本机没有 Codex 或 internal profile 的新用户，按默认路径第一次就可能失败，失败原因又被 CD-02 遮住。
- 修复建议：`init` 探测 claude、codex，写入可用项。新增 `tekon doctor`，合并 provider 预检和 workflow preflight，覆盖全部 provider。经用户确认（2026-11-06）：API key 和订阅登录都要能用，并由各 agent 自己管理，所以预检两种情况都要覆盖，只检测和提示，不增加认证配置。run 前 fail-fast。默认不传 profile，由用户在配置里显式指定；适配器现在拒绝 `--profile`、`-c/--config` 这类用户参数（`codex-adapter.ts:360-431`），要由适配器翻译配置字段，并放开相应校验。Codex 的认证变量同样要透传（见 CD-01 现象）。

### [PD-04] 校验命令被硬编码白名单拒绝，preflight 却报 resolved
- 维度：产品、代码 | 严重度：S1 | 工作量：S | 置信度：高 | 状态：已确认（合并 CD-07），另排（重构第 2 阶段）
- 位置：packages/core/src/workflow/workflow-runtime.ts:156-171，packages/core/src/workflow/gate-runner.ts:119，packages/core/src/runtime/command-gateway.ts:177-183，packages/core/src/repo/profile.ts:18-25、327-347，docs/manual/tekon-user-manual.md:154、353
- 现象：Python 仓库的 `repo-profile` 初始为 `commands: {}`，按提示写入 `tool: python3` 后 preflight 显示 `resolved`，运行却 blocked。配 `make` 同样 blocked，CLI exit 0。门禁日志只有 `command does not match allow policy`，提示 “Change the command or policy intentionally”，但没有 policy 入口。allow 固定为 git、pnpm、npm、claude、codex、dsh，手册未提。runner 只有 npm 或 pnpm（yarn、bun 也按 npm 处理）。无 package.json 时报 missing-command、blocked。
- 依据：allow 列表不覆盖非 Node 工具，手册没有给出替代路径。`notApplicable` 手册有说明（§4.3、:353），它只跳过命令门禁，不跳过安全扫描和 schema 校验。7 个内置模板里 5 个带 build gate，只有 goal 和 plan-only 不带。standard-delivery 要跑完前 10 个节点和 rd-code-change 共 11 次 agent 调用才触发这个门禁，而 preflight 在开跑前就能知道。
- 影响：Python、Go、Rust、Java、Make、yarn 仓库不能直接使用命令门禁，只能标 notApplicable 放弃这部分校验，不符合“不限研发”。
- 修复建议：用户手写在 repo-profile 或模板里的命令视为已授权，allow 由它们推导，保留现有拒绝规则和网络检查。模型生成的计划（PD-09）不得带命令字段；存成模板时要人工确认并标记来源，否则模型写的命令会被当成用户授权。删掉 runner 判断，命令按原样执行。preflight 与 gateway 共用同一判定。run 前发现 missing 直接阻止并给修改示例。

### [PD-05] 改好配置后 resume 同一个 run 仍按旧绑定失败
- 维度：产品 | 严重度：S1 | 工作量：M | 置信度：高 | 状态：已确认，另排（重构第 2 阶段）
- 位置：docs/manual/tekon-user-manual.md:430-432，packages/core/src/workflow/run-plan.ts:423，packages/cli/src/commands/status.ts
- 现象：Python 仓库 bugfix 首跑 blocked（missing-command），改 profile 后 preflight 为 resolved，`resume` 仍 blocked，第二条结果仍是 `missing-command`，退出码 0。每次 resume 都新建一条 rd-fix role_run。`tekon review` 的 Triage 写 `retry=after-fix`，建议先修 commandRef 再重试。Web 有绑定横幅，`status` 有 `executionBinding=frozen`，但都不说这次失败和绑定有关。
- 依据：冻结本身是产品方向偏差：文档已声明，与目标基准冲突（手册写“执行、恢复、修复重试和返工沿用原记录”“希望采用新配置时，应明确发起新任务”）。实现缺陷：Triage 建议与手册矛盾，明知必败仍调 agent（PD-31）。经用户确认（2026-11-06）：默认冻结，提示差异，`--rebind` 显式采用。
- 影响：前面节点的 agent 成本作废。粗算 11 节点约 5.5-12 分钟（按 30s 到 67s 每节点，未实测）。
- 修复建议：默认维持冻结。resume 时检测配置差异并提示，`--rebind` 显式采用新配置。`status`、`resume` 输出阻塞原因和下一步，blocked 退出码为 2。修正 Triage 文案。绑定横幅改为只在配置有差异时显示（与 UI-15 同一处修复）。

### [PD-06] 非研发工作流只能借研发槽位表达，缺节点级 prompt 和自由产物类型
- 维度：产品、代码 | 严重度：S1 | 工作量：L（拆子项） | 置信度：高（用 mock 或 stub 验证，真实 provider 未测） | 状态：已确认（合并 CD-08），另排（重构第 2 阶段）
- 位置：packages/core/src/types/domain.ts:5、34-56、59-72，packages/core/src/workflow/template.ts:155-186、468-470、502-504、700-715，packages/core/src/artifact/schemas.ts:21、158-180、218-239，packages/core/src/workflow/prompt-builder.ts:167、195、284、301-349、419-426，packages/core/src/role/loader.ts:24-37，packages/cli/src/commands/role.ts:42，AGENTS.md:16，README.md:5
- 现象：`role: writer` 报枚举错误。`prompt:` 报 `Unrecognized key`。artifact 只能选 21 个研发枚举值，`essay` 报枚举错误。不带 reviewer 报 `Workflow template must include a reviewer node`。`listRoleIds` 按枚举过滤，自定义目录不可见。能跑的写法有两种：pm + reviewer 借用 `prd`、`review-report`，实际 prompt 是“Tekon PM 把需求整理为目标、非目标…”；或 `governance: none` + goal 节点。后者声明 inputs、outputs 后（如两 phase、`essay:prd`）能跑通，下游 prompt 含上游产物内容；不声明 outputs 时下游收不到内容。`role create pm` 后改 system.md，提示词生效。
- 依据：产品方向偏差：文档已声明，与目标基准冲突（README:5 写“按固定流程分工”，AGENTS.md:16 把角色、artifact schema、Gate 明示为产品合同）。枚举散布：`roleSchema` 22 处 6 个文件，`artifactTypeSchema` 20 处 4 个文件，`gateTypeSchema` 9 处 3 个文件，artifact 字面量散落二十余个文件。真实缺陷：`role.ts:43` 缺 goal，`schemas.ts:218-239` 的枚举副本缺 ci-status，`governance: none` 只在 workflows/goal.yaml:4、9 出现，手册、README、产品和技术文档都没写。经用户确认（2026-11-06）：角色和产物自由命名，reviewer 和 Gate 可选，治理放进模板，同步改 AGENTS.md。
- 影响：目标基准①④不成立，也就是用户说的“工作流定义不了或太死”。
- 修复建议：拆子项。1）先修 role.ts、schemas.ts 两处枚举副本。2）节点增加 `prompt` 字段，产物自由命名并在节点间传递。3）role 和 artifact type 改为开放字符串，schema 校验变成可选注册项，内置研发角色降为模板内容。4）reviewer 和 Gate 改为可选，治理放进模板。5）同步改 AGENTS.md 的产品合同和文档。

### [PD-07] 工作流没有 Web 创建入口，CLI 的 list、create 不校验
- 维度：产品 | 严重度：S1 | 工作量：M | 置信度：高 | 状态：已确认，另排（重构第 2 阶段）
- 位置：packages/web/src/client/pages/config/WorkflowsTab.tsx，packages/web/src/client/components/config/WorkflowDetailPanel.tsx，packages/cli/src/commands/workflow.ts:211-217
- 现象：Web 只读展示 ID、Name、Source。`workflow list` 会列出无效模板，`create` 不校验。`show`、`run` 才校验，且对无效模板输出原始 zod JSON。`show` 对有效模板只输出 id、name、phases 三行，看不到节点。没有 validate 子命令。`workflow create` 存在但手册没写，默认复制 326 行模板。
- 依据：Config 的 Workflows 页和 CLI 实测输出。
- 影响：用户只能读模板源码来学写法，写错要靠 run 或 show 才发现。
- 修复建议：`show` 展示节点和角色。list 标记无效项。增加最小模板。Web 提供 YAML 编辑、校验、运行。

### [PD-08] 默认值过重，默认入口不能选模板和 provider
- 维度：产品、代码 | 严重度：S1 | 工作量：M | 置信度：高（耗时为粗算，未实测 standard-delivery） | 状态：已确认（合并 CD-19），另排（重构第 2 阶段）
- 位置：packages/cli/src/commands/run.ts:154，docs/manual/tekon-user-manual.md:32，README.md:29、48，packages/web/src/client/components/sessions/SessionComposer.tsx:44，packages/web/src/server/api/routers/project-with-run-mode-policy.ts:26，workflows/standard-delivery.yaml
- 现象：“增加减法函数”默认走 standard-delivery：16 节点（9 个是评审节点，每个 schema、independent-review、role-scope 三道门禁）、13 phase、44 个门禁结果、19 个产物、175 条审计事件、214 条 session 事件，mock 运行界面有 195 条技术事件。`run` 不采用 Draft 推荐模板，Web 的 Draft 跳转却会预填推荐模板。首页 payload 只有需求文本和计划摘要，选不了模板、provider、Goal。
- 依据：默认值是产品方向偏差：文档已声明，与目标基准冲突（README:29、48，手册:32）。CLI 和 Web 的 Draft 推荐不一致是实现问题。门禁算式 9×3 + 2 + 1 + 1 + 4 + 4 + 2 + 3 = 44。经用户确认（2026-11-06）：新建轻量模板作默认（plan→实现→人工确认）。
- 影响：真实 provider 下一次 run 至少调用 agent 16 次，小任务的等待和成本与任务规模不相称。粗算：bugfix 的 4 个 agent 节点共 269s（32.6s、23.3s、177.2s、34.0s），16 节点约 10-18 分钟（去掉 QA 离群值约 10.5 分钟，均值法约 18 分钟），节点耗时不均。
- 修复建议：新建轻量模板 plan→实现→人工确认作为默认，standard-delivery 改为显式选择。现在写不出这个模板：`template.ts:700-715` 要求产出代码的节点带 build 和 lint 门禁（复现报 `Code-producing node "impl" must include build and lint gates`），Goal 也不能改源码。所以先做 PD-06（门禁可选）、CD-09（文件权限）、PD-04（命令门禁）、PD-18（驳回返工），再改默认值。首页加模板和 provider 下拉。统一 CLI 和 Web 对 Draft 推荐的处理。

### [PD-09] “动态编排”实为硬编码和规则匹配
- 维度：产品、代码 | 严重度：S1 | 工作量：L | 置信度：高 | 状态：已确认（合并 CD-13），另排（重构第 5 阶段）
- 位置：packages/cli/src/commands/run.ts:127-152、334-411，packages/core/src/draft/shape.ts:115-123、150-180，packages/core/src/workflow/dynamic.ts:139、145-146、172-177、181-221、302-308、429-431，packages/core/src/workflow/engine.ts:72，docs/manual/tekon-user-manual.md:405、434、856、858
- 现象：`run --dynamic` 只能配 `--dry-run`，adapter 写死 `createDynamicMockAdapter`，固定产出 rd→qa→reviewer，用正则判风险，`--agent` 被忽略，“翻译英文合同”也一样。唯一调用方是 CLI，Web 没有调用。`--save-as dyn` 后 `run --template dyn` 报 missing-command、blocked，exit 0：无命令配置的非 Node 仓库确认发生，这不是动态模板本身的问题；已有 package.json 的仓库复现结果不一致，未定论。`workflow select` 输出 `standard-feature category=other ready=true score=1.00`。“整理本周周报”被判为 category=refactor，`evaluateWorkflowSelection` 用同一函数自评。`draft shape` 对翻译合同生成“build/lint/test/security gate 通过”“PR package”类验收标准。
- 依据：换真实 adapter 也跑不通：`dynamic.ts:302-308` 的 `allow:[]` 会被 `command-gateway.ts:177-179` 拒绝，`dynamic.ts:172-177` 把 outputFiles[0]（stdout 日志）当 JSON 解析。`engine.ts:72` 的 `mode:'dynamic'` 无人传入。mkdtemp 目录不清理。手册标了“预览”，误导是轻度的。经用户确认（2026-11-06）：重做为 plan 节点产出受校验的 steps，同一执行路径，结果可存 YAML。
- 影响：目标基准“按任务描述动态选择或编排”没有实现，界面却展示出已具备的样子。
- 修复建议：重做为 plan 节点产出受校验的 steps，走同一条执行路径，结果可存 YAML。去掉写死的 mock adapter 和关键词自评，删除时保留可复用的 `generateDynamicWorkflow`（`dynamic.ts:139`）。

### [PD-10] 角色不能配模型和 effort，工具只是提示，也不能新建角色名
- 维度：产品、代码 | 严重度：S1 | 工作量：M | 置信度：高 | 状态：已确认（合并 CD-05、CD-06、CD-41），另排（重构第 2 阶段）
- 位置：packages/core/src/role/loader.ts:24-37，packages/core/src/role/prompt-builder.ts:23-27，packages/core/src/role/tool-policy.ts，packages/core/src/constraint/runtime-policy.ts，packages/core/src/runtime/agent-adapter.ts:18-21，packages/core/src/runtime/agent-runtime.ts:19-27、95-147，packages/core/src/runtime/claude-code-permissions.ts:31-48、67-134，packages/core/src/workflow/helpers.ts:201，packages/core/src/workflow/engine.ts:114，packages/cli/src/commands/run.ts:44-63，packages/cli/src/commands/role.ts:42-43，docs/product/tekon-current-product-scope.md:36，docs/README.md:21，docs/manual/tekon-user-manual.md:649，AGENTS.md:16
- 现象：role schema、适配器 config、runtime overrides、CLI run 选项、rpc-contract 都没有 model、effort 字段。`--model` 只出现在适配器测试里，经 `config.args` 传入，用户入口没有暴露。一次 run 只有一个 adapter，`run_provider_configs` 以 run_id 为主键，provider 按 run 固定。提示词能通过 `.tekon/roles/<role>/` 覆盖。tools 只进 prompt：`compileRoleToolPolicy` 在生产代码里只被 prompt-builder 调用且只取 `.promptSummary`，`runtime-policy.ts` 只有测试使用，`agent.yaml` 的 injectMode 从未被读取。Claude 的工具许可固定，没有扩展入口，make、python、cargo 这类命令要靠宿主权限配置批准，未获准时可能失败或等待超时。`role create` 只接受 5 个内置 ID，不能取新名字。`role list` 有 goal，`role show goal` 却报无效。
- 依据：产品方向偏差：文档已声明，与目标基准冲突（范围文档:36、docs/README.md:21、手册:649 写明工具只是提示；model、effort 文档未提）。工具配置只是提示，不是隔离边界，文档已披露。帮助文案称“从内置角色复制创建自定义角色”，与实际不符。
- 影响：目标基准③基本不成立，同一工作流做不到不同角色用不同模型，配置了工具也没有效果。
- 修复建议：`agent.yaml` 增加可选的 driver、model、effort、tools、permission。不写 model、effort 时不传，用 agent 默认值；不写 driver 时用默认 agent；不写 tools、permission 时用 Tekon 的统一基线，因为官方文档写明 [claude -p](https://code.claude.com/docs/en/permission-modes.md) 和 [codex exec](https://learn.chatgpt.com/docs/non-interactive-mode) 默认只读。基线要统一 CLI 和 Web：Web 入口现在传 `on-request`，Claude 适配器映射成 `default`（`packages/web/src/server/api/agents.ts:27`，`claude-code-adapter.ts:176-181`），按文档推断写文件和交产物都会失败，未跑真实 provider。统一基线是待用户确认的建议，放在第 1 阶段随 PD-24 一起做；不统一时，Web 上的 Claude 写节点要在启动前明确报错。其余字段在第 2 阶段做，两个入口都要实测。写了的字段进入每节点计划快照，由各适配器翻译成 harness 参数。`config.args` 路径可复用的只有 model；Codex 拒绝 `-c/--config`、`--profile`，Claude 拒绝 `--tools`、`--allowedTools`、`--settings`、`--agents`（`claude-code-adapter.ts:183-230`），所以这些字段要由适配器翻译，并调整校验。经用户确认（2026-11-06）：会使用各种模型，字段不绑定 Claude、Codex。角色文件格式在重构第 5 阶段再改成 Markdown。tools 编译到每节点 provider 参数后删掉“提示文本”路径和没有读取方的字段。角色名放开与 PD-06 同一改动。修复 `role show goal`。

### [PD-11] Config 页只读且内容失真
- 维度：产品 | 严重度：S1 | 工作量：M | 置信度：高 | 状态：已确认，另排（重构第 2 阶段）
- 位置：packages/web/src/client/pages/config/RolesTab.tsx:61，packages/web/src/server/api/routers/role.ts:17-22，packages/web/src/client/components/config/RoleDetailPanel.tsx:137，packages/web/src/client/pages/config/ConstraintsTab.tsx:7-9、36
- 现象：新项目 Roles 页显示“No roles configured”，实际 6 个内置角色正在使用。prompt 以“安全”为由隐藏，内容其实在公开仓库。Constraints 是硬编码静态 YAML，与真实 constraints.yaml（结构是 `rules:`）不一致。
- 依据：`role.ts:17-22` 只读 `.tekon/roles`，overview 的 `counts.roles=0`。代码注释写 “There is no constraint.list RPC procedure yet”。
- 影响：用户无法在此配置任何东西，还会被错误内容误导。
- 修复建议：删除 Constraints tab。Roles 列出内置和项目角色，显示并允许编辑 prompt。

### [PD-12] 发给 agent 的上下文、实时输出和最终答复不可见
- 维度：产品、代码 | 严重度：S1 | 工作量：M | 置信度：高（用 stub 验证，真实 provider 未测） | 状态：已确认（合并 CD-10），另排（重构第 3 阶段）
- 位置：packages/core/src/runtime/agent-step-events.ts:36、67-215，packages/web/src/client/pages/run-detail/ProgressTab.tsx:203、228-232，packages/core/src/runtime/claude-code-adapter.ts:29-30，packages/core/src/runtime/agent-adapter.ts:135-153，packages/core/src/runtime/dsh-headless-adapter.ts:364-367，docs/manual/tekon-user-manual.md:714
- 现象：stub 实测真实 provider 路径不落盘完整 prompt（只有 mock 写 transcript）。`promptSummary` 截断到 500 字符，基本是角色样板，停在 “Demand bod…”，feed 也不渲染。ProgressTab 写明 “raw stdout/stderr is never exposed”，只显示字节数，而这段因 PD-13 实际永不渲染。Goal 加假 Codex 输出答案，run passed，答案文本在 `tekon review`、`tekon log`、`status` 中出现 0 次，只在节点 stdout.log；session 的 `assistant/message` 内容是 `[goal] completed: 0 artifact(s), exit 0`。
- 依据：流式缺失和输出不可见是产品方向偏差：文档已声明，与目标基准冲突（手册:714 写“均不提供模型原文逐块流”）。prompt 不可见是产品缺口。`assistantText` 只有 dsh 适配器赋值，Claude 和 Codex 适配器不读 stdout。缓冲到退出的问题见 CD-12。
- 影响：用户无从判断 agent 收到了什么、正在做什么，run 成功了也拿不到答复。这是“看不清”的核心原因。
- 修复建议：每节点落盘 prompt 和输入，节点面板展示 prompt、输入、输出。所有适配器解析最终文本，脱敏后写入一个默认产物和事件（Claude JSON 已有 `result`，`draft-agent.ts:247` 已按此解析）。Claude 改用流式输出（`--output-format` 由 adapter 控制）。本地工具默认可看原始输出，敏感内容脱敏。

### [PD-13] Progress 页的“命令进度”恒为空
- 维度：产品 | 严重度：S1 | 工作量：S | 置信度：高 | 状态：已确认
- 位置：packages/web/src/server/api/routers/progress.ts:89-122，packages/core/src/runtime/command-gateway.ts:348，packages/core/src/workflow/helpers.ts:171-177，packages/web/__tests__/api/progress.test.ts:31-33
- 现象：已通过的 run 显示 “No progress files found”，并说明文件会在命令运行时出现。运行中也一样：mock（`build: sleep 25`）和假 claude（sleep 20）运行时，进度文件分别在 `gates/` 和 `<nodeId>/`，status=running，进程内调用真实 router 都返回 `n=0`。
- 依据：router 只扫 `runs/<id>/` 根目录。8 个 run 共 295 个进度文件，根目录 0 个；抽查的 run 中 `commands/` 36 个、`gates/` 3 个。`progress.test.ts:31-33` 的 fixture 放在根目录，形状也是真实写入方不会产生的，所以测试没有发现。
- 影响：唯一的命令活动视图实际不工作。
- 修复建议：推荐删除该块，以节点时间线替代（重构第 1 阶段先删，时间线在第 3 阶段接事件流）。若保留：递归扫描 `commands/`、`gates/`、`<nodeId>/`；按真实文件改字段（无 nodeId，command 是对象，字段名是 `lastOutputDirActivityAt`）；单 run 可达 113 个 commands 文件，默认只看运行中或 agent 级；fixture 换成真实形状。

### [PD-14] 进展 feed 没有内容，Session 与 Run 不连通，产物要 4 到 5 次点击
- 维度：产品 | 严重度：S1 | 工作量：M | 置信度：高 | 状态：已确认，另排（重构第 4 阶段）
- 位置：packages/core/src/runtime/agent-step-events.ts:167，packages/web/src/client/lib/session-side-panel.ts:14，packages/web/src/client/pages/SessionDetailPage.tsx:97
- 现象：feed 主体是 “[pm] completed: 2 artifact(s), exit 0.”，重复 16 行，没有节点名、时间、内容，也没有 X/N 进度。195 条技术事件被隐藏，内容是原始的 `worktree/leased`、`job/checkpointed`。侧栏产物卡只有类型和 artifact ID，不可点。“已关联交付运行”是纯文本，Session 页主体内链接数为 0。
- 依据：手册:714 说明 feed 是合成摘要。路径为“高级 Advanced → 运行列表 → 行 → Artifacts → 条目”共 5 次点击，经 Dashboard 最近运行最少 4 次，还要按标题自己匹配 run。经用户确认（2026-11-06）：任务一对多 run，Web 只留一套入口。
- 影响：用户看不懂进展，也不容易拿到结果。
- 修复建议：按任务一对多 run 打通，任务页直接关联 run。feed 行改为“节点名、角色、耗时、产物标题和摘要”，顶部显示 X/N，产物在任务页内展开预览。

### [PD-15] 用户要面对的概念和状态过多
- 维度：产品 | 严重度：S1 | 工作量：L | 置信度：中（数量依赖计数口径） | 状态：已确认，另排（重构第 4 阶段）
- 位置：packages/core/src/types/domain.ts:8、20、75、267，packages/core/src/types/session-contract.ts:35、78，packages/core/src/workflow/run-plan.ts:397，docs/manual/tekon-user-manual.md:248-330
- 现象：界面、CLI、手册暴露至少 31 个概念（手册 §5 只列 11 个），12 套状态共 66 个取值：workflow 8、node 10、gate 6、decision 3、PR 6、session 7、job 8、executionBinding 4、admission 2、filesState 3、preflight 4、actionKind 3，严格 schema 为 64，加 not-prepared 和 inline 为 66。node 状态基本只在日志里，排除后 56。`tekon status` 一行输出 executionBinding、admission、filesState、requestId。
- 依据：产品方向偏差：文档已声明，与目标基准冲突。状态值已复算；31 个概念未逐一复算，枚举量级相符。推断：走完一次默认路径至少要理解 13 个概念。
- 影响：学习成本远超任务本身。
- 修复建议：拆两步。1）用户层压缩成任务、步骤、角色、检查、产物、provider 6 个概念，以及运行中、等你处理、完成、失败、已停止 5 个状态。2）其余只在调试视图显示，内部枚举暂不动。

### [PD-16] 运行中不能对话和纠偏，“待输入”却没有输入框
- 维度：产品 | 严重度：S1 | 工作量：L | 置信度：高 | 状态：已确认，另排（重构第 3 阶段）
- 位置：packages/core/src/runtime/legacy-agent-driver.ts:137-141，packages/web/src/client/components/sessions/SessionComposer.tsx:160，packages/core/src/session/workflow-job-executor.ts:199、249、281、286，packages/core/src/session/session-store.ts:926，README.md:72，docs/product/tekon-current-product-scope.md:32，docs/manual/tekon-user-manual.md:684
- 现象：`followUp` 和 `steer` 抛 `NotSupportedYet`。interrupted 和 blocked 都被映射成 awaiting-input，首页显示“待输入 / 等待输入”，详情页没有任何输入控件。
- 依据：不能追问和纠偏是产品方向偏差：文档已声明，与目标基准冲突（README:72、范围文档:32、手册:684）。状态映射和文案是实现缺陷（`session-store.ts:926`）。经用户确认（2026-11-06）：驱动现有 harness，在现仓库分阶段替换。
- 影响：用户“插不上手”，状态文字还暗示可以输入。
- 修复建议：拆两步。1）先改 interrupted、blocked 的映射和文案（与 UI-02 同一处修复）。2）再实现消息入口，驱动 harness 续会话（依赖 CD-11）。

### [PD-17] blocked、interrupted 后不能改指令或换 provider，Web 也不能取消
- 维度：产品 | 严重度：S1 | 工作量：M | 置信度：高 | 状态：已确认
- 位置：packages/web/src/client/components/runs/RunControls.tsx:38、55-56，packages/core/src/workflow/gate-runner.ts:533-538，docs/manual/tekon-user-manual.md:287
- 现象：Web 只有 paused、blocked、interrupted 可恢复，恢复沿用 provider 快照和原指令。interrupted 和 blocked 在 Web 上不能取消，CLI 实测能取消 blocked 的 run。Codex 缺失的 run 只有“恢复”一个动作，点了再次中断。
- 依据：沿用快照是产品方向偏差：文档已声明，与目标基准冲突（手册:287）。Web 不能取消是实现缺陷：`RunControls.tsx:56` 只放 running、paused，而 `project.cancel` 和 `requestCancel` 没有状态限制。workflow 进入 failed 只有 `gate-runner.ts:533-538` 的 `onExhausted: fail` 一条路，默认是 block，7 个内置模板都没声明，所以真正的死路是 blocked 和 interrupted。
- 影响：形成死路，用户只能重新发起，新发起时已完成节点无法复用（resume 本身会复用）。
- 修复建议：按优先级：1）放开任何非终态的 Web 取消，只改一行（本 PR）。2）恢复时可换 provider、改指令，“重试此节点”。3）failed 重试放最后。第 2、3 步另排（重构第 2 阶段，和 PD-05 一起）。

### [PD-18] 驳回没有返工路径，备注到不了 agent
- 维度：产品 | 严重度：S1 | 工作量：M | 置信度：高（用 mock 和假 claude 验证，真实 provider 未测） | 状态：已确认，另排（重构第 2 阶段）
- 位置：packages/core/src/gate/human-gate.ts:66、133-170，packages/core/src/workflow/prompt-builder.ts:123-128，packages/core/src/workflow/node-executor.ts:216-220，packages/core/src/workflow/rework.ts，packages/web/src/client/components/approvals/DecisionForm.tsx:71-80
- 现象：驳回后 run 进入 blocked，只剩“恢复”。每次恢复都调用一次 reviewer：假 claude 进程调用计数 1 → 驳回并恢复后 2 → 再驳回并恢复后 3，生成 `review-report.v2` 和新的 pending decision。RD 不重跑，改动不变，复用原 lease（`worktree_leases` 仍是 1 条）。两次 prompt `diff` 为空，备注标记出现 0 次。
- 依据：`prompt-builder.ts:123-128` 不读 note，全仓读取 `decision.note` 的只有 repositories、approval/summary、web mappers。驳回备注还会覆盖请求上下文的 `note`（`human-gate.ts:66、145`）。返工框架已支持目标节点和 reviewFeedback，只是只由 independent-review 的 changes-requested 触发。
- 影响：涉及 bugfix、plan-only。审批实际只有“批准或放弃”两个结果，用户的修改意见传不到 agent，每次恢复还多花一次 agent 成本。
- 修复建议：把 human 拒绝接入 `rework.ts` 的 `attemptChangesRequestedRework` 和 `buildReworkNodePrompt`。现有返工不能直接复用，要改三点：
  - **触发点：** 返工现在只由 `gate-runner.ts:498` 的进程内循环触发，人工驳回发生在 blocked 之后的 resume，要在 resume 路径增加入口。
  - **反馈来源：** 现有反馈读评审产物（`rework.ts:300`），这里要读决策备注。决策备注和请求上下文的 `note` 字段拆开。
  - **目标节点：** 人工门禁在 `reviewer-review`（workflows/bugfix.yaml:61-68），决策没有 `reviewProcess.targetNodeId`。由模板声明返工目标，或驳回时由用户选择；不用启发式（见 CD-14）。

### [PD-19] 产物不能评论或圈选，预览只有纯文本
- 维度：产品 | 严重度：S1 | 工作量：L | 置信度：高 | 状态：已确认，另排（重构第 6 阶段）
- 位置：packages/web/src/client/pages/run-detail/ArtifactsTab.tsx:265，packages/web/package.json
- 现象：产物用 `CodeBlock` 展示原文，不渲染 Markdown。client 没有 getSelection 和批注实现，命中的 “comment” 都是代码注释。没有 Markdown 依赖，也没有 iframe。
- 依据：产品方向偏差：文档未承诺该能力，与目标基准冲突。
- 影响：目标基准②“在 HTML 上圈选、评论和 agent 对齐”完全缺失。
- 修复建议：拆两步。1）先做 Markdown 和 HTML 渲染，产物按不可信内容处理：Markdown 净化，HTML 放与控制台隔离的沙箱 iframe，页面安全策略同步调整。2）再做选区评论，并作为下一轮输入（依赖 PD-16、PD-18）。

### [PD-21] 运行结果只留在 delivery 分支且没有指引，非 standard-delivery 不能交付
- 维度：产品、代码 | 严重度：S1 | 工作量：M | 置信度：高 | 状态：已确认（合并 CD-34），另排（重构第 2 阶段）
- 位置：packages/core/src/delivery/pre-pr-readiness.ts:70-71，packages/web/src/client/pages/DeliveryPage.tsx:80-84，docs/manual/tekon-user-manual.md:79、208、546，README.md:46-51
- 现象：bugfix 运行 passed 后，`delivery prepare` 报 `run is not ready for PR creation: standard-delivery-template: workflow template is bugfix; …`，并列出缺失的治理门禁。main 没有变化，改动只在 `tekon-delivery/run_*` 分支。Web 的 Delivery 显示分支和 diff 统计，`review` 输出 `diffBranch`、`diffAvailable`，但手册和 README 都没提这个分支，也没有合入指引。Web 的 Prepare PR 按钮可点，点了才报错。
- 依据：仅支持 standard-delivery 是产品方向偏差：文档已声明，与目标基准冲突（手册:79、208、546）。README 把 bugfix、standard-feature 列为可选模板却没说明不能交付，是小缺陷。按钮是实现缺陷：`canPrepare` 只看 workflow 状态。readiness 还硬要求 QA signoff、governance gates、security-scan、acceptance 证据，只去掉模板判断不够。`standard-delivery` 字面量出现在 13 个文件以上。经用户确认（2026-11-06）：模板声明出 PR 所需证据。
- 影响：7 个模板中 6 个跑通后没有交付路径，而 Draft 恰恰会推荐这些模板。
- 修复建议：模板声明出 PR 所需证据，readiness 按声明校验。结束页明确“结果在哪”，提供 diff 和应用到分支的动作。按钮按准备度提前禁用并说明原因。

### [PD-22] 全局审批队列和交付页只看最新一个 run
- 维度：产品 | 严重度：S1 | 工作量：S | 置信度：高 | 状态：已确认
- 位置：packages/web/src/client/pages/ApprovalsPage.tsx:26、40，packages/web/src/client/pages/DeliveryPage.tsx:36，packages/web/src/client/pages/run-detail/DeliveryTab.tsx
- 现象：Approvals 只指向最新 run，显示“没有待处理审批”，同时另外 3 个 run 各有 1 条 pending，首页显示 3 个待审批。Delivery 页没有 run 选择器。run 详情的 Delivery tab 没有操作按钮（`<button` 计数 0）。
- 依据：Approvals 页与首页对照，实现缺陷。缓解：Session 详情页可以按会话审批。
- 影响：审批可能遗漏，较早的 run 只能走 CLI 交付。
- 修复建议：审批队列查全部 pending（本 PR）。交付动作下沉到 run 详情，全局页删除，另排（重构第 4 阶段）。

### [PD-24] defaultAgent 只对 CLI 生效，重跑 init 还会覆盖配置
- 维度：产品、代码 | 严重度：S1 | 工作量：S | 置信度：高 | 状态：已确认（合并 CD-22）
- 位置：packages/cli/src/lib/context.ts:128-137，packages/cli/src/commands/init.ts:37，packages/cli/src/commands/run.ts:190，packages/web/src/server/api/routers/project-with-run-mode-policy.ts:26，packages/web/src/client/components/runs/StartRunForm.tsx:69，packages/core/src/session/workflow-job-executor.ts:128，packages/core/src/workflow/engine.ts:399-400，packages/core/src/types/config.ts:166-177
- 现象：CLI 读取 `defaultAgent`，手改 `mock` 后 run 生效。Web 两个入口都默认 codex。重跑 `tekon init` 把 `mock` 重置回 `codex`，repo-profile 和 web-session 不受影响。`storage.dataDir` 写入配置但路径写死。projectName 写死 'tekon'，每个 run 新建 project（5 个 run 对应 5 个同名 project）。
- 依据：Web 固定 Codex 是产品方向偏差：文档已声明，与目标基准冲突（README:25、手册:684）。`init` 覆盖是实现缺陷：同函数对 web-session.json 和 repo-profile 有 existsSync 保护，对 config.yaml 没有。
- 影响：本机没有可用 Codex 的 Claude 用户在 Web 首页必败。用户配置被静默覆盖，配置文件里的字段看起来可改，实际无效。
- 修复建议：Web 读取 `defaultAgent`，同一 PR 处理 Web 写权限基线（见 PD-10），用 fake claude 测试锁定 Web 入口的权限参数，合入前用真实 Claude 从 Web 跑通一个写节点。`init` 已存在就合并或跳过。删除无效字段。

### [PD-25] Web 双入口、双模型互不连通
- 维度：产品 | 严重度：S1 | 工作量：L | 置信度：高 | 状态：已确认，另排（重构第 4 阶段）
- 位置：packages/web/src/client/App.tsx:48-95，packages/web/src/client/layouts/Sidebar.tsx:203，packages/web/src/client/layouts/TopBar.tsx:27，packages/web/src/client/lib/route-paths.ts:4-6，docs/manual/tekon-user-manual.md:682-684
- 现象：Sessions 与 Runs 为 8:8 一一对应。“启动受控交付”会跳转；“新建运行”留在列表页，只有 flash 和内联的“观察原会话”链接。Claude、Goal 只在 Advanced。品牌在 Workspace 和 Cockpit 间切换。`/advanced/runs/:id/review` 与 Overview 重复（`App.tsx:62-63`）。
- 依据：产品方向偏差：文档已声明，与目标基准冲突（`route-paths.ts:4-6` 和手册:682-684 写明双轨，手册称 Advanced 是“旧 Run Dashboard 保留”）。经用户确认（2026-11-06）：任务一对多 run，Web 只留一套入口；前端控制台改信息架构和数据来源，不换技术栈，分阶段。
- 影响：同一个任务要在两套视图间猜，核心能力藏在“高级”里。
- 修复建议：分阶段：1）统一为一个任务列表和一个任务详情，任务一对多 run。2）只留一个发起入口，高级选项折叠。3）删除 Dashboard 和重复路由。

### [PD-31] blocked 恢复一律盲目重跑 agent（prompt 不含失败原因），门禁确定性失败时每次白花一个节点
- 维度：产品 | 严重度：S1 | 工作量：M | 置信度：高（调用计数实测，真实 provider 未测） | 状态：已确认，另排（重构第 2 阶段）
- 位置：packages/core/src/workflow/node-executor.ts:155-159、205、288，packages/core/src/workflow/prompt-builder.ts:123-127，docs/manual/tekon-user-manual.md:502
- 现象：`resumeFromGate` 不包含 blocked，恢复时新建 role_run 并调用 agent。bugfix 模板实测每次 resume 都多一次 agent 调用，prompt 都不含失败原因：
  - `missing-command`：3 次 resume 后 rd-fix=4（另有 pm-triage=1，共 5 条），仍 blocked，`lease.created` 不增加，prompt 长度完全相同（5292）。
  - `human-rejected`：重跑 reviewer-review，重新等审批，不含驳回备注。
  - `invalid-artifact`（首次注入）：重跑后越过 → paused。
  - `exit-code`（第二次调用时 stub 补文件）：重跑后越过 → paused，prompt 长度相同（5292）。
- 依据：恢复逻辑不看阻塞原因，`prompt-builder.ts:123-127` 只保留 passed、skipped 的门禁，手册:502 只说“阻塞节点重跑”，没有说明成本。这是独立根因，PD-05、PD-18、CD-46 只是共用这条路径：修了本条，PD-05 仍 blocked；PD-18 恰恰需要带反馈重跑；CD-46 修复后不再触发，未修时每次 resume 多一次 pmo 调用。
- 影响：每次恢复多一次节点级 agent 调用，耗时不超过该节点超时；确定性失败不会因为重跑变好。
- 修复建议：
  1. 白名单 fail-fast，未列入的一律不 fail-fast。只放 `missing-command`（绑定已冻结，`gate/engine.ts:100` 在无 command 时直接失败，实测一致）、`rejected`（allow 策略拒绝，恢复时策略不变，实测 PD-04 路径得到此分类）和 `unsupported-gate`（读码判定）。前提是当前节点最新失败门禁的分类在白名单内，并按类别判断：`missing-command` 要求绑定的 command 仍为空；`rejected` 要求当前策略仍拒绝该命令；采用 `--rebind` 后都按新绑定重新判定。判定放在 `checkedTransitionNode` 和创建 role_run 之前，节点保持 blocked，CLI 输出原因和下一步，退出码为 2。
  2. 其他类别保留 agent 重跑，复用 `buildRepairPrompt` 注入失败原因。`exit-code`、`invalid-artifact` 已实测可恢复，`timeout`、`security-findings`、`missing-artifact`、AC、role-scope、review 类、`process-*` 是读码判断。`human-rejected`、`review-not-approved` 需要人的反馈，交给 PD-18。
  3. 不把“agent 已完成就只重跑门禁”设为默认，否则产物不合法时永远过不了。它只做显式选项（如 `--gates-only`），用于用户手工修好环境或工作树后的 `exit-code`、`timeout`。

### [PD-23] CLI 帮助和错误信息不指导下一步
- 维度：产品 | 严重度：S2 | 工作量：S | 置信度：高 | 状态：已确认
- 位置：packages/cli/src/commands/init.ts，packages/cli/src/commands/help.ts，packages/cli/src/commands/workflow.ts，packages/cli/src/commands/status.ts，docs/manual/tekon-user-manual.md:674
- 现象：`workflow --help` 报“工作流名称不能为空”。`status --help` 报 `Unknown option '--help'`。`tekon help run` 只有 4 行，不列 `--agent`、`--template`。无效模板报 `ENOENT ... nope.yaml`。非 git 目录 `init` 成功（exit 0），到 run 才报 `fatal: not a git repository`。无提交仓库 run 显示“已启动”后 interrupted。`review` 输出行数依样本为 111 行（Goal）、152 行（bugfix blocked）到 516 行（blocked）。
- 依据：CLI 实测复现，手册:674 承认帮助不保证列全。
- 影响：首次使用反复碰壁。
- 修复建议：入口层统一拦截 `--help`。`init` 提示缺 git 或首个提交，只在选用 worktree 时阻断（git 将变为可选，见 CD-09）。模板错误列出可选名。`review` 默认摘要，`--full` 看全量。

### [PD-26] 内部自检和未完成功能外露给用户
- 维度：产品 | 严重度：S2 | 工作量：M | 置信度：高 | 状态：已确认
- 位置：packages/cli/src/index.ts:92，packages/core/src/draft/shape.ts:242-250，packages/web/src/client/pages/evaluations/WorkflowSelectionTab.tsx:34，packages/web/src/client/pages/EvaluationsPage.tsx，docs/manual/tekon-user-manual.md:76、166
- 现象：19 个顶层命令加 29 个子命令。`draft plan` 只置标志位，帮助写“生成计划产物”，手册 §6.5.1 写“生成……结构化计划快照”。`eval` 的 demand-shape、workflow-selection、approval-summary 是自检，work-usability 是团队内部验收。Web Eval 要选 run（有“使用最新”按钮和预填 placeholder），并有 Coming Soon 页。`constraints show` 读安装目录文件。`clean` 已停用但仍列出。
- 依据：`tekon help` 和 Evaluations 页实测。调用方判定已排除 CLI 和 Web 入口的直接调用，这里讨论的是外露是否必要，不是死代码。
- 影响：命令面和导航都被稀释，用户分不清什么才是该用的。
- 修复建议：`clean` 恢复前从列表隐藏，自检类 eval 改为隐藏，下线 Coming Soon，`constraints show` 改读目标仓库，`draft plan` 改文案或真生成。`eval approval-summary`、`demand-shape` 是手册流程步骤（手册:76、166），改动要同步文档。

### [PD-27] 文档体量失衡，手册混入研发规则
- 维度：产品 | 严重度：S2 | 工作量：M | 置信度：高 | 状态：已确认（2026-11-09 用户决定）；另排（重构第 4 阶段之后）
- 位置：docs/reviews/，docs/manual/tekon-user-manual.md:500-504、745-764、885-891，scripts/install.sh:70，README.md
- 现象：docs 共 46MB，其中 docs/reviews 45MB（242 png、60 log、34 json、16 html、7 md）。其余现行文档只有 12 个文件，约 364K。手册 891 行，HTML 版 1008 行。§7.1 中英对照重复，§12 是研发维护规则，§6.10（手册:500-504）等写租约等内部概念。
- 依据：`du`、`find` 实测。仓库自己要求手册“面向工具使用者”。
- 影响：`install.sh` 即使 `--depth 1` 也会检出全部工作树文件，迁出后工作树减少约 45MB（算式 46M−1M，压缩后实际下载量未实测）。用户手册违背仓库自己的要求。
- 修复建议：经用户确认（2026-11-09）：`docs/reviews` 不迁到独立分支，改为整合精简过程性文档和产物。有长期价值的结论并入产品范围、运行时合同、手册等固定文档，或合并成一份完整记录；截图、日志等中间产物只保留被固定文档引用的。手册拆成不超过 100 行的上手页和参考页，删除 §12 和 §7.1 重复部分。截图会随重构第 4 阶段的页面重做而变，所以放在第 4 阶段之后做。

### 4.2 UI 与交互

### [UI-02] 同一状态多套标签，interrupted 还显示成“待输入”
- 维度：UI | 严重度：S1 | 工作量：S | 置信度：高 | 状态：已确认
- 位置：packages/web/src/client/pages/SessionsPage.tsx:32，packages/web/src/client/components/ui/StatusBadge.tsx:44-45、57，packages/web/src/client/components/runs/RunTable.tsx:37，packages/core/src/session/session-store.ts:926
- 现象：等审批时，列表显示“待审批”加“等待审批”，详情显示“已暂停”，Runs 表显示 `paused`。中断时，列表显示“待输入”加“等待输入”，详情显示“已中断”，Runs 表显示 `interrupted`。通过时，三处分别是“已完成”“已通过”、`passed`。blocked 也映射到“待输入”。
- 依据：实现缺陷。页面实测三处标签不一致；状态徽章有两套实现。
- 影响：用户无法判断是否需要自己动手。
- 修复建议：改成单一的状态到标签映射，列表只保留一个徽章。“待输入”的修正和 PD-16 第 1 步是同一处修复。

### [UI-03] Advanced Dashboard 数字自相矛盾，列内容错误
- 维度：UI | 严重度：S1 | 工作量：S | 置信度：高 | 状态：已确认
- 位置：packages/web/src/client/pages/DashboardPage.tsx:59、166、202、247、369、391
- 现象：同屏出现 “8 runs · 3 pending”“no active runs · 3 pending”、待审批卡 0、Active Run “Pending approvals 1”、面板 “No pending approvals”。TEMPLATE 列显示 `demand_<uuid>`，PHASES 列实际是门禁计数。
- 依据：实现缺陷，根因是错误数据和只看最新 run 的口径，和双入口无关。`templateFromDemandId` 直接返回 demandId，`pendingCount` 把 paused 算入。页面实测，数据来自 mock 合成仓库，真实 provider 未测。
- 影响：总览不可信。
- 修复建议：用户已确认 Web 只留一套入口（见 PD-25），Dashboard 不值得再修。“高级 Advanced”入口和其他分组都依赖 `/advanced` 路径（`Sidebar.tsx:41、178-179`），所以重构第 1 阶段把 `/advanced` 重定向到 `/advanced/runs`，只移除 Dashboard 页，入口保留到第 4 阶段。

### [UI-04] 审批卡难用且结论矛盾
- 维度：UI | 严重度：S1 | 工作量：M | 置信度：高 | 状态：已确认，另排（重构第 4 阶段）
- 位置：packages/web/src/client/components/approvals/DecisionCard.tsx:100，packages/web/src/client/components/approvals/ApprovalSummary.tsx:37，packages/web/src/client/lib/check-labels.ts:247、255
- 现象：批准按钮在 1440 宽度下位于 y=1970-2072（视口 900），390 宽度下位于 y=2455-2974，随会话不同，页面高分别可达 2754、3713。卡片堆满带绝对路径的 CLI 命令，“规划一个 CLI 工具”会话的摘要有 2847 字符，没有产物正文和 diff。3 个会话都显示“就绪度 100% — 已就绪”，而该会话同卡 Readiness 失败项有 9 条。Web 发起的会话左侧 feed 还同屏显示“交付准备度 · 未通过”。风险显示“未知”，同卡却有 `risk=human-control`。命令显示 `not_applicable`，证据链接文字是 `gate_<uuid>`、`worktree.lease.created`。
- 依据：实现缺陷。该分数实际是 approvalEvaluation（摘要完整性），不是 readiness。页面实测，数据来自 mock 合成仓库，真实 provider 未测。
- 影响：用户决定批准时没有可依据的实质内容，还被矛盾信息误导。
- 修复建议：顶部写清“要你决定什么”，内嵌产物和 diff，操作按钮固定在视口内；“就绪度”改名“摘要完整性”或删除；证据链接用人话命名。

### [UI-05] Run Overview 把“还没创建 PR”显示成失败
- 维度：UI | 严重度：S1 | 工作量：S | 置信度：高 | 状态：已确认
- 位置：packages/web/src/client/pages/run-detail/OverviewTab.tsx，packages/web/src/client/lib/check-labels.ts:155，README.md:53
- 现象：已通过的 run 顶部是绿色 0.73 加红色“失败”，并显示粉色进度条。3 个失败项是 PR 准备、PR 创建、远程 CI。建议写“远程 CI 未通过，查看 CI 日志修复”，实际事实是 `remote CI status not checked`。已通过的行也挂红色 REQUIRED。4 个 passed run 全部 ready=false（0.36、0.73、0.64、0.73），Goal 的 7 项失败含不适用项。
- 依据：实现缺陷。README.md:53 只声明了“passed 不等于 ready”，没有解释这种显示。页面实测，数据来自 mock 合成仓库，真实 provider 未测。
- 影响：只想本地跑任务的用户永远看到失败，也无从判断任务是否成功。
- 修复建议：把“任务结果”和“交付进度”分开；未开始的显示“未开始”，不适用的不计入失败；建议文案按实际状态给出。

### [UI-01] 首页被执行前计划占据，任务列表被挤下去
- 维度：UI | 严重度：S2 | 工作量：S | 置信度：高 | 状态：已确认
- 位置：packages/web/src/client/components/sessions/SessionComposer.tsx，packages/web/src/client/pages/SessionsPage.tsx
- 现象：首屏主体是 `pm → pm → pm → rd …`、“44 个控制点”“计划未请求不受限网络”。展开后是 44 行“schema / 按检查规则执行 / 模板定义”。第一条任务在 1440 宽度下位于 y=565，390 宽度下位于 y=734（视口 844）。
- 依据：页面实测，两个宽度的位置均已复现。
- 影响：新用户第一眼看到的是内部术语，老用户要滚动才能看到任务。
- 修复建议：计划折叠成一行摘要；任务列表上移或与输入框并列。

### [UI-06] 节点 ID 的 `run_<uuid>_` 前缀撑坏布局
- 维度：UI | 严重度：S2 | 工作量：S | 置信度：高 | 状态：已确认
- 位置：packages/web/src/client/pages/run-detail/ArtifactsTab.tsx，packages/web/src/client/pages/run-detail/GatesTab.tsx，packages/web/src/client/components/runs/RunTable.tsx:168
- 现象：standard-delivery run 的 Artifacts 页有 16 个节点 chip，1440 宽度下页面宽 2683px，chip 区在 768 宽度下高 589px，390 宽度下高 896px。Runs 表的 PROGRESS 列也显示这种 ID。
- 依据：实测 `scrollWidth=2683`。内容仍可达，列表首屏可读。只有 standard-delivery 这类节点多的模板溢出，bugfix 不溢出。
- 影响：在默认的 standard-delivery 模板下，查看产物的主页面需要横向滚动，chip 区占满一屏。
- 修复建议：显示时去掉前缀，优先用节点名；chip 改下拉；PROGRESS 列改为“X/N 当前步骤”。工作量小，可以优先修。

### [UI-07] 中英混用，时间格式三套
- 维度：UI | 严重度：S2 | 工作量：M | 置信度：高 | 状态：已确认
- 位置：packages/web/src/client/pages/DashboardPage.tsx:33、46，packages/web/src/client/components/runs/RunTable.tsx:46、58，packages/web/src/client/lib/relative-time.ts:10，packages/web/src/client/pages/RunDetailPage.tsx:39，packages/web/src/client/pages/ApprovalsPage.tsx:131，packages/web/src/client/lib/approval-feedback.ts:5
- 现象：`passed` 与“已通过”并存，“3m ago”与“3分钟前”并存，“No pending approvals”与“没有待处理审批”并存，flash “Decision … rejected”与“审批已记录，运行恢复已入队。”并存。页面标题 Dashboard、Approvals、Delivery、Config、Evaluations 与“需求澄清”并存。时长 “0m”与 “0m 4s”并存。
- 依据：页面实测；时间函数分散在上述 4 个文件。
- 影响：显得粗糙，增加认读成本。
- 修复建议：单一中文文案表（不引入 i18n 框架）；一个时间工具函数。

### [UI-08] 错误提示模板答非所问
- 维度：UI | 严重度：S2 | 工作量：S | 置信度：高 | 状态：已确认
- 位置：packages/web/src/client/components/ui/ErrorBanner.tsx:47-48、50-60、81，packages/web/src/server/api/routers/project.ts:428-431，docs/manual/tekon-user-manual.md:680
- 现象：Prepare PR 被业务规则拒绝，却显示“请求参数有误”“确认必填字段是否已填写”。无 token 时显示 “Session token is required”“联系管理员重新生成 Token”。同类还有 “Token 可能已过期”“请刷新页面重新登录”。等审批时点恢复，收到英文 “Run has pending human decisions…”。
- 依据：实现缺陷。这是单机工具，没有管理员，也没有登录流程。手册:680 的真实办法是重新打开 `tekon ui` 链接。页面实测复现。
- 影响：提示把用户引向错误方向。
- 修复建议：删除通用建议，服务端返回业务错误码和下一步；令牌提示改为手册写明的真实操作。

### [UI-09] 操作入口不按状态收敛
- 维度：UI | 严重度：S2 | 工作量：S | 置信度：高 | 状态：已确认
- 位置：packages/web/src/client/components/runs/RunControls.tsx:38、55-56，packages/web/src/client/components/demand/DraftCard.tsx:88、149-157，packages/web/src/client/components/runs/StartRunForm.tsx:74、536、662
- 现象：等审批时“恢复”可点，点了报错。Draft 显示“可执行: 否”，发起按钮仍可点。新建表单的模板下拉和运行模式都有 Goal。超时单位是毫秒（默认 3600000）。选 standard-delivery 后控制台出现 11 条错误，抽看的都是重复 key 告警，来源是 `:536` 的 `key={role}`。
- 依据：实现缺陷。五点都已复现；重复 key 的复现方式是打开新建运行，选 standard-delivery，看控制台。
- 影响：用户反复试错。
- 修复建议：按状态禁用并说明原因；超时改分钟；去掉重复的 Goal；key 加序号。

### [UI-10] 空状态失真
- 维度：UI | 严重度：S2 | 工作量：S | 置信度：高 | 状态：已确认
- 位置：packages/web/src/client/pages/run-detail/ProgressTab.tsx:237，packages/web/src/client/pages/config/RolesTab.tsx:61，packages/web/src/client/pages/evaluations/WorkflowSelectionTab.tsx:34，packages/web/src/client/pages/run-detail/GatesTab.tsx:224
- 现象：已通过的 run 显示 “No progress files found”。内置角色在用却显示 “No roles configured”。导航里有 Coming Soon 页。人工门禁显示“该门禁没有输出日志”。终态 Session 侧栏顶部是空白卡片。
- 依据：页面实测，上述代码位置均已核对。
- 影响：空状态说的不是真实情况。
- 修复建议：去掉无功能入口；人工门禁改显示决策人和理由；空状态写明真实原因。

### [UI-11] 窄屏无整页溢出，但关键内容被裁切或拉得过长
- 维度：UI | 严重度：S2 | 工作量：M | 置信度：高 | 状态：已确认
- 位置：packages/web/src/client/pages/RunDetailPage.tsx，packages/web/src/client/components/runs/RunTable.tsx，packages/web/src/client/pages/run-detail/AuditTab.tsx
- 现象：17 个路由在 390 和 768 宽度下都无整页横向溢出。390 宽度下 tab 区 scrollWidth 479、clientWidth 358，能滑但没有提示，Delivery 被截断，Progress 不可见。Runs 表实际宽 847px，右边界 x=864，由内容撑开，390 和 768 宽度都要横向滚动，DEMAND 被裁。Audit 页最坏值是 standard-delivery run：390 宽度高 72204px，768 宽度高 13391px（bugfix run 为 21980、4663）。顶栏在 390 宽度占两行约 108px，768 宽度为 61px。
- 依据：实测 `scrollWidth`、`scrollHeight`，数据来自 mock 合成仓库，真实 provider 未测。
- 影响：手机上看任务和审批都吃力，批准按钮最低在 y=2974。
- 修复建议：tab 加渐隐提示；小屏表格改卡片；审计 payload 默认折叠。

### [UI-12] 侧栏双高亮，路径溢出
- 维度：UI | 严重度：S2 | 工作量：S | 置信度：高 | 状态：已确认
- 位置：packages/web/src/client/layouts/Sidebar.tsx:226、242-244，packages/web/src/client/styles/reset.css:200-206
- 现象：“高级 Advanced”和子项同时高亮，`end` 只对首页生效。底部仓库路径溢出被裁，裁切程度取决于路径长度。
- 依据：页面实测；路径样式没有 overflow 控制。
- 影响：当前位置不清晰。
- 修复建议：父项加 `end`；路径改中间省略并加 title。

### [UI-13] 自家 CSP 拦截字体和控件图标，控制台持续报错
- 维度：UI | 严重度：S2 | 工作量：S | 置信度：高 | 状态：已确认
- 位置：packages/web/src/client/styles/tokens.css:1，packages/web/src/server/http.ts:493-495
- 现象：设计字体和 select 箭头图标被自家 CSP 拦截，控制台持续报错，“Newest first”下拉看起来像输入框。
- 依据：控制台实测复现，页面显示与之一致。
- 影响：设计字体不生效，控制台一直有错误，真问题容易被淹没。
- 修复建议：字体本地打包或删除；让控件图标能正常加载。

### [UI-15] 无操作意义的术语提示和反复的“未通过”
- 维度：UI | 严重度：S2 | 工作量：S | 置信度：高 | 状态：已确认
- 位置：packages/web/src/client/components/runs/ExecutionBindingNotice.tsx:2，packages/web/src/client/lib/event-feed.ts:179、224
- 现象：每个任务页都有“仓库检查已绑定…此提示不保证…”横幅。Goal 运行也显示“受控交付已开始”“交付运行”。Web 发起的会话里，feed 重复出现“交付准备度 · 未通过”，重复程度依样本而定。
- 依据：页面实测，数据来自 mock 合成仓库，真实 provider 未测。
- 影响：常态性噪声和假警报，用户会习惯性忽略提示。
- 修复建议：横幅只在配置确实有差异时显示，同时满足 PD-05 的差异提示；准备度只在结束时出现一次；按模式显示文案。

### [UI-14] 样式实现分散
- 维度：UI | 严重度：S3 | 工作量：M | 置信度：高 | 状态：已确认
- 位置：packages/web/src/client（全局），对照 packages/web/src/client/components/ui/StatusBadge.tsx:57 与 packages/web/src/client/components/runs/RunTable.tsx:37
- 现象：338 处内联 `style={{`（40 个文件）；`.tsx` 中 39 处十六进制颜色（6 位色值在 11 个文件）；53 行 emoji（24 个文件）与 SVG 图标混用；两套状态徽章。
- 依据：grep 计数，已复算一致。
- 影响：一致性问题会持续增加，目前不直接阻塞使用。
- 修复建议：改到相关页面时顺带收敛，不单独立项。

### 4.3 代码实现

### [CD-01] Claude 适配器的环境白名单丢 USER，macOS Keychain 登录下首节点失败
- 维度：代码、产品 | 严重度：S0 | 工作量：S | 置信度：高 | 状态：已修复（hotfix #39，合并提交 dc1a156，v0.26.2）
- 位置：packages/core/src/runtime/claude-code-support.ts:9-18，:24-34，packages/core/src/runtime/claude-code-adapter.ts:94-101，packages/core/src/runtime/command-gateway.ts:290-321，packages/core/src/runtime/dsh-headless-adapter.ts:47-56，packages/core/__tests__/runtime/claude-provider-smoke-evidence.test.ts:33-48
- 现象：`buildClaudeProviderEnv` 只复制 8 个键：PATH、HOME、TMPDIR、TMP、TEMP、LANG、LC_ALL、SHELL，适配器用 `envMode:'exact'` 启动子进程。白名单共 3 份。父进程设 USER、LOGNAME、ANTHROPIC_API_KEY、CLAUDE_CONFIG_DIR、HTTPS_PROXY、OPENAI_API_KEY、CODEX_HOME 时，Claude 和 Codex stub 收到的键都只有 `_ HOME LANG PATH PWD SHELL SHLVL TEKON_* TMPDIR`。
- 依据：
  - 事实：`env -i` 只带白名单时 `claude -p` 报未登录，加上 USER 后成功（Claude Code 2.1.318，macOS Keychain 登录）。
  - 事实：剔除 API key 是有意的，上述测试明确断言，但手册和 README 都没写。缺 USER 是无意的：白名单加 USER 后全量测试 0 failed，没有测试锁定它。
  - 事实：`ANTHROPIC_BASE_URL` 按白名单代码同样被丢弃，未单独实测。
  - 推断：`packages/cli/src/draft-agent.ts:228-239` 用 `execFileSync` 继承完整环境，所以同一台机器上 draft 路径应能调到 Claude，`tekon run` 不能。
- 影响：macOS Keychain 登录用户使用 `--agent claude-code` 会在首节点失败（已实测）。API key、代理、自定义配置目录的用户同样会失败或连不上，这是推断，真实认证未测；Linux 文件凭据可能不受影响。
- 修复建议：经用户确认（2026-11-06）：Claude 白名单补 USER、LOGNAME、代理变量、`ANTHROPIC_*`、`CLAUDE_*`，并加可选的显式透传配置项，作为白名单没覆盖时的兜底。
  - **只改 `claude-code-support.ts`。** 不要把这些键并进公共白名单：门禁命令和 Codex 走 `command-gateway.ts:290-321` 的默认环境（`gate/runners.ts:40-57` 不传 env），合并后目标仓库的 `npm run build` 会拿到 Anthropic 凭据。补测试锁定门禁命令收不到 provider 凭据。
  - **透传 key 后行为会变。** 官方[认证优先级](https://code.claude.com/docs/en/authentication)写明 `ANTHROPIC_AUTH_TOKEN`、`ANTHROPIC_API_KEY` 优先于订阅，`-p` 下有 key 就总用 key。经用户确认（2026-11-06）：Tekon 不做认证配置，登录和 key 都用各 agent 自己的配置。所以要显示实际认证来源，并写进 CHANGELOG 和手册；工作和个人场景在同一台机器上时，由用户在 shell 或项目环境里分开。
  - **验证：** 同步修改上述测试并锁定 USER。真实运行 `tekon run --template bugfix --agent claude-code`，覆盖“只有订阅”和“已有订阅登录且 shell 有 key”两种环境，预期不再报未登录，后者走 key 且认证来源显示正确。Codex 的同类问题（`OPENAI_API_KEY`、`CODEX_HOME` 被丢弃）在 PD-02 处理。
- 修复记录：#39 补齐了白名单和前缀，并加了门禁命令收不到 provider 凭据的测试。真实 Claude 订阅登录跑通 bugfix 模板；用无效假 key 验证了 key 优先于订阅，没有用真实 key 跑通。显式透传配置项和认证来源显示属于新功能，移到重构第 1 阶段。行为变化已写进手册和 CHANGELOG：Claude 在节点里执行的命令也能读到 shell 里的 key。

### [CD-46] 默认流程中任一独立评审提出 changes-requested 并返工成功后，run 必定卡死在 pmo-checkpoint
- 维度：代码 | 严重度：S0 | 工作量：S | 置信度：高（只验证了 mock 链路，真实 provider 未测） | 状态：已修复（hotfix #39，合并提交 dc1a156，v0.26.2）
- 位置：packages/core/src/gate/engine.ts:801，:851-862，:874-905，packages/core/src/gate/runners/semantic.ts:292，packages/core/src/workflow/execution-plan.ts:164-174，packages/core/src/workflow/rework.ts:318-345，:374-387，:437-451，packages/core/__tests__/workflow/engine-rework.e2e.test.ts:73
- 现象：不翻转时 16 次 agent 调用后 passed。逐个翻转 standard-delivery 的 9 个 independent-review 节点，9/9 全部 blocked：每次跑 18 次 agent 调用，最终 `pmo-checkpoint` 的 `process-completeness` 失败，分类 `process-artifact-evidence-missing`。两次 resume 各多调一次 pmo，然后仍 blocked。
- 依据：
  - 事实：返工节点克隆了 outputs 和 gates，但产物和门禁结果都记在目标节点上，process-completeness 却按节点 ID 要实物。engine-rework.e2e 用假 gate engine，所以没覆盖到。
  - 事实：默认流程以它为入口（packages/cli/src/commands/run.ts:154，手册:32，Web 默认入口）。`decision` 枚举和 prompt 都含 changes-requested，gate 注释写明它用于触发返工，reviewer 职责要求 Critical/Important 项明确阻断。
  - 事实：7 个内置模板里只有 standard-delivery 同时含 `independent-review`（9 处）和 `process-completeness`（1 处）。其他模板不走这条路是读码判定，未逐个翻转。
  - 推断：PMO 产物只写到自身节点，agent 补不出派生节点的实物，也没有恢复命令。自定义模板若同时含这两种门禁也受影响。
  - 真实频率没有数据：仓库 docs 里 `changes-requested` 只出现在单测日志，`gate.rework`、`passed-after-rework` 没有命中。算式示意：一次 run 经过 9 次评审，单次概率假设 5% 时至少触发一次的概率是 37%，假设 10% 时是 61%。
- 影响：全部 approved 的路径能走通，也没有数据丢失；但评审真正起作用时这条路径 100% 失败。卡点在全流程末尾，只能整 run 重跑，重跑还可能再次触发。
- 修复建议：
  - 只在产物证据和门禁证据两个检查里排除 `order >= DYNAMIC_NODE_ORDER_OFFSET` 的节点，保留 requiredNodes 和状态检查，未到终态的返工节点仍会被拦。只排除产物证据时仍 blocked，分类变成 `process-gate-evidence-missing`。
  - `engine.ts:801` 和 `semantic.ts:292` 是两份实现，要一起改或删一份。
  - 补丁实测 9/9 passed；返工错误路径（rework-agent、target-gate、review-rerun）全部能通过；修复后 `delivery prepare` 成功。副作用是不再单独校验返工节点的证据，它本来没有独立产物，目标节点门禁也已在 rework.ts:437-451 强制重跑。
  - 用真实 gate engine 补 e2e：翻转一次，预期 passed。

- 修复记录：#39 在两份实现里只对产物证据和门禁证据跳过返工节点，状态检查保留；用真实 gate engine 跑 standard-delivery 翻转评审的 e2e 测试锁定。修复时发现一个相关的既有缺陷：两个评审都对同一目标提出修改时，第二次返工节点 ID 冲突（`UNIQUE constraint failed: nodes.id`），run 中断；原因是 `workflow/gate-runner.ts:477` 每个评审都从 0 计数，`rework.ts:283,327` 只用“目标 + 次数”生成 ID。另排到重构第 1 阶段。
### [CD-02] Provider 失败原因被丢弃，所有失败都变成 interrupted 并提示 resume
- 维度：代码、产品 | 严重度：S1 | 工作量：M | 置信度：高 | 状态：已确认（合并 PD-03）
- 位置：packages/core/src/runtime/claude-code-adapter.ts:108-116，:120，:160-171，packages/core/src/runtime/codex-adapter.ts:112-120，packages/core/src/runtime/agent-adapter.ts:55-66，:80-101，packages/core/src/runtime/agent-step-events.ts:133-149，packages/core/src/workflow/helpers.ts:269-282，packages/core/src/workflow/node-executor.ts:386-393，packages/core/src/session/workflow-job-executor.ts:285-290，packages/cli/src/lib/session-context.ts:358-387，packages/cli/src/commands/provider.ts:128-133，packages/cli/src/commands/run.ts，packages/web/src/client/lib/event-feed.ts:125，packages/core/src/delivery/pre-pr-readiness.ts:174
- 现象：
  - stub 输出 “Not logged in” 后 exit 1：CLI 先打印“运行已启动”，再显示 interrupted，并提示“检查旧执行退出情况后 resume”。`tekon log` 只有 `agent failed: provider=claude-code exitCode=1`，原因只在 stdout.log。
  - Codex 缺失时 progress 为 rejected，reason 哪里都看不到，stdout 和 stderr 都是 0 字节。假 Codex 失败时报 `reason=artifact manifest missing`，这个原因是误导的。
  - Web feed 显示“Agent 错误”，没有正文。`tekon review` 给出 `summary=QA release signoff missing`。
- 依据：信息在四处丢失：
  1. 网关返回非 executed 时，适配器只留 `exitCode:1`，丢掉 `reason`。
  2. 非零退出时适配器不读 stdout/stderr，也没有 diagnostic。
  3. `AgentRunDiagnosticCode` 只有 artifact 类，未知 code 被映射成 artifact-file-unreadable。
  4. `assertSuccessfulAgentRun` 只拼 exitCode，抛错后一路变成 interrupted。

  另外，event-feed 的 body 取 `message/error`，而 payload 只有 `{stepId,nodeId,role,exitCode,timedOut}`。`provider preflight` 只支持 dsh-headless。`--output-format json` 已传，`draft-agent.ts:241-254` 也解析 `is_error` 和 `result`，但 Claude 主路径不解析。
- 影响：未登录、CLI 未安装、参数错误这类确定性失败，用户看到的是“可恢复的中断”，resume 只会再失败一次。
- 修复建议：
  - `AgentRunResult` 增加 `failure {kind, message, stdoutTail, stderrTail}`，要取 stdout 尾部，因为 Claude JSON 模式的原因在 stdout。
  - 复用 agent-step-events.ts:133-149 的 diagnostic 通道并新增诊断码，写入 agent/error 事件，在 Web feed 和 `status` 显示。
  - 确定性失败（未登录、CLI 未安装、参数错误）不进终态：`failed` 不可恢复（手册:500），后面节点才遇到登录过期时，前面的节点就全作废了。第 1 阶段统一保持 interrupted（退出码 1），带 `failure.kind`、原因和下一步，不自动重试，用户放弃时才进终态。
  - 启动输出按实际状态变化，未执行的节点在 `review` 显示“未执行”。
  - 给所有 provider 做 preflight，在 `init` 和 `run` 前执行。

### [CD-09] 强依赖 git 和 worktree，只有 code-changes 节点能改文件，Goal 改文件后 resume 走不出
- 维度：代码 | 严重度：S1 | 工作量：M | 置信度：高 | 状态：已确认，另排（重构第 2 阶段）
- 位置：packages/core/src/workflow/lease-service.ts:209-225，:270-276，packages/core/src/runtime/worktree-manager.ts:71-128，packages/cli/src/lib/session-context.ts:346-348，README.md:72-75
- 现象（三种路径均复现）：
  - 非 git 目录：`init` 成功，`run --goal` 输出原始 `fatal: not a git repository`，exit=1。
  - 无 commit 的仓库：interrupted，日志是 `not a valid object name: 'HEAD'`。
  - Goal 加假 Claude 改一个文件：审计事件 `worktree.lease.finalize.failed`，错误是 `node … is not allowed to modify repository source files: a.txt`，run interrupted。改动留在 `.tekon/worktrees/<run>/…`，主仓库不变。resume 两次仍 interrupted，exit=1，每次都重跑 agent。
- 依据：Goal 拒绝改源码这部分是产品方向偏差：文档已声明，与目标基准冲突。实现缺陷是失败走 interrupted 加 resume 提示，用户走不出去。
- 影响：“写一份文档到目录”这种最简单的非研发任务做不了。改动藏在隐藏目录里，用户不知道去哪找。违背目标基准第 1 条。
- 修复建议：节点或模板声明 `workspace: none | in-place | worktree`，文件权限不再从 artifact 类型推断。finalize 被拒时不进终态，保持可恢复（同 CD-02），给出改动路径和取回方法。

### [CD-11] 适配器契约是一次性调用，没有流式事件、续接和用量
- 维度：代码、产品 | 严重度：S1 | 工作量：L（拆成流式事件、resume token、用量三项） | 置信度：高（harness 能力未实测，为中） | 状态：已确认（合并 PD-29），另排（重构第 3 阶段）
- 位置：packages/core/src/runtime/agent-adapter.ts:148-152，:155-157，packages/core/src/runtime/agent-step-events.ts:13-19，:67-215，packages/core/src/runtime/legacy-agent-driver.ts:137-148，:175-177，packages/core/src/runtime/claude-code-adapter.ts:29-30，:183-228，packages/core/src/runtime/codex-adapter.ts:360-429，packages/core/src/runtime/agent-runtime.ts:106-108，packages/core/src/session/job-runner.ts，packages/core/src/types/session-contract.ts:245-261
- 现象：
  - `interface AgentAdapter { runAgent(input): Promise<AgentRunResult> }`，实际是一次性的 `claude -p --output-format json` 和 `codex exec`，进程结束后才合成 `tool/call`、`tool/result`、`completed` 事件。
  - resume 在 Codex 的 args 黑名单里，`--agents`、`--settings` 等在 Claude 黑名单里。runtime 里没有 `stream-json`、`--resume`。
  - `tokenUsage` 只声明，除 agent-step-events.ts:204 透传外无人赋值。
  - core 共 29919 行、90 个文件，包含 job runner、lease、admission、审计链、门禁等。
- 依据：
  - 产品方向偏差：文档已声明（手册:714），与目标基准冲突。
  - 事实：`AgentDriver`、`AgentHandle` 只有 legacy 实现，followUp、steer 抛 NotSupportedYet，resume 抛错。`assistant/chunk`、`plan/updated`、`todo/updated`、`tool/progress`、`agent/steered` 无人发送。
  - 推断：一次性调用是 follow-up 和流式都做不到的共同根因（PD-12、PD-16）。
  - 未验证：`stream-json` 和 `--resume` 未用真实 provider 测试。
- 影响：运行中看不到 agent 在做什么，插不上手，也统计不了成本。runtime 维护成本高，用户能力反而弱于直接用 harness。违背目标基准第 2、5、6 条。
- 修复建议：经用户确认（2026-11-06）：驱动现有 harness，在现仓库分阶段替换。
  - 契约改成事件流加 resume token，从 `session-contract.ts:245-261` 的接缝新增 driver 起步，先在 Claude Code 上做纵向验证。
  - API key 和订阅登录都由各 agent 自己管理，Tekon 不做认证配置；另加一条通用模型通道。
  - `session-contract.ts` 被 12 个源文件引用（Job、事件 schema 在用），只删 `AgentDriver/AgentHandle` 和 legacy driver，不整文件删。

### [CD-12] Provider 输出全量缓存到进程结束，运行中日志为 0 字节，内存无上界
- 维度：代码 | 严重度：S1 | 工作量：S | 置信度：高 | 状态：已确认
- 位置：packages/core/src/security/secrets.ts:52-63，packages/core/src/runtime/command-gateway.ts:351-352，:411-412，:674-683
- 现象（实测）：
  - 假 Claude 输出一行后睡眠：1.5、3、4.5 秒时 stdout.log 都是 0 字节，progress 的 stdoutBytes=31，结束后 82 字节。
  - SIGKILL Tekon 后日志 0 字节，agent 因 `detached:true` 成为孤儿继续运行，job 行留在 running。
  - 300MB 输出时 RSS 1,139,032,064 字节，基线 94,765,056 字节。
- 依据：`createSecretRedactionTransform` 只在 `transform` 里 `chunks.push`，只在 `flush` 里输出。每个 chunk 还同步 `writeFileSync` 一次 progress.json。超时路径的 hard settle 会结束 transform，正常和超时退出不丢日志。
- 影响：`tail -f` 和任何实时展示都不可能，长任务只能看字节数；内存占用等于 agent 总输出；Tekon 被杀时日志全丢，agent 成为孤儿。
- 修复建议：按行流式脱敏，保留跨 chunk 的短尾窗口，边脱敏边落盘，跨行内容单独做状态处理。

### [CD-14] Rework 反馈大多丢失，目标节点靠启发式选择，可能选错
- 维度：代码 | 严重度：S1 | 工作量：M | 置信度：高 | 状态：已确认，另排（重构第 2 阶段）
- 位置：packages/core/src/workflow/rework.ts:100-140，:146-166，packages/core/src/db/repositories.ts:564-575，packages/core/src/workflow/workflow-runtime.ts:194-208，:215-223，:229-231
- 现象：
  - 翻转 pm-test-plan-intent-review 后调用序列是 `… qa-test-plan → qa-test-plan-review → pm-test-plan-intent-review → qa-test-plan-review → pm-test-plan-intent-review → rd-code-change …`，审计 `targetNodeId: qa-test-plan-review`。artifact 里正确的 `reviewProcess.targetNodeId` 被忽略，`qa-test-plan` 没有重跑。
  - 目标解析和反馈提取只读 technical-review、demand-review、requirement-interface-review 三种类型。
  - 反馈：非白名单节点是固定句 “Review found changes that need to be addressed.”；白名单节点有 summary 时给 summary，无 summary 时给被截断的 JSON 头部。具体 findings 从未进入 rework prompt。
- 依据：9 个评审节点中，白名单 5 个，JSON 时目标正确；启发式 4 个，其中 3 个碰巧对、1 个错。白名单节点若用 YAML 或 Markdown 也会走启发式，有 3 个可能错（推断）。repair 节点无 phase 排最后，只在自定义 `autoFix:true` 模板才可能被选中，内置模板没有 autoFix。
- 影响：agent 拿不到具体评审意见就重做，或者重跑错误节点，浪费额度。
- 修复建议：6 种评审类型共用 schema，直接读 `reviewProcess.targetNodeId`（gate 已校验连通性和类型），把 body 和 findings 作为反馈，删除启发式。

### [CD-17] 没有任何插件机制，新增 provider、gate、channel 都要改核心
- 维度：代码、产品 | 严重度：S1 | 工作量：L（拆步见修复建议） | 置信度：高 | 状态：已确认（合并 PD-20），另排（重构第 7 阶段）
- 位置：packages/core/src/runtime/provider-registry.ts:95-235，:275-282，packages/core/src/runtime/agent-runtime.ts:81-85，packages/core/src/gate/registry.ts:78，packages/core/src/types/domain.ts:304，packages/core/src/types/config.ts:101，:166-177，:175，packages/core/src/types/session-contract.ts:128，packages/web/src/server/api/root.ts:147-371，packages/cli/src/lib/session-context.ts，docs/manual/tekon-user-manual.md:458
- 现象：
  - provider registry 是封闭的 `BUILT_IN`，只有 4 个内置，无 register 入口，provider 字面量分布在 29 个文件；custom 快照报不可重放。
  - gate registry 只有内置工厂。channel 零实现，无 webhook、Slack、飞书（只有 draft/shape.ts:553 的 webhook 正则命中）。
  - `tekonConfigSchema` 只有测试使用。组合根 CLI 和 Web 各一份。
  - 手册写明审批摘要“不会发送通知”。
- 依据：session-contract.ts:128 的注释说 string constants “so plugins can merge”，但仓库没有插件。这是方向缺口。现有 RPC 和 SSE 已可由非浏览器客户端经认证调用，CLI 也有 `resume --approve-human`、`approval reject`；真正缺的是稳定公开合同、出站推送和向运行中 agent 发消息。
- 影响：等审批时收不到通知，接入新 provider 或 IM 都要改核心。违背目标基准第 6 条。
- 修复建议：
  1. 合并组合根。
  2. Driver 接口随 CD-11 在重构第 3 阶段定义。本条在第 7 阶段公开 Channel 接口和插件加载，用配置声明；Viewer、Hook 等有第二个实现再开。Gate 先做成“命令”和“人工”两种，不开放任意插件。
  3. 增加事件 webhook。
  4. 把现有 RPC 文档化并定义版本合同，不新建 API；向运行中 agent 发消息依赖 PD-16。

### [CD-18] 运行资源没有清理路径：分支、worktree 累积，`tekon clean` 永远失败
- 维度：代码、产品 | 严重度：S1 | 工作量：M | 置信度：高 | 状态：已确认（合并 PD-28）
- 位置：packages/core/src/runtime/worktree-manager.ts:219-242，packages/web/src/server/api/routers/project.ts:472-528，packages/core/src/workflow/dynamic.ts:145-146，:430，packages/cli/src/index.ts:92，:164，docs/manual/tekon-user-manual.md:654-664
- 现象：
  - 一次 standard-delivery mock 后 git 分支 18 个（main、tekon-delivery、16 个 `tekon/<run>/…`）。`.tekon` 有 433 个文件、43 个目录、2.0M，其中 `commands/` 339 个文件。
  - 走查仓库 8 个 run 留下 49 个分支：1 个 main、8 个 delivery、40 个节点分支，每 run 2 到 17 个。
  - `tekon cancel` 后 worktree 仍在。走查仓库另有 3 个 worktree，全属 paused run 的 reviewer，恢复时要用，不是残留；其余 run 的 worktree 已回收，只剩空目录。
  - `tekon clean` 报 `CLEAN_SUSPENDED`，exit=1，手册已写明停用。
  - 动态工作流每次预览都建临时目录，实测留下 52 个。
- 依据：`releaseLease` 只移除 worktree、不删分支；`pruneStaleLeases` 无生产调用；Web 的 clean 写审计后永远抛错。
- 影响：用得越久，用户的 `git branch` 越乱，磁盘只增不减。
- 修复建议：run 进入终态后自动清理节点分支和 worktree；`tekon-delivery/<run>` 是交付物，不能删；paused run 的 worktree 要保留。对终态 run 恢复一个安全的 `tekon clean`。

### [CD-20] 工作流定义的引用语法反直觉，报错不指路，查看命令过简
- 维度：代码 | 严重度：S1 | 工作量：S | 置信度：高 | 状态：已确认，另排（重构第 2 阶段）
- 位置：packages/core/src/workflow/template.ts:438-441，:620-650，packages/cli/src/commands/workflow.ts:211-220，:222-243
- 现象：手写两节点 YAML 连续失败三次（已复现）：
  - 同 phase `dependsOn` 报 `unknown dependency "writer"`。
  - 写 `p1-writer` 报同样的错。
  - `inputs: writer:tech-design` 报 `unknown dependency "writer:tech-design"`（实际要写输出 id 加类型）。

  跨 phase 的正确写法 exit 0。`workflow show` 只输出 id、name、phases；`workflow create` 用正则从模板复制。
- 依据：dependsOn 不允许引用同 phase 节点的规则，报错里没有说明，可用的节点 id 和输出 id 也没有列出。
- 影响：这是用户说的“工作流定义不了”的直接来源。
- 修复建议：这条是 S 级，先做，只改报错和提示，不改格式：报错说明同 phase 规则并列出可用的节点 id 和输出 id。`show` 已会解析校验，加强它展示完整结构，就能替代新增 validate 命令。格式本身的简化（`steps`、`agent`、`needs`）在重构第 5 阶段做。

### [CD-29] Runner 可认领其他进程的 job，退出时会杀掉
- 维度：代码 | 严重度：S1 | 工作量：S | 置信度：高 | 状态：已确认
- 位置：packages/core/src/session/session-store.ts:726-765，packages/core/src/session/job-runner.ts:400-432，:574-586，:588-666，packages/cli/src/lib/session-context.ts:187-199，:283-286，packages/cli/src/commands/run.ts:287，packages/cli/src/commands/approval.ts:347，packages/web/src/server/api/root.ts:224，docs/technical/tekon-runtime-contract.md:70
- 现象：
  - `claimNext` 没有按发起进程过滤，CLI 和 Web 都启动 runner。`stop()` 5 秒后对自己持有的全部 job 执行 abort 和 SIGKILL。
  - 实测（真实 Web 组合根，不监听端口，加一个长 CLI 运行）：Web 发起 10 次 Goal，5 次被 CLI 认领。
  - 长 Web job 第一次就被 CLI 认领；CLI 自己的 job 结束后约 5 秒，Web job 变 `interrupted`、abort_state=stopped，workflow interrupted，agent 被杀。CLI 自己 exit 0，没有任何提示。
  - CLI 对 CLI 的并发启动，此前 10 次竞争 0 次跨进程认领（CLI 在 admission 后立即 poll，窗口很窄），未重复验证。
- 依据：`session-context.ts:187-199` 的注释只承认 automation job 的情况，运行时合同只说各自运行。
- 影响：Web 发起的 run 会被一个无关的 `tekon run` 退出时杀掉，且没有提示。环境变量也可能来自错误的进程。
- 修复建议：CLI 按 jobId 只认领自己的 job，Web 只认领非 CLI 发起的，stop 不杀他人的 job。

### [CD-40] 安全类，详情见私下渠道
- 维度：代码 | 严重度：S1 | 状态：已确认，单独小 PR
- 说明：细节未公开，走单独小 PR，提交信息不描述弱点。修复者向维护者索取细节；拿不到时不要处理并注明。

### [CD-45] 存活进程的 job 被自己的 poll 判为 stale，暂停或时钟跳变超过 30 秒后运行被杀
- 维度：代码 | 严重度：S1 | 工作量：S | 置信度：高（暂停已复现，时钟前跳已模拟，真实休眠未测） | 状态：已确认
- 位置：packages/core/src/session/session-store.ts:882-903，:914-938，packages/core/src/session/job-runner.ts:355-374，:400-442，packages/core/__tests__/session/job-runner.test.ts:598，:678，docs/manual/tekon-user-manual.md:500
- 现象（真实 CLI 加长任务假 claude）：
  - SIGSTOP 40 秒、SIGCONT 后 3 秒内 job 变 `interrupted|NULL|NULL`，workflow interrupted，agent 被杀，CLI exit=1，stderr 有 `JOB_FENCING`。
  - SIGSTOP 32 秒同样被判中断，阈值就是 30 秒 TTL。
  - SIGSTOP 15 秒：租约恢复续期，最终 passed，exit=0。
  - 不暂停、不休眠，只模拟墙钟前跳 60 秒：job 同样 interrupted、exit=1，agent 约 5 秒后停止。
- 依据：
  - 事实：`interruptStale` 的 SQL 只看状态和过期时间，没有 owner 过滤，每轮 poll（200ms）都先于 10 秒心跳有机会执行。`syncOwnedControls` 发现 owner 变化后 abort 并 SIGKILL。
  - 事实：审计最后一条是 `worktree.lease.created`，`session_events` 只有 `job/status=interrupted`，没有原因。测试只覆盖预置过期 lease，没有存活自持 job。
  - 推断：系统休眠或合盖也会触发（lease 用墙钟，真实休眠未测）。自持判 stale 只在事件循环已恢复时才会发生，此时进程必然存活，所以中断自己回收不到任何东西。进程已死、事件循环永久阻塞、agent 卡死三种场景的回收都不依赖这条路径。
- 影响：Ctrl-Z 超过 30 秒或时钟跳变会丢掉正在跑的节点。恢复要 `tekon resume --confirm-stopped --previous-job-id`，然后整个节点重跑，已花的 agent 额度白费。手册:500 没有说明存活进程也会这样。
- 修复建议：
  1. 在 poll 的 `syncOwnedControls` 之后、`recoverStaleJobs` 之前，对 `controllers` 里本进程持有的 job，若 lease 已超过 heartbeatMs，就按 owner 和 status 条件续租；条件未命中时沿用现有 fencing。必须按过期条件续租，否则每 200ms 写一次库。
  2. 探测到两次 poll 间隔明显超过预期（本进程被挂起过）时，本轮跳过回收其他 owner 的 job，只延后、不漏收。
  3. interrupt 时写明原因事件，并把 SIGSTOP 和时钟前跳的复现写成仓库内回归测试。

  不用 pid 探活：`kill -0` 分不清卡死、暂停和 pid 复用，用它否决回收会让真卡死的 job 一直 running，唯一出路只剩不可恢复的 cancel。第 1 项（无条件续租版）打补丁实测，SIGSTOP 40 秒和时钟前跳都变成 passed、exit=0；第 2、3 项和 Web 加 CLI 双进程场景未实测。

### [CD-04] Codex 非零退出或超时在 artifact 齐全时被改写成成功，和 Claude 语义相反
- 维度：代码 | 严重度：S2 | 工作量：S | 置信度：高 | 状态：已确认
- 位置：packages/core/src/runtime/codex-adapter.ts:126-129，:172-189，packages/core/src/runtime/claude-code-adapter.ts:120，:160-171
- 现象：模板带必需 artifact 时，假 Codex exit 3 或超时都 passed、CLI exit 0，适配器返回 `exitCode:0, timedOut:false`；假 Claude 同输入 interrupted。Goal 的 required 为空时不改写，exit 3 走 interrupted、exit 1。真实 codex 未测。
- 依据：这是有意设计（commit 40ad248 带测试），且 artifact 仍要过 gate。缺陷是真实退出码和超时只留在磁盘 progress.json，审计无痕，现行文档也不再说明。
- 影响：切换 provider 会改变结果语义，审计和 UI 看不到 provider 实际非零退出或超时。
- 修复建议：经用户确认（2026-11-06）：Codex 保留恢复并加审计告警。result 增加 `providerExitCode` 和 `timedOut`，写入审计告警事件。

### [CD-15] 状态机被大量绕过，还存在不可达状态
- 维度：代码 | 严重度：S2 | 工作量：M | 置信度：高 | 状态：已确认
- 位置：packages/core/src/db/repositories.ts:448-476，:577-583，packages/core/src/workflow/state-machine.ts:23-52，:83，:96-127，packages/core/src/workflow/engine.ts:504-522，packages/core/src/workflow/gate-runner.ts:315-439，packages/core/src/workflow/node-executor.ts:135-468，packages/core/src/workflow/rework.ts，packages/web/src/server/api/routers/gate.ts:177-178，:230，packages/cli/src/commands/approval.ts:295
- 现象：节点转换里 raw `transitionNode(` 共 31 处（2+8+9+5+3+3+1），校验版 13 处。`repositories.transitionNode` 不校验合法性，`canWorkflowTransition`、`transitionWorkflowNode` 只有测试使用。不可达项：
  - `phases.status` 只写 'pending'（admission-store.ts:357、repositories.ts:515），passed 后 13 个 phase 全是 pending。
  - node `skipped` 没有写入点。
  - run `pending` 在生产不出现（admission-store.ts:328 直接写 'running'），`createWorkflowInstance` 无生产调用，却被 38 个测试文件使用。
- 依据：包装 `transitionNode` 实测，happy path、rework 加两次 resume、pause 三条路径 0 次非法转换。唯一实际违规是 reject 的 `paused→blocked`（已复现）。`phases.status` 没有消费方。
- 影响：目前没有用户可见后果。合法转换表不能保证实际行为，测试建状态的路径和生产不同，状态相关测试的可信度下降。
- 修复建议：先把 `paused→blocked` 加进合法表，否则 reject 会抛错。再删除 raw 入口，所有转换走同一个校验函数，并与事件同事务（见 CD-31）。删除 phases.status 和 node skipped。

### [CD-16] Gate 有两套实现，registry 和 runners 共 1444 行在生产中不执行
- 维度：代码、测试 | 严重度：S2 | 工作量：M | 置信度：高 | 状态：已确认（合并 TS-13）
- 位置：packages/core/src/gate/engine.ts:44-165，packages/core/src/gate/registry.ts:78，packages/core/src/gate/helpers.ts，packages/core/src/gate/runners/，packages/cli/src/lib/session-context.ts:126，packages/core/src/session/workflow-job-executor.ts:135，packages/core/src/workflow/engine.ts:169，packages/web/src/server/api/root.ts:135，packages/core/src/constraint/runtime-policy.ts:29-36，:93-97，packages/core/src/constraint/validator.ts:94，:239，:245，packages/core/src/workflow/dynamic.ts:228，packages/core/__tests__/gate/registry.test.ts:178，:247，packages/core/__tests__/workflow/state-machine.test.ts:47-89，:159-176
- 现象：
  - 4 个生产调用点都不传 gate registry，走 engine.ts:83-144 的 if/else。`createBuiltInGateRegistry` 只有 `registry.test.ts` 使用，其 “same as legacy” 只比 skipped 和 command 路径。无动态引用，4 个包都 private。
  - 不执行的代码：registry 113、semantic 482、review 305、schema 85、command 75、human 42、security 36、helpers 306，共 1444 行（`gate/runners/*` 占 1025 行）。helpers、review、semantic、schema 的非平凡行与 engine.ts 重合率 598/745=80.3%。
  - 覆盖率：helpers 7.42%、semantic 11.11%、review 23.46%、schema 30.88%、human 62.5%、security 62.06%、command 96.96%。
  - `dslRules` 没有生产调用方。agent.yaml 的 autonomy、riskTolerance、defaultTimeoutMs、allowedGateTags 等字段只有不可达的 `runtime-policy.ts` 消费，测试只验证解析，用户配了没效果。
  - 另有 6 个生产不可达模块共 664 行：constraint/runtime-policy、eval/metrics、eval/report、runtime/legacy-agent-driver、types/events、workflow/scheduler。
  - 保护它们的测试（行/tests）：registry 363/10、runtime-policy 233/17、dsl 235/15、eval/metrics 238/1、eval/report 399/6、legacy-agent-driver 178/5、scheduler 138/8、agent-config-extended 243/7，合计 2,027 行、69 tests。另有 `state-machine.test.ts` 的 `transitionWorkflowNode` 5 tests，生产走 `repositories.transitionNode`。
- 依据：可达性来自静态 import 图和导出引用。AGENTS.md:21 要求不重复测试、不测死路径。docs 没有把 gate registry 说成新路径，只有 engine.ts:57、:83 的注释这样写。registry 引入后这组文件只有 2 次提交，没有“改错地方”的实证。
- 影响：影响局限在 gate 模块和这批测试：维护成本增加，覆盖率有一部分落在不跑的代码上，还制造“gate registry、约束 DSL、自主等级可用”的错觉。
- 修复建议：删 registry 这一套，保留 engine 的 if/else（gate 不做任意插件，见 CD-17）。
  - 模块和测试一起删：源码约 2,100 行（664+1,025+306+113），测试 2,027 行。删 agent.yaml 中无效的字段。
  - 先把 `COMMAND_GATE_TYPES`、`GOVERNANCE_GATE_TYPES` 移到独立常量文件（`delivery/pre-pr-readiness.ts:7`、`eval/work-readiness.ts:4` 在用）。
  - `gate/runners.ts`（192 行）是生产代码，和 `gate/runners/` 同名，不能删。治理用的语义 gate 搬进 `delivery` 包，通过内部注入点提供（复用 TS-12 的注入点），不对外开放。
  - `tekon clean` 按 CD-18 恢复，`clean.test.ts`、`project-clean.test.ts`、`http-clean-failure.test.ts`（共 584 行）保留。

### [CD-21] Artifact 归一化 625 行在补 LLM 输出形状漂移
- 维度：代码 | 严重度：S2 | 工作量：M | 置信度：高 | 状态：已确认
- 位置：packages/core/src/artifact/schemas.ts:311-935
- 现象：按类型归一化加 providerStyle 系列函数共 625 行，占文件 66.8%（625/935）。
- 依据：这些代码只为把不同 LLM 输出形状转回固定 schema。内置模板没有 autoFix，schema 失败直接 blocked，agent 重试目前不存在。git log 里有多个 normalize 修复对应真实 provider 输出漂移（如 “normalize Codex acceptance criteria artifacts”）。文件自 2026-06-13 后没改过，近期没有新增分支的实证。
- 影响：schema 和归一化耦合，新增 artifact 类型或模型漂移时要补分支；直接删除会增加失败。
- 修复建议：先放宽 schema（重构第 2 阶段，见 PD-06）或加上 agent 重试（把校验错误喂回去），再分批删除归一化。

### [CD-23] blocked 和 paused 的 CLI 退出码是 0，job 记为 done
- 维度：代码 | 严重度：S2 | 工作量：S | 置信度：高 | 状态：已确认
- 位置：packages/cli/src/lib/session-context.ts:341-348，packages/core/src/session/workflow-job-executor.ts:270-284
- 现象：blocked 和 paused 的 CLI 都是 exit=0（实测）。
- 依据：`exitCodeForWorkflowStatus` 只把 failed、cancelled、interrupted 映射为 1，session-context.ts:341-345 的注释表明这是有意的。
- 影响：脚本或 IM 集成会把“卡住”当成成功。
- 修复建议：经用户确认（2026-11-06）：blocked=2，paused=3，同步更新手册和测试。

### [CD-24] `parallel` 是假能力：解析后仍串行执行，UI 却显示“并行阶段”
- 维度：代码 | 严重度：S2 | 工作量：S | 置信度：高 | 状态：已确认
- 位置：packages/core/src/workflow/engine.ts:528-529，packages/core/src/workflow/template.ts:170，:497，packages/core/src/workflow/run-plan.ts:43，:209，:274，packages/core/src/workflow/workflow-runtime.ts:30-36，packages/core/src/workflow/scheduler.ts，packages/web/src/client/lib/plan-format.ts:34-35，packages/web/src/client/components/runs/StartRunForm.tsx:580
- 现象：执行是串行 for 循环。`parallel` 解析后进入计划，ExecutionPlan 丢弃，UI 显示“并行阶段”。`scheduler.ts` 只有测试和 index 引用。
- 依据：`dependsOn` 不属于此问题：它只能引用已声明的节点或 phase，串行执行天然满足。节点级 dependsOn 还被 `gate/engine.ts:481-486` 用于评审连通性校验，被 `lease-service.ts:131-132` 用于 repair 校验。
- 影响：用户写了并行不会并行，UI 给出错误信息。
- 修复建议：删除 `parallel` 字段和 UI 文案，真需要时再实现。保留节点级 dependsOn，否则连通性校验会失效。

### [CD-25] 死代码：101 个导出没有外部生产使用方，其中 19 个完全无生产使用
- 维度：代码 | 严重度：S2 | 工作量：S | 置信度：高 | 状态：已确认
- 位置：均在 packages/core/src 下，清单见现象
- 现象：101 个导出中，80 个在本文件内有使用，不算死代码。19 个只有测试或 index 引用：
  - constraint/dsl：loadConstraintRules
  - constraint/runtime-policy：canSatisfyGate、compileRoleRuntimePolicy
  - db/admission-store：buildRunAdmissionEnvelope
  - eval/metrics：extractRunMetrics
  - eval/report：renderRunEvaluationReport
  - gate/registry：createBuiltInGateRegistry
  - repo/profile：repoProfileCommand
  - runtime/legacy-agent-driver：createLegacyAgentDriver
  - session/dual-write：MAPPED_AUDIT_EVENT_TYPES
  - session/present：buildModelVisibleView
  - session/profile-policy：canMutate
  - types/session-contract：REQUIRED_EVENT_TYPES
  - workflow/execution-plan：persistPlan
  - workflow/run-plan：projectRunPlan
  - workflow/scheduler：createPhaseSchedule
  - workflow/state-machine：canWorkflowTransition、transitionWorkflowNode
  - workflow/template：loadBuiltInWorkflowTemplate

  另有 store 方法：findRecoverableRun、updateWorkflowInstanceStatus（13 个测试文件用）、cancelStaleActiveJobs、requeueStale、upsertProjectionCheckpoint、pruneStaleLeases、listLeases。表：run_locks、projection_checkpoints。还有 `types/events.ts` 的 runtimeEventSchema 和 config.ts 的 tekonConfigSchema、constraintRule*。
- 依据：4 个包都 private，`@tekon/core` 的 `export *` 不是对外 API；无动态引用（只有固定文件名的 `import()`）。`buildClaudeProviderSmokeEvidenceHtml`、`…Markdown` 被 `packages/core/__manual__/claude-code-provider.smoke.test.ts` 使用，属入口脚本类，不计入。
- 影响：eval/metrics 约 222 行、eval/report 94 行、legacy driver 179 行、runtime-policy 143 行等没有产品收益，测试还在覆盖它们（测试清单见 CD-16）。
- 修复建议：连同只验证它们的测试一起删除，注意顺序：runtime-policy 和 loadConstraintRules、canMutate 先看 PD-10；`pruneStaleLeases`、`listLeases` 先看 CD-18；`createBuiltInGateRegistry` 随 CD-16；`projectRunPlan` 只是别名，删除收益约 1 行。

### [CD-26] 重复实现
- 维度：代码 | 严重度：S2 | 工作量：M | 置信度：高 | 状态：已确认
- 位置：packages/core/src/runtime/claude-code-support.ts:9-18，packages/core/src/runtime/command-gateway.ts:290-299，packages/core/src/runtime/dsh-headless-adapter.ts:47-56，packages/core/src/workflow/helpers.ts:110-126，packages/core/src/workflow/prompt-builder.ts:70-86，:372，packages/core/src/workflow/rework.ts:243，packages/core/src/gate/engine.ts:787，packages/core/src/workflow/template.ts:19，:566，:669，packages/core/src/workflow/workflow-runtime.ts:120，packages/core/src/workflow/dynamic.ts:410，packages/core/src/runtime/provider-registry.ts:95-235，packages/web/src/server/api/routers/project.ts:532-583，packages/web/src/server/api/routers/role.ts:14-33，packages/web/src/server/api/routers/workflow.ts:59-88，packages/cli/src/commands/ui.ts:104-178，scripts/update.sh
- 现象：
  - 环境白名单 3 份。
  - mustGetWorkflow 3 处，mustGetDemand、latestQaValidationRef 多处，`latestGateResults` 5 份。
  - artifactSummaries、stableGateKey、getWorkflowsDir 各 2 份。
  - commandRef 枚举 4 份（template、domain、repo-command-binding、rpc-contract）。
  - provider create/restore 3 份，三个适配器主流程相似。
  - 脱敏 2 套，token 校验 3 份。
  - admission envelope 多份（session-service.ts:260-267、run.ts:165-183、engine.ts:370-378、web admission-envelope.ts）。
  - update 逻辑 2 份。web listRoles、loadTemplate 各 2 份，且 listRoles 只读 `.tekon/roles`。组合根 2 份。
- 依据：见位置，抽查属实。
- 影响：修一处漏一处。
- 修复建议：先合并组合根和脱敏。白名单只合并公共基础键，provider 凭据键按 provider 分开，默认环境不含任何 provider 凭据（见 CD-01）；`dsh-bridge-probe.ts:25-29` 的探针列表有意不转发 key 和代理，不并入。其余随重构删除。

### [CD-27] rpc-contract 和 server context 手写类型重复，handler 无编译期约束
- 维度：代码 | 严重度：S2 | 工作量：M | 置信度：高 | 状态：已确认
- 位置：packages/web/src/shared/rpc-contract.ts，packages/web/src/server/api/context.ts:268-540，packages/web/src/server/api/dispatch.ts:43-54
- 现象：rpc-contract 1104 行，101 个 export，32 个 z.enum，`z.infer` 只有 1 处。executionBinding 重复 3 次（:248、:515、:834），filesState 4 次（:260、:517、:617、:836）。context.ts 另有 22 个手写 Input/Output 类型。
- 依据：`dispatch.ts` 把 handler 强转为 `Record<string,(input?:unknown)=>Promise<unknown>>`，不匹配只在运行时报 INTERNAL_ERROR。新增一个 RPC 要改 rpc-contract、context、router、mapper、client 五处。
- 影响：加接口成本高，类型漂移要到运行时才发现。
- 修复建议：以 rpc-contract 的 zod schema 为唯一来源，用 `z.infer` 导出类型，删除 context.ts 的手写类型。

### [CD-28] 复杂度超标函数
- 维度：代码 | 严重度：S2 | 工作量：L（随删除治理功能分批） | 置信度：高 | 状态：已确认
- 位置：见现象，格式为“函数：圈复杂度/行数/嵌套”
- 现象：全部 2771 个函数中，cc>25 有 30 个，cc>15 有 91 个，行数>80 有 157 个，嵌套>4 有 10 个。超过 800 行的文件：repositories 1205、gate/engine 1138、rpc-contract 1104、command-gateway 1031、session-store 994、artifact/schemas 935、review/surface 837。最严重的函数：
  - `packages/core/src/workflow/gate-runner.ts:206` runGateWithRepair：69/353/8（`interrupted())` 检查 33 处）
  - `packages/core/src/workflow/node-executor.ts:99` executeNode：53/392/6（四段相似的 abort 分类）
  - `packages/core/src/runtime/codex-adapter.ts:363`：59/60/0（参数黑名单）
  - `packages/web/src/client/pages/DeliveryPage.tsx:24`：63/752/0
  - `packages/web/src/client/components/runs/StartRunForm.tsx:48`：60/712/0
  - `packages/web/src/client/layouts/TopBar.tsx:24`：53/435/0
  - `packages/core/src/workflow/execution-plan.ts:331`：40/140/3
  - `packages/cli/src/commands/workflow.ts:31`：40/218/7
  - `packages/core/src/workflow/lease-service.ts:85`：32/57/3
  - `packages/core/src/workflow/rework.ts:269` attemptChangesRequestedRework：317 行
  - `packages/core/src/db/admission-store.ts:281`：22/237/2（单个事务 237 行）
  - `packages/core/src/workflow/engine.ts:164` createWorkflowEngine：502 行
- 依据：用 TypeScript API 脚本统计，独立脚本复算一致。
- 影响：改动风险高，abort 类逻辑四处相似，容易漏分支。
- 修复建议：优先靠删除治理功能降低复杂度，再把 abort 判断收敛成一个包裹函数。不建议在现结构上单独拆分。

### [CD-30] Runner 每次 poll 都有写事务，随已取消 run 数增长
- 维度：代码 | 严重度：S2 | 工作量：S | 置信度：高 | 状态：已确认
- 位置：packages/core/src/session/job-runner.ts:129-133，:444-458，packages/core/src/session/session-store.ts:266-272，:882-903
- 现象：poll 间隔 200ms，每次执行 `interruptStale`（BEGIN IMMEDIATE）和 `reconcileCancelledRuns`（每个已取消 run 一次 BEGIN IMMEDIATE，每次最多 100 个）。cursor 回绕后下一轮空转，已取消的 run 永远不退出扫描。已处理的 run 不再写行，但仍取写锁。
- 依据：实测，N 是累计已取消 run 数，`interruptStale` 恒为 5 次/秒，`reconcile` 随 N 增长（N≤100 时总量约 5+2.5N 次/秒）：

| N | reconcile 次/秒 | CPU |
|---|---|---|
| 0 | 0 | 0.6% |
| 5 | 13 | 0.8% |
| 100 | 260 | 4% |
| 300 | 380 | 6.1% |

- 影响：写锁竞争随历史增长（busy_timeout 5000ms），CLI 和 Web 的 runner 各算各的。修复收益依据上表：N=100 时可省约 260 次/秒写事务；对用户操作的实际影响未测。
- 修复建议：只在 cancel 事件或存在非终态 job 时扫描，已处理的 run 不再进入。

### [CD-31] 事件有多条写入路径，审计和 session 事件不同事务
- 维度：代码 | 严重度：S2 | 工作量：M | 置信度：高 | 状态：已确认
- 位置：packages/core/src/session/dual-write.ts:34-48，:218-251，:261-286，:300-387，packages/core/src/session/session-store.ts:432-480，:457，:914-938，packages/core/src/session/run-recovery.ts:69-88，packages/core/src/db/admission-store.ts:473
- 现象：dual-write 映射 13 种审计类型，best-effort 写入，每个事件都要查一次 findSessionByRunId。`session_events` 有 4 个写入点：`appendEvent`（session-store.ts:457）、`interruptJobTxn`（:934）、`reconcileCancelledRunTxn`（run-recovery.ts:81）、admission（admission-store.ts:473）。
- 依据：docs/README.md:19 声明 session 事件不能代替领域记录。审计事件又被用于控制流（execution-plan.ts:331-470、node-executor.ts:538-546、lease-service.ts:85-141）。
- 影响：领域行、审计、会话事件之间可能不一致，UI 看到的进度不是权威状态。
- 修复建议：
  - 一张 `run_events(run_id, seq, type, payload, ts, prev_hash?)`，`(run_id, seq)` 唯一，需要防篡改时哈希链放在同表。
  - 一个 `apply(event)` 函数，同一事务写事件和投影行（run、node、gate、artifact），合法转换也只在这里校验。不做纯事件溯源。
  - 恢复和控制流只读投影，不再解析审计内容；`jobs` 只作租约小表；外部消费按 cursor 读事件。
  - 可删除 dual-write 387 行和多余的写入路径。经用户确认（2026-11-06）任务一对多 run，会话层保留为很薄的任务表。

### [CD-32] Human gate 有三条路径，语义不同，且不是原子操作
- 维度：代码 | 严重度：S2 | 工作量：M | 置信度：高 | 状态：已确认
- 位置：packages/core/src/gate/human-gate.ts:78-172，packages/web/src/server/api/routers/gate.ts:99-108，:170-178，:222-230，packages/cli/src/commands/approval.ts:290-295
- 现象：
  - web 注释写明 “The core rejectHumanGate is bypassed by this inline implementation”。
  - 差异：core 在无 gateResultId 时写 `gate_resume_*` 结果，web 不写；节点结果 core 是 running，web 和 CLI 是 awaiting-gate；web 的 run 状态用 CAS。
  - 决策、gate、节点、run 分四步写，不在同一事务。
- 依据：决策写入后状态不再是 pending，web 的 :99-104 拒绝重试。后续步骤失败时无法通过再次审批补完。
- 影响：审批是用户介入的主入口，两端行为不一致。
- 修复建议：合并为 core 一个事务函数，CLI 和 Web 都调用。

### [CD-33] Rework 错误路径会引发二次异常，role_run 留下孤儿记录
- 维度：代码 | 严重度：S2 | 工作量：S | 置信度：高 | 状态：已确认
- 位置：packages/core/src/workflow/rework.ts:314，:388，:405-411，:438-455，:539，:555-567，packages/core/src/workflow/gate-runner.ts:508，packages/core/src/workflow/lease-service.ts:174-175
- 现象（三种注入）：
  - rework 后目标 gate 失败：首次 interrupted，真实原因被 `active execution lease required…` 盖住，无孤儿，resume 后 blocked，再 resume 后 passed。
  - rework agent 失败：首次 interrupted，二次错误 `gate.execution.error: agent failed…`，role_run 留 running，resume 后 passed。
  - 再评审失败：首次 interrupted，二次错误 `illegal workflow transition: interrupted -> blocked`，role_run 留 running，resume 后卡在 pmo-checkpoint（见 CD-46）。
- 依据：`rework.ts:314` 先 finalize review lease，失败路径直接 return，调用方 `gate-runner.ts:508` 再执行 runGate。:405-411 和 :555 的 role_run 未标 interrupted。取消不受影响：`workflow-job-executor.ts:105-113` 的 gateway 用 `input.signal ?? ctx.signal` 兜底。
- 影响：失败时出现误导性的二次错误，真实原因被盖住，role_run 状态失真。
- 修复建议：用 mock adapter 注入上述失败补测试；随 CD-14 简化一起收敛。

### [CD-35] install 和 update 脚本失败时没有错误信息
- 维度：代码 | 严重度：S2 | 工作量：S | 置信度：高（读脚本确认，未运行） | 状态：已确认
- 位置：scripts/install.sh:2，:65-70，:77-78，scripts/update.sh:33，:44-49
- 现象：`set -euo pipefail` 配合 `>/dev/null 2>&1`。依赖安装或构建失败时脚本直接退出，只留步骤标题，没有错误原因。
- 依据：读脚本确认，未验证实际运行。
- 影响：第一次安装失败时用户无从排查。
- 修复建议：把输出写到临时日志，用 trap 在失败时打印尾部和日志路径。

### [CD-36] Draft 路径绕过 CommandGateway，吞掉错误，模板推荐靠关键词
- 维度：代码 | 严重度：S2 | 工作量：S | 置信度：高 | 状态：已确认（2026-11-09 用户授权维护方决定）；另排（重构第 5 阶段）
- 位置：packages/cli/src/draft-agent.ts:14-18，:47-52，:228-239，packages/cli/src/draft-interactive.ts:108，:112，packages/core/src/draft/shape.ts:18，:442-480，docs/manual/tekon-user-manual.md:647
- 现象：
  - `execFileSync` 直接调用，写死 Claude 的参数（注释称只支持 claude-code），`stdio` 忽略 stderr，超时 60 秒。任何异常都 `catch {}`，回退到静态问题。回退时会打印提示。
  - `classifyDraft` 和 `recommendTemplate` 用正则关键词选模板。
- 依据：手册:647 写明是独立路径。`tekon run` 不走这条路径，默认 standard-delivery（run.ts:154）。
- 影响：失败原因被吞。同一个 provider 两条调用路径并存，配置和输出处理不一致。“按任务描述选 workflow”实际是关键词匹配。
- 修复建议：已决定（2026-11-09）：保留澄清能力，并入动态工作流的 planner，统一走 adapter 和 CommandGateway，删除 `draft-agent.ts` 里的独立调用和关键词选模板；失败原因按 run 事件如实上报，不再静默回退。理由：只留一条 provider 调用路径，配置、日志和错误处理一致；删除虽然最省，但会失去任务开始前的澄清步骤。依赖动态工作流的重做，随重构第 5 阶段处理。

### [CD-42] 安全类，详情见私下渠道
- 维度：代码 | 严重度：S2 | 状态：已确认，单独小 PR
- 说明：细节未公开，走单独小 PR，提交信息不描述弱点。修复者向维护者索取细节；拿不到时不要处理并注明。

### [CD-43] 安全类，详情见私下渠道
- 维度：代码 | 严重度：S2 | 状态：已确认，单独小 PR
- 说明：细节未公开，走单独小 PR，提交信息不描述弱点。修复者向维护者索取细节；拿不到时不要处理并注明。

### [CD-44] 安全类，详情见私下渠道
- 维度：代码、产品 | 严重度：S2 | 状态：已确认（合并 PD-30），单独小 PR
- 说明：细节未公开，走单独小 PR，提交信息不描述弱点。修复者向维护者索取细节；拿不到时不要处理并注明。

### [CD-37] 每条 CLI 命令跑两次 integrity_check
- 维度：代码 | 严重度：S3 | 工作量：S | 置信度：高 | 状态：已确认
- 位置：packages/core/src/db/migrations.ts:5-19，:24，:316，packages/cli/src/lib/context.ts:43
- 现象：`migrateDatabase` 每次调用都跑两次 `PRAGMA integrity_check`，context.ts 和 session-context 每条命令都调用。
- 依据：实测 594KB 库单次 ≤10ms，63MB 合成库 40ms/次，每次 migrate 约 80ms。合成数据只作量级参考。
- 影响：耗时随数据库大小增长。收益依据上述实测：63MB 时每条命令约省 80ms，小库不明显。
- 修复建议：只在有待执行迁移时检查。

### [CD-38] 零散观察
- 维度：代码 | 严重度：S3 | 工作量：S | 置信度：高 | 状态：已确认
- 位置：scripts/install.sh:17，packages/core/src/role/loader.ts，packages/core/src/session/profile-policy.ts，packages/web/src/client/pages/config/ConstraintsTab.tsx:5-8，:36，packages/web/tsconfig.tsbuildinfo，packages/core/src/workflow/engine.ts:151，:171-178，packages/core/src/session/session-service.ts:191，packages/core/src/runtime/agent-step-events.ts:13-19，packages/core/src/runtime/legacy-agent-driver.ts:150-157，docs/reviews/，AGENTS.md:16
- 现象和依据：
  1. 默认安装目录 `~/.tekon` 和项目 `.tekon` 同名。role loader 的 `~/.tekon/roles` 候选恰好是安装克隆里被 git 跟踪的目录，改它会弄脏克隆。
  2. `canMutate` 只有测试使用。
  3. ConstraintsTab 显示静态 YAML，注释写明没有 RPC。
  4. `packages/web/tsconfig.tsbuildinfo` 被跟踪，4451 字节，是仓库唯一被跟踪的 tsbuildinfo，`.gitignore` 没有规则。
  5. 过时注释：`agent-step-events.ts:13-19`（“CLI passes nothing”）、`engine.ts:171-178`、`session-service.ts:191`、`legacy-agent-driver.ts:150-157`，抽查 3 处属实。
  6. docs/reviews 有 360 个被跟踪文件（png 242、log 60、json 34、html 16、md 7、txt 1），45M，占 docs 约 99%。
  7. 三个包的 lint 都是 `tsc --noEmit`，和 typecheck 完全相同。
- 影响：单项影响小；第 6 项让克隆变重，第 7 项意味着实际没有 lint。
- 修复建议：逐项小改；tsbuildinfo 加入 `.gitignore` 并移出跟踪；docs/reviews 证据是否迁出随 PD-27 决定。

### [CD-39] AGENTS.md 的“产品合同”和实际情况、目标基准都冲突
- 维度：代码 | 严重度：S3 | 工作量：S | 置信度：高 | 状态：已确认
- 位置：AGENTS.md:7，:16，docs/README.md:21
- 现象：AGENTS.md:16 写“角色职责、artifact schema、Gate 和权限是产品合同”，而 docs/README.md:21 承认 tools.yaml 只是提示。AGENTS.md:7 对 core 的描述偏窄，没提 session、delivery 等。
- 依据：见 PD-06、PD-10。
- 影响：这一句会约束后续 agent 不去放开枚举，和重构方向相反。
- 修复建议：经用户确认（2026-11-06）：角色和产物自由命名，reviewer 和 Gate 可选，治理放进模板，同步修改 AGENTS.md。该句改为“内置模板的默认约束”，并补全第 7 行对 core 的描述。

### 4.4 测试

### [TS-01] 真实 CLI 不在常规入口，fake 合同只覆盖 codex 成功路径和 claude 生命周期
- 维度：测试 | 严重度：S1 | 工作量：M | 置信度：高 | 状态：已确认
- 位置：package.json:12、15，packages/core/__manual__/claude-code-provider.smoke.test.ts:19-35、54-58、82，packages/core/src/runtime/mock-agent-adapter.ts:30-78、80-170，packages/core/__tests__/runtime/claude-code-adapter.test.ts:220-392，packages/core/__tests__/session/run-recovery.e2e.test.ts:41-43、134，packages/cli/__tests__/run-cli.test.ts:1286-1349，packages/web/__tests__/api/write-auth.test.ts:409-459，packages/cli/src/commands/provider.ts:128-133，packages/web/src/server/api/provider-health.ts:1-15
- 现象：默认入口不跑 smoke，也没有脚本调用它。仓库只有 claude-code 一个手动 smoke，配置手写，不经 `createAgentRuntime` 和引擎；Codex 没有 smoke。已有保护有三处：`run-cli.test.ts:1286-1349` 用 `--agent codex` 走真实 adapter 和 gateway，fake codex 校验 profile、approval、sandbox、add-dir 参数并断言 passed；`write-auth.test.ts:409-459` 在 Web 入口走同样路径；`run-recovery.e2e.test.ts` 覆盖 claude-code 跨进程生命周期。缺的是失败路径、认证环境、claude-code 经 CLI 和 Web 入口运行、常规入口里的真实 CLI。CLI 的 47 次 `run` 调用中，mock 42、codex 1、dsh-headless 2、误计 2、claude-code 0。实验性的 dsh-headless 专用测试有 10 个文件约 2,500 行，`tekon provider preflight` 也只支持 dsh-headless。
- 依据：项目自己写明“mock 或只读 smoke 不能替代真实交付”（docs/reviews/current.md:38）。变异验证（一次一个，跑全量，对照 2248 tests、0 failed）：白名单加 `USER` 为 0 failed；拒绝路径的 `exitCode: 1` 改 0 为 0 failed；删除 `claude-code-adapter.ts:96` 的环境展开后，只有 `run-recovery.e2e` 的 2 条因变异失败，`claude-code-adapter.test.ts` 无失败，说明 claude 这层保护只靠丢 PATH 偶然发现。真实 provider smoke 本次未执行。推断，未验证：`packages/web/__tests__/e2e/start-run-form.test.ts:130-159` 默认提交 codex，没有 fake，也不隔离 PATH，在已登录 codex 的机器上可能真实拉起 provider。
- 影响：认证、环境和失败路径的回归只能靠发布时人工发现。走查里 Claude 认证失败、Codex 未安装时第一步就失败，测试全绿。缺陷本身的严重度由 CD-01、PD-02 定级。
- 修复建议：分两层。常规层扩展现有 fake，合并两份 `writeFakeCodex`，补 claude 入口、命令不存在、非零退出、未登录和环境键名断言；这套夹具和 TS-02、TS-08 共用，工作量只算一次。真实层把 smoke 改成经 `tekon run` 跑最小单节点工作流，覆盖 API key 和订阅两种认证，沿用 `dsh-bridge-contract.test.ts:73` 的 opt-in 方式。本 PR 做常规层和 Claude 真实层；Codex 真实层另排（重构第 3 阶段）。真实层依赖账号和费用，不放默认入口；常规层发现不了外部 CLI 的行为漂移，所以两层都要。

### [TS-02] 不带 `--agent` 的默认选择无保护，Provider 缺失或未登录的失败体验零测试
- 维度：测试 | 严重度：S1 | 工作量：M | 置信度：高 | 状态：已确认
- 位置：packages/cli/src/commands/run.ts:189-190，packages/cli/src/lib/utils.ts:152-164，packages/cli/__tests__/run-cli.test.ts:54，packages/web/__tests__/e2e/start-run-form.test.ts:130-159，packages/core/src/runtime/codex-adapter.ts:112-119，packages/core/src/runtime/claude-code-adapter.ts:108-116，packages/core/__tests__/runtime/codex-adapter.test.ts:531-557，packages/core/__tests__/runtime/claude-code-adapter.test.ts:358-392，packages/core/__tests__/runtime/command-gateway.test.ts:947，packages/core/__tests__/workflow/helpers.test.ts:90、101，packages/core/__tests__/workflow/engine-unit.test.ts:68、80，packages/cli/src/lib/session-context.ts:378
- 现象：显式 `--agent codex` 经 fake 能跑到 passed，但没有测试不带 `--agent` 走到运行结果，`run-cli.test.ts:54` 只断言配置文本 `defaultAgent: codex`。浏览器里默认 workflow 加 codex 的唯一提交用例只断言 RPC 200、有 run id、无 digest 错误。adapter 丢弃 gateway 的 `reason`，对应分支被执行但不断言返回值；gateway 自身的 reason 有断言。`helpers.test.ts`、`engine-unit.test.ts` 只匹配 `/agent failed/`。`session-context.ts:378` 的恢复提示没有测试。
- 依据：走查错误只有 `agent failed: provider=codex exitCode=1`。变异验证（一次一个，跑全量）：`run.ts:190` 默认 agent 改 mock，含 CLI e2e 为 0 failed；两个 adapter 拒绝路径的 `exitCode: 1` 改 0，为 0 failed。
- 影响：默认首跑路径没有回归保护，改坏默认选择、提示或失败信息都不会变红。
- 修复建议：在 `packages/cli/__tests__/e2e/` 新增首次运行测试。PATH 不含 codex，init 后不带 `--agent` 执行 `tekon run`，断言非零退出，并指出 CLI 不可用和下一步。fake codex 和 fake claude 输出未登录后退出 1，断言原因可见。adapter 单测补 rejected 分支对 `exitCode` 和诊断信息的断言。这些用例当前会红，先修产品再转绿，可作为重构验收。

### [TS-08] 人工介入缺 CLI 和 Web 入口层的真实链路
- 维度：测试 | 严重度：S1 | 工作量：M | 置信度：高 | 状态：已确认
- 位置：packages/cli/__tests__/e2e/cli-flow.e2e.test.ts:158-164，packages/cli/__tests__/run-cli.test.ts:600-603，packages/cli/__tests__/approval-terminal.test.ts:80-81、197，packages/web/__tests__/api/project-run-job.test.ts:125-140、201-222，packages/web/__tests__/api/write-auth.test.ts:303、1215、1263、1289、1328，packages/web/__tests__/e2e/r27-control-feedback.e2e.test.ts:34-59，packages/cli/__tests__/e2e/resume-exit-confirmation.e2e.test.ts:30-31
- 现象：审批有真实链路（`session-approval.test.ts`、`cli-flow` 的 `--approve-human`）。引擎和 core 层较强：`engine-worktree.e2e.test.ts:60-100` 覆盖第二次退出 1、变 interrupted、resume 后 passed，另有 `engine-recovery.e2e.test.ts:29`、`queued-resume.e2e`、`queued-pause`、`job-runner.test.ts:366-446`、`run-recovery.e2e.test.ts:134`。缺口在入口层：`tekon pause` 的 3 处测试都针对终态，只验证被拒绝；`project.pause` 的 6 处都是鉴权失败、NOT_FOUND 或终态；`resume` 的真实进程用例用 SQL 把状态改成 interrupted；“provider 失败、修环境、resume、成功”在 CLI、Web 入口加生产 adapter 这一层没有测试。
- 依据：走查正好卡在这里，`tekon resume` 后再次 interrupted，提示只有通用文案。浏览器层 pause、resume 全部 `route.fulfill` 是有意分层，不算缺陷。
- 影响：用户从入口触发的暂停和失败修复没有端到端保护，core 层绿不代表 CLI 和 Web 的接线正确。
- 修复建议：新增真实进程 e2e，不用 SQL 设置状态。fake codex 首次退出 1，断言 interrupted 且原因可见，换成成功的 fake 后 resume，断言 passed。fake 慢节点运行中 `tekon pause`，断言在边界停下，resume 后 passed。Web API 层加一条同样的路径。浏览器层复用 TS-07 的 barrier 为可选项。

### [TS-03] 测试大面积写死内部结构和文案，放大重构成本
- 维度：测试 | 严重度：S2 | 工作量：L | 置信度：高 | 状态：已确认
- 位置：packages/core/__tests__/workflow/engine-role-prompt.test.ts:663-697，packages/core/__tests__/workflow/template.test.ts:136-235，packages/core/__tests__/workflow/engine-template.e2e.test.ts:60-61，packages/core/__tests__/gate/registry.test.ts:49、174，packages/core/__tests__/phase1/kernel.e2e.test.ts:83-109，packages/web/__tests__/client/run-controls-cancel-feedback.test.ts:7-12、23-28，packages/core/__tests__/docs/manual-node-range.test.ts:15-18，packages/cli/__tests__/e2e/cli-flow.e2e.test.ts:233-234，packages/core/__tests__/ci/github-workflows.test.ts
- 现象：扫描 242 个测试树文件：模板名 162 处/36 文件，裸 SQL 约 259-273 处/42-43 文件（含 migrations 和 `execution-plan-integrity`，这两处的裸 SQL 就是测试目的），内置节点 id 严格计 114 处/23 文件，中文文案断言约 599 处/71 文件（正则近似），`key=value` 输出 158 处/18 文件。226/1850 个静态测试点只有文本断言。`engine-role-prompt` 逐句断言提示词。`template.test` 写死 standard-delivery 的 16 个节点和 gate 集合，`engine-template.e2e` 写死 5 phase、5 node，`registry` 写死 12 个 gate。`kernel.e2e` 断言 mock 产出 20 种 artifact。5 个 client 测试 `vi.mock('react')`，其中 `run-controls-cancel-feedback` 固定 `useState` 后把组件当函数调用。`cli-flow:234` 断言错误信息含 issue 号。`manual-node-range` 读手册文字，`github-workflows.test.ts` 解析 CI YAML。
- 依据：事实：6 个月改动次数为 run-cli 29、engine-role-prompt 27、release-dashboard 19、write-auth 19、dashboard 16、command-gateway 14、schemas 14。增删以新增为主（engine-role-prompt +1633/−38、run-cli +1778/−121、write-auth +1755/−113），`engine-role-prompt` 的提交多是 provider 失败模式的回归锁，所以没有证据说明大面积“跟着改断言”。明显返工的只有文案类（release-dashboard +229/−148、dashboard +213/−103）。AGENTS.md:25 对仅改文档的场景写明无需文字断言，手册文字测试与此不一致。模板和 Gate 部分锁定的是 AGENTS.md 声明的产品合同，经用户确认（2026-11-06）要放开（见 PD-06）。
- 影响：推断：改节点名、表结构或文案要动大量测试，而这些改动不一定改变用户可见行为。按已确认方向放开模板时，模板和 Gate 断言要随之调整。
- 修复建议：按子项拆开做，优先删除和收敛。测试自带最小工作流 fixture，内置模板只留一条“可加载、依赖闭合”的测试。裸 SQL 收敛到一个按状态语义命名的 helper，排除 migrations 和 `execution-plan-integrity`。提示词测试改成保留安全和协议条款的表驱动断言，不简单收缩。UI 文案断言换成错误码和 role、testid。`vi.mock('react')` 的 5 个测试改用真实渲染，或由 Playwright 覆盖后删除。删除手册文字和 issue 号断言。`audit-production`、`runtime-audit-scope` 测的是真实脚本和依赖归类，保留。

### [TS-04] 自定义工作流缺 create 后运行的来回和错误提示测试
- 维度：测试 | 严重度：S2 | 工作量：M | 置信度：高 | 状态：已确认
- 位置：packages/cli/__tests__/e2e/cli-flow.e2e.test.ts:198-212，packages/cli/__tests__/run-cli.test.ts:621-629，packages/cli/__tests__/e2e/run-command-binding.e2e.test.ts:29-33、42-61，packages/web/__tests__/fixtures/project.ts:55-130，packages/core/__tests__/workflow/template.test.ts:235、336、353、448，packages/core/src/types/domain.ts:5、34，packages/core/src/workflow/template.ts:186、502-503、710-713，workflows/goal.yaml:4-9，packages/cli/src/commands/workflow.ts:211-243
- 现象：已有保护：`fixtures/project.ts` 种了项目级自定义 YAML，Web API 和 Playwright 都跑到 passed（`write-auth.test.ts:352、423`、`session-approval`、`http-run-*`）；CLI 真实进程有 `run-command-binding.e2e`。余下缺口：`workflow create --from bugfix` 的两处测试只断言输出路径或非空，没有 create 后再运行的来回；CLI 测试没有校验错误提示（grep `Invalid option|expected one of` 无结果）；没有经 `status`、`log` 看节点的断言。
- 依据：产品方向偏差：文档已声明，与目标基准冲突（README 写明按固定流程分工，目标是快速定义工作流马上跑）。实测（mock，真实 provider 未测）：最小 YAML 退出 0、状态 passed；缺 `governance` 退出 1 并提示缺 reviewer；`workflow create --from bugfix` 后运行退出 0、状态 paused。`governance` 字段 README 和手册都没写。经用户确认（2026-11-06）：角色和产物自由命名，reviewer 和 Gate 可选，治理放进模板，同步改 AGENTS.md。
- 影响：路径目前可走，错误提示和 create 后运行的改坏不会变红。`template.test.ts:235、353` 把强制 reviewer 锁成合同，与已确认方向冲突。
- 修复建议：新增真实进程 e2e：用户写最小 YAML，`tekon run --template <名字> --agent mock`，断言 passed，并能在 `status`、`log` 看到节点；create 后再运行走一次来回。错误路径断言“指出字段和允许值”，不断言 zod 原文。删除 create 后只看路径的断言。放开枚举和 reviewer 时同步改 `template.test.ts` 的合同断言。

### [TS-05] 自定义角色没有端到端测试，配置是否生效只有分段单测
- 维度：测试 | 严重度：S2 | 工作量：S | 置信度：高 | 状态：已确认
- 位置：packages/cli/src/commands/role.ts:43-47、70-89，packages/cli/src/lib/session-context.ts:134，packages/cli/__tests__/e2e/cli-flow.e2e.test.ts:184-186，packages/cli/__tests__/run-cli.test.ts:617，packages/core/__tests__/role/loader.test.ts:18，packages/core/__tests__/workflow/engine-role-prompt.test.ts:28，packages/core/__tests__/runtime/claude-code-adapter.test.ts:220，packages/core/src/role/prompt-builder.ts:26
- 现象：分段保护存在：`loader.test.ts:18` 验证 project、user、builtin 的优先级，`engine-role-prompt.test.ts:28` 用真实 engine、loader、prompt-builder 捕获 prompt，`claude-code-adapter.test.ts:220` 验证 policy 进入 argv。缺口是 `session-context.ts:134` 的生产接线和 `.tekon/roles` 的真实进程路径。`role create` 的测试只用内置 `qa`，只看输出路径。新 id 被拒绝（`role create writer` 退出 1，提示“无效的角色 ID”），这条错误没有测试。`tools.yaml` 只出现在 3 个测试文件（共 4 处）。model、effort 字段在角色和配置里不存在，归 PD-10。
- 依据：实测（mock，真实 provider 未测）：`role create rd` 后在 `system.md` 追加标记，运行后标记出现在 `mock-agent-transcript.txt`，路径当前可用。
- 影响：生产接线和真实进程路径改坏不会被发现；相邻层有保护，所以是局部缺口。
- 修复建议：优先做，新增两条 e2e。一条是上述 transcript 断言。另一条用 fake claude 记录 prompt 和 argv，断言 `tools.yaml` 的改动到达 provider；当前工具配置只是提示，先断言进入 prompt，PD-10 落地后再按新机制改断言。model、effort 随 PD-10 再加。

### [TS-06] 动态工作流的 CLI 测试只验证生产代码里的硬编码 mock
- 维度：测试、产品 | 严重度：S2 | 工作量：M | 置信度：高 | 状态：已确认
- 位置：packages/cli/src/commands/run.ts:127-150、334-401，packages/cli/__tests__/e2e/cli-flow.e2e.test.ts:66-82，packages/cli/__tests__/e2e/release-flow.e2e.test.ts:78-93，packages/cli/__tests__/run-cli.test.ts:150-165，packages/core/__tests__/workflow/dynamic.test.ts:34，packages/core/src/workflow/dynamic.ts:430，docs/manual/tekon-user-manual.md:405、434
- 现象：`--dynamic` 不带 `--dry-run` 直接报错（`run.ts:128-129`），这条错误没有测试。`run.ts:134` 固定用 `createDynamicMockAdapter`，`--agent` 不起作用。风险判定是正则 `/高风险|high-risk|risk/u`（`:344`），`assumptions` 写着 `mock dynamic workflow preview`（`:397`）。CLI 的 3 条测试输入正好命中正则，再断言 `conditional-high-risk-human-gate`。`dynamic.test.ts:34` 用 fake adapter，确实在测生成逻辑。Web 没有 dynamic 入口。附带：`dynamic.ts:430` 每次预览都建临时目录，实测留下 52 个。
- 依据：产品方向偏差：文档已声明，与目标基准冲突（手册写明必须配 `--dry-run`、不受理 Run，目标是按任务描述动态编排），产品侧见 PD-09。手册没写生成器是固定 mock，也没写 `--agent` 被忽略。实测未调用真实 provider：高风险输入得到 phases=4 和两个 conditional mutation；“写一篇周报”得到 phases=3、mutations 为空；不带 `--dry-run` 退出 1。经用户确认（2026-11-06）：重做为 plan 节点产出受校验的 steps，同一执行路径，结果可存 YAML。
- 影响：3 条绿测试和手册示例会给人动态编排已可用的印象。`--agent` 被静默忽略。
- 修复建议：把硬编码 mock 移到测试目录，用 fake agent 输出 steps，覆盖 plan 节点产出、校验失败、走同一执行路径运行、结果存 YAML 后再运行；删除只验证正则命中的 3 条断言。

### [TS-07] Web 没有真实引擎进行中链路，ProgressTab 内容无浏览器断言
- 维度：测试 | 严重度：S2 | 工作量：M | 置信度：高 | 状态：已确认
- 位置：packages/web/__tests__/e2e/session-feed.test.ts:79-88，packages/web/__tests__/e2e/session-approval.test.ts:78-152，packages/web/__tests__/e2e/mobile-layout.test.ts:85-88，packages/web/__tests__/e2e/r24-query-observation.e2e.test.ts:195-238、277-348、350-447，packages/web/__tests__/e2e/r26-run-recovery.e2e.test.ts:6-44，packages/web/__tests__/e2e/r27-control-feedback.e2e.test.ts:34-59，packages/web/__tests__/e2e/run-tab-content.test.ts:47-53，packages/web/__tests__/api/progress.test.ts，packages/web/src/client/pages/run-detail/ProgressTab.tsx:123-132、152，packages/core/src/runtime/command-gateway.ts:348
- 现象：`r24-query-observation` 三组用例是页面打开后后台状态推进、不刷新就更新，数据来自真实 SQLite catch-up。但“引擎真实进行中且页面已打开”没有：`session-feed` 等 passed 后才打开，`session-approval` 批准后只用 RPC 轮询，`mobile-layout` 只查溢出。用 `agent:'mock'` 经 `project.run` 启动运行的 Playwright 只有 6 个测试文件和 1 个 helper。fixture 没有 progress 文件，`ProgressTab.tsx:152` 的表格分支从未被渲染，`:123-132` 的错误分支出现时导航链接还在，测试照样通过。`api/progress.test.ts` 手写的进度文件形状，真实写入方不会产生。全部 Playwright 有 20 个文件 81 处 `route.fulfill`，r26、r27 注释说明这是有意分层，手写响应的漂移风险仍在，只有 2 个 helper 用了合同类型。
- 依据：变异验证（只跑 `run-tab-content`）：`ProgressTab` 函数体首行抛错，1 failed、5 passed，崩溃能被发现。推断：client 没有 ErrorBoundary，崩溃后 router 错误页替换整页，导航链接消失，所以只能发现首行崩溃，发现不了内容错误。未验证：在 `progressFiles.map` 内抛错或让组件 `return null`，静态推断 6 条全过。API 层 SSE 保护较强（`session-sse.test.ts`、`workspace-sse.test.ts`），缺口在客户端渲染。ProgressTab 约 390 行，vitest 不可达，也不计入覆盖率。
- 影响：真实 provider 用户看到的节点进展内容改坏不会变红；手写响应和真实合同漂移时也发现不了。
- 修复建议：新增一条 e2e：fake CLI 用 barrier 控制节点推进，打开页面后断言节点时间线随事件变化、产物能打开。PD-13 决定删除 ProgressTab 的命令进度块，所以不断言它的表格分支。手写响应改用 `RpcProcedureMap` 类型约束，两个 helper 已有先例。

### [TS-09] 白名单测试只锁剥离，不锁可用性
- 维度：测试 | 严重度：S2 | 工作量：S | 置信度：高 | 状态：已确认
- 位置：packages/core/__tests__/runtime/claude-provider-smoke-evidence.test.ts:11-30、32-48，packages/core/src/runtime/claude-code-support.ts:9-18、24-34，packages/core/src/runtime/claude-code-adapter.ts:94-101，packages/core/src/runtime/command-gateway.ts:290，packages/core/__tests__/runtime/command-gateway-env.test.ts:21、57
- 现象：测试输入没有 `USER`，`toEqual` 要求输出只有 PATH、HOME、LANG，并要求 API key 等敏感变量被剥离。测试名写 preflight，放在 smoke 证据文件里，但函数是生产路径（`claude-code-adapter.ts:96`）。在 codex、claude 两个 adapter 的测试里，只有 `codex-adapter.test.ts:534-556` 断言 `envMode`，都没有断言子进程环境。Codex 走另一份 `SAFE_ENV_KEYS`，同样没有 `USER`。`:11-30` 断言 smoke 证据生成器的中文文字，生成器只有 `__manual__` 在用。
- 依据：变异验证（一次一个，跑全量）：白名单加 `USER`，0 failed，说明缺 `USER` 没被锁住；被测试固化的只有剥离 API key。`CLAUDE_CONFIG_DIR`、`HTTPS_PROXY`、`ANTHROPIC_BASE_URL` 不在白名单内是静态事实，是否造成失败未验证。手册和 README 目前都没有 API key 说明。经用户确认（2026-11-06）：白名单补 USER、LOGNAME、代理、ANTHROPIC_*、CLAUDE_*，加显式透传。
- 影响：有测试锁住白名单，会让人以为这里既安全又正确，但可用性无人验证。剥离 API key 的合同与已确认方向冲突，修 CD-01 时会变红。
- 修复建议：拆成两类断言并移到 adapter 合同测试：不泄露无关机密（门禁命令和其他 provider 收不到 Claude 凭据）；传递已确认的认证、代理变量和显式透传项。公共基础键可以合并，provider 凭据键按 provider 分开（见 CD-01、CD-26）。删除 `:11-30`。手册和 README 补 API key 说明。产品修复在 CD-01。

### [TS-10] 覆盖率数字不代表核心路径受保护
- 维度：测试 | 严重度：S2 | 工作量：S | 置信度：高 | 状态：已确认
- 位置：vitest.config.ts:14-20，packages/core/src/runtime/claude-code-support.ts，packages/core/src/runtime/claude-code-adapter.ts，packages/core/src/runtime/codex-adapter.ts，packages/cli/src/commands/ui.ts
- 现象：走查失败的三个文件覆盖率分别为 100%、90.64%、90.52%。client 被排除（94 文件，14,745 行）。按静态 import 图，vitest 可达 50 个文件约 6,767 行，44 个文件约 7,978 行不可达，只由 Playwright 驱动且不计量，包括 DeliveryPage、StartRunForm、DashboardPage（各约 580 到 780 行）和 ProgressTab。自定义 exclude 覆盖默认值，10 个测试树文件计入（1,376 行，覆盖 624）。`**/dist/**` 排除使真实进程 e2e 和 CLI、Web 跑到的 core 产物不计入，所以 `cli/src` 72.93% 偏低（如 draft 命令 29.83%）。
- 依据：总覆盖率 26,999/32,043 = 84.25%。只算 src：26,375/30,667 = 86.0%。剔除死代码后约 86.4%，死代码不是虚高来源。client 全算未覆盖的下界：26,999/(32,043+14,745) = 57.7%，两边行口径不同，只作量级。
- 影响：84% 不能作为核心路径受保护的依据，也不能作为重构门槛。
- 修复建议：exclude 增加 `**/__tests__/**`、`**/__manual__/**`；维护一张“核心路径到守护测试”的表，代替覆盖率判断；明确写清 client 不计量，或单独出报告（UI 实测覆盖率未验证）。

### [TS-11] `pnpm test` 不构建，CLI 和 Web 测试可能跑旧产物
- 维度：测试 | 严重度：S2 | 工作量：S | 置信度：高 | 状态：已确认
- 位置：package.json:12，packages/core/package.json:6-11，packages/cli/package.json:22，packages/cli/__tests__/e2e/cli-flow.e2e.test.ts:32，packages/cli/__tests__/e2e/job-failure-exit.e2e.test.ts:19，AGENTS.md:23，.github/workflows/ci.yml:134-135、172-175、202-203、233-234，.github/workflows/core.yml:58
- 现象：`@tekon/core` 的 exports 指向 `./dist/index.js`，根配置和 web 配置都没有 alias。43 个 CLI、Web 测试文件 import `@tekon/core`，e2e 跑 `packages/cli/dist/index.js`。`pnpm test` 不含构建，只有 `packages/cli/package.json:22` 的 `test:e2e` 才构建。CI 各测试 job 都先构建，风险只在本地。
- 依据：AGENTS.md:23 要求提交前跑 `pnpm test --run`，涉及 CLI 产物才构建。变异验证（只跑 `run-cli.test.ts`）：改 `agent-runtime.ts:130` 的 profile，不构建 15 passed，构建 core 后 1 failed、14 passed。
- 影响：改 core 后不构建直接跑测试，CLI 和 Web 测的是旧代码，会假绿。已构建过的仓库不会报错，所以不易察觉。
- 修复建议：`test` 脚本显式前置 `pnpm -r build`。实测 4.225s，约为 vitest 墙钟 76-87s 的 5%，同时修好进程内测试和跑 dist 的 e2e。vitest alias 修不了真实进程 e2e，只作 watch 模式补充。

### [TS-12] 治理子系统测试占比高，合同测试和单点 fixture 与其耦合
- 维度：测试 | 严重度：S2 | 工作量：M | 置信度：中 | 状态：已确认
- 位置：packages/core/__tests__/gate/，packages/core/__tests__/delivery/，packages/core/__tests__/eval/，packages/core/__tests__/constraint/，packages/core/__tests__/draft/，packages/web/__tests__/fixtures/project.ts:311、323，packages/core/__tests__/workflow/engine-worktree.e2e.test.ts，packages/core/__tests__/phase1/session-job-e2e.test.ts
- 现象：gate、delivery、eval、constraint、draft 五个子系统共 7,793 行源码。直接失效的测试有 30 文件、13,145 行（真实换行数 13,115）、247 tests，占行 19.2%、占 tests 11.0%，其中子系统目录内 19 文件/8,405 行/156 tests，目录外直接 import 的 11 文件/4,740 行/91 tests。合同候选 `engine-worktree.e2e`、`session-job-e2e`、`kernel.e2e`、`repo-command-binding.e2e` 直接 import `createGateEngine`。`fixtures/project.ts`（517 行）同时种 run、gate 结果、delivery 目录和人工决策，被约 60 个文件依赖。
- 依据：直接失效部分由 import 关系算出，较可靠。关键词上界是 89 文件、37,868 行、1,082 tests（占行 55.3%、占 tests 48.1%），只是文件级粗估：偏高来自假阳性（`\bdelivery\b` 命中 `standard-delivery`，`createPr` 命中 `createProviderHealthService`），偏低来自 helper 和 fixture 未计（10 文件/1,627 行）、38 个依赖 fixture 的文件（8,527 行）未计、Playwright tests 计 0。校准估算：块级 25,399/68,507 = 37.1%，严格 API 命中 20,165/68,507 = 29.4%。实际删除校准未执行，未验证。
- 影响：删除治理子系统时估算约 30%-37% 的测试行要动，其中相当部分只是 setup 引用。不先解耦的话，安全网会和被删代码一起失效。
- 修复建议：重构前先做三件事。拆 fixture：最小 run 种子，加可选的 gate、delivery 种子。给 engine 提供无 gate 的注入点，让合同测试不 import `createGateEngine`。分三批处理：子系统目录内的直接删，目录外直接 import 的逐个改，只命中关键词的 59 个文件在临时副本实际删除校准后再定。

### [TS-14] `tekon ui`、`tekon update` 没有真实进程测试
- 维度：测试 | 严重度：S2 | 工作量：S | 置信度：高 | 状态：已确认
- 位置：packages/cli/src/commands/ui.ts:23-44、73-76，packages/cli/__tests__/e2e/cli-flow.e2e.test.ts:401-402，packages/cli/__tests__/help.test.ts:82-83，packages/web/__tests__/e2e/prod-bootstrap-fixture.ts:12、29，README.md:20，packages/cli/src/commands/help.ts:54，AGENTS.md:22
- 现象：e2e 目录里 `ui`、`update` 只出现在帮助文字的 `toContain`。`ui.ts` 行覆盖 4.51%。`prod-bootstrap-fixture.ts:29` 直接调用 `createWebServer`，下层有保护，缺的是 `tekon ui` 这层薄入口。`approval`、`review` 在 e2e 目录也没有字面量命中，进程内由其他测试部分覆盖。
- 依据：README 和 help 把 `tekon ui` 列为 Web 入口，AGENTS.md:22 要求 CLI 命令有真实进程测试。`ui.ts:73-74` 的注释写明“监听成功前不打印长期 token”，这条不变量没有测试。
- 影响：Web 首次进入路径坏了不会变红。
- 修复建议：一条真实进程 e2e，覆盖随机空闲端口启动并打印 URL、带 token 访问成功、端口占用时非零退出且输出不含 token、未 init 时的提示。`ui.ts:24` 拒绝端口 0，e2e 要自己先选空闲端口。`update` 会改外部状态，只测参数和错误路径。

### [TS-15] 标题承诺的行为没有被断言
- 维度：测试 | 严重度：S2 | 工作量：M | 置信度：高 | 状态：已确认
- 位置：packages/core/__tests__/phase1/session-job-e2e.test.ts:770-832，packages/web/__tests__/e2e/run-tab-content.test.ts:47-53，packages/web/__tests__/api/project-run-job.test.ts:224-272、440-455，packages/core/__tests__/workflow/lease-service.test.ts:368、386，packages/core/__tests__/session/job-runner.test.ts:776，packages/cli/__tests__/run-cli.test.ts:613-635，packages/core/__tests__/smoke.test.ts:59-60，packages/core/__tests__/runtime/claude-code-adapter.test.ts:49-133，packages/cli/__tests__/e2e/cli-flow.e2e.test.ts:158-164
- 现象：`session-job-e2e:770` 标题说不自动重复执行，但只等状态变成 interrupted，没有执行次数断言，`:776-777` 的注释还写着 requeue 后 passed，已过时。`run-tab-content:47` 只断言导航链接。`project-run-job:224` 标题说 exactly once，但按竞态结果分支，输掉竞态时只断言 `agent/cancelled` 为 0；`:440-455` 用真实 sleep 800ms 做否定证明。`lease-service:368、386` 标题说 does nothing，只验证不抛异常。`job-runner:776` 标题说 resolves immediately，没有时间断言。`run-cli:613-635` 的 10 条命令只断言退出 0 和 stdout 非空。`smoke.test` 只断言 `toBeTypeOf('function')`。裸 `toThrow` 45 处/16 文件（schemas 11、contract-strict 8、admission-store 4、agent-config-extended 4、config 3、state-machine 3 等）。`cli-flow:158-164` 的 pause 任何失败都能通过，`claude-code-adapter.test.ts:49-133` 大多 `message: undefined`，拒绝用例可能因别的原因抛错。
- 依据：AGENTS.md:21。没有证明假通过：`ProgressTab` 首行抛错的变异验证中 `run-tab-content` 能发现崩溃；`project-run-job` 的竞态分支命中率未验证；`run-recovery.e2e.test.ts:300` 对恢复不变量有另一层保护，所以不算掩盖真实失败。
- 影响：这些用例绿，不代表标题所说的行为成立。
- 修复建议：`session-job-e2e` 用计数 adapter 断言 `runAgent` 调用 0 次，并修注释。`project-run-job` 用 barrier 确保 cancel 先到。`run-tab-content` 的内容断言随 TS-07 一起做。直接删除只留 lease-service 和 smoke 的那几条。裸 `toThrow` 优先改 `claude-code-adapter.test.ts:49-133` 和 `cli-flow:158-164`，schema 类的 11 处风险低，可以不动。

### [TS-16] 慢测试集中在少数文件，部分用整条流程验证简单拒绝
- 维度：测试 | 严重度：S2 | 工作量：M | 置信度：高 | 状态：已确认
- 位置：packages/cli/__tests__/run-cli.test.ts:41，packages/web/__tests__/api/project-run-job.test.ts:92、179、201，packages/web/__tests__/api/write-auth.test.ts，packages/cli/__tests__/e2e/cli-flow.e2e.test.ts:30、269，packages/web/__tests__/e2e/dashboard-surfaces.e2e.test.ts:5，packages/web/playwright.config.ts:7
- 现象：前三个文件累计 217.58s。最慢单测：`run-cli` 的 “covers the local release command surface”（从 `:41` 开始的 600 行单个 `it`）28.5s，cli-flow 22.07s 和 19.88s，release-flow 21.69s。`project-run-job` 的 MF2 10.3s、SHOULD16 9.76s、M8 9.51s，只测对活动 run 或终态的拒绝，却先跑完整 standard-delivery。Playwright 6.8 分钟（workers:1），日志没有单用例耗时。
- 依据：(75.86+72.54+69.18)/585.76 = 37.1%。三条拒绝测试合计 10.3+9.76+9.51 = 29.57s。M8 也是 TS-19 里负载下超时的用例。
- 影响：可节省的累计耗时量级在这 29.57s 之内，机制是把 16 节点流程换成单节点模板或直接种状态，墙钟收益取决于并行，未实测；修 M8 还能同时去掉一个不稳定来源。拆开 600 行的 `it` 主要收益是失败定位，不是提速。
- 修复建议：拒绝类测试换最小模板或种子状态。拆开 `run-cli.test.ts:41`。重复的宽度矩阵（`dashboard-surfaces.e2e.test.ts:5` 的 7 个宽度）按断点合并，收益未实测。

### [TS-19] 依赖真实时间的用例在负载下超时，3 条已复现
- 维度：测试 | 严重度：S2 | 工作量：M | 置信度：中 | 状态：已确认
- 位置：packages/web/__tests__/api/project-run-job.test.ts，packages/web/__tests__/api/write-auth.test.ts，packages/cli/__tests__/e2e/cli-flow.e2e.test.ts，packages/core/__tests__/session/job-runner.test.ts:574、582、720、747，packages/core/__tests__/session/job-runner-stop-race.test.ts:51、230，packages/core/__tests__/session/run-recovery.e2e.test.ts:130、291、294，packages/cli/__tests__/run-cli.test.ts:21、371、1291，packages/web/playwright.config.ts:12-13，packages/web/__tests__/e2e/shared-fixture.ts:44-46
- 现象：`setTimeout(` 73 处/26 文件，`useFakeTimers` 只有 2 处，多处用 sleep 做否定证明。显式超时：30s×48、15s×15、20s×11、60s×8、45s×6、90s×3。一轮变异全量中 3 条失败：M8（waitFor 上限 20s，21.88s）、write-auth shape（15s，16.41s）、cli-flow draft plan（30s，39.7s）。未变异时全量 5 轮分别为 9.51-11.45s、10.24-12.1s、19.88-25.61s；单跑 3 次全过，分别为 5.99-8.15s、5.71-6.4s、12.45-14.62s；限速（`taskpolicy -b`）跑都失败，分别为 23.05s、15.2s、82.1s。提交 39919c5 把 release-flow 从 30s 提到 90s。`shared-fixture.ts` 注释记录过冷启动 401 flake。`run-cli.test.ts` 在进程内改 cwd 和 PATH。
- 依据：事实：3 条都用 mock，变异点走不到它们；限速下的失败信号与那轮相同；那轮累计 840s，其余 4 轮是 628-731s。推断（强）：这 3 条是负载下超时，和变异无关。样本只有 1 轮全量失败，不能当失败率。
- 影响：负载变化时会假红，余量也紧（shape 12.1/15s，plan 25.61/30s）。否定证明的 sleep 也可能太短而假绿。
- 修复建议：先把这 3 条换成最小模板或种子状态，不优先加大超时。否定证明改成事件完成信号或计数断言。PATH、cwd 改成通过子进程环境传入。

### [TS-17] 重复和常量测试
- 维度：测试 | 严重度：S3 | 工作量：S | 置信度：高 | 状态：已确认
- 位置：packages/core/__tests__/workflow/engine-unit.test.ts:34-100、337-400、410-460、466-475、484，packages/core/__tests__/workflow/workflow-runtime.test.ts，packages/core/__tests__/workflow/helpers.test.ts:59-130，packages/web/__tests__/api/redaction.test.ts:13、20、59-64、89、93，packages/web/src/server/api/redaction.ts:80-83
- 现象：`engine-unit` 与 `workflow-runtime` 同测 scopedId、stableGateKey、gatesWithStableKeys、resolveReviewTargetNodeByHeuristic，有 16 个同标题用例，其中 3 个函数体完全相同，13 个只有数据不同。`assertSuccessfulAgentRun` 测了两份。还有常量和形状测试，如 “returns a string path”、“returns an object with startRun and resumeRun functions”。`redaction` 两组同名用例不是纯重复，`redactTextPreview` 等于 `redactString` 加 `slice`。`redaction.test.ts:59-64` 标题写先截断再脱敏，实现相反；断言 `≤30` 也锁不住截断，去掉 `slice` 后输出 16 字符仍能通过。
- 依据：AGENTS.md:21。
- 影响：改一处要改两处，不增加信息；`redaction` 的截断没有被锁住。
- 修复建议：删除 `engine-unit` 中与另两个文件重复的块和常量测试。`redaction` 只删 preview 组里的模式用例，保留 `redactString` 组。`:59-64` 改正标题，并断言 `'token'`。

### [TS-18] 测试 helper 碎片化
- 维度：测试 | 严重度：S3 | 工作量：M | 置信度：中 | 状态：已确认
- 位置：packages/cli/__tests__/run-cli.test.ts:1526-1625，packages/web/__tests__/api/write-auth.test.ts:1527-1624
- 现象：相同实现 17 到 18 组，冗余 211 到 387 行，差异来自统计口径（collectSse、makeFakeReqRes、createMemoryIo、makeDraft 等）。同名变体：setup 17 文件 526 行，seedRun 11 文件 431 行，createRunFixture 9 文件 327 行，fixture 8 文件 256 行，waitFor 6 文件（只计函数声明），seedSession 8 文件，createFixtureRepo 7 文件 210 行。git fixture 构造函数 23 个。`writeFakeCodex` 有两份近似实现。
- 依据：文本归一化比较和同名统计。同名变体不一定都能合并。
- 影响：改内部表或 fake 行为时要改多处，也是 TS-03 成本的来源之一。
- 修复建议：只抽 fake CLI、SSE 收集、状态种子这几类高频 helper，放进现有测试 helper 目录，不新建框架。

### [TS-20] e2e 命名失真
- 维度：测试 | 严重度：S3 | 工作量：S | 置信度：高 | 状态：已确认
- 位置：packages/cli/__tests__/e2e/draft-agent.e2e.test.ts:6、42、56，packages/core/__tests__/phase1/session-job-e2e.test.ts，packages/core/package.json:18-19
- 现象：CLI e2e 目录下的 `draft-agent.e2e.test.ts` 直接 import src，用 fake backend，不是真实进程。12 个 core e2e 有 6 个没有 spawn 或 execFile。`session-job-e2e.test.ts` 不匹配 `.e2e.test`，会进入 `test:unit`。16 个 Playwright 和 API 文件名用 r23 到 r27 这类版本号。
- 依据：AGENTS.md:22 约定 CLI e2e 目录是真实进程测试。
- 影响：会高估真实链路的覆盖，也不便按路径找测试。
- 修复建议：重命名或移动文件，把真实进程 e2e 与进程内集成测试分开。

## 五、需要决策的事项

已定（2026-11-09，用户授权维护方评估）：[CD-36] Draft 并入动态工作流的 planner，统一走 adapter，随重构第 5 阶段处理。条目区不再有待决条目。

另有一项非条目决定：[Agent SDK 文档](https://code.claude.com/docs/en/agent-sdk/overview.md)对第三方产品使用订阅登录有限制，资料内容是登录方式的适用范围。Tekon 驱动的 agent 可能走订阅登录，自用是否合规本次未判定，发布给他人使用前必须重新确认（仓库公开且有 install.sh）。

还有一项待用户确认的决定：是否统一 Web 和 CLI 的写权限基线（见 PD-10）。

## 六、审查范围与局限

- **已覆盖**：`packages/core`、`packages/cli`、`packages/web`、`workflows`、`roles`、`scripts`、AGENTS.md、README、现行文档。
- **未覆盖**：`docs/reviews` 360 个历史证据只统计规模。install 和 update 脚本只读未运行。
- **局限**：
  - 真实 provider 只跑过 Claude Code（1 次 bugfix），本机没有 Codex，Codex 相关结论只来自 stub 和读码。
  - 多数复现用 mock 或假 CLI，CD-46 的真实触发频率没有数据。真实系统休眠未测，时钟跳变是模拟。
  - Web 走查用合成数据和 mock provider。
  - 没有使用数据，删除建议以静态调用关系和用户目标为依据。
  - 同类框架调研只读代码和文档，没有运行。
- **待查线索**：`packages/web/__tests__/e2e/start-run-form.test.ts:130-159` 默认提交 codex 且不隔离 PATH。PATH 前置记录桩单跑一次，桩收到 0 次调用，可能是测试结束早于 job 被认领，不足以定论。

## 附录

### A. 内部评审记录

- **轮数**：2 轮。第 1 轮全范围质证：确认 50，修改 59，驳回 0，补报 4。第 2 轮复核 3 条补报：全部修改。
- **驳回**：无。
- **补报**：CD-45（暂停或时钟跳变后被杀）、CD-46（返工后卡死，复核后升 S0）、PD-31（blocked 恢复盲目重跑）；另一条（环境丢 API key 和代理）并入 CD-01。
- **严重度校正**：PD-02、PD-03、PD-04、PD-06、CD-02、CD-07 从 S0 降到 S1；CD-04、CD-15、CD-16、CD-41、TS-03、TS-04、TS-05、TS-06、TS-07、UI-06 从 S1 降到 S2；CD-29 从 S2 升 S1；TS-19 从 S3 升 S2。
- **用户确认的决策（2026-11-06）**：
  - PD-01：转通用 workflow 框架，研发交付退为模板。
  - CD-11（含 PD-29）：驱动现有 harness，现仓库分阶段替换。
  - CD-01、TS-09：白名单补 USER、LOGNAME、代理、ANTHROPIC_*、CLAUDE_*，加显式透传。
  - PD-08（含 CD-19）：新建轻量模板作默认。
  - PD-09（含 CD-13）、TS-06：重做为 plan 节点产出受校验的 steps。
  - PD-06（含 CD-08）、CD-39、TS-04：角色和产物自由命名，reviewer 和 Gate 可选，治理放进模板。
  - PD-21（含 CD-34）：模板声明出 PR 所需证据。
  - PD-05：默认冻结，提示差异，`--rebind` 显式采用。
  - CD-23、CD-04：blocked=2、paused=3；Codex 保留恢复并加告警。
  - PD-14、PD-25：任务一对多 run，Web 只留一套入口。前端改信息架构和数据来源，不换技术栈。
  - 认证：API key 和订阅登录都要能用，由各 agent 自己管理，Tekon 不做认证配置；会使用各种模型，模型配置可选，不写就用 agent 默认值。
  - 交付：报告入库，不带截图；S0 单开 hotfix；安全细节只留本地。

### B. 基线数据

- **测试**：根 vitest 2248 个用例，0 失败，1 跳过。Playwright 211 passed（约 6.8 分钟）。首轮 Playwright 因本机浏览器版本不符报错，安装对应浏览器后全过，不算项目缺陷。
- **覆盖率**：lines 84.25%，branches 83.27%。client 不计量（见 TS-10）。
- **构建与类型检查**：通过。
- **真实运行**：Claude Code 2.1.318，补 USER 后 bugfix 到人工 Gate 269 秒、4 个 agent 节点、51 轮、约 \$1.59；批准后 passed。
- **热点（6 个月，排除证据）**：CHANGELOG 93、README 81、手册 HTML/MD 67/55、cli/index.ts 45、workflow/engine.ts 44、core/index.ts 36、engine-role-prompt.test 27、web root.ts 24、write-auth.test 19。
