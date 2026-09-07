import type { Page, Route } from '@playwright/test';
import { test, expect } from './shared-fixture.js';

async function expectReadableFlash(page: Page, variant: 'success' | 'error' | 'info') {
  const flash = page.locator(`.flash-item.${variant}`);
  await expect(flash).toBeVisible();
  // Wait for the real entrance animation before measuring; a screenshot must
  // also disable animations so it cannot capture a transparent intermediate frame.
  await expect(flash).toHaveCSS('opacity', '1');
  const appearance = await flash.evaluate(element => {
    const style = getComputedStyle(element);
    const color = style.backgroundColor;
    const alpha = color.startsWith('rgba(') ? Number(color.slice(5, -1).split(',')[3]) : color.startsWith('rgb(') ? 1 : 0;
    const bounds = element.getBoundingClientRect();
    const text = element.querySelector('span')!;
    const range = document.createRange();
    range.selectNodeContents(text);
    const textBounds = text.getBoundingClientRect();
    const dismiss = element.querySelector('button')!.getBoundingClientRect();
    return {
      alpha,
      backgroundColor: color,
      opacity: style.opacity,
      clipped: [...range.getClientRects()].some(rect => rect.left < Math.max(bounds.left, textBounds.left) - 1 ||
        rect.right > Math.min(bounds.right, textBounds.right, dismiss.left) + 1 || rect.top < bounds.top - 1 || rect.bottom > bounds.bottom + 1),
      outsideViewport: bounds.left < -1 || bounds.right > innerWidth + 1,
    };
  });
  expect(appearance).toMatchObject({ alpha: 1, opacity: '1', clipped: false, outsideViewport: false });
  await test.info().attach(`flash-${variant}-appearance`, { body: JSON.stringify(appearance), contentType: 'application/json' });
}

// Real application shell and RPC transport; faults isolate receipt semantics.
async function controls(page: Page, initialStatus = 'running') {
  const state = {
    status: initialStatus,
    calls: [] as string[],
    respond: async (route: Route, action: string) => {
      state.status = action === 'project.pause' ? 'paused' : 'running';
      await route.fulfill({ json: { result: { run: { id: 'run_1', status: state.status }, jobId: 'original-job' } } });
    },
  };
  await page.route('**/api/rpc', async route => {
    const { path, input } = route.request().postDataJSON();
    if (path === 'project.pause' || path === 'project.resume') {
      expect(input.runId).toBe('run_1');
      state.calls.push(path);
      return state.respond(route, path);
    }
    if (path === 'review.get') {
      const response = await route.fetch();
      const json = await response.json();
      json.result.workflowStatus = state.status;
      json.result.recovery = { runStatus: state.status, cancelRecovery: null, resumeRecovery: null };
      return route.fulfill({ response, json });
    }
    return route.continue();
  });
  return state;
}

for (const width of [320, 390, 768, 1440]) {
  test(`R27 ${width}px pause/resume receipts and authoritative refresh`, async ({ page, server }, info) => {
    await page.setViewportSize({ width, height: 900 });
    const state = await controls(page);
    await page.goto(`${server.url}/advanced/runs/run_1`);
    const pause = page.getByRole('button', { name: '暂停运行', exact: true });
    await pause.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('.flash-container [role="status"]')).toContainText('暂停请求已记录，活动步骤将在边界停下');
    const resume = page.getByRole('button', { name: '恢复运行', exact: true });
    await expect(resume).toBeVisible();
    await expectReadableFlash(page, 'success');
    await page.screenshot({ path: info.outputPath(`r27-${width}-pause.png`), fullPage: true, animations: 'disabled' });
    await page.getByRole('button', { name: '关闭通知' }).click();
    let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const respond = state.respond;
    state.respond = async (route, action) => { await waiting; await respond(route, action); };
    await resume.focus();
    await page.keyboard.press('Enter');
    await expect(resume).toBeDisabled();
    await page.keyboard.press('Enter');
    expect(state.calls).toEqual(['project.pause', 'project.resume']);
    release();
    await expect(page.locator('.flash-container [role="status"]')).toContainText('已受理恢复，请观察原运行');
    await expect(pause).toBeVisible();
    const overflow = await page.locator('.run-controls, .flash-item').evaluateAll(elements => elements.some(element => {
      const rect = element.getBoundingClientRect();
      return rect.left < -1 || rect.right > innerWidth + 1 || element.scrollWidth > element.clientWidth + 1;
    }));
    expect(overflow).toBe(false);
    await expectReadableFlash(page, 'success');
    await page.screenshot({ path: info.outputPath(`r27-${width}-resume.png`), fullPage: true, animations: 'disabled' });
  });
}

for (const action of ['pause', 'resume']) {
  test(`R27 ${action} error remains visible and can retry`, async ({ page, server }) => {
    await page.setViewportSize({ width: 320, height: 900 });
    const state = await controls(page, action === 'pause' ? 'running' : 'paused');
    const success = state.respond;
    state.respond = async route => { await route.fulfill({ status: 409, json: { error: { code: 'CONFLICT', message: '控制请求未完成，请核对后重试' } } }); };
    await page.goto(`${server.url}/advanced/runs/run_1`);
    const button = page.getByRole('button', { name: action === 'pause' ? '暂停运行' : '恢复运行', exact: true });
    await button.click();
    await expect(page.locator('.run-recovery-error')).toHaveText('控制请求未完成，请核对后重试');
    await expectReadableFlash(page, 'error');
    await page.getByRole('button', { name: '关闭通知' }).click();
    await expect(page.locator('.run-recovery-error')).toBeVisible();
    state.respond = success;
    await button.click();
    await expect(page.locator('.run-recovery-error')).toHaveCount(0);
    expect(state.calls).toHaveLength(2);
  });

  for (const status of ['passed', 'failed', 'cancelled']) {
    test(`R27 ${action} receipt respects concurrent ${status}`, async ({ page, server }) => {
      await page.setViewportSize({ width: 320, height: 900 });
      const state = await controls(page, action === 'pause' ? 'running' : 'paused');
      state.respond = async route => {
        state.status = status;
        await route.fulfill({ json: { result: { run: { id: 'run_1', status } } } });
      };
      await page.goto(`${server.url}/advanced/runs/run_1`);
      await page.getByRole('button', { name: action === 'pause' ? '暂停运行' : '恢复运行', exact: true }).click();
      await expect(page.locator('.flash-container [role="status"]')).toContainText('运行已结束');
      await expectReadableFlash(page, 'info');
      await expect(page.locator('.flash-container [role="status"]')).not.toContainText(/暂停请求已记录|已受理恢复/);
      await expect(page.getByRole('button', { name: /^(暂停运行|恢复运行)$/ })).toHaveCount(0);
    });
  }
}
