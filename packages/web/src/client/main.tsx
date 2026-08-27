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

import './styles/tokens.css';
import './styles/reset.css';
import './styles/utilities.css';
import './styles/sessions.css';
import './styles/mobile-drawer.css';

// F7-P0-01: seed the RPC/SSE token synchronously BEFORE the first render.
// React runs child effects before parent effects, so the first `session.list`
// from a page component fires before AuthProvider's effect could set the token
// — seeding here guarantees the first-paint RPC/SSE already carries it (no 401
// on the default entry). Persist here as well: relying on AuthProvider's later
// passive effect leaves a small cross-document/reload window where the visible
// app has the token but sessionStorage does not yet. AuthProvider repeats both
// operations defensively, so the two paths remain idempotent.
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
