/**
 * ⚠ replace-confirm — one of the 3 undesigned screens (built functionally in the
 * Ember system, flagged for design). A confirm bottom-sheet shown when the user
 * already published a recap to a group today and is about to REPLACE it (Q2):
 * publishing the new montage supersedes the prior one (its reactions/comments go
 * with it). The sheet states the consequence explicitly and is idempotent —
 * confirming runs /montages/:id/replace.
 *
 * Presentational + a confirm callback; the parent owns the mutation. Web-safe
 * (built on the shared <Sheet/>).
 */
import { Text, View } from 'react-native';

import { useTheme } from '../../theme';
import { Button, Icon, Sheet } from '../../ui';

export interface ReplaceConfirmSheetProps {
  visible: boolean;
  onClose: () => void;
  onConfirm: () => void;
  loading?: boolean;
  /** Names of the groups that already have today's recap (for the copy). */
  groupNames?: string[];
}

export function ReplaceConfirmSheet({
  visible,
  onClose,
  onConfirm,
  loading = false,
  groupNames = [],
}: ReplaceConfirmSheetProps) {
  const theme = useTheme();
  const c = theme.colors;

  const where =
    groupNames.length === 0
      ? 'this group'
      : groupNames.length === 1
        ? groupNames[0]
        : `${groupNames.length} groups`;

  return (
    <Sheet visible={visible} onClose={onClose} title="Replace today’s recap?">
      <View style={{ gap: theme.spacing.md }}>
        <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
          <Icon name="swap-horizontal-outline" size={22} color={c.accent2} />
          <Text style={{ ...theme.typography.body, color: c.text2, flex: 1 }}>
            You already published a recap to {where} today. Publishing this one replaces it — the old recap and its
            reactions and comments are removed. This can’t be undone.
          </Text>
        </View>

        <View style={{ gap: theme.spacing.sm, marginTop: theme.spacing.xs }}>
          <Button label="Replace recap" icon="swap-horizontal" variant="danger" fullWidth loading={loading} onPress={onConfirm} />
          <Button label="Keep current recap" variant="ghost" fullWidth onPress={onClose} />
        </View>
      </View>
    </Sheet>
  );
}
