# 变更日志

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

## v0.20.6

本轮收口第二十轮复审确认的 DSH metadata probe fallback 风险与默认 Session 启动恢复缺口。Tekon 的 DSH tested pin 仍为 `0.1.2-alpha.3`；官方 `0.1.2-rc.1` 只完成无凭据 Wrapped L2，不据此升级生产 pin。

### 用户可见改进

- **默认 Session 缺摘要可原地恢复**：执行计划返回但缺少 `digest` 时，界面继续 fail-closed 阻止提交，同时提供“重试”按钮重新请求计划；摘要恢复后提交按钮重新可用。
- **默认 Session 失败后可重试证据**：新增真实 Chromium 场景，验证首次 `project.run` 返回错误后同步 latch 被释放，第二次提交只再发起一次请求并成功进入 Session 详情页。
- **窄屏 Advanced Run 动态态可读**：高级设置展开后改用自适应网格，超时输入与脏工作区选项不再挤入三列；dsh 闭合选项缩短为 `dsh-headless（仅 Goal）`，实验性、仅 Goal 与网络风险仍由相邻说明展示。

### 工程与合同

- **DSH metadata probe 使用隔离临时 workspace**：只要版本、Config 或 Help 中任一 probe 使用内置实现，就创建一次临时 root，并统一设置 `cwd=root`、`DSH_HOME=root/dsh-home`、`DSH_AGENTS_HOME=root/agents-home`。这会切断 DSH rc.1 已确认的 invocation cwd `.env`、DSH home `.env` 与 `.credentials.yaml` 自动 fallback；它不是 OS sandbox，不能阻止同 UID 恶意二进制主动读取宿主文件。
- **混合 probe 与命令路径合同**：default probe 使用隔离 cwd、最小环境和切换 cwd 前解析的相对命令；custom probe 保持接收调用方原始命令；三项全为 custom 时不创建 workspace。Config 校验完成后才执行 Help，继续避免同一临时 DSH home 的 first-use 并发写。
- **环境与清理闭环**：宿主 `DSH_HOME`/`DSH_AGENTS_HOME` 不再透传，补充 `SystemDrive`、`windir`、`WINDIR` 防御性兼容值；成功、合同失败与命令缺失均在 `finally` 清理。清理失败只经安全 warning sink 报告，不覆盖主结果或主异常；版本阶段的原生 `ENOENT` 和后续阶段的 `DshCapabilityError` 语义保持不变。
- **官方 rc.1 Wrapped L2**：在 Node 22.19.0 上通过 Tekon 生产构建和 delegating recorder 调用 npm `@deepseek-ai/dsh@0.1.2-rc.1`（integrity `sha512-RPq48TzxvwpdT9/7W1tbhZDBMmeK+bxDrX9cqQC27Wx/LqtgJF8PSa3b3xriU8oxtvhwYmk21w2cej3uMQrnVA==`）。Version/Config/Help 分别为 51ms/69ms/556ms，5 项插件行与 Help 锚点通过，版本事实保持 incompatible + explicitly bypassed，敏感哨兵未进入实际命令，临时 root 完成后已删除。L3 真实模型调用仍未开展。
- **测试规范**：Web e2e 文件改为 `session-composer-admission.e2e.test.ts`；Core 增加真实 caller cwd、ambient DSH home、混合 probe、相对命令、分阶段 `ENOENT`、Windows 变量和清理双故障覆盖。
- **响应式运行入口回归**：新增常驻 `responsive-run-surfaces.e2e.test.ts`，四档 Chromium 视口均检查 SessionComposer 与 StartRunForm 默认正常态的页面横溢、控件越界/重叠和文本横向裁切；320px/390px 另覆盖缺摘要重试、dsh 联网警告和高级设置展开态。矩阵 4/4 通过，Web Chromium 全量 48 项。

## v0.20.5

本轮落地第十九轮复审（`docs/reviews/2026-09-03-tekon-product-runtime-harness-nineteenth-review.md`，PR #11）锁定的整改事项：收口 Advanced Run 准入与并发防重入、DSH metadata preflight 内置 session telemetry 硬关断，并补齐执行方案/文档。架构级项（single-owner Runtime、权威 Session、ACP、RunPlan schema、完整生命周期治理与 `project.clean`）按复审裁决维持冻结，由独立 issue/PR 承载。

### 用户可见改进

- **Advanced Run 使用单一阻断源**：提交按钮与 handler 共享 `startRunSubmitState`，一致阻断 token 缺失、计划未就绪、空需求、草案未批准、计划摘要缺失和网络未确认等状态；生成过计划的需求草案现在必须完成独立计划审批后才能提交。
- **同一页面重复提交防护**：同步 `useRef` latch 关闭 React pending 状态生效前的重入窗口，并在请求失败后释放以允许重试。该保护只覆盖当前组件实例，不替代服务端幂等或跨端 Run admission。
- **Advanced Run 窄屏可读性**：在 768px 及以下把模式、模板、Provider 与 Profile 选择器改为单列，缩短闭合选择器中的 dsh/mock/autonomous 标签；联网不受限、合成结果和“不自动创建 PR”等完整边界继续由紧邻帮助与告警说明。
- **提示保持诚实**：Advanced Run 延续“计划未请求不受限网络”的准确表述，mock Provider 明确为合成测试/演示，不能作为真实交付证据。

### 工程与合同

- **DSH 内置 session telemetry 硬关断**：正式 Run 在 `7acfbae` 新增 `DSH_TELEMETRY_DISABLED=1`（`envMode: exact` 白名单）；metadata preflight 本轮同样实施 hard opt-out，三个 metadata probe（`--version`、`--dump-default-config`、`--profile headless --help`）保留 `PATH`、`DSH_HOME` 等必要环境，删除宿主环境（ambient）中的 `DSH_TELEMETRY_MODE` 与 `DSH_TELEMETRY_OTLP_URL`，并固定设置 `DSH_TELEMETRY_DISABLED=1`。DSH 对任意非空 `DSH_TELEMETRY_DISABLED` 均视为关闭，`1` 是 Tekon 的规范化表达。事实澄清：在 alpha.3 中，`--version` 与 `--dump-default-config` 为 boot-free，但 `--profile headless --help` 会进入 profile/plugin boot；无证据表明此前发生外传，但不能用不 boot 排除风险。此外，preflight 仍继承其他宿主环境变量，不等于凭证隔离（例如 worktree `.env` 读取仍是独立安全风险）。
- **回归证据补齐**：新增 probe 环境真子进程测试、Advanced Run 阻断状态单测和合规命名的 Playwright e2e，覆盖同一页面单次提交、失败后重试及 `hasPlan => planApproved`。第十九轮执行方案同步提供 Markdown/HTML 审阅版。

## v0.20.4

本轮落地第十二轮复审（`docs/reviews/2026-08-31-tekon-product-runtime-harness-twelfth-review.md`，PR #11）第 17.2 节批注锁定的四项低风险收敛：DSH tested pin 升级、版本身份统一、fixture npm warning 清理、CI 供应链 gate。架构级项按复审裁决维持冻结，登记为后续顺序。

### 工程与合同

- **DSH tested pin 升级**：`dsh` 钉死版本由 `0.1.2-alpha.2` 升级到 `0.1.2-alpha.3（tested pin）`。Tekon 依赖的 alpha.3 headless 兼容锚点相对 alpha.2 未变（help anchor、required config row ids、Node engines、reasoning streaming、exit code 语义均未变），升级风险低。alpha.3 移除了 SQLite 持久化后端（确立 JSONL 为唯一 provider），与 Tekon 绑定的 `session-persistence-jsonl` 方向一致。注意：本机无 `dsh` 二进制与 API key，本轮只更新了契约 fixture 与版本号；带真实 provider 的 smoke 仍需在装有 `dsh` 的环境执行。
- **版本身份统一（P1-RELEASE-01）**：`@tekon/core`、`@tekon/cli`、`@tekon/web` 三个内部 package 的版本由 `0.7.0` 统一为 `0.20.4`，与根产品版本 lockstep。此前 `TEKON_CORE_VERSION`（读内部 package）与 CLI `getVersion()`（读根 package）输出不一致，按推断会干扰 bug report 与日志中的版本识别（当前无生产代码消费该常量，属预防性统一）。补了 smoke 测试断言所有内部 package 与根版本一致，防止再次漂移。
- **fixture npm warning 清理（P2-CI-03）**：6 个 CLI 测试文件的 `createFixtureRepo` 不再 spawn `npm init`/`npm pkg set` 子进程，改用 `writeFileSync` 直接写 `package.json`。消除了 fixture 子进程继承 pnpm 注入的 `npm_config_*` 导致的 npm unknown-config 弃用警告，同时省去每次测试 4 次子进程派生开销。`run-mode-policy.test.ts` 保留了 `scripts.test`（`npm init -y` 隐式生成），避免 `detectRepoProfile` 静默漂移。
- **CI 供应链 gate（P2-DEPS-01）**：`.github/workflows/ci.yml` 新增独立 `audit` job 执行 `pnpm audit --prod`。当前生产依赖树 0 漏洞，不阻断；未来新增不安全生产依赖时 CI 自动拦截。边界：`--prod` 只覆盖 50 个生产依赖包，不覆盖构建链（vite/tsx/esbuild 等 232 个 dev 包）；audit 与功能测试解耦（`cli`/`web` 只 `needs: typecheck`），audit 失败不压掉功能诊断，但 audit 本身仍是独立 gate。

### DSH Host Node 版本硬拦截（第十四轮批注）

- **preflight 硬拦截不兼容宿主 Node**：`runDshPreflight` 在探测 dsh 二进制之前新增宿主 Node 版本检查（`isHostNodeVersionCompatible`），不兼容时（Node 20.x、22.12–22.18、23.x 奇数线）抛 `DshHostNodeError`，不再让用户先撞上 dsh 子进程的底层退出错误。提供 `TEKON_DSH_ALLOW_HOST_NODE=<实际版本>` 精确值逃生口（对齐 `TEKON_DSH_ALLOW_VERSION` 先例），放行时输出 `onWarn` 警告。`DshPreflightResult` 增加 `hostNodeVersion`/`hostNodeCompatible`/`hostNodeBypassed` 结构化字段；CLI `provider preflight` 输出与 `--json` 同步展示宿主 Node 状态，`failureKind` 判别字段区分"宿主 Node 不兼容"与"dsh 未安装"。Web `probeProvider` health 判定同步纳入宿主 Node 检查。

### DSH preflight 语义修正与 Web health 同源（第十五轮批注）

- **Host Node 判定改为稳定 semver**：`isHostNodeVersionCompatible` 只接受完整 `v?major.minor.patch`，prerelease/partial/malformed 一律 fail-closed，数值必须是 safe integer；不再只截取 major/minor 导致 prerelease 被误判为兼容。
- **compatible 与 bypass 分离**：`DshPreflightResult` 增加 `versionCompatible/versionBypassed`，与 `hostNodeCompatible/hostNodeBypassed` 并列；逃生口命中时 compatible 保持 false，bypassed 为 true。CLI 文本在任意 bypass 存在时显示"已旁路（无合同保证）"而非"兼容"。
- **移除公开 `--host-node-version`**：该参数是测试注入 seam，可伪造当前机器兼容结果；公共 CLI 不再接受，程序化 API 仍保留。
- **Web health 与真实 admission 同源**：`probeProvider()` 改为调用完整 `runDshPreflight()`（含 tested pin、help anchor、plugin config），有 1 秒 metadata probe 预算；顶栏不可用提示指向 `tekon provider preflight dsh-headless` 诊断动作。
- **网络隔离文案修正**：SessionComposer 网络隔离说明从"网络访问受限"改为"计划未请求不受限网络；实际隔离取决于 Provider 与宿主环境"，避免过度承诺。

### 测试与 CI 收尾（第十三轮批注）

- **smoke 版本断言健壮性**：`packages/core/__tests__/smoke.test.ts` 的 lockstep 断言改为扫描 `packages/` 目录（不再硬编码包名），并用 `existsSync(<pkg>/package.json)` 过滤，避免 `.DS_Store`、残留目录或断链 symlink 触发 `MODULE_NOT_FOUND`。
- **CI audit 拆独立 job**：`pnpm audit --prod` 从 `typecheck` job 拆为独立 `audit` job（`--ignore-scripts` + `timeout-minutes: 5`），`cli`/`web` 只 `needs: typecheck`。audit 与功能测试解耦，audit 失败不压掉功能诊断。
- **dirty-base 测试回归修复**：`run-cli.test.ts` 的 `--allow-dirty-base` 测试改为 `JSON.parse` → 改字段 → `JSON.stringify`，与 fixture 的 `JSON.stringify` 输出格式解耦，不再依赖文本 replace 匹配。

## v0.20.3

本轮落地第十一轮复审（`docs/reviews/2026-08-31-tekon-product-runtime-harness-eleventh-review.md`，PR #11）第 16.3 节批注锁定的三项过程/卫生收敛：CLI e2e 文件命名与 lane 语义对齐、CI npm env warning 清理、devDependencies 漏洞 override。架构级项（single-owner Runtime、权威 Session、ACP vertical slice、RunPlan authority、模型 compaction、全站 a11y）按复审裁决维持冻结，登记为后续顺序。

### 工程与合同

- **CLI e2e lane 对齐**：`packages/cli/__tests__/e2e/` 下三个文件由 `*.test.ts` 重命名为 `*.e2e.test.ts`，`test:e2e` 选择器从 `__tests__/e2e` 改为 `.e2e.test`，与 `packages/core` 约定一致。此前这三个真实子进程 e2e 用例因文件名不匹配 `--exclude "**/*.e2e.test.ts"`，同时进入 unit lane 与 e2e lane 各跑一遍；现在 unit lane 只跑 9 个 unit 文件，e2e lane 跑 3 个 e2e 文件，恢复「快速 unit gate / 慢速 e2e gate」分层。
- **CI npm env warning 清理**：`.github/workflows/ci.yml` 中 17 处 `npm exec --yes -- pnpm@10.12.1` 替换为 `corepack pnpm`，由根 `package.json` 的 `packageManager: "pnpm@10.12.1"` 解析版本，消除 npm 对 `npm_config_*` 未知 env config 的弃用警告。注意：`scripts/install.sh`、`scripts/update.sh`、root `smoke:claude-provider` 与 `.github/workflows/core.yml` 仍用 `npm exec`，会继续发同类告警，留待独立 PR（改 installer 需按 AGENTS.md 跑干净环境 smoketest）。
- **devDependencies 漏洞 override**：根 `package.json` 新增 `pnpm.overrides`，锁定 `brace-expansion`（按 `^2.0.0`/`^5.0.0` 声明范围分桶到 `2.1.4`/`5.0.9`）、`postcss`（`8.5.26`）、`nanoid`（`3.3.18`）。`pnpm audit` 的 High/Moderate 由 10 项降为 0，仅剩 2 项 esbuild Low（vite 要求 `^0.27.0`，修补版 `0.28.1` 越界，强升会击穿 vite 构建，故保留）。全部命中项均为 dev-only，`pnpm audit --prod` 始终为 0。override 只锁当前依赖树存在的 2.x/5.x brace-expansion；若将来引入 3.x/4.x 主版本，需重新评估并加桶（advisory `>=3.0.0 <5.0.7` 当前无暴露面）。

## v0.20.2

本轮落地第十轮复审第 17 节批注锁定的四项收敛：DSH tested pin 升级到 alpha.2、CI e2e 脚本修复、react-router 安全升级、HTML 标签修复。架构级项（8 项 P0/P1）按复审裁决维持冻结，登记为后续顺序。

### 用户可见改进

- **DSH tested pin 升级**：`dsh` 钉死版本由 `0.1.2-alpha.1` 升级到 `0.1.2-alpha.2（tested pin）`。alpha.2 与 alpha.1 的 headless 合同零差异（help/config/Node engines 均未变），升级合同风险极低。注意：本机无 `dsh` 二进制与 API key，本轮只更新了契约 fixture 与版本号；带真实 provider 的 smoke 仍需在装有 `dsh` 的环境执行。

### 工程与合同

- **CI e2e 脚本修复**：`packages/core` 的 `test:e2e` 从硬编码 7 个文件改为 `.e2e.test` 子串匹配，补全了被遗漏的 `engine-rework.e2e.test.ts`，且不会误纳 `session-job-e2e.test.ts` 命名反例。
- **react-router 安全升级**：`^7.17.0` 升级到 `^7.18.2`，修复 2 个 high（CSRF 绕过、未认证 DoS）+ 3 个 moderate 漏洞。本仓库为 Vite SPA 模式，实际暴露面有限，升级主要为消除 audit 告警与依赖卫生。
- **HTML 标签修复**：`follow-up-review.html` 的未闭合 `<code>` 标签修复，消除了该文件的 HTML parse error。`format:check` 全仓仍有既有 250 文件格式待办，不在本轮范围。

## v0.20.1

本轮落地第十轮复审（`docs/reviews/2026-08-31-tekon-human-first-harness-tenth-review.md`，PR #11）第 16 节批注锁定的三项收敛：workspace summary SSE 背压上限、DSH Node 前置条件说明、统一 fake-dsh fixture 并移除 bare-line 测试 seam。架构级项（single-owner daemon、executor 隔离、权威 Session log、ACP vertical slice、Collaborate→Deliver、RunPlan 全字段绑定、模型 compaction、完整历史导出、全站 a11y 专项）按复审裁决维持冻结，登记为后续顺序。

### 用户可见改进

- **workspace 概览推送不再被慢客户端拖垮**：workspace summary SSE 在慢客户端背压期间对未发送帧设置数量与字节双维度上限（100 帧 / 256KB），超限即关闭连接，客户端重连后通过追赶轮询拿到最新快照。
- **DSH 的 Node 版本要求被显式告知**：`tekon provider preflight dsh-headless` 的安装指引（文本与 `--json`）现在明确写出 DSH 要求 Node `^22.19.0 || >=24.0.0`，与 Tekon 主合同的 Node `^20.19.0 || >=22.12.0` 不同；用户手册 §5.7 同步补充该边界。Node 20 用户不会再被送进一个装不上或跑不起来的安装。

### 工程与合同

- **测试 fixture 诚实度**：CLI 层 fake-dsh 生成逻辑统一为单一 helper（`VALID_DSH_CONFIG` 由 `REQUIRED_DSH_PLUGIN_IDS` 生成），单测与 e2e 不再各持一份手写副本；adapter 测试的 probe config 从裸行 id 改为标准 YAML `id:` 行；生产 parser 移除 `bareProbeId` 兼容分支，合同校验只接受完整 `id:` YAML 行，消除 seam 掩盖回归的可能。

## v0.20.0

本轮落地第九轮复审（`docs/reviews/2026-08-30-tekon-human-first-harness-ninth-review.md`，PR #11）第 16 节批注锁定的四项收敛：DSH 版本 pin 升级、真正的历史反向分页、慢客户端背压上限与历史截断用户提示。架构级项（single-owner daemon、executor 隔离、权威 Session log、ACP vertical slice、Collaborate→Deliver、RunPlan 全字段绑定）按复审裁决维持冻结，登记为后续顺序。

### 用户可见改进

- **“加载更早历史”真正向前推进**：历史分页改为真正的反向游标（`beforeSeq`），连续大量技术事件不再让“加载更早”按钮点了却没有更早内容，也不会误报“已加载最早历史”；每次点击都向更早的记录推进，直到真正到达起点。
- **历史截断有明确提示**：当网络恢复或客户端较慢导致在线回放的历史量超过预算时，会话顶部出现一条可关闭的非阻断提示，说明已切换到最近记录、完整历史仍可按页读取，不再静默截断。
- **慢客户端不再拖垮服务端内存**：服务端在慢客户端背压期间对未发送事件设置数量与字节双维度上限，超限即截断到尾窗并让客户端重连，而不是无界缓冲。

### 工程与合同

- **DSH 测试基准版本升级**：`dsh` 钉死版本由 `0.1.1-rc.2` 升级到 `0.1.2-alpha.1（tested pin）`，help/config 契约 fixture 同步更新。注意：本机无 `dsh` 二进制与 API key，本轮只更新了契约 fixture 与 L1 解析测试；带真实 provider 的 smoke 仍需在装有 `dsh` 的环境执行，未在本轮声称完成兼容验证。

