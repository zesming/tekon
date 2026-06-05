export interface WriteQueue {
  enqueue<T>(operation: () => T | Promise<T>): Promise<T>;
}

export function createWriteQueue(): WriteQueue {
  let tail: Promise<unknown> = Promise.resolve();

  return {
    enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
      const next = tail.then(operation, operation);
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
}
