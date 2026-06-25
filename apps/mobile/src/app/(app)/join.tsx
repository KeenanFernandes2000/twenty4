// (app)/join — manual join-by-code. The user types/pastes a code and taps Preview;
// we then render the shared <InvitePreviewJoin/> (same unit the deep-link route uses),
// which fetches the preview and handles Join + all coded error copy. Editing the code
// returns to the entry field.
import { useState } from 'react';
import { View } from 'react-native';
import { Button, Input, Screen, Text } from '@/ui';
import { useTheme } from '@/theme';
import { ScreenHeader } from '@/components/groups/ScreenHeader';
import { InvitePreviewJoin } from '@/components/InvitePreviewJoin';

export default function JoinScreen() {
  const theme = useTheme();
  const [code, setCode] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);

  const trimmed = code.trim();
  const canPreview = trimmed.length > 0;

  return (
    <Screen scroll keyboardAvoiding>
      <ScreenHeader title="Join a group" />

      {submitted == null ? (
        <View style={{ gap: theme.spacing.xl, paddingTop: theme.spacing.lg }}>
          <Text variant="body" color="muted">
            Enter an invite code to preview the group before you join.
          </Text>
          <View testID="join-code-input">
            <Input
              label="Invite code"
              value={code}
              onChangeText={setCode}
              placeholder="Paste or type a code"
              autoCapitalize="none"
              returnKeyType="go"
              onSubmitEditing={() => {
                if (canPreview) setSubmitted(trimmed);
              }}
            />
          </View>
          <Button
            variant="primary"
            fullWidth
            title="Preview"
            disabled={!canPreview}
            onPress={() => setSubmitted(trimmed)}
            testID="join-preview-button"
          />
        </View>
      ) : (
        <View style={{ gap: theme.spacing.base }}>
          <InvitePreviewJoin code={submitted} heading="You're invited" />
          <Button
            variant="ghost"
            fullWidth
            title="Use a different code"
            onPress={() => setSubmitted(null)}
            testID="join-change-code-button"
          />
        </View>
      )}
    </Screen>
  );
}
