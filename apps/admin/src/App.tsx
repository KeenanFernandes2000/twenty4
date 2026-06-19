// Root component. Gates on admin auth; routes via the URL hash (#/users etc.)
// so deep links + refresh work without a router dependency.
import { useEffect, useState } from 'react';
import { AuthProvider, useAuth } from './auth';
import { Layout, type Route } from './components/Layout';
import { Login } from './pages/Login';
import { Users } from './pages/Users';
import { Reports } from './pages/Reports';
import { Content } from './pages/Content';
import { Ops } from './pages/Ops';
import { Spinner } from './components/ui';
import { c } from './theme';

const ROUTES: Route[] = ['users', 'reports', 'content', 'ops'];

function parseHash(): Route {
  const h = window.location.hash.replace(/^#\/?/, '') as Route;
  return ROUTES.includes(h) ? h : 'reports';
}

function Shell() {
  const { me, loading } = useAuth();
  const [route, setRoute] = useState<Route>(parseHash);

  useEffect(() => {
    const onHash = () => setRoute(parseHash());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);

  function navigate(r: Route) {
    window.location.hash = `/${r}`;
    setRoute(r);
  }

  if (loading) {
    return (
      <div
        style={{
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          color: c.muted,
        }}
      >
        <Spinner />
        restoring session…
      </div>
    );
  }

  if (!me) return <Login />;

  return (
    <Layout route={route} onNavigate={navigate}>
      {route === 'users' && <Users />}
      {route === 'reports' && <Reports />}
      {route === 'content' && <Content />}
      {route === 'ops' && <Ops />}
    </Layout>
  );
}

export function App() {
  return (
    <AuthProvider>
      <Shell />
    </AuthProvider>
  );
}
