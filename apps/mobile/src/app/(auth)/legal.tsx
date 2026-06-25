// (auth)/legal — a scrollable reader for the bundled Terms & Privacy copy (there are
// NO /legal/* API routes; the text is static, see src/lib/authLegalCopy.ts). A
// Privacy|Terms toggle switches docs; a back affordance returns to the prior screen.
// Reachable from welcome and sign-in.
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { Screen, Text } from '@/ui';
import { useTheme } from '@/theme';
import { AuthSegmentedControl } from '@/components/AuthSegmentedControl';
import { PRIVACY, TERMS, type LegalDoc } from '@/lib/authLegalCopy';

type DocKey = 'privacy' | 'terms';

const DOCS: Record<DocKey, LegalDoc> = {
  privacy: PRIVACY,
  terms: TERMS,
};

export default function LegalScreen() {
  const theme = useTheme();
  const router = useRouter();
  const [docKey, setDocKey] = useState<DocKey>('privacy');
  const doc = DOCS[docKey];

  return (
    <Screen scroll>
      <View style={{ paddingTop: theme.spacing.xxl, paddingBottom: theme.spacing.section }}>
        {/* Back affordance. */}
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={8}
          style={{ alignSelf: 'flex-start', marginBottom: theme.spacing.xl }}
        >
          <Text variant="body" weight="extrabold" color="accent">
            ‹ Back
          </Text>
        </Pressable>

        <Text variant="h1" weight="black" style={{ marginBottom: theme.spacing.xl }}>
          Legal
        </Text>

        <AuthSegmentedControl<DocKey>
          value={docKey}
          onChange={setDocKey}
          options={[
            { value: 'privacy', label: 'Privacy' },
            { value: 'terms', label: 'Terms' },
          ]}
        />

        {/* Active doc. */}
        <View style={{ marginTop: theme.spacing.xxl }}>
          <Text variant="h2" weight="black">
            {doc.title}
          </Text>
          <Text variant="caption" color="faint" style={{ marginTop: theme.spacing.xs }}>
            {doc.updated}
          </Text>

          <View style={{ marginTop: theme.spacing.xl, gap: theme.spacing.xxl }}>
            {doc.sections.map((section) => (
              <View key={section.heading} style={{ gap: theme.spacing.sm }}>
                <Text variant="title" weight="extrabold">
                  {section.heading}
                </Text>
                <Text variant="body" color="secondary">
                  {section.body}
                </Text>
              </View>
            ))}
          </View>
        </View>
      </View>
    </Screen>
  );
}
