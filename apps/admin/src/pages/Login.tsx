// Admin login. Two tabs:
//   · OTP — the same Better Auth email/phone OTP the mobile app uses
//     (/auth/start → /auth/verify). On verify we adopt the accessToken and
//     confirm the account is an admin.
//   · Token — paste an accessToken directly (alpha / CI convenience).
import { useState } from 'react';
import { api, errMessage, API_URL } from '../api';
import { useAuth } from '../auth';
import { Button, Card, Input, ErrorBanner } from '../components/ui';
import { c, radii, space, font } from '../theme';

type Tab = 'otp' | 'token';
type OtpStep = 'identifier' | 'code';

export function Login() {
  const { adoptToken } = useAuth();
  const [tab, setTab] = useState<Tab>('otp');

  // OTP flow state
  const [method, setMethod] = useState<'email' | 'phone'>('email');
  const [identifier, setIdentifier] = useState('');
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [step, setStep] = useState<OtpStep>('identifier');

  // Token flow state
  const [token, setToken] = useState('');

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function startOtp() {
    setError(null);
    setBusy(true);
    try {
      const res = await api.auth.start({ method, identifier: identifier.trim() });
      if (!res.challengeId) throw new Error('No challenge returned.');
      setChallengeId(res.challengeId);
      setStep('code');
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function verifyOtp() {
    if (!challengeId) return;
    setError(null);
    setBusy(true);
    try {
      const tokens = await api.auth.verify({ challengeId, code: code.trim() });
      await adoptToken(tokens.accessToken);
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function useToken() {
    setError(null);
    setBusy(true);
    try {
      await adoptToken(token.trim());
    } catch (e) {
      setError(errMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: space.lg,
      }}
    >
      <Card style={{ width: 420, maxWidth: '100%' }}>
        <div style={{ textAlign: 'center', marginBottom: space.lg }}>
          <div
            style={{
              fontSize: 30,
              fontWeight: 900,
              color: c.accent,
              letterSpacing: -1,
              fontFamily: font.ui,
            }}
          >
            twenty4
          </div>
          <div style={{ color: c.muted, fontSize: 13, marginTop: 2, fontWeight: 700 }}>
            moderation &amp; ops console
          </div>
        </div>

        <div style={{ display: 'flex', gap: space.xs, marginBottom: space.lg }}>
          <TabBtn active={tab === 'otp'} onClick={() => setTab('otp')}>
            Sign in (OTP)
          </TabBtn>
          <TabBtn active={tab === 'token'} onClick={() => setTab('token')}>
            Paste token
          </TabBtn>
        </div>

        {error && (
          <div style={{ marginBottom: space.md }}>
            <ErrorBanner message={error} />
          </div>
        )}

        {tab === 'otp' && step === 'identifier' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void startOtp();
            }}
            style={{ display: 'grid', gap: space.md }}
          >
            <div style={{ display: 'flex', gap: space.xs }}>
              <TabBtn active={method === 'email'} onClick={() => setMethod('email')}>
                Email
              </TabBtn>
              <TabBtn active={method === 'phone'} onClick={() => setMethod('phone')}>
                Phone
              </TabBtn>
            </div>
            <Label>{method === 'email' ? 'Admin email' : 'Phone (E.164)'}</Label>
            <Input
              type={method === 'email' ? 'email' : 'tel'}
              autoFocus
              value={identifier}
              placeholder={method === 'email' ? 'you@example.com' : '+15551234567'}
              onChange={(e) => setIdentifier(e.target.value)}
            />
            <Button
              type="submit"
              variant="primary"
              loading={busy}
              disabled={!identifier.trim()}
              style={{ justifyContent: 'center' }}
            >
              Send code
            </Button>
          </form>
        )}

        {tab === 'otp' && step === 'code' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void verifyOtp();
            }}
            style={{ display: 'grid', gap: space.md }}
          >
            <Label>Enter the code sent to {identifier}</Label>
            <Input
              autoFocus
              inputMode="numeric"
              value={code}
              placeholder="123456"
              onChange={(e) => setCode(e.target.value)}
            />
            <Button
              type="submit"
              variant="primary"
              loading={busy}
              disabled={code.trim().length < 4}
              style={{ justifyContent: 'center' }}
            >
              Verify &amp; sign in
            </Button>
            <button
              type="button"
              onClick={() => {
                setStep('identifier');
                setCode('');
                setChallengeId(null);
              }}
              style={linkBtn}
            >
              ← Use a different identifier
            </button>
          </form>
        )}

        {tab === 'token' && (
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void useToken();
            }}
            style={{ display: 'grid', gap: space.md }}
          >
            <Label>Paste an admin access token</Label>
            <textarea
              value={token}
              autoFocus
              onChange={(e) => setToken(e.target.value)}
              placeholder="eyJ… / session token"
              rows={4}
              style={{
                background: c.field,
                border: `1px solid ${c.border}`,
                borderRadius: radii.md,
                padding: '9px 12px',
                fontSize: 12.5,
                color: c.text,
                fontFamily: font.mono,
                resize: 'vertical',
              }}
            />
            <Button
              type="submit"
              variant="primary"
              loading={busy}
              disabled={!token.trim()}
              style={{ justifyContent: 'center' }}
            >
              Sign in
            </Button>
          </form>
        )}

        <div style={{ marginTop: space.lg, color: c.faint, fontSize: 11.5, textAlign: 'center' }}>
          API · {API_URL}
        </div>
      </Card>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        flex: 1,
        padding: '8px 10px',
        borderRadius: radii.md,
        border: `1px solid ${active ? 'transparent' : c.border}`,
        background: active ? c.accentSoft : 'transparent',
        color: active ? c.accent : c.muted,
        fontWeight: 800,
        fontSize: 13,
      }}
    >
      {children}
    </button>
  );
}

function Label({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ fontSize: 12, fontWeight: 800, color: c.label, textTransform: 'uppercase' }}>
      {children}
    </div>
  );
}

const linkBtn: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: c.muted,
  fontSize: 13,
  textAlign: 'left',
  padding: 0,
};
