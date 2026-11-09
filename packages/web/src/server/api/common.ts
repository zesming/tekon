import { timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

import type { WebProjectContext } from '../project-context.js';
import { ApiError } from './errors.js';

export function assertSessionToken(
  context: WebProjectContext,
  providedToken: string,
): void {
  assertSessionTokenFromFile(context.sessionPath, providedToken);
}

/** The one session-token check: reads the token file and compares in constant time. */
export function assertSessionTokenFromFile(
  sessionPath: string,
  providedToken: string,
): void {
  if (!providedToken) {
    throw new ApiError('UNAUTHORIZED', 'Session token is required');
  }

  let expectedToken: string | undefined;
  try {
    const parsed = JSON.parse(readFileSync(sessionPath, 'utf8')) as {
      token?: unknown;
    };
    expectedToken = typeof parsed.token === 'string' ? parsed.token : undefined;
  } catch {
    throw new ApiError('UNAUTHORIZED', 'Web session token is not configured');
  }

  if (!expectedToken || !tokensEqual(providedToken, expectedToken)) {
    throw new ApiError('UNAUTHORIZED', 'Invalid session token');
  }
}

function tokensEqual(provided: string, expected: string): boolean {
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function positiveIntOrUndefined(
  value: number | undefined,
  name: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new ApiError('BAD_REQUEST', `${name} must be a positive integer`);
  }
  return value;
}

export function assertSafeName(name: string, label: string): void {
  if (!/^[a-zA-Z0-9_-]+$/u.test(name)) {
    throw new ApiError('BAD_REQUEST', `Invalid ${label}: ${name}`);
  }
}
