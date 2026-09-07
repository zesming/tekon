import {
  test, expect, controls, openEntry, receiptRow, expectKnown, expectLocalWarning,
  observeOriginal, failStorageOnce, expectStorageFailure, auditReceiptNotice,
  reachByKeyboard, captureReceipt,
} from './helpers/r25-receipt.js';

for (const width of [320, 390, 700, 1440] as const) {
  for (const entry of ['simple', 'advanced'] as const) {
    for (const state of ['accepted', 'recovery-required'] as const) {
      test(`R25 ${width}px ${entry}: ${state} local warning coexists with a long unknown request`, async ({
        page, server, receipts,
      }, info) => {
        await page.setViewportSize({ width, height: width <= 390 ? 844 : 900 });
        receipts.longRequestIds = true;
        if (state === 'recovery-required') receipts.blockDirectory();
        receipts.onRun = async (route, _input, index) => {
          if (index === 1) return route.abort('connectionfailed');
          const { response, receipt } = await receipts.fetchRun(route);
          expect(receipt.admissionState).toBe(state);
          // 共存的旧请求使两类受理回执的后处理都走 setItem；其余 I/O 分支在行为矩阵覆盖。
          await failStorageOnce(page, 'setItem');
          await route.fulfill({ response });
        };
        await openEntry(page, server.url, entry);
        const { demand, submit } = controls(page, entry);
        await demand.fill('R25 仍需查询的另一条旧请求：暂未收到服务端回执');
        await submit.click();
        await expect.poll(() => receipts.requests.length).toBe(1);
        const unknownId = receipts.requests[0]!.requestId!;
        expect(unknownId).toHaveLength(128);
        const unknownRow = receiptRow(page, unknownId);
        await expect(unknownRow.locator('strong')).toHaveText('受理状态待确认');

        const demandText = state === 'accepted'
          ? 'R25 请求已经受理，浏览器记录未更新；请保留原身份并继续观察原会话。'
          : 'R25 请求已经受理，运行目录等待恢复；本地存储故障不能使已知身份消失。';
        await demand.fill(demandText);
        await submit.click();
        await expect.poll(() => receipts.replies.length).toBe(1);
        const receipt = receipts.replies[0]!;
        expect(receipt.requestId).toHaveLength(128);
        expect(receipt.requestId).not.toBe(unknownId);
        const knownRow = await expectKnown(page, receipt);
        await expectLocalWarning(page);
        await expectStorageFailure(page);
        await expect(unknownRow.locator('strong')).toHaveText('受理状态待确认');
        await expect(unknownRow.getByRole('link')).toHaveCount(0);
        await expect(demand).toHaveValue(demandText);
        expect(receipts.requests).toHaveLength(2);
        receipts.expectOneAdmission(receipt);
        if (state === 'recovery-required') receipts.expectNotExecuted(receipt);

        const listItem = await receipts.refreshForScreenshot(entry, receipt, info);
        const assertCapturedState = async () => {
          await expect(listItem).toBeVisible();
          await expect(page.locator('#main-content [style*="spin"]')).toHaveCount(0);
          await expectKnown(page, receipt);
          await expectLocalWarning(page);
          await expect(unknownRow.locator('strong')).toHaveText('受理状态待确认');
          await expect(unknownRow.getByRole('link')).toHaveCount(0);
          await expect(demand).toHaveValue(demandText);
          await expect(submit).toBeEnabled();
          receipts.expectScreenshotState(receipt);
          receipts.expectOneAdmission(receipt);
        };
        await assertCapturedState();
        const originalLink = knownRow.getByRole('link', { name: '观察原会话', exact: true });
        const query = unknownRow.getByRole('button', { name: '查询受理结果', exact: true });
        await reachByKeyboard(page, demand, query);
        await reachByKeyboard(page, demand, originalLink);
        const label = `r25-${width}-${entry}-${state}-local-warning`;
        await auditReceiptNotice(page, info, label);
        await captureReceipt(page, info, label);
        await assertCapturedState();
        await reachByKeyboard(page, demand, query);
        await reachByKeyboard(page, demand, originalLink);
        await auditReceiptNotice(page, info, `${label}-after-capture`);
        await observeOriginal(page, receipt);
        receipts.expectOneAdmission(receipt);
      });
    }
  }
}
