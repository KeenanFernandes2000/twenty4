// App shell: a fixed sidebar nav + a scrollable content pane. Hash-based routing
// (no router dependency) keeps the build minimal.
import type { ReactNode } from 'react';
import { useAuth } from '../auth';
import { Button } from './ui';
import { c, radii, space, font } from '../theme';

export type Route = 'users' | 'reports' | 'content' | 'ops';

const NAV: { route: Route; label: string; hint: string }[] = [
  { route: 'reports', label: 'Reports', hint: 'moderation queue' },
  { route: 'users', label: 'Users', hint: 'search · suspend · ban' },
  { route: 'content', label: 'Content', hint: 'remove montage/comment' },
  { route: 'ops', label: 'Ops', hint: 'jobs · storage · metrics' },
];

export function Layout({
  route,
  onNavigate,
  children,
}: {
  route: Route;
  onNavigate: (r: Route) => void;
  children: ReactNode;
}) {
  const { me, signOut } = useAuth();
  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <aside
        style={{
          width: 232,
          flexShrink: 0,
          background: c.bg,
          borderRight: `1px solid ${c.border}`,
          padding: space.lg,
          display: 'flex',
          flexDirection: 'column',
          gap: space.xs,
          position: 'sticky',
          top: 0,
          height: '100vh',
        }}
      >
        <div style={{ marginBottom: space.lg }}>
          <div
            style={{
              fontSize: 22,
              fontWeight: 900,
              color: c.accent,
              letterSpacing: -0.5,
            }}
          >
            twenty4
          </div>
          <div style={{ fontSize: 11, fontWeight: 800, color: c.faint, letterSpacing: 1 }}>
            ADMIN CONSOLE
          </div>
        </div>

        {NAV.map((n) => {
          const active = n.route === route;
          return (
            <button
              key={n.route}
              onClick={() => onNavigate(n.route)}
              style={{
                textAlign: 'left',
                background: active ? c.accentSoft : 'transparent',
                border: `1px solid ${active ? `${c.accent}44` : 'transparent'}`,
                borderRadius: radii.md,
                padding: '10px 12px',
                color: active ? c.accent : c.text2,
                display: 'block',
              }}
            >
              <div style={{ fontWeight: 800, fontSize: 14 }}>{n.label}</div>
              <div style={{ fontSize: 11, color: active ? c.accent2 : c.faint, marginTop: 1 }}>
                {n.hint}
              </div>
            </button>
          );
        })}

        <div style={{ flex: 1 }} />

        <div
          style={{
            borderTop: `1px solid ${c.border}`,
            paddingTop: space.md,
            display: 'grid',
            gap: space.sm,
          }}
        >
          <div style={{ fontSize: 12, color: c.muted }}>
            <div style={{ fontWeight: 800, color: c.text2 }}>
              {me?.displayName || me?.username || 'admin'}
            </div>
            <div style={{ fontFamily: font.mono, fontSize: 11, color: c.faint }}>
              {me?.email ?? me?.username ?? ''}
            </div>
          </div>
          <Button onClick={() => void signOut()} style={{ justifyContent: 'center' }}>
            Sign out
          </Button>
        </div>
      </aside>

      <main
        style={{
          flex: 1,
          padding: space.xl,
          maxWidth: 1180,
          margin: '0 auto',
          width: '100%',
        }}
      >
        {children}
      </main>
    </div>
  );
}

export function PageHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div style={{ marginBottom: space.xl }}>
      <h1 style={{ margin: 0, fontSize: 26, fontWeight: 900, color: c.text }}>{title}</h1>
      {subtitle && (
        <div style={{ color: c.muted, fontSize: 14, marginTop: 4 }}>{subtitle}</div>
      )}
    </div>
  );
}
