export interface WriteQueueOptions {
  isClosed?: () => boolean;
}

export interface WriteQueue {
  enqueue<T>(operation: () => T | Promise<T>): Promise<T>;
  markClosed?: () => void;
  isClosed?: () => boolean;
}

export function createWriteQueue(options?: WriteQueueOptions): WriteQueue {
  let closed = false;
  let tail: Promise<unknown> = Promise.resolve();

  const checkClosed = (): boolean => {
    return closed || Boolean(options?.isClosed?.());
  };

  return {
    enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
      const scope = executionWriteScope.getStore();
      const execute = () => scope ? scope(operation) : operation();
      if (checkClosed()) {
        return Promise.reject(
          new Error('WriteQueue is closed (shutdown fence active)'),
        );
      }
      const next = tail.then(
        () => {
          if (checkClosed()) {
            throw new Error('WriteQueue is closed (shutdown fence active)');
          }
          return execute();
        },
        () => {
          if (checkClosed()) {
            throw new Error('WriteQueue is closed (shutdown fence active)');
          }
          return execute();
        },
      );
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
    markClosed() {
      closed = true;
    },
    isClosed() {
      return checkClosed();
    },
  };
}
import { AsyncLocalStorage } from 'node:async_hooks';

type WriteScope = <T>(operation: () => T | Promise<T>) => T | Promise<T>;
const executionWriteScope = new AsyncLocalStorage<WriteScope>();

/** Propagates an execution's ownership fence through repository/Session writes. */
export function withExecutionWriteScope<T>(scope: WriteScope, operation: () => T): T {
  return executionWriteScope.run(scope, operation);
}

/** Event subscribers own separate operations; they do not inherit publisher leases. */
export function withoutExecutionWriteScope<T>(operation: () => T): T {
  return executionWriteScope.exit(operation);
}
