import { join } from 'node:path';
import {
  createSessionEventStore,
  createWriteQueue,
  openTekonDatabase,
} from '@tekon/core';
import type { Locator, Page, TestInfo } from '@playwright/test';

import { test, expect } from './shared-fixture.js';
import { credentialStatus, INPUT_LABELS } from './helpers/locators.js';

// Existing responsive-run-surfaces covers ordinary forms and plan previews.
// This file records the added admission/provider states. PNGs are review
// evidence, not pixel goldens; geometry failures remain ordinary assertions.
const WIDTHS = [320, 390, 700, 1440] as const;
const CHECKED_AT = '2026-09-05T03:00:00.000Z';
const SNAPSHOT_ERROR = '受理快照读取失败，请重试以确认当前运行是否就绪。';

async function expectReachable(control: Locator) {
  await expect(control).toBeVisible();
  await expect(control).toBeEnabled();
  await control.scrollIntoViewIfNeeded();
  await expect
    .poll(
      async () => {
        const box = await control.boundingBox();
        const viewport = control.page().viewportSize();
        if (!box || !viewport) return Infinity;
        // Measure all four edges in pixels; intersection ratios can round a fully
        // reachable small control just below a percentage threshold.
        return Math.max(
          0,
          -box.x,
          -box.y,
          box.x + box.width - viewport.width,
          box.y + box.height - viewport.height,
        );
      },
      { message: '关键控件四边应位于视口内，仅允许 1px 取整误差' },
    )
    .toBeLessThanOrEqual(1);
  await control.click({ trial: true });
  await control.focus();
  await expect(control).toBeFocused();
}

async function auditSurface(surface: Locator, info: TestInfo, label: string) {
  await expect(surface).toBeVisible();
  await surface.page().evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  const report = await surface.evaluate((root) => {
    const visible = (element: Element) => {
      if (element.closest('.sr-only,[hidden]')) return false;
      const closedDetails = element.closest('details:not([open])');
      if (closedDetails) {
        const summary = closedDetails.querySelector(':scope > summary');
        if (!summary || (element !== summary && !summary.contains(element)))
          return false;
      }
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.visibility !== 'hidden' &&
        style.display !== 'none'
      );
    };
    const rect = root.getBoundingClientRect();
    const controls = [
      ...root.querySelectorAll<HTMLElement>(
        'button,input,select,textarea,a[href],summary',
      ),
    ].filter(visible);
    const controlBoxes = controls.map((element) => {
      const box = element.getBoundingClientRect();
      return {
        label:
          element.getAttribute('aria-label') ||
          element.id ||
          element.textContent?.trim().slice(0, 80) ||
          element.tagName,
        left: box.left,
        right: box.right,
        top: box.top,
        bottom: box.bottom,
      };
    });
    const overlap: string[] = [];
    for (let left = 0; left < controls.length; left++) {
      for (let right = left + 1; right < controls.length; right++) {
        if (
          controls[left]!.contains(controls[right]!) ||
          controls[right]!.contains(controls[left]!)
        )
          continue;
        const a = controlBoxes[left]!;
        const b = controlBoxes[right]!;
        if (
          Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
        )
          overlap.push(`${a.label} / ${b.label}`);
      }
    }
    const textOutside: string[] = [];
    let textFragments = 0;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const parent = node.parentElement;
      if (!node.data.trim() || !parent || !visible(parent)) continue;
      // Native inputs manage their own value layout; their box and reachability
      // are checked separately. Hidden option labels are not rendered text.
      if (parent.closest('select,textarea')) continue;
      const range = document.createRange();
      range.selectNodeContents(node);
      for (const box of range.getClientRects()) {
        if (!box.width || !box.height) continue;
        textFragments++;
        if (box.left < -1 || box.right > innerWidth + 1)
          textOutside.push(node.data.trim().slice(0, 100));
      }
    }
    const clipped: string[] = [];
    controls.forEach((element, index) => {
      const box = controlBoxes[index]!;
      let ancestor = element.parentElement;
      while (ancestor) {
        const style = getComputedStyle(ancestor);
        if (style.overflowX !== 'visible') {
          const bounds = ancestor.getBoundingClientRect();
          if (box.left < bounds.left - 1 || box.right > bounds.right + 1)
            clipped.push(box.label);
        }
        ancestor = ancestor.parentElement;
      }
    });
    return {
      viewport: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      surface: { left: rect.left, right: rect.right, width: rect.width },
      controls: controlBoxes,
      outside: controlBoxes.filter(
        (box) => box.left < -1 || box.right > innerWidth + 1,
      ),
      clipped,
      overlap,
      textFragments,
      textOutside,
    };
  });
  await info.attach(`${label}-geometry`, {
    body: JSON.stringify(report, null, 2),
    contentType: 'application/json',
  });
  expect(report.documentWidth).toBeLessThanOrEqual(report.viewport + 1);
  expect(report.surface.left).toBeGreaterThanOrEqual(-1);
  expect(report.surface.right).toBeLessThanOrEqual(report.viewport + 1);
  expect(report.textFragments).toBeGreaterThan(0);
  expect(report.outside).toEqual([]);
  expect(report.clipped).toEqual([]);
  expect(report.overlap).toEqual([]);
  expect(report.textOutside).toEqual([]);
}

