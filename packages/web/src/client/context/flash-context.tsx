import React, { createContext, useContext, useState, useCallback, useRef } from 'react';
import type { ReactElement } from 'react';

// ---------------------------------------------------------------------------
// Flash message types
// ---------------------------------------------------------------------------

export type FlashVariant = 'success' | 'error' | 'info' | 'warning';

export interface FlashMessage {
  id: number;
  variant: FlashVariant;
  message: string;
}

interface FlashContextValue {
  messages: FlashMessage[];
  addFlash: (variant: FlashVariant, message: string, autoDismissMs?: number) => void;
  removeFlash: (id: number) => void;
}

// ---------------------------------------------------------------------------
// Flash context
// ---------------------------------------------------------------------------

const FlashContext = createContext<FlashContextValue | undefined>(undefined);

const DEFAULT_AUTO_DISMISS_MS = 5000;

// ---------------------------------------------------------------------------
// Flash provider
// ---------------------------------------------------------------------------

export interface FlashProviderProps {
  children: React.ReactNode;
}

/**
 * Provides toast/flash message management with auto-dismiss.
 */
export function FlashProvider({ children }: FlashProviderProps): ReactElement {
  const [messages, setMessages] = useState<FlashMessage[]>([]);
  const nextId = useRef(1);
  const timersRef = useRef<Map<number, ReturnType<typeof setTimeout>>>(new Map());

  const removeFlash = useCallback((id: number) => {
    setMessages((prev) => prev.filter((m) => m.id !== id));
    const timer = timersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timersRef.current.delete(id);
    }
  }, []);

  const addFlash = useCallback(
    (variant: FlashVariant, message: string, autoDismissMs: number = DEFAULT_AUTO_DISMISS_MS) => {
      const id = nextId.current++;
      const flash: FlashMessage = { id, variant, message };
      setMessages((prev) => [...prev, flash]);

      if (autoDismissMs > 0) {
        const timer = setTimeout(() => {
          removeFlash(id);
        }, autoDismissMs);
        timersRef.current.set(id, timer);
      }
    },
    [removeFlash],
  );

  return (
    <FlashContext.Provider value={{ messages, addFlash, removeFlash }}>
      {children}
    </FlashContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// useFlash hook
// ---------------------------------------------------------------------------

/**
 * Hook to access flash message management.
 */
export function useFlash(): FlashContextValue {
  const context = useContext(FlashContext);
  if (!context) {
    throw new Error('useFlash must be used within a FlashProvider');
  }
  return context;
}
