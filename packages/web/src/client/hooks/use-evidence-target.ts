import { useEffect, useRef } from 'react';

/** 目标首次可用或请求目标变更时定位；同一目标的数据刷新不抢回焦点。 */
export function useEvidenceTarget(id: string | null, ready: boolean, scope?: string) {
  const request = useRef<{ key: string; focused: boolean } | null>(null);
  useEffect(() => {
    const key = JSON.stringify([scope, id]);
    if (request.current?.key !== key) request.current = { key, focused: false };
    if (!id || !ready || request.current.focused) return;
    const target = document.getElementById(id);
    if (!target) return;
    target.focus({ preventScroll: true });
    target.scrollIntoView({ block: 'center' });
    request.current.focused = true;
  }, [id, ready, scope]);
}
