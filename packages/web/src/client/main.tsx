import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';

import { AuthProvider } from './context/auth-context.js';
import { FlashProvider } from './context/flash-context.js';
import { router } from './App.js';
import {
  persistToken,
  readTokenFromLocation,
} from './lib/session-bootstrap.js';
import { setRpcSessionToken } from './lib/rpc-client.js';

import './styles/workbench.css';

// Sync persisted theme synchronously before first render without violating strict CSP (`script-src 'self'`)
try {
  const savedTheme = localStorage.getItem('tekon.workbench.theme');
  if (savedTheme === 'dark' || savedTheme === 'light') {
    document.documentElement.dataset.theme = savedTheme;
  }
} catch {
  // ignore storage errors
}

const initialToken = readTokenFromLocation();
persistToken(initialToken);
setRpcSessionToken(initialToken);

createRoot(document.getElementById('root')!).render(
  <AuthProvider initialToken={initialToken}>
    <FlashProvider>
      <RouterProvider router={router} />
    </FlashProvider>
  </AuthProvider>,
);
