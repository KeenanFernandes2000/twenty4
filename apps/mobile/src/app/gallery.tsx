/**
 * /gallery — the Slice-0 design-system showcase.
 *
 * Renders every Ember UI primitive with sample states. A SegmentedControl at
 * the top switches the surrounding theme (System / Light / Dark) so a single
 * screenshot proves the system, and a "Split" mode renders the whole gallery in
 * BOTH light and dark side-by-side for the orchestrator's Playwright capture.
 *
 * Strictly themed — every color comes from `useTheme()`, no raw hex here.
 */
import { useState } from 'react';
import { ScrollView, Text, View } from 'react-native';

// Proves the monorepo spine resolves through Metro: shared, typed value sets
// (Ember themes + reaction types) come straight from @twenty4/contracts.
import { THEMES, REACTION_TYPES } from '@twenty4/contracts/enums';

import {
  ThemeProvider,
  darkTheme,
  lightTheme,
  useTheme,
  useThemeControls,
  type Theme,
} from '../theme';
import {
  Avatar,
  Button,
  Card,
  Chip,
  CountdownBadge,
  EmptyState,
  ErrorRetry,
  Field,
  Icon,
  type IconName,
  ListRow,
  ProgressBar,
  SegmentedControl,
  Sheet,
  Skeleton,
  Toast,
} from '../ui';

// Map each contract reaction type to an Ionicon. Keyed by the contract tuple
// values so it stays in sync with @twenty4/contracts.
const REACTION_ICON: Record<(typeof REACTION_TYPES)[number], IconName> = {
  like: 'thumbs-up',
  laugh: 'happy',
  fire: 'flame',
  heart: 'heart',
  shocked: 'alert-circle',
};

/* -------------------------------------------------------------------------- */
/*  Section helpers                                                            */
/* -------------------------------------------------------------------------- */

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  const theme = useTheme();
  return (
    <View style={{ gap: theme.spacing.md }}>
      <Text style={{ ...theme.typography.label, color: theme.colors.label, letterSpacing: 1 }}>
        {title.toUpperCase()}
      </Text>
      <Card style={{ gap: theme.spacing.md }}>{children}</Card>
    </View>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
      {children}
    </View>
  );
}

