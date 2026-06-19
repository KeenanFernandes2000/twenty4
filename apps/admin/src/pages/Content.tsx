// Content removal page: hard-delete a montage or a comment by id (with an
// optional content-free reason note). Montage removal returns a cascade summary;
// comment removal is a 204. Idempotent on the server (gone → 404, surfaced).
import { useState } from 'react';
import { api, errMessage } from '../api';
import { PageHeader } from '../components/Layout';
import { Button, Card, ErrorBanner, Input } from '../components/ui';
import { c, radii, space, font } from '../theme';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function Content() {
  return (
    <div>
      <PageHeader
        title="Content removal"
        subtitle="Hard-delete reported content by id. Removal is irreversible and writes an audit tombstone."
      />
      <div style={{ display: 'grid', gap: space.lg, gridTemplateColumns: '1fr 1fr' }}>
        <RemoveMontage />
        <RemoveComment />
      </div>
    </div>
  );
}

function RemoveMontage() {
  const [id, setId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  async function run() {
    if (!UUID_RE.test(id.trim())) {
      setError('Enter a valid montage id (uuid).');
      return;
    }
    if (!confirm('Hard-delete this montage (video + thumb + reactions + comments)?')) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.admin.removeMontage(id.trim(), reason.trim() ? { reason: reason.trim() } : {});
      setResult(`Removed montage ${res.montageId.slice(0, 8)}… (removed=${res.removed}).`);
      setId('');
      setReason('');
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Remove a montage">
      <div style={{ display: 'grid', gap: space.md }}>
        <Field label="Montage id">
          <Input
            value={id}
            placeholder="00000000-0000-0000-0000-000000000000"
            onChange={(e) => setId(e.target.value)}
            style={{ fontFamily: font.mono, fontSize: 12.5 }}
          />
        </Field>
        <Field label="Reason (optional, content-free)">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="policy violation" />
        </Field>
        {error && <ErrorBanner message={error} />}
        {result && <Ok>{result}</Ok>}
        <Button variant="danger" loading={busy} onClick={() => void run()} style={{ justifyContent: 'center' }}>
          Remove montage
        </Button>
      </div>
    </Card>
  );
}

function RemoveComment() {
  const [id, setId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  async function run() {
    if (!UUID_RE.test(id.trim())) {
      setError('Enter a valid comment id (uuid).');
      return;
    }
    if (!confirm('Hard-delete this comment?')) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      await api.admin.removeComment(id.trim());
      setResult(`Removed comment ${id.trim().slice(0, 8)}….`);
      setId('');
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Remove a comment">
      <div style={{ display: 'grid', gap: space.md }}>
        <Field label="Comment id">
          <Input
            value={id}
            placeholder="00000000-0000-0000-0000-000000000000"
            onChange={(e) => setId(e.target.value)}
            style={{ fontFamily: font.mono, fontSize: 12.5 }}
          />
        </Field>
        {error && <ErrorBanner message={error} />}
        {result && <Ok>{result}</Ok>}
        <Button variant="danger" loading={busy} onClick={() => void run()} style={{ justifyContent: 'center' }}>
          Remove comment
        </Button>
      </div>
    </Card>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'grid', gap: 6 }}>
      <div style={{ fontSize: 12, fontWeight: 800, color: c.label, textTransform: 'uppercase' }}>
        {label}
      </div>
      {children}
    </div>
  );
}

function Ok({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        background: 'rgba(54,201,138,0.10)',
        border: `1px solid ${c.success}55`,
        color: c.success,
        borderRadius: radii.md,
        padding: '10px 14px',
        fontSize: 13.5,
        fontWeight: 600,
      }}
    >
      {children}
    </div>
  );
}
