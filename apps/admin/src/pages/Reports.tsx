// Reports page: the moderation queue. Filter by status (defaults to the open
// queue), then resolve a report with one of: dismiss | remove_content |
// suspend_user | ban_user. Re-resolving a closed report → 409 (surfaced).
import { useCallback, useEffect, useState } from 'react';
import { api, errMessage } from '../api';
import type { AdminReport, ReportResolveAction } from '@twenty4/contracts/dto';
import { PageHeader } from '../components/Layout';
import {
  Button,
  Card,
  Empty,
  ErrorBanner,
  IdCell,
  Pill,
  Select,
  Spinner,
} from '../components/ui';
import { c, radii, space, font } from '../theme';

const STATUS_FILTERS = ['open', 'under_review', 'actioned', 'dismissed'] as const;

const ACTION_LABELS: Record<ReportResolveAction, string> = {
  dismiss: 'Dismiss',
  remove_content: 'Remove content',
  suspend_user: 'Suspend user',
  ban_user: 'Ban user',
};

export function Reports() {
  const [status, setStatus] = useState<string>('open');
  const [items, setItems] = useState<AdminReport[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);

  const load = useCallback(
    async (opts: { append?: boolean; cursor?: string | null } = {}) => {
      setLoading(true);
      setError(null);
      try {
        const res = await api.admin.listReports({
          status,
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
    [status],
  );

  useEffect(() => {
    void load({ cursor: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  // Which actions make sense for a given target type.
  function actionsFor(r: AdminReport): ReportResolveAction[] {
    const base: ReportResolveAction[] = ['dismiss'];
    if (r.targetType === 'montage' || r.targetType === 'comment') {
      base.push('remove_content');
    }
    base.push('suspend_user', 'ban_user');
    return base;
  }

  async function resolve(r: AdminReport, action: ReportResolveAction) {
    if (!confirm(`${ACTION_LABELS[action]} for this ${r.targetType} report?`)) return;
    setResolving(r.id);
    setError(null);
    try {
      const res = await api.admin.resolveReport(r.id, { action });
      // Drop it from the open queue; or update its status in any other view.
      setItems((prev) =>
        status === 'open' || status === 'under_review'
          ? prev.filter((x) => x.id !== r.id)
          : prev.map((x) => (x.id === r.id ? { ...x, status: res.status } : x)),
      );
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setResolving(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="Reports"
        subtitle="Resolve a report to apply its side-effect and close it. Closed reports can't be re-actioned."
      />

      <Card style={{ marginBottom: space.lg }}>
        <div style={{ display: 'flex', gap: space.md, alignItems: 'center' }}>
          <span style={{ fontSize: 13, fontWeight: 800, color: c.label }}>QUEUE</span>
          <Select value={status} onChange={(e) => setStatus(e.target.value)}>
            {STATUS_FILTERS.map((s) => (
              <option key={s} value={s}>
                {s}
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

      {items.length === 0 && !loading ? (
        <Card>
          <Empty>
            {status === 'open' ? 'The queue is clear. Nothing to moderate.' : 'No reports here.'}
          </Empty>
        </Card>
      ) : (
        <div style={{ display: 'grid', gap: space.md }}>
          {items.map((r) => (
            <Card key={r.id}>
              <div
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'flex-start',
                  gap: space.md,
                  flexWrap: 'wrap',
                }}
              >
                <div style={{ display: 'grid', gap: 6 }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                    <Pill status={r.status} />
                    <Pill>{r.targetType}</Pill>
                    <span
                      style={{
                        fontSize: 13,
                        fontWeight: 800,
                        color: c.warn,
                        textTransform: 'uppercase',
                        letterSpacing: 0.4,
                      }}
                    >
                      {r.reason.replace(/_/g, ' ')}
                    </span>
                  </div>
                  <div style={{ fontSize: 13, color: c.muted }}>
                    target&nbsp;
                    <span style={{ fontFamily: font.mono, color: c.text2 }}>
                      {r.targetType}
                    </span>
                    &nbsp;
                    <IdCell id={r.targetId} />
                  </div>
                  <div style={{ fontSize: 12.5, color: c.muted }}>
                    reported by{' '}
                    <span style={{ color: c.text2, fontWeight: 700 }}>
                      @{r.reporter.username || r.reporter.id.slice(0, 8)}
                    </span>{' '}
                    · {new Date(r.createdAt).toLocaleString()}
                  </div>
                </div>

                {(r.status === 'open' || r.status === 'under_review') && (
                  <div
                    style={{
                      display: 'flex',
                      gap: 6,
                      flexWrap: 'wrap',
                      justifyContent: 'flex-end',
                      maxWidth: 380,
                    }}
                  >
                    {actionsFor(r).map((action) => (
                      <Button
                        key={action}
                        variant={
                          action === 'ban_user'
                            ? 'danger'
                            : action === 'dismiss'
                              ? 'ghost'
                              : 'warn'
                        }
                        loading={resolving === r.id}
                        onClick={() => void resolve(r, action)}
                        style={{ fontSize: 12.5, padding: '6px 10px' }}
                      >
                        {ACTION_LABELS[action]}
                      </Button>
                    ))}
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      {nextCursor && (
        <div style={{ textAlign: 'center', marginTop: space.lg }}>
          <Button
            loading={loading}
            onClick={() => void load({ append: true, cursor: nextCursor })}
            style={{ borderRadius: radii.md }}
          >
            Load more
          </Button>
        </div>
      )}
    </div>
  );
}
