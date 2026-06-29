// ExpiryCountdown — a live-ticking "expires in Hh Mm" derived from a recap's
// `expiryAt` (ISO). Recaps key visibility on the live window (`expiry_at > now`),
// not the calendar day (M8 §11), so a real countdown is the honest signal. Ticks
// once a minute (the resolution we display); flips to "Expired" at/after zero.
import { useEffect, useState } from 'react';
import { Text, type TextProps } from '@/ui';

function format(remainingMs: number): string {
  if (remainingMs <= 0) return 'Expired';
  const totalMin = Math.floor(remainingMs / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}m left`;
  if (m > 0) return `${m}m left`;
  return '<1m left';
}

export function ExpiryCountdown({
  expiryAt,
  variant = 'micro',
  color = 'label',
  testID,
}: {
  expiryAt: string;
  variant?: TextProps['variant'];
  color?: TextProps['color'];
  testID?: string;
}) {
  const target = new Date(expiryAt).getTime();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const remaining = Number.isFinite(target) ? target - now : 0;
  const expired = remaining <= 0;

  return (
    <Text variant={variant} color={expired ? 'danger' : color} testID={testID}>
      {format(remaining)}
    </Text>
  );
}
