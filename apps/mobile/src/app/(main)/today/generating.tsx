/**
 * 2.4 Montage generating — FORCED DARK (matches the Ember prototype).
 *
 * Entered from 2.1 Today after POST /montages returns { montageId }. This screen
 * owns the §7.3 poll: `useMontage(id)` re-fetches while status === 'generating'
 * and stops on a terminal status, then routes:
 *   - draft_ready  → 2.5 Review (replace, so Back doesn't return here)
 *   - failed       → render-failed
 *   - 404 / gone   → back to Today
 *
 * Design (Spool 2.4): a spinner ring with a progress %, "Stitching your day
 * together" headline + encouragement copy, a clip filmstrip, and a "Notify me
 * when it's ready" affordance (you can leave; the poll resumes on return).
 *
 * Web-safe: the mock layer can pin status='generating' to screenshot this
 * screen without a session; the real poll only runs on a device.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, useRouter } from 'expo-router';

import { ForcedDarkProvider, useTheme } from '../../../theme';
import { Button } from '../../../ui';
import { useMontage } from '../../../lib/montage';
import { montageMockActive, montageMockMode, mockMontageForMode } from '../../../lib/montageMocks';
import type { MontageResponse } from '@twenty4/contracts/dto';

const ENCOURAGEMENT = [
  'Cutting your clips to the beat.',
  'Finding the best moments.',
  'Syncing the music.',
  'Adding the finishing touches.',
];

export default function GeneratingRoute() {
  return (
    <ForcedDarkProvider>
      <Generating />
    </ForcedDarkProvider>
  );
}

function Generating() {
  const theme = useTheme();
  const c = theme.colors;
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id, clips } = useLocalSearchParams<{ id?: string; clips?: string }>();

  const mock = montageMockActive();
  const mode = montageMockMode();
  const query = useMontage(id, { enabled: !mock });
  const montage: MontageResponse | undefined = mock ? mockMontageForMode() ?? undefined : query.data;
  const status = montage?.status ?? (mock ? mode : 'generating');
  const notFound = !mock && query.notFound;

  const clipCount = clips ? Number(clips) || undefined : undefined;

  // Indeterminate visual progress while we poll (the server reports no %); it
  // eases toward 90% and snaps to 100% on draft_ready so it never looks stuck.
  const [pct, setPct] = useState(8);
  const phaseRef = useRef(0);
  const [phase, setPhase] = useState(0);
  useEffect(() => {
    if (status !== 'generating') {
      setPct(100);
      return;
    }
    const t = setInterval(() => {
      setPct((p) => (p >= 90 ? 90 : p + Math.max(1, Math.round((92 - p) * 0.06))));
      phaseRef.current = (phaseRef.current + 1) % ENCOURAGEMENT.length;
      setPhase(phaseRef.current);
    }, 1100);
    return () => clearInterval(t);
  }, [status]);

  // Route off the screen on a terminal status (skip when mock-pinned).
  useEffect(() => {
    if (mock || !id) return;
    if (notFound) {
      router.replace('/(main)/today');
      return;
    }
    if (status === 'draft_ready' || status === 'published') {
      router.replace({ pathname: '/(main)/today/review', params: { id } });
    } else if (status === 'failed') {
      router.replace({ pathname: '/(main)/today/render-failed', params: { id } });
    }
  }, [mock, id, status, notFound, router]);

  const headline = useMemo(
    () => (status === 'generating' ? 'Stitching your day together' : 'Almost there'),
    [status],
  );
  const sub = clipCount
    ? `Cutting ${clipCount} clip${clipCount === 1 ? '' : 's'} to the beat. This usually takes under a minute — you can leave and we’ll let you know.`
    : 'Mixing your moments to the music. This usually takes under a minute — you can leave and we’ll let you know.';

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: c.bg,
        paddingTop: insets.top + theme.spacing.xl,
        paddingBottom: insets.bottom + theme.spacing.xl,
        paddingHorizontal: theme.spacing.xl,
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.spacing.lg,
      }}
    >
      <View style={{ flex: 1 }} />

      {/* Spinner ring + progress % */}
      <View style={{ width: 110, height: 110, alignItems: 'center', justifyContent: 'center' }}>
        <View
          style={{
            position: 'absolute',
            width: 110,
            height: 110,
            borderRadius: 55,
            borderWidth: 4,
            borderColor: c.surface3,
          }}
        />
        <ActivityIndicator size="large" color={c.accent} />
        <Text
          style={{
            position: 'absolute',
            ...theme.typography.heading,
            color: c.text,
            fontFamily: theme.fontFamily.extrabold,
          }}
        >
          {Math.round(pct)}%
        </Text>
      </View>

      <View style={{ alignItems: 'center', gap: theme.spacing.sm, paddingHorizontal: theme.spacing.md }}>
        <Text style={{ ...theme.typography.title, color: c.text, textAlign: 'center' }}>{headline}</Text>
        <Text style={{ ...theme.typography.body, color: c.text2, textAlign: 'center' }}>{sub}</Text>
        <Text style={{ ...theme.typography.caption, color: c.accent, textAlign: 'center', marginTop: 4 }}>
          {status === 'generating' ? ENCOURAGEMENT[phase] : 'Wrapping up…'}
        </Text>
      </View>

      {/* Clip filmstrip — a few placeholder frames, the next ones dashed. */}
      <View style={{ flexDirection: 'row', gap: 7 }}>
        {[0, 1, 2, 3, 4].map((i) => (
          <View
            key={i}
            style={{
              width: 30,
              height: 44,
              borderRadius: 8,
              backgroundColor: i < 3 ? c.surface2 : 'transparent',
              borderWidth: i < 3 ? 0 : 1.5,
              borderStyle: i < 3 ? 'solid' : 'dashed',
              borderColor: c.surface3,
              opacity: i < 2 ? 1 : 0.55,
            }}
          />
        ))}
      </View>

      <View style={{ flex: 1 }} />

      <View style={{ alignSelf: 'stretch', gap: theme.spacing.sm }}>
        <Button
          label="Notify me when it’s ready"
          variant="secondary"
          fullWidth
          onPress={() => router.replace('/(main)/today')}
        />
      </View>
    </View>
  );
}
