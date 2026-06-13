import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

import { test as sharedTest, expect } from './shared-fixture.js';
import {
  createWebServer,
  type RunningWebServer,
} from '../../src/server/http.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeFakeGh(binDir: string): void {
  const ghPath = join(binDir, 'gh');
  writeFileSync(
    ghPath,
    `#!/usr/bin/env sh
echo "$*" >> "${join(binDir, 'gh.log')}"
if [ "$1 $2" = "auth status" ]; then
  echo "Logged in to github.example" >&2
  exit 0
fi
echo "https://github.example/tekon/pull/10"
`,
    'utf8',
  );
  chmodSync(ghPath, 0o755);
}

/**
 * Read the fake gh invocation log. Returns an empty string if the log file
 * does not exist (meaning gh has never been called).
 */
function readGhLog(binDir: string): string {
  const logPath = join(binDir, 'gh.log');
  if (!existsSync(logPath)) return '';
  return readFileSync(logPath, 'utf8').trim();
}

/** Start a completed run and prepare it for delivery via the RPC API. */
async function startAndPrepareRun(
  baseUrl: string,
  sessionToken: string,
): Promise<string> {
  // 1. Start a run with standard-delivery template (mock agent completes it)
  const runResponse = await fetch(`${baseUrl}/api/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: 'project.run',
      input: {
        demandText:
          'E2E test: Create PR requires explicit confirmation approval.',
        template: 'standard-delivery',
        agent: 'mock',
        token: sessionToken,
      },
    }),
  });
  if (!runResponse.ok) {
    const body = await runResponse.text();
    throw new Error(`Failed to start run: ${runResponse.status} ${body}`);
  }
  const runBody = (await runResponse.json()) as {
    result: { run: { id: string } };
  };
  const runId = runBody.result.run.id;

  // 2. Prepare delivery (creates pr-body.md and pr-package.md)
  const prepareResponse = await fetch(`${baseUrl}/api/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      path: 'delivery.prepare',
      input: { runId, token: sessionToken },
    }),
  });
  if (!prepareResponse.ok) {
    const body = await prepareResponse.text();
    throw new Error(`Failed to prepare run: ${prepareResponse.status} ${body}`);
  }

  return runId;
}

// ---------------------------------------------------------------------------
// Extended fixtures for this test file
// ---------------------------------------------------------------------------

interface CreatePrFixtures {
  binDir: string;
  remotePath: string;
}

const test = sharedTest.extend<CreatePrFixtures>({
  binDir: async ({}, use) => {
    const binDir = mkdtempSync(join(tmpdir(), 'tekon-e2e-fake-gh-'));
    writeFakeGh(binDir);
    await use(binDir);
    rmSync(binDir, { recursive: true, force: true });
  },

  remotePath: async ({}, use) => {
    const remotePath = mkdtempSync(join(tmpdir(), 'tekon-e2e-remote-'));
    execFileSync('git', ['init', '--bare'], { cwd: remotePath });
    await use(remotePath);
    rmSync(remotePath, { recursive: true, force: true });
  },

  server: async ({ fixture, binDir, remotePath }, use) => {
    // Set up a bare remote origin so git push works
    execFileSync('git', ['remote', 'add', 'origin', remotePath], {
      cwd: fixture.projectRoot,
    });

    // Start the server with fake gh in PATH
    const server = await createWebServer({
      projectRoot: fixture.projectRoot,
      port: 0,
      vite: true,
      env: { ...process.env, PATH: `${binDir}${delimiter}${process.env.PATH}` },
    });
    await server.listen();
    await use(server);
    await server.close();
  },
});

// ---------------------------------------------------------------------------
// E2E: Create PR requires explicit approval — rigorous gh invocation checks
// ---------------------------------------------------------------------------

