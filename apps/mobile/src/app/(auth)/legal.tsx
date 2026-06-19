/**
 * 1.7 Legal — Terms of Service / Privacy Policy reader stub + final consent.
 *
 * A segmented toggle switches between the two documents (placeholder copy). The
 * final "Agree & continue" records consent locally and finishes onboarding by
 * routing into the (main) tabs. Web-safe.
 */
import { useState } from 'react';
import { Stack, useRouter } from 'expo-router';
import { Text, View } from 'react-native';

import { AuthScaffold } from '../../components/AuthScaffold';
import { useTheme } from '../../theme';
import { Button, SegmentedControl } from '../../ui';

type Doc = 'terms' | 'privacy';

const TERMS = [
  'Welcome to twenty4. By using the app you agree to these Terms of Service.',
  'twenty4 is a today-only sharing app. Media you collect is bucketed to the current day and montages expire 24 hours after publishing.',
  'You are responsible for the content you share and must have the rights to any media you upload. Don’t post anything illegal, harmful, or that infringes others’ rights.',
  'We may suspend or terminate accounts that violate these terms or our community guidelines. Sessions can be revoked immediately to support safety actions.',
  'The service is provided “as is” without warranties. To the extent permitted by law, twenty4 is not liable for indirect or consequential damages.',
  'These terms may change; continued use after an update constitutes acceptance.',
];

const PRIVACY = [
  'This Privacy Policy explains what we collect and how we use it.',
  'We process: profile info (name, username, photo), the media you add, comments and reactions, your push token, basic analytics, and media metadata used to validate that content is from today.',
  'Contacts, when you opt in, are hashed on your device before discovery — we never store raw phone numbers or emails from your address book.',
  'Montages and their source media are deleted after expiry. We may retain a limited moderation snapshot where legally required.',
  'You can edit or delete your account at any time; deletion revokes all sessions and purges your data.',
  'We don’t sell your personal data.',
];

export default function Legal() {
  const theme = useTheme();
  const router = useRouter();
  const [doc, setDoc] = useState<Doc>('terms');

  const paragraphs = doc === 'terms' ? TERMS : PRIVACY;

  return (
    <>
      <Stack.Screen options={{ title: 'Terms & Privacy' }} />
      <AuthScaffold
        step={7}
        title="The fine print"
        subtitle="Please review and accept to finish setting up."
        footer={
          <>
            <Button
              label="Agree & continue"
              size="lg"
              fullWidth
              icon="checkmark-circle-outline"
              onPress={() => router.replace('/(main)/today')}
            />
            <Text
              style={{
                ...theme.typography.caption,
                color: theme.colors.faint,
                textAlign: 'center',
              }}
            >
              By continuing you agree to our Terms of Service & Privacy Policy.
            </Text>
          </>
        }
      >
        <SegmentedControl
          value={doc}
          onChange={setDoc}
          options={[
            { label: 'Terms', value: 'terms' },
            { label: 'Privacy', value: 'privacy' },
          ]}
        />

        <View
          style={{
            gap: theme.spacing.md,
            padding: theme.spacing.lg,
            borderRadius: theme.radii.lg,
            backgroundColor: theme.colors.surface,
            borderWidth: 1,
            borderColor: theme.colors.border,
          }}
        >
          <Text style={{ ...theme.typography.heading, color: theme.colors.text }}>
            {doc === 'terms' ? 'Terms of Service' : 'Privacy Policy'}
          </Text>
          <Text style={{ ...theme.typography.label, color: theme.colors.faint }}>
            Last updated June 2026
          </Text>
          {paragraphs.map((p, i) => (
            <Text key={i} style={{ ...theme.typography.body, color: theme.colors.text2 }}>
              {p}
            </Text>
          ))}
        </View>
      </AuthScaffold>
    </>
  );
}