## v0.19.0

本轮落地第八轮复审（`docs/reviews/2026-08-30-tekon-human-first-harness-eighth-review.md`，PR #11）第 18 节维护者批注后的整改，聚焦 canonical RunPlan、DSH 预检前移、长会话有界化、连接健康诚实化、数据引用完整性与弹窗可访问性；架构级项（single-owner daemon、Session 事实源选型、Collaborate 主链路、DSH pin 升级）按复审裁决维持冻结。

### 用户可见改进

- **执行计划成为真实合同**：Web 发起 workflow 运行必须回传服务端计划 digest，缺失或被篡改即拒绝启动；digest 绑定完整执行参数（代理、Profile、超时、工作区、模板等），计划预览与实际执行同源；运行持久化 canonical 计划快照，可审计。
- **DSH 环境预检前移**：使用 `dsh-headless` 时，版本/help/config 合同校验在任何运行记录产生之前执行，不兼容时立即给出可读错误与安装指引；新增 `tekon provider preflight dsh-headless` 命令，可主动自检环境兼容性。
- **长会话全链路有界**：事件分页有最大上限；断线重连追赶有事件数与字节预算，超限降级为尾窗并通知；服务端按慢客户端背压推流；"加载更早"在整段历史都是技术事件时不再误报没有更早内容；客户端历史窗口加载后立即裁剪。
- **连接状态更诚实**：顶栏健康状态的缓存不再保存原始令牌，容量与过期有界；Provider 可用性字段明确为 `dsh-headless` 探测结果，不再泛化表述。
- **配置弹窗可键盘操作**：角色/工作流详情弹窗支持 Esc 关闭、Tab 焦点循环、关闭后焦点回到触发按钮，背景对辅助技术 inert。
- **停机更安全**：服务关闭超时后，迟到的数据库写入会被快速拒绝，不再静默写入已关闭句柄。

## v0.18.0

本轮落地第七轮复审（`docs/reviews/2026-08-30-tekon-human-first-harness-seventh-review.md`，PR #11）批注中可独立验证的 8 项整改，均为用户可见或行为级改进；架构基线项（single-owner runtime、权威 Session log、Collaborate vertical slice、外键迁移、全站可访问性专项）维持复审裁决，留给后续架构 PR。

### 用户可见改进

- **内置模板可选**：高级“新建运行”表单与 CLI `workflow list` 现在展示同一组模板（6 个内置 + 项目模板）；下拉选项标识与后端加载标识统一为文件名，项目模板 `id` 与文件名不一致时不再出现“看得到、选不了”。
- **高级入口计划失败即阻断**：高级表单在执行计划加载失败时显示明确错误并禁用提交，与默认入口统一为 fail-closed；计划附带 digest，启动时回传校验，预览与实际执行之间模板被改动或参数被篡改时拒绝启动。
- **连接状态反映真实握手**：顶栏连接状态不再只凭本地令牌非空显示“已设置”，改为服务端握手校验结果（未配置 / 有效 / 无效），Provider 可用性仅作附加提示，不覆盖凭据结论。
- **长会话不再无界增长**：事件流初次连接只回放最近窗口，更早历史按需分段加载；服务端分页与客户端内存窗口共同约束网络与内存占用；断线重连仍从上次位置连续补齐，不丢事件。
- **DSH 能力预检**：使用 dsh provider 启动前，除版本外还校验 headless help 合同与默认配置插件组合，任一不满足即 fail-closed，不再带着残缺能力进入执行。
- **停机语义明确**：服务关闭有 hard deadline，不会被不合作的执行器永久挂住；被中断的运行持久标记为 `interrupted`（可恢复语义），不再静默归入 `cancelled`；用户主动取消仍为 `cancelled`，所有权丢失仍站下不写。
- **用户手册 Node 版本一致**：手册与 package/installer/README 统一为 `^20.19.0` 或 `>=22.12.0`，不再宣称 Node 18 可用；新增一致性检查防止再次漂移。
- **E2E 控件文案单点维护**：跨页面复用的稳定控件文案集中到 locator helper，文案变更不再击穿整套浏览器测试。

## v0.17.0

本轮聚焦“面向人类可用”的主路径闭环与安全停机，均为用户可见的行为改进（评审过程与递延决策记录见 `docs/reviews/` 与 `docs/technical/adr-0001-runtime-authority-and-collaborate.md`，不再写入变更日志）。

### 用户可见改进

- **执行计划预览**：在“新建运行”表单中，发起前可预览本次运行的角色链路、阶段、需人工审批的 Gate、超时（人类可读）与预期节点，工程参数收进高级折叠区。
- **联网不受限知情确认**：当所选 agent（当前为 `dsh-headless`）会带来不受限网络出口时，预览显式告警并要求勾选知情确认；未确认时无法提交，确认事实写入运行审计，不再由隐藏布尔值绕过。
- **失败任务处理语义**：受控交付列表中的失败会话可“确认/归档”，确认后下沉到历史区、不再占据待处理置顶位；未确认（含历史遗留数据）仍保持置顶提醒。
- **连接状态呈现**：顶栏 Token 输入框重构为“已连接/未连接”连接状态徽标与连接管理面板（查看/重填并应用令牌、断开连接），主路径术语统一为产品化中文。
- **任务列表实时刷新**：受控交付列表订阅工作区级事件流，任一会话状态变化可自动上屏，保留短轮询兜底。
- **长会话渲染边界**：会话事件流默认渲染最近若干条并可“展开更早”，超长单条内容限高按需展开，长会话不再无界撑爆页面。
- **安全停机序列**：运行器停止改为确定性终止序列（draining → 有界等待正常完成 → 对在途任务 abort + 强制结束 → 确定性 drain 后再关闭数据库），消除停机后仍可能发生的延迟写入。


## v0.16.0

第十五轮**人类可用性与 Harness 架构全面复审**（`docs/reviews/2026-08-28-tekon-human-first-harness-architecture-review.md`，PR #11）。本轮以“面向人类可用”为基准对产品主路径、CLI/Web 入口与运行时架构进行系统性审查，完成人类入口体验优化（FIX-01/02/03）与会话列表行动投影（FIX-04/P1-04），并确立多项架构 ADR 与分阶段推进策略。产品版本统一提升至 `0.16.0`。

### 人类入口与体验改进（FIX-01 ~ FIX-04）

- **FIX-01 无参数成为人类入口**：`tekon` 无参数执行不再视为错误（退出码 1→0），与 `tekon help` 对齐，首屏清晰提供 Web 界面、直接运行和命令帮助三条推荐路径。
- **FIX-02 帮助页推荐开始方式前置**：帮助页重构为“推荐开始方式”优先（`tekon ui` / `tekon run "你的需求"` / `tekon help <cmd>`），避免新用户被二十余个底层框架命令淹没。
- **FIX-03 统一 CLI 与 updater 产品版本**：CLI 改为直接读取根 `package.json` 的 `0.16.0`，消除此前 CLI 显示内部包版本 `0.7.0` 与 updater 读取根版本 `0.15.x` 的双重身份漂移。
- **FIX-04 / P1-04 Session 列表按最近活动排序并补齐行动投影**：
  - `packages/core/src/session/session-store.ts`：`listSessions` 改用 `LEFT JOIN session_events`，通过 `coalesce(max(e.timestamp), s.created_at)` 派生 `lastActivityAt`，按 `last_activity_at desc, s.rowid desc` 稳定排序；产生新事件的旧会话自动置顶。
  - `packages/web/src/shared/rpc-contract.ts`：`apiSessionSchema` 扩充 `lastActivityAt`、`needsAction`（布尔）与 `actionKind`（`approval` | `input` | `failed` | `null`）。
  - `packages/web/src/server/api/routers/session.ts`：在 `session.list` 与 `session.get` 集中派生待处理行动状态（`awaiting-approval`→`approval`、`awaiting-input`→`input`、`failed`→`failed`），不触碰 core 冻结的 `sessionSchema`。
  - `packages/web/src/client/pages/SessionsPage.tsx`：展示中文相对活动时间（如“12分钟前”/“2小时前”），并在需人类介入时显示“待审批 / 待输入 / 需处理”高亮徽标。

### 架构复审与视角批注（§13 second-perspective annotation）

- **P0-01 措辞订正**：原报告称“产品合同不成立”偏强。对外承诺的“受控交付（standard-delivery）”合同完整成立并有测试真锁；缺失的是尚未宣称的轻量持续协作（Collaborate）能力。界面已在 `SessionComposer.tsx:11-15, 74` 诚实披露；verdict 为 real，归入 §9 阶段 B/C 推进。
- **P0-02 ~ P0-04 架构 ADR 递延（阶段 A/C）**：Web/CLI 事实 multi-owner（P0-02）、非 quiescent shutdown（P0-03）与 dual-write projection-only 事实源角色（P0-04）全部确认属实；单 owner daemon vs multi-owner generation fencing 留待用户拍板后独立 PR 执行。
- **P1-01 / P1-03 / P1-05 / P1-06 / P1-07 演进递延（阶段 B/C/D）**：DSH bridge SDK/ACP 重新对齐（P1-01）、默认交付前 run plan 预览（P1-03）、Token 输入框重构为连接管理（P1-05）、长会话分页/虚拟化（P1-06）以及中英文案词汇表统一（P1-07）均已诚实归入后续阶段。
- **P1-08 流程治理采纳**：明确区分 Merge gate 与 Product acceptance gate，避免以 CI 全绿掩盖产品级未决项。

### 第二轮复审收敛与轻量补强（Follow-up Review & Polish）

第二轮**人类可用性与 Harness 架构全面复审**（`docs/reviews/2026-08-28-tekon-human-first-harness-follow-up-review.md`，提交 `6da5ee1`）。复审确认新增改动总体方向正确，可进入代码审阅；本轮完成复审批注追加、首轮虚构引用修正与两项低风险轻量改进，版本保持 `0.16.0`（不 bump）：

- **CODE-01 / CODE-02 / CODE-03 核验通过**：
  - `CODE-01`：服务端实现 `attentionRank` 排序（`needsAction`→`active`→`idle`→`terminal`），同组按 `lastActivityAt` 降序；
  - `CODE-02`：统一 `session.list` 与 `session.get` 的 `lastActivityAt` 契约（取 `createdAt`/`updatedAt`/最新事件最大值），消除双重语义；
  - `CODE-03`：API 测试移除 20ms sleep，改用固定 ISO 时间戳确定性断言。
- **CITATION 首轮虚构引用修正**：确认首轮报告 §13.2 P1-02 引用的 `goal-job-executor.ts` 不存在，已修正为 `workflows/goal.yaml:1-16` + `workflow-job-executor.ts:165-166`（case 'goal-run'）+ `engine.ts:71`。
- **P1-PERF-01 Session 列表去全聚合优化**：`packages/core/src/session/session-store.ts` 中 `listSessions` 改为相关子查询 `(select e.timestamp from session_events e where e.session_id = s.id order by e.seq desc limit 1)` 取尾，依据同一事务中 `seq` 与 `timestamp` 同序分配保证最新事件匹配，消除历史事件全量重聚合开销。
- **P1-UX-02 相对时间共享 ticker**：`packages/web/src/client/hooks/use-ticker.ts` 引入页面级 `useTicker(60_000)` 共享定时器驱动 SessionsPage 相对时间自动推进；诚实说明因 web vitest 为 node 环境（无 jsdom）故遵循既有惯例不加 renderHook 单测，`formatRelativeTime` 纯函数保持不变。
- **P0-ARCH-01~03 / P1-UX-01/03/04/05 架构 ADR 递延**：确认 multi-owner、shutdown quiescence、Session Event 事实源角色及 UI/UX 演进归入 follow-up 报告 §11 阶段 A-D。

### 第三轮复审收敛（Third Review）

第三轮**人类可用性与 Harness 架构全面复审**（`docs/reviews/2026-08-28-tekon-human-first-harness-third-review.md`，提交 `ae09034` + `f657252`）。作者在 `ae09034` 自行收敛了相对时间实现（`useTicker` 返回共享时间戳、抽出 `relative-time.ts` 纯函数显式注入时钟、补确定性边界测试、`<time datetime>` 语义化），经核验无回归。本轮实施方处置：

- **P1-CODE-01 `session.get` 尾事件轻量读取**：`packages/core/src/session/session-store.ts` 新增 `getLatestEventTimestamp()`（`select timestamp ... order by seq desc limit 1`，复用 `(session_id, seq)` 索引，与 `listSessions` 尾事件子查询同语义）；`packages/web/src/server/api/routers/session.ts` get handler 从 `latestSeq` + `listEventsSince(latestSeq-1)` 两步收敛为单步，消除一次 DB 往返与完整事件 payload（含 `JSON.parse`）反序列化；`lastActivityAt` 组合语义不变。报告 §8.2 原以“影响多处测试/fixture”递延，经核验全仓无手写 `SessionEventStore` double（均走真实 SQLite），故本轮闭环。
- **P1-UX-02（failed 永久置顶）ADR 递延**：移除 `failed` 的 needsAction 会丢失失败警示徽标（功能倒退）；真实闭环需 frozen `sessionSchema` 取舍 + migration + mutation + UI，归入第三轮报告 §12 阶段 D。
- **P0-ARCH-01~03 / P0-PRODUCT-01 / P1-UX-01/03/04/05 / P1-CODE-02 / P1-ARCH-04 / P1-PRODUCT-02**：自第二轮以来无新代码事实，递延结论与第 4~14 轮一致。
- **P2-PROCESS-01 采纳**：第三轮报告作为 PR #11 当前权威裁决入口，后续只维护一份 current decision record 与简短 revision log。

### 第四轮复审收敛（Fourth Review）

第四轮**人类可用性与 Harness 架构全面复审**（`docs/reviews/2026-08-29-tekon-human-first-harness-fourth-review.md`，提交 `3b26d88` + `bec0bed`）。作者在 `3b26d88` 统一了 Goal 与 dsh-headless 入口契约（Core `run-mode-policy.ts` 纯函数策略、CLI 副作用前 fail-fast、Web API 包装层鉴权后校验、StartRunForm 显式 Workflow/Goal 切换 + 三层测试），经核验无回归。本轮实施方处置：

- **P2-TEST-01 Goal/dsh UI 浏览器断言**：新增 `packages/web/__tests__/e2e/start-run-form.test.ts`（~60 行），覆盖 dsh-headless→goal 自动切换、workflow 回退 codex、goal 禁用 template/profile 三组纯前端状态联动，不启动真实 run。
- **P1-DATA-01 注释勘误**：`getLatestEventTimestamp` 接口注释从"Session 不存在返回 null"修正为"无匹配事件行返回 null"（DB 无 FK，孤儿事件可存在）；整体 FK 迁移 + 孤儿策略归入第四轮报告 §11-D。
- **P1-SEC-01（dsh 网络不受限未显式确认）ADR 递延**：纯 Web checkbox 无服务端执行是剧场；真实修复需完整契约（RPC+Core+CLI+snapshot），归入阶段 B/C。
- **P0-ARCH-01~03 / P0-PRODUCT-01 / P1-UX-01~05 / P1-CODE-02 / P1-ARCH-04 / P2-TEST-02**：自第三轮以来无新代码事实，递延结论与第 4~14 轮一致。

### 验证

- 本地 `corepack pnpm test` 全量通过：1328 passed / 3 skipped（118 个测试文件），覆盖 Core、Web、CLI（含 `session-store`、`session-read-api`、`run-mode-policy` 与 `cli` 测试）；
- Web Playwright e2e 全量通过：29 passed（含移动端 390px 无横向溢出、内联审批闭环、P1-04 "待审批"行动徽标断言、P2-TEST-01 Goal/dsh 状态联动断言）；
- P1-04 UI 已做真实浏览器截图核验（桌面 1440px + 移动 390px），行动徽标/状态徽标/时间同行排布无错位、无重叠、无溢出；
- 三包 build/typecheck 干净。

## Unreleased（复审记录，不 bump 产品版本）

> 依 `docs/technical/tekon-replatform-current-scope.md` §6 采纳的发布策略：**纯复审报告、批注、措辞订正与验收状态调整不单独抬高产品版本**（`tekon update` 比较根 `package.json` version，误 bump 会让用户全量重装重建却零行为变化）。此类内容记录于此，不再为每轮复审创建新的产品 PATCH。

### 第二十一轮复审收口（PR #11）

- **Node 兼容矩阵**：在现有 `CI` workflow 中新增独立 `node-compat` job，以 `fail-fast: false` 并行验证 Node 20.19.x、22.12.x、22.19.x、24.x 的 frozen install、全包 build/typecheck、Core unit、CLI unit 与构建后 CLI smoke。矩阵固定安装 `corepack@0.34.1`，避免 Node 22.12 自带 Corepack 0.29.4 无法验证 pnpm 10.12.1 签名；不修改 branch protection/ruleset。
- **测试合同**：新增结构化 YAML 合同测试，锁定矩阵覆盖根 `engines.node` 下界、独立运行、20 分钟上限、命令顺序，以及不得通过 `exclude`、`if` 或 `continue-on-error` 跳过失败版本；开发过程已通过缺 job、缺固定 Corepack、exclude 腿和 job 条件跳过等变异确认 RED，最终实现 GREEN。
- **评审资料纠偏**：第二十一轮报告恢复与 Markdown 内容源同步的 HTML 人审版，`current.md` 恢复 v0.20.6 本地测试、四视口、历史 Head/run 证据，并明确最终证据不以仓库提交自引用。
- **版本裁决**：没有用户命令、运行时合同、产品 Gate 或数据格式变化，产品版本保持 `0.20.6`；required checks、供应链发布证据与其它架构项继续留在独立 Issue/PR。

### 第十四轮权威复审收敛（`docs/reviews/2026-08-28-tekon-harness-replatform-fourteenth-authoritative-review.md`，作者推送，`18106e1..f9de822` 共 29 提交）

- **本轮 CI 自修改工作流首次落地实质产品代码**（5 个 web 文件）并自动应用了 `apply_fixes`（版本回退 + 文档状态改写 + 生成报告）。动态评估 workflow（新代码正确性 / 版本与分析器 soundness / P0 架构核验三视角 + 首席）+ 独立 opus reviewer 一致：`hasMustFix=false`（新产品代码无回归）、本轮有 3 个自动化引入的 PR-local 文档缺陷需修、`needsUserAdrDecision=true`。
- **B（保留，逐行核验无回归、测试真锁）**：`bca6846`/`d80f981`/`d72a262` **fix(web)**——Session header 改 `displayedStatus = liveState.runStatus ?? session?.status`（实时投影优先），`StatusBadge` 同时正确渲染 session（`done`→passed）与 run（`passed`）双词表、unknown→中性 `badge-skipped` 不再伪装 cancelled。**这正确关闭了我第十三轮 defer 的 P1-PRODUCT-02 header-陈旧**（当时因值域/顺序边界判为「非干净一行修」，CI 用「双词表 StatusBadge + 偏好 runStatus」干净解决，我据此收回该保留）。`659b050` **feat(web)**：EventFeed 默认 `isNarrativeRow` 过滤 + 显式「显示技术事件」toggle（隐藏计数正确、保留 `role=log`）。`96a4ec6` **feat(web)**：SessionSidePanel 折叠 supporting cards 到最新 6、results/errors 恒显。本地 `pnpm test` 114 files / 1316 passed / 3 skipped、web e2e 28 passed 0 flaky。
- **A（本轮已修，3 个 `apply_fixes` 自动化引入的文档缺陷）**：(a) phase3 设计文档重复 H1 标题（regex 与第十三轮 banner 碰撞）→ 删重复行；(b) 报告 §5 泄漏 `fatal: ambiguous argument 'main..HEAD'` git 错误串（生成器在无 `main` ref 的 CI 环境取 PR 规模失败）→ 替换为本地实测 `208 commits / 214 files / +37187/-1751`（相对 `origin/main` `df38520`）；(c) 本 CHANGELOG 两段自相矛盾的复审记录 → 合并订正（见下）。
- **版本治理：接受回退 `0.15.5 → 0.15.4`（订正第十三轮「不回退」措辞）**。第十三轮我判「本轮不回退」，依据是当时报告 §9.2 只要求不 bump、未要求回退；**第十四轮报告 §6 首次明确要求回退**至 docs-only 前的 `0.15.4`，触发条件已变，故本轮接受。回退低风险：`0.15.5` 本身是无行为变化的复审 over-bump，`scope-baseline 828edad` 未把 `0.15.x` 硬编码进正文（无悬空引用），分支未合入 main、churn 属 cosmetic。**版本身份 reconcile 仍待发布前统一**：`@tekon/{cli,core,web}` 包版本冻结 `0.7.0`，根 `0.15.x` 为 updater-visible 身份。（说明：本轮虽含 `feat(web)` UI 改动，SemVer 角度可支持 MINOR bump，但报告 §6 明确要求回退到 `0.15.4` 且分支未合入 main、版本身份本就待统一，故遵从报告不另行上调，把发布身份定义整体留到正式发布前。）
- **C / needs-user-ADR（与第 4~13 轮一致，报告 verdict 公允）**：6 个 P0（Provider streaming / durable inbox / Collaborate-Deliver 双轨 / persistent claim authority / Node CAS / shutdown quiescence）+ P1 §9 token 状态化 / §10 长 Session 有界——代码事实核验全部属实且本轮未改动。报告 §8「Session state coherence」现 **PASS**（header-fix 关闭）。§5 超大 PR（208 commits）论断成立，仅 metric 取数在 CI 环境失败（非误报）。

