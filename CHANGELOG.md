# 变更日志

## 0.41.0 — 2026-11-20

- **多 Agent 工作台与编排引擎精简重构**：
  - **Core（`@tekon/core`）**：SQLite 幂等升级至 Schema v8（新增 `task_attachments`、`task_context_entries`、`role_sessions`、`context_archives`、`user_preferences`、`follow_up_turns` 6 张表及向后兼容增量列，保持既有闭集枚举不变）；新增本机 Agent 探测注册表（`createAgentDiscoveryRegistry`，60s 缓存、严格 ≤5s 超时上限、仅从 `~/.tekon/agents.yaml` 扩展自定义 Agent、项目 `.tekon/config.yaml` 维持 `.strict()` 防 RCE）；新增节点级多 Provider 解析器（`createProviderAdapterResolver`）与任务编排运行时（`createWorkbenchRuntime`），消除单运行单驱动限制，支持跨 Provider 混排、快照冻结隔离、确认点与定点上游返工（`needs-revision` + `attempt_generation`）、单节点局部换模型重试、协作暂停/恢复/排队约束/二次确认不可逆终止、动态蓝图规划（2 次自动纠偏 + 失败回退 + 编辑 + 另存为模板）及完成后多轮追问。
  - **双层上下文与产物协议**：Single Source of Truth `buildNodeContextPackage` 同时驱动执行 Prompt 与前端透视；支持通用上下文（goal/handoff/constraint/rework）+ 固化 Markdown 文档跨节点 `(run_id, doc_key)` 版本管理、行级 LCS Diff、Pin 置顶、控制字符清洗导出、锚定历史压缩（保留目标与最近 2 轮并真实计算窗口占用）与可逆归档挂载；同角色会话自动续接支持显式 `reset` 覆盖并隔离跨驱动 `providerThreadId`；通用输出摄入（`general-output.ts`）对 `handoff.json` 与 `<docKey>.md` 强制软链/越界拒绝与 `redactSecrets` 脱敏，三条执行路径统一对齐 Codex 适配器 4 段 `.tekon/runs/<runId>/<nodeId>` 目录契约。
  - **内置通用角色与线性模板**：新增 `explorer`、`designer`、`coder`、`orchestrator` 通用角色与 `deep-research`（4 节点：调研→初稿→独立评审→终稿）、`quick-dev` 线性工作流模板，增量兼容保留 `reviewer` 与全部历史交付模板/角色。
  - **Web 工作台（`@tekon/web`）**：新增 42 个会话鉴权（`auth: 'session'`）工作台 RPC，完整保留全部 38 个历史后端 RPC；前端重构为 Semi Design 浅色/深色双主题双栏工作台（零新增 npm 依赖、严格生产 CSP `script-src 'self'` 零内联脚本），提供默认收起的顶部点线进度条（支持应用内切换右侧竖向进度轨与窄屏 ≤900px 自动回落）、3 档内容宽度切换（正常 760px / 宽 1080px / 全宽 100%，零横向溢出且保留表单草稿）、全场景 Agent 品牌 SVG 图标与级联 `Agent → Model → Effort` 选择器、去框化时间线、文档/上下文右侧抽屉与 `Esc` 分层关闭；旧 `/sessions/*` 与 `/advanced/*` 路由平滑重定向至 `/`。
- **文档、CI 与自举验证**：
  - 用户手册新增 **§13 多 Agent 工作台与部署指南**（MD + HTML 同步），提供一键安装/升级、源码构建、本机 Agent 配置、macOS `launchd` / Linux `systemd` 常驻服务及 SSH 远程安全访问指南；同步更新 `README.md`、`docs/README.md` 与 `docs/reviews/current.*`。
  - `.github/workflows/ci.yml` 补充 `bash -n scripts/update.sh` 语法检查，并在 `web-e2e` job 中显式构建 `@tekon/core` 与 `@tekon/web` 生产包再运行 Playwright E2E。
  - 完成真实本机 `claude-code` `2.1.327` 双节点自举验证（`run_2195c05b-218`，真实捕获并修复空 `commandPolicy.allow` 生产缺陷），归档至 `docs/reviews/2026-11-20-tekon-v2-bootstrap.md`（及 HTML）。

## 0.40.0 — 2026-11-19

- 声明式交付证据（PD-21）：工作流模板新增顶层 `delivery:` 块声明「是否可交付 + 所需证据」，裁决依据从模板名称改为运行受理时冻结的计划快照（`plan_snapshot`，sha256 摘要），运行途中改 YAML 不影响在途运行。五个产代码内置模板补齐声明：`standard-delivery`（build/lint/test + 五类治理门禁 + QA 签署 + 安全扫描 + 验收证据）、`bugfix`/`standard-feature`（命令门禁 build/lint/test，另有 QA 签署与安全扫描要求）、`test-improvement`（命令门禁额外含 e2e）、`docs-update`（命令门禁仅 build/lint，另有 QA 签署与安全扫描要求）；`goal`、`plan-only`、`lightweight-delivery` 不声明、结构性不可交付。schema 在归一化双收口（`normalizeWorkflowTemplate` 与 `normalizeExecutableTemplate`）强制：门禁类型必须属内置枚举、声明的门必须在节点中真实存在、数组去重、`deliverable:false` 不得携带 requirements，非法模板两条路径均报 `INVALID_WORKFLOW_TEMPLATE`。
- Pre-PR readiness 重写为声明驱动：命令门禁按「每节点 + gateKey」取最新结果裁决（skipped 且 not-applicable 视为满足，零结果判缺失），治理门禁按类型集合语义；模板未要求的维度以「模板未要求」通过而非标红。快照缺失、旧 V1、损坏或摘要/投影被篡改一律 fail-closed 为单一 `delivery-not-declared` 失败检查、绝不抛错击穿 review 面。check id 改名 `standard-delivery-template`→`delivery-declared`、`standard-governance-gates-passed`→`governance-gates-satisfied`，旧 id 在 Web 标签库保留为历史事件别名。
- **行为变化（S2）**：升级前创建的旧运行没有带声明的冻结快照，升级后按不可交付处理，需换用可交付模板重新发起运行才能 prepare/创建 PR；自定义模板同样需显式补 `delivery:` 声明。
- Web：Delivery 页 Dry-Run 删除自研宽松判定，改调 core `evaluatePrePullRequestReadiness` 单一事实源，响应携带逐项 `readinessChecks`；Prepare PR 按钮按 `readiness.ready` 禁用，禁用时内联展示首个失败检查的中文标签与建议；Run 详情 DeliveryTab 新增「交付落点与下一步」卡片（交付分支/基线、各节点 worktree 及释放状态、diff 概览、PR 包与 body 文件路径、下一步命令），数据来自 review surface 新增的 `worktrees` 字段并经 RPC 合约校验。
- CLI：`tekon delivery prepare` 与 `tekon run` 结束输出追加「交付指引」块（分支/base/worktree/diff/落点/下一步），命令建议复用 core `nextCommandsFor` 不另起判定；diff 可用时追加本地 `git merge tekon-delivery/<runId>` 合入提示。本批不新增 git 回送命令（脏工作区/in-place/非 Git 场景需独立设计），已在 devflow backlog 与手册 §5.4「未来条目」登记，指引不承诺不存在的动作。
- 测试：core 新增交付声明 schema 19 测、快照完整性回归（旧 V2/V3 投影兼容、声明改动改摘要、篡改 fail-closed）、readiness 43 测（每节点裁决、双节点 3/4 计数、坏快照、goal/deliverable:false/零准则边界、gateKey 去重与治理门 latest-wins、冻结独立性）与 surface worktree 租约映射测；模板布尔证据要求与静态门禁交叉校验（validate 期拒绝不可满足声明）。Web API 新增不可交付模板 dryRun 用例与 Playwright 4 项（禁用原因、DeliveryTab 指引卡含阻断态与未 prepare 态、Prepare 启用态真实点击、390px 窄屏无横向溢出），另增 check-labels 漂移防护与指引卡纯函数单测；CLI 新增交付指引纯函数 10 测、不可交付 run 的 prepare 中文阻断进程内测，release-flow e2e 补 bugfix 审批后端到端 prepare。手册（§4.7/§5.4/§5.10/§6.14）、README 与产品范围 md+html 同步声明式交付模型；术语统一为「QA 签署」，CLI prepare 阻断错误中文化（含补救路径，不再直出英文技术串）。

