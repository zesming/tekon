import { useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router';

import { FlashMessages } from '../components/ui/FlashMessages.js';
import { Sidebar } from './Sidebar.js';
import { TopBar } from './TopBar.js';

const MOBILE_NAV_QUERY = '(max-width: 768px)';
const DRAWER_FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function AppLayout() {
  const { pathname } = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const sidebarRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const previousPathRef = useRef(pathname);
  const focusMainAfterCloseRef = useRef(false);

  const closeNav = useCallback((restoreToggle = true) => {
    setNavOpen(false);
    if (restoreToggle) {
      requestAnimationFrame(() => toggleRef.current?.focus());
    }
  }, []);

  // A route selected from the drawer should reveal the destination and move
  // focus to the new main landmark. Record that intent before closing; the
  // drawer cleanup performs the focus only after it removes `inert` from main.
  useEffect(() => {
    if (previousPathRef.current !== pathname) {
      previousPathRef.current = pathname;
      if (navOpen) {
        focusMainAfterCloseRef.current = true;
        setNavOpen(false);
      }
    }
  }, [navOpen, pathname]);

  // Do not preserve a mobile-only open state across breakpoint changes. Without
  // this reset, widening and shrinking the viewport can unexpectedly reopen the
  // drawer later.
  useEffect(() => {
    const media = window.matchMedia(MOBILE_NAV_QUERY);
    const onChange = (event: MediaQueryListEvent) => {
      if (!event.matches) setNavOpen(false);
    };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);

  // The narrow sidebar behaves as a modal navigation drawer: move focus into
  // it, contain Tab/Shift+Tab, lock background scrolling, close on Escape and
  // restore focus to the invoker. Pointer interaction outside is blocked by the
  // overlay; keyboard interaction must be blocked consistently as well.
  useEffect(() => {
    if (!navOpen) return;

    const sidebar = sidebarRef.current;
    if (!sidebar) return;
    const sidebarElement = sidebar;
    const previousOverflow = document.body.style.overflow;
    const main = mainRef.current;
    document.body.style.overflow = 'hidden';
    if (main) main.inert = true;

    const focusable = () =>
      [
        ...sidebarElement.querySelectorAll<HTMLElement>(DRAWER_FOCUSABLE),
      ].filter(
        (element) =>
          !element.hasAttribute('disabled') &&
          element.getAttribute('aria-hidden') !== 'true' &&
          element.offsetParent !== null,
      );

    requestAnimationFrame(() => {
      const elements = focusable();
      (elements[0] ?? sidebarElement).focus();
    });

    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeNav(true);
        return;
      }
      if (event.key !== 'Tab') return;

      const elements = focusable();
      if (elements.length === 0) {
        event.preventDefault();
        sidebarElement.focus();
        return;
      }
      const first = elements[0]!;
      const last = elements[elements.length - 1]!;
      const active = document.activeElement;
      if (
        event.shiftKey &&
        (active === first || !sidebarElement.contains(active))
      ) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    }

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previousOverflow;
      if (main) {
        main.inert = false;
        if (focusMainAfterCloseRef.current) {
          focusMainAfterCloseRef.current = false;
          requestAnimationFrame(() => main.focus());
        }
      }
    };
  }, [closeNav, navOpen]);

  return (
    <>
      <Sidebar
        ref={sidebarRef}
        open={navOpen}
        onClose={() => closeNav(true)}
      />
      {navOpen ? (
        <div
          className="nav-overlay"
          aria-hidden="true"
          onClick={() => closeNav(true)}
        />
      ) : null}
      <div className="main" ref={mainRef} tabIndex={-1}>
        <TopBar
          navOpen={navOpen}
          onToggleNav={() =>
            navOpen ? closeNav(true) : setNavOpen(true)
          }
          toggleRef={toggleRef}
        />
        <FlashMessages />
        <div className="view">
          <Outlet />
        </div>
      </div>
    </>
  );
}
