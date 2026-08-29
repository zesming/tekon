import { describe, expect, it } from 'vitest';
import {
  formatTimeout,
  formatPhaseParallel,
} from '../../src/client/lib/plan-format.js';

describe('plan-format', () => {
  describe('formatTimeout', () => {
    it('returns "无限制" for undefined, null, zero, or negative ms', () => {
      expect(formatTimeout(undefined)).toBe('无限制');
      expect(formatTimeout(null)).toBe('无限制');
      expect(formatTimeout(0)).toBe('无限制');
      expect(formatTimeout(-100)).toBe('无限制');
    });

    it('formats milliseconds below 1 second', () => {
      expect(formatTimeout(500)).toBe('500 毫秒');
    });

    it('formats seconds below 1 minute', () => {
      expect(formatTimeout(1000)).toBe('1 秒');
      expect(formatTimeout(30000)).toBe('30 秒');
      expect(formatTimeout(45000)).toBe('45 秒');
    });

    it('formats minutes', () => {
      expect(formatTimeout(60000)).toBe('1 分钟');
      expect(formatTimeout(300000)).toBe('5 分钟');
      expect(formatTimeout(1800000)).toBe('30 分钟');
      expect(formatTimeout(3600000)).toBe('1 小时');
      expect(formatTimeout(7200000)).toBe('2 小时');
      expect(formatTimeout(5400000)).toBe('90 分钟');
    });
  });

  describe('formatPhaseParallel', () => {
    it('returns correct parallel vs sequential label', () => {
      expect(formatPhaseParallel(true)).toBe('并行阶段');
      expect(formatPhaseParallel(false)).toBe('顺序阶段');
    });
  });
});
