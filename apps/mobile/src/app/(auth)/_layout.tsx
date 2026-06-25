// (auth) group layout — pre-session flow: welcome → sign-in → verify → profile-setup,
// plus legal. A themed Stack, headers hidden (screens render their own chrome).
// initialRouteName pins the group entry to `welcome`.
import { Stack } from 'expo-router';
import { useTheme } from '@/theme';

export const unstable_settings = {
  initialRouteName: 'welcome',
};

export default function AuthLayout() {
  const theme = useTheme();
  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: theme.colors.bg },
      }}
    />
  );
}