## 0.39.2 — 2026-11-19

- 回退未合入的 0.39.1 依赖归类尝试，恢复 `vite`/`@vitejs/plugin-react` 在 web `dependencies` 的生产依赖定位。0.39.1 曾把二者移到 `devDependencies` 以让 `pnpm audit --prod` 排除其传递依赖 picomatch（GHSA-fc5q-39xc-vjpf），但该判断不成立：`packages/web/src/server/http.ts` 在 `tekon ui` dev 模式经 `await import('vite')` 动态加载 Vite 中间件并启用 React 插件，二者是真实运行时依赖；`runtime-audit-scope.test.ts` 也以合同测试钉住「manifest 与 lock importer 均属生产依赖」。回退后产品行为与 0.39.0 完全一致（构建产物哈希不变），仅版本号前向递增以保持历史单调。
- picomatch ReDoS 公告仍在，但它只经构建/开发链进入、非浏览器运行时面，且 Dependency audit 是不阻塞合并的非必需检查；在 npm 发布含修复的 picomatch 版本前维持现状，待上游补丁后升级，不在审计中静音高危项。

## 0.39.0 — 2026-11-18

- 新增轻量默认工作流 `lightweight-delivery`（PD-08）：plan→implement→confirm 三阶段、pm-plan/rd-implement/human-confirm 三节点，只保留两个 `schema` 门禁与一个人工 `human` 门禁，产出 demand-card、code-changes 两个产物。human-confirm 是无产物输出的纯人工确认节点，跨阶段 `dependsOn` 实现节点，驳回经 PD-18 `reworkTargetNodeId: rd-implement` 回到 RD 返工；节点重试 maxAttempts 2、固定退避 250ms。小改动不再承担 `standard-delivery` 的 16 节点/44 门禁成本。
- 新增 `DEFAULT_WORKFLOW_TEMPLATE_ID = 'lightweight-delivery'` 常量并加入内置模板联合类型，作为运行缺省唯一事实源：core 的 admission-store（3 处回落）、workflow engine 回落，CLI 的 `run`/`doctor`/`workflow preflight`，以及 Web 的 workflow/project 路由与受理信封统一改用该常量。`standard-delivery` 不再是隐式默认，需在模板列表显式选择；`workflow init --from` 脚手架刻意保留 `standard-delivery` 作复制源（生成完整可裁剪模板），与运行缺省默认分离。draft shape 的受控模板联合同步收录新 id。
- CLI `run` 模板生效优先级明确为「显式 `--template` > 已塑形需求卡 `recommendedTemplate` > 缺省默认」。生效模板只在新受理分支内惰性解析、经 `startRun` 通道绑定；**受理信封（requestId + 需求哈希双键）保持常量、绝不因模板回落重建**——同一 Request ID 重放时即使需求卡已删除/修改也不会触发 `REQUEST_ID_CONFLICT`，沿用首次执行绑定的模板，修复了分支内重建信封导致重放永久哈希冲突的缺陷。
- Web 首页 SessionComposer 新增运行模式/工作流模板/执行代理三选：抽 `use-run-plan-selection` 共享 hook（agent 常量、默认代理解析、Goal/DSH 互斥、全量入参 planKey），StartRunForm 高级表单改为复用同一套常量与约束，两个入口行为对齐。切换任一选择都以全量入参重查 `workflow.plan`，查询缓存按入参区分不串用；Goal 模式禁用模板且请求不带 template/profile，选 `dsh-headless` 自动切 Goal 并清空模板；提交时默认留空不带 template（服务端回落轻量默认），显式选择则随受理载荷上报。
- 产品边界登记：轻量模板只有 schema+human 门禁，无命令型门禁、五类治理门禁、安全扫描与验收证据，Pre-PR readiness 9 项中 6 项结构性恒红（模板、命令门禁、验收证据、QA 签署、治理门禁、安全扫描），`ready` 恒 false，`delivery prepare`/`create-pr` 前置拦截——默认模板不会也无法自动产出 PR，需要可审 PR 必须显式 `standard-delivery`。
- 测试：core 新增轻量模板结构/目录/常量单测 6 项与真实内置模板引擎 e2e 2 项（暂停→驳回触发 rd-implement 返工、驳回标记进 prompt、返工审计事件→再暂停→批准 passed 的完整人工环，以及一次通过路径）；CLI 新增真实进程 e2e 6 项（默认轻量、显式模板、Draft 采用、覆盖、Goal、删 Draft 同 runId 重放）；Web 新增 Playwright 三选 e2e 4 项（默认渲染、全量入参刷新与缓存命中、Goal/DSH 互斥、受理载荷 template 取舍）；既有 run-cli/write-auth/workflow-inspect 断言升级为显式 `standard-delivery` 口径。另新增轻量模板 readiness 6 项恒红边界回归（精确钉住 6 红/3 绿 id 集合，防默认模板悄悄变得可交付）。
- 修复 Node 24 下角色物化的进程级硬崩（CI Verify 红灯根因）：`materializeProjectRole` 原直接 `fs.cpSync(..., {recursive:true})` 复制内置角色目录，当目录权限被撤（如 `chmod 0o000`，根目录或嵌套 `skills`/`knowledge` 子目录）时，Node 24 的 native `directory_iterator` 抛出的 C++ `filesystem_error` 会逃逸 N-API 绑定边界，JS try/catch 无法捕获而 `SIGABRT`（vitest 表现为无 JS 错误的 `Worker exited unexpectedly`，全部测试仍过但步骤失败）；Node 20/22/26 同路径正常抛 JS `EACCES`。现 cpSync 前用纯 libuv JS 系 API（`readdirSync` + `accessSync`，不走 native 迭代器）对整棵角色树递归预检，任一不可读项即在创建临时目录前 fail-closed 抛可读 `ROLE_DIR_INVALID`、无残留；覆盖根目录与嵌套子目录两类撤权，最小复现脚本与 Node 24/26 双版本验证通过，并经负向用例证实撤掉递归预检会在 Node 24 复现 SIGABRT。
- 修复 CLI `run` 结果行模板错报：采纳 Draft `recommendedTemplate` 回落时，执行与落库用的是生效模板，但 stdout「模板:」行原来打印受理信封里的静态缺省（误报 `lightweight-delivery`）。改为从持久化计划快照 `planSnapshot.template.id` 回读实际生效模板（fresh 受理与重放路径一致），快照异常时安全回落到信封模板；展示与执行、审计、plan_snapshot 重新对齐。

## 0.38.0 — 2026-11-18

- Web Config 页整改（PD-11）：删除与真实 `constraints.yaml` 结构不符的静态 Constraints tab（页面、路由、导航与死样式一并清理，旧 URL 落到 404 页）；Roles 页从「只读项目目录、新项目误显示 No roles configured」改为列出内置+项目角色并集（6 个内置角色不再隐形），每行标注来源（内置 built-in/项目 project），overview 角色计数同口径修复。
- 角色 prompt 可在 Web 查看与编辑：列表 DTO 仍保持 strict 不携带 prompt（既有防泄漏回归不变），新增显式 `role.get`（返回生效候选的 systemPrompt 与来源）和 `role.updatePrompt`（会话 token 鉴权）两个 RPC。编辑内置角色不会修改安装目录，而是在 `.tekon/roles/<id>/` 物化整目录项目级覆盖（复制 agent.yaml/tools.yaml/skills/knowledge，保证 `loadRole` 三级解析合同不被半成品破坏），运行时项目覆盖优先；项目角色直接改写其 system.md。
- 角色写原语下沉 core（新 `role/project-overrides.ts`）：`listAvailableRoles`/`readRolePrompt`/`materializeProjectRole`/`writeProjectRolePrompt`，CLI `tekon role create` 重构为薄封装共用同一实现，输出、错误文案与重复创建拒绝行为保持不变（真实进程 e2e 锁定）。物化走临时目录 + 原子 rename，失败清理不留残留，重复调用幂等。
- 写路径安全闸门对齐 demand.ts 范式：`.tekon` 父目录与 roles 目录 lstat 拒软链、realpath 严格锚定 `<repo>/.tekon/roles` 防父目录软链逃逸、角色目录 containment、system.md 文件本体写前 lstat 拒软链；角色 id 经 kebab-case schema 校验，prompt 限非空且 ≤64 KiB（按 UTF-8 字节计）。RPC 语义校验在 handler 内完成，非法/未知 id 与解析失败均给中文 4xx/404 而非英文模板；仅存在于 user 级的角色不经 Web RPC 直读。
- 测试：core 新原语 18 测（含五类软链/逃逸对抗夹具、原子性与重试、字节边界）、Web RPC 8 测（并集、token 鉴权、落盘且内置零改动、中文错误、user 级隔离、非法 prompt 零副作用）、Playwright 编辑旅程与 Constraints 移除断言；旧 role.list/overview/contract-strict 断言升级为并集口径，安全断言保留。

