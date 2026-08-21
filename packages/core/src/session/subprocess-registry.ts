/**
 * 子进程句柄注册表（阶段 1 Event Spine，设计 §2.4）。
 *
 * key = runId；同一个 run 可能同时有 agent 子进程与 gate 命令子进程，
 * 故一个 key 对应多个 handle。cancel 时 `killAll(runId, 'SIGKILL')`
 * 兜底杀掉该 run 的全部子进程（取消传播链见设计 §2.8）。
 */
export interface SubprocessHandle {
  readonly pid: number | undefined;
  kill(signal: NodeJS.Signals): void;
}

export interface SubprocessRegistry {
  register(key: string, handle: SubprocessHandle): void;
  unregister(key: string, handle: SubprocessHandle): void;
  /** 杀掉 key 下全部 handle，返回被杀掉的 handle 数；key 不存在返回 0。 */
  killAll(key: string, signal: NodeJS.Signals): number;
  list(key: string): readonly SubprocessHandle[];
}

export function createSubprocessRegistry(): SubprocessRegistry {
  const handlesByKey = new Map<string, Set<SubprocessHandle>>();

  return {
    register(key, handle) {
      let handles = handlesByKey.get(key);
      if (!handles) {
        handles = new Set();
        handlesByKey.set(key, handles);
      }
      handles.add(handle);
    },

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