async function capture(page: Page, info: TestInfo, label: string) {
  await page.locator('#main-content').focus();
  await page.evaluate(async () => {
    await document.fonts.ready;
    window.scrollTo(0, 0);
    await new Promise<void>((resolve) =>
      requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
    );
  });
  const path = info.outputPath(`${label}.png`);
  await page.screenshot({
    path,
    fullPage: true,
    animations: 'disabled',
    caret: 'hide',
  });
  await info.attach(label, { path, contentType: 'image/png' });
}

async function expectRunMetadataReadable(page: Page, info: TestInfo) {
  const metadata = page.locator('.run-header-meta');
  await expect(metadata).toBeVisible();
  await expect(metadata.locator(':scope > span')).toHaveCount(5);
  const items = await metadata
    .locator(':scope > span')
    .evaluateAll((elements) =>
      elements.map((element) => {
        const style = getComputedStyle(element);
        const lineHeight =
          Number.parseFloat(style.lineHeight) ||
          Number.parseFloat(style.fontSize) * 1.6;
        const box = element.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(element);
        const tops = [...range.getClientRects()]
          .filter((rect) => rect.width > 0 && rect.height > 0)
          .map((rect) => rect.top)
          .sort((a, b) => a - b);
        const lines: number[] = [];
        for (const top of tops) {
          if (
            lines.length === 0 ||
            top - lines[lines.length - 1]! > lineHeight / 2
          )
            lines.push(top);
        }
        const decoration =
          Number.parseFloat(style.paddingTop) +
          Number.parseFloat(style.paddingBottom) +
          Number.parseFloat(style.borderTopWidth) +
          Number.parseFloat(style.borderBottomWidth);
        return {
          text: element.textContent?.trim(),
          lines: lines.length,
          width: box.width,
          height: box.height,
          singleLineHeight: lineHeight + decoration,
        };
      }),
    );
  await info.attach('run-unready-metadata-readability', {
    body: JSON.stringify(items, null, 2),
    contentType: 'application/json',
  });
  // Every fixture value fits individually at 320 px. Rows may wrap, but an
  // individual badge/metadata value must not become a column of single glyphs.
  // Flex rows may legitimately stretch text-only spans to the padded badge's
  // height. Use the tallest single-line sibling as that row's height budget.
  const rowHeight = Math.max(...items.map((item) => item.singleLineHeight));
  for (const item of items) {
    expect(item.lines, `${item.text} 应完整显示为一行`).toBe(1);
    expect(
      item.height,
      `${item.text} 不应因 flex 挤压而增加行高`,
    ).toBeLessThanOrEqual(rowHeight + 1);
  }
}

async function seedSession(projectRoot: string) {
  const db = openTekonDatabase({
    filename: join(projectRoot, '.tekon', 'tekon.sqlite'),
  });
  try {
    const store = createSessionEventStore(db, createWriteQueue());
    const workspace = await store.getOrCreateDefaultWorkspace(projectRoot);
    const session = await store.createSession({
      workspaceId: workspace.id,
      runId: 'run_1',
      profile: 'human-web',
      title: '等待目录恢复的受控交付任务',
    });
    await store.updateSessionStatus(session.id, 'active');
    await store.appendEvent({
      sessionId: session.id,
      type: 'workflow/started',
      payload: { runId: 'run_1' },
    });
    return session.id;
  } finally {
    db.close();
  }
}