## 0.37.0 — 2026-11-18

- 角色 `tools.yaml` 工具策略从「仅 prompt 提示」升级为运行时 fail-closed 强制（PD-10 10a-2）。角色声明的 `deny`/`requiresHumanApproval`/`network`/工作目录约束现在真正参与命令裁决，不再依赖 agent 自觉。
- 新增纯函数 `mergeRoleAndGatePolicy`/`mergeCwdScope`（core 导出）：角色策略与门禁策略按候选 A 合并——`deny`/`requiresHumanApproval`/`allow` 取并集、`network` 取最严（disabled>restricted>enabled）、工作目录走语义 containment 交集（取能容纳执行 cwd 的唯一最窄 scope，无 scope 容纳时 fail-closed，杜绝朴素数组交集在 worktree 场景误杀）。角色 `deny` 不可被门禁手写授权（PD-04）覆盖；固定拒绝规则（危险 rm/force push/shell 元字符/网络）仍在裁决最前端先生效。
- 两条执行通道统一收口：命令网关（gate-runner 门禁命令、resume 确定性失败判定）按「拥有该 gate 的节点」角色合并策略（返工取 targetNode 角色，不串用评审节点）；适配器通道在现有 `AgentRunInput.commandPolicy` 上逐节点不可变合并（node/rework/repair 四调用点经 `agentInputForLease` 单点覆盖，不 mutate run 级单例）。
- preflight/doctor 接入同一角色策略：新增 `resolved-approval-required` 预检状态（复用网关同一 `matchesAny` 判定），消除「预检 resolved、运行 blocked-for-approval」的审批双标；角色在预检与运行期经同一 `loadRole` 层级解析。
- 安全：角色 `tools.yaml` 损坏/加载失败时节点 fail-closed，不回落基线继续跑；角色策略生效写 `role.tool-policy.applied` 审计（含 source 与约束规模），可追溯。
- 已知边界（设计登记）：codex/dsh 的会话内工具域与审批无原生强制（claude 经 `--settings` 落地），但网关层 blocked-for-approval 与网络/deny 约束对三 provider 一致；角色文件运行时读盘不进冻结计划，跨 resume 一致性依赖文件未被修改。
- 测试：新增合并函数 14 测（含归因判别，证明拒绝来自角色而非固定规则）、真实命令网关 e2e（角色 deny 端到端 rejected）、适配器注入/空 allow 不塌缩/双节点不可变/fail-closed e2e、resume 角色 parity、preflight 审批 parity。

## 0.36.0 — 2026-11-17

- 工作流模板可浏览、可校验、可轻量脚手架（PD-07 CLI 部分、CD-20）：`tekon workflow list` 每行输出 `id [builtin|project]` 来源标记，并在浏览阶段对每个模板跑非抛出的解析探针——解析失败的模板不再被静默丢弃，而是附 `invalid: <可读原因>`，写错的模板不必等到 `run`/`show` 才暴露；错误消息折叠为严格单行（YAML 语法错误自带的多行代码片段也不例外），保住一行一模板的脚本解析合同，完整多行诊断交给 `validate`。探针为显式 opt-in（`listWorkflowCatalog({ validate: true })`），既有调用方（含 Web 模板列表与 CLI 其他路径）不传该选项，目录扫描的零副作用形状不变。
- `tekon workflow show <name>` 由只给 id/name/阶段数三行改为节点化完整结构：逐阶段列出节点角色、工作区模式、内联提示词、产物类型与门禁（命令型门禁带 `commandRef`），不读模板 YAML 源码就能学写法。
- 新增 `tekon workflow validate <name>`：独立校验模板文件，成功退出 0 并输出阶段/节点数，失败退出 1 并给中文可读原因与修复指路，可直接用于脚本。core 同步导出非抛出的 `validateWorkflowTemplateFile`、判别联合 `WorkflowTemplateValidation` 与统一错误翻译 `readableWorkflowTemplateError`/`formatZodIssues`。
- CD-20 全链路消除裸校验器输出：`show`/`preflight`/`run`/`doctor` 共用的 `loadWorkflowByName` 现在把 zod 校验错误翻译为「字段路径: 中文原因」单行（invalid_type/too_small/too_big/unrecognized_keys/invalid_value 枚举/invalid_union 联合/invalid_format 标识符/superRefine custom 门禁均有中文映射，枚举错误附允许值列表），YAML 语法错误折叠为单行中文；zod 通过后的语义校验错误（重复阶段/节点 ID、重复 gateKey、未知 dependsOn 依赖、产物引用非法、保留产物类型误用等十余族）经展示层翻译表统一中文化，内部 throw 的英文稳定标识保持不变以免影响既有机器断言。模板名不存在时统一提示用 `workflow list` 查看可用名称——不再抛英文 ENOENT/EISDIR/EACCES，也不回显 CLI 安装目录这类仓库外路径。
- `tekon workflow create <name> --minimal` 生成单阶段、单实现节点加人工门禁的最小合法脚手架，不必再从重量级 `standard-delivery` 复制裁剪；不带 `--minimal` 时仍按 `--from`（默认 standard-delivery）复制既有模板，同传两个冲突选项时提示 `--from` 被忽略。create 现拒绝覆盖已存在的模板文件（需先手动删除或换名）；`--from` 来源模板不存在时给中文指路而非英文 ENOENT，且失败不留目标文件或空目录副作用。
- 模板目录扫描接受符号链接（`.yaml`/`.yml`）：项目可用软链共享同一份工作流模板，链接模板与普通模板一样出现在 `list`/`show`/`validate` 中并参与有效性探针。**统一软链信任边界（对所有命令一致）**：core 导出 `inspectTemplateSymlink`，在任何 `readFileSync` 之前做 lstat+realpath containment 校验，链接目标必须位于该模板目录内——目录扫描的取名读取与解析探针、按名加载器 `loadWorkflowTemplate`（Web/goal 路径）、CLI `loadWorkflowByName`（show/preflight/run/doctor 汇聚点）与显式 `validate` 全部共用同一闸门。指向目录外（含随 git 提交进入仓库的恶意软链）或断开的链接一律拒绝读取：list 标记为无效条目，显式命令直接报中文错误，杜绝仓库外文件内容经 YAML 解析错误片段或条目字段回显（覆盖自动枚举与用户点名两条路径）。Web 两个 `loadProjectWorkflowIfPresent` 直读助手（workflow/project 路由的 plan/run 模板加载）此前绕过按名加载器，本批同样接入闸门并有 RPC 级回归（越界软链经 `workflow.plan` 被拒且不回显外部内容）。目录内合法软链（含嵌套）正常放行，共享用法不受影响；EISDIR/EACCES/ELOOP 等异常均给中文错误而非裸 errno。断链、越界、目录链接、按名/显式加载/Web RPC 拦截均有回归用例并断言不泄漏外部内容。已知残留：lstat/realpath 与读取之间存在本地单用户模型下可接受的 TOCTOU 窗口，注释中登记。
- 修复 argv 解析隐患：统一从子命令后的完整 tail 解析选项，模板名只取 parseArgs 规范化后的位置参数。旧实现的原始 argv 解构有两类错位——`workflow list --repo <path>` 这类标志紧跟子命令的写法，`--repo` 被吞进名称位导致 parseArgs 见不到 repo、静默回落当前工作目录（项目模板不可见）；`workflow show --repo <path> <name>` 这类标志位在位置参数之前的写法，`--repo` 会被误当模板名去找 `--repo.yaml`。现在 `select` 之外的五个子命令对两种参数顺序行为一致，无位置参数的 `preflight` 正确回落 `standard-delivery`。手册新增 §6.3.1（Markdown 与 HTML 人审版同步），并顺手修正手册封面历史版本号。

