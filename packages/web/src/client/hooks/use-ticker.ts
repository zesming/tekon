import { useEffect, useState } from 'react';

/**
 * 页面级时钟：每 intervalMs 更新一次当前时间戳，驱动相对时间等展示。
 * 调用方只需在页面顶层调用一次，所有列表项在同一渲染周期共享同一个 nowMs；
 * 卸载时会清理 interval，不为每行创建 timer。
 */
export function useTicker(intervalMs = 60_000): number {
  const [nowMs, setNowMs] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return nowMs;
}
