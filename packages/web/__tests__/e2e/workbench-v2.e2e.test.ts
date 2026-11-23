import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  createProviderAdapterResolver,
  type AgentAdapter,
  type AgentDiscoveryRegistry,
  type AgentDiscoverySnapshot,
  type ProviderAdapterResolver,
} from '@tekon/core';
import { createWebFixtureProject } from '../fixtures/project.js';
import { createWebServer, type RunningWebServer } from '../../src/server/http.js';

interface HarnessOptions {
  readyAgents?: boolean;
  failOnceNodeRole?: string;
  planFailOnce?: boolean;
  slowFirstNodeMs?: number;
}

async function startWorkbenchHarness(opts: HarnessOptions = {}) {
  const fixture = await createWebFixtureProject();
  const ready = opts.readyAgents ?? true;

  const snapshot: AgentDiscoverySnapshot = {
    probedAt: '2026-11-20T12:00:00.000Z',
    agents: [
      {
        id: 'claude-code',
        name: 'Claude Code',
        iconKey: 'claude-code',
        status: ready ? 'ready' : 'unauthenticated',
        authKind: 'oauth-token',
        loginHint: 'claude auth login',
        models: ['claude-sonnet-4-6', 'claude-opus-4-6'],
        efforts: ['default', 'high'],
        source: 'built-in',
      },
      {
        id: 'codex',
        name: 'Codex CLI',
        iconKey: 'codex',
        status: 'ready',
        authKind: 'oauth-token',
        models: ['gpt-5.4', 'gpt-5.3-codex'],
        efforts: ['medium', 'high', 'xhigh'],
        modelEfforts: {
          'gpt-5.4': ['medium', 'high', 'xhigh'],
          'gpt-5.3-codex': ['high', 'xhigh'],
        },
        source: 'built-in',
      },
      {
        id: 'antigravity',
        name: 'Antigravity',
        iconKey: 'antigravity',
        status: 'ready',
        models: ['gemini-4-neon'],
        efforts: ['low', 'medium', 'high'],
        source: 'user-config',
      },
    ],
  };

  let refreshCount = 0;
  const discovery: AgentDiscoveryRegistry = {
    getSnapshot: async () => snapshot,
    refresh: async () => {
      refreshCount += 1;
      return {
        ...snapshot,
        probedAt: new Date(Date.now() + refreshCount * 1000).toISOString(),
      };
    },
    getAgent: async (id) => snapshot.agents.find((a) => a.id === id),
  };

  let seq = 0;
  let failedOnce = false;
  let planFailuresRemaining = opts.planFailOnce ? 2 : 0;
  const makeAdapter = (driver: string): AgentAdapter => ({
    async runAgent(input) {
      seq += 1;
      if (opts.slowFirstNodeMs && seq === 1) {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, opts.slowFirstNodeMs);
          input.signal?.addEventListener('abort', () => {
            clearTimeout(timer);
            resolve();
          });
        });
        if (input.signal?.aborted) {
          return {
            provider: 'claude-code',
            exitCode: 130,
            cancelled: true,
            durationMs: 30,
            outputFiles: [],
            artifacts: [],
          };
        }
      }

      if (input.roleConfig.role === 'orchestrator') {
        if (planFailuresRemaining > 0) {
          planFailuresRemaining -= 1;
          return {
            provider: 'claude-code',
            exitCode: 1,
            durationMs: 15,
            outputFiles: [],
            artifacts: [],
            diagnostic: { code: 'unclassified', message: '编排模型暂时不可用' },
          };
        }
        return {
          provider: 'claude-code',
          exitCode: 0,
          durationMs: 20,
          outputFiles: [],
          artifacts: [],
          assistantText: JSON.stringify({
            summary: '动态生成两步研究流程',
            nodes: [
              {
                name: '文献梳理',
                roleId: 'explorer',
                docKey: 'survey',
                expectedDoc: 'survey.md',
                reason: '收集行业案例',
                confirmAfter: false,
              },
              {
                name: '方案定稿',
                roleId: 'designer',
                docKey: 'final-plan',
                expectedDoc: 'final-plan.md',
                reason: '输出落地设计',
                confirmAfter: false,
              },
            ],
          }),
          tokenUsage: { inputTokens: 120, outputTokens: 80 },
        };
      }

      if (opts.failOnceNodeRole && input.roleConfig.role === opts.failOnceNodeRole && !failedOnce) {
        failedOnce = true;
        return {
          provider: driver === 'codex' ? 'codex' : 'claude-code',
          exitCode: 1,
          durationMs: 18,
          outputFiles: [],
          artifacts: [],
          diagnostic: { code: 'unclassified', message: '模拟额度超限错误' },
        };
      }

      input.onOutputLine?.({
        stream: 'stdout',
        line: `[${driver}] 正在执行 ${input.roleConfig.role} (#${seq})`,
        timestamp: new Date().toISOString(),
      });

      const docType = input.requiredArtifactTypes?.[0];
      const artifacts = [];
      if (docType && input.artifactStore) {
        artifacts.push(
          await input.artifactStore.writeArtifact({
            runId: input.runContext.runId,
            nodeId: input.runContext.nodeId,
            type: docType,
            docKey: docType,
            content: `# ${docType} (iter ${seq})\n\n共同内容行\n更新结论行 #${seq} (${driver}/${input.providerOverrides?.model ?? 'default'})\n`,
          }),
        );
      }

      return {
        provider: driver === 'codex' ? 'codex' : 'claude-code',
        exitCode: 0,
        durationMs: 25,
        outputFiles: [],
        artifacts,
        assistantText: `来自 ${input.roleConfig.role} 的回复 (#${seq})`,
        handoffBrief: `节点结论 #${seq}（${driver}/${input.providerOverrides?.model ?? 'default'}）`,
        providerThreadId: `thread_${driver}_${input.roleConfig.role}`,
        tokenUsage: {
          inputTokens: 800,
          cachedInputTokens: input.resumeThreadId ? 600 : 100,
          outputTokens: 200,
        },
      };
    },
  });

  const resolver: ProviderAdapterResolver = createProviderAdapterResolver({
    repoPath: fixture.projectRoot,
    defaultDriver: 'claude-code',
    adapters: {
      'claude-code': makeAdapter('claude-code'),
      codex: makeAdapter('codex'),
      antigravity: makeAdapter('antigravity'),
    },
  });

  const server: RunningWebServer = await createWebServer({
    projectRoot: fixture.projectRoot,
    port: 0,
    vite: false,
    workbenchDiscovery: discovery,
    workbenchResolver: resolver,
  });
  await server.listen();

  const token = (
    JSON.parse(
      readFileSync(join(fixture.projectRoot, '.tekon', 'web-session.json'), 'utf8'),
    ) as { token: string }
  ).token;

  if (!ready) {
    // Explicitly bind explorer to unauthenticated claude-code so preflight blocker triggers
    await fetch(`${server.url}/api/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-session-token': token },
      body: JSON.stringify({
        path: 'role.save',
        input: {
          id: 'explorer',
          name: '调研员',
          driver: 'claude-code',
          model: 'claude-sonnet-4-6',
          effort: 'default',
          systemPrompt: '调研汇总',
        },
      }),
    });
  }

  return {
    server,
    token,
    urlWithToken: `${server.url}/#token=${encodeURIComponent(token)}`,
    async cleanup() {
      await server.close();
      fixture.cleanup();
    },
  };
}

