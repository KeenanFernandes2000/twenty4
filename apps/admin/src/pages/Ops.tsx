// Ops dashboard: per-queue BullMQ job-state counts (failed highlighted),
// per-bucket S3 storage usage (objects + bytes), and growth/health metrics.
import { useCallback, useEffect, useState } from 'react';
import { api, errMessage } from '../api';
import type { AdminOpsResponse } from '@twenty4/contracts/dto';
import { PageHeader } from '../components/Layout';
import { Button, Card, ErrorBanner, Spinner } from '../components/ui';
import { c, radii, space, font } from '../theme';

function fmtBytes(n: number): string {
  if (n === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${(n / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

export function Ops() {
  const [data, setData] = useState<AdminOpsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await api.admin.ops());
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div>
      <PageHeader title="Ops" subtitle="Queue health, storage usage, and growth metrics." />

      <div style={{ marginBottom: space.lg, display: 'flex', alignItems: 'center', gap: space.md }}>
        <Button onClick={() => void load()} loading={loading}>
          Refresh
        </Button>
        {loading && !data && <Spinner />}
      </div>

      {error && (
        <div style={{ marginBottom: space.md }}>
          <ErrorBanner message={error} />
        </div>
      )}

      {data && (
        <div style={{ display: 'grid', gap: space.lg }}>
          {/* Metrics */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: space.md }}>
            <Metric label="Published montages" value={data.metrics.publishedMontages} />
            <Metric label="Active users" value={data.metrics.activeUsers} />
            <Metric label="Expired montages" value={data.metrics.expiredMontages} />
            <Metric
              label="Open reports"
              value={data.metrics.openReports}
              accent={data.metrics.openReports > 0 ? c.warn : undefined}
            />
          </div>

          {/* Queues */}
          <Card title="Queues (BullMQ job states)">
            <table>
              <thead>
                <tr style={th.row}>
                  <th style={th.cell}>Queue</th>
                  <th style={{ ...th.cell, textAlign: 'right' }}>Waiting</th>
                  <th style={{ ...th.cell, textAlign: 'right' }}>Active</th>
                  <th style={{ ...th.cell, textAlign: 'right' }}>Delayed</th>
                  <th style={{ ...th.cell, textAlign: 'right' }}>Completed</th>
                  <th style={{ ...th.cell, textAlign: 'right' }}>Failed</th>
                </tr>
              </thead>
              <tbody>
                {data.queues.map((q) => (
                  <tr key={q.name} style={td.row}>
                    <td style={{ ...td.cell, fontFamily: font.mono, color: c.text }}>{q.name}</td>
                    <td style={num}>{q.waiting}</td>
                    <td style={num}>{q.active}</td>
                    <td style={num}>{q.delayed}</td>
                    <td style={num}>{q.completed}</td>
                    <td style={{ ...num, color: q.failed > 0 ? c.danger : c.muted, fontWeight: q.failed > 0 ? 800 : 600 }}>
                      {q.failed}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>

          {/* Storage */}
          <Card title="Storage (S3 buckets)">
            <table>
              <thead>
                <tr style={th.row}>
                  <th style={th.cell}>Bucket</th>
                  <th style={{ ...th.cell, textAlign: 'right' }}>Objects</th>
                  <th style={{ ...th.cell, textAlign: 'right' }}>Size</th>
                </tr>
              </thead>
              <tbody>
                {data.storage.map((s) => (
                  <tr key={s.bucket} style={td.row}>
                    <td style={{ ...td.cell, fontFamily: font.mono, color: c.text }}>{s.bucket}</td>
                    <td style={num}>{s.objectCount.toLocaleString()}</td>
                    <td style={{ ...num, color: c.text2 }}>{fmtBytes(s.bytes)}</td>
                  </tr>
                ))}
                <tr>
                  <td style={{ ...td.cell, fontWeight: 800, color: c.text2 }}>total</td>
                  <td style={{ ...num, fontWeight: 800 }}>
                    {data.storage.reduce((a, s) => a + s.objectCount, 0).toLocaleString()}
                  </td>
                  <td style={{ ...num, fontWeight: 800, color: c.text }}>
                    {fmtBytes(data.storage.reduce((a, s) => a + s.bytes, 0))}
                  </td>
                </tr>
              </tbody>
            </table>
          </Card>
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, accent }: { label: string; value: number; accent?: string }) {
  return (
    <div
      style={{
        background: c.surface,
        border: `1px solid ${c.border}`,
        borderRadius: radii.lg,
        padding: space.lg,
      }}
    >
      <div style={{ fontSize: 30, fontWeight: 900, color: accent ?? c.text, lineHeight: 1 }}>
        {value.toLocaleString()}
      </div>
      <div style={{ fontSize: 12, color: c.muted, marginTop: 6, fontWeight: 700 }}>{label}</div>
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
  cell: { padding: '12px', fontSize: 14, color: c.text2 } as React.CSSProperties,
};
const num: React.CSSProperties = { ...td.cell, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