### 第十三轮权威复审收敛（`docs/reviews/2026-08-28-tekon-harness-replatform-thirteenth-authoritative-review.md`，作者推送，远端领先 2 提交）

- **本轮无产品 / Runtime 代码变更**：`8e39c9c..97ad2f5` = `828edad`（新增范围基线 `docs/technical/tekon-replatform-current-scope.md`）+ `97ad2f5`（报告）。动态评估 workflow（版本策略 / P1 UX 可修性 / P0 架构核验三视角 + 首席 max 综合）+ 独立 reviewer 一致：`hasMustFix=true`（本轮首次有真实 PR-local 可修项）、`needsUserAdrDecision=true`。
- **A（本轮必做，版本 / 发布治理，接受报告 §4 P1-PROCESS-01）**：纯复审 PATCH bump 会触发真实 `tekon update` 重型流程（`scripts/update.sh:30/35` 比较根版本 → `git pull + pnpm install + pnpm build`）。第 8/9/11/12 轮的 `v0.15.1/0.15.2/0.15.4/0.15.5` 其自述均「无代码变更、无用户可见行为变化」，违反 SemVer PATCH 定义。**处置**：本轮 docs-only 不 bump（已合规）；停止未来纯复审 bump；本轮**暂不回退已提交的 `0.15.5`**（依据：第十三轮报告 §9.2 只要求不 bump、未要求回退）。**⚠️ 第十四轮订正**：第十四轮报告 §6 明确要求回退，触发条件改变，故已接受回退 `0.15.5 → 0.15.4`（见上方第十四轮条目）；此处「暂不回退」仅为第十三轮当时的处置记录。
- **版本身份 reconcile（记录）**：根 `package.json` `version=0.15.x` 是 **`tekon update` 可见的唯一发布身份**；`@tekon/{cli,core,web}` 包版本仍冻结于 `0.7.0`（自 replatform 起未随根版本抬升）。二者需在**正式发布前统一定义单一发布身份**（scope-baseline §6）。在此之前，CLI `--version`（读包 `0.7.0`）与 updater（读根 `0.15.x`）会显示两个数字，属已知待收敛项。
- **P（完成报告 §3.2 文档状态修复）**：为 `phase2`（`已实施`）/ `phase3`（`3a-3d 全部实现完成`）设计文档头补 banner「状态口径以 `docs/technical/tekon-replatform-current-scope.md` 为准」，明确其为 **切片完成** 而非原始阶段验收整体完成。
- **C / needs-user-ADR（与第 4~12 轮一致，勿当本轮缺口）**：§5 P0-PRODUCT（真实 Provider streaming / durable inbox / follow-up-steer-resume / Collaborate-Deliver 双轨）、§6 P0-RUNTIME（persistent `claim_generation` / Node CAS / shutdown quiescence）、§6 P0-ARCH-04（Session Event authoritative-log 未来决策，当前 projection-only 已被 scope-baseline §3 明文化并接受）、§4 P1-PRODUCT-02 List 排序/needsAction 服务端稳定投影、P1-OBSERVABILITY-03 projection 健康子系统、P1-AUTH-04 复制深链新标签页认证、§7 P1-UX（Feed/Inspector/Final Result/长会话）——报告自身递延为独立 vertical-slice PR 或待 ADR，代码事实核验全部属实且本轮未改动。P1-PRODUCT-02 的 header-陈旧子项虽真实，但因值域/顺序边界情形非干净一行修，随里程碑做。
- **验证**：本地 `pnpm test` 1313 passed / 3 skipped、web e2e 28 passed 0 flaky（本轮仅文档变更，确认无回归）。README / manual / AGENTS 无需同步（无代码行为变化）。

## 复审记录（2026-08-28，非产品发布）

> 本节只记录第十二轮报告批注与验收口径订正；没有产品或 Runtime 行为变化，不构成 SemVer 发布。根版本保持 `0.15.4`。

第十二轮**权威复审**（`docs/reviews/2026-08-27-tekon-harness-replatform-twelfth-authoritative-review.md`，作者推送，远端领先 6 提交）循环评估后的收敛。经动态评估 workflow（CI 提交核验 / 报告 P0-P1 triage A-D / 合并门槛与 scope-drift 三视角 + 首席 max 综合）达成一致：**本轮无任何新的 PR-local 必修代码项**（第五个此类轮，性质同第 8/9/11 轮），`needsUserAdrDecision=true`。`c224e33..ef56dfa` 6 个新提交经 `git diff --stat` 核验只改两个 e2e 测试文件 + 报告，无产品/Provider/Session/Runtime/Node/shutdown 代码变更，CI 最终快照 28 项首轮全绿。相称做法 = 报告批注（§15）+ 订正措辞 + 版本同步 + 向用户呈现 ADR 决策，不做未经用户拍板的架构重写。

### 已闭环并复核保留（B，本轮 5 个 `test(web)` fixture 提交经实地核验正确、无回归、真锁）

- `9d3a0f3` 作为**反向实验**移除第十轮的 `page.goto` `#token` 注入 → 复现 6 flaky（报告 §10.1/§11.2 `22 passed / 6 flaky / exit 1`），证明广泛业务 E2E 绿依赖 route-launch 注入而非 sessionStorage 恢复。
- `eabdce1` 以 **`URLSearchParams` 保留 hash 的条件注入**恢复（`shared-fixture.ts:49-59`：仅当 `!hash.has('token')` 才 `set`），**严格优于**第十轮的无条件 `target.hash` 覆盖。复核无隐患：`createBrowserRouter` 路径路由 + 所有业务 `page.goto` 裸路径无 hash → 干净 `#token=`；`beforeEach` 唯一带 hash 的 goto 已含 `token=` → 正确跳过不双写。
- `8b56961`/`0f65b71`/`f23a241` 演化 `shared-fixture-auth-lock.test.ts` 到最终锁：`addInitScript` 清 sessionStorage 后仅靠 fragment 认证，正向断言 `.run-header-id` + 负向断言无「认证失败」。真锁非死测试（revert 注入则 401 超时失败）。fixture 注释（`:38-41`）与 auth-lock 标题（`:8`）已如实标注为「测试启动策略，非 sessionStorage 恢复证据」。

### 订正：`persistToken` 措辞（P，接受报告 §2.2 降级）

第十一轮 CHANGELOG 曾把 `6ce9fb5` 表述为「闭合了同一 bootstrap 竞态」，措辞过强。据本轮反向实验订正为「闭合产品首屏 + refresh 恢复路径（`prod-bootstrap` 专测覆盖）；任意无 fragment 深链 hard-nav 的 sessionStorage 回落未被广泛 E2E 证明」（详见下方 v0.15.4 条目内订正说明）。

### 本轮核心增量：三项交用户 / 项目拍板的 ADR 决策（`needsUserAdrDecision=true`，报告 §3/§4/§5，自第 4 轮起持续呈现，本轮收紧）

1. **范围合同重新基线化**（报告 §3）：路径 A 坚持原始单 PR 完整计划 / 路径 B（推荐）新增 scope ADR 重命名为 `Phase 1 + 2a + partial Phase 3 infrastructure`、订正 phase2/3 文档状态、拆独立小 PR。事实为真（`execution-plan.md` 承诺单 PR 完成阶段 0-5 含 follow-up/steer/inbox/streaming/diff-card，phase2/3 设计头称「已实施/全部完成」却 §0.2 递延同批能力），但路径 B 会覆盖已记录的「用户决策：按完整报告方向推进」，须用户裁定。
2. **Runtime ownership**（报告 §4）：single-owner daemon（推荐，第二 owner fail-fast）/ 完整 multi-owner fencing（持久 claim authority + Node CAS + 全副作用 fencing + 两进程交错测试）。当前 Web+CLI 共享 SQLite/Git 无 runtime lock = 事实 multi-owner，`transitionNode`（`repositories.ts:569`）无 CAS，`claim_generation` 列不存在——「需要决策 ≠ 当前安全 ≠ 可默认合入 main」论断成立。
3. **Session Event 事实源角色**（报告 §5，本轮新框定）：projection-only 明文化 / authoritative log（append 不得 best-effort 丢失 + 同事务/outbox）。当前 `dual-write.ts` 显式声明 best-effort 投影不拖垮治理路径（C1）、治理主路径旧表才是事实源，自洽已披露，不造成治理数据错误；authority 角色决定与 durable-inbox 耦合。

### 诚实递延（C，与第 4~11 轮一致，勿当本轮缺口）

P0-PRODUCT（真实 streaming：`legacy-agent-driver:132` `await done` 一次性 / follow-up-steer-resume throw `NotSupportedYet` / durable inbox / 双轨）、P0-RUNTIME（persistent claim_generation / Node CAS / shutdown quiescence：`STOP_SETTLE_TIMEOUT_MS=5000` 不 abort/kill/join）、P1-UX（§8.3-8.6 token 状态化 / Narrative Feed / Inspector 当前状态 / 结构化 Final Result）、P1-RUNTIME-04（长 Session bounded）——均报告 §8/§9 自认独立 ADR/PR 里程碑，核验代码事实全部属实且本轮未改动，无倒退。

### 版本与文档

- 不提升产品版本：报告批注与措辞订正不构成运行时 PATCH；根版本保持 `0.15.4`。
- README / manual / AGENTS 无需同步：本轮无代码行为变化。

## v0.15.4

第十一轮**权威复审**（`docs/reviews/2026-08-27-tekon-harness-replatform-eleventh-authoritative-review.md`，作者推送）循环评估后的收敛。经动态评估 workflow（CI 提交核验 / 报告 P0-P1 triage / CI 事实与合并门槛三视角 + 首席综合）达成一致：**本轮无任何新的 PR-local 必修代码项**（性质同第八 / 九轮）。报告 §1 已明确 PASS 第十轮 flaky 整改与本轮 CI 三提交；剩余全部为第 4~10 轮已披露的架构里程碑，诚实 C 递延。本轮相称地做报告批注 + 版本同步，不做未经用户拍板的重大架构重写。

### 已闭环并复核保留（B，本轮 3 个 CI 提交经实地核验正确、无回归、测试真锁）

- `6ce9fb5` **fix(web)**：`main.tsx` 在 first render 前同步 `persistToken(initialToken)`（`persistToken(null)` 为 no-op 不误清；`AuthProvider` 仍幂等重复）。这硬化了**产品首屏 + refresh 恢复路径**（由 `prod-bootstrap` 专测独立覆盖）。**订正（第十二轮）**：第十一轮曾把此项表述为「闭合了同一 bootstrap 竞态」，措辞过强——第十二轮反向实验（`0f65b71` 移除 e2e fixture 的 `#token` 注入）复现 `22 passed / 6 flaky`，证明广泛业务 E2E 绿依赖每次 hard route launch 注入 `#token`，而非 sessionStorage 恢复；因此该同步持久化闭合的是**产品首屏 + refresh**，任意无 fragment 深链 hard-nav 的 sessionStorage 回落**未被广泛 E2E 证明**。它与第十轮 e2e fixture `#token=` fragment 注入互补，是有价值的产品硬化，但不等于「所有跨文档认证已闭环」。
- `ffc1ecd` **perf(web)**：`session-stream` `mergeEventsBySeq` 增有序追加快路径（existing/incoming 均严格递增且 incoming 首项在 existing 末项之后 → 线性 concat，否则回退 Map dedupe + sort 防御路径）；11 边界 cross-check 证明与 fallback 等价，replay/dup/乱序语义不变。不关闭长会话无界问题。
- `dad49b0` **test(web)**：锁有序追加路径（对象身份 + out-of-order 修复），真锁非假通过。
- 验证：本地 web 单测 253 passed；HEAD 六项 CI check 全 success，Playwright 28 passed / 0 flaky / 0 retry。

### 本轮核心增量：合并门槛 / 架构 ADR 决策（交用户 / 项目拍板）

报告 §3.5 / §6 / §9 / §13 主张 multi-owner authority（持久 `claim_generation`）、Node expected-from/revision CAS、完整 shutdown quiescence 是当前 Runtime 的**正确性问题**而非纯未来功能。实施方核验事实前提成立：Web 服务端（`root.ts`）与 CLI（`run.ts`/`approval.ts`/`session-context.ts`）都会 `createJobRunner().start()`，可访问同一 project SQLite/Git 且无 runtime lock = 事实 multi-owner。但报告提出的两条闭合路径——(A) 强制 single-owner daemon（Web/CLI 变客户端）/ (B) 完整 multi-owner generation + Node CAS + 副作用 fencing——**都是需用户先拍板方向的重大架构改动**，报告 §13 自身也判定应"冻结范围 + 先出 single-owner daemon ADR + 独立小 PR"。这与第 4~10 轮反复记录、交用户决策的 single-owner-vs-multi-owner ADR 同源，本轮不做未经拍板的架构重写。

### 诚实递延（C，与第 4~10 轮一致，勿当本轮缺口）

P0-PRODUCT（真实 streaming / follow-up-steer-resume / durable inbox / 双轨）、P0-RUNTIME（persistent generation / Node CAS / shutdown quiescence）、P1-UX（token 状态化 / Narrative Feed / Inspector / 结构化 Final Result）、P1-RUNTIME-04（长 Session 有界化）——报告 §10 分阶段独立 ADR/PR 里程碑，无倒退。

### 版本与文档

- CI 三提交含实质 web 代码变更却未 bump（仍 0.15.3）；随本批注 `0.15.3` → `0.15.4`（PATCH，内部竞态硬化 + 性能优化，无用户可见新功能）。
- 本轮改动无用户可见行为变化，故 README / manual / AGENTS 无需同步。

## v0.15.3

第十轮**权威复审**（`docs/reviews/2026-08-27-tekon-harness-replatform-tenth-authoritative-review.md`，作者推送）循环评估后的收敛。不同于第八 / 九轮"无 PR-local 必修"，本轮存在一个真实、当前 PR 自身可也必须收敛的阻断项：**Web Playwright e2e 首轮 flaky 使整体 CI 失败**（本轮 CI 自修改工作流的 `fa9749f` 启用了 `failOnFlakyTests`，不再把 retry-恢复的 flaky 伪装成绿色）。经动态评估 workflow（flaky 根因 max / 报告 triage / CI 事实核验三视角 + 首席综合 max）达成一致：本轮唯一必修 = flaky 的确定性根因；架构级 P0 / P1 仍为已披露里程碑、诚实 C 递延（报告 §8 自身接受"降格为基础设施里程碑后不必同 PR 全实现"）。

### 修复：消除 5 个（潜在 10 个）e2e 首轮 flaky 的确定性根因

- **根因（探针实证）**：`packages/web/__tests__/e2e/shared-fixture.ts` 的 `beforeEach` 用根导航 `/#token=` 把令牌写进 sessionStorage（在 `AuthProvider` 的异步 effect 里），随后每个业务 journey 对同一 server 做**不带 fragment 的二次 `page.goto`**。新文档 `main.tsx` 同步读 sessionStorage 时，上一个文档的异步写**首轮间歇尚未提交** → 首帧 RPC/SSE 无 `x-session-token` → 401 → 渲染认证失败错误页 → 断言的 `.event-feed` / `.run-header-id` / `交付管道 Delivery Pipeline` / token 输入框值永不出现；retry（sessionStorage 已提交）通过。这是**测试脚手架的跨导航令牌交接竞态，非产品 bootstrap 缺陷**——真实 `tekon ui` 首屏 URL 一定带 `#token=`，`main.tsx` 同步命中 hash，永不走 sessionStorage 回落。
- **修复（只改 e2e fixture，不动产品码）**：在 `shared-fixture.ts` override `page` fixture，对指向本 server 的每次跨文档 `page.goto` 自动注入 `#token=<token>` fragment，使 `main.tsx` 首帧同步命中 hash、彻底绕开跨导航 sessionStorage 交接。single-file 改动覆盖全部 10 个 shared-fixture 消费者及未来新增 journey（含首轮 CI 未暴露、但承受同一竞态的 5 个文件），无遗漏；SPA 路由导航与 `page.reload()` 复用已就绪的 sessionStorage、不经过该 wrapper，属已知且安全的边界。
- **真锁验证**：新增 `shared-fixture-auth-lock.test.ts` —— 先以 document-start init script 清空 sessionStorage 移除回落令牌，再导航业务路由，正向断言 `.run-header-id` 渲染 + 负向断言无 `认证失败` 错误页。已实测：注入禁用时该锁**确定性失败**、启用时通过，非恒绿死测试。
- **验证**：同一 HEAD 本地 `CI=1 playwright test`（`failOnFlakyTests` 生效）连续 5 轮 exit 0、28 passed、**零 flaky / 零 retry**；根 `pnpm test` 1311 passed / 3 skipped。

### 已闭环并复核保留（B，本轮 17 个 CI 提交经实地核验正确、无回归）

- worktree base-OID fencing（`bfe6e3e`/`e669b8a`/`3215b56`）：promotion 用租约创建时持久化的 `lease.baseHead` 作 expected-old（替代 promote 前临时读目标 ref），消 ABA；legacy 缺 `baseHead` fail-closed；git 3-arg `update-ref` 强制 CAS。
- `failOnFlakyTests`（`fa9749f`）：本地保留 1 retry 取 trace，CI 拒绝伪绿——正是本轮暴露上述根因的关键。
- prod-build e2e（`7a92e8a` 等）：共享 journeys 改对 production build 跑 + 走真实 launch URL bootstrap（去 `window.fetch` monkeypatch），更贴近生产。
- 仓库卫生：`bd41546` 误加根目录 `nonexistent`、`9bf51a7` 删除；工作树 clean。

### 诚实递延（C，报告 §5 / §6 架构里程碑，报告 §8 自身接受）

真实 Provider 执行期 streaming、follow-up / steer / resume（`NotSupportedYet`）、durable inbox、persistent `claim_generation`、Node transition expected-from / revision CAS、完整 shutdown quiescence、Collaborate / Deliver 后端双轨；token 状态化 UX、Narrative Feed、Current-state Inspector、服务端结构化 Final Result、长 Session 端到端有界。另：产品侧 401 页在令牌可用后自动 refetch 属可选硬化（生产首屏 fragment 确定故不触发），本轮不做。

### 版本与文档

- 17 个 CI 提交含实质代码却未 bump（仍 0.15.2）；本轮 flaky 修复落地代码，随收敛 `0.15.2` → `0.15.3`（PATCH，测试脚手架 bug 修复无用户可见新功能）。
- 修复仅触及 e2e fixture + 版本 / CHANGELOG / 报告批注，无用户可见行为变更，故 README / manual / AGENTS 无需同步。

## v0.15.2

第九轮**权威复审**（`docs/reviews/2026-08-27-tekon-harness-replatform-ninth-authoritative-review.md`，作者推送）循环评估后的收敛。本轮同步基线前，远端已领先 15 个提交——CI 自修改工作流在 v0.15.1 之上做了**实质并发/CAS 硬修复**后才发布报告。经动态评估 workflow（CI 提交正确性、Runtime/产品闭环、UI-UX/报告完整性三视角独立实地核验 + 首席综合 max）**一致判定无业务代码逻辑必修项**：报告为 criteria-based（准则式）复述已披露长期里程碑，CI 15 提交已正确关闭其可关闭部分。本轮相称地做报告批注 + B/P/C 诚实标注 + 三项低成本诚实收敛（注释漂移、版本、断链引用），不为凑工作量改任何架构级代码。

