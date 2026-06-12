import { useEffect, useRef } from 'react';

const POLL_INTERVAL_MS = 3000;
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

/**
 * React hook to poll for run status updates.
 * Polls every 3 seconds when status is running/paused, stops on terminal status.
 *
 * @param status - Current run status
 * @param callback - Function to call on each poll
 */
export function useRunPoller(
  status: string | undefined,
  callback: () => void,
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!status || TERMINAL_STATUSES.has(status)) {
      return;
    }

    const intervalId = setInterval(() => {
      callbackRef.current();
    }, POLL_INTERVAL_MS);

    return () => {
      clearInterval(intervalId);
    };
  }, [status]);
}
