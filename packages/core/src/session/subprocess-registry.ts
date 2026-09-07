/**
 * 子进程句柄注册表。生产后台以 Job ID 隔离每代执行；同一 Job 的
 * Agent、Gate 与 worktree 命令共享 scope，旧代 kill/close 不影响新代。
 * kill/unregister 不构成退出证据，只有真实 close 才清除未确认记录。
 */
export interface SubprocessHandle {
  readonly pid: number | undefined;
  kill(signal: NodeJS.Signals): void;
}

export interface SubprocessRegistry {
  register(key: string, handle: SubprocessHandle): void;
  unregister(key: string, handle: SubprocessHandle): void;
  /** Only the actual ChildProcess close handler may confirm physical close. */
  confirmClosed(key: string, handle: SubprocessHandle): void;
  hasUnconfirmed(key: string): boolean;
  /** 杀掉 key 下全部 handle，返回被杀掉的 handle 数；key 不存在返回 0。 */
  killAll(key: string, signal: NodeJS.Signals): number;
  list(key: string): readonly SubprocessHandle[];
}

export function createSubprocessRegistry(): SubprocessRegistry {
  const handlesByKey = new Map<string, Set<SubprocessHandle>>();
  const unconfirmedByKey = new Map<string, Set<SubprocessHandle>>();

  return {
    register(key, handle) {
      let handles = handlesByKey.get(key);
      if (!handles) {
        handles = new Set();
        handlesByKey.set(key, handles);
      }
      handles.add(handle);
      let unconfirmed = unconfirmedByKey.get(key);
      if (!unconfirmed) { unconfirmed = new Set(); unconfirmedByKey.set(key, unconfirmed); }
      unconfirmed.add(handle);
    },

    confirmClosed(key, handle) {
      const unconfirmed = unconfirmedByKey.get(key);
      unconfirmed?.delete(handle);
      if (unconfirmed?.size === 0) unconfirmedByKey.delete(key);
    },

    hasUnconfirmed(key) { return (unconfirmedByKey.get(key)?.size ?? 0) > 0; },

    unregister(key, handle) {
      const handles = handlesByKey.get(key);
      if (!handles) {
        return;
      }
      handles.delete(handle);
      if (handles.size === 0) {
        handlesByKey.delete(key);
      }
    },

    killAll(key, signal) {
      const handles = handlesByKey.get(key);
      if (!handles || handles.size === 0) {
        return 0;
      }
      const snapshot = [...handles];
      for (const handle of snapshot) {
        handle.kill(signal);
      }
      return snapshot.length;
    },

    list(key) {
      const handles = handlesByKey.get(key);
      return handles ? [...handles] : [];
    },
  };
}
