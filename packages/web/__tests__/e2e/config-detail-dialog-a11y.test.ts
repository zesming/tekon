import { test, expect } from "./shared-fixture.js";

test.describe("Config detail dialog accessibility (P1-A11Y-01 / P2-UX-01)", () => {
  test("RoleDetailPanel has aria-modal, aria-labelledby, traps Tab focus, closes on Escape, and restores focus", async ({
    page,
    server,
  }) => {
    await page.goto(`${server.url}/advanced/config`);
    await expect(page.getByText("Config", { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    const viewRoleBtn = page.getByRole("button", { name: "查看 →" }).first();
    await expect(viewRoleBtn).toBeVisible();
    await viewRoleBtn.click();

    const dialog = page.locator(".detail-panel[role=\"dialog\"]");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(dialog).toHaveAttribute("aria-labelledby", /role-detail-title-/);

    const closeBtn = page.getByRole("button", { name: "关闭角色详情" });
    await expect(closeBtn).toBeVisible();
    await expect(closeBtn).toBeFocused();

    // Background lock and inert
    await expect
      .poll(() => page.evaluate(() => document.body.style.overflow))
      .toBe("hidden");

    // Tab key cycling
    await page.keyboard.press("Tab");
    await expect
      .poll(() =>
        page.evaluate(
          () => document.activeElement?.closest(".detail-panel") !== null,
        ),
      )
      .toBe(true);

    await page.keyboard.press("Shift+Tab");
    await expect
      .poll(() =>
        page.evaluate(
          () => document.activeElement?.closest(".detail-panel") !== null,
        ),
      )
      .toBe(true);

    // Escape closes dialog and restores focus
    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(viewRoleBtn).toBeFocused();
    await expect
      .poll(() => page.evaluate(() => document.body.style.overflow))
      .toBe("");
  });

  test("WorkflowDetailPanel has aria-modal, aria-labelledby, traps Tab focus, and closes on backdrop click", async ({
    page,
    server,
  }) => {
    await page.goto(`${server.url}/advanced/config/workflows`);
    await expect(page.getByText("Config", { exact: true })).toBeVisible({
      timeout: 15_000,
    });

    const viewWorkflowBtn = page.getByRole("button", { name: "查看 →" }).first();
    await expect(viewWorkflowBtn).toBeVisible();
    await viewWorkflowBtn.click();

    const dialog = page.locator(".detail-panel[role=\"dialog\"]");
    await expect(dialog).toBeVisible();
    await expect(dialog).toHaveAttribute("aria-modal", "true");
    await expect(dialog).toHaveAttribute("aria-labelledby", /workflow-detail-title-/);

    const closeBtn = page.getByRole("button", { name: "关闭工作流详情" });
    await expect(closeBtn).toBeVisible();
    await expect(closeBtn).toBeFocused();

    // Tab key cycling
    await page.keyboard.press("Tab");
    await expect
      .poll(() =>
        page.evaluate(
          () => document.activeElement?.closest(".detail-panel") !== null,
        ),
      )
      .toBe(true);

    // Click backdrop overlay to close
    await page.locator(".detail-overlay").click({ position: { x: 10, y: 10 } });
    await expect(dialog).toBeHidden();
    await expect(viewWorkflowBtn).toBeFocused();
  });
});
