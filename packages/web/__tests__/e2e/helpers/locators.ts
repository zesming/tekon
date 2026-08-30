import type { Locator, Page } from '@playwright/test';

export const CREDENTIAL_TEXT = {
  NOT_CONFIGURED: '连接凭据：未配置',
  VALID: '连接凭据：有效',
  INVALID: '连接凭据：无效',
} as const;

export const BUTTON_LABELS = {
  CLEAR_CREDENTIAL: '清除凭据',
  APPLY_CONNECTION: '应用连接',
  SHOW_TOKEN: '显示会话令牌',
  HIDE_TOKEN: '隐藏会话令牌',
  START_CONTROLLED_DELIVERY: '启动受控交付',
  ACKNOWLEDGE_FAILED: '将失败会话标记为已处理',
  SHOW_TECHNICAL_EVENTS: '显示技术事件',
  HIDE_TECHNICAL_EVENTS: '隐藏技术事件',
} as const;

export const INPUT_LABELS = {
  SESSION_TOKEN: '会话令牌 (Session token)',
} as const;

export function credentialStatus(
  page: Page,
  status?: 'valid' | 'invalid' | 'not-configured',
): Locator {
  if (status === 'valid') {
    return page.getByRole('button', { name: CREDENTIAL_TEXT.VALID });
  }
  if (status === 'invalid') {
    return page.getByRole('button', { name: CREDENTIAL_TEXT.INVALID });
  }
  if (status === 'not-configured') {
    return page.getByRole('button', { name: CREDENTIAL_TEXT.NOT_CONFIGURED });
  }
  return page.getByRole('button', { name: /连接凭据/ });
}

export function acknowledgeFailedButton(scope: Page | Locator): Locator {
  return scope.getByRole('button', {
    name: BUTTON_LABELS.ACKNOWLEDGE_FAILED,
  });
}