function Swatch({ name, color }: { name: string; color: string }) {
  const theme = useTheme();
  return (
    <View style={{ alignItems: 'center', gap: 4, width: 64 }}>
      <View
        style={{
          width: 48,
          height: 48,
          borderRadius: theme.radii.md,
          backgroundColor: color,
          borderWidth: 1,
          borderColor: theme.colors.border,
        }}
      />
      <Text style={{ ...theme.typography.label, color: theme.colors.muted }} numberOfLines={1}>
        {name}
      </Text>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/*  The full primitive gallery (rendered inside whatever theme wraps it)       */
/* -------------------------------------------------------------------------- */

function GalleryBody() {
  const theme = useTheme();
  const [seg, setSeg] = useState<'one' | 'two' | 'three'>('one');
  const [sheetOpen, setSheetOpen] = useState(false);
  const [text, setText] = useState('');

  // Fixed "now" so screenshots are deterministic: ~3h and ~20m remaining.
  const NOW = 1_700_000_000_000;

  const c = theme.colors;

  return (
    <View style={{ gap: theme.spacing.xl }}>
      <Text style={{ ...theme.typography.title, color: c.text }}>
        Ember — {theme.scheme}
      </Text>

      <Section title="Color tokens">
        <Row>
          <Swatch name="accent" color={c.accent} />
          <Swatch name="accent2" color={c.accent2} />
          <Swatch name="bg" color={c.bg} />
          <Swatch name="canvas" color={c.canvas} />
          <Swatch name="surface" color={c.surface} />
          <Swatch name="surface2" color={c.surface2} />
          <Swatch name="surface3" color={c.surface3} />
          <Swatch name="field" color={c.field} />
          <Swatch name="text" color={c.text} />
          <Swatch name="muted" color={c.muted} />
          <Swatch name="faint" color={c.faint} />
          <Swatch name="danger" color={c.danger} />
          <Swatch name="success" color={c.success} />
          <Swatch name="vid" color={c.vid[0]} />
        </Row>
      </Section>

      <Section title="Typography">
        <Text style={{ ...theme.typography.display, color: c.text }}>Display</Text>
        <Text style={{ ...theme.typography.title, color: c.text }}>Title</Text>
        <Text style={{ ...theme.typography.heading, color: c.text }}>Heading</Text>
        <Text style={{ ...theme.typography.subheading, color: c.text }}>Subheading</Text>
        <Text style={{ ...theme.typography.body, color: c.text }}>
          Body — today’s moments, gone in 24h.
        </Text>
        <Text style={{ ...theme.typography.caption, color: c.muted }}>Caption / muted</Text>
        <Text style={{ ...theme.typography.mono, color: c.accent }}>mono 04:21:09</Text>
      </Section>

      <Section title="Buttons">
        <Row>
          <Button label="Primary" onPress={() => {}} />
          <Button label="Secondary" variant="secondary" onPress={() => {}} />
          <Button label="Ghost" variant="ghost" onPress={() => {}} />
          <Button label="Danger" variant="danger" onPress={() => {}} />
        </Row>
        <Row>
          <Button label="With icon" icon="camera" onPress={() => {}} />
          <Button label="Loading" loading onPress={() => {}} />
          <Button label="Disabled" disabled onPress={() => {}} />
          <Button label="Small" size="sm" onPress={() => {}} />
          <Button label="Large" size="lg" onPress={() => {}} />
        </Row>
        <Button label="Full width" fullWidth onPress={() => {}} />
      </Section>

      <Section title="Fields">
        <Field
          label="Display name"
          placeholder="e.g. Alex"
          value={text}
          onChangeText={setText}
          hint="Visible to your groups."
        />
        <Field label="Phone" placeholder="+1 555 0100" keyboardType="phone-pad" />
        <Field label="Code" placeholder="000000" error="That code didn’t match." />
      </Section>

      <Section title="Chips & Segmented">
        <Text style={{ ...theme.typography.caption, color: c.muted }}>
          Ember themes (from @twenty4/contracts):
        </Text>
        <Row>
          {THEMES.map((t, i) => (
            <Chip key={t} label={t} selected={i === 0} onPress={() => {}} />
          ))}
        </Row>
        <SegmentedControl
          value={seg}
          onChange={setSeg}
          options={[
            { label: 'Light', value: 'one' },
            { label: 'Party', value: 'two' },
            { label: 'Mellow', value: 'three' },
          ]}
        />
      </Section>

      <Section title="Avatars">
        <Row>
          <Avatar name="Alex Doe" />
          <Avatar name="Bo" size={56} />
          <Avatar name="Casey Quinn" size={32} />
          <Avatar uri="https://i.pravatar.cc/100" size={48} name="Pic" />
        </Row>
      </Section>

      <Section title="Countdown & Progress">
        <Row>
          <CountdownBadge expiresAt={NOW + 3 * 3600_000 + 12 * 60_000} now={NOW} />
          <CountdownBadge expiresAt={NOW + 20 * 60_000} now={NOW} />
          <CountdownBadge expiresAt={NOW - 1000} now={NOW} />
        </Row>
        <ProgressBar value={0.25} />
        <ProgressBar value={0.7} color={c.success} />
        <ProgressBar value={1} />
      </Section>

      <Section title="Toasts">
        <Toast message="Your montage is publishing…" tone="info" />
        <Toast message="Published to 3 groups." tone="success" />
        <Toast message="Upload failed — tap to retry." tone="error" />
      </Section>

      <Section title="List rows">
        <ListRow
          title="Edit profile"
          subtitle="Name, photo, bio"
          leadingIcon="person-circle-outline"
          showChevron
          onPress={() => {}}
        />
        <ListRow
          title="Notifications"
          leadingIcon="notifications-outline"
          trailing={<Chip label="3 on" />}
          showChevron
          onPress={() => {}}
        />
        <ListRow
          title="Delete account"
          leadingIcon="trash-outline"
          danger
          showChevron
          onPress={() => {}}
        />
      </Section>

      <Section title="Skeleton (loading)">
        <Skeleton width={140} height={20} />
        <Skeleton width="100%" height={120} radius={theme.radii.lg} />
        <Row>
          <Skeleton width={48} height={48} radius={24} />
          <View style={{ gap: 8, flex: 1 }}>
            <Skeleton width="60%" height={14} />
            <Skeleton width="40%" height={12} />
          </View>
        </Row>
      </Section>

      <Section title="Sheet">
        <Button label="Open bottom sheet" icon="chevron-up" onPress={() => setSheetOpen(true)} />
        <Sheet visible={sheetOpen} onClose={() => setSheetOpen(false)} title="Pick a theme">
          <Row>
            <Chip label="Chill" selected onPress={() => {}} />
            <Chip label="Party" onPress={() => {}} />
            <Chip label="Soft" onPress={() => {}} />
          </Row>
          <Button label="Done" fullWidth onPress={() => setSheetOpen(false)} />
        </Sheet>
      </Section>

      <Section title="Empty & Error states">
        <EmptyState
          icon="images-outline"
          title="No moments yet"
          body="Capture today’s photos and videos to start your montage."
          actionLabel="Open camera"
          onAction={() => {}}
        />
        <View style={{ height: 1, backgroundColor: c.border }} />
        <ErrorRetry onRetry={() => {}} />
      </Section>

      <Section title="Reactions (from contracts)">
        <Row>
          {REACTION_TYPES.map((r) => (
            <Chip key={r} label={r} icon={REACTION_ICON[r]} onPress={() => {}} />
          ))}
        </Row>
      </Section>

      <Section title="Icons">
        <Row>
          {(
            [
              'camera',
              'images',
              'play-circle',
              'heart',
              'chatbubble',
              'flame',
              'happy',
              'people',
              'settings',
              'time',
            ] as const
          ).map((n) => (
            <Icon key={n} name={n} size={24} color={c.accent} />
          ))}
        </Row>
      </Section>
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/*  Themed panel — used by the Split view to force a specific theme            */
/* -------------------------------------------------------------------------- */

function ForcedThemePanel({ theme }: { theme: Theme }) {
  // Wrap in a ThemeProvider locked to the given scheme.
  return (
    <ThemeProvider initialMode={theme.scheme}>
      <View style={{ flex: 1, minWidth: 320, backgroundColor: theme.colors.bg }}>
        <View style={{ padding: 16 }}>
          <GalleryBody />
        </View>
      </View>
    </ThemeProvider>
  );
}

/* -------------------------------------------------------------------------- */
/*  Route                                                                       */
/* -------------------------------------------------------------------------- */

export default function GalleryScreen() {
  const { theme, mode, setMode } = useThemeControls();
  const [view, setView] = useState<'single' | 'split'>('single');

  return (
    <ScrollView style={{ flex: 1, backgroundColor: theme.colors.bg }}>
      <View style={{ padding: 16, gap: 16 }}>
        <SegmentedControl
          value={view}
          onChange={setView}
          options={[
            { label: 'Single', value: 'single' },
            { label: 'Split L/D', value: 'split' },
          ]}
        />
        {view === 'single' ? (
          <SegmentedControl
            value={mode}
            onChange={setMode}
            options={[
              { label: 'System', value: 'system' },
              { label: 'Light', value: 'light' },
              { label: 'Dark', value: 'dark' },
            ]}
          />
        ) : null}
      </View>

      {view === 'single' ? (
        <View style={{ padding: 16 }}>
          <GalleryBody />
        </View>
      ) : (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap' }}>
          <ForcedThemePanel theme={lightTheme} />
          <ForcedThemePanel theme={darkTheme} />
        </View>
      )}
    </ScrollView>
  );
}
