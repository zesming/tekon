import { useEffect, useRef, useState } from 'react';
import { Outlet, useLocation } from 'react-router';

import { FlashMessages } from '../components/ui/FlashMessages.js';
import { Sidebar } from './Sidebar.js';
import { TopBar } from './TopBar.js';

export function AppLayout() {
  const { pathname } = useLocation();
  const [navOpen, setNavOpen] = useState(false);
  const toggleRef = useRef<HTMLButtonElement>(null);

  // Close the mobile drawer whenever the route changes (tapping a nav link
  // navigates, then the drawer should get out of the way of the new page).
  useEffect(() => {
    setNavOpen(false);
  }, [pathname]);

  // Esc closes the drawer and returns focus to the toggle that opened it —
  // the drawer is a modal-style overlay on mobile, so keyboard dismissal is
  // the minimum accessible behavior.
  useEffect(() => {
    if (!navOpen) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        setNavOpen(false);
        toggleRef.current?.focus();
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navOpen]);

  return (
    <>
      <Sidebar open={navOpen} />
      {navOpen ? (
        <div
          className="nav-overlay"
          aria-hidden="true"
          onClick={() => setNavOpen(false)}
        />
      ) : null}
      <div className="main">
        <TopBar
          navOpen={navOpen}
          onToggleNav={() => setNavOpen((prev) => !prev)}
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
