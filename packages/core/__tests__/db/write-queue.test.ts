import { describe, it, expect } from 'vitest';
import { createWriteQueue } from '../../src/db/write-queue.js';

describe('createWriteQueue', () => {
  it('returns a WriteQueue with enqueue method', () => {
    const queue = createWriteQueue();
    expect(queue).toBeDefined();
    expect(typeof queue.enqueue).toBe('function');
  });

  describe('single operations', () => {
    it('returns value from sync operation', async () => {
      const queue = createWriteQueue();
      const result = await queue.enqueue(() => 42);
      expect(result).toBe(42);
    });

    it('returns value from async operation', async () => {
      const queue = createWriteQueue();
      const result = await queue.enqueue(async () => 'hello');
      expect(result).toBe('hello');
    });

    it('preserves string return type', async () => {
      const queue = createWriteQueue();
      const result = await queue.enqueue(() => 'test-string');
      expect(typeof result).toBe('string');
      expect(result).toBe('test-string');
    });

    it('preserves number return type', async () => {
      const queue = createWriteQueue();
      const result = await queue.enqueue(() => 123.45);
      expect(typeof result).toBe('number');
      expect(result).toBe(123.45);
    });

    it('preserves object return type', async () => {
      const queue = createWriteQueue();
      const obj = { key: 'value', nested: { count: 5 } };
      const result = await queue.enqueue(() => obj);
      expect(result).toEqual(obj);
      expect(result).toBe(obj); // same reference
    });
  });

  describe('sequential execution', () => {
    it('executes two async operations in order, not parallel', async () => {
      const queue = createWriteQueue();
      const executionOrder: number[] = [];

      const p1 = queue.enqueue(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        executionOrder.push(1);
        return 'first';
      });

      const p2 = queue.enqueue(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        executionOrder.push(2);
        return 'second';
      });

      const [r1, r2] = await Promise.all([p1, p2]);

      expect(r1).toBe('first');
      expect(r2).toBe('second');
      expect(executionOrder).toEqual([1, 2]);
    });

    it('executes 20 concurrent operations in strict FIFO order', async () => {
      const queue = createWriteQueue();
      const executionOrder: number[] = [];
      const promises: Promise<number>[] = [];

      for (let i = 0; i < 20; i++) {
        promises.push(
          queue.enqueue(async () => {
            // Random delay to ensure ordering is not accidental
            await new Promise(resolve => setTimeout(resolve, Math.random() * 10));
            executionOrder.push(i);
            return i;
          })
        );
      }

      const results = await Promise.all(promises);

      // Verify execution order is strictly sequential
      expect(executionOrder).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);

      // Verify all results are correct
      for (let i = 0; i < 20; i++) {
        expect(results[i]).toBe(i);
      }
    });

    it('maintains order with mixed sync and async operations', async () => {
      const queue = createWriteQueue();
      const executionOrder: string[] = [];

      const p1 = queue.enqueue(() => {
        executionOrder.push('sync-1');
        return 'sync-1';
      });

      const p2 = queue.enqueue(async () => {
        await new Promise(resolve => setTimeout(resolve, 30));
        executionOrder.push('async-2');
        return 'async-2';
      });

      const p3 = queue.enqueue(() => {
        executionOrder.push('sync-3');
        return 'sync-3';
      });

      const p4 = queue.enqueue(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        executionOrder.push('async-4');
        return 'async-4';
      });

      const results = await Promise.all([p1, p2, p3, p4]);

      expect(executionOrder).toEqual(['sync-1', 'async-2', 'sync-3', 'async-4']);
      expect(results).toEqual(['sync-1', 'async-2', 'sync-3', 'async-4']);
    });
  });

  describe('error handling', () => {
    it('sync throw in one operation does not block subsequent operations', async () => {
      const queue = createWriteQueue();
      const executionOrder: string[] = [];

      const p1 = queue.enqueue(() => {
        executionOrder.push('first');
        return 'first';
      });

      const p2 = queue.enqueue(() => {
        executionOrder.push('throwing');
        throw new Error('sync error');
      });

      const p3 = queue.enqueue(() => {
        executionOrder.push('third');
        return 'third';
      });

      // p1 should succeed
      await expect(p1).resolves.toBe('first');

      // p2 should reject
      await expect(p2).rejects.toThrow('sync error');

      // p3 should succeed and execute after p2
      await expect(p3).resolves.toBe('third');

      // All operations should have executed
      expect(executionOrder).toEqual(['first', 'throwing', 'third']);
    });

    it('async reject in one operation does not block subsequent operations', async () => {
      const queue = createWriteQueue();
      const executionOrder: string[] = [];

      const p1 = queue.enqueue(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        executionOrder.push('first');
        return 'first';
      });

      const p2 = queue.enqueue(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        executionOrder.push('rejecting');
        throw new Error('async error');
      });

      const p3 = queue.enqueue(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        executionOrder.push('third');
        return 'third';
      });

      // p1 should succeed
      await expect(p1).resolves.toBe('first');

      // p2 should reject
      await expect(p2).rejects.toThrow('async error');

      // p3 should succeed and execute after p2
      await expect(p3).resolves.toBe('third');

      // All operations should have executed
      expect(executionOrder).toEqual(['first', 'rejecting', 'third']);
    });

    it('multiple errors in sequence do not break the queue', async () => {
      const queue = createWriteQueue();
      const executionOrder: string[] = [];

      const p1 = queue.enqueue(() => {
        executionOrder.push('error-1');
        throw new Error('error 1');
      });

      const p2 = queue.enqueue(async () => {
        executionOrder.push('error-2');
        throw new Error('error 2');
      });

      const p3 = queue.enqueue(() => {
        executionOrder.push('success');
        return 'success';
      });

      await expect(p1).rejects.toThrow('error 1');
      await expect(p2).rejects.toThrow('error 2');
      await expect(p3).resolves.toBe('success');

      expect(executionOrder).toEqual(['error-1', 'error-2', 'success']);
    });

    it('error in one operation does not affect return value of next operation', async () => {
      const queue = createWriteQueue();

      const p1 = queue.enqueue(() => {
        throw new Error('fail');
      });

      const p2 = queue.enqueue(() => ({ data: 'recovered' }));

      await expect(p1).rejects.toThrow('fail');
      await expect(p2).resolves.toEqual({ data: 'recovered' });
    });
  });

  describe('queue isolation', () => {
    it('different queues operate independently', async () => {
      const queue1 = createWriteQueue();
      const queue2 = createWriteQueue();

      const order1: number[] = [];
      const order2: number[] = [];

      const p1 = queue1.enqueue(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
        order1.push(1);
        return 'q1-1';
      });

      const p2 = queue2.enqueue(async () => {
        await new Promise(resolve => setTimeout(resolve, 10));
        order2.push(1);
        return 'q2-1';
      });

      const [r1, r2] = await Promise.all([p1, p2]);

      // queue2's operation should complete first due to shorter delay
      expect(r2).toBe('q2-1');
      expect(r1).toBe('q1-1');

      // Each queue executed its own operation
      expect(order1).toEqual([1]);
      expect(order2).toEqual([1]);
    });
  });
});
