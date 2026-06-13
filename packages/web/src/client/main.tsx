import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router';

import { AuthProvider } from './context/auth-context.js';
import { FlashProvider } from './context/flash-context.js';
import { router } from './App.js';

import './styles/tokens.css';
import './styles/reset.css';
import './styles/utilities.css';

createRoot(document.getElementById('root')!).render(
  <AuthProvider>
    <FlashProvider>
      <RouterProvider router={router} />
    </FlashProvider>
  </AuthProvider>,
);
