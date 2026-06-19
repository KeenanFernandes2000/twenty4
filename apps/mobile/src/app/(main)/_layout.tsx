/**
 * (main) tab navigator — Today | Feed | Groups | Profile.
 * Theme-driven tab bar; web-safe (no native-only imports).
 */
import { Tabs } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';

import { useTheme } from '../../theme';

export default function MainLayout() {
  const theme = useTheme();
  return (
    <Tabs
      screenOptions={{
        headerShown: true,
        headerStyle: { backgroundColor: theme.colors.surface },
        headerTitleStyle: { color: theme.colors.text, fontFamily: theme.fontFamily.bold },
        headerTintColor: theme.colors.text,
        tabBarActiveTintColor: theme.colors.accent,
        tabBarInactiveTintColor: theme.colors.muted,
        tabBarStyle: {
          backgroundColor: theme.colors.surface,
          borderTopColor: theme.colors.border,
        },
        tabBarLabelStyle: { fontFamily: theme.fontFamily.semibold, fontSize: 11 },
      }}
    >
      <Tabs.Screen
        name="today"
        options={{
          title: 'Today',
          // The today tab is its own Stack (today/_layout) that renders per-screen
          // chrome (grid header, forced-dark camera, modals); hide the tab header.
          headerShown: false,
          tabBarIcon: ({ color, size }) => <Ionicons name="today-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="feed"
        options={{
          title: 'Feed',
          // The feed tab is its own Stack (feed/_layout) — index, dark player,
          // comments modal; hide the tab-level header to avoid a double bar.
          headerShown: false,
          tabBarIcon: ({ color, size }) => <Ionicons name="albums-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="groups"
        options={{
          title: 'Groups',
          // The groups tab is its own Stack (groups/_layout) which renders the
          // per-screen header; hide the tab-level header to avoid a double bar.
          headerShown: false,
          tabBarIcon: ({ color, size }) => <Ionicons name="people-outline" color={color} size={size} />,
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          title: 'Profile',
          tabBarIcon: ({ color, size }) => <Ionicons name="person-outline" color={color} size={size} />,
        }}
      />
    </Tabs>
  );
}