## 0.35.0 — 2026-11-17

- 角色支持声明 Provider 覆盖（PD-10 第一批）：项目/内置角色 `agent.yaml` 新增可选 `model`、`effort`、`driver` 三个厂商中立的开放字符串字段，不写时沿用运行级 Provider 默认值，行为零变化。覆盖按节点在执行期读取角色文件（与 `system.md` 热更同语义，不进冻结计划），经适配器翻译成 harness 参数——claude-code 的 `model` 翻译为受控 `--model`；codex 的 `model` 翻译为 `--model`、`effort` 翻译为受控 `model_reasoning_effort`。三个字段在进入任何子进程 argv 前经统一字符白名单校验（字母/数字开头，仅含字母数字、连字符、点、下划线，长度 ≤64），在解析层与两个适配器构建层双点拦截，杜绝选项与 Shell 元字符注入。适配器无法 honor 的字段在节点启动前显式报错而非静默丢弃：claude-code/dsh-headless 不支持 `effort` 报 `ROLE_OVERRIDE_UNSUPPORTED`；角色 `driver` 与运行级 Provider 不符报 `ROLE_DRIVER_MISMATCH`（同一运行不能按节点切换 harness）；非法值报 `ROLE_OVERRIDE_INVALID`。每次解析送达适配器的覆盖写入审计事件 `role.provider-overrides` 可追溯（是否真正生效以适配器执行结果为准）；`mock` 适配器忽略所有覆盖。合同 5 由 `it.fails` 占位转为真实回归（核心 expected fail 归零）。角色工具策略 `tools.yaml` 的运行时强制执行仍为后续批次。

## 0.34.0 — 2026-11-17

- 终态 failed 运行支持显式重试（PD-17 步 3）：新增 `tekon retry [--run-id <runId>]`——运行因门禁重试耗尽（模板声明 `onExhausted: fail`）等原因收敛为终态 `failed` 后，裸 `tekon resume` 仍按终态拒绝，确认失败原因排除后可用 retry 只重跑失败节点：CAS 把运行与失败节点从 `failed` 置回 `running`（状态机仅开放 `failed→running` 一条开口，`failed` 仍属终态），审计事件 `run.retried` 记录 `fromStatus`/`toStatus`；已 `passed`/`skipped` 节点由执行计划自然跳过、不重复调用 Agent，只有失败节点及其后继重新执行（新建角色执行记录，仍活动的工作树租约复用以保留现场）。重试沿用受理时冻结的计划与 Provider 快照，不改变模板结构；退出码与 `run`/`resume` 同一合同。
- 重试入口的状态守卫：只接受 `failed` 运行——`passed`/`cancelled` 按终态拒绝，`blocked`/`interrupted`/`paused` 报 `RETRY_NOT_FAILED` 并提示改用 resume，存在执行中作业时拒绝入队。重试选项经 `jobs.resume_options.retry` 持久化跨进程传递，入队与 claim 两道终态守卫同步开放 failed-retry 旁路（普通终态作业仍被拦截，retry 标记不能复活 passed/cancelled），作业执行器据此改走独立的 `engine.retryRun` 而非 resume 路径；CLI 入队后认领前崩溃留下的 queued 作业在下一次 retry 时由事务自动交接复用，不形成孤儿死结。`run.retried` 同步接入会话事件投影（Web 会话流以“受控交付已重试”标题区分重试代际）。
- 手册 §6.10.1 文档化 `tekon retry` 的用法、边界与与 `--rebind`/新运行的选择，并同步故障处理表与 HTML 人审版。

## 0.33.0 — 2026-11-17

- 修复配置后可在同一运行内采用新绑定（PD-05）：运行默认仍按受理时冻结的绑定恢复，但 `tekon resume` 与 `tekon status` 现在会只读探测并提示当前仓库配置与冻结绑定的分项差异（agent、provider、repo-profile 命令），不改变绑定；新增 `tekon resume --rebind [--agent <name>]` 显式采用当前配置——用冻结模板原字节与当前仓库事实重新捕获自洽的执行计划（新 digest），在一个事务内替换 `plan_snapshot`/`plan_digest` 与 Provider 快照，并重写尚未终态节点（含历史返工节点）的物化门禁，已通过节点的历史门禁结果与审计链保持不变，重绑定记录在审计事件 `run.rebound`（含新旧 digest 与脱敏分项差异）。终态运行与有活跃 Job 的运行拒绝重绑定；只重绑定 agent/Provider/门禁命令，模板结构变更仍需新运行。`tekon review` 的 missing-command Triage 改指 `--rebind`，不再建议与手册矛盾的旧路径。角色指令（`.tekon/roles/<role>/`）本就运行时读盘，修改后普通 resume 即生效，无需重绑定。
- 多人工门禁按 gateKey 精确关联返工（独立审查加固）：同一节点挂多个 human gate 时，被驳回的门禁结果必须与声明 `reworkTargetNodeId` 的门禁按稳定 gateKey 匹配，不再可能借用另一个门禁的返工目标发起错误返工并卡死运行；补纯判定与引擎级 e2e 及变异证据。
- `--rebind` 独立审查加固：重绑定事务内复查活跃作业，消除前置检查与事务之间的 TOCTOU 窗口（`REBIND_ACTIVE_JOB`）；零差异重绑定只跑安全守卫、跳过写入与审计噪声；补含人工返工节点的重绑定回归与审计脱敏（`[REDACTED_*]`）专门 e2e。
- Web 决策输出接口补齐 `requestNote` 字段声明，修复静态类型门禁（运行时 mapper 已输出该字段）。

## 0.32.0 — 2026-11-17

- CLI 退出码区分“卡住”的运行（CD-23）：`tekon run` / `tekon resume` 结束时按工作流终态返回退出码——`0` passed；`1` failed/interrupted/cancelled；`2` blocked（节点被确定性问题卡住，需先修复配置或环境）；`3` paused（等待人工确认）。此前 blocked 和 paused 都返回 `0`，脚本或 IM 集成会把“等待处理”误判为成功。`tekon status` 等只读命令退出码不变。
- 返工目标改为声明驱动（CD-14）：changes-requested 返工只读取评审产物 `reviewProcess.targetNodeId`（independent-review 门禁已校验其连通性、角色与产物类型），删除“取最后一个 passed 节点”的启发式回退——评审产物缺少合法目标时直接按门禁耗尽处理（blocked），不再可能重跑错误节点；六种评审产物类型一视同仁，不再只认三类白名单。返工反馈现在携带评审标题、正文、摘要、决定和完整 findings 列表，而不是固定英文句或被截断的 JSON 头部。
- 返工失败路径不再产生孤儿记录或掩盖真实原因（CD-33）：返工 agent 或评审节点重跑失败时，对应 role_run 立即标记 interrupted（旧实现留在 running）；评审重跑失败改为向上抛错由节点执行器统一收敛，消除 `illegal workflow transition` 二次异常；目标门禁抛错时清理租约别名，避免后续被 `active execution lease required` 掩盖真实门禁错误。三种失败注入均有 e2e 覆盖并验证 resume 可恢复。
- 恢复 blocked 运行不再盲目重跑 agent（PD-31）：新增确定性失败白名单——最近一次门禁失败为 `missing-command`、`rejected` 或 `unsupported-gate` 且失败条件在当前配置下仍成立时，resume 不创建 role_run、不调用 agent，节点保持 blocked 并输出原因与下一步（审计事件 `node.resume-skipped-deterministic`）；条件已消失或分类不在白名单（如 `exit-code`、`invalid-artifact`、`timeout`、`human-rejected`）时照常重跑，且重跑提示词注入最近一次门禁失败的类型与分类。新增 `tekon resume --gates-only`（Web `project.resume` 同步支持 `gatesOnly`）：只重跑门禁不重跑 agent，选项经新增的 `jobs.resume_options` 列持久化跨进程传递；节点无完成 agent 记录时以 `GATES_ONLY_NO_AGENT_RUN` 拒绝。
- 人工驳回接入返工链路（PD-18）：human gate 支持模板字段 `reworkTargetNodeId` 声明返工目标（解析期校验为节点直接上游，内置 bugfix/plan-only 已声明）；驳回后 resume 按声明对目标节点返工，决策备注作为反馈注入返工提示词，返工后重跑评审并产生新的 pending 决策（同一驳回只返工一次），不再盲目重跑被驳回的评审节点。人工决策新增 `request_note` 列与 `requestNote` 字段，把门禁请求上下文与决策备注分离，approve/reject 覆盖备注不再破坏审批摘要的命令/风险解析（旧行自动回落 note）。执行计划完整性校验接受 human-rejected 作为合法返工授权来源；合同 6 由 `it.fails` 占位转为真实 e2e 回归。
- 独立审查加固（同次发布）：人工返工补发 `gate.rework.attempt` 审计事件，动态返工节点由此通过二次 resume 的计划完整性校验（此前返工后再次恢复必然 `nodes.unproven` 卡死）；人工返工失败与 `--gates-only` 守卫拒绝都把工作流/节点收敛回 interrupted/blocked，不再谎报 running；完整性校验新增 human 返工目标与模板 `reworkTargetNodeId` 一致性断言；spawn 前取消的门禁归类为 `cancelled` 而非 `rejected`，不再被 resume fail-fast 误判为确定性策略拒绝；已物化冻结门禁的 missing-command 提示改指 `--rebind`/新运行而非死路；Web 决策投影顶层 `requestNote` 旧行回落与 core 对齐。