### 已闭环并复核保留（B，CI 15 提交经实地核验正确、无新回归、测试真锁）

- `d22ac0f`/`6fe3b2a`（**报告 P0-05 Git 侧**）：`worktree-manager.ts` 分支 promotion 从 `git branch -f` 改用 `git update-ref <targetRef> <leaseHeadOid> <expectedOldOid>` 的 expected-old-OID compare-and-swap——并发 promoter 中恰有一个赢、落败者报错不静默覆盖新工作；expected-old 由 `rev-parse --verify` 读得，首次 promotion 非回归（`ensureRunBranch` 在建租约前预建 delivery ref，targetRef 必存在）。
- `8288da1`/`f62b84e`/`3fbb0b6`（**报告 P0-04 owner-conditioned write 半**）：`session-store.ts` `updateJob`（owner+status 谓词入 SQL WHERE，`changes!==1` 返回 null 不改行）+ `settleOwnedJob`（单条 SQL 内 owner 检查 + 取消优先 + 终态，消除 read-then-write 窗口）；`job-runner.ts` 所有写入点（checkpoint/heartbeat/settle/pause/cancel）改条件写，heartbeat miss → abort ownership-lost + killAll 自我 fence。`job-owner-fencing.test.ts` 用真实内存 SQLite 锁死 stale owner 不能写/取消优先/终态不被 stale pause 复活。
- `6642ef0`/`e1afb82`/`12e1198`/`ce434e9`：SSE 行尾单遍逐字符归一化（正确处理跨 chunk 分裂的 CRLF），无回归。
- `c4fc9e7`（**报告 P1-01 半**）：`TopBar.tsx` 手工 token 改本地 `draftToken` + 350ms debounce 应用，避免每键 `setToken` 反复切 scope/清 cache/重建 RPC·SSE。
- `fe6c2c3`/`1155c95`：a11y 统一单一 `main` landmark（`AppLayout` 用 `<main>`、`SessionDetailPage` 嵌套 `<main>` 降为 `<section>`）。
- `d624be0`：首页导航前预热 client graph 以降 flaky。

### 本轮低成本诚实收敛（非业务代码逻辑）

- **注释漂移**：`node-executor.ts` 与 `gate-runner.ts` 的 fencing 注释仍称 promotion 用 `git branch -f`、"no CAS"，与 `d22ac0f` 矛盾。更新为反映现用 `git update-ref` expected-old-OID CAS，并说明 stand-down fencing 与 CAS 正交、仍作为 defense-in-depth 必要（避免 stale executor 的 finalize/transition 副作用）。所守 fencing 逻辑本身正确不变。
- **版本元数据同步**：CI 15 个含实质 bug 修复/硬化的提交未 bump 版本；本次随批注把 `0.15.1` → `0.15.2`（PATCH）——均为对既有行为的修复级硬化，无超出用户可见的新功能。
- **报告断链引用**：权威报告第 6 行引用不存在的 `...-ninth-review.md` 详细证据矩阵、第 92 行抬为"最终依据"。改为自引本报告的实施方批注小节，消除悬空引用（不伪造 companion 文件）。

### 部分闭环与诚实递延（P/C，报告 §9 分阶段，勿当本轮缺口）

- **P0-04/P0-05 P（部分）**：Git expected-old CAS + owner/status 条件写已闭环；全库仍无持久化 `claim_generation` 列（fencing 靠 owner 字符串 + 进程内 symbol），`db/repositories.ts` `transitionNode` 无 Node revision/expected-from CAS。后二者为报告 §9 第 1/2 项 single-owner-vs-multi-owner 架构 ADR，≡ 前四/五/七/八轮 F4-P0/F5-P0-02~05/F7-P0-05·06/F8-P0-04 递延；Node expected-from CAS 是剩余最小可切分项但仍属中等成本 schema+call-site 改动，待用户拍板后独立 PR。
- **P1-01 P**：debounce 已闭环；bootstrap 成立后 token 框状态化（已连接/失败/重连）UX 重构递延（产品级 UI 改动）。
- **P0-01/02/03/06、P1-02~05 C**：真 Provider 执行期流式 + follow-up/steer/resume（显式 `NotSupportedYet`）、durable inbox、Collaborate/Deliver 双轨、完整 shutdown quiescence、Narrative Feed、当前状态 Inspector、结构化 Final Result、长 Session 端到端有界——报告 §9 分阶段独立 ADR/PR 里程碑，§11 认可诚实标注边界的阶段性基础设施可评估合并。
- **§7.2 flaky**：报告"green≠一次通过"批评成立且诚实（报告未谎称一次过）；`retries:1` 是长期已披露妥协，非本批新回归，长期消除 SSE/server-readiness/导航竞态后去除。

### 流程治理建议（交用户决策）

自修改评审 workflow 已连续第五轮（第 3/6/7/8/9 轮）在发布报告的同时夹带业务代码提交；报告 §7/§8 自身也建议冻结范围、停用该工作流。建议固化"评审只读、业务改动走显式提交"，并将 single-owner daemon / 完整 multi-owner、真实 Provider、双轨产品、长 Session、安全 nonce 分别进入独立 ADR 与独立 PR。

## v0.15.1

第八轮**权威复审**（`docs/reviews/2026-08-27-tekon-harness-replatform-eighth-review.md`，作者推送）循环评估后的收敛。经动态评估 workflow（CLOSED 硬化正确性、Runtime/并发/产品闭环、UI-UX/测试/报告完整性三视角独立实地核验 + 首席综合）**一致判定 `hasMustFix=false`**：报告本身把第七轮整改 + 本轮边界修复 + 移动端全判为【通过】，剩余全部是报告 §8 自身分阶段的已披露长期里程碑 / 待 ADR 架构决策。**本轮无必修代码项**，相称地只做报告批注 + 诚实递延 + 本次版本元数据同步。

### 已闭环并复核保留（CLOSED-01~05）

第七轮整改（`998d2b3`）之上，CI 自修改工作流的 4 个硬化提交经实地读码 + 全量测试确认正确、无新回归，予以保留：

- `5d4a42e`：`stripTokenFragment` 保留 `window.history.state`（不破坏 React Router 前进/后退）；
- `0871ed7`：`AuthProvider.setToken` 原子同步 seed RPC token + sessionStorage（避免手工兜底/`hashchange` 时新 scope 首请求用旧 token 401）；`hashchange` 监听让已打开标签页接受新 `#token=`；移除误导性裸 URL，`server/index.ts` 只输出唯一带 `#token=` 的启动 URL + 无链接 `Tekon Web ready`；
- `f37070f`/`ba44ad0`：close bootstrap/teardown 边界（`close()` 先摘 automation 监听器 + 等待 in-flight auto-prepare 回调再关 DB）+ 针对性测试。

本地全量 `pnpm test` 1301 passed/3 skipped，6 条 prod-bootstrap e2e（独立无 monkeypatch fixture）+ 2 条 close-teardown 单测全绿，HEAD CI 6/6 全绿。

### 版本元数据同步

CI 工作流的 4 个硬化提交未 bump 版本；本次随批注把 `0.15.0` → `0.15.1`（PATCH）——均为对 v0.15.0 token bootstrap 的 bug-fix 级硬化，无超出 v0.15.0 的新用户行为。

### 诚实递延（交用户决策，勿当本轮缺口——报告 §8 Phase A/B/C/D 分阶段列出）

- **F8-P0-01/02/03**：真 Provider 执行期增量流、follow-up/steer/resume + durable inbox（显式 `NotSupportedYet`）、Collaborate/Deliver 双轨——Phase B/C 里程碑。
- **F8-P0-04/05**：事实 multi-owner 缺持久化 `claim_generation` + 统一 Node/Git CAS、完整 shutdown quiescence——Phase A 架构红线，≡ 前四/五/七轮 F4-P0/F5-P0-02~05/F7-P0-05·06 递延，single-owner daemon vs 完整 multi-owner 待用户拍板。
- **F8-P1-01~05**：token 控件移入连接设置、Feed 叙事化、Inspector 当前状态投影、结构化 DeliveryResult、长会话规模化——Phase C/D。F8-P1-01 技术诉求属实但认证已原子化不再破坏、正确迁移与 CLOSED-04 e2e 耦合，仓促半做有回归风险，故递延。
- **§6/§7**：PR 规模、停用自修改评审 workflow、缺 multi-owner/大规模测试——流程治理建议。报告字面"`events.map` 事件墙"略夸大（实为 `groupEventsByTurn` + typed 叙事映射），方向成立、属 Phase C。

## v0.15.0

第七轮**权威复审**（`docs/reviews/2026-08-26-tekon-harness-replatform-seventh-review.md`，作者推送）循环评估后的收敛。经动态评估 workflow（产品/bootstrap、Runtime/并发、报告/代码质量三视角独立实地核验 + 首席综合）达成一致：报告事实层面全部成立、无阻断级误报；本轮做 **3 条相称最小必修**，其余 F7-P0-02~06、P1-01~07、§6 治理建议均为报告 §8 自身分阶段列出的架构决策/长期里程碑，诚实递延（不被完整 roadmap 裹挟做架构级重写）。设计经 reviewer 循环评审、实现经独立 code review 收敛。

### F7-P0-01 生产浏览器 Token Bootstrap（默认 Web 入口修复前对普通用户不可用）

- **问题**：`tekon ui` 只打印裸 `http://localhost:${port}`，`AuthProvider` 初始 token=null 且仅内存、刷新丢失，首屏 `session.list`/SSE 全部 401；e2e 用 `window.fetch` monkeypatch 注入 token 掩盖了它；手册声称"输出带 session token 的完整 URL"与实现矛盾。
- **修复（最小诚实 fragment 闭环）**：`ui.ts` 打印 `#token=<token>` fragment URL（fragment 不随请求上送、不进 Referer/服务端日志）；新增 `session-bootstrap.ts`；`main.tsx` 在 `createRoot` **之前**同步 `setRpcSessionToken(readTokenFromLocation())`（React 子 effect 先于父,必须同步 seed 才能保证首屏 RPC/SSE 带 token）；`AuthProvider` 以此为初始 state、token 变化写 `sessionStorage`（同标签页刷新保持）、挂载后 `history.replaceState` 清除地址栏 fragment；手册 md（3 处）+ html（3 处）文案对齐。完整一次性 nonce 硬化（防 token 落 shell history）走独立后续 PR/ADR（报告 §8 Phase A-7）。
- **验证**：新增**不 monkeypatch fetch** 的独立 fixture + `prod-bootstrap.test.ts`（#token 首屏不 401 / 刷新 sessionStorage 保持 / token 不进 URL·Referer），mutation 反证为真锁（去掉 main.tsx 同步 seed → 首屏 401 测试 FAIL）。

### F7-P0-07 shutdown 竞态（readiness/auto-prepare 监听器泄漏）

- **问题**：`root.ts` 两个 `bus.subscribeAll` 的 unsubscribe 被丢弃，`close()` 只清 debounce 计时器却从不注销监听器 → `jobRunner.stop()` 的 5s 窗口内到达的 `gate/result`/`approval/decided` 会重装计时器、`agent/status:passed` 同步 enqueue，命中 `db.close()` 后 `[readiness] enqueue failed: database connection is not open`。
- **修复**：捕获两个 unsubscribe，`close()` 最前注销（stop/db.close 之前）。新增 `close-teardown.test.ts`（close 后 publish 三类事件 + 等 700ms，断言无 late enqueue），mutation 反证为真锁（去掉注销 → FAIL）。

### 代码勘误

- `session-contract.ts` 顶部块 + AgentHandle 块过期注释（"no runtime implementation yet"）改为反映已被 SessionService/dual-write/legacy-agent-driver 接入的现状。

### 诚实递延（交用户决策，勿当本轮缺口——报告 §8 分阶段列出）

- **F7-P0-02/03/04**：真 Provider 流式（one-shot）、follow-up/steer/resume（`NotSupportedYet`）、Collaborate/Deliver 双轨——Phase B/C 里程碑，代码/Composer/手册已披露。
- **F7-P1-01~04**：Feed 叙事化、Inspector 当前状态投影、服务端 DeliveryResult 投影、长会话规模化——Phase C/D。
- **F7-P0-05/06、完整 shutdown quiesce、F7-P1-05/06/07**：multi-owner fencing、Node·Git 统一 CAS、StartRun Saga、process-local bus、durable dual-write——Phase A 架构红线，≡ 前四/五轮 F4-P0/F5-P0-02~05 递延，single-owner daemon vs 完整 multi-owner 待用户拍板；进程内 fencing + `workflow_instances` 部分 CAS 已提供当前单进程正确性兜底。
- **§6.2/6.3/6.4/6.5/6.6（CSS 拆分）**：横向抽象领先纵向、PR 过大、自修改评审 workflow 应停、flaky 硬化、reset.css 拆分——流程治理/大重构建议。误报（D）：§6.6 visibility vs modelVisible 不重复（两字段不同轴）。

## v0.14.6

第六轮**权威复审**（`docs/reviews/2026-08-26-tekon-harness-replatform-sixth-review.md`，作者推送覆盖了此前实施 Agent 的重建简版）循环评估后的收敛。经动态评估 workflow（前端/UX、后端/并发、报告完整性三视角独立实地核验 + 首席综合）达成一致：本轮唯一必修实现回归是 **F6-P0-01 移动端布局**，其余 F6-P0-02/03/04、F6-P1-01~04、F6-ARCH-01 均为报告自身及 README/手册已诚实披露的长期里程碑或待 ADR 架构决策，诚实递延。设计经 reviewer 循环评审、实现经独立 code review 收敛。

### F6-P0-01 移动端布局修复（真实实现回归，比报告更严重）

- **死 CSS 根因**：`packages/web/src/client/main.tsx` 只 import `tokens/reset/utilities.css`，从不 import `sessions.css`；`styles/index.css`（唯一 @import sessions.css 者）无任何 importer。git 全历史证实 sessions.css **从未被加载**——即整个 Human-first Session UI（默认落地页 SessionsPage / SessionDetailPage / EventFeed / SessionComposer，共 5 个组件使用 sessions 系列类名）自 Phase 3 引入以来一直**近乎无样式渲染**，报告以为生效的 860px 两列折叠是死代码。**修复**：`main.tsx` 增加 `import './styles/sessions.css'`。
- **无全局响应式根因**：`reset.css` 零 `max-width` 断点；`.sidebar{position:fixed;232px}` + `.main{margin-left:232px}` 在所有宽度恒定；更深的根因是 `#root` 无 CSS、是 `body`（display:flex）下的 block flex-item，其默认 `min-width:auto` 拒绝收缩，令移动端宽 `<select>` 撑爆整页（`.main{flex:1}` 一直是死规则，因父 `#root` 非 flex）。**修复**：`#root{flex:1;min-width:0;display:flex}`（激活既有 `.main{flex:1}` 意图，桌面零回归）+ 文件末尾 `@media(max-width:768px)`：`.main` 归零左边距、侧栏转**可访问抽屉**（TopBar 汉堡按钮 `aria-expanded`/`aria-controls`，遮罩点击/Esc/路由变化关闭，Esc 焦点归还汉堡，关闭态 `visibility:hidden` 移出 tab 序，汉堡 `sticky z-index` 保持可点）、topbar 换行、token input 流式化、Advanced Cockpit flex 行 `flex-wrap`+`min-width:0`、toolbar/filter-group 内 select/input `width:100%` 防溢出。
- **验证**：新增 `packages/web/__tests__/e2e/mobile-layout.test.ts`（390px 无横向溢出：sessions 列表 + session-detail + /advanced/runs + /advanced；抽屉汉堡开合 + overlay/Esc/路由三种关闭；1440px 无回归：sidebar 常驻、无汉堡、`.main` margin-left:232px）。全量 `pnpm test` 1299 passed/3 skipped；Playwright e2e 全绿；web typecheck 干净。桌面/移动截图人工核验布局正确、抽屉交互正常。

### 诚实递延（交用户决策，勿当本轮缺口）

- **F6-P0-02/03/04**：真 Provider 流式（`legacy-agent-driver` one-shot）、Session 内 follow-up/steer（显式 `NotSupportedYet`）、Collaborate/Deliver 双轨（仅 Deliver 治理 profile）——README/手册已披露的产品里程碑。
- **F6-P1-01~04**：Feed 叙事聚合、结构化 Final Result、event outbox 持久化边界、长会话规模化——报告标 P1 的 UX/架构演进项。
- **F6-ARCH-01**：Runtime 所有权模型 ADR（单 owner 推荐 / multi-owner）≡ 第五轮 F5-P0-02~05 递延，待用户拍板。

## v0.14.5

第六轮全面复审（`docs/reviews/2026-08-26-tekon-harness-replatform-sixth-review.md`）循环评估后的收敛。本轮特殊：核心修复由 CI 自修改评审工作流用正则脚本自动应用于 `3d6836d`（run 执行与 automation 控制分离 + Session/Workspace 身份幂等 + enqueue 绑定校验），且原始报告 `.md` 未随修复落库（与第三轮同型流程缺口）。为此委派动态 workflow（3 个最高思考等级 subagent 分别核验三处核心改动 + 1 个核验 web/README/e2e + 1 个首席综合），对机器生成改动补做审查，以 mutation 反证真锁性。

### 核验结论：自动应用的核心改动正确、可保留

- **run/automation 分离 = 真实改进，非回归**：`findActiveByRunId` / `cancelStaleActiveJobs` / `enqueueIfNoActiveByRunId` 的 active-job 判定收窄到 `RUN_EXECUTION_JOB_KINDS`（`workflow-run`/`workflow-resume`/`goal-run`）。`requestPause`（先 `running→paused` CAS）、`requestCancel`（先 `writeWorkflowTerminal`）的语义锚点在 workflow-instance 层、都在 job relay 之前，故排除 automation job 不引入 pause/cancel 静默失效；分离前未过滤反而可能对 automation job 施加 workflow 控制或 409 误拒 resume——那才是被修掉的真 bug。
- **Session/Workspace 身份幂等正确**：`getOrCreateDefaultWorkspace` / `createSession` 改为 `BEGIN IMMEDIATE` 内幂等 get-or-create（与 `appendEvent` 同款跨进程临界区）；三个调用方（startRun/resumeRun/gate.approve）均安全，补齐第五轮 F5-P0-01「无 session 子案例可能建两 session」窗口。session 收敛测试对 pre-fix 无条件 insert 为真锁；workspace 收敛测试因 pre-fix 已是 lookup-then-insert，属回归护栏而非 mutation-killer（跨进程竞态单进程 vitest 无法复现，与 F5-P0-01 同款限制）。

### 本轮补修（CI 自修改工作流遗漏）

- **e2e 断言漂移（必修）**：`packages/web/__tests__/e2e/session-routing.test.ts:33` 仍断言导航项 `会话 Sessions`，但 Sidebar 已改名 `受控交付`（`Sidebar.tsx:27`）——真实浏览器必然超时失败。已改为 `受控交付`。根因：`pnpm test`（vitest）`exclude: __tests__/e2e/**`，Playwright 漂移逃过 CI `pnpm test` gate。已 `git stash` 对比证明 committed 状态该 e2e 确实失败、修复后通过。
- **测试覆盖缺口**：`event-feed.test.ts` 补 `readiness-evaluate→准备度检查`、`delivery-auto-prepare→交付材料准备` 两条 automation 子分支断言（mutation 反证为真锁）。
- **手册文案漂移**：`docs/manual/tekon-user-manual.md` + `.html` 的「当前边界」提示仍写「从会话输入框『开始会话』发起」，但该 Composer CTA 第五轮已改名 `启动受控交付`（README 已同步、手册漏改）。已同步两份手册。

### 复审结论

- 保留自动应用的 run/automation 分离 + session 身份幂等 + enqueue 绑定校验；补修上述 2 处。
- **诚实递延（交用户决策）**：单-vs-多 owner 架构决策、PRODUCT-P0 产品主闭环（真流式/follow-up-steer/双轨）、PR 拆分——延续前五轮，属已披露里程碑 / 架构方向，非本轮缺口。

