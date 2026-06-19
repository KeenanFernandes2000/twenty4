/**
 * SafetySheet — the report (6.1) / block (6.2) entry points for a feed card or
 * the player. Opened from the card "⋯" overflow menu; presents:
 *   - Report this recap  → a reason picker that calls POST /reports. A repeat
 *     OPEN report dedups server-side (returns the existing report); either way
 *     we toast "Thanks — our team will review this."
 *   - Block @user        → confirms, then POST /blocks. Takes effect immediately:
 *     the feed + every social action already filter BOTH directions (Slice 6), and
 *     useBlockUser invalidates the feed so the author drops out at once.
 *   - Delete (owner)     → owner-only hard-delete of their own recap.
 *
 * Web-safe (RN Modal-based Sheet). Mutations toast via the parent's onDone.
 */
import { useState } from 'react';
import { Text, View } from 'react-native';

import { useTheme } from '../../theme';
import { Button, Icon, ListRow, Sheet } from '../../ui';
import type { ReportReason } from '@twenty4/contracts/enums';
import { apiClient } from '../../lib/apiClient';
import { useBlockUser, useReport } from '../../lib/safety';

/** Reason set mirrors the contracts `REPORT_REASONS` enum (analytics-stable). */
const REASONS: Array<{ value: ReportReason; label: string }> = [
  { value: 'harassment', label: 'Harassment or bullying' },
  { value: 'nudity', label: 'Nudity or sexual content' },
  { value: 'hate', label: 'Hate speech or symbols' },
  { value: 'violence', label: 'Violence or threats' },
  { value: 'self_harm', label: 'Self-harm or suicide' },
  { value: 'illegal', label: 'Illegal goods or activity' },
  { value: 'impersonation', label: 'Impersonation' },
  { value: 'spam', label: 'Spam or scam' },
  { value: 'other', label: 'Something else' },
];

export interface SafetySheetProps {
  visible: boolean;
  onClose: () => void;
  montageId: string;
  authorId: string;
  authorName: string;
  /** True when the caller owns this recap → show the owner Delete action. */
  isOwner?: boolean;
  onDeleted?: () => void;
  /** Toast callback ("Reported", "Blocked"). */
  onDone?: (message: string) => void;
}

type SheetView = 'menu' | 'report' | 'block';

export function SafetySheet({
  visible,
  onClose,
  montageId,
  authorId,
  authorName,
  isOwner = false,
  onDeleted,
  onDone,
}: SafetySheetProps) {
  const theme = useTheme();
  const c = theme.colors;
  const [view, setView] = useState<SheetView>('menu');
  const [busy, setBusy] = useState(false);

  const report = useReport();
  const block = useBlockUser();

  const reset = () => {
    setView('menu');
    setBusy(false);
  };
  const close = () => {
    reset();
    onClose();
  };

  const submitReport = async (reason: ReportReason) => {
    if (busy) return;
    setBusy(true);
    try {
      await report.mutateAsync({ targetType: 'montage', targetId: montageId, reason });
    } catch {
      // Best-effort: still acknowledge so the user isn't stuck (e.g. a duplicate
      // already-open report dedups to 200; a transient error shouldn't trap them).
    }
    onDone?.('Thanks — our team will review this.');
    close();
  };

  const confirmBlock = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await block.mutateAsync(authorId);
      onDone?.(`You blocked ${authorName}.`);
    } catch {
      onDone?.("Couldn't block right now. Please try again.");
    }
    close();
  };

  const confirmDelete = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await apiClient.montage.remove(montageId);
      onDeleted?.();
    } finally {
      close();
    }
  };

  return (
    <Sheet
      visible={visible}
      onClose={close}
      title={
        view === 'menu'
          ? undefined
          : view === 'report'
            ? 'Report this recap'
            : `Block ${authorName}?`
      }
    >
      {view === 'menu' ? (
        <View style={{ marginHorizontal: -theme.spacing.lg }}>
          {isOwner ? (
            <ListRow
              title="Delete my recap"
              subtitle="Removes it for everyone now — reactions & comments too."
              leadingIcon="trash-outline"
              danger
              onPress={() => void confirmDelete()}
            />
          ) : (
            <>
              <ListRow
                title="Report recap"
                subtitle="Let us know if something's wrong."
                leadingIcon="flag-outline"
                onPress={() => setView('report')}
              />
              <ListRow
                title={`Block ${authorName}`}
                subtitle="You won't see each other's recaps."
                leadingIcon="hand-left-outline"
                danger
                onPress={() => setView('block')}
              />
            </>
          )}
        </View>
      ) : null}

      {view === 'report' ? (
        <View style={{ marginHorizontal: -theme.spacing.lg }}>
          <Text
            style={{
              ...theme.typography.caption,
              color: c.muted,
              paddingHorizontal: theme.spacing.lg,
              paddingBottom: theme.spacing.xs,
            }}
          >
            Why are you reporting this? Your report is anonymous.
          </Text>
          {REASONS.map((r) => (
            <ListRow
              key={r.value}
              title={r.label}
              showChevron
              onPress={() => void submitReport(r.value)}
            />
          ))}
        </View>
      ) : null}

      {view === 'block' ? (
        <View style={{ gap: theme.spacing.md }}>
          <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: 10 }}>
            <Icon name="information-circle-outline" size={20} color={c.muted} />
            <Text style={{ ...theme.typography.body, color: c.text2, flex: 1 }}>
              {authorName} won't be able to see your recaps, and you won't see theirs. You can undo
              this anytime from Settings → Blocked.
            </Text>
          </View>
          <Button
            label={`Block ${authorName}`}
            variant="danger"
            fullWidth
            loading={busy}
            onPress={() => void confirmBlock()}
          />
          <Button label="Cancel" variant="ghost" fullWidth onPress={() => setView('menu')} />
        </View>
      ) : null}
    </Sheet>
  );
}