## 0.31.0 — 2026-11-16

- 工作流角色和产物类型开放命名（PD-06 子项 1–3）：模板里的 `role` 和产物 `type` 不再限制在内置枚举，任何 kebab-case 标识符（如 `writer`、`essay`、`weekly-report`）都能声明并在节点间传递；内置研发角色和 21 种内置产物保留专用校验，自定义产物类型回落通用 Markdown payload 校验（仍要求非空 title/body）。`ci-status` 改为显式的交付保留类型，agent 产物清单继续拒绝声明，安全边界从“枚举漏配的意外保护”变为明确规则。
- 节点支持自带 `prompt` 字段：模板节点可声明提示词，经执行计划落库到 nodes 表（新增可空 `prompt` 列，旧库自动加列），运行时注入该节点的 agent 提示词，resume 后保持一致。
- 角色管理放开自定义名字（PD-10 角色名部分）：`tekon role create <name>` 对非内置名字生成最小角色脚手架（agent.yaml + system.md），内置角色仍走整目录复制；`tekon role show goal` 不再被 CLI 的枚举副本拒绝；`role list` 能列出项目目录下的自定义角色，非标识符目录忽略。角色 ID 必须是小写字母开头的 kebab-case 标识符。
- 返工一致性：声明了节点 `prompt` 的节点被 changes-requested 返工时，节点指令在同进程返工提示词、落库返工节点和 resume 重建计划三条路径保持一致，评审反馈在节点指令之上叠加；自定义角色在 role-scope 门禁上 fail-closed（现役引擎与 legacy registry 两套实现均有测试守护）。
- 模板解析期直接拒绝把交付保留类型 `ci-status` 声明为节点产物，报错说明该类型由 Tekon 交付机制自产；Web 角色列表与 CLI 复用同一 kebab-case 标识符过滤，不再显示 `.DS_Store` 类非角色目录。
- 删除从未实现的 `parallel` 阶段字段（CD-24）：旧模板里残留的 `parallel` 键会被接受但忽略，解析结果、运行计划和发起页不再出现"并行阶段"标识，阶段始终按依赖顺序串行执行；节点级 `dependsOn` 不受影响。
- reviewer 节点与 Gate 变为可选（PD-06 子项 4）：不再要求模板必须包含 reviewer，产出 `code-changes` 的节点也不再强制带 build/lint 门禁，治理约束完全由模板自身内容表达；旧的 `governance` 字段保留解析兼容但不再生效。内置交付模板的角色、产物和门禁不变。
- 产品合同同步（PD-06 子项 5、CD-39）：AGENTS.md 把"角色/产物/Gate 是产品合同"改写为"内置模板的默认约束"，补全 core 模块描述；README 与产品范围文档去掉"固定流程/固定模板"表述，反映可自由定义的工作流模板。
- 手写仓库命令视为授权（PD-04）：门禁要执行的用户手写命令（模板内联或 repo-profile 绑定）自动进入该门禁的命令授权，`python3`、`make` 等非 Node 仓库的工具不再被固定 allow-list 拒绝；shell 元字符、网络命令、递归强制删除、force push 等固定拒绝规则仍然先生效。新增共享裁决函数，CLI `workflow preflight` 与运行期 Gateway 使用同一判定，预检的 `rejected` 状态能准确预测运行期结果，不再"预检 resolved、运行被拒"。
- 受理期阻断缺失命令（PD-04）：新运行所需的必填 `commandRef` 在 repo-profile 中缺失时，受理直接失败并给出补全或标记 `notApplicable` 的修改示例，不创建运行、不调用 agent（CLI 与 Web 均生效，Web 返回 400）；`security-scan` 缺失有内置扫描兜底，不阻断；历史冻结计划的执行语义不变。
- 旧计划兼容（CD-24 修复补强）：在 `parallel` 字段删除前冻结的 v2/v3 计划快照（含真实 R27 归档证据）仍可正常校验和恢复——投影对比前对称剔除遗留的 `parallel` 与 `digest` 键，计划摘要（digest）仍按冻结原字节做哈希认证，防篡改能力不降级；校验通过后回传的是经认证的冻结 digest 而非重投影的新 digest，因此 DB 级恢复链（`validateAndBuildExecutionPlan` 的 plan.digest 复核）与 `classifyExecutionBinding` 仍识别原计划身份（v3=frozen、v2=legacy-unbound），不会误判 invalid，历史冻结计划的执行语义保持不变。
- 预检/运行裁决一致性补强（PD-04）：CLI `workflow preflight` 对 `commandRef` 解析出的非基线工具（如 `python3`、`make`）现在与运行期同判为已授权（resolved），不再出现"预检 rejected、运行放行"；`preflight` 与 `doctor` 的门禁分类改为直接复用运行期 `commandBindingBehavior` 规则，human/schema/independent-review 等语义门禁携带的命令引用（缺失或已解析）统一显示 `not-command-gate`，不再误报 missing 或对永不执行的命令做网关拒绝，与受理期阻断规则严格对齐。
- 节点工作区三态（CD-09）：模板节点可声明 `workspace: worktree`（默认，隔离工作树，历史行为）| `in-place`（直接在仓库工作区执行，不建 worktree，支持非 git 目录）| `none`（禁止改源码）。文件权限不再从 `code-changes` 产物推断，而由该声明驱动：agent 提示词的源码编辑指引、finalize 裁决都按 workspace 生成；内置 Goal 模板显式声明 `none`，保留其历史只读语义。`none` 节点违规改源码时 finalize 抛可恢复错误（不进终态、不释放租约，审计事件带改动路径、工作树/快照位置与恢复指引），用户回滚后 resume 直接重试 finalize 而**不再重跑 agent**；同一节点首次 agent 失败/中断后再执行时，已释放的合成租约会被重新激活并为 none 节点重拍源快照基线，none 强制力在新一代执行中依然生效、带 gate 节点也不会因租约失活而卡死；合成租约（in-place/非 git none）在 release 后冷启动 resume 幂等复用、不报主键冲突，终态证据被正确识别。非 git 目录用文件快照（相对路径 + sha256 + 权限位，排除 `.git`/`.tekon`/`node_modules`）做源修改比对；worktree/repair 在非 git 目录抛可读的 `WORKSPACE_GIT_REQUIRED` 而非原始 git fatal。旧库自动加 `nodes.workspace` 列并默认 `worktree`，旧冻结计划快照缺省补 `workspace` 且 digest 防篡改不降级。`in-place` 与无交付分支的非 git 运行，PR 交付前置拦截（`DELIVERY_WORKSPACE_UNSUPPORTED`）。

## 0.30.0 — 2026-11-13

