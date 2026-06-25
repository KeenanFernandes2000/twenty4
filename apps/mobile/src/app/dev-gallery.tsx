import { useState } from 'react';
import { View } from 'react-native';
import {
  Screen,
  Text,
  Button,
  Input,
  OTPInput,
  Card,
  Avatar,
  Spinner,
  useToast,
} from '@/ui';
import { useTheme } from '@/theme';
import type { TextColor } from '@/ui';

// DEV-ONLY QA gallery — proves every Ember primitive compiles + renders.
// Reachable at /dev-gallery (kept for QA / Playwright). NOT gated; ThemeProvider +
// ToastProvider are mounted in _layout.tsx, so primitives + useToast() work here.
// The AuthGate now owns "/" (src/app/index.tsx); this screen moved off the root.

const TEXT_VARIANTS = [
  'display',
  'h1',
  'h2',
  'title',
  'bodyLg',
  'body',
  'label',
  'caption',
  'micro',
] as const;

const TEXT_COLORS: TextColor[] = [
  'primary',
  'secondary',
  'muted',
  'label',
  'faint',
  'accent',
  'danger',
  'success',
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View style={{ marginTop: theme.spacing.huge, gap: theme.spacing.base }}>
      <Text variant="micro" color="accent">
        {title}
      </Text>
      {children}
    </View>
  );
}

export default function DevGalleryScreen() {
  const theme = useTheme();
  const toast = useToast();
  const [text, setText] = useState('');
  const [errText, setErrText] = useState('not-an-email');
  const [otp, setOtp] = useState('');

  return (
    <Screen scroll>
      <View style={{ paddingVertical: theme.spacing.xxl, gap: theme.spacing.base }}>
        <Text variant="display">Ember</Text>
        <Text variant="body" color="muted">
          twenty4 design system — primitive gallery
        </Text>
      </View>

      <Section title="Text — variants">
        {TEXT_VARIANTS.map((v) => (
          <Text key={v} variant={v}>
            {v}
          </Text>
        ))}
      </Section>

      <Section title="Text — colors">
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.base }}>
          {TEXT_COLORS.map((c) => (
            <Text key={c} variant="body" color={c}>
              {c}
            </Text>
          ))}
        </View>
      </Section>

      <Section title="Button — variants">
        <Button variant="primary" title="Primary CTA" onPress={() => {}} />
        <Button variant="secondary" title="Secondary" onPress={() => {}} />
        <Button variant="ghost" title="Ghost" onPress={() => {}} />
        <Button variant="danger" title="Danger" onPress={() => {}} />
      </Section>

      <Section title="Button — sizes (primary)">
        <Button variant="primary" size="sm" title="Small" onPress={() => {}} />
        <Button variant="primary" size="md" title="Medium" onPress={() => {}} />
        <Button variant="primary" size="lg" title="Large" onPress={() => {}} />
      </Section>

      <Section title="Button — states">
        <Button variant="primary" loading title="Loading" onPress={() => {}} />
        <Button variant="primary" disabled title="Disabled" onPress={() => {}} />
        <Button variant="secondary" loading title="Loading" onPress={() => {}} />
        <Button variant="primary" fullWidth title="Full width" onPress={() => {}} />
      </Section>

      <Section title="Input">
        <Input
          label="Email"
          placeholder="you@example.com"
          value={text}
          onChangeText={setText}
          keyboardType="email-address"
        />
        <Input
          label="With error"
          value={errText}
          onChangeText={setErrText}
          error="Enter a valid email address"
        />
        <Input
          label="Password"
          placeholder="••••••••"
          value={text}
          onChangeText={setText}
          secureTextEntry
        />
      </Section>

      <Section title="OTPInput">
        <OTPInput
          value={otp}
          onChangeText={setOtp}
          onComplete={(code) =>
            toast.show({ type: 'success', message: `Code: ${code}` })
          }
        />
      </Section>

      <Section title="Card">
        <Card>
          <Text variant="title">Padded card</Text>
          <Text variant="body" color="muted">
            Default xxl radius, neutral shadow.
          </Text>
        </Card>
        <Card variant="compact" bezel radius="lg">
          <Text variant="body">Compact + bezel ring</Text>
        </Card>
        <Card onPress={() => toast.show({ message: 'Card pressed' })}>
          <Text variant="body">Pressable card (tap me)</Text>
        </Card>
      </Section>

      <Section title="Avatar">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.lg }}>
          <Avatar size="sm" name="Ada Lovelace" />
          <Avatar size="md" name="Grace Hopper" />
          <Avatar size="lg" name="Alan Turing" />
          <Avatar
            size="lg"
            name="With Image"
            uri="https://i.pravatar.cc/128"
          />
        </View>
      </Section>

      <Section title="Spinner">
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xl }}>
          <Spinner size="small" />
          <Spinner size="large" />
        </View>
      </Section>

      <Section title="Toast">
        <Button
          variant="secondary"
          title="Success toast"
          onPress={() => toast.show({ type: 'success', message: 'Saved!' })}
        />
        <Button
          variant="secondary"
          title="Error toast"
          onPress={() => toast.show({ type: 'error', message: 'Something broke.' })}
        />
        <Button
          variant="secondary"
          title="Info toast"
          onPress={() => toast.show({ type: 'info', message: 'Heads up.' })}
        />
      </Section>

      <View style={{ height: theme.spacing.section }} />
    </Screen>
  );
}
