/**
 * Sheet — bottom sheet via RN Modal + scrim. Web-safe (no native-only deps).
 * For Slice 0 this is a controlled, presentational sheet (no gesture drag yet).
 */
import { Modal, Pressable, Text, View } from 'react-native';
import { useTheme } from '../theme';

export interface SheetProps {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children?: React.ReactNode;
}

export function Sheet({ visible, onClose, title, children }: SheetProps) {
  const theme = useTheme();
  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable
          accessibilityLabel="Close sheet"
          onPress={onClose}
          style={{ ...StyleSheetAbsoluteFill, backgroundColor: theme.colors.scrim }}
        />
        <View
          style={{
            backgroundColor: theme.colors.surface,
            borderTopLeftRadius: theme.radii['2xl'],
            borderTopRightRadius: theme.radii['2xl'],
            paddingTop: theme.spacing.md,
            paddingBottom: theme.spacing['2xl'],
            paddingHorizontal: theme.spacing.lg,
            borderTopWidth: 1,
            borderColor: theme.colors.border,
            gap: theme.spacing.md,
          }}
        >
          <View
            style={{
              alignSelf: 'center',
              width: 40,
              height: 5,
              borderRadius: 3,
              backgroundColor: theme.colors.surface3,
            }}
          />
          {title ? (
            <Text style={{ ...theme.typography.heading, color: theme.colors.text }}>{title}</Text>
          ) : null}
          {children}
        </View>
      </View>
    </Modal>
  );
}

const StyleSheetAbsoluteFill = {
  position: 'absolute' as const,
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
};
