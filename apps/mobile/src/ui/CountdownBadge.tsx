/**
 * CountdownBadge — shows time-left until a target (24h montage expiry).
 * Ticks every second; turns danger-toned when < 1h remains.
 */
import { useEffect, useState } from 'react';
import { Text, View } from 'react-native';
import { useTheme } from '../theme';
import { Icon } from './Icon';

export interface CountdownBadgeProps {
  /** Expiry timestamp (ms epoch). */
  expiresAt: number;
  /** Override "now" for testing/screenshots. */
  now?: number;
}

function formatRemaining(ms: number): string {
  if (ms <= 0) return 'Expired';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m left`;
  if (m > 0) return `${m}m ${s}s left`;
  return `${s}s left`;
}

export function CountdownBadge({ expiresAt, now }: CountdownBadgeProps) {
  const theme = useTheme();
  const [current, setCurrent] = useState(now ?? Date.now());

  useEffect(() => {
    if (now != null) return; // static (screenshot) mode
    const id = setInterval(() => setCurrent(Date.now()), 1000);
    return () => clearInterval(id);
  }, [now]);

  const remaining = expiresAt - current;
  const urgent = remaining < 3600_000;
  const tone = remaining <= 0 ? theme.colors.muted : urgent ? theme.colors.danger : theme.colors.accent;

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 5,
        paddingVertical: 4,
        paddingHorizontal: 9,
        borderRadius: theme.radii.pill,
        backgroundColor: theme.colors.surface2,
        borderWidth: 1,
        borderColor: theme.colors.border,
        alignSelf: 'flex-start',
      }}
    >
      <Icon name="time-outline" size={13} color={tone} />
      <Text style={{ color: tone, fontFamily: theme.fontFamily.mono, fontSize: 12 }}>
        {formatRemaining(remaining)}
      </Text>
    </View>
  );
}
