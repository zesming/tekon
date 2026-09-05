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
          return operation();
        },
        () => {
          if (checkClosed()) {
            throw new Error('WriteQueue is closed (shutdown fence active)');
          }
          return operation();
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