## v0.14.4

第五轮全面复审（`docs/reviews/2026-08-26-tekon-harness-replatform-fifth-review.md`）循环评估后的收敛修复。报告确认第四轮 F4-P0-02/03/05 已正确闭环，并提出一个不依赖租约过期的正常路径新阻断。经动态 workflow（F5-P0-01 首审 + 对手方复核 + 三线取舍 + 首席综合）+ 独立 code review 复核收敛。

### 并发正确性修复

- **F5-P0-01（CONFIRMED / High）：并发 resume 重复 active job**。`resumeRun` 的 `findActiveByRunId`（裸 read，不在事务）与 `enqueue` 之间无临界区，`sessions.run_id` 非 unique、`jobs` 无 per-run active 约束，CLI 与 web 各开独立 SQLite 连接 + 各自 WriteQueue（仅单进程串行化）。两并发 resume 可都见"无 active job"→各 enqueue → 同一 run 被两 executor 真跑（双 agent 花费 + 两 worktree `git branch -f` 提升到同一 run 分支冲突/覆盖）。第四轮的 workflow 终态 CAS 只护"状态"、不护"执行"。
  - **修复**：新增 `JobRepository.enqueueIfNoActiveByRunId`，把 active-check + insert 收进一个 `BEGIN IMMEDIATE` 事务（复用 `appendEvent` 已验证的跨进程临界区范式，`busy_timeout` 处理短竞争），冲突返回既有 active job 不二次 insert。`DurableJobRunner` 加同名包装；`SessionService.resumeRun` 与 `gate.approve`（第二个并发 resume 入口，同有此竞态）均改用原子方法。
  - **否决"仅 sessions.run_id unique"**：paused run 必有既存 session、resume 跳过 createSession，该约束对主导案例零保护；事务方案是根因修复。
  - 新增测试：顺序 re-check 真锁（移除 in-tx re-check 即 fail）+ 两连接 file-db 集成断言（诚实标注 better-sqlite3 同步单线程无法进程内制造真交错，原子性由 BEGIN IMMEDIATE 保证）。

### 复审结论（追加到第五轮报告实施方批注）

- **确认第四轮 F4-P0-02/03/05 已正确闭环**；确认本轮已提交的 a11y 改动（EventFeed `role=log`、SessionComposer `aria-*`/`role=alert`、RunControls `role=group`+中文标签、SessionDetailPage `aria-atomic`+landmark + e2e）正确无回归。
- **诚实递延（交用户决策）**：F5-P0-02/03/04/05 ≡ 第四轮 F4-P0-01/03/05/04 递延项的重述+扩展，报告自述其必要性取决于"单 owner daemon vs 完整 multi-owner"架构决策（单 owner 下非必需）——属架构方向，非无条件 bug；§6.2 visibility/modelVisible 死枚举（无运行后果）、§6.5 Workspace/Project、§7 PR 拆分/单 owner ADR 为架构/过程建议；PRODUCT-P0-01/02/03（真流式/follow-up-steer/双轨）为前四轮已披露里程碑。

## v0.14.3

第四轮全面复审（`docs/reviews/2026-08-25-tekon-harness-replatform-fourth-review.md`）循环评估后的收敛修复。本轮报告不同于第三轮的正则分析器产物，是一份扎实的架构级复审并主动纠正了第三轮误判。经一个动态 workflow（5 项 F4-P0 各由「首审 + 对手方复核」两个最高思考等级 subagent 独立回代码核验 + 交叉印证 + 三线取舍 + 首席综合，共 12 个 agent）+ 独立 code review 复核收敛。

### 并发正确性修复（真实低成本缺口，与既有 ownership fencing 一致）

- **F4-P0-02（CONFIRMED）**：`workflow/engine.ts` executePlan 的两处裸 `if(signal.aborted){settleCancelled}`（节点边界 + 全节点完成后）加 `isJobOwnershipLostAbort` 分类。此前被 fence 的旧 worker 会在 plan 边界把新 owner 仍在执行的 run 写成 `cancelled`（终态 CAS from=running 合法），新 owner 随后写 `passed` 撞终态抛错、交付被丢弃。现 ownership-lost 站队不写共享 workflow 行，仅用户 cancel 才 settle `cancelled`。
- **F4-P0-03（成功路径守卫）**：`workflow/node-executor.ts` 成功路径 `finalizeExecutionLease` 之前加 ownership-lost 守卫 stand down。此前守卫只在 catch 里，finalize 成功时 fenced 旧 worker 会 commit + `promoteLeaseToRunBranch`（`git branch -f` 无 expected-old-SHA CAS）静默覆盖新 owner 已推进的交付分支。
- **F4-P0-05（终态单调守卫）**：`workflow/node-executor.ts:133`（stale-running 写 interrupted）与 `:159`（resume-at-gate 写 running）由无守护 `updateWorkflowInstanceStatus` 改用 `updateWorkflowInstanceStatusIfActive`，堵住回退他人已 settle 的终态；合法路径行为不变，零新增 API。

新增两条真锁回归测试（`engine-recovery.e2e.test.ts`：plan 边界 fence 不写 cancelled；成功路径 fence 时 spy worktreeManager 的 commit/promote 零调用），已验证移除对应守卫即 fail。

### 复审结论（追加到第四轮报告实施方批注）

- **确认报告 §2 主动纠正第三轮误判准确**（写前脱敏 / Goal fail-closed / 响应式断点已存在 / delivery approval 降级），是有良好信誉的复审。
- **确认本轮已提交的两处 §3 源码改动无回归**：RunControls 图标按钮补 `aria-label`、SessionComposer 文案改为诚实描述 standard-delivery 全链路。
- **诚实递延（已披露，交用户决策）**：F4-P0-01（jobs 写 owner 谓词）、F4-P0-04（stop() 两阶段 quiesce）、F4-P0-03 的 `--force-with-lease`、F4-P0-05 的 node 行 CAS——均为触发需 ≥30s 心跳饥饿的尾部竞争或无正确性后果的资源泄漏；§6.4 RunControls 控制真源、§6.3 更丰富 Final Result 为增量增强；产品主闭环 PRODUCT-P0-01/02/03（真流式 / follow-up-steer / 双轨）为里程碑级能力，前三轮已披露。

## v0.14.2

第三轮复审循环评估后的收敛。第三轮报告由 `scripts/run_third_comprehensive_review.py` 正则静态分析器生成（逐行匹配使 `re.S` 失效，系统性误报）；两个最高思考等级 subagent 独立核验 + 交叉印证后，仅采纳其中唯一被证实的真实低成本缺口（UX-01 可访问性），并推翻多处误报。

### 可访问性（第三轮 UX-01，两个 reviewer 共识确认的真实缺口）

- **live region**：`SessionDetailPage.tsx` 连接状态 `.session-conn`、`EventFeed.tsx` 空态 `feed-empty` 加 `role="status" aria-live="polite"`，使连接状态（连接中/实时/重连中/已关闭）与"等待事件"对屏幕阅读器非打断式可感知。新增 Playwright 断言锁定该属性（已验证移除即失败）。
- **reduced-motion**：`reset.css` 补全局 `@media (prefers-reduced-motion: reduce)`，压制 `pulse`/`viewFadeIn`/`flashSlideIn`/`overlayFadeIn` 等动画与 `transition`/`animation`/`scroll-behavior`（含 delay），尊重系统减动画偏好。

### 复审结论（追加到第三轮报告实施方批注）

- **推翻误报**：REG-01（称 durable event redaction 回归）——F-08 脱敏完整存在 `agent-step-events.ts:41/:107` 且测试全绿，分析器逐行匹配漏检；P1-04（称 bootstrap nonce 已闭环）——nonce 从未实现，分析器 `open\s*\(` 误匹配 React `setIsOpen`；CODE-01——分析器扫到自己脚本的正则字符串；UX-01 响应式降级——`sessions.css:73-77` 已有窄屏单列降级。报告 §4 声称的 aria-live 改动从未提交到分支。
- **维持已披露的诚实递延**：P0-01/02/03、P1-01/02/03/05/06 均为报告 §10 里程碑级产品能力，前两轮已在 README/manual 诚实披露"未开放/迁移期 projection/仅长驻进程/审批未绑内容指纹"，本轮无新动作。P0-04 goal 治理已闭环（fail-closed，属实）。

### 清理

- 删除本轮评审的一次性自动化脚手架：`scripts/{run_third_comprehensive_review,apply_third_review_fixes,repair_third_review_script}.py` 与 `.github/workflows/{third-comprehensive-review,apply-third-review-fixes}.yml`。原因：`apply-third-review-fixes.yml` 由 push 触发、持 `contents:write`，仅以 commit message marker 作弱 gate 即自动运行 923 行分析器脚本改码提交，风险面大于收益；脚手架已完成一次性用途，审计产物（第三轮报告）保留在 `docs/reviews/`。

## v0.14.1

第二轮全面复审（`docs/reviews/2026-08-25-tekon-harness-replatform-second-review.md`）循环评估后的收敛修复。经两个最高思考等级 subagent（验证 F-01~F-09 修复真实性 + P0/P1 逐条取舍）+ 交叉复核，按报告 §11「方案 1」以基础设施里程碑推进：修复一处必修回归、补两处 fake-pass/脱敏红线测试锁、诚实披露产品边界。

### 修复（必修，正确性红线）

- **修复 F-01 引入的终态单调性回归（High）**：`node-executor.ts` 三处 ownership-lost 分支（预 agent / finally / catch）此前用无守卫的 `updateWorkflowInstanceStatus('interrupted')` + `transitionNode('interrupted')` 写共享 node/workflow 行。当一个僵尸 worker 被新 owner fence（job 已被 recoverStale 重领并写 `passed`）时，其 abort 收尾会把新 owner 的终态 `passed` 回退成 `interrupted`，破坏终态单调性。
  - ownership-lost（`isJobOwnershipLostAbort`）分支现**完全跳过共享 node/workflow 写入 + 不 finalize lease**，仅清理自身 `role_run` 后 stand down（新 owner 权威；避免僵尸 finalize 把半成品 promote 到共享 run branch）。
  - 新增 `repositories.updateWorkflowInstanceStatusIfActive`（条件 UPDATE：`status not in ('passed','failed','cancelled')`）；真正的中断（非 fence）写 `interrupted` 也经此守卫，绝不覆盖终态。
  - **首轮 code review 追加检出 M1/M2/M3**：同一漏洞在 agent 成功后的路径仍有裸写——gates catch、finalize catch（`node-executor.ts`）与 gate-runner repair/exhausted 写入（`gate-runner.ts`）。已补 ownership-lost stand-down：gate-runner 新增 `getSignal()` dep，在 gate 失败后、repair 循环每轮、exhausted settle 前三处 fence 检查；node-executor gates/finalize catch 加同构守卫。
  - **次轮 code review 追加检出 S6**：gate-runner repair 循环的 `finally` 在 fence 下仍无条件 `finalizeExecutionLease`，会 `git branch -f` 强制把僵尸 repair worktree promote 到 run branch、回退新 owner 已交付的分支（git 层代码丢失，与 S1 同源）。已加 fence 守卫跳过。rework.ts 同类 finalize（S7）、repair 成功后回写主节点的极窄窗口（S8）不回退 workflow 终态，记录为后续。
  - 回归测试：`engine-recovery.e2e.test.ts` 新增「被 fence 的执行器不得回退新 owner 的终态」（agent throw 路径）与「gates 阶段被 fence 不得回退终态」（agent 成功 + gate 阶段 fence，覆盖 M1/M2/M3 的 (a) 检查）；`engine-gate-repair.e2e.test.ts` 新增「repair 阶段被 fence」（autoFix gate 持续失败驱动 repair，覆盖 repair-loop (b) + exhausted-settle (c) 检查）；`repositories.test.ts` 新增守卫单测。均已验证移除守卫即失败，非假通过。

### 测试（补红线锁）

- **F-04 fake-pass 锁**：`workflow-job-executor.ts` 加 `engineFactory` 测试注入 seam；`automation-job-executor.test.ts` 新增「engine 返回非终态 → job failed + `agent/error`（不静默映射 done/idle）」，并已验证反向（default 分支改回 done）会令该测试失败。
- **F-08 写前脱敏锁**：`agent-step-events.test.ts` 新增「durable `step/start` promptSummary 与 `agent/error` 消息在写入前脱敏」两条断言。

### 文档（诚实披露产品边界，方案 1 前提）

- README 新增「当前边界与实验性特性」章节；`docs/manual/tekon-user-manual.md`（及 `.html`）同步披露：默认发起=`standard-delivery` 受控交付全链路、Session feed 非完整模型 streaming、follow-up/steer 未开放、event log 为迁移期 best-effort projection（旧表仍是事实源）、automation 仅长驻进程内触发、交付审批记录未绑定内容指纹、goal 模式为实验性且默认拒绝源码改动、workspace 为单项目占位。
- 复审报告追加「实施方批注」：逐条 P0/P1 事实核验 + 本轮/递延处置；其中 **P0-04 判定为描述不准**（goal 改源码会被 `finalizeExecutionLease` fail-closed 拒绝，已有单测，不 promote），**P1-05 判定非安全洞**（create-pr 始终要求当次人工批准）。

## v0.14.0

Harness-inspired replatform 阶段 5：**legacy 清理（5a）+ Harness bridge（5b）**。5a 移除已废弃的 `demand.*` 兼容别名层;5b 新增 experimental 的 `dsh-headless` provider——经 `dsh --profile headless "<task>"` 子进程边界接入 DeepSeek Harness,默认关闭、零回归面。

### 新功能（5b：dsh-headless provider，experimental，默认关闭）

- 新增内置 provider `dsh-headless`(`packages/core/src/runtime/dsh-headless-adapter.ts`):经 `dsh --profile headless "<task>"` 一次性子进程边界执行(argv → stdout/stderr/exit-code),实现 `AgentAdapter`,插入既有 provider-registry。默认 provider 仍是 `codex`,不选即完全 inert(不 spawn、不探测)。
- **版本 pin + capability probe**(`dsh-bridge-probe.ts`):钉死 `TESTED_DSH_VERSION='0.1.1-rc.2'`;运行时首个 real-dsh run 前 spawn `dsh --version` 精确比对,不符抛 `DshVersionGateError` 显式失败(escape hatch `allowVersion` 放行 + warning);capability probe 校验 headless `--help` stdout 契约锚点与 `--dump-default-config` 必需插件 id 集。
- **contract test 三层**:L1 fixture 契约测试(2026-08-25 实测 `--version`/`--help`/`--dump-default-config` 存为 fixture,CI 常驻);L2 live probe(`DSH_CLI_PATH` 未设置即 skip);L3 live run(发布 checklist 手动,需 `DEEPSEEK_API_KEY`)。
- provider 枚举扩展 `'dsh-headless'`:`config.ts`(×2)、`domain.ts`、`eval/work-usability.ts`、`agent-adapter.ts`、`agent-runtime.ts`(SupportedAgent/错误信息/defaultProviderConfig/restore 白名单)。

### 治理与诚实边界（5b，据探针实测 + 用户知情决策）

- **网络出口不受限,弱于 codex(诚实标注,非等价)**:探针经 4 处官方 README 实证 dsh 沙箱只管文件写效果,任何模式都无法禁网;codex `workspace-write` 默认禁网。用户知情后决策"接受 dsh 网络出口"。工程落地:permission profile **诚实声明 `network: 'enabled'`**(绝不谎报 `restricted`);能力护栏 `assertAgentProviderCapabilities` 仅对 `provider==='dsh-headless' && acknowledgeUnrestrictedNetwork===true` 放行 `enabled`——全局护栏对 codex/claude 与误配 dsh 仍 fail-closed,弱化仅在显式确认下对 dsh 单一 provider 生效。
- **仅 goal / 无产物节点可用**:dsh 单一工作区可写根(=cwd),无 codex `--add-dir` 等价机制,无法写 worktree 外产物目录 → standard-delivery 等交付类 workflow 每个产物节点确定性失败(mirror 现有 `missingRequiredArtifactTypes` 强制,不假成功)。manual 第一屏红字标注。
- **护栏**:`DSH_PERMISSION_MODE=workspace-write` 显式钉死(不继承 ambient,envMode='exact' 子进程只拿显式 env);拒绝 `danger-full-access`;拒绝所有 launcher flag(`--profile`/`--patch`/`--dump-*`/`--version`/`web`/`plugin`,与 codex arg 白名单对称);`DSH_HOME` 钉到 **worktree 之外**的 per-run 隔离目录(`<dataDir>/runs/<runId>/<nodeId>-dsh-home`,agent 沙箱工具无法跨 run 污染 dsh profile/session,不碰 `~/.dsh`);`dsh` 已加入 `defaultCommandPolicy` allow 列表(与 codex/claude 对称);`DEEPSEEK_API_KEY` 仅存在时透传,不写入任何持久化(snapshot configSummary 脱敏,测试断言);版本 escape hatch `TEKON_DSH_ALLOW_VERSION` env 接线(放行未测版本 + stderr warning)。
- 不加任何 npm 依赖(与 codex/claude 先例一致,PATH 探测);用户自行安装 `@deepseek-ai/dsh`。

### 移除（5a，breaking：仅影响直接调用已废弃别名的外部集成）

- **`demand.*` RPC 别名删除**:`rpc-contract.ts` 移除 3 个 `demand.*` procedure(`demand.shape`/`demand.approve`/`demand.detail`)与 6 个别名 schema;`root.ts` 移除 `demand: demandRouter` 挂载(保留 `draftShape: demandRouter`,同一实现);`context.ts` 移除 `ApiCaller.demand`。所有能力经 `draftShape.*` 命名空间提供,行为等价。
- **`demand*` 核心别名删除**:`packages/core/src/draft/shape.ts` 移除 13 个 `@deprecated` `demand*` 兼容导出;`packages/core/src/demand/shape.ts`(纯 re-export 垫片)删除。
- **CLI `demand` 命令别名删除**:`index.ts` 移除 `aliases:['demand']` 与 `case 'demand'` 分派;内部 `demand*` 标识统一 rename 为 `draft*`(draft.ts/eval.ts/run.ts/workflow.ts/path-utils.ts,约 36 处),CLI 用户面命令 `tekon draft ...` 不变。
- **Web `Demand*` 组件别名删除**:`DemandForm.tsx`/`DemandShapeCard.tsx`/`DemandPage.tsx` 删除;`DraftForm`/`DraftPage` 移除 `DemandForm`/`DemandPage` 兼容别名导出。`AcceptanceCriteria.tsx` 保留(DraftCard 在用)。

### 行为变化

- runner 自发的 `job/status` session_event 归入 `CONTROL_EVENT_TYPES`:S9 会话-run 事件对账排除该类型,只对 §1.2 映射类型做计数相等断言(runner 生命周期事件不参与 run 事件计数)。

### 测试

- 5a core:`demand/shape.test.ts` 删除(对应 shim 已删);`types/session-contract.test.ts` +1(`job/status` ∈ CONTROL_EVENT_TYPES)。
- 5b core:`dsh-bridge-probe.test.ts`(13,版本解析/gate/help+config 契约)、`dsh-headless-adapter.test.ts`(27,命令构造/launcher flag 拒绝/网络 ack 护栏/danger-full-access 拒绝/结果映射四终态/版本 gate 接线四态/env 钉死+DSH_HOME worktree 外+key 透传/goal-only artifact 失败/零 spawn 回归锁)、`dsh-bridge-contract.test.ts`(L1 fixture 常驻 + L2 opt-in skip)、`provider-registry.test.ts`(+四 built-in + dsh snapshot 往返 + ack 剥离 fail-closed)、`engine-unit.test.ts`(+dsh ∈ defaultCommandPolicy 回归锁);`agent-runtime.test.ts` 错误信息断言同步。
- 全量根聚合 1275 passed(110 文件)/ 三包 typecheck 全绿。5a 别名删除后无残留公开别名引用(全仓 grep);5b 不选 dsh 时零 spawn(gateway spy 锁定)。

## v0.13.0

Harness-inspired replatform 阶段 4（4d–4f）：把 `sessions.profile` 从纯展示字段变成**真实行为分支**（4d），把 Gate/Delivery 生命周期做成**事件订阅 + readiness 投影**（4e），并给需求卡加上**独立的计划产物与计划审批点**（4f-2）。三者各自独立可交付，且共同守住同一条红线——高自治可以自动准备交付，但**合入、PR 创建、人工审批 gate 仍须人工**，不因 profile 削弱。

