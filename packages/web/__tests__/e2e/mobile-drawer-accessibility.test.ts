import { test, expect } from './shared-fixture.js';

const MOBILE = { width: 390, height: 844 };

test.describe('mobile navigation accessibility', () => {
  test.use({ viewport: MOBILE });

  test('drawer is modal, traps focus, and restores focus on every close path', async ({
    page,
    server,
  }) => {
    await page.goto(server.url);
    await expect(page.getByRole('heading', { name: '受控交付' })).toBeVisible({
      timeout: 15_000,
    });

    const sidebar = page.locator('#app-sidebar');
    const main = page.locator('.main');
    // Keep a stable element locator: the accessible name intentionally changes
    // from “打开导航” to “关闭导航” while the drawer is open.
    const toggle = page.locator('.nav-toggle');

    await expect(toggle).toHaveAttribute('aria-label', '打开导航');
    await toggle.click();
    await expect(sidebar).toBeVisible();
    await expect(sidebar).toHaveAttribute('role', 'dialog');
    await expect(sidebar).toHaveAttribute('aria-modal', 'true');
    await expect(page.locator('.nav-overlay')).toBeVisible();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toHaveAttribute('aria-label', '关闭导航');

    const drawerClose = page.getByRole('button', { name: '关闭侧边导航' });
    await expect(drawerClose).toBeVisible();
    await expect(drawerClose).toBeFocused();
    await expect
      .poll(() => page.evaluate(() => document.body.style.overflow))
      .toBe('hidden');
    await expect
      .poll(() =>
        main.evaluate((element) => (element as HTMLElement).inert),
      )
      .toBe(true);

    const focusableCount = await sidebar
      .locator('a[href], button:not([disabled])')
      .count();
    for (let index = 0; index < focusableCount + 2; index += 1) {
      await page.keyboard.press('Tab');
      await expect
        .poll(() =>
          page.evaluate(
            () => document.activeElement?.closest('#app-sidebar') !== null,
          ),
        )
        .toBe(true);
    }
    await page.keyboard.press('Shift+Tab');
    await expect
      .poll(() =>
        page.evaluate(
          () => document.activeElement?.closest('#app-sidebar') !== null,
        ),
      )
      .toBe(true);
    await expect(page.getByRole('button', { name: /已连接/ })).not.toBeFocused();

    await page.locator('.nav-overlay').click({ position: { x: 380, y: 400 } });
    await expect(sidebar).toBeHidden();
    await expect(toggle).toBeFocused();
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveAttribute('aria-label', '打开导航');
    await expect
      .poll(() => page.evaluate(() => document.body.style.overflow))
      .toBe('');
    await expect
      .poll(() =>
        main.evaluate((element) => (element as HTMLElement).inert),
      )
      .toBe(false);

    await toggle.click();
    await expect(drawerClose).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(sidebar).toBeHidden();
    await expect(toggle).toBeFocused();

    await toggle.click();
    await page.getByRole('link', { name: '高级 Advanced' }).click();
    await expect(page).toHaveURL(/\/advanced$/);
    await expect(sidebar).toBeHidden();
    await expect(main).toBeFocused();
  });

  test('widening the viewport clears a stale mobile drawer state', async ({
    page,
    server,
  }) => {
    await page.goto(server.url);
    const sidebar = page.locator('#app-sidebar');
    await page.getByRole('button', { name: '打开导航' }).click();
    await expect(sidebar).toBeVisible();

    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.getByRole('button', { name: '打开导航' })).toHaveCount(0);
    await expect(page.locator('.nav-overlay')).toHaveCount(0);
    await expect(sidebar).toBeVisible();
  });
});
