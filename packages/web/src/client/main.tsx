import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';

import { AuthProvider } from './context/auth-context.js';
import { FlashProvider } from './context/flash-context.js';
import { router } from './App.js';
import { readTokenFromLocation } from './lib/session-bootstrap.js';
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
// on the default entry). AuthProvider reads the same source for its initial
// state, so the two never diverge.
const initialToken = readTokenFromLocation();
setRpcSessionToken(initialToken);

createRoot(document.getElementById('root')!).render(
  <AuthProvider initialToken={initialToken}>
    <FlashProvider>
      <RouterProvider router={router} />
    </FlashProvider>
  </AuthProvider>,
);
