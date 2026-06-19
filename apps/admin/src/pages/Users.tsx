// Users page: search by handle/email/id, filter by status, keyset-paginate, and
// moderate (suspend / unsuspend / ban). Each action calls the corresponding admin
// endpoint then patches the row in place.
import { useCallback, useEffect, useState } from 'react';
import { api, errMessage } from '../api';
import type { AdminUserSummary } from '@twenty4/contracts/dto';
import { PageHeader } from '../components/Layout';
import {
  Button,
  Card,
  Empty,
  ErrorBanner,
  IdCell,
  Input,
  Pill,
  Select,
  Spinner,
} from '../components/ui';
import { c, space } from '../theme';

const STATUSES = ['', 'active', 'suspended', 'banned', 'deleted'] as const;

export function Users() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [items, setItems] = useState<AdminUserSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);

  const load = useCallback(
    async (opts: { append?: boolean; cursor?: string | null } = {}) => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.admin.searchUsers(q.trim() || undefined, {
          status: status || undefined,
          cursor: opts.cursor ?? undefined,
          limit: 25,
        });
        setItems((prev) => (opts.append ? [...prev, ...res.items] : res.items));
        setNextCursor(res.nextCursor ?? null);
      } catch (e) {
        setError(errMessage(e));
      } finally {
        setLoading(false);
      }
    },
    [q, status],
  );

  // Initial + on filter change (debounced for the text query).
  useEffect(() => {
    const t = setTimeout(() => {
      void load({ cursor: null });
    }, 250);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, status]);

  async function moderate(
    user: AdminUserSummary,
    action: 'suspend' | 'unsuspend' | 'ban',
  ) {
    const verb = action === 'unsuspend' ? 'unsuspend' : action;
    if (!confirm(`${verb} @${user.username || user.id}? This takes effect immediately.`)) return;
    setActingId(user.id);
    setError(null);
    try {
      const res =
        action === 'suspend'
          ? await api.admin.suspendUser(user.id)
          : action === 'unsuspend'
            ? await api.admin.unsuspendUser(user.id)
            : await api.admin.banUser(user.id);
      setItems((prev) =>
        prev.map((u) => (u.id === user.id ? { ...u, accountStatus: res.accountStatus } : u)),
      );
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setActingId(null);
    }
  }

  return (
    <div>
      <PageHeader title="Users" subtitle="Search by handle, email, or id. Moderation is immediate." />

      <Card style={{ marginBottom: space.lg }}>
        <div style={{ display: 'flex', gap: space.md, alignItems: 'center' }}>
          <Input
            placeholder="Search handle / email / id…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            style={{ flex: 1 }}
          />
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s === '' ? 'All statuses' : s}
              </option>
            ))}
          </Select>
          {loading && <Spinner />}
        </div>
      </Card>

      {error && (
        <div style={{ marginBottom: space.md }}>
          <ErrorBanner message={error} />
        </div>
      )}

      <Card>
        {items.length === 0 && !loading ? (
          <Empty>No users match.</Empty>
        ) : (
          <table>
            <thead>
              <tr style={th.row}>
                <th style={th.cell}>User</th>
                <th style={th.cell}>Status</th>
                <th style={{ ...th.cell, textAlign: 'right' }}>Groups</th>
                <th style={{ ...th.cell, textAlign: 'right' }}>Montages</th>
                <th style={{ ...th.cell, textAlign: 'right' }}>Reports</th>
                <th style={{ ...th.cell, textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {items.map((u) => (
                <tr key={u.id} style={td.row}>
                  <td style={td.cell}>
                    <div style={{ fontWeight: 800, color: c.text }}>
                      {u.displayName || '—'}
                    </div>
                    <div style={{ fontSize: 12, color: c.muted }}>
                      @{u.username || '—'} · <IdCell id={u.id} />
                    </div>
                  </td>
                  <td style={td.cell}>
                    <Pill status={u.accountStatus} />
                  </td>
                  <td style={{ ...td.cell, textAlign: 'right' }}>{u.groupCount}</td>
                  <td style={{ ...td.cell, textAlign: 'right' }}>{u.montageCount}</td>
                  <td style={{ ...td.cell, textAlign: 'right', color: u.reportCount ? c.warn : c.muted }}>
                    {u.reportCount}
                  </td>
                  <td style={{ ...td.cell, textAlign: 'right' }}>
                    <div style={{ display: 'inline-flex', gap: 6, justifyContent: 'flex-end' }}>
                      {u.accountStatus === 'suspended' ? (
                        <Button
                          loading={actingId === u.id}
                          onClick={() => void moderate(u, 'unsuspend')}
                        >
                          Unsuspend
                        </Button>
                      ) : (
                        <Button
                          variant="warn"
                          disabled={u.accountStatus === 'deleted' || u.accountStatus === 'banned'}
                          loading={actingId === u.id}
                          onClick={() => void moderate(u, 'suspend')}
                        >
                          Suspend
                        </Button>
                      )}
                      <Button
                        variant="danger"
                        disabled={u.accountStatus === 'deleted' || u.accountStatus === 'banned'}
                        loading={actingId === u.id}
                        onClick={() => void moderate(u, 'ban')}
                      >
                        Ban
                      </Button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        {nextCursor && (
          <div style={{ textAlign: 'center', marginTop: space.lg }}>
            <Button
              loading={loading}
              onClick={() => void load({ append: true, cursor: nextCursor })}
            >
              Load more
            </Button>
          </div>
        )}
      </Card>
    </div>
  );
}

const th = {
  row: { borderBottom: `1px solid ${c.border}` } as React.CSSProperties,
  cell: {
    textAlign: 'left',
    padding: '0 12px 10px',
    fontSize: 11,
    fontWeight: 800,
    color: c.label,
    textTransform: 'uppercase',
    letterSpacing: 0.5,
  } as React.CSSProperties,
};

const td = {
  row: { borderBottom: `1px solid ${c.border}` } as React.CSSProperties,
  cell: { padding: '12px', verticalAlign: 'middle', fontSize: 14, color: c.text2 } as React.CSSProperties,
};
