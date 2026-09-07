import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type { RunPlanPreviewSigner } from '@tekon/core';

/** 每个 Web 根实例独立保管显示密钥；不持久化、不作为受理授权。 */
export function createPlanPreviewSigner(): RunPlanPreviewSigner {
  const key = randomBytes(32);
  return {
    comparisonScope: randomUUID(),
    sign(privateFacts) {
      return createHmac('sha256', key).update(privateFacts, 'utf8').digest('hex');
    },
  };
}