### 新功能

**profiles 策略层（4d，autonomous-delivery 自动准备交付，红线不越）:**
- 新增 `packages/core/src/session/profile-policy.ts`（纯函数，无 IO）：`SessionProfile = 'human-web' | 'autonomous-delivery' | 'review-only'`；`canAutoPrepareDelivery`（仅 autonomous-delivery 为真）、`canMutate`（review-only 为假）。
- `project.run` 接受显式 per-run `profile`（`human-web` | `autonomous-delivery`；自治永不被推断）；Web StartRunForm 加 Profile 下拉。省略时回落组合根默认 `human-web`。
- autonomous-delivery 的真实新自动化：run 抵达 `passed` 时，组合根 listener 查 session profile，为真则 enqueue `delivery-auto-prepare` job——打包证据 + 写 `prepared` 行 + 发 `delivery/prepared`，**绝不创建 PR**（治理红线）。仅长驻服务（Web/headless）接线；CLI 跑完即退出，不接此自动化。
- **executor 隔离（M1）**：自动化 job kind（`delivery-auto-prepare`、`readiness-evaluate`）走独立轻量 executor（`createRoutingJobExecutor` 按 job kind 派发），绝不触碰 workflow/session 终态；自捕获错误（发 `agent/error`、返回 failed，绝不抛出污染 run 状态）。
- review-only：`canMutate` 原语已备并测，但**入口尚未接线**（发起 run 本身即是 mutation，当前无只读入口）；review-only 未纳入 `project.run` schema，避免装饰性 guard。enforcement 待专门只读入口设计。

**Gate/Delivery 事件订阅（4e）:**
- `event-bus.ts` 加 `subscribeAll(listener)` + `SessionEventBusOptions.onError`，publish 内 `safeInvoke` try/catch 隔离——单个 listener 抛错不再中断 fan-out 或传播给 publisher。
- readiness 投影：gate result 落库时（`gate/result` 事件）**或人工决策落定时**（`approval/decided` 事件）按 session 去抖 500ms 后 enqueue `readiness-evaluate` job，评估 pre-PR readiness 并发 `readiness/evaluated` 事件，UI/交付无需轮询即可反应（订阅 approval 事件使报告 §10「readiness/approval events」名副其实——审批改变 gate 状态后投影不再陈旧到下一个 gate/result）。新增事件类型 `readiness/evaluated`。
- `createPr` 幂等：分支断言后查 `delivery_pull_requests`，已 `created` 且有 prUrl 直接短路返回，重复调用不再重复建 PR。

**需求卡计划产物 + 独立计划审批（4f-2）:**
- draft shape schema 加可选 `hasPlan` / `planApproved` / `planApprovedBy` / `planApprovedAt`（`.strict()` 下加已知可选字段不影响旧 draft 文件读取）。
- `markDraftPlanGenerated`（显式生成计划产物，置 `hasPlan=true`；重新生成使旧计划审批失效）+ `planApproveDraftShape`（独立计划审批，未生成计划则抛错）。`approveDraftShape`（需求审批）**不触碰** `planApproved`——两审批正交。
- 新 RPC `draftShape.generatePlan` / `draftShape.planApprove`；新 CLI 子命令 `tekon draft plan` / `tekon draft plan-approve`。
- **`project.run` 与 CLI `run` 双侧门控（非装饰）**：`hasPlan && planApproved !== true` → 拒绝。语义：**已生成计划的需求卡必须先计划审批才能 run**；**未生成计划的需求卡（含所有旧 draft）恒豁免**，既有 approve→run 路径零破坏。

### 行为变化

- `sessions.profile` 不再是纯展示：`autonomous-delivery` 会在 run 通过后自动准备交付（不创建 PR）；其余 profile 行为不变。
- 已生成计划（`hasPlan`）的需求卡：`tekon run` 与 Web 发起运行在计划审批前一律拒绝。未生成计划的需求卡不受影响。

### 已知边界（诚实标注）

- **4f-1（澄清事件化）递延**：澄清发生在 run 前、session 尚未创建，`clarification/*` 事件挂靠哪个 session、draft 与 session 如何绑定是独立设计问题，不在本轮范围。与 4e 旁路 gate、4d review-only enforcement 同属"原语已备、消费入口待专门设计"的诚实收窄。
- 旁路 gate（schema-only 放开）在 4e 递延——复用 stableGateKey / 写前查 latest / 过滤 human gate 的机制已在设计中定稿，实现单列。
- auto-prepare 仅长驻服务特性；CLI 显式 `delivery prepare` 不变。CLI 未提供 `--profile` 标志（M2 决策下它对 CLI 行为惰性，会是装饰性标志）——CLI 自治交付通过 `tekon delivery prepare` 显式进行。

### 测试

- core：`profile-policy.test.ts`（5）、`automation-job-executor.test.ts`（6，含 M1 跨进程路由隔离 / M1 同进程隔离 / goal-skip / delivery-ready 自动 prepare 只到 prepared 不 created / S2 保留人工审批 / 幂等）、`event-bus.test.ts`（+3 subscribeAll/onError 隔离）、`scm.test.ts`（+1 createPr 幂等 + dry-run 尊重调用方）、`types/session-contract.test.ts`（+1 readiness/evaluated）、`draft/shape.test.ts`（+2 计划生成/审批正交 + 重新生成使审批失效）。
- web：`project-run-job.test.ts`（+3 autonomous auto-prepare vs human-web 不 prepare + gate/result 去抖 readiness 链路）、`write-auth.test.ts`（+3 计划审批门控 + 向后兼容旧 draft 仍 run + plan-approve 无计划报 400）、`gate-approve-async.test.ts`（+1 approval/decided 触发 readiness 投影）。
- CLI：`cli-flow.test.ts`（+1 e2e：draft plan→plan-approve 门控 + 旧 draft 无计划仍 passed）。
- 全量根聚合 1229 passed（108 文件）/ Playwright 11 passed + 5 flaky-then-pass（与 v0.12.0 基线一致）/ 三包 typecheck 全绿。

## v0.12.0

Harness-inspired replatform 阶段 4（4a–4c）：把 run 编排收敛为**共享 Session API**，让 CLI 与 Web 走同一条 `SessionService` + 后台 Job 路径；并把 workflow 从"唯一入口"降级为可选的 goal plugin。分阶段是纪律不是打折——4d–4f（profiles、Gate/Delivery 事件订阅、Demand→澄清/plan）单列后续设计，不在本次范围。

### 新功能

**SessionService + executor 移入 core（4a，零行为漂移）:**
- 把 web project router 的 run/resume/cancel/pause 编排抽成 `packages/core` 的 `createSessionService`，`workflow-job-executor` 一并从 web 迁入 core。web 组合根经 `createWebRunEngineFactory` 注入 provider/adapter 构造，router 只保留鉴权/ApiError/redaction/清洁基线断言等 web 专属校验；服务层用判别式 outcome（非抛错）回传校验失败，鉴权与错误映射仍归 router。

**workflow 降级为可选 goal plugin（4b）:**
- 新增内置单节点 `goal` 模板 + `goal` 角色：`governance: none` 仅豁免"必须有 reviewer 节点"这一条白名单不变量，其余模板不变量照常。goal run 是一次轻量 Agent 目标，不产出 code-changes、不接交付流程。
- `workflow_instances` 新增 `kind`（`workflow`|`goal`）列（默认 `workflow`，零迁移风险）；`run.started`/`run.resumed`/`run.passed` 审计与 dual-write 事件按 run 真实 kind 派生。
- 未知 job kind 显式 `throw`→job failed，绝不回落到空 plan 静默写 `run.passed`（§0.3 硬约束）。

**CLI 会话化（4c）:**
- `tekon run` / `tekon resume` 改走 `SessionService` + 内嵌 job runner，产生 session（profile=`cli`）、会话事件与 dual-write 投影，与 Web 共享同一 Session API。"跑完即退出"语义不变：await job 终态后重读 **workflow 状态**再退出，退出码依 workflow 终态派生。
- `tekon run --goal`：CLI 侧发起轻量 goal 运行（与 `--template` 互斥）。
- `tekon pause` / `tekon cancel` 改走 job runner 治理路径：真正杀子进程（`requestCancel → registry.killAll`），不再只改 DB 状态。
- 跨进程治理（M2）：`requestPause` 跨 owner 持久化 `status='paused'`；CLI 持有方在 `awaitJobTerminal` 轮询里观察自身 job 行——见 `cancelling`→`requestCancel`（abort+killAll）、`paused`→`requestPause`（仅置 in-process pauseFlags，绝不 abort，否则 run 会 settle 成 cancelled 而非 paused）。防"cancel 被吞、run 假 passed"的根本护栏是 `writeWorkflowTerminal` 首步 CAS（与谁持有 run、观察是否及时无关）。

### 行为变化

- `run_provider_config` 快照不再承载 run 级执行策略；`allow-dirty-base` 作为 run 级策略持久化到 `workflow_instances.allow_dirty_base`，后台 Job executor 重建引擎时回读该策略——修复"CLI run 走异步 Job 后 `--allow-dirty-base` 丢失导致 dirty 基线 run 失败"的潜伏缺陷。
- `resumeRun` 守卫顺序修正：**先判终态**再判 pending 决策——cancelled/passed/failed 的 run 即便残留 pending 决策也一律报"终态"（CLI → 退出码 1 + "终态"提示），不再误报"存在待审批"。
- `tekon resume --approve-human` 对齐 web `gate.approve`：批准单个决策后驱动 run 前进，不再因**其它**未决决策被 pending 守卫挡回（引擎会在下一个人工 gate 处重新暂停）；裸 `tekon resume` 仍保留 pending 守卫。

### 已知边界（诚实标注）

- 取消链完整仅保证 **CLI 持有方**（同进程 SIGINT / CLI await 观察循环）；CLI 取消一个 **Web 持有**的 run 时，workflow 状态经 CAS 护栏诚实变 cancelled，但 Web 侧 Agent 子进程会跑到引擎下次终态写入抛错才停（可能空耗剩余节点 token）。消除此空耗需把同一观察 hook 加进 web jobRunner，列为后续。
- goal run 默认不接 delivery（standard-delivery 的 pre-PR readiness 检查对 goal 恒 false）；权威硬 guard 是**服务端** `assertPrePullRequestReady`（goal run 恒红、无法创建 PR）。UI/CLI 层的 delivery 入口尚未按 kind 收窄（Delivery tab 与 `tekon delivery` 对所有 run 无条件可见），纵深防御的 UI/CLI guard 待后续补齐——治理不退化由服务端保证。
- 4d（profiles）、4e（Gate/Delivery 事件订阅）、4f（Demand→澄清/plan flow）单列后续设计，不在本次范围。

### 测试

- core：`session-service.test.ts`（startRun 建 session/绑 runId/发三事件/enqueue 正确 kind；resume 守卫顺序 + afterApproval；cancel writeWorkflowTerminal 首步 + terminalConflict）、`job-runner.test.ts`（requestPause 跨 owner 持久化 / 队列态不搁浅 / 幂等）。
- CLI：新增 goal 路径（run→passed + kind=goal）、cli-profile 会话产生断言、`--goal`/`--template` 互斥、`awaitJobTerminal` 观察循环（paused→requestPause、cancelling→requestCancel、终态直返、job 消失抛错）；既有 cli-flow e2e 的"状态: passed/paused"+ 人工确认断言在异步 Job 路径下继续通过。
- 全量根聚合 1201 passed / Playwright 16（11 clean + 5 flaky-then-pass）/ 三包 typecheck 全绿。

## v0.11.0

Harness-inspired replatform 阶段 3：Human-first Session UI。第一次把已在事件流里的会话事实（阶段 1/2 的 session/turn/step/tool/assistant/治理事件）接到**客户端**，形成连续叙事交互。默认路由 `/` 改为 Session UI；旧 run-centric Cockpit 完整保留在 `/advanced/*`（双轨并存，零删除）。

### 新功能

**会话读路径（报告 §10 阶段 3，3a）:**
- core `SessionEventStore.listSessions(workspaceId)`：按 `created_at desc, rowid desc` 稳定排序的纯 SELECT（零迁移），返回 `SessionListEntry`（Session + run_id 列）。
- web `session.list` / `session.get` RPC（`auth:'session'`）：`session.list` 无客户端入参，服务端经 `getOrCreateDefaultWorkspace(projectRoot)` 解析 workspace 并回传 workspaceId；`session.get` 经 `getRunIdBySessionId` 组合 runId（不改冻结 Session 契约）。事件本身走既有 SSE 端点（初始快照 = `sinceSeq=0` replay），不新增 `session.events` RPC。

**SSE 客户端 + 实时会话（3a/3b/3d）:**
- `lib/session-stream.ts`：`fetch` + `ReadableStream` 手写 SSE 客户端（非 `EventSource`——后者无法设置 `x-session-token` 头，query-param token 会泄漏进日志）。纯函数 `createSseParser`/`mergeEventsBySeq`/`lastEventId` 单测覆盖（半包/心跳/CRLF/去重/seq 单调/Last-Event-ID）；断线指数退避重连 + `Last-Event-ID` 续播（服务端 0..k∪k..end 拼接零丢失/零重复）。
- `use-session-stream` hook：live 累积 + `connState`（连接/实时/重连/关闭）+ 状态翻转事件 invalidate `session.list`。

**三栏 Session UI（3b/3c）:**
- Session 列表（`/`）+ composer（起新 run；不注入运行中消息——follow-up/steer 递延 2b）+ workspace 只读占位（顶栏显示 `session.list` 回传的默认 workspaceId，多 workspace 管理递延后续阶段）。
- Session Detail（`/sessions/:id`）：中栏 event feed（`describeEvent` 把 15+ 事件类型映射为连续叙事，按 turn 分组，合成 assistant 标"摘要"、截断标"已截断"，未知类型降级不崩）；右栏 = 运行控制（复用 RunControls）+ inline 审批（复用 DecisionCard，上下文从 `gate.list` 补全，approve/reject 走既有 `gate.approve/reject`，治理语义不变）+ tool/artifact/error 卡片 + run 达终态后的 final-result 收尾卡（终态状态 + artifact/error 计数）。

**token 接线修复（3a，顺带还债）:**
- `AuthProvider` 同步 `setRpcSessionToken`：修复 `auth:'session'` 读 RPC 在生产中因 token 头从未发送而全部 401 的预存缺陷（此前仅被 e2e fetch 猴补掩盖）。补 HTTP 层 200/401 测试（不经猴补）防假绿。

### 行为变化

- 默认路由 `/` 从旧 Dashboard 改为 Human-first Session UI；旧 Dashboard/Runs/Run-detail/Approvals/Delivery/Draft/Config/Eval 全部移到 `/advanced/*`（保留不删，报告 C2）。侧栏新增"会话 Sessions"（默认）与"高级 Advanced"两个入口。

### 已知边界（诚实标注）

- `assistant/message` 仍是产物元数据合成（非模型原文，阶段 2 M3）；feed 显式标"摘要"。真正逐块流式 `assistant/chunk` 递延 2b。
- composer 不支持运行中 follow-up/steer（`AgentHandle` 相应方法在 2b 才实现，现抛 `NotSupportedYet`），UI 诚实提示。
- 写操作（inline approve/reject）需在顶栏输入会话令牌（服务端校验请求体 token）；只读会话浏览在配置了令牌后即可。
- workspace picker 为只读占位（当前单默认 workspace）；多 workspace 管理递延后续阶段。diff 卡片本阶段不做（会话事件流无 diff 数据源；diff 在 delivery 投影里，随阶段 4 delivery 事件订阅补 diff 事件后再做）。

### 删除

- 删死代码 `hooks/use-run-poller.ts`（无消费者；实时更新由 SSE 取代）。

### 测试

- 新增 core `listSessions`（3）、web api `session-read-api`（4，含 M1 HTTP 200/401 防假绿）、client `session-stream`（11 解析器/reducer）、`session-stream-reconnect`（7 断线重连/Last-Event-ID/致命状态 400·401·403·404 不重连/503 重试）、`event-feed`（13 事件映射/turn 分组）、`session-side-panel`（15 右栏派生/终态状态/final-result 卡）。
- 新增 Playwright：`session-feed`（2，真实 mock-agent run→建流→replay→live→feed 有序）、`session-approval`（1，human-gate run→inline 卡片→两步批准→gate.approve→清空）、`session-routing`（1，`/`=Session UI、`/advanced`=旧 Cockpit 保留）。
- e2e fixture 新增 `feature-approval.yaml`（human gate 模板）；既有 12 Playwright 路径同步到 `/advanced/*`。
- 提交前全量 `pnpm test` 通过：core 894 / web 235 / cli 37 / 聚合 1166 + Playwright 11+5-flaky-then-pass（含 code review 修复的 +12、报告完整性终审的 +3 单测）。

## v0.10.0

Harness-inspired replatform 阶段 2（2a）：流式 Agent Loop 兼容层 + Provider Registry + Snapshot 版本契约 + 会话事件词汇补齐。让**真实 agent 产出**（每 node 的 step/tool/assistant 事件）进入会话事件流，并可从 event log 重建模型可见历史（报告 §13.6）。无 breaking change，事件为向后兼容的加法。

### 新功能

**Provider Registry（报告 §P1-02）:**
- 新增 `provider-registry.ts`：`ProviderDefinition`/`ProviderRegistry`/`createBuiltInProviderRegistry`，照搬 gate registry 范式；`createAgentRuntime`/`createAgentAdapterFromSnapshot` 改为委派 registry，删除两处重复 if/else（签名与行为不变，CLI/Web 构造路径回归锁定）。能力护栏 `assertAgentProviderCapabilities` 仍在 adapter 工厂内，registry 未绕过。

**Provider Snapshot 版本契约（报告 §10 阶段 2）:**
- `ProviderSnapshotVersionError` + `schemaVersion`（存于 config_summary JSON，零迁移）：缺省=1（旧快照兼容），高于当前版本抛错，防 provider 升级静默破坏 replay/resume。

**Agent Loop 事件桥（报告 §8.3/§8.4/§P0-04 桥接部分）:**
- 新增 `agent-step-events.ts`：`runAgentWithStepEvents` 单一拥有 `step/start → (tool/call → tool/result → assistant/message | agent/error) → step/end` 序列，包住 **4 处**真实 agent 调用（node-executor 主执行、rework 重跑、review 重跑、gate-repair 自动修复），确保经历 rework 或 gate 修复的 run 也有完整 §13.6 replay；事件经 dual-write bridge best-effort 发射（C1 治理零回归）。
- 新增 `legacy-agent-driver.ts`：冻结的 `AgentDriver`/`AgentHandle` 契约的首个实现（legacy 桥接，一次 runAgent = 一个 step）；`followUp`/`steer`/`resume` 抛 `NotSupportedYet`（递延 2b）。
- 补齐会话事件词汇：`step/start`、`step/end`、`tool/call`、`tool/result`、真实的 `assistant/message`（取代合成的 "Run passed."）；`tool/result` 与 `assistant/message` 标 `modelVisible`。

### 行为变化

- run 完成后不再发合成的 "Run passed." assistant/message；改为每个执行的 node 发一条真实的（产物元数据合成的）assistant/message。
- 事件流现在含真实 agent 步骤（step/tool/assistant），可经 SSE 消费并从 log replay 重建模型可见历史。

### 已知边界（诚实标注）

- 2a 的 `assistant/message` 由产物元数据合成，**非模型原文**；真正的增量 `assistant/chunk` 逐块流式依赖 provider 增量输出能力，递延阶段 2b。
- `followUp`/`steer`（运行中转向）、细粒度 tool 事件、spill reference 递延阶段 2b。
- dashboard 客户端尚未消费事件流（阶段 3）；`tool/call` 为 node 级摘要（`summaryLevel:'node'`）。
- §13.6 replay 覆盖跑过 agent 的 node（含 rework/gate-repair）；从 gate 断点恢复（resumeFromGate）不重跑 agent、不发 step 事件，故升级前已完成的 node 视图不含其 step/tool/assistant 事件——这是恢复语义，非缺陷。CLI 路径当前不接事件流（阶段 4），`--dynamic --dry-run` 预览的 `dynamic.ts` agent 调用不发 step 事件。
- `AgentDriver.cancel()` 对真实 provider 的中断依赖 adapter 透传 `signal`（现 codex/claude-code adapter 未透传），driver 尚无生产调用方，完整 provider→driver cancel 接线递延 2b（web job 路径的取消经 `ctx.signal` 独立生效，不受影响）。

