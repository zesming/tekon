import { Link } from 'react-router';

import { routes } from '../lib/route-paths.js';

export function NotFoundPage() {
  return (
    <>
      <header className="page-header">
        <div>
          <h1 className="page-title">404</h1>
          <p className="page-subtitle">页面不存在 · Page not found</p>
        </div>
      </header>
      <div style={{ textAlign: 'center', padding: '32px 0' }}>
        <Link to={routes.home} className="btn btn-primary">
          返回 Dashboard
        </Link>
      </div>
    </>
  );
}