for (const width of WIDTHS) {
  test.describe(`R23 admission evidence ${width}px`, () => {
    test.use({ viewport: { width, height: width <= 390 ? 844 : 900 } });

    test('TopBar provider error, prior check time and retry remain readable and reachable', async ({
      page,
      server,
    }, info) => {
      let providerCalls = 0;
      await page.route('**/api/rpc', async (route) => {
        if (route.request().postDataJSON().path !== 'project.providerHealth')
          return route.continue();
        providerCalls++;
        if (providerCalls > 1)
          return route.fulfill({
            status: 500,
            json: {
              error: {
                code: 'INTERNAL_ERROR',
                message: 'provider check failed',
              },
            },
          });
        return route.fulfill({
          json: {
            result: {
              provider: 'dsh-headless',
              status: 'unavailable',
              checkedAt: CHECKED_AT,
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
            },
          },
        });
      });
      await page.goto(`${server.url}/?r23-layout=provider-${width}`);
      await expect(credentialStatus(page, 'valid')).toContainText(
        'dsh-headless不可用',
      );
      await credentialStatus(page).click();
      const panel = page.getByRole('dialog', { name: '连接管理' });
      const retry = panel.getByRole('button', { name: '重新检查 Provider' });
      await retry.click();
      await expect(panel.getByTestId('provider-health-state')).toHaveText(
        '检查失败',
      );
      await expect(panel.locator('time')).toHaveAttribute(
        'datetime',
        CHECKED_AT,
      );
      for (const control of [
        retry,
        panel.getByLabel(INPUT_LABELS.SESSION_TOKEN),
        panel.getByRole('button', { name: '应用连接' }),
        panel.getByRole('button', { name: '关闭连接管理面板' }),
      ])
        await expectReachable(control);
      await auditSurface(
        page.locator('.topbar'),
        info,
        'topbar-provider-error',
      );
      await capture(page, info, `${width}-topbar-provider-error`);
    });

    test('simple unknown and advanced recovery records fit without hiding recovery actions', async ({
      page,
      server,
    }, info) => {
      let outcome: 'unknown' | 'recovery' = 'unknown';
      await page.route('**/api/rpc', async (route) => {
        const body = route.request().postDataJSON();
        if (body.path === 'project.admissionIntent' && body.input.run) {
          const response = await route.fetch();
          const data = await response.json();
          expect(data.error).toBeUndefined();
          data.result.requestId = `r23-${width}-${outcome}-`.padEnd(128, 'x');
          return route.fulfill({ json: data });
        }
        if (body.path !== 'project.run') return route.continue();
        if (outcome === 'unknown')
          return route.fulfill({
            status: 500,
            json: {
              error: {
                code: 'INTERNAL_ERROR',
                message: '暂时无法确认受理结果，请保留原请求身份并查询或重试。',
              },
            },
          });
        return route.fulfill({
          json: {
            result: {
              requestId: body.input.requestId,
              replayed: false,
              admissionState: 'recovery-required',
              sessionId: 'session-layout-recovery',
              jobId: 'job-layout-recovery',
              run: {
                id: 'run_1',
                projectId: 'project-layout',
                demandId: 'demand-layout',
                demandTitle: null,
                provider: 'mock',
                status: 'running',
                currentNodeId: null,
                createdAt: CHECKED_AT,
                updatedAt: CHECKED_AT,
                admissionState: 'recovery-required',
                filesState: 'recovery_required',
              },
            },
          },
        });
      });
      await page.goto(`${server.url}/?r23-layout=simple-${width}`);
      const simpleInput = page.getByLabel('新建受控交付任务');
      await simpleInput.fill(
        '检查受控交付失败后的请求身份、查询操作与明确新建入口在窄屏中仍然可读可达。',
      );
      const simpleSubmit = page.getByRole('button', { name: '启动受控交付' });
      await simpleSubmit.click();
      await expect(page.getByTestId('admission-notice')).toContainText(
        '受理状态待确认',
      );
      for (const control of [
        simpleInput,
        simpleSubmit,
        page.getByRole('button', { name: '查询受理结果' }),
        page.getByRole('button', { name: '明确新建另一个任务' }),
      ])
        await expectReachable(control);
      await auditSurface(
        page.locator('.session-composer'),
        info,
        'simple-unknown',
      );
      await capture(page, info, `${width}-simple-unknown`);

      outcome = 'recovery';
      await page.goto(
        `${server.url}/advanced/runs?r23-layout=recovery-${width}`,
      );
      await page.getByRole('button', { name: '✦ 新建运行' }).click();
      const demand = page.getByLabel('需求描述', { exact: true });
      await demand.fill(
        '高级入口的目录恢复提示应保留观察原会话的链接，并让用户理解任务尚未执行。',
      );
      const submit = page.getByRole('button', { name: '▶ 发起运行' });
      await submit.click();
      const notice = page.getByTestId('admission-notice');
      await expect(notice).toContainText('已受理，等待目录恢复');
      await expect(notice).toContainText('任务尚未执行');
      for (const control of [
        demand,
        page.getByLabel('运行模式', { exact: true }),
        submit,
        notice.getByRole('button', { name: '查询受理结果' }).last(),
        notice.getByRole('link', { name: '观察原会话' }),
        notice.getByRole('button', { name: '明确新建另一个任务' }),
      ])
        await expectReachable(control);
      await auditSurface(
        page.locator('#start-run-form-body'),
        info,
        'advanced-form',
      );
      await auditSurface(notice, info, 'advanced-recovery');
      await capture(page, info, `${width}-advanced-recovery`);
    });

    test('Session and Run unready and error details preserve readable guidance and reachable retry', async ({
      page,
      server,
      fixture,
    }, info) => {
      test.setTimeout(45_000);
      const sessionId = await seedSession(fixture.projectRoot);
      let failure = false;
      await page.route('**/api/rpc', async (route) => {
        const body = route.request().postDataJSON();
        if (body.path !== 'session.get' && body.path !== 'review.get')
          return route.continue();
        if (failure)
          return route.fulfill({
            status: 500,
            json: {
              error: { code: 'INTERNAL_ERROR', message: SNAPSHOT_ERROR },
            },
          });
        const response = await route.fetch();
        const data = await response.json();
        expect(data.error).toBeUndefined();
        const value =
          body.path === 'session.get' ? data.result.session : data.result;
        value.admissionState = 'recovery-required';
        value.filesState = 'recovery_required';
        return route.fulfill({ json: data });
      });
      await page.goto(
        `${server.url}/sessions/${sessionId}?r23-layout=unready-${width}`,
      );
      await expect(page.getByTestId('admission-readiness')).toContainText(
        '任务尚未执行',
      );
      await expect(
        page.locator('[data-event-type="workflow/started"]'),
      ).toBeVisible();
      await expect(page.locator('.session-conn-live')).toBeVisible();
      await expect(page.getByRole('button', { name: '暂停运行' })).toHaveCount(
        0,
      );
      await auditSurface(
        page.locator('.session-detail'),
        info,
        'session-unready',
      );
      await auditSurface(
        page.locator('.session-side-col'),
        info,
        'session-unready-controls',
      );
      await capture(page, info, `${width}-session-unready`);

      failure = true;
      await page.goto(
        `${server.url}/sessions/${sessionId}?r23-layout=error-${width}`,
      );
      await expect(
        page.getByText(SNAPSHOT_ERROR, { exact: true }),
      ).toBeVisible();
      await expect(page.locator('.session-conn-live')).toBeVisible();
      await expect(page.getByRole('button', { name: '暂停运行' })).toHaveCount(
        0,
      );
      await expectReachable(
        page.getByRole('button', { name: '↻ 重试', exact: true }),
      );
      await auditSurface(
        page.locator('.session-detail'),
        info,
        'session-error',
      );
      await capture(page, info, `${width}-session-error`);

      failure = false;
      await page.goto(
        `${server.url}/advanced/runs/run_1?r23-layout=unready-${width}`,
      );
      await expect(page.getByTestId('admission-readiness')).toContainText(
        '任务尚未执行',
      );
      await expect(page.locator('.run-header-actions button')).toHaveCount(0);
      await expectReachable(page.getByRole('link', { name: '运行列表 Runs' }));
      await expectRunMetadataReadable(page, info);
      await auditSurface(page.locator('.view'), info, 'run-unready');
      await capture(page, info, `${width}-run-unready`);

      failure = true;
      await page.goto(
        `${server.url}/advanced/runs/run_1?r23-layout=error-${width}`,
      );
      await expect(
        page.getByText(SNAPSHOT_ERROR, { exact: true }),
      ).toBeVisible();
      await expectReachable(
        page.getByRole('button', { name: '↻ 重试', exact: true }),
      );
      await expectReachable(page.getByRole('link', { name: '运行列表 Runs' }));
      await auditSurface(page.locator('.view'), info, 'run-error');
      await capture(page, info, `${width}-run-error`);
    });
  });
}
