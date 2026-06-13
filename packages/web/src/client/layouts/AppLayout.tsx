import { Outlet } from 'react-router';

import { FlashMessages } from '../components/ui/FlashMessages.js';
import { Sidebar } from './Sidebar.js';
import { TopBar } from './TopBar.js';

export function AppLayout() {
  return (
    <>
      <Sidebar />
      <div className="main">
        <TopBar />
        <FlashMessages />
        <div className="view">
          <Outlet />
        </div>
      </div>
    </>
  );
}