### 测试

- 新增 `runtime/provider-registry.test.ts`（10：注册/未知/能力护栏/版本往返/缺失兼容/高版本抛错）、`runtime/agent-step-events.test.ts`（7：三分支 + C1 故障注入 + 无 sink）、`runtime/legacy-agent-driver.test.ts`（5：序列 + seq 单调 + cancel + pause + NotSupportedYet）。
- `phase1/session-job-e2e` 新增 journey 5（§13.6 模型可见 replay：三要素 + 顺序 + 真实 payload + 断线拼接一致）；harness 镜像 web 路径（agentEventSink + user/message modelVisible + 移除合成消息）；闭集泄漏断言扩展第四类 agent-loop 事件。
- 提交前全量 `pnpm test` 通过：core 892 / web 185 / cli 37 + Playwright 12。

## v0.9.0

Harness-inspired replatform 阶段 1：Event Spine（session/event/job 持久化 + dual-write）、真实后台 Job Runner（lease/心跳/崩溃恢复/fencing）、SSE 事件端点、AbortSignal + 子进程注册表取消链，以及 P0/P1/评审必修的运行时语义修复。**run / approve / resume 由同步阻塞改为后台 job 异步驱动**——这是面向使用者的行为变化。

### 新功能

**Event Spine 与后台 Job（报告 §8.2/§8.3，设计 §2）:**
- `core/session/`：`session-store`（Workspace/Session/SessionEvent/Job 持久化 + `listEventsSince` 回放）、`event-bus`（进程内 pub/sub）、`job-runner`（durable 轮询 runner，lease 续租 + stale 恢复 + owner fencing）、`subprocess-registry`（子进程句柄注册，取消链末端）、`dual-write`（AuditLogger/Repositories 包装器：仓储写入与 audit 事件透明投影为 session 事件）、`present`（传输层脱敏 + 限长）
- migrations v4：新增 `workspaces`/`sessions`/`session_events`/`jobs`/`projection_checkpoints` 五表，旧 15 表不动
- `nodes.node_order` 持久列：node 顺序确定化（消除跨进程加载顺序不确定）

**Web SSE 事件端点（设计 §3）:**
- `GET /api/sessions/:sessionId/events`：`x-session-token` 头鉴权（复用 RPC 的 origin/Sec-Fetch 校验）、`sinceSeq`/`Last-Event-ID` 回放、live 推送；**先订阅后回放（M6）消除回放/订阅交界丢事件**；payload 脱敏 + internal 事件不下发（C5）

**运行异步化（设计 §2.5/§2.11）:**
- `project.run` / `project.resume` / `gate.approve` 改为 enqueue 后台 `workflow-run`/`workflow-resume` job 后立即返回 `{sessionId, jobId}`；工作流由 job runner 出带驱动，取消可中断（P0-02 不回退）
- `project.run` 的既有同步校验（脏工作区、模板、agent runtime、P0-03 审批双校验、demandText 非空）全部保留在 enqueue 之前

### 修复

**P0/P1 与评审必修（设计 §0.2/§0.3）:**
- P0-02：resume/approve 不再阻塞，取消可中断后台续跑 job
- P0-03：服务端强制 shaped draft `approved && readyForRun`，否则 400
- P1-04/M8：终态 run 的 resume/approve/reject 抛 `WorkflowTerminalError` → CLI exit 1 + 中文提示 / Web 400，不复活
- §12-P1.7：run 级状态机 validator + 幂等终态写 `writeWorkflowTerminal`（CAS 收敛并发竞态，Gap A）。注：报告 §5 的 P1-07（任务续聊/运行中转向）是不同条目，属阶段 2 范围
- MF1：cancel 经 web 路径单发 `agent/cancel-requested` + `agent/cancelled`，落 session 终态
- MF2：`project.resume` / `gate.approve` 清理旧 job 后 `findActiveByRunId`，仍有活跃 job → 409（同 run 不允许双活跃 job）
- MF3：web reject 补终态检查 → 400，`casWorkflowInstanceStatus(paused→blocked)` 防并发 cancel 被覆盖复活
- 复审 A1：`cancelStaleActiveJobs` 的 queued 分支加 `created_at` 年龄阈值——并发双 approve/resume 时败者不再误杀胜者刚入队的新鲜 job
- 复审 S1：单活跃 job 护栏从 approve 提升到覆盖 approve + reject——resume job 在途（run 瞬时 `running`）时 reject 不再落 run 级 CAS 失败的误导性 200，改 409
- gate.approve/reject 决策翻转改幂等 CAS（`expectedStatus='pending'`），并发双提交零重复副作用

### 测试

- core 新增 `phase1/session-job-e2e`（run-to-passed / cancel / crash-recovery 四 journey + audit↔session_events 对账）、`session/*`（store/bus/job-runner/dual-write/present/subprocess-registry 单测）
- web 新增 `session-sse`（鉴权/回放/live/M6 边界/断连清理/getSession 失败前置于开流）、`gate-approve-async`（异步契约 + MF2 + A1 并发 + S1 reject 活跃 job 409 + P0-02 取消）、`project-run-job`（run 异步契约）；既有 write-auth / e2e 改轮询至终态
- 提交前全量 `pnpm test` 通过：core 869 / web 185 / cli 37 + Playwright 12

## v0.8.0

Harness-inspired replatform 阶段 0：修稳既有 flaky 测试、P1 纯 UI/API 修复、CI 覆盖三包、Session/Event 契约冻结。不动 core 运行时主路径。

### 修复

**CLI/Web 测试稳定性:**
- `run-cli.test.ts`：新增 anchor cwd 复位（`afterEach` 无条件 `process.chdir(anchorCwd)`），消除测试间共享进程级 cwd 导致的 `ENOENT chdir` 级联失败；超时 15s→30s 匹配真实子进程耗时
- `cli-flow.test.ts` / `release-flow.test.ts`：超时 30s→90s，消除并行负载下的 flaky 超时

**P1 人类可用性（报告 §12）:**
- P1.1 Resume 覆盖 `blocked`/`interrupted`：`RunControls` 抽出纯函数 `runControlAffordances`，Resume 不再仅对 `paused` 显示（`RunControls.tsx`）
- P1.2 terminal "眼睛"按钮：从 `stopPropagation` 无行为改为 `onView` 回调导航到 run 详情（`RunControls.tsx` + `RunTable.tsx`）
- P1.3 Run 列表展示需求标题：API 新增 `demandTitle` 字段（`mappers.ts`/`queries.ts`/`rpc-contract.ts`），`RunTable` Demand 列显示标题而非内部 ID
- P1.4 Run Detail 展示真实 provider：`review.get` 响应新增 `provider` 字段（`review.ts`/`context.ts`），`deriveAgent` 不再固定返回 `—`

### 新功能

**CI 覆盖三包（报告 P1-06）:**
- 新增 `.github/workflows/ci.yml`：root typecheck + CLI build/unit/e2e + Web build/typecheck/unit + Playwright e2e（含 `playwright install --with-deps chromium`）
- 既有 `core.yml` 保留为 core 专项门禁

**Session/Event 契约冻结（报告 §8.2/§8.3/§8.4）:**
- 新增 `core/types/session-contract.ts`：Workspace/Session/SessionEvent/Job schema + 事件词汇（core/control/tekon-governance）+ AgentDriver/JobRunner/EventSubscription/Projection 接口签名（纯类型，无实现）
- 新增 `core/__tests__/types/session-contract.test.ts`：9 个测试锁定 schema 版本、必需事件核心、merge-extensible 兼容策略

### 测试

- 新增 `web/__tests__/client/run-controls.test.ts`：8 个测试覆盖 `runControlAffordances` 全状态矩阵
- `read-api.test.ts`：新增 2 个 API 级测试覆盖 demandTitle/provider enrichment（含缺 provider 快照的 null 路径）
- `contract-strict.test.ts`：同步 `apiWorkflowSchema` 新必需字段
- e2e 断言同步当前中文 UI：`demand` 页标题 `Demand`→`需求澄清`、gates 页 `human`→`人工审批`、approve 按钮 `✓ Approve`→`✓ 批准`
- `playwright.config.ts`：`expect.timeout` 10s、`navigationTimeout` 20s、`retries: 1`（Vite dev-server 冷启动抖动兜底）

### 文档

- `docs/reviews/2026-08-20-...migration-review.md`：新增 §0 维护方决策批注（事实核验结论 + 定位判断 + 处置决策）
- 新增 `docs/superpowers/plans/2026-08-20-harness-replatform-execution-plan.md`：六阶段总体执行方案

## v0.7.0

### 新功能

**Web Cache Token Invalidation:**
- 新增 `query-keys.ts`：集中式 auth-scoped query key 工厂
- 新增 `use-auth-scope.ts`：React hook 派生当前 auth scope
- 扩展 QueryCache：`clearByScope`、`clearAllInFlight`、scope metadata
- AuthProvider token 变更时自动清除旧 session 缓存和 in-flight 请求
- 13 个 Web 组件统一使用 queryKeys 工厂，消除分散 key 拼接

**Gate Engine 注册表模式:**
- 新增 `gate/registry.ts`：GateDefinition + GateMetadata + GateRegistry 接口
- 新增 `gate/helpers.ts`：提取共享 gate 工具函数
- Gate runners 拆分为独立文件：command, security, schema, review, semantic, human
- Engine 支持可选 registry 参数，向后兼容旧 if/else 分派
- work-readiness 和 pre-pr-readiness 使用 registry 常量替代硬编码 gate 类型

**约束系统增强:**
- `agent.yaml` 新增 `autonomy`（level + riskTolerance）、`requiresHumanApprovalFor`、`defaultTimeoutMs`、`allowedGateTags` 字段（向后兼容）
- 新增 `runtime-policy.ts`：compileRoleRuntimePolicy + requiresHumanApproval + canSatisfyGate
- `constraints.yaml` 升级为有限 DSL：requiresGate / injectGate / requirePhase / requireOutput / suggest
- 新增 `dsl.ts`：loadConstraintRules + evaluateConstraints（支持 glob pattern matching）
- validator 集成 DSL 规则（硬编码规则作为 fallback）

**CLI/Web Agent Runtime 去重:**
- 新增 `core/runtime/agent-runtime.ts`：共享 createAgentRuntime + createAgentAdapterFromSnapshot + defaultProviderConfig
- CLI agent-factory.ts：thin wrapper，approvalDefault: 'on-failure'
- Web agents.ts：thin wrapper，approvalDefault: 'on-request'
- Web gate.ts：去除重复 resume/snapshot 函数
- CLI 减少 ~130 行重复，Web 减少 ~220 行重复

### 测试

**新增 234 个测试（641 → 875）：**
- scheduler.test.ts (8): phase 顺序、节点过滤、空 phase、未知 phaseId
- write-queue.test.ts (14): 串行执行、错误恢复、20 并发 FIFO
- query-keys.test.ts (25): auth scope 一致性、key 格式、token 隔离
- query-cache-scope.test.ts (9): clearByScope、clearAllInFlight、token 变更流
- agent-runtime.test.ts (30): factory/snapshot/config/overrides
- registry.test.ts (10): 12 gate 类型、metadata、category 过滤
- runtime-policy.test.ts (17): defaults、pattern matching、gate satisfaction
- dsl.test.ts (15): loading、validation、evaluation、glob patterns
- agent-config-extended.test.ts (7): 向后兼容、新字段、非法输入拒绝
- execution-plan.test.ts (23): templateToPlan、persistPlan、planFromRepository
- lease-service.test.ts (18): worktree lease、audit events、error handling
- workflow-runtime.test.ts (32): scopedId、stableGateKey、resolveReviewTarget、isChangesRequested
- helpers.test.ts (26): mustGetWorkflow/Demand、assertSuccessfulAgentRun

## v0.6.0

### 重构

**CLI 模块化拆分:**
- `packages/cli/src/index.ts` 从 3040 行缩减到 304 行（仅路由入口）
- 新增 `commands/` 目录：14 个命令文件（init, run, draft, workflow, delivery, approval, eval, review, role, status, ui, help）
- 新增 `lib/` 目录：5 个工具文件（agent-factory, context, db-helpers, path-utils, utils）

**Workflow Engine 模块化拆分:**
- `packages/core/src/workflow/engine.ts` 从 2389 行缩减到 335 行（仅编排层）
- 新增 8 个子模块：execution-plan, node-executor, gate-runner, rework, prompt-builder, lease-service, helpers, workflow-runtime
- gate-runner ↔ rework 通过 lazy getter 注入解决循环依赖

## v0.5.2

### 修复（全面审查第二轮）

**UX CLI 改进:**
- `draft new` 删除不存在的 `tekon draft review` 命令提示
- `tekon run` 输出增加中文上下文（🚀 运行已启动）和后续操作提示
- `delivery create-pr` 输出增加可读 PR URL 格式（✅ PR 已创建）
- 错误消息系统性国际化（约 30 处英文→中文）
- `delivery dry-run` 加入帮助子命令列表
- `constraints` 子命令帮助完善
- `update` 命令输出改中文

**UX Web 改进:**
- Session token 自动从 URL 读取并存入 `sessionStorage`
- Sidebar 底部从 API 动态读取项目名称和路径
- RunControls "View details" 按钮添加导航行为
- NotFoundPage 增加"返回 Dashboard"链接
- Flash 消息统一为中文
- `LoadingState`/`EmptyState` 默认消息改中文

**测试质量:**
- `engine-unit.test.ts` 19 个假测试修复：提取 `resolveReviewTargetNode` 等纯函数为导出函数，直接测试源码
- 新增 engine 纯函数单元测试

## v0.5.1

### 修复（全面审查第一轮）

**Critical:**
- 修复 rework 逻辑缺陷：`changes-requested` rework 后现在会重新运行 target node 的所有 gates 并重新生成 review artifact
- 修复 rework node 空 `outputs`/`gates` 导致真实 provider 不产出也通过的问题

**Major 引擎正确性:**
- `resumeRun()` 增加终态拒绝检查，防止恢复已完成/已取消的 run
- Human gate 幂等处理，防止 resume 时重复创建 pending decision
- Gate retry 循环完善，正确映射 `block`/`pause`/`fail`
- Gate 执行增加外层异常处理，防止 `running`/`awaiting-gate` 半状态
- Lease 生命周期 `try/finally` 管理，失败时正确释放
- 引入 `checkedTransitionNode` 状态机校验，防止非法状态转换

**Major 安全:**
- `role create` 增加 `ensureSafeName()` 校验，防止 `../` 路径逃逸
- Web 读 API（artifact/gate/audit/review/progress）增加 session token 鉴权
- CLI 不再将 token 放入 URL query string
- Secret scan 使用 `lstatSync` 跳过 symlink，增加深度和文件数限制
- `web-session.json` 写入时设置 `mode: 0o600`

**Major DB 连接管理:**
- 引入 `withProjectContext` 辅助函数，统一 DB 连接生命周期管理

**Major 类型安全:**
- 移除 `as never` 类型断言，增加 `validRoles` 运行时校验
- `assertAgentProviderCapabilities` 使用具体类型替代 `unknown`
- `TEKON_CORE_VERSION` 从 `package.json` 动态读取
- 清理 20+ 处未使用的 import 和变量

## v0.5.0

### 新增

- CLI `help` 命令：`tekon help` 输出分组命令概览，`tekon help <command>` 查看子命令详情；`--help`/`-h` 和 `--version`/`-v` 作为全局 flag 支持。
- Agent 驱动需求澄清：`draft new` 支持调用 Claude Code agent 生成上下文相关澄清问题并精炼需求草案，agent 不可用时自动回退到静态问题；新增 `draft-agent.ts` 模块，包含 PM 角色 prompt、JSON 解析容错、`verification` 字段保留等。
- Web Dashboard 状态修复：`skipped`（已跳过）、`interrupted`（已中断）、`blocked`（已阻断）状态在 StatusBadge、GatesTab、RunDetailPage、RunTable 中正确显示中文标签和 CSS 样式。
- Review → rework → re-review 闭环：`independent-review` gate 返回 `changes-requested` 时触发目标节点重新执行（最多 5 次），不再直接阻塞 workflow；`passed` 状态允许向 `needs-revision` 转换；rework 节点 ID 包含 attempt 计数器避免碰撞。
- AGENTS.md 新增「测试要求」章节：测试先行、提交前全量通过、测试质量检查（正确性/完整性/无冗余）、测试与代码同步、e2e 测试要求。

### 变更

- 真实 provider 默认权限模式从 `on-request` 改为 `on-failure`（Claude Code adapter 映射为 `acceptEdits`），减少 agent 执行时的权限拒绝。
- Claude Code adapter 自动 `--add-dir` 追加节点 artifact 输出目录到沙箱。
- Manifest 文件解析增强：`resolveExistingManifestPath` 检查 5 个候选文件名；`parseStructuredPayload` 对 JSON/YAML 解析增加 try/catch 容错。
- Engine prompt 中 `$TEKON_ARTIFACT_MANIFEST` 环境变量引用替换为实际 manifest 文件路径，避免 agent Bash 调用被拒时无法读取。
- `draft new` 命令从 `demand shape` 分流，新增 CLI `draft` 命令组（别名 `demand`），子命令 `new`/`shape`/`approve`/`show`。

### 修复

- 修复 `changes-requested` 被错误归类为通用 `review-not-approved` 的问题，现在独立返回 `failureClassification: 'changes-requested'`。
- 修复 rework 节点未持久化导致 transition 失败的问题。
- 修复 rework 节点 ID 碰撞（多次重试使用同一 ID）的问题。
- 修复 `extractDraftShapePatch` 丢失 AI 验收标准 `verification` 字段的问题。
- 修复 `packages/cli/package.json` 版本号 0.1.0 → 0.5.0，与根 package.json 对齐。

## 未发布

### 新增