- Web 运行控制：blocked、interrupted、pending 等任何非终态运行都能在 Web 上直接取消（以前只有 running、paused 可以），interrupted 状态统一显示“已中断，需恢复”，不再出现“待输入/等待输入”这类与详情页不一致的标签；会话列表和运行表共用同一套状态标签，每个运行只显示一个徽章。
- Web 默认代理：发起运行不再写死 `codex`，改为读取仓库 `.tekon/config.yaml` 的 `defaultAgent`（与 CLI 一致，未配置时默认 `claude-code`），发起表单用服务端返回的默认代理初始化；预览和受理按同一代理计算，计划摘要一致。
- Web 写权限：Web 发起的写节点与 CLI 使用同一基线（`acceptEdits` 加角色的 `--disallowedTools`），headless 下普通文件编辑不再被只读默认拒绝；只读的 draft 路径不变。旧版本 Web 运行的快照仍是只读 `on-request`，恢复到写节点时会提示新建运行。
- Web 审批队列：`/advanced/approvals` 列出当前项目下所有运行的待审批决定，不再只看最新一个运行；每条决定带所属运行和恢复信息，按各自的 runId 批准或拒绝。在会话侧栏批准或拒绝后，全局审批队列现在同步刷新，不再显示已决定的陈旧条目。
- Web 运行前检查：发起和恢复运行后，若未检测到登录或有其他非阻断预警，会在页面提示，并列出透传的环境变量名；Provider 未安装等硬性失败仍在发起前直接拒绝。
- Web 受理预检：`.tekon/config.yaml` 写错时，计划预览、运行受理和受理指纹三个入口统一返回 400 并带 `TEKON_CONFIG_INVALID` 前缀（以前受理指纹入口只给泛化服务错误），空的代理名在 HTTP 入口即被拒绝。
- Web 就绪度：运行详情顶部徽章反映任务本身是否通过（工作流结果），交付包、PR 准备、PR 创建、远程 CI 等交付阶段在没有证据时显示“未开始”，不再计入失败；QA 签收和安全扫描属于任务结果，未通过仍计为失败。
- Web 进度页：移除恒为空的“命令进度”卡片（其只扫描运行根目录，而进度文件实际写在 commands/gates/节点目录），保留工作流进度和门禁时间线；`progress.list` 接口保留给其他调用方。
- `/advanced` 旧仪表盘移除，访问时直接重定向到 `/advanced/runs` 运行列表。
- 节点和命令的输出脱敏后按行实时写入日志，运行中可以用 `tail -f` 查看，内存占用不再随输出总量增长；单行上限 1MB，超出时分段写入。跨数据块的中文等多字节字符不再乱码。
- `progress.json` 在持续输出时最多每秒更新一次，心跳和结束时照常写入。
- Tekon 进程被强制结束后留下的 agent 等子进程，会在另一个 Tekon 进程回收该任务时结束：核对启动时间一致后先 SIGTERM，5 秒后 SIGKILL，结果写入运行审计 `job.process-group`。进程启动后不到一个心跳就被结束的、以及首进程已退出的进程组不处理，见手册 §7。
- 脱敏：值写在键的下一行时（如 `password:` 换行后的值）也会脱敏；私钥块每行带前缀（`cat -n`、`grep -A`、时间戳）时整块替换。

## 0.29.0 — 2026-11-12

- 新增 `tekon clean [--run-id <id>] [--dry-run] [--yes]`：清理已结束（passed、failed、cancelled）且没有未结束任务的运行留下的 worktree，以及运行租约记录的节点分支 `tekon/<runId>/…`。不带 `--run-id` 时先列出，加 `--yes` 才执行；`--dry-run` 只预览。保留 `tekon-delivery/<runId>` 交付分支、`.tekon/runs/` 下的证据、审计记录和不属于任何运行租约的目录；运行结束时不会自动清理。未结束的运行不能清理，报错且不改动。结果写入运行审计 `run.cleanup`，个别项目没清理掉时退出码为 1，运行状态不变。
- Web `project.clean` 按同样规则清理，确认字面量改为 `'clean-terminal-runs'`，支持 `dryRun`，返回各项数量（以前固定拒绝）。
- 动态工作流预览不再在系统临时目录留下目录。
- 任务认领：CLI 只执行自己发起或恢复的任务，不再自动接手 Web 或其他 CLI 进程排队的任务（包括 Web 的自动交付准备）；Web 不接手 CLI 发起的任务。CLI 受理后退出、还没执行的运行，可以再用 `tekon resume` 或在 Web 上恢复后执行；Web 排队的任务在 CLI 恢复时也一样。升级前排队的任务照常可由 Web 执行。升级后请重启已在运行的 `tekon ui`：旧版本的服务仍会接手 CLI 的任务。
- 租约：进程被挂起（休眠、调试器暂停）超过租约时间再恢复时，先续租自己的任务，并给其他进程一个心跳的时间续租，再回收过期任务，不再把自己仍在执行的任务判为中断。中断事件记录原因、原 owner、租约时间和判定所用的截止时间。限制：同一仓库同时有两个 Tekon 进程时，一个被挂起与它已经退出无法区分，另一个仍会在租约过期后把任务标为中断，可按手册 §7.1 恢复；系统时钟往回调会推迟回收。

## 0.28.0 — 2026-11-11

- 运行前检查：新增 `tekon doctor`，列出配置、每个 Provider 是否安装和认证方式（不显示账号信息）、默认 workflow 的检查命令，只报告不修改。CLI 和 Web 发起、恢复运行前都会检查 Provider：命令不在 PATH 里时直接拒绝，不创建运行；批准人工 Gate 时先检查再记录决定。CLI 在没检测到登录时提示，并写出认证方式和透传的变量名；Web 事件流在运行开始和恢复时列出透传的变量名。
- 失败原因：Provider 失败按原因归类（未安装、未登录或凭据无效、配置无效、非零退出、超时、取消、Tekon 停止时中断、等待审批），`run`、`status` 和 Web 事件流写明原因和下一步，只有非零退出、超时和 Tekon 停止时中断先建议 `tekon resume`。自动修复节点遇到未安装、未登录或配置无效时不再重复尝试，原因同样显示。Claude 退出 0 但结果标记错误时按该错误归类。`run` 的第一行按结果写已完成、已暂停、中断、失败或已取消；`review` 在运行未完成时先说明，并列出各节点状态，没执行到的显示“未执行”。
- 仓库配置：`.tekon/config.yaml` 统一读取，YAML 写错、字段名拼错或值不对时直接报错，不再静默回退。CLI 在未配置 `defaultAgent` 时默认用 `claude-code`（以前是 `codex`；Web 发起的运行暂时不读 `defaultAgent`，仍默认 `codex`）。`init` 写入 PATH 里第一个找到的 Provider（先 `claude` 后 `codex`），已有的 `config.yaml` 不再覆盖。
- Provider 环境：新增 `providers.<provider>.passthroughEnv`，把指定的环境变量名额外传给 Provider；会改变程序加载方式或由 Tekon 控制的变量不能透传。Codex 改为只收到固定的一组变量加透传变量。
- 行为变化：Codex 不再默认带 `--profile internal`，需要时在配置里写 `providers.codex.profile: internal`；升级前启动的运行恢复时仍用 `internal`。`codex.profile` 必须以字母或数字开头。升级后请重启已在运行的 `tekon ui`。退回旧版本后，0.28.0 创建的运行不能恢复，需要重新发起。
- 修复两个评审要求返工同一节点时返工节点 ID 冲突的问题；升级前因此中断的运行可以直接恢复。

## 0.27.1 — 2026-11-11

- 开发命令：`pnpm test --run` 先构建全部包再跑测试，命令行的真实进程测试总用最新产物，不用再另跑 `pnpm --filter @tekon/cli test:e2e`（Web 的 Playwright 测试仍单独运行）；`__manual__` 目录仍不进默认入口。
- 内部清理（不改变运行行为）：Gate 引擎接口只保留执行检查，自动修复节点的创建移到工作流内部；测试共用一份假 Codex，并新增假 Claude 和隔离 PATH 与环境变量的命令行运行助手，供后续测试使用；Web 测试数据可以按需关掉检查、交付和审计数据。

## 0.27.0 — 2026-11-09

