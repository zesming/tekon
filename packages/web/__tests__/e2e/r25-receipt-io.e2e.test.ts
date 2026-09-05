import {
  test, expect, controls, openEntry, receiptRow, expectKnown, expectLocalWarning,
  observeOriginal, failStorageOnce, expectStorageFailure,
} from './helpers/r25-receipt.js';

const POST_CASES = [
  { state: 'accepted', method: 'removeItem', otherUnknown: false },
  { state: 'accepted', method: 'getItem', otherUnknown: false },
  // accepted 清理有其他旧请求的账本时走 setItem，不是 removeItem。
  { state: 'accepted', method: 'setItem', otherUnknown: true },
  { state: 'recovery-required', method: 'setItem', otherUnknown: false },
  { state: 'recovery-required', method: 'getItem', otherUnknown: false },
] as const;

for (const entry of ['simple', 'advanced'] as const) {
  for (const scenario of POST_CASES) {
    test(`${entry}: real ${scenario.state} POST survives local ${scenario.method}${scenario.otherUnknown ? ' with another unknown' : ''}`, async ({
      page, server, receipts,
    }) => {
      if (scenario.state === 'recovery-required') receipts.blockDirectory();
      receipts.onRun = async (route, _input, index) => {
        if (scenario.otherUnknown && index === 1) return route.abort('connectionfailed');
        const { response, receipt } = await receipts.fetchRun(route);
        expect(receipt.admissionState).toBe(scenario.state);
        await failStorageOnce(page, scenario.method);
        await route.fulfill({ response });
      };
      await openEntry(page, server.url, entry);
      const { demand, submit } = controls(page, entry);
      if (scenario.otherUnknown) {
        await demand.fill('R25 应与已受理任务同时保留的旧未知请求');
        await submit.click();
        await expect.poll(() => receipts.requests.length).toBe(1);
        await expect(receiptRow(page, receipts.requests[0]!.requestId!).locator('strong'))
          .toHaveText('受理状态待确认');
      }
      const text = `R25 ${entry} ${scenario.state} ${scenario.method} 回执后存储故障`;
      await demand.fill(text);
      await submit.click();
      await expect.poll(() => receipts.replies.length).toBe(1);
      const receipt = receipts.replies[0]!;
      await expectKnown(page, receipt);
      await expectLocalWarning(page);
      await expectStorageFailure(page);
      await expect(demand).toHaveValue(text);
      await expect(submit).toBeEnabled();
      expect(receipts.requests).toHaveLength(scenario.otherUnknown ? 2 : 1);
      receipts.expectOneAdmission(receipt);
      if (scenario.state === 'recovery-required') receipts.expectNotExecuted(receipt);

      // 删除或更新失败留下旧 unknown 磁盘记录后，新提交合并仍保留 A 的回执。
      // 查询 A 也不能消除另一个未知 B 的错误；这是两项真实请求，不是单行假状态。
      if (scenario.method === 'removeItem' || (scenario.state === 'recovery-required' && scenario.method === 'setItem')) {
        receipts.onRun = async (route) => route.abort('connectionfailed');
        await demand.fill('R25 后来的未知请求 B 不得抹掉已经确认的 A');
        await submit.click();
        await expect.poll(() => receipts.requests.length).toBe(2);
        const unknownId = receipts.requests[1]!.requestId!;
        expect(unknownId).not.toBe(receipt.requestId);
        await expect(receiptRow(page, unknownId).locator('strong')).toHaveText('受理状态待确认');
        await expectKnown(page, receipt);
        const alert = page.getByTestId('admission-notice').getByRole('alert');
        await expect(alert).toContainText('受理状态待确认');
        const unknownError = await alert.innerText();
        if (scenario.state === 'recovery-required') {
          await receiptRow(page, receipt.requestId).getByRole('button', { name: '查询受理结果', exact: true }).click();
          await expect.poll(() => receipts.lookups.length).toBe(1);
          await expect(receiptRow(page, receipt.requestId).getByRole('button', { name: '查询受理结果', exact: true })).toBeEnabled();
          await expect(alert).toHaveText(unknownError);
          await expectKnown(page, receipt);
        }
        receipts.expectOneAdmission(receipt);
      }
      await observeOriginal(page, receipt);
      receipts.expectOneAdmission(receipt);
    });
  }

  for (const state of ['accepted', 'recovery-required'] as const) {
    test(`${entry}: real ${state} lookup keeps its identity when local ledger I/O fails`, async ({ page, server, receipts }) => {
      if (state === 'recovery-required') receipts.blockDirectory();
      receipts.onRun = async (route) => {
        const { receipt } = await receipts.fetchRun(route);
        expect(receipt.admissionState).toBe(state);
        // 服务端确已提交；仅丢失浏览器将收到的响应。
        await route.abort('connectionfailed');
      };
      receipts.onLookup = async (route) => {
        const { response, result } = await receipts.fetchLookup(route);
        expect(result.state).toBe(state);
        await failStorageOnce(page, state === 'accepted' ? 'removeItem' : 'setItem');
        await route.fulfill({ response });
      };
      await openEntry(page, server.url, entry);
      const { demand, submit } = controls(page, entry);
      await demand.fill(`R25 ${entry} 查询确认 ${state} 后保留回执`);
      await submit.click();
      await expect.poll(() => receipts.replies.length).toBe(1);
      const receipt = receipts.replies[0]!;
      const row = receiptRow(page, receipt.requestId);
      await expect(row.locator('strong')).toHaveText('受理状态待确认');
      await row.getByRole('button', { name: '查询受理结果', exact: true }).click();
      await expectKnown(page, receipt);
      await expectLocalWarning(page);
      await expectStorageFailure(page);
      expect(receipts.requests).toHaveLength(1);
      receipts.expectOneAdmission(receipt);
      if (state === 'recovery-required') receipts.expectNotExecuted(receipt);
      await observeOriginal(page, receipt);
      receipts.expectOneAdmission(receipt);
    });

    test(`${entry}: real ${state} lookup wins over a later failure of the original POST`, async ({ page, server, receipts }) => {
      if (state === 'recovery-required') receipts.blockDirectory();
      const post = receipts.hold();
      receipts.onRun = async (route) => {
        const { receipt } = await receipts.fetchRun(route);
        expect(receipt.admissionState).toBe(state);
        await post.wait;
        await route.abort('connectionfailed');
      };
      await openEntry(page, server.url, entry);
      const { demand, submit } = controls(page, entry);
      await demand.fill(`R25 ${entry} ${state} 查询先于 POST 断线`);
      await submit.click();
      await expect.poll(() => receipts.replies.length).toBe(1);
      const receipt = receipts.replies[0]!;
      const row = receiptRow(page, receipt.requestId);
      await row.getByRole('button', { name: '查询受理结果', exact: true }).click();
      await expectKnown(page, receipt);
      await expect.poll(() => receipts.lookups.length).toBe(1);
      expect(receipts.lookups[0]!.state).toBe(state);
      post.release();
      await expect(submit).toBeEnabled();
      await expectKnown(page, receipt);
      await expect(page.getByTestId('admission-notice').getByRole('alert')).toHaveCount(0);
      expect(receipts.requests).toHaveLength(1);
      receipts.expectOneAdmission(receipt);
      await observeOriginal(page, receipt);
    });
  }

  test(`${entry}: directory recovery retains one Run through pre-dispatch storage failure, retry disconnect and successful replay`, async ({
    page, server, receipts,
  }) => {
    receipts.blockDirectory();
    const retry = receipts.hold();
    receipts.onRun = async (route, _input, index) => {
      if (index === 2) {
        await retry.wait;
        return route.abort('connectionfailed');
      }
      const { response } = await receipts.fetchRun(route);
      await route.fulfill({ response });
    };
    await openEntry(page, server.url, entry);
    const { demand, submit } = controls(page, entry);
    const text = `R25 ${entry} 原请求目录恢复完整旅程`;
    await demand.fill(text);
    await submit.click();
    await expect.poll(() => receipts.replies.length).toBe(1);
    const receipt = receipts.replies[0]!;
    expect(receipt.admissionState).toBe('recovery-required');
    await expectKnown(page, receipt);
    await expect(submit).toBeEnabled();
    receipts.expectNotExecuted(receipt);

    // 第二次 submit 在 submittedRecord 赋值前首次 list 就失败，不能改称未创建。
    await failStorageOnce(page, 'getItem');
    await submit.click();
    await expectLocalWarning(page);
    await expectStorageFailure(page);
    await expectKnown(page, receipt);
    expect(receipts.requests).toHaveLength(1);

    await submit.click();
    await expect.poll(() => receipts.requests.length).toBe(2);
    expect(receipts.requests[1]!.requestId).toBe(receipt.requestId);
    await expectKnown(page, receipt);
    await expect(submit).toBeDisabled();
    retry.release();
    await expect(submit).toBeEnabled();
    await expectKnown(page, receipt);
    await expect(page.getByTestId('admission-notice')).not.toContainText('受理状态待确认');
    receipts.expectNotExecuted(receipt);
    receipts.expectOneAdmission(receipt);

    receipts.restoreFiles();
    await submit.click();
    await expect.poll(() => receipts.replies.length).toBe(2);
    const recovered = receipts.replies[1]!;
    expect(recovered).toMatchObject({
      requestId: receipt.requestId, sessionId: receipt.sessionId, jobId: receipt.jobId,
      admissionState: 'accepted', replayed: true, run: { id: receipt.run.id, filesState: 'ready' },
    });
    expect(receipts.requests).toHaveLength(3);
    expect(receipts.requests.map((request) => request.requestId)).toEqual(Array(3).fill(receipt.requestId));
    receipts.expectOneAdmission(recovered);
    if (entry === 'simple') {
      await expect(page).toHaveURL(new RegExp(`/sessions/${receipt.sessionId}$`, 'u'));
      await expect(page.locator('[data-event-type="user/message"]')).toContainText(text);
    } else {
      await expectKnown(page, recovered);
      await observeOriginal(page, recovered);
    }
    receipts.expectOneAdmission(recovered);
  });

  test(`${entry}: an actual old not-found lookup cannot erase a later directory-recovery POST receipt`, async ({
    page, server, receipts,
  }) => {
    receipts.blockDirectory();
    const dispatch = receipts.hold();
    const oldLookup = receipts.hold();
    receipts.onRun = async (route) => {
      await dispatch.wait;
      const { response } = await receipts.fetchRun(route);
      await route.fulfill({ response });
    };
    receipts.onLookup = async (route) => {
      const { response, result } = await receipts.fetchLookup(route);
      expect(result.state).toBe('not-found');
      await oldLookup.wait;
      await route.fulfill({ response });
    };
    await openEntry(page, server.url, entry);
    const { demand, submit } = controls(page, entry);
    await demand.fill(`R25 ${entry} 旧查询晚于目录恢复回执`);
    await submit.click();
    await expect.poll(() => receipts.requests.length).toBe(1);
    const row = receiptRow(page, receipts.requests[0]!.requestId!);
    await row.getByRole('button', { name: '查询受理结果', exact: true }).click();
    await expect.poll(() => receipts.lookups.length).toBe(1);
    dispatch.release();
    await expect.poll(() => receipts.replies.length).toBe(1);
    const receipt = receipts.replies[0]!;
    await expectKnown(page, receipt);
    oldLookup.release();
    await expect(row.getByRole('button', { name: '查询受理结果', exact: true })).toBeEnabled();
    await expectKnown(page, receipt);
    await expect(row).not.toContainText('当前尚未查到记录');
    expect(receipts.requests).toHaveLength(1);
    receipts.expectOneAdmission(receipt);
    receipts.expectNotExecuted(receipt);
    await observeOriginal(page, receipt);
  });
}
