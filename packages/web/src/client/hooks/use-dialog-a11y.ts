import { useEffect, useRef } from "react";

const FOCUSABLE_SELECTOR = [
  "a[href]",
  "button:not([disabled])",
  "input:not([disabled])",
  "select:not([disabled])",
  "textarea:not([disabled])",
  "[tabindex]:not([tabindex=\"-1\"])",
].join(",");

export interface UseDialogA11yOptions {
  onClose: () => void;
  isOpen?: boolean;
}

export function useDialogA11y<T extends HTMLElement = HTMLDivElement>(
  options: UseDialogA11yOptions,
): React.RefObject<T | null> {
  const { onClose, isOpen = true } = options;
  const dialogRef = useRef<T>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!isOpen) return;

    const dialogElement = dialogRef.current;
    if (!dialogElement) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    // Find all external siblings / ancestor-siblings to set inert
    const overlay = dialogElement.closest(".detail-overlay") ?? dialogElement;
    const inertElements: HTMLElement[] = [];
    let curr: HTMLElement | null = overlay as HTMLElement;
    while (curr && curr !== document.body) {
      const parentEl: HTMLElement | null = curr.parentElement;
      if (!parentEl) break;
      for (const child of Array.from(parentEl.children)) {
        if (child !== curr && child instanceof HTMLElement && !child.contains(overlay)) {
          if (!child.inert) {
            child.inert = true;
            inertElements.push(child);
          }
        }
      }
      curr = parentEl;
    }

    const getFocusableElements = (): HTMLElement[] => {
      return Array.from(
        dialogElement.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      ).filter(
        (el) =>
          !el.hasAttribute("disabled") &&
          el.getAttribute("aria-hidden") !== "true" &&
          (el.offsetParent !== null || el.offsetWidth > 0 || el.offsetHeight > 0),
      );
    };

    // Initial focus into first focusable element
    requestAnimationFrame(() => {
      const focusable = getFocusableElements();
      if (focusable.length > 0) {
        focusable[0].focus();
      } else {
        if (!dialogElement.hasAttribute("tabindex")) {
          dialogElement.setAttribute("tabindex", "-1");
        }
        dialogElement.focus();
      }
    });

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onCloseRef.current();
        return;
      }

      if (event.key !== "Tab") return;

      const focusable = getFocusableElements();
      if (focusable.length === 0) {
        event.preventDefault();
        dialogElement.focus();
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;

      if (event.shiftKey) {
        if (active === first || !dialogElement.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else {
        if (active === last || !dialogElement.contains(active)) {
          event.preventDefault();
          first.focus();
        }
      }
    };

    window.addEventListener("keydown", onKeyDown);

    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      for (const el of inertElements) {
        el.inert = false;
      }
      requestAnimationFrame(() => {
        previouslyFocused?.focus?.();
      });
    };
  }, [isOpen]);

  return dialogRef;
}
