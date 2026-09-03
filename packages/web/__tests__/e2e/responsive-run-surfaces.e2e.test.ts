import type { Page, Route } from '@playwright/test';

import { test, expect } from './shared-fixture.js';

const VIEWPORTS = [320, 390, 700, 1440] as const;

type SurfaceAuditResult =
  | { missing: true }
  | {
      missing: false;
      viewport: number;
      documentWidth: number;
      bodyWidth: number;
      controlCount: number;
      textFragmentCount: number;
      outOfBounds: AuditBox[];
      clippedControls: string[];
      overlaps: string[];
      clippedText: string[];
      clippedControlText: string[];
    };

interface AuditBox {
  label: string;
  left: number;
  right: number;
  top: number;
  bottom: number;
}

interface AuditMinimums {
  controls: number;
  textFragments: number;
}

async function expectSurfaceFitsViewport(
  page: Page,
  surfaceSelector: string,
  minimums: AuditMinimums,
): Promise<void> {
  const result = await page.evaluate<SurfaceAuditResult, string>((selector) => {
    const surface = document.querySelector<HTMLElement>(selector);
    if (!surface) return { missing: true };

    const isVisible = (element: Element) => {
      const closedDetails = element.closest('details:not([open])');
      if (closedDetails) {
        const summary = closedDetails.querySelector(':scope > summary');
        if (!summary || (element !== summary && !summary.contains(element))) {
          return false;
        }
      }
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        Number(style.opacity) !== 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    const labelFor = (element: HTMLElement) => {
      const labelledBy = element.getAttribute('aria-labelledby');
      const labelledText = labelledBy
        ?.split(/\s+/u)
        .map((id) => document.getElementById(id)?.textContent?.trim())
        .filter(Boolean)
        .join(' ');
      const labels =
        element instanceof HTMLInputElement ||
        element instanceof HTMLSelectElement ||
        element instanceof HTMLTextAreaElement
          ? Array.from(element.labels ?? [])
              .map((label) => label.textContent?.trim())
              .filter(Boolean)
              .join(' ')
          : '';
      return (
        element.getAttribute('aria-label') ||
        labelledText ||
        labels ||
        element.textContent?.trim().slice(0, 80) ||
        element.id ||
        element.tagName
      );
    };
    const toBox = (rect: DOMRect, label: string): AuditBox => ({
      label,
      left: rect.left,
      right: rect.right,
      top: rect.top,
      bottom: rect.bottom,
    });
    const overlapArea = (left: AuditBox, right: AuditBox) => ({
      width:
        Math.min(left.right, right.right) - Math.max(left.left, right.left),
      height:
        Math.min(left.bottom, right.bottom) - Math.max(left.top, right.top),
    });
    const describeBox = (box: AuditBox) =>
      `${box.label} [${box.left.toFixed(1)},${box.top.toFixed(1)}-${box.right.toFixed(1)},${box.bottom.toFixed(1)}]`;

    const controls = Array.from(
      surface.querySelectorAll<HTMLElement>(
        'button, input, select, textarea, summary, [role="button"]',
      ),
    ).filter(isVisible);
    const controlBoxes = controls.map((element) => ({
      element,
      box: toBox(element.getBoundingClientRect(), labelFor(element)),
    }));
    const outOfBounds = controlBoxes
      .map(({ box }) => box)
      .filter((box) => box.left < -1 || box.right > window.innerWidth + 1);
    const clippedControls = controlBoxes.flatMap(({ element, box }) => {
      let ancestor = element.parentElement;
      while (ancestor) {
        const style = getComputedStyle(ancestor);
        if (style.overflowX !== 'visible') {
          const rect = ancestor.getBoundingClientRect();
          const left =
            rect.left + Number.parseFloat(style.borderLeftWidth || '0');
          const right =
            rect.right - Number.parseFloat(style.borderRightWidth || '0');
          if (box.left < left - 1 || box.right > right + 1) {
            return [
              `${describeBox(box)} (${labelFor(ancestor)}:${style.overflowX})`,
            ];
          }
        }
        ancestor = ancestor.parentElement;
      }
      return [];
    });
    const overlaps: string[] = [];
    for (let index = 0; index < controlBoxes.length; index += 1) {
      for (let other = index + 1; other < controlBoxes.length; other += 1) {
        const left = controlBoxes[index]!.box;
        const right = controlBoxes[other]!.box;
        const overlap = overlapArea(left, right);
        if (overlap.width > 1 && overlap.height > 1) {
          overlaps.push(`${describeBox(left)} <> ${describeBox(right)}`);
        }
      }
    }

    const textFragments: Array<{
      parent: HTMLElement;
      box: AuditBox;
    }> = [];
    const walker = document.createTreeWalker(surface, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const node = walker.currentNode as Text;
      const text = node.data.trim();
      const parent = node.parentElement;
      if (!text || !parent || !isVisible(parent)) continue;

      const range = document.createRange();
      range.selectNodeContents(node);
      for (const rect of Array.from(range.getClientRects())) {
        if (rect.width <= 0 || rect.height <= 0) continue;
        textFragments.push({
          parent,
          box: toBox(rect, text.slice(0, 80)),
        });
      }
    }

    const clippedText: string[] = [];
    for (const fragment of textFragments) {
      if (
        fragment.box.left < -1 ||
        fragment.box.right > window.innerWidth + 1
      ) {
        clippedText.push(`${fragment.box.label} (viewport)`);
        continue;
      }

      let ancestor: HTMLElement | null = fragment.parent;
      while (ancestor) {
        const style = getComputedStyle(ancestor);
        if (style.overflowX !== 'visible') {
          const rect = ancestor.getBoundingClientRect();
          const left =
            rect.left + Number.parseFloat(style.borderLeftWidth || '0');
          const right =
            rect.right - Number.parseFloat(style.borderRightWidth || '0');
          if (fragment.box.left < left - 1 || fragment.box.right > right + 1) {
            clippedText.push(
              `${fragment.box.label} (${labelFor(ancestor)}:${style.overflowX})`,
            );
            break;
          }
        }
        ancestor = ancestor.parentElement;
      }
    }

    for (const control of controlBoxes) {
      for (const fragment of textFragments) {
        if (control.element.contains(fragment.parent)) {
          continue;
        }
        const overlap = overlapArea(control.box, fragment.box);
        if (overlap.width > 1 && overlap.height > 1) {
          overlaps.push(
            `${describeBox(control.box)} <> ${describeBox(fragment.box)}`,
          );
        }
      }
    }

    for (let index = 0; index < textFragments.length; index += 1) {
      for (let other = index + 1; other < textFragments.length; other += 1) {
        const left = textFragments[index]!;
        const right = textFragments[other]!;
        if (
          left.parent === right.parent ||
          left.parent.contains(right.parent) ||
          right.parent.contains(left.parent)
        ) {
          continue;
        }
        const overlap = overlapArea(left.box, right.box);
        if (overlap.width > 1 && overlap.height > 1) {
          overlaps.push(
            `${describeBox(left.box)} <> ${describeBox(right.box)}`,
          );
        }
      }
    }

    const measureContext = document.createElement('canvas').getContext('2d');
    const clippedControlText = controls.flatMap((element) => {
      if (!measureContext) return [];

      const style = getComputedStyle(element);
      let text = '';
      if (element instanceof HTMLSelectElement) {
        text = element.options[element.selectedIndex]?.text.trim() ?? '';
      } else if (element instanceof HTMLInputElement) {
        if (['checkbox', 'radio', 'range'].includes(element.type)) return [];
        text = element.value || element.placeholder;
      } else if (element instanceof HTMLTextAreaElement) {
        if (element.wrap !== 'off') return [];
        text = element.value || element.placeholder;
      } else {
        return [];
      }
      if (!text) return [];

      measureContext.font = style.font;
      const available =
        element.clientWidth -
        Number.parseFloat(style.paddingLeft || '0') -
        Number.parseFloat(style.paddingRight || '0');
      return measureContext.measureText(text).width > available + 1
        ? [`${labelFor(element)}: ${text.slice(0, 80)}`]
        : [];
    });

    return {
      missing: false,
      viewport: window.innerWidth,
      documentWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.scrollWidth,
      controlCount: controls.length,
      textFragmentCount: textFragments.length,
      outOfBounds,
      clippedControls,
      overlaps,
      clippedText,
      clippedControlText,
    };
  }, surfaceSelector);

  if (result.missing) {
    expect(result.missing, `missing surface: ${surfaceSelector}`).toBe(false);
    return;
  }

  expect(result.documentWidth).toBeLessThanOrEqual(result.viewport + 1);
  expect(result.bodyWidth).toBeLessThanOrEqual(result.viewport + 1);
  expect(result.controlCount).toBeGreaterThanOrEqual(minimums.controls);
  expect(result.textFragmentCount).toBeGreaterThanOrEqual(
    minimums.textFragments,
  );
  expect(result.outOfBounds).toEqual([]);
  expect(result.clippedControls).toEqual([]);
  expect(result.overlaps).toEqual([]);
  expect(result.clippedText).toEqual([]);
  expect(result.clippedControlText).toEqual([]);
}

function isWorkflowPlan(route: Route): boolean {
  try {
    return route.request().postDataJSON()?.path === 'workflow.plan';
  } catch {
    return false;
  }
}

for (const width of VIEWPORTS) {
  test.describe(`run surfaces at ${width}px`, () => {
    test.use({ viewport: { width, height: width <= 390 ? 844 : 900 } });

    test('keep default and advanced controls readable and within the viewport', async ({
      page,
      server,
    }) => {
      await page.goto(server.url);
      await expect(page.locator('.session-composer')).toBeVisible();
      await expect(
        page.getByRole('region', { name: '执行前计划' }),
      ).toContainText('执行链路');
      await expect(page.getByLabel('新建受控交付任务')).toBeVisible();
      await expect(
        page.getByRole('button', { name: '启动受控交付' }),
      ).toBeVisible();
      await expectSurfaceFitsViewport(page, '.session-composer', {
        controls: 2,
        textFragments: 4,
      });

      if (width <= 390) {
        const missingDigestHandler = async (route: Route) => {
          if (!isWorkflowPlan(route)) {
            await route.continue();
            return;
          }
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              result: {
                roleChain: ['analyst', 'executor'],
                gates: [],
                phases: [],
                requiresUnrestrictedNetwork: false,
                digest: '',
              },
            }),
          });
        };
        await page.route('**/api/rpc', missingDigestHandler);
        await page.goto(`${server.url}/?fresh=responsive-missing-${width}`);
        const warning = page.getByText(
          '执行计划缺少校验摘要，已阻止启动。请重新读取计划后再试。',
        );
        await expect(warning).toBeVisible();
        await expect(
          page
            .getByRole('region', { name: '执行前计划' })
            .getByRole('button', { name: '重试' }),
        ).toBeVisible();
        await expectSurfaceFitsViewport(page, '.session-composer', {
          controls: 3,
          textFragments: 4,
        });
        await page.unroute('**/api/rpc', missingDigestHandler);
      }

      await page.goto(`${server.url}/advanced/runs`);
      await page.getByRole('button', { name: '✦ 新建运行' }).click();
      await expect(page.locator('#start-run-form-body')).toBeVisible();
      await expect(
        page.getByRole('region', { name: '执行计划预览' }),
      ).toContainText('角色链路');
      const demandInput = page.getByLabel('需求描述', { exact: true });
      const modeSelect = page.getByLabel('运行模式', { exact: true });
      const templateSelect = page.getByLabel('工作流模板', { exact: true });
      const agentSelect = page.getByLabel('执行代理', { exact: true });
      const profileSelect = page.getByLabel('Profile', { exact: true });
      const submitButton = page.getByRole('button', { name: '▶ 发起运行' });
      for (const control of [
        demandInput,
        modeSelect,
        templateSelect,
        agentSelect,
        profileSelect,
        submitButton,
      ]) {
        await expect(control).toBeVisible();
      }
      await expectSurfaceFitsViewport(page, '#start-run-form-body', {
        controls: 7,
        textFragments: 12,
      });

      if (width <= 390) {
        await agentSelect.selectOption('dsh-headless');
        await expect(page.getByRole('alert')).toContainText('联网不受限');
        await page.locator('#start-run-form-body details > summary').click();
        await expect(
          page.getByLabel('超时 (ms)', { exact: true }),
        ).toBeVisible();
        await expect(
          page.getByLabel('无进展超时 (ms)', { exact: true }),
        ).toBeVisible();
        await expect(page.getByLabel('允许脏工作区')).toBeVisible();
        await expect(
          page.getByLabel('我已知悉本次运行联网不受限'),
        ).toBeVisible();
        await expectSurfaceFitsViewport(page, '#start-run-form-body', {
          controls: 11,
          textFragments: 16,
        });
      }
    });
  });
}
