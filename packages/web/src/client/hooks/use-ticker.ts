import { useEffect, useState } from 'react';

/** 页面级共享定时器：每 intervalMs 触发一次重渲染，驱动相对时间等随时间变化的展示。
 *  单个 setInterval，卸载时清理；不为每行创建 timer。 */
export function useTicker(intervalMs = 60_000): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return tick;
}
