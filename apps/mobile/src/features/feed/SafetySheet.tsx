/**
 * SafetySheet — the report (6.1) / block (6.2) entry points for a feed card or
 * the player. Opened from the card "⋯" overflow menu; presents:
 *   - Report this recap  → a reason picker that calls the (stubbed) safety.report
 *     api method. The real /reports + /blocks endpoints land in Slice 8; the UI
 *     affordance + the call site exist now so wiring them is a one-line swap.
 *   - Block @user        → confirms, then calls safety.block(userId).
 *   - Delete (owner)     → owner-only hard-delete of their own recap.
 *
 * Web-safe (RN Modal-based Sheet). Mutations are best-effort: on success we toast
 * via the parent's onDone; the safety methods currently return TODO(slice 8).
 */
import { useState } from 'react';
import { Text, View } from 'react-native';

import { useTheme } from '../../theme';
import { Button, Icon, ListRow, Sheet } from '../../ui';
import type { ReportReason } from '@twenty4/contracts/enums';
import { apiClient } from '../../lib/apiClient';

const REASONS: Array<{ value: ReportReason; label: string }> = [
  { value: 'harassment', label: 'Harassment or bullying' },
  { value: 'nudity', label: 'Nudity or sexual content' },
  { value: 'hate', label: 'Hate speech' },
  { value: 'violence', label: 'Violence or threats' },
  { value: 'spam', label: 'Spam' },
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

type View_ = 'menu' | 'report' | 'block';

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
  const [view, setView] = useState<View_>('menu');
  const [busy, setBusy] = useState(false);

  const reset = () => {
    setView('menu');
    setBusy(false);
  };
  const close = () => {
    reset();
    onClose();
  };

  const submitReport = async (reason: ReportReason) => {
    setBusy(true);
    try {
      // TODO(slice 8): real /reports DTO; method is stubbed in the api-client.
      await apiClient.safety.report({ targetType: 'montage', targetId: montageId, reason });
    } catch {
      // Swallow until the endpoint exists; the UI affordance is what matters now.
    }
    onDone?.('Thanks — our team will review this.');
    close();
  };

  const confirmBlock = async () => {
    setBusy(true);
    try {
      // TODO(slice 8): real /blocks/:userId endpoint.
      await apiClient.safety.block(authorId);
    } catch {
      // Swallow until the endpoint exists.
    }
    onDone?.(`You blocked ${authorName}.`);
    close();
  };

  const confirmDelete = async () => {
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
              this later in Settings.
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