- 天工（Tekon）主用户使用手册：`docs/manual/tekon-user-manual.md`，覆盖 overview、quick start、核心用户场景、CLI/Web 使用、参数解释、结果判断和常见问题处理；后续每次迭代后都必须评估是否需要同步更新。
- Phase 1 `@tekon/core` 安全可恢复内核。
- GitHub Actions core validation workflow 和 native dependency build gate。
- actionlint workflow validation。
- README 和当前 MVP 边界手册。
- Phase 2 角色文件系统、内置 `pm/rd/qa/reviewer/pmo` 角色、workflow 模板、constraint validator、dynamic workflow dry-run 和 durable workflow engine。
- `@tekon/cli` 本地 CLI 包，支持 `init/run/status/pause/resume/cancel/role/workflow/constraints/log/clean` 的 mock 验证路径；`run --allow-dirty-base` 可显式允许基于本地 dirty base 执行。
- Phase 2 CLI evidence 和 review HTML 审阅文档。
- Phase 3 SCM delivery dry-run、delivery evidence、metrics/report、Web dashboard、Web human approval、audit hash/filter、release-flow e2e 和 coverage provider。
- Phase 3 V2 用户手册、dogfooding report、final acceptance report 及对应 HTML 审阅版。
- README 更新 Phase 3 本地验收边界，并链接 V2 manual、dogfooding report 和 final acceptance report。
- 工作可用化增量：`.tekon/repo-profile.yaml` 仓库画像、Engine 角色 prompt 注入、CLI `--agent claude-code` adapter 接线、`delivery prepare` PR 准备包、`eval readiness` 工作就绪度评估。
- 工作可用化闭环：真实 git worktree lease 进入 Engine 主路径，节点改动会提交并推进到 `tekon-delivery/<runId>`；内置模板加入 `security-scan` gate。
- 真实 provider 产物协议：Engine 在 prompt/env 中注入 `TEKON_OUTPUT_DIR` 和 `$TEKON_ARTIFACT_MANIFEST` manifest 路径，Claude Code adapter 会读取 manifest、校验 artifact schema 并写入 Artifact Store；缺少必需 artifact 时节点失败。
- 仓库画像驱动 gate：内置 workflow 使用 `commandRef` 引用 `.tekon/repo-profile.yaml`，CLI 新增 `workflow preflight` 展示 build/lint/test/security 等 gate 将运行的命令。
- 恢复一致性：run 创建时落库 provider/config 摘要，CLI/Web resume 按 run provider 快照恢复；Engine 对 stale `running` 节点增加 completed role-run marker 检查，避免未完成节点直接跳到 gate。
- 受控远端交付：CLI `delivery create-pr` 支持人工批准后 push 分支并调用 `gh pr create --body-file`，PR 状态和 URL 落库，失败阶段落库，PR 已存在时尝试 `gh pr view` 恢复 URL；执行前会拒绝主工作区除 `.tekon` 外的未提交改动。
- 语义证据：artifact schema 支持验收标准、criteria evidence 和 security findings；delivery evidence/readiness 汇总逐条验收证据和安全扫描结果。
- Web human approval 自动 resume：Web approve/reject 会更新决策、gate/node/workflow 和 audit，approve 后自动调用 Engine 继续运行。
- 审阅面聚合：core 新增 review surface，CLI 新增 `review --run-id`，Web 新增 Readiness、Diff、Artifact 正文、Gate Logs、PR 包和下一步命令区块；同一聚合器会读取 artifact 正文、gate 输出、PR body/package、delivery diff 和 readiness 失败项。
- 审阅证据导航：review surface 新增 evidence groups，把 readiness 失败项关联到 artifact、gate log、audit event、PR body、PR package 和 diff；CLI 输出 Evidence Navigation，Web 新增 Evidence Links 面板。
- Gate 失败诊断：review surface 新增 Gate Failure Triage，把失败 gate 的分类、日志锚点、重试建议和建议命令结构化输出；CLI `review` 和 Web dashboard 会展示同一诊断结果。
- 需求塑形入口：core 新增 demand shape/approve/evaluate 能力，CLI 新增 `demand shape`、`demand approve`、`demand show`、`run --demand-file` 和 `eval demand-shape`；Web dashboard 可用 session token 塑形、批准需求后再发起 run。
- 受控 Workflow 选择：新增 `test-improvement`、`docs-update`、`plan-only` 内置模板，需求塑形可推荐对应模板；CLI 新增 `workflow select` 和 `eval workflow-selection`，Web 模板选择器同步展示受控模板。
- Web 受控执行入口：dashboard 可用 session token 发起模板 run、执行 `delivery prepare`、触发受人工批准的 `delivery create-pr`，并提供 artifact/gate/audit 到审阅正文和 PR 包的基础锚点互跳。
- Web 多运行审阅流：dashboard 会列出当前项目内的 runs，可选择任意 run 加载 readiness、artifact 正文、gate log、audit 和 PR 包；PR 准备/创建也作用在当前选中的 run 上，而不是固定 latest run。
- 工作可用样本评估：core 新增 work usability evaluator，CLI 新增 `eval work-usability --samples`，可按样本清单检查 readiness、真实 provider、真实 PR、security scan、worktree 隔离和远端副作用审批证据。
- 工作可用样本沉淀：CLI 新增 `eval work-usability record`，可把已完成 run 写入样本清单；`eval work-usability` 支持 `--report-md/--report-html` 生成可提交的样本评估报告。
- 敏感信息治理：新增共享 secret scanner，内置 `security-scan`、Artifact Store 和 CommandGateway 复用同一规则；artifact 写入前拒绝明显密钥，命令 stdout/stderr 落盘前脱敏。
- 远端 CI 状态证据：core 新增 `ci-status` artifact、delivery CI 查询和 PR 包 Remote CI 区块；CLI 新增 `delivery ci-status`，可只读调用 `gh pr checks` 并把 PR checks 状态写入 evidence 和 audit。
- 远端 CI watch：core 新增 PR checks 轮询能力和 `delivery.ci.watch-completed` 审计事件；CLI 新增 `delivery ci-watch`，可按次数、间隔和退避等待 PR checks 进入 `passed/failed/skipped` 终态，同时保留每次只读查询证据。
- 审批摘要：core 新增 human approval summary 和 `eval approval-summary` 评估；CLI 新增 `approval summary` 可复制审批摘要和 `approval reject` 拒绝入口；Web 待审批区展示同一摘要，包含风险、命令、影响文件、证据入口和批准/拒绝入口。
- 仓库画像缺失命令修复引导：core 新增 repo profile command guidance，CLI `workflow preflight` 在 commandRef 缺失时输出 `hint/profilePath`，并基于 `package.json` 的 `compile/test:e2e/playwright` 等候选脚本给出 `suggestedCommand`。
- 仓库画像显式不适用语义：repo profile 命令支持 `notApplicable: true` 和 `reason`；普通 command gate 会记录 `skipped/not-applicable` 并进入 readiness 和 PR 包，`security-scan` 仍保留内置扫描兜底。
- CLI 默认上下文推断：常规命令会自动发现当前 repo、最近需求卡、最近 run 和最近 pending human decision；`--repo`、`--run-id`、`--shape`、`--demand-file`、`--decision-id` 保留给跨仓库、历史对象和消除歧义场景。
- Codex provider P0 接线：core 新增 `createCodexAdapter` 和共享 manifest ingestion，CLI/Web 支持 `--agent codex`、provider snapshot resume 和 Web run 下拉选项；`eval work-usability record` 可记录 `expectedProvider: codex` 与真实 PR 要求。
- Codex provider 使用文档：README、主用户手册和 `docs/manual/codex-provider-smoke.md/html` 说明本机 Codex CLI、`codex --profile internal ... exec`、artifact manifest、权限边界和自举 smoke 流程。
- Standard Delivery 标准模板：新增完整 `standard-delivery` 内置 workflow，覆盖 PM 内审、PM/RD/QA 外部需求评审、RD 技术评审、QA 测试方案评审、独立变更评审、QA final signoff、QA signoff review 和 PMO checkpoint。
- Standard Delivery 交付可信度：非 `code-changes` 节点在 worktree finalize 前会被源码变更 guard 拦截；QA validation 会记录 tested ref，QA signoff、pre-PR readiness、PR package 和 readiness 会校验所测对象与交付对象一致。
- PMO 过程观测：Engine 在每个节点通过后写入 `pmo.node-checkpoint` 审计事件，记录节点状态、必需 artifact、gate 类型和最新 gate 状态；末端 PMO checkpoint 仍负责交付包完整性。
- Standard Delivery 强治理 gate：新增 `demand-review`、`implementation-plan`、`test-plan`、`ac-evidence`、`qa-release-signoff`、`process-checkpoint` 等 artifact schema，以及 `independent-review`、`role-scope`、`ac-evidence`、`qa-signoff`、`process-completeness` gate。
- Standard Delivery 角色边界：PM、RD、QA、reviewer、PMO 的 system 描述补充评审范围、不越权边界、独立评审要求和升级条件。
- Standard Delivery P1-0 seed run 归档：记录 `run_04b37267-2686-42c6-a0a4-9b37410f65f7` 在 RD Codex 节点 300 秒超时中断的证据和后续拆分策略。
- 长程任务产物进展观测：CommandGateway 的 no-progress 判定除 stdout/stderr 外，会扫描受控 `outputDir` 中的 artifact/manifest 等文件变化，排除自身 stdout/stderr/progress 文件，并在 progress JSON 中记录 `lastOutputDirActivityAt`、`outputDirFileCount`、`outputDirBytes` 和 `outputDirLatestMtimeMs`；1 小时默认预算和 2 小时级长程预算仍需 heartbeat、no-progress 与受控 outputDir 产物进展观测共同约束。

### 变更

- README 从阶段验收与增量清单改为项目级介绍，聚焦定位、工作流、核心能力、边界、快速开始、运行产物、仓库结构和文档入口。
- 项目品牌迁移为天工（Tekon）/tekon，CLI、包名、运行态目录、环境变量前缀、交付分支前缀、文档文件名和用户文档引用同步更新。
- Vitest 配置从旧 workspace 文件迁移到 `vitest.config.ts` 的 `test.projects`。
- 建立 `.prettierrc.json`，让全仓 `prettier --check .` 成为可执行的发布 gate。
- `@tekon/core test:e2e` 覆盖 workflow engine、recovery、gate repair 和 dynamic constraint e2e。
- 发布说明从 Phase 2 本地 mock CLI 基线更新为 Phase 3 本地验收通过，不把真实 PR、自动 merge 或生产级真实 LLM workflow 写成已完成能力。
- Web 技术基线从计划中的 Next/tRPC 降级为本地 Node HTTP + Vite React dashboard，验收产物为 `packages/web/dist`；保留后续升级到远程多路由 Web 的空间。
- `init` 会根据目标仓库 `package.json` 自动生成仓库画像；正式远端 PR 仍需人工确认，当前新增的是本地 PR 准备包和工作就绪度判断。
- `eval readiness` 从“PR 准备可审阅”升级为“验收标准有证据、安全扫描通过、无 pending human gate、PR 已创建且远端 CI 通过”的工作就绪判断；PR 创建和远端 CI 通过已从推荐项升为必需项，merge/上线仍不自动化。
- `eval work-usability` 把 P0-2/P0-6/P0-7 的真实样本要求固化为阈值评估；默认阈值面向正式 dogfooding 样本集，可在受控 fixture 中通过 sample file 降低阈值做回归测试。
- 内置安全扫描从 gate 私有规则调整为共享规则集；当前覆盖 private key、OpenAI-style key、AWS access key 和常见 token/secret assignment。
- `delivery create-pr` 默认不执行远端副作用；只有显式 `--approve-human` 才 push 和创建 PR，并且不会提交主工作区未提交改动或 `.tekon` 运行态目录。
- `delivery prepare` 和 `delivery create-pr` 统一执行 pre-PR readiness：workflow passed、无 pending human gate、验证 gate 与安全扫描满足、AC evidence 完整、QA release signoff 通过且绑定 QA validation tested ref；不满足时不会生成 PR 包或创建远端 PR。
- Mock agent 从“每个节点写全量内置 artifact”调整为优先写 workflow 要求的 artifact 类型，更贴近真实 provider manifest 协议。
- Codex adapter 默认固定 `codex --profile internal --sandbox workspace-write --ask-for-approval on-request --add-dir <TEKON_OUTPUT_DIR> exec`，并拒绝 provider args 覆盖 profile、sandbox、approval、文件系统、配置或危险 bypass 参数；`--add-dir` 只由 Tekon 受控追加到本节点 artifact 输出目录，安全边界参数会放在 `exec` 之前，匹配本机 Codex CLI 语法。
- 真实 provider 默认总超时从 300 秒调整为 1 小时，并写入 provider snapshot，降低长程 Codex/Claude Code 节点被短超时误杀的概率；CLI `run` 新增 `--timeout-ms`、`--no-progress-timeout-ms`、`--progress-heartbeat-ms`，Web dashboard 新增对应运行参数输入，允许对明确长程任务显式配置 2 小时以上外层预算；CommandGateway 同步写入 `*.progress.json`，记录命令状态、最近输出时间、stdout/stderr 字节数、受控输出目录文件数量和字节数、elapsed、总超时、无进展超时、timeoutReason 和 heartbeat 次数；默认无 stdout/stderr 或受控输出目录文件进展 15 分钟会触发 `no-progress` timeout，`delivery create-pr --approve-human` 的受控 `git/gh` 命令及前置只读 probe 也复用该超时和进展策略；diff 级续期和可恢复 job runner 仍待后续补强。
- Gate result 新增 `gateKey`，workflow 会为同一节点下的重复同类型 gate 生成稳定身份，例如多个 `schema` gate 会按 artifact/commandRef 区分；PMO `process-checkpoint` 也会带上 gateKey 证据，避免重复 gate 被误认为已经通过；human gate 审批会更新原始 gate result 并保留 gateKey，不再创建无 key 的 resume gate。
- CommandGateway 人工审批 note 复用命令参数脱敏逻辑，避免 `--token`、`--password` 或环境变量形式的敏感值进入 human decision 审阅面。
- SCM 远端交付对 delivery branch/base branch 做安全 ref 校验，并把实际生成的 `git branch`、`git push`、`gh pr create/view` 写命令加入 exact allow，避免 broad prefix allow 放大远端副作用边界。
- `workflow preflight` 对 schema、QA signoff、role-scope 等非命令 gate 显示 `status=not-command-gate`，与 repo profile 显式 `notApplicable` 的 `status=not-applicable` 区分开，避免把无需命令的语义 gate 误报成 command missing。
- Codex adapter 在 provider timeout 或非零退出后会尝试读取并校验 `$TEKON_ARTIFACT_MANIFEST` 指向的 manifest 文件；只要 workflow 必需 artifact 已完整入库，就按 artifact 完成继续进入 gate。manifest 缺失、schema 非法、必需 artifact 不齐或非 timeout signal 仍按失败处理。若真实 Codex 误写出字面文件名 `TEKON_ARTIFACT_MANIFEST`，adapter 会在受控 `TEKON_OUTPUT_DIR` 内按同一 schema 兼容读取。
- 真实 provider artifact 协议增加节点职责边界和收尾约束：非 `code-changes` 节点只写 `TEKON_OUTPUT_DIR` 下的节点 artifact，不修改仓库工作区；所有需要 artifact 的节点先写 artifact 与 `$TEKON_ARTIFACT_MANIFEST` 指向的 manifest 文件，再立即退出，且不在节点内启动嵌套 subagent 审阅或执行 `git add`、`git commit`、`git push`、PR 创建，避免 PM/QA 等节点继续执行下游实现、格式化、额外审阅或远端交付工作。
- 真实 provider artifact 协议明确结构化 JSON artifact 必须包含非空 `title` 和 `body`，并在 prompt 中要求 `demand-card`/`prd` 使用 `acceptanceCriteria[].id/description`；`code-changes` 的 provider-style JSON 在包含非空 `summary` 或有效 `changedFiles`/`verification` 条目时会被归一化为 Tekon 可审阅 artifact，`demand-card`/`prd` 的有效 `acceptance_criteria[].criterion` 也会被归一化为 `acceptanceCriteria[].description`，降低真实 Codex run 因字段命名漂移中断的概率。
- 真实 provider artifact 协议对评审类 artifact 增加严格 role-scoped review JSON 指引：prompt 会给出 `reviewScope`、`reviewProcess`、`decision`、`findings[].severity/message` 的合法字段和值，并写入目标节点和目标角色，避免真实 Codex 用 `reviewRole`、`reviewedArtifacts` 或数组/对象形式 `reviewScope` 产出无法过 schema/role-scope gate 的评审产物。
- 真实 provider 评审类 artifact 对 `findings[].ownerRole` 做窄归一化：若 provider 写出非角色枚举的 ownerRole，会把该值保留到 finding message 并移除无效 ownerRole；`reviewScope`、`reviewProcess.reviewerRole`、`targetRole` 和 `decision` 仍保持严格 schema 校验。
- 真实 provider `test-plan` artifact 协议明确要求 `testBasis` 和 `testCases` 字段；若 Codex 写出 provider-style `sourceArtifactsReviewed` 与 `testScenarios`，Tekon 会窄归一化为 schema 所需的测试依据和测试用例，避免 QA 测试方案因字段命名漂移中断。
- 真实 provider `test-report`/`ac-evidence`/`qa-release-signoff` artifact 协议明确要求 `criteriaEvidence[].criterionId/status/evidence`，其中 `evidence` 必须是字符串；需要 evidence anchor 的场景必须把 `outputPaths`、`gateResultIds` 或 `artifactIds` 放在对应 `criteriaEvidence` 条目内，不能只放在 artifact 顶层；`artifactIds` 只能使用 Artifacts 区展示的真实 `artifact_<uuid>`，不能使用 `nodeId:type` 标签；`gateResultIds` 只能使用 prompt 的 `Prior eligible gate results` 区展示的真实 `gateResultId`，不能使用 `gateKey`、`commandRef`、`outputPath` 或 gate 日志文件名；`qa-release-signoff` 还必须显式写入 `targetRef`、`validatedRef` 和 `overallStatus`，且 `overallStatus` 只能是 `passed`、`failed` 或 `blocked`，不能用 `decision` 或 `recommendation` 替代。若 Codex 在 `test-report`/`ac-evidence` 中写出对象形式 `summary`、带字符串 `summary` 的 evidence 对象、`criteriaEvidence[].id/evidenceSummary/coverage` 或 `passed_with_*`/`failed_with_*`/`blocked_with_*` 状态标签，Tekon 会窄归一化为 schema 所需字段；`qa-release-signoff` 不做这类 provider-style QA evidence 字段归一化，缺失状态、含糊状态、无 `summary` 的 evidence 对象、只有顶层 anchor 或只有 `criterion` 而无证据字段仍失败，避免 QA validation 已产出有效证据但因字段命名漂移中断，同时保持 QA final signoff 严格按 schema 表达。
- 真实 provider `ac-evidence`/`qa-release-signoff` prompt 明确：当前 QA validation 节点不应仅因 PR 创建、delivery package 或下游 PMO/QA signoff 节点尚未运行而阻塞；这些交付闭环由后续节点、pre-PR readiness 和受控 PR 创建继续校验。
- Web dashboard 从只展示 artifact/gate 路径和计数，升级为可直接审阅关键正文、日志、diff 和 PR 包的本地审阅面，并能在同一页面完成 run 发起、PR 准备和受控 PR 创建入口。
- `demand shape` 默认写入 `.tekon/demands/`，`demand approve`、`run`、`status`、`review`、`approval summary`、`resume --approve-human`、`delivery prepare` 和 `eval readiness` 等常规命令默认读取最近合适的上下文；历史需求卡和历史 run/decision 仍通过显式参数兼容。
- 审批摘要和 review surface 的建议命令在默认上下文中改为短命令，例如 `tekon resume --approve-human`、`tekon approval reject`、`tekon review`；显式查看历史 run/decision 时仍输出带 id 和 repo 的精确命令，避免复制后操作到最新上下文。
- 默认审批命令遇到同一 run 多个 pending human decision 时会拒绝歧义并要求 `--decision-id`；`resume --approve-human --decision-id <id>` 只批准指定 decision。

### 修复

- CommandGateway 不再在无 stdin 时写入空 chunk；显式 stdin 写失败、子进程异步 `error` 事件、命令日志写入失败和忽略 `SIGTERM` 的 timeout 场景会返回受控结果，降低快速退出命令触发 `EPIPE`、promise 悬挂或丢失执行证据的风险。
- 真实 provider `process-checkpoint` prompt 明确 `artifactEvidence[].nodeId/type`、`gateEvidence[].nodeId/gateType/gateKey/status` 和数字型 `humanDecisionEvidence.pending`，避免 PMO checkpoint 误写 `output`、`observedStatus` 或 pending 数组后无法通过 schema ingest。
- Web server 关闭时会主动关闭 idle/all connections，避免 dashboard e2e 或本地开发停止时被 keep-alive 连接挂住。
- Worktree finalize 提交节点变更时不再 broad `git add .`，改为只 stage `git status --porcelain` 中的非 `.tekon` 真实改动，避免真实 provider 运行态目录被 `.gitignore` 忽略时阻断节点 promote。

### 说明

- Tekon 已有本地 mock CLI 入口、本地 Web dashboard 和受人工批准的 PR 创建 fixture 覆盖，但仍未发布自动 merge、自动上线或生产级真实 LLM workflow。
- 交付 dry-run、prepare、create-pr、metrics、dogfooding 和 final acceptance 已记录本地验收结果；真实生产仓库使用仍需受控 fixture、明确人工批准和单独记录失败恢复证据。
- 当前 CLI/Web 主要用于本地验收和研发 dogfooding。

### 已验证

- 发布就绪加固本地 gate 已通过。
- 代码完成提交的远端 Core workflow 已通过。
- Claude provider 手动 smoke 已在认证本地环境通过。
- Phase 2 本地 gate 已通过：`pnpm build`、`pnpm typecheck`、`pnpm test -- --run`、`@tekon/core test:e2e`、`@tekon/cli test:e2e`、`prettier --check .`。
- Phase 3 本地 gate 已通过：`install --frozen-lockfile`、`build`、`typecheck`、Vitest coverage、CLI release e2e、Web dashboard e2e。

### 后续发布范围外

- 自动 merge。
- 生产级真实 LLM workflow 稳定性。
- 远程多租户 Web 服务。
