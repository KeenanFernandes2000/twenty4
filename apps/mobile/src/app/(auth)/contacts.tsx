/**
 * 1.5 Contacts — priming + permission ask to find friends from contacts.
 *
 * The native contacts read is stubbed (would hash identifiers client-side and
 * POST /users/me/contacts-discovery per §8/§12 no-PII). This screen is just the
 * prime + CTA: "Allow access" stubs the permission, "Skip for now" continues.
 * Web-safe (no expo-contacts import).
 */
import { Stack, useRouter } from 'expo-router';
import { Text, View } from 'react-native';

import { PrimingHero } from '../../components/PrimingHero';
import { AuthScaffold } from '../../components/AuthScaffold';
import { useTheme } from '../../theme';
import { Button, Icon, type IconName } from '../../ui';

const BENEFITS: { icon: IconName; text: string }[] = [
  { icon: 'lock-closed-outline', text: 'Contacts are hashed on-device — we never store raw numbers.' },
  { icon: 'people-circle-outline', text: 'We only match people who already use twenty4.' },
  { icon: 'options-outline', text: 'You choose who to add. Nothing is shared automatically.' },
];

export default function Contacts() {
  const theme = useTheme();
  const router = useRouter();

  function allow() {
    // STUB: a real flow requests Contacts permission, hashes + posts them.
    router.push('/(auth)/notifications-priming');
  }

  return (
    <>
      <Stack.Screen options={{ title: 'Find friends' }} />
      <AuthScaffold
        step={5}
        footer={
          <>
            <Button label="Allow access" size="lg" fullWidth icon="people-outline" onPress={allow} />
            <Button
              label="Skip for now"
              variant="ghost"
              fullWidth
              onPress={() => router.push('/(auth)/notifications-priming')}
            />
          </>
        }
      >
        <PrimingHero
          icon="people"
          title="Find your friends"
          subtitle="See which of your contacts are already on twenty4 so you can add them to a group."
        />

        <View style={{ gap: theme.spacing.md, marginTop: theme.spacing.lg }}>
          {BENEFITS.map((b) => (
            <View key={b.text} style={{ flexDirection: 'row', gap: theme.spacing.md, alignItems: 'center' }}>
              <Icon name={b.icon} size={20} color={theme.colors.accent} />
              <Text style={{ ...theme.typography.caption, color: theme.colors.text2, flex: 1 }}>
                {b.text}
              </Text>
            </View>
          ))}
        </View>
      </AuthScaffold>
    </>
  );
}
