import { Stack } from 'expo-router';
import { Placeholder } from '../../components/Placeholder';

export default function NotificationsPriming() {
  return (
    <>
      <Stack.Screen options={{ title: 'Stay in the loop' }} />
      <Placeholder
        name="Notifications priming (1.6)"
        icon="notifications-outline"
        description="Ask to enable reminders."
      />
    </>
  );
}
