import { join } from "node:path";
import {
  createSessionEventStore,
  createWriteQueue,
  openTekonDatabase,
} from "@tekon/core";
import { test, expect } from "./shared-fixture.js";

// T3 / T7: E2E test for acknowledging a failed session from the SessionsPage UI.

test("acknowledging a failed session clears its action badge and sinks it down", async ({
  page,
  server,
  fixture,
}) => {
  // 1. Seed two sessions directly in SQLite store:
  // - failedSession: status "failed", unacknowledged (needsAction rank 0, pinned at top)
  // - activeSession: status "active" (rank 1, newer timestamp)
  const db = openTekonDatabase({
    filename: join(fixture.projectRoot, ".tekon", "tekon.sqlite"),
  });
  const writeQueue = createWriteQueue();
  const store = createSessionEventStore(db, writeQueue);
  const workspace = await store.getOrCreateDefaultWorkspace(fixture.projectRoot);

  const failedSession = await store.createSession({
    workspaceId: workspace.id,
    title: "失败待确认会话",
    profile: "human-web",
    runId: "run_failed_1",
  });
  await store.updateSessionStatus(failedSession.id, "failed");

  const activeSession = await store.createSession({
    workspaceId: workspace.id,
    title: "正常运行会话",
    profile: "human-web",
    runId: "run_active_1",
  });
  await store.updateSessionStatus(activeSession.id, "active");

  // Make failed older than active to verify attention ranking overrides chronological order
  db.prepare("update sessions set created_at = ?, updated_at = ? where id = ?").run(
    "2026-08-28T09:00:00.000Z",
    "2026-08-28T09:00:00.000Z",
    failedSession.id,
  );
  db.prepare("update sessions set created_at = ?, updated_at = ? where id = ?").run(
    "2026-08-28T10:00:00.000Z",
    "2026-08-28T10:00:00.000Z",
    activeSession.id,
  );
  db.close();

  // 2. Navigate to SessionsPage
  await page.goto(`${server.url}/?ackTest=${Date.now()}`);
  await expect(page.getByRole("heading", { name: "受控交付" })).toBeVisible();

  // 3. Locate both session rows
  const failedItem = page.locator("li.session-list-item").filter({
    hasText: "失败待确认会话",
  });
  await expect(failedItem).toBeVisible({ timeout: 15_000 });

  const activeItem = page.locator("li.session-list-item").filter({
    hasText: "正常运行会话",
  });
  await expect(activeItem).toBeVisible({ timeout: 15_000 });

  // Unconditionally assert attention ordering: unacknowledged failed session is pinned at index 0
  const itemsBefore = page.locator("li.session-list-item");
  await expect(itemsBefore.nth(0)).toContainText("失败待确认会话");
  await expect(itemsBefore.nth(1)).toContainText("正常运行会话");

  // Unconditionally assert action badge and acknowledge button on the failed session
  await expect(
    failedItem.locator(".session-list-action-failed"),
  ).toHaveText("需处理");

  const ackBtn = failedItem.getByRole("button", {
    name: "确认并归档失败会话",
  });
  await expect(ackBtn).toBeVisible();

  // 4. Click the acknowledge button
  await ackBtn.click();

  // 5. Unconditionally assert that acknowledge button disappears and action badge clears
  await expect(ackBtn).not.toBeVisible({ timeout: 10_000 });
  await expect(
    failedItem.locator(".session-list-action-failed"),
  ).not.toBeVisible();

  // 6. Unconditionally assert that the failed session sank below the active session
  const itemsAfter = page.locator("li.session-list-item");
  await expect(itemsAfter.nth(0)).toContainText("正常运行会话");
  await expect(itemsAfter.nth(1)).toContainText("失败待确认会话");
});
