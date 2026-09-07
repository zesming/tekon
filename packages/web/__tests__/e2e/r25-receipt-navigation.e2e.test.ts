import {
  test, expect, controls, openEntry, expectKnown, expectLocalWarning,
  observeOriginal,
} from './helpers/r25-receipt.js';

declare global {
  interface Window {
    __r25Navigation?: { hits: number; rejections: string[]; restore(): void };
  }
}

test('default entry consumes a real Data Router navigation rejection and opens the original Session on retry', async ({
  page, server, receipts,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await openEntry(page, server.url, 'simple');
  await page.evaluate(() => {
    const push = History.prototype.pushState;
    const state = {
      hits: 0,
      rejections: [] as string[],
      restore() {
        History.prototype.pushState = push;
        window.removeEventListener('unhandledrejection', observeRejection);
      },
    };
    const observeRejection = (event: PromiseRejectionEvent) => {
      state.rejections.push(String(event.reason));
      // 不 preventDefault：测试应发现真实未处理拒绝，不能把它隐藏掉。
    };
    window.addEventListener('unhandledrejection', observeRejection);
    History.prototype.pushState = function (data, unused, url) {
      const target = url == null ? null : new URL(String(url), window.location.href);
      if (target?.pathname.startsWith('/sessions/') && state.hits === 0) {
        state.hits++;
        // 当前 Router 对 DataCloneError rethrow；普通 Error 会走整页导航回退。
        throw new DOMException('R25_PRIVATE_NAVIGATION_SENTINEL', 'DataCloneError');
      }
      return push.call(this, data, unused, url);
    };
    window.__r25Navigation = state;
  });
  try {
    const { demand, submit } = controls(page, 'simple');
    const text = 'R25 导航失败保留原需求与原会话，不能重复创建';
    await demand.fill(text);
    await submit.click();
    await expect.poll(() => receipts.replies.length).toBe(1);
    const receipt = receipts.replies[0]!;
    expect(receipt.admissionState).toBe('accepted');
    await expectKnown(page, receipt);
    await expectLocalWarning(page);
    await expect(demand).toHaveValue(text);
    await expect(submit).toBeEnabled();
    await expect(page).toHaveURL(`${server.url}/`);
    const navigation = await page.evaluate(() => ({
      hits: window.__r25Navigation?.hits,
      rejections: window.__r25Navigation?.rejections,
    }));
    expect(navigation).toEqual({ hits: 1, rejections: [] });
    expect(pageErrors).toEqual([]);
    expect(receipts.requests).toHaveLength(1);
    receipts.expectOneAdmission(receipt);

    // 原按钮再点仍是同一已确认意图，不触发第二个 POST，也不自动重试路由。
    await submit.click();
    await expect(submit).toBeEnabled();
    await expectKnown(page, receipt);
    expect(receipts.requests).toHaveLength(1);
    await page.evaluate(() => window.__r25Navigation?.restore());
    await observeOriginal(page, receipt);
    await expect(page.locator('[data-event-type="user/message"]')).toContainText(text);
    receipts.expectOneAdmission(receipt);

    // 回到首页是重新挂载的表单；成功后的清空无需在旧异步 continuation 中写 state。
    await page.goBack();
    await expect(page).toHaveURL(`${server.url}/`);
    await expect(controls(page, 'simple').demand).toHaveValue('');
    await expect(controls(page, 'simple').submit).toBeDisabled();
    expect(pageErrors).toEqual([]);
    expect(receipts.requests).toHaveLength(1);
    receipts.expectOneAdmission(receipt);
  } finally {
    if (!page.isClosed()) await page.evaluate(() => window.__r25Navigation?.restore());
  }
});