- 安全加固：
  - 日志、事件和产物的凭据识别规则补全并分为两档：高精度规则会拒绝写入产物、让安全扫描 Gate 失败；较宽的规则只做脱敏，覆盖带键名的密码、token、Cookie、命令行参数等任意长度的值，尽量不改写函数调用、比较、类型注解和占位符（只影响日志展示）。Web 界面先走同一套规则再做自己的脱敏。
  - `tekon init` 在 git 仓库里把 `.tekon/` 写入 `.git/info/exclude`（已被忽略时不写，写不进去时只警告），不改 `.gitignore`；已初始化的项目可在仓库根目录执行 `echo '.tekon/' >> "$(git rev-parse --git-path info/exclude)"` 补上（重新 `init` 会重写 `config.yaml`）。
  - Web 服务只响应发往 `localhost`、`127.0.0.1`、`::1` 的请求，所有接口都校验来源，通过局域网 IP、反向代理域名或云 IDE 端口转发访问会返回 403（SSH 等转发到本机 localhost 不受影响）；会话令牌校验合并为一份。
  - `tekon ui` 默认直接服务构建好的页面，使用不允许内联脚本的 CSP；Vite 开发模式改为 `TEKON_WEB_DEV=1` 时启用。

## 0.26.4 — 2026-11-09

- 修复开发依赖的已知漏洞：vitest 和 `@vitest/coverage-v8` 升到 4.1.12（随之移除有漏洞的 tinypool、minimatch、brace-expansion），删除已无作用的 brace-expansion override；vitest 与 coverage 插件同钉 4.1.12，coverage 显式列出源文件以保留未测文件。只影响开发和测试，不影响安装后的 `tekon`。
- 适配 Vitest 4：对已是 mock 的方法再 `vi.spyOn` 会返回同一个 mock，`gate-shutdown` 测试改为直接包装底层实现，避免递归。

## 0.26.3 — 2026-11-09

- 升级有已知漏洞的依赖：vite 7.3.7、zod 4.6.7、source-map-js 1.2.2，生产依赖审计恢复为 0 条。
- CI 精简为一个 workflow，`CI OK` 汇总全部任务作为合入检查；Playwright 固定在 `ubuntu-24.04` 运行。
- 依赖审计只在依赖、审计脚本或 workflow 变化时运行，不再拦截无关 PR；新公布的漏洞由 Dependabot 告警提示。
- CI 只测 Node `engines` 下限 `20.19.0`、`22.12.0` 和主版本 24，不再单独测 `22.19.0`（DSH 的宿主下限仍由 DSH preflight 检查）。
- 开发命令：`pnpm lint` 现为 `pnpm -r typecheck` 的别名（内置模板的 lint 门禁使用它），子包不再各自定义 `lint`。

## 0.26.2 — 2026-11-09

- 修复 Claude Code 节点在 macOS Keychain 登录下报未登录：Claude 子进程现在会收到登录用户、代理变量、`NODE_EXTRA_CA_CERTS` 以及 `ANTHROPIC_*`、`CLAUDE_*` 变量。
- 行为变化：以前 key 会被剔除，Claude 总用订阅登录；现在 shell 里有 `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN` 或 `CLAUDE_CODE_OAUTH_TOKEN` 时，Claude 会改用它们，计费方式和账号会随之改变。Claude 在节点里执行的命令（包括免审批的 `npm test`、`npm run build`）也能读到这些变量；Tekon 自己运行的检查命令仍拿不到。处理不信任的仓库时，不要在 shell 里放 key。
- 修复默认 `standard-delivery` 流程中，评审提出修改并返工成功后，run 卡在 PMO 流程检查点的问题。返工节点的产物和检查结果记在原节点上，流程完整性检查不再要求返工节点单独提供证据，返工节点仍须完成。

## 0.26.1 — 2026-09-08

- 产物导入失败保留可诊断的原因，区分缺失 manifest、非法格式/schema 与必需产物缺失；补齐 JSON 序列化提示和历史租约冲突的人工处置说明，保持严格校验与原恢复边界。
- 明确发布问题的影响与阻断条件，在默认入口披露本轮 Codex/DSH 真实验收缺口；补丁不承诺模型永远生成合法产物，也不自动裁决历史租约冲突。

## 0.26.0 — 2026-09-08

- 运行概览合并重复检查列表，失败项优先展示，保留通过计数、建议和全部证据；运行操作回执在通知消失后仍可查看。
- 修复审批备注的可访问名称、异步错误通知语义，以及窄屏门禁诊断的长文本裁切。
- 人工审批使用 pending 状态比较交换，阻止重复或并发审批覆盖已记录决定；Codex/Claude adapter 透传取消信号。
- Claude workflow 为 policy 与 profile 同时允许的有限验证命令生成精确工具授权，保留拒绝/人工审批规则，阻止自定义参数覆盖权限。
- 草稿 AI 澄清显式关闭模型内置与 MCP 工具，移除跳过审批的调用，并修复 Claude JSON 结果解包；失败继续回退静态澄清。
- 阻塞节点重试复用原工作树租约，保留修改并严格拒绝冲突身份；CLI run/resume 在后台任务失败、中断或取消时返回非零及日志指引。
- 合并重复产物类型推导和纯函数测试，修正 macOS 路径别名导致的回归误报。
- PMO 流程检查点直接获得带稳定 gateKey 的 Gate JSON，QA 测试计划明确 method 枚举，减少字段口径错配；保留严格 schema/完整性校验及 QA 的 gateResultId 证据格式。
- 精简角色与仓库指令，明确节点产物协议和 Gate 验证分工；现行文档统一到产品、设计、运行时合同和手册，历史评审保留正式证据索引与 Git 快照。
- 角色工具提示、顶层命令治理与 Provider/宿主隔离分别说明；完整外部副作用隔离不属于本版承诺。验收范围与限制见发布审核记录。

## 0.25.1 — 2026-09-07

- 保留用户手册 12 章与原有小节结构，重写操作说明，纠正草案、Provider 与恢复相关旧用法。
- 重做手册 HTML：浅色排版、章节目录、连续阅读、代码复制与窄屏布局；正文与 Markdown 同步。
- 精简 README，以流程图、操作表和 Web 实际截图介绍上手路径；完整参数与限制转到手册和产品范围。

## 0.25.0 — 2026-09-07

- 修复初始 queued Job 暂停后的恢复竞争：原子复核后复用仍排队的原 Job；已排空时按正常恢复入队，终态和已有活动执行保持不变。
- Run/Session/列表共用暂停与恢复请求反馈，错误保持可见，终态竞争反馈在控件移除后仍可查看。
- 修复 Web 证据链接仅改变地址片段、未打开实际内容的问题：定位产物、门禁日志、审计事件及交付章节，缺失或读取失败时显示原因。
- 修复窄屏检查证据与长链接裁切，以及侧栏显示断点处运行列表撑出页面的问题；列表保留局部横向滚动。
- 新增手册暂停、取消与恢复章节；归并产品范围、运行时与 Web 运行控制合同并提供 HTML，已完成过程计划移出工作树，历史证据链接保留固定快照。
- DSH tested CLI pin 仍为 `0.1.2-alpha.3`；顶层版本不锁定传递依赖树，新版完整树及 L2/L3、持续协作、完整导出继续独立验收。
- 正常关停打断 Gate 时保留已完成 Agent 和对应工作树，显式恢复从 Gate 继续；已完成自动修复的工作树关联支持服务进程重启后恢复，缺失或歧义时明确阻断。关停/取消不再被误判为质量失败而触发自动修复。主动取消仍为 cancelled 终态，不可恢复。

## 0.24.1 — 2026-09-06

- 修复初始 queued Job 被暂停后仍执行的路径：暂停状态下排空初始 Job 而不运行 Agent/Gate，保留原 Run 供显式恢复。

## 0.24.0 — 2026-09-06

- 取消意图已持久化但控制投递或观察更新失败时，允许同 Run 重试，并由有界后台巡检补发；取消生命周期事件与 Session 状态在同库事务内协调。
- 过期的已认领 Job 转为 interrupted，不自动重跑。退出证据按 Job 记录，历史 stopped 或租约过期不冒充进程退出。
- Web 与 CLI 恢复入口要求确认未知退出的旧 Job；CLI 增加 `--confirm-stopped` / `--previous-job-id`，历史无 Job 使用 `none`。审批已记录但恢复被竞争拒绝时，分别报告两个结果。
- 运行详情和 Session 使用一致的持久恢复信息，保留取消重试与错误说明；通知增加常驻 Live Region，手册补齐 3 秒二次取消确认。
- DSH tested pin 保持 `0.1.2-alpha.3`。完整导出、ACP 持续协作与生命周期安全清理仍未开放；测试与真实 Provider 验收结果以本轮正式报告为准。

