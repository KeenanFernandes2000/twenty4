// Small set of utilitarian, Ember-styled UI primitives (inline-styled — no CSS
// framework). Buttons, cards, pills, inputs, spinner, empty/error states.
import type {
  ButtonHTMLAttributes,
  CSSProperties,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';
import { c, radii, space, font, statusColor } from '../theme';

type Variant = 'primary' | 'ghost' | 'danger' | 'warn';

export function Button({
  variant = 'ghost',
  loading,
  children,
  style,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  loading?: boolean;
}) {
  const base: CSSProperties = {
    border: `1px solid ${c.border}`,
    borderRadius: radii.md,
    padding: '8px 14px',
    fontSize: 14,
    fontWeight: 700,
    background: c.surface2,
    color: c.text,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 8,
    lineHeight: 1.2,
    transition: 'filter 0.12s ease',
  };
  const variants: Record<Variant, CSSProperties> = {
    primary: { background: c.accent, color: c.onAccent, borderColor: 'transparent' },
    ghost: {},
    danger: { background: 'transparent', color: c.danger, borderColor: 'rgba(255,106,106,0.4)' },
    warn: { background: 'transparent', color: c.warn, borderColor: 'rgba(255,179,71,0.4)' },
  };
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      style={{ ...base, ...variants[variant], ...style }}
    >
      {loading && <Spinner size={14} />}
      {children}
    </button>
  );
}

export function Card({
  children,
  style,
  title,
  right,
}: {
  children: ReactNode;
  style?: CSSProperties;
  title?: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div
      style={{
        background: c.surface,
        border: `1px solid ${c.border}`,
        borderRadius: radii.lg,
        padding: space.lg,
        ...style,
      }}
    >
      {(title || right) && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            marginBottom: space.md,
          }}
        >
          <div style={{ fontSize: 15, fontWeight: 800, color: c.text }}>{title}</div>
          {right}
        </div>
      )}
      {children}
    </div>
  );
}

export function Pill({ status, children }: { status?: string; children?: ReactNode }) {
  const color = status ? statusColor(status) : c.muted;
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 10px',
        borderRadius: radii.pill,
        fontSize: 12,
        fontWeight: 800,
        letterSpacing: 0.3,
        color,
        background: 'rgba(255,255,255,0.04)',
        border: `1px solid ${color}55`,
        textTransform: 'uppercase',
      }}
    >
      {children ?? status}
    </span>
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      style={{
        background: c.field,
        border: `1px solid ${c.border}`,
        borderRadius: radii.md,
        padding: '9px 12px',
        fontSize: 14,
        color: c.text,
        width: '100%',
        ...props.style,
      }}
    />
  );
}

export function Select(props: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      {...props}
      style={{
        background: c.field,
        border: `1px solid ${c.border}`,
        borderRadius: radii.md,
        padding: '9px 12px',
        fontSize: 14,
        color: c.text,
        ...props.style,
      }}
    />
  );
}

export function Spinner({ size = 18 }: { size?: number }) {
  return (
    <span
      aria-label="loading"
      style={{
        display: 'inline-block',
        width: size,
        height: size,
        border: `2px solid ${c.faint}`,
        borderTopColor: c.accent,
        borderRadius: '50%',
        animation: 'spin 0.7s linear infinite',
      }}
    />
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return (
    <span style={{ fontFamily: font.mono, fontSize: 12.5, color: c.text2 }}>{children}</span>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div
      style={{
        background: 'rgba(255,106,106,0.10)',
        border: `1px solid ${c.danger}55`,
        color: c.danger,
        borderRadius: radii.md,
        padding: '10px 14px',
        fontSize: 13.5,
        fontWeight: 600,
      }}
    >
      {message}
    </div>
  );
}

export function Empty({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        textAlign: 'center',
        color: c.muted,
        padding: '48px 16px',
        fontSize: 14,
      }}
    >
      {children}
    </div>
  );
}

/** Truncating, copy-on-click id cell. */
export function IdCell({ id }: { id: string }) {
  return (
    <span
      title={id}
      onClick={() => void navigator.clipboard?.writeText(id).catch(() => {})}
      style={{ fontFamily: font.mono, fontSize: 12, color: c.muted, cursor: 'copy' }}
    >
      {id.slice(0, 8)}…
    </span>
  );
}
