// GroupBits — small shared, Ember-styled presentational pieces for the group
// screens: a role pill, a tappable group list row, an action/navigation row, and a
// section heading. Kept dumb (props in, no data fetching) so screens compose them.
import type { ReactNode } from 'react';
import { Pressable, View, type ViewStyle } from 'react-native';
import type { GroupDTO, MemberDTO } from '@twenty4/contracts';
import { Avatar, Card, Text } from '@/ui';
import { useTheme } from '@/theme';

type Role = GroupDTO['role'];

// ── Role pill ────────────────────────────────────────────────────────────────

export function RoleBadge({ role }: { role: Role }) {
  const theme = useTheme();
  if (role === 'member') return null; // members get no badge (reduce noise)
  const label = role === 'owner' ? 'Owner' : 'Admin';
  return (
    <View
      style={{
        backgroundColor: theme.colors.accentSoft,
        borderRadius: theme.radii.pill,
        paddingHorizontal: theme.spacing.md,
        paddingVertical: 2,
      }}
    >
      <Text variant="micro" color="accent">
        {label}
      </Text>
    </View>
  );
}

// ── Group list row ───────────────────────────────────────────────────────────

export function GroupRow({
  group,
  onPress,
  testID,
}: {
  group: GroupDTO;
  onPress: () => void;
  testID?: string;
}) {
  const theme = useTheme();
  return (
    <Card variant="compact" onPress={onPress} style={{ overflow: 'visible' }}>
      <View
        style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.base }}
        testID={testID}
      >
        <Avatar uri={group.photoUrl ?? undefined} name={group.name} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="bodyLg" weight="extrabold" numberOfLines={1}>
            {group.name}
          </Text>
          <Text variant="caption" color="muted">
            {group.memberCount} {group.memberCount === 1 ? 'member' : 'members'}
          </Text>
        </View>
        <RoleBadge role={group.role} />
        <Text variant="bodyLg" color="faint">
          {'›'}
        </Text>
      </View>
    </Card>
  );
}

// ── Member roster row ────────────────────────────────────────────────────────

export function MemberRow({
  member,
  isSelf,
  trailing,
  testID,
}: {
  member: MemberDTO;
  isSelf?: boolean;
  /** Optional trailing node (e.g. a Remove button for owners). */
  trailing?: ReactNode;
  testID?: string;
}) {
  const theme = useTheme();
  const name = member.displayName ?? member.username ?? 'Member';
  const handle = member.username != null ? `@${member.username}` : null;
  return (
    <Card variant="compact" flat>
      <View
        style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.base }}
        testID={testID}
      >
        <Avatar uri={member.profilePhotoUrl ?? undefined} name={name} />
        <View style={{ flex: 1, gap: 2 }}>
          <Text variant="body" weight="extrabold" numberOfLines={1}>
            {name}
            {isSelf ? ' (you)' : ''}
          </Text>
          {handle != null ? (
            <Text variant="caption" color="muted" numberOfLines={1}>
              {handle}
            </Text>
          ) : null}
        </View>
        <RoleBadge role={member.role} />
        {trailing}
      </View>
    </Card>
  );
}

// ── Action / navigation row (detail screen) ──────────────────────────────────

export function ActionRow({
  label,
  sublabel,
  onPress,
  danger = false,
  disabled = false,
  trailing,
  testID,
}: {
  label: string;
  sublabel?: string;
  onPress: () => void;
  danger?: boolean;
  disabled?: boolean;
  trailing?: ReactNode;
  testID?: string;
}) {
  const theme = useTheme();
  const rowStyle: ViewStyle = {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing.base,
    backgroundColor: theme.colors.surface,
    borderRadius: theme.radii.lg,
    borderWidth: 1,
    borderColor: theme.colors.border,
    paddingVertical: theme.spacing.lg,
    paddingHorizontal: theme.spacing.xl,
    minHeight: 56,
  };
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      testID={testID}
      style={({ pressed }) => [
        rowStyle,
        disabled ? { opacity: 0.5 } : null,
        pressed && !disabled ? { opacity: 0.85 } : null,
      ]}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="body" weight="extrabold" color={danger ? 'danger' : 'primary'}>
          {label}
        </Text>
        {sublabel != null ? (
          <Text variant="caption" color="muted">
            {sublabel}
          </Text>
        ) : null}
      </View>
      {trailing ?? (
        <Text variant="bodyLg" color="faint">
          {'›'}
        </Text>
      )}
    </Pressable>
  );
}

// ── Section heading ──────────────────────────────────────────────────────────

export function SectionLabel({ children }: { children: ReactNode }) {
  const theme = useTheme();
  return (
    <Text
      variant="micro"
      color="label"
      style={{ marginTop: theme.spacing.lg, marginBottom: theme.spacing.xs }}
    >
      {children}
    </Text>
  );
}