test.describe('Create PR requires explicit confirmation', () => {
  test('fake gh is only invoked after explicit confirmation, never before', async ({
    page,
    fixture,
    server,
    binDir,
  }) => {
    // ── 0. Start a completed run via API so delivery is ready ────────────────
    const runId = await startAndPrepareRun(server.url, fixture.sessionToken);

    await page.setViewportSize({ width: 1280, height: 900 });

    // ── PROOF 1: Before any UI interaction, fake gh has NOT been called ──────
    // The server-side startAndPrepareRun calls project.run and delivery.prepare
    // via direct RPC — neither of those should invoke `gh`. Verify this.
    expect(readGhLog(binDir)).toBe('');

    // ── 1. Navigate to the delivery page ───────────────────────────────────
    await page.goto(`${server.url}/delivery`);

    // Wait for the page to load
    await expect(
      page.getByRole('heading', { name: 'Delivery' }),
    ).toBeVisible();

    // ── PROOF 2: After page load, fake gh still NOT called ─────────────────
    // The page makes several read-only RPC calls (project.overview, review.get)
    // but none of them should trigger gh.
    expect(readGhLog(binDir)).toBe('');

    // ── 2. Enter the session token ─────────────────────────────────────────
    await page.getByLabel('Session token').fill(fixture.sessionToken);

    // ── PROOF 3: After entering token, fake gh still NOT called ────────────
    expect(readGhLog(binDir)).toBe('');

    // ── 3. Create PR button becomes enabled ────────────────────────────────
    const createPrButton = page.getByRole('button', { name: 'Create PR' });
    await expect(createPrButton).toBeVisible();
    await expect(createPrButton).toBeEnabled();

    // ── 4. Click Create PR → confirmation dialog appears ───────────────────
    await createPrButton.click();

    // The confirmation dialog should appear
    await expect(page.getByText('⚠ Create Pull Request')).toBeVisible();

    // Dialog warning content is visible
    await expect(
      page.getByText(/This action will push the branch/),
    ).toBeVisible();

    // Cancel and Confirm buttons are visible
    const cancelButton = page.getByRole('button', { name: 'Cancel' });
    const confirmButton = page.getByRole('button', {
      name: 'Confirm & Create PR',
    });
    await expect(cancelButton).toBeVisible();
    await expect(confirmButton).toBeVisible();

    // ── PROOF 4: After clicking Create PR (showing dialog), gh NOT called ───
    // The dialog is just a UI overlay; no server-side action should have been
    // triggered yet.
    expect(readGhLog(binDir)).toBe('');

    // ── 5. Click backdrop to dismiss the dialog ────────────────────────────
    // The backdrop is the outer div with position: fixed. Clicking at the
    // top-left corner hits the overlay, not the inner dialog (which has
    // e.stopPropagation()).
    const backdrop = page.locator('[style*="position: fixed"]').first();
    await backdrop.click({ position: { x: 10, y: 10 } });

    // Dialog disappears
    await expect(page.getByText('⚠ Create Pull Request')).not.toBeVisible();

    // ── PROOF 5: After backdrop dismiss, gh still NOT called ────────────────
    // Dismissing the dialog without confirming must not trigger any gh
    // invocation.
    expect(readGhLog(binDir)).toBe('');

    // No PR result banner is shown
    await expect(page.getByText('PR Created Successfully')).not.toBeVisible();
    await expect(
      page.getByText('PR Creation In Progress'),
    ).not.toBeVisible();

    // The Create PR button is still visible and enabled (we can try again)
    await expect(createPrButton).toBeVisible();
    await expect(createPrButton).toBeEnabled();

    // ── 6. Click Create PR again and this time CONFIRM ─────────────────────
    await createPrButton.click();

    // Dialog reappears
    await expect(page.getByText('⚠ Create Pull Request')).toBeVisible();

    // Set up interception of the RPC request BEFORE clicking confirm.
    // We intercept the request to verify the exact RPC path and input.
    // The predicate specifically matches delivery.createPr requests.
    const rpcRequestPromise = page.waitForRequest(
      (request) => {
        if (!request.url().includes('/api/rpc') || request.method() !== 'POST')
          return false;
        try {
          const body = request.postDataJSON() as { path: string };
          return body.path === 'delivery.createPr';
        } catch {
          return false;
        }
      },
      { timeout: 30_000 },
    );

    // Also wait for a successful RPC response. We match the createPr response
    // by checking the corresponding request's path.
    const rpcResponsePromise = page.waitForResponse(
      async (response) => {
        if (!response.url().includes('/api/rpc') || response.status() !== 200)
          return false;
        try {
          const request = response.request();
          const body = request.postDataJSON() as { path: string };
          return body.path === 'delivery.createPr';
        } catch {
          return false;
        }
      },
      { timeout: 30_000 },
    );

    // Click the confirm button
    await confirmButton.click();

    // ── PROOF 6: The RPC request was delivery.createPr with approveHuman ────
    const rpcRequest = await rpcRequestPromise;
    const requestBody = rpcRequest.postDataJSON() as {
      path: string;
      input: { runId: string; token: string; approveHuman: boolean };
    };
    expect(requestBody.path).toBe('delivery.createPr');
    expect(requestBody.input.approveHuman).toBe(true);
    expect(requestBody.input.runId).toBe(runId);

    // Wait for the RPC response and verify success
    const rpcResponse = await rpcResponsePromise;
    expect(rpcResponse.ok()).toBe(true);

    const responseBody = (await rpcResponse.json()) as {
      result?: {
        prUrl?: string;
        deliveryStatus?: string;
        branch?: string;
      };
      error?: { code: string; message: string };
    };

    // Expect success result (not error)
    expect(responseBody.error).toBeUndefined();
    expect(responseBody.result).toBeDefined();
    expect(responseBody.result?.prUrl).toBe(
      'https://github.example/tekon/pull/10',
    );
    expect(responseBody.result?.deliveryStatus).toBe('created');

    // ── PROOF 7: After confirmation, fake gh WAS called ─────────────────────
    // Wait a small amount of time for the server-side process to complete
    // writing to gh.log (the gh process is synchronous but may take a moment
    // to flush through the server pipeline).
    await expect.poll(() => readGhLog(binDir), { timeout: 10_000 }).not.toBe('');

    // The log should contain a "pr create" invocation
    const ghLog = readGhLog(binDir);
    expect(ghLog).toContain('pr create');

    // ── 8. UI shows success result ──────────────────────────────────────────
    // After the mutation completes, the page invalidates cache keys and
    // refetches queries. Wait for the success banner to appear (auto-retry).
    await expect(page.getByText('PR Created Successfully')).toBeVisible({
      timeout: 15_000,
    });

    // The PR URL is shown as a link on the page (appears in both the pipeline
    // card and the result banner; use first() to handle multiple matches).
    await expect(
      page
        .getByRole('link', {
          name: 'https://github.example/tekon/pull/10',
        })
        .first(),
    ).toBeVisible();
  });
});
