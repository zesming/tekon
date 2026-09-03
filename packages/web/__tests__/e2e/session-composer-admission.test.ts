import { test, expect } from './shared-fixture.js';

test('default Session composer synchronously blocks duplicate Run creation', async ({
  page,
  server,
}) => {
  await page.goto(server.url);

  const demandInput = page.getByLabel('新建受控交付任务');
  const submitButton = page.getByRole('button', { name: '启动受控交付' });
  await demandInput.fill('默认入口同步单飞验证');
  await expect(submitButton).toBeEnabled();

  let projectRunCount = 0;
  await page.route('**/api/rpc', async (route) => {
    let isProjectRun = false;
    try {
      isProjectRun = route.request().postDataJSON()?.path === 'project.run';
    } catch {
      isProjectRun = false;
    }

    if (isProjectRun) {
      projectRunCount += 1;
      if (projectRunCount === 1) {
        // Keep the first call open across the second same-turn activation.
        await new Promise((resolve) => setTimeout(resolve, 800));
      }
    }
    await route.continue();
  });

  const responsePromise = page.waitForResponse(
    (response) => {
      if (!response.url().includes('/api/rpc') || response.status() !== 200) {
        return false;
      }
      try {
        return response.request().postDataJSON()?.path === 'project.run';
      } catch {
        return false;
      }
    },
    { timeout: 15_000 },
  );

  // Bypass the DOM disabled state after the first activation to prove the
  // component's synchronous latch, not React rendering speed, owns single-flight.
  await submitButton.evaluate((button: HTMLButtonElement) => {
    button.click();
    button.removeAttribute('disabled');
    button.disabled = false;
    button.click();
  });

  await responsePromise;
  expect(projectRunCount).toBe(1);
});