## v0.23.1

- **当前页保留已确认回执**：已受理或等待目录恢复的请求，不再因账本重读、另一任务提交、迟到查询或原请求重试失败而丢失 Run/Session 观察入口；目录修复后仍可按原 ID 重试恢复。
- **本地失败不等于受理失败**：浏览器记录更新失败时保留服务端确认，查询其他请求不会抹掉当前未知请求的错误；切换仓库作用域后，旧请求不会因新账本读取失败而留在页面。
- **导航失败可恢复**：默认入口等待异步导航结果，失败时保留输入和原会话入口，显示脱敏提示；导航期间后来编辑的内容不会被旧回调清空。

## v0.23.0

- **发起前检查配置**：Web 默认入口和高级表单展示逐项检查的来源、执行或跳过方式以及缺少命令的情况。点击“刷新检查配置”可查看哪些检查变化；刷新后仍需审阅并再次提交。服务重启或切换上下文后不沿用旧比较结果，配置读取失败时提示先修正文件。
- **执行沿用受理时的检查**：新运行保存实际使用的仓库命令、来源、不适用与缺失决定，后续执行、恢复、修复重试和返工沿用这份记录。普通 CLI 在启动请求时捕获配置；修改当前仓库配置不会替换已受理运行的检查。该绑定不冻结脚本正文、PATH 二进制、依赖或宿主环境。
- **历史绑定状态可见**：Run/Session 详情和 CLI `status` 显示检查绑定状态。历史 v1/v2/无快照运行保留兼容路径，不自动升级；其中使用 `commandRef` 的检查仍按当前配置解析。无效或暂不可识别的记录不会显示为已冻结。
- **目录恢复明确已受理**：目录 `pending` 显示“已受理，等待目录就绪”，`recovery_required` 显示“已受理，等待目录恢复”；任务尚未执行。查询失败保留已经确认的受理身份；结果仍未知时继续查询或重试原请求。
- **列表与审批自动追平**：Session 列表在事件流首次连接、重连后读取最新状态；另一入口的审批决定或新增审批会更新详情卡片。读取期间收到新变化时，旧响应不会盖住新状态。事件日志仍可能缺失后续事件，不能用于完整重建所有运行。

## v0.22.0

本轮完善执行计划绑定、请求身份与启动恢复。以下为功能变更说明；验收和 CI 结果以本轮正式报告为准。

### 用户可见改进

- **原请求可重试**：普通 workflow/Goal 启动前打印 Request ID，CLI 增加 `--request-id`。同一提交意图重试返回原 Run/Session/Job；不同意图复用标识返回 `REQUEST_ID_CONFLICT`，需要另建任务时使用新标识。
- **受理与执行状态分开**：目录未就绪时保留运行身份，显示“创建失败需恢复（尚未执行）”；`status` 增加受理状态、文件状态及 requestId。原请求重试，或启动相应 CLI 命令/Web 服务时恢复目录；未就绪 Job 不被认领，恢复不复活取消或终态运行。
- **Web 待确认请求可找回**：默认入口和高级表单共享查询、同意图重试和计划过期处理。当前标签页的 sessionStorage 账本仅存作用域指纹、意图指纹、requestId 和受理状态，不存需求正文或 token；查询暂未找到记录仍保留原请求身份。
- **完整计划绑定**：RunPlan v2 绑定完整模板、执行模式与确认参数，运行恢复校验持久计划和合法派生节点。预览过期时提示刷新并重新确认；公开预览只展示摘要，不返回内联命令配置。
- **连接状态独立呈现**：凭据与 Provider 分别显示，Provider 可显示检查中、可用、不可用或检查失败，并提供检查时间和重试；按服务端过期时间刷新，凭据有效不等于 Provider 可用。
- **仓库别名兼容**：Web 使用仓库物理路径确定作用域，同仓库历史 alias Project/Workspace 和 Session 保持可见；列表及事件订阅兼容这些历史身份，不合并或重写 ID。
- **预览边界明确**：CLI `--dry-run` 仅支持 `--dynamic`；普通 workflow/Goal 的 dry-run 在初始化前拒绝，动态路径仍不开放实际执行。

### 工程与合同

- **原子受理与审计**：Run 领域记录、必需治理 Audit、三个 Session 开场事件、初始 Job 和请求账本在同一 SQLite 事务内提交；目录准备后置并可恢复。常规 Audit 追加也在事务中分配单调时间和链头，避免跨进程追加分叉。后续 Session 事件仍属 best-effort 投影，不扩张为全域 outbox。
- **运行时依赖审计集合修正**：Web 正常启动使用的 `tsx`、`vite`、`@vitejs/plugin-react` 归入 dependencies，让生产依赖审计覆盖实际启动链；保留无有效审计结果即失败的策略。此调整不代表发现了新的具体漏洞。
- **保留长期边界**：DSH tested pin 仍为 `0.1.2-alpha.3`；持续协作、OS 级隔离、完整导出/retention/purge、全域事件事实源及全部执行环境绑定仍属于后续范围。

## v0.21.0

本轮依据第二十二轮复审收口可确定性验证的安全与合同缺口。DeepSeek Harness tested pin 继续保持 `0.1.2-alpha.3`；官方 `0.1.3-alpha.1` 仅作为 ACP/SessionHandle 后续技术输入，不据“最新”直接升 pin。

### 用户可见改进

- **物理清理入口 fail-closed**：Web `project.clean` 与 CLI `tekon clean` 暂停全部物理删除。Web 在认证、确认字面量、runId 格式和仓库 scope 校验后记录 `project.clean.suspended` Audit，再返回 `CLEAN_SUSPENDED`；CLI 固定 exit 1、只写 stderr。run/worktree 目录均保持不变，完整 export/retention/purge 继续由 #18/#33 承担。
- **连接状态不再等待可选 DSH**：`project.health` 只验证 Web Session token；TopBar 在凭据有效后通过独立、受认证且有界缓存/single-flight 的 `project.providerHealth` 异步获取 dsh-headless 可用性。Provider 失败不会把有效凭据误显示为无效，原始进程错误、路径和代理信息不会返回浏览器。
- **计划摘要拒绝静默漂移**：`SessionService` 顶层 `planDigest` 进入 `WorkflowEngine.prepareRun`；input/options/canonical plan 的 digest 在任何目录、数据库或 Audit 副作用前做一致性校验，不一致返回 `PLAN_DIGEST_MISMATCH`。

### 工程与合同

- **Production Audit 分类重试**：CI 改由可测试脚本解析 pnpm 10.12.1 JSON；只有有效零漏洞结果成功。已确认 Advisory、零退出但空/坏 JSON和未知错误立即失败，只有无有效结果的 timeout/DNS/reset/HTTP 5xx 可重试一次。
- **Node floor 精确验证**：兼容矩阵从 minor 浮动值改为精确 `20.19.0`、`22.12.0`、`22.19.0`，Node 24 保持 `24.x` 最新补丁，并在 setup 后断言实际解析版本。根 `engines` 范围本轮不变；Node 23/25/26/future major 不因开放上界被表述为已验证。
- **正式文档恢复双格式**：第二十二轮报告与本轮执行方案均提供同步 Markdown/HTML，人审版本不再以减少镜像为由违反仓库交付规则。

## 历史更新记录

[0.20.6 及更早版本的完整记录](https://github.com/zesming/tekon/blob/86a3d48fcf54ea663b1ce3bdf86595187a425d1e/CHANGELOG.md#v0206)保留在固定 Git 快照中，包括当时的验证范围、失败记录及复审批注。旧的 Unreleased 和多轮评审过程不再混入当前发布清单。

现行能力、限制与技术决策以[文档索引](docs/README.md)为准；历次正式验收见[证据索引](docs/reviews/current.md)。历史结论不代表本次版本已经验收。