test.describe('Tekon v2 Workbench E2E', () => {
  test('Deep Research 4-node flow: confirm, rework v2 diff, pin, context compact/archive, rail toggle, and follow-up', async ({
    page,
  }) => {
    const h = await startWorkbenchHarness();
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(h.urlWithToken);

      await expect(page.getByTestId('new-task-hero')).toBeVisible();
      await page.getByLabel('选择工作流模板').selectOption('deep-research');
      // Attach a reference markdown file via hero file input
      await page.locator('input[type="file"]').setInputFiles({
        name: 'arch-notes.md',
        mimeType: 'text/markdown',
        buffer: Buffer.from('# Architecture Notes\n\nExisting internal infra uses Neo4j.\n'),
      });
      await expect(page.getByText('arch-notes.md')).toBeVisible();
      await page
        .getByLabel('任务描述')
        .fill('研究大型代码工程的知识图谱落地方案');
      await page.getByLabel('启动任务').click();

      // Should land on task detail and reach checkpoint at node 3 (amber confirm dot in rail!)
      await expect(page).toHaveURL(/\/tasks\/run_/);
      await expect(page.getByTestId('confirm-action-strip')).toBeVisible({
        timeout: 10_000,
      });
      await expect(page.locator('.wb-nd-confirm')).toHaveCount(1);

      // Verify Agent brand icons are visible in timeline and rail
      expect(await page.locator('[data-agent-icon]').count()).toBeGreaterThan(2);

      // Top dot-line rail defaults collapsed -> expand -> switch to Right Vertical Rail -> slim -> back to Top
      await page.getByLabel('展开节点详情').click();
      await expect(page.locator('.wb-rail-expanded')).toBeVisible();
      await page.getByLabel('切换为右侧竖向进度轨').click();
      await expect(page.locator('.wb-v-rail')).toBeVisible();
      await page.getByLabel('切换右侧进度宽度').click();
      await expect(page.locator('.wb-v-rail.slim')).toBeVisible();
      await page.getByLabel('切换右侧进度宽度').click();
      await page.getByLabel('切换为顶部点线进度').click();
      await expect(page.locator('.wb-top-rail')).toBeVisible();

      // Trigger targeted rework back to step 2 (方案初稿)
      await page.getByRole('button', { name: '要求返工' }).click();
      const targetSelect = page.getByLabel('选择返工起始节点');
      const optVal = await targetSelect.locator('option').nth(1).getAttribute('value');
      await targetSelect.selectOption(optVal!);
      await page.getByLabel('返工修改意见').fill('补充增量索引成本对比');
      await page.getByRole('button', { name: '提交返工' }).click();
      // Deterministic wait: rework submission confirmed & toast appears before second checkpoint
      await expect(page.getByText('已提交返工并重跑目标节点')).toBeVisible({
        timeout: 5_000,
      });

      // Wait for rework to finish and pause again at checkpoint with v2 document
      await expect(page.getByTestId('confirm-action-strip')).toBeVisible({
        timeout: 10_000,
      });

      // Approve checkpoint and wait for full 4-node completion
      await page.getByRole('button', { name: '确认继续' }).click();
      await expect(page.locator('.wb-tb-status')).toContainText('已完成', {
        timeout: 10_000,
      });

      // Open Docs drawer -> verify attachment arch-notes.md, then unconditionally select v2 doc for diff & pin!
      await page.getByLabel('打开固化文档抽屉').click();
      await expect(page.getByRole('button', { name: /arch-notes\.md/ })).toBeVisible();
      const v2DocPill = page
        .locator('.wb-drawer .wb-pill-group .wb-pill')
        .filter({ hasText: /v[2-9]/ })
        .first();
      await expect(v2DocPill).toBeVisible();
      await v2DocPill.click();
      await expect(page.getByTestId('doc-content-view')).toBeVisible();
      const diffBtn = page.getByLabel('版本对比');
      await expect(diffBtn).toBeVisible();
      await diffBtn.click();
      await expect(page.getByTestId('doc-diff-view')).toBeVisible();
      await page.getByLabel('置顶文档').click();
      await expect(page.getByText('已置顶文档')).toBeVisible();

      // Switch to Context Inspector tab -> compact -> mount archive
      await page.getByRole('tab', { name: /上下文/ }).click();
      await expect(page.getByTestId('context-summary-kv')).toBeVisible();
      await page.getByRole('button', { name: /压缩/ }).click();
      await expect(page.getByText(/已压缩.*原文已归档/)).toBeVisible();
      const mountBtn = page.getByRole('button', { name: '挂载' }).first();
      await mountBtn.click();
      await expect(page.getByRole('button', { name: '已挂载' }).first()).toBeVisible();

      // Close drawer via Esc
      await page.keyboard.press('Escape');
      await expect(page.locator('.wb-drawer')).toHaveCount(0);

      // Switch to Right Vertical Rail on desktop, then shrink to 768px -> auto-fallback to Top Dot-Line + drawer mutual exclusion
      await page.getByLabel('切换为右侧竖向进度轨').click();
      await expect(page.locator('.wb-v-rail')).toBeVisible();
      await page.setViewportSize({ width: 768, height: 820 });
      await expect(page.locator('.wb-top-rail')).toBeVisible();
      await expect(page.locator('.wb-v-rail')).toHaveCount(0);

      await page.getByLabel('打开任务列表').click();
      await expect(page.locator('.wb-sidebar.open')).toBeVisible();
      await page.locator('.wb-backdrop.open').click({ position: { x: 650, y: 400 } });
      await expect(page.locator('.wb-sidebar.open')).toHaveCount(0);
      await page.getByLabel('打开固化文档抽屉').click();
      await expect(page.locator('.wb-drawer')).toBeVisible();
      await expect(page.locator('.wb-sidebar.open')).toHaveCount(0);
      await page.keyboard.press('Escape');
      await expect(page.locator('.wb-drawer')).toHaveCount(0);
      await page.setViewportSize({ width: 1440, height: 900 });

      // Post-completion follow-up turn
      await page.getByLabel('继续追问').fill('请再补充一下落地排期建议');
      await page.getByLabel('发送').click();
      await expect(page.getByText(/追问回复/)).toBeVisible({ timeout: 8_000 });
    } finally {
      await h.cleanup();
    }
  });

  test('Dynamic orchestration: failed plan fallback, editable blueprint, save as template, and confirm run', async ({
    page,
  }) => {
    const h = await startWorkbenchHarness({ planFailOnce: true });
    try {
      await page.setViewportSize({ width: 1280, height: 860 });
      await page.goto(h.urlWithToken);

      await page.getByLabel('选择工作流模板').selectOption('__dynamic__');
      await page.getByLabel('任务描述').fill('帮我调研微前端迁移方案');
      await page.getByLabel('启动任务').click();

      // First attempt fails -> shows fallback & retry
      await expect(page.getByText('动态规划失败')).toBeVisible({ timeout: 8_000 });
      await page.getByRole('button', { name: '重试规划' }).click();

      // Second attempt succeeds -> shows editable blueprint
      await expect(page.getByText('动态编排计划（确认后执行）')).toBeVisible({
        timeout: 8_000,
      });

      // Save blueprint as template
      await page.getByRole('button', { name: '另存为模板' }).click();
      await page.getByPlaceholder('输入新模板名称').fill('我的微前端模板');
      await page.getByRole('button', { name: '保存', exact: true }).click();
      await expect(page.getByText(/已另存为模板/)).toBeVisible();

      // Confirm and run to completion
      await page.getByRole('button', { name: /确认开始执行/ }).click();
      await expect(page.locator('.wb-tb-status')).toContainText('已完成', {
        timeout: 10_000,
      });
    } finally {
      await h.cleanup();
    }
  });

  test('Node failure single-step retry with model override + Pause, queued constraint, Resume, and double-confirm Cancel', async ({
    page,
  }) => {
    const h = await startWorkbenchHarness({ failOnceNodeRole: 'designer' });
    try {
      await page.setViewportSize({ width: 1280, height: 860 });
      await page.goto(h.urlWithToken);

      await page.getByLabel('选择工作流模板').selectOption('deep-research');
      await page.getByLabel('任务描述').fill('验证单节点失败与重试');
      await page.getByLabel('启动任务').click();

      await expect(page.getByTestId('retry-action-strip')).toBeVisible({
        timeout: 10_000,
      });
      await page.getByLabel('重试 Agent').selectOption('codex');
      await page.getByRole('button', { name: '仅重试此节点' }).click();

      await expect(page.getByTestId('confirm-action-strip')).toBeVisible({
        timeout: 10_000,
      });
    } finally {
      await h.cleanup();
    }

    const hSlow = await startWorkbenchHarness({ slowFirstNodeMs: 8000 });
    try {
      await page.goto(hSlow.urlWithToken);
      await page.getByLabel('选择工作流模板').selectOption('deep-research');
      await page.getByLabel('任务描述').fill('测试暂停恢复与二次确认终止');
      await page.getByLabel('启动任务').click();

      await expect(page.getByLabel('暂停任务')).toBeVisible({ timeout: 5_000 });
      await page.getByLabel('暂停任务').click();
      await expect(page.locator('.wb-tb-status')).toContainText('已暂停', {
        timeout: 5_000,
      });
      // Verify paused node body does not falsely say "已完成"
      await expect(page.locator('.wb-nb-body').first()).toContainText('已暂停');

      await page.getByLabel('补充约束').fill('必须兼顾离线部署场景');
      await page.getByLabel('发送').click();
      await expect(page.getByText('待注入约束')).toBeVisible();

      // Resume task briefly, then trigger double-confirm Cancel
      await page.getByLabel('继续执行').click();
      await expect(page.getByText('已恢复任务执行')).toBeVisible();
      await page.getByLabel('终止任务').click();
      await expect(page.getByTestId('cancel-confirm-bar')).toBeVisible();
      await page.getByTestId('cancel-confirm-bar').getByRole('button', { name: '确认终止' }).click();
      await expect(page.locator('.wb-tb-status')).toContainText('已终止', {
        timeout: 5_000,
      });
    } finally {
      await hSlow.cleanup();
    }
  });

  test('Settings cascading Agent->Model->Effort selectors, draft preservation, Dark Mode persistence, 9-combo width & narrow viewport zero-overflow', async ({
    page,
  }) => {
    const h = await startWorkbenchHarness({ readyAgents: false });
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(h.urlWithToken);

      // Preflight blocker shown because explorer is explicitly bound to unauthenticated claude-code
      await expect(page.getByTestId('preflight-blocker')).toBeVisible();

      // Navigate to Settings -> Roles
      await page.getByRole('button', { name: '切换角色 Agent' }).click();
      await expect(page).toHaveURL(/\/settings\/roles/);

      const explorerCard = page.getByTestId('role-card-explorer');
      await expect(explorerCard).toBeVisible();

      // Edit prompt (unsaved draft) and switch content width -> draft must be preserved!
      const promptInput = explorerCard.locator('textarea');
      await promptInput.fill('UNSAVED_DRAFT_PROMPT_CHECK');
      await page.getByLabel(/内容宽度/).click();
      await page.getByRole('menuitemradio', { name: /宽/ }).first().click();
      await expect(promptInput).toHaveValue('UNSAVED_DRAFT_PROMPT_CHECK');

      // Cascading Agent -> Model -> Effort selector
      await explorerCard.getByLabel('Agent').selectOption('codex');
      await expect(explorerCard.getByLabel('模型')).toHaveValue('gpt-5.4');
      await expect(explorerCard.locator('[data-agent-icon="codex"]').first()).toBeVisible();
      await explorerCard.getByRole('button', { name: '保存' }).click();
      await expect(page.getByText(/已保存角色/)).toBeVisible();

      // Refresh Agent probe
      await page.getByRole('button', { name: /刷新 Agent/ }).click();
      await expect(page.getByText('已刷新本机 Agent 探测列表')).toBeVisible();

      // Toggle Dark Mode & verify persistence across full reload
      await page.getByLabel('切换深色模式').click();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
      await page.reload();
      await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');

      // 9-combo responsive width clamping zero-overflow assertion: {1440, 1024, 768} x {normal, wide, full}
      const viewports = [1440, 1024, 768];
      const presets: Array<{ label: RegExp; attr: string }> = [
        { label: /^正常/, attr: 'normal' },
        { label: /^宽/, attr: 'wide' },
        { label: /^全宽/, attr: 'full' },
      ];
      for (const width of viewports) {
        await page.setViewportSize({ width, height: 820 });
        for (const preset of presets) {
          await page.getByLabel(/内容宽度/).click();
          await page.getByRole('menuitemradio', { name: preset.label }).click();
          await expect(page.locator('.wb-app')).toHaveAttribute('data-width', preset.attr);
          const overflow = await page.evaluate(() => ({
            scrollWidth: document.documentElement.scrollWidth,
            innerWidth: window.innerWidth,
          }));
          expect(
            overflow.scrollWidth,
            `horizontal overflow at ${width}px / ${preset.attr}`,
          ).toBeLessThanOrEqual(overflow.innerWidth);
        }
      }

      // Narrow viewport (768px) sidebar drawer open & Esc close
      await page.setViewportSize({ width: 768, height: 820 });
      await page.getByLabel('打开任务列表').click();
      await expect(page.locator('.wb-sidebar.open')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('.wb-sidebar.open')).toHaveCount(0);
    } finally {
      await h.cleanup();
    }
  });

  test('hides blueprint actions after cancelling dynamic task and clears stale detail when switching to an unloadable task', async ({
    page,
  }) => {
    const h = await startWorkbenchHarness();
    try {
      await page.setViewportSize({ width: 1280, height: 860 });
      await page.goto(h.urlWithToken);

      // Start dynamic task -> pauses at blueprint_review
      await page.getByLabel('选择工作流模板').selectOption('__dynamic__');
      await page.getByLabel('任务描述').fill('验证终止后隐藏蓝图与切换防串台');
      await page.getByLabel('启动任务').click();
      await expect(page.getByTestId('blueprint-card')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByRole('button', { name: /确认开始执行/ })).toBeVisible();

      // Cancel while awaiting blueprint review -> blueprint card & confirm button must disappear!
      await page.getByLabel('终止任务').click();
      await expect(page.getByTestId('cancel-confirm-bar')).toBeVisible();
      await page.getByRole('button', { name: '确认终止' }).click();
      await expect(page.locator('.wb-tb-status')).toContainText('已终止', { timeout: 5_000 });
      await expect(page.getByTestId('blueprint-card')).toHaveCount(0);

      // Navigate to a non-existent task route -> must NOT keep previous task detail or controls!
      await page.goto(`${h.server.url}/tasks/run_missing_404#token=${encodeURIComponent(h.token)}`);
      await expect(page.getByTestId('task-load-error')).toBeVisible({ timeout: 5_000 });
      await expect(page.getByTestId('task-timeline')).toHaveCount(0);
      await expect(page.getByLabel('终止任务')).toHaveCount(0);
    } finally {
      await h.cleanup();
    }
  });
});
